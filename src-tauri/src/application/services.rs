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
    if profile.username == "root" {
        command.to_string()
    } else if profile.elevated {
        format!("sudo -n {command}")
    } else {
        command.to_string()
    }
}

pub(crate) fn elevation_preamble(profile: &ConnectionProfile) -> String {
    let pass_env = if let Some(ref pass) = profile.password {
        format!("SUDO_PASS={}\nexport SUDO_PASS\n", shell_quote(pass))
    } else {
        String::new()
    };
    let is_elevated = if profile.elevated { "1" } else { "0" };
    format!(
        r#"{pass_env}IS_ELEVATED={is_elevated}
run_elevated() {{
  if [ "$(id -u)" -eq 0 ]; then
    "$@"
    return $?
  fi
  if command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
    sudo -n "$@"
    return $?
  fi
  if [ -n "$SUDO_PASS" ] && command -v sudo >/dev/null 2>&1; then
    out=$(printf '%s\n' "$SUDO_PASS" | sudo -S -p '' "$@" 2>&1)
    rc=$?
    if [ $rc -eq 0 ]; then
      [ -n "$out" ] && printf '%s\n' "$out"
      return 0
    fi
  fi
  if [ "$IS_ELEVATED" = "1" ] && command -v sudo >/dev/null 2>&1; then
    sudo -n "$@"
    return $?
  fi
  "$@"
  return $?
}}
"#
    )
}

