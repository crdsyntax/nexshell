use crate::application::sharing::crypto::{NONCE_LEN, TAG_LEN};
use crate::error::{AppError, AppResult};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::io::Write;
use std::path::Path;
use uuid::Uuid;

pub const FORMAT_ID: &str = "2shell-share";
pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_ENVELOPE_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_PLAINTEXT_BYTES: usize = 1024 * 1024;
pub const MAX_TTL_SECS: i64 = 2_592_000;
pub const CLOCK_SKEW_SECS: i64 = 300;
pub const MIN_M_KIB: u32 = 19_456;
pub const MAX_M_KIB: u32 = 262_144;
pub const MIN_T_COST: u32 = 1;
pub const MAX_T_COST: u32 = 10;
pub const MIN_P_COST: u32 = 1;
pub const MAX_P_COST: u32 = 4;
pub const MIN_SALT_LEN: usize = 16;
pub const MAX_SALT_LEN: usize = 32;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ShareMode {
    Metadata,
    Secrets,
}

impl ShareMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            ShareMode::Metadata => "metadata",
            ShareMode::Secrets => "secrets",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KdfParams {
    pub alg: String,
    pub salt: String,
    pub m: u32,
    pub t: u32,
    pub p: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CipherParams {
    pub alg: String,
    pub nonce: String,
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShareEnvelope {
    pub format: String,
    pub version: u32,
    pub share_id: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub mode: ShareMode,
    pub kdf: KdfParams,
    pub cipher: CipherParams,
    pub payload: String,
}

impl std::fmt::Debug for ShareEnvelope {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ShareEnvelope")
            .field("format", &self.format)
            .field("version", &self.version)
            .field("share_id", &self.share_id)
            .field("created_at", &self.created_at)
            .field("expires_at", &self.expires_at)
            .field("mode", &self.mode)
            .field("kdf", &self.kdf)
            .field("cipher", &self.cipher)
            .field("payload_len", &self.payload.len())
            .finish()
    }
}

#[derive(Debug)]
pub struct DecodedHeader {
    pub salt: Vec<u8>,
    pub nonce: [u8; NONCE_LEN],
    pub ciphertext: Vec<u8>,
}

pub fn decode_canonical_b64url(input: &str, err_code: &'static str) -> AppResult<Vec<u8>> {
    if input.is_empty() || input.contains('=') {
        return Err(AppError::share(err_code, "invalid base64url encoding"));
    }
    let decoded = B64URL
        .decode(input)
        .map_err(|_| AppError::share(err_code, "invalid base64url encoding"))?;
    if B64URL.encode(&decoded) != input {
        return Err(AppError::share(
            err_code,
            "non-canonical base64url encoding",
        ));
    }
    Ok(decoded)
}

impl ShareEnvelope {
    pub fn aad_string(&self) -> String {
        format!(
            "{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}|{}",
            self.format,
            self.version,
            self.share_id,
            self.created_at,
            self.expires_at,
            self.mode.as_str(),
            self.kdf.alg,
            self.kdf.salt,
            self.kdf.m,
            self.kdf.t,
            self.kdf.p,
            self.cipher.alg,
            self.cipher.nonce
        )
    }

    pub fn aad_bytes(&self) -> Vec<u8> {
        self.aad_string().into_bytes()
    }

    pub fn is_expired_at(&self, now: i64) -> bool {
        now > self.expires_at.saturating_add(CLOCK_SKEW_SECS)
    }

    pub fn validate_header(&self, now: i64, enforce_expiry: bool) -> AppResult<DecodedHeader> {
        if self.format != FORMAT_ID {
            return Err(AppError::share("SHARE_FORMAT", "invalid share format"));
        }
        if self.version != PROTOCOL_VERSION {
            return Err(AppError::share(
                "SHARE_VERSION",
                "unsupported share protocol version",
            ));
        }

        let parsed_uuid = Uuid::parse_str(&self.share_id)
            .map_err(|_| AppError::share("SHARE_FORMAT", "invalid shareId UUID"))?;
        if parsed_uuid.get_version_num() != 4 || self.share_id != parsed_uuid.to_string() {
            return Err(AppError::share(
                "SHARE_FORMAT",
                "shareId must be a lowercase UUID v4",
            ));
        }

        if self.created_at <= 0 {
            return Err(AppError::share(
                "SHARE_FORMAT",
                "createdAt must be positive",
            ));
        }
        if self.expires_at <= self.created_at {
            return Err(AppError::share(
                "SHARE_FORMAT",
                "expiresAt must be greater than createdAt",
            ));
        }
        if self.expires_at - self.created_at > MAX_TTL_SECS {
            return Err(AppError::share(
                "SHARE_FORMAT",
                "share expiration exceeds 30 days maximum",
            ));
        }
        if self.created_at > now.saturating_add(CLOCK_SKEW_SECS) {
            return Err(AppError::share(
                "SHARE_FORMAT",
                "createdAt is in the future beyond clock skew tolerance",
            ));
        }
        if enforce_expiry && self.is_expired_at(now) {
            return Err(AppError::share("SHARE_EXPIRED", "share file has expired"));
        }

        if self.kdf.alg != "argon2id" {
            return Err(AppError::share(
                "SHARE_KDF_INVALID",
                "unsupported KDF algorithm",
            ));
        }
        if !(MIN_M_KIB..=MAX_M_KIB).contains(&self.kdf.m)
            || !(MIN_T_COST..=MAX_T_COST).contains(&self.kdf.t)
            || !(MIN_P_COST..=MAX_P_COST).contains(&self.kdf.p)
        {
            return Err(AppError::share(
                "SHARE_KDF_INVALID",
                "KDF parameters out of allowed bounds",
            ));
        }
        let salt = decode_canonical_b64url(&self.kdf.salt, "SHARE_KDF_INVALID")?;
        if !(MIN_SALT_LEN..=MAX_SALT_LEN).contains(&salt.len()) {
            return Err(AppError::share(
                "SHARE_KDF_INVALID",
                "KDF salt length out of bounds",
            ));
        }

        if self.cipher.alg != "aes-256-gcm" {
            return Err(AppError::share(
                "SHARE_CIPHER_INVALID",
                "unsupported cipher algorithm",
            ));
        }
        let nonce_vec = decode_canonical_b64url(&self.cipher.nonce, "SHARE_CIPHER_INVALID")?;
        if nonce_vec.len() != NONCE_LEN {
            return Err(AppError::share(
                "SHARE_CIPHER_INVALID",
                "cipher nonce must be 12 bytes",
            ));
        }
        let mut nonce = [0u8; NONCE_LEN];
        nonce.copy_from_slice(&nonce_vec);

        let ciphertext = decode_canonical_b64url(&self.payload, "SHARE_CIPHER_INVALID")?;
        if ciphertext.len() <= TAG_LEN {
            return Err(AppError::share(
                "SHARE_CIPHER_INVALID",
                "encrypted payload is too short",
            ));
        }
        if ciphertext.len() > MAX_PLAINTEXT_BYTES + TAG_LEN {
            return Err(AppError::share(
                "SHARE_TOO_LARGE",
                "encrypted payload exceeds maximum size",
            ));
        }

        Ok(DecodedHeader {
            salt,
            nonce,
            ciphertext,
        })
    }
}

pub fn parse_envelope_bytes(
    raw: &[u8],
    now: i64,
    enforce_expiry: bool,
) -> AppResult<(ShareEnvelope, DecodedHeader)> {
    if raw.len() > MAX_ENVELOPE_BYTES {
        return Err(AppError::share(
            "SHARE_TOO_LARGE",
            "share file exceeds 2 MiB limit",
        ));
    }
    if raw.starts_with(&[0xEF, 0xBB, 0xBF]) {
        return Err(AppError::share(
            "SHARE_FORMAT",
            "UTF-8 BOM is not permitted",
        ));
    }
    if let Ok(probe) = serde_json::from_slice::<serde_json::Value>(raw) {
        if let Some(obj) = probe.as_object() {
            if let Some(format_val) = obj.get("format") {
                if format_val.as_str() != Some(FORMAT_ID) {
                    return Err(AppError::share("SHARE_FORMAT", "invalid share format"));
                }
            }
            if let Some(version_val) = obj.get("version") {
                if version_val.as_u64() != Some(u64::from(PROTOCOL_VERSION)) {
                    return Err(AppError::share(
                        "SHARE_VERSION",
                        "unsupported share protocol version",
                    ));
                }
            }
        }
    }
    let envelope: ShareEnvelope = serde_json::from_slice(raw)
        .map_err(|e| AppError::share("SHARE_FORMAT", format!("invalid share envelope: {e}")))?;
    let decoded = envelope.validate_header(now, enforce_expiry)?;
    Ok((envelope, decoded))
}

pub fn read_envelope_from_path(
    path: &Path,
    now: i64,
    enforce_expiry: bool,
) -> AppResult<(ShareEnvelope, DecodedHeader, u64)> {
    let meta = std::fs::metadata(path)
        .map_err(|e| AppError::share("SHARE_IO", format!("cannot read share file: {e}")))?;
    if !meta.is_file() {
        return Err(AppError::share("SHARE_IO", "path is not a regular file"));
    }
    let len = meta.len();
    if len > MAX_ENVELOPE_BYTES as u64 {
        return Err(AppError::share(
            "SHARE_TOO_LARGE",
            "share file exceeds 2 MiB limit",
        ));
    }
    let raw = std::fs::read(path)
        .map_err(|e| AppError::share("SHARE_IO", format!("cannot read share file: {e}")))?;
    let (envelope, decoded) = parse_envelope_bytes(&raw, now, enforce_expiry)?;
    Ok((envelope, decoded, raw.len() as u64))
}

pub fn write_envelope_atomic(path: &Path, envelope: &ShareEnvelope) -> AppResult<(u64, String)> {
    let serialized = serde_json::to_vec_pretty(envelope)
        .map_err(|e| AppError::share("SHARE_FORMAT", format!("cannot serialize envelope: {e}")))?;
    if serialized.len() > MAX_ENVELOPE_BYTES {
        return Err(AppError::share(
            "SHARE_TOO_LARGE",
            "serialized envelope exceeds 2 MiB limit",
        ));
    }

    let parent = path
        .parent()
        .filter(|p| !p.as_os_str().is_empty())
        .unwrap_or_else(|| Path::new("."));
    std::fs::create_dir_all(parent)
        .map_err(|e| AppError::share("SHARE_IO", format!("cannot create directory: {e}")))?;

    let tmp_name = format!(".2shell-share-{}.tmp", Uuid::new_v4());
    let tmp_path = parent.join(tmp_name);

    let write_result = (|| -> AppResult<()> {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts
            .open(&tmp_path)
            .map_err(|e| AppError::share("SHARE_IO", format!("cannot create temp file: {e}")))?;
        file.write_all(&serialized)
            .map_err(|e| AppError::share("SHARE_IO", format!("cannot write temp file: {e}")))?;
        file.sync_all()
            .map_err(|e| AppError::share("SHARE_IO", format!("cannot sync temp file: {e}")))?;
        drop(file);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut perms = std::fs::metadata(&tmp_path)
                .map_err(|e| AppError::share("SHARE_IO", format!("cannot stat temp file: {e}")))?
                .permissions();
            perms.set_mode(0o600);
            std::fs::set_permissions(&tmp_path, perms)
                .map_err(|e| AppError::share("SHARE_IO", format!("cannot set permissions: {e}")))?;
        }

        std::fs::rename(&tmp_path, path)
            .map_err(|e| AppError::share("SHARE_IO", format!("cannot commit share file: {e}")))?;
        Ok(())
    })();

    if let Err(err) = write_result {
        let _ = std::fs::remove_file(&tmp_path);
        return Err(err);
    }

    let mut hasher = Sha256::new();
    hasher.update(&serialized);
    let digest = hasher.finalize();
    let sha256 = digest
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect::<String>();

    Ok((serialized.len() as u64, sha256))
}

