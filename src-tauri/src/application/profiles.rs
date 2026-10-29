use crate::error::{AppError, AppResult};
use crate::infrastructure::crypto::SecretBox;
use crate::infrastructure::storage::Storage;
use crate::models::{
    ConnectionProfile, DetectedWebServer, ProfileView, ServerInfo, TestResult, REDACTED,
};
use crate::ssh::SshConnection;
use chrono::Utc;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};
use uuid::Uuid;

#[derive(Debug, Default, Serialize, Deserialize)]
struct SecretPayload {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    password: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    private_key: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    passphrase: Option<String>,
}

impl SecretPayload {
    fn is_empty(&self) -> bool {
        self.password.is_none() && self.private_key.is_none() && self.passphrase.is_none()
    }
}

pub struct ProfileService {
    storage: Arc<Storage>,
    secrets: Arc<SecretBox>,
}

impl ProfileService {
    pub fn new(storage: Arc<Storage>, secrets: Arc<SecretBox>) -> Self {
        Self { storage, secrets }
    }

    pub fn list(&self) -> Vec<ProfileView> {
        self.storage
            .list_stored()
            .into_iter()
            .map(|(profile, blob)| {
                let mut profile = profile;
                if let Some(blob) = blob {
                    if let Ok(plain) = self.decrypt_payload(&blob) {
                        // Materialize placeholders so the view can report which
                        // credentials exist without exposing their values.
                        if plain.password.is_some() {
                            profile.password = Some(REDACTED.to_string());
                        }
                        if plain.private_key.is_some() {
                            profile.private_key = Some(REDACTED.to_string());
                        }
                        if plain.passphrase.is_some() {
                            profile.passphrase = Some(REDACTED.to_string());
                        }
                    }
                }
                profile.view()
            })
            .collect()
    }

    pub fn get(&self, id: &str) -> AppResult<ConnectionProfile> {
        let (mut profile, blob) = self
            .storage
            .get_stored(id)
            .ok_or_else(|| AppError::NotFound(format!("profile {id} does not exist")))?;

        if let Some(blob) = blob {
            let plain = self.decrypt_payload(&blob)?;
            profile.password = plain.password;
            profile.private_key = plain.private_key;
            profile.passphrase = plain.passphrase;
        }
        Ok(profile)
    }

    pub fn save(&self, mut input: ConnectionProfile) -> AppResult<ProfileView> {
        let now = Utc::now().timestamp();

        if input.id.trim().is_empty() {
            input.id = Uuid::new_v4().to_string();
        }

        if input.name.trim().is_empty() {
            input.name = if input.username.is_empty() {
                input.host.clone()
            } else {
                format!("{}@{}", input.username, input.host)
            };
        }
        input.name = input.name.trim().to_string();
        input.host = input.host.trim().to_string();
        input.username = input.username.trim().to_string();
        input.environment = input.environment.trim().to_lowercase();
        input.key_path = input
            .key_path
            .as_deref()
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_string);

        self.merge_existing_secrets(&mut input);
        self.validate(&input)?;

        let existing = self.storage.get_stored(&input.id);
        input.created_at = existing
            .as_ref()
            .map(|(p, _)| p.created_at)
            .filter(|ts| *ts > 0)
            .unwrap_or(now);
        input.updated_at = now;

        let payload = SecretPayload {
            password: non_empty(input.password.clone()),
            private_key: non_empty(input.private_key.clone()),
            passphrase: non_empty(input.passphrase.clone()),
        };
        let secret_blob = if payload.is_empty() {
            None
        } else {
            Some(self.encrypt_payload(&payload)?)
        };

