use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, Fail2banActionResult, Fail2banJail, Fail2banReport};
use chrono::Utc;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

const REPORT_TIMEOUT: Duration = Duration::from_secs(30);
const ACTION_TIMEOUT: Duration = Duration::from_secs(45);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(240);
const JAIL: &str = "sshd";

const REPORT_SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
echo __HOST__
hostname 2>/dev/null
echo __INSTALLED__
command -v fail2ban-client >/dev/null 2>&1 && echo yes || echo no
echo __VERSION__
fail2ban-client -V 2>/dev/null | head -n 1
echo __ACTIVE__
systemctl is-active fail2ban 2>/dev/null || true
echo __JAILS__
fail2ban-client status 2>/dev/null
echo __SSHD_STATUS__
fail2ban-client status sshd 2>/dev/null
echo __MAXRETRY__
fail2ban-client get sshd maxretry 2>/dev/null
echo __FINDTIME__
fail2ban-client get sshd findtime 2>/dev/null
echo __BANTIME__
fail2ban-client get sshd bantime 2>/dev/null
echo __IGNOREIP__
fail2ban-client get sshd ignoreip 2>/dev/null
exit 0
"####;

const JAIL_TEMPLATE: &str = r#"[DEFAULT]
bantime = 1h
findtime = 10m
maxretry = 5
ignoreip = 127.0.0.1/8 ::1 __IGNORE__

[sshd]
enabled = true
backend = auto
"#;

pub struct Fail2banManager;

