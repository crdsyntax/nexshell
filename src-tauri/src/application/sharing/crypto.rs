use crate::error::{AppError, AppResult};
use aes_gcm::aead::{Aead, KeyInit, Payload};
use aes_gcm::{Aes256Gcm, Nonce};
use argon2::{Algorithm, Argon2, Params, Version};
use rand::rngs::OsRng;
use rand::RngCore;
use zeroize::Zeroizing;

pub const DEFAULT_M_KIB: u32 = 65_536;
pub const DEFAULT_T_COST: u32 = 3;
pub const DEFAULT_P_COST: u32 = 1;
pub const SALT_LEN: usize = 16;
pub const NONCE_LEN: usize = 12;
pub const KEY_LEN: usize = 32;
pub const TAG_LEN: usize = 16;

const CROCKFORD_ALPHABET: &[u8; 32] = b"0123456789ABCDEFGHJKMNPQRSTVWXYZ";

pub fn generate_passphrase() -> Zeroizing<String> {
    let mut entropy = Zeroizing::new([0u8; 20]);
    OsRng.fill_bytes(&mut *entropy);
    encode_crockford_formatted(&entropy)
}

pub fn encode_crockford_formatted(bytes: &[u8; 20]) -> Zeroizing<String> {
    let mut raw = Zeroizing::new(String::with_capacity(32));
    for chunk in bytes.chunks_exact(5) {
        let mut acc: u64 = 0;
        for &b in chunk {
            acc = (acc << 8) | u64::from(b);
        }
        for shift in (0..8).rev() {
            let idx = ((acc >> (shift * 5)) & 0x1f) as usize;
            raw.push(CROCKFORD_ALPHABET[idx] as char);
        }
    }

    let mut formatted = Zeroizing::new(String::with_capacity(39));
    for (i, ch) in raw.chars().enumerate() {
        if i > 0 && i % 4 == 0 {
            formatted.push('-');
        }
        formatted.push(ch);
    }
    formatted
}

pub fn normalize_passphrase(input: &str) -> AppResult<Zeroizing<String>> {
    let mut out = Zeroizing::new(String::with_capacity(32));
    for ch in input.chars() {
        if ch == '-' || ch.is_whitespace() {
            continue;
        }
        if !ch.is_ascii() {
            return Err(AppError::share(
                "SHARE_BAD_PASSPHRASE",
                "invalid passphrase character",
            ));
        }
        let upper = ch.to_ascii_uppercase();
        let mapped = match upper {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        };
        if !CROCKFORD_ALPHABET.contains(&(mapped as u8)) {
            return Err(AppError::share(
                "SHARE_BAD_PASSPHRASE",
                "invalid passphrase character",
            ));
        }
        out.push(mapped);
    }

    if out.len() != 32 {
        return Err(AppError::share(
            "SHARE_BAD_PASSPHRASE",
            "passphrase must be 32 canonical characters",
        ));
    }

    Ok(out)
}

pub fn derive_key(
    canonical_passphrase: &str,
    salt: &[u8],
    m_kib: u32,
    t_cost: u32,
    p_cost: u32,
) -> AppResult<Zeroizing<[u8; KEY_LEN]>> {
    let params = Params::new(m_kib, t_cost, p_cost, Some(KEY_LEN))
        .map_err(|_| AppError::share("SHARE_KDF_INVALID", "invalid Argon2id parameters"))?;
    let argon2 = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = Zeroizing::new([0u8; KEY_LEN]);
    argon2
        .hash_password_into(canonical_passphrase.as_bytes(), salt, &mut *key)
        .map_err(|_| AppError::share("SHARE_KDF_INVALID", "key derivation failed"))?;
    Ok(key)
}

pub fn encrypt_payload(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    plaintext: &[u8],
) -> AppResult<Vec<u8>> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::share("SHARE_CIPHER_INVALID", "invalid AES-256 key"))?;
    cipher
        .encrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: plaintext,
                aad,
            },
        )
        .map_err(|_| AppError::share("SHARE_CIPHER_INVALID", "payload encryption failed"))
}

