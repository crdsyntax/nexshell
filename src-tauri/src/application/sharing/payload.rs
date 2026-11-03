use crate::application::sharing::envelope::{ShareMode, MAX_PLAINTEXT_BYTES};
use crate::error::{AppError, AppResult};
use crate::models::{AuthMethod, ConnectionProfile, DbTarget, PoolSettings, RetryPolicy};
use serde::{Deserialize, Serialize};
use uuid::Uuid;
use zeroize::Zeroize;

pub const SHARE_ENTRY_NAMESPACE: Uuid = Uuid::from_bytes([
    0xb7, 0xf4, 0xc2, 0xd1, 0x9e, 0x3a, 0x5f, 0x6b, 0x8c, 0x0d, 0x2a, 0x4e, 0x6f, 0x8b, 0x1c, 0x3d,
]);

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OriginInfo {
    pub app: String,
    pub version: String,
    pub platform: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RetryShare {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
    pub jitter: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PoolShare {
    pub max_connections: u32,
    pub acquire_timeout_ms: u64,
    pub idle_timeout_secs: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProfileShare {
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub environment: String,
    pub color: String,
    pub tags: Vec<String>,
    pub keepalive_secs: u64,
    pub connect_timeout_secs: u64,
    pub retry: RetryShare,
    pub pool: PoolShare,
    pub elevated: bool,
}

#[derive(Clone, Default, Serialize, Deserialize, Zeroize)]
#[zeroize(drop)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SecretsShare {
    pub ssh_password: Option<String>,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub database_password: Option<String>,
}

impl std::fmt::Debug for SecretsShare {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SecretsShare")
            .field("has_ssh_password", &self.ssh_password.is_some())
            .field("has_private_key", &self.private_key.is_some())
            .field("has_passphrase", &self.passphrase.is_some())
            .field("has_database_password", &self.database_password.is_some())
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HostKeyShare {
    pub fingerprint: String,
    pub algorithm: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DbTargetShare {
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub socket: Option<String>,
}

impl From<DbTargetShare> for DbTarget {
    fn from(value: DbTargetShare) -> Self {
        Self {
            engine: value.engine,
            host: value.host,
            port: value.port,
            user: value.user,
            socket: value.socket,
        }
    }
}

impl From<DbTarget> for DbTargetShare {
    fn from(value: DbTarget) -> Self {
        Self {
            engine: value.engine,
            host: value.host,
            port: value.port,
            user: value.user,
            socket: value.socket,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConnectionShare {
    pub share_entry_id: String,
    pub profile: ProfileShare,
    #[serde(default)]
    pub secrets: Option<SecretsShare>,
    #[serde(default)]
    pub key_path_hint: Option<String>,
    #[serde(default)]
    pub host_key: Option<HostKeyShare>,
    #[serde(default)]
    pub database: Option<DbTargetShare>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SharePayload {
    pub protocol: u32,
    pub kind: String,
    #[serde(default)]
    pub origin: Option<OriginInfo>,
    pub connections: Vec<ConnectionShare>,
    #[serde(default)]
    pub extensions: serde_json::Map<String, serde_json::Value>,
}

#[allow(dead_code)]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToketeoSshConfig {
    pub host: String,
    pub port: u16,
    pub user: String,
    pub auth_type: AuthMethod,
    pub private_key: Option<String>,
    pub passphrase: Option<String>,
    pub password: Option<String>,
}

impl std::fmt::Debug for ToketeoSshConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToketeoSshConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("auth_type", &self.auth_type)
            .finish()
    }
}

#[allow(dead_code)]
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ToketeoDbConnectionConfig {
    #[serde(rename = "type")]
    pub db_type: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: Option<String>,
    pub ssh: ToketeoSshConfig,
}

impl std::fmt::Debug for ToketeoDbConnectionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ToketeoDbConnectionConfig")
            .field("db_type", &self.db_type)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("ssh", &self.ssh)
            .finish()
    }
}

pub fn share_entry_id(host: &str, port: u16, username: &str) -> String {
    let normalized_host = host.trim().to_ascii_lowercase();
    let name = format!("{normalized_host}|{port}|{username}");
    Uuid::new_v5(&SHARE_ENTRY_NAMESPACE, name.as_bytes()).to_string()
}

pub fn sanitize_key_path_hint(path: &str) -> Option<String> {
    let file_name = std::path::Path::new(path.trim())
        .file_name()
        .and_then(|n| n.to_str())?;
    if file_name.is_empty() || file_name.len() > 128 {
        return None;
    }
    if file_name
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        Some(file_name.to_string())
    } else {
        None
    }
}

fn truncate_utf8_bytes(input: &str, max_bytes: usize) -> String {
    if input.len() <= max_bytes {
        return input.to_string();
    }
    let mut end = max_bytes;
    while !input.is_char_boundary(end) {
        end -= 1;
    }
    input[..end].to_string()
}

pub fn is_valid_hex_color(color: &str) -> bool {
    color.len() == 7 && color.starts_with('#') && color[1..].chars().all(|c| c.is_ascii_hexdigit())
}

pub fn normalize_profile_for_export(profile: &ConnectionProfile) -> ProfileShare {
    let raw_name = if profile.name.trim().is_empty() {
        format!("{}@{}", profile.username.trim(), profile.host.trim())
    } else {
        profile.name.trim().to_string()
    };
    let clean_name: String = raw_name.chars().filter(|c| !c.is_control()).collect();
    let name = truncate_utf8_bytes(&clean_name, 120);

    let env_lower = profile.environment.trim().to_ascii_lowercase();
    let environment = match env_lower.as_str() {
        "development" | "staging" | "production" | "local" => env_lower,
        _ => "local".to_string(),
    };

    let color = if is_valid_hex_color(&profile.color) {
        profile.color.clone()
    } else {
        "#F97316".to_string()
    };

    let tags = profile
        .tags
        .iter()
        .map(|t| {
            let clean: String = t.trim().chars().filter(|c| !c.is_control()).collect();
            truncate_utf8_bytes(&clean, 32)
        })
        .filter(|t| !t.is_empty())
        .take(16)
        .collect();

    let base_delay_ms = profile.retry.base_delay_ms.clamp(1, 60_000);
    let max_delay_ms = profile.retry.max_delay_ms.clamp(base_delay_ms, 300_000);

    ProfileShare {
        name: if name.is_empty() {
            "server".to_string()
        } else {
            name
        },
        host: profile.host.trim().to_string(),
        port: if profile.port == 0 { 22 } else { profile.port },
        username: profile.username.trim().to_string(),
        auth_method: profile.auth_method,
        environment,
        color,
        tags,
        keepalive_secs: profile.keepalive_secs.min(3_600),
        connect_timeout_secs: profile.connect_timeout_secs.clamp(1, 300),
        retry: RetryShare {
            max_retries: profile.retry.max_retries.min(10),
            base_delay_ms,
            max_delay_ms,
            jitter: profile.retry.jitter,
        },
        pool: PoolShare {
            max_connections: profile.pool.max_connections.clamp(1, 32),
            acquire_timeout_ms: profile.pool.acquire_timeout_ms.clamp(500, 300_000),
            idle_timeout_secs: profile.pool.idle_timeout_secs.min(3_600),
        },
        elevated: profile.elevated,
    }
}

impl ConnectionShare {
    pub fn to_connection_profile(&self, id: String, preserve_share_id: bool) -> ConnectionProfile {
        let mut password = None;
        let mut private_key = None;
        let mut passphrase = None;
        if let Some(sec) = &self.secrets {
            password = sec.ssh_password.clone().filter(|s| !s.is_empty());
            private_key = sec.private_key.clone().filter(|s| !s.is_empty());
            passphrase = sec.passphrase.clone().filter(|s| !s.is_empty());
        }

        ConnectionProfile {
            id,
            name: self.profile.name.clone(),
            host: self.profile.host.clone(),
            port: self.profile.port,
            username: self.profile.username.clone(),
            auth_method: self.profile.auth_method,
            password,
            private_key,
            passphrase,
            key_path: None,
            clear_private_key: false,
            clear_key_path: false,
            color: self.profile.color.clone(),
            environment: self.profile.environment.clone(),
            tags: self.profile.tags.clone(),
            retry: RetryPolicy {
                max_retries: self.profile.retry.max_retries,
                base_delay_ms: self.profile.retry.base_delay_ms,
                max_delay_ms: self.profile.retry.max_delay_ms,
                jitter: self.profile.retry.jitter,
            },
            pool: PoolSettings {
                max_connections: self.profile.pool.max_connections,
                acquire_timeout_ms: self.profile.pool.acquire_timeout_ms,
                idle_timeout_secs: self.profile.pool.idle_timeout_secs,
            },
            keepalive_secs: self.profile.keepalive_secs,
            connect_timeout_secs: self.profile.connect_timeout_secs,
            elevated: self.profile.elevated,
            source_share_id: preserve_share_id.then(|| self.share_entry_id.clone()),
            db_target: self.database.clone().map(DbTarget::from),
            created_at: 0,
            updated_at: 0,
        }
    }

    #[allow(dead_code)]
    pub fn to_toketeo_handoff(&self) -> Option<ToketeoDbConnectionConfig> {
        let db = self.database.as_ref()?;
        let normalized_db_host = if db.host.eq_ignore_ascii_case("localhost") {
            "127.0.0.1".to_string()
        } else {
            db.host.clone()
        };
        let secrets = self.secrets.as_ref();
        let ssh_password = if self.profile.auth_method == AuthMethod::Password {
            secrets.and_then(|s| s.ssh_password.clone())
        } else {
            None
        };

        Some(ToketeoDbConnectionConfig {
            db_type: db.engine.clone(),
            host: normalized_db_host,
            port: db.port,
            user: db.user.clone(),
            password: secrets.and_then(|s| s.database_password.clone()),
            ssh: ToketeoSshConfig {
                host: self.profile.host.clone(),
                port: self.profile.port,
                user: self.profile.username.clone(),
                auth_type: self.profile.auth_method,
                private_key: secrets.and_then(|s| s.private_key.clone()),
                passphrase: secrets.and_then(|s| s.passphrase.clone()),
                password: ssh_password,
            },
        })
    }
}

pub fn parse_and_validate_payload(raw: &[u8], mode: ShareMode) -> AppResult<SharePayload> {
    if raw.len() > MAX_PLAINTEXT_BYTES {
        return Err(AppError::share(
            "SHARE_TOO_LARGE",
            "decrypted payload exceeds 1 MiB limit",
        ));
    }
    let mut payload: SharePayload = serde_json::from_slice(raw).map_err(|e| {
        AppError::share(
            "SHARE_PAYLOAD_INVALID",
            format!("invalid share payload JSON: {e}"),
        )
    })?;
    payload.validate_and_normalize(mode)?;
    Ok(payload)
}

impl SharePayload {
    pub fn validate_and_normalize(&mut self, mode: ShareMode) -> AppResult<()> {
        if self.protocol != 1 {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "unsupported payload protocol version",
            ));
        }
        if self.kind != "connection-share" {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "invalid payload kind",
            ));
        }
        if let Some(origin) = &self.origin {
            if origin.app != "2shell"
                || origin.version.is_empty()
                || origin.version.len() > 32
                || !matches!(origin.platform.as_str(), "linux" | "macos" | "windows")
            {
                return Err(AppError::share(
                    "SHARE_PAYLOAD_INVALID",
                    "invalid origin metadata",
                ));
            }
        }
        if self.connections.is_empty() || self.connections.len() > 32 {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "connections count must be between 1 and 32",
            ));
        }

        for conn in &mut self.connections {
            validate_connection(conn, mode)?;
        }

        Ok(())
    }
}

