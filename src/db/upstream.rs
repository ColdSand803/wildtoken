use sqlx::SqlitePool;
use std::collections::HashMap;

use crate::error::AppError;
use crate::models::upstream::{UpstreamIn, UpstreamOut, UpstreamRow, UpstreamUpdate};

// ── Helpers ───────────────────────────────────────────────────────────────────

fn parse_json_array(s: &str) -> Result<Vec<String>, AppError> {
    serde_json::from_str(s).map_err(AppError::Json)
}

fn parse_json_map(s: &str) -> Result<HashMap<String, String>, AppError> {
    serde_json::from_str(s).map_err(AppError::Json)
}

fn row_to_upstream_out(row: &UpstreamRow) -> Result<UpstreamOut, AppError> {
    Ok(UpstreamOut {
        id: row.id,
        name: row.name.clone(),
        base_url: row.base_url.clone(),
        api_key_set: row.api_key.is_some(),
        model_names: parse_json_array(&row.model_names)?,
        model_prefixes: parse_json_array(&row.model_prefixes)?,
        model_mappings: parse_json_map(&row.model_mappings)?,
        priority: row.priority,
        weight: row.weight,
        auto_weight_enabled: row.auto_weight_enabled == 1,
        enabled: row.enabled == 1,
        extra_headers: parse_json_map(&row.extra_headers)?,
        timeout_seconds: row.timeout_seconds,
        created_at: row.created_at.clone(),
        updated_at: row.updated_at.clone(),
        runtime_health_score: 100,
        effective_weight: row.weight as f64,
        health_recovery_remaining_seconds: None,
    })
}

// ── Public functions ──────────────────────────────────────────────────────────

pub async fn list_upstreams(pool: &SqlitePool) -> Result<Vec<UpstreamOut>, AppError> {
    let rows: Vec<UpstreamRow> =
        sqlx::query_as("SELECT * FROM upstreams ORDER BY priority DESC, id ASC")
            .fetch_all(pool)
            .await?;

    rows.iter().map(row_to_upstream_out).collect()
}

/// Raw rows for callers that need the stored API key, which [`UpstreamOut`]
/// deliberately withholds.
pub async fn list_upstream_rows(pool: &SqlitePool) -> Result<Vec<UpstreamRow>, AppError> {
    let rows = sqlx::query_as("SELECT * FROM upstreams ORDER BY priority DESC, id ASC")
        .fetch_all(pool)
        .await?;

    Ok(rows)
}

pub async fn list_enabled_upstreams(pool: &SqlitePool) -> Result<Vec<UpstreamRow>, AppError> {
    let rows =
        sqlx::query_as("SELECT * FROM upstreams WHERE enabled = 1 ORDER BY priority DESC, id ASC")
            .fetch_all(pool)
            .await?;

    Ok(rows)
}

