use crate::application::audit::AuditService;
use crate::application::metrics::MetricsService;
use crate::application::pool::PoolManager;
use crate::application::profiles::ProfileService;
use crate::application::terminal::TerminalManager;
use crate::infrastructure::crypto::SecretBox;
use crate::infrastructure::storage::Storage;
use crate::ssh::KnownHostsStore;
use std::sync::Arc;

pub struct AppState {
    pub audit: Arc<AuditService>,
    pub profiles: Arc<ProfileService>,
    pub pools: Arc<PoolManager>,
    pub terminals: Arc<TerminalManager>,
    pub metrics: Arc<MetricsService>,
}

impl AppState {
    pub fn new(storage: Arc<Storage>, secrets: Arc<SecretBox>) -> Self {
        let audit = Arc::new(AuditService::new(storage.clone()));
        let profiles = Arc::new(ProfileService::new(storage.clone(), secrets));
        let known_hosts = Arc::new(KnownHostsStore::new(storage.clone()));
        let pools = Arc::new(PoolManager::new(
            profiles.clone(),
            known_hosts.clone(),
            audit.clone(),
        ));

        Self {
            audit: audit.clone(),
            profiles,
            pools,
            terminals: Arc::new(TerminalManager::new(audit)),
            metrics: Arc::new(MetricsService::new()),
        }
    }
}
