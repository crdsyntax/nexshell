use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{
    ConnectionProfile, CronBulkDeleteResult, CronDeleteResult, CronEntry, CronReport,
};
use chrono::Utc;
use std::collections::BTreeMap;
use std::collections::HashMap;
use std::time::Duration;

const CRON_SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
echo __HOST__
hostname 2>/dev/null
echo __SERVICE__
state=unknown
for s in crond cron; do
  a=$(systemctl is-active "$s" 2>/dev/null || true)
  [ "$a" = "active" ] && state=active
done
echo "$state"
echo __ROOT_CRON__
crontab -l -u root 2>&1
echo __USER_CRONS__
for u in $(awk -F: '$3 >= 1000 {print $1}' /etc/passwd 2>/dev/null); do
  out=$(crontab -l -u "$u" 2>/dev/null) || continue
  [ -n "$out" ] && { echo "### $u"; echo "$out"; }
done
echo __ETC_CRONTAB__
cat /etc/crontab 2>/dev/null
echo __CRON_D__
for f in /etc/cron.d/*; do
  [ -f "$f" ] && { echo "### $f"; cat "$f"; }
done 2>/dev/null
echo __PERIODIC__
for d in /etc/cron.hourly /etc/cron.daily /etc/cron.weekly /etc/cron.monthly; do
  echo "### $d"
  ls -1 "$d" 2>/dev/null
done
echo __TIMERS__
systemctl list-timers --all --no-pager --no-legend 2>/dev/null
echo __AT__
atq 2>/dev/null
echo __ANACRON__
cat /etc/anacrontab 2>/dev/null
echo __RECENT__
if [ -f /var/log/cron ]; then
  tail -n 60 /var/log/cron 2>/dev/null
else
  journalctl -u crond -n 60 --no-pager 2>/dev/null
fi
exit 0
"####;

pub struct CronManager;

impl CronManager {
    pub async fn list(pools: &PoolManager, profile: &ConnectionProfile) -> AppResult<CronReport> {
        let command = as_root(profile, CRON_SCRIPT);
        let output = pools
            .execute_with_category(&profile.id, &command, Duration::from_secs(45), "cron")
            .await?;
        if !output.success() && output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "cron collection failed: {}{}",
                output.stdout.trim(),
                output.stderr.trim()
            )));
        }

        let sections = collect_sections(&output.stdout);
        let mut entries = Vec::new();
        let mut errors = Vec::new();

        parse_crontab(
            section(&sections, "ROOT_CRON"),
            "crontab:root",
            false,
            Some("root"),
            &mut entries,
        );

        let user_lines = section(&sections, "USER_CRONS");
        let mut current_user: Option<String> = None;
        for line in user_lines {
            if let Some(user) = line.trim().strip_prefix("### ") {
                current_user = Some(user.trim().to_string());
                continue;
            }
            if let Some(user) = current_user.as_deref() {
                let mut parsed = Vec::new();
                parse_crontab(
                    std::slice::from_ref(line),
                    &format!("crontab:{user}"),
                    false,
                    Some(user),
                    &mut parsed,
                );
                entries.extend(parsed);
            }
        }

        parse_crontab(
            section(&sections, "ETC_CRONTAB"),
            "/etc/crontab",
            true,
            None,
            &mut entries,
        );

        let mut current_source = String::from("/etc/cron.d");
        for line in section(&sections, "CRON_D") {
            if let Some(path) = line.trim().strip_prefix("### ") {
                current_source = path.trim().to_string();
                continue;
            }
            let mut parsed = Vec::new();
            parse_crontab(
                std::slice::from_ref(line),
                &current_source,
                true,
                None,
                &mut parsed,
            );
            entries.extend(parsed);
        }

        let periodic = section(&sections, "PERIODIC");
        let mut current_dir = String::new();
        for line in periodic {
            if let Some(dir) = line.trim().strip_prefix("### ") {
                current_dir = dir.trim().to_string();
                continue;
            }
            let name = line.trim();
            if name.is_empty() || current_dir.is_empty() {
                continue;
            }
            let schedule = current_dir
                .rsplit('/')
                .next()
                .unwrap_or(&current_dir)
                .to_string();
            entries.push(CronEntry {
                source: current_dir.clone(),
                schedule,
                user: Some("root".into()),
                command: format!("{current_dir}/{name}"),
                raw: format!("{current_dir}/{name}"),
                suspicious: false,
            });
        }

        let timers = section(&sections, "TIMERS")
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty() && !line.starts_with("NEXT"))
            .collect();

        let at_jobs = section(&sections, "AT")
            .iter()
            .map(|line| line.trim().to_string())
            .filter(|line| !line.is_empty())
            .collect();

        let recent = section(&sections, "RECENT")
            .iter()
            .map(|line| line.trim_end().to_string())
            .filter(|line| !line.is_empty())
            .collect();

        for line in section(&sections, "ANACRON") {
            if !line.trim().is_empty()
                && !line.trim().starts_with('#')
                && !line.contains("SHELL=")
                && !line.contains("PATH=")
            {
                errors.push(format!("/etc/anacrontab: {}", line.trim()));
            }
        }

        entries.sort_by(|a, b| a.source.cmp(&b.source).then(a.raw.cmp(&b.raw)));
        Ok(CronReport {
            hostname: first(&sections, "HOST"),
            generated_at: Utc::now().timestamp(),
            service_state: first(&sections, "SERVICE"),
            entries,
            timers,
            at_jobs,
            errors,
            recent,
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

fn is_suspicious(command: &str) -> bool {
    let lower = command.to_lowercase();
    [
        "/tmp/",
        "/dev/shm/",
        "base64",
        "bash -i",
        "/dev/tcp",
        "ncat ",
        " nc ",
        "chmod +x",
        "curl ",
        "wget ",
        "python -c",
        "perl -e",
        "eval ",
        "docker start",
        "docker run",
        "docker exec",
        "docker create",
        "docker pull",
        "docker restart",
        "nohup ",
        "systemd-run",
        "ld.so.preload",
        "authorized_keys",
    ]
    .iter()
    .any(|needle| lower.contains(needle))
}

fn parse_crontab(
    lines: &[String],
    source: &str,
    user_field: bool,
    fixed_user: Option<&str>,
    entries: &mut Vec<CronEntry>,
) {
    for line in lines {
        let raw = line.trim_end().to_string();
        let trimmed = raw.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('#')
            || trimmed.starts_with("no crontab")
            || trimmed.starts_with("###")
            || is_environment_line(trimmed)
        {
            continue;
        }

        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        if tokens.is_empty() {
            continue;
        }

        if tokens[0].starts_with('@') {
            let (user, command_index) = if user_field {
                if tokens.len() < 3 {
                    continue;
                }
                (Some(tokens[1].to_string()), 2)
            } else {
                (fixed_user.map(str::to_string), 1)
            };
            let command = tokens[command_index..].join(" ");
            if command.is_empty() {
                continue;
            }
            entries.push(CronEntry {
                source: source.to_string(),
                schedule: tokens[0].to_string(),
                user,
                suspicious: is_suspicious(&command),
                command,
                raw,
            });
            continue;
        }

        if tokens.len() < 6 {
            continue;
        }

        let schedule = tokens[0..5].join(" ");
        let (user, command_index) = if user_field {
            if tokens.len() < 7 {
                continue;
            }
            (Some(tokens[5].to_string()), 6)
        } else {
            (fixed_user.map(str::to_string), 5)
        };
        let command = tokens[command_index..].join(" ");
        if command.is_empty() {
            continue;
        }
        entries.push(CronEntry {
            source: source.to_string(),
            schedule,
            user,
            suspicious: is_suspicious(&command),
            command,
            raw,
        });
    }
}

fn is_environment_line(line: &str) -> bool {
    let Some((key, _)) = line.split_once('=') else {
        return false;
    };
    !key.is_empty()
        && key.chars().all(|c| c.is_ascii_alphanumeric() || c == '_')
        && key
            .chars()
            .next()
            .is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_user_crontab_lines() {
        let mut entries = Vec::new();
        parse_crontab(
            &[
                "*/5 * * * * /usr/bin/backup.sh".to_string(),
                "@reboot /opt/agent/start".to_string(),
                "MAILTO=root".to_string(),
                "# comment".to_string(),
            ],
            "crontab:deploy",
            false,
            Some("deploy"),
            &mut entries,
        );
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].schedule, "*/5 * * * *");
        assert_eq!(entries[0].user.as_deref(), Some("deploy"));
        assert_eq!(entries[1].schedule, "@reboot");
    }

    #[test]
    fn parses_system_crontab_with_user_field_and_flags_tmp_scripts() {
        let mut entries = Vec::new();
        parse_crontab(
            &["0 3 * * * root /tmp/.hidden.sh".to_string()],
            "/etc/crontab",
            true,
            None,
            &mut entries,
        );
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].user.as_deref(), Some("root"));
        assert_eq!(entries[0].command, "/tmp/.hidden.sh");
        assert!(entries[0].suspicious);
    }

    #[test]
    fn flags_docker_restart_persistence() {
        assert!(is_suspicious(
            "(docker start amco_166a1cb8 2>/dev/null || true) >/dev/null 2>&1"
        ));
        assert!(is_suspicious("nohup sh /tmp/.x.sh"));
        assert!(!is_suspicious("/usr/bin/backup.sh"));
    }

    #[test]
    fn environment_lines_are_not_cron_jobs() {
        assert!(is_environment_line("PATH=/usr/bin:/bin"));
        assert!(is_environment_line("_JAVA_OPTIONS=-Xmx1g"));
        assert!(!is_environment_line("0 3 * * * root /bin/true"));
    }
}

