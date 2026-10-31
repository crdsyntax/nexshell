use crate::application::pool::PoolManager;
use crate::error::{AppError, AppResult};
use crate::models::{
    ConfigContent, ConfigEntry, ConnectionProfile, ServiceActionResult, ServiceStatus,
    WebServiceInfo,
};
use std::time::Duration;

const MAX_CONFIG_BYTES: usize = 1024 * 1024;
const MAX_CONFIG_LIST: usize = 300;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WebService {
    Nginx,
    Apache2,
    Httpd,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ServiceAction {
    Start,
    Stop,
    Restart,
    Reload,
    Test,
}

impl ServiceAction {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value.trim().to_lowercase().as_str() {
            "start" => Ok(Self::Start),
            "stop" => Ok(Self::Stop),
            "restart" => Ok(Self::Restart),
            "reload" => Ok(Self::Reload),
            "test" => Ok(Self::Test),
            other => Err(AppError::Validation(format!(
                "unsupported service action '{other}'"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Reload => "reload",
            Self::Test => "test",
        }
    }
}

struct ServiceSpec {
    name: &'static str,
    binary: &'static str,
    unit: &'static str,
    config_root: &'static str,
    config_file: &'static str,
    log_file: &'static str,
    test_command: &'static str,
    reload_fallback: &'static str,
}

impl WebService {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value.trim().to_lowercase().as_str() {
            "nginx" => Ok(Self::Nginx),
            "apache2" => Ok(Self::Apache2),
            "httpd" => Ok(Self::Httpd),
            other => Err(AppError::Validation(format!(
                "unsupported web service '{other}' (expected nginx, apache2 or httpd)"
            ))),
        }
    }

    fn spec(self) -> ServiceSpec {
        match self {
            Self::Nginx => ServiceSpec {
                name: "nginx",
                binary: "nginx",
                unit: "nginx",
                config_root: "/etc/nginx",
                config_file: "/etc/nginx/nginx.conf",
                log_file: "/var/log/nginx/error.log",
                test_command: "nginx -t",
                reload_fallback: "nginx -s reload",
            },
            Self::Apache2 => ServiceSpec {
                name: "apache2",
                binary: "apache2",
                unit: "apache2",
                config_root: "/etc/apache2",
                config_file: "/etc/apache2/apache2.conf",
                log_file: "/var/log/apache2/error.log",
                test_command: "apache2ctl configtest",
                reload_fallback: "apache2ctl graceful",
            },
            Self::Httpd => ServiceSpec {
                name: "httpd",
                binary: "httpd",
                unit: "httpd",
                config_root: "/etc/httpd",
                config_file: "/etc/httpd/conf/httpd.conf",
                log_file: "/var/log/httpd/error_log",
                test_command: "httpd -t",
                reload_fallback: "httpd -k graceful",
            },
        }
    }

    fn info(
        self,
        installed: bool,
        binary: String,
        version: String,
        active: bool,
    ) -> WebServiceInfo {
        let spec = self.spec();
        WebServiceInfo {
            name: spec.name.to_string(),
            installed,
            binary,
            version,
            active,
            service_unit: spec.unit.to_string(),
            config_root: spec.config_root.to_string(),
            config_file: spec.config_file.to_string(),
            log_file: spec.log_file.to_string(),
        }
    }
}

pub fn shell_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

pub(crate) fn maybe_sudo(profile: &ConnectionProfile, command: &str) -> String {
    if profile.elevated {
        format!("sudo -n {command}")
    } else {
        command.to_string()
    }
}

pub struct ServiceManager;

impl ServiceManager {
    pub async fn detect(
        pools: &PoolManager,
        profile: &ConnectionProfile,
    ) -> AppResult<Vec<WebServiceInfo>> {
        let script = r#"export LC_ALL=C 2>/dev/null
for s in nginx apache2 httpd; do
  b=$(command -v "$s" 2>/dev/null)
  if [ -n "$b" ]; then
    inst=1
    case "$s" in
      nginx) v=$(nginx -v 2>&1 | head -n1) ;;
      apache2) v=$(apache2 -v 2>&1 | head -n1) ;;
      httpd) v=$(httpd -v 2>&1 | head -n1) ;;
    esac
    a=$(systemctl is-active "$s" 2>/dev/null || echo unknown)
  else
    inst=0; v=""; a="unknown"
  fi
  echo "SERVICE|$s|$inst|$b|$v|$a"
done
exit 0"#;

        let output = pools
            .execute_service(&profile.id, script, Duration::from_secs(25))
            .await?;

        if output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "service detection returned no output: {}",
                output.stderr.trim()
            )));
        }

        let mut services = Vec::new();
        for line in output.stdout.lines() {
            let Some(rest) = line.trim().strip_prefix("SERVICE|") else {
                continue;
            };
            let mut parts = rest.splitn(5, '|');
            let name = parts.next().unwrap_or_default();
            let installed = parts.next().unwrap_or("0") == "1";
            let binary = parts.next().unwrap_or_default().to_string();
            let version = parts.next().unwrap_or_default().to_string();
            let active = parts.next().unwrap_or("unknown").trim() == "active";
            if let Ok(service) = WebService::parse(name) {
                services.push(service.info(installed, binary, version, active));
            }
        }

        services.sort_by_key(|service| match service.name.as_str() {
            "nginx" => 0,
            "apache2" => 1,
            _ => 2,
        });
        Ok(services)
    }

    pub async fn status(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        service: WebService,
    ) -> AppResult<ServiceStatus> {
        let spec = service.spec();
        let is_active = maybe_sudo(profile, &format!("systemctl is-active {}", spec.unit));
        let status = maybe_sudo(
            profile,
            &format!("systemctl status {} --no-pager -n 4", spec.unit),
        );
        let script = format!(
            r#"export LC_ALL=C 2>/dev/null
command -v {binary} >/dev/null 2>&1 && echo "__INSTALLED__1" || echo "__INSTALLED__0"
state=$({is_active} 2>/dev/null || true)
[ -z "$state" ] && {{ pgrep -x {binary} >/dev/null 2>&1 && state=active || state=inactive; }}
echo "__STATE__$state"
pid=$(pgrep -x {binary} 2>/dev/null | head -n1)
echo "__PID__$pid"
echo "__DETAIL__"
{status} 2>&1 | head -n 8
exit 0"#,
            binary = spec.binary,
            is_active = is_active,
            status = status
        );

        let output = pools
            .execute_silent(&profile.id, &script, Duration::from_secs(20))
            .await?;

        let installed = output
            .stdout
            .lines()
            .any(|line| line.trim() == "__INSTALLED__1");
        let state = output
            .stdout
            .lines()
            .find_map(|line| line.trim().strip_prefix("__STATE__"))
            .unwrap_or("unknown")
            .trim()
            .to_string();
        let pid = output
            .stdout
            .lines()
            .find_map(|line| line.trim().strip_prefix("__PID__"))
            .and_then(|value| value.trim().parse().ok());
        let detail = output
            .stdout
            .split("__DETAIL__")
            .nth(1)
            .unwrap_or_default()
            .trim()
            .to_string();

        Ok(ServiceStatus {
            service: spec.name.to_string(),
            installed,
            active: state == "active",
            state,
            pid,
            detail,
        })
    }

    pub async fn act(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        service: WebService,
        action: ServiceAction,
    ) -> AppResult<ServiceActionResult> {
        let spec = service.spec();

        if action == ServiceAction::Test {
            return Self::test_config(pools, profile, service).await;
        }

        let installed = pools
            .execute_service(
                &profile.id,
                &format!(
                    "command -v {} >/dev/null 2>&1 && echo yes || echo no",
                    spec.binary
                ),
                Duration::from_secs(10),
            )
            .await?;
        if installed.stdout.trim() != "yes" {
            return Err(AppError::Validation(format!(
                "{} is not installed on this host",
                spec.name
            )));
        }

        let verb = action.as_str();
        let systemctl = maybe_sudo(profile, "systemctl");
        let service_cmd = maybe_sudo(profile, "service");
        let fallback = maybe_sudo(profile, spec.reload_fallback);
        let script = format!(
            r#"rc=1
if command -v systemctl >/dev/null 2>&1; then
  {systemctl} {verb} {unit} 2>&1
  rc=$?
fi
if [ $rc -ne 0 ]; then
  {service_cmd} {unit} {verb} 2>&1
  rc=$?
fi
if [ $rc -ne 0 ] && [ "{verb}" = "reload" ]; then
  {fallback} 2>&1
  rc=$?
fi
exit $rc"#,
            systemctl = systemctl,
            service_cmd = service_cmd,
            verb = verb,
            unit = spec.unit,
            fallback = fallback
        );

        let output = pools
            .execute_service(&profile.id, &script, Duration::from_secs(45))
            .await?;

        let combined = format!("{}{}", output.stdout, output.stderr);
        if profile.elevated && combined.contains("a password is required") {
            return Err(AppError::Validation(
                "sudo requires a password. Configure passwordless sudo (NOPASSWD) for the service commands or disable the elevated flag."
                    .into(),
            ));
        }

        Ok(ServiceActionResult {
            ok: output.success(),
            action: action.as_str().to_string(),
            output: if combined.trim().is_empty() {
                format!("{} {} completed", spec.name, action.as_str())
            } else {
                combined.trim().to_string()
            },
            exit_code: output.exit_status,
            backup_path: None,
        })
    }

    pub async fn test_config(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        service: WebService,
    ) -> AppResult<ServiceActionResult> {
        let spec = service.spec();
        let test = maybe_sudo(profile, spec.test_command);
        let script = format!(
            r#"if command -v {binary} >/dev/null 2>&1; then
  {test} 2>&1
  exit $?
fi
echo "{binary} is not installed" >&2
exit 127"#,
            binary = spec.binary,
            test = test
        );

        let output = pools
            .execute_service(&profile.id, &script, Duration::from_secs(30))
            .await?;

        Ok(ServiceActionResult {
            ok: output.success(),
            action: "test".to_string(),
            output: format!("{}{}", output.stdout, output.stderr)
                .trim()
                .to_string(),
            exit_code: output.exit_status,
            backup_path: None,
        })
    }

    pub async fn config_list(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        service: WebService,
    ) -> AppResult<Vec<ConfigEntry>> {
        let spec = service.spec();
        let find = maybe_sudo(profile, "find");
        let script = format!(
            r#"{find} {root} -maxdepth 5 \( -type f -o -type l \) \( -name '*.conf' -o -name '*.vhost' -o -name '*.load' -o -name '*.inc' \) -printf '%p|%s|%TY-%Tm-%Td %TH:%TM\n' 2>/dev/null | sort | head -n {limit}
exit 0"#,
            find = find,
            root = shell_quote(spec.config_root),
            limit = MAX_CONFIG_LIST
        );

        let output = pools
            .execute_service(&profile.id, &script, Duration::from_secs(25))
            .await?;

        let mut entries = Vec::new();
        for line in output.stdout.lines() {
            let mut parts = line.splitn(3, '|');
            let path = parts.next().unwrap_or_default().trim();
            if path.is_empty() {
                continue;
            }
            entries.push(ConfigEntry {
                path: path.to_string(),
                size: parts.next().and_then(|v| v.parse().ok()).unwrap_or(0),
                modified: parts.next().unwrap_or_default().trim().to_string(),
            });
        }
        Ok(entries)
    }

    pub async fn config_read(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        service: WebService,
        path: &str,
    ) -> AppResult<ConfigContent> {
        validate_config_path(service, path)?;
        assert_canonical(pools, profile, service, path).await?;
        let script = maybe_sudo(profile, &format!("cat -- {}", shell_quote(path)));
        let output = pools
            .execute_service(&profile.id, &script, Duration::from_secs(20))
            .await?;

        if !output.success() {
            let detail = if !output.stderr.trim().is_empty() {
                output.stderr.trim().to_string()
            } else if output.exit_status < 0 && !output.stdout.trim().is_empty() {
                "the SSH server returned file content without an exit status".to_string()
            } else {
                output.stdout.trim().to_string()
            };
            let detail = truncate_error_detail(&detail, 2_000);
            return Err(AppError::Remote(format!(
                "cannot read {path}: {}",
                describe_read_failure(&detail)
            )));
        }

        let (content, truncated) = if output.stdout.len() > MAX_CONFIG_BYTES {
            (output.stdout[..MAX_CONFIG_BYTES].to_string(), true)
        } else {
            (output.stdout, false)
        };

        Ok(ConfigContent {
            path: path.to_string(),
            content,
            truncated,
        })
    }

    pub async fn config_write(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        service: WebService,
        path: &str,
        content: &str,
    ) -> AppResult<ServiceActionResult> {
        validate_config_path(service, path)?;
        if content.len() > MAX_CONFIG_BYTES {
            return Err(AppError::Validation(
                "configuration content exceeds 1 MiB".into(),
            ));
        }

        let spec = service.spec();
        let test_binary = maybe_sudo(profile, "test");
        let exists = pools
            .execute_service(
                &profile.id,
                &format!(
                    "{test_binary} -f {} && echo yes || echo no",
                    shell_quote(path)
                ),
                Duration::from_secs(10),
            )
            .await?;
        if exists.stdout.trim() != "yes" {
            return Err(AppError::NotFound(format!(
                "configuration file {path} does not exist"
            )));
        }

        assert_canonical(pools, profile, service, path).await?;

        let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
        let backup_path = format!("{path}.2shell-{timestamp}.bak");
        let encoded = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            content.as_bytes(),
        );

        let cp = maybe_sudo(profile, "cp");
        let tee = maybe_sudo(profile, "tee");
        let test = maybe_sudo(profile, spec.test_command);
        let write_script = format!(
            r#"{cp} -p -- {path} {backup} || exit 1
printf '%s' {encoded} | base64 -d | {tee} {path} >/dev/null || {{ {cp} -p -- {backup} {path}; exit 1; }}
{test} 2>&1
rc=$?
if [ $rc -ne 0 ]; then
  {cp} -p -- {backup} {path}
  echo "--- configuration restored from backup ---"
fi
exit $rc"#,
            cp = cp,
            tee = tee,
            path = shell_quote(path),
            backup = shell_quote(&backup_path),
            encoded = shell_quote(&encoded),
            test = test
        );

        let output = pools
            .execute_service(&profile.id, &write_script, Duration::from_secs(45))
            .await?;

        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        let restored = combined.contains("configuration restored from backup");

        Ok(ServiceActionResult {
            ok: output.success(),
            action: "write-config".to_string(),
            output: if combined.is_empty() {
                "configuration saved and validated".to_string()
            } else {
                combined
            },
            exit_code: output.exit_status,
            backup_path: if restored { None } else { Some(backup_path) },
        })
    }

    pub async fn logs(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        service: WebService,
        lines: u32,
    ) -> AppResult<String> {
        let spec = service.spec();
        let count = lines.clamp(20, 2_000);
        let tail = maybe_sudo(profile, "tail");
        let journalctl = maybe_sudo(profile, "journalctl");
        let script = format!(
            r#"if [ -f {log} ]; then
  {tail} -n {count} {log} 2>&1
else
  {journalctl} -u {unit} -n {count} --no-pager 2>&1
fi
exit 0"#,
            log = shell_quote(spec.log_file),
            unit = spec.unit,
            count = count,
            tail = tail,
            journalctl = journalctl
        );

        let output = pools
            .execute_service(&profile.id, &script, Duration::from_secs(25))
            .await?;
        Ok(output.stdout)
    }
}

