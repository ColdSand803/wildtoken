use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::models::settings::RuntimeSettings;
use crate::models::upstream::UpstreamRow;

pub const MAX_HEALTH_SCORE: i64 = 100;

#[derive(Debug, Clone, Copy)]
pub struct AutoWeightPolicy {
    failure_penalty: i64,
    success_increment: i64,
    recovery_increment: i64,
    recovery_interval: Duration,
}

impl From<&RuntimeSettings> for AutoWeightPolicy {
    fn from(settings: &RuntimeSettings) -> Self {
        Self {
            failure_penalty: settings.auto_weight_failure_penalty,
            success_increment: settings.auto_weight_success_increment,
            recovery_increment: settings.auto_weight_recovery_increment,
            recovery_interval: Duration::from_secs(
                settings.auto_weight_recovery_interval_seconds.max(1) as u64,
            ),
        }
    }
}

struct HealthState {
    score: i64,
    last_adjusted_at: Instant,
}

#[derive(Debug, Clone, Copy)]
pub struct HealthSnapshot {
    pub score: i64,
    pub routing_weight: u64,
    pub effective_weight: f64,
    pub recovery_remaining_seconds: Option<i64>,
}

pub struct AutoWeightManager {
    states: Mutex<HashMap<i64, HealthState>>,
}

impl AutoWeightManager {
    pub fn new() -> Self {
        Self {
            states: Mutex::new(HashMap::new()),
        }
    }

    fn recover(state: &mut HealthState, policy: AutoWeightPolicy, now: Instant) {
        if state.score >= MAX_HEALTH_SCORE || policy.recovery_increment == 0 {
            return;
        }
        let interval_seconds = policy.recovery_interval.as_secs();
        let intervals = now
            .saturating_duration_since(state.last_adjusted_at)
            .as_secs()
            / interval_seconds;
        if intervals == 0 {
            return;
        }
        let recovered = policy
            .recovery_increment
            .saturating_mul(intervals.min(i64::MAX as u64) as i64);
        state.score = state.score.saturating_add(recovered).min(MAX_HEALTH_SCORE);
        state.last_adjusted_at += Duration::from_secs(interval_seconds.saturating_mul(intervals));
    }

    pub fn record_failure(
        &self,
        upstream_id: i64,
        auto_weight_enabled: bool,
        policy: AutoWeightPolicy,
    ) {
        if !auto_weight_enabled {
            return;
        }
        let now = Instant::now();
        let mut guard = self
            .states
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let state = guard.entry(upstream_id).or_insert(HealthState {
            score: MAX_HEALTH_SCORE,
            last_adjusted_at: now,
        });
        Self::recover(state, policy, now);
        state.score = state.score.saturating_sub(policy.failure_penalty).max(0);
        if policy.failure_penalty > 0 {
            // A failure at zero restarts the full recovery interval.
            state.last_adjusted_at = now;
        }
        if state.score == MAX_HEALTH_SCORE {
            guard.remove(&upstream_id);
        }
    }

    pub fn record_success(
        &self,
        upstream_id: i64,
        auto_weight_enabled: bool,
        policy: AutoWeightPolicy,
    ) {
        if !auto_weight_enabled {
            return;
        }
        let now = Instant::now();
        let mut guard = self
            .states
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let Some(state) = guard.get_mut(&upstream_id) else {
            return;
        };
        Self::recover(state, policy, now);
        let previous_score = state.score;
        state.score = state
            .score
            .saturating_add(policy.success_increment)
            .min(MAX_HEALTH_SCORE);
        if state.score != previous_score {
            state.last_adjusted_at = now;
        }
        if state.score == MAX_HEALTH_SCORE {
            guard.remove(&upstream_id);
        }
    }

