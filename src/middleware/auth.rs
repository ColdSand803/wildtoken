use axum::{
    extract::FromRequestParts,
    http::{request::Parts, StatusCode},
    Json,
};

use crate::state::AppState;

// ── AdminAuth ────────────────────────────────────────────────────────────────

/// Extractor that validates the `x-admin-token` request header against
/// `state.settings.admin.token`.
pub struct AdminAuth;

impl FromRequestParts<AppState> for AdminAuth {
    type Rejection = (StatusCode, Json<serde_json::Value>);

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let token = parts
            .headers
            .get("x-admin-token")
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        if token != state.settings.admin.token {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({"detail": "invalid admin token"})),
            ));
        }

        Ok(AdminAuth)
    }
}

// ── DownstreamAuth ───────────────────────────────────────────────────────────

/// Extractor that validates the `Authorization: Bearer <token>` header against
/// the `api_tokens` table (enabled tokens only).
///
/// Returns an OpenAI-compatible error body on failure.
pub struct DownstreamAuth;

impl FromRequestParts<AppState> for DownstreamAuth {
    type Rejection = (StatusCode, Json<serde_json::Value>);

    async fn from_request_parts(parts: &mut Parts, state: &AppState) -> Result<Self, Self::Rejection> {
        let auth_header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        let token = if auth_header.to_lowercase().starts_with("bearer ") {
            auth_header[7..].trim()
        } else {
            ""
        };

        let row: Option<(i64,)> = sqlx::query_as(
            "SELECT id FROM api_tokens WHERE token = ? AND enabled = 1",
        )
        .bind(token)
        .fetch_optional(&state.db)
        .await
        .map_err(|_| {
            (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(serde_json::json!({"error": "database error"})),
            )
        })?;

        if row.is_none() {
            return Err((
                StatusCode::UNAUTHORIZED,
                Json(serde_json::json!({
                    "error": {
                        "message": "Incorrect API key provided",
                        "type": "invalid_api_key",
                        "code": "invalid_api_key"
                    }
                })),
            ));
        }

        Ok(DownstreamAuth)
    }
}
