use axum::{
    extract::FromRequestParts,
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use crate::state::AppState;

// ── AdminAuth ────────────────────────────────────────────────────────────────

/// Extractor that verifies the `x-admin-token` header against the current
/// Argon2id credential snapshot. All authentication failures are deliberately
/// indistinguishable to callers.
pub struct AdminAuth {
    /// Version of the credential snapshot this request authenticated against.
    /// Handlers that mutate the credential use this as their CAS precondition.
    pub credential_version: i64,
}

fn unauthorized() -> (StatusCode, Json<serde_json::Value>) {
    (
        StatusCode::UNAUTHORIZED,
        Json(serde_json::json!({"error": "unauthorized"})),
    )
}

impl FromRequestParts<AppState> for AdminAuth {
    type Rejection = (StatusCode, Json<serde_json::Value>);

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let token = match parts
            .headers
            .get("x-admin-token")
            .and_then(|v| v.to_str().ok())
        {
            Some(token) if !token.is_empty() => token.to_owned(),
            _ => return Err(unauthorized()),
        };

        let credential_version = state
            .authenticate_admin_token(token)
            .await
            .ok_or_else(unauthorized)?;

        Ok(AdminAuth { credential_version })
    }
}

// ── DownstreamAuth ───────────────────────────────────────────────────────────

/// Extractor that validates the `Authorization: Bearer <token>` header against
/// the `api_tokens` table (enabled tokens only).
///
/// Returns an OpenAI-compatible error body on failure.
pub struct DownstreamAuth {
    pub token_id: i64,
    pub token_name: String,
    pub client_type: String,
}

pub struct DownstreamAuthRejection {
    anthropic: bool,
    status: StatusCode,
    message: &'static str,
}

fn detect_client_type(parts: &Parts, anthropic: bool) -> String {
    let user_agent = parts
        .headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if user_agent.contains("opencode") {
        "opencode".into()
    } else if user_agent.contains("codex") {
        "codex".into()
    } else if anthropic
        || user_agent.contains("claude")
        || parts.headers.contains_key("anthropic-version")
    {
        "claude".into()
    } else {
        "unknown".into()
    }
}

impl IntoResponse for DownstreamAuthRejection {
    fn into_response(self) -> Response {
        if self.anthropic {
            (
                self.status,
                Json(serde_json::json!({
                    "type": "error",
                    "error": {"type": "authentication_error", "message": self.message}
                })),
            )
                .into_response()
        } else {
            (
                self.status,
                Json(serde_json::json!({
                    "error": {
                        "message": self.message,
                        "type": "invalid_api_key",
                        "code": "invalid_api_key"
                    }
                })),
            )
                .into_response()
        }
    }
}

impl FromRequestParts<AppState> for DownstreamAuth {
    type Rejection = DownstreamAuthRejection;

    async fn from_request_parts(
        parts: &mut Parts,
        state: &AppState,
    ) -> Result<Self, Self::Rejection> {
        let anthropic = parts.uri.path().trim_end_matches('/') == "/v1/messages";
        let auth_header = parts
            .headers
            .get(axum::http::header::AUTHORIZATION)
            .and_then(|v| v.to_str().ok())
            .unwrap_or("");

        let bearer_token = if auth_header.to_lowercase().starts_with("bearer ") {
            auth_header[7..].trim()
        } else {
            ""
        };
        let token = if !bearer_token.is_empty() {
            bearer_token
        } else if anthropic {
            parts
                .headers
                .get("x-api-key")
                .and_then(|v| v.to_str().ok())
                .unwrap_or("")
                .trim()
        } else {
            ""
        };

        let row: Option<(i64, String)> =
            sqlx::query_as("SELECT id, name FROM api_tokens WHERE token = ? AND enabled = 1")
                .bind(token)
                .fetch_optional(&state.db)
                .await
                .map_err(|_| DownstreamAuthRejection {
                    anthropic,
                    status: StatusCode::INTERNAL_SERVER_ERROR,
                    message: "database error",
                })?;

        if row.is_none() {
            return Err(DownstreamAuthRejection {
                anthropic,
                status: StatusCode::UNAUTHORIZED,
                message: "Incorrect API key provided",
            });
        }

        let (token_id, token_name) = row.expect("validated token row must be present");
        Ok(DownstreamAuth {
            token_id,
            token_name,
            client_type: detect_client_type(parts, anthropic),
        })
    }
}
