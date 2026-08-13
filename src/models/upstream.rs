use serde::{Deserialize, Serialize};
use std::collections::HashMap;

// ── DB row ────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct UpstreamRow {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub model_names: String,    // JSON array string "[]"
    pub model_prefixes: String, // JSON array string "[]"
    pub model_mappings: String, // JSON object string "{}"
    pub priority: i32,
    pub weight: i64,
    pub auto_weight_enabled: i64, // 0 or 1
    pub enabled: i64,             // 0 or 1
    pub extra_headers: String,    // JSON object string "{}"
    pub timeout_seconds: f64,
    pub created_at: String,
    pub updated_at: String,
}

// ── Input models ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
pub struct UpstreamIn {
    pub name: String,
    pub base_url: String,
    #[serde(default)]
    pub api_key: Option<String>,
    #[serde(default)]
    pub model_names: Vec<String>,
    #[serde(default)]
    pub model_prefixes: Vec<String>,
    #[serde(default)]
    pub model_mappings: HashMap<String, String>,
    #[serde(default = "default_priority")]
    pub priority: i32,
    #[serde(default = "default_weight")]
    pub weight: i64,
    #[serde(default = "default_enabled")]
    pub auto_weight_enabled: bool,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
    #[serde(default)]
    pub extra_headers: HashMap<String, String>,
    #[serde(default)]
    pub timeout_seconds: Option<f64>,
}

fn default_priority() -> i32 {
    100
}

fn default_weight() -> i64 {
    100
}

fn default_enabled() -> bool {
    true
}

impl UpstreamIn {
    pub fn validate(&self) -> Result<(), &'static str> {
        if !(0..=10_000).contains(&self.weight) {
            return Err("weight must be between 0 and 10000");
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpstreamUpdate {
    #[serde(flatten)]
    pub base: UpstreamIn,
    #[serde(default)]
    pub clear_api_key: bool,
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpstreamEnabledIn {
    pub enabled: bool,
}

// ── Import / export ───────────────────────────────────────────────────────────

/// Envelope marker so an unrelated JSON file cannot be mistaken for a channel
/// export.
pub const CHANNEL_DOCUMENT_KIND: &str = "wildtoken.channels";
pub const CHANNEL_DOCUMENT_VERSION: u32 = 1;
/// Upper bound on one imported document, checked in addition to the framework's
/// request body limit.
pub const CHANNEL_IMPORT_MAX_ENTRIES: usize = 500;

#[derive(Debug, Clone, Default, Deserialize)]
pub struct ChannelExportRequest {
    /// Channel ids to export; `None` or an empty list exports every channel.
    #[serde(default)]
    pub ids: Option<Vec<i64>>,
    #[serde(default = "default_enabled")]
    pub include_api_keys: bool,
}

/// One exported channel. Fields mirror [`UpstreamIn`] so a document round-trips
/// through the import path without a conversion step. Runtime-only state (id,
/// timestamps, health scores) is deliberately absent.
#[derive(Debug, Clone, Serialize)]
pub struct ChannelExportItem {
    pub name: String,
    pub base_url: String,
    /// Omitted entirely when keys are excluded, so importing such a document
    /// leaves an existing stored key untouched.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub api_key: Option<String>,
    pub model_names: Vec<String>,
    pub model_prefixes: Vec<String>,
    pub model_mappings: HashMap<String, String>,
    pub priority: i32,
    pub weight: i64,
    pub auto_weight_enabled: bool,
    pub enabled: bool,
    pub extra_headers: HashMap<String, String>,
    pub timeout_seconds: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelExportDocument {
    pub kind: &'static str,
    pub version: u32,
    pub exported_at: String,
    pub channels: Vec<ChannelExportItem>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelImportMode {
    /// Leave an existing same-name channel alone.
    Skip,
    /// Update an existing same-name channel in place, keeping its id.
    Overwrite,
}

#[derive(Debug, Clone, Deserialize)]
pub struct ChannelImportRequest {
    #[serde(default)]
    pub kind: Option<String>,
    #[serde(default)]
    pub version: Option<u32>,
    pub channels: Vec<UpstreamIn>,
    pub mode: ChannelImportMode,
}

impl ChannelImportRequest {
    /// Reject documents that are not channel exports before touching the
    /// database. An absent `kind` is accepted so a hand-written list of
    /// channels still imports.
    pub fn validate(&self) -> Result<(), String> {
        if let Some(kind) = self.kind.as_deref().map(str::trim) {
            if !kind.is_empty() && kind != CHANNEL_DOCUMENT_KIND {
                return Err(format!(
                    "不是渠道导出文件：kind 应为 {CHANNEL_DOCUMENT_KIND}，实际为 {kind}"
                ));
            }
        }
        if let Some(version) = self.version {
            if version > CHANNEL_DOCUMENT_VERSION {
                return Err(format!(
                    "文档版本 {version} 高于当前支持的 {CHANNEL_DOCUMENT_VERSION}，请升级 WildToken"
                ));
            }
        }
        if self.channels.is_empty() {
            return Err("文档里没有渠道".into());
        }
        if self.channels.len() > CHANNEL_IMPORT_MAX_ENTRIES {
            return Err(format!(
                "一次最多导入 {CHANNEL_IMPORT_MAX_ENTRIES} 个渠道，当前 {}",
                self.channels.len()
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelImportAction {
    Created,
    Updated,
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
pub struct ChannelImportItemOut {
    pub name: String,
    pub action: ChannelImportAction,
    /// Reason for a skip or failure. Never carries credential material.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub message: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize)]
pub struct ChannelImportOut {
    pub created: usize,
    pub updated: usize,
    pub skipped: usize,
    pub failed: usize,
    pub items: Vec<ChannelImportItemOut>,
}

impl ChannelImportOut {
    pub fn record(&mut self, name: String, action: ChannelImportAction, message: Option<String>) {
        match action {
            ChannelImportAction::Created => self.created += 1,
            ChannelImportAction::Updated => self.updated += 1,
            ChannelImportAction::Skipped => self.skipped += 1,
            ChannelImportAction::Failed => self.failed += 1,
        }
        self.items.push(ChannelImportItemOut {
            name,
            action,
            message,
        });
    }
}

#[derive(Debug, Clone, Deserialize)]
pub struct UpstreamPriorityIn {
    pub priority: i32,
}

// ── Output models ─────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct UpstreamOut {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    pub api_key_set: bool,
    pub model_names: Vec<String>,
    pub model_prefixes: Vec<String>,
    pub model_mappings: HashMap<String, String>,
    pub priority: i32,
    pub weight: i64,
    pub auto_weight_enabled: bool,
    pub enabled: bool,
    pub extra_headers: HashMap<String, String>,
    pub timeout_seconds: f64,
    pub created_at: String,
    pub updated_at: String,
    pub runtime_health_score: i64,
    pub effective_weight: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_recovery_remaining_seconds: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct UpstreamDetailOut {
    pub id: i64,
    pub name: String,
    pub base_url: String,
    pub api_key: Option<String>,
    pub api_key_set: bool,
    pub model_names: Vec<String>,
    pub model_prefixes: Vec<String>,
    pub model_mappings: HashMap<String, String>,
    pub priority: i32,
    pub weight: i64,
    pub auto_weight_enabled: bool,
    pub enabled: bool,
    pub extra_headers: HashMap<String, String>,
    pub timeout_seconds: f64,
    pub created_at: String,
    pub updated_at: String,
    pub runtime_health_score: i64,
    pub effective_weight: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub health_recovery_remaining_seconds: Option<i64>,
}
