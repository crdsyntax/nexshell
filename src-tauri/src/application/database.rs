use crate::application::pool::PoolManager;
use crate::application::services::{maybe_sudo, shell_quote};
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, DbInfo, DbLoginTest, DbPasswordResult, DbUser};
use std::time::Duration;

const DB_TIMEOUT: Duration = Duration::from_secs(25);
const TEST_TIMEOUT: Duration = Duration::from_secs(20);
const SYSTEM_USERS: &[&str] = &[
    "mariadb.sys",
    "mysql.sys",
    "mysql.session",
    "mysql.infoschema",
    "mysql",
];

pub struct DatabaseManager;

impl DatabaseManager {
    pub async fn info(pools: &PoolManager, profile: &ConnectionProfile) -> AppResult<DbInfo> {
        let binary = match client_binary(pools, profile).await {
            Ok(binary) => binary,
            Err(error) => {
                return Ok(DbInfo {
                    installed: false,
                    client: String::new(),
                    version: String::new(),
                    hostname: String::new(),
                    port: 3306,
                    socket: String::new(),
                    service_state: "unknown".into(),
                    can_query: false,
                    error: Some(error.to_string()),
                })
            }
        };

        let service_state = pools
            .execute_silent(
                &profile.id,
                r#"s=$(systemctl is-active mariadb 2>/dev/null || true)
[ -z "$s" ] && s=$(systemctl is-active mysql 2>/dev/null || true)
[ -z "$s" ] && { pgrep -x mariadbd >/dev/null 2>&1 && s=active || s=unknown; }
echo "$s""#,
                Duration::from_secs(10),
            )
            .await
            .map(|output| output.stdout.trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string());

        let command = format!(
            "{} -N -B -e {}",
            privileged_client(profile, &binary),
            shell_quote("SELECT VERSION(), @@hostname, @@port, @@socket;")
        );

        match pools
            .execute_with_category(&profile.id, &command, DB_TIMEOUT, "database")
            .await
        {
            Ok(output) if output.success() => {
                let fields: Vec<&str> = output.stdout.trim().split('\t').collect();
                Ok(DbInfo {
                    installed: true,
                    client: binary,
                    version: fields.first().unwrap_or(&"").to_string(),
                    hostname: fields.get(1).unwrap_or(&"").to_string(),
                    port: fields
                        .get(2)
                        .and_then(|value| value.parse().ok())
                        .unwrap_or(3306),
                    socket: fields.get(3).unwrap_or(&"").to_string(),
                    service_state,
                    can_query: true,
                    error: None,
                })
            }
            Ok(output) => Ok(DbInfo {
                installed: true,
                client: binary,
                version: String::new(),
                hostname: String::new(),
                port: 3306,
                socket: String::new(),
                service_state,
                can_query: false,
                error: Some(format!("{}{}", output.stdout.trim(), output.stderr.trim())),
            }),
            Err(error) => Ok(DbInfo {
                installed: true,
                client: binary,
                version: String::new(),
                hostname: String::new(),
                port: 3306,
                socket: String::new(),
                service_state,
                can_query: false,
                error: Some(error.to_string()),
            }),
        }
    }

    pub async fn users(pools: &PoolManager, profile: &ConnectionProfile) -> AppResult<Vec<DbUser>> {
        let binary = client_binary(pools, profile).await?;
        let command = format!(
            "{} -N -B -e {}",
            privileged_client(profile, &binary),
            shell_quote("SELECT User, Host, plugin FROM mysql.user ORDER BY User, Host;")
        );
        let output = pools
            .execute_with_category(&profile.id, &command, DB_TIMEOUT, "database")
            .await?;

        if !output.success() {
            return Err(AppError::Remote(format!(
                "cannot list database users: {}{}",
                output.stdout.trim(),
                output.stderr.trim()
            )));
        }

        let users = output
            .stdout
            .lines()
            .filter_map(|line| {
                let fields: Vec<&str> = line.split('\t').collect();
                if fields.len() < 2 {
                    return None;
                }
                let user = fields[0].trim().to_string();
                let host = fields[1].trim().to_string();
                let plugin = fields.get(2).unwrap_or(&"").trim().to_string();
                if user.is_empty() && host.is_empty() {
                    return None;
                }
                Some(DbUser {
                    system: SYSTEM_USERS.contains(&user.as_str()),
                    user,
                    host,
                    plugin,
                })
            })
            .collect();
        Ok(users)
    }

    pub async fn grants(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        user: &str,
        host: &str,
    ) -> AppResult<String> {
        validate_account(user, host)?;
        let binary = client_binary(pools, profile).await?;
        let sql = format!("SHOW GRANTS FOR {}@{};", sql_string(user), sql_string(host));
        let command = format!(
            "{} -N -B -e {}",
            privileged_client(profile, &binary),
            shell_quote(&sql)
        );
        let output = pools
            .execute_with_category(&profile.id, &command, DB_TIMEOUT, "database")
            .await?;
        if !output.success() {
            return Err(AppError::Remote(format!(
                "cannot read grants: {}{}",
                output.stdout.trim(),
                output.stderr.trim()
            )));
        }
        Ok(output.stdout)
    }

