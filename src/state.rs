use std::{
    sync::{
        atomic::{AtomicI64, Ordering},
        Arc,
    },
    time::Instant,
};

use sqlx::SqlitePool;
use tokio::sync::RwLock;

use crate::config::Settings;
use crate::error::AppError;
use crate::proxy::matcher::BackoffManager;
use crate::{
    db::settings as settings_db,
    models::settings::{AdminCredential, RuntimeSettings},
};

const RESPONSE_REASONING_EFFORT_BACKFILL: &str = "request_logs_response_reasoning_effort_v1";
const CLIENT_TYPE_BACKFILL: &str = "request_logs_client_type_v1";
const REQUEST_LOG_PAYLOADS_MIGRATION: &str = "request_log_payloads_v1";

async fn backfill_response_reasoning_effort_once(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let already_applied: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = ?)")
            .bind(RESPONSE_REASONING_EFFORT_BACKFILL)
            .fetch_one(&mut *tx)
            .await?;
    if already_applied != 0 {
        tx.commit().await?;
        return Ok(());
    }

    sqlx::query(
        r#"UPDATE request_logs
           SET response_reasoning_effort = CASE
               WHEN upstream_response LIKE '%"effort":"minimal"%' THEN 'minimal'
               WHEN upstream_response LIKE '%"effort":"low"%' THEN 'low'
               WHEN upstream_response LIKE '%"effort":"medium"%' THEN 'medium'
               WHEN upstream_response LIKE '%"effort":"high"%' THEN 'high'
               WHEN upstream_response LIKE '%"effort":"max"%' THEN 'max'
           END
           WHERE response_reasoning_effort IS NULL
             AND (upstream_response LIKE '%"effort":"minimal"%'
               OR upstream_response LIKE '%"effort":"low"%'
               OR upstream_response LIKE '%"effort":"medium"%'
               OR upstream_response LIKE '%"effort":"high"%'
               OR upstream_response LIKE '%"effort":"max"%')"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO app_migrations (name) VALUES (?)")
        .bind(RESPONSE_REASONING_EFFORT_BACKFILL)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn backfill_client_type_once(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let already_applied: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = ?)")
            .bind(CLIENT_TYPE_BACKFILL)
            .fetch_one(&mut *tx)
            .await?;
    if already_applied != 0 {
        tx.commit().await?;
        return Ok(());
    }

    sqlx::query(
        r#"WITH classified AS (
               SELECT id,
                   CASE
                       WHEN json_valid(downstream_request)
                         AND LOWER(COALESCE(json_extract(downstream_request, '$.headers.user-agent'), '')) LIKE '%opencode%' THEN 'opencode'
                       WHEN json_valid(downstream_request)
                         AND LOWER(COALESCE(json_extract(downstream_request, '$.headers.user-agent'), '')) LIKE '%codex%' THEN 'codex'
                       WHEN path = 'messages'
                         OR (json_valid(downstream_request)
                           AND (LOWER(COALESCE(json_extract(downstream_request, '$.headers.user-agent'), '')) LIKE '%claude%'
                             OR COALESCE(json_extract(downstream_request, '$.headers.anthropic-version'), '') <> '')) THEN 'claude'
                   END AS detected_client_type
               FROM request_logs
           )
           UPDATE request_logs
           SET client_type = (
               SELECT detected_client_type
               FROM classified
               WHERE classified.id = request_logs.id
           )
           WHERE EXISTS (
               SELECT 1
               FROM classified
               WHERE classified.id = request_logs.id
                 AND classified.detected_client_type IS NOT NULL
                 AND classified.detected_client_type IS NOT request_logs.client_type
           )"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO app_migrations (name) VALUES (?)")
        .bind(CLIENT_TYPE_BACKFILL)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

