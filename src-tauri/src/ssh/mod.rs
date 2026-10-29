use crate::error::{AppError, AppResult};
use crate::infrastructure::storage::Storage;
use crate::models::{AuthMethod, ConnectionProfile, ExecOutput, KeyProbe};
use russh::client::Handle;
use russh::keys::ssh_key::HashAlg;
use russh::keys::{PrivateKey, PrivateKeyWithHashAlg};
use std::future::Future;
use std::path::PathBuf;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

const MAX_EXEC_OUTPUT: usize = 4 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Known hosts (trust on first use)
// ---------------------------------------------------------------------------

pub struct KnownHostsStore {
    storage: Arc<Storage>,
}

impl KnownHostsStore {
    pub fn new(storage: Arc<Storage>) -> Self {
        Self { storage }
    }

    /// Returns true when the presented key matches the pinned key, or when it
    /// is the first key seen for this endpoint (TOFU, persisted immediately).
    pub fn verify_or_record(&self, host: &str, port: u16, fingerprint: &str) -> bool {
        match self.storage.known_host(host, port) {
            Some(expected) => expected == fingerprint,
            None => self
                .storage
                .remember_host(host, port, fingerprint)
                .map(|_| true)
                .unwrap_or(false),
        }
    }
}

pub struct ClientHandler {
    host: String,
    port: u16,
    known_hosts: Arc<KnownHostsStore>,
    observed_fingerprint: Arc<std::sync::Mutex<Option<String>>>,
}

impl ClientHandler {
    pub fn new(
        host: &str,
        port: u16,
        known_hosts: Arc<KnownHostsStore>,
        observed_fingerprint: Arc<std::sync::Mutex<Option<String>>>,
    ) -> Self {
        Self {
            host: host.to_string(),
            port,
            known_hosts,
            observed_fingerprint,
        }
    }
}

impl russh::client::Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &russh::keys::ssh_key::PublicKey,
    ) -> Result<bool, Self::Error> {
        let fingerprint = server_public_key.fingerprint(HashAlg::Sha256).to_string();
        if let Ok(mut observed) = self.observed_fingerprint.lock() {
            *observed = Some(fingerprint.clone());
        }

        if self
            .known_hosts
            .verify_or_record(&self.host, self.port, &fingerprint)
        {
            Ok(true)
        } else {
            tracing::error!(
                target: "twoshell::ssh",
                "host key mismatch for {}:{} (presented {}) - refusing connection",
                self.host,
                self.port,
                fingerprint
            );
            Ok(false)
        }
    }
}

// ---------------------------------------------------------------------------
// Connection
// ---------------------------------------------------------------------------

pub struct SshConnection {
    pub fingerprint: String,
    handle: Handle<ClientHandler>,
}

fn expand_local_path(path: &str) -> PathBuf {
    if let Some(rest) = path.strip_prefix("~/") {
        if let Some(home) = std::env::var_os("HOME") {
            return PathBuf::from(home).join(rest);
        }
    }
    PathBuf::from(path)
}

fn load_private_key(
    key_path: Option<&str>,
    private_key: Option<&str>,
    passphrase: Option<&str>,
) -> AppResult<PrivateKey> {
    // An inline key is an explicit choice; a stored path may be stale after
    // the user pasted a different key in the form. Prefer the inline key.
    let parsed = if let Some(key) = private_key.map(str::trim).filter(|k| !k.is_empty()) {
        russh::keys::decode_secret_key(key, passphrase)
    } else if let Some(path) = key_path.filter(|p| !p.trim().is_empty()) {
        russh::keys::load_secret_key(expand_local_path(path), passphrase)
    } else {
        return Err(AppError::Auth(
            "key authentication requires a private key or a key path".into(),
        ));
    };

    parsed.map_err(|e| {
        let reason = match &e {
            russh::keys::Error::KeyIsEncrypted if passphrase.is_some() => {
                "the key is encrypted and the supplied passphrase is incorrect"
            }
            russh::keys::Error::KeyIsEncrypted => {
                "the key is encrypted and no passphrase was provided; enter it in the profile's Key passphrase field"
            }
            russh::keys::Error::KeyIsCorrupt => "the key file is corrupt",
            russh::keys::Error::UnsupportedKeyType { .. }
            | russh::keys::Error::UnknownAlgorithm(_) => {
                "unsupported key format; use an OpenSSH, PEM PKCS#1 or PKCS#8 private key"
            }
            _ => "the key could not be decoded; check the file and the passphrase",
        };
        let source = key_path
            .filter(|p| !p.trim().is_empty())
            .map(|p| format!(" from {p}"))
            .unwrap_or_else(|| " from the pasted key".to_string());
        AppError::Auth(format!(
            "could not load the SSH private key{source}: {reason} ({e})"
        ))
    })
}

