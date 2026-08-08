use std::collections::HashSet;

use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use base64::Engine;
use rand::Rng;
use sha2::{Digest, Sha256};
use sqlx::SqlitePool;

use crate::error::AppError;
use crate::models::token::{
    utc_now_timestamp, ApiTokenCreatedOut, ApiTokenIn, ApiTokenOut, ApiTokenRow, ApiTokenUpdateIn,
};

const TOKEN_PREVIEW_CHARS: usize = 8;

/// Every column of a token row, in the order `ApiTokenRow` declares them.
const TOKEN_COLUMNS: &str =
    "id, name, description, token_preview, enabled, expires_at, created_at, updated_at";

// ── Helpers ────────────────────────────────────────────────────────────────────────────

pub fn generate_api_token() -> String {
    let mut bytes = [0u8; 32];
    rand::thread_rng().fill(&mut bytes);
    let encoded = URL_SAFE_NO_PAD.encode(bytes);
    format!("wildtoken_{encoded}")
}

pub fn token_digest(token: &str) -> String {
    format!("{:x}", Sha256::digest(token.as_bytes()))
}

pub fn token_preview(token: &str) -> String {
    let char_count = token.chars().count();
    let visible_chars = if char_count > TOKEN_PREVIEW_CHARS {
        TOKEN_PREVIEW_CHARS
    } else {
        char_count / 2
    };
    let prefix: String = token.chars().take(visible_chars).collect();
    format!("{prefix}…")
}

fn token_out(row: ApiTokenRow) -> ApiTokenOut {
    let ApiTokenRow {
        id,
        name,
        description,
        token_preview,
        enabled,
        expires_at,
        created_at,
        updated_at,
    } = row;
    ApiTokenOut {
        id,
        name,
        description,
        token_preview,
        enabled: enabled == 1,
        expires_at,
        created_at,
        updated_at,
    }
}

/// Reject an expiry that has already passed.
///
/// Compared as text rather than as parsed instants: `expires_at` and SQLite's
/// `datetime('now')` share one fixed-width UTC shape, so this reaches the same
/// verdict as the authentication SQL in `middleware::auth`. Parsing here
/// instead would open a window where the console accepts an expiry the proxy
/// already treats as dead.
fn reject_past_expiry(expires_at: Option<&str>) -> Result<(), AppError> {
    match expires_at {
        Some(expiry) if expiry <= utc_now_timestamp().as_str() => Err(AppError::BadRequest(
            "token expiry must be in the future; disable or delete the token to revoke it now"
                .into(),
        )),
        _ => Ok(()),
    }
}

/// Upgrade plaintext token rows in one transaction.
///
/// The legacy `token` column is retained because its NOT NULL/UNIQUE constraints
/// are part of deployed databases. Its values are overwritten with the same
/// SHA-256 digest stored in `token_hash`, so no plaintext survives the commit.
pub async fn migrate_legacy_token_storage(pool: &SqlitePool) -> Result<(), sqlx::Error> {
    let mut tx = pool.begin().await?;
    let columns: Vec<String> =
        sqlx::query_scalar("SELECT name FROM pragma_table_info('api_tokens') ORDER BY cid")
            .fetch_all(&mut *tx)
            .await?;
    let has_legacy_token = columns.iter().any(|column| column == "token");
    let has_token_hash = columns.iter().any(|column| column == "token_hash");
    let has_token_preview = columns.iter().any(|column| column == "token_preview");

    if !has_legacy_token {
        return Err(sqlx::Error::Protocol(
            "api_tokens is missing its compatibility token column".into(),
        ));
    }
    if !has_token_hash {
        sqlx::query("ALTER TABLE api_tokens ADD COLUMN token_hash TEXT")
            .execute(&mut *tx)
            .await?;
    }
    if !has_token_preview {
        sqlx::query("ALTER TABLE api_tokens ADD COLUMN token_preview TEXT NOT NULL DEFAULT ''")
            .execute(&mut *tx)
            .await?;
    }

    if !has_token_hash {
        let rows: Vec<(i64, String)> =
            sqlx::query_as("SELECT id, token FROM api_tokens ORDER BY id")
                .fetch_all(&mut *tx)
                .await?;
        let existing_tokens: HashSet<&str> = rows.iter().map(|(_, token)| token.as_str()).collect();

        let marker_prefix = loop {
            let mut bytes = [0_u8; 16];
            rand::thread_rng().fill(&mut bytes);
            let candidate = format!(
                "__wildtoken_token_migration_{}__",
                URL_SAFE_NO_PAD.encode(bytes)
            );
            if existing_tokens
                .iter()
                .all(|token| !token.starts_with(&candidate))
            {
                break candidate;
            }
        };

        for (id, plaintext) in rows {
            sqlx::query(
                "UPDATE api_tokens SET token = ?, token_hash = ?, token_preview = ? WHERE id = ?",
            )
            .bind(format!("{marker_prefix}{id}"))
            .bind(token_digest(&plaintext))
            .bind(token_preview(&plaintext))
            .bind(id)
            .execute(&mut *tx)
            .await?;
        }
    }

    let missing_hashes: i64 =
        sqlx::query_scalar("SELECT COUNT(*) FROM api_tokens WHERE token_hash IS NULL")
            .fetch_one(&mut *tx)
            .await?;
    if missing_hashes != 0 {
        return Err(sqlx::Error::Protocol(
            "api_tokens contains rows without a token digest".into(),
        ));
    }

    // Clear compatibility-column plaintext after every startup. This is also a
    // repair guard for databases whose legacy column was modified out of band.
    sqlx::query("UPDATE api_tokens SET token = token_hash WHERE token <> token_hash")
        .execute(&mut *tx)
        .await?;
    sqlx::query(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash)",
    )
    .execute(&mut *tx)
    .await?;

    tx.commit().await
}

