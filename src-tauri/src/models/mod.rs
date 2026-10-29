use serde::{Deserialize, Serialize};

pub const REDACTED: &str = "********";

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, Default)]
#[serde(rename_all = "lowercase")]
pub enum AuthMethod {
    #[default]
    Password,
    Key,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RetryPolicy {
    pub max_retries: u32,
    pub base_delay_ms: u64,
    pub max_delay_ms: u64,
    pub jitter: bool,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_retries: 3,
            base_delay_ms: 400,
            max_delay_ms: 8_000,
            jitter: true,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolSettings {
    pub max_connections: u32,
    pub acquire_timeout_ms: u64,
    pub idle_timeout_secs: u64,
}

impl Default for PoolSettings {
    fn default() -> Self {
        Self {
            max_connections: 4,
            acquire_timeout_ms: 10_000,
            idle_timeout_secs: 300,
        }
    }
}

/// A remote host profile. Secret fields are populated only while the profile is
/// in memory (between decryption and use) and are marked `skip_serializing`, so
/// they can never leak through a Tauri event or command response.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub host: String,
    #[serde(default = "default_port")]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub auth_method: AuthMethod,
    #[serde(default, skip_serializing)]
    pub password: Option<String>,
    #[serde(default, skip_serializing)]
    pub private_key: Option<String>,
    #[serde(default, skip_serializing)]
    pub passphrase: Option<String>,
    #[serde(default)]
    pub key_path: Option<String>,
    /// UI intent flags (never persisted): remove a stored inline key when the
    /// user switches to a key file, or remove the path when pasting a key.
    #[serde(default, skip_serializing)]
    pub clear_private_key: bool,
    #[serde(default, skip_serializing)]
    pub clear_key_path: bool,
    #[serde(default = "default_color")]
    pub color: String,
    #[serde(default = "default_environment")]
    pub environment: String,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub retry: RetryPolicy,
    #[serde(default)]
    pub pool: PoolSettings,
    #[serde(default = "default_keepalive")]
    pub keepalive_secs: u64,
    #[serde(default = "default_connect_timeout")]
    pub connect_timeout_secs: u64,
    /// Prefix privileged service commands with `sudo -n` (passwordless sudo).
    #[serde(default)]
    pub elevated: bool,
    #[serde(default)]
    pub created_at: i64,
    #[serde(default)]
    pub updated_at: i64,
}

fn default_port() -> u16 {
    22
}
fn default_color() -> String {
    "#5eead4".to_string()
}
fn default_environment() -> String {
    "development".to_string()
}
fn default_keepalive() -> u64 {
    20
}
fn default_connect_timeout() -> u64 {
    12
}

impl Default for ConnectionProfile {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            host: String::new(),
            port: default_port(),
            username: String::new(),
            auth_method: AuthMethod::Password,
            password: None,
            private_key: None,
            passphrase: None,
            key_path: None,
            clear_private_key: false,
            clear_key_path: false,
            color: default_color(),
            environment: default_environment(),
            tags: Vec::new(),
            retry: RetryPolicy::default(),
            pool: PoolSettings::default(),
            keepalive_secs: default_keepalive(),
            connect_timeout_secs: default_connect_timeout(),
            elevated: false,
            created_at: 0,
            updated_at: 0,
        }
    }
}

