use crate::error::{AppError, AppResult};
use aes_gcm::aead::{Aead, KeyInit};
use aes_gcm::{Aes256Gcm, Nonce};
use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use std::path::Path;

const KEY_LEN: usize = 32;
const NONCE_LEN: usize = 12;

pub struct SecretBox {
    cipher: Aes256Gcm,
}

impl SecretBox {
    pub fn load_or_create(path: &Path) -> AppResult<Self> {
        let key = if path.exists() {
            let raw = std::fs::read(path)?;
            if raw.len() != KEY_LEN {
                return Err(AppError::Crypto(format!(
                    "master key at {} has invalid length {} (expected {})",
                    path.display(),
                    raw.len(),
                    KEY_LEN
                )));
            }
            let mut key = [0u8; KEY_LEN];
            key.copy_from_slice(&raw);
            key
        } else {
            let mut key = [0u8; KEY_LEN];
            OsRng.fill_bytes(&mut key);
            if let Some(parent) = path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            std::fs::write(path, key)?;
            restrict_permissions(path)?;
            key
        };

        Ok(Self {
            cipher: Aes256Gcm::new_from_slice(&key)
                .map_err(|e| AppError::Crypto(format!("invalid master key: {e}")))?,
        })
    }

    pub fn encrypt(&self, plaintext: &str) -> AppResult<String> {
        let mut nonce_bytes = [0u8; NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let ciphertext = self
            .cipher
            .encrypt(nonce, plaintext.as_bytes())
            .map_err(|e| AppError::Crypto(format!("encryption failed: {e}")))?;
        let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        blob.extend_from_slice(&nonce_bytes);
        blob.extend_from_slice(&ciphertext);
        Ok(B64.encode(blob))
    }

    pub fn decrypt(&self, blob: &str) -> AppResult<String> {
        let raw = B64
            .decode(blob)
            .map_err(|e| AppError::Crypto(format!("invalid secret blob: {e}")))?;
        if raw.len() <= NONCE_LEN {
            return Err(AppError::Crypto("secret blob is too short".into()));
        }
        let (nonce_bytes, ciphertext) = raw.split_at(NONCE_LEN);
        let nonce = Nonce::from_slice(nonce_bytes);
        let plaintext = self
            .cipher
            .decrypt(nonce, ciphertext)
            .map_err(|_| AppError::Crypto("secret decryption failed".into()))?;
        String::from_utf8(plaintext)
            .map_err(|e| AppError::Crypto(format!("secret is not valid UTF-8: {e}")))
    }
}

#[cfg(unix)]
fn restrict_permissions(path: &Path) -> AppResult<()> {
    use std::os::unix::fs::PermissionsExt;
    let mut perms = std::fs::metadata(path)?.permissions();
    perms.set_mode(0o600);
    std::fs::set_permissions(path, perms)?;
    Ok(())
}

#[cfg(not(unix))]
fn restrict_permissions(_path: &Path) -> AppResult<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn encrypt_decrypt_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let key_path = dir.path().join("master.key");
        let secrets = SecretBox::load_or_create(&key_path).unwrap();
        let blob = secrets.encrypt("s3cr3t-value").unwrap();
        assert_ne!(blob, "s3cr3t-value");
        assert_eq!(secrets.decrypt(&blob).unwrap(), "s3cr3t-value");
    }

    #[test]
    fn decrypt_with_other_key_fails() {
        let dir = tempfile::tempdir().unwrap();
        let a = SecretBox::load_or_create(&dir.path().join("a.key")).unwrap();
        let b = SecretBox::load_or_create(&dir.path().join("b.key")).unwrap();
        let blob = a.encrypt("value").unwrap();
        assert!(b.decrypt(&blob).is_err());
    }
}