    pub fn snapshot(
        &self,
        upstream_id: i64,
        weight: i64,
        auto_weight_enabled: bool,
        policy: AutoWeightPolicy,
    ) -> HealthSnapshot {
        let base_weight = weight.max(0) as u64;
        if !auto_weight_enabled {
            return HealthSnapshot {
                score: MAX_HEALTH_SCORE,
                routing_weight: base_weight.saturating_mul(MAX_HEALTH_SCORE as u64),
                effective_weight: weight.max(0) as f64,
                recovery_remaining_seconds: None,
            };
        }

        let now = Instant::now();
        let mut guard = self
            .states
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let mut remove_recovered = false;
        let (score, recovery_remaining_seconds) = match guard.get_mut(&upstream_id) {
            Some(state) => {
                Self::recover(state, policy, now);
                remove_recovered = state.score == MAX_HEALTH_SCORE;
                let remaining = if state.score == 0 && policy.recovery_increment > 0 {
                    let elapsed = now.saturating_duration_since(state.last_adjusted_at);
                    let remaining = policy.recovery_interval.saturating_sub(elapsed);
                    Some(remaining.as_millis().div_ceil(1_000) as i64)
                } else {
                    None
                };
                (state.score, remaining)
            }
            None => (MAX_HEALTH_SCORE, None),
        };
        if remove_recovered {
            guard.remove(&upstream_id);
        }

        HealthSnapshot {
            score,
            routing_weight: base_weight.saturating_mul(score as u64),
            effective_weight: weight.max(0) as f64 * score as f64 / MAX_HEALTH_SCORE as f64,
            recovery_remaining_seconds,
        }
    }

    pub fn reset(&self, upstream_id: i64) {
        self.states
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .remove(&upstream_id);
    }

    #[cfg(test)]
    fn set_last_adjusted_at(&self, upstream_id: i64, last_adjusted_at: Instant) {
        if let Some(state) = self
            .states
            .lock()
            .unwrap_or_else(|error| error.into_inner())
            .get_mut(&upstream_id)
        {
            state.last_adjusted_at = last_adjusted_at;
        }
    }
}

// ── Model matching ───────────────────────────────────────────────────────────

/// Normalize a model name: trim whitespace and lowercase.
fn normalize_model_match(value: &str) -> String {
    value.trim().to_lowercase()
}

#[derive(Clone)]
struct ParsedModelName {
    original: String,
    normalized: String,
}

#[derive(Clone)]
struct ParsedModelMapping {
    key_normalized: String,
    value: Option<String>,
}

#[derive(Clone)]
struct ParsedUpstream {
    row: UpstreamRow,
    model_names: Vec<ParsedModelName>,
    model_prefixes: Vec<String>,
    model_mappings: Vec<ParsedModelMapping>,
}

impl ParsedUpstream {
    fn from_row(row: UpstreamRow) -> Self {
        let model_names = serde_json::from_str::<Vec<String>>(&row.model_names)
            .unwrap_or_default()
            .into_iter()
            .map(|original| ParsedModelName {
                normalized: normalize_model_match(&original),
                original,
            })
            .collect();
        let model_prefixes = serde_json::from_str::<Vec<String>>(&row.model_prefixes)
            .unwrap_or_default()
            .into_iter()
            .map(|prefix| normalize_model_match(&prefix))
            .collect();
        let model_mappings =
            serde_json::from_str::<serde_json::Map<String, serde_json::Value>>(&row.model_mappings)
                .unwrap_or_default()
                .into_iter()
                .map(|(key, value)| ParsedModelMapping {
                    key_normalized: normalize_model_match(&key),
                    value: value.as_str().map(str::to_owned),
                })
                .collect();

        Self {
            row,
            model_names,
            model_prefixes,
            model_mappings,
        }
    }
}

struct UpstreamRoutingSnapshot {
    upstreams: Vec<ParsedUpstream>,
    by_id: HashMap<i64, usize>,
    by_name: HashMap<String, usize>,
}

impl UpstreamRoutingSnapshot {
    fn from_rows(rows: Vec<UpstreamRow>) -> Self {
        let mut upstreams = Vec::with_capacity(rows.len());
        let mut by_id = HashMap::with_capacity(rows.len());
        let mut by_name = HashMap::with_capacity(rows.len());

        for row in rows.into_iter().filter(|row| row.enabled == 1) {
            let index = upstreams.len();
            by_id.insert(row.id, index);
            by_name.insert(row.name.clone(), index);
            upstreams.push(ParsedUpstream::from_row(row));
        }

        Self {
            upstreams,
            by_id,
            by_name,
        }
    }