impl ConnectionProfile {
    pub fn view(&self) -> ProfileView {
        ProfileView {
            id: self.id.clone(),
            name: self.name.clone(),
            host: self.host.clone(),
            port: self.port,
            username: self.username.clone(),
            auth_method: self.auth_method,
            key_path: self.key_path.clone(),
            color: self.color.clone(),
            environment: self.environment.clone(),
            tags: self.tags.clone(),
            retry: self.retry.clone(),
            pool: self.pool.clone(),
            keepalive_secs: self.keepalive_secs,
            connect_timeout_secs: self.connect_timeout_secs,
            elevated: self.elevated,
            created_at: self.created_at,
            updated_at: self.updated_at,
            has_password: self
                .password
                .as_ref()
                .map(|v| !v.is_empty() && v != REDACTED)
                .unwrap_or(false),
            has_private_key: self
                .private_key
                .as_ref()
                .map(|v| !v.is_empty() && v != REDACTED)
                .unwrap_or(false)
                || self
                    .key_path
                    .as_deref()
                    .map(|path| !path.trim().is_empty())
                    .unwrap_or(false),
            has_passphrase: self
                .passphrase
                .as_ref()
                .map(|v| !v.is_empty() && v != REDACTED)
                .unwrap_or(false),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileView {
    pub id: String,
    pub name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_method: AuthMethod,
    pub key_path: Option<String>,
    pub color: String,
    pub environment: String,
    pub tags: Vec<String>,
    pub retry: RetryPolicy,
    pub pool: PoolSettings,
    pub keepalive_secs: u64,
    pub connect_timeout_secs: u64,
    pub elevated: bool,
    pub created_at: i64,
    pub updated_at: i64,
    pub has_password: bool,
    pub has_private_key: bool,
    pub has_passphrase: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecutionLog {
    pub id: i64,
    pub timestamp: i64,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub category: String,
    pub action: String,
    pub target: Option<String>,
    pub command: Option<String>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub metadata: Option<serde_json::Value>,
}

#[derive(Debug, Clone)]
pub struct NewExecutionLog {
    pub timestamp: i64,
    pub profile_id: Option<String>,
    pub profile_name: Option<String>,
    pub category: String,
    pub action: String,
    pub target: Option<String>,
    pub command: Option<String>,
    pub status: String,
    pub exit_code: Option<i32>,
    pub duration_ms: Option<u64>,
    pub output: Option<String>,
    pub error: Option<String>,
    pub metadata_json: Option<String>,
}

#[derive(Debug, Clone)]
pub struct LogFilter {
    pub profile_id: Option<String>,
    pub category: Option<String>,
    pub status: Option<String>,
    pub search: Option<String>,
    pub limit: u32,
    pub offset: u32,
}

impl Default for LogFilter {
    fn default() -> Self {
        Self {
            profile_id: None,
            category: None,
            status: None,
            search: None,
            limit: 250,
            offset: 0,
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LargeFile {
    pub path: String,
    pub size_human: String,
    pub size_bytes: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProperties {
    pub path: String,
    pub file_type: String,
    pub size_bytes: u64,
    pub size_human: String,
    pub disk_usage_human: String,
    pub owner: String,
    pub group: String,
    pub mode: String,
    pub modified: String,
    pub accessed: String,
    pub inode: u64,
    pub links: u64,
    pub target: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileDeleteResult {
    pub path: String,
    pub ok: bool,
    pub output: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessLocation {
    pub pid: u32,
    pub cwd: Option<String>,
    pub exe: Option<String>,
    pub command: String,
    pub directory: String,
    pub accessible: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessKillResult {
    pub pid: u32,
    pub signal: String,
    pub ok: bool,
    pub output: String,
    pub exit_code: i32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KeyProbe {
    pub path: String,
    pub exists: bool,
    pub encrypted: bool,
    pub valid: bool,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExecOutput {
    pub stdout: String,
    pub stderr: String,
    pub exit_status: i32,
}

impl ExecOutput {
    pub fn success(&self) -> bool {
        self.exit_status == 0
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DetectedWebServer {
    pub name: String,
    pub binary: String,
    pub version: String,
    pub active: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub hostname: String,
    pub os_name: String,
    pub os_version: String,
    pub distro_id: String,
    pub distro_family: String,
    pub kernel: String,
    pub arch: String,
    pub init_system: String,
    pub package_manager: String,
    pub shell: String,
    pub username: String,
    pub is_container: bool,
    pub cpu_model: String,
    pub cpu_count: u32,
    pub mem_total_kb: u64,
    pub web_servers: Vec<DetectedWebServer>,
    pub fingerprint: String,
    pub latency_ms: u64,
    pub detected_at: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolStats {
    pub profile_id: String,
    pub max_connections: u32,
    pub total: u32,
    pub idle: u32,
    pub in_use: u32,
    pub acquire_timeout_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalInfo {
    pub session_id: String,
    pub profile_id: String,
    pub title: String,
    pub cols: u32,
    pub rows: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CpuCore {
    pub name: String,
    pub usage: f32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProcessInfo {
    pub pid: u32,
    pub user: String,
    pub cpu: f32,
    pub mem: f32,
    pub rss_kb: u64,
    pub command: String,
}

#[derive(Debug, Clone, Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct MetricsSnapshot {
    pub timestamp: i64,
    pub hostname: String,
    pub kernel: String,
    pub uptime_secs: u64,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub cpu_total: f32,
    pub cores: Vec<CpuCore>,
    pub mem_total_kb: u64,
    pub mem_used_kb: u64,
    pub mem_available_kb: u64,
    pub swap_total_kb: u64,
    pub swap_used_kb: u64,
    pub net_rx_bps: f64,
    pub net_tx_bps: f64,
    pub disk_total_kb: u64,
    pub disk_used_kb: u64,
    pub processes: Vec<ProcessInfo>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WebServiceInfo {
    pub name: String,
    pub installed: bool,
    pub binary: String,
    pub version: String,
    pub active: bool,
    pub service_unit: String,
    pub config_root: String,
    pub config_file: String,
    pub log_file: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceStatus {
    pub service: String,
    pub installed: bool,
    pub active: bool,
    pub state: String,
    pub pid: Option<u32>,
    pub detail: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigEntry {
    pub path: String,
    pub size: u64,
    pub modified: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigContent {
    pub path: String,
    pub content: String,
    pub truncated: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceActionResult {
    pub ok: bool,
    pub action: String,
    pub output: String,
    pub exit_code: i32,
    pub backup_path: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TestResult {
    pub ok: bool,
    pub latency_ms: u64,
    pub server: Option<ServerInfo>,
    pub error: Option<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn secrets_never_survive_serialization() {
        let profile = ConnectionProfile {
            id: "p1".into(),
            host: "example.com".into(),
            password: Some("hunter2".into()),
            private_key: Some("KEY".into()),
            passphrase: Some("pp".into()),
            ..Default::default()
        };
        let json = serde_json::to_string(&profile).unwrap();
        assert!(!json.contains("hunter2"));
        assert!(!json.contains("KEY"));
        assert!(!json.contains("pp"));
        let view = profile.view();
        assert!(view.has_password);
        assert!(view.has_private_key);
        assert!(view.has_passphrase);
    }

    #[test]
    fn redacted_values_report_as_missing() {
        let profile = ConnectionProfile {
            password: Some(REDACTED.into()),
            ..Default::default()
        };
        assert!(!profile.view().has_password);
    }
}
