use crate::application::audit::{AuditEvent, AuditService};
use crate::application::profiles::ProfileService;
use crate::application::sharing::crypto::{
    decrypt_payload, derive_key, encrypt_payload, generate_passphrase, normalize_passphrase,
    random_nonce, random_salt, DEFAULT_M_KIB, DEFAULT_P_COST, DEFAULT_T_COST,
};
use crate::application::sharing::envelope::{
    read_envelope_from_path, write_envelope_atomic, CipherParams, KdfParams, ShareEnvelope,
    ShareMode, FORMAT_ID, MAX_TTL_SECS, PROTOCOL_VERSION,
};
use crate::application::sharing::payload::{
    normalize_profile_for_export, parse_and_validate_payload, sanitize_key_path_hint,
    share_entry_id, ConnectionShare, DbTargetShare, HostKeyShare, OriginInfo, SecretsShare,
    SharePayload,
};
use crate::application::sharing::report::{
    ConflictPolicy, EphemeralDatabase, HostKeyImportReport, ImportReport, ImportedEntryReport,
    ShareConflictCandidate, ShareConnectionPreview, ShareExportResult, ShareHeaderView,
    ShareImportOptions, SharePrepareOptions, SharePrepareResult, SharePreview, SkippedEntryReport,
};
use crate::error::{AppError, AppResult};
use crate::infrastructure::storage::Storage;
use crate::models::{AuthMethod, ConnectionProfile};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use chrono::Utc;
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use uuid::Uuid;
use zeroize::{Zeroize, Zeroizing};

pub const PENDING_TTL_SECS: i64 = 300;
pub const RATE_LIMIT_WINDOW_SECS: i64 = 600;
pub const MAX_FAILED_ATTEMPTS: u32 = 5;
const MAX_KEY_FILE_BYTES: u64 = 65_536;

struct PendingExport {
    profile_id: String,
    profile_name: String,
    envelope: ShareEnvelope,
    created_at: i64,
}

impl Drop for PendingExport {
    fn drop(&mut self) {
        self.envelope.payload.zeroize();
    }
}

struct PendingImport {
    share_id: String,
    mode: ShareMode,
    payload: SharePayload,
    created_at: i64,
}

#[derive(Default)]
struct AttemptRecord {
    failures: u32,
    window_started_at: i64,
    locked_until: i64,
}

#[derive(Default)]
pub struct AttemptLimiter {
    records: HashMap<String, AttemptRecord>,
}

impl AttemptLimiter {
    pub fn check_allowed(&mut self, key: &str, now: i64) -> AppResult<()> {
        if let Some(rec) = self.records.get_mut(key) {
            if now.saturating_sub(rec.window_started_at) >= RATE_LIMIT_WINDOW_SECS {
                rec.failures = 0;
                rec.window_started_at = now;
                rec.locked_until = 0;
                return Ok(());
            }
            if rec.failures >= MAX_FAILED_ATTEMPTS || now < rec.locked_until {
                return Err(AppError::share(
                    "SHARE_RATE_LIMITED",
                    "too many failed passphrase attempts; wait before retrying",
                ));
            }
        }
        Ok(())
    }

    pub fn record_failure(&mut self, key: &str, now: i64) {
        let entry = self
            .records
            .entry(key.to_string())
            .or_insert_with(|| AttemptRecord {
                failures: 0,
                window_started_at: now,
                locked_until: 0,
            });
        if now.saturating_sub(entry.window_started_at) >= RATE_LIMIT_WINDOW_SECS {
            entry.failures = 0;
            entry.window_started_at = now;
            entry.locked_until = 0;
        }
        entry.failures += 1;
        if entry.failures >= MAX_FAILED_ATTEMPTS {
            entry.locked_until = entry
                .window_started_at
                .saturating_add(RATE_LIMIT_WINDOW_SECS);
        }
    }

    pub fn clear(&mut self, key: &str) {
        self.records.remove(key);
    }
}

pub struct SharingService {
    profiles: Arc<ProfileService>,
    storage: Arc<Storage>,
    audit: Arc<AuditService>,
    pending_export: Mutex<Option<PendingExport>>,
    pending_import: Mutex<Option<PendingImport>>,
    attempts: Mutex<AttemptLimiter>,
    clock: Arc<dyn Fn() -> i64 + Send + Sync>,
}

impl SharingService {
    pub fn new(
        profiles: Arc<ProfileService>,
        storage: Arc<Storage>,
        audit: Arc<AuditService>,
    ) -> Self {
        Self {
            profiles,
            storage,
            audit,
            pending_export: Mutex::new(None),
            pending_import: Mutex::new(None),
            attempts: Mutex::new(AttemptLimiter::default()),
            clock: Arc::new(|| Utc::now().timestamp()),
        }
    }

