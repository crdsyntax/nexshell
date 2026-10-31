use crate::application::pool::PoolManager;
use crate::application::services::{maybe_sudo, shell_quote};
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, FileDeleteResult, FileProperties, LargeFile};
use std::time::Duration;

const LARGE_FILES_LIMIT: u32 = 20;
const SCAN_TIMEOUT: Duration = Duration::from_secs(180);

pub struct FilesystemManager;

impl FilesystemManager {
    pub async fn large_files(
        pools: &PoolManager,
        profile: &ConnectionProfile,
    ) -> AppResult<Vec<LargeFile>> {
        if profile.elevated {
            let preflight = pools
                .execute_filesystem(
                    &profile.id,
                    "sudo -n find / -maxdepth 0 -print",
                    Duration::from_secs(10),
                )
                .await?;
            if !preflight.success() {
                return Err(AppError::Validation(format!(
                    "sudo -n cannot run find: {}. Add /usr/bin/find to the NOPASSWD sudoers rule or disable the elevated option.",
                    first_non_empty(&preflight.stderr, &preflight.stdout)
                )));
            }
        }

        let find = maybe_sudo(profile, "find");
        let script = format!(
            "export LC_ALL=C\n{find} / -xdev -type f -exec du -h {{}} + 2>/dev/null | sort -rh | head -n {LARGE_FILES_LIMIT}\n"
        );

        let output = pools
            .execute_filesystem(&profile.id, &script, SCAN_TIMEOUT)
            .await?;

        if !output.success() && output.stdout.trim().is_empty() {
            let detail = first_non_empty(&output.stderr, &output.stdout);
            return Err(AppError::Remote(format!(
                "large-file scan failed (exit {}): {detail}",
                output.exit_status
            )));
        }

        Ok(parse_large_files(&output.stdout))
    }

    pub async fn properties(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        path: &str,
    ) -> AppResult<FileProperties> {
        validate_path(path)?;

        let stat = maybe_sudo(profile, "stat");
        let du = maybe_sudo(profile, "du");
        let readlink = maybe_sudo(profile, "readlink");
        let script = format!(
            r#"p={path}
stat_out=$({stat} -c '%s|%U|%G|%a|%y|%x|%i|%h|%F' -- "$p" 2>&1)
rc=$?
echo "__STAT__$stat_out"
echo "__RC__$rc"
echo "__DU__"
{du} -h -- "$p" 2>/dev/null | awk '{{print $1}}'
echo "__TARGET__"
{readlink} -- "$p" 2>/dev/null
echo "__TARGET_END__"
exit 0"#,
            path = shell_quote(path),
            stat = stat,
            du = du,
            readlink = readlink
        );

        let output = pools
            .execute_filesystem(&profile.id, &script, Duration::from_secs(20))
            .await?;

        parse_properties(path, &output.stdout)
    }

    pub async fn delete(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        path: &str,
    ) -> AppResult<FileDeleteResult> {
        validate_deletable_path(path)?;

        let test = maybe_sudo(profile, "test");
        let exists = pools
            .execute_filesystem(
                &profile.id,
                &format!("{test} -f {}", shell_quote(path)),
                Duration::from_secs(10),
            )
            .await?;
        if !exists.success() {
            let detail = first_non_empty(&exists.stderr, &exists.stdout);
            if detail.is_empty() {
                return Err(AppError::NotFound(format!(
                    "{path} is not a regular file or no longer exists"
                )));
            }
            return Err(AppError::Validation(format!(
                "cannot verify {path}: {detail}"
            )));
        }

        let rm = maybe_sudo(profile, "rm");
        let output = pools
            .execute_filesystem(
                &profile.id,
                &format!("{rm} -f -- {} 2>&1", shell_quote(path)),
                Duration::from_secs(30),
            )
            .await?;

        if !output.success() {
            let detail = first_non_empty(&output.stderr, &output.stdout);
            let hint = if detail.contains("Permission denied") {
                "permission denied — enable the elevated (sudo -n) profile option or delete the file as its owner"
            } else {
                detail.as_str()
            };
            return Err(AppError::Remote(format!("cannot delete {path}: {hint}")));
        }

        Ok(FileDeleteResult {
            path: path.to_string(),
            ok: true,
            output: format!("deleted {path}"),
            exit_code: output.exit_status,
        })
    }

