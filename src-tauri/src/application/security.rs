use crate::application::cron::CronManager;
use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, SecurityFinding, SecurityReport, SecuritySummary};
use chrono::Utc;
use std::collections::HashMap;
use std::time::{Duration, Instant};

const AUDIT_SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
echo __HOST__
hostname 2>/dev/null
echo __OS__
. /etc/os-release 2>/dev/null; echo "${PRETTY_NAME:-unknown}"; uname -sr
echo __SSHD__
sshd -T 2>/dev/null | grep -E '^(permitrootlogin|passwordauthentication|pubkeyauthentication|permitemptypasswords|x11forwarding|maxauthtries|kbdinteractiveauthentication)' || true
echo __SSHD_TEST__
sshd -t 2>&1
echo "__RC__$?"
echo __FIREWALL__
firewall-cmd --state 2>/dev/null
systemctl is-active firewalld ufw 2>/dev/null
ufw status 2>/dev/null | head -n 8
iptables -S 2>/dev/null | head -n 30
echo __SELINUX__
getenforce 2>/dev/null
aa-status --enabled 2>/dev/null && echo apparmor-enabled
echo __UPDATES__
if command -v dnf >/dev/null 2>&1; then
  dnf -q updateinfo list security 2>/dev/null | head -n 80
elif command -v apt-get >/dev/null 2>&1; then
  n=$(apt-get -s upgrade 2>/dev/null | grep -ci '^Inst .*security' || true); [ "$n" -gt 0 ] && echo "$n security updates available"
fi
echo __REBOOT__
[ -f /var/run/reboot-required ] && echo yes || true
command -v needs-restarting >/dev/null 2>&1 && needs-restarting -r 2>/dev/null
echo __PASSWD__
awk -F: '$3 == 0 { print $1 }' /etc/passwd 2>/dev/null
echo __SHADOW__
awk -F: '$2 == "" { print $1 }' /etc/shadow 2>/dev/null
echo __PERMS__
for f in /etc/passwd /etc/shadow /etc/sudoers /etc/ssh/sshd_config; do
  stat -c '%a %U:%G %n' "$f" 2>/dev/null
