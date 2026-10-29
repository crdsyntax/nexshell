use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, ExecutionLog, LogFilter, NewExecutionLog};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::Duration;

const SCHEMA_VERSION: i64 = 1;
const DEFAULT_LOG_RETENTION: u32 = 10_000;

#[derive(Debug, Deserialize)]
struct LegacyStoreFile {
    #[serde(default)]
    profiles: Vec<LegacyStoredProfile>,
    #[serde(default)]
    known_hosts: HashMap<String, String>,
}

#[derive(Debug, Deserialize)]
struct LegacyStoredProfile {
    #[serde(flatten)]
    profile: ConnectionProfile,
    #[serde(default)]
    secret_blob: Option<String>,
}

/// SQLite-backed persistence for profiles, pinned host keys and execution logs.
///
/// Secrets never enter the `profiles.config_json` column: `ProfileService`
/// encrypts them and passes the opaque `secret_blob` separately.
pub struct Storage {
    path: PathBuf,
    conn: Mutex<Connection>,
}

impl Storage {
    pub fn open(path: &Path, legacy_json: Option<&Path>) -> AppResult<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }

        let conn = Connection::open(path)?;
        conn.busy_timeout(Duration::from_secs(5))?;
        conn.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA foreign_keys = ON;
             PRAGMA synchronous = NORMAL;",
        )?;

        let storage = Self {
            path: path.to_path_buf(),
            conn: Mutex::new(conn),
        };
        storage.init_schema()?;
        restrict_database_permissions(path);

        if let Some(legacy) = legacy_json {
            storage.migrate_legacy(legacy)?;
        }
        restrict_database_permissions(path);

        if let Err(error) = storage.prune_logs(DEFAULT_LOG_RETENTION) {
            tracing::warn!(target: "twoshell::storage", "log pruning failed: {}", error);
        }
        Ok(storage)
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    fn init_schema(&self) -> AppResult<()> {
        let conn = self.lock()?;
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS profiles (
                id          TEXT PRIMARY KEY,
                config_json TEXT NOT NULL,
                secret_blob TEXT,
                created_at  INTEGER NOT NULL DEFAULT 0,
                updated_at  INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS known_hosts (
                host        TEXT NOT NULL,
                port        INTEGER NOT NULL,
                fingerprint TEXT NOT NULL,
                first_seen  INTEGER NOT NULL,
                last_seen   INTEGER NOT NULL,
                PRIMARY KEY (host, port)
            );

            CREATE TABLE IF NOT EXISTS execution_logs (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp     INTEGER NOT NULL,
                profile_id    TEXT,
                profile_name  TEXT,
                category      TEXT NOT NULL,
                action        TEXT NOT NULL,
                target        TEXT,
                command       TEXT,
                status        TEXT NOT NULL,
                exit_code     INTEGER,
                duration_ms   INTEGER,
                output        TEXT,
                error         TEXT,
                metadata_json TEXT
            );

            CREATE INDEX IF NOT EXISTS idx_logs_id ON execution_logs (id DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_profile ON execution_logs (profile_id, id DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_category ON execution_logs (category, id DESC);
            CREATE INDEX IF NOT EXISTS idx_logs_status ON execution_logs (status, id DESC);",
        )?;
        conn.pragma_update(None, "user_version", SCHEMA_VERSION)?;
        Ok(())
    }

    fn migrate_legacy(&self, legacy_path: &Path) -> AppResult<()> {
        if !legacy_path.exists() {
            return Ok(());
        }

        let profile_count: i64 = {
            let conn = self.lock()?;
            conn.query_row("SELECT COUNT(*) FROM profiles", [], |row| row.get(0))?
        };
        if profile_count > 0 {
            tracing::info!(
                target: "twoshell::storage",
                "legacy JSON found at {}, but the SQLite database already has profiles; leaving it untouched",
                legacy_path.display()
            );
            return Ok(());
        }

        let raw = std::fs::read_to_string(legacy_path)?;
        let legacy: LegacyStoreFile = match serde_json::from_str(&raw) {
            Ok(value) => value,
            Err(error) => {
                tracing::error!(
                    target: "twoshell::storage",
                    "cannot parse legacy JSON {}: {}; SQLite starts empty and the legacy file is kept",
                    legacy_path.display(),
                    error
                );
                return Ok(());
            }
        };

        let now = Utc::now().timestamp();
        let mut conn = self.lock()?;
        let transaction = conn.transaction()?;
        for item in &legacy.profiles {
            let created_at = if item.profile.created_at > 0 {
                item.profile.created_at
            } else {
                now
            };
            let updated_at = if item.profile.updated_at > 0 {
                item.profile.updated_at
            } else {
                now
            };
            let config_json = serde_json::to_string(&item.profile)?;
            transaction.execute(
                "INSERT OR IGNORE INTO profiles (id, config_json, secret_blob, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![
                    item.profile.id,
                    config_json,
                    item.secret_blob,
                    created_at,
                    updated_at
                ],
            )?;
        }
        for (endpoint, fingerprint) in &legacy.known_hosts {
            if let Some((host, port)) = endpoint.rsplit_once(':') {
                if let Ok(port) = port.parse::<u16>() {
                    transaction.execute(
                        "INSERT OR IGNORE INTO known_hosts (host, port, fingerprint, first_seen, last_seen)
                         VALUES (?1, ?2, ?3, ?4, ?4)",
                        params![host, port, fingerprint, now],
                    )?;
                }
            }
        }
        transaction.commit()?;
        drop(conn);

        let backup = legacy_path.with_extension("json.migrated");
        if let Err(error) = std::fs::rename(legacy_path, &backup) {
            tracing::warn!(
                target: "twoshell::storage",
                "migrated legacy JSON but could not rename it to {}: {}",
                backup.display(),
                error
            );
        }

        tracing::info!(
            target: "twoshell::storage",
            "migrated {} profiles and {} known hosts from {} into SQLite",
            legacy.profiles.len(),
            legacy.known_hosts.len(),
            legacy_path.display()
        );
        Ok(())
    }

    pub fn list_stored(&self) -> Vec<(ConnectionProfile, Option<String>)> {
        let Ok(conn) = self.lock() else {
            return Vec::new();
        };
        let Ok(mut statement) = conn.prepare(
            "SELECT config_json, secret_blob FROM profiles ORDER BY updated_at DESC, created_at DESC",
        ) else {
            return Vec::new();
        };
        let Ok(rows) = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        }) else {
            return Vec::new();
        };

        rows.filter_map(|row| {
            let (config_json, secret_blob) = row.ok()?;
            match serde_json::from_str::<ConnectionProfile>(&config_json) {
                Ok(profile) => Some((profile, secret_blob)),
                Err(error) => {
                    tracing::error!(target: "twoshell::storage", "corrupt profile row: {}", error);
                    None
                }
            }
        })
        .collect()
    }

    pub fn get_stored(&self, id: &str) -> Option<(ConnectionProfile, Option<String>)> {
        let conn = self.lock().ok()?;
        let row = conn
            .query_row(
                "SELECT config_json, secret_blob FROM profiles WHERE id = ?1",
                params![id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()
            .ok()??;

        let profile = serde_json::from_str::<ConnectionProfile>(&row.0).ok()?;
        Some((profile, row.1))
    }

    pub fn upsert(
        &self,
        mut profile: ConnectionProfile,
        secret_blob: Option<String>,
    ) -> AppResult<()> {
        let now = Utc::now().timestamp();
        if profile.created_at <= 0 {
            profile.created_at = now;
        }
        if profile.updated_at <= 0 {
            profile.updated_at = now;
        }

        let config_json = serde_json::to_string(&profile)?;
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO profiles (id, config_json, secret_blob, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(id) DO UPDATE SET
                config_json = excluded.config_json,
                secret_blob = excluded.secret_blob,
                updated_at = excluded.updated_at",
            params![
                profile.id,
                config_json,
                secret_blob,
                profile.created_at,
                profile.updated_at
            ],
        )?;
        drop(conn);
        restrict_database_permissions(&self.path);
        Ok(())
    }

    pub fn delete(&self, id: &str) -> AppResult<bool> {
        let conn = self.lock()?;
        let changed = conn.execute("DELETE FROM profiles WHERE id = ?1", params![id])?;
        drop(conn);
        restrict_database_permissions(&self.path);
        Ok(changed > 0)
    }

    pub fn known_host(&self, host: &str, port: u16) -> Option<String> {
        let conn = self.lock().ok()?;
        conn.query_row(
            "SELECT fingerprint FROM known_hosts WHERE host = ?1 AND port = ?2",
            params![host, port],
            |row| row.get(0),
        )
        .optional()
        .ok()?
    }

    pub fn remember_host(&self, host: &str, port: u16, fingerprint: &str) -> AppResult<()> {
        let now = Utc::now().timestamp();
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO known_hosts (host, port, fingerprint, first_seen, last_seen)
             VALUES (?1, ?2, ?3, ?4, ?4)
             ON CONFLICT(host, port) DO UPDATE SET
                fingerprint = excluded.fingerprint,
                last_seen = excluded.last_seen",
            params![host, port, fingerprint, now],
        )?;
        drop(conn);
        restrict_database_permissions(&self.path);
        Ok(())
    }

    pub fn insert_log(&self, log: &NewExecutionLog) -> AppResult<i64> {
        let conn = self.lock()?;
        conn.execute(
            "INSERT INTO execution_logs
                (timestamp, profile_id, profile_name, category, action, target, command,
                 status, exit_code, duration_ms, output, error, metadata_json)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
            params![
                log.timestamp,
                log.profile_id,
                log.profile_name,
                log.category,
                log.action,
                log.target,
                log.command,
                log.status,
                log.exit_code,
                log.duration_ms.map(|value| value as i64),
                log.output,
                log.error,
                log.metadata_json
            ],
        )?;
        let id = conn.last_insert_rowid();
        drop(conn);
        restrict_database_permissions(&self.path);
        Ok(id)
    }

    pub fn list_logs(&self, filter: &LogFilter) -> AppResult<Vec<ExecutionLog>> {
        let limit = filter.limit.clamp(1, 1_000) as i64;
        let offset = filter.offset as i64;
        let search = filter
            .search
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| format!("%{value}%"));

        let conn = self.lock()?;
        let mut statement = conn.prepare(
            "SELECT id, timestamp, profile_id, profile_name, category, action, target,
                    command, status, exit_code, duration_ms, output, error, metadata_json
             FROM execution_logs
             WHERE (?1 IS NULL OR profile_id = ?1)
               AND (?2 IS NULL OR category = ?2)
               AND (?3 IS NULL OR status = ?3)
               AND (?4 IS NULL OR command LIKE ?4 OR target LIKE ?4 OR profile_name LIKE ?4)
             ORDER BY id DESC
             LIMIT ?5 OFFSET ?6",
        )?;

        let rows = statement.query_map(
            params![
                filter.profile_id.as_deref(),
                filter.category.as_deref(),
                filter.status.as_deref(),
                search.as_deref(),
                limit,
                offset
            ],
            |row| {
                let metadata_json: Option<String> = row.get(13)?;
                Ok(ExecutionLog {
                    id: row.get(0)?,
                    timestamp: row.get(1)?,
                    profile_id: row.get(2)?,
                    profile_name: row.get(3)?,
                    category: row.get(4)?,
                    action: row.get(5)?,
                    target: row.get(6)?,
                    command: row.get(7)?,
                    status: row.get(8)?,
                    exit_code: row.get(9)?,
                    duration_ms: row.get::<_, Option<i64>>(10)?.map(|value| value as u64),
                    output: row.get(11)?,
                    error: row.get(12)?,
                    metadata: metadata_json.and_then(|raw| serde_json::from_str(&raw).ok()),
                })
            },
        )?;

        let mut logs = Vec::new();
        for row in rows {
            logs.push(row?);
        }
        Ok(logs)
    }

    pub fn clear_logs(&self, profile_id: Option<&str>) -> AppResult<usize> {
        let conn = self.lock()?;
        let changed = if let Some(profile_id) = profile_id {
            conn.execute(
                "DELETE FROM execution_logs WHERE profile_id = ?1",
                params![profile_id],
            )?
        } else {
            conn.execute("DELETE FROM execution_logs", [])?
        };
        drop(conn);
        restrict_database_permissions(&self.path);
        Ok(changed)
    }

    pub fn prune_logs(&self, keep: u32) -> AppResult<usize> {
        let keep = keep.max(100) as i64;
        let conn = self.lock()?;
        let changed = conn.execute(
            "DELETE FROM execution_logs
             WHERE id NOT IN (SELECT id FROM execution_logs ORDER BY id DESC LIMIT ?1)",
            params![keep],
        )?;
        drop(conn);
        restrict_database_permissions(&self.path);
        Ok(changed)
    }

    fn lock(&self) -> AppResult<std::sync::MutexGuard<'_, Connection>> {
        self.conn
            .lock()
            .map_err(|_| AppError::Storage("SQLite connection lock poisoned".into()))
    }
}

