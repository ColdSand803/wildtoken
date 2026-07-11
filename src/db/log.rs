use sqlx::{FromRow, SqlitePool};

use crate::error::AppError;
use crate::models::request_log::{RequestLogDetailOut, RequestLogOut};

// ── Internal query types (to avoid exceeding sqlx tuple limit) ──────────────

#[derive(Debug, FromRow)]
struct LogListRow {
    id: i64,
    created_at: String,
    method: String,
    path: String,
    upstream_id: Option<i64>,
    upstream_name: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    stream: i32,
    status_code: Option<i32>,
    prompt_tokens: Option<i32>,
    completion_tokens: Option<i32>,
    total_tokens: Option<i32>,
    duration_ms: Option<i32>,
    first_token_ms: Option<i32>,
    error: Option<String>,
}

#[derive(Debug, FromRow)]
struct LogDetailRow {
    id: i64,
    created_at: String,
    method: String,
    path: String,
    upstream_id: Option<i64>,
    upstream_name: Option<String>,
    model: Option<String>,
    reasoning_effort: Option<String>,
    stream: i32,
    status_code: Option<i32>,
    prompt_tokens: Option<i32>,
    completion_tokens: Option<i32>,
    total_tokens: Option<i32>,
    duration_ms: Option<i32>,
    first_token_ms: Option<i32>,
    error: Option<String>,
    downstream_request: Option<String>,
    upstream_request: Option<String>,
    upstream_response: Option<String>,
    downstream_response: Option<String>,
}

// ── Public functions ────────────────────────────────────────────────────────

pub async fn list_logs(
    pool: &SqlitePool,
    limit: i32,
    offset: i32,
    upstream_id: Option<i64>,
) -> Result<Vec<RequestLogOut>, AppError> {
    let rows: Vec<LogListRow> = if let Some(uid) = upstream_id {
        sqlx::query_as(
            "SELECT id, created_at, method, path,
                    upstream_id, upstream_name, model, reasoning_effort,
                    stream, status_code,
                    prompt_tokens, completion_tokens, total_tokens,
                    duration_ms, first_token_ms,
                    error
             FROM request_logs
             WHERE upstream_id = ?
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?",
        )
        .bind(uid)
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?
    } else {
        sqlx::query_as(
            "SELECT id, created_at, method, path,
                    upstream_id, upstream_name, model, reasoning_effort,
                    stream, status_code,
                    prompt_tokens, completion_tokens, total_tokens,
                    duration_ms, first_token_ms,
                    error
             FROM request_logs
             ORDER BY created_at DESC
             LIMIT ? OFFSET ?",
        )
        .bind(limit)
        .bind(offset)
        .fetch_all(pool)
        .await?
    };

    let outputs: Vec<RequestLogOut> = rows
        .into_iter()
        .map(|r| RequestLogOut {
            id: r.id,
            created_at: r.created_at,
            method: r.method,
            path: r.path,
            upstream_id: r.upstream_id,
            upstream_name: r.upstream_name,
            model: r.model,
            reasoning_effort: r.reasoning_effort,
            stream: r.stream,
            status_code: r.status_code,
            prompt_tokens: r.prompt_tokens,
            completion_tokens: r.completion_tokens,
            total_tokens: r.total_tokens,
            duration_ms: r.duration_ms,
            first_token_ms: r.first_token_ms,
            error: r.error,
        })
        .collect();

    Ok(outputs)
}

pub async fn get_log_detail(
    pool: &SqlitePool,
    log_id: i64,
) -> Result<Option<RequestLogDetailOut>, AppError> {
    let row: Option<LogDetailRow> = sqlx::query_as(
        r#"SELECT id, created_at, method, path,
                  upstream_id, upstream_name, model, reasoning_effort,
                  stream, status_code,
                  prompt_tokens, completion_tokens, total_tokens,
                  duration_ms, first_token_ms,
                  error,
                  downstream_request, upstream_request,
                  upstream_response, downstream_response
           FROM request_logs
           WHERE id = ?"#,
    )
    .bind(log_id)
    .fetch_optional(pool)
    .await?;

    Ok(row.map(|r| RequestLogDetailOut {
        base: RequestLogOut {
            id: r.id,
            created_at: r.created_at,
            method: r.method,
            path: r.path,
            upstream_id: r.upstream_id,
            upstream_name: r.upstream_name,
            model: r.model,
            reasoning_effort: r.reasoning_effort,
            stream: r.stream,
            status_code: r.status_code,
            prompt_tokens: r.prompt_tokens,
            completion_tokens: r.completion_tokens,
            total_tokens: r.total_tokens,
            duration_ms: r.duration_ms,
            first_token_ms: r.first_token_ms,
            error: r.error,
        },
        downstream_request: r.downstream_request.and_then(|s| serde_json::from_str(&s).ok()),
        upstream_request: r.upstream_request.and_then(|s| serde_json::from_str(&s).ok()),
        upstream_response: r.upstream_response.and_then(|s| serde_json::from_str(&s).ok()),
        downstream_response: r.downstream_response.and_then(|s| serde_json::from_str(&s).ok()),
    }))
}

pub async fn insert_log(
    pool: &SqlitePool,
    method: &str,
    path: &str,
    upstream_id: Option<i64>,
    upstream_name: Option<&str>,
    model: Option<&str>,
    reasoning_effort: Option<&str>,
    stream: bool,
    status_code: Option<i32>,
    prompt_tokens: Option<i32>,
    completion_tokens: Option<i32>,
    total_tokens: Option<i32>,
    duration_ms: Option<i32>,
    first_token_ms: Option<i32>,
    error: Option<&str>,
    downstream_request: &str,
    upstream_request: &str,
    upstream_response: &str,
    downstream_response: &str,
) -> Result<(), AppError> {
    let stream_int: i32 = if stream { 1 } else { 0 };

    sqlx::query(
        r#"INSERT INTO request_logs
            (method, path,
             upstream_id, upstream_name, model, reasoning_effort,
             stream, status_code,
             prompt_tokens, completion_tokens, total_tokens,
             duration_ms, first_token_ms, error,
             downstream_request, upstream_request,
             upstream_response, downstream_response, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))"#,
    )
    .bind(method)
    .bind(path)
    .bind(upstream_id)
    .bind(upstream_name)
    .bind(model)
    .bind(reasoning_effort)
    .bind(stream_int)
    .bind(status_code)
    .bind(prompt_tokens)
    .bind(completion_tokens)
    .bind(total_tokens)
    .bind(duration_ms)
    .bind(first_token_ms)
    .bind(error)
    .bind(downstream_request)
    .bind(upstream_request)
    .bind(upstream_response)
    .bind(downstream_response)
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn clear_old_log_bodies(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::query(
        r#"UPDATE request_logs
        SET downstream_request = '{"cleared":true}',
            upstream_request   = '{"cleared":true}',
            upstream_response  = '{"cleared":true}',
            downstream_response = '{"cleared":true}'
        WHERE id NOT IN (
            SELECT id FROM request_logs
            ORDER BY created_at DESC
            LIMIT 100
        )"#,
    )
    .execute(pool)
    .await?;

    Ok(())
}

pub async fn delete_old_logs(pool: &SqlitePool) -> Result<(), AppError> {
    sqlx::query(
        "DELETE FROM request_logs WHERE created_at < datetime('now', '-30 days')",
    )
    .execute(pool)
    .await?;

    Ok(())
}
