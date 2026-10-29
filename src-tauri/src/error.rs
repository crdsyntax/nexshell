use serde::ser::{Serialize, Serializer};

/// Every error that can cross the Tauri boundary. Variants are deliberately
/// coarse: the UI only needs an actionable message, and logs keep the detail.
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("SSH error: {0}")]
    Ssh(String),
    #[error("Authentication failed: {0}")]
    Auth(String),
    #[error("Connection timed out: {0}")]
    Timeout(String),
    #[error("Connection pool error: {0}")]
    Pool(String),
    #[error("Not found: {0}")]
    NotFound(String),
    #[error("Validation error: {0}")]
    Validation(String),
    #[error("Storage error: {0}")]
    Storage(String),
    #[error("Cryptography error: {0}")]
    Crypto(String),
    #[error("Remote command failed: {0}")]
    Remote(String),
    #[error("Terminal error: {0}")]
    Terminal(String),
}

pub type AppResult<T> = Result<T, AppError>;

impl Serialize for AppError {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl AppError {
    /// Authentication failures and invalid input will not succeed on a second
    /// attempt; retrying them only risks account lockout or fail2ban bans.
    pub fn is_retryable(&self) -> bool {
        match self {
            AppError::Auth(_)
            | AppError::Validation(_)
            | AppError::NotFound(_)
            | AppError::Crypto(_)
            | AppError::Storage(_) => false,
            AppError::Ssh(message) => {
                !message.contains("Unknown server key") && !message.contains("host key")
            }
            _ => true,
        }
    }
}

impl From<std::io::Error> for AppError {
    fn from(value: std::io::Error) -> Self {
        AppError::Storage(value.to_string())
    }
}

impl From<serde_json::Error> for AppError {
    fn from(value: serde_json::Error) -> Self {
        AppError::Storage(format!("JSON serialization failed: {value}"))
    }
}

impl From<rusqlite::Error> for AppError {
    fn from(value: rusqlite::Error) -> Self {
        AppError::Storage(format!("SQLite: {value}"))
    }
}

impl From<russh::Error> for AppError {
    fn from(value: russh::Error) -> Self {
        AppError::Ssh(value.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn auth_and_validation_errors_are_not_retried() {
        assert!(!AppError::Auth("bad key".into()).is_retryable());
        assert!(!AppError::Validation("bad host".into()).is_retryable());
        assert!(!AppError::Ssh("cannot connect: Unknown server key".into()).is_retryable());
        assert!(AppError::Timeout("handshake".into()).is_retryable());
        assert!(AppError::Ssh("connection refused".into()).is_retryable());
    }
}