    fn by_id(&self, id: i64) -> Option<&ParsedUpstream> {
        self.by_id
            .get(&id)
            .and_then(|index| self.upstreams.get(*index))
    }

    fn by_name(&self, name: &str) -> Option<&ParsedUpstream> {
        self.by_name
            .get(name)
            .and_then(|index| self.upstreams.get(*index))
    }
}

/// In-memory cache for enabled upstream routing data.
///
/// The cache stores parsed model fields so the proxy hot path does not query
/// SQLite and reparse JSON on every request. Admin upstream mutations invalidate
/// it; the next proxy request reloads from SQLite.
pub struct UpstreamRoutingCache {
    value: tokio::sync::RwLock<Option<Arc<UpstreamRoutingSnapshot>>>,
    revision: AtomicU64,
}

impl UpstreamRoutingCache {
    pub fn new() -> Self {
        Self {
            value: tokio::sync::RwLock::new(None),
            revision: AtomicU64::new(0),
        }
    }

    async fn get(&self) -> Option<Arc<UpstreamRoutingSnapshot>> {
        self.value.read().await.clone()
    }

    pub async fn invalidate(&self) {
        self.revision.fetch_add(1, Ordering::AcqRel);
        *self.value.write().await = None;
    }

    async fn get_or_load(
        &self,
        pool: &sqlx::SqlitePool,
    ) -> Result<Arc<UpstreamRoutingSnapshot>, AppError> {
        loop {
            if let Some(snapshot) = self.get().await {
                return Ok(snapshot);
            }

            let observed_revision = self.revision.load(Ordering::Acquire);
            let rows = db::upstream::list_enabled_upstreams(pool).await?;
            let loaded = Arc::new(UpstreamRoutingSnapshot::from_rows(rows));

            let mut guard = self.value.write().await;
            if let Some(snapshot) = guard.clone() {
                return Ok(snapshot);
            }
            if self.revision.load(Ordering::Acquire) == observed_revision {
                *guard = Some(loaded.clone());
                return Ok(loaded);
            }
        }
    }

    #[cfg(test)]
    async fn is_cached(&self) -> bool {
        self.value.read().await.is_some()
    }
}