pub async fn get_upstream(pool: &SqlitePool, id: i64) -> Result<Option<UpstreamRow>, AppError> {
    let row = sqlx::query_as("SELECT * FROM upstreams WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?;

    Ok(row)
}

pub async fn get_upstream_by_name(
    pool: &SqlitePool,
    name: &str,
) -> Result<Option<UpstreamRow>, AppError> {
    let row = sqlx::query_as("SELECT * FROM upstreams WHERE name = ?")
        .bind(name)
        .fetch_optional(pool)
        .await?;

    Ok(row)
}

pub async fn create_upstream(
    pool: &SqlitePool,
    input: &UpstreamIn,
    default_timeout: f64,
) -> Result<UpstreamOut, AppError> {
    let timeout = input.timeout_seconds.unwrap_or(default_timeout);
    let enabled: i64 = if input.enabled { 1 } else { 0 };
    let auto_weight_enabled: i64 = if input.auto_weight_enabled { 1 } else { 0 };

    let model_names = serde_json::to_string(&input.model_names)?;
    let model_prefixes = serde_json::to_string(&input.model_prefixes)?;
    let model_mappings = serde_json::to_string(&input.model_mappings)?;
    let extra_headers = serde_json::to_string(&input.extra_headers)?;

    let result = sqlx::query(
        r#"INSERT INTO upstreams
            (name, base_url, api_key, model_names, model_prefixes, model_mappings,
             priority, weight, auto_weight_enabled, enabled, extra_headers, timeout_seconds,
             created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"#,
    )
    .bind(&input.name)
    .bind(&input.base_url)
    .bind(&input.api_key)
    .bind(&model_names)
    .bind(&model_prefixes)
    .bind(&model_mappings)
    .bind(input.priority)
    .bind(input.weight)
    .bind(auto_weight_enabled)
    .bind(enabled)
    .bind(&extra_headers)
    .bind(timeout)
    .execute(pool)
    .await?;

    let id = result.last_insert_rowid();
    let row: UpstreamRow = sqlx::query_as("SELECT * FROM upstreams WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;

    row_to_upstream_out(&row)
}

pub async fn update_upstream(
    pool: &SqlitePool,
    id: i64,
    input: &UpstreamUpdate,
    _default_timeout: f64,
) -> Result<UpstreamOut, AppError> {
    let existing: UpstreamRow = sqlx::query_as("SELECT * FROM upstreams WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await?
        .ok_or_else(|| AppError::NotFound(format!("upstream {id} not found")))?;

    let name = &input.base.name;
    let base_url = &input.base.base_url;
    let api_key = if input.clear_api_key {
        None
    } else if input.base.api_key.is_some() {
        input.base.api_key.clone()
    } else {
        existing.api_key.clone()
    };
    let timeout = input
        .base
        .timeout_seconds
        .unwrap_or(existing.timeout_seconds);
    let enabled: i64 = if input.base.enabled { 1 } else { 0 };
    let auto_weight_enabled: i64 = if input.base.auto_weight_enabled { 1 } else { 0 };

    let model_names = serde_json::to_string(&input.base.model_names)?;
    let model_prefixes = serde_json::to_string(&input.base.model_prefixes)?;
    let model_mappings = serde_json::to_string(&input.base.model_mappings)?;
    let extra_headers = serde_json::to_string(&input.base.extra_headers)?;

    sqlx::query(
        r#"UPDATE upstreams
        SET name = ?, base_url = ?, api_key = ?,
            model_names = ?, model_prefixes = ?, model_mappings = ?,
            priority = ?, weight = ?, auto_weight_enabled = ?, enabled = ?, extra_headers = ?,
            timeout_seconds = ?, updated_at = datetime('now')
        WHERE id = ?"#,
    )
    .bind(name)
    .bind(base_url)
    .bind(&api_key)
    .bind(&model_names)
    .bind(&model_prefixes)
    .bind(&model_mappings)
    .bind(input.base.priority)
    .bind(input.base.weight)
    .bind(auto_weight_enabled)
    .bind(enabled)
    .bind(&extra_headers)
    .bind(timeout)
    .bind(id)
    .execute(pool)
    .await?;

    let row: UpstreamRow = sqlx::query_as("SELECT * FROM upstreams WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;

    row_to_upstream_out(&row)
}

pub async fn set_upstream_enabled(
    pool: &SqlitePool,
    id: i64,
    enabled: bool,
) -> Result<UpstreamOut, AppError> {
    let val: i64 = if enabled { 1 } else { 0 };

    sqlx::query("UPDATE upstreams SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(val)
        .bind(id)
        .execute(pool)
        .await?;

    let row: UpstreamRow = sqlx::query_as("SELECT * FROM upstreams WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;

    row_to_upstream_out(&row)
}

pub async fn set_upstream_priority(
    pool: &SqlitePool,
    id: i64,
    priority: i32,
) -> Result<UpstreamOut, AppError> {
    sqlx::query("UPDATE upstreams SET priority = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(priority)
        .bind(id)
        .execute(pool)
        .await?;

    let row: UpstreamRow = sqlx::query_as("SELECT * FROM upstreams WHERE id = ?")
        .bind(id)
        .fetch_one(pool)
        .await?;

    row_to_upstream_out(&row)
}

pub async fn delete_upstream(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM upstreams WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use super::{create_upstream, get_upstream_by_name, list_upstream_rows, update_upstream};
    use crate::models::upstream::{UpstreamIn, UpstreamUpdate};
    use crate::state::init_db;
    use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};

    async fn test_pool() -> SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&pool).await.unwrap();
        pool
    }

    fn entry(name: &str, api_key: Option<&str>) -> UpstreamIn {
        UpstreamIn {
            name: name.into(),
            base_url: "https://api.example.test/v1".into(),
            api_key: api_key.map(str::to_owned),
            model_names: vec!["gpt-4o-mini".into()],
            model_prefixes: Vec::new(),
            model_mappings: Default::default(),
            priority: 100,
            weight: 100,
            auto_weight_enabled: true,
            enabled: true,
            extra_headers: Default::default(),
            timeout_seconds: Some(300.0),
        }
    }

    /// A channel document exported without keys must be able to refresh routing
    /// config without wiping the credential already stored on the target.
    #[tokio::test]
    async fn overwriting_without_an_api_key_keeps_the_stored_one() {
        let pool = test_pool().await;
        create_upstream(&pool, &entry("openai", Some("sk-original")), 300.0)
            .await
            .unwrap();
        let existing = get_upstream_by_name(&pool, "openai")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(existing.api_key.as_deref(), Some("sk-original"));

        let mut keyless = entry("openai", None);
        keyless.priority = 555;
        update_upstream(
            &pool,
            existing.id,
            &UpstreamUpdate {
                base: keyless,
                clear_api_key: false,
            },
            300.0,
        )
        .await
        .unwrap();

        let updated = get_upstream_by_name(&pool, "openai")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.id, existing.id, "overwrite must keep the row id");
        assert_eq!(updated.priority, 555, "routing config must be refreshed");
        assert_eq!(
            updated.api_key.as_deref(),
            Some("sk-original"),
            "an omitted api_key must not clear the stored credential"
        );
    }

    #[tokio::test]
    async fn overwriting_with_an_api_key_replaces_it() {
        let pool = test_pool().await;
        create_upstream(&pool, &entry("openai", Some("sk-original")), 300.0)
            .await
            .unwrap();
        let existing = get_upstream_by_name(&pool, "openai")
            .await
            .unwrap()
            .unwrap();

        update_upstream(
            &pool,
            existing.id,
            &UpstreamUpdate {
                base: entry("openai", Some("sk-rotated")),
                clear_api_key: false,
            },
            300.0,
        )
        .await
        .unwrap();

        let updated = get_upstream_by_name(&pool, "openai")
            .await
            .unwrap()
            .unwrap();
        assert_eq!(updated.api_key.as_deref(), Some("sk-rotated"));
    }

    /// Export reads raw rows because `UpstreamOut` withholds the key.
    #[tokio::test]
    async fn raw_row_listing_exposes_keys_for_export() {
        let pool = test_pool().await;
        create_upstream(&pool, &entry("a", Some("sk-a")), 300.0)
            .await
            .unwrap();
        create_upstream(&pool, &entry("b", None), 300.0)
            .await
            .unwrap();

        let rows = list_upstream_rows(&pool).await.unwrap();

        assert_eq!(rows.len(), 2);
        let a = rows.iter().find(|row| row.name == "a").unwrap();
        let b = rows.iter().find(|row| row.name == "b").unwrap();
        assert_eq!(a.api_key.as_deref(), Some("sk-a"));
        assert_eq!(b.api_key, None);
    }
}
