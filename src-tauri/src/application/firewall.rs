use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, FirewallActionResult, FirewallReport, FirewallRule};
use chrono::Utc;
use std::collections::HashMap;
use std::net::IpAddr;
use std::time::Duration;

const REPORT_TIMEOUT: Duration = Duration::from_secs(30);
const ACTION_TIMEOUT: Duration = Duration::from_secs(45);
const INSTALL_TIMEOUT: Duration = Duration::from_secs(240);

const REPORT_SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
echo __HOST__
hostname 2>/dev/null
echo __OS__
. /etc/os-release 2>/dev/null; echo "${ID:-unknown} ${VERSION_ID:-}"
echo __PM__
command -v apt-get 2>/dev/null || command -v dnf 2>/dev/null || command -v yum 2>/dev/null || true
echo __UFW__
command -v ufw >/dev/null 2>&1 && echo yes || echo no
echo __UFW_STATUS__
ufw status verbose 2>&1
echo __UFW_NUM__
ufw status numbered 2>&1
echo __FIREWALLD__
command -v firewall-cmd >/dev/null 2>&1 && echo yes || echo no
echo __FIREWALLD_STATE__
firewall-cmd --state 2>&1
echo __FIREWALLD_ALL__
firewall-cmd --list-all 2>&1
echo __SSHD__
sshd -T 2>/dev/null | awk '/^port /{print $2}'
echo __IPTABLES__
iptables -S 2>/dev/null | head -n 30
echo __NFT__
nft list ruleset 2>/dev/null | head -n 30
exit 0
"####;

#[derive(Debug, Clone, Copy, Default)]
pub struct FirewallRuleChange<'a> {
    pub port: Option<&'a str>,
    pub protocol: Option<&'a str>,
    pub source: Option<&'a str>,
    pub rule_id: Option<&'a str>,
    pub rule_action: Option<&'a str>,
    pub previous_action: Option<&'a str>,
    pub previous_port: Option<&'a str>,
    pub previous_protocol: Option<&'a str>,
    pub previous_source: Option<&'a str>,
}

pub struct FirewallManager;