impl Default for UpstreamRoutingCache {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
pub fn model_match_score(upstream: &UpstreamRow, model: Option<&str>) -> i32 {
    parsed_model_match_score(&ParsedUpstream::from_row(upstream.clone()), model)
}

/// Return a match score 0–4.
///
/// - 4: exact match in `model_mappings` or `model_names`
/// - 3: prefix match in `model_prefixes`
/// - 2: any non-exact candidate in `model_names` starts with the requested model
/// - 1: any non-exact candidate in `model_names` ends with the requested model
/// - 0: no match
fn parsed_model_match_score(upstream: &ParsedUpstream, model: Option<&str>) -> i32 {
    let model = match model {
        Some(m) => m,
        None => return 0,
    };

    let req = normalize_model_match(model);

    if upstream
        .model_mappings
        .iter()
        .any(|mapping| mapping.key_normalized == req)
    {
        return 4;
    }

    if upstream
        .model_names
        .iter()
        .any(|name| name.normalized == req)
    {
        return 4;
    }

    for prefix in &upstream.model_prefixes {
        if req.starts_with(prefix) {
            return 3;
        }
    }

    let mut best = 0i32;
    for name in &upstream.model_names {
        if name.normalized.starts_with(&req) {
            best = best.max(2);
        } else if name.normalized.ends_with(&req) {
            best = best.max(1);
        }
    }
    best
}

fn parsed_match_model(upstream: &ParsedUpstream, model: Option<&str>) -> bool {
    model.is_none_or(|model| parsed_model_match_score(upstream, Some(model)) > 0)
}

/// Select the forward model name.
///
/// 1. If there is an exact mapping key → return the mapped value.
/// 2. Else if a model_names candidate starts with / equals the request → return that candidate.
/// 3. Else if a model_names candidate ends with the request → return that candidate.
/// 4. Otherwise fall back to the original model.
fn parsed_select_forward_model(
    upstream: &ParsedUpstream,
    requested_model: Option<&str>,
) -> Option<String> {
    let model = requested_model?;
    let req = normalize_model_match(model);

    for mapping in &upstream.model_mappings {
        if mapping.key_normalized == req {
            if let Some(value) = &mapping.value {
                return Some(value.clone());
            }
        }
    }

    for name in &upstream.model_names {
        if name.normalized.starts_with(&req) || name.normalized == req {
            return Some(name.original.clone());
        }
    }
    for name in &upstream.model_names {
        if !name.normalized.is_empty() && name.normalized.ends_with(&req) {
            return Some(name.original.clone());
        }
    }

    Some(model.to_string())
}

// ── Upstream selection ───────────────────────────────────────────────────────

use crate::db;
use crate::error::AppError;
use rand::distributions::{Distribution, WeightedIndex};

/// Core upstream selection.
///
/// 1. Direct selection via `x-wildtoken-upstream` header or `upstream` query param
///    (value can be an id or a name).
/// 2. Otherwise fetch all enabled upstreams.
/// 3. Filter by model match score, keeping only those with the highest score.
/// 4. Visit priority groups from highest to lowest. Within the first group
///    whose total effective weight is positive, choose by weighted random.
pub async fn select_upstream(
    pool: &sqlx::SqlitePool,
    routing_cache: &UpstreamRoutingCache,
    auto_weight: &AutoWeightManager,
    policy: AutoWeightPolicy,
    upstream_selector: Option<&str>,
    model: Option<&str>,
) -> Result<Option<(UpstreamRow, Option<String>)>, AppError> {
    let snapshot = routing_cache.get_or_load(pool).await?;
    Ok(select_upstream_from_snapshot(
        &snapshot,
        auto_weight,
        policy,
        upstream_selector,
        model,
    ))
}

fn select_upstream_from_snapshot(
    snapshot: &UpstreamRoutingSnapshot,
    auto_weight: &AutoWeightManager,
    policy: AutoWeightPolicy,
    upstream_selector: Option<&str>,
    model: Option<&str>,
) -> Option<(UpstreamRow, Option<String>)> {
    // ── Direct selection ─────────────────────────────────────────────────
    if let Some(selector) = upstream_selector {
        if let Ok(id) = selector.parse::<i64>() {
            if let Some(upstream) = snapshot.by_id(id) {
                if parsed_match_model(upstream, model) {
                    let fwd = parsed_select_forward_model(upstream, model);
                    return Some((upstream.row.clone(), fwd));
                }
            }
        }

        if let Some(upstream) = snapshot.by_name(selector) {
            if parsed_match_model(upstream, model) {
                let fwd = parsed_select_forward_model(upstream, model);
                return Some((upstream.row.clone(), fwd));
            }
        }

        return None;
    }

    // ── Pool-based selection ─────────────────────────────────────────────
    if snapshot.upstreams.is_empty() {
        return None;
    }

    // Filter by model score
    let mut scored: Vec<(&ParsedUpstream, i32)> = snapshot
        .upstreams
        .iter()
        .map(|u| (u, parsed_model_match_score(u, model)))
        .collect();

    if model.is_some() {
        // keep the best score
        let best = scored.iter().map(|(_, s)| *s).max().unwrap_or(0);
        if best <= 0 {
            return None;
        }
        scored.retain(|(_, s)| *s == best);
    }

    let mut candidates_by_priority: HashMap<i32, Vec<&ParsedUpstream>> = HashMap::new();
    for (up, _) in &scored {
        candidates_by_priority
            .entry(up.row.priority)
            .or_default()
            .push(up);
    }
    if candidates_by_priority.is_empty() {
        return None;
    }

    let mut priorities: Vec<i32> = candidates_by_priority.keys().copied().collect();
    priorities.sort_unstable_by(|left, right| right.cmp(left));

    for priority in priorities {
        let candidates = candidates_by_priority.get(&priority).unwrap();
        let mut selectable = Vec::with_capacity(candidates.len());
        let mut weights = Vec::with_capacity(candidates.len());
        for candidate in candidates {
            let snapshot = auto_weight.snapshot(
                candidate.row.id,
                candidate.row.weight,
                candidate.row.auto_weight_enabled == 1,
                policy,
            );
            if snapshot.routing_weight > 0 {
                selectable.push(*candidate);
                weights.push(snapshot.routing_weight);
            }
        }
        if selectable.is_empty() {
            continue;
        }
        let distribution = WeightedIndex::new(&weights)
            .expect("selectable routing weights must contain a positive weight");
        let chosen = selectable[distribution.sample(&mut rand::thread_rng())];
        let fwd = parsed_select_forward_model(chosen, model);
        return Some((chosen.row.clone(), fwd));
    }

    None
}

#[cfg(test)]
mod tests {
    use super::{model_match_score, AutoWeightManager, AutoWeightPolicy, UpstreamRoutingCache};
    use crate::error::AppError;
    use crate::models::settings::RuntimeSettings;
    use crate::models::upstream::UpstreamRow;
    use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
    use std::time::{Duration, Instant};

