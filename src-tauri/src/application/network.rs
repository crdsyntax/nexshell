use crate::application::pool::PoolManager;
use crate::error::{AppError, AppResult};
use crate::models::{
    ConnectionInspection, ConnectionProfile, InspectionSection, ListeningPort, NetworkConnection,
    NetworkReport,
};
use chrono::Utc;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

const NET_TIMEOUT: Duration = Duration::from_secs(25);
const INSPECT_TIMEOUT: Duration = Duration::from_secs(40);
const MAX_LINUX_PID: u32 = 4_194_304;

const NET_SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
echo __HOST__
hostname 2>/dev/null
echo __LISTEN__
if command -v ss >/dev/null 2>&1; then
  ss -tulpnH 2>/dev/null
else
  netstat -tulpn 2>/dev/null | tail -n +3
fi
echo __CONN__
if command -v ss >/dev/null 2>&1; then
  ss -tunpH state established 2>/dev/null
else
  netstat -tunp 2>/dev/null | grep ESTABLISHED
fi
echo __TRAFFIC__
if command -v ss >/dev/null 2>&1; then
  ss -tinpH state established 2>/dev/null
fi
echo __STATS__
if command -v ss >/dev/null 2>&1; then ss -s 2>/dev/null; fi
echo __DNS__
cat /etc/resolv.conf 2>/dev/null | grep -E '^nameserver' | head -5
echo __ROUTE__
ip route show default 2>/dev/null | head -3
exit 0
"####;

pub struct NetworkManager;

impl NetworkManager {
    pub async fn scan(
        pools: &PoolManager,
        profile: &ConnectionProfile,
    ) -> AppResult<NetworkReport> {
        let command = as_root(profile, NET_SCRIPT);
        let output = pools
            .execute_with_category(&profile.id, &command, NET_TIMEOUT, "network")
            .await?;
        if !output.success() && output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "network scan failed: {}",
                output.stderr.trim()
            )));
        }

        let sections = collect_sections(&output.stdout);
        let listening = parse_listening(section(&sections, "LISTEN"));
        let mut connections = parse_connection_blocks(section(&sections, "CONN"));
        let traffic = parse_connection_blocks(section(&sections, "TRAFFIC"));
        for sample in traffic {
            if let Some(connection) = connections
                .iter_mut()
                .find(|item| item.local == sample.local && item.remote == sample.remote)
            {
                connection.bytes_sent = sample.bytes_sent;
                connection.bytes_received = sample.bytes_received;
                connection.rtt = sample.rtt;
                if connection.process.is_empty() {
                    connection.process = sample.process;
                    connection.pid = sample.pid;
                }
            } else {
                connections.push(sample);
            }
        }

        let mut summary = Vec::new();
        let public = listening.iter().filter(|port| port.public).count();
        summary.push(format!("{} listening sockets", listening.len()));
        summary.push(format!("{public} bound to all interfaces"));
        summary.push(format!("{} established connections", connections.len()));

        let mut stats = clean(section(&sections, "STATS"));
        stats.extend(clean(section(&sections, "DNS")));
        stats.extend(clean(section(&sections, "ROUTE")));

        Ok(NetworkReport {
            hostname: first(&sections, "HOST"),
            generated_at: Utc::now().timestamp(),
            listening,
            connections,
            listening_summary: summary,
            stats,
        })
    }

    pub async fn inspect(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        pid: u32,
        remote: &str,
        probe_tls: bool,
    ) -> AppResult<ConnectionInspection> {
        if pid <= 1 || pid > MAX_LINUX_PID {
            return Err(AppError::Validation(format!("invalid PID {pid}")));
        }
        let (ip, port) = split_endpoint(remote)
            .ok_or_else(|| AppError::Validation(format!("invalid remote endpoint '{remote}'")))?;
        ip.parse::<IpAddr>()
            .map_err(|_| AppError::Validation(format!("invalid IP address '{ip}'")))?;

        let script = inspect_script(pid, &ip, port, probe_tls);
        let command = as_root(profile, &script);
        let output = pools
            .execute_with_category(&profile.id, &command, INSPECT_TIMEOUT, "network")
            .await?;
        if !output.success() && output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "connection inspection failed: {}",
                output.stderr.trim()
            )));
        }

        let sections = inspection_sections(&collect_sections(&output.stdout));
        if sections.is_empty() {
            return Err(AppError::NotFound(format!(
                "no inspection data for pid {pid} and {remote}"
            )));
        }

        Ok(ConnectionInspection {
            pid,
            remote: remote.to_string(),
            generated_at: Utc::now().timestamp(),
            sections,
        })
    }
}