        let view = input.view();
        self.storage.upsert(input, secret_blob)?;
        Ok(view)
    }

    pub fn delete(&self, id: &str) -> AppResult<()> {
        let removed = self.storage.delete(id)?;
        if !removed {
            return Err(AppError::NotFound(format!("profile {id} does not exist")));
        }
        Ok(())
    }

    /// Used by "test connection": reuse stored credentials when the form sends
    /// empty or redacted secret fields.
    pub fn resolve_for_connection(
        &self,
        mut input: ConnectionProfile,
    ) -> AppResult<ConnectionProfile> {
        self.merge_existing_secrets(&mut input);
        if input.id.trim().is_empty() {
            input.id = Uuid::new_v4().to_string();
        }
        if input.name.trim().is_empty() {
            input.name = format!("{}@{}", input.username, input.host);
        }
        self.validate(&input)?;
        Ok(input)
    }

    pub async fn test(&self, input: ConnectionProfile) -> TestResult {
        let started = Instant::now();
        let profile = match self.resolve_for_connection(input) {
            Ok(profile) => profile,
            Err(error) => {
                return TestResult {
                    ok: false,
                    latency_ms: started.elapsed().as_millis() as u64,
                    server: None,
                    error: Some(error.to_string()),
                }
            }
        };

        let known_hosts = crate::ssh::KnownHostsStore::new(self.storage.clone());
        match SshConnection::connect(&profile, Arc::new(known_hosts)).await {
            Ok(connection) => match self.detect_server(&connection).await {
                Ok(server) => TestResult {
                    ok: true,
                    latency_ms: started.elapsed().as_millis() as u64,
                    server: Some(server),
                    error: None,
                },
                Err(error) => TestResult {
                    ok: true,
                    latency_ms: started.elapsed().as_millis() as u64,
                    server: None,
                    error: Some(format!("connected, but server detection failed: {error}")),
                },
            },
            Err(error) => TestResult {
                ok: false,
                latency_ms: started.elapsed().as_millis() as u64,
                server: None,
                error: Some(error.to_string()),
            },
        }
    }

    pub async fn detect_server(&self, connection: &SshConnection) -> AppResult<ServerInfo> {
        let started = Instant::now();
        let output = connection
            .exec(DETECT_SCRIPT, Duration::from_secs(20))
            .await?;
        if !output.success() && output.stdout.trim().is_empty() {
            return Err(AppError::Remote(format!(
                "detection command failed (exit {}): {}",
                output.exit_status,
                output.stderr.trim()
            )));
        }

        let mut info = parse_server_info(&output.stdout)?;
        info.fingerprint = connection.fingerprint.clone();
        info.latency_ms = started.elapsed().as_millis() as u64;
        info.detected_at = Utc::now().timestamp();
        Ok(info)
    }

    fn validate(&self, profile: &ConnectionProfile) -> AppResult<()> {
        if profile.host.is_empty() {
            return Err(AppError::Validation("host is required".into()));
        }
        if profile
            .host
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(AppError::Validation(
                "host must not contain spaces or control characters".into(),
            ));
        }
        if profile.port == 0 {
            return Err(AppError::Validation(
                "port must be between 1 and 65535".into(),
            ));
        }
        if profile.username.is_empty() {
            return Err(AppError::Validation("username is required".into()));
        }
        if profile
            .username
            .chars()
            .any(|c| c.is_whitespace() || c.is_control())
        {
            return Err(AppError::Validation(
                "username must not contain spaces or control characters".into(),
            ));
        }
        if profile.pool.max_connections == 0 || profile.pool.max_connections > 32 {
            return Err(AppError::Validation(
                "pool size must be between 1 and 32".into(),
            ));
        }
        if profile.pool.acquire_timeout_ms < 500 {
            return Err(AppError::Validation(
                "pool acquire timeout must be at least 500 ms".into(),
            ));
        }
        if profile.retry.base_delay_ms == 0
            || profile.retry.max_delay_ms < profile.retry.base_delay_ms
        {
            return Err(AppError::Validation(
                "retry max delay must be >= base delay (and base delay > 0)".into(),
            ));
        }
        if profile.retry.max_retries > 10 {
            return Err(AppError::Validation(
                "retry count must be between 0 and 10".into(),
            ));
        }
        if profile.connect_timeout_secs < 3 || profile.connect_timeout_secs > 120 {
            return Err(AppError::Validation(
                "connect timeout must be between 3 and 120 seconds".into(),
            ));
        }
        if profile.keepalive_secs > 600 {
            return Err(AppError::Validation(
                "keepalive interval must be <= 600 seconds".into(),
            ));
        }
        Ok(())
    }

    fn merge_existing_secrets(&self, profile: &mut ConnectionProfile) {
        if profile.id.trim().is_empty() {
            return;
        }
        let Ok(existing) = self.get(&profile.id) else {
            return;
        };

        if needs_fallback(&profile.password) {
            profile.password = existing.password;
        }

        // The profile form allows either a key file or an inline key. When the
        // user switches source, do not resurrect the other stored credential.
        if profile.clear_private_key {
            profile.private_key = None;
        } else if needs_fallback(&profile.private_key) {
            profile.private_key = existing.private_key;
        }
        if profile.clear_key_path {
            profile.key_path = None;
        }

        if needs_fallback(&profile.passphrase) {
            profile.passphrase = existing.passphrase;
        }
    }

    fn encrypt_payload(&self, payload: &SecretPayload) -> AppResult<String> {
        let raw = serde_json::to_string(payload)?;
        self.secrets.encrypt(&raw)
    }

    fn decrypt_payload(&self, blob: &str) -> AppResult<SecretPayload> {
        let raw = self.secrets.decrypt(blob)?;
        serde_json::from_str(&raw)
            .map_err(|e| AppError::Storage(format!("corrupted credential payload: {e}")))
    }
}

