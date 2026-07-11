use crate::error::AppError;
use crate::models::upstream::UpstreamRow;
use crate::state::AppState;
use futures::StreamExt;
use std::collections::HashMap;

use super::logging;
use super::matcher::{self, BackoffManager};

// ── Constants ────────────────────────────────────────────────────────────────

/// Headers that must **not** be forwarded to the upstream.
pub const HOP_BY_HOP_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "host",
    "content-length",
    "te",
    "trailer",
    "upgrade",
    "proxy-authorization",
    "proxy-authenticate",
    "x-wildtoken-upstream",
];

/// Headers whose values should be redacted in logs.
pub const SENSITIVE_REQUEST_HEADERS: &[&str] = &[
    "authorization",
    "x-api-key",
    "cookie",
    "set-cookie",
    "proxy-authorization",
    "x-admin-token",
];

// ── URL building ─────────────────────────────────────────────────────────────

/// Build the full upstream URL.
pub fn build_upstream_url(
    upstream: &UpstreamRow,
    path: &str,
    query_params: Option<&str>,
) -> String {
    let base = upstream.base_url.trim_end_matches('/');
    let suffix = path.trim_start_matches('/');
    let mut target = if base.ends_with("/v1") {
        format!("{base}/{suffix}")
    } else {
        format!("{base}/v1/{suffix}")
    };
    if let Some(q) = query_params {
        if !q.is_empty() {
            target.push('?');
            target.push_str(q);
        }
    }
    target
}

// ── Header forwarding ───────────────────────────────────────────────────────

/// Build forward headers: filter hop-by-hop, inject api_key, merge extra_headers.
///
/// Header names are normalized to lowercase so we never emit case-duplicate keys
/// (e.g. both `Authorization` and `authorization`), which many reverse proxies
/// reject with a raw HTTP 400 HTML page.
///
/// The downstream client's `Authorization` is intentionally dropped; we inject
/// the upstream key under a single lowercase `authorization` name.
pub fn build_forward_headers(
    downstream_headers: &axum::http::HeaderMap,
    upstream: &UpstreamRow,
) -> HashMap<String, String> {
    let mut out = HashMap::new();

    for (name, value) in downstream_headers.iter() {
        let name_lower = name.as_str().to_lowercase();
        if HOP_BY_HOP_HEADERS.contains(&name_lower.as_str()) {
            continue;
        }
        // Never forward the client's credentials; replace with upstream key below.
        if name_lower == "authorization" {
            continue;
        }
        if let Ok(v) = value.to_str() {
            out.insert(name_lower, v.to_string());
        }
    }

    // Prefer uncompressed responses so we can log usage from body text.
    out.insert("accept-encoding".into(), "identity".into());

    // Always override Authorization when upstream has an api_key.
    if let Some(ref key) = upstream.api_key {
        if !key.is_empty() {
            out.insert("authorization".into(), format!("Bearer {key}"));
        }
    }

    // Merge extra_headers last so they can override (normalize keys too).
    if let Ok(extra) = serde_json::from_str::<HashMap<String, String>>(&upstream.extra_headers) {
        for (k, v) in extra {
            out.insert(k.to_lowercase(), v);
        }
    }

    out
}

// ── SSE / token helpers ─────────────────────────────────────────────────────

fn non_empty_str(value: &serde_json::Value) -> bool {
    value.as_str().map(|s| !s.is_empty()).unwrap_or(false)
}

/// Whether a parsed SSE JSON payload contains the first visible generation token.
fn json_has_visible_token(obj: &serde_json::Value) -> bool {
    if let Some(choices) = obj.get("choices").and_then(|v| v.as_array()) {
        for choice in choices {
            let delta = &choice["delta"];
            if non_empty_str(&delta["content"])
                || non_empty_str(&delta["reasoning_content"])
                || non_empty_str(&delta["reasoning"])
                || non_empty_str(&delta["text"])
            {
                return true;
            }
            if non_empty_str(&choice["text"]) || non_empty_str(&choice["message"]["content"]) {
                return true;
            }
        }
    }

    // OpenAI Responses API streaming events.
    if obj
        .get("type")
        .and_then(|v| v.as_str())
        .is_some_and(|t| {
            t == "response.output_text.delta"
                || t == "response.reasoning_text.delta"
                || t == "response.reasoning_summary_text.delta"
        })
        && non_empty_str(&obj["delta"])
    {
        return true;
    }

    false
}