/// Inspect a local private key without connecting. Used by the profile form to
/// warn as soon as the file picker returns an encrypted key.
pub fn probe_private_key(path: &str) -> KeyProbe {
    let expanded = expand_local_path(path);
    let display = expanded.to_string_lossy().to_string();

    if !expanded.is_file() {
        return KeyProbe {
            path: display,
            exists: false,
            encrypted: false,
            valid: false,
            error: Some("the file does not exist or is not a regular file".into()),
        };
    }

    match russh::keys::load_secret_key(&expanded, None) {
        Ok(_) => KeyProbe {
            path: display,
            exists: true,
            encrypted: false,
            valid: true,
            error: None,
        },
        Err(russh::keys::Error::KeyIsEncrypted) => KeyProbe {
            path: display,
            exists: true,
            encrypted: true,
            valid: false,
            error: None,
        },
        Err(error) => KeyProbe {
            path: display,
            exists: true,
            encrypted: false,
            valid: false,
            error: Some(error.to_string()),
        },
    }
}

impl SshConnection {
    pub async fn connect(
        profile: &ConnectionProfile,
        known_hosts: Arc<KnownHostsStore>,
    ) -> AppResult<Self> {
        if profile.host.trim().is_empty() {
            return Err(AppError::Validation("host is required".into()));
        }
        if profile.username.trim().is_empty() {
            return Err(AppError::Validation("username is required".into()));
        }

        let observed = Arc::new(std::sync::Mutex::new(None));
        let config = Arc::new(russh::client::Config {
            inactivity_timeout: None,
            keepalive_interval: (profile.keepalive_secs > 0)
                .then(|| Duration::from_secs(profile.keepalive_secs)),
            keepalive_max: 3,
            nodelay: true,
            ..Default::default()
        });

        let connect_timeout = Duration::from_secs(profile.connect_timeout_secs.clamp(3, 120));
        let connecting = russh::client::connect(
            config,
            (profile.host.as_str(), profile.port),
            ClientHandler::new(&profile.host, profile.port, known_hosts, observed.clone()),
        );

        let mut session = tokio::time::timeout(connect_timeout, connecting)
            .await
            .map_err(|_| {
                AppError::Timeout(format!(
                    "no SSH handshake with {}:{} after {}s",
                    profile.host, profile.port, profile.connect_timeout_secs
                ))
            })?
            .map_err(|e| {
                AppError::Ssh(format!(
                    "cannot connect to {}:{}: {e}",
                    profile.host, profile.port
                ))
            })?;

        let inline_key = profile
            .private_key
            .as_deref()
            .map(|k| !k.trim().is_empty())
            .unwrap_or(false);
        let key_source = if inline_key {
            "inline"
        } else if profile.key_path.is_some() {
            "file"
        } else {
            "none"
        };
        tracing::info!(
            target: "twoshell::ssh",
            "auth user={} method={:?} key_source={} has_passphrase={}",
            profile.username,
            profile.auth_method,
            key_source,
            profile.passphrase.is_some()
        );

        match profile.auth_method {
            AuthMethod::Password => {
                let password = profile.password.clone().ok_or_else(|| {
                    AppError::Auth("password authentication selected but no password stored".into())
                })?;
                let result = session
                    .authenticate_password(&profile.username, password)
                    .await
                    .map_err(|e| AppError::Auth(format!("password authentication failed: {e}")))?;
                if !result.success() {
                    return Err(AppError::Auth(format!(
                        "password rejected for user '{}'",
                        profile.username
                    )));
                }
            }
            AuthMethod::Key => {
                // Do not trim: passphrases may legitimately contain spaces.
                let passphrase = profile.passphrase.as_deref().filter(|p| !p.is_empty());
                let key = load_private_key(
                    profile.key_path.as_deref(),
                    profile.private_key.as_deref(),
                    passphrase,
                )?;
                let hash = session
                    .best_supported_rsa_hash()
                    .await
                    .map_err(|e| AppError::Auth(format!("RSA negotiation failed: {e}")))?;
                let result = session
                    .authenticate_publickey(
                        &profile.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key), hash.flatten()),
                    )
                    .await
                    .map_err(|e| AppError::Auth(format!("key authentication failed: {e}")))?;
                if !result.success() {
                    return Err(AppError::Auth(format!(
                        "public key rejected for user '{}': not authorized on the server",
                        profile.username
                    )));
                }
            }
        }

        let fingerprint = observed
            .lock()
            .ok()
            .and_then(|fp| fp.clone())
            .unwrap_or_else(|| "unknown".to_string());

        tracing::info!(
            target: "twoshell::ssh",
            "authenticated {}@{}:{} ({})",
            profile.username,
            profile.host,
            profile.port,
            fingerprint
        );

        Ok(Self {
            fingerprint,
            handle: session,
        })
    }

    pub fn is_closed(&self) -> bool {
        self.handle.is_closed()
    }

    /// Run one command through a dedicated session channel and capture output.
    pub async fn exec(&self, command: &str, timeout: Duration) -> AppResult<ExecOutput> {
        let fut = async {
            let mut channel = self
                .handle
                .channel_open_session()
                .await
                .map_err(|e| AppError::Ssh(format!("cannot open exec channel: {e}")))?;

            channel
                .exec(true, command.to_string())
                .await
                .map_err(|e| AppError::Ssh(format!("cannot start remote command: {e}")))?;

            let mut stdout: Vec<u8> = Vec::new();
            let mut stderr: Vec<u8> = Vec::new();
            let mut exit_status: Option<i32> = None;
            let mut saw_eof = false;
            let mut truncated = false;

            loop {
                // Some servers send EOF before the exit-status packet. Do not
                // break immediately: wait briefly for the status so a successful
                // `cat` is not reported as a failure.
                let message = if saw_eof {
                    match tokio::time::timeout(Duration::from_secs(1), channel.wait()).await {
                        Ok(message) => message,
                        Err(_) => break,
                    }
                } else {
                    channel.wait().await
                };

                match message {
                    Some(russh::ChannelMsg::Data { data }) => {
                        if stdout.len() < MAX_EXEC_OUTPUT {
                            let room = MAX_EXEC_OUTPUT - stdout.len();
                            stdout.extend_from_slice(&data[..data.len().min(room)]);
                            if data.len() > room {
                                truncated = true;
                            }
                        } else {
                            truncated = true;
                        }
                    }
                    Some(russh::ChannelMsg::ExtendedData { data, ext }) => {
                        if ext == 1 && stderr.len() < MAX_EXEC_OUTPUT {
                            let room = MAX_EXEC_OUTPUT - stderr.len();
                            stderr.extend_from_slice(&data[..data.len().min(room)]);
                        }
                    }
                    Some(russh::ChannelMsg::ExitStatus { exit_status: code }) => {
                        exit_status = Some(code as i32);
                        if saw_eof {
                            break;
                        }
                    }
                    Some(russh::ChannelMsg::Eof) => {
                        if exit_status.is_some() {
                            break;
                        }
                        saw_eof = true;
                    }
                    Some(russh::ChannelMsg::Close) | None => break,
                    _ => {}
                }
            }

            if truncated {
                stderr.extend_from_slice(b"\n[2shell: output truncated at 4 MiB]\n");
            }

            Ok(ExecOutput {
                stdout: String::from_utf8_lossy(&stdout).to_string(),
                stderr: String::from_utf8_lossy(&stderr).to_string(),
                exit_status: exit_status.unwrap_or(-1),
            })
        };

        tokio::time::timeout(timeout, fut).await.map_err(|_| {
            AppError::Timeout(format!(
                "remote command timed out after {}s",
                timeout.as_secs()
            ))
        })?
    }

    /// Open an interactive PTY-backed shell. The channel is split so the reader
    /// and writer can live in independent tasks without borrowing conflicts.
    pub async fn open_shell(
        &self,
        cols: u32,
        rows: u32,
    ) -> AppResult<(russh::ChannelReadHalf, Box<dyn ShellWriter>)> {
        let channel = self
            .handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::Terminal(format!("cannot open shell channel: {e}")))?;

        channel
            .request_pty(
                true,
                "xterm-256color",
                cols.clamp(20, 500),
                rows.clamp(5, 300),
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| AppError::Terminal(format!("PTY request failed: {e}")))?;

        channel
            .request_shell(true)
            .await
            .map_err(|e| AppError::Terminal(format!("shell request failed: {e}")))?;

        let (read_half, write_half) = channel.split();
        Ok((read_half, Box::new(write_half)))
    }
}