fn non_empty(value: Option<String>) -> Option<String> {
    value.filter(|v| !v.is_empty() && v != REDACTED)
}

fn needs_fallback(value: &Option<String>) -> bool {
    match value {
        None => true,
        Some(v) => v.is_empty() || v == REDACTED,
    }
}

// ---------------------------------------------------------------------------
// Server detection
// ---------------------------------------------------------------------------

const DETECT_SCRIPT: &str = r#"export LC_ALL=C 2>/dev/null
echo __OS__
cat /etc/os-release 2>/dev/null
echo __UNAME__
uname -srm 2>/dev/null
echo __ARCH__
uname -m 2>/dev/null
echo __HOST__
hostname 2>/dev/null
echo __USER__
id -un 2>/dev/null
echo __INIT__
ps -p 1 -o comm= 2>/dev/null
echo __SHELL__
getent passwd "$(id -u)" 2>/dev/null | cut -d: -f7
echo __CPU__
grep -m1 'model name' /proc/cpuinfo 2>/dev/null | cut -d: -f2
echo __CORES__
(getconf _NPROCESSORS_ONLN 2>/dev/null || nproc 2>/dev/null) | head -n1
echo __MEM__
awk '/^MemTotal:/{print $2}' /proc/meminfo 2>/dev/null
echo __PKG__
for p in apt-get dnf yum apk pacman zypper; do command -v "$p" >/dev/null 2>&1 && { echo "$p"; break; }; done
echo __WEB__
for s in nginx apache2 httpd; do
  b=$(command -v "$s" 2>/dev/null) || continue
  v=$("$s" -v 2>&1 | head -n1 | tr -d '\r')
  a=$(systemctl is-active "$s" 2>/dev/null || echo unknown)
  echo "$s|$b|$v|$a"
done
echo __CONTAINER__
[ -f /.dockerenv ] && echo docker
grep -qaE 'docker|containerd|kubepods' /proc/1/cgroup 2>/dev/null && echo container
exit 0
"#;

fn collect_sections(output: &str) -> HashMap<String, Vec<String>> {
    let mut sections: HashMap<String, Vec<String>> = HashMap::new();
    let mut current = String::from("__HEAD__");
    for line in output.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("__") && trimmed.ends_with("__") && trimmed.len() > 4 {
            current = trimmed.trim_matches('_').to_string();
            sections.entry(current.clone()).or_default();
        } else {
            sections
                .entry(current.clone())
                .or_default()
                .push(line.trim_end().to_string());
        }
    }
    sections
}

fn first_line(sections: &HashMap<String, Vec<String>>, key: &str) -> String {
    sections
        .get(key)
        .and_then(|lines| lines.iter().find(|l| !l.trim().is_empty()))
        .map(|l| l.trim().to_string())
        .unwrap_or_default()
}

fn os_release(sections: &HashMap<String, Vec<String>>) -> HashMap<String, String> {
    let mut map = HashMap::new();
    if let Some(lines) = sections.get("OS") {
        for line in lines {
            let Some((key, value)) = line.split_once('=') else {
                continue;
            };
            let key = key.trim().to_string();
            if key.is_empty() || key.starts_with('#') {
                continue;
            }
            map.insert(key, value.trim().trim_matches('"').to_string());
        }
    }
    map
}

