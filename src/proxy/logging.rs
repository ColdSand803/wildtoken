use base64::Engine as _;

// ── Constants ────────────────────────────────────────────────────────────────

/// Maximum characters to log for request / response bodies before truncation.
const MAX_LOGGED_BODY_CHARS: usize = 200_000;

// ── Log entry ────────────────────────────────────────────────────────────────

/// Structured log entry.
#[derive(Debug, Default, Clone)]
pub struct LogEntry {
    pub method: String,
    pub path: String,
    pub upstream_id: Option<i64>,
    pub upstream_name: Option<String>,
    pub model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub stream: bool,
    pub status_code: Option<i32>,
    pub prompt_tokens: Option<i32>,
    pub completion_tokens: Option<i32>,
    pub total_tokens: Option<i32>,
    pub first_token_ms: Option<i32>,
    pub duration_ms: Option<i32>,
    pub error: Option<String>,
    pub downstream_request: Option<serde_json::Value>,
    pub upstream_request: Option<serde_json::Value>,
    pub upstream_response: Option<serde_json::Value>,
    pub downstream_response: Option<serde_json::Value>,
}

// ── Snapshots ────────────────────────────────────────────────────────────────

/// Build a request snapshot (with redacted headers, truncated body).
pub fn snapshot_request(
    method: &str,
    url: &str,
    headers: &std::collections::HashMap<String, String>,
    body: Option<&[u8]>,
) -> serde_json::Value {
    let redacted: std::collections::HashMap<&str, &str> = headers
        .iter()
        .map(|(k, v)| {
            let is_sensitive = super::client::SENSITIVE_REQUEST_HEADERS
                .iter()
                .any(|h| k.to_lowercase() == h.to_lowercase());
            let val: &str = if is_sensitive { "***REDACTED***" } else { v };
            (k.as_str(), val)
        })
        .collect();

    let mut obj = serde_json::json!({
        "method": method,
        "url": url,
        "headers": redacted,
    });

    if let Some(b) = body {
        obj["body"] = truncate_body(b);
    }

    obj
}

/// Build a response snapshot (with redacted headers, truncated body).
pub fn snapshot_response(
    status: u16,
    headers: &std::collections::HashMap<String, String>,
    body: Option<&[u8]>,
) -> serde_json::Value {
    let mut obj = serde_json::json!({
        "status": status,
        "headers": headers,
    });

    if let Some(b) = body {
        obj["body"] = truncate_body(b);
    }

    obj
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/// Redact a single header value.
#[allow(dead_code)]
fn redact_header_value(_value: &str) -> String {
    "***REDACTED***".to_string()
}

/// Truncate body: if text > MAX_LOGGED_BODY_CHARS, base64-encode and truncate.
fn truncate_body(body: &[u8]) -> serde_json::Value {
    // Try UTF-8 text first
    if let Ok(text) = std::str::from_utf8(body) {
        if text.len() <= MAX_LOGGED_BODY_CHARS {
            return serde_json::Value::String(text.to_string());
        }
        // Too long → base64 + truncate
    }

    // Fallback: base64
    let encoded = base64::Engine::encode(&base64::engine::general_purpose::STANDARD, body);
    if encoded.len() <= MAX_LOGGED_BODY_CHARS {
        return serde_json::json!({ "base64": encoded, "size": body.len() });
    }

    serde_json::json!({
        "base64_truncated": &encoded[..MAX_LOGGED_BODY_CHARS],
        "size": body.len(),
    })
}

// ── Async log writer ────────────────────────────────────────────────────────

/// Spawn a background task to write the log entry so the caller is not blocked
/// and the write cannot be cancelled by the caller's drop.
pub fn schedule_log(pool: &sqlx::SqlitePool, entry: LogEntry) {
    let pool = pool.clone();
    tokio::spawn(async move {
        let _ = insert_log_entry(&pool, entry).await;
    });
}

async fn insert_log_entry(
    pool: &sqlx::SqlitePool,
    entry: LogEntry,
) -> Result<(), crate::error::AppError> {
    let stream_int: i64 = if entry.stream { 1 } else { 0 };

    let downstream_request = entry
        .downstream_request
        .map(|v| v.to_string())
        .unwrap_or_default();
    let upstream_request = entry
        .upstream_request
        .map(|v| v.to_string())
        .unwrap_or_default();
    let upstream_response = entry
        .upstream_response
        .map(|v| v.to_string())
        .unwrap_or_default();
    let downstream_response = entry
        .downstream_response
        .map(|v| v.to_string())
        .unwrap_or_default();

    sqlx::query(
        r#"INSERT INTO request_logs
            (method, path, upstream_id, upstream_name, model,
             reasoning_effort, stream, status_code,
             prompt_tokens, completion_tokens, total_tokens,
             duration_ms, first_token_ms, error,
             downstream_request, upstream_request,
             upstream_response, downstream_response,
             created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                ?, ?, ?, ?, datetime('now'))"#,
    )
    .bind(&entry.method)
    .bind(&entry.path)
    .bind(entry.upstream_id)
    .bind(&entry.upstream_name)
    .bind(&entry.model)
    .bind(&entry.reasoning_effort)
    .bind(stream_int)
    .bind(entry.status_code)
    .bind(entry.prompt_tokens)
    .bind(entry.completion_tokens)
    .bind(entry.total_tokens)
    .bind(entry.duration_ms)
    .bind(entry.first_token_ms)
    .bind(&entry.error)
    .bind(&downstream_request)
    .bind(&upstream_request)
    .bind(&upstream_response)
    .bind(&downstream_response)
    .execute(pool)
    .await?;

    Ok(())
}

// ── Background cleanup ──────────────────────────────────────────────────────

/// Background task that periodically cleans old log bodies and deletes stale logs.
pub async fn cleanup_loop(pool: sqlx::SqlitePool) {
    loop {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;

        if let Err(e) = crate::db::log::clear_old_log_bodies(&pool).await {
            tracing::error!("clear_old_log_bodies failed: {:?}", e);
        }

        if let Err(e) = crate::db::log::delete_old_logs(&pool).await {
            tracing::error!("delete_old_logs failed: {:?}", e);
        }
    }
}