/// Detect whether an SSE line/chunk contains a visible content token.
pub fn extract_first_token_ms(chunk: &[u8]) -> Option<u64> {
    let text = std::str::from_utf8(chunk).ok()?;
    for line in text.lines() {
        if sse_line_has_visible_token(line) {
            return Some(0);
        }
    }
    None
}

fn sse_line_has_visible_token(line: &str) -> bool {
    let line = line.trim();
    let Some(data) = line.strip_prefix("data:") else {
        return false;
    };
    let data = data.trim_start();
    if data.is_empty() || data == "[DONE]" {
        return false;
    }
    serde_json::from_str::<serde_json::Value>(data)
        .ok()
        .is_some_and(|obj| json_has_visible_token(&obj))
}

/// Extract token usage from either SSE stream body or JSON body.
///
/// Returns `(prompt_tokens, completion_tokens, total_tokens)`.
pub fn extract_usage(
    raw_body: &[u8],
    content_type: &str,
) -> (Option<i32>, Option<i32>, Option<i32>) {
    let text = match std::str::from_utf8(raw_body) {
        Ok(s) => s,
        Err(_) => return (None, None, None),
    };

    if content_type.contains("text/event-stream") || content_type.contains("sse") {
        let mut prompt = None;
        let mut completion = None;
        let mut total = None;
        for line in text.lines() {
            let line = line.trim();
            if let Some(data) = line.strip_prefix("data: ") {
                if data == "[DONE]" {
                    continue;
                }
                if let Ok(obj) = serde_json::from_str::<serde_json::Value>(data) {
                    if let Some(u) = obj.get("usage") {
                        prompt = u
                            .get("prompt_tokens")
                            .or_else(|| u.get("input_tokens"))
                            .and_then(|v| v.as_i64())
                            .map(|v| v as i32);
                        completion = u
                            .get("completion_tokens")
                            .or_else(|| u.get("output_tokens"))
                            .and_then(|v| v.as_i64())
                            .map(|v| v as i32);
                        total = u
                            .get("total_tokens")
                            .and_then(|v| v.as_i64())
                            .map(|v| v as i32);
                    }
                }
            }
        }
        return (prompt, completion, total);
    }

    if let Ok(obj) = serde_json::from_str::<serde_json::Value>(text) {
        if let Some(u) = obj.get("usage") {
            let prompt = u
                .get("prompt_tokens")
                .or_else(|| u.get("input_tokens"))
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);
            let completion = u
                .get("completion_tokens")
                .or_else(|| u.get("output_tokens"))
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);
            let total = u
                .get("total_tokens")
                .and_then(|v| v.as_i64())
                .map(|v| v as i32);
            return (prompt, completion, total);
        }
    }

    (None, None, None)
}

/// Extract reasoning effort from an OpenAI-compatible request body.
///
/// Supports:
/// - top-level `reasoning_effort` (chat completions / o-series)
/// - nested `reasoning.effort` (Responses API style)
fn extract_reasoning_effort(body: &[u8]) -> Option<String> {
    let json = serde_json::from_slice::<serde_json::Value>(body).ok()?;

    if let Some(v) = json.get("reasoning_effort") {
        if let Some(s) = v.as_str() {
            let s = s.trim();
            if !s.is_empty() {
                return Some(s.to_string());
            }
        } else if let Some(n) = v.as_i64() {
            return Some(n.to_string());
        } else if let Some(n) = v.as_f64() {
            return Some(n.to_string());
        } else if let Some(b) = v.as_bool() {
            return Some(b.to_string());
        }
    }

    if let Some(s) = json
        .get("reasoning")
        .and_then(|r| r.get("effort"))
        .and_then(|v| v.as_str())
    {
        let s = s.trim();
        if !s.is_empty() {
            return Some(s.to_string());
        }
    }

    None
}

