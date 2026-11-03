use crate::application::sharing::envelope::ShareMode;
use crate::application::sharing::payload::{DbTargetShare, HostKeyShare, OriginInfo, ProfileShare};
use serde::{Deserialize, Serialize};
use zeroize::Zeroize;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePrepareOptions {
    pub mode: ShareMode,
    pub include_ssh_password: bool,
    pub include_private_key: bool,
    pub include_private_key_file: bool,
    pub include_passphrase: bool,
    pub include_database: bool,
    pub include_database_password: bool,
    pub include_host_key: bool,
    pub expires_in_secs: i64,
    #[serde(default)]
    pub database_override: Option<DbTargetShare>,
}

#[derive(Clone, Serialize, Deserialize, Zeroize)]
#[zeroize(drop)]
#[serde(rename_all = "camelCase")]
pub struct SharePrepareResult {
    pub share_id: String,
    pub passphrase: String,
    #[zeroize(skip)]
    pub mode: ShareMode,
    pub expires_at: i64,
    pub warnings: Vec<String>,
}

impl std::fmt::Debug for SharePrepareResult {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SharePrepareResult")
            .field("share_id", &self.share_id)
            .field("mode", &self.mode)
            .field("expires_at", &self.expires_at)
            .field("warnings", &self.warnings)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareExportResult {
    pub path: String,
    pub bytes: u64,
    pub sha256: String,
    pub expires_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareHeaderView {
    pub format: String,
    pub version: u32,
    pub share_id: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub mode: ShareMode,
    pub bytes: u64,
    pub expired: bool,
    pub needs_passphrase: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareConflictCandidate {
    pub profile_id: String,
    pub profile_name: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub matched_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareConnectionPreview {
    pub share_entry_id: String,
    pub profile: ProfileShare,
    pub has_ssh_password: bool,
    pub has_private_key: bool,
    pub has_passphrase: bool,
    pub has_database_password: bool,
    pub needs_credentials: bool,
    pub key_path_hint: Option<String>,
    pub host_key: Option<HostKeyShare>,
    pub database: Option<DbTargetShare>,
    pub conflicts: Vec<ShareConflictCandidate>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SharePreview {
    pub share_id: String,
    pub created_at: i64,
    pub expires_at: i64,
    pub mode: ShareMode,
    pub origin: Option<OriginInfo>,
    pub connections: Vec<ShareConnectionPreview>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ConflictPolicy {
    Skip,
    Overwrite,
    Duplicate,
}

impl ConflictPolicy {
    pub fn as_str(&self) -> &'static str {
        match self {
            ConflictPolicy::Skip => "skip",
            ConflictPolicy::Overwrite => "overwrite",
            ConflictPolicy::Duplicate => "duplicate",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShareImportOptions {
    pub trust_host_key: bool,
    pub open_database: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportedEntryReport {
    pub share_entry_id: String,
    pub profile_id: String,
    pub action: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SkippedEntryReport {
    pub share_entry_id: String,
    pub existing_profile_id: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HostKeyImportReport {
    pub host: String,
    pub port: u16,
    pub fingerprint: String,
    pub pinned: bool,
}

#[derive(Clone, Serialize, Deserialize, Zeroize)]
#[zeroize(drop)]
#[serde(rename_all = "camelCase")]
pub struct EphemeralDatabase {
    pub profile_id: String,
    pub engine: String,
    pub host: String,
    pub port: u16,
    pub user: String,
    pub password: String,
    pub expires_at: i64,
}

impl std::fmt::Debug for EphemeralDatabase {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("EphemeralDatabase")
            .field("profile_id", &self.profile_id)
            .field("engine", &self.engine)
            .field("host", &self.host)
            .field("port", &self.port)
            .field("user", &self.user)
            .field("expires_at", &self.expires_at)
            .finish()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub share_id: String,
    pub mode: ShareMode,
    pub imported: Vec<ImportedEntryReport>,
    pub skipped: Vec<SkippedEntryReport>,
    pub needs_credentials: Vec<String>,
    pub host_keys: Vec<HostKeyImportReport>,
    pub ephemeral_database: Option<EphemeralDatabase>,
}