#[cfg(test)]
mod tests {
    use super::*;

    const VALID_ENVELOPE_JSON: &str = r#"{
  "format": "2shell-share",
  "version": 1,
  "shareId": "2f1c6b0a-9d4e-4c7a-8b21-3e5d7f9a1c42",
  "createdAt": 1760000000,
  "expiresAt": 1760086400,
  "mode": "secrets",
  "kdf": {
    "alg": "argon2id",
    "salt": "AAECAwQFBgcICQoLDA0ODw",
    "m": 65536,
    "t": 3,
    "p": 1
  },
  "cipher": {
    "alg": "aes-256-gcm",
    "nonce": "AAAAAAAAAAAAAAAA"
  },
  "payload": "O_3Y9u9UX5iTSIbZu6ODnPwlVO2Ukc2KpU1ZXxxYCgOQ8gD0J8cLShWYCd2hqUex6iQQ7weBCsSLF478PnhJSuwv365TtdoYceeS1zirhjc3Dnu7WKCHWhR3m5-bFxdk9gv8TvTn9yy1f870JEbEcHL_RL1O4YGUQ0Il3CFY0zDopexulQJHZbF1KVIN9S0hPlVe7w1cgr5GyxyzVYK8o3pAuJwCeSv5nV3p86eY0IsIW_WchCNyADzIBLB71oXaSe9bkFClNt7db9LZhXlbUx-ILySBb7ELEqFSTFSS5tIOGVAjg6BNHiWICojtZhIVaQwPrOU1I-CQLmFLG7jHkaByttZTm6Yioqy4knOJspdfYPDgwI6pjoYZPrG11HmCyeQb7hzxnuyIJ1juzwcXGv_oo2vezEr6VlzxY9qTlaWq8lCCP066o2p2nK_HmsDvLuQA3ZDq7GTxi8rHgUIYLNe-5Iiqv4lris6svKc2sk55UXbvNK3zDRSe_TnLBxxMzknJOZUuxhb6DIehQuFMLfZfWOg1JbCerfgGILFz_dXZLh30qNf6763fwlUAHwea41y4cpdVCeh7c3axmcG-iq-AEPqMH6e46asKQ3GS-UXXuE9h-fs4LNgoyPfnhl9DT4HLRF_1dLwiT9Khquub8_kBjC9_fUL4qoBL6ZwdtAEXWNe9w0Ir9wBfZkPPHRlTuFTTuuzqgmDfqQNNYfdz0EdQV-K7gF43VRO2C9EMPAZqKWZc7BBjYVXtsSj3G_5FuzfARs6EcAKOc5JJEIjLJ_oNE4IFBJy5s_mCchOBFX7Dp0PzBQoOa_vegZ-Fr2d7hPUoUIhy56D4Id27p82X71N7sfmBz66a1jPFcA6vQJwdCNZjW0E75o1OdlUnEX5Ks38urWrAk2M8uPH5Ed78BfkUH0BG9cH4HYop6Xbaia1H6I_qD6xjgXOgMMA7UhsUBQCTaGCBkusWZvdNDRS9l32QhrAp3Ql_YYrX5twm2zuk9_-DWLzNpn9m2n3X294ldqS7tzZw4rvkFzlF1X2F_2v5ReJVZl4q87IRPWAKcNWc88n9kpSai0MtIGZd6qZVfzWJpNquhJZiBRJtt6cw2CP910-hFl4E78T9jiWZ8T_7jmZlzvupoXbq7Fh25OGvFZ70ZOcdkQcHeMTuI5StKt97z-mv2h9eSsXc"
}"#;

    #[test]
    fn parses_valid_envelope_and_builds_aad() {
        let (env, _) =
            parse_envelope_bytes(VALID_ENVELOPE_JSON.as_bytes(), 1760000001, true).unwrap();
        assert_eq!(
            env.aad_string(),
            "2shell-share|1|2f1c6b0a-9d4e-4c7a-8b21-3e5d7f9a1c42|1760000000|1760086400|secrets|argon2id|AAECAwQFBgcICQoLDA0ODw|65536|3|1|aes-256-gcm|AAAAAAAAAAAAAAAA"
        );
    }

    #[test]
    fn rejects_invalid_envelope_cases_from_protocol() {
        let wrong_format = VALID_ENVELOPE_JSON.replace("\"2shell-share\"", "\"2shell\"");
        assert_eq!(
            parse_envelope_bytes(wrong_format.as_bytes(), 1760000001, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_FORMAT")
        );

        let wrong_version = VALID_ENVELOPE_JSON.replace("\"version\": 1", "\"version\": 2");
        assert_eq!(
            parse_envelope_bytes(wrong_version.as_bytes(), 1760000001, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_VERSION")
        );

        let wrong_mode = VALID_ENVELOPE_JSON.replace("\"secrets\"", "\"public\"");
        assert_eq!(
            parse_envelope_bytes(wrong_mode.as_bytes(), 1760000001, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_FORMAT")
        );

        let bad_expiry = VALID_ENVELOPE_JSON.replace("1760086400", "1760000000");
        assert_eq!(
            parse_envelope_bytes(bad_expiry.as_bytes(), 1760000001, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_FORMAT")
        );

        assert_eq!(
            parse_envelope_bytes(VALID_ENVELOPE_JSON.as_bytes(), 1760086400 + 301, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_EXPIRED")
        );

        let short_salt = B64URL.encode([0u8; 15]);
        let bad_salt = VALID_ENVELOPE_JSON.replace("AAECAwQFBgcICQoLDA0ODw", &short_salt);
        assert_eq!(
            parse_envelope_bytes(bad_salt.as_bytes(), 1760000001, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_KDF_INVALID")
        );

        let high_m = VALID_ENVELOPE_JSON.replace("65536", "1048576");
        assert_eq!(
            parse_envelope_bytes(high_m.as_bytes(), 1760000001, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_KDF_INVALID")
        );

        let short_nonce = B64URL.encode([0u8; 11]);
        let bad_nonce = VALID_ENVELOPE_JSON.replace("AAAAAAAAAAAAAAAA", &short_nonce);
        assert_eq!(
            parse_envelope_bytes(bad_nonce.as_bytes(), 1760000001, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_CIPHER_INVALID")
        );

        let padded_payload = VALID_ENVELOPE_JSON.replace("mv2h9eSsXc\"", "mv2h9eSsXc=\"");
        assert_eq!(
            parse_envelope_bytes(padded_payload.as_bytes(), 1760000001, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_CIPHER_INVALID")
        );

        let unknown_field =
            VALID_ENVELOPE_JSON.replace("\"version\": 1,", "\"version\": 1, \"extra\": true,");
        assert_eq!(
            parse_envelope_bytes(unknown_field.as_bytes(), 1760000001, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_FORMAT")
        );

        let oversized = vec![b' '; MAX_ENVELOPE_BYTES + 1];
        assert_eq!(
            parse_envelope_bytes(&oversized, 1760000001, true)
                .unwrap_err()
                .share_code(),
            Some("SHARE_TOO_LARGE")
        );
    }

    #[test]
    fn writes_atomically_with_0600_permissions() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("demo.2share");
        let (env, _) =
            parse_envelope_bytes(VALID_ENVELOPE_JSON.as_bytes(), 1760000001, true).unwrap();
        let (bytes, sha256) = write_envelope_atomic(&path, &env).unwrap();
        assert!(bytes > 0);
        assert_eq!(sha256.len(), 64);

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }
}