/// Read the full upstream body while recording true TTFT for SSE streams.
async fn read_response_body(
    response: reqwest::Response,
    start: std::time::Instant,
) -> Result<(Vec<u8>, Option<i32>), reqwest::Error> {
    let mut body_bytes = Vec::new();
    let mut first_token_ms = None;
    let mut line_buf = String::new();
    let mut stream = response.bytes_stream();

    while let Some(chunk) = stream.next().await {
        let chunk = chunk?;
        body_bytes.extend_from_slice(&chunk);

        if first_token_ms.is_none() {
            line_buf.push_str(&String::from_utf8_lossy(&chunk));
            while let Some(pos) = line_buf.find('\n') {
                let line = line_buf[..pos].trim_end_matches('\r').to_string();
                let rest = line_buf[pos + 1..].to_string();
                line_buf = rest;
                if sse_line_has_visible_token(&line) {
                    first_token_ms = Some(start.elapsed().as_millis() as i32);
                    break;
                }
            }
        }
    }

    // Final partial line (rare, but keep parity with buffered detection).
    if first_token_ms.is_none() && sse_line_has_visible_token(line_buf.trim_end_matches('\r')) {
        first_token_ms = Some(start.elapsed().as_millis() as i32);
    }

    Ok((body_bytes, first_token_ms))
}

// ── Main proxy function ─────────────────────────────────────────────────────

