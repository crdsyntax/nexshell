use crate::application::audit::{AuditEvent, AuditService};
use crate::application::profiles::ProfileService;
use crate::error::{AppError, AppResult};
use crate::models::{ConnectionProfile, ExecOutput, PoolStats, RetryPolicy};
use crate::ssh::{KnownHostsStore, SshConnection};
use rand::Rng;
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

struct IdleConnection {
    connection: Arc<SshConnection>,
    last_used: Instant,
}

#[derive(Default)]
struct PoolInner {
    idle: Vec<IdleConnection>,
    total: usize,
    closed: bool,
}

/// Bounded pool of authenticated SSH transports.
///
/// Each lease owns one transport; a transport can host many logical channels,
/// but pooling transports keeps a hard ceiling on sockets and makes retry and
/// backoff behaviour explicit and observable from the UI.
pub struct ConnectionPool {
    profile_id: String,
    profile_name: String,
    profile: ConnectionProfile,
    known_hosts: Arc<KnownHostsStore>,
    audit: Arc<AuditService>,
    max_connections: usize,
    acquire_timeout: Duration,
    idle_timeout: Duration,
    retry: RetryPolicy,
    inner: Mutex<PoolInner>,
    notify: tokio::sync::Notify,
}

impl ConnectionPool {
    pub fn new(
        profile: ConnectionProfile,
        known_hosts: Arc<KnownHostsStore>,
        audit: Arc<AuditService>,
    ) -> Self {
        Self {
            profile_id: profile.id.clone(),
            profile_name: profile.name.clone(),
            max_connections: profile.pool.max_connections.max(1) as usize,
            acquire_timeout: Duration::from_millis(profile.pool.acquire_timeout_ms.max(500)),
            idle_timeout: Duration::from_secs(profile.pool.idle_timeout_secs.max(10)),
            retry: profile.retry.clone(),
            profile,
            known_hosts,
            audit,
            inner: Mutex::new(PoolInner::default()),
            notify: tokio::sync::Notify::new(),
        }
    }