    #[cfg(test)]
    pub fn with_clock(
        profiles: Arc<ProfileService>,
        storage: Arc<Storage>,
        audit: Arc<AuditService>,
        clock: Arc<dyn Fn() -> i64 + Send + Sync>,
    ) -> Self {
        Self {
            profiles,
            storage,
            audit,
            pending_export: Mutex::new(None),
            pending_import: Mutex::new(None),
            attempts: Mutex::new(AttemptLimiter::default()),
            clock,
        }
    }

    fn now(&self) -> i64 {
        (self.clock)()
    }

    pub fn prepare(
        &self,
        profile_id: &str,
        options: SharePrepareOptions,
        db_password: Option<String>,
    ) -> AppResult<SharePrepareResult> {
        let db_password = db_password.map(Zeroizing::new);
        if options.expires_in_secs <= 0 || options.expires_in_secs > MAX_TTL_SECS {
            return Err(AppError::share(
                "SHARE_FORMAT",
                "expiresInSecs must be between 1 and 2592000",
            ));
        }

        let has_db_pw_arg = db_password
            .as_ref()
            .map(|p| !p.as_str().is_empty())
            .unwrap_or(false);
        if has_db_pw_arg
            && (options.mode != ShareMode::Secrets
                || !options.include_database
                || !options.include_database_password)
        {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "database password requires secrets mode and database inclusion",
            ));
        }

        let profile = self.profiles.get(profile_id).map_err(|_| {
            AppError::share("SHARE_PROFILE_NOT_FOUND", "source profile does not exist")
        })?;

        let mut warnings = Vec::new();
        let key_path_hint = profile.key_path.as_deref().and_then(sanitize_key_path_hint);

        let database = if options.include_database {
            options
                .database_override
                .clone()
                .or_else(|| profile.db_target.clone().map(DbTargetShare::from))
        } else {
            None
        };

        let secrets = match options.mode {
            ShareMode::Metadata => {
                if profile.auth_method == AuthMethod::Password {
                    warnings.push(
                        "El modo metadata no incluye la contraseña SSH; el receptor deberá introducirla."
                            .to_string(),
                    );
                } else {
                    warnings.push(
                        "El modo metadata no incluye la clave privada SSH; el receptor deberá configurarla."
                            .to_string(),
                    );
                }
                None
            }
            ShareMode::Secrets => {
                let ssh_password = if options.include_ssh_password {
                    let pw = profile
                        .password
                        .clone()
                        .filter(|p| !p.is_empty())
                        .ok_or_else(|| {
                            AppError::share(
                                "SHARE_SECRETS_UNAVAILABLE",
                                "SSH password is not available in stored profile",
                            )
                        })?;
                    Some(pw)
                } else {
                    None
                };

                let private_key = if options.include_private_key_file {
                    let key_path = profile
                        .key_path
                        .as_deref()
                        .filter(|p| !p.trim().is_empty())
                        .ok_or_else(|| {
                            AppError::share(
                                "SHARE_KEY_UNREADABLE",
                                "profile does not have a local key path",
                            )
                        })?;
                    let content = read_private_key_file(key_path)?;
                    warnings.push(
                        "Se ha leído y adjuntado el archivo de clave privada local al paquete cifrado."
                            .to_string(),
                    );
                    Some(content)
                } else if options.include_private_key {
                    let pk = profile
                        .private_key
                        .clone()
                        .filter(|k| !k.is_empty())
                        .ok_or_else(|| {
                            AppError::share(
                                "SHARE_SECRETS_UNAVAILABLE",
                                "inline private key is not available in stored profile",
                            )
                        })?;
                    Some(pk)
                } else {
                    None
                };

                let passphrase = if options.include_passphrase && private_key.is_some() {
                    profile.passphrase.clone().filter(|p| !p.is_empty())
                } else {
                    None
                };

                let database_password = if options.include_database
                    && options.include_database_password
                {
                    if database.is_none() {
                        return Err(AppError::share(
                            "SHARE_PAYLOAD_INVALID",
                            "database target is required when including database password",
                        ));
                    }
                    let pw = db_password
                        .as_ref()
                        .map(|z| z.as_str().to_string())
                        .filter(|p| !p.is_empty())
                        .ok_or_else(|| {
                            AppError::share(
                                "SHARE_SECRETS_UNAVAILABLE",
                                "database password was not supplied",
                            )
                        })?;
                    warnings.push(
                        "La contraseña de base de datos viajará cifrada y solo se abrirá en memoria en el receptor."
                            .to_string(),
                    );
                    Some(pw)
                } else {
                    None
                };

                Some(SecretsShare {
                    ssh_password,
                    private_key,
                    passphrase,
                    database_password,
                })
            }
        };

        let host_key = if options.include_host_key {
            self.storage
                .known_host(&profile.host, profile.port)
                .filter(|fp| fp.starts_with("SHA256:"))
                .map(|fingerprint| HostKeyShare {
                    fingerprint,
                    algorithm: None,
                })
        } else {
            None
        };

        let normalized_profile = normalize_profile_for_export(&profile);
        let entry_id = share_entry_id(
            &normalized_profile.host,
            normalized_profile.port,
            &normalized_profile.username,
        );

        let mut payload = SharePayload {
            protocol: 1,
            kind: "connection-share".to_string(),
            origin: Some(OriginInfo {
                app: "2shell".to_string(),
                version: "0.2.0".to_string(),
                platform: current_platform().to_string(),
            }),
            connections: vec![ConnectionShare {
                share_entry_id: entry_id,
                profile: normalized_profile,
                secrets,
                key_path_hint,
                host_key,
                database,
            }],
            extensions: serde_json::Map::new(),
        };
        payload.validate_and_normalize(options.mode)?;

        let plaintext = Zeroizing::new(serde_json::to_vec(&payload).map_err(|e| {
            AppError::share(
                "SHARE_PAYLOAD_INVALID",
                format!("cannot serialize share payload: {e}"),
            )
        })?);

        let passphrase = generate_passphrase();
        let canonical = normalize_passphrase(&passphrase)?;
        let salt = random_salt();
        let nonce = random_nonce();
        let now = self.now();
        let expires_at = now.saturating_add(options.expires_in_secs);
        let share_id = Uuid::new_v4().to_string();

        let mut envelope = ShareEnvelope {
            format: FORMAT_ID.to_string(),
            version: PROTOCOL_VERSION,
            share_id: share_id.clone(),
            created_at: now,
            expires_at,
            mode: options.mode,
            kdf: KdfParams {
                alg: "argon2id".to_string(),
                salt: B64URL.encode(salt),
                m: DEFAULT_M_KIB,
                t: DEFAULT_T_COST,
                p: DEFAULT_P_COST,
            },
            cipher: CipherParams {
                alg: "aes-256-gcm".to_string(),
                nonce: B64URL.encode(nonce),
            },
            payload: String::new(),
        };

        let aad = envelope.aad_bytes();
        let key = derive_key(
            &canonical,
            &salt,
            DEFAULT_M_KIB,
            DEFAULT_T_COST,
            DEFAULT_P_COST,
        )?;
        let ciphertext = encrypt_payload(&key, &nonce, &aad, &plaintext)?;
        envelope.payload = B64URL.encode(&ciphertext);

        let mut guard = self
            .pending_export
            .lock()
            .map_err(|_| AppError::Storage("pending_export lock poisoned".into()))?;
        *guard = Some(PendingExport {
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            envelope,
            created_at: now,
        });

        Ok(SharePrepareResult {
            share_id,
            passphrase: passphrase.as_str().to_string(),
            mode: options.mode,
            expires_at,
            warnings,
        })
    }

    pub fn export(&self, destination_path: &str) -> AppResult<ShareExportResult> {
        let trimmed = destination_path.trim();
        if trimmed.is_empty() {
            return Err(AppError::share(
                "SHARE_IO",
                "destination path must not be empty",
            ));
        }
        let now = self.now();
        let pending = {
            let mut guard = self
                .pending_export
                .lock()
                .map_err(|_| AppError::Storage("pending_export lock poisoned".into()))?;
            let Some(pending) = guard.take() else {
                return Err(AppError::share(
                    "SHARE_SESSION_EXPIRED",
                    "no pending share export session",
                ));
            };
            if now > pending.created_at.saturating_add(PENDING_TTL_SECS) {
                return Err(AppError::share(
                    "SHARE_SESSION_EXPIRED",
                    "pending share export session expired",
                ));
            }
            pending
        };

        let path = Path::new(trimmed);
        match write_envelope_atomic(path, &pending.envelope) {
            Ok((bytes, sha256)) => {
                self.audit.log(
                    AuditEvent::new("share", "share.export", "success")
                        .profile(Some(&pending.profile_id), Some(&pending.profile_name))
                        .metadata(serde_json::json!({
                            "profileId": pending.profile_id,
                            "mode": pending.envelope.mode.as_str(),
                            "expiresAt": pending.envelope.expires_at,
                            "bytes": bytes,
                            "sha256": sha256,
                        })),
                );
                Ok(ShareExportResult {
                    path: trimmed.to_string(),
                    bytes,
                    sha256,
                    expires_at: pending.envelope.expires_at,
                })
            }
            Err(err) => {
                self.audit.log(
                    AuditEvent::new("share", "share.export", "error")
                        .profile(Some(&pending.profile_id), Some(&pending.profile_name))
                        .error(err.to_string())
                        .metadata(serde_json::json!({
                            "profileId": pending.profile_id,
                            "mode": pending.envelope.mode.as_str(),
                            "expiresAt": pending.envelope.expires_at,
                        })),
                );
                Err(err)
            }
        }
    }

    pub fn cancel(&self) -> AppResult<()> {
        let mut guard = self
            .pending_export
            .lock()
            .map_err(|_| AppError::Storage("pending_export lock poisoned".into()))?;
        *guard = None;
        Ok(())
    }

    pub fn inspect(&self, path: &str) -> AppResult<ShareHeaderView> {
        let now = self.now();
        let (envelope, _, bytes) = read_envelope_from_path(Path::new(path.trim()), now, false)?;
        Ok(ShareHeaderView {
            format: envelope.format.clone(),
            version: envelope.version,
            share_id: envelope.share_id.clone(),
            created_at: envelope.created_at,
            expires_at: envelope.expires_at,
            mode: envelope.mode,
            bytes,
            expired: envelope.is_expired_at(now),
            needs_passphrase: true,
        })
    }

    pub fn unlock(&self, path: &str, passphrase: &str) -> AppResult<SharePreview> {
        let trimmed_path = path.trim();
        let rate_key = canonical_rate_key(trimmed_path);
        let now = self.now();

        {
            let mut limiter = self
                .attempts
                .lock()
                .map_err(|_| AppError::Storage("attempts lock poisoned".into()))?;
            limiter.check_allowed(&rate_key, now)?;
        }

        let (envelope, decoded, _) = read_envelope_from_path(Path::new(trimmed_path), now, true)?;

        let canonical = match normalize_passphrase(passphrase) {
            Ok(val) => val,
            Err(err) => {
                if let Ok(mut limiter) = self.attempts.lock() {
                    limiter.record_failure(&rate_key, now);
                }
                return Err(err);
            }
        };

        let key = derive_key(
            &canonical,
            &decoded.salt,
            envelope.kdf.m,
            envelope.kdf.t,
            envelope.kdf.p,
        )?;
        let aad = envelope.aad_bytes();
        let plaintext = match decrypt_payload(&key, &decoded.nonce, &aad, &decoded.ciphertext) {
            Ok(plain) => plain,
            Err(err) => {
                if let Ok(mut limiter) = self.attempts.lock() {
                    limiter.record_failure(&rate_key, now);
                }
                return Err(err);
            }
        };

        if let Ok(mut limiter) = self.attempts.lock() {
            limiter.clear(&rate_key);
        }

        let payload = parse_and_validate_payload(&plaintext, envelope.mode)?;
        let stored_profiles: Vec<ConnectionProfile> = self
            .storage
            .list_stored()
            .into_iter()
            .map(|(p, _)| p)
            .collect();

        let preview = build_preview(&envelope, &payload, &stored_profiles);

        let mut guard = self
            .pending_import
            .lock()
            .map_err(|_| AppError::Storage("pending_import lock poisoned".into()))?;
        *guard = Some(PendingImport {
            share_id: envelope.share_id,
            mode: envelope.mode,
            payload,
            created_at: now,
        });

        Ok(preview)
    }

    pub fn import(
        &self,
        selection: Vec<String>,
        policy: ConflictPolicy,
        options: ShareImportOptions,
    ) -> AppResult<ImportReport> {
        let now = self.now();
        let pending = {
            let mut guard = self
                .pending_import
                .lock()
                .map_err(|_| AppError::Storage("pending_import lock poisoned".into()))?;
            let Some(pending) = guard.take() else {
                return Err(AppError::share(
                    "SHARE_SESSION_EXPIRED",
                    "no pending share import session",
                ));
            };
            if now > pending.created_at.saturating_add(PENDING_TTL_SECS) {
                return Err(AppError::share(
                    "SHARE_SESSION_EXPIRED",
                    "pending share import session expired",
                ));
            }
            pending
        };

        if selection.is_empty() {
            return Err(AppError::share(
                "SHARE_PAYLOAD_INVALID",
                "at least one connection must be selected",
            ));
        }

        let mut selected_connections = Vec::new();
        for id in &selection {
            let Some(conn) = pending
                .payload
                .connections
                .iter()
                .find(|c| &c.share_entry_id == id)
            else {
                return Err(AppError::share(
                    "SHARE_ENTRY_INVALID",
                    "selected shareEntryId is not present in bundle",
                ));
            };
            selected_connections.push(conn);
        }

        let stored_profiles: Vec<ConnectionProfile> = self
            .storage
            .list_stored()
            .into_iter()
            .map(|(p, _)| p)
            .collect();

        if policy == ConflictPolicy::Overwrite {
            for conn in &selected_connections {
                let candidates = find_conflicts(conn, &stored_profiles);
                if candidates.len() > 1 {
                    self.audit.log(
                        AuditEvent::new("share", "share.import", "error")
                            .error("SHARE_CONFLICT: multiple matching profiles")
                            .metadata(serde_json::json!({
                                "shareId": pending.share_id,
                                "mode": pending.mode.as_str(),
                                "policy": policy.as_str(),
                            })),
                    );
                    return Err(AppError::share(
                        "SHARE_CONFLICT",
                        "multiple existing profiles match the same endpoint; choose skip or duplicate",
                    ));
                }
            }
        }

        let mut imported = Vec::new();
        let mut skipped = Vec::new();
        let mut needs_credentials = Vec::new();
        let mut host_keys = Vec::new();
        let mut ephemeral_database = None;
        let mut created_count = 0u32;
        let mut updated_count = 0u32;

        for conn in selected_connections {
            let candidates = find_conflicts(conn, &stored_profiles);

            let (saved_view, action) = if candidates.is_empty() {
                let new_id = Uuid::new_v4().to_string();
                let profile = conn.to_connection_profile(new_id, true);
                let view = self.profiles.save(profile)?;
                created_count += 1;
                (view, "created")
            } else {
                match policy {
                    ConflictPolicy::Skip => {
                        skipped.push(SkippedEntryReport {
                            share_entry_id: conn.share_entry_id.clone(),
                            existing_profile_id: Some(candidates[0].profile_id.clone()),
                            reason: "conflict".to_string(),
                        });
                        continue;
                    }
                    ConflictPolicy::Duplicate => {
                        let new_id = Uuid::new_v4().to_string();
                        let profile = conn.to_connection_profile(new_id, false);
                        let view = self.profiles.save(profile)?;
                        created_count += 1;
                        (view, "duplicated")
                    }
                    ConflictPolicy::Overwrite => {
                        let target_id = candidates[0].profile_id.clone();
                        let existing = self.profiles.get(&target_id)?;
                        let mut profile = conn.to_connection_profile(target_id, true);
                        let incoming_has_inline_key = profile
                            .private_key
                            .as_ref()
                            .map(|k| !k.is_empty())
                            .unwrap_or(false);
                        if incoming_has_inline_key {
                            profile.clear_key_path = true;
                        } else {
                            profile.key_path = existing.key_path;
                        }
                        let view = self.profiles.save(profile)?;
                        updated_count += 1;
                        (view, "updated")
                    }
                }
            };

            let missing_creds = match saved_view.auth_method {
                AuthMethod::Password => !saved_view.has_password,
                AuthMethod::Key => !saved_view.has_private_key,
            };
            if missing_creds {
                needs_credentials.push(saved_view.id.clone());
            }

            if let Some(hk) = &conn.host_key {
                if options.trust_host_key {
                    self.storage.remember_host(
                        &conn.profile.host,
                        conn.profile.port,
                        &hk.fingerprint,
                    )?;
                }
                host_keys.push(HostKeyImportReport {
                    host: conn.profile.host.clone(),
                    port: conn.profile.port,
                    fingerprint: hk.fingerprint.clone(),
                    pinned: options.trust_host_key,
                });
            }

            if options.open_database && ephemeral_database.is_none() {
                if let (Some(db), Some(db_pw)) = (
                    &conn.database,
                    conn.secrets
                        .as_ref()
                        .and_then(|s| s.database_password.as_ref())
                        .filter(|p| !p.is_empty()),
                ) {
                    ephemeral_database = Some(EphemeralDatabase {
                        profile_id: saved_view.id.clone(),
                        engine: db.engine.clone(),
                        host: db.host.clone(),
                        port: db.port,
                        user: db.user.clone(),
                        password: db_pw.clone(),
                        expires_at: now.saturating_add(PENDING_TTL_SECS),
                    });
                }
            }

            imported.push(ImportedEntryReport {
                share_entry_id: conn.share_entry_id.clone(),
                profile_id: saved_view.id,
                action: action.to_string(),
            });
        }

        self.audit.log(
            AuditEvent::new("share", "share.import", "success").metadata(serde_json::json!({
                "shareId": pending.share_id,
                "mode": pending.mode.as_str(),
                "created": created_count,
                "updated": updated_count,
                "skipped": skipped.len(),
                "policy": policy.as_str(),
                "ephemeralDatabase": ephemeral_database.is_some(),
            })),
        );

        Ok(ImportReport {
            share_id: pending.share_id,
            mode: pending.mode,
            imported,
            skipped,
            needs_credentials,
            host_keys,
            ephemeral_database,
        })
    }

    pub fn discard(&self) -> AppResult<()> {
        let mut guard = self
            .pending_import
            .lock()
            .map_err(|_| AppError::Storage("pending_import lock poisoned".into()))?;
        *guard = None;
        Ok(())
    }
}