#[cfg(unix)]
fn restrict_database_permissions(path: &Path) {
    use std::os::unix::fs::PermissionsExt;

    let mut candidates = vec![path.to_path_buf()];
    for suffix in ["-wal", "-shm"] {
        let mut sidecar = path.as_os_str().to_os_string();
        sidecar.push(suffix);
        candidates.push(PathBuf::from(sidecar));
    }

    for candidate in candidates {
        if let Ok(metadata) = std::fs::metadata(&candidate) {
            let mut permissions = metadata.permissions();
            permissions.set_mode(0o600);
            let _ = std::fs::set_permissions(&candidate, permissions);
        }
    }
}

#[cfg(not(unix))]
fn restrict_database_permissions(_path: &Path) {}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_storage(dir: &tempfile::TempDir) -> Storage {
        Storage::open(&dir.path().join("nexshell.db"), None).unwrap()
    }

    #[test]
    fn persists_profiles_and_host_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("db.sqlite");
        let storage = Storage::open(&path, None).unwrap();

        let profile = ConnectionProfile {
            id: "abc".into(),
            name: "prod".into(),
            host: "10.0.0.1".into(),
            ..Default::default()
        };
        storage.upsert(profile, Some("blob".into())).unwrap();
        storage.remember_host("10.0.0.1", 22, "SHA256:xyz").unwrap();

        let reopened = Storage::open(&path, None).unwrap();
        let (restored, blob) = reopened.get_stored("abc").unwrap();
        assert_eq!(restored.name, "prod");
        assert_eq!(blob.as_deref(), Some("blob"));
        assert_eq!(
            reopened.known_host("10.0.0.1", 22).as_deref(),
            Some("SHA256:xyz")
        );
    }

    #[test]
    fn plaintext_secrets_are_not_written() {
        let dir = tempfile::tempdir().unwrap();
        let storage = test_storage(&dir);
        let profile = ConnectionProfile {
            id: "abc".into(),
            password: Some("hunter2".into()),
            ..Default::default()
        };
        storage.upsert(profile, None).unwrap();
        let raw = std::fs::read(dir.path().join("nexshell.db")).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("hunter2"));
    }

    #[test]
    fn migrates_legacy_json_once() {
        let dir = tempfile::tempdir().unwrap();
        let legacy = dir.path().join("nexshell.json");
        std::fs::write(
            &legacy,
            r#"{
              "profiles": [
                {
                  "id": "legacy-1",
                  "name": "legacy host",
                  "host": "192.0.2.10",
                  "port": 22,
                  "username": "deploy",
                  "secret_blob": "encrypted"
                }
              ],
              "known_hosts": { "192.0.2.10:22": "SHA256:legacy" }
            }"#,
        )
        .unwrap();

        let db = dir.path().join("nexshell.db");
        let storage = Storage::open(&db, Some(&legacy)).unwrap();
        let (profile, blob) = storage.get_stored("legacy-1").unwrap();
        assert_eq!(profile.name, "legacy host");
        assert_eq!(blob.as_deref(), Some("encrypted"));
        assert_eq!(
            storage.known_host("192.0.2.10", 22).as_deref(),
            Some("SHA256:legacy")
        );
        assert!(!legacy.exists());
        assert!(dir.path().join("nexshell.json.migrated").exists());
    }

    #[test]
    fn stores_filters_and_clears_execution_logs() {
        let dir = tempfile::tempdir().unwrap();
        let storage = test_storage(&dir);
        let base = NewExecutionLog {
            timestamp: 100,
            profile_id: Some("p1".into()),
            profile_name: Some("prod".into()),
            category: "service".into(),
            action: "exec".into(),
            target: None,
            command: Some("systemctl status nginx".into()),
            status: "success".into(),
            exit_code: Some(0),
            duration_ms: Some(12),
            output: Some("active".into()),
            error: None,
            metadata_json: None,
        };
        storage.insert_log(&base).unwrap();
        storage
            .insert_log(&NewExecutionLog {
                timestamp: 101,
                category: "filesystem".into(),
                command: Some("rm -f /tmp/a".into()),
                status: "error".into(),
                error: Some("permission denied".into()),
                profile_id: Some("p2".into()),
                ..base.clone()
            })
            .unwrap();

        let all = storage
            .list_logs(&LogFilter {
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(all.len(), 2);

        let filtered = storage
            .list_logs(&LogFilter {
                category: Some("service".into()),
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(filtered.len(), 1);
        assert_eq!(filtered[0].action, "exec");

        let searched = storage
            .list_logs(&LogFilter {
                search: Some("nginx".into()),
                limit: 10,
                ..Default::default()
            })
            .unwrap();
        assert_eq!(searched.len(), 1);

        assert_eq!(storage.clear_logs(Some("p2")).unwrap(), 1);
        assert_eq!(storage.clear_logs(None).unwrap(), 1);
        assert!(storage.list_logs(&LogFilter::default()).unwrap().is_empty());
    }
}
