use crate::application::filesystem::human_size;
use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{ArtifactEntry, ConnectionProfile, SearchHit, SecretHit, SessionEntry};
use chrono::Utc;
use std::time::Duration;

const TIMEOUT: Duration = Duration::from_secs(60);
const SESSION_LIMIT: usize = 200;
const ARTIFACT_LIMIT: usize = 400;
const SEARCH_LIMIT: usize = 300;
const SECRET_LIMIT: usize = 200;

pub struct ForensicsManager;

impl ForensicsManager {
    /// SSH login history with source IP, start/end and duration.
    pub async fn sessions(
        pools: &PoolManager,
        profile: &ConnectionProfile,
    ) -> AppResult<Vec<SessionEntry>> {
        let script =
            format!("LC_ALL=C last -aF -n {SESSION_LIMIT} 2>/dev/null | head -n {SESSION_LIMIT}");
        let output = pools
            .execute_with_category(&profile.id, &as_root(profile, &script), TIMEOUT, "security")
            .await?;
        let mut sessions = Vec::new();
        for line in output.stdout.lines() {
            if line.trim().is_empty() || line.starts_with("wtmp") || line.starts_with("btmp") {
                continue;
            }
            if let Some(entry) = parse_session(line) {
                sessions.push(entry);
            }
        }
        Ok(sessions)
    }