fn current_platform() -> &'static str {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
}

fn canonical_rate_key(path: &str) -> String {
    std::fs::canonicalize(path)
        .unwrap_or_else(|_| PathBuf::from(path))
        .to_string_lossy()
        .to_string()
}

fn expand_key_path(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn read_private_key_file(path: &str) -> AppResult<String> {
    let expanded = expand_key_path(path.trim());
    let meta = std::fs::metadata(&expanded).map_err(|e| {
        AppError::share(
            "SHARE_KEY_UNREADABLE",
            format!("cannot access private key file: {e}"),
        )
    })?;
    if !meta.is_file() || meta.len() == 0 || meta.len() > MAX_KEY_FILE_BYTES {
        return Err(AppError::share(
            "SHARE_KEY_UNREADABLE",
            "private key file must be a regular file up to 64 KiB",
        ));
    }
    let raw = std::fs::read_to_string(&expanded).map_err(|e| {
        AppError::share(
            "SHARE_KEY_UNREADABLE",
            format!("cannot read private key file: {e}"),
        )
    })?;
    let trimmed = raw.trim().to_string();
    if !trimmed.starts_with("-----BEGIN") || trimmed.len() > MAX_KEY_FILE_BYTES as usize {
        return Err(AppError::share(
            "SHARE_KEY_UNREADABLE",
            "private key file does not start with a PEM header",
        ));
    }
    Ok(trimmed)
}

fn find_conflicts(
    conn: &ConnectionShare,
    stored: &[ConnectionProfile],
) -> Vec<ShareConflictCandidate> {
    let by_share_id: Vec<ShareConflictCandidate> = stored
        .iter()
        .filter(|p| p.source_share_id.as_deref() == Some(conn.share_entry_id.as_str()))
        .map(|p| ShareConflictCandidate {
            profile_id: p.id.clone(),
            profile_name: p.name.clone(),
            host: p.host.clone(),
            port: p.port,
            username: p.username.clone(),
            matched_by: "sourceShareId".to_string(),
        })
        .collect();

    if !by_share_id.is_empty() {
        return by_share_id;
    }

    stored
        .iter()
        .filter(|p| {
            p.host.eq_ignore_ascii_case(&conn.profile.host)
                && p.port == conn.profile.port
                && p.username == conn.profile.username
        })
        .map(|p| ShareConflictCandidate {
            profile_id: p.id.clone(),
            profile_name: p.name.clone(),
            host: p.host.clone(),
            port: p.port,
            username: p.username.clone(),
            matched_by: "endpoint".to_string(),
        })
        .collect()
}

fn build_preview(
    envelope: &ShareEnvelope,
    payload: &SharePayload,
    stored: &[ConnectionProfile],
) -> SharePreview {
    let connections = payload
        .connections
        .iter()
        .map(|conn| {
            let sec = conn.secrets.as_ref();
            let has_ssh_password = sec
                .and_then(|s| s.ssh_password.as_ref())
                .map(|v| !v.is_empty())
                .unwrap_or(false);
            let has_private_key = sec
                .and_then(|s| s.private_key.as_ref())
                .map(|v| !v.is_empty())
                .unwrap_or(false);
            let has_passphrase = sec
                .and_then(|s| s.passphrase.as_ref())
                .map(|v| !v.is_empty())
                .unwrap_or(false);
            let has_database_password = sec
                .and_then(|s| s.database_password.as_ref())
                .map(|v| !v.is_empty())
                .unwrap_or(false);
            let needs_credentials = match conn.profile.auth_method {
                AuthMethod::Password => !has_ssh_password,
                AuthMethod::Key => !has_private_key,
            };
            let conflicts = find_conflicts(conn, stored);

            ShareConnectionPreview {
                share_entry_id: conn.share_entry_id.clone(),
                profile: conn.profile.clone(),
                has_ssh_password,
                has_private_key,
                has_passphrase,
                has_database_password,
                needs_credentials,
                key_path_hint: conn.key_path_hint.clone(),
                host_key: conn.host_key.clone(),
                database: conn.database.clone(),
                conflicts,
            }
        })
        .collect();

    SharePreview {
        share_id: envelope.share_id.clone(),
        created_at: envelope.created_at,
        expires_at: envelope.expires_at,
        mode: envelope.mode,
        origin: payload.origin.clone(),
        connections,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::infrastructure::crypto::SecretBox;
    use crate::models::{DbTarget, LogFilter};
    use std::sync::atomic::{AtomicI64, Ordering};

    struct TestEnv {
        dir: tempfile::TempDir,
        clock_val: Arc<AtomicI64>,
        storage: Arc<Storage>,
        profiles: Arc<ProfileService>,
        audit: Arc<AuditService>,
        sharing: SharingService,
    }

    impl TestEnv {
        fn new(initial_time: i64) -> Self {
            let dir = tempfile::tempdir().unwrap();
            let clock_val = Arc::new(AtomicI64::new(initial_time));
            let storage = Arc::new(Storage::open(&dir.path().join("nexshell.db"), None).unwrap());
            let secrets =
                Arc::new(SecretBox::load_or_create(&dir.path().join("master.key")).unwrap());
            let profiles = Arc::new(ProfileService::new(storage.clone(), secrets));
            let audit = Arc::new(AuditService::new(storage.clone()));
            let clock_clone = clock_val.clone();
            let sharing = SharingService::with_clock(
                profiles.clone(),
                storage.clone(),
                audit.clone(),
                Arc::new(move || clock_clone.load(Ordering::SeqCst)),
            );
            Self {
                dir,
                clock_val,
                storage,
                profiles,
                audit,
                sharing,
            }
        }
    }

    #[test]
    fn export_and_import_secrets_and_ephemeral_db_roundtrip() {
        let source = TestEnv::new(1_760_000_000);
        let saved = source
            .profiles
            .save(ConnectionProfile {
                name: "prod-api".into(),
                host: "203.0.113.10".into(),
                port: 22,
                username: "deploy".into(),
                auth_method: AuthMethod::Password,
                password: Some("super-secret-ssh".into()),
                environment: "production".into(),
                color: "#F97316".into(),
                tags: vec!["api".into()],
                db_target: Some(DbTarget {
                    engine: "mariadb".into(),
                    host: "localhost".into(),
                    port: 3306,
                    user: "dbadmin".into(),
                    socket: None,
                }),
                ..Default::default()
            })
            .unwrap();
        source
            .storage
            .remember_host(
                "203.0.113.10",
                22,
                "SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
            )
            .unwrap();

        let prep = source
            .sharing
            .prepare(
                &saved.id,
                SharePrepareOptions {
                    mode: ShareMode::Secrets,
                    include_ssh_password: true,
                    include_private_key: false,
                    include_private_key_file: false,
                    include_passphrase: false,
                    include_database: true,
                    include_database_password: true,
                    include_host_key: true,
                    expires_in_secs: 86_400,
                    database_override: None,
                },
                Some("ephemeral-db-pass".into()),
            )
            .unwrap();

        let bundle_path = source.dir.path().join("prod-api.2share");
        let exp = source
            .sharing
            .export(bundle_path.to_str().unwrap())
            .unwrap();
        assert!(exp.bytes > 0);
        assert_eq!(exp.sha256.len(), 64);

        let raw_bundle = std::fs::read_to_string(&bundle_path).unwrap();
        assert!(!raw_bundle.contains("203.0.113.10"));
        assert!(!raw_bundle.contains("super-secret-ssh"));
        assert!(!raw_bundle.contains("ephemeral-db-pass"));

        let dest = TestEnv::new(1_760_000_100);
        let header = dest.sharing.inspect(bundle_path.to_str().unwrap()).unwrap();
        assert_eq!(header.mode, ShareMode::Secrets);
        assert!(!header.expired);

        let preview = dest
            .sharing
            .unlock(bundle_path.to_str().unwrap(), &prep.passphrase)
            .unwrap();
        assert_eq!(preview.connections.len(), 1);
        assert!(preview.connections[0].has_ssh_password);
        assert!(preview.connections[0].has_database_password);
        assert!(!preview.connections[0].needs_credentials);

        let entry_id = preview.connections[0].share_entry_id.clone();
        let report = dest
            .sharing
            .import(
                vec![entry_id.clone()],
                ConflictPolicy::Skip,
                ShareImportOptions {
                    trust_host_key: false,
                    open_database: true,
                },
            )
            .unwrap();

        assert_eq!(report.imported.len(), 1);
        assert_eq!(report.imported[0].action, "created");
        assert!(report.needs_credentials.is_empty());
        assert_eq!(report.host_keys.len(), 1);
        assert!(!report.host_keys[0].pinned);
        assert!(dest.storage.known_host("203.0.113.10", 22).is_none());

        let eph = report.ephemeral_database.as_ref().unwrap();
        assert_eq!(eph.password, "ephemeral-db-pass");
        assert_eq!(eph.host, "localhost");

        let imported_id = &report.imported[0].profile_id;
        let stored_profile = dest.profiles.get(imported_id).unwrap();
        assert_eq!(stored_profile.password.as_deref(), Some("super-secret-ssh"));
        assert_eq!(
            stored_profile.source_share_id.as_deref(),
            Some(entry_id.as_str())
        );
        assert_eq!(stored_profile.db_target.as_ref().unwrap().host, "localhost");

        let raw_db = std::fs::read(dest.dir.path().join("nexshell.db")).unwrap();
        let raw_db_str = String::from_utf8_lossy(&raw_db);
        assert!(!raw_db_str.contains("ephemeral-db-pass"));
        assert!(!raw_db_str.contains("super-secret-ssh"));

        let logs = dest.audit.list(&LogFilter::default()).unwrap();
        let log_json = serde_json::to_string(&logs).unwrap();
        assert!(!log_json.contains("ephemeral-db-pass"));
        assert!(!log_json.contains("super-secret-ssh"));
        assert!(!log_json.contains(&prep.passphrase));
    }

    #[test]
    fn metadata_import_preserves_existing_secrets_and_handles_conflict_policies() {
        let env = TestEnv::new(1_760_000_000);
        let existing = env
            .profiles
            .save(ConnectionProfile {
                name: "prod".into(),
                host: "203.0.113.10".into(),
                port: 22,
                username: "root".into(),
                auth_method: AuthMethod::Password,
                password: Some("keep-me".into()),
                environment: "production".into(),
                color: "#F97316".into(),
                ..Default::default()
            })
            .unwrap();

        let prep = env
            .sharing
            .prepare(
                &existing.id,
                SharePrepareOptions {
                    mode: ShareMode::Metadata,
                    include_ssh_password: false,
                    include_private_key: false,
                    include_private_key_file: false,
                    include_passphrase: false,
                    include_database: false,
                    include_database_password: false,
                    include_host_key: false,
                    expires_in_secs: 3600,
                    database_override: None,
                },
                None,
            )
            .unwrap();
        let path = env.dir.path().join("meta.2share");
        env.sharing.export(path.to_str().unwrap()).unwrap();

        let preview = env
            .sharing
            .unlock(path.to_str().unwrap(), &prep.passphrase)
            .unwrap();
        let entry_id = preview.connections[0].share_entry_id.clone();
        assert_eq!(preview.connections[0].conflicts.len(), 1);

        let skip_report = env
            .sharing
            .import(
                vec![entry_id.clone()],
                ConflictPolicy::Skip,
                ShareImportOptions {
                    trust_host_key: false,
                    open_database: false,
                },
            )
            .unwrap();
        assert_eq!(skip_report.skipped.len(), 1);
        assert!(skip_report.imported.is_empty());

        env.sharing
            .unlock(path.to_str().unwrap(), &prep.passphrase)
            .unwrap();
        let overwrite_report = env
            .sharing
            .import(
                vec![entry_id.clone()],
                ConflictPolicy::Overwrite,
                ShareImportOptions {
                    trust_host_key: false,
                    open_database: false,
                },
            )
            .unwrap();
        assert_eq!(overwrite_report.imported[0].action, "updated");
        assert_eq!(overwrite_report.imported[0].profile_id, existing.id);
        let reloaded = env.profiles.get(&existing.id).unwrap();
        assert_eq!(reloaded.password.as_deref(), Some("keep-me"));
        assert_eq!(reloaded.source_share_id.as_deref(), Some(entry_id.as_str()));

        env.sharing
            .unlock(path.to_str().unwrap(), &prep.passphrase)
            .unwrap();
        let dup_report = env
            .sharing
            .import(
                vec![entry_id.clone()],
                ConflictPolicy::Duplicate,
                ShareImportOptions {
                    trust_host_key: false,
                    open_database: false,
                },
            )
            .unwrap();
        assert_eq!(dup_report.imported[0].action, "duplicated");
        let dup_id = &dup_report.imported[0].profile_id;
        assert_ne!(dup_id, &existing.id);
        let dup_profile = env.profiles.get(dup_id).unwrap();
        assert!(dup_profile.source_share_id.is_none());
        assert!(dup_profile.password.is_none());
    }

    #[test]
    fn enforces_rate_limit_and_session_expiry() {
        let env = TestEnv::new(1_760_000_000);
        assert_eq!(
            env.sharing
                .export("/tmp/none.2share")
                .unwrap_err()
                .share_code(),
            Some("SHARE_SESSION_EXPIRED")
        );

        let saved = env
            .profiles
            .save(ConnectionProfile {
                name: "node".into(),
                host: "198.51.100.5".into(),
                port: 22,
                username: "ubuntu".into(),
                ..Default::default()
            })
            .unwrap();

        let prep = env
            .sharing
            .prepare(
                &saved.id,
                SharePrepareOptions {
                    mode: ShareMode::Metadata,
                    include_ssh_password: false,
                    include_private_key: false,
                    include_private_key_file: false,
                    include_passphrase: false,
                    include_database: false,
                    include_database_password: false,
                    include_host_key: false,
                    expires_in_secs: 3600,
                    database_override: None,
                },
                None,
            )
            .unwrap();
        let path = env.dir.path().join("rate.2share");
        env.sharing.export(path.to_str().unwrap()).unwrap();

        for _ in 0..5 {
            let err = env
                .sharing
                .unlock(
                    path.to_str().unwrap(),
                    "0000-0000-0000-0000-0000-0000-0000-0000",
                )
                .unwrap_err();
            assert_eq!(err.share_code(), Some("SHARE_BAD_PASSPHRASE"));
        }

        let limited = env
            .sharing
            .unlock(path.to_str().unwrap(), &prep.passphrase)
            .unwrap_err();
        assert_eq!(limited.share_code(), Some("SHARE_RATE_LIMITED"));

        env.clock_val.store(1_760_000_601, Ordering::SeqCst);
        let unlocked = env
            .sharing
            .unlock(path.to_str().unwrap(), &prep.passphrase)
            .unwrap();
        assert_eq!(unlocked.connections.len(), 1);
    }
}