fn validate_connection(conn: &mut ConnectionShare, mode: ShareMode) -> AppResult<()> {
    validate_profile(&conn.profile)?;

    let expected_id = share_entry_id(
        &conn.profile.host,
        conn.profile.port,
        &conn.profile.username,
    );
    if conn.share_entry_id != expected_id {
        return Err(AppError::share(
            "SHARE_ENTRY_INVALID",
            "shareEntryId does not match computed endpoint UUID v5",
        ));
    }

    if let Some(hint) = &conn.key_path_hint {
        if hint.is_empty()
            || hint.len() > 128
            || hint.contains('/')
            || hint.contains('\\')
            || hint.contains(':')
            || !hint
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
        {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "invalid keyPathHint",
            ));
        }
    }

    if let Some(hk) = &conn.host_key {
        validate_host_key(hk)?;
    }

    if let Some(db) = &conn.database {
        validate_database(db)?;
    }

    match mode {
        ShareMode::Metadata => {
            if conn.secrets.is_some() {
                return Err(AppError::share(
                    "SHARE_PAYLOAD_INVALID",
                    "secrets must be null in metadata mode",
                ));
            }
        }
        ShareMode::Secrets => {
            if let Some(sec) = &mut conn.secrets {
                normalize_and_validate_secrets(sec, conn.database.is_some())?;
            }
        }
    }

    Ok(())
}