async fn assert_canonical(
    pools: &PoolManager,
    profile: &ConnectionProfile,
    service: WebService,
    path: &str,
) -> AppResult<()> {
    let spec = service.spec();
    let root_prefix = format!("{}/", spec.config_root.trim_end_matches('/'));
    let command = maybe_sudo(profile, &format!("readlink -f -- {}", shell_quote(path)));
    let output = pools
        .execute_service(&profile.id, &command, Duration::from_secs(8))
        .await?;
    if !output.success() {
        let detail = if !output.stderr.trim().is_empty() {
            output.stderr.trim().to_string()
        } else {
            output.stdout.trim().to_string()
        };
        return Err(AppError::Remote(format!(
            "cannot resolve configuration path {path}: {detail}"
        )));
    }
    let resolved = output.stdout.trim();
    if resolved.is_empty() {
        return Err(AppError::Remote(format!(
            "cannot resolve configuration path {path}"
        )));
    }
    if !resolved.starts_with(&root_prefix) {
        return Err(AppError::Validation(format!(
            "{path} resolves outside {} (to {resolved})",
            spec.config_root
        )));
    }
    Ok(())
}

fn truncate_error_detail(detail: &str, max_chars: usize) -> String {
    if detail.chars().count() <= max_chars {
        return detail.to_string();
    }
    let mut truncated: String = detail.chars().take(max_chars).collect();
    truncated.push_str("… [truncated]");
    truncated
}