    pub async fn acquire(self: &Arc<Self>) -> AppResult<PoolLease> {
        let deadline = Instant::now() + self.acquire_timeout;

        loop {
            if let Some(connection) = self.take_idle() {
                return Ok(PoolLease::new(Arc::clone(self), connection));
            }

            let reserved = {
                let mut inner = self.lock_inner()?;
                if inner.closed {
                    return Err(AppError::Pool(format!(
                        "pool for profile {} is closed",
                        self.profile_id
                    )));
                }
                if inner.total < self.max_connections {
                    inner.total += 1;
                    true
                } else {
                    false
                }
            };

            if reserved {
                match self.connect_with_retry().await {
                    Ok(connection) => {
                        return Ok(PoolLease::new(Arc::clone(self), Arc::new(connection)))
                    }
                    Err(error) => {
                        if let Ok(mut inner) = self.inner.lock() {
                            inner.total = inner.total.saturating_sub(1);
                        }
                        self.notify.notify_waiters();
                        return Err(error);
                    }
                }
            }

            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err(AppError::Pool(format!(
                    "timed out after {} ms waiting for a free connection (max {})",
                    self.acquire_timeout.as_millis(),
                    self.max_connections
                )));
            }

            if tokio::time::timeout(remaining, self.notify.notified())
                .await
                .is_err()
            {
                return Err(AppError::Pool(format!(
                    "timed out after {} ms waiting for a free connection (max {})",
                    self.acquire_timeout.as_millis(),
                    self.max_connections
                )));
            }
        }
    }

    pub fn stats(&self) -> PoolStats {
        let (total, idle) = match self.inner.lock() {
            Ok(inner) => (inner.total as u32, inner.idle.len() as u32),
            Err(_) => (0, 0),
        };
        PoolStats {
            profile_id: self.profile_id.clone(),
            max_connections: self.max_connections as u32,
            total,
            idle,
            in_use: total.saturating_sub(idle),
            acquire_timeout_ms: self.acquire_timeout.as_millis() as u64,
        }
    }

    pub fn close(&self) {
        let mut idle = Vec::new();
        if let Ok(mut inner) = self.inner.lock() {
            inner.closed = true;
            idle = std::mem::take(&mut inner.idle);
            inner.total = inner.total.saturating_sub(idle.len());
        }
        drop(idle);
        self.notify.notify_waiters();
    }

    fn take_idle(&self) -> Option<Arc<SshConnection>> {
        let mut selected = None;
        if let Ok(mut inner) = self.inner.lock() {
            let mut index = 0;
            while index < inner.idle.len() {
                let expired = inner.idle[index].connection.is_closed()
                    || inner.idle[index].last_used.elapsed() > self.idle_timeout;
                if expired {
                    inner.idle.remove(index);
                    inner.total = inner.total.saturating_sub(1);
                } else if selected.is_none() {
                    // Lease it: ownership moves out of the idle list, so the
                    // total count stays unchanged (it is now in use).
                    selected = Some(inner.idle.remove(index).connection);
                } else {
                    index += 1;
                }
            }
        }
        selected
    }

    fn lock_inner(&self) -> AppResult<std::sync::MutexGuard<'_, PoolInner>> {
        self.inner
            .lock()
            .map_err(|_| AppError::Pool("connection pool lock poisoned".into()))
    }

    fn release(&self, connection: Arc<SshConnection>) {
        let alive = !connection.is_closed();
        if let Ok(mut inner) = self.inner.lock() {
            if inner.closed || !alive {
                inner.total = inner.total.saturating_sub(1);
            } else {
                inner.idle.push(IdleConnection {
                    connection,
                    last_used: Instant::now(),
                });
            }
        }
        self.notify.notify_one();
    }

    async fn connect_with_retry(&self) -> AppResult<SshConnection> {
        let mut last_error: Option<AppError> = None;

        for attempt in 0..=self.retry.max_retries {
            let started = Instant::now();
            match SshConnection::connect(&self.profile, self.known_hosts.clone()).await {
                Ok(connection) => {
                    tracing::info!(
                        target: "twoshell::pool",
                        "pool[{}] opened transport on attempt {}",
                        self.profile_id,
                        attempt + 1
                    );
                    self.audit.log(
                        AuditEvent::new("connection", "connect", "success")
                            .profile(Some(&self.profile_id), Some(&self.profile_name))
                            .target(format!("{}:{}", self.profile.host, self.profile.port))
                            .duration(started.elapsed().as_millis() as u64)
                            .output(format!("authenticated on attempt {}", attempt + 1)),
                    );
                    return Ok(connection);
                }
                Err(error) => {
                    if !error.is_retryable() {
                        tracing::warn!(
                            target: "twoshell::pool",
                            "pool[{}] non-retryable failure on attempt {}: {}",
                            self.profile_id,
                            attempt + 1,
                            error
                        );
                        self.audit.log(
                            AuditEvent::new("connection", "connect", "error")
                                .profile(Some(&self.profile_id), Some(&self.profile_name))
                                .target(format!("{}:{}", self.profile.host, self.profile.port))
                                .duration(started.elapsed().as_millis() as u64)
                                .error(error.to_string()),
                        );
                        return Err(error);
                    }
                    tracing::warn!(
                        target: "twoshell::pool",
                        "pool[{}] connect attempt {} failed: {}",
                        self.profile_id,
                        attempt + 1,
                        error
                    );
                    let delay = backoff_delay(&self.retry, attempt);
                    last_error = Some(error);
                    if attempt < self.retry.max_retries {
                        tokio::time::sleep(delay).await;
                    }
                }
            }
        }

        let error = last_error.unwrap_or_else(|| AppError::Ssh("unknown connection error".into()));
        let final_error = AppError::Ssh(format!(
            "{} (after {} attempt(s))",
            error,
            self.retry.max_retries + 1
        ));
        self.audit.log(
            AuditEvent::new("connection", "connect", "error")
                .profile(Some(&self.profile_id), Some(&self.profile_name))
                .target(format!("{}:{}", self.profile.host, self.profile.port))
                .error(final_error.to_string()),
        );
        Err(final_error)
    }
}

