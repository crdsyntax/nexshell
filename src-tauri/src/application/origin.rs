use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{AccountEvidence, AccountOrigin, ConnectionProfile};
use chrono::{TimeZone, Utc};
use std::collections::HashMap;
use std::time::Duration;

const FORENSIC_TIMEOUT: Duration = Duration::from_secs(60);

const SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
user=__USER__
echo __META__
getent passwd "$user" 2>/dev/null
group=$(id -gn "$user" 2>/dev/null)
[ -n "$group" ] && getent group "$group" 2>/dev/null
stat -c 'passwd=%y' /etc/passwd 2>/dev/null
stat -c 'group=%y' /etc/group 2>/dev/null
stat -c 'shadow=%y' /etc/shadow 2>/dev/null
home=$(getent passwd "$user" 2>/dev/null | cut -d: -f6)
if [ -n "$home" ] && [ -d "$home" ]; then
  stat -c 'home_birth=%w' "$home" 2>/dev/null
  stat -c 'home_change=%z' "$home" 2>/dev/null
fi
[ -f "/var/spool/mail/$user" ] && stat -c 'mail_birth=%w' "/var/spool/mail/$user" 2>/dev/null
echo __AUDIT__
if command -v ausearch >/dev/null 2>&1; then
  ausearch -m ADD_USER,ADD_GROUP,USER_MGMT,GRP_MGMT,USER_CHAUTHTOK -i 2>/dev/null \
    | grep -iE "acct=\"?$user\"?|name=\"?$user\"?|op=add-(user|group)" | tail -60
else
  for f in /var/log/audit/audit.log /var/log/audit/audit.log.1 /var/log/audit/audit.log.2; do
    [ -f "$f" ] || continue
    grep -E 'ADD_USER|ADD_GROUP|USER_MGMT|GRP_MGMT|USER_CHAUTHTOK' "$f" 2>/dev/null \
      | grep -E "acct=\"?$user\"?|name=\"?$user\"?" | tail -40
  done
fi
echo __SECURE__
for f in /var/log/secure /var/log/secure-* /var/log/auth.log /var/log/auth.log.*; do
  [ -f "$f" ] || continue
  grep -iE 'useradd|groupadd|adduser|new user|new group|usermod' "$f" 2>/dev/null \
    | grep -F "$user" | tail -40
done
echo __LOGINS__
last -a -w "$user" 2>/dev/null | head -40
echo __SUDO__
for f in /var/log/secure /var/log/secure-* /var/log/auth.log /var/log/auth.log.*; do
  [ -f "$f" ] || continue
  grep -E 'sudo:.*(useradd|groupadd|adduser|usermod|chpasswd)' "$f" 2>/dev/null | tail -20
done
echo __HISTORY__
grep -nE '(useradd|adduser|groupadd|usermod|visudo|sudoers|chpasswd)' /root/.bash_history 2>/dev/null | tail -40
echo __SSHLOG__
for f in /var/log/secure /var/log/secure-* /var/log/auth.log /var/log/auth.log.*; do
  [ -f "$f" ] || continue
  grep -E 'Accepted (password|publickey) for root|session opened for user root' "$f" 2>/dev/null | tail -40
done
exit 0
"####;

const SESSION_SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
for ses in __SESSIONS__; do
  for f in /var/log/audit/audit.log /var/log/audit/audit.log.1 /var/log/audit/audit.log.2; do
    [ -f "$f" ] || continue
    grep -hE " ses=$ses " "$f" 2>/dev/null \
      | grep -oE 'addr=[0-9A-Fa-f.:]+|terminal=[^ ]+|auid=[0-9]+' \
      | sort -u | sed "s/^/ses=$ses /"
  done
done
exit 0
"####;

pub struct AccountOriginManager;