    fn policy() -> AutoWeightPolicy {
        AutoWeightPolicy::from(&RuntimeSettings::default())
    }

    async fn select_upstream(
        pool: &SqlitePool,
        auto_weight: &AutoWeightManager,
        policy: AutoWeightPolicy,
        upstream_selector: Option<&str>,
        model: Option<&str>,
    ) -> Result<Option<(UpstreamRow, Option<String>)>, AppError> {
        let cache = UpstreamRoutingCache::new();
        super::select_upstream(pool, &cache, auto_weight, policy, upstream_selector, model).await
    }

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"
            CREATE TABLE upstreams (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                name            TEXT NOT NULL UNIQUE,
                base_url        TEXT NOT NULL,
                api_key         TEXT,
                model_names     TEXT NOT NULL DEFAULT '[]',
                model_prefixes  TEXT NOT NULL DEFAULT '[]',
                model_mappings  TEXT NOT NULL DEFAULT '{}',
                priority        INTEGER NOT NULL DEFAULT 100,
                weight          INTEGER NOT NULL DEFAULT 100,
                auto_weight_enabled INTEGER NOT NULL DEFAULT 1,
                enabled         INTEGER NOT NULL DEFAULT 1,
                extra_headers   TEXT NOT NULL DEFAULT '{}',
                timeout_seconds REAL NOT NULL DEFAULT 300.0,
                created_at      TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
            )
            "#,
        )
        .execute(&pool)
        .await
        .unwrap();
        pool
    }

    async fn insert_upstream(
        pool: &SqlitePool,
        name: &str,
        model_names: &[&str],
        priority: i32,
        weight: i64,
        auto_weight_enabled: bool,
    ) {
        sqlx::query(
            r#"
            INSERT INTO upstreams
                (name, base_url, model_names, model_prefixes, model_mappings,
                 priority, weight, auto_weight_enabled, enabled, extra_headers, timeout_seconds)
            VALUES (?, 'https://example.test', ?, '[]', '{}', ?, ?, ?, 1, '{}', 300.0)
            "#,
        )
        .bind(name)
        .bind(serde_json::to_string(model_names).unwrap())
        .bind(priority)
        .bind(weight)
        .bind(i64::from(auto_weight_enabled))
        .execute(pool)
        .await
        .unwrap();
    }

    #[tokio::test]
    async fn pool_selection_rejects_only_enabled_channel_when_model_does_not_match() {
        let pool = test_pool().await;
        insert_upstream(
            &pool,
            "deepseek-only",
            &["DeepSeek-V4-Flash"],
            100,
            100,
            true,
        )
        .await;

        let selected = select_upstream(
            &pool,
            &AutoWeightManager::new(),
            policy(),
            None,
            Some("gpt-5.5"),
        )
        .await
        .unwrap();

        assert!(selected.is_none());
    }

    #[tokio::test]
    async fn direct_selection_cannot_bypass_model_matching() {
        let pool = test_pool().await;
        insert_upstream(&pool, "deepseek-only", &["DeepSeek-V4-Flash"], 100, 0, true).await;
        let auto_weight = AutoWeightManager::new();

        let by_name = select_upstream(
            &pool,
            &auto_weight,
            policy(),
            Some("deepseek-only"),
            Some("gpt-5.5"),
        )
        .await
        .unwrap();
        let by_id = select_upstream(&pool, &auto_weight, policy(), Some("1"), Some("gpt-5.5"))
            .await
            .unwrap();

        assert!(by_name.is_none());
        assert!(by_id.is_none());
    }

    #[tokio::test]
    async fn numeric_direct_selection_falls_back_to_name_when_id_does_not_match() {
        let pool = test_pool().await;
        insert_upstream(&pool, "id-one", &["other-model"], 100, 100, true).await;
        insert_upstream(&pool, "1", &["target-model"], 100, 100, true).await;
        let auto_weight = AutoWeightManager::new();

        let selected = select_upstream(
            &pool,
            &auto_weight,
            policy(),
            Some("1"),
            Some("target-model"),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(selected.0.name, "1");
    }

    #[tokio::test]
    async fn matching_model_still_selects_enabled_channel() {
        let pool = test_pool().await;
        insert_upstream(
            &pool,
            "deepseek-only",
            &["DeepSeek-V4-Flash"],
            100,
            100,
            true,
        )
        .await;

        let selected = select_upstream(
            &pool,
            &AutoWeightManager::new(),
            policy(),
            None,
            Some("DeepSeek-V4-Flash"),
        )
        .await
        .unwrap();

        let (upstream, forward_model) = selected.unwrap();
        assert_eq!(upstream.name, "deepseek-only");
        assert_eq!(forward_model.as_deref(), Some("DeepSeek-V4-Flash"));
    }

    #[tokio::test]
    async fn routing_cache_reuses_snapshot_until_invalidated() {
        let pool = test_pool().await;
        insert_upstream(&pool, "cached", &["first-model"], 100, 100, true).await;
        let cache = UpstreamRoutingCache::new();
        let auto_weight = AutoWeightManager::new();

        let first = super::select_upstream(
            &pool,
            &cache,
            &auto_weight,
            policy(),
            None,
            Some("first-model"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(first.0.name, "cached");
        assert!(cache.is_cached().await);

        sqlx::query(
            "UPDATE upstreams SET model_names = '[\"second-model\"]' WHERE name = 'cached'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let stale = super::select_upstream(
            &pool,
            &cache,
            &auto_weight,
            policy(),
            None,
            Some("first-model"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(stale.0.name, "cached");

        cache.invalidate().await;
        let old_model = super::select_upstream(
            &pool,
            &cache,
            &auto_weight,
            policy(),
            None,
            Some("first-model"),
        )
        .await
        .unwrap();
        assert!(old_model.is_none());

        let reloaded = super::select_upstream(
            &pool,
            &cache,
            &auto_weight,
            policy(),
            None,
            Some("second-model"),
        )
        .await
        .unwrap()
        .unwrap();
        assert_eq!(reloaded.0.name, "cached");
    }

    #[tokio::test]
    async fn higher_priority_wins_even_with_a_smaller_weight() {
        let pool = test_pool().await;
        insert_upstream(&pool, "primary", &["model"], 999, 1, true).await;
        insert_upstream(&pool, "fallback", &["model"], 998, 10_000, true).await;
        let auto_weight = AutoWeightManager::new();

        for _ in 0..20 {
            let selected = select_upstream(&pool, &auto_weight, policy(), None, Some("model"))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(selected.0.name, "primary");
        }
    }

    #[tokio::test]
    async fn zero_base_weight_is_never_selected_from_a_weighted_group() {
        let pool = test_pool().await;
        insert_upstream(&pool, "zero", &["model"], 999, 0, true).await;
        insert_upstream(&pool, "active", &["model"], 999, 1, true).await;
        let auto_weight = AutoWeightManager::new();

        for _ in 0..20 {
            let selected = select_upstream(&pool, &auto_weight, policy(), None, Some("model"))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(selected.0.name, "active");
        }
    }

    #[tokio::test]
    async fn model_match_score_is_resolved_before_priority() {
        let pool = test_pool().await;
        insert_upstream(&pool, "prefix", &[], 999, 100, true).await;
        insert_upstream(&pool, "mapping", &[], 100, 100, true).await;
        sqlx::query("UPDATE upstreams SET model_prefixes = '[\"gpt-\"]' WHERE name = 'prefix'")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            "UPDATE upstreams SET model_mappings = '{\"gpt-test\":\"provider-model\"}' WHERE name = 'mapping'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let selected = select_upstream(
            &pool,
            &AutoWeightManager::new(),
            policy(),
            None,
            Some("gpt-test"),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(selected.0.name, "mapping");
        assert_eq!(selected.1.as_deref(), Some("provider-model"));
    }

    #[tokio::test]
    async fn exact_model_name_and_mapping_tie_before_priority() {
        let pool = test_pool().await;
        insert_upstream(&pool, "native", &["gpt-test"], 999, 100, true).await;
        insert_upstream(&pool, "mapping", &[], 100, 100, true).await;
        sqlx::query(
            "UPDATE upstreams SET model_mappings = '{\"gpt-test\":\"provider-model\"}' WHERE name = 'mapping'",
        )
        .execute(&pool)
        .await
        .unwrap();

        let native = crate::db::upstream::get_upstream_by_name(&pool, "native")
            .await
            .unwrap()
            .unwrap();
        let mapping = crate::db::upstream::get_upstream_by_name(&pool, "mapping")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(model_match_score(&native, Some("gpt-test")), 4);
        assert_eq!(model_match_score(&mapping, Some("gpt-test")), 4);

        let selected = select_upstream(
            &pool,
            &AutoWeightManager::new(),
            policy(),
            None,
            Some("gpt-test"),
        )
        .await
        .unwrap()
        .unwrap();

        assert_eq!(selected.0.name, "native");
        assert_eq!(selected.1.as_deref(), Some("gpt-test"));
    }

    #[tokio::test]
    async fn zero_health_priority_group_falls_back_to_the_next_group() {
        let pool = test_pool().await;
        insert_upstream(&pool, "primary", &["model"], 999, 100, true).await;
        insert_upstream(&pool, "fallback", &["model"], 998, 100, true).await;
        let auto_weight = AutoWeightManager::new();
        for _ in 0..5 {
            auto_weight.record_failure(1, true, policy());
        }

        let selected = select_upstream(&pool, &auto_weight, policy(), None, Some("model"))
            .await
            .unwrap()
            .unwrap();

        assert_eq!(selected.0.name, "fallback");
    }

    #[tokio::test]
    async fn direct_selection_bypasses_zero_weight_and_zero_health() {
        let pool = test_pool().await;
        insert_upstream(&pool, "direct", &["model"], 999, 0, true).await;
        let auto_weight = AutoWeightManager::new();
        for _ in 0..5 {
            auto_weight.record_failure(1, true, policy());
        }

        let pooled = select_upstream(&pool, &auto_weight, policy(), None, Some("model"))
            .await
            .unwrap();
        let direct = select_upstream(&pool, &auto_weight, policy(), Some("direct"), Some("model"))
            .await
            .unwrap();

        assert!(pooled.is_none());
        assert_eq!(direct.unwrap().0.name, "direct");
    }

    #[test]
    fn fixed_health_adjustments_and_time_recovery_are_bounded() {
        let auto_weight = AutoWeightManager::new();
        for _ in 0..5 {
            auto_weight.record_failure(7, true, policy());
        }
        assert_eq!(auto_weight.snapshot(7, 100, true, policy()).score, 0);

        auto_weight.set_last_adjusted_at(7, Instant::now() - Duration::from_secs(61));
        assert_eq!(auto_weight.snapshot(7, 100, true, policy()).score, 10);

        auto_weight.record_success(7, true, policy());
        assert_eq!(auto_weight.snapshot(7, 100, true, policy()).score, 15);
    }

    #[test]
    fn disabled_auto_weight_ignores_health_updates() {
        let auto_weight = AutoWeightManager::new();
        for _ in 0..10 {
            auto_weight.record_failure(9, false, policy());
        }
        let snapshot = auto_weight.snapshot(9, 25, false, policy());
        assert_eq!(snapshot.score, 100);
        assert_eq!(snapshot.routing_weight, 2_500);
    }
}