// ── Public functions ─────────────────────────────────────────────────────────────────

pub async fn list_tokens(pool: &SqlitePool) -> Result<Vec<ApiTokenOut>, AppError> {
    let rows: Vec<ApiTokenRow> = sqlx::query_as(&format!(
        "SELECT {TOKEN_COLUMNS} FROM api_tokens ORDER BY id ASC"
    ))
    .fetch_all(pool)
    .await?;

    Ok(rows.into_iter().map(token_out).collect())
}

pub async fn get_token(pool: &SqlitePool, id: i64) -> Result<Option<ApiTokenOut>, AppError> {
    let row: Option<ApiTokenRow> = sqlx::query_as(&format!(
        "SELECT {TOKEN_COLUMNS} FROM api_tokens WHERE id = ?"
    ))
    .bind(id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(token_out))
}

pub async fn create_token(
    pool: &SqlitePool,
    input: &ApiTokenIn,
) -> Result<ApiTokenCreatedOut, AppError> {
    input
        .validate()
        .map_err(|message| AppError::BadRequest(message.into()))?;
    let expires_at = input
        .normalized_expires_at()
        .map_err(|message| AppError::BadRequest(message.into()))?;
    reject_past_expiry(expires_at.as_deref())?;

    let token_value = input.token.clone().unwrap_or_else(generate_api_token);
    let token_hash = token_digest(&token_value);
    let token_preview = token_preview(&token_value);
    let enabled = i64::from(input.enabled);

    let result = sqlx::query(
        r#"INSERT INTO api_tokens
        (name, description, token, token_hash, token_preview, enabled, expires_at, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))"#,
    )
    .bind(input.name.trim())
    .bind(input.description.trim())
    .bind(&token_hash)
    .bind(&token_hash)
    .bind(&token_preview)
    .bind(enabled)
    .bind(expires_at.as_deref())
    .execute(pool)
    .await?;

    let last_id = result.last_insert_rowid();
    let row: ApiTokenRow = sqlx::query_as(&format!(
        "SELECT {TOKEN_COLUMNS} FROM api_tokens WHERE id = ?"
    ))
    .bind(last_id)
    .fetch_one(pool)
    .await?;

    Ok(ApiTokenCreatedOut {
        id: row.id,
        name: row.name,
        description: row.description,
        token: token_value,
        token_preview: row.token_preview,
        enabled: row.enabled == 1,
        expires_at: row.expires_at,
        created_at: row.created_at,
        updated_at: row.updated_at,
    })
}

pub async fn update_token(
    pool: &SqlitePool,
    id: i64,
    input: &ApiTokenUpdateIn,
) -> Result<ApiTokenOut, AppError> {
    input
        .validate()
        .map_err(|message| AppError::BadRequest(message.into()))?;
    let expires_at = input
        .normalized_expires_at()
        .map_err(|message| AppError::BadRequest(message.into()))?;

    let existing = get_token(pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound("token not found".into()))?;

    // Only a changed expiry has to be in the future. Editing a token that has
    // already lapsed sends its own past expiry back unchanged, and rejecting
    // that would make renaming an expired token impossible without renewing it.
    if expires_at != existing.expires_at {
        reject_past_expiry(expires_at.as_deref())?;
    }

    sqlx::query(
        "UPDATE api_tokens SET name = ?, description = ?, expires_at = ?, updated_at = datetime('now') WHERE id = ?",
    )
    .bind(input.name.trim())
    .bind(input.description.trim())
    .bind(expires_at.as_deref())
    .bind(id)
    .execute(pool)
    .await?;

    get_token(pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound("token not found".into()))
}

pub async fn set_token_enabled(
    pool: &SqlitePool,
    id: i64,
    enabled: bool,
) -> Result<ApiTokenOut, AppError> {
    let val = i64::from(enabled);

    sqlx::query("UPDATE api_tokens SET enabled = ?, updated_at = datetime('now') WHERE id = ?")
        .bind(val)
        .bind(id)
        .execute(pool)
        .await?;

    get_token(pool, id)
        .await?
        .ok_or_else(|| AppError::NotFound("token not found".into()))
}

pub async fn delete_token(pool: &SqlitePool, id: i64) -> Result<bool, AppError> {
    let result = sqlx::query("DELETE FROM api_tokens WHERE id = ?")
        .bind(id)
        .execute(pool)
        .await?;

    Ok(result.rows_affected() > 0)
}