    /// Top-level entries of a directory with birth/change timestamps and a rough tag.
    pub async fn artifacts(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        path: &str,
    ) -> AppResult<Vec<ArtifactEntry>> {
        validate_path(path)?;
        let script = format!(
            r####"export LC_ALL=C 2>/dev/null
dir={dir}
[ -d "$dir" ] || {{ echo "not a directory: $dir" >&2; exit 3; }}
for f in "$dir"/* "$dir"/.[!.]*; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  stat -c '%n\t%F\t%w\t%z\t%s' -- "$f" 2>/dev/null
done | head -n {limit}
exit 0
"####,
            dir = shell_quote(path),
            limit = ARTIFACT_LIMIT
        );
        let output = pools
            .execute_with_category(&profile.id, &as_root(profile, &script), TIMEOUT, "security")
            .await?;
        if !output.success() && output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "cannot inspect {path}: {}",
                output.stderr.trim()
            )));
        }

        let mut artifacts: Vec<ArtifactEntry> = output
            .stdout
            .lines()
            .filter_map(|line| {
                let mut parts = line.splitn(5, '\t');
                let full = parts.next()?.trim();
                let kind = parts.next()?.trim().to_string();
                let birth = parts.next().unwrap_or("-").trim().to_string();
                let change = parts.next().unwrap_or("-").trim().to_string();
                let size: u64 = parts
                    .next()
                    .and_then(|v| v.trim().parse().ok())
                    .unwrap_or(0);
                let name = full.rsplit('/').next().unwrap_or(full).to_string();
                Some(ArtifactEntry {
                    name: name.clone(),
                    path: full.to_string(),
                    tag: classify(&name),
                    kind,
                    birth,
                    change,
                    size_bytes: size,
                    size_human: human_size(size),
                })
            })
            .collect();

        artifacts.sort_by(|a, b| a.tag.cmp(&b.tag).then(a.name.cmp(&b.name)));
        Ok(artifacts)
    }

    /// Literal recursive search (grep -F) with bounded output.
    pub async fn search(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        path: &str,
        query: &str,
        regex: bool,
    ) -> AppResult<Vec<SearchHit>> {
        validate_path(path)?;
        if query.trim().is_empty() || query.chars().any(char::is_control) {
            return Err(AppError::Validation("invalid search query".into()));
        }
        let mode = if regex { "-E" } else { "-F" };
        let script = format!(
            r####"export LC_ALL=C 2>/dev/null
dir={dir}
[ -d "$dir" ] || {{ echo "not a directory: $dir" >&2; exit 3; }}
grep -RInI {mode} --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next \
  --exclude-dir=dist --exclude-dir=build --exclude-dir=.cache --exclude-dir=target \
  -- {query} "$dir" 2>/dev/null | head -n {limit}
exit 0
"####,
            dir = shell_quote(path),
            query = shell_quote(query),
            mode = mode,
            limit = SEARCH_LIMIT
        );
        let output = pools
            .execute_with_category(&profile.id, &as_root(profile, &script), TIMEOUT, "security")
            .await?;
        Ok(parse_hits(&output.stdout))
    }

    /// Files containing credential-like patterns. Values are never returned.
    pub async fn secrets(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        path: &str,
    ) -> AppResult<Vec<SecretHit>> {
        validate_path(path)?;
        let script = format!(
            r####"export LC_ALL=C 2>/dev/null
dir={dir}
[ -d "$dir" ] || {{ echo "not a directory: $dir" >&2; exit 3; }}
grep -RInIE --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.next \
  --exclude-dir=dist --exclude-dir=build --exclude-dir=.cache --exclude-dir=target \
  'sk-[A-Za-z0-9_-]{{20,}}|ghp_[A-Za-z0-9]{{36}}|AIza[0-9A-Za-z_-]{{35}}|AKIA[0-9A-Z]{{16}}|xox[bpas]-[0-9A-Za-z-]{{10,}}|dop_v1_[a-f0-9]{{64}}|sk_live_[0-9a-zA-Z]{{24,}}|-----BEGIN [A-Z ]*PRIVATE KEY-----' \
  "$dir" 2>/dev/null | head -n {limit}
exit 0
"####,
            dir = shell_quote(path),
            limit = SECRET_LIMIT
        );
        let output = pools
            .execute_with_category(&profile.id, &as_root(profile, &script), TIMEOUT, "security")
            .await?;

        let mut hits = Vec::new();
        for line in output.stdout.lines() {
            let mut parts = line.splitn(3, ':');
            let Some(path) = parts.next() else { continue };
            let Some(number) = parts.next().and_then(|v| v.parse::<u32>().ok()) else {
                continue;
            };
            let Some(text) = parts.next() else { continue };
            let kind = detect_kind(text);
            hits.push(SecretHit {
                path: path.to_string(),
                line: number,
                kind,
                preview: mask(text),
            });
            if hits.len() >= SECRET_LIMIT {
                break;
            }
        }
        Ok(hits)
    }
}

fn parse_session(line: &str) -> Option<SessionEntry> {
    let fields: Vec<&str> = line.split_whitespace().collect();
    if fields.len() < 8 {
        return None;
    }
    let user = fields[0].to_string();

    // `last -aF` puts the source host at the very end, after the duration.
    if user == "reboot" {
        return Some(SessionEntry {
            user,
            tty: fields[1].to_string(),
            from: String::new(),
            start: fields.get(3..8).map(|s| s.join(" ")).unwrap_or_default(),
            end: "still running".to_string(),
            duration: String::new(),
            current: true,
        });
    }

    let tty = fields[1].to_string();
    let start = fields[2..7].join(" ");
    let mut tail: Vec<&str> = fields[7..].to_vec();
    let host = tail
        .last()
        .copied()
        .filter(|value| {
            !value.starts_with('(')
                && value.parse::<i32>().is_err()
                && !matches!(*value, "in" | "running" | "logged" | "-")
        })
        .unwrap_or("");
    let from = host.to_string();
    if !from.is_empty() {
        tail.pop();
    }
    let joined = tail.join(" ");
    let current = joined.contains("still logged in") || joined.contains("still running");
    let (end, duration) = if current {
        ("still logged in".to_string(), String::new())
    } else if let Some(rest) = joined.strip_prefix("- ") {
        let duration = rest
            .rsplit_once('(')
            .map(|(_, value)| value.trim_end_matches(')').to_string())
            .unwrap_or_default();
        let end = rest.split(" (").next().unwrap_or(rest).trim().to_string();
        (end, duration)
    } else {
        (String::new(), String::new())
    };

    Some(SessionEntry {
        user,
        tty,
        from,
        start,
        end,
        duration,
        current,
    })
}

fn parse_hits(output: &str) -> Vec<SearchHit> {
    output
        .lines()
        .filter_map(|line| {
            let mut parts = line.splitn(3, ':');
            let path = parts.next()?.to_string();
            let number = parts.next()?.parse().ok()?;
            let text = parts.next().unwrap_or("").to_string();
            Some(SearchHit {
                path,
                line: number,
                text: truncate(&text, 400),
            })
        })
        .collect()
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

fn mask(line: &str) -> String {
    let trimmed = line.trim();
    if trimmed.len() <= 80 {
        return format!("{}…", &trimmed[..trimmed.len().min(12)]);
    }
    format!("{}…", &trimmed[..40])
}

fn detect_kind(line: &str) -> String {
    if line.contains("BEGIN") && line.contains("PRIVATE KEY") {
        "private key".to_string()
    } else if line.contains("ghp_") {
        "github token".to_string()
    } else if line.contains("AIza") {
        "google api key".to_string()
    } else if line.contains("AKIA") {
        "aws access key".to_string()
    } else if line.contains("xox") {
        "slack token".to_string()
    } else if line.contains("dop_v1_") {
        "digitalocean token".to_string()
    } else if line.contains("sk_live_") {
        "stripe key".to_string()
    } else {
        "api key".to_string()
    }
}

fn classify(name: &str) -> String {
    let lower = name.to_lowercase();
    let ai = [
        ".cursor",
        ".cursor-server",
        ".windsurf-server",
        ".vscode-server",
        ".copilot",
        ".gemini",
        ".codeium",
        ".claude",
        ".ollama",
        ".aider",
        "antigravity",
    ];
    if ai
        .iter()
        .any(|prefix| lower == *prefix || lower.starts_with(prefix))
    {
        return "ai-tool".to_string();
    }
    let dev = [
        ".npm", ".nvm", ".pm2", ".local", ".config", ".cache", ".dotnet", ".mongodb", ".yarn",
        ".bun", ".cargo", ".rustup", ".gradle", ".m2", ".vscode",
    ];
    if dev.contains(&lower.as_str()) {
        return "dev-tool".to_string();
    }
    if lower == ".ssh" || lower == ".gnupg" {
        return "credentials".to_string();
    }
    "other".to_string()
}

fn validate_path(path: &str) -> AppResult<()> {
    if path.is_empty() || !path.starts_with('/') {
        return Err(AppError::Validation("an absolute path is required".into()));
    }
    if path.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(AppError::Validation(
            "path contains control characters".into(),
        ));
    }
    if path.split('/').any(|segment| segment == "..") {
        return Err(AppError::Validation("path traversal is not allowed".into()));
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

#[allow(dead_code)]
fn now() -> i64 {
    Utc::now().timestamp()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_login_history() {
        let line = "root     pts/2        Thu Oct 29 16:31:08 2026 - Thu Oct 29 16:31:13 2026  (00:00)     190.103.29.167";
        let session = parse_session(line).unwrap();
        assert_eq!(session.user, "root");
        assert_eq!(session.tty, "pts/2");
        assert_eq!(session.from, "190.103.29.167");
        assert!(!session.current);
        assert_eq!(session.duration, "00:00");

        let current = "root     pts/1        Thu Oct 29 16:30:25 2026   still logged in                       190.103.29.167";
        let session = parse_session(current).unwrap();
        assert!(session.current);
    }

    #[test]
    fn classifies_artifacts() {
        assert_eq!(classify(".cursor-server"), "ai-tool");
        assert_eq!(classify(".gemini"), "ai-tool");
        assert_eq!(classify(".pm2"), "dev-tool");
        assert_eq!(classify(".ssh"), "credentials");
        assert_eq!(classify("dump"), "other");
    }

    #[test]
    fn parses_search_output() {
        let hits = parse_hits("/root/a.txt:12:useradd pakchoi\n/root/b.txt:3:curl http://x\n");
        assert_eq!(hits.len(), 2);
        assert_eq!(hits[0].path, "/root/a.txt");
        assert_eq!(hits[0].line, 12);
        assert_eq!(hits[1].text, "curl http://x");
    }

    #[test]
    fn detects_secret_kinds_without_leaking_values() {
        assert_eq!(detect_kind("x ghp_abcdef"), "github token");
        assert_eq!(detect_kind("AKIAIOSFODNN7EXAMPLE"), "aws access key");
        assert_eq!(
            detect_kind("-----BEGIN RSA PRIVATE KEY-----"),
            "private key"
        );
        assert!(!mask("sk-1234567890abcdefghijklmnop").contains("abcdefghij"));
    }

    #[test]
    fn rejects_unsafe_paths() {
        assert!(validate_path("/root").is_ok());
        assert!(validate_path("root").is_err());
        assert!(validate_path("/root/../etc").is_err());
    }
}
