use crate::application::pool::PoolManager;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, ListeningPort, NetworkConnection, NetworkReport};
use chrono::Utc;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

const NET_TIMEOUT: Duration = Duration::from_secs(25);

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
        let connections = parse_connections(section(&sections, "CONN"));

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

    // ss:  tcp LISTEN 0 511 0.0.0.0:80 0.0.0.0:* users:(("nginx",pid=1,fd=6))
    // netstat: tcp 0 0 0.0.0.0:80 0.0.0.0:* LISTEN 1/nginx
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

fn parse_connections(lines: &[String]) -> Vec<NetworkConnection> {
    lines
        .iter()
        .filter_map(|line| {
            let fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() < 5 {
                return None;
            }
            let protocol = fields[0].to_lowercase();
            let netstat_style = fields[1].chars().all(|c| c.is_ascii_digit());
            let state = if netstat_style {
                fields.get(5).copied().unwrap_or("ESTABLISHED").to_string()
            } else {
                fields[1].to_string()
            };
            // ss:    tcp ESTAB 0 0 local peer users:(("node",pid=1,fd=3))
            // netstat: tcp 0 0 local peer ESTABLISHED 1/node
            let (local, remote, process_field) = if netstat_style {
                (
                    fields[3],
                    fields[4],
                    fields.get(6).copied().unwrap_or("").to_string(),
                )
            } else {
                (fields[4], fields[5], fields[6..].join(" "))
            };
            let (process, pid) = parse_process(&process_field, netstat_style);
            Some(NetworkConnection {
                protocol,
                state,
                local: local.to_string(),
                remote: remote.to_string(),
                process,
                pid,
            })
        })
        .take(200)
        .collect()
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
        let connections = parse_connections(&lines);
        assert_eq!(connections.len(), 2);
        assert_eq!(connections[0].remote, "153.75.94.153:8080");
        assert_eq!(connections[0].process, "node");
        assert_eq!(connections[0].pid, Some(658292));
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
}