#[cfg(test)]
mod tests {
    use sqlx::sqlite::SqlitePoolOptions;

    use super::{create_token, get_token, token_digest, token_preview, update_token};
    use crate::{
        error::AppError,
        models::token::{ApiTokenIn, ApiTokenUpdateIn},
        state::init_db,
    };

    async fn memory_pool() -> sqlx::SqlitePool {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&pool).await.unwrap();
        pool
    }

    fn create_input(name: &str, expires_at: Option<&str>) -> ApiTokenIn {
        ApiTokenIn {
            name: name.into(),
            description: String::new(),
            token: None,
            enabled: true,
            expires_at: expires_at.map(str::to_owned),
        }
    }

    #[tokio::test]
    async fn creation_honors_enabled_and_persists_only_the_digest() {
        let pool = memory_pool().await;
        let plaintext = "custom-token-value-1234";

        let created = create_token(
            &pool,
            &ApiTokenIn {
                name: " disabled client ".into(),
                description: " disabled at creation ".into(),
                token: Some(plaintext.into()),
                enabled: false,
                expires_at: None,
            },
        )
        .await
        .unwrap();

        assert_eq!(created.token, plaintext);
        assert!(!created.enabled);
        assert_eq!(created.name, "disabled client");
        let stored: (String, String, String, i64) = sqlx::query_as(
            "SELECT token, token_hash, token_preview, enabled FROM api_tokens WHERE id = ?",
        )
        .bind(created.id)
        .fetch_one(&pool)
        .await
        .unwrap();
        assert_eq!(stored.0, token_digest(plaintext));
        assert_eq!(stored.1, token_digest(plaintext));
        assert_ne!(stored.2, plaintext);
        assert_eq!(stored.3, 0);
    }

    #[tokio::test]
    async fn creation_stores_a_normalized_expiry_and_refuses_a_past_one() {
        let pool = memory_pool().await;

        let never = create_token(&pool, &create_input("never", None))
            .await
            .unwrap();
        assert_eq!(never.expires_at, None);

        // An offset form is accepted and lands in the stored UTC shape.
        let dated = create_token(
            &pool,
            &create_input("dated", Some("2099-01-01T08:00:00+08:00")),
        )
        .await
        .unwrap();
        assert_eq!(dated.expires_at.as_deref(), Some("2099-01-01 00:00:00"));

        let past = create_token(&pool, &create_input("past", Some("2000-01-01 00:00:00"))).await;
        assert!(matches!(past, Err(AppError::BadRequest(_))));
    }

    #[tokio::test]
    async fn updating_can_renew_or_clear_an_expiry_and_leaves_a_lapsed_one_editable() {
        let pool = memory_pool().await;
        let created = create_token(&pool, &create_input("client", Some("2099-01-01 00:00:00")))
            .await
            .unwrap();

        // Backdate the row the way time would have.
        sqlx::query("UPDATE api_tokens SET expires_at = '2000-01-01 00:00:00' WHERE id = ?")
            .bind(created.id)
            .execute(&pool)
            .await
            .unwrap();

        // Renaming an expired token resends its own past expiry unchanged. That
        // must not be rejected, or the row could never be edited again.
        let renamed = update_token(
            &pool,
            created.id,
            &ApiTokenUpdateIn {
                name: "renamed".into(),
                description: String::new(),
                expires_at: Some("2000-01-01 00:00:00".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(renamed.name, "renamed");
        assert_eq!(renamed.expires_at.as_deref(), Some("2000-01-01 00:00:00"));

        // Moving it to a different past instant is a real change, so it is not.
        let backdated = update_token(
            &pool,
            created.id,
            &ApiTokenUpdateIn {
                name: "renamed".into(),
                description: String::new(),
                expires_at: Some("2001-01-01 00:00:00".into()),
            },
        )
        .await;
        assert!(matches!(backdated, Err(AppError::BadRequest(_))));

        let renewed = update_token(
            &pool,
            created.id,
            &ApiTokenUpdateIn {
                name: "renamed".into(),
                description: String::new(),
                expires_at: Some("2099-06-01 00:00:00".into()),
            },
        )
        .await
        .unwrap();
        assert_eq!(renewed.expires_at.as_deref(), Some("2099-06-01 00:00:00"));

        // An absent expiry clears it — the update endpoint is a full replacement.
        update_token(
            &pool,
            created.id,
            &ApiTokenUpdateIn {
                name: "renamed".into(),
                description: String::new(),
                expires_at: None,
            },
        )
        .await
        .unwrap();
        assert_eq!(
            get_token(&pool, created.id)
                .await
                .unwrap()
                .unwrap()
                .expires_at,
            None
        );
    }

    #[test]
    fn preview_never_contains_a_short_token_in_full() {
        assert_eq!(token_preview(""), "…");
        assert_eq!(token_preview("x"), "…");
        assert_eq!(token_preview("short"), "sh…");
        assert_eq!(token_preview("long-enough-token"), "long-eno…");
    }
}