impl AccountOriginManager {
    pub async fn origin(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        user: &str,
    ) -> AppResult<AccountOrigin> {
        validate_user(user)?;
        let script = SCRIPT.replace("__USER__", &shell_quote(user));
        let output = pools
            .execute_with_category(
                &profile.id,
                &as_root(profile, &script),
                FORENSIC_TIMEOUT,
                "security",
            )
            .await?;
        if !output.success() && output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "cannot inspect account origin: {}",
                output.stderr.trim()
            )));
        }

        let sections = collect_sections(&output.stdout);
        let meta = parse_meta(section(&sections, "META"));
        let audit_lines = clean(section(&sections, "AUDIT"));
        let secure_lines = clean(section(&sections, "SECURE"));
        let sudo_lines = clean(section(&sections, "SUDO"));
        let history = clean(section(&sections, "HISTORY"));
        let ssh_log = clean(section(&sections, "SSHLOG"));
        let logins = clean(section(&sections, "LOGINS"));

        let sessions = extract_sessions(&audit_lines);
        let session_map = if sessions.is_empty() {
            HashMap::new()
        } else {
            Self::sessions(pools, profile, &sessions)
                .await
                .unwrap_or_default()
        };

        let mut evidence: Vec<AccountEvidence> = Vec::new();
        for line in &audit_lines {
            let actor = field(line, "auid=")
                .and_then(resolve_actor)
                .unwrap_or_else(|| "unknown".to_string());
            let session = field(line, "ses=").unwrap_or_default();
            let addr = session_map
                .get(&session)
                .map(|value| value.ip.clone())
                .filter(|value| !value.is_empty())
                .or_else(|| field(line, "addr="))
                .unwrap_or_default();
            evidence.push(AccountEvidence {
                kind: "auditd".to_string(),
                timestamp: audit_timestamp(line),
                actor,
                source_ip: addr,
                detail: truncate(line, 400),
            });
        }
        for line in &secure_lines {
            evidence.push(AccountEvidence {
                kind: "secure".to_string(),
                timestamp: log_timestamp(line),
                actor: String::new(),
                source_ip: String::new(),
                detail: truncate(line, 400),
            });
        }
        for line in &sudo_lines {
            evidence.push(AccountEvidence {
                kind: "sudo".to_string(),
                timestamp: log_timestamp(line),
                actor: sudo_actor(line),
                source_ip: String::new(),
                detail: truncate(line, 400),
            });
        }
        evidence.sort_by(|a, b| a.timestamp.cmp(&b.timestamp));

        let created_at = evidence
            .iter()
            .find(|event| !event.timestamp.is_empty())
            .map(|event| event.timestamp.clone())
            .or_else(|| {
                if meta.home_birth.is_empty() {
                    None
                } else {
                    Some(meta.home_birth.clone())
                }
            })
            .unwrap_or_default();
        let created_by = evidence
            .iter()
            .find(|event| !event.actor.is_empty())
            .map(|event| event.actor.clone())
            .unwrap_or_default();
        let source_ip = evidence
            .iter()
            .find(|event| !event.source_ip.is_empty())
            .map(|event| event.source_ip.clone())
            .unwrap_or_default();

        let mut notes = Vec::new();
        if audit_lines.is_empty() {
            notes.push(
                "auditd no tiene registros de creación: la cuenta se creó antes de habilitar \
                 audit o los logs se rotaron/borraron."
                    .to_string(),
            );
        }
        if secure_lines.is_empty() && sudo_lines.is_empty() {
            notes.push(
                "No hay useradd/groupadd en /var/log/secure ni en sudo: la creación no quedó \
                 registrada por el método habitual."
                    .to_string(),
            );
        }
        if source_ip.is_empty() {
            notes.push(
                "No se pudo correlacionar una IP de origen: revisa las sesiones SSH de root \
                 alrededor de la fecha de creación."
                    .to_string(),
            );
        }

        Ok(AccountOrigin {
            user: user.to_string(),
            account: meta.account,
            group: meta.group,
            passwd_mtime: meta.passwd_mtime,
            group_mtime: meta.group_mtime,
            shadow_mtime: meta.shadow_mtime,
            home_birth: meta.home_birth,
            home_change: meta.home_change,
            created_at,
            created_by,
            source_ip,
            evidence,
            logins,
            history,
            ssh_log,
            notes,
            audit_available: !audit_lines.is_empty(),
        })
    }

    async fn sessions(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        sessions: &[String],
    ) -> AppResult<HashMap<String, SessionInfo>> {
        let list = sessions.join(" ");
        let script = SESSION_SCRIPT.replace("__SESSIONS__", &list);
        let output = pools
            .execute_with_category(
                &profile.id,
                &as_root(profile, &script),
                Duration::from_secs(30),
                "security",
            )
            .await?;
        let mut map: HashMap<String, SessionInfo> = HashMap::new();
        for line in output.stdout.lines() {
            let entry = map.entry(session_of(line).unwrap_or_default()).or_default();
            if let Some(addr) = field(line, "addr=") {
                if !addr.is_empty() && addr != "?" {
                    entry.ip = addr;
                }
            }
            if let Some(terminal) = field(line, "terminal=") {
                if !terminal.is_empty() && terminal != "?" {
                    entry.terminal = terminal;
                }
            }
        }
        Ok(map)
    }
}

#[derive(Default)]
struct SessionInfo {
    ip: String,
    terminal: String,
}

#[derive(Default)]
struct Meta {
    account: String,
    group: String,
    passwd_mtime: String,
    group_mtime: String,
    shadow_mtime: String,
    home_birth: String,
    home_change: String,
}

fn parse_meta(lines: &[String]) -> Meta {
    let mut meta = Meta::default();
    for line in lines {
        let trimmed = line.trim();
        if let Some(value) = trimmed.strip_prefix("passwd=") {
            meta.passwd_mtime = value.to_string();
        } else if let Some(value) = trimmed.strip_prefix("group=") {
            meta.group_mtime = value.to_string();
        } else if let Some(value) = trimmed.strip_prefix("shadow=") {
            meta.shadow_mtime = value.to_string();
        } else if let Some(value) = trimmed.strip_prefix("home_birth=") {
            meta.home_birth = value.replace("birth:", "").trim().to_string();
        } else if let Some(value) = trimmed.strip_prefix("home_change=") {
            meta.home_change = value.to_string();
        } else if trimmed.contains(':') && meta.account.is_empty() {
            meta.account = trimmed.to_string();
        } else if trimmed.contains(':') && meta.group.is_empty() {
            meta.group = trimmed.to_string();
        }
    }
    meta
}

