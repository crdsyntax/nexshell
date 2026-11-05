use crate::application::pool::PoolManager;
use crate::application::services::shell_quote;
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

#[derive(Debug, Clone, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DbAuth {
    pub user: String,
    pub password: String,
    pub host: String,
    pub port: u16,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub auth_db: Option<String>,
}

impl DbAuth {
    pub fn is_mongodb(&self) -> bool {
        self.engine
            .as_deref()
            .map(|e| e.eq_ignore_ascii_case("mongodb"))
            .unwrap_or(false)
            || self.port == 27017
    }

    fn validate(&self) -> AppResult<()> {
        if self.user.trim().is_empty() {
            return Err(AppError::Validation("database user is required".into()));
        }
        if self.password.is_empty() {
            return Err(AppError::Validation(
                "database password is required; no connection attempt was made".into(),
            ));
        }
        if self.port == 0 {
            return Err(AppError::Validation(
                "database port must be between 1 and 65535".into(),
            ));
        }
        if self.user.chars().any(|c| c.is_control()) || self.host.chars().any(|c| c.is_control()) {
            return Err(AppError::Validation(
                "database user and host must not contain control characters".into(),
            ));
        }
        if let Some(auth_db) = &self.auth_db {
            if auth_db.chars().any(|c| c.is_control() || c == '\'' || c == '"') {
                return Err(AppError::Validation(
                    "database auth source must not contain control characters or quotes".into(),
                ));
            }
        }
        Ok(())
    }
}

fn auth_command(
    profile: &ConnectionProfile,
    binary: &str,
    auth: &DbAuth,
    sql: &str,
) -> AppResult<String> {
    auth.validate()?;
    let host = auth.host.trim();
    let host_arg = if host.is_empty() || host.eq_ignore_ascii_case("localhost") {
        String::new()
    } else {
        format!(" -h {}", shell_quote(host))
    };
    let base = format!(
        "-u {} -P {}{} --connect-timeout=5 -N -B -e {}",
        shell_quote(&auth.user),
        auth.port,
        host_arg,
        shell_quote(sql)
    );
    let password = shell_quote(&auth.password);
    let binary = shell_quote(binary);
    if profile.username != "root" && profile.elevated {
        Ok(format!("sudo -n env MYSQL_PWD={password} {binary} {base}"))
    } else {
        Ok(format!("MYSQL_PWD={password} {binary} {base}"))
    }
}

fn js_string(value: &str) -> String {
    let escaped = value
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
        .replace('\n', "\\n")
        .replace('\r', "\\r");
    format!("\"{escaped}\"")
}

async fn mongo_client_binary(pools: &PoolManager, profile: &ConnectionProfile) -> AppResult<String> {
    let output = pools
        .execute_silent(
            &profile.id,
            "command -v mongosh 2>/dev/null || command -v mongo 2>/dev/null || true",
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
                "no mongosh or mongo client found on the host; install mongosh to manage MongoDB".into(),
            )
        })?;
    Ok(binary)
}

fn mongo_auth_command(
    profile: &ConnectionProfile,
    binary: &str,
    auth: &DbAuth,
    js_code: &str,
) -> AppResult<String> {
    auth.validate()?;
    let host = auth.host.trim();
    let host_arg = if host.is_empty() { "127.0.0.1" } else { host };
    let auth_db = auth.auth_db.as_deref().unwrap_or("admin").trim();
    let auth_db = if auth_db.is_empty() { "admin" } else { auth_db };

    let base = format!(
        "--host {} --port {} -u {} -p {} --authenticationDatabase {} --quiet --eval {}",
        shell_quote(host_arg),
        auth.port,
        shell_quote(&auth.user),
        shell_quote(&auth.password),
        shell_quote(auth_db),
        shell_quote(js_code)
    );
    let binary = shell_quote(binary);
    if profile.username != "root" && profile.elevated {
        Ok(format!("sudo -n {binary} {base}"))
    } else {
        Ok(format!("{binary} {base}"))
    }
}

pub struct DatabaseManager;