async fn migrate_request_log_payloads_once(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS request_log_payloads (
            request_log_id INTEGER PRIMARY KEY
                REFERENCES request_logs(id) ON DELETE CASCADE,
            request_snapshot TEXT,
            upstream_request_override TEXT,
            upstream_request_is_override INTEGER NOT NULL DEFAULT 0
                CHECK (upstream_request_is_override IN (0, 1)),
            response_snapshot TEXT,
            downstream_response_override TEXT,
            downstream_response_is_override INTEGER NOT NULL DEFAULT 0
                CHECK (downstream_response_is_override IN (0, 1))
        );"#,
    )
    .execute(&mut *tx)
    .await?;

    let already_applied: i64 =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = ?)")
            .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
            .fetch_one(&mut *tx)
            .await?;
    if already_applied != 0 {
        tx.commit().await?;
        return Ok(());
    }

    sqlx::query(
        r#"INSERT OR IGNORE INTO request_log_payloads (
               request_log_id,
               request_snapshot,
               upstream_request_override,
               upstream_request_is_override,
               response_snapshot,
               downstream_response_override,
               downstream_response_is_override
           )
           SELECT id,
               downstream_request,
               CASE WHEN upstream_request IS NOT downstream_request THEN upstream_request END,
               upstream_request IS NOT downstream_request,
               upstream_response,
               CASE WHEN downstream_response IS NOT upstream_response THEN downstream_response END,
               downstream_response IS NOT upstream_response
           FROM request_logs"#,
    )
    .execute(&mut *tx)
    .await?;

    let parent_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_logs")
        .fetch_one(&mut *tx)
        .await?;
    let payload_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_log_payloads")
        .fetch_one(&mut *tx)
        .await?;
    if parent_count != payload_count {
        let error = sqlx::Error::Protocol(format!(
            "request log payload migration row-count mismatch: {parent_count} request_logs, {payload_count} request_log_payloads"
        ));
        tx.rollback().await?;
        return Err(error);
    }

    sqlx::query(
        r#"UPDATE request_logs
           SET downstream_request = NULL,
               upstream_request = NULL,
               upstream_response = NULL,
               downstream_response = NULL
           WHERE downstream_request IS NOT NULL
              OR upstream_request IS NOT NULL
              OR upstream_response IS NOT NULL
              OR downstream_response IS NOT NULL"#,
    )
    .execute(&mut *tx)
    .await?;
    sqlx::query("INSERT INTO app_migrations (name) VALUES (?)")
        .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;
    Ok(())
}

/// Application shared state.
#[derive(Clone)]
pub struct AppState {
    pub db: SqlitePool,
    pub http_client: reqwest::Client,
    pub settings: Settings,
    pub backoff: Arc<BackoffManager>,
    pub runtime_settings: Arc<RwLock<RuntimeSettings>>,
    /// Current Argon2id credential snapshot. It is published only after a DB commit.
    pub admin_credential: Arc<RwLock<AdminCredential>>,
    /// Commit generation, advanced before publishing a newly committed snapshot.
    /// This closes the commit-to-publication window for newly-started requests.
    pub admin_credential_version: Arc<AtomicI64>,
    pub started_at: Instant,
}

impl AppState {
    /// Publish a credential that has already committed to SQLite.
    ///
    /// The atomic generation closes the commit-to-publication window for
    /// authentication. `fetch_max` makes that signal irreversible, while the
    /// lock keeps the credential snapshot itself monotonic when rotations
    /// complete their database work out of order.
    pub async fn publish_admin_credential(&self, credential: AdminCredential) {
        self.admin_credential_version
            .fetch_max(credential.credential_version, Ordering::AcqRel);

        let mut snapshot = self.admin_credential.write().await;
        if credential.credential_version > snapshot.credential_version {
            *snapshot = credential;
        }
    }
}