fn validate_profile(p: &ProfileShare) -> AppResult<()> {
    if p.name.is_empty() || p.name.len() > 120 || p.name.chars().any(|c| c.is_control()) {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid profile name",
        ));
    }
    if p.host.is_empty()
        || p.host.len() > 255
        || p.host.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid profile host",
        ));
    }
    if p.port == 0 {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid profile port",
        ));
    }
    if p.username.is_empty()
        || p.username.len() > 128
        || p.username
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid profile username",
        ));
    }
    if !matches!(
        p.environment.as_str(),
        "development" | "staging" | "production" | "local"
    ) {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid profile environment",
        ));
    }
    if !is_valid_hex_color(&p.color) {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid profile color",
        ));
    }
    if p.tags.len() > 16 {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "too many profile tags",
        ));
    }
    for tag in &p.tags {
        if tag.is_empty() || tag.len() > 32 || tag.chars().any(|c| c.is_control()) {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "invalid profile tag",
            ));
        }
    }
    if p.keepalive_secs > 3_600 {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "keepaliveSecs out of range",
        ));
    }
    if !(1..=300).contains(&p.connect_timeout_secs) {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "connectTimeoutSecs out of range",
        ));
    }
    if p.retry.max_retries > 10
        || !(1..=60_000).contains(&p.retry.base_delay_ms)
        || p.retry.max_delay_ms < p.retry.base_delay_ms
        || p.retry.max_delay_ms > 300_000
    {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "retry settings out of range",
        ));
    }
    if !(1..=32).contains(&p.pool.max_connections)
        || !(500..=300_000).contains(&p.pool.acquire_timeout_ms)
        || p.pool.idle_timeout_secs > 3_600
    {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "pool settings out of range",
        ));
    }
    Ok(())
}