pub fn decrypt_payload(
    key: &[u8; KEY_LEN],
    nonce: &[u8; NONCE_LEN],
    aad: &[u8],
    ciphertext: &[u8],
) -> AppResult<Zeroizing<Vec<u8>>> {
    let cipher = Aes256Gcm::new_from_slice(key)
        .map_err(|_| AppError::share("SHARE_CIPHER_INVALID", "invalid AES-256 key"))?;
    let plain = cipher
        .decrypt(
            Nonce::from_slice(nonce),
            Payload {
                msg: ciphertext,
                aad,
            },
        )
        .map_err(|_| AppError::share("SHARE_BAD_PASSPHRASE", "authentication failed"))?;
    Ok(Zeroizing::new(plain))
}

pub fn random_salt() -> [u8; SALT_LEN] {
    let mut salt = [0u8; SALT_LEN];
    OsRng.fill_bytes(&mut salt);
    salt
}

pub fn random_nonce() -> [u8; NONCE_LEN] {
    let mut nonce = [0u8; NONCE_LEN];
    OsRng.fill_bytes(&mut nonce);
    nonce
}

#[cfg(test)]
mod tests {
    use super::*;
    use base64::engine::general_purpose::URL_SAFE_NO_PAD as B64URL;
    use base64::Engine;

    const KAT_PASSPHRASE: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const KAT_SALT_B64: &str = "AAECAwQFBgcICQoLDA0ODw";
    const KAT_NONCE_B64: &str = "AAAAAAAAAAAAAAAA";
    const KAT_KEY_B64: &str = "lDotP35ZQazh7-ncBJsdZi7hmeMRmvgxW4B541kX448";
    const KAT_AAD: &str = "2shell-share|1|2f1c6b0a-9d4e-4c7a-8b21-3e5d7f9a1c42|1760000000|1760086400|secrets|argon2id|AAECAwQFBgcICQoLDA0ODw|65536|3|1|aes-256-gcm|AAAAAAAAAAAAAAAA";
    const KAT_PLAINTEXT: &str = r##"{"protocol":1,"kind":"connection-share","origin":{"app":"2shell","version":"0.2.0","platform":"linux"},"connections":[{"shareEntryId":"47643f34-d009-5253-8ec8-665ac82948b0","profile":{"name":"demo","host":"203.0.113.10","port":22,"username":"root","authMethod":"password","environment":"production","color":"#F97316","tags":["cliente"],"keepaliveSecs":30,"connectTimeoutSecs":15,"retry":{"maxRetries":3,"baseDelayMs":250,"maxDelayMs":5000,"jitter":true},"pool":{"maxConnections":4,"acquireTimeoutMs":10000,"idleTimeoutSecs":300},"elevated":false},"secrets":{"sshPassword":"s3cr3t","privateKey":null,"passphrase":null,"databasePassword":null},"keyPathHint":null,"hostKey":{"fingerprint":"SHA256:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA","algorithm":"ssh-ed25519"},"database":{"engine":"mariadb","host":"localhost","port":3306,"user":"root","socket":null}}],"extensions":{}}"##;
    const KAT_CIPHERTEXT_B64: &str = "O_3Y9u9UX5iTSIbZu6ODnPwlVO2Ukc2KpU1ZXxxYCgOQ8gD0J8cLShWYCd2hqUex6iQQ7weBCsSLF478PnhJSuwv365TtdoYceeS1zirhjc3Dnu7WKCHWhR3m5-bFxdk9gv8TvTn9yy1f870JEbEcHL_RL1O4YGUQ0Il3CFY0zDopexulQJHZbF1KVIN9S0hPlVe7w1cgr5GyxyzVYK8o3pAuJwCeSv5nV3p86eY0IsIW_WchCNyADzIBLB71oXaSe9bkFClNt7db9LZhXlbUx-ILySBb7ELEqFSTFSS5tIOGVAjg6BNHiWICojtZhIVaQwPrOU1I-CQLmFLG7jHkaByttZTm6Yioqy4knOJspdfYPDgwI6pjoYZPrG11HmCyeQb7hzxnuyIJ1juzwcXGv_oo2vezEr6VlzxY9qTlaWq8lCCP066o2p2nK_HmsDvLuQA3ZDq7GTxi8rHgUIYLNe-5Iiqv4lris6svKc2sk55UXbvNK3zDRSe_TnLBxxMzknJOZUuxhb6DIehQuFMLfZfWOg1JbCerfgGILFz_dXZLh30qNf6763fwlUAHwea41y4cpdVCeh7c3axmcG-iq-AEPqMH6e46asKQ3GS-UXXuE9h-fs4LNgoyPfnhl9DT4HLRF_1dLwiT9Khquub8_kBjC9_fUL4qoBL6ZwdtAEXWNe9w0Ir9wBfZkPPHRlTuFTTuuzqgmDfqQNNYfdz0EdQV-K7gF43VRO2C9EMPAZqKWZc7BBjYVXtsSj3G_5FuzfARs6EcAKOc5JJEIjLJ_oNE4IFBJy5s_mCchOBFX7Dp0PzBQoOa_vegZ-Fr2d7hPUoUIhy56D4Id27p82X71N7sfmBz66a1jPFcA6vQJwdCNZjW0E75o1OdlUnEX5Ks38urWrAk2M8uPH5Ed78BfkUH0BG9cH4HYop6Xbaia1H6I_qD6xjgXOgMMA7UhsUBQCTaGCBkusWZvdNDRS9l32QhrAp3Ql_YYrX5twm2zuk9_-DWLzNpn9m2n3X294ldqS7tzZw4rvkFzlF1X2F_2v5ReJVZl4q87IRPWAKcNWc88n9kpSai0MtIGZd6qZVfzWJpNquhJZiBRJtt6cw2CP910-hFl4E78T9jiWZ8T_7jmZlzvupoXbq7Fh25OGvFZ70ZOcdkQcHeMTuI5StKt97z-mv2h9eSsXc";

