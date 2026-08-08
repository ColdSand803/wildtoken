use std::collections::HashMap;

use axum::{
    extract::{Path, State},
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use base64::{engine::general_purpose::URL_SAFE_NO_PAD, Engine as _};
use rand::{rngs::OsRng, RngCore};

use crate::db::{settings as settings_db, upstream as upstream_db};
use crate::error::AppError;
use crate::middleware::auth::AdminAuth;
use crate::models::request_log::{ModelFetchIn, ModelListOut, TestRequest};
use crate::models::settings::ModelTestRequest;
use crate::models::upstream::{
    UpstreamDetailOut, UpstreamEnabledIn, UpstreamIn, UpstreamOut, UpstreamPriorityIn,
    UpstreamUpdate,
};
use crate::proxy::client::{
    apply_header_overrides, extract_usage, is_sensitive_header_name, validate_header_overrides,
};
use crate::proxy::logging;
use crate::proxy::matcher::AutoWeightPolicy;
use crate::state::AppState;

// ── URL helper (aligned with Python build_upstream_url) ───────────────────────

fn build_url(base_url: &str, path: &str, query: &str) -> String {
    let base = base_url.trim_end_matches('/');
    let suffix = path.trim_start_matches('/');
    let target = if base.ends_with("/v1") {
        format!("{base}/{suffix}")
    } else {
        format!("{base}/v1/{suffix}")
    };
    if query.is_empty() {
        target
    } else {
        format!("{target}?{query}")
    }
}

fn apply_runtime_health(state: &AppState, policy: AutoWeightPolicy, item: &mut UpstreamOut) {
    let health = state
        .auto_weight
        .snapshot(item.id, item.weight, item.auto_weight_enabled, policy);
    item.runtime_health_score = health.score;
    item.effective_weight = health.effective_weight;
    item.health_recovery_remaining_seconds = health.recovery_remaining_seconds;
}

fn extract_model_test_reply(payload: &serde_json::Value) -> Option<String> {
    if let Some(content) = payload
        .pointer("/choices/0/message/content")
        .and_then(serde_json::Value::as_str)
    {
        return Some(content.to_owned());
    }
    if let Some(content) = payload.get("content").and_then(serde_json::Value::as_array) {
        let text = content
            .iter()
            .filter(|item| item.get("type").and_then(serde_json::Value::as_str) == Some("text"))
            .filter_map(|item| item.get("text")?.as_str())
            .collect::<Vec<_>>()
            .join("\n");
        if !text.is_empty() {
            return Some(text);
        }
    }
    let output = payload.get("output")?.as_array()?;
    let text = output
        .iter()
        .filter_map(|item| item.get("content")?.as_array())
        .flat_map(|content| content.iter())
        .filter_map(|item| item.get("text")?.as_str())
        .collect::<Vec<_>>()
        .join("\n");
    (!text.is_empty()).then_some(text)
}

fn codex_model_test_headers() -> HashMap<String, String> {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let request_id = URL_SAFE_NO_PAD.encode(bytes);
    let headers = HashMap::from([
        ("accept".into(), "text/event-stream".into()),
        ("accept-encoding".into(), "identity".into()),
        ("content-type".into(), "application/json".into()),
        ("originator".into(), "codex-tui".into()),
        ("session-id".into(), request_id.clone()),
        ("thread-id".into(), request_id.clone()),
        ("user-agent".into(), "codex-tui/0.144.1 (Fedora 44.0.0; x86_64) xterm-256color (codex-tui; 0.144.1)".into()),
        ("x-client-request-id".into(), request_id.clone()),
        ("x-codex-beta-features".into(), "memories,remote_compaction_v2".into()),
        ("x-codex-turn-metadata".into(), serde_json::json!({"installation_id": request_id, "session_id": request_id, "thread_id": request_id, "turn_id": request_id, "window_id": request_id}).to_string()),
        ("x-codex-window-id".into(), format!("{request_id}:0")),
    ]);
    headers
}

fn claude_cli_model_test_headers() -> HashMap<String, String> {
    let mut bytes = [0_u8; 16];
    OsRng.fill_bytes(&mut bytes);
    let session_id = URL_SAFE_NO_PAD.encode(bytes);
    HashMap::from([
        ("accept".into(), "application/json".into()),
        ("accept-encoding".into(), "identity".into()),
        ("anthropic-beta".into(), "claude-code-20250219,interleaved-thinking-2025-05-14,mid-conversation-system-2026-04-07,effort-2025-11-24".into()),
        ("anthropic-dangerous-direct-browser-access".into(), "true".into()),
        ("anthropic-version".into(), "2023-06-01".into()),
        ("content-type".into(), "application/json".into()),
        ("user-agent".into(), "claude-cli/2.1.216 (external, cli)".into()),
        ("x-app".into(), "cli".into()),
        ("x-claude-code-session-id".into(), session_id),
        ("x-stainless-arch".into(), "x64".into()),
        ("x-stainless-lang".into(), "js".into()),
        ("x-stainless-os".into(), "Linux".into()),
        ("x-stainless-package-version".into(), "0.94.0".into()),
        ("x-stainless-retry-count".into(), "0".into()),
        ("x-stainless-runtime".into(), "node".into()),
        ("x-stainless-runtime-version".into(), "v26.3.0".into()),
        ("x-stainless-timeout".into(), "600".into()),
    ])
}

fn extract_model_ids(payload: &serde_json::Value) -> Vec<String> {
    let source = if let Some(data) = payload.get("data").and_then(|v| v.as_array()) {
        data.clone()
    } else if let Some(models) = payload.get("models").and_then(|v| v.as_array()) {
        models.clone()
    } else if let Some(arr) = payload.as_array() {
        arr.clone()
    } else {
        return Vec::new();
    };

    let mut seen = std::collections::HashSet::new();
    let mut model_ids = Vec::new();
    for item in source {
        let model_id = if let Some(s) = item.as_str() {
            s.trim().to_string()
        } else if let Some(s) = item.get("id").and_then(|v| v.as_str()) {
            s.trim().to_string()
        } else {
            continue;
        };
        if !model_id.is_empty() && seen.insert(model_id.clone()) {
            model_ids.push(model_id);
        }
    }
    model_ids
}

async fn fetch_models_for_target(
    state: &AppState,
    upstream: Option<(i64, &str)>,
    base_url: &str,
    api_key: Option<&str>,
    extra_headers: &HashMap<String, String>,
    timeout_seconds: f64,
) -> Result<ModelListOut, AppError> {
    validate_overrides(extra_headers)?;
    let target_url = build_url(base_url, "models", "");
    let mut req = state
        .http_client
        .get(&target_url)
        .timeout(std::time::Duration::from_secs_f64(timeout_seconds.max(1.0)));

    let request_headers = build_channel_request_headers(HashMap::new(), api_key, extra_headers);
    for (k, v) in &request_headers {
        req = req.header(k.as_str(), v.as_str());
    }

    let outcome = send_and_log(
        state,
        ConsoleProbe {
            client_type: PROBE_MODEL_LIST,
            method: "GET",
            url: &target_url,
            headers: &request_headers,
            body: None,
            upstream,
            model: None,
        },
        req,
    )
    .await
    .map_err(|e| AppError::UpstreamError(format!("upstream request failed: {e}")))?;

    if !(200..300).contains(&outcome.status) {
        let preview: String = outcome.body.chars().take(300).collect();
        let status = outcome.status;
        return Err(AppError::UpstreamError(format!(
            "upstream returned HTTP {status}: {preview}"
        )));
    }

    let payload: serde_json::Value = serde_json::from_str(&outcome.body)
        .map_err(|_| AppError::UpstreamError("upstream did not return JSON".into()))?;

    let models = extract_model_ids(&payload);
    if models.is_empty() {
        return Err(AppError::UpstreamError(
            "upstream response did not contain model ids".into(),
        ));
    }
    Ok(ModelListOut { models })
}

fn parse_extra_headers(s: &str) -> Result<HashMap<String, String>, AppError> {
    serde_json::from_str(s).map_err(|error| {
        AppError::BadRequest(format!("channel Header override JSON is invalid: {error}"))
    })
}

/// Build headers for channel-related admin requests using the same precedence
/// as normal proxy traffic: generated channel credentials first, configured
/// Header overrides last.
fn build_channel_request_headers(
    mut headers: HashMap<String, String>,
    api_key: Option<&str>,
    overrides: &HashMap<String, String>,
) -> HashMap<String, String> {
    if let Some(key) = api_key.filter(|key| !key.is_empty()) {
        headers.insert("authorization".into(), format!("Bearer {key}"));
    }
    // Admin-side probes have no downstream request context. Client Header
    // placeholders are therefore skipped while static overrides still apply.
    apply_header_overrides(&mut headers, overrides, None);
    headers
}

fn build_json_channel_request(
    client: &reqwest::Client,
    url: &str,
    payload: &serde_json::Value,
    timeout: std::time::Duration,
    headers: &HashMap<String, String>,
) -> Result<reqwest::RequestBuilder, AppError> {
    let mut request = client
        .post(url)
        .body(serde_json::to_vec(payload)?)
        .timeout(timeout);
    for (name, value) in headers {
        request = request.header(name, value);
    }
    Ok(request)
}

fn validate_overrides(overrides: &HashMap<String, String>) -> Result<(), AppError> {
    validate_header_overrides(overrides).map_err(AppError::BadRequest)
}

// ── Console probes ───────────────────────────────────────────────────────────

/// `client_type` values for requests the console makes on an operator's behalf.
///
/// These share the column with real downstream clients rather than getting a
/// column of their own: the log page's client filter then picks them up for
/// free. `downstream_token_id` being NULL would also mark them, but that column
/// is cleared when a token is deleted (`ON DELETE SET NULL`), so it cannot be
/// trusted as the marker.
///
/// The log page's filter is a hardcoded list; `tests/console-probe-logging.test.mjs`
/// holds it to this set.
pub(crate) const PROBE_MODEL_TEST: &str = "model-test";
pub(crate) const PROBE_CHANNEL_TEST: &str = "channel-test";
pub(crate) const PROBE_MODEL_LIST: &str = "model-list";
pub(crate) const PROBE_BALANCE: &str = "balance";

/// One outbound request the console makes on an operator's behalf.
struct ConsoleProbe<'a> {
    client_type: &'a str,
    method: &'a str,
    url: &'a str,
    headers: &'a HashMap<String, String>,
    body: Option<&'a serde_json::Value>,
    /// Absent for the channel form's preview, which probes a typed-in base URL
    /// that has no channel row behind it.
    upstream: Option<(i64, &'a str)>,
    /// Only the model test carries one.
    model: Option<&'a str>,
}

struct ProbeOutcome {
    status: u16,
    /// Unredacted, for callers that build their own preview. The copy written
    /// to the log is redacted by `snapshot_response`.
    headers: HashMap<String, String>,
    body: String,
}

/// The path component of a probe URL, for the log's `path` column.
///
/// Falls back to the whole URL when it does not parse — a log row with an odd
/// path beats one with none.
fn probe_log_path(url: &str) -> String {
    reqwest::Url::parse(url)
        .map(|parsed| parsed.path().to_owned())
        .unwrap_or_else(|_| url.to_owned())
}

/// Send a console probe and record it in the request log.
///
/// Transport failures are logged too, with no status code and the error
/// attached. Leaving those out would drop exactly the case most worth having a
/// record of — the channel that could not be reached at all.
async fn send_and_log(
    state: &AppState,
    probe: ConsoleProbe<'_>,
    request: reqwest::RequestBuilder,
) -> Result<ProbeOutcome, reqwest::Error> {
    let log_body_max_bytes = state.runtime_settings.read().await.log_body_max_bytes as usize;
    let request_body = probe.body.and_then(|body| serde_json::to_vec(body).ok());
    let request_snapshot = logging::snapshot_request(
        probe.method,
        probe.url,
        probe.headers,
        request_body.as_deref(),
        log_body_max_bytes,
    );

    let base_entry = logging::LogEntry {
        method: probe.method.to_owned(),
        path: probe_log_path(probe.url),
        client_type: Some(probe.client_type.to_owned()),
        upstream_id: probe.upstream.map(|(id, _)| id),
        upstream_name: probe.upstream.map(|(_, name)| name.to_owned()),
        model: probe.model.map(str::to_owned),
        request_model: probe.model.map(str::to_owned),
        upstream_model: probe.model.map(str::to_owned),
        downstream_request: Some(request_snapshot.clone()),
        upstream_request: Some(request_snapshot),
        ..Default::default()
    };

    let started = std::time::Instant::now();
    let response = match request.send().await {
        Ok(response) => response,
        Err(error) => {
            logging::schedule_log(
                &state.log_writer,
                logging::LogEntry {
                    duration_ms: Some(started.elapsed().as_millis() as i32),
                    error: Some(error.to_string()),
                    ..base_entry
                },
            );
            return Err(error);
        }
    };

    let status = response.status().as_u16();
    let headers: HashMap<String, String> = response
        .headers()
        .iter()
        .map(|(name, value)| {
            (
                name.to_string(),
                value.to_str().unwrap_or("[binary]").to_owned(),
            )
        })
        .collect();
    let content_type = headers.get("content-type").cloned().unwrap_or_default();

    let body = match response.text().await {
        Ok(body) => body,
        Err(error) => {
            logging::schedule_log(
                &state.log_writer,
                logging::LogEntry {
                    status_code: Some(status as i32),
                    duration_ms: Some(started.elapsed().as_millis() as i32),
                    error: Some(error.to_string()),
                    ..base_entry
                },
            );
            return Err(error);
        }
    };

    // Only an inference probe can have token usage. Running the extractor over
    // a model list or a billing payload could read unrelated numbers as usage,
    // and these rows count toward the dashboard's token totals.
    let usage = match probe.model {
        Some(_) => extract_usage(body.as_bytes(), &content_type),
        None => Default::default(),
    };
    let response_snapshot =
        logging::snapshot_response(status, &headers, Some(body.as_bytes()), log_body_max_bytes);

    logging::schedule_log(
        &state.log_writer,
        logging::LogEntry {
            status_code: Some(status as i32),
            duration_ms: Some(started.elapsed().as_millis() as i32),
            prompt_tokens: usage.prompt_tokens,
            completion_tokens: usage.completion_tokens,
            total_tokens: usage.total_tokens,
            prompt_cached_tokens: usage.prompt_cached_tokens,
            cache_creation_tokens: usage.cache_creation_tokens,
            completion_reasoning_tokens: usage.completion_reasoning_tokens,
            upstream_response: Some(response_snapshot.clone()),
            downstream_response: Some(response_snapshot),
            ..base_entry
        },
    );

    Ok(ProbeOutcome {
        status,
        headers,
        body,
    })
}

fn json_number(value: Option<&serde_json::Value>) -> Option<f64> {
    match value? {
        serde_json::Value::Number(number) => number.as_f64(),
        serde_json::Value::String(text) => text.trim().parse::<f64>().ok(),
        _ => None,
    }
}

fn json_number_at(payload: &serde_json::Value, pointers: &[&str]) -> Option<f64> {
    pointers
        .iter()
        .find_map(|pointer| json_number(payload.pointer(pointer)))
}

fn json_string_at(payload: &serde_json::Value, pointers: &[&str]) -> Option<String> {
    pointers.iter().find_map(|pointer| {
        payload
            .pointer(pointer)
            .and_then(serde_json::Value::as_str)
            .map(str::trim)
            .filter(|text| !text.is_empty())
            .map(str::to_owned)
    })
}

fn parse_sub2api_balance_payload(payload: &serde_json::Value) -> Option<serde_json::Value> {
    let remaining_usd = json_number_at(
        payload,
        &[
            "/remaining",
            "/balance",
            "/quota/remaining",
            "/quota/balance",
        ],
    );
    let used_usd = json_number_at(
        payload,
        &[
            "/usage/total/actual_cost",
            "/usage/total/cost",
            "/total_actual_cost",
            "/total_cost",
            "/used",
            "/usage",
        ],
    );
    let total_usd = json_number_at(payload, &["/total", "/quota/total", "/limit"]);
    let unit = json_string_at(payload, &["/unit", "/quota/unit"]).unwrap_or_else(|| "USD".into());
    let plan_name = json_string_at(payload, &["/planName", "/plan_name", "/plan"]);
    let is_valid = payload
        .get("isValid")
        .or_else(|| payload.get("is_active"))
        .and_then(serde_json::Value::as_bool);
    let mode = json_string_at(payload, &["/mode"]);

    if remaining_usd.is_none() && used_usd.is_none() && total_usd.is_none() {
        return None;
    }

    Some(serde_json::json!({
        "ok": true,
        "provider": "sub2api",
        "total_usd": total_usd,
        "used_usd": used_usd,
        "remaining_usd": remaining_usd,
        "unit": unit,
        "plan_name": plan_name,
        "is_valid": is_valid,
        "mode": mode,
    }))
}

fn redact_header_preview(headers: &HashMap<String, String>) -> HashMap<String, String> {
    headers
        .iter()
        .map(|(name, value)| {
            let sensitive = is_sensitive_header_name(name);
            (
                name.clone(),
                if sensitive {
                    "[redacted]".into()
                } else {
                    value.clone()
                },
            )
        })
        .collect()
}

// ── Upstreams ────────────────────────────────────────────────────────────────

pub async fn admin_list_upstreams(
    State(state): State<AppState>,
    _auth: AdminAuth,
) -> Result<Json<Vec<crate::models::upstream::UpstreamOut>>, AppError> {
    let mut items = upstream_db::list_upstreams(&state.db).await?;
    let runtime_settings = state.runtime_settings.read().await.clone();
    let policy = AutoWeightPolicy::from(&runtime_settings);
    for item in &mut items {
        apply_runtime_health(&state, policy, item);
    }
    Ok(Json(items))
}

pub async fn admin_get_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<Json<UpstreamDetailOut>, AppError> {
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;

    let runtime_settings = state.runtime_settings.read().await.clone();
    let health = state.auto_weight.snapshot(
        row.id,
        row.weight,
        row.auto_weight_enabled == 1,
        AutoWeightPolicy::from(&runtime_settings),
    );
    let model_names: Vec<String> = serde_json::from_str(&row.model_names).unwrap_or_default();
    let model_prefixes: Vec<String> = serde_json::from_str(&row.model_prefixes).unwrap_or_default();
    let model_mappings: HashMap<String, String> =
        serde_json::from_str(&row.model_mappings).unwrap_or_default();
    let extra_headers = parse_extra_headers(&row.extra_headers)?;
    validate_overrides(&extra_headers)?;

    Ok(Json(UpstreamDetailOut {
        id: row.id,
        name: row.name,
        base_url: row.base_url,
        api_key: row.api_key.clone(),
        api_key_set: row.api_key.is_some(),
        model_names,
        model_prefixes,
        model_mappings,
        priority: row.priority,
        weight: row.weight,
        auto_weight_enabled: row.auto_weight_enabled == 1,
        enabled: row.enabled == 1,
        extra_headers,
        timeout_seconds: row.timeout_seconds,
        created_at: row.created_at,
        updated_at: row.updated_at,
        runtime_health_score: health.score,
        effective_weight: health.effective_weight,
        health_recovery_remaining_seconds: health.recovery_remaining_seconds,
    }))
}

pub async fn admin_create_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Json(input): Json<UpstreamIn>,
) -> Result<Response, AppError> {
    input
        .validate()
        .map_err(|error| AppError::BadRequest(error.into()))?;
    validate_overrides(&input.extra_headers)?;
    match upstream_db::create_upstream(
        &state.db,
        &input,
        state.settings.upstream.default_timeout_seconds,
    )
    .await
    {
        Ok(mut out) => {
            state.models_list_cache.invalidate().await;
            state.routing_cache.invalidate().await;
            let runtime_settings = state.runtime_settings.read().await.clone();
            apply_runtime_health(&state, AutoWeightPolicy::from(&runtime_settings), &mut out);
            Ok((StatusCode::CREATED, Json(out)).into_response())
        }
        Err(AppError::Database(e)) if e.to_string().contains("UNIQUE") => {
            Err(AppError::BadRequest("upstream name already exists".into()))
        }
        Err(e) => Err(e),
    }
}

