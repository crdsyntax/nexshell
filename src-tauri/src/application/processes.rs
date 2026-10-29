use crate::application::pool::PoolManager;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, ProcessKillResult, ProcessLocation};
use std::time::Duration;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProcessSignal {
    Term,
    Int,
    Kill,
}

impl ProcessSignal {
    pub fn parse(value: &str) -> AppResult<Self> {
        match value.trim().to_uppercase().as_str() {
            "TERM" | "SIGTERM" => Ok(Self::Term),
            "INT" | "SIGINT" => Ok(Self::Int),
            "KILL" | "SIGKILL" => Ok(Self::Kill),
            other => Err(AppError::Validation(format!(
                "unsupported signal '{other}' (use TERM, INT or KILL)"
            ))),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Term => "TERM",
            Self::Int => "INT",
            Self::Kill => "KILL",
        }
    }
}

const MAX_LINUX_PID: u32 = 4_194_304;

fn validate_pid(pid: u32) -> AppResult<()> {
    if pid <= 1 {
        return Err(AppError::Validation(
            "refusing to signal PID 1 or a non-positive PID".into(),
        ));
    }
    if pid > MAX_LINUX_PID {
        return Err(AppError::Validation(format!(
            "PID {pid} is outside the Linux pid_max range"
        )));
    }
    Ok(())
}

pub struct ProcessManager;

impl ProcessManager {
    /// Resolve the working directory of a process (falling back to the
    /// executable's directory) and report whether the SSH user can enter it.
    pub async fn locate(
        pools: &PoolManager,
        profile_id: &str,
        pid: u32,
    ) -> AppResult<ProcessLocation> {
        validate_pid(pid)?;

        let script = format!(
            r#"pid={pid}
cwd=$(readlink -f "/proc/$pid/cwd" 2>/dev/null)
exe=$(readlink -f "/proc/$pid/exe" 2>/dev/null)
cmd=$(tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | tr '\n' ' ' | head -c 512)
dir="$cwd"
[ -z "$dir" ] && [ -n "$exe" ] && dir=$(dirname "$exe")
access=0
[ -n "$dir" ] && [ -d "$dir" ] && [ -r "$dir" ] && [ -x "$dir" ] && access=1
echo "__PID__$pid"
echo "__CWD__$cwd"
echo "__EXE__$exe"
echo "__DIR__$dir"
echo "__ACCESS__$access"
echo "__CMD__$cmd"
exit 0"#
        );

        let output = pools
            .execute_process(profile_id, &script, Duration::from_secs(12))
            .await?;

        let location = parse_location(pid, &output.stdout)?;
        if location.directory.is_empty() {
            return Err(AppError::NotFound(format!(
                "process {pid} has no resolvable working directory (it may have exited or be a kernel thread)"
            )));
        }
        Ok(location)
    }

    pub async fn kill(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        pid: u32,
        signal: ProcessSignal,
    ) -> AppResult<ProcessKillResult> {
        validate_pid(pid)?;

        let signal_name = signal.as_str();
        let kill = if profile.elevated {
            format!("sudo -n kill -{signal_name} {pid}")
        } else {
            format!("kill -{signal_name} {pid}")
        };
        let output = pools
            .execute_process(
                &profile.id,
                &format!("{kill} 2>&1"),
                Duration::from_secs(12),
            )
            .await?;

        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();

        if !output.success() {
            if combined.contains("No such process") {
                return Err(AppError::NotFound(format!(
                    "process {pid} no longer exists"
                )));
            }
            if combined.contains("Operation not permitted") {
                return Err(AppError::Validation(format!(
                    "the SSH user cannot signal PID {pid}; run the session as its owner or enable the elevated profile option"
                )));
            }
            return Err(AppError::Remote(format!(
                "SIG{signal_name} to PID {pid} failed (exit {}): {combined}",
                output.exit_status
            )));
        }

        Ok(ProcessKillResult {
            pid,
            signal: signal_name.to_string(),
            ok: true,
            output: if combined.is_empty() {
                format!("SIG{signal_name} sent to PID {pid}")
            } else {
                combined
            },
            exit_code: output.exit_status,
        })
    }
}

fn parse_location(pid: u32, output: &str) -> AppResult<ProcessLocation> {
    let field = |prefix: &str| -> String {
        output
            .lines()
            .find_map(|line| line.trim().strip_prefix(prefix))
            .map(|value| value.trim().to_string())
            .unwrap_or_default()
    };

    let cwd = field("__CWD__");
    let exe = field("__EXE__");
    let directory = field("__DIR__");
    let command = field("__CMD__");
    let accessible = field("__ACCESS__") == "1";

    Ok(ProcessLocation {
        pid,
        cwd: (!cwd.is_empty()).then_some(cwd),
        exe: (!exe.is_empty()).then_some(exe),
        command,
        directory,
        accessible,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "__PID__1412
__CWD__/srv/app/current
__EXE__/usr/bin/node
__DIR__/srv/app/current
__ACCESS__1
__CMD__node /srv/app/server.js --port 3000
";

    #[test]
    fn parses_location_output() {
        let location = parse_location(1412, SAMPLE).unwrap();
        assert_eq!(location.pid, 1412);
        assert_eq!(location.cwd.as_deref(), Some("/srv/app/current"));
        assert_eq!(location.exe.as_deref(), Some("/usr/bin/node"));
        assert_eq!(location.directory, "/srv/app/current");
        assert!(location.accessible);
        assert_eq!(location.command, "node /srv/app/server.js --port 3000");
    }

    #[test]
    fn detects_inaccessible_directory() {
        let output = "__DIR__/root/private\n__ACCESS__0\n";
        let location = parse_location(9, output).unwrap();
        assert_eq!(location.directory, "/root/private");
        assert!(!location.accessible);
    }

    #[test]
    fn rejects_pid_one_and_unknown_signals() {
        assert!(validate_pid(1).is_err());
        assert!(validate_pid(0).is_err());
        assert!(validate_pid(1412).is_ok());
        assert_eq!(
            ProcessSignal::parse("sigkill").unwrap(),
            ProcessSignal::Kill
        );
        assert!(ProcessSignal::parse("HUP").is_err());
    }
}