const BACKUP_DIR: &str = "/var/backups/2shell/cron";

impl CronManager {
    pub async fn delete_entry(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        source: &str,
        raw_line: &str,
    ) -> AppResult<CronDeleteResult> {
        validate_delete_source(source)?;
        validate_entry_line(raw_line)?;
        let line = shell_quote(raw_line.trim());
        let slug = backup_slug(source);

        let script = if let Some(user) = source.strip_prefix("crontab:") {
            validate_cron_user(user)?;
            format!(
                r####"set -e
user={user}
line={line}
bdir={bdir}
slug={slug}
mkdir -p "$bdir"
chmod 700 "$bdir"
backup="$bdir/$slug-$(date +%s).bak"
tmp=$(mktemp)
chmod 600 "$tmp"
crontab -l -u "$user" > "$tmp" 2>/dev/null || {{ echo "cannot read crontab for $user" >&2; rm -f "$tmp"; exit 1; }}
grep -Fqx -- "$line" "$tmp" || {{ echo "entry not found in crontab:$user" >&2; rm -f "$tmp"; exit 1; }}
cp -p "$tmp" "$backup"
chmod 600 "$backup"
grep -Fvx -- "$line" "$tmp" > "$tmp.new" || true
crontab -u "$user" "$tmp.new"
rm -f "$tmp" "$tmp.new"
echo "BACKUP=$backup"
echo "removed 1 entry from crontab:$user"
"####,
                user = shell_quote(user),
                line = line,
                bdir = shell_quote(BACKUP_DIR),
                slug = shell_quote(&slug)
            )
        } else {
            format!(
                r####"set -e
file={file}
line={line}
bdir={bdir}
slug={slug}
[ -f "$file" ] || {{ echo "cron file not found" >&2; exit 1; }}
grep -Fqx -- "$line" "$file" || {{ echo "entry not found in $file" >&2; exit 1; }}
mkdir -p "$bdir"
chmod 700 "$bdir"
backup="$bdir/$slug-$(date +%s).bak"
cp -p "$file" "$backup"
chmod 600 "$backup"
grep -Fvx -- "$line" "$file" > "$file.2shell-tmp" || true
cat "$file.2shell-tmp" > "$file"
rm -f "$file.2shell-tmp"
echo "BACKUP=$backup"
echo "removed 1 entry from $file"
"####,
                file = shell_quote(source),
                line = line,
                bdir = shell_quote(BACKUP_DIR),
                slug = shell_quote(&slug)
            )
        };

        let output = pools
            .execute_sensitive(
                &profile.id,
                &as_root(profile, &script),
                Duration::from_secs(30),
            )
            .await?;
        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        if !output.success() {
            return Err(AppError::Remote(format!(
                "cannot delete cron entry: {combined}"
            )));
        }
        Ok(CronDeleteResult {
            source: source.to_string(),
            backup: parse_backup(&combined).unwrap_or_default(),
            output: strip_backup(&combined),
            entries: vec![raw_line.trim().to_string()],
        })
    }

