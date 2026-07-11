use axum::{
    body::Body,
    extract::State,
    http::{HeaderMap, HeaderName, HeaderValue, Request, StatusCode},
    response::Response,
};
use serde_json::json;

use crate::error::AppError;
use crate::middleware::auth::DownstreamAuth;
use crate::proxy::{client, matcher};
use crate::state::AppState;

const HOP_BY_HOP_RESPONSE_HEADERS: &[&str] = &[
    "connection",
    "keep-alive",
    "transfer-encoding",
    "te",
    "trailer",
    "upgrade",
    "proxy-authenticate",
    "proxy-authorization",
    "content-encoding",
    "content-length",
];

fn parse_model_from_body(body: &[u8]) -> Option<String> {
    serde_json::from_slice::<serde_json::Value>(body)
        .ok()
        .and_then(|v| {
            v.get("model")
                .and_then(|m| m.as_str())
                .map(|s| s.to_string())
                .filter(|s| !s.is_empty())
        })
}

fn get_upstream_selector(headers: &HeaderMap, query: Option<&str>) -> Option<String> {
    if let Some(val) = headers
        .get("x-wildtoken-upstream")
        .and_then(|v| v.to_str().ok())
        .map(str::trim)
        .filter(|s| !s.is_empty())
    {
        return Some(val.to_string());
    }

    query.and_then(|q| {
        q.split('&').find_map(|pair| {
            let mut parts = pair.splitn(2, '=');
            let key = parts.next()?;
            let val = parts.next().unwrap_or("");
            if key == "upstream" && !val.is_empty() {
                Some(val.to_string())
            } else {
                None
            }
        })
    })
}

fn openai_error_response(status: StatusCode, message: &str, error_type: &str) -> Response {
    let body = json!({
        "error": {
            "message": message,
            "type": error_type,
            "code": null
        }
    });
    Response::builder()
        .status(status)
        .header("content-type", "application/json")
        .body(Body::from(body.to_string()))
        .unwrap_or_else(|_| {
            Response::builder()
                .status(StatusCode::INTERNAL_SERVER_ERROR)
                .body(Body::from("internal error"))
                .unwrap()
        })
}

/// Main proxy handler – forwards OpenAI-compatible requests to upstream providers.
pub async fn proxy_handler(
    State(state): State<AppState>,
    _auth: DownstreamAuth,
    req: Request<Body>,
) -> Result<Response, AppError> {
    let method = req.method().to_string();
    let headers = req.headers().clone();
    let uri = req.uri().clone();

    // Path after /v1/ — e.g. "chat/completions"
    let full_path = uri.path();
    let path = full_path
        .strip_prefix("/v1/")
        .or_else(|| full_path.strip_prefix("/v1"))
        .unwrap_or(full_path)
        .trim_start_matches('/');
    let query = uri.query();

    let body_bytes = axum::body::to_bytes(req.into_body(), 50 * 1024 * 1024)
        .await
        .map_err(|e| AppError::BadRequest(format!("failed to read body: {e}")))?;

    let model = parse_model_from_body(&body_bytes);
    let selector = get_upstream_selector(&headers, query);

    let selected = matcher::select_upstream(
        &state.db,
        &state.backoff,
        selector.as_deref(),
        model.as_deref(),
    )
    .await?;

    let Some((upstream, forward_model)) = selected else {
        return Ok(openai_error_response(
            StatusCode::SERVICE_UNAVAILABLE,
            "No enabled upstream is configured",
            "upstream_not_configured",
        ));
    };

    let (status, resp_headers, body) = client::proxy_request(
        &state,
        &state.backoff,
        &upstream,
        forward_model.as_deref(),
        &method,
        path,
        query,
        &headers,
        &body_bytes,
    )
    .await?;

    let mut response = Response::new(Body::from(body));
    *response.status_mut() = status;

    for (name, value) in &resp_headers {
        let name_lower = name.to_lowercase();
        if HOP_BY_HOP_RESPONSE_HEADERS.contains(&name_lower.as_str()) {
            continue;
        }
        if let (Ok(hname), Ok(hval)) = (
            HeaderName::from_bytes(name.as_bytes()),
            HeaderValue::from_str(value),
        ) {
            response.headers_mut().insert(hname, hval);
        }
    }

    Ok(response)
}