/// Proxy a request to the upstream, returning (status_code, response_headers, body_bytes).
pub async fn proxy_request(
    state: &AppState,
    backoff: &BackoffManager,
    upstream: &UpstreamRow,
    forward_model: Option<&str>,
    method: &str,
    path: &str,
    query_params: Option<&str>,
    downstream_headers: &axum::http::HeaderMap,
    body: &[u8],
) -> Result<(axum::http::StatusCode, HashMap<String, String>, Vec<u8>), AppError> {
    let start = std::time::Instant::now();
    let reasoning_effort = extract_reasoning_effort(body);

    let url = build_upstream_url(upstream, path, query_params);
    let mut fwd_headers = build_forward_headers(downstream_headers, upstream);

    let downstream_snap = logging::snapshot_request(method, &url, &fwd_headers, Some(body));

    // Rewrite model field when mapping applies.
    let upstream_body = if let Some(fmodel) = forward_model {
        if let Ok(mut json) = serde_json::from_slice::<serde_json::Value>(body) {
            if let Some(existing) = json.get("model").and_then(|v| v.as_str()) {
                if existing != fmodel {
                    json["model"] = serde_json::Value::String(fmodel.to_string());
                    fwd_headers.remove("content-length");
                    serde_json::to_vec(&json).unwrap_or_else(|_| body.to_vec())
                } else {
                    body.to_vec()
                }
            } else {
                body.to_vec()
            }
        } else {
            body.to_vec()
        }
    } else {
        body.to_vec()
    };

    let upstream_snap =
        logging::snapshot_request(method, &url, &fwd_headers, Some(&upstream_body));

    let mut req_builder = state.http_client.request(
        reqwest::Method::from_bytes(method.as_bytes()).unwrap_or(reqwest::Method::POST),
        &url,
    );

    for (k, v) in &fwd_headers {
        let kl = k.to_lowercase();
        if HOP_BY_HOP_HEADERS.contains(&kl.as_str()) || kl == "content-length" || kl == "host" {
            continue;
        }
        req_builder = req_builder.header(k.as_str(), v.as_str());
    }

    if !upstream_body.is_empty() {
        req_builder = req_builder.body(upstream_body.clone());
    }

    req_builder = req_builder.timeout(std::time::Duration::from_secs_f64(
        if upstream.timeout_seconds > 0.0 {
            upstream.timeout_seconds
        } else {
            state.settings.upstream.default_timeout_seconds
        },
    ));

    let response = match req_builder.send().await {
        Ok(resp) => resp,
        Err(e) => {
            backoff.record_failure(upstream.id);

            let elapsed = start.elapsed();
            let code: i32 = if e.is_timeout() { 504 } else { 502 };
            let err_msg = e.to_string();

            let log_entry = logging::LogEntry {
                method: method.to_string(),
                path: path.to_string(),
                upstream_id: Some(upstream.id),
                upstream_name: Some(upstream.name.clone()),
                model: forward_model.map(|s| s.to_string()),
                reasoning_effort: reasoning_effort.clone(),
                stream: false,
                status_code: Some(code),
                duration_ms: Some(elapsed.as_millis() as i32),
                error: Some(err_msg.clone()),
                downstream_request: Some(downstream_snap),
                upstream_request: Some(upstream_snap),
                ..Default::default()
            };
            logging::schedule_log(&state.db, log_entry);

            return Err(AppError::UpstreamError(err_msg));
        }
    };

    let status = response.status();
    let mut resp_headers: HashMap<String, String> = HashMap::new();
    for (name, value) in response.headers().iter() {
        if let Ok(v) = value.to_str() {
            resp_headers.insert(name.as_str().to_string(), v.to_string());
        }
    }

    let content_type = resp_headers
        .get("content-type")
        .cloned()
        .unwrap_or_default();

    let (body_bytes, streamed_first_token_ms) = match read_response_body(response, start).await {
        Ok(v) => v,
        Err(e) => {
            backoff.record_failure(upstream.id);
            let elapsed = start.elapsed();
            let log_entry = logging::LogEntry {
                method: method.to_string(),
                path: path.to_string(),
                upstream_id: Some(upstream.id),
                upstream_name: Some(upstream.name.clone()),
                model: forward_model.map(|s| s.to_string()),
                reasoning_effort: reasoning_effort.clone(),
                stream: false,
                status_code: Some(502),
                duration_ms: Some(elapsed.as_millis() as i32),
                error: Some(e.to_string()),
                downstream_request: Some(downstream_snap),
                upstream_request: Some(upstream_snap),
                ..Default::default()
            };
            logging::schedule_log(&state.db, log_entry);
            return Err(AppError::UpstreamError(e.to_string()));
        }
    };

    let status_u16 = status.as_u16();
    let auto_disabled = matcher::AUTO_DISABLE_STATUS_CODES.contains(&status_u16);
    if auto_disabled {
        let _ = crate::db::upstream::set_upstream_enabled(&state.db, upstream.id, false).await;
    }

    // Backoff bookkeeping: success on 2xx or after auto-disable; else failure.
    if auto_disabled || (200..300).contains(&status_u16) {
        backoff.record_success(upstream.id);
    } else {
        backoff.record_failure(upstream.id);
    }

    let upstream_resp_snap =
        logging::snapshot_response(status_u16, &resp_headers, Some(&body_bytes));

    let (prompt_tokens, completion_tokens, total_tokens) =
        extract_usage(&body_bytes, &content_type);

    let elapsed = start.elapsed();
    let is_stream = body_bytes.starts_with(b"data:") || content_type.contains("event-stream");

    // Prefer true stream TTFT; fall back to buffered detection only for stream bodies.
    let first_token_ms = if is_stream {
        streamed_first_token_ms.or_else(|| {
            extract_first_token_ms(&body_bytes).map(|_| elapsed.as_millis() as i32)
        })
    } else {
        None
    };

    let log_entry = logging::LogEntry {
        method: method.to_string(),
        path: path.to_string(),
        upstream_id: Some(upstream.id),
        upstream_name: Some(upstream.name.clone()),
        model: forward_model.map(|s| s.to_string()),
        reasoning_effort,
        stream: is_stream,
        status_code: Some(status_u16 as i32),
        prompt_tokens,
        completion_tokens,
        total_tokens,
        first_token_ms,
        duration_ms: Some(elapsed.as_millis() as i32),
        downstream_request: Some(downstream_snap),
        upstream_request: Some(upstream_snap),
        upstream_response: Some(upstream_resp_snap.clone()),
        downstream_response: Some(upstream_resp_snap),
        ..Default::default()
    };
    logging::schedule_log(&state.db, log_entry);

    Ok((status, resp_headers, body_bytes))
}