fn field(line: &str, key: &str) -> Option<String> {
    let start = line.find(key)? + key.len();
    let rest = &line[start..];
    let value: String = rest
        .chars()
        .take_while(|c| !c.is_whitespace() && *c != ',' && *c != ')' && *c != '"')
        .collect();
    Some(value.trim_matches('"').to_string())
}

fn resolve_actor(auid: String) -> Option<String> {
    if auid.is_empty() || auid == "4294967295" || auid == "unset" {
        return None;
    }
    Some(match auid.as_str() {
        "0" => "root (auid 0)".to_string(),
        other => format!("uid {other}"),
    })
}

fn extract_sessions(lines: &[String]) -> Vec<String> {
    let mut sessions: Vec<String> = lines
        .iter()
        .filter_map(|line| field(line, "ses="))
        .filter(|value| !value.is_empty() && value != "4294967295")
        .collect();
    sessions.sort();
    sessions.dedup();
    sessions.truncate(20);
    sessions
}

fn session_of(line: &str) -> Option<String> {
    field(line, "ses=")
}

fn audit_timestamp(line: &str) -> String {
    let Some(start) = line.find("audit(") else {
        return log_timestamp(line);
    };
    let rest = &line[start + 6..];
    let Some(end) = rest.find(')') else {
        return log_timestamp(line);
    };
    let stamp = rest[..end].trim();
    if stamp.contains('/') {
        return stamp
            .rsplit_once(':')
            .map(|(value, _)| value)
            .unwrap_or(stamp)
            .split('.')
            .next()
            .unwrap_or(stamp)
            .to_string();
    }
    let seconds = stamp.split('.').next().unwrap_or("");
    seconds
        .parse::<i64>()
        .ok()
        .and_then(|seconds| Utc.timestamp_opt(seconds, 0).single())
        .map(|date| date.format("%Y-%m-%d %H:%M:%S").to_string())
        .unwrap_or_else(|| stamp.to_string())
}

fn log_timestamp(line: &str) -> String {
    let parts: Vec<&str> = line.split_whitespace().take(3).collect();
    if parts.len() == 3 && parts[0].contains('-') {
        return parts.join(" ");
    }
    String::new()
}

fn sudo_actor(line: &str) -> String {
    line.split("sudo:")
        .nth(1)
        .and_then(|rest| rest.split(':').next())
        .map(|value| value.trim().to_string())
        .unwrap_or_default()
}

fn truncate(value: &str, max: usize) -> String {
    if value.len() <= max {
        return value.to_string();
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}…", &value[..end])
}

fn validate_user(user: &str) -> AppResult<()> {
    if user.is_empty()
        || user.len() > 32
        || !user
            .chars()
            .next()
            .map(|c| c.is_ascii_lowercase() || c == '_')
            .unwrap_or(false)
        || !user
            .chars()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-')
    {
        return Err(AppError::Validation(format!("invalid user name: {user}")));
    }
    Ok(())
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
    fn parses_audit_fields() {
        let line = "type=ADD_USER msg=audit(1793283475.123:4567) : pid=1 uid=0 auid=1000 ses=42 subj=x msg='op=add-user acct=\"pakchoi\" exe=\"/usr/sbin/useradd\" addr=203.0.113.9 terminal=pts/0 res=success'";
        assert_eq!(field(line, "auid="), Some("1000".to_string()));
        assert_eq!(field(line, "ses="), Some("42".to_string()));
        assert_eq!(field(line, "addr="), Some("203.0.113.9".to_string()));
        assert_eq!(field(line, "terminal="), Some("pts/0".to_string()));
        assert_eq!(audit_timestamp(line), "2026-10-29 14:17:55");
    }

    #[test]
    fn parses_human_audit_timestamp() {
        let line = "type=ADD_USER msg=audit(10/16/2026 18:17:55.123:4567) : acct=\"pakchoi\"";
        assert_eq!(audit_timestamp(line), "10/16/2026 18:17:55");
    }

    #[test]
    fn extracts_sessions_without_invalid_values() {
        let lines = vec![
            "a auid=0 ses=12".to_string(),
            "b auid=0 ses=12".to_string(),
            "c ses=4294967295".to_string(),
        ];
        assert_eq!(extract_sessions(&lines), vec!["12"]);
    }

    #[test]
    fn rejects_unsafe_user_names() {
        assert!(validate_user("pakchoi").is_ok());
        assert!(validate_user("cloud-user").is_ok());
        assert!(validate_user("Bad User").is_err());
        assert!(validate_user("a;rm").is_err());
    }
}