done
echo __SUDOERS__
grep -RhsE '^[^#].*NOPASSWD' /etc/sudoers /etc/sudoers.d 2>/dev/null | head -n 30
echo __KEYS__
find /root /home -maxdepth 3 -name authorized_keys -type f -printf '%p|%m|%u\n' 2>/dev/null
echo __WORLD__
find /etc -xdev -type f -perm -0002 2>/dev/null | head -n 30
echo __SUID__
find /usr /bin /sbin /opt /usr/local -xdev -type f -perm /6000 2>/dev/null | head -n 50
echo __LISTEN__
ss -tulpn 2>/dev/null | head -n 100
echo __TMP__
find /tmp /dev/shm /var/tmp -maxdepth 3 -type f -perm /111 2>/dev/null | head -n 30
find /tmp /dev/shm /var/tmp -maxdepth 2 -type f -name '.*' 2>/dev/null | head -n 30
echo __TMPPROC__
for p in /proc/[0-9]*; do
  pid=${p#/proc/}
  exe=$(readlink "$p/exe" 2>/dev/null) || continue
  case "$exe" in
    /tmp/*|/dev/shm/*|/var/tmp/*) ;;
    *" (deleted)") ;;
    *) continue ;;
  esac
  printf '%s\t%s\t%s\n' "$pid" "$(stat -c %U "$p" 2>/dev/null)" "$exe"
done
echo __BADENV__
for p in /proc/[0-9]*/environ; do
  tr '\0' '\n' < "$p" 2>/dev/null \
    | grep -aE '^(npm_config_node_gyp|LD_PRELOAD|NODE_OPTIONS)=' \
    | grep -E '/tmp/|/dev/shm/|/var/tmp/' \
    | sed "s|^|${p#/proc/}|"
done 2>/dev/null | sort -u | head -n 40
echo __WEB__
if command -v nginx >/dev/null 2>&1; then
  echo "path=$(command -v nginx)"
  nginx -v 2>&1
  if command -v rpm >/dev/null 2>&1; then
    for pkg in nginx nginx-core nginx-common; do
      rpm -q "$pkg" --qf 'package=%{VERSION}-%{RELEASE}\n' 2>/dev/null
    done
    dnf -q check-update nginx nginx-core nginx-common >/dev/null 2>&1
    echo "pending=$?"
  elif command -v dpkg-query >/dev/null 2>&1; then
    dpkg-query -W -f='package=${Version}\n' nginx nginx-core nginx-common 2>/dev/null
    aptcount=$(apt-get -s install nginx 2>/dev/null | grep -c '^Inst nginx')
    echo "pending=$aptcount"
  fi
  pid=$(systemctl show -p MainPID --value nginx 2>/dev/null || true)
  if [ -n "$pid" ] && [ "$pid" != "0" ]; then echo "running_pid=$pid"; fi
  for candidate in /usr/sbin/nginx /usr/local/sbin/nginx /usr/local/nginx/sbin/nginx; do
    [ -x "$candidate" ] && echo "binary=$candidate"
  done
fi
if command -v httpd >/dev/null 2>&1; then httpd -v 2>&1 | head -n 1; fi
echo __PRELOAD__
cat /etc/ld.so.preload 2>/dev/null
echo __LASTB__
lastb -n 30 2>/dev/null | head -n 30
echo __LAST__
last -n 15 2>/dev/null
exit 0
"####;

pub struct SecurityManager;

impl SecurityManager {
    pub async fn audit(
        pools: &PoolManager,
        profile: &ConnectionProfile,
    ) -> AppResult<SecurityReport> {
        let started = Instant::now();
        let command = as_root(profile, AUDIT_SCRIPT);
        let output = pools
            .execute_with_category(&profile.id, &command, Duration::from_secs(120), "security")
            .await?;
        if output.stdout.trim().is_empty() && !output.success() {
            return Err(AppError::Remote(format!(
                "security audit failed: {}{}",
                output.stdout.trim(),
                output.stderr.trim()
            )));
        }

        let sections = collect_sections(&output.stdout);
        let mut findings = Vec::new();
        let mut passed = 0u32;

        let ssh = key_values(section(&sections, "SSHD"));
        let ssh_test_rc = section(&sections, "SSHD_TEST")
            .iter()
            .find_map(|line| line.trim().strip_prefix("__RC__"))
            .map(str::to_string)
            .unwrap_or_else(|| "1".to_string());
        if ssh_test_rc != "0" {
            findings.push(finding(
                "sshd-config-test",
                "sshd configuration test failed",
                "high",
                "SSH",
                "`sshd -t` did not validate the current configuration.",
                &section(&sections, "SSHD_TEST").join("\n"),
                "Fix /etc/ssh/sshd_config or the included drop-ins, then run `sshd -t` and reload sshd.",
            ));
        } else {
            passed += 1;
        }

        match ssh.get("permitrootlogin").map(String::as_str) {
            Some("yes") => findings.push(finding(
                "ssh-root-login",
                "Root login is enabled over SSH",
                "high",
                "SSH",
                "PermitRootLogin yes allows direct password/key login as root.",
                "permitrootlogin yes",
                "Set `PermitRootLogin prohibit-password` or `no` in sshd_config.",
            )),
            Some("prohibit-password") | Some("without-password") => findings.push(finding(
                "ssh-root-key-login",
                "Root can log in with SSH keys",
                "medium",
                "SSH",
                "PermitRootLogin is limited to key authentication, but root access remains possible.",
                "permitrootlogin prohibit-password",
                "Prefer a non-root deployment user and `PermitRootLogin no`.",
            )),
            Some("no") => passed += 1,
            _ => {}
        }

        match ssh.get("passwordauthentication").map(String::as_str) {
            Some("yes") => findings.push(finding(
                "ssh-password-auth",
                "SSH password authentication is enabled",
                "medium",
                "SSH",
                "Passwords can be brute-forced or reused from the compromised environment.",
                "passwordauthentication yes",
                "Add SSH keys for the required users and disable PasswordAuthentication.",
            )),
            Some("no") => passed += 1,
            _ => {}
        }

        if ssh.get("permitemptypasswords").map(String::as_str) == Some("yes") {
            findings.push(finding(
                "ssh-empty-passwords",
                "Empty SSH passwords are allowed",
                "critical",
                "SSH",
                "PermitEmptyPasswords yes allows accounts with empty passwords.",
                "permitemptypasswords yes",
                "Set `PermitEmptyPasswords no` and lock any account with an empty password.",
            ));
        }
        if ssh.get("pubkeyauthentication").map(String::as_str) == Some("no") {
            findings.push(finding(
                "ssh-no-pubkey",
                "SSH public key authentication is disabled",
                "high",
                "SSH",
                "Key-based login is not available, forcing passwords or other methods.",
                "pubkeyauthentication no",
                "Set `PubkeyAuthentication yes`.",
            ));
        }
        if ssh.get("x11forwarding").map(String::as_str) == Some("yes") {
            findings.push(finding(
                "ssh-x11",
                "SSH X11 forwarding is enabled",
                "low",
                "SSH",
                "X11 forwarding enlarges the attack surface of SSH sessions.",
                "x11forwarding yes",
                "Set `X11Forwarding no` unless it is required.",
            ));
        }
        if ssh
            .get("maxauthtries")
            .and_then(|value| value.parse::<u32>().ok())
            .is_some_and(|value| value > 5)
        {
            findings.push(finding(
                "ssh-max-auth-tries",
                "SSH MaxAuthTries is high",
                "low",
                "SSH",
                "A high number of authentication attempts helps brute-force attempts.",
                &format!("maxauthtries {}", ssh["maxauthtries"]),
                "Set `MaxAuthTries 3` or lower.",
            ));
        }

        let firewall = section(&sections, "FIREWALL").join("\n");
        let firewall_active = firewall.contains("running")
            || firewall.contains("Status: active")
            || firewall.lines().any(|line| line.trim() == "active")
            || firewall.contains("-P INPUT DROP")
            || firewall.contains("-P INPUT REJECT")
            || firewall.lines().any(|line| line.starts_with("-A INPUT"));
        if firewall_active {
            passed += 1;
        } else {
            findings.push(finding(
                "firewall",
                "No active host firewall detected",
                "high",
                "Network",
                "firewalld/ufw/iptables did not report an active policy.",
                &firewall,
                "Enable firewalld or ufw and allow only the required ports.",
            ));
        }

        let selinux = section(&sections, "SELINUX").join("\n");
        if selinux.contains("Enforcing") || selinux.contains("apparmor-enabled") {
            passed += 1;
        } else if selinux.contains("Permissive") {
            findings.push(finding(
                "mac-permissive",
                "SELinux is permissive",
                "medium",
                "Hardening",
                "SELinux is active but does not enforce policy.",
                &selinux,
                "Set SELinux to enforcing after validating the workload.",
            ));
        } else if selinux.contains("Disabled") {
            findings.push(finding(
                "mac-disabled",
                "SELinux is disabled",
                "medium",
                "Hardening",
                "No SELinux enforcing policy is active.",
                &selinux,
                "Enable SELinux in enforcing mode if the distribution supports it.",
            ));
        } else {
            findings.push(finding(
                "mac-unknown",
                "MAC status could not be determined",
                "info",
                "Hardening",
                "Neither SELinux nor AppArmor status was available.",
                &selinux,
                "Check the distribution's mandatory access control configuration.",
            ));
        }

        let updates = security_update_lines(&sections);
        if updates.is_empty() {
            passed += 1;
        } else {
            let high = updates.len() > 10;
            findings.push(finding(
                "security-updates",
                "Pending security updates",
                if high { "high" } else { "medium" },
                "Patching",
                &format!("{} security update line(s) reported.", updates.len()),
                &updates.join("\n"),
                "Apply security updates and restart affected services.",
            ));
        }

        if !section(&sections, "REBOOT").is_empty() {
            findings.push(finding(
                "reboot-required",
                "The host reports a pending reboot",
                "low",
                "Patching",
                "A kernel or critical library update requires a reboot to become effective.",
                &section(&sections, "REBOOT").join("\n"),
                "Schedule a reboot after validating the workload.",
            ));
        }

        let uid_zero: Vec<String> = section(&sections, "PASSWD")
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        let roots: Vec<&String> = uid_zero
            .iter()
            .filter(|user| user.as_str() != "root")
            .collect();
        if roots.is_empty() {
            passed += 1;
        } else {
            findings.push(finding(
                "uid-zero",
                "Additional UID 0 accounts exist",
                "critical",
                "Accounts",
                "Every UID 0 account has full root privileges.",
                &roots
                    .iter()
                    .map(|user| format!("{user}: UID 0"))
                    .collect::<Vec<_>>()
                    .join("\n"),
                "Remove or change the UID of unknown accounts.",
            ));
        }

        let empty_passwords: Vec<String> = section(&sections, "SHADOW")
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        if empty_passwords.is_empty() {
            passed += 1;
        } else {
            findings.push(finding(
                "empty-passwords",
                "Accounts with empty password hashes",
                "critical",
                "Accounts",
                "These accounts can authenticate without a password.",
                &empty_passwords.join("\n"),
                "Lock the accounts or set a strong password immediately.",
            ));
        }

        let mut perms = HashMap::new();
        for line in section(&sections, "PERMS") {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() >= 3 {
                perms.insert(
                    fields[2].to_string(),
                    (fields[0].to_string(), fields[1].to_string()),
                );
            }
        }
        for (path, allowed_modes, severity, label) in [
            (
                "/etc/shadow",
                &["0", "000", "600", "640"][..],
                "high",
                "shadow",
            ),
            (
                "/etc/sudoers",
                &["400", "440", "600"][..],
                "high",
                "sudoers",
            ),
            ("/etc/passwd", &["644", "664"][..], "medium", "passwd"),
        ] {
            if let Some((mode, owner)) = perms.get(path) {
                if allowed_modes.contains(&mode.as_str()) && owner.starts_with("root:") {
                    passed += 1;
                } else {
                    findings.push(finding(
                        &format!("perms-{label}"),
                        &format!("Unexpected permissions on {path}"),
                        severity,
                        "Filesystem",
                        &format!("{} mode {mode} owner {owner}", path),
                        &format!("{path} {mode} {owner}"),
                        "Set the file owner to root and restrict permissions.",
                    ));
                }
            }
        }

        let nopasswd: Vec<String> = section(&sections, "SUDOERS")
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        if !nopasswd.is_empty() {
            let grants_all = nopasswd.iter().any(|line| {
                let upper = line.to_uppercase();
                upper.contains("NOPASSWD:")
                    && upper.split("NOPASSWD:").nth(1).is_some_and(|rest| {
                        rest.split_whitespace()
                            .any(|token| token.trim_matches(',').trim() == "ALL")
                    })
            });
            findings.push(finding(
                "sudo-nopasswd",
                if grants_all {
                    "Passwordless sudo grants full root (NOPASSWD: ALL)"
                } else {
                    "Passwordless sudo entries found"
                },
                if grants_all { "high" } else { "medium" },
                "Accounts",
                &format!("{} sudoers line(s) contain NOPASSWD.", nopasswd.len()),
                &nopasswd.join("\n"),
                "Remove unknown users and restrict each NOPASSWD rule to the exact commands needed.",
            ));
        }

        let world_writable: Vec<String> = section(&sections, "WORLD")
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        if world_writable.is_empty() {
            passed += 1;
        } else {
            findings.push(finding(
                "world-writable-etc",
                "World-writable files under /etc",
                "high",
                "Filesystem",
                "Any local user can modify these configuration files.",
                &world_writable.join("\n"),
                "Remove world-write permissions and investigate how they appeared.",
            ));
        }

        let suid: Vec<String> = section(&sections, "SUID")
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        if let Some(suspicious) = suid
            .iter()
            .find(|path| path.starts_with("/tmp/") || path.starts_with("/home/"))
        {
            findings.push(finding(
                "suid-suspicious",
                "SUID binary in a user-writable location",
                "critical",
                "Filesystem",
                "A SUID binary outside the system directories is a common privilege-escalation artifact.",
                suspicious,
                "Remove the SUID bit and investigate the binary.",
            ));
        }

        let listeners = section(&sections, "LISTEN").join("\n");
        for (port, label) in [
            ("3306", "MariaDB/MySQL"),
            ("5432", "PostgreSQL"),
            ("6379", "Redis"),
            ("27017", "MongoDB"),
        ] {
            if listeners.lines().any(|line| {
                line.contains(&format!("0.0.0.0:{port}"))
                    || line.contains(&format!("[::]:{port}"))
                    || line.contains(&format!("*:{port}"))
            }) {
                findings.push(finding(
                    &format!("public-db-{port}"),
                    &format!("{label} is listening on all interfaces"),
                    "critical",
                    "Network",
                    &format!("Port {port} is exposed on 0.0.0.0/::."),
                    &listeners,
                    "Bind the database to 127.0.0.1 and restrict the port with the firewall.",
                ));
            }
        }

        let tmp_lines: Vec<String> = section(&sections, "TMP")
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        if !tmp_lines.is_empty() {
            findings.push(finding(
                "tmp-executables",
                "Executable files or processes in /tmp or /dev/shm",
                "high",
                "Persistence",
                "Temporary directories are a common location for droppers and miners.",
                &tmp_lines.join("\n"),
                "Identify the files/processes, capture evidence, and remove persistence.",
            ));
        }

        let insecure_keys: Vec<String> = section(&sections, "KEYS")
            .iter()
            .filter_map(|line| {
                let mut fields = line.split('|');
                let path = fields.next()?.trim();
                let mode = fields.next()?.trim();
                let owner = fields.next()?.trim();
                let parsed = u32::from_str_radix(mode, 8).ok()?;
                (parsed & 0o022 != 0).then(|| format!("{path} {owner} {mode}"))
            })
            .collect();
        if !insecure_keys.is_empty() {
            findings.push(finding(
                "ssh-key-perms",
                "Authorized_keys files are group/world writable",
                "high",
                "SSH",
                "A writable authorized_keys file allows another local user to add keys.",
                &insecure_keys.join("\n"),
                "Set authorized_keys to mode 600 and ensure the owner is the target user.",
            ));
        }

        match web_verdict(&section(&sections, "WEB").join("\n")) {
            Some(WebVerdict::OutdatedSource(major, minor)) => {
                findings.push(finding(
                    "web-version",
                    "nginx was built from source and is older than 1.24",
                    "medium",
                    "Patching",
                    &format!(
                        "nginx {major}.{minor} is not managed by the distribution package manager, so it does not receive backported fixes.",
                    ),
                    &section(&sections, "WEB").join("\n"),
                    "Update the source build or migrate to the distribution/official stable package, then reload nginx.",
                ));
            }
            Some(WebVerdict::BinaryBehindPackage(binary, package)) => {
                findings.push(finding(
                    "web-version-mismatch",
                    "nginx binary is older than the installed package",
                    "high",
                    "Patching",
                    &format!(
                        "The nginx in PATH reports {}.{} but the installed package is {}.{}. A stale binary in PATH or a missing reload is likely.",
                        binary.0, binary.1, package.0, package.1
                    ),
                    &section(&sections, "WEB").join("\n"),
                    "Run `systemctl reload nginx` (or restart it) and confirm `command -v nginx` points to the updated binary.",
                ));
            }
            Some(WebVerdict::Current | WebVerdict::SourceCurrent) => passed += 1,
            // Pending package updates are reported by the security-updates check.
            Some(WebVerdict::PendingUpdate) | None => {}
        }

        let tmp_processes: Vec<String> = section(&sections, "TMPPROC")
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        if !tmp_processes.is_empty() {
            findings.push(finding(
                "tmp-processes",
                "Processes are running from temporary directories",
                "critical",
                "Persistence",
                "Executables launched from /tmp, /dev/shm or /var/tmp, or whose binary was deleted, are a strong indicator of an active implant.",
                &tmp_processes.join("\n"),
                "Open Security → Incident, kill the process and quarantine the binary. Preserve a hash before removing it.",
            ));
        }

        let bad_env: Vec<String> = section(&sections, "BADENV")
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();
        if !bad_env.is_empty() {
            findings.push(finding(
                "suspicious-env",
                "Process environments point executables to temporary paths",
                "high",
                "Persistence",
                "Variables such as npm_config_node_gyp, LD_PRELOAD or NODE_OPTIONS referencing /tmp are used to relaunch payloads on every build or restart.",
                &bad_env.join("\n"),
                "Inspect the parent process (PM2/systemd), remove the variable and restart the service from a clean unit file.",
            ));
        }

        let preload = section(&sections, "PRELOAD").join("\n");
        if !preload.trim().is_empty() {
            findings.push(finding(
                "ld-preload",
                "/etc/ld.so.preload is present",
                "critical",
                "Persistence",
                "A preload library can intercept system calls and hide malware.",
                &preload,
                "Inspect the library, remove the preload entry, and investigate the host.",
            ));
        }

        let failed_logins = section(&sections, "LASTB")
            .iter()
            .filter(|line| {
                let line = line.trim();
                !line.is_empty() && !line.starts_with("btmp") && !line.starts_with("wtmp")
            })
            .count();
        if failed_logins > 100 {
            findings.push(finding(
                "brute-force",
                "High number of failed login attempts",
                "high",
                "Authentication",
                &format!("{failed_logins} failed login lines in lastb."),
                &section(&sections, "LASTB").join("\n"),
                "Enable fail2ban/rate limiting, disable password auth, and review source IPs.",
            ));
        } else if failed_logins > 20 {
            findings.push(finding(
                "brute-force",
                "Failed login attempts detected",
                "medium",
                "Authentication",
                &format!("{failed_logins} failed login lines in lastb."),
                &section(&sections, "LASTB").join("\n"),
                "Review the source IPs and consider fail2ban or key-only SSH.",
            ));
        } else {
            passed += 1;
        }

        let cron = CronManager::list(pools, profile).await.ok();
        if let Some(cron) = &cron {
            let suspicious: Vec<_> = cron
                .entries
                .iter()
                .filter(|entry| entry.suspicious)
                .collect();
            if !suspicious.is_empty() {
                findings.push(finding(
                    "suspicious-cron",
                    "Suspicious cron entries",
                    "high",
                    "Persistence",
                    "Cron entries reference temporary paths or download/execute patterns.",
                    &suspicious
                        .iter()
                        .map(|entry| {
                            format!("{}: {} {}", entry.source, entry.schedule, entry.command)
                        })
                        .collect::<Vec<_>>()
                        .join("\n"),
                    "Review and remove unauthorized cron entries.",
                ));
            }
            if !cron.at_jobs.is_empty() {
                findings.push(finding(
                    "at-jobs",
                    "Pending at jobs",
                    "low",
                    "Persistence",
                    "Queued at jobs can execute later, including after the next reboot.",
                    &cron.at_jobs.join("\n"),
                    "Inspect and remove unknown at jobs.",
                ));
            }
        }

        let summary = summarize(&findings, passed);
        let score = score(&findings);
        let hostname = first(&sections, "HOST");
        Ok(SecurityReport {
            id: None,
            timestamp: Utc::now().timestamp(),
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            hostname,
            score,
            summary,
            findings,
            cron,
            duration_ms: started.elapsed().as_millis() as u64,
        })
    }
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

fn finding(
    id: &str,
    title: &str,
    severity: &str,
    category: &str,
    detail: &str,
    evidence: &str,
    remediation: &str,
) -> SecurityFinding {
    SecurityFinding {
        id: id.to_string(),
        title: title.to_string(),
        severity: severity.to_string(),
        category: category.to_string(),
        status: "fail".to_string(),
        detail: detail.to_string(),
        evidence: evidence.trim().to_string(),
        remediation: remediation.to_string(),
        fixable: crate::application::remediation::is_fixable(id),
    }
}

fn summarize(findings: &[SecurityFinding], passed: u32) -> SecuritySummary {
    let mut summary = SecuritySummary {
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
        passed,
    };
    for finding in findings {
        match finding.severity.as_str() {
            "critical" => summary.critical += 1,
            "high" => summary.high += 1,
            "medium" => summary.medium += 1,
            "low" => summary.low += 1,
            _ => summary.info += 1,
        }
    }
    summary
}

fn score(findings: &[SecurityFinding]) -> u32 {
    let mut score = 100i32;
    for finding in findings {
        score -= match finding.severity.as_str() {
            "critical" => 25,
            "high" => 15,
            "medium" => 7,
            "low" => 3,
            _ => 0,
        };
    }
    score.clamp(0, 100) as u32
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

fn key_values(lines: &[String]) -> HashMap<String, String> {
    lines
        .iter()
        .filter_map(|line| {
            let mut parts = line.split_whitespace();
            let key = parts.next()?.to_lowercase();
            let value = parts.collect::<Vec<_>>().join(" ");
            Some((key, value))
        })
        .collect()
}

#[derive(Debug, PartialEq, Eq)]
enum WebVerdict {
    /// Package-managed nginx, no pending updates: backports make the upstream
    /// version irrelevant.
    Current,
    /// Package-managed nginx with a newer release available.
    PendingUpdate,
    /// Package updated but the binary in PATH still reports an older minor.
    BinaryBehindPackage((u32, u32), (u32, u32)),
    /// Source build below 1.24 with no distribution backports.
    OutdatedSource(u32, u32),
    /// Source build at 1.24 or newer.
    SourceCurrent,
}

fn web_verdict(text: &str) -> Option<WebVerdict> {
    let binary = nginx_version(text)?;
    // Distributions split nginx into several packages (nginx, nginx-core, ...);
    // keep the highest one so an upgrade in progress cannot hide behind a meta package.
    let installed = text
        .lines()
        .filter_map(|line| line.trim().strip_prefix("package="))
        .filter_map(package_version)
        .max();
    let pending = field_value(text, "pending")
        .map(|value| value != "0")
        .unwrap_or(false);

    Some(match installed {
        Some(package) if package > binary => WebVerdict::BinaryBehindPackage(binary, package),
        Some(_) if pending => WebVerdict::PendingUpdate,
        Some(_) => WebVerdict::Current,
        None if binary < (1, 24) => WebVerdict::OutdatedSource(binary.0, binary.1),
        None => WebVerdict::SourceCurrent,
    })
}

fn field_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|line| {
        line.trim()
            .strip_prefix(&format!("{key}="))
            .map(|value| value.trim().to_string())
    })
}

/// Turns `1.20.1-16.el9` or `1.28.0-1.el9.nginx` into `(1, 20)` / `(1, 28)`.
fn package_version(raw: &str) -> Option<(u32, u32)> {
    let version = raw.split('-').next()?.trim();
    let mut parts = version.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn nginx_version(text: &str) -> Option<(u32, u32)> {
    let version = text.split("nginx/").nth(1)?;
    let mut parts = version.split(|c: char| !c.is_ascii_digit());
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    Some((major, minor))
}

fn security_update_lines(sections: &HashMap<String, Vec<String>>) -> Vec<String> {
    section(sections, "UPDATES")
        .iter()
        .map(|line| line.trim().to_string())
        .filter(|line| {
            !line.is_empty()
                && !line.starts_with("Last metadata")
                && !line.starts_with("Available Upgrades")
                && !line.starts_with("===")
                && !line.starts_with("Loading")
                && line.chars().any(|c| c.is_ascii_alphabetic())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn scores_findings_by_severity() {
        let findings = vec![
            finding("a", "a", "critical", "x", "", "", ""),
            finding("b", "b", "high", "x", "", "", ""),
            finding("c", "c", "medium", "x", "", "", ""),
            finding("d", "d", "low", "x", "", "", ""),
        ];
        assert_eq!(score(&findings), 50);
        let summary = summarize(&findings, 3);
        assert_eq!(summary.critical, 1);
        assert_eq!(summary.high, 1);
        assert_eq!(summary.medium, 1);
        assert_eq!(summary.low, 1);
        assert_eq!(summary.passed, 3);
    }

    #[test]
    fn parses_sshd_key_values() {
        let values = key_values(&[
            "permitrootlogin no".into(),
            "passwordauthentication no".into(),
        ]);
        assert_eq!(
            values.get("permitrootlogin").map(String::as_str),
            Some("no")
        );
        assert_eq!(
            values.get("passwordauthentication").map(String::as_str),
            Some("no")
        );
    }

    #[test]
    fn distro_backports_are_not_flagged_as_old() {
        let current =
            "path=/usr/sbin/nginx\nnginx version: nginx/1.20.1\npackage=1.20.1-16.el9\npending=0\n";
        assert_eq!(web_verdict(current), Some(WebVerdict::Current));

        let pending = "nginx version: nginx/1.20.1\npackage=1.20.1-16.el9\npending=100\n";
        assert_eq!(web_verdict(pending), Some(WebVerdict::PendingUpdate));

        let split_packages = "nginx version: nginx/1.20.1\npackage=1.20.1-16.el9\npackage=1.20.1-17.el9\npending=0\n";
        assert_eq!(web_verdict(split_packages), Some(WebVerdict::Current));

        let updated = "nginx version: nginx/1.20.1\npackage=1.28.0-1.el9.nginx\npending=0\n";
        assert_eq!(
            web_verdict(updated),
            Some(WebVerdict::BinaryBehindPackage((1, 20), (1, 28)))
        );

        let source_old = "nginx version: nginx/1.20.1\n";
        assert_eq!(
            web_verdict(source_old),
            Some(WebVerdict::OutdatedSource(1, 20))
        );

        let source_new = "nginx version: nginx/1.26.2\n";
        assert_eq!(web_verdict(source_new), Some(WebVerdict::SourceCurrent));

        assert_eq!(web_verdict("no nginx here"), None);
    }

    #[test]
    fn parses_package_versions() {
        assert_eq!(package_version("1.20.1-16.el9"), Some((1, 20)));
        assert_eq!(package_version("1.28.0-1.el9.nginx"), Some((1, 28)));
        assert_eq!(package_version("1.24.0-1~bookworm"), Some((1, 24)));
        assert_eq!(package_version("garbage"), None);
    }

    #[test]
    fn reads_web_fields() {
        let text =
            "path=/usr/sbin/nginx\nnginx version: nginx/1.20.1\npackage=1.20.1-16.el9\npending=0\n";
        assert_eq!(
            field_value(text, "package").as_deref(),
            Some("1.20.1-16.el9")
        );
        assert_eq!(field_value(text, "pending").as_deref(), Some("0"));
        assert_eq!(
            field_value(text, "path").as_deref(),
            Some("/usr/sbin/nginx")
        );
        assert_eq!(field_value(text, "missing"), None);
    }

    #[test]
    fn extracts_nginx_version() {
        assert_eq!(nginx_version("nginx version: nginx/1.20.1"), Some((1, 20)));
        assert_eq!(nginx_version("nginx/1.31.8"), Some((1, 31)));
        assert_eq!(nginx_version("no nginx"), None);
    }

    #[test]
    fn filters_security_update_noise() {
        let mut sections = HashMap::new();
        sections.insert(
            "UPDATES".into(),
            vec![
                "Last metadata expiration check".into(),
                "nginx-core.x86_64 1.20.1-32.el9 appstream".into(),
                "".into(),
            ],
        );
        assert_eq!(security_update_lines(&sections).len(), 1);
    }
}