pub async fn admin_update_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(input): Json<UpstreamUpdate>,
) -> Result<Json<crate::models::upstream::UpstreamOut>, AppError> {
    input
        .base
        .validate()
        .map_err(|error| AppError::BadRequest(error.into()))?;
    validate_overrides(&input.base.extra_headers)?;
    let Some(existing) = upstream_db::get_upstream(&state.db, id).await? else {
        return Err(AppError::NotFound("upstream not found".into()));
    };
    let mut out = upstream_db::update_upstream(
        &state.db,
        id,
        &input,
        state.settings.upstream.default_timeout_seconds,
    )
    .await?;
    state.models_list_cache.invalidate().await;
    state.routing_cache.invalidate().await;
    if existing.auto_weight_enabled != i64::from(input.base.auto_weight_enabled)
        || (existing.enabled == 0 && input.base.enabled)
    {
        state.auto_weight.reset(id);
    }
    let runtime_settings = state.runtime_settings.read().await.clone();
    apply_runtime_health(&state, AutoWeightPolicy::from(&runtime_settings), &mut out);
    Ok(Json(out))
}

pub async fn admin_set_upstream_enabled(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(body): Json<UpstreamEnabledIn>,
) -> Result<Json<crate::models::upstream::UpstreamOut>, AppError> {
    if upstream_db::get_upstream(&state.db, id).await?.is_none() {
        return Err(AppError::NotFound("upstream not found".into()));
    }
    let mut out = upstream_db::set_upstream_enabled(&state.db, id, body.enabled).await?;
    state.models_list_cache.invalidate().await;
    state.routing_cache.invalidate().await;
    if body.enabled {
        state.auto_weight.reset(id);
    }
    let runtime_settings = state.runtime_settings.read().await.clone();
    apply_runtime_health(&state, AutoWeightPolicy::from(&runtime_settings), &mut out);
    Ok(Json(out))
}