    #[allow(clippy::too_many_arguments)]
    pub async fn change_password(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        user: &str,
        host: &str,
        password: &str,
        test_host: Option<&str>,
        test_port: Option<u16>,
        test_database: Option<&str>,
    ) -> AppResult<DbPasswordResult> {
        validate_account(user, host)?;
        validate_password(password)?;

        let binary = client_binary(pools, profile).await?;
        let sql = format!(
            "ALTER USER {}@{} IDENTIFIED BY {};\nFLUSH PRIVILEGES;",
            sql_string(user),
            sql_string(host),
            sql_string(password)
        );
        let command = format!(
            "{} <<'NEXSQL'\n{}\nNEXSQL",
            privileged_client(profile, &binary),
            sql
        );
        let output = pools
            .execute_sensitive(&profile.id, &command, DB_TIMEOUT)
            .await?;

        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        let ok = output.success();
        let should_test = test_host
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        let test = if ok && should_test {
            let host_to_test = test_host
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| default_test_host(host));
            Some(
                Self::test_login(
                    pools,
                    profile,
                    user,
                    host_to_test,
                    test_port.unwrap_or(3306).max(1),
                    test_database,
                    password,
                )
                .await
                .unwrap_or_else(|error| DbLoginTest {
                    ok: false,
                    output: String::new(),
                    error: Some(error.to_string()),
                }),
            )
        } else {
            None
        };

        Ok(DbPasswordResult {
            ok,
            output: if combined.is_empty() {
                if ok {
                    format!("password changed for {user}@{host}")
                } else {
                    "password change failed without output".to_string()
                }
            } else {
                combined
            },
            exit_code: output.exit_status,
            test,
        })
    }

    pub async fn test_login(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        user: &str,
        host: &str,
        port: u16,
        database: Option<&str>,
        password: &str,
    ) -> AppResult<DbLoginTest> {
        validate_account(user, host)?;
        if password.is_empty() {
            return Err(AppError::Validation("password is required".into()));
        }
        if host.chars().any(|c| c.is_control()) {
            return Err(AppError::Validation(
                "test host contains control characters".into(),
            ));
        }

        let binary = client_binary(pools, profile).await?;
        let db_arg = database
            .filter(|value| !value.trim().is_empty())
            .map(|value| format!(" -D {}", shell_quote(value)))
            .unwrap_or_default();
        let command = format!(
            "MYSQL_PWD={} {} -u {} -h {} -P {}{} --connect-timeout=5 -N -B -e 'SELECT 1;'",
            shell_quote(password),
            shell_quote(&binary),
            shell_quote(user),
            shell_quote(host),
            port,
            db_arg
        );
        let output = pools
            .execute_sensitive(&profile.id, &command, TEST_TIMEOUT)
            .await?;
        let stdout = output.stdout.trim().to_string();
        let stderr = output.stderr.trim().to_string();
        let ok = output.success() && stdout.lines().any(|line| line.trim() == "1");
        Ok(DbLoginTest {
            ok,
            output: stdout,
            error: if ok {
                None
            } else if stderr.is_empty() {
                Some(format!("login test failed (exit {})", output.exit_status))
            } else {
                Some(stderr)
            },
        })
    }
}

async fn client_binary(pools: &PoolManager, profile: &ConnectionProfile) -> AppResult<String> {
    let output = pools
        .execute_silent(
            &profile.id,
            "command -v mariadb 2>/dev/null || command -v mysql 2>/dev/null || true",
            Duration::from_secs(8),
        )
        .await?;
    let binary = output
        .stdout
        .lines()
        .map(str::trim)
        .find(|line| !line.is_empty())
        .map(str::to_string)
        .ok_or_else(|| {
            AppError::NotFound(
                "no mariadb/mysql client found on the host; install MariaDB or MySQL client tools"
                    .into(),
            )
        })?;
    Ok(binary)
}

fn privileged_client(profile: &ConnectionProfile, binary: &str) -> String {
    if profile.username == "root" {
        shell_quote(binary)
    } else {
        maybe_sudo(profile, &shell_quote(binary))
    }
}

fn default_test_host(account_host: &str) -> &str {
    if account_host == "localhost" {
        "localhost"
    } else {
        "127.0.0.1"
    }
}

fn validate_account(user: &str, host: &str) -> AppResult<()> {
    if user.trim().is_empty() || host.trim().is_empty() {
        return Err(AppError::Validation(
            "database user and host are required".into(),
        ));
    }
    if user.len() > 128 || host.len() > 255 {
        return Err(AppError::Validation(
            "database user or host is too long".into(),
        ));
    }
    if user.chars().any(|c| c.is_control() || c == '\'')
        || host.chars().any(|c| c.is_control() || c == '\'')
    {
        return Err(AppError::Validation(
            "database user and host must not contain quotes or control characters".into(),
        ));
    }
    Ok(())
}

fn validate_password(password: &str) -> AppResult<()> {
    if password.len() < 8 {
        return Err(AppError::Validation(
            "the new password must be at least 8 characters".into(),
        ));
    }
    if password.chars().any(|c| c.is_control()) {
        return Err(AppError::Validation(
            "the new password must not contain control characters".into(),
        ));
    }
    Ok(())
}

fn sql_string(value: &str) -> String {
    format!("'{}'", value.replace('\\', "\\\\").replace('\'', "\\'"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn escapes_sql_strings() {
        assert_eq!(sql_string("plain"), "'plain'");
        assert_eq!(sql_string("pa'ss"), "'pa\\'ss'");
        assert_eq!(sql_string("a\\b"), "'a\\\\b'");
    }

    #[test]
    fn validates_accounts_and_passwords() {
        assert!(validate_account("root", "localhost").is_ok());
        assert!(validate_account("", "localhost").is_err());
        assert!(validate_account("us'er", "localhost").is_err());
        assert!(validate_password("short").is_err());
        assert!(validate_password("long-enough-password").is_ok());
        assert!(validate_password("line\nbreak").is_err());
        assert_eq!(default_test_host("localhost"), "localhost");
        assert_eq!(default_test_host("%"), "127.0.0.1");
    }
}
