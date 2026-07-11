use std::sync::Arc;

use sqlx::SqlitePool;

use crate::config::Settings;
use crate::error::AppError;
use crate::proxy::matcher::BackoffManager;

/// Application shared state.
#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub http_client: reqwest::Client,
    pub settings: Settings,
    pub backoff: Arc<BackoffManager>,
}

/// Create database tables and enable WAL mode + foreign keys.
pub async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("PRAGMA journal_mode=WAL;")
        .execute(pool)
        .await?;

    sqlx::query("PRAGMA foreign_keys=ON;")
        .execute(pool)
        .await?;

    // ---------- upstreams ----------
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS upstreams (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            name            TEXT NOT NULL UNIQUE,
            base_url        TEXT NOT NULL,
            api_key         TEXT,
            model_names     TEXT NOT NULL DEFAULT '[]',
            model_prefixes  TEXT NOT NULL DEFAULT '[]',
            model_mappings  TEXT NOT NULL DEFAULT '{}',
            priority        INTEGER NOT NULL DEFAULT 100,
            enabled         INTEGER NOT NULL DEFAULT 1,
            extra_headers   TEXT NOT NULL DEFAULT '{}',
            timeout_seconds REAL NOT NULL DEFAULT 300.0,
            created_at      TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_upstreams_enabled_priority ON upstreams(enabled, priority, id);",
    )
    .execute(pool)
    .await?;

    // ---------- request_logs ----------
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS request_logs (
            id                  INTEGER PRIMARY KEY AUTOINCREMENT,
            created_at          TEXT NOT NULL DEFAULT (datetime('now')),
            method              TEXT NOT NULL,
            path                TEXT NOT NULL,
            upstream_id         INTEGER REFERENCES upstreams(id) ON DELETE SET NULL,
            upstream_name       TEXT,
            model               TEXT,
            reasoning_effort    TEXT,
            stream              INTEGER NOT NULL DEFAULT 0,
            status_code         INTEGER,
            prompt_tokens       INTEGER,
            completion_tokens   INTEGER,
            total_tokens        INTEGER,
            duration_ms         INTEGER,
            first_token_ms      INTEGER,
            error               TEXT,
            downstream_request  TEXT,
            upstream_request    TEXT,
            upstream_response   TEXT,
            downstream_response TEXT
        );
        "#,
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        "CREATE INDEX IF NOT EXISTS idx_request_logs_upstream_created_at ON request_logs(upstream_id, created_at);",
    )
    .execute(pool)
    .await?;

    // ---------- api_tokens ----------
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS api_tokens (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            name        TEXT NOT NULL UNIQUE,
            description TEXT NOT NULL DEFAULT '',
            token       TEXT NOT NULL UNIQUE,
            enabled     INTEGER NOT NULL DEFAULT 1,
            created_at  TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
    .execute(pool)
    .await?;

    // ---------- app_migrations ----------
    sqlx::query(
        r#"
        CREATE TABLE IF NOT EXISTS app_migrations (
            name       TEXT PRIMARY KEY,
            applied_at TEXT NOT NULL DEFAULT (datetime('now'))
        );
        "#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// Insert the default downstream API token when the `api_tokens` table is empty.
pub async fn seed_default_token(pool: &SqlitePool, settings: &Settings) -> Result<(), AppError> {
    let count: (i64,) = sqlx::query_as("SELECT COUNT(*) FROM api_tokens")
        .fetch_one(pool)
        .await?;

    if count.0 == 0 {
        sqlx::query("INSERT INTO api_tokens (name, description, token) VALUES (?, ?, ?)")
            .bind("Default")
            .bind("Default downstream token (auto-generated)")
            .bind(&settings.admin.downstream_api_key)
            .execute(pool)
            .await?;
    }

    Ok(())
}