pub struct PoolLease {
    pool: Arc<ConnectionPool>,
    connection: Option<Arc<SshConnection>>,
}

impl PoolLease {
    fn new(pool: Arc<ConnectionPool>, connection: Arc<SshConnection>) -> Self {
        Self {
            pool,
            connection: Some(connection),
        }
    }

    pub fn connection(&self) -> &Arc<SshConnection> {
        self.connection
            .as_ref()
            .expect("pool lease always holds a connection until drop")
    }
}

impl Drop for PoolLease {
    fn drop(&mut self) {
        if let Some(connection) = self.connection.take() {
            self.pool.release(connection);
        }
    }
}

pub fn backoff_delay(policy: &RetryPolicy, attempt: u32) -> Duration {
    let exponential = policy
        .base_delay_ms
        .saturating_mul(1u64 << attempt.min(16))
        .min(policy.max_delay_ms);
    let jitter = if policy.jitter {
        rand::thread_rng().gen_range(0..=(policy.base_delay_ms / 2).max(1))
    } else {
        0
    };
    Duration::from_millis(exponential.saturating_add(jitter))
}

// ---------------------------------------------------------------------------
// Pool registry
// ---------------------------------------------------------------------------

pub struct PoolManager {
    profiles: Arc<ProfileService>,
    known_hosts: Arc<KnownHostsStore>,
    audit: Arc<AuditService>,
    pools: RwLock<HashMap<String, Arc<ConnectionPool>>>,
}

impl PoolManager {
    pub fn new(
        profiles: Arc<ProfileService>,
        known_hosts: Arc<KnownHostsStore>,
        audit: Arc<AuditService>,
    ) -> Self {
        Self {
            profiles,
            known_hosts,
            audit,
            pools: RwLock::new(HashMap::new()),
        }
    }

    pub async fn pool(&self, profile_id: &str) -> AppResult<Arc<ConnectionPool>> {
        if let Some(pool) = self.pools.read().await.get(profile_id).cloned() {
            return Ok(pool);
        }

        let profile = self.profiles.get(profile_id)?;
        let mut pools = self.pools.write().await;
        if let Some(pool) = pools.get(profile_id).cloned() {
            return Ok(pool);
        }
        let pool = Arc::new(ConnectionPool::new(
            profile,
            self.known_hosts.clone(),
            self.audit.clone(),
        ));
        pools.insert(profile_id.to_string(), pool.clone());
        Ok(pool)
    }

    pub async fn invalidate(&self, profile_id: &str) {
        if let Some(pool) = self.pools.write().await.remove(profile_id) {
            pool.close();
        }
    }

    pub async fn stats(&self, profile_id: &str) -> AppResult<PoolStats> {
        Ok(self.pool(profile_id).await?.stats())
    }

    pub async fn check(&self, profile_id: &str) -> AppResult<()> {
        let pool = self.pool(profile_id).await?;
        let lease = pool.acquire().await?;
        if lease.connection().is_closed() {
            return Err(AppError::Ssh(
                "transport closed immediately after connect".into(),
            ));
        }
        Ok(())
    }

    pub async fn execute_service(
        &self,
        profile_id: &str,
        command: &str,
        timeout: Duration,
    ) -> AppResult<ExecOutput> {
        self.execute_with_category(profile_id, command, timeout, "service")
            .await
    }

    pub async fn execute_process(
        &self,
        profile_id: &str,
        command: &str,
        timeout: Duration,
    ) -> AppResult<ExecOutput> {
        self.execute_with_category(profile_id, command, timeout, "process")
            .await
    }