    pub async fn restore_backup(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        source: &str,
        backup: &str,
    ) -> AppResult<String> {
        validate_delete_source(source)?;
        validate_backup_path(backup)?;

        let script = if let Some(user) = source.strip_prefix("crontab:") {
            validate_cron_user(user)?;
            format!(
                r####"set -e
backup={backup}
user={user}
[ -f "$backup" ] || {{ echo "backup not found: $backup" >&2; exit 1; }}
crontab -u "$user" "$backup"
echo "crontab:$user restored from $backup"
"####,
                backup = shell_quote(backup),
                user = shell_quote(user)
            )
        } else {
            format!(
                r####"set -e
backup={backup}
file={file}
[ -f "$backup" ] || {{ echo "backup not found: $backup" >&2; exit 1; }}
cp -p "$backup" "$file"
echo "$file restored from $backup"
"####,
                backup = shell_quote(backup),
                file = shell_quote(source)
            )
        };

        let output = pools
            .execute_sensitive(
                &profile.id,
                &as_root(profile, &script),
                Duration::from_secs(30),
            )
            .await?;
        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        if !output.success() {
            return Err(AppError::Remote(format!(
                "cannot restore cron backup: {combined}"
            )));
        }
        Ok(combined)
    }

    pub async fn delete_suspicious(
        pools: &PoolManager,
        profile: &ConnectionProfile,
    ) -> AppResult<CronBulkDeleteResult> {
        let report = Self::list(pools, profile).await?;
        let mut groups: BTreeMap<String, Vec<String>> = BTreeMap::new();
        for entry in report.entries.iter().filter(|entry| entry.suspicious) {
            if !is_writable_source(&entry.source) {
                continue;
            }
            let raw = entry.raw.trim();
            if raw.is_empty() || raw.chars().any(char::is_control) {
                continue;
            }
            groups
                .entry(entry.source.clone())
                .or_default()
                .push(raw.to_string());
        }

        if groups.is_empty() {
            return Err(AppError::Validation(
                "no suspicious entries in writable cron sources".into(),
            ));
        }

        let mut results = Vec::new();
        let mut outputs = Vec::new();
        for (source, lines) in &groups {
            validate_delete_source(source)?;
            let patterns = lines
                .iter()
                .map(|line| shell_quote(line))
                .collect::<Vec<_>>()
                .join(" ");
            let slug = shell_quote(&backup_slug(source));

            let script = if let Some(user) = source.strip_prefix("crontab:") {
                format!(
                    r####"set -e
user={user}
bdir={bdir}
slug={slug}
mkdir -p "$bdir"
chmod 700 "$bdir"
backup="$bdir/$slug-$(date +%s).bak"
tmp=$(mktemp)
pat=$(mktemp)
chmod 600 "$tmp" "$pat"
printf '%s\n' {patterns} > "$pat"
crontab -l -u "$user" > "$tmp" 2>/dev/null || {{ echo "cannot read crontab for $user" >&2; rm -f "$tmp" "$pat"; exit 1; }}
cp -p "$tmp" "$backup"
chmod 600 "$backup"
count=$(grep -c -F -x -f "$pat" "$tmp" || true)
grep -FvxF -f "$pat" "$tmp" > "$tmp.new" || true
crontab -u "$user" "$tmp.new"
rm -f "$tmp" "$tmp.new" "$pat"
echo "BACKUP=$backup"
echo "crontab:$user: removed ${{count:-0}} entries"
"####,
                    user = shell_quote(user),
                    bdir = shell_quote(BACKUP_DIR),
                    slug = slug,
                    patterns = patterns
                )
            } else {
                format!(
                    r####"set -e
file={file}
bdir={bdir}
slug={slug}
[ -f "$file" ] || {{ echo "cron file not found" >&2; exit 1; }}
mkdir -p "$bdir"
chmod 700 "$bdir"
backup="$bdir/$slug-$(date +%s).bak"
pat=$(mktemp)
chmod 600 "$pat"
printf '%s\n' {patterns} > "$pat"
cp -p "$file" "$backup"
chmod 600 "$backup"
count=$(grep -c -F -x -f "$pat" "$file" || true)
grep -FvxF -f "$pat" "$file" > "$file.2shell-tmp" || true
cat "$file.2shell-tmp" > "$file"
rm -f "$file.2shell-tmp" "$pat"
echo "BACKUP=$backup"
echo "$file: removed ${{count:-0}} entries"
"####,
                    file = shell_quote(source),
                    bdir = shell_quote(BACKUP_DIR),
                    slug = slug,
                    patterns = patterns
                )
            };

            let output = pools
                .execute_sensitive(
                    &profile.id,
                    &as_root(profile, &script),
                    Duration::from_secs(45),
                )
                .await?;
            let combined = format!("{}{}", output.stdout, output.stderr)
                .trim()
                .to_string();
            if !output.success() {
                return Err(AppError::Remote(format!(
                    "cannot remove suspicious entries from {source}: {combined}"
                )));
            }
            outputs.push(strip_backup(&combined));
            results.push(CronDeleteResult {
                source: source.clone(),
                backup: parse_backup(&combined).unwrap_or_default(),
                output: strip_backup(&combined),
                entries: lines.clone(),
            });
        }

        outputs.insert(
            0,
            format!(
                "{} suspicious cron entries removed from {} source(s)",
                results
                    .iter()
                    .map(|result| result.entries.len())
                    .sum::<usize>(),
                results.len()
            ),
        );
        Ok(CronBulkDeleteResult {
            output: outputs.join("\n"),
            results,
        })
    }
}