impl FirewallManager {
    pub async fn report(
        pools: &PoolManager,
        profile: &ConnectionProfile,
    ) -> AppResult<FirewallReport> {
        let command = as_root(profile, REPORT_SCRIPT);
        let output = pools
            .execute_with_category(&profile.id, &command, REPORT_TIMEOUT, "firewall")
            .await?;
        if !output.success() && output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "firewall inspection failed: {}",
                output.stderr.trim()
            )));
        }
        Ok(parse_report(profile, &collect_sections(&output.stdout)))
    }

    pub async fn action(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        action: &str,
        change: FirewallRuleChange<'_>,
    ) -> AppResult<FirewallActionResult> {
        if profile.username != "root" && !profile.elevated {
            return Err(AppError::Validation(
                "firewall changes require a root profile or elevated with sudo -n".into(),
            ));
        }

        let normalized = action.trim().to_lowercase();
        let (script, timeout) = match normalized.as_str() {
            "install" => (install_script(), INSTALL_TIMEOUT),
            "enable" => (enable_script(profile), ACTION_TIMEOUT),
            "disable" => (disable_script(), ACTION_TIMEOUT),
            "add_rule" => (
                add_rule_script(
                    change
                        .port
                        .ok_or_else(|| AppError::Validation("port is required".into()))?,
                    change.protocol.unwrap_or("tcp"),
                    change.source.unwrap_or("any"),
                    change.rule_action.unwrap_or("allow"),
                    &ssh_ports(profile),
                )?,
                ACTION_TIMEOUT,
            ),
            "update_rule" => (
                update_rule_script(
                    change
                        .rule_id
                        .ok_or_else(|| AppError::Validation("rule id is required".into()))?,
                    change
                        .port
                        .ok_or_else(|| AppError::Validation("port is required".into()))?,
                    change.protocol.unwrap_or("tcp"),
                    change.source.unwrap_or("any"),
                    change.rule_action.unwrap_or("allow"),
                    change.previous_action,
                    change.previous_port,
                    change.previous_protocol,
                    change.previous_source,
                    &ssh_ports(profile),
                )?,
                ACTION_TIMEOUT,
            ),
            "delete_rule" => (
                delete_rule_script(
                    change
                        .rule_id
                        .ok_or_else(|| AppError::Validation("rule id is required".into()))?,
                )?,
                ACTION_TIMEOUT,
            ),
            other => {
                return Err(AppError::Validation(format!(
                    "unsupported firewall action '{other}'"
                )))
            }
        };

        let command = as_root(profile, &script);
        let output = pools
            .execute_with_category(&profile.id, &command, timeout, "firewall")
            .await?;
        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        if !output.success() {
            return Err(AppError::Remote(format!(
                "firewall {normalized} failed (exit {}): {combined}",
                output.exit_status
            )));
        }
        Ok(FirewallActionResult {
            ok: true,
            action: normalized,
            output: if combined.is_empty() {
                "firewall action completed".to_string()
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

fn install_script() -> String {
    r####"set -e
if command -v ufw >/dev/null 2>&1; then
  echo "ufw already installed"
  ufw --version 2>/dev/null | head -n 1
  exit 0
fi
if command -v firewall-cmd >/dev/null 2>&1; then
  echo "firewalld already installed"
  firewall-cmd --version 2>/dev/null | head -n 1
  exit 0
fi
if command -v apt-get >/dev/null 2>&1; then
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq
  apt-get install -y ufw
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y firewalld
elif command -v yum >/dev/null 2>&1; then
  yum install -y firewalld
else
  echo "unsupported package manager: install ufw or firewalld manually" >&2
  exit 1
fi
"####
        .to_string()
}

fn enable_script(profile: &ConnectionProfile) -> String {
    let ports = ssh_ports(profile)
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    format!(
        r####"set -e
ssh_ports="{ports}"
for p in $(sshd -T 2>/dev/null | awk '/^port /{{print $2}}'); do ssh_ports="$ssh_ports $p"; done
ssh_ports=$(printf '%s\n' $ssh_ports | sort -nu | tr '\n' ' ')
mkdir -p /var/backups/2shell/firewall
stamp=$(date +%Y%m%d-%H%M%S)
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --list-all > "/var/backups/2shell/firewall/firewalld-$stamp.txt" 2>&1 || true
  systemctl enable --now firewalld >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=ssh >/dev/null
  for p in $ssh_ports; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null; done
  firewall-cmd --reload
  firewall-cmd --query-service=ssh >/dev/null 2>&1 || {{ echo "SSH service is not allowed; stopping firewalld" >&2; systemctl stop firewalld; exit 1; }}
  for p in $ssh_ports; do
    firewall-cmd --query-port="$p/tcp" >/dev/null 2>&1 || {{ echo "SSH port $p is not allowed; stopping firewalld" >&2; systemctl stop firewalld; exit 1; }}
  done
  firewall-cmd --list-all
elif command -v ufw >/dev/null 2>&1; then
  ufw status verbose > "/var/backups/2shell/firewall/ufw-$stamp.txt" 2>&1 || true
  for p in $ssh_ports; do
    ufw prepend allow "$p/tcp" >/dev/null 2>&1 || ufw allow "$p/tcp" >/dev/null
  done
  ufw default deny incoming >/dev/null
  ufw default allow outgoing >/dev/null
  ufw --force enable
  for p in $ssh_ports; do
    ufw status | grep -Eq "^$p/tcp[[:space:]]+ALLOW" || {{ echo "SSH port $p is not allowed; disabling ufw" >&2; ufw --force disable >/dev/null; exit 1; }}
  done
  ufw status verbose
elif command -v firewall-cmd >/dev/null 2>&1; then
  firewall-cmd --list-all > "/var/backups/2shell/firewall/firewalld-$stamp.txt" 2>&1 || true
  systemctl enable --now firewalld >/dev/null 2>&1 || true
  firewall-cmd --permanent --add-service=ssh >/dev/null
  for p in $ssh_ports; do firewall-cmd --permanent --add-port="$p/tcp" >/dev/null; done
  firewall-cmd --reload
  firewall-cmd --query-service=ssh >/dev/null 2>&1 || {{ echo "SSH service is not allowed; stopping firewalld" >&2; systemctl stop firewalld; exit 1; }}
  for p in $ssh_ports; do
    firewall-cmd --query-port="$p/tcp" >/dev/null 2>&1 || {{ echo "SSH port $p is not allowed; stopping firewalld" >&2; systemctl stop firewalld; exit 1; }}
  done
  firewall-cmd --list-all
else
  echo "no firewall backend installed; run install first" >&2
  exit 1
fi
"####
    )
}

fn disable_script() -> String {
    r####"set -e
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  systemctl disable --now firewalld
  echo "firewalld disabled"
elif command -v ufw >/dev/null 2>&1; then
  ufw --force disable
  ufw status verbose
else
  echo "no firewall backend installed" >&2
  exit 1
fi
"####
        .to_string()
}

fn add_rule_script(
    port: &str,
    protocol: &str,
    source: &str,
    action: &str,
    ssh_ports: &[u16],
) -> AppResult<String> {
    let port = validate_port(port)?;
    let protocol = validate_protocol(protocol)?;
    let source = validate_source(source)?;
    let action = match action.trim().to_lowercase().as_str() {
        "allow" => "allow".to_string(),
        "deny" => "deny".to_string(),
        _ => {
            return Err(AppError::Validation(
                "rule action must be allow or deny".into(),
            ))
        }
    };
    if action == "deny" {
        if let Ok(numeric) = port.parse::<u16>() {
            if ssh_ports.contains(&numeric) {
                return Err(AppError::Validation(format!(
                    "refusing to deny SSH port {numeric}: it would lock out the server"
                )));
            }
        }
    }
    let ufw_rule = ufw_rule("", &action, &port, &protocol, &source)?;
    let firewalld_rule = firewalld_rule(&action, &port, &protocol, &source)?;
    Ok(format!(
        r####"set -e
mkdir -p /var/backups/2shell/firewall
stamp=$(date +%Y%m%d-%H%M%S)
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --list-all > "/var/backups/2shell/firewall/firewalld-$stamp.txt" 2>&1 || true
  {firewalld_rule}
  firewall-cmd --reload
  firewall-cmd --list-all
elif command -v ufw >/dev/null 2>&1; then
  ufw status verbose > "/var/backups/2shell/firewall/ufw-$stamp.txt" 2>&1 || true
  {ufw_rule}
  ufw status verbose
else
  echo "no firewall backend installed" >&2
  exit 1
fi
"####
    ))
}

#[allow(clippy::too_many_arguments)]
fn update_rule_script(
    rule_id: &str,
    port: &str,
    protocol: &str,
    source: &str,
    action: &str,
    previous_action: Option<&str>,
    previous_port: Option<&str>,
    previous_protocol: Option<&str>,
    previous_source: Option<&str>,
    ssh_ports: &[u16],
) -> AppResult<String> {
    let id = rule_id.trim();
    if !id.chars().all(|c| c.is_ascii_digit()) {
        return Err(AppError::Validation(
            "editing requires a numeric ufw rule id".into(),
        ));
    }
    let port = validate_port(port)?;
    let protocol = validate_protocol(protocol)?;
    let source = validate_source(source)?;
    let action = normalize_rule_action(action)?;
    let previous_action = normalize_rule_action(
        previous_action
            .ok_or_else(|| AppError::Validation("previous rule action is required".into()))?,
    )?;
    let previous_port = validate_port(
        previous_port
            .ok_or_else(|| AppError::Validation("previous rule port is required".into()))?,
    )?;
    let previous_protocol = validate_protocol(previous_protocol.unwrap_or("tcp"))?;
    let previous_source = validate_source(previous_source.unwrap_or("any"))?;
    if action == "deny" {
        if let Ok(numeric) = port.parse::<u16>() {
            if ssh_ports.contains(&numeric) {
                return Err(AppError::Validation(format!(
                    "refusing to deny SSH port {numeric}: it would lock out the server"
                )));
            }
        }
    }
    if previous_action == action
        && previous_port == port
        && previous_protocol == protocol
        && previous_source == source
    {
        return Ok(format!("echo 'ufw rule {id} unchanged'"));
    }
    let add = ufw_rule("prepend ", &action, &port, &protocol, &source)?;
    let delete = ufw_rule(
        "delete ",
        &previous_action,
        &previous_port,
        &previous_protocol,
        &previous_source,
    )?;
    let ports = ssh_ports
        .iter()
        .map(u16::to_string)
        .collect::<Vec<_>>()
        .join(" ");
    Ok(format!(
        r####"set -e
mkdir -p /var/backups/2shell/firewall
stamp=$(date +%Y%m%d-%H%M%S)
ufw status verbose > "/var/backups/2shell/firewall/ufw-$stamp.txt" 2>&1 || true
{add}
{delete} >/dev/null 2>&1 || true
{delete} >/dev/null 2>&1 || true
for p in {ports}; do
  ufw status | grep -Eq "^$p/tcp[[:space:]]+ALLOW" || {{ echo "SSH port $p is not allowed after update; disabling ufw" >&2; ufw --force disable >/dev/null; exit 1; }}
done
ufw status verbose
"####,
        add = add,
        delete = delete,
        ports = ports,
    ))
}

fn normalize_rule_action(action: &str) -> AppResult<String> {
    match action.trim().to_lowercase().as_str() {
        "allow" => Ok("allow".into()),
        "deny" => Ok("deny".into()),
        _ => Err(AppError::Validation(
            "rule action must be allow or deny".into(),
        )),
    }
}

fn delete_rule_script(rule_id: &str) -> AppResult<String> {
    let id = rule_id.trim();
    if id.is_empty() || id.len() > 120 {
        return Err(AppError::Validation("invalid rule id".into()));
    }
    let ufw_delete = id.chars().all(|c| c.is_ascii_digit());
    let firewalld_remove = id
        .strip_prefix("service:")
        .map(valid_service)
        .or_else(|| id.strip_prefix("port:").map(valid_port_spec))
        .unwrap_or(false);
    if !ufw_delete && !firewalld_remove {
        return Err(AppError::Validation(
            "rule id must be a ufw number, service:<name> or port:<port>/<proto>".into(),
        ));
    }
    let firewalld_command = if let Some(name) = id.strip_prefix("service:") {
        format!("firewall-cmd --permanent --remove-service={name} >/dev/null")
    } else if let Some(spec) = id.strip_prefix("port:") {
        format!("firewall-cmd --permanent --remove-port={spec} >/dev/null")
    } else {
        String::new()
    };
    Ok(format!(
        r####"set -e
mkdir -p /var/backups/2shell/firewall
stamp=$(date +%Y%m%d-%H%M%S)
if command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; then
  firewall-cmd --list-all > "/var/backups/2shell/firewall/firewalld-$stamp.txt" 2>&1 || true
  {firewalld_command}
  firewall-cmd --reload
  firewall-cmd --list-all
elif command -v ufw >/dev/null 2>&1; then
  ufw status verbose > "/var/backups/2shell/firewall/ufw-$stamp.txt" 2>&1 || true
  ufw --force delete {id}
  ufw status verbose
else
  echo "no firewall backend installed" >&2
  exit 1
fi
"####,
        firewalld_command = firewalld_command,
        id = id,
    ))
}

fn ufw_rule(
    verb: &str,
    action: &str,
    port: &str,
    protocol: &str,
    source: &str,
) -> AppResult<String> {
    let spec = if protocol == "any" {
        port.to_string()
    } else {
        format!("{port}/{protocol}")
    };
    if source == "any" {
        return Ok(format!("ufw {verb}{action} {spec}"));
    }
    let from = shell_quote(source);
    let mut rule = format!("ufw {verb}{action} from {from} to any port {port}");
    if protocol != "any" {
        rule.push_str(&format!(" proto {protocol}"));
    }
    Ok(rule)
}

fn firewalld_rule(action: &str, port: &str, protocol: &str, source: &str) -> AppResult<String> {
    let protocols: Vec<&str> = if protocol == "any" {
        vec!["tcp", "udp"]
    } else {
        vec![protocol]
    };
    if action == "allow" && source == "any" {
        return Ok(protocols
            .iter()
            .map(|proto| format!("firewall-cmd --permanent --add-port={port}/{proto} >/dev/null"))
            .collect::<Vec<_>>()
            .join("\n  "));
    }
    let families: Vec<&str> = if source == "any" {
        vec!["ipv4", "ipv6"]
    } else if source.contains(':') {
        vec!["ipv6"]
    } else {
        vec!["ipv4"]
    };
    let mut commands = Vec::new();
    for family in families {
        for proto in &protocols {
            let source_clause = if source == "any" {
                String::new()
            } else {
                format!(" source address=\"{source}\"")
            };
            let target = if action == "allow" { "accept" } else { "drop" };
            let rich = format!(
                "rule family=\"{family}\"{source_clause} port port=\"{port}\" protocol=\"{proto}\" {target}"
            );
            commands.push(format!(
                "firewall-cmd --permanent --add-rich-rule={} >/dev/null",
                shell_quote(&rich)
            ));
        }
    }
    Ok(commands.join("\n  "))
}

fn validate_port(port: &str) -> AppResult<String> {
    let value: u16 = port
        .trim()
        .parse()
        .map_err(|_| AppError::Validation(format!("invalid port '{port}'")))?;
    if value == 0 {
        return Err(AppError::Validation(
            "port must be between 1 and 65535".into(),
        ));
    }
    Ok(value.to_string())
}

fn validate_protocol(protocol: &str) -> AppResult<String> {
    match protocol.trim().to_lowercase().as_str() {
        "tcp" => Ok("tcp".into()),
        "udp" => Ok("udp".into()),
        "any" => Ok("any".into()),
        other => Err(AppError::Validation(format!(
            "unsupported protocol '{other}' (use tcp, udp or any)"
        ))),
    }
}

fn validate_source(source: &str) -> AppResult<String> {
    let value = source.trim();
    if value.is_empty() || value.eq_ignore_ascii_case("any") {
        return Ok("any".into());
    }
    let (address, prefix) = match value.split_once('/') {
        Some((address, prefix)) => (address, Some(prefix)),
        None => (value, None),
    };
    let parsed: IpAddr = address
        .parse()
        .map_err(|_| AppError::Validation(format!("invalid source address '{source}'")))?;
    if let Some(prefix) = prefix {
        let prefix: u8 = prefix
            .parse()
            .map_err(|_| AppError::Validation(format!("invalid CIDR prefix '{source}'")))?;
        let max = if parsed.is_ipv4() { 32 } else { 128 };
        if prefix > max {
            return Err(AppError::Validation(format!(
                "CIDR prefix must be 0-{max} for {source}"
            )));
        }
        Ok(format!("{parsed}/{prefix}"))
    } else {
        Ok(parsed.to_string())
    }
}

fn valid_service(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
}

fn valid_port_spec(spec: &str) -> bool {
    let Some((port, protocol)) = spec.split_once('/') else {
        return false;
    };
    port.parse::<u16>().is_ok() && matches!(protocol, "tcp" | "udp")
}

fn ssh_ports(profile: &ConnectionProfile) -> Vec<u16> {
    let mut ports = vec![22, profile.port];
    ports.sort_unstable();
    ports.dedup();
    ports
}

fn parse_report(
    profile: &ConnectionProfile,
    sections: &HashMap<String, Vec<String>>,
) -> FirewallReport {
    let ufw_installed = first(sections, "UFW") == "yes";
    let firewalld_installed = first(sections, "FIREWALLD") == "yes";
    let ufw_status = clean(section(sections, "UFW_STATUS"));
    let ufw_active = ufw_status
        .iter()
        .any(|line| line.contains("Status: active"));
    let firewalld_state = first(sections, "FIREWALLD_STATE");
    let firewalld_active = firewalld_state.contains("running");
    let backend = if firewalld_active {
        "firewalld"
    } else if ufw_active || ufw_installed {
        "ufw"
    } else if firewalld_installed {
        "firewalld"
    } else {
        "none"
    };
    let active = if backend == "firewalld" {
        firewalld_active
    } else if backend == "ufw" {
        ufw_active
    } else {
        false
    };
    let rules = match backend {
        "ufw" => parse_ufw_rules(section(sections, "UFW_NUM")),
        "firewalld" => parse_firewalld_rules(section(sections, "FIREWALLD_ALL")),
        _ => Vec::new(),
    };
    let mut ports = ssh_ports(profile);
    for line in section(sections, "SSHD") {
        if let Ok(port) = line.trim().parse::<u16>() {
            if port > 0 {
                ports.push(port);
            }
        }
    }
    ports.sort_unstable();
    ports.dedup();
    let allowed = allowed_ssh_ports(&rules, &ports);
    let default_incoming = ufw_status
        .iter()
        .find_map(|line| line.trim().strip_prefix("Default:"))
        .map(|rest| default_part(rest, "incoming"))
        .unwrap_or_default();
    let default_outgoing = ufw_status
        .iter()
        .find_map(|line| line.trim().strip_prefix("Default:"))
        .map(|rest| default_part(rest, "outgoing"))
        .unwrap_or_default();
    let can_manage = profile.username == "root" || profile.elevated;
    let mut warnings = Vec::new();
    if !ufw_installed && !firewalld_installed {
        warnings.push("No hay ufw ni firewalld instalado.".to_string());
    } else if !active {
        warnings.push("El firewall está instalado pero inactivo.".to_string());
    }
    if !can_manage {
        warnings.push(
            "Se requiere un perfil root o elevated con sudo -n para administrar el firewall."
                .to_string(),
        );
    }
    if active {
        for port in &ports {
            if !allowed.contains(port) {
                warnings.push(format!(
                    "El puerto SSH {port} no tiene una regla ALLOW; no desactives el firewall sin corregirlo."
                ));
            }
        }
    }
    if !ufw_installed && !firewalld_installed && first(sections, "PM").is_empty() {
        warnings.push(
            "No se detectó apt-get, dnf ni yum: instala ufw o firewalld manualmente.".to_string(),
        );
    }
    let mut raw = Vec::new();
    raw.extend(ufw_status);
    raw.extend(clean(section(sections, "FIREWALLD_ALL")));
    raw.extend(clean(section(sections, "IPTABLES")));
    raw.extend(clean(section(sections, "NFT")));

    FirewallReport {
        hostname: first(sections, "HOST"),
        os: first(sections, "OS"),
        package_manager: first(sections, "PM"),
        backend: backend.to_string(),
        installed: ufw_installed || firewalld_installed,
        active,
        can_manage,
        default_incoming,
        default_outgoing,
        ssh_ports: ports,
        ssh_allowed: allowed,
        rules,
        warnings,
        raw,
        generated_at: Utc::now().timestamp(),
    }
}

fn parse_ufw_rules(lines: &[String]) -> Vec<FirewallRule> {
    lines
        .iter()
        .filter_map(|line| {
            let trimmed = line.trim();
            let close = trimmed.find(']')?;
            if !trimmed.starts_with('[') || close < 2 {
                return None;
            }
            let id = trimmed[1..close].trim().to_string();
            let rest = trimmed[close + 1..].trim();
            let mut parts = rest.split_whitespace().peekable();
            let to = parts.next()?;
            if parts.peek() == Some(&"(v6)") {
                parts.next();
            }
            let mut action = parts.next()?.to_lowercase();
            while !matches!(action.as_str(), "allow" | "deny" | "reject" | "limit") {
                action = parts.next()?.to_lowercase();
            }
            let direction = parts.next().unwrap_or("");
            let from = parts.collect::<Vec<_>>().join(" ");
            let (port, protocol) = ufw_target(to);
            Some(FirewallRule {
                id,
                action,
                port,
                protocol,
                from: if from.is_empty() {
                    direction.to_string()
                } else {
                    from
                },
                comment: String::new(),
            })
        })
        .collect()
}

fn ufw_target(value: &str) -> (String, String) {
    if let Some((port, protocol)) = value.split_once('/') {
        return (port.to_string(), protocol.to_string());
    }
    if value.chars().all(|c| c.is_ascii_digit() || c == ',') {
        return (value.to_string(), "any".to_string());
    }
    (value.to_string(), "any".to_string())
}

fn parse_firewalld_rules(lines: &[String]) -> Vec<FirewallRule> {
    let mut rules = Vec::new();
    let mut in_rich = false;
    let mut rich_index = 0;
    for line in lines {
        let trimmed = line.trim();
        if let Some(rest) = trimmed.strip_prefix("services:") {
            in_rich = false;
            for service in rest.split_whitespace() {
                rules.push(FirewallRule {
                    id: format!("service:{service}"),
                    action: "allow".into(),
                    port: service.to_string(),
                    protocol: "any".into(),
                    from: "any".into(),
                    comment: "firewalld service".into(),
                });
            }
        } else if let Some(rest) = trimmed.strip_prefix("ports:") {
            in_rich = false;
            for entry in rest.split_whitespace() {
                let (port, protocol) = entry.split_once('/').unwrap_or((entry, "tcp"));
                rules.push(FirewallRule {
                    id: format!("port:{entry}"),
                    action: "allow".into(),
                    port: port.to_string(),
                    protocol: protocol.to_string(),
                    from: "any".into(),
                    comment: "firewalld port".into(),
                });
            }
        } else if trimmed == "rich rules:" {
            in_rich = true;
        } else if in_rich && !trimmed.is_empty() {
            rich_index += 1;
            rules.push(FirewallRule {
                id: format!("rich:{rich_index}"),
                action: if trimmed.contains("drop") || trimmed.contains("reject") {
                    "deny".into()
                } else {
                    "allow".into()
                },
                port: token_value(trimmed, "port").unwrap_or_else(|| "—".into()),
                protocol: token_value(trimmed, "protocol").unwrap_or_else(|| "any".into()),
                from: token_value(trimmed, "address")
                    .or_else(|| token_value(trimmed, "source"))
                    .unwrap_or_else(|| "any".into()),
                comment: trimmed.to_string(),
            });
        }
    }
    rules
}

fn token_value(text: &str, key: &str) -> Option<String> {
    text.split_whitespace()
        .find_map(|token| token.strip_prefix(&format!("{key}=\"")))
        .map(|value| value.trim_end_matches('"').to_string())
}

fn allowed_ssh_ports(rules: &[FirewallRule], ports: &[u16]) -> Vec<u16> {
    ports
        .iter()
        .copied()
        .filter(|port| {
            rules.iter().any(|rule| {
                matches!(rule.action.as_str(), "allow" | "limit")
                    && (rule.protocol == "tcp" || rule.protocol == "any" || rule.port == "ssh")
                    && rule_covers_port(rule, *port)
            })
        })
        .collect()
}

fn rule_covers_port(rule: &FirewallRule, port: u16) -> bool {
    if rule.port.eq_ignore_ascii_case("ssh") || rule.port.eq_ignore_ascii_case("openssh") {
        return port == 22;
    }
    rule.port
        .split(',')
        .any(|part| part.trim() == port.to_string())
}

fn default_part(text: &str, key: &str) -> String {
    text.split(',')
        .find(|part| part.contains(key))
        .map(|part| part.trim().to_string())
        .unwrap_or_default()
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
            name: "vps".into(),
            host: "127.0.0.1".into(),
            port: 2222,
            username: "root".into(),
            ..ConnectionProfile::default()
        }
    }

    #[test]
    fn parses_ufw_numbered_rules() {
        let lines = vec![
            "[ 1] 22/tcp                     ALLOW IN    Anywhere".to_string(),
            "[ 2] 80,443/tcp                 ALLOW IN    Anywhere".to_string(),
            "[ 3] 22/tcp (v6)                ALLOW IN    Anywhere (v6)".to_string(),
            "[ 4] 3306                       DENY IN     10.0.0.5".to_string(),
        ];
        let rules = parse_ufw_rules(&lines);
        assert_eq!(rules.len(), 4);
        assert_eq!(rules[0].id, "1");
        assert_eq!(rules[0].action, "allow");
        assert_eq!(rules[0].port, "22");
        assert_eq!(rules[0].protocol, "tcp");
        assert_eq!(rules[1].port, "80,443");
        assert_eq!(rules[3].action, "deny");
        assert_eq!(rules[3].protocol, "any");
    }

    #[test]
    fn reports_allowed_ssh_ports() {
        let rules = vec![
            FirewallRule {
                id: "1".into(),
                action: "allow".into(),
                port: "22".into(),
                protocol: "tcp".into(),
                from: "Anywhere".into(),
                comment: String::new(),
            },
            FirewallRule {
                id: "2".into(),
                action: "allow".into(),
                port: "2222".into(),
                protocol: "tcp".into(),
                from: "Anywhere".into(),
                comment: String::new(),
            },
            FirewallRule {
                id: "3".into(),
                action: "deny".into(),
                port: "2222".into(),
                protocol: "tcp".into(),
                from: "Anywhere".into(),
                comment: String::new(),
            },
        ];
        assert_eq!(allowed_ssh_ports(&rules, &[22, 2222]), vec![22, 2222]);
    }

    #[test]
    fn parses_firewalld_services_and_ports() {
        let lines = vec![
            "public (active)".to_string(),
            "  services: ssh dhcpv6-client".to_string(),
            "  ports: 8080/tcp 16556/udp".to_string(),
            "  rich rules:".to_string(),
            "    rule family=\"ipv4\" source address=\"1.2.3.4\" port port=\"9000\" protocol=\"tcp\" drop".to_string(),
        ];
        let rules = parse_firewalld_rules(&lines);
        assert!(rules.iter().any(|rule| rule.id == "service:ssh"));
        assert!(rules.iter().any(|rule| rule.id == "port:8080/tcp"));
        let rich = rules.iter().find(|rule| rule.id == "rich:1").unwrap();
        assert_eq!(rich.action, "deny");
        assert_eq!(rich.port, "9000");
        assert_eq!(rich.from, "1.2.3.4");
    }

    #[test]
    fn validates_ports_protocols_and_sources() {
        assert_eq!(validate_port("22").unwrap(), "22");
        assert!(validate_port("0").is_err());
        assert!(validate_port("70000").is_err());
        assert_eq!(validate_protocol("TCP").unwrap(), "tcp");
        assert!(validate_protocol("icmp").is_err());
        assert_eq!(validate_source("any").unwrap(), "any");
        assert_eq!(validate_source("10.0.0.0/8").unwrap(), "10.0.0.0/8");
        assert_eq!(validate_source("2001:db8::/32").unwrap(), "2001:db8::/32");
        assert!(validate_source("10.0.0.0/40").is_err());
        assert!(validate_source("not-an-ip").is_err());
    }

    #[test]
    fn builds_safe_ssh_enable_script() {
        let script = enable_script(&profile());
        assert!(script.contains("ssh_ports=\"22 2222\""));
        assert!(script.contains("ufw prepend allow \"$p/tcp\""));
        assert!(script.contains("|| ufw allow \"$p/tcp\""));
        assert!(!script.contains("ufw insert 1"));
        assert!(script.contains("ufw --force enable"));
        assert!(script.contains("/var/backups/2shell/firewall"));
        assert!(script.contains("^$p/tcp[[:space:]]+ALLOW"));
        assert!(script.contains("|| { echo"));
        assert!(!script.contains("{{"));
    }

    #[test]
    fn refuses_to_deny_ssh_ports() {
        assert!(add_rule_script("22", "tcp", "any", "deny", &[22, 2222]).is_err());
        assert!(add_rule_script("2222", "tcp", "any", "deny", &[22, 2222]).is_err());
        assert!(add_rule_script("22", "tcp", "any", "allow", &[22, 2222]).is_ok());
        assert!(add_rule_script("8080", "tcp", "any", "deny", &[22, 2222]).is_ok());
    }

    #[test]
    fn builds_update_rule_script_with_ssh_guard() {
        let script = update_rule_script(
            "3",
            "22",
            "tcp",
            "1.2.3.4",
            "allow",
            Some("allow"),
            Some("22"),
            Some("tcp"),
            Some("any"),
            &[22, 2222],
        )
        .unwrap();
        assert!(script.contains("ufw prepend allow from '1.2.3.4' to any port 22 proto tcp"));
        assert!(script.contains("ufw delete allow 22/tcp"));
        assert!(script.contains("disabling ufw"));
        assert!(update_rule_script(
            "rich:1",
            "22",
            "tcp",
            "any",
            "allow",
            Some("allow"),
            Some("22"),
            Some("tcp"),
            Some("any"),
            &[22],
        )
        .is_err());
        assert!(update_rule_script(
            "3",
            "22",
            "tcp",
            "1.2.3.4",
            "deny",
            Some("allow"),
            Some("22"),
            Some("tcp"),
            Some("any"),
            &[22],
        )
        .is_err());
        let unchanged = update_rule_script(
            "3",
            "22",
            "tcp",
            "1.2.3.4",
            "allow",
            Some("allow"),
            Some("22"),
            Some("tcp"),
            Some("1.2.3.4"),
            &[22],
        )
        .unwrap();
        assert!(unchanged.contains("unchanged"));
        assert!(!unchanged.contains("ufw prepend"));
    }

    #[test]
    fn rejects_invalid_delete_ids() {
        assert!(delete_rule_script("1").is_ok());
        assert!(delete_rule_script("service:ssh").is_ok());
        assert!(delete_rule_script("port:8080/tcp").is_ok());
        assert!(delete_rule_script("rich:1").is_err());
        assert!(delete_rule_script("1; rm -rf /").is_err());
    }

    #[test]
    fn default_report_includes_ssh_ports_and_warnings() {
        let mut sections = HashMap::new();
        sections.insert("HOST".into(), vec!["vps-1".into()]);
        sections.insert("OS".into(), vec!["ubuntu 24.04".into()]);
        sections.insert("PM".into(), vec!["/usr/bin/apt-get".into()]);
        sections.insert("UFW".into(), vec!["yes".into()]);
        sections.insert(
            "UFW_STATUS".into(),
            vec![
                "Status: inactive".into(),
                "Default: deny (incoming), allow (outgoing), disabled (routed)".into(),
            ],
        );
        sections.insert("FIREWALLD".into(), vec!["no".into()]);
        sections.insert("SSHD".into(), vec!["22".into(), "2222".into()]);
        let report = parse_report(&profile(), &sections);
        assert_eq!(report.backend, "ufw");
        assert!(!report.active);
        assert_eq!(report.ssh_ports, vec![22, 2222]);
        assert!(report.warnings.iter().any(|line| line.contains("inactivo")));
        assert_eq!(report.default_incoming, "deny (incoming)");
    }
}