    pub async fn execute_filesystem(
        &self,
        profile_id: &str,
        command: &str,
        timeout: Duration,
    ) -> AppResult<ExecOutput> {
        self.execute_with_category(profile_id, command, timeout, "filesystem")
            .await
    }

    pub async fn execute_command(
        &self,
        profile_id: &str,
        command: &str,
        timeout: Duration,
    ) -> AppResult<ExecOutput> {
        self.execute_with_category(profile_id, command, timeout, "command")
            .await
    }

    /// Execute SQL that contains a password. The audit trail records only the
    /// outcome, never the command or its output.
    pub async fn execute_sensitive(
        &self,
        profile_id: &str,
        command: &str,
        timeout: Duration,
    ) -> AppResult<ExecOutput> {
        let pool = self.pool(profile_id).await?;
        let lease = pool.acquire().await?;
        let started = Instant::now();
        let result = lease.connection().exec(command, timeout).await;
        let status = match &result {
            Ok(output) if output.success() => "success",
            Ok(_) => "failed",
            Err(_) => "error",
        };
        let mut event = AuditEvent::new("database", "sensitive-exec", status)
            .profile(Some(profile_id), Some(&pool.profile_name))
            .target("sensitive SQL")
            .duration(started.elapsed().as_millis() as u64);
        if let Ok(output) = &result {
            event = event.exit(Some(output.exit_status));
        }
        self.audit.log(event);
        result
    }

    /// Polling/status checks that should not pollute the audit trail.
    pub async fn execute_silent(
        &self,
        profile_id: &str,
        command: &str,
        timeout: Duration,
    ) -> AppResult<ExecOutput> {
        self.execute_with_category(profile_id, command, timeout, "silent")
            .await
    }

    /// Execute a remote command and append it to the audit trail. `metrics` is
    /// deliberately excluded to avoid logging every poll.
    pub async fn execute_with_category(
        &self,
        profile_id: &str,
        command: &str,
        timeout: Duration,
        category: &str,
    ) -> AppResult<ExecOutput> {
        let pool = self.pool(profile_id).await?;
        let lease = pool.acquire().await?;
        let started = Instant::now();
        let result = lease.connection().exec(command, timeout).await;

        if category != "metrics" && category != "silent" {
            let status = match &result {
                Ok(output) if output.success() => "success",
                Ok(_) => "failed",
                Err(_) => "error",
            };
            let mut event = AuditEvent::new(category, "exec", status)
                .profile(Some(profile_id), Some(&pool.profile_name))
                .command(command)
                .duration(started.elapsed().as_millis() as u64);
            match &result {
                Ok(output) => {
                    event = event
                        .exit(Some(output.exit_status))
                        .output(format!("{}{}", output.stdout, output.stderr));
                }
                Err(error) => {
                    event = event.error(error.to_string());
                }
            }
            self.audit.log(event);
        }

        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    fn policy() -> RetryPolicy {
        RetryPolicy {
            max_retries: 5,
            base_delay_ms: 100,
            max_delay_ms: 1_000,
            jitter: false,
        }
    }

    #[test]
    fn backoff_grows_exponentially_and_caps() {
        let p = policy();
        assert_eq!(backoff_delay(&p, 0), Duration::from_millis(100));
        assert_eq!(backoff_delay(&p, 1), Duration::from_millis(200));
        assert_eq!(backoff_delay(&p, 3), Duration::from_millis(800));
        assert_eq!(backoff_delay(&p, 10), Duration::from_millis(1_000));
    }

    #[test]
    fn jitter_stays_inside_bounds() {
        let p = RetryPolicy {
            jitter: true,
            ..policy()
        };
        for _ in 0..100 {
            let delay = backoff_delay(&p, 1).as_millis() as u64;
            assert!((200..=250).contains(&delay), "delay={delay}");
        }
    }
}