/// Create database tables and enable WAL mode + foreign keys.
pub async fn init_db(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    sqlx::query("PRAGMA journal_mode=WAL;")
        .execute(pool)
        .await?;

    sqlx::query("PRAGMA foreign_keys=ON;").execute(pool).await?;

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

    sqlx::query(r#"CREATE TABLE IF NOT EXISTS model_test_prompt_templates (
        id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL UNIQUE, prompt TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')), updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );"#).execute(pool).await?;
    sqlx::query(r#"INSERT INTO model_test_prompt_templates (name, prompt) VALUES
        ('模型能力概览', '请用中文说明你当前使用的模型名称、两项主要能力，以及用户提交复杂任务时应提供的关键信息。使用自然段，不要使用表格、工具或外部引用。总回复不超过 120 个汉字。'),
        ('代码审查', '请审查以下需求的实现风险：一个 HTTP API 需要支持鉴权、超时、错误处理和请求日志。用三条简短建议说明优先级和原因，不要编造未提供的事实。'),
        ('问题排查', '请给出排查 API 请求失败的步骤。按网络、认证、请求格式、上游响应四个方面排序，每项一句，并说明最先应收集的证据。'),
        ('结构化摘要', '请用三条要点总结：如何把一项复杂工程任务拆分为可验证的步骤。每条不超过 30 个汉字，不要使用表格。'),
        ('中文问答', '请用中文解释为什么客户端超时不一定代表上游服务故障。给出一个简短例子，并说明日志中应重点查看哪些字段。')
        ON CONFLICT(name) DO NOTHING"#).execute(pool).await?;

    // ---------- admin_credential ----------
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS admin_credential (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            credential_hash TEXT NOT NULL,
            credential_version INTEGER NOT NULL CHECK (credential_version >= 1),
            rotated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );"#,
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
            downstream_token_id INTEGER REFERENCES api_tokens(id) ON DELETE SET NULL,
            downstream_token_name TEXT,
            client_type         TEXT NOT NULL DEFAULT 'unknown',
            upstream_id         INTEGER REFERENCES upstreams(id) ON DELETE SET NULL,
            upstream_name       TEXT,
            model               TEXT,
            reasoning_effort    TEXT,
            response_reasoning_effort TEXT,
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

    for definition in [
        "downstream_token_id INTEGER REFERENCES api_tokens(id) ON DELETE SET NULL",
        "downstream_token_name TEXT",
        "client_type TEXT NOT NULL DEFAULT 'unknown'",
        "response_reasoning_effort TEXT",
    ] {
        let column = definition
            .split_whitespace()
            .next()
            .expect("column definition must start with a name");
        let exists: Option<String> =
            sqlx::query_scalar("SELECT name FROM pragma_table_info('request_logs') WHERE name = ?")
                .bind(column)
                .fetch_optional(pool)
                .await?;
        if exists.is_none() {
            sqlx::query(&format!("ALTER TABLE request_logs ADD COLUMN {definition}"))
                .execute(pool)
                .await?;
        }
    }

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

    // These derivations must consume the legacy snapshots before the payload
    // migration clears them from the hot request_logs table.
    backfill_response_reasoning_effort_once(pool).await?;
    backfill_client_type_once(pool).await?;
    migrate_request_log_payloads_once(pool).await?;

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

    // ---------- runtime_settings ----------
    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS runtime_settings (
            id INTEGER PRIMARY KEY CHECK (id = 1),
            log_body_keep_count INTEGER NOT NULL CHECK (log_body_keep_count BETWEEN 1 AND 10000),
            log_retention_days INTEGER NOT NULL CHECK (log_retention_days BETWEEN 1 AND 3650),
            log_body_max_bytes INTEGER NOT NULL CHECK (log_body_max_bytes BETWEEN 0 AND 1048576),
            revision INTEGER NOT NULL DEFAULT 1 CHECK (revision >= 1),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );"#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        "INSERT INTO runtime_settings (id, log_body_keep_count, log_retention_days, log_body_max_bytes, revision) VALUES (1, 100, 30, 200000, 1) ON CONFLICT(id) DO NOTHING",
    )
    .execute(pool)
    .await?;

    sqlx::query(
        r#"CREATE TABLE IF NOT EXISTS model_test_templates (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE,
            request_kind TEXT NOT NULL CHECK (request_kind IN ('responses', 'chat_completions')),
            prompt TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
        );"#,
    )
    .execute(pool)
    .await?;
    sqlx::query(
        r#"INSERT INTO model_test_templates (name, request_kind, prompt)
        VALUES
            ('Codex', 'responses', '请用中文回答：你当前使用的模型名称是什么？请概括你擅长处理的两类任务，并给出一个简短、准确的建议，说明用户在提交复杂问题时应提供哪些关键信息。使用自然段回答，不要使用 Markdown 表格、工具调用或外部引用；结尾加上“WildToken 已收到回答”。总回复不超过 120 个汉字。'),
            ('OpenCode', 'chat_completions', '请用中文回答：你当前使用的模型名称是什么？请概括你擅长处理的两类任务，并给出一个简短、准确的建议，说明用户在提交复杂问题时应提供哪些关键信息。使用自然段回答，不要使用 Markdown 表格、工具调用或外部引用；结尾加上“WildToken 已收到回答”。总回复不超过 120 个汉字。')
        ON CONFLICT(name) DO NOTHING"#,
    )
    .execute(pool)
    .await?;
    // Upgrade only the original short defaults; administrator-customized templates remain untouched.
    sqlx::query(
        r#"UPDATE model_test_templates
        SET prompt = '请用中文回答：你当前使用的模型名称是什么？请概括你擅长处理的两类任务，并给出一个简短、准确的建议，说明用户在提交复杂问题时应提供哪些关键信息。使用自然段回答，不要使用 Markdown 表格、工具调用或外部引用；结尾加上“WildToken 已收到回答”。总回复不超过 120 个汉字。', updated_at = datetime('now')
        WHERE name IN ('Codex', 'OpenCode') AND prompt IN ('Reply with exactly: WildToken test passed.', '请用中文完成一次简短的连通性测试。先说明你已收到请求，再用两句话概括：当前模型名称、你能提供的主要能力。不要使用 Markdown 表格，不要调用工具，不要编造外部信息。最后单独输出“WildToken 模型测试通过”，并确保总回复不超过 120 个汉字。')"#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

/// Hash a token with Argon2id on the blocking pool. The plaintext is never persisted.
pub async fn hash_admin_token(token: String) -> Result<String, AppError> {
    tokio::task::spawn_blocking(move || {
        use argon2::{
            password_hash::{rand_core::OsRng, SaltString},
            Argon2, PasswordHasher,
        };
        let salt = SaltString::generate(&mut OsRng);
        Argon2::default()
            .hash_password(token.as_bytes(), &salt)
            .map(|hash| hash.to_string())
            .map_err(|_| AppError::Internal("could not hash admin credential".into()))
    })
    .await
    .map_err(|_| AppError::Internal("admin credential hashing task failed".into()))?
}

/// Verify an admin token against a credential snapshot without exposing Argon2
/// work on the async runtime.
pub async fn verify_admin_token(credential: AdminCredential, token: String) -> bool {
    tokio::task::spawn_blocking(move || {
        use argon2::{Argon2, PasswordHash, PasswordVerifier};
        PasswordHash::new(&credential.credential_hash)
            .ok()
            .map(|hash| {
                Argon2::default()
                    .verify_password(token.as_bytes(), &hash)
                    .is_ok()
            })
            .unwrap_or(false)
    })
    .await
    .unwrap_or(false)
}

/// Bootstrap once and return the committed credential snapshot.
pub async fn bootstrap_admin_credential(
    pool: &SqlitePool,
    startup_token: String,
) -> Result<AdminCredential, AppError> {
    if let Some(credential) = settings_db::load_admin_credential(pool).await? {
        return Ok(credential);
    }
    let hash = hash_admin_token(startup_token).await?;
    settings_db::bootstrap_admin_credential(pool, hash).await
}

#[cfg(test)]
mod tests {
    use std::{sync::atomic::AtomicI64, sync::Arc, time::Instant};

    use argon2::{Argon2, PasswordHash, PasswordVerifier};
    use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
    use tokio::sync::RwLock;

    use crate::{
        config::Settings,
        models::settings::{AdminCredential, RuntimeSettings},
        proxy::matcher::BackoffManager,
    };

    use super::{
        hash_admin_token, init_db, verify_admin_token, AppState, CLIENT_TYPE_BACKFILL,
        REQUEST_LOG_PAYLOADS_MIGRATION, RESPONSE_REASONING_EFFORT_BACKFILL,
    };

    async fn test_pool() -> SqlitePool {
        SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap()
    }

    fn state_with_credential(credential: AdminCredential) -> AppState {
        AppState {
            db: SqlitePool::connect_lazy("sqlite::memory:").unwrap(),
            http_client: reqwest::Client::new(),
            settings: Settings::default(),
            backoff: Arc::new(BackoffManager::new()),
            runtime_settings: Arc::new(RwLock::new(RuntimeSettings::default())),
            admin_credential_version: Arc::new(AtomicI64::new(credential.credential_version)),
            admin_credential: Arc::new(RwLock::new(credential)),
            started_at: Instant::now(),
        }
    }

    #[tokio::test]
    async fn initialization_does_not_overwrite_existing_runtime_settings() {
        let pool = test_pool().await;
        init_db(&pool).await.unwrap();
        sqlx::query(
            "UPDATE runtime_settings SET log_body_keep_count = 42, revision = 7 WHERE id = 1",
        )
        .execute(&pool)
        .await
        .unwrap();

        init_db(&pool).await.unwrap();

        let row: (i64, i64) = sqlx::query_as(
            "SELECT log_body_keep_count, revision FROM runtime_settings WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(row, (42, 7));
    }

    #[tokio::test]
    async fn payload_migration_deduplicates_snapshots_null_safely() {
        let pool = test_pool().await;
        init_db(&pool).await.unwrap();
        sqlx::query("DELETE FROM app_migrations WHERE name IN (?, ?, ?)")
            .bind(RESPONSE_REASONING_EFFORT_BACKFILL)
            .bind(CLIENT_TYPE_BACKFILL)
            .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
            .execute(&pool)
            .await
            .unwrap();

        let shared_request = r#"{"headers":{"user-agent":"codex-cli"}}"#;
        let shared_response = r#"{"body":{"effort":"high"}}"#;
        sqlx::query(
            r#"INSERT INTO request_logs (
                   id, method, path, client_type, downstream_request,
                   upstream_request, upstream_response, downstream_response
               ) VALUES (1, 'POST', 'responses', 'unknown', ?, ?, ?, ?)"#,
        )
        .bind(shared_request)
        .bind(shared_request)
        .bind(shared_response)
        .bind(shared_response)
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO request_logs (
                   id, method, path, downstream_request, upstream_request,
                   upstream_response, downstream_response
               ) VALUES (2, 'POST', 'responses', NULL, 'upstream-only-request',
                   'upstream-only-response', NULL)"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO request_logs (
                   id, method, path, downstream_request, upstream_request,
                   upstream_response, downstream_response
               ) VALUES (3, 'POST', 'responses', 'downstream-only-request', NULL,
                   NULL, 'downstream-only-response')"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        init_db(&pool).await.unwrap();

        type PayloadRow = (
            i64,
            Option<String>,
            Option<String>,
            i64,
            Option<String>,
            Option<String>,
            i64,
        );
        let payloads: Vec<PayloadRow> = sqlx::query_as(
            r#"SELECT request_log_id, request_snapshot,
                   upstream_request_override, upstream_request_is_override,
                   response_snapshot, downstream_response_override,
                   downstream_response_is_override
               FROM request_log_payloads ORDER BY request_log_id"#,
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            payloads,
            vec![
                (
                    1,
                    Some(shared_request.into()),
                    None,
                    0,
                    Some(shared_response.into()),
                    None,
                    0,
                ),
                (
                    2,
                    None,
                    Some("upstream-only-request".into()),
                    1,
                    Some("upstream-only-response".into()),
                    None,
                    1,
                ),
                (
                    3,
                    Some("downstream-only-request".into()),
                    None,
                    1,
                    None,
                    Some("downstream-only-response".into()),
                    1,
                ),
            ]
        );

        let legacy_rows_with_payloads: i64 = sqlx::query_scalar(
            r#"SELECT COUNT(*) FROM request_logs
               WHERE downstream_request IS NOT NULL
                  OR upstream_request IS NOT NULL
                  OR upstream_response IS NOT NULL
                  OR downstream_response IS NOT NULL"#,
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(legacy_rows_with_payloads, 0);
        let derived: (String, Option<String>) = sqlx::query_as(
            "SELECT client_type, response_reasoning_effort FROM request_logs WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(derived, ("codex".into(), Some("high".into())));

        init_db(&pool).await.unwrap();
        let payload_count: i64 = sqlx::query_scalar("SELECT COUNT(*) FROM request_log_payloads")
            .fetch_one(&pool)
            .await
            .unwrap();
        assert_eq!(payload_count, 3);
    }

    #[tokio::test]
    async fn legacy_backfills_update_only_changed_matched_rows_and_run_once() {
        let pool = test_pool().await;
        init_db(&pool).await.unwrap();
        sqlx::query("DELETE FROM app_migrations WHERE name IN (?, ?, ?)")
            .bind(RESPONSE_REASONING_EFFORT_BACKFILL)
            .bind(CLIENT_TYPE_BACKFILL)
            .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE request_log_migration_audit (
                   kind TEXT NOT NULL, request_log_id INTEGER NOT NULL
               );
               CREATE TRIGGER audit_client_type_update
               AFTER UPDATE OF client_type ON request_logs
               BEGIN
                   INSERT INTO request_log_migration_audit VALUES ('client_type', NEW.id);
               END;
               CREATE TRIGGER audit_reasoning_effort_update
               AFTER UPDATE OF response_reasoning_effort ON request_logs
               BEGIN
                   INSERT INTO request_log_migration_audit VALUES ('response_reasoning_effort', NEW.id);
               END;"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"INSERT INTO request_logs (
                   id, method, path, client_type, response_reasoning_effort,
                   downstream_request, upstream_response
               ) VALUES
                   (1, 'POST', 'responses', 'unknown', NULL,
                       '{"headers":{"user-agent":"codex-cli"}}', '{"effort":"high"}'),
                   (2, 'POST', 'responses', 'codex', 'high',
                       '{"headers":{"user-agent":"codex-cli"}}', '{"effort":"high"}'),
                   (3, 'POST', 'responses', 'unknown', NULL,
                       '{"headers":{"user-agent":"generic-client"}}', '{"result":"ok"}')"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        init_db(&pool).await.unwrap();

        let updates: Vec<(String, i64)> = sqlx::query_as(
            "SELECT kind, request_log_id FROM request_log_migration_audit ORDER BY kind",
        )
        .fetch_all(&pool)
        .await
        .unwrap();
        assert_eq!(
            updates,
            vec![
                ("client_type".into(), 1),
                ("response_reasoning_effort".into(), 1),
            ]
        );

        sqlx::query("DELETE FROM request_log_migration_audit")
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            r#"UPDATE request_logs
               SET client_type = 'unknown', response_reasoning_effort = NULL,
                   downstream_request = '{"headers":{"user-agent":"codex-cli"}}',
                   upstream_response = '{"effort":"high"}'
               WHERE id = 3"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("DELETE FROM request_log_migration_audit")
            .execute(&pool)
            .await
            .unwrap();

        init_db(&pool).await.unwrap();

        let audit_count: i64 =
            sqlx::query_scalar("SELECT COUNT(*) FROM request_log_migration_audit")
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(audit_count, 0);
        let unchanged: (String, Option<String>) = sqlx::query_as(
            "SELECT client_type, response_reasoning_effort FROM request_logs WHERE id = 3",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(unchanged, ("unknown".into(), None));
    }

    #[tokio::test]
    async fn payload_migration_keeps_legacy_columns_when_row_counts_do_not_match() {
        let pool = test_pool().await;
        init_db(&pool).await.unwrap();
        sqlx::query("DELETE FROM app_migrations WHERE name = ?")
            .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
            .execute(&pool)
            .await
            .unwrap();
        sqlx::query(
            r#"INSERT INTO request_logs (
                   id, method, path, downstream_request, upstream_request
               ) VALUES (1, 'POST', 'responses', 'downstream', 'upstream')"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query(
            r#"CREATE TRIGGER skip_payload_backfill
               BEFORE INSERT ON request_log_payloads
               BEGIN
                   SELECT RAISE(IGNORE);
               END;"#,
        )
        .execute(&pool)
        .await
        .unwrap();

        let error = init_db(&pool).await.unwrap_err();
        assert!(error
            .to_string()
            .contains("request log payload migration row-count mismatch"));
        let legacy: (Option<String>, Option<String>) = sqlx::query_as(
            "SELECT downstream_request, upstream_request FROM request_logs WHERE id = 1",
        )
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(legacy, (Some("downstream".into()), Some("upstream".into())));
        let migration_marked: i64 =
            sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM app_migrations WHERE name = ?)")
                .bind(REQUEST_LOG_PAYLOADS_MIGRATION)
                .fetch_one(&pool)
                .await
                .unwrap();
        assert_eq!(migration_marked, 0);
    }

    #[tokio::test]
    async fn generated_argon2_hash_verifies_only_its_token() {
        let hash = hash_admin_token("test-token-not-a-deployment-secret".into())
            .await
            .unwrap();
        assert!(hash.starts_with("$argon2id$"));
        let parsed = PasswordHash::new(&hash).unwrap();
        assert!(Argon2::default()
            .verify_password(b"test-token-not-a-deployment-secret", &parsed)
            .is_ok());
        assert!(Argon2::default()
            .verify_password(b"wrong-token", &parsed)
            .is_err());
    }

    #[tokio::test]
    async fn credential_publication_never_reverts_to_an_older_version() {
        let state = state_with_credential(AdminCredential {
            credential_hash: "version-one".into(),
            credential_version: 1,
        });
        let version_three = AdminCredential {
            credential_hash: "version-three".into(),
            credential_version: 3,
        };
        let version_two = AdminCredential {
            credential_hash: "version-two".into(),
            credential_version: 2,
        };

        state.publish_admin_credential(version_three).await;
        state.publish_admin_credential(version_two).await;

        let published = state.admin_credential.read().await;
        assert_eq!(published.credential_version, 3);
        assert_eq!(published.credential_hash, "version-three");
        assert_eq!(
            state
                .admin_credential_version
                .load(std::sync::atomic::Ordering::Acquire),
            3
        );
    }

    #[tokio::test]
    async fn published_rotation_rejects_the_old_token_and_accepts_the_new_one() {
        let old_token = "old-admin-token".to_string();
        let new_token = "new-admin-token".to_string();
        let state = state_with_credential(AdminCredential {
            credential_hash: hash_admin_token(old_token.clone()).await.unwrap(),
            credential_version: 1,
        });

        state
            .publish_admin_credential(AdminCredential {
                credential_hash: hash_admin_token(new_token.clone()).await.unwrap(),
                credential_version: 2,
            })
            .await;

        let published = state.admin_credential.read().await.clone();
        assert!(!verify_admin_token(published.clone(), old_token).await);
        assert!(verify_admin_token(published, new_token).await);
    }
}

/// Load the persisted policy, falling back to safe startup defaults if it is absent or invalid.
pub async fn load_runtime_settings(pool: &SqlitePool) -> RuntimeSettings {
    match settings_db::load_runtime_settings(pool).await {
        Ok(Some(mut settings)) if settings.validate().is_ok() => {
            settings.database_override = true;
            settings
        }
        Ok(Some(_)) => {
            tracing::warn!("runtime_settings contains invalid values; using startup defaults");
            RuntimeSettings::default()
        }
        Ok(None) => {
            tracing::warn!("runtime_settings row is missing; using startup defaults");
            RuntimeSettings::default()
        }
        Err(error) => {
            tracing::warn!(
                ?error,
                "could not load runtime_settings; using startup defaults"
            );
            RuntimeSettings::default()
        }
    }
}
