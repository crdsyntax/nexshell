use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{
    ConnectionProfile, IncidentActionResult, IncidentScan, SuspectConnection, SuspectFile,
    SuspectProcess,
};
use chrono::Utc;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

const SCAN_TIMEOUT: Duration = Duration::from_secs(45);
const ACTION_TIMEOUT: Duration = Duration::from_secs(30);
const QUARANTINE_DIR: &str = "/var/backups/2shell/quarantine";

const SCAN_SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
echo __HOST__
hostname 2>/dev/null
echo __PROCS__
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  exe=$(readlink "$p/exe" 2>/dev/null) || continue
  case "$exe" in
    /tmp/*|/dev/shm/*|/var/tmp/*) ;;
    *" (deleted)") ;;
    *) continue ;;
  esac
  user=$(stat -c %U "$p" 2>/dev/null)
  started=$(stat -c %y "$p" 2>/dev/null | cut -c1-19)
  cmd=$(tr '\0' ' ' < "$p/cmdline" 2>/dev/null | cut -c1-300)
  printf '%s\t%s\t%s\t%s\t%s\n' "$pid" "$user" "$exe" "$started" "$cmd"
done
echo __FILES__
for d in /tmp /dev/shm /var/tmp; do
  find "$d" -xdev -maxdepth 4 -type f \( -perm /111 -o -name '.*' \) 2>/dev/null | head -200 | while IFS= read -r f; do
    printf '%s\t%s\t%s\t%s\t%s\n' "$f" \
      "$(stat -c %a "$f" 2>/dev/null)" \
      "$(stat -c %U "$f" 2>/dev/null)" \
      "$(stat -c %s "$f" 2>/dev/null)" \
      "$(stat -c %y "$f" 2>/dev/null | cut -c1-19)"
  done
done
echo __ENV__
for p in /proc/[0-9]*/environ; do
  pid=${p#/proc/}
  pid=${pid%/environ}
  tr '\0' '\n' < "$p" 2>/dev/null \
    | grep -aE '^(npm_config_node_gyp|LD_PRELOAD|NODE_OPTIONS|PYTHONPATH|GIT_SSH_COMMAND)=' \
    | grep -E '/tmp/|/dev/shm/|/var/tmp/' \
    | sed "s|^|pid=$pid |"
done 2>/dev/null | sort -u | head -40
echo __NET__
ss -tnp state established 2>/dev/null | tail -n +2 | head -80
echo __KEYS__
for f in /root/.ssh/authorized_keys /home/*/.ssh/authorized_keys; do
  [ -f "$f" ] || continue
  printf '### %s | %s\n' "$f" "$(stat -c %y "$f" 2>/dev/null | cut -c1-19)"
  awk 'NF && $1 !~ /^#/ { print "  " $1 " " $2 " " $3 }' "$f" 2>/dev/null | head -20
done
echo __UNITS__
systemctl list-units --type=service --state=running --no-pager --no-legend 2>/dev/null | awk '{print $1}' | head -80
echo __HISTORY__
tail -n 60 /root/.bash_history 2>/dev/null
echo __DOCKER__
if command -v docker >/dev/null 2>&1; then
  docker ps -a --format '{{.Names}}|{{.Image}}|{{.Status}}' 2>/dev/null | head -50
fi
exit 0
"####;

pub struct IncidentManager;

impl IncidentManager {
    pub async fn scan(pools: &PoolManager, profile: &ConnectionProfile) -> AppResult<IncidentScan> {
        let command = as_root(profile, SCAN_SCRIPT);
        let output = pools
            .execute_with_category(&profile.id, &command, SCAN_TIMEOUT, "incident")
            .await?;
        if !output.success() && output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "incident scan failed: {}",
                output.stderr.trim()
            )));
        }

        let sections = collect_sections(&output.stdout);
        Ok(IncidentScan {
            hostname: first(&sections, "HOST"),
            generated_at: Utc::now().timestamp(),
            processes: parse_processes(section(&sections, "PROCS")),
            files: parse_files(section(&sections, "FILES")),
            env_hits: clean_lines(section(&sections, "ENV")),
            connections: parse_connections(section(&sections, "NET")),
            authorized_keys: clean_lines(section(&sections, "KEYS")),
            units: clean_lines(section(&sections, "UNITS")),
            shell_history: clean_lines(section(&sections, "HISTORY")),
            containers: clean_lines(section(&sections, "DOCKER")),
        })
    }

    /// Kills a process only when its executable lives in a temporary directory or has
    /// been deleted from disk.
    pub async fn kill_process(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        pid: u32,
    ) -> AppResult<IncidentActionResult> {
        if pid < 2 {
            return Err(AppError::Validation("refusing to kill pid 0/1".into()));
        }
        let script = format!(
            r####"set -e
pid={pid}
[ -d "/proc/$pid" ] || {{ echo "process $pid not found" >&2; exit 1; }}
exe=$(readlink "/proc/$pid/exe" 2>/dev/null || true)
case "$exe" in
  /tmp/*|/dev/shm/*|/var/tmp/*) ;;
  *" (deleted)") ;;
  *) echo "refusing to kill pid $pid: executable is ${{exe:-unknown}}" >&2; exit 3 ;;
esac
cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-200)
user=$(stat -c %U "/proc/$pid" 2>/dev/null)
kill -9 "$pid"
sleep 1
if [ -d "/proc/$pid" ]; then echo "pid $pid is still alive (supervisor?)" >&2; exit 4; fi
echo "killed pid $pid user=$user exe=$exe"
echo "cmdline=$cmd"
"####,
            pid = pid
        );
        run_action(pools, profile, &script).await
    }

    /// Moves a file from a temporary directory into the quarantine folder.
    pub async fn quarantine(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        path: &str,
    ) -> AppResult<IncidentActionResult> {
        validate_tmp_path(path)?;
        let script = format!(
            r####"set -e
src={src}
dest={dest}
[ -f "$src" ] || {{ echo "file not found: $src" >&2; exit 1; }}
sha=$(sha256sum "$src" 2>/dev/null | awk '{{print $1}}')
mkdir -p "$dest"
chmod 700 "$dest"
name=$(basename "$src")
target="$dest/$name-$(date +%s)"
mv -f "$src" "$target"
chmod 000 "$target"
echo "quarantined $src -> $target"
echo "sha256=$sha"
"####,
            src = shell_quote(path),
            dest = shell_quote(QUARANTINE_DIR)
        );
        run_action(pools, profile, &script).await
    }

    /// Blocks or unblocks an IP address on INPUT and OUTPUT.
    pub async fn block_ip(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        ip: &str,
        block: bool,
    ) -> AppResult<IncidentActionResult> {
        let address: IpAddr = ip
            .trim()
            .parse()
            .map_err(|_| AppError::Validation(format!("invalid IP address: {ip}")))?;
        let family = if address.is_ipv4() { "ipv4" } else { "ipv6" };
        let quoted = shell_quote(&address.to_string());

        let script = if block {
            format!(
                r####"set -e
ip={ip}
family={family}
iptables -I INPUT 1 -s "$ip" -j DROP 2>/dev/null || true
iptables -I OUTPUT 1 -d "$ip" -j DROP 2>/dev/null || true
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --add-rich-rule="rule family=$family source address=$ip drop" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi
echo "blocked $ip (iptables INPUT/OUTPUT)"
iptables -S 2>/dev/null | grep -F "$ip" || echo "note: no persistent iptables rule (not installed?)"
"####,
                ip = quoted,
                family = family
            )
        } else {
            format!(
                r####"set -e
ip={ip}
family={family}
iptables -D INPUT -s "$ip" -j DROP 2>/dev/null || true
iptables -D OUTPUT -d "$ip" -j DROP 2>/dev/null || true
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --permanent --remove-rich-rule="rule family=$family source address=$ip drop" >/dev/null 2>&1 || true
  firewall-cmd --reload >/dev/null 2>&1 || true
fi
echo "unblocked $ip"
"####,
                ip = quoted,
                family = family
            )
        };
        run_action(pools, profile, &script).await
    }
}

async fn run_action(
    pools: &PoolManager,
    profile: &ConnectionProfile,
    script: &str,
) -> AppResult<IncidentActionResult> {
    let output = pools
        .execute_sensitive(&profile.id, &as_root(profile, script), ACTION_TIMEOUT)
        .await?;
    let combined = format!("{}{}", output.stdout, output.stderr)
        .trim()
        .to_string();
    if !output.success() {
        return Ok(IncidentActionResult {
            ok: false,
            output: if combined.is_empty() {
                format!("exit code {}", output.exit_status)
            } else {
                combined
            },
        });
    }
    Ok(IncidentActionResult {
        ok: true,
        output: if combined.is_empty() {
            "done".to_string()
        } else {
            combined
        },
    })
}

fn as_root(profile: &ConnectionProfile, script: &str) -> String {
    if profile.username == "root" {
        script.to_string()
    } else if profile.elevated {
        format!("sudo -n sh -c {}", shell_quote(script))
    } else {
        script.to_string()
    }
}

fn validate_tmp_path(path: &str) -> AppResult<()> {
    let trimmed = path.trim();
    let allowed = ["/tmp/", "/dev/shm/", "/var/tmp/"]
        .iter()
        .any(|prefix| trimmed.starts_with(prefix));
    if !allowed {
        return Err(AppError::Validation(
            "only files under /tmp, /dev/shm or /var/tmp can be quarantined".into(),
        ));
    }
    if trimmed.contains("..") || trimmed.chars().any(char::is_control) {
        return Err(AppError::Validation("invalid file path".into()));
    }
    Ok(())
}

fn collect_sections(output: &str) -> HashMap<String, Vec<String>> {
    let mut sections: HashMap<String, Vec<String>> = HashMap::new();
    let mut current = String::from("__HEAD__");
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("__") && trimmed.ends_with("__") && trimmed.len() > 4 {
            current = trimmed.trim_matches('_').to_string();
            sections.entry(current.clone()).or_default();
        } else {
            sections
                .entry(current.clone())
                .or_default()
                .push(line.to_string());
        }
    }
    sections
}

fn section<'a>(sections: &'a HashMap<String, Vec<String>>, key: &str) -> &'a [String] {
    sections.get(key).map(Vec::as_slice).unwrap_or(&[])
}

fn first(sections: &HashMap<String, Vec<String>>, key: &str) -> String {
    section(sections, key)
        .iter()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .unwrap_or_default()
}

fn clean_lines(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.trim().is_empty())
        .collect()
}

fn parse_processes(lines: &[String]) -> Vec<SuspectProcess> {
    lines
        .iter()
        .filter_map(|line| {
            let mut parts = line.splitn(5, '\t');
            let pid = parts.next()?.trim().parse().ok()?;
            Some(SuspectProcess {
                pid,
                user: parts.next()?.trim().to_string(),
                exe: parts.next()?.trim().to_string(),
                started: parts.next()?.trim().to_string(),
                command: parts.next().unwrap_or("").trim().to_string(),
            })
        })
        .collect()
}

fn parse_files(lines: &[String]) -> Vec<SuspectFile> {
    lines
        .iter()
        .filter_map(|line| {
            let mut parts = line.splitn(5, '\t');
            let path = parts.next()?.trim().to_string();
            if path.is_empty() {
                return None;
            }
            Some(SuspectFile {
                path,
                mode: parts.next().unwrap_or("").trim().to_string(),
                owner: parts.next().unwrap_or("").trim().to_string(),
                size: parts
                    .next()
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0),
                modified: parts.next().unwrap_or("").trim().to_string(),
            })
        })
        .collect()
}

fn parse_connections(lines: &[String]) -> Vec<SuspectConnection> {
    lines
        .iter()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 5 {
                return None;
            }
            let local = fields[3].to_string();
            let remote = fields[4].to_string();
            let (ip, port) = split_endpoint(&remote)?;
            if is_local_address(&ip) {
                return None;
            }
            let users = fields[5..].join(" ");
            let (process, pid) = parse_users(&users);
            Some(SuspectConnection {
                local,
                remote,
                ip,
                port,
                process,
                pid,
            })
        })
        .take(60)
        .collect()
}

fn split_endpoint(value: &str) -> Option<(String, u16)> {
    let (host, port) = value.rsplit_once(':')?;
    let port = port.parse().ok()?;
    let host = host.trim_matches(['[', ']']).to_string();
    Some((host, port))
}

fn is_local_address(ip: &str) -> bool {
    match ip.parse::<IpAddr>() {
        Ok(address) => {
            address.is_loopback()
                || address.is_unspecified()
                || match address {
                    IpAddr::V4(v4) => v4.is_private(),
                    IpAddr::V6(v6) => v6.is_loopback(),
                }
        }
        Err(_) => true,
    }
}

fn parse_users(value: &str) -> (String, Option<u32>) {
    let process = value
        .split("((\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or("")
        .to_string();
    let pid = value
        .split("pid=")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|value| value.parse().ok());
    (process, pid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_scan_sections() {
        let output = "__HOST__\nweb-01\n__PROCS__\n42\troot\t/tmp/x (deleted)\t2026-10-29 02:00:00\t/tmp/x -d\n__FILES__\n/tmp/.a.sh\t755\troot\t118\t2026-10-29 04:17:27\n";
        let sections = collect_sections(output);
        assert_eq!(first(&sections, "HOST"), "web-01");
        let processes = parse_processes(section(&sections, "PROCS"));
        assert_eq!(processes.len(), 1);
        assert_eq!(processes[0].pid, 42);
        assert!(processes[0].exe.contains("(deleted)"));
        let files = parse_files(section(&sections, "FILES"));
        assert_eq!(files.len(), 1);
        assert_eq!(files[0].size, 118);
    }

    #[test]
    fn parses_socket_owners() {
        assert_eq!(
            parse_users("users:((\"node\",pid=658292,fd=31))"),
            ("node".into(), Some(658292))
        );
        assert_eq!(parse_users(""), (String::new(), None));
    }

    #[test]
    fn ignores_local_connections() {
        let lines = vec![
            "ESTAB 0 0 10.0.0.5:53222 153.75.94.153:8080 users:((\"node\",pid=1,fd=3))".to_string(),
            "ESTAB 0 0 127.0.0.1:3306 127.0.0.1:52344 users:((\"mariadbd\",pid=2,fd=3))"
                .to_string(),
            "ESTAB 0 0 10.0.0.5:22 10.0.0.9:51234 users:((\"sshd\",pid=3,fd=3))".to_string(),
        ];
        let parsed = parse_connections(&lines);
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].ip, "153.75.94.153");
        assert_eq!(parsed[0].port, 8080);
        assert_eq!(parsed[0].pid, Some(1));
    }

    #[test]
    fn only_quarantines_tmp_paths() {
        assert!(validate_tmp_path("/tmp/.x.sh").is_ok());
        assert!(validate_tmp_path("/dev/shm/a").is_ok());
        assert!(validate_tmp_path("/var/tmp/b").is_ok());
        assert!(validate_tmp_path("/etc/passwd").is_err());
        assert!(validate_tmp_path("/tmp/../etc/passwd").is_err());
    }
}