const INSPECT_SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
pid=__PID__
ip=__IP__
port=__PORT__
echo __SOCKET__
ss -tinpe 2>/dev/null | grep -F "pid=$pid," | grep -F "$ip:$port" | head -n 5
echo __PROCESS__
ps -o pid=,ppid=,user=,stat=,lstart=,args= -p "$pid" 2>/dev/null
echo __PARENT__
ppid=$(ps -o ppid= -p "$pid" 2>/dev/null | tr -d ' ')
[ -n "$ppid" ] && ps -o pid=,user=,args= -p "$ppid" 2>/dev/null
echo __FDS__
ls -l "/proc/$pid/fd" 2>/dev/null | awk '$NF ~ /socket/ {print $9, $10, $11}'
echo __PEERS__
ss -tunpe 2>/dev/null | grep -F "pid=$pid," | head -n 30
echo __DNS__
getent hosts "$ip" 2>/dev/null
echo __CWD__
readlink -f "/proc/$pid/cwd" 2>/dev/null
echo __ENV__
tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | sed -E 's#^([A-Za-z_][A-Za-z0-9_]*)="?([A-Za-z][A-Za-z0-9+.-]*://)([^/@]*@)?([^/:]+)(:[0-9]+)?.*#\1=\2\4\5#; t; s/=.*/=<redacted>/' | grep -Ei 'url|host|port|redis|mongo|mysql|postgres|database|db_|aws|s3|proxy|endpoint|api' | sort -u | head -n 40
echo __HITS__
cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null)
host=$(getent hosts "$ip" 2>/dev/null | awk '{print $2}' | head -n 1)
if [ -n "$cwd" ] && [ -d "$cwd" ]; then
  { timeout 8 grep -rIn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=dist --exclude-dir=build --exclude-dir=vendor --exclude-dir=coverage --exclude='*.map' -- "$ip" "$cwd" 2>/dev/null | cut -d: -f1,2 | head -n 20 | sed 's/^/[ip] /'; } || true
  if [ -n "$host" ]; then
    { timeout 8 grep -rIn --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=dist --exclude-dir=build --exclude-dir=vendor --exclude-dir=coverage --exclude='*.map' -- "$host" "$cwd" 2>/dev/null | cut -d: -f1,2 | head -n 20 | sed 's/^/[host] /'; } || true
  fi
  { timeout 8 grep -rInE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next --exclude-dir=dist --exclude-dir=build --exclude-dir=vendor --exclude-dir=coverage --exclude='*.map' -- "(^|[^0-9])$port([^0-9]|$)" "$cwd" 2>/dev/null | cut -d: -f1,2 | head -n 20 | sed 's/^/[port] /'; } || true
fi
echo __LSOF__
if command -v lsof >/dev/null 2>&1; then lsof -nP -p "$pid" -i 2>/dev/null | head -n 40; fi
__TLS__exit 0
"####;

const TLS_BLOCK: &str = r####"echo __TLS__
if command -v openssl >/dev/null 2>&1; then
  connect="$ip:$port"
  case "$ip" in *:*) connect="[$ip]:$port" ;; esac
  timeout 6 openssl s_client -connect "$connect" -brief </dev/null 2>&1 | head -n 30
else
  echo "openssl no disponible en el host"
fi
"####;

fn inspect_script(pid: u32, ip: &str, port: u16, probe_tls: bool) -> String {
    INSPECT_SCRIPT
        .replace("__PID__", &pid.to_string())
        .replace("__IP__", ip)
        .replace("__PORT__", &port.to_string())
        .replace("__TLS__", if probe_tls { TLS_BLOCK } else { "" })
}

fn inspection_sections(sections: &HashMap<String, Vec<String>>) -> Vec<InspectionSection> {
    let mut out = Vec::new();
    let mut push = |title: &str, keys: &[&str]| {
        let lines: Vec<String> = keys
            .iter()
            .flat_map(|key| section(sections, key))
            .map(|line| line.trim_end().to_string())
            .filter(|line| !line.trim().is_empty())
            .collect();
        if !lines.is_empty() {
            out.push(InspectionSection {
                title: title.to_string(),
                lines,
            });
        }
    };
    push("Socket TCP", &["SOCKET"]);
    push("Proceso", &["PROCESS", "PARENT"]);
    push("Descriptores de socket", &["FDS"]);
    push("Conexiones del PID", &["PEERS"]);
    push("DNS inverso", &["DNS"]);
    push("Directorio de trabajo", &["CWD"]);
    push("Entorno (solo nombres)", &["ENV"]);
    push("Referencias en el proyecto", &["HITS"]);
    push("lsof", &["LSOF"]);
    push("TLS", &["TLS"]);
    out
}