pub async fn admin_set_upstream_priority(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(body): Json<UpstreamPriorityIn>,
) -> Result<Json<crate::models::upstream::UpstreamOut>, AppError> {
    if upstream_db::get_upstream(&state.db, id).await?.is_none() {
        return Err(AppError::NotFound("upstream not found".into()));
    }
    let mut out = upstream_db::set_upstream_priority(&state.db, id, body.priority).await?;
    state.models_list_cache.invalidate().await;
    state.routing_cache.invalidate().await;
    let runtime_settings = state.runtime_settings.read().await.clone();
    apply_runtime_health(&state, AutoWeightPolicy::from(&runtime_settings), &mut out);
    Ok(Json(out))
}

pub async fn admin_delete_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<StatusCode, AppError> {
    let deleted = upstream_db::delete_upstream(&state.db, id).await?;
    if deleted {
        state.models_list_cache.invalidate().await;
        state.routing_cache.invalidate().await;
        state.auto_weight.reset(id);
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::NotFound("upstream not found".into()))
    }
}

pub async fn admin_test_upstream(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(data): Json<TestRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;

    let target_path = if data.path.starts_with("/v1/") {
        data.path.trim_start_matches("/v1/").to_string()
    } else {
        data.path.trim_start_matches('/').to_string()
    };
    let target_url = build_url(&row.base_url, &target_path, "");

    let mut req = state
        .http_client
        .get(&target_url)
        .timeout(std::time::Duration::from_secs_f64(
            row.timeout_seconds.max(1.0),
        ));

    let overrides = parse_extra_headers(&row.extra_headers)?;
    validate_overrides(&overrides)?;
    let request_headers =
        build_channel_request_headers(HashMap::new(), row.api_key.as_deref(), &overrides);
    for (k, v) in &request_headers {
        req = req.header(k.as_str(), v.as_str());
    }

    match send_and_log(
        &state,
        ConsoleProbe {
            client_type: PROBE_CHANNEL_TEST,
            method: "GET",
            url: &target_url,
            headers: &request_headers,
            body: None,
            upstream: Some((row.id, row.name.as_str())),
            model: None,
        },
        req,
    )
    .await
    {
        Ok(outcome) => {
            let preview: String = outcome.body.chars().take(1000).collect();
            Ok(Json(serde_json::json!({
                "ok": outcome.status < 400,
                "status_code": outcome.status,
                "content_type": outcome.headers.get("content-type"),
                "preview": preview,
            })))
        }
        Err(e) => Ok(Json(serde_json::json!({
            "ok": false,
            "status_code": null,
            "message": e.to_string(),
        }))),
    }
}