fn describe_read_failure(detail: &str) -> String {
    if detail.contains("Permission denied") {
        "permission denied — enable the elevated (sudo -n) profile option or make the file readable by the SSH user".to_string()
    } else if detail.contains("password is required") {
        "sudo requires a password — configure passwordless sudo (NOPASSWD) for the SSH user or disable the elevated option".to_string()
    } else if detail.is_empty() {
        "the remote command returned no details; check the file permissions and the SSH user"
            .to_string()
    } else {
        detail.to_string()
    }
}

fn validate_config_path(service: WebService, path: &str) -> AppResult<()> {
    let spec = service.spec();
    if path.trim().is_empty() {
        return Err(AppError::Validation("config path is required".into()));
    }
    if path.chars().any(|c| c == '\0' || c == '\n' || c == '\r') {
        return Err(AppError::Validation(
            "config path contains control characters".into(),
        ));
    }
    if path.split('/').any(|segment| segment == "..") {
        return Err(AppError::Validation(
            "config path traversal is not allowed".into(),
        ));
    }
    let root_prefix = format!("{}/", spec.config_root.trim_end_matches('/'));
    if !path.starts_with(&root_prefix) {
        return Err(AppError::Validation(format!(
            "config path must stay inside {} for {}",
            spec.config_root, spec.name
        )));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shell_quote_escapes_single_quotes() {
        assert_eq!(shell_quote("plain"), "'plain'");
        assert_eq!(shell_quote("a'b"), "'a'\\''b'");
    }

    #[test]
    fn config_paths_are_confined_to_service_root() {
        assert!(validate_config_path(WebService::Nginx, "/etc/nginx/nginx.conf").is_ok());
        assert!(validate_config_path(WebService::Nginx, "/etc/nginx/sites-enabled/a.conf").is_ok());
        assert!(validate_config_path(WebService::Nginx, "/etc/passwd").is_err());
        assert!(validate_config_path(WebService::Nginx, "/etc/nginx/../passwd").is_err());
        assert!(validate_config_path(WebService::Nginx, "/etc/nginxx/a.conf").is_err());
        assert!(validate_config_path(WebService::Apache2, "/etc/nginx/nginx.conf").is_err());
        assert!(validate_config_path(WebService::Nginx, "/etc/nginx/a\n.conf").is_err());
    }

    #[test]
    fn read_failures_are_actionable() {
        assert!(
            describe_read_failure("cat: /etc/nginx/a.conf: Permission denied").contains("elevated")
        );
        assert!(describe_read_failure("sudo: a password is required").contains("NOPASSWD"));
        assert!(describe_read_failure("").contains("no details"));
        assert_eq!(
            describe_read_failure("cat: /etc/nginx/a.conf: No such file or directory"),
            "cat: /etc/nginx/a.conf: No such file or directory"
        );
    }

    #[test]
    fn service_aliases_parse() {
        assert_eq!(WebService::parse("NGINX").unwrap(), WebService::Nginx);
        assert_eq!(WebService::parse("apache2").unwrap(), WebService::Apache2);
        assert_eq!(WebService::parse("httpd").unwrap(), WebService::Httpd);
        assert!(WebService::parse("caddy").is_err());
        assert_eq!(ServiceAction::parse("TEST").unwrap(), ServiceAction::Test);
        assert!(ServiceAction::parse("delete").is_err());
    }
}