// ---------------------------------------------------------------------------
// ShellWriter: erase the private `Msg` type from the public API
// ---------------------------------------------------------------------------

pub type BoxFuture<'a, T> = Pin<Box<dyn Future<Output = T> + Send + 'a>>;

pub trait ShellWriter: Send + Sync {
    fn write(&self, data: Vec<u8>) -> BoxFuture<'_, AppResult<()>>;
    fn resize(&self, cols: u32, rows: u32) -> BoxFuture<'_, AppResult<()>>;
    fn close(&self) -> BoxFuture<'_, AppResult<()>>;
}

impl<S> ShellWriter for russh::ChannelWriteHalf<S>
where
    S: From<(russh::ChannelId, russh::ChannelMsg)> + Send + Sync + 'static,
{
    fn write(&self, data: Vec<u8>) -> BoxFuture<'_, AppResult<()>> {
        Box::pin(async move {
            self.data_bytes(data)
                .await
                .map_err(|e| AppError::Terminal(format!("terminal write failed: {e}")))
        })
    }

    fn resize(&self, cols: u32, rows: u32) -> BoxFuture<'_, AppResult<()>> {
        Box::pin(async move {
            self.window_change(cols.clamp(20, 500), rows.clamp(5, 300), 0, 0)
                .await
                .map_err(|e| AppError::Terminal(format!("terminal resize failed: {e}")))
        })
    }

    fn close(&self) -> BoxFuture<'_, AppResult<()>> {
        Box::pin(async move {
            let _ = self.eof().await;
            self.close()
                .await
                .map_err(|e| AppError::Terminal(format!("terminal close failed: {e}")))
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn probe_reports_a_missing_key() {
        let probe = probe_private_key("/nonexistent/2shell-test-key");
        assert!(!probe.exists);
        assert!(!probe.valid);
        assert!(probe.error.is_some());
    }

    #[test]
    fn expands_home_paths() {
        std::env::set_var("HOME", "/home/tester");
        assert_eq!(
            expand_local_path("~/.ssh/id_ed25519"),
            PathBuf::from("/home/tester/.ssh/id_ed25519")
        );
        assert_eq!(expand_local_path("/abs/key"), PathBuf::from("/abs/key"));
    }
}