pub fn as_root(profile: &ConnectionProfile, script: &str) -> String {
    if profile.username == "root" {
        return script.to_string();
    }
    let pass_env = if let Some(ref pass) = profile.password {
        format!("SUDO_PASS={}\nexport SUDO_PASS\n", shell_quote(pass))
    } else {
        String::new()
    };
    let is_elevated = if profile.elevated { "1" } else { "0" };
    format!(
        r#"{pass_env}IS_ELEVATED={is_elevated}
if [ "$(id -u)" -eq 0 ]; then
  sh -c {quoted}
elif command -v sudo >/dev/null 2>&1 && sudo -n true 2>/dev/null; then
  sudo -n sh -c {quoted}
elif [ -n "$SUDO_PASS" ] && command -v sudo >/dev/null 2>&1; then
  printf '%s\n' "$SUDO_PASS" | sudo -S -p '' sh -c {quoted}
elif [ "$IS_ELEVATED" = "1" ] && command -v sudo >/dev/null 2>&1; then
  sudo -n sh -c {quoted}
else
  sh -c {quoted}
fi"#,
        pass_env = pass_env,
        is_elevated = is_elevated,
        quoted = shell_quote(script)
    )
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
        let preamble = elevation_preamble(profile);
        let script = format!(
            r#"{preamble}
export LC_ALL=C 2>/dev/null
command -v {binary} >/dev/null 2>&1 && echo "__INSTALLED__1" || echo "__INSTALLED__0"
state=$(run_elevated systemctl is-active {unit} 2>/dev/null || true)
[ -z "$state" ] && {{ pgrep -x {binary} >/dev/null 2>&1 && state=active || state=inactive; }}
echo "__STATE__$state"
pid=$(pgrep -x {binary} 2>/dev/null | head -n1)
echo "__PID__$pid"
echo "__DETAIL__"
run_elevated systemctl status {unit} --no-pager -n 4 2>&1 | head -n 8
exit 0"#,
            preamble = preamble,
            binary = spec.binary,
            unit = spec.unit
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
        let preamble = elevation_preamble(profile);
        let script = format!(
            r#"{preamble}
rc=1
if command -v systemctl >/dev/null 2>&1; then
  run_elevated systemctl --no-ask-password {verb} {unit} 2>&1
  rc=$?
fi
if [ $rc -ne 0 ] && ! command -v systemctl >/dev/null 2>&1 && command -v service >/dev/null 2>&1; then
  run_elevated service {unit} {verb} 2>&1
  rc=$?
fi
if [ $rc -ne 0 ] && [ "{verb}" = "reload" ]; then
  run_elevated {fallback} 2>&1
  rc=$?
fi
exit $rc"#,
            preamble = preamble,
            verb = verb,
            unit = spec.unit,
            fallback = spec.reload_fallback
        );

        let output = pools
            .execute_service(&profile.id, &script, Duration::from_secs(45))
            .await?;

        let combined = format!("{}{}", output.stdout, output.stderr);
        let trimmed = combined.trim();

        let output_text = if !output.success() {
            describe_action_failure(trimmed, &profile.username, action.as_str(), spec.name)
        } else if trimmed.is_empty() {
            format!("{} {} completed", spec.name, action.as_str())
        } else {
            trimmed.to_string()
        };

        Ok(ServiceActionResult {
            ok: output.success(),
            action: action.as_str().to_string(),
            output: output_text,
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
        let preamble = elevation_preamble(profile);
        let script = format!(
            r#"{preamble}
if command -v {binary} >/dev/null 2>&1; then
  run_elevated {test} 2>&1
  exit $?
fi
echo "{binary} is not installed" >&2
exit 127"#,
            preamble = preamble,
            binary = spec.binary,
            test = spec.test_command
        );

        let output = pools
            .execute_service(&profile.id, &script, Duration::from_secs(30))
            .await?;

        let combined = format!("{}{}", output.stdout, output.stderr);
        let trimmed = combined.trim();
        let output_text = if !output.success() {
            describe_action_failure(trimmed, &profile.username, "test", spec.name)
        } else if trimmed.is_empty() {
            format!("{} configuration syntax ok", spec.name)
        } else {
            trimmed.to_string()
        };

        Ok(ServiceActionResult {
            ok: output.success(),
            action: "test".to_string(),
            output: output_text,
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
            r#"{find} {root} -maxdepth 5 \( -type f -o -type l \) \
! -name '*.bak' ! -name '*.old' ! -name '*~' ! -name '*.dpkg-*' ! -name '*.save' \
\( -name '*.conf' -o -name '*.vhost' -o -name '*.load' -o -name '*.inc' -o -name '*.snippet' \
-o -path '*/sites-available/*' -o -path '*/sites-enabled/*' -o -path '*/conf.d/*' -o -path '*/conf-available/*' -o -path '*/conf-enabled/*' -o -path '*/snippets/*' \) \
-printf '%p|%s|%TY-%Tm-%Td %TH:%TM|%y\n' 2>/dev/null | sort | head -n {limit}
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
            let mut parts = line.splitn(4, '|');
            let path = parts.next().unwrap_or_default().trim();
            if path.is_empty() {
                continue;
            }
            let size = parts.next().and_then(|v| v.parse().ok()).unwrap_or(0);
            let modified = parts.next().unwrap_or_default().trim().to_string();
            let is_symlink = parts.next().map(|v| v.trim() == "l").unwrap_or(false);
            entries.push(ConfigEntry {
                path: path.to_string(),
                size,
                modified,
                is_symlink,
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
                    "{test_binary} -f {} || {test_binary} -L {} && echo yes || echo no",
                    shell_quote(path),
                    shell_quote(path)
                ),
                Duration::from_secs(10),
            )
            .await?;
        let is_existing = exists.stdout.trim() == "yes";

        if is_existing {
            assert_canonical(pools, profile, service, path).await?;
        } else {
            let parent = std::path::Path::new(path)
                .parent()
                .and_then(|p| p.to_str())
                .unwrap_or(spec.config_root);
            validate_config_path(service, parent)?;
        }

        let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
        let backup_path = format!("{path}.2shell-{timestamp}.bak");
        let staged_path = format!("{path}.2shell-staged-{timestamp}");
        let encoded = base64::Engine::encode(
            &base64::engine::general_purpose::STANDARD,
            content.as_bytes(),
        );

        let config_root = spec.config_root;
        let test = spec.test_command;

        // Path-jailed atomic transaction:
        // Enforces canonical boundaries to eliminate reliance on generic sudo whitelist binaries (tee/cp).
        let inner_script = if is_existing {
            format!(
                r#"set -e
dest={path}
backup={backup}
staged={staged}
config_root={config_root}

real_dest=$(readlink -f "$dest" 2>/dev/null || realpath -m "$dest" 2>/dev/null)
case "$real_dest" in
  "$config_root"/*) ;;
  *) echo "Security error: target '$dest' resolves outside root '$config_root'" >&2; exit 2 ;;
esac

# Stage content to temp file inside config directory
printf '%s' {encoded} | base64 -d > "$staged" || exit 1
chmod 644 "$staged" 2>/dev/null || true

# Backup current file
cat -- "$dest" > "$backup" 2>/dev/null || true

# Atomically replace target and test syntax
mv -f -- "$staged" "$dest" || exit 1
if {test} 2>&1; then
  exit 0
else
  rc=$?
  cat -- "$backup" > "$dest" 2>/dev/null || true
  echo "--- configuration restored from backup ---"
  exit $rc
fi"#,
                path = shell_quote(path),
                backup = shell_quote(&backup_path),
                staged = shell_quote(&staged_path),
                config_root = shell_quote(config_root),
                encoded = shell_quote(&encoded),
                test = test
            )
        } else {
            format!(
                r#"set -e
dest={path}
staged={staged}
config_root={config_root}

dir=$(dirname -- "$dest")
real_dir=$(readlink -f "$dir" 2>/dev/null || realpath -m "$dir" 2>/dev/null)
case "$real_dir" in
  "$config_root"|"$config_root"/*) ;;
  *) echo "Security error: destination '$dir' outside root '$config_root'" >&2; exit 2 ;;
esac

mkdir -p -- "$dir" || exit 1
printf '%s' {encoded} | base64 -d > "$staged" || exit 1
chmod 644 "$staged" 2>/dev/null || true

mv -f -- "$staged" "$dest" || exit 1
if {test} 2>&1; then
  exit 0
else
  rc=$?
  rm -f -- "$dest"
  echo "--- new configuration failed syntax test, file removed ---"
  exit $rc
fi"#,
                path = shell_quote(path),
                staged = shell_quote(&staged_path),
                config_root = shell_quote(config_root),
                encoded = shell_quote(&encoded),
                test = test
            )
        };

        let write_script = as_root(profile, &inner_script);

        let output = pools
            .execute_service(&profile.id, &write_script, Duration::from_secs(45))
            .await?;

        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        let restored = combined.contains("configuration restored from backup")
            || combined.contains("failed syntax test, file removed");

        Ok(ServiceActionResult {
            ok: output.success() && !restored,
            action: if is_existing {
                "write-config".to_string()
            } else {
                "create-config".to_string()
            },
            output: if combined.is_empty() {
                "configuration saved and validated".to_string()
            } else {
                combined
            },
            exit_code: output.exit_status,
            backup_path: if is_existing && !restored {
                Some(backup_path)
            } else {
                None
            },
        })
    }

    pub async fn dirs_list(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        service: WebService,
    ) -> AppResult<Vec<String>> {
        let spec = service.spec();
        let find = maybe_sudo(profile, "find");
        let script = format!(
            r#"{find} {root} -mindepth 1 -maxdepth 3 -type d 2>/dev/null | sort
exit 0"#,
            find = find,
            root = shell_quote(spec.config_root),
        );
        let output = pools
            .execute_service(&profile.id, &script, Duration::from_secs(15))
            .await?;

        let mut dirs: Vec<String> = output
            .stdout
            .lines()
            .map(|l| l.trim().to_string())
            .filter(|l| !l.is_empty())
            .collect();

        let standard_subdirs = match service {
            WebService::Nginx => vec!["conf.d", "sites-available", "sites-enabled", "snippets"],
            WebService::Apache2 => vec![
                "sites-available",
                "sites-enabled",
                "conf-available",
                "conf-enabled",
                "mods-available",
                "mods-enabled",
            ],
            WebService::Httpd => vec!["conf", "conf.d", "conf.modules.d"],
        };
        for sub in standard_subdirs {
            let full = format!("{}/{}", spec.config_root.trim_end_matches('/'), sub);
            if !dirs.contains(&full) {
                dirs.push(full);
            }
        }
        dirs.sort();
        Ok(dirs)
    }

    pub async fn config_delete(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        service: WebService,
        path: &str,
    ) -> AppResult<ServiceActionResult> {
        validate_config_path(service, path)?;
        let spec = service.spec();
        if path == spec.config_file {
            return Err(AppError::Validation(format!(
                "cannot delete primary configuration file '{path}'"
            )));
        }

        let timestamp = chrono::Utc::now().format("%Y%m%d%H%M%S");
        let backup_path = format!("{path}.2shell-{timestamp}.delbak");
        let config_root = spec.config_root;
        let test = spec.test_command;

        let inner_script = format!(
            r#"set -e
dest={path}
backup={backup}
config_root={config_root}

real_dest=$(readlink -f "$dest" 2>/dev/null || realpath -m "$dest" 2>/dev/null)
case "$real_dest" in
  "$config_root"/*) ;;
  *) echo "Security error: target '$dest' resolves outside root '$config_root'" >&2; exit 2 ;;
esac

cat -- "$dest" > "$backup" 2>/dev/null || true
rm -f -- "$dest" || exit 1
if {test} 2>&1; then
  rm -f -- "$backup"
  exit 0
else
  rc=$?
  cat -- "$backup" > "$dest" 2>/dev/null || true
  echo "--- deletion aborted: syntax test failed, configuration restored ---"
  exit $rc
fi"#,
            path = shell_quote(path),
            backup = shell_quote(&backup_path),
            config_root = shell_quote(config_root),
            test = test
        );

        let script = as_root(profile, &inner_script);

        let output = pools
            .execute_service(&profile.id, &script, Duration::from_secs(30))
            .await?;

        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        let restored = combined.contains("deletion aborted");

        Ok(ServiceActionResult {
            ok: output.success() && !restored,
            action: "delete-config".to_string(),
            output: if combined.is_empty() {
                "file deleted and service configuration validated".to_string()
            } else {
                combined
            },
            exit_code: output.exit_status,
            backup_path: None,
        })
    }

    pub async fn config_toggle_site(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        service: WebService,
        site_name: &str,
        enable: bool,
    ) -> AppResult<ServiceActionResult> {
        let spec = service.spec();
        if service != WebService::Nginx && service != WebService::Apache2 {
            return Err(AppError::Validation(
                "site enabling via symlinks is only supported for Nginx and Apache2".into(),
            ));
        }
        if site_name.contains('/') || site_name.contains("..") || site_name.trim().is_empty() {
            return Err(AppError::Validation("invalid site name".into()));
        }

        let root = spec.config_root.trim_end_matches('/');
        let available = format!("{root}/sites-available/{site_name}");
        let enabled = format!("{root}/sites-enabled/{site_name}");
        let test = spec.test_command;

        let inner_script = if enable {
            format!(
                r#"set -e
root={root}
available={available}
enabled={enabled}

real_available=$(readlink -f "$available" 2>/dev/null || realpath -m "$available" 2>/dev/null)
case "$real_available" in
  "$root"/sites-available/*) ;;
  *) echo "Security error: available site path outside authorized sites-available directory" >&2; exit 2 ;;
esac

mkdir -p "$root/sites-enabled" || exit 1
if [ ! -f "$available" ] && [ ! -L "$available" ]; then
  echo "site file not found in sites-available"
  exit 1
fi
ln -sf "$available" "$enabled" || exit 1
if {test} 2>&1; then
  exit 0
else
  rc=$?
  rm -f "$enabled"
  echo "--- site enablement failed syntax test, symlink removed ---"
  exit $rc
fi"#,
                root = shell_quote(root),
                available = shell_quote(&available),
                enabled = shell_quote(&enabled),
                test = test
            )
        } else {
            format!(
                r#"set -e
root={root}
available={available}
enabled={enabled}

real_enabled=$(readlink -f "$enabled" 2>/dev/null || realpath -m "$enabled" 2>/dev/null)
case "$real_enabled" in
  "$root"/sites-enabled/*) ;;
  *) echo "Security error: enabled site path outside authorized sites-enabled directory" >&2; exit 2 ;;
esac

if [ -L "$enabled" ] || [ -f "$enabled" ]; then
  rm -f "$enabled" || exit 1
  if {test} 2>&1; then
    exit 0
  else
    rc=$?
    ln -sf "$available" "$enabled" 2>/dev/null || true
    echo "--- disabling site broke configuration, symlink restored ---"
    exit $rc
  fi
else
  echo "site is not enabled"
  exit 0
fi"#,
                root = shell_quote(root),
                enabled = shell_quote(&enabled),
                available = shell_quote(&available),
                test = test
            )
        };

        let script = as_root(profile, &inner_script);

        let output = pools
            .execute_service(&profile.id, &script, Duration::from_secs(30))
            .await?;

        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();

        Ok(ServiceActionResult {
            ok: output.success(),
            action: if enable {
                "enable-site".to_string()
            } else {
                "disable-site".to_string()
            },
            output: if combined.is_empty() {
                if enable {
                    "site enabled and configuration validated".to_string()
                } else {
                    "site disabled and configuration validated".to_string()
                }
            } else {
                combined
            },
            exit_code: output.exit_status,
            backup_path: None,
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

fn describe_action_failure(
    detail: &str,
    username: &str,
    action: &str,
    service_name: &str,
) -> String {
    let trimmed = detail.trim();
    if trimmed.contains("Interactive authentication required") {
        format!(
            "Error de permisos interactivos (PolicyKit): la acción '{action}' en el servicio '{service_name}' fue bloqueada porque la sesión SSH no es interactiva y el usuario '{username}' no posee privilegios de superusuario directos.\n\n\
            Diagnóstico del sistema:\n{trimmed}\n\n\
            Solución recomendada:\n\
            1. En el servidor remoto, otorga permisos sudo sin contraseña para el usuario '{username}':\n\
               echo \"{username} ALL=(ALL) NOPASSWD: /bin/systemctl, /usr/bin/systemctl, /sbin/service, /usr/sbin/service\" | sudo tee /etc/sudoers.d/2shell-services\n\
            2. O bien inicia sesión como 'root' o activa la opción 'Use sudo -n' en la configuración del perfil si el usuario ya dispone de permisos sudo."
        )
    } else if trimmed.contains("password is required")
        || trimmed.contains("no tty present and no askpass program specified")
    {
        format!(
            "Error de sudo: la ejecución de '{action}' en '{service_name}' requiere contraseña interactiva para el usuario '{username}'.\n\n\
            Salida del sistema:\n{trimmed}\n\n\
            Solución:\n\
            • Configura una regla NOPASSWD en sudoers para los comandos de servicio o verifica la contraseña configurada en el perfil."
        )
    } else if trimmed.contains("Permission denied") || trimmed.contains("Access denied") {
        format!(
            "Permiso denegado al ejecutar '{action}' en '{service_name}'. Se requieren privilegios de administrador (root/sudo).\n\nSalida del sistema:\n{trimmed}"
        )
    } else if trimmed.is_empty() {
        format!(
            "{service_name} {action} falló sin salida en la consola. Consulta los registros con journalctl -u {service_name}.service"
        )
    } else {
        trimmed.to_string()
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
    fn action_failures_handle_interactive_auth_and_sudo() {
        let failure = describe_action_failure(
            "Failed to restart httpd.service: Interactive authentication required.",
            "cardiorientecom",
            "restart",
            "httpd",
        );
        assert!(failure.contains("PolicyKit"));
        assert!(failure.contains("NOPASSWD"));
        assert!(failure.contains("cardiorientecom"));

        let sudo_fail = describe_action_failure(
            "sudo: a password is required",
            "ubuntu",
            "restart",
            "nginx",
        );
        assert!(sudo_fail.contains("requiere contraseña interactiva"));
        assert!(sudo_fail.contains("ubuntu"));
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