    pub async fn ensure_directory(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        directory: &str,
    ) -> AppResult<()> {
        if directory != "/" {
            validate_path(directory)?;
        }
        let quote = shell_quote(directory);
        let script = format!(
            "if [ -d {quote} ] && [ -r {quote} ] && [ -x {quote} ]; then echo yes; else echo no; fi"
        );
        let output = pools
            .execute_filesystem(&profile.id, &script, Duration::from_secs(10))
            .await?;
        if output.stdout.trim() != "yes" {
            return Err(AppError::Validation(format!(
                "the SSH user cannot access directory {directory}; check its permissions"
            )));
        }
        Ok(())
    }
}

fn first_non_empty(primary: &str, fallback: &str) -> String {
    let primary = primary.trim();
    if primary.is_empty() {
        fallback.trim().to_string()
    } else {
        primary.to_string()
    }
}

pub fn validate_path(path: &str) -> AppResult<()> {
    if path.trim().is_empty() {
        return Err(AppError::Validation("path is required".into()));
    }
    if !path.starts_with('/') {
        return Err(AppError::Validation("an absolute path is required".into()));
    }
    if path == "/" {
        return Err(AppError::Validation(
            "refusing to operate on the filesystem root".into(),
        ));
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

fn validate_deletable_path(path: &str) -> AppResult<()> {
    validate_path(path)?;
    for prefix in ["/proc/", "/sys/", "/dev/"] {
        if path.starts_with(prefix) {
            return Err(AppError::Validation(format!(
                "refusing to delete files from the virtual filesystem {prefix}"
            )));
        }
    }
    Ok(())
}

pub fn parse_human_size(value: &str) -> u64 {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return 0;
    }

    let (number, suffix) = match trimmed.chars().last() {
        Some(last) if last.is_ascii_alphabetic() => {
            (&trimmed[..trimmed.len() - 1], last.to_ascii_uppercase())
        }
        _ => (trimmed, ' '),
    };

    let multiplier = match suffix {
        'K' => 1024f64,
        'M' => 1024f64.powi(2),
        'G' => 1024f64.powi(3),
        'T' => 1024f64.powi(4),
        'P' => 1024f64.powi(5),
        _ => 1f64,
    };

    let number = number.trim().parse::<f64>().unwrap_or(0.0);
    (number * multiplier).round().clamp(0.0, u64::MAX as f64) as u64
}

pub fn human_size(bytes: u64) -> String {
    const UNITS: [&str; 6] = ["B", "K", "M", "G", "T", "P"];
    if bytes == 0 {
        return "0 B".to_string();
    }

    let mut value = bytes as f64;
    let mut unit = 0;
    while value >= 1024.0 && unit < UNITS.len() - 1 {
        value /= 1024.0;
        unit += 1;
    }

    if unit == 0 {
        format!("{bytes} B")
    } else {
        format!("{value:.1}{}", UNITS[unit])
    }
}

fn parse_large_files(output: &str) -> Vec<LargeFile> {
    output
        .lines()
        .filter_map(|line| {
            let line = line.trim_end();
            let (size, path) = line.split_once('\t').or_else(|| line.split_once(' '))?;
            let size = size.trim();
            let path = path.trim();
            if size.is_empty() || path.is_empty() {
                return None;
            }
            Some(LargeFile {
                path: path.to_string(),
                size_human: size.to_string(),
                size_bytes: parse_human_size(size),
            })
        })
        .collect()
}

fn parse_properties(path: &str, output: &str) -> AppResult<FileProperties> {
    let stat_line = output
        .lines()
        .find_map(|line| line.strip_prefix("__STAT__"))
        .map(str::trim)
        .unwrap_or_default()
        .to_string();
    let stat_rc: i32 = output
        .lines()
        .find_map(|line| line.strip_prefix("__RC__"))
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(1);

    if stat_rc != 0 {
        if stat_line.contains("No such file")
            || stat_line.contains("cannot stat")
            || stat_line.contains("cannot access")
        {
            return Err(AppError::NotFound(format!(
                "{path} does not exist or is no longer accessible"
            )));
        }
        return Err(AppError::Remote(format!(
            "cannot inspect {path}: {stat_line}"
        )));
    }

    let fields: Vec<&str> = stat_line.splitn(9, '|').collect();
    if fields.len() < 9 {
        return Err(AppError::Remote(format!(
            "unexpected stat output for {path}: {stat_line}"
        )));
    }

    let size_bytes = fields[0].trim().parse().unwrap_or(0);
    let disk_usage_human = output
        .split("__DU__")
        .nth(1)
        .map(str::trim_start)
        .and_then(|section| section.lines().next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("unknown")
        .to_string();
    let target = output
        .split("__TARGET__")
        .nth(1)
        .and_then(|section| section.split("__TARGET_END__").next())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string);

    Ok(FileProperties {
        path: path.to_string(),
        file_type: fields[8].trim().to_string(),
        size_bytes,
        size_human: human_size(size_bytes),
        disk_usage_human,
        owner: fields[1].trim().to_string(),
        group: fields[2].trim().to_string(),
        mode: fields[3].trim().to_string(),
        modified: fields[4].trim().to_string(),
        accessed: fields[5].trim().to_string(),
        inode: fields[6].trim().parse().unwrap_or(0),
        links: fields[7].trim().parse().unwrap_or(0),
        target,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_human_sizes() {
        assert_eq!(parse_human_size("4.0K"), 4096);
        assert_eq!(parse_human_size("1.5M"), 1_572_864);
        assert_eq!(parse_human_size("1.2G"), 1_288_490_189);
        assert_eq!(parse_human_size("0"), 0);
        assert_eq!(parse_human_size("512"), 512);
    }

    #[test]
    fn formats_human_sizes() {
        assert_eq!(human_size(0), "0 B");
        assert_eq!(human_size(512), "512 B");
        assert_eq!(human_size(4096), "4.0K");
        assert_eq!(human_size(1_572_864), "1.5M");
    }

    #[test]
    fn parses_du_output() {
        let files = parse_large_files("1.2G\t/var/log/huge.log\n512M\t/srv/app/data.bin\n");
        assert_eq!(files.len(), 2);
        assert_eq!(files[0].path, "/var/log/huge.log");
        assert_eq!(files[0].size_human, "1.2G");
        assert!(files[0].size_bytes > 1_000_000_000);
        assert_eq!(files[1].size_bytes, 512 * 1024 * 1024);
    }

    #[test]
    fn parses_file_properties() {
        let output = "__STAT__2048|root|www-data|640|2026-10-28 09:17:03 +0000|2026-10-28 09:18:00 +0000|123456|1|regular file\n__RC__0\n__DU__\n8.0K\n__TARGET__\n__TARGET_END__\n";
        let props = parse_properties("/var/log/app.log", output).unwrap();
        assert_eq!(props.size_bytes, 2048);
        assert_eq!(props.size_human, "2.0K");
        assert_eq!(props.disk_usage_human, "8.0K");
        assert_eq!(props.owner, "root");
        assert_eq!(props.group, "www-data");
        assert_eq!(props.mode, "640");
        assert_eq!(props.inode, 123456);
        assert_eq!(props.links, 1);
        assert_eq!(props.file_type, "regular file");
        assert!(props.target.is_none());
    }

    #[test]
    fn rejects_unsafe_paths() {
        assert!(validate_path("/var/log/app.log").is_ok());
        assert!(validate_path("relative/path").is_err());
        assert!(validate_path("/").is_err());
        assert!(validate_path("/var/../etc/passwd").is_err());
        assert!(validate_path("/var/log/a\nb").is_err());
        assert!(validate_deletable_path("/proc/1/mem").is_err());
        assert!(validate_deletable_path("/var/log/app.log").is_ok());
    }

    #[test]
    fn missing_stat_is_reported() {
        let output = "__STAT__stat: cannot statx '/nope': No such file or directory\n__RC__1\n__DU__\n__TARGET__\n__TARGET_END__\n";
        let error = parse_properties("/nope", output).unwrap_err();
        assert!(error.to_string().contains("does not exist"));
    }
}