pub async fn admin_test_upstream_model(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
    Json(data): Json<ModelTestRequest>,
) -> Result<Json<serde_json::Value>, AppError> {
    data.validate()
        .map_err(|message| AppError::BadRequest(message.into()))?;
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;
    let template = settings_db::list_model_test_templates(&state.db)
        .await?
        .into_iter()
        .find(|item| item.id == data.wrapper_id)
        .ok_or_else(|| AppError::NotFound("model test wrapper not found".into()))?;
    let prompt_template = settings_db::list_model_test_prompt_templates(&state.db)
        .await?
        .into_iter()
        .find(|item| item.id == data.prompt_template_id)
        .ok_or_else(|| AppError::NotFound("model test prompt template not found".into()))?;
    let prompt = if data.prompt.trim().is_empty() {
        prompt_template.prompt
    } else {
        data.prompt.trim().to_owned()
    };
    let target_path = match template.request_kind.as_str() {
        "responses" => "responses",
        "chat_completions" => "chat/completions",
        "messages" => "messages",
        _ => {
            return Err(AppError::BadRequest(
                "unsupported template request kind".into(),
            ))
        }
    };
    // Claude Code CLI appends this query parameter on every /v1/messages call.
    let target_query = if template.request_kind == "messages" {
        "beta=true"
    } else {
        ""
    };
    let target_url = build_url(&row.base_url, target_path, target_query);
    let payload = match template.request_kind.as_str() {
        "responses" => serde_json::json!({
            "model": data.model.trim(),
            "input": prompt,
            "max_output_tokens": 1000,
        }),
        "chat_completions" => serde_json::json!({
            "model": data.model.trim(),
            "messages": [{ "role": "user", "content": prompt }],
            "max_tokens": 1000,
        }),
        "messages" => serde_json::json!({
            "model": data.model.trim(),
            "max_tokens": 1000,
            "messages": [{ "role": "user", "content": prompt }],
        }),
        _ => unreachable!(),
    };
    let default_headers = if template.name == "codex-tui" {
        codex_model_test_headers()
    } else if template.name == "claude-cli" {
        claude_cli_model_test_headers()
    } else {
        HashMap::from([("content-type".into(), "application/json".into())])
    };
    let overrides = parse_extra_headers(&row.extra_headers)?;
    validate_overrides(&overrides)?;
    let request_headers =
        build_channel_request_headers(default_headers, row.api_key.as_deref(), &overrides);
    // Use an explicit body instead of RequestBuilder::json(). The latter adds
    // Content-Type before our loop, and RequestBuilder::header() would append a
    // configured override instead of replacing that implicit value.
    let req = build_json_channel_request(
        &state.http_client,
        &target_url,
        &payload,
        std::time::Duration::from_secs_f64(row.timeout_seconds.max(1.0)),
        &request_headers,
    )?;
    let request_headers_preview = redact_header_preview(&request_headers);
    match send_and_log(
        &state,
        ConsoleProbe {
            client_type: PROBE_MODEL_TEST,
            method: "POST",
            url: &target_url,
            headers: &request_headers,
            body: Some(&payload),
            upstream: Some((row.id, row.name.as_str())),
            model: Some(data.model.trim()),
        },
        req,
    )
    .await
    {
        Ok(outcome) => {
            let content_type = outcome.headers.get("content-type").cloned();
            let response_headers: HashMap<String, String> = outcome
                .headers
                .iter()
                .map(|(name, value)| {
                    let sensitive =
                        matches!(name.as_str(), "set-cookie" | "authorization" | "x-api-key");
                    let shown = if sensitive {
                        "[redacted]".to_owned()
                    } else {
                        value.clone()
                    };
                    (name.clone(), shown)
                })
                .collect();
            let reply = serde_json::from_str::<serde_json::Value>(&outcome.body)
                .ok()
                .and_then(|payload| extract_model_test_reply(&payload));
            let preview: String = outcome.body.chars().take(10_000).collect();
            Ok(Json(serde_json::json!({
                "ok": outcome.status < 400,
                "status_code": outcome.status,
                "content_type": content_type,
                "response_headers": response_headers,
                "prompt": prompt,
                "request": { "url": target_url, "headers": request_headers_preview, "body": payload },
                "reply": reply,
                "preview": preview,
            })))
        }
        Err(error) => Ok(Json(serde_json::json!({
            "ok": false,
            "status_code": null,
            "message": error.to_string(),
        }))),
    }
}

