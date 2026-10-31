use crate::application::filesystem::{human_size, validate_path};
use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, DirListing, FsEntry};
use std::time::Duration;

const FS_TIMEOUT: Duration = Duration::from_secs(20);
const MAX_ENTRIES: usize = 3000;

const LIST_SCRIPT: &str = r####"export LC_ALL=C 2>/dev/null
dir=__DIR__
[ -d "$dir" ] || { echo "not a directory: $dir" >&2; exit 3; }
cd "$dir" || exit 4
echo "__PATH__$PWD"
for f in .[!.]* *; do
  [ -e "$f" ] || [ -L "$f" ] || continue
  if [ -L "$f" ]; then kind=link
  elif [ -d "$f" ]; then kind=dir
  else kind=file; fi
  empty=0
  if [ "$kind" = dir ]; then
    if [ -z "$(ls -A -- "$f" 2>/dev/null | head -n 1)" ]; then empty=1; fi
  fi
  size=$(stat -c %s -- "$f" 2>/dev/null || true)
  [ -n "$size" ] || size=0
  mode=$(stat -c %a -- "$f" 2>/dev/null || true)
  [ -n "$mode" ] || mode=-
  mtime=$(stat -c %y -- "$f" 2>/dev/null | cut -c1-19)
  printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$f" "$kind" "$size" "$mode" "$mtime" "$empty"
done | head -n __LIMIT__
exit 0
"####;

pub struct FileTreeManager;

impl FileTreeManager {
    pub async fn list(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        path: &str,
    ) -> AppResult<DirListing> {
        validate_list_path(path)?;
        let script = LIST_SCRIPT
            .replace("__DIR__", &shell_quote(path))
            .replace("__LIMIT__", &MAX_ENTRIES.to_string());
        let output = pools
            .execute_filesystem(&profile.id, &script, FS_TIMEOUT)
            .await?;
        if !output.success() {
            return Err(AppError::Remote(format!(
                "cannot list {path}: {}",
                output.stderr.trim()
            )));
        }

        let mut resolved = path.to_string();
        let mut entries = Vec::new();
        for line in output.stdout.lines() {
            if let Some(value) = line.strip_prefix("__PATH__") {
                resolved = value.trim().to_string();
                continue;
            }
            let mut parts = line.splitn(6, '\t');
            let Some(name) = parts.next() else { continue };
            if name.is_empty() {
                continue;
            }
            let kind = parts.next().unwrap_or("file").to_string();
            let raw_size: u64 = parts
                .next()
                .and_then(|v| v.trim().parse().ok())
                .unwrap_or(0);
            let mode = parts.next().unwrap_or("-").trim().to_string();
            let modified = parts.next().unwrap_or("").trim().to_string();
            let empty = parts.next().map(|v| v.trim() == "1").unwrap_or(false);
            let is_link = kind == "link";
            entries.push(FsEntry {
                name: name.to_string(),
                path: join_path(&resolved, name),
                kind,
                size_bytes: raw_size,
                size_human: human_size(raw_size),
                mode,
                modified,
                empty,
                hidden: name.starts_with('.'),
                symlink: is_link,
            });
        }

        entries.sort_by(|a, b| {
            rank(&a.kind)
                .cmp(&rank(&b.kind))
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
        });

        Ok(DirListing {
            path: resolved.clone(),
            parent: parent_of(&resolved),
            entries,
        })
    }