fn family_for(os: &HashMap<String, String>) -> String {
    let id = os.get("ID").map(|s| s.to_lowercase()).unwrap_or_default();
    let like = os
        .get("ID_LIKE")
        .map(|s| s.to_lowercase())
        .unwrap_or_default();
    let haystack = format!("{id} {like}");
    if haystack.contains("debian") || haystack.contains("ubuntu") {
        "debian".into()
    } else if haystack.contains("rhel")
        || haystack.contains("fedora")
        || haystack.contains("centos")
        || haystack.contains("rocky")
        || haystack.contains("alma")
    {
        "redhat".into()
    } else if haystack.contains("alpine") {
        "alpine".into()
    } else if haystack.contains("arch") {
        "arch".into()
    } else if haystack.contains("suse") {
        "suse".into()
    } else {
        "linux".into()
    }
}

pub fn parse_server_info(output: &str) -> AppResult<ServerInfo> {
    let sections = collect_sections(output);
    let os = os_release(&sections);

    let web_servers = sections
        .get("WEB")
        .map(|lines| {
            lines
                .iter()
                .filter_map(|line| {
                    let mut parts = line.splitn(4, '|');
                    let name = parts.next()?.trim();
                    let binary = parts.next()?.trim();
                    let version = parts.next()?.trim();
                    let active = parts.next().unwrap_or("unknown").trim() == "active";
                    if name.is_empty() || binary.is_empty() {
                        return None;
                    }
                    Some(DetectedWebServer {
                        name: name.to_string(),
                        binary: binary.to_string(),
                        version: version.to_string(),
                        active,
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();

    let cpu_model = first_line(&sections, "CPU");
    let cpu_count = first_line(&sections, "CORES").parse().unwrap_or(1);
    let mem_total_kb = first_line(&sections, "MEM").parse().unwrap_or(0);
    let init_system = first_line(&sections, "INIT");
    let uname_line = first_line(&sections, "UNAME");
    let kernel = uname_line
        .split_whitespace()
        .nth(1)
        .unwrap_or(&uname_line)
        .to_string();

    Ok(ServerInfo {
        hostname: first_line(&sections, "HOST"),
        os_name: os.get("PRETTY_NAME").cloned().unwrap_or_else(|| {
            let name = os.get("NAME").cloned().unwrap_or_else(|| "Linux".into());
            let version = os.get("VERSION").cloned().unwrap_or_default();
            if version.is_empty() {
                name
            } else {
                format!("{name} {version}")
            }
        }),
        os_version: os.get("VERSION_ID").cloned().unwrap_or_default(),
        distro_id: os.get("ID").cloned().unwrap_or_default(),
        distro_family: family_for(&os),
        kernel,
        arch: first_line(&sections, "ARCH"),
        init_system: if init_system.contains("systemd") {
            "systemd".into()
        } else if init_system.is_empty() {
            "unknown".into()
        } else {
            init_system
        },
        package_manager: first_line(&sections, "PKG"),
        shell: first_line(&sections, "SHELL"),
        username: first_line(&sections, "USER"),
        is_container: sections
            .get("CONTAINER")
            .map(|lines| lines.iter().any(|l| !l.trim().is_empty()))
            .unwrap_or(false),
        cpu_model: if cpu_model.is_empty() {
            "unknown".into()
        } else {
            cpu_model
        },
        cpu_count,
        mem_total_kb,
        web_servers,
        fingerprint: String::new(),
        latency_ms: 0,
        detected_at: 0,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::AuthMethod;

    const SAMPLE: &str = r#"__OS__
NAME="Ubuntu"
VERSION="24.04.1 LTS (Noble Numbat)"
ID=ubuntu
ID_LIKE=debian
PRETTY_NAME="Ubuntu 24.04.1 LTS"
VERSION_ID="24.04"
__UNAME__
Linux 6.8.0-45-generic x86_64
__ARCH__
x86_64
__HOST__
web-01
__USER__
deploy
__INIT__
systemd
__SHELL__
/bin/bash
__CPU__
 Intel(R) Xeon(R) CPU E5-2670 v3 @ 2.30GHz
__CORES__
8
__MEM__
16384000
__PKG__
apt-get
__WEB__
nginx|/usr/sbin/nginx|nginx version: nginx/1.24.0 (Ubuntu)|active
apache2|/usr/sbin/apache2|Server version: Apache/2.4.58 (Ubuntu)|inactive
__CONTAINER__
__HEAD__"#;

    #[test]
    fn parses_linux_detection() {
        let info = parse_server_info(SAMPLE).unwrap();
        assert_eq!(info.hostname, "web-01");
        assert_eq!(info.distro_id, "ubuntu");
        assert_eq!(info.distro_family, "debian");
        assert_eq!(info.kernel, "6.8.0-45-generic");
        assert_eq!(info.init_system, "systemd");
        assert_eq!(info.package_manager, "apt-get");
        assert_eq!(info.cpu_count, 8);
        assert_eq!(info.mem_total_kb, 16_384_000);
        assert_eq!(info.web_servers.len(), 2);
        assert!(info.web_servers[0].active);
        assert!(!info.web_servers[1].active);
        assert!(!info.is_container);
    }

    #[test]
    fn editing_without_retyping_password_keeps_the_stored_secret() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Arc::new(
            crate::infrastructure::storage::Storage::open(&dir.path().join("db.json"), None)
                .unwrap(),
        );
        let secrets = Arc::new(
            crate::infrastructure::crypto::SecretBox::load_or_create(&dir.path().join("key"))
                .unwrap(),
        );
        let service = ProfileService::new(storage, secrets);

        let created = service
            .save(ConnectionProfile {
                name: "prod".into(),
                host: "10.0.0.1".into(),
                username: "deploy".into(),
                password: Some("hunter2".into()),
                ..Default::default()
            })
            .unwrap();
        assert!(created.has_password);

        let updated = service
            .save(ConnectionProfile {
                id: created.id.clone(),
                name: "prod renamed".into(),
                host: "10.0.0.1".into(),
                username: "deploy".into(),
                password: Some(String::new()),
                ..Default::default()
            })
            .unwrap();
        assert!(updated.has_password);
        assert_eq!(
            service.get(&created.id).unwrap().password.as_deref(),
            Some("hunter2")
        );
        let raw = std::fs::read(dir.path().join("db.json")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("hunter2"));
    }

    #[test]
    fn switching_to_a_key_path_drops_the_stored_inline_key() {
        let dir = tempfile::tempdir().unwrap();
        let storage = Arc::new(
            crate::infrastructure::storage::Storage::open(&dir.path().join("db.json"), None)
                .unwrap(),
        );
        let secrets = Arc::new(
            crate::infrastructure::crypto::SecretBox::load_or_create(&dir.path().join("key"))
                .unwrap(),
        );
        let service = ProfileService::new(storage, secrets);

        let created = service
            .save(ConnectionProfile {
                name: "prod".into(),
                host: "10.0.0.1".into(),
                username: "deploy".into(),
                auth_method: AuthMethod::Key,
                private_key: Some("-----BEGIN OPENSSH PRIVATE KEY-----".into()),
                ..Default::default()
            })
            .unwrap();

        let updated = service
            .save(ConnectionProfile {
                id: created.id.clone(),
                name: "prod".into(),
                host: "10.0.0.1".into(),
                username: "deploy".into(),
                auth_method: AuthMethod::Key,
                key_path: Some("/home/deploy/.ssh/id_ed25519".into()),
                clear_private_key: true,
                ..Default::default()
            })
            .unwrap();

        assert!(updated.has_private_key);
        let stored = service.get(&created.id).unwrap();
        assert!(stored.private_key.is_none());
        assert_eq!(
            stored.key_path.as_deref(),
            Some("/home/deploy/.ssh/id_ed25519")
        );
    }

    #[test]
    fn maps_redhat_family() {
        let os = HashMap::from([
            ("ID".to_string(), "rocky".to_string()),
            ("ID_LIKE".to_string(), "rhel centos fedora".to_string()),
        ]);
        assert_eq!(family_for(&os), "redhat");
    }

    #[test]
    fn detects_container_marker() {
        let output = "__CONTAINER__\ndocker\n__HEAD__";
        let info = parse_server_info(output).unwrap();
        assert!(info.is_container);
    }
}