    #[test]
    fn kat_argon2id_and_aes_gcm() {
        let salt = B64URL.decode(KAT_SALT_B64).unwrap();
        let nonce_vec = B64URL.decode(KAT_NONCE_B64).unwrap();
        let mut nonce = [0u8; 12];
        nonce.copy_from_slice(&nonce_vec);

        let canonical = normalize_passphrase(KAT_PASSPHRASE).unwrap();
        let key = derive_key(&canonical, &salt, 65536, 3, 1).unwrap();
        assert_eq!(B64URL.encode(*key), KAT_KEY_B64);

        assert_eq!(KAT_PLAINTEXT.len(), 875);
        let ciphertext =
            encrypt_payload(&key, &nonce, KAT_AAD.as_bytes(), KAT_PLAINTEXT.as_bytes()).unwrap();
        assert_eq!(ciphertext.len(), 891);
        assert_eq!(B64URL.encode(&ciphertext), KAT_CIPHERTEXT_B64);

        let decrypted = decrypt_payload(&key, &nonce, KAT_AAD.as_bytes(), &ciphertext).unwrap();
        assert_eq!(decrypted.as_slice(), KAT_PLAINTEXT.as_bytes());
    }

    #[test]
    fn normalizes_passphrase_and_rejects_invalid() {
        let formatted = generate_passphrase();
        assert_eq!(formatted.len(), 39);
        let canonical = normalize_passphrase(&formatted).unwrap();
        assert_eq!(canonical.len(), 32);

        let ambiguous = "o i l - 3456-789a-bcde-fghj-kmnp-qrst-vwxyz";
        let norm = normalize_passphrase(ambiguous).unwrap();
        assert_eq!(norm.as_str(), "0113456789ABCDEFGHJKMNPQRSTVWXYZ");

        let bad_char = normalize_passphrase("U123456789ABCDEFGHJKMNPQRSTVWXYZ").unwrap_err();
        assert_eq!(bad_char.share_code(), Some("SHARE_BAD_PASSPHRASE"));

        let short = normalize_passphrase("0123456789ABCDEFGHJKMNPQRSTVWXY").unwrap_err();
        assert_eq!(short.share_code(), Some("SHARE_BAD_PASSPHRASE"));
    }

    #[test]
    fn tampered_aad_or_wrong_key_fails_with_bad_passphrase() {
        let key = [7u8; 32];
        let nonce = [1u8; 12];
        let aad = b"2shell-share|1|id|1|2|secrets|argon2id|salt|65536|3|1|aes-256-gcm|nonce";
        let ct = encrypt_payload(&key, &nonce, aad, b"secret payload").unwrap();

        let tampered_aad =
            b"2shell-share|1|id|1|2|metadata|argon2id|salt|65536|3|1|aes-256-gcm|nonce";
        let err = decrypt_payload(&key, &nonce, tampered_aad, &ct).unwrap_err();
        assert_eq!(err.share_code(), Some("SHARE_BAD_PASSPHRASE"));

        let wrong_key = [8u8; 32];
        let err2 = decrypt_payload(&wrong_key, &nonce, aad, &ct).unwrap_err();
        assert_eq!(err2.share_code(), Some("SHARE_BAD_PASSPHRASE"));
    }
}