fn validate_entry_line(raw_line: &str) -> AppResult<()> {
    if raw_line.trim().is_empty()
        || raw_line.contains('\n')
        || raw_line.contains('\r')
        || raw_line.chars().any(char::is_control)
    {
        return Err(AppError::Validation("invalid cron entry line".into()));
    }
    Ok(())
}

fn backup_slug(source: &str) -> String {
    source
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '_' })
        .collect()
}

fn parse_backup(output: &str) -> Option<String> {
    output
        .lines()
        .find_map(|line| line.trim().strip_prefix("BACKUP="))
        .map(|value| value.trim().to_string())
}

fn strip_backup(output: &str) -> String {
    output
        .lines()
        .filter(|line| !line.trim().starts_with("BACKUP="))
        .collect::<Vec<_>>()
        .join("\n")
        .trim()
        .to_string()
}

fn validate_backup_path(path: &str) -> AppResult<()> {
    let name = path
        .strip_prefix(BACKUP_DIR)
        .and_then(|rest| rest.strip_prefix('/'))
        .ok_or_else(|| AppError::Validation(format!("unexpected backup path: {path}")))?;
    if name.is_empty()
        || name.contains('/')
        || name.contains("..")
        || name.chars().any(|c| c.is_control())
    {
        return Err(AppError::Validation("invalid backup path".into()));
    }
    Ok(())
}