    pub async fn editor(pools: &PoolManager, profile: &ConnectionProfile) -> AppResult<String> {
        let script = r####"export LC_ALL=C 2>/dev/null
for c in "$EDITOR" vim nano vi; do
  [ -n "$c" ] || continue
  if command -v "$c" >/dev/null 2>&1; then
    echo "$c"
    exit 0
  fi
done
echo vi
"####;
        let output = pools
            .execute_filesystem(&profile.id, script, Duration::from_secs(10))
            .await?;
        let candidate = output
            .stdout
            .lines()
            .next()
            .unwrap_or("vi")
            .split_whitespace()
            .next()
            .unwrap_or("vi")
            .to_string();
        let valid = !candidate.is_empty()
            && candidate.len() <= 120
            && candidate
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '/' | '.' | '_' | '-'));
        Ok(if valid { candidate } else { "vi".to_string() })
    }

    pub async fn create(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        path: &str,
        directory: bool,
    ) -> AppResult<String> {
        validate_path(path)?;
        let quoted = shell_quote(path);
        let script = if directory {
            format!("mkdir -p -- {quoted}")
        } else {
            format!(
                "[ -e {quoted} ] && {{ echo \"already exists: {quoted}\" >&2; exit 5; }}; \
                 d=$(dirname -- {quoted}); mkdir -p -- \"$d\"; : > {quoted}"
            )
        };
        run(pools, profile, &script, "create").await
    }

    pub async fn rename(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        from: &str,
        to: &str,
    ) -> AppResult<String> {
        validate_path(from)?;
        validate_path(to)?;
        let script = format!(
            "[ -e {to} ] && {{ echo \"destination exists: {to}\" >&2; exit 6; }}; mv -- {from} {to} && echo renamed",
            from = shell_quote(from),
            to = shell_quote(to)
        );
        run(pools, profile, &script, "rename").await
    }

    pub async fn delete(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        path: &str,
    ) -> AppResult<String> {
        validate_path(path)?;
        let script = format!("rm -rf -- {}", shell_quote(path));
        run(pools, profile, &script, "delete").await
    }
}

fn rank(kind: &str) -> u8 {
    match kind {
        "dir" => 0,
        "link" => 1,
        _ => 2,
    }
}

fn join_path(parent: &str, name: &str) -> String {
    if parent.ends_with('/') {
        format!("{parent}{name}")
    } else {
        format!("{parent}/{name}")
    }
}

fn parent_of(path: &str) -> String {
    if path == "/" {
        return "/".to_string();
    }
    let trimmed = path.trim_end_matches('/');
    match trimmed.rfind('/') {
        Some(0) => "/".to_string(),
        Some(index) => trimmed[..index].to_string(),
        None => "/".to_string(),
    }
}

fn validate_list_path(path: &str) -> AppResult<()> {
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

async fn run(
    pools: &PoolManager,
    profile: &ConnectionProfile,
    script: &str,
    action: &str,
) -> AppResult<String> {
    let output = pools
        .execute_filesystem(&profile.id, script, FS_TIMEOUT)
        .await?;
    let combined = format!("{}{}", output.stdout, output.stderr)
        .trim()
        .to_string();
    if !output.success() {
        return Err(AppError::Remote(format!(
            "{action} failed: {}",
            if combined.is_empty() {
                "unknown error"
            } else {
                combined.as_str()
            }
        )));
    }
    Ok(combined)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn joins_and_resolves_parents() {
        assert_eq!(join_path("/var/www", "app"), "/var/www/app");
        assert_eq!(join_path("/", "etc"), "/etc");
        assert_eq!(parent_of("/var/www/app"), "/var/www");
        assert_eq!(parent_of("/var"), "/");
        assert_eq!(parent_of("/"), "/");
    }

    #[test]
    fn orders_directories_first() {
        let mut kinds = vec!["file", "dir", "link"];
        kinds.sort_by_key(|kind| rank(kind));
        assert_eq!(kinds, vec!["dir", "link", "file"]);
    }

    #[test]
    fn rejects_unsafe_list_paths() {
        assert!(validate_list_path("/var/www").is_ok());
        assert!(validate_list_path("/").is_ok());
        assert!(validate_list_path("relative").is_err());
        assert!(validate_list_path("/var/../etc").is_err());
        assert!(validate_list_path("/var/x\nrm -rf /").is_err());
    }
}