fn validate_host_key(hk: &HostKeyShare) -> AppResult<()> {
    let Some(rest) = hk.fingerprint.strip_prefix("SHA256:") else {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid hostKey fingerprint prefix",
        ));
    };
    let trimmed = rest.strip_suffix('=').unwrap_or(rest);
    if trimmed.len() != 43
        || !trimmed
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || c == '+' || c == '/')
    {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid hostKey fingerprint",
        ));
    }
    if let Some(alg) = &hk.algorithm {
        if alg.is_empty()
            || alg.len() > 64
            || !alg
                .chars()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-')
        {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "invalid hostKey algorithm",
            ));
        }
    }
    Ok(())
}

fn validate_database(db: &DbTargetShare) -> AppResult<()> {
    if !matches!(db.engine.as_str(), "mariadb" | "mysql") {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid database engine",
        ));
    }
    if db.host.is_empty()
        || db.host.len() > 255
        || db.host.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid database host",
        ));
    }
    if db.port == 0 {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid database port",
        ));
    }
    if db.user.is_empty()
        || db.user.len() > 128
        || db.user.chars().any(|c| c.is_whitespace() || c.is_control())
    {
        return Err(AppError::share(
            "SHARE_PAYLOAD_INVALID",
            "invalid database user",
        ));
    }
    if let Some(socket) = &db.socket {
        if socket.is_empty()
            || socket.len() > 255
            || !socket.starts_with('/')
            || socket.chars().any(|c| c.is_control())
        {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "invalid database socket path",
            ));
        }
    }
    Ok(())
}