impl Fail2banManager {
    pub async fn report(
        pools: &PoolManager,
        profile: &ConnectionProfile,
    ) -> AppResult<Fail2banReport> {
        let command = as_root(profile, REPORT_SCRIPT);
        let output = pools
            .execute_with_category(&profile.id, &command, REPORT_TIMEOUT, "fail2ban")
            .await?;
        if !output.success() && output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "fail2ban inspection failed: {}",
                output.stderr.trim()
            )));
        }
        Ok(parse_report(profile, &collect_sections(&output.stdout)))
    }

    pub async fn action(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        action: &str,
        ip: Option<&str>,
        ignore_ip: Option<&str>,
    ) -> AppResult<Fail2banActionResult> {
        if profile.username != "root" && !profile.elevated {
            return Err(AppError::Validation(
                "fail2ban changes require a root profile or elevated with sudo -n".into(),
            ));
        }
        let normalized = action.trim().to_lowercase();
        let (script, timeout) = match normalized.as_str() {
            "install" => (install_script(ignore_ip)?, INSTALL_TIMEOUT),
            "enable" => (configure_script(ignore_ip, true)?, ACTION_TIMEOUT),
            "configure" => (configure_script(ignore_ip, false)?, ACTION_TIMEOUT),
            "disable" => (disable_script(), ACTION_TIMEOUT),
            "reload" => (reload_script(), ACTION_TIMEOUT),
            "ban" | "unban" => {
                let address = ip
                    .ok_or_else(|| AppError::Validation("ip is required".into()))?
                    .trim();
                let parsed: IpAddr = address
                    .parse()
                    .map_err(|_| AppError::Validation(format!("invalid IP address '{address}'")))?;
                (
                    jail_ip_script(&parsed.to_string(), normalized == "ban"),
                    ACTION_TIMEOUT,
                )
            }
            other => {
                return Err(AppError::Validation(format!(
                    "unsupported fail2ban action '{other}'"
                )))
            }
        };
        let command = as_root(profile, &script);
        let output = pools
            .execute_with_category(&profile.id, &command, timeout, "fail2ban")
            .await?;
        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        if !output.success() {
            return Err(AppError::Remote(format!(
                "fail2ban {normalized} failed (exit {}): {combined}",
                output.exit_status
            )));
        }
        Ok(Fail2banActionResult {
            ok: true,
            action: normalized,
            output: if combined.is_empty() {
                "fail2ban action completed".to_string()
            } else {
                combined
            },
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

fn install_script(ignore_ip: Option<&str>) -> AppResult<String> {
    let ignore = ignore_list(ignore_ip)?;
    let configure = configure_body(&ignore, true);
    Ok(format!(
        r####"set -e
if ! command -v fail2ban-client >/dev/null 2>&1; then
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    apt-get install -y fail2ban
  elif command -v dnf >/dev/null 2>&1; then
    dnf install -y fail2ban
  elif command -v yum >/dev/null 2>&1; then
    yum install -y fail2ban
  else
    echo "unsupported package manager: install fail2ban manually" >&2
    exit 1
  fi
fi
{configure}
"####,
        configure = configure
    ))
}

fn configure_script(ignore_ip: Option<&str>, enable: bool) -> AppResult<String> {
    let ignore = ignore_list(ignore_ip)?;
    Ok(configure_body(&ignore, enable))
}

fn configure_body(ignore: &str, enable: bool) -> String {
    let jail = JAIL_TEMPLATE.replace("__IGNORE__", ignore);
    let enable_block = if enable {
        r#"systemctl enable --now fail2ban >/dev/null 2>&1 || true
fail2ban-client reload >/dev/null 2>&1 || true
for i in 1 2 3 4 5; do fail2ban-client status sshd >/dev/null 2>&1 && break; sleep 1; done
fail2ban-client status sshd"#
    } else {
        r#"if systemctl is-active fail2ban >/dev/null 2>&1; then
  fail2ban-client reload >/dev/null 2>&1 || true
  for i in 1 2 3 4 5; do fail2ban-client status sshd >/dev/null 2>&1 && break; sleep 1; done
  fail2ban-client status sshd
else
  echo "configuration saved; fail2ban is inactive"
fi"#
    };
    format!(
        r####"set -e
mkdir -p /etc/fail2ban/jail.d /var/backups/2shell/fail2ban
stamp=$(date +%Y%m%d-%H%M%S)
if [ -f /etc/fail2ban/jail.d/00-2shell.local ]; then
  cp -a /etc/fail2ban/jail.d/00-2shell.local "/var/backups/2shell/fail2ban/00-2shell.local-$stamp"
fi
cat > /etc/fail2ban/jail.d/00-2shell.local <<'2SHELL'
{jail}2SHELL
{enable_block}
"####,
        jail = jail,
        enable_block = enable_block,
    )
}

fn disable_script() -> String {
    r####"systemctl disable --now fail2ban 2>/dev/null || true
systemctl is-active fail2ban 2>/dev/null || true
"####
        .to_string()
}

fn reload_script() -> String {
    r####"fail2ban-client reload
fail2ban-client status sshd
"####
        .to_string()
}

fn jail_ip_script(ip: &str, ban: bool) -> String {
    let verb = if ban { "banip" } else { "unbanip" };
    format!(
        r#"fail2ban-client set {jail} {verb} {ip}
fail2ban-client status {jail}
"#,
        jail = JAIL,
        verb = verb,
        ip = shell_quote(ip),
    )
}

fn ignore_list(value: Option<&str>) -> AppResult<String> {
    let mut entries = Vec::new();
    if let Some(value) = value {
        for token in value.split(|c: char| c.is_whitespace() || c == ',') {
            let token = token.trim();
            if token.is_empty() {
                continue;
            }
            validate_cidr(token)?;
            entries.push(token.to_string());
        }
    }
    Ok(entries.join(" "))
}

fn validate_cidr(value: &str) -> AppResult<()> {
    let (address, prefix) = match value.split_once('/') {
        Some((address, prefix)) => (address, Some(prefix)),
        None => (value, None),
    };
    let parsed: IpAddr = address
        .parse()
        .map_err(|_| AppError::Validation(format!("invalid ignored address '{value}'")))?;
    if let Some(prefix) = prefix {
        let prefix: u8 = prefix
            .parse()
            .map_err(|_| AppError::Validation(format!("invalid CIDR prefix '{value}'")))?;
        let max = if parsed.is_ipv4() { 32 } else { 128 };
        if prefix > max {
            return Err(AppError::Validation(format!(
                "CIDR prefix must be 0-{max} for {value}"
            )));
        }
    }
    Ok(())
}

fn parse_report(
    profile: &ConnectionProfile,
    sections: &HashMap<String, Vec<String>>,
) -> Fail2banReport {
    let installed = first(sections, "INSTALLED") == "yes";
    let active = first(sections, "ACTIVE").trim() == "active";
    let version = first(sections, "VERSION");
    let jails = parse_jails(section(sections, "JAILS"));
    let sshd = if installed && jails.iter().any(|jail| jail == JAIL) {
        Some(parse_jail(JAIL, sections))
    } else {
        None
    };
    let can_manage = profile.username == "root" || profile.elevated;
    let mut warnings = Vec::new();
    if !installed {
        warnings.push("Fail2ban no está instalado.".to_string());
    } else if !active {
        warnings.push("Fail2ban está instalado pero inactivo.".to_string());
    } else if sshd.is_none() {
        warnings.push("El jail sshd no está activo.".to_string());
    }
    if !can_manage {
        warnings.push(
            "Se requiere un perfil root o elevated con sudo -n para administrar fail2ban."
                .to_string(),
        );
    }
    let mut raw = clean(section(sections, "JAILS"));
    raw.extend(clean(section(sections, "SSHD_STATUS")));
    Fail2banReport {
        hostname: first(sections, "HOST"),
        installed,
        active,
        version,
        can_manage,
        jails,
        sshd,
        warnings,
        raw,
        generated_at: Utc::now().timestamp(),
    }
}

fn parse_jails(lines: &[String]) -> Vec<String> {
    for line in lines {
        if let Some(index) = line.find("Jail list:") {
            let rest = line[index + "Jail list:".len()..].trim();
            return rest
                .split(|c: char| c == ',' || c.is_whitespace())
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(str::to_string)
                .collect();
        }
    }
    Vec::new()
}

fn parse_jail(name: &str, sections: &HashMap<String, Vec<String>>) -> Fail2banJail {
    let status = section(sections, "SSHD_STATUS");
    let value = |key: &str| -> u64 {
        status
            .iter()
            .find_map(|line| {
                let index = line.find(key)?;
                let rest = line[index + key.len()..].trim_start_matches(':').trim();
                rest.split_whitespace().next()?.parse().ok()
            })
            .unwrap_or(0)
    };
    let banned = status
        .iter()
        .find_map(|line| {
            line.find("Banned IP list:")
                .map(|index| &line[index + 15..])
        })
        .map(|rest| {
            rest.split_whitespace()
                .map(str::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let ignoreip = first(sections, "IGNOREIP")
        .trim_matches(|c| c == '[' || c == ']' || c == '\'' || c == '"')
        .replace([',', '\''], " ")
        .split_whitespace()
        .map(str::to_string)
        .collect();
    Fail2banJail {
        name: name.to_string(),
        enabled: true,
        currently_failed: value("Currently failed"),
        total_failed: value("Total failed"),
        currently_banned: value("Currently banned"),
        total_banned: value("Total banned"),
        banned,
        maxretry: first(sections, "MAXRETRY").parse().unwrap_or(0),
        findtime: format_seconds(&first(sections, "FINDTIME")),
        bantime: format_seconds(&first(sections, "BANTIME")),
        ignoreip,
    }
}

fn format_seconds(value: &str) -> String {
    let Ok(seconds) = value.trim().parse::<i64>() else {
        return value.trim().to_string();
    };
    if seconds < 0 {
        return "permanente".to_string();
    }
    if seconds == 0 {
        return "0s".to_string();
    }
    let days = seconds / 86_400;
    let hours = (seconds % 86_400) / 3_600;
    let minutes = (seconds % 3_600) / 60;
    let secs = seconds % 60;
    let mut parts = Vec::new();
    if days > 0 {
        parts.push(format!("{days}d"));
    }
    if hours > 0 {
        parts.push(format!("{hours}h"));
    }
    if minutes > 0 {
        parts.push(format!("{minutes}m"));
    }
    if secs > 0 && days == 0 {
        parts.push(format!("{secs}s"));
    }
    parts.join(" ")
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

    fn profile() -> ConnectionProfile {
        ConnectionProfile {
            id: "p1".into(),
            username: "root".into(),
            ..ConnectionProfile::default()
        }
    }

    #[test]
    fn parses_sshd_status_and_banned_list() {
        let mut sections = HashMap::new();
        sections.insert("HOST".into(), vec!["vps-1".into()]);
        sections.insert("INSTALLED".into(), vec!["yes".into()]);
        sections.insert("VERSION".into(), vec!["Fail2Ban v1.0.2".into()]);
        sections.insert("ACTIVE".into(), vec!["active".into()]);
        sections.insert(
            "JAILS".into(),
            vec![
                "Status".into(),
                "|- Number of jail: 2".into(),
                "`- Jail list: sshd, nginx-http-auth".into(),
            ],
        );
        sections.insert(
            "SSHD_STATUS".into(),
            vec![
                "Status for the jail: sshd".into(),
                "|- Filter".into(),
                "|  |- Currently failed: 3".into(),
                "|  |- Total failed: 42".into(),
                "`- Actions".into(),
                "   |- Currently banned: 2".into(),
                "   |- Total banned: 5".into(),
                "   `- Banned IP list: 203.0.113.5 198.51.100.9".into(),
            ],
        );
        sections.insert("MAXRETRY".into(), vec!["5".into()]);
        sections.insert("FINDTIME".into(), vec!["600".into()]);
        sections.insert("BANTIME".into(), vec!["3600".into()]);
        sections.insert("IGNOREIP".into(), vec!["127.0.0.1/8 ::1".into()]);

        let report = parse_report(&profile(), &sections);
        assert!(report.installed && report.active);
        assert_eq!(report.jails, vec!["sshd", "nginx-http-auth"]);
        let jail = report.sshd.unwrap();
        assert_eq!(jail.currently_failed, 3);
        assert_eq!(jail.total_failed, 42);
        assert_eq!(jail.currently_banned, 2);
        assert_eq!(jail.total_banned, 5);
        assert_eq!(jail.banned, vec!["203.0.113.5", "198.51.100.9"]);
        assert_eq!(jail.maxretry, 5);
        assert_eq!(jail.findtime, "10m");
        assert_eq!(jail.bantime, "1h");
    }

    #[test]
    fn warns_when_not_installed() {
        let report = parse_report(&profile(), &HashMap::new());
        assert!(!report.installed);
        assert!(report
            .warnings
            .iter()
            .any(|line| line.contains("no está instalado")));
    }

    #[test]
    fn validates_ignore_addresses() {
        assert_eq!(
            ignore_list(Some("203.0.113.7, 2001:db8::/32")).unwrap(),
            "203.0.113.7 2001:db8::/32"
        );
        assert!(ignore_list(Some("not-an-ip")).is_err());
        assert!(ignore_list(Some("10.0.0.0/40")).is_err());
    }

    #[test]
    fn formats_durations() {
        assert_eq!(format_seconds("600"), "10m");
        assert_eq!(format_seconds("3600"), "1h");
        assert_eq!(format_seconds("86400"), "1d");
        assert_eq!(format_seconds("-1"), "permanente");
        assert_eq!(format_seconds("90"), "1m 30s");
    }
}