impl DatabaseManager {
    pub async fn info(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        auth: &DbAuth,
    ) -> AppResult<DbInfo> {
        auth.validate()?;
        if auth.is_mongodb() {
            return Self::mongo_info(pools, profile, auth).await;
        }
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

        let command = auth_command(
            profile,
            &binary,
            auth,
            "SELECT VERSION(), @@hostname, @@port, @@socket;",
        )?;

        match pools
            .execute_sensitive(&profile.id, &command, DB_TIMEOUT)
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

    async fn mongo_info(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        auth: &DbAuth,
    ) -> AppResult<DbInfo> {
        let binary = match mongo_client_binary(pools, profile).await {
            Ok(binary) => binary,
            Err(error) => {
                return Ok(DbInfo {
                    installed: false,
                    client: String::new(),
                    version: String::new(),
                    hostname: String::new(),
                    port: auth.port,
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
                r#"s=$(systemctl is-active mongod 2>/dev/null || true)
[ -z "$s" ] && s=$(systemctl is-active mongodb 2>/dev/null || true)
[ -z "$s" ] && { pgrep -x mongod >/dev/null 2>&1 && s=active || s=unknown; }
echo "$s""#,
                Duration::from_secs(10),
            )
            .await
            .map(|output| output.stdout.trim().to_string())
            .unwrap_or_else(|_| "unknown".to_string());

        let js = "print(JSON.stringify({ version: db.version(), hostname: (db.runCommand({ hello: 1 }).me || 'localhost') }))";
        let command = mongo_auth_command(profile, &binary, auth, js)?;

        match pools.execute_sensitive(&profile.id, &command, DB_TIMEOUT).await {
            Ok(output) if output.success() => {
                let parsed: Option<serde_json::Value> = output
                    .stdout
                    .lines()
                    .rev()
                    .find_map(|line| serde_json::from_str(line.trim()).ok());

                if let Some(val) = parsed {
                    let version = val["version"].as_str().unwrap_or("").to_string();
                    let hostname = val["hostname"].as_str().unwrap_or("localhost").to_string();
                    Ok(DbInfo {
                        installed: true,
                        client: binary,
                        version,
                        hostname,
                        port: auth.port,
                        socket: String::new(),
                        service_state,
                        can_query: true,
                        error: None,
                    })
                } else {
                    Ok(DbInfo {
                        installed: true,
                        client: binary,
                        version: String::new(),
                        hostname: String::new(),
                        port: auth.port,
                        socket: String::new(),
                        service_state,
                        can_query: false,
                        error: Some("failed to parse mongosh response".into()),
                    })
                }
            }
            Ok(output) => Ok(DbInfo {
                installed: true,
                client: binary,
                version: String::new(),
                hostname: String::new(),
                port: auth.port,
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
                port: auth.port,
                socket: String::new(),
                service_state,
                can_query: false,
                error: Some(error.to_string()),
            }),
        }
    }

    pub async fn users(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        auth: &DbAuth,
    ) -> AppResult<Vec<DbUser>> {
        if auth.is_mongodb() {
            return Self::mongo_users(pools, profile, auth).await;
        }
        let binary = client_binary(pools, profile).await?;
        let command = auth_command(
            profile,
            &binary,
            auth,
            "SELECT User, Host, plugin FROM mysql.user ORDER BY User, Host;",
        )?;
        let output = pools
            .execute_sensitive(&profile.id, &command, DB_TIMEOUT)
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

    async fn mongo_users(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        auth: &DbAuth,
    ) -> AppResult<Vec<DbUser>> {
        let binary = mongo_client_binary(pools, profile).await?;
        let target_db = auth.auth_db.as_deref().unwrap_or("admin").trim();
        let target_db = if target_db.is_empty() { "admin" } else { target_db };
        let target_db_js = js_string(target_db);
        let user_js = js_string(auth.user.trim());

        let js = format!(
            r#"(function() {{
  try {{
    var resAll = db.getSiblingDB("admin").runCommand({{ usersInfo: {{ forAllDBs: true }} }});
    if (resAll && resAll.ok && Array.isArray(resAll.users) && resAll.users.length > 0) {{
      print(JSON.stringify(resAll.users));
      return;
    }}
  }} catch (e1) {{}}

  try {{
    var resDb = db.getSiblingDB({target_db_js}).runCommand({{ usersInfo: 1 }});
    if (resDb && resDb.ok && Array.isArray(resDb.users) && resDb.users.length > 0) {{
      print(JSON.stringify(resDb.users));
      return;
    }}
  }} catch (e2) {{}}

  try {{
    var resSelf = db.getSiblingDB({target_db_js}).runCommand({{ usersInfo: {{ user: {user_js}, db: {target_db_js} }} }});
    if (resSelf && resSelf.ok && Array.isArray(resSelf.users) && resSelf.users.length > 0) {{
      print(JSON.stringify(resSelf.users));
      return;
    }}
  }} catch (e3) {{}}

  try {{
    var status = db.getSiblingDB({target_db_js}).runCommand({{ connectionStatus: 1 }});
    if (status && status.ok && status.authInfo) {{
      var authUsers = status.authInfo.authenticatedUsers || [];
      var authRoles = status.authInfo.authenticatedUserRoles || [];
      if (authUsers.length > 0) {{
        var mapped = authUsers.map(function(u) {{
          var uRoles = authRoles.filter(function(r) {{ return !r.db || r.db === u.db; }});
          return {{
            user: u.user,
            db: u.db,
            roles: uRoles.length > 0 ? uRoles : authRoles
          }};
        }});
        print(JSON.stringify(mapped));
        return;
      }}
    }}
  }} catch (e4) {{}}

  print(JSON.stringify([{{
    user: {user_js},
    db: {target_db_js},
    roles: []
  }}]));
}})();"#
        );
        let command = mongo_auth_command(profile, &binary, auth, &js)?;
        let output = pools
            .execute_sensitive(&profile.id, &command, DB_TIMEOUT)
            .await?;

        if !output.success() {
            return Err(AppError::Remote(format!(
                "cannot list MongoDB users: {}{}",
                output.stdout.trim(),
                output.stderr.trim()
            )));
        }

        let parsed: Option<serde_json::Value> = output
            .stdout
            .lines()
            .rev()
            .find_map(|line| serde_json::from_str(line.trim()).ok());

        let users_arr = match parsed {
            Some(serde_json::Value::Array(arr)) => arr,
            _ => {
                return Err(AppError::Remote(
                    "unexpected output format when listing MongoDB users".into(),
                ));
            }
        };

        let mut users = Vec::new();
        for item in users_arr {
            let user = item["user"].as_str().unwrap_or("").trim().to_string();
            let db = item["db"].as_str().unwrap_or("admin").trim().to_string();
            if user.is_empty() {
                continue;
            }
            let roles_str = item["roles"]
                .as_array()
                .map(|roles| {
                    roles
                        .iter()
                        .filter_map(|r| {
                            let role_name = r["role"].as_str()?;
                            let role_db = r["db"].as_str().unwrap_or("");
                            if role_db.is_empty() || role_db == db {
                                Some(role_name.to_string())
                            } else {
                                Some(format!("{role_name}@{role_db}"))
                            }
                        })
                        .collect::<Vec<_>>()
                        .join(", ")
                })
                .unwrap_or_default();

            let is_system = db == "local"
                || user.starts_with("__")
                || (db == "admin" && (user == "__system" || user == "system"));

            users.push(DbUser {
                user,
                host: db,
                plugin: roles_str,
                system: is_system,
            });
        }

        users.sort_by(|a, b| a.user.cmp(&b.user).then_with(|| a.host.cmp(&b.host)));
        Ok(users)
    }

    pub async fn grants(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        auth: &DbAuth,
        user: &str,
        host: &str,
    ) -> AppResult<String> {
        if auth.is_mongodb() {
            return Self::mongo_grants(pools, profile, auth, user, host).await;
        }
        validate_account(user, host)?;
        let binary = client_binary(pools, profile).await?;
        let sql = format!("SHOW GRANTS FOR {}@{};", sql_string(user), sql_string(host));
        let command = auth_command(profile, &binary, auth, &sql)?;
        let output = pools
            .execute_sensitive(&profile.id, &command, DB_TIMEOUT)
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

    async fn mongo_grants(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        auth: &DbAuth,
        user: &str,
        db: &str,
    ) -> AppResult<String> {
        validate_account(user, db)?;
        let binary = mongo_client_binary(pools, profile).await?;
        let user_js = js_string(user);
        let db_js = js_string(db);
        let js = format!(
            r#"(function() {{
  var res = null;
  try {{
    res = db.getSiblingDB({db_js}).runCommand({{ usersInfo: {{ user: {user_js}, db: {db_js} }}, showPrivileges: true }});
  }} catch (e1) {{}}

  if (!res || !res.ok || !res.users || res.users.length === 0) {{
    try {{
      res = db.getSiblingDB("admin").runCommand({{ usersInfo: {{ user: {user_js}, db: {db_js} }}, showPrivileges: true }});
    }} catch (e2) {{}}
  }}

  if (!res || !res.ok || !res.users || res.users.length === 0) {{
    try {{
      var status = db.getSiblingDB({db_js}).runCommand({{ connectionStatus: 1, showPrivileges: true }});
      if (status && status.ok) {{
        res = {{
          ok: 1,
          authInfo: status.authInfo,
          users: (status.authInfo && status.authInfo.authenticatedUsers) || []
        }};
      }}
    }} catch (e3) {{}}
  }}

  print(JSON.stringify(res || {{ ok: 0, error: "could not retrieve privileges" }}, null, 2));
}})();"#
        );
        let command = mongo_auth_command(profile, &binary, auth, &js)?;
        let output = pools
            .execute_sensitive(&profile.id, &command, DB_TIMEOUT)
            .await?;
        if !output.success() {
            return Err(AppError::Remote(format!(
                "cannot read MongoDB user privileges: {}{}",
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
        auth: &DbAuth,
        user: &str,
        host: &str,
        password: &str,
        test_host: Option<&str>,
        test_port: Option<u16>,
        test_database: Option<&str>,
    ) -> AppResult<DbPasswordResult> {
        if auth.is_mongodb() {
            return Self::mongo_change_password(
                pools,
                profile,
                auth,
                user,
                host,
                password,
                test_host,
                test_port,
                test_database,
            )
            .await;
        }
        validate_account(user, host)?;
        validate_password(password)?;

        let binary = client_binary(pools, profile).await?;
        let sql = format!(
            "ALTER USER {}@{} IDENTIFIED BY {};\nFLUSH PRIVILEGES;",
            sql_string(user),
            sql_string(host),
            sql_string(password)
        );
        let command = auth_command(profile, &binary, auth, &sql)?;
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
                    Some("mysql"),
                    None,
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

    #[allow(clippy::too_many_arguments)]
    async fn mongo_change_password(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        auth: &DbAuth,
        user: &str,
        db: &str,
        password: &str,
        test_host: Option<&str>,
        test_port: Option<u16>,
        test_database: Option<&str>,
    ) -> AppResult<DbPasswordResult> {
        validate_account(user, db)?;
        validate_password(password)?;

        let binary = mongo_client_binary(pools, profile).await?;
        let user_js = js_string(user);
        let db_js = js_string(db);
        let pass_js = js_string(password);
        let js = format!(
            r#"db.getSiblingDB({db_js}).changeUserPassword({user_js}, {pass_js}); print("PASSWORD_CHANGED_OK");"#
        );
        let command = mongo_auth_command(profile, &binary, auth, &js)?;
        let output = pools
            .execute_sensitive(&profile.id, &command, DB_TIMEOUT)
            .await?;

        let combined = format!("{}{}", output.stdout, output.stderr)
            .trim()
            .to_string();
        let ok = output.success() && combined.contains("PASSWORD_CHANGED_OK");
        let should_test = test_host
            .map(|value| !value.trim().is_empty())
            .unwrap_or(false);
        let test = if ok && should_test {
            let host_to_test = test_host
                .filter(|value| !value.trim().is_empty())
                .unwrap_or(&auth.host);
            Some(
                Self::test_login(
                    pools,
                    profile,
                    user,
                    host_to_test,
                    test_port.unwrap_or(auth.port).max(1),
                    test_database.or(Some(db)),
                    password,
                    Some("mongodb"),
                    Some(db),
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
                    format!("password changed for MongoDB user {user} on db {db}")
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

    #[allow(clippy::too_many_arguments)]
    pub async fn test_login(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        user: &str,
        host: &str,
        port: u16,
        database: Option<&str>,
        password: &str,
        engine: Option<&str>,
        auth_db: Option<&str>,
    ) -> AppResult<DbLoginTest> {
        let is_mongo = engine
            .map(|e| e.eq_ignore_ascii_case("mongodb"))
            .unwrap_or(false)
            || port == 27017;

        if is_mongo {
            return Self::mongo_test_login(
                pools,
                profile,
                user,
                host,
                port,
                auth_db.or(database).unwrap_or("admin"),
                password,
            )
            .await;
        }

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

    async fn mongo_test_login(
        pools: &PoolManager,
        profile: &ConnectionProfile,
        user: &str,
        host: &str,
        port: u16,
        auth_db: &str,
        password: &str,
    ) -> AppResult<DbLoginTest> {
        validate_account(user, auth_db)?;
        if password.is_empty() {
            return Err(AppError::Validation("password is required".into()));
        }
        let binary = mongo_client_binary(pools, profile).await?;
        let auth = DbAuth {
            user: user.to_string(),
            password: password.to_string(),
            host: host.to_string(),
            port,
            engine: Some("mongodb".into()),
            auth_db: Some(auth_db.to_string()),
        };
        let js = "print(JSON.stringify(db.runCommand({ ping: 1 })))";
        let command = mongo_auth_command(profile, &binary, &auth, js)?;
        let output = pools
            .execute_sensitive(&profile.id, &command, TEST_TIMEOUT)
            .await?;
        let stdout = output.stdout.trim().to_string();
        let stderr = output.stderr.trim().to_string();
        let ok = output.success() && (stdout.contains("\"ok\":1") || stdout.contains("\"ok\": 1"));
        Ok(DbLoginTest {
            ok,
            output: stdout,
            error: if ok {
                None
            } else if stderr.is_empty() {
                Some(format!("MongoDB login test failed (exit {})", output.exit_status))
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

    fn auth(host: &str) -> DbAuth {
        DbAuth {
            user: "root".into(),
            password: "s3cret-pass".into(),
            host: host.into(),
            port: 3306,
            engine: None,
            auth_db: None,
        }
    }

    #[test]
    fn builds_mongo_auth_command() {
        let profile = ConnectionProfile::default();
        let mongo_auth = DbAuth {
            user: "admin".into(),
            password: "p@ssword".into(),
            host: "127.0.0.1".into(),
            port: 27017,
            engine: Some("mongodb".into()),
            auth_db: Some("admin".into()),
        };
        let cmd = mongo_auth_command(&profile, "/usr/bin/mongosh", &mongo_auth, "db.version()").unwrap();
        assert!(cmd.contains("/usr/bin/mongosh"));
        assert!(cmd.contains("--host '127.0.0.1' --port 27017"));
        assert!(cmd.contains("-u 'admin' -p 'p@ssword' --authenticationDatabase 'admin'"));
        assert!(cmd.contains("--quiet --eval 'db.version()'"));
    }

    #[test]
    fn escapes_js_strings() {
        assert_eq!(js_string("admin"), "\"admin\"");
        assert_eq!(js_string("pass\"word"), "\"pass\\\"word\"");
        assert_eq!(js_string("slash\\path"), "\"slash\\\\path\"");
    }

    #[test]
    fn requires_a_password_before_any_query() {
        let mut missing = auth("localhost");
        missing.password.clear();
        assert!(missing.validate().is_err());
        assert!(auth("localhost").validate().is_ok());
    }

    #[test]
    fn builds_authenticated_client_command_without_leaking_host_for_localhost() {
        let profile = ConnectionProfile::default();
        let sql = "SELECT 1;";
        let local = auth_command(&profile, "/usr/bin/mariadb", &auth("localhost"), sql).unwrap();
        assert!(local.contains("MYSQL_PWD='s3cret-pass'"));
        assert!(local.contains("-u 'root' -P 3306"));
        assert!(!local.contains(" -h "));
        assert!(local.contains("-e 'SELECT 1;'"));

        let remote = auth_command(&profile, "/usr/bin/mariadb", &auth("127.0.0.1"), sql).unwrap();
        assert!(remote.contains("-h '127.0.0.1'"));
    }

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