pub async fn admin_fetch_upstream_models(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<Json<ModelListOut>, AppError> {
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;
    let extra = parse_extra_headers(&row.extra_headers)?;
    let out = fetch_models_for_target(
        &state,
        Some((row.id, row.name.as_str())),
        &row.base_url,
        row.api_key.as_deref(),
        &extra,
        row.timeout_seconds,
    )
    .await?;
    Ok(Json(out))
}

pub async fn admin_fetch_models_preview(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Json(data): Json<ModelFetchIn>,
) -> Result<Json<ModelListOut>, AppError> {
    let empty = HashMap::new();
    let extra = data.extra_headers.as_ref().unwrap_or(&empty);
    validate_overrides(extra)?;
    let timeout = data
        .timeout_seconds
        .unwrap_or(state.settings.upstream.default_timeout_seconds);
    // The channel form's preview probes a typed-in base URL, so there is no
    // channel row to attribute the log row to.
    let out = fetch_models_for_target(
        &state,
        None,
        &data.base_url,
        data.api_key.as_deref(),
        extra,
        timeout,
    )
    .await?;
    Ok(Json(out))
}

pub async fn admin_fetch_upstream_balance(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;

    let extra = parse_extra_headers(&row.extra_headers)?;
    validate_overrides(&extra)?;
    let timeout = std::time::Duration::from_secs_f64(row.timeout_seconds.max(1.0));
    let subscription_url = build_url(&row.base_url, "dashboard/billing/subscription", "");
    let usage_url = build_url(
        &row.base_url,
        "dashboard/billing/usage",
        "start_date=2020-01-01&end_date=2099-12-31",
    );

    let request_headers =
        build_channel_request_headers(HashMap::new(), row.api_key.as_deref(), &extra);
    let mut sub_req = state.http_client.get(&subscription_url).timeout(timeout);
    for (k, v) in &request_headers {
        sub_req = sub_req.header(k.as_str(), v.as_str());
    }

    let sub_outcome = match send_and_log(
        &state,
        ConsoleProbe {
            client_type: PROBE_BALANCE,
            method: "GET",
            url: &subscription_url,
            headers: &request_headers,
            body: None,
            upstream: Some((row.id, row.name.as_str())),
            model: None,
        },
        sub_req,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(e) => {
            return Ok(Json(serde_json::json!({
                "ok": false,
                "message": format!("请求失败: {e}")
            })));
        }
    };

    if sub_outcome.status != 200 {
        return Ok(Json(serde_json::json!({
            "ok": false,
            "message": format!("渠道返回 HTTP {}", sub_outcome.status)
        })));
    }

    let sub_payload: serde_json::Value = match serde_json::from_str(&sub_outcome.body) {
        Ok(v) => v,
        Err(_) => {
            return Ok(Json(serde_json::json!({
                "ok": false,
                "message": "渠道未返回 JSON"
            })));
        }
    };

    let mut used_usd: Option<f64> = None;
    let mut usage_req = state.http_client.get(&usage_url).timeout(timeout);
    for (k, v) in &request_headers {
        usage_req = usage_req.header(k.as_str(), v.as_str());
    }
    let usage_outcome = send_and_log(
        &state,
        ConsoleProbe {
            client_type: PROBE_BALANCE,
            method: "GET",
            url: &usage_url,
            headers: &request_headers,
            body: None,
            upstream: Some((row.id, row.name.as_str())),
            model: None,
        },
        usage_req,
    )
    .await;
    if let Ok(usage_outcome) = usage_outcome {
        if usage_outcome.status == 200 {
            if let Ok(usage_payload) =
                serde_json::from_str::<serde_json::Value>(&usage_outcome.body)
            {
                if let Some(total_usage) = usage_payload.get("total_usage").and_then(|v| v.as_f64())
                {
                    used_usd = Some(total_usage / 100.0);
                }
            }
        }
    }

    let mut total_usd: Option<f64> = None;
    if let Some(obj) = sub_payload.as_object() {
        for key in ["hard_limit_usd", "system_hard_limit_usd", "soft_limit_usd"] {
            if let Some(v) = obj.get(key).and_then(|v| v.as_f64()) {
                total_usd = Some(v);
                break;
            }
        }
    }

    let mut remaining_usd: Option<f64> = None;
    if let (Some(total), Some(used)) = (total_usd, used_usd) {
        remaining_usd = Some(total - used);
    } else if let Some(obj) = sub_payload.as_object() {
        for key in ["total_available", "remain_quota", "remaining", "balance"] {
            if let Some(v) = obj.get(key).and_then(|v| v.as_f64()) {
                remaining_usd = Some(v);
                break;
            }
        }
    }

    if total_usd.is_none() && remaining_usd.is_none() {
        return Ok(Json(serde_json::json!({
            "ok": false,
            "message": "无法从响应中识别余额字段"
        })));
    }

    Ok(Json(serde_json::json!({
        "ok": true,
        "provider": "new-api",
        "total_usd": total_usd,
        "used_usd": used_usd,
        "remaining_usd": remaining_usd,
    })))
}

pub async fn admin_fetch_upstream_sub2api_balance(
    State(state): State<AppState>,
    _auth: AdminAuth,
    Path(id): Path<i64>,
) -> Result<Json<serde_json::Value>, AppError> {
    let row = upstream_db::get_upstream(&state.db, id)
        .await?
        .ok_or_else(|| AppError::NotFound("upstream not found".into()))?;

    let extra = parse_extra_headers(&row.extra_headers)?;
    validate_overrides(&extra)?;
    let timeout = std::time::Duration::from_secs_f64(row.timeout_seconds.max(1.0));
    let usage_url = build_url(&row.base_url, "usage", "");
    let request_headers =
        build_channel_request_headers(HashMap::new(), row.api_key.as_deref(), &extra);

    let mut request = state.http_client.get(&usage_url).timeout(timeout);
    for (name, value) in &request_headers {
        request = request.header(name.as_str(), value.as_str());
    }

    let outcome = match send_and_log(
        &state,
        ConsoleProbe {
            client_type: PROBE_BALANCE,
            method: "GET",
            url: &usage_url,
            headers: &request_headers,
            body: None,
            upstream: Some((row.id, row.name.as_str())),
            model: None,
        },
        request,
    )
    .await
    {
        Ok(outcome) => outcome,
        Err(error) => {
            return Ok(Json(serde_json::json!({
                "ok": false,
                "provider": "sub2api",
                "message": format!("请求失败: {error}")
            })));
        }
    };

    let status = outcome.status;
    let text = outcome.body;

    if !(200..300).contains(&status) {
        let preview: String = text.chars().take(160).collect();
        return Ok(Json(serde_json::json!({
            "ok": false,
            "provider": "sub2api",
            "message": if preview.is_empty() {
                format!("渠道返回 HTTP {status}")
            } else {
                format!("渠道返回 HTTP {status}: {preview}")
            }
        })));
    }

    let payload: serde_json::Value = match serde_json::from_str(&text) {
        Ok(payload) => payload,
        Err(_) => {
            return Ok(Json(serde_json::json!({
                "ok": false,
                "provider": "sub2api",
                "message": "渠道未返回 JSON"
            })));
        }
    };

    Ok(parse_sub2api_balance_payload(&payload)
        .map(Json)
        .unwrap_or_else(|| {
            Json(serde_json::json!({
                "ok": false,
                "provider": "sub2api",
                "message": "无法从 sub2api 响应中识别余额字段"
            }))
        }))
}

#[cfg(test)]
mod tests {
    use super::{
        build_channel_request_headers, build_json_channel_request, extract_model_test_reply,
        parse_sub2api_balance_payload, probe_log_path, redact_header_preview, send_and_log,
        ConsoleProbe, PROBE_MODEL_TEST,
    };
    use crate::{
        config::Settings,
        models::settings::{AdminCredential, RuntimeSettings},
        proxy::matcher::AutoWeightManager,
        state::{init_db, AdminAuthCache, AppState, RuntimeMetrics},
    };
    use axum::{routing::post, Json, Router};
    use sqlx::sqlite::SqlitePoolOptions;
    use std::collections::HashMap;
    use std::{
        sync::{atomic::AtomicI64, Arc},
        time::{Duration, Instant},
    };
    use tokio::sync::RwLock;

    async fn probe_test_state() -> AppState {
        let db = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        init_db(&db).await.unwrap();

        let runtime_metrics = Arc::new(RuntimeMetrics::new());
        let log_stats = Arc::new(crate::db::log_stats::LogStatsCache::empty());
        let log_writer = crate::proxy::logging::spawn_log_writer(
            db.clone(),
            runtime_metrics.clone(),
            log_stats.clone(),
            Settings::default().logging.log_queue_capacity,
        );
        AppState {
            db,
            http_client: reqwest::Client::new(),
            settings: Settings::default(),
            auto_weight: Arc::new(AutoWeightManager::new()),
            runtime_settings: Arc::new(RwLock::new(RuntimeSettings::default())),
            admin_credential: Arc::new(RwLock::new(AdminCredential {
                credential_hash: "test".into(),
                credential_version: 1,
            })),
            admin_credential_version: Arc::new(AtomicI64::new(1)),
            admin_auth_cache: Arc::new(AdminAuthCache::new()),
            admin_throttle: Arc::new(crate::state::AdminAuthThrottle::new()),
            runtime_metrics,
            log_writer,
            log_stats,
            models_list_cache: Arc::new(crate::state::ModelsListCache::new()),
            routing_cache: Arc::new(crate::proxy::matcher::UpstreamRoutingCache::new()),
            started_at: Instant::now(),
        }
    }

    /// Seed a channel row and return its id.
    ///
    /// `request_logs.upstream_id` is a real foreign key and `init_db` turns
    /// enforcement on, so a probe naming a channel that does not exist would
    /// have its log insert rolled back.
    async fn seed_upstream(db: &sqlx::SqlitePool, name: &str) -> i64 {
        sqlx::query("INSERT INTO upstreams (name, base_url) VALUES (?, 'http://example.invalid')")
            .bind(name)
            .execute(db)
            .await
            .unwrap()
            .last_insert_rowid()
    }

    /// The single logged row, once the batching writer has committed it.
    type LoggedProbe = (
        String,
        Option<String>,
        Option<i64>,
        Option<String>,
        Option<String>,
        Option<i32>,
        Option<i32>,
        Option<i64>,
        Option<String>,
    );

    async fn only_logged_probe(db: &sqlx::SqlitePool) -> LoggedProbe {
        tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let row = sqlx::query_as::<_, LoggedProbe>(
                    r#"SELECT path, client_type, upstream_id, upstream_name, model,
                              status_code, total_tokens, downstream_token_id, error
                       FROM request_logs LIMIT 1"#,
                )
                .fetch_optional(db)
                .await
                .unwrap();
                if let Some(row) = row {
                    break row;
                }
                tokio::task::yield_now().await;
            }
        })
        .await
        .expect("a console probe must reach the request log")
    }

    #[test]
    fn probe_path_falls_back_to_the_whole_url_when_it_does_not_parse() {
        assert_eq!(
            probe_log_path("https://api.example.com/v1/chat/completions?beta=true"),
            "/v1/chat/completions"
        );
        assert_eq!(probe_log_path("not a url"), "not a url");
    }

    #[tokio::test]
    async fn a_console_probe_reaches_the_request_log_with_its_token_usage() {
        let upstream = Router::new().route(
            "/v1/chat/completions",
            post(|| async {
                Json(serde_json::json!({
                    "choices": [{"message": {"role": "assistant", "content": "hi"}}],
                    "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        let state = probe_test_state().await;
        let upstream_id = seed_upstream(&state.db, "probe channel").await;
        let url = format!("http://{address}/v1/chat/completions");
        let payload = serde_json::json!({"model": "probe-model", "messages": []});
        let headers = HashMap::from([("content-type".to_string(), "application/json".to_string())]);
        let request = state.http_client.post(&url).body(payload.to_string());

        let outcome = send_and_log(
            &state,
            ConsoleProbe {
                client_type: PROBE_MODEL_TEST,
                method: "POST",
                url: &url,
                headers: &headers,
                body: Some(&payload),
                upstream: Some((upstream_id, "probe channel")),
                model: Some("probe-model"),
            },
            request,
        )
        .await
        .unwrap();
        assert_eq!(outcome.status, 200);

        let (
            path,
            client_type,
            upstream_id_logged,
            upstream_name,
            model,
            status,
            tokens,
            token_id,
            error,
        ) = only_logged_probe(&state.db).await;
        assert_eq!(path, "/v1/chat/completions");
        assert_eq!(client_type.as_deref(), Some("model-test"));
        assert_eq!(upstream_name.as_deref(), Some("probe channel"));
        assert_eq!(model.as_deref(), Some("probe-model"));
        assert_eq!(status, Some(200));
        assert_eq!(tokens, Some(18));
        assert_eq!(upstream_id_logged, Some(upstream_id));
        // A console probe has no downstream caller of its own.
        assert_eq!(token_id, None);
        assert_eq!(error, None);

        server.abort();
    }

    #[tokio::test]
    async fn a_non_inference_probe_records_no_token_usage() {
        // Some channels answer every path with the same JSON. A billing or
        // model-list reply that happens to carry a usage block must not land in
        // the token totals, so usage is only read for probes that name a model.
        let upstream = Router::new().route(
            "/v1/dashboard/billing/usage",
            post(|| async {
                Json(serde_json::json!({
                    "usage": {"prompt_tokens": 11, "completion_tokens": 7, "total_tokens": 18},
                }))
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let server = tokio::spawn(async move { axum::serve(listener, upstream).await.unwrap() });

        let state = probe_test_state().await;
        let upstream_id = seed_upstream(&state.db, "billing").await;
        let url = format!("http://{address}/v1/dashboard/billing/usage");
        let headers = HashMap::new();

        send_and_log(
            &state,
            ConsoleProbe {
                client_type: super::PROBE_BALANCE,
                method: "POST",
                url: &url,
                headers: &headers,
                body: None,
                upstream: Some((upstream_id, "billing")),
                model: None,
            },
            state.http_client.post(&url),
        )
        .await
        .unwrap();

        let (_, client_type, _, _, _, status, tokens, _, _) = only_logged_probe(&state.db).await;
        assert_eq!(client_type.as_deref(), Some("balance"));
        assert_eq!(status, Some(200));
        assert_eq!(tokens, None, "a non-inference probe must record no usage");

        server.abort();
    }

    #[tokio::test]
    async fn an_unreachable_channel_still_leaves_a_log_row() {
        let state = probe_test_state().await;
        let upstream_id = seed_upstream(&state.db, "unreachable").await;
        // Port 1 on loopback refuses connections, so the send fails outright.
        let url = "http://127.0.0.1:1/v1/models".to_string();
        let headers = HashMap::new();
        let request = state
            .http_client
            .get(&url)
            .timeout(Duration::from_millis(500));

        let sent = send_and_log(
            &state,
            ConsoleProbe {
                client_type: PROBE_MODEL_TEST,
                method: "GET",
                url: &url,
                headers: &headers,
                body: None,
                upstream: Some((upstream_id, "unreachable")),
                model: None,
            },
            request,
        )
        .await;
        assert!(sent.is_err(), "the probe must surface the transport error");

        let (path, client_type, upstream_id_logged, _, _, status, _, _, error) =
            only_logged_probe(&state.db).await;
        assert_eq!(path, "/v1/models");
        assert_eq!(client_type.as_deref(), Some("model-test"));
        assert_eq!(upstream_id_logged, Some(upstream_id));
        // The case most worth a record: no response at all, but still a row.
        assert_eq!(status, None);
        assert!(error.is_some_and(|message| !message.is_empty()));
    }

    #[test]
    fn extracts_reply_from_anthropic_messages_response() {
        let payload = serde_json::json!({
            "id": "msg_1",
            "type": "message",
            "role": "assistant",
            "content": [
                {"type": "text", "text": "第一段"},
                {"type": "text", "text": "第二段"}
            ],
            "model": "claude-sonnet-5",
            "stop_reason": "end_turn"
        });

        assert_eq!(
            extract_model_test_reply(&payload).as_deref(),
            Some("第一段\n第二段")
        );
    }

    #[test]
    fn admin_channel_requests_apply_overrides_after_api_key_and_defaults() {
        let defaults = HashMap::from([
            ("content-type".into(), "application/json".into()),
            ("user-agent".into(), "default-agent".into()),
        ]);
        let overrides = HashMap::from([
            ("AUTHORIZATION".into(), "Token overridden".into()),
            ("User-Agent".into(), "channel-agent".into()),
            ("X-Client-Agent".into(), "{client_header:User-Agent}".into()),
        ]);

        let headers = build_channel_request_headers(defaults, Some("channel-api-key"), &overrides);

        assert_eq!(headers["authorization"], "Token overridden");
        assert_eq!(headers["user-agent"], "channel-agent");
        assert_eq!(headers["content-type"], "application/json");
        assert!(!headers.contains_key("x-client-agent"));
        assert_eq!(
            headers
                .keys()
                .filter(|name| name.eq_ignore_ascii_case("authorization"))
                .count(),
            1
        );
    }

    #[test]
    fn admin_header_preview_redacts_case_insensitive_credentials() {
        let headers = HashMap::from([
            ("AUTHORIZATION".into(), "secret-auth".into()),
            ("api-key".into(), "secret-api-key".into()),
            ("X-API-Key".into(), "secret-key".into()),
            ("X-Custom-Token".into(), "secret-token".into()),
            ("x-trace-id".into(), "trace-123".into()),
        ]);

        let preview = redact_header_preview(&headers);

        assert_eq!(preview["AUTHORIZATION"], "[redacted]");
        assert_eq!(preview["api-key"], "[redacted]");
        assert_eq!(preview["X-API-Key"], "[redacted]");
        assert_eq!(preview["X-Custom-Token"], "[redacted]");
        assert_eq!(preview["x-trace-id"], "trace-123");
    }

    #[test]
    fn sub2api_balance_parser_reads_usage_payload() {
        let payload = serde_json::json!({
            "balance": 2924.537349,
            "remaining": "2924.537349",
            "unit": "USD",
            "planName": "钱包余额",
            "isValid": true,
            "mode": "unrestricted",
            "usage": {
                "total": {
                    "actual_cost": 17.462651,
                    "cost": 34.925302
                }
            }
        });

        let parsed = parse_sub2api_balance_payload(&payload).unwrap();

        assert_eq!(parsed["ok"], true);
        assert_eq!(parsed["provider"], "sub2api");
        assert_eq!(parsed["remaining_usd"], 2924.537349);
        assert_eq!(parsed["used_usd"], 17.462651);
        assert_eq!(parsed["unit"], "USD");
        assert_eq!(parsed["plan_name"], "钱包余额");
        assert_eq!(parsed["is_valid"], true);
    }

    #[test]
    fn sub2api_balance_parser_rejects_unrecognized_payload() {
        let payload = serde_json::json!({
            "data": [],
            "object": "list"
        });

        assert!(parse_sub2api_balance_payload(&payload).is_none());
    }

    #[test]
    fn model_test_request_has_one_overridden_content_type() {
        let headers = HashMap::from([("content-type".into(), "application/custom+json".into())]);
        let request = build_json_channel_request(
            &reqwest::Client::new(),
            "https://example.test/v1/responses",
            &serde_json::json!({"model": "test"}),
            std::time::Duration::from_secs(1),
            &headers,
        )
        .unwrap()
        .build()
        .unwrap();

        let values: Vec<_> = request
            .headers()
            .get_all(reqwest::header::CONTENT_TYPE)
            .iter()
            .collect();
        assert_eq!(values.len(), 1);
        assert_eq!(values[0], "application/custom+json");
    }
}
