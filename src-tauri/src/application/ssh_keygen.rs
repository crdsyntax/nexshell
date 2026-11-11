use crate::error::{AppError, AppResult};
use russh::keys::ssh_key::{HashAlg, PublicKey};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GenerateKeyRequest {
    pub algorithm: String,
    pub bits: Option<u32>,
    pub comment: Option<String>,
    pub passphrase: Option<String>,
    pub destination_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GeneratedKeyPair {
    pub algorithm: String,
    pub bits: Option<u32>,
    pub comment: String,
    pub public_key: String,
    pub private_key: String,
    pub fingerprint: String,
    pub saved_private_path: Option<String>,
    pub saved_public_path: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveKeyPairRequest {
    pub private_key: String,
    pub public_key: String,
    pub destination_path: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveKeyPairResult {
    pub private_path: String,
    pub public_path: String,
}

pub fn expand_path(raw: &str) -> PathBuf {
    if let Some(rest) = raw.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(raw)
}

fn find_ssh_keygen() -> PathBuf {
    #[cfg(target_os = "windows")]
    {
        let win_path = PathBuf::from(r"C:\Windows\System32\OpenSSH\ssh-keygen.exe");
        if win_path.exists() {
            return win_path;
        }
    }
    #[cfg(not(target_os = "windows"))]
    {
        for p in &["/usr/bin/ssh-keygen", "/usr/local/bin/ssh-keygen", "/bin/ssh-keygen"] {
            let path = PathBuf::from(p);
            if path.exists() {
                return path;
            }
        }
    }
    PathBuf::from("ssh-keygen")
}

#[cfg(unix)]
fn set_mode(path: &Path, mode: u32) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(mode))
}

#[cfg(not(unix))]
fn set_mode(_path: &Path, _mode: u32) -> std::io::Result<()> {
    Ok(())
}

pub fn save_key_pair_to_disk(
    private_key: &str,
    public_key: &str,
    destination_path: &str,
) -> AppResult<SaveKeyPairResult> {
    let clean_path = destination_path.trim();
    if clean_path.is_empty() {
        return Err(AppError::Validation("Destination path cannot be empty".into()));
    }

    let expanded = expand_path(clean_path);
    let (priv_path, pub_path) = if clean_path.ends_with(".pub") {
        let parent = expanded.parent().unwrap_or_else(|| Path::new("."));
        let stem = expanded.file_stem().unwrap_or_default();
        (parent.join(stem), expanded.clone())
    } else {
        let mut pub_name = expanded.file_name().unwrap_or_default().to_os_string();
        pub_name.push(".pub");
        let parent = expanded.parent().unwrap_or_else(|| Path::new("."));
        (expanded.clone(), parent.join(pub_name))
    };

    if let Some(parent) = priv_path.parent() {
        if !parent.exists() {
            std::fs::create_dir_all(parent)?;
            let _ = set_mode(parent, 0o700);
        }
    }

    let trimmed_priv = private_key.trim();
    let priv_content = if trimmed_priv.ends_with('\n') {
        trimmed_priv.to_string()
    } else {
        format!("{trimmed_priv}\n")
    };

    let trimmed_pub = public_key.trim();
    let pub_content = if trimmed_pub.ends_with('\n') {
        trimmed_pub.to_string()
    } else {
        format!("{trimmed_pub}\n")
    };

    std::fs::write(&priv_path, priv_content)?;
    let _ = set_mode(&priv_path, 0o600);

    std::fs::write(&pub_path, pub_content)?;
    let _ = set_mode(&pub_path, 0o644);

    Ok(SaveKeyPairResult {
        private_path: priv_path.to_string_lossy().to_string(),
        public_path: pub_path.to_string_lossy().to_string(),
    })
}

pub fn generate_ssh_key_pair(req: GenerateKeyRequest) -> AppResult<GeneratedKeyPair> {
    let algo = req.algorithm.trim().to_lowercase();
    if algo != "ed25519" && algo != "rsa" {
        return Err(AppError::Validation(format!(
            "Unsupported algorithm '{algo}'. Supported: 'ed25519', 'rsa'"
        )));
    }

    let bits = if algo == "rsa" {
        let b = req.bits.unwrap_or(4096);
        if !(2048..=8192).contains(&b) {
            return Err(AppError::Validation(
                "RSA key size must be between 2048 and 8192 bits (standard: 2048, 4096)".into(),
            ));
        }
        Some(b)
    } else {
        None
    };

    let comment = req
        .comment
        .as_deref()
        .map(str::trim)
        .filter(|c| !c.is_empty())
        .unwrap_or("nexshell@local")
        .to_string();

    if comment.contains('\n') || comment.contains('\r') {
        return Err(AppError::Validation("Comment cannot contain newlines".into()));
    }

    let passphrase = req.passphrase.unwrap_or_default();
    if passphrase.contains('\n') || passphrase.contains('\r') {
        return Err(AppError::Validation("Passphrase cannot contain newline characters".into()));
    }

    let temp_dir = tempfile::Builder::new()
        .prefix("nexshell_keygen_")
        .tempdir()?;
    let key_file = temp_dir.path().join("id_generated");

    let binary = find_ssh_keygen();
    let mut cmd = std::process::Command::new(&binary);
    cmd.arg("-q");
    cmd.arg("-t").arg(&algo);
    if let Some(b) = bits {
        cmd.arg("-b").arg(b.to_string());
    }
    cmd.arg("-C").arg(&comment);
    cmd.arg("-N").arg(&passphrase);
    cmd.arg("-f").arg(&key_file);

    let output = cmd.output().map_err(|e| {
        AppError::Crypto(format!(
            "Failed to execute ssh-keygen ({}): {e}",
            binary.display()
        ))
    })?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        return Err(AppError::Crypto(format!(
            "ssh-keygen failed: {}",
            stderr.trim()
        )));
    }

    let private_key = std::fs::read_to_string(&key_file)?;
    let pub_file = temp_dir.path().join("id_generated.pub");
    let public_key = std::fs::read_to_string(&pub_file)?.trim().to_string();

    let fingerprint = match PublicKey::from_openssh(&public_key) {
        Ok(pk) => pk.fingerprint(HashAlg::Sha256).to_string(),
        Err(_) => String::new(),
    };

    let (saved_private_path, saved_public_path) = if let Some(ref dest) = req.destination_path {
        let saved = save_key_pair_to_disk(&private_key, &public_key, dest)?;
        (Some(saved.private_path), Some(saved.public_path))
    } else {
        (None, None)
    };

    Ok(GeneratedKeyPair {
        algorithm: algo,
        bits,
        comment,
        public_key,
        private_key,
        fingerprint,
        saved_private_path,
        saved_public_path,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_generate_ed25519() {
        let req = GenerateKeyRequest {
            algorithm: "ed25519".into(),
            bits: None,
            comment: Some("test-user@host".into()),
            passphrase: None,
            destination_path: None,
        };
        let res = generate_ssh_key_pair(req).expect("keygen should succeed");
        assert_eq!(res.algorithm, "ed25519");
        assert!(res.public_key.starts_with("ssh-ed25519 "));
        assert!(res.public_key.contains("test-user@host"));
        assert!(res.private_key.contains("BEGIN OPENSSH PRIVATE KEY"));
        assert!(res.fingerprint.starts_with("SHA256:"));
    }

    #[test]
    fn test_generate_rsa_and_save() {
        let temp_dir = tempfile::tempdir().unwrap();
        let dest = temp_dir.path().join("id_rsa_custom");
        let dest_str = dest.to_string_lossy().to_string();

        let req = GenerateKeyRequest {
            algorithm: "rsa".into(),
            bits: Some(2048),
            comment: Some("rsa-test@unit".into()),
            passphrase: Some("secure123".into()),
            destination_path: Some(dest_str.clone()),
        };
        let res = generate_ssh_key_pair(req).expect("rsa keygen should succeed");
        assert_eq!(res.algorithm, "rsa");
        assert_eq!(res.bits, Some(2048));
        assert!(res.public_key.starts_with("ssh-rsa "));
        assert!(dest.exists());
        let pub_dest = temp_dir.path().join("id_rsa_custom.pub");
        assert!(pub_dest.exists());
    }
}