fn as_root(profile: &ConnectionProfile, script: &str) -> String {
    if profile.username == "root" {
        script.to_string()
    } else if profile.elevated {
        format!(
            "sudo -n sh -c {}",
            crate::application::services::shell_quote(script)
        )
    } else {
        script.to_string()
    }
}

fn parse_listening(lines: &[String]) -> Vec<ListeningPort> {
    let mut ports: Vec<ListeningPort> = lines
        .iter()
        .filter_map(|line| parse_listening_line(line))
        .collect();
    ports.sort_by(|a, b| a.port.cmp(&b.port).then(a.protocol.cmp(&b.protocol)));
    ports.dedup_by(|a, b| a.protocol == b.protocol && a.local == b.local && a.pid == b.pid);
    ports
}

fn parse_listening_line(line: &str) -> Option<ListeningPort> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 5 {
        return None;
    }
    let protocol = fields[0].to_lowercase();
    if !protocol.starts_with("tcp") && !protocol.starts_with("udp") {
        return None;
    }

    let netstat_style = fields[1].chars().all(|c| c.is_ascii_digit());
    let process_field = if netstat_style {
        fields.get(6).copied().unwrap_or("").to_string()
    } else {
        fields[5..].join(" ")
    };
    let local = if netstat_style { fields[3] } else { fields[4] };

    let (ip, port) = split_endpoint(local)?;
    let (process, pid) = parse_process(&process_field, netstat_style);
    let public = matches!(
        ip.as_str(),
        "0.0.0.0" | "::" | "*" | "[::]" | ":::" | "0:0:0:0:0:0:0:0"
    ) || ip
        .parse::<IpAddr>()
        .map(|addr| addr.is_unspecified())
        .unwrap_or(false);

    Some(ListeningPort {
        protocol,
        local: local.to_string(),
        ip,
        port,
        process,
        pid,
        public,
    })
}

fn parse_connection_blocks(lines: &[String]) -> Vec<NetworkConnection> {
    let mut connections: Vec<NetworkConnection> = Vec::new();
    let mut current: Option<usize> = None;

    for line in lines {
        if line.trim().is_empty() {
            continue;
        }
        let indented = line.starts_with(' ') || line.starts_with('\t');
        if indented {
            if let Some(index) = current {
                let connection = &mut connections[index];
                if connection.bytes_sent == 0 {
                    connection.bytes_sent = metric(line, "bytes_sent:");
                }
                if connection.bytes_received == 0 {
                    connection.bytes_received = metric(line, "bytes_received:");
                }
                if connection.rtt.is_empty() {
                    connection.rtt = text_metric(line, "rtt:");
                }
            }
            continue;
        }

        match parse_connection_line(line.trim()) {
            Some(connection) => {
                connections.push(connection);
                current = Some(connections.len() - 1);
                if connections.len() >= 200 {
                    break;
                }
            }
            None => current = None,
        }
    }
    connections
}

fn metric(line: &str, key: &str) -> u64 {
    let Some(index) = line.find(key) else {
        return 0;
    };
    let rest = &line[index + key.len()..];
    let digits: String = rest.chars().take_while(|c| c.is_ascii_digit()).collect();
    digits.parse().unwrap_or(0)
}

fn text_metric(line: &str, key: &str) -> String {
    let Some(index) = line.find(key) else {
        return String::new();
    };
    let rest = &line[index + key.len()..];
    rest.split_whitespace()
        .next()
        .unwrap_or("")
        .trim_end_matches(',')
        .to_string()
}

