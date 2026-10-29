use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, SudoAccount, SudoGroup, SudoRule, SudoersReport};
use chrono::Utc;
use std::time::Duration;

const SUDO_TIMEOUT: Duration = Duration::from_secs(25);
const BACKUP_DIR: &str = "/var/backups/2shell/sudoers";

const SUDO_SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
echo __HOST__
hostname 2>/dev/null
echo __GROUPS__
for g in wheel sudo admin; do
  getent group "$g" 2>/dev/null
done
echo __RULES__
for f in /etc/sudoers /etc/sudoers.d/*; do
  [ -f "$f" ] || continue
  echo "### $f"
  grep -vE '^[[:space:]]*(#|$|@includedir|#includedir)' "$f" 2>/dev/null
done
echo __ROOT__
awk -F: '$3 == 0 { print $1 }' /etc/passwd 2>/dev/null
echo __VISUDO__
visudo -c 2>&1
exit 0
"####;

pub struct SudoersManager;

impl SudoersManager {
    pub async fn report(
        pools: &PoolManager,
        profile: &ConnectionProfile,
    ) -> AppResult<SudoersReport> {
        let command = as_root(profile, SUDO_SCRIPT);
        let output = pools
            .execute_with_category(&profile.id, &command, SUDO_TIMEOUT, "security")
            .await?;
        if !output.success() && output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "cannot read sudoers: {}",
                output.stderr.trim()
            )));
        }

        let sections = collect_sections(&output.stdout);
        let mut groups = Vec::new();
        for line in section(&sections, "GROUPS") {
            if let Some(group) = parse_group(line) {
                groups.push(group);
            }
        }

        let mut rules = Vec::new();
        let mut source = String::new();
        for line in section(&sections, "RULES") {
            let trimmed = line.trim();
            if let Some(path) = trimmed.strip_prefix("### ") {
                source = path.trim().to_string();
                continue;
            }
            if let Some(rule) = parse_rule(trimmed, &source) {
                rules.push(rule);
            }
        }

        let mut users: Vec<String> = Vec::new();
        for group in &groups {
            for member in &group.members {
                if !users.contains(member) {
                    users.push(member.clone());
                }
            }
        }
        for rule in &rules {
            if !rule.principal.starts_with('%') && !users.contains(&rule.principal) {
                users.push(rule.principal.clone());
            }
        }
        users.sort();
        let accounts = Self::accounts(pools, profile, &users)
            .await
            .unwrap_or_default();

        let visudo = section(&sections, "VISUDO").join("\n");
        let config_ok = visudo.contains("parsed OK")
            && !visudo.to_lowercase().contains("syntax error")
            && !visudo.to_lowercase().contains("parse error");

        Ok(SudoersReport {
            hostname: first(&sections, "HOST"),
            generated_at: Utc::now().timestamp(),
            groups,
            rules,
            accounts,
            root_accounts: section(&sections, "ROOT")
                .iter()
                .map(|line| line.trim().to_string())
                .filter(|line| !line.is_empty())
                .collect(),
            config_ok,
            config_output: visudo.trim().to_string(),
        })
    }

    async fn accounts(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        users: &[String],
    ) -> AppResult<Vec<SudoAccount>> {
        if users.is_empty() {
            return Ok(Vec::new());
        }
        let list = users
            .iter()
            .map(|user| shell_quote(user))
            .collect::<Vec<_>>()
            .join(" ");
        let script = format!(
            r####"export LC_ALL=C 2>/dev/null
for u in {list}; do
  entry=$(getent passwd "$u" 2>/dev/null)
  if [ -z "$entry" ]; then
    printf '%s\t0\t\t\t\t\t\t\t0\t\n' "$u"
    continue
  fi
  uid=$(printf '%s' "$entry" | cut -d: -f3)
  gid=$(printf '%s' "$entry" | cut -d: -f4)
  home=$(printf '%s' "$entry" | cut -d: -f6)
  shell=$(printf '%s' "$entry" | cut -d: -f7)
  status=$(passwd -S "$u" 2>/dev/null | awk '{{print $2}}')
  [ -n "$status" ] || status="?"
  logged=$(last -n 1 -w "$u" 2>/dev/null | head -n 1 | cut -c1-80)
  [ -n "$logged" ] || logged="never"
  keys=$(grep -cE '^[^#[:space:]]' "$home/.ssh/authorized_keys" 2>/dev/null || true)
  [ -n "$keys" ] || keys=0
  groups=$(id -nG "$u" 2>/dev/null | tr ' ' ',')
  printf '%s\t1\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
    "$u" "$uid" "$gid" "$home" "$shell" "$status" "$logged" "$keys" "$groups"
done
exit 0
"####,
            list = list
        );
        let output = pools
            .execute_with_category(
                &profile.id,
                &as_root(profile, &script),
                SUDO_TIMEOUT,
                "security",
            )
            .await?;
        Ok(parse_accounts(&output.stdout))
    }

    /// Removes one sudoers rule, validating the file with visudo and rolling back on error.
    pub async fn remove_rule(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        source: &str,
        raw: &str,
    ) -> AppResult<String> {
        validate_rule_source(source)?;
        let line = raw.trim();
        if line.is_empty() || line.contains('\n') || line.chars().any(char::is_control) {
            return Err(AppError::Validation("invalid sudoers rule".into()));
        }
        let slug: String = source
            .chars()
            .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
            .collect();

        let script = format!(
            r####"set -e
file={file}
line={line}
bdir={bdir}
mkdir -p "$bdir"
chmod 700 "$bdir"
backup="$bdir/{slug}-$(date +%s).bak"
[ -f "$file" ] || {{ echo "sudoers file not found: $file" >&2; exit 1; }}
grep -Fqx -- "$line" "$file" || {{ echo "rule not found in $file" >&2; exit 1; }}
cp -p "$file" "$backup"
chmod 600 "$backup"
grep -Fvx -- "$line" "$file" > "$file.2shell-tmp" || true
cat "$file.2shell-tmp" > "$file"
rm -f "$file.2shell-tmp"
if ! visudo -c >/dev/null 2>&1; then
  cp -p "$backup" "$file"
  echo "visudo rejected the change; restored $file" >&2
  exit 2
fi
if [ "$file" != "/etc/sudoers" ] && ! grep -qE '^[[:space:]]*[^#[:space:]]' "$file"; then
  rm -f "$file"
  echo "removed empty drop-in $file"
fi
echo "removed rule from $file"
echo "BACKUP=$backup"
"####,
            file = shell_quote(source),
            line = shell_quote(line),
            bdir = shell_quote(BACKUP_DIR),
            slug = slug
        );
        run_script(pools, profile, &script).await
    }

    /// Locks or unlocks a local account with `passwd -l` / `passwd -u`.
    pub async fn set_lock(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        user: &str,
        locked: bool,
    ) -> AppResult<String> {
        validate_user(user)?;
        let script = format!(
            r####"set -e
user={user}
getent passwd "$user" >/dev/null 2>&1 || {{ echo "user not found: $user" >&2; exit 1; }}
passwd {flag} "$user" >/dev/null
passwd -S "$user" 2>/dev/null
"####,
            user = shell_quote(user),
            flag = if locked { "-l" } else { "-u" }
        );
        run_script(pools, profile, &script).await
    }
}

async fn run_script(
    pools: &PoolManager,
    profile: &ConnectionProfile,
    script: &str,
) -> AppResult<String> {
    let output = pools
        .execute_sensitive(&profile.id, &as_root(profile, script), SUDO_TIMEOUT)
        .await?;
    let combined = format!("{}{}", output.stdout, output.stderr)
        .trim()
        .to_string();
    if !output.success() {
        return Err(AppError::Remote(format!(
            "sudoers action failed: {combined}"
        )));
    }
    Ok(combined)
}

fn validate_rule_source(source: &str) -> AppResult<()> {
    if source == "/etc/sudoers" {
        return Ok(());
    }
    let name = source
        .strip_prefix("/etc/sudoers.d/")
        .ok_or_else(|| AppError::Validation(format!("unexpected sudoers source: {source}")))?;
    if name.is_empty()
        || name.contains('/')
        || name.contains("..")
        || name.chars().any(|c| c.is_control())
    {
        return Err(AppError::Validation("invalid sudoers file name".into()));
    }
    Ok(())
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

fn parse_accounts(output: &str) -> Vec<SudoAccount> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(10, '\t');
            let user = parts.next()?.trim().to_string();
            if user.is_empty() {
                return None;
            }
            Some(SudoAccount {
                user,
                exists: parts.next().unwrap_or("0").trim() == "1",
                uid: parts.next().unwrap_or("").trim().to_string(),
                gid: parts.next().unwrap_or("").trim().to_string(),
                home: parts.next().unwrap_or("").trim().to_string(),
                shell: parts.next().unwrap_or("").trim().to_string(),
                password_status: parts.next().unwrap_or("").trim().to_string(),
                last_login: parts.next().unwrap_or("").trim().to_string(),
                authorized_keys: parts
                    .next()
                    .and_then(|value| value.trim().parse().ok())
                    .unwrap_or(0),
                groups: parts.next().unwrap_or("").trim().to_string(),
            })
        })
        .collect()
}

fn parse_group(line: &str) -> Option<SudoGroup> {
    let mut parts = line.trim().splitn(4, ':');
    let name = parts.next()?.trim().to_string();
    if name.is_empty() {
        return None;
    }
    let _password = parts.next();
    let gid = parts.next().unwrap_or("").trim().to_string();
    let members = parts
        .next()
        .unwrap_or("")
        .split(',')
        .map(str::trim)
        .filter(|member| !member.is_empty())
        .map(str::to_string)
        .collect();
    Some(SudoGroup { name, gid, members })
}

/// Parses `principal host=(runas) [NOPASSWD:] commands`.
fn parse_rule(line: &str, source: &str) -> Option<SudoRule> {
    if line.is_empty()
        || line.starts_with("Defaults")
        || line.starts_with("User_Alias")
        || line.starts_with("Cmnd_Alias")
        || line.starts_with("Host_Alias")
        || line.starts_with("Runas_Alias")
    {
        return None;
    }
    let (principal, rest) = line.split_once(char::is_whitespace)?;
    let (host, rest) = rest.trim().split_once('=')?;
    let rest = rest.trim();

    let (runas, commands) = if let Some(stripped) = rest.strip_prefix('(') {
        match stripped.split_once(')') {
            Some((runas, commands)) => (runas.trim(), commands.trim()),
            None => ("", rest),
        }
    } else {
        ("", rest)
    };

    if principal.is_empty() || commands.is_empty() {
        return None;
    }

    Some(SudoRule {
        principal: principal.to_string(),
        host: host.trim().to_string(),
        runas: runas.to_string(),
        nopasswd: commands.to_uppercase().contains("NOPASSWD:"),
        commands: commands.to_string(),
        source: source.to_string(),
        raw: line.to_string(),
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

fn collect_sections(output: &str) -> std::collections::HashMap<String, Vec<String>> {
    let mut sections: std::collections::HashMap<String, Vec<String>> =
        std::collections::HashMap::new();
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

fn section<'a>(
    sections: &'a std::collections::HashMap<String, Vec<String>>,
    key: &str,
) -> &'a [String] {
    sections.get(key).map(Vec::as_slice).unwrap_or(&[])
}

fn first(sections: &std::collections::HashMap<String, Vec<String>>, key: &str) -> String {
    section(sections, key)
        .iter()
        .find(|line| !line.trim().is_empty())
        .map(|line| line.trim().to_string())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_group_members() {
        let group = parse_group("wheel:x:10:root,deploy, ops").unwrap();
        assert_eq!(group.name, "wheel");
        assert_eq!(group.gid, "10");
        assert_eq!(group.members, vec!["root", "deploy", "ops"]);
        assert!(parse_group("").is_none());
    }

    #[test]
    fn parses_account_rows() {
        let output = "pakchoi\t1\t1001\t1001\t/home/pakchoi\t/bin/bash\tP\t2026-10-28 03:11:09\t2\twheel\nghost\t0\t\t\t\t\t\t\t0\t\n";
        let accounts = parse_accounts(output);
        assert_eq!(accounts.len(), 2);
        assert!(accounts[0].exists);
        assert_eq!(accounts[0].home, "/home/pakchoi");
        assert_eq!(accounts[0].authorized_keys, 2);
        assert_eq!(accounts[0].password_status, "P");
        assert!(!accounts[1].exists);
    }

    #[test]
    fn validates_sudoers_sources_and_users() {
        assert!(validate_rule_source("/etc/sudoers").is_ok());
        assert!(validate_rule_source("/etc/sudoers.d/99-pakchoi").is_ok());
        assert!(validate_rule_source("/etc/passwd").is_err());
        assert!(validate_rule_source("/etc/sudoers.d/../passwd").is_err());
        assert!(validate_user("pakchoi").is_ok());
        assert!(validate_user("cloud-user").is_ok());
        assert!(validate_user("root").is_ok());
        assert!(validate_user("Bad User").is_err());
        assert!(validate_user("").is_err());
        assert!(validate_user("a;rm").is_err());
    }

    #[test]
    fn parses_sudo_rules() {
        let rule = parse_rule(
            "deploy ALL=(ALL) NOPASSWD: /usr/bin/systemctl",
            "/etc/sudoers.d/deploy",
        )
        .unwrap();
        assert_eq!(rule.principal, "deploy");
        assert_eq!(rule.host, "ALL");
        assert_eq!(rule.runas, "ALL");
        assert!(rule.nopasswd);
        assert_eq!(rule.commands, "NOPASSWD: /usr/bin/systemctl");

        let rule = parse_rule("%sudo ALL=(ALL:ALL) ALL", "/etc/sudoers").unwrap();
        assert_eq!(rule.principal, "%sudo");
        assert!(!rule.nopasswd);
        assert_eq!(rule.runas, "ALL:ALL");

        assert!(parse_rule("Defaults env_keep += \"LC_*\"", "/etc/sudoers").is_none());
        assert!(parse_rule("# comment", "/etc/sudoers").is_none());
    }
}