fn is_writable_source(source: &str) -> bool {
    source.starts_with("crontab:") || source == "/etc/crontab" || source.starts_with("/etc/cron.d/")
}

fn validate_delete_source(source: &str) -> AppResult<()> {
    if let Some(user) = source.strip_prefix("crontab:") {
        return validate_cron_user(user);
    }
    if source == "/etc/crontab" {
        return Ok(());
    }
    if let Some(file) = source.strip_prefix("/etc/cron.d/") {
        if file.is_empty()
            || file.contains('/')
            || file.contains("..")
            || file.chars().any(char::is_control)
        {
            return Err(AppError::Validation("invalid /etc/cron.d file path".into()));
        }
        return Ok(());
    }
    Err(AppError::Validation(format!(
        "cron source '{source}' is read-only; remove periodic scripts manually"
    )))
}

fn validate_cron_user(user: &str) -> AppResult<()> {
    if user.trim().is_empty() || user.chars().any(|c| c.is_control() || c.is_whitespace()) {
        return Err(AppError::Validation("invalid cron user".into()));
    }
    Ok(())
}

#[cfg(test)]
mod delete_tests {
    use super::*;

    #[test]
    fn accepts_supported_cron_sources() {
        assert!(validate_delete_source("crontab:root").is_ok());
        assert!(validate_delete_source("/etc/crontab").is_ok());
        assert!(validate_delete_source("/etc/cron.d/0hourly").is_ok());
        assert!(validate_delete_source("/etc/cron.daily").is_err());
        assert!(validate_delete_source("/etc/cron.d/../passwd").is_err());
        assert!(validate_delete_source("crontab:bad user").is_err());
    }

    #[test]
    fn sanitizes_backup_names() {
        assert_eq!(backup_slug("crontab:root"), "crontab_root");
        assert_eq!(backup_slug("/etc/cron.d/0hourly"), "_etc_cron_d_0hourly");
    }

    #[test]
    fn validates_backup_paths() {
        assert!(validate_backup_path("/var/backups/2shell/cron/crontab_root-1.bak").is_ok());
        assert!(validate_backup_path("/var/backups/2shell/cron/../passwd").is_err());
        assert!(validate_backup_path("/etc/passwd").is_err());
        assert!(validate_backup_path("/var/backups/2shell/cron/").is_err());
    }

    #[test]
    fn parses_backup_marker() {
        let output = "BACKUP=/var/backups/2shell/cron/a-1.bak\nremoved 1 entry";
        assert_eq!(
            parse_backup(output).as_deref(),
            Some("/var/backups/2shell/cron/a-1.bak")
        );
        assert_eq!(strip_backup(output), "removed 1 entry");
    }

    #[test]
    fn only_writable_sources_are_bulk_editable() {
        assert!(is_writable_source("crontab:root"));
        assert!(is_writable_source("/etc/crontab"));
        assert!(is_writable_source("/etc/cron.d/0hourly"));
        assert!(!is_writable_source("/etc/cron.hourly"));
        assert!(!is_writable_source("/etc/cron.daily/droplet-agent"));
    }
}