fn parse_connection_line(line: &str) -> Option<NetworkConnection> {
    let tokens: Vec<&str> = line.split_whitespace().collect();
    if tokens.len() < 4 {
        return None;
    }
    let protocol = {
        let first = tokens[0].to_lowercase();
        if first.starts_with("tcp") || first.starts_with("udp") {
            first
        } else {
            "tcp".to_string()
        }
    };

    let mut plain: Vec<&str> = Vec::new();
    let mut process_tokens: Vec<&str> = Vec::new();
    let mut in_process = false;
    for token in tokens.iter().skip(1) {
        if !in_process && (token.contains("users:((") || token.starts_with("users:")) {
            in_process = true;
        }
        if in_process {
            process_tokens.push(token);
            if token.ends_with("))") {
                in_process = false;
            }
        } else if token.starts_with('(') && token.ends_with(')') {
            continue;
        } else {
            plain.push(token);
        }
    }

    let endpoints: Vec<(&str, String, u16)> = plain
        .iter()
        .filter_map(|token| {
            let (host, port) = split_endpoint(token)?;
            Some((*token, host, port))
        })
        .collect();
    if endpoints.len() < 2 {
        return None;
    }
    let (local, _, _) = &endpoints[0];
    let (remote, _, _) = &endpoints[1];

    let state = plain
        .iter()
        .find(|token| is_state(token))
        .map(|token| token.to_string())
        .unwrap_or_else(|| "ESTAB".to_string());

    let process_field = process_tokens.join(" ");
    let netstat_style = process_field.contains('/') && !process_field.contains("users:");
    let (process, pid) = if process_field.is_empty() {
        (String::new(), None)
    } else {
        parse_process(&process_field, netstat_style)
    };

    Some(NetworkConnection {
        protocol,
        state,
        local: local.to_string(),
        remote: remote.to_string(),
        bytes_sent: metric(line, "bytes_sent:"),
        bytes_received: metric(line, "bytes_received:"),
        process,
        pid,
        rtt: text_metric(line, "rtt:"),
    })
}

fn is_state(token: &str) -> bool {
    matches!(
        token.to_uppercase().as_str(),
        "ESTAB"
            | "ESTABLISHED"
            | "LISTEN"
            | "TIME-WAIT"
            | "CLOSE-WAIT"
            | "SYN-SENT"
            | "SYN-RECV"
            | "FIN-WAIT-1"
            | "FIN-WAIT-2"
            | "LAST-ACK"
            | "CLOSING"
            | "UNCONN"
    )
}

fn parse_process(field: &str, netstat_style: bool) -> (String, Option<u32>) {
    if netstat_style {
        let mut parts = field.splitn(2, '/');
        let pid = parts.next().and_then(|value| value.parse().ok());
        let name = parts.next().unwrap_or("").to_string();
        return (name, pid);
    }
    let name = field
        .split("((\"")
        .nth(1)
        .and_then(|rest| rest.split('"').next())
        .unwrap_or("")
        .to_string();
    let pid = field
        .split("pid=")
        .nth(1)
        .and_then(|rest| rest.split(|c: char| !c.is_ascii_digit()).next())
        .and_then(|value| value.parse().ok());
    (name, pid)
}

