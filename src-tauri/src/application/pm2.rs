use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, Pm2Logs, Pm2Process, Pm2Report};
use serde_json::Value;
use std::time::Duration;

const PM2_TIMEOUT: Duration = Duration::from_secs(30);
const MAX_LOG_BYTES: usize = 60_000;

const PM2_PRELUDE: &str = r####"PM2=$(command -v pm2 2>/dev/null || true)
if [ -z "$PM2" ]; then
  for candidate in /usr/local/bin/pm2 /usr/bin/pm2 /root/.local/bin/pm2 /root/.nvm/versions/node/*/bin/pm2 /home/*/.nvm/versions/node/*/bin/pm2; do
    [ -x "$candidate" ] && { PM2=$candidate; break; }
  done
fi
if [ -z "$PM2" ]; then
  echo "__NO_PM2__"
  exit 0
fi
echo "__BIN__$PM2"
"####;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Pm2Action {
    Start,
    Stop,
    Restart,
    Reload,
    Delete,
}

impl Pm2Action {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value.trim().to_lowercase().as_str() {
            "start" => Ok(Self::Start),
            "stop" => Ok(Self::Stop),
            "restart" => Ok(Self::Restart),
            "reload" => Ok(Self::Reload),
            "delete" => Ok(Self::Delete),
            other => Err(AppError::Validation(format!(
                "unsupported pm2 action: {other}"
            ))),
        }
    }

    fn verb(self) -> &'static str {
        match self {
            Self::Start => "start",
            Self::Stop => "stop",
            Self::Restart => "restart",
            Self::Reload => "reload",
            Self::Delete => "delete",
        }
    }
}

pub struct Pm2Manager;

impl Pm2Manager {
    pub async fn list(pools: &PoolManager, profile: &ConnectionProfile) -> AppResult<Pm2Report> {
        let script = format!("{PM2_PRELUDE}\n\"$PM2\" jlist 2>/dev/null\nexit 0\n");
        let output = pools
            .execute_with_category(&profile.id, &as_root(profile, &script), PM2_TIMEOUT, "pm2")
            .await?;
        let raw = output.stdout;
        if raw.contains("__NO_PM2__") {
            return Ok(Pm2Report {
                available: false,
                binary: String::new(),
                processes: Vec::new(),
            });
        }

        let start = raw.find('[');
        let end = raw.rfind(']');
        let processes = match (start, end) {
            (Some(start), Some(end)) if end > start => {
                let slice = &raw[start..=end];
                serde_json::from_str::<Vec<Value>>(slice)
                    .map(|items| items.iter().filter_map(parse_process).collect())
                    .unwrap_or_default()
            }
            _ => Vec::new(),
        };

        Ok(Pm2Report {
            available: true,
            binary: pm2_binary(&raw),
            processes,
        })
    }

    pub async fn action(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        id: u32,
        action: Pm2Action,
    ) -> AppResult<String> {
        let verb = action.verb();
        let script = format!(
            r####"{prelude}
"$PM2" {verb} "{id}" 2>&1
echo "__DONE__"
"####,
            prelude = PM2_PRELUDE,
            verb = verb,
            id = id
        );
        let output = pools
            .execute_sensitive(&profile.id, &as_root(profile, &script), PM2_TIMEOUT)
            .await?;
        let combined = format!("{}{}", output.stdout, output.stderr)
            .replace("__DONE__", "")
            .trim()
            .to_string();
        if !output.success() {
            return Err(AppError::Remote(format!(
                "pm2 {verb} {id} failed: {combined}"
            )));
        }
        Ok(truncate(combined, 4000))
    }

    pub async fn logs(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        id: u32,
        lines: u32,
    ) -> AppResult<Pm2Logs> {
        let report = Self::list(pools, profile).await?;
        if !report.available {
            return Err(AppError::Validation(
                "pm2 is not installed on this host".into(),
            ));
        }
        let process = report
            .processes
            .iter()
            .find(|process| process.id == i64::from(id))
            .ok_or_else(|| AppError::Validation(format!("pm2 process {id} not found")))?;

        let out_path = process.out_log.clone();
        let err_path = process.err_log.clone();
        for path in [&out_path, &err_path] {
            if !path.is_empty() {
                validate_log_path(path)?;
            }
        }
        let limit = lines.clamp(20, 5000);

        let script = format!(
            r####"export LC_ALL=C
out={out}
err={err}
echo "__OUT__"
if [ -z "$out" ]; then
  echo "(no out log configured)"
elif [ -L "$out" ]; then
  echo "(refusing to read symlink: $out)"
elif [ ! -f "$out" ]; then
  echo "(log file not found: $out)"
else
  tail -n {limit} "$out" 2>/dev/null | tail -c {max_bytes}
fi
echo
echo "__ERR__"
if [ -z "$err" ]; then
  echo "(no error log configured)"
elif [ -L "$err" ]; then
  echo "(refusing to read symlink: $err)"
elif [ ! -f "$err" ]; then
  echo "(log file not found: $err)"
else
  tail -n {limit} "$err" 2>/dev/null | tail -c {max_bytes}
fi
echo
exit 0
"####,
            out = shell_quote(&out_path),
            err = shell_quote(&err_path),
            limit = limit,
            max_bytes = MAX_LOG_BYTES
        );
        let output = pools
            .execute_with_category(&profile.id, &as_root(profile, &script), PM2_TIMEOUT, "pm2")
            .await?;

        let stdout = output.stdout;
        let (_, rest) = stdout
            .split_once("__OUT__")
            .ok_or_else(|| AppError::Remote("unexpected pm2 log output".into()))?;
        let (out_log, err_log) = rest
            .split_once("__ERR__")
            .ok_or_else(|| AppError::Remote("unexpected pm2 log output".into()))?;

        Ok(Pm2Logs {
            id,
            name: process.name.clone(),
            out_path,
            err_path,
            stdout: out_log.trim_end().to_string(),
            stderr: err_log.trim_end().to_string(),
        })
    }
}

fn parse_process(item: &Value) -> Option<Pm2Process> {
    let env = item.get("pm2_env");
    let id = item
        .get("pm_id")
        .and_then(Value::as_i64)
        .or_else(|| env.and_then(|env| env.get("pm_id")).and_then(Value::as_i64))?;
    let name = item
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let monit = item.get("monit");
    let status = env
        .and_then(|env| env.get("status"))
        .and_then(Value::as_str)
        .unwrap_or("unknown")
        .to_string();
    let pid = item
        .get("pid")
        .and_then(Value::as_i64)
        .filter(|pid| *pid > 0);

    Some(Pm2Process {
        id,
        name,
        namespace: value_str(env, "namespace"),
        status,
        pid,
        uptime_ms: env
            .and_then(|env| env.get("pm_uptime"))
            .and_then(Value::as_i64),
        restarts: env
            .and_then(|env| env.get("restart_time"))
            .and_then(Value::as_i64)
            .unwrap_or(0),
        cpu: monit
            .and_then(|monit| monit.get("cpu"))
            .and_then(Value::as_f64)
            .unwrap_or(0.0),
        memory: monit
            .and_then(|monit| monit.get("memory"))
            .and_then(Value::as_u64)
            .unwrap_or(0),
        mode: value_str(env, "exec_mode"),
        script: value_str(env, "script"),
        cwd: value_str(env, "cwd"),
        version: value_str(env, "version"),
        out_log: value_str(env, "pm_out_log_path"),
        err_log: value_str(env, "pm_err_log_path"),
    })
}

fn value_str(value: Option<&Value>, key: &str) -> String {
    value
        .and_then(|value| value.get(key))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

fn pm2_binary(raw: &str) -> String {
    raw.lines()
        .next()
        .filter(|line| line.starts_with("__BIN__"))
        .map(|line| line.trim_start_matches("__BIN__").trim().to_string())
        .unwrap_or_default()
}

fn validate_log_path(path: &str) -> AppResult<()> {
    let trimmed = path.trim();
    if !trimmed.starts_with('/') || trimmed.contains("..") || trimmed.chars().any(char::is_control)
    {
        return Err(AppError::Validation(format!(
            "unexpected pm2 log path: {path}"
        )));
    }
    let lower = trimmed.to_lowercase();
    if !lower.ends_with(".log") && !trimmed.contains("/.pm2/logs/") {
        return Err(AppError::Validation(format!(
            "pm2 log path must point to a .log file: {path}"
        )));
    }
    for denied in [
        "/etc/",
        "/proc/",
        "/sys/",
        "/dev/",
        "/root/.ssh/",
        "/home/.ssh/",
    ] {
        if lower.starts_with(denied) {
            return Err(AppError::Validation(format!(
                "refusing to read pm2 log from {denied}"
            )));
        }
    }
    Ok(())
}

fn truncate(value: String, max: usize) -> String {
    if value.len() <= max {
        return value;
    }
    let mut end = max;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    format!("{}\n… truncated", &value[..end])
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_pm2_jlist() {
        let raw = r#"[{"name":"felizviaje-web","pm_id":0,"pid":658292,"monit":{"memory":104857600,"cpu":12.5},"pm2_env":{"status":"online","pm_uptime":1793283000000,"restart_time":3,"exec_mode":"fork_mode","script":"/var/www/app/server.js","cwd":"/var/www/app","version":"1.2.3","namespace":"default","pm_out_log_path":"/root/.pm2/logs/felizviaje-web-out.log","pm_err_log_path":"/root/.pm2/logs/felizviaje-web-error.log"}}]"#;
        let items: Vec<Value> = serde_json::from_str(raw).unwrap();
        let process = parse_process(&items[0]).unwrap();
        assert_eq!(process.id, 0);
        assert_eq!(process.name, "felizviaje-web");
        assert_eq!(process.status, "online");
        assert_eq!(process.pid, Some(658292));
        assert_eq!(process.restarts, 3);
        assert_eq!(process.memory, 104857600);
        assert_eq!(process.cpu, 12.5);
        assert!(process.out_log.ends_with("felizviaje-web-out.log"));
    }

    #[test]
    fn accepts_custom_pm2_log_paths() {
        assert!(validate_log_path("/root/.pm2/logs/app-out.log").is_ok());
        assert!(validate_log_path("/var/www/felizviajeapi/logs/out.log").is_ok());
        assert!(validate_log_path("/opt/app/logs/error.log").is_ok());
        assert!(validate_log_path("/etc/passwd").is_err());
        assert!(validate_log_path("/etc/shadow.log").is_err());
        assert!(validate_log_path("/root/.pm2/logs/../../etc/passwd").is_err());
        assert!(validate_log_path("relative/out.log").is_err());
        assert!(validate_log_path("/var/www/app/out.txt").is_err());
    }

    #[test]
    fn truncates_on_char_boundary() {
        assert_eq!(truncate("hello".into(), 10), "hello");
        let truncated = truncate("ñ".repeat(10), 5);
        assert!(truncated.ends_with("truncated"));
    }
}