fn normalize_and_validate_secrets(sec: &mut SecretsShare, has_database: bool) -> AppResult<()> {
    if sec.ssh_password.as_deref() == Some("") {
        sec.ssh_password = None;
    }
    if sec.private_key.as_deref() == Some("") {
        sec.private_key = None;
    }
    if sec.passphrase.as_deref() == Some("") {
        sec.passphrase = None;
    }
    if sec.database_password.as_deref() == Some("") {
        sec.database_password = None;
    }

    if let Some(pw) = &sec.ssh_password {
        if pw.len() > 4_096 {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "sshPassword exceeds maximum length",
            ));
        }
    }
    if let Some(pk) = &sec.private_key {
        if pk.len() > 65_536 || !pk.starts_with("-----BEGIN") {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "privateKey must start with -----BEGIN and not exceed 64 KiB",
            ));
        }
    }
    if let Some(pp) = &sec.passphrase {
        if pp.len() > 4_096 {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "passphrase exceeds maximum length",
            ));
        }
    }
    if let Some(db_pw) = &sec.database_password {
        if !has_database {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "databasePassword is not allowed without database target",
            ));
        }
        if db_pw.len() > 4_096 {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "databasePassword exceeds maximum length",
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const KAT_PLAINTEXT: &str = r##"{"protocol":1,"kind":"connection-share","origin":{"app":"2shell","version":"0.2.0","platform":"linux"},"connections":[{"shareEntryId":"47643f34-d009-5253-8ec8-665ac82948b0","profile":{"name":"demo","host":"203.0.113.10","port":22,"username":"root","authMethod":"password","environment":"production","color":"#F97316","tags":["cliente"],"keepaliveSecs":30,"connectTimeoutSecs":15,"retry":{"maxRetries":3,"baseDelayMs":250,"maxDelayMs":5000,"jitter":true},"pool":{"maxConnections":4,"acquireTimeoutMs":10000,"idleTimeoutSecs":300},"elevated":false},"secrets":{"sshPassword":"s3cr3t","privateKey":null,"passphrase":null,"databasePassword":null},"keyPathHint":null,"hostKey":{"fingerprint":"SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","algorithm":"ssh-ed25519"},"database":{"engine":"mariadb","host":"localhost","port":3306,"user":"root","socket":null}}],"extensions":{}}"##;

    #[test]
    fn computes_deterministic_share_entry_id() {
        assert_eq!(
            share_entry_id("203.0.113.10", 22, "root"),
            "47643f34-d009-5253-8ec8-665ac82948b0"
        );
        assert_eq!(
            share_entry_id("  EXAMPLE.COM ", 2222, "Deploy"),
            share_entry_id("example.com", 2222, "Deploy")
        );
        assert_ne!(
            share_entry_id("example.com", 2222, "Deploy"),
            share_entry_id("example.com", 2222, "deploy")
        );
    }

    #[test]
    fn parses_kat_payload_and_projects_to_toketeo() {
        let payload =
            parse_and_validate_payload(KAT_PLAINTEXT.as_bytes(), ShareMode::Secrets).unwrap();
        assert_eq!(payload.connections.len(), 1);
        let conn = &payload.connections[0];
        let handoff = conn.to_toketeo_handoff().unwrap();
        assert_eq!(handoff.host, "127.0.0.1");
        assert_eq!(handoff.port, 3306);
        assert_eq!(handoff.db_type, "mariadb");
        assert_eq!(handoff.ssh.host, "203.0.113.10");
        assert_eq!(handoff.ssh.password.as_deref(), Some("s3cr3t"));
    }

    #[test]
    fn rejects_invalid_payload_cases() {
        let bad_entry = KAT_PLAINTEXT.replace(
            "47643f34-d009-5253-8ec8-665ac82948b0",
            "00000000-0000-5000-8000-000000000000",
        );
        assert_eq!(
            parse_and_validate_payload(bad_entry.as_bytes(), ShareMode::Secrets)
                .unwrap_err()
                .share_code(),
            Some("SHARE_ENTRY_INVALID")
        );

        assert_eq!(
            parse_and_validate_payload(KAT_PLAINTEXT.as_bytes(), ShareMode::Metadata)
                .unwrap_err()
                .share_code(),
            Some("SHARE_PAYLOAD_INVALID")
        );

        let db_pass_without_db = KAT_PLAINTEXT
            .replace(r#""databasePassword":null"#, r#""databasePassword":"dbpw""#)
            .replace(
                r#""database":{"engine":"mariadb","host":"localhost","port":3306,"user":"root","socket":null}"#,
                r#""database":null"#,
            );
        assert_eq!(
            parse_and_validate_payload(db_pass_without_db.as_bytes(), ShareMode::Secrets)
                .unwrap_err()
                .share_code(),
            Some("SHARE_PAYLOAD_INVALID")
        );

        let unknown_field =
            KAT_PLAINTEXT.replace(r#""elevated":false"#, r#""elevated":false,"extra":1"#);
        assert_eq!(
            parse_and_validate_payload(unknown_field.as_bytes(), ShareMode::Secrets)
                .unwrap_err()
                .share_code(),
            Some("SHARE_PAYLOAD_INVALID")
        );
    }
}