fn split_endpoint(value: &str) -> Option<(String, u16)> {
    let (host, port) = value.rsplit_once(':')?;
    let port = port.parse().ok()?;
    Some((host.trim_matches(['[', ']']).to_string(), port))
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

fn clean(lines: &[String]) -> Vec<String> {
    lines
        .iter()
        .map(|line| line.trim_end().to_string())
        .filter(|line| !line.trim().is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ss_listening_sockets() {
        let lines = vec![
            "tcp   LISTEN 0      511          0.0.0.0:80         0.0.0.0:*    users:((\"nginx\",pid=1201,fd=6))".to_string(),
            "tcp   LISTEN 0      151        127.0.0.1:3306       0.0.0.0:*    users:((\"mariadbd\",pid=829,fd=20))".to_string(),
            "udp   UNCONN 0      0            0.0.0.0:68         0.0.0.0:*    users:((\"dhclient\",pid=700,fd=7))".to_string(),
        ];
        let ports = parse_listening(&lines);
        assert_eq!(ports.len(), 3);
        let http = ports.iter().find(|port| port.port == 80).unwrap();
        assert_eq!(http.protocol, "tcp");
        assert_eq!(http.process, "nginx");
        assert_eq!(http.pid, Some(1201));
        assert!(http.public);
        let db = ports.iter().find(|port| port.port == 3306).unwrap();
        assert!(!db.public);
    }

    #[test]
    fn parses_netstat_listening_sockets() {
        let line = "tcp        0      0 0.0.0.0:22              0.0.0.0:*               LISTEN      1234/sshd";
        let port = parse_listening_line(line).unwrap();
        assert_eq!(port.port, 22);
        assert_eq!(port.process, "sshd");
        assert_eq!(port.pid, Some(1234));
        assert!(port.public);
    }

    #[test]
    fn parses_established_connections() {
        let lines = vec![
            "tcp   ESTAB 0      0      10.0.0.5:53222    153.75.94.153:8080  users:((\"node\",pid=658292,fd=31))".to_string(),
            "tcp   ESTAB 0      0      10.0.0.5:22       10.0.0.9:51234      users:((\"sshd\",pid=42,fd=4))".to_string(),
        ];
        let connections = parse_connection_blocks(&lines);
        assert_eq!(connections.len(), 2);
        assert_eq!(connections[0].remote, "153.75.94.153:8080");
        assert_eq!(connections[0].process, "node");
        assert_eq!(connections[0].pid, Some(658292));
    }

    #[test]
    fn survives_process_fields_with_spaces_and_shifts() {
        let line = "tcp users:((\"node /var/www/f\",pid=3013683,fd=23)) 165.232.158.163:36280 13.222.201.154:16556";
        let connection = parse_connection_line(line).unwrap();
        assert_eq!(connection.protocol, "tcp");
        assert_eq!(connection.local, "165.232.158.163:36280");
        assert_eq!(connection.remote, "13.222.201.154:16556");
        assert_eq!(connection.process, "node /var/www/f");
        assert_eq!(connection.pid, Some(3013683));
    }

    #[test]
    fn parses_traffic_counters() {
        let lines = vec![
            "tcp ESTAB 0 0 165.232.158.163:36280 13.222.201.154:16556 users:((\"node\",pid=3013683,fd=23))".to_string(),
            "     cubic wscale:7,7 rtt:0.123/0.045 ato:40 mss:1448 bytes_sent:1234 bytes_acked:1235 bytes_received:5678 segs_out:20".to_string(),
        ];
        let connections = parse_connection_blocks(&lines);
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].bytes_sent, 1234);
        assert_eq!(connections[0].bytes_received, 5678);
        assert_eq!(connections[0].rtt, "0.123/0.045");
    }

    #[test]
    fn parses_counters_when_ss_omits_proto_and_state() {
        let lines = vec![
            "0      0      127.0.0.1:38528    127.0.0.1:49374   users:((\"ai.opencode\",pid=13238,fd=27))".to_string(),
            "\t cubic wscale:10,10 rtt:0.129/0.045 bytes_sent:1856 bytes_received:45522017".to_string(),
        ];
        let connections = parse_connection_blocks(&lines);
        assert_eq!(connections.len(), 1);
        assert_eq!(connections[0].local, "127.0.0.1:38528");
        assert_eq!(connections[0].remote, "127.0.0.1:49374");
        assert_eq!(connections[0].bytes_sent, 1856);
        assert_eq!(connections[0].bytes_received, 45522017);
        assert_eq!(connections[0].pid, Some(13238));
    }

    #[test]
    fn handles_ipv6_endpoints() {
        assert_eq!(split_endpoint("[::]:443"), Some(("::".to_string(), 443)));
        assert_eq!(
            split_endpoint("127.0.0.1:6379"),
            Some(("127.0.0.1".to_string(), 6379))
        );
        assert_eq!(split_endpoint("no-port"), None);
    }

    #[test]
    fn builds_inspection_sections_in_order() {
        let mut sections = HashMap::new();
        sections.insert("SOCKET".to_string(), vec!["tcp ESTAB".to_string()]);
        sections.insert("PROCESS".to_string(), vec!["3013683 www-data".to_string()]);
        sections.insert("PARENT".to_string(), vec!["1 root pm2".to_string()]);
        sections.insert("ENV".to_string(), vec!["   ".to_string()]);
        sections.insert(
            "HITS".to_string(),
            vec!["[ip] /var/www/f/server.js:12".to_string()],
        );

        let result = inspection_sections(&sections);
        let titles: Vec<&str> = result.iter().map(|item| item.title.as_str()).collect();
        assert_eq!(
            titles,
            vec!["Socket TCP", "Proceso", "Referencias en el proyecto"]
        );
        assert_eq!(result[1].lines.len(), 2);
    }

    #[test]
    fn inspection_script_targets_the_endpoint_and_optional_tls() {
        let script = inspect_script(3013683, "13.222.201.154", 16556, false);
        assert!(script.contains("pid=3013683"));
        assert!(script.contains("ip=13.222.201.154"));
        assert!(script.contains("port=16556"));
        assert!(!script.contains("openssl s_client"));

        let probed = inspect_script(3013683, "13.222.201.154", 16556, true);
        assert!(probed.contains("echo __TLS__"));
        assert!(probed.contains("openssl s_client"));
    }
}
