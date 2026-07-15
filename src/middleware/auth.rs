use axum::{
    extract::FromRequestParts,
    http::{request::Parts, StatusCode},
    response::{IntoResponse, Response},
    Json,
};

use crate::{db::token as token_db, state::AppState};

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
    let originator = parts
        .headers
        .get("originator")
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();
    let user_agent = parts
        .headers
        .get(axum::http::header::USER_AGENT)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("")
        .to_ascii_lowercase();

    if originator.contains("codex desktop") {
        "codex-desktop".into()
    } else if originator.contains("codex-tui") {
        "codex-tui".into()
    } else if user_agent.contains("codex desktop") {
        "codex-desktop".into()
    } else if user_agent.contains("codex-tui") {
        "codex-tui".into()
    } else if user_agent.contains("opencode") {
        "opencode".into()
    } else if originator.contains("codex") || user_agent.contains("codex") {
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

fn extract_downstream_token(parts: &Parts, anthropic: bool) -> Option<&str> {
    let bearer_token = parts
        .headers
        .get(axum::http::header::AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            let (scheme, credentials) = value.split_once(' ')?;
            if !scheme.eq_ignore_ascii_case("bearer") {
                return None;
            }
            let token = credentials.trim();
            (!token.is_empty()).then_some(token)
        });
    if bearer_token.is_some() {
        return bearer_token;
    }
    if !anthropic {
        return None;
    }
    parts
        .headers
        .get("x-api-key")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|token| !token.is_empty())
}

async fn lookup_enabled_downstream_token(
    pool: &sqlx::SqlitePool,
    token: &str,
) -> Result<Option<(i64, String)>, sqlx::Error> {
    if token.is_empty() {
        return Ok(None);
    }
    sqlx::query_as("SELECT id, name FROM api_tokens WHERE token_hash = ? AND enabled = 1")
        .bind(token_db::token_digest(token))
        .fetch_optional(pool)
        .await
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
        let token = extract_downstream_token(parts, anthropic)
            .ok_or(DownstreamAuthRejection {
                anthropic,
                status: StatusCode::UNAUTHORIZED,
                message: "Incorrect API key provided",
            })?
            .to_owned();

        let row = lookup_enabled_downstream_token(&state.db, &token)
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

#[cfg(test)]
mod tests {
    use axum::http::Request;
    use sqlx::sqlite::SqlitePoolOptions;

    use super::{detect_client_type, extract_downstream_token, lookup_enabled_downstream_token};

    fn request_parts(headers: &[(&str, &str)]) -> axum::http::request::Parts {
        let mut request = Request::builder().uri("/v1/responses");
        for (name, value) in headers {
            request = request.header(*name, *value);
        }
        request.body(()).unwrap().into_parts().0
    }

    #[test]
    fn distinguishes_codex_tui_and_desktop_with_originator_precedence() {
        let tui = request_parts(&[
            ("originator", "codex-tui"),
            ("user-agent", "Codex Desktop/0.144.2"),
        ]);
        assert_eq!(detect_client_type(&tui, false), "codex-tui");

        let desktop = request_parts(&[
            ("originator", "Codex Desktop"),
            ("user-agent", "codex-tui/0.144.3"),
        ]);
        assert_eq!(detect_client_type(&desktop, false), "codex-desktop");
    }

    #[test]
    fn falls_back_to_user_agent_and_preserves_other_client_types() {
        for (user_agent, expected) in [
            ("codex-tui/0.144.3", "codex-tui"),
            ("Codex Desktop/0.144.2", "codex-desktop"),
            ("codex-cli/0.1", "codex"),
            ("opencode/1.0", "opencode"),
            ("claude-cli/1.0", "claude"),
        ] {
            let parts = request_parts(&[("user-agent", user_agent)]);
            assert_eq!(detect_client_type(&parts, false), expected);
        }

        assert_eq!(detect_client_type(&request_parts(&[]), true), "claude");
        assert_eq!(detect_client_type(&request_parts(&[]), false), "unknown");
    }

    #[test]
    fn missing_or_empty_credentials_are_rejected_before_lookup() {
        assert!(extract_downstream_token(&request_parts(&[]), false).is_none());
        assert!(
            extract_downstream_token(&request_parts(&[("authorization", "Bearer")]), false)
                .is_none()
        );
        assert!(extract_downstream_token(&request_parts(&[("x-api-key", "")]), true).is_none());
        assert_eq!(
            extract_downstream_token(
                &request_parts(&[("authorization", "bEaReR valid-token-value")]),
                false
            ),
            Some("valid-token-value")
        );
    }

    #[tokio::test]
    async fn legacy_plaintext_token_migrates_and_still_authenticates() {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect("sqlite::memory:")
            .await
            .unwrap();
        sqlx::query(
            r#"CREATE TABLE api_tokens (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                name TEXT NOT NULL UNIQUE,
                description TEXT NOT NULL DEFAULT '',
                token TEXT NOT NULL UNIQUE,
                enabled INTEGER NOT NULL DEFAULT 1,
                created_at TEXT NOT NULL DEFAULT (datetime('now')),
                updated_at TEXT NOT NULL DEFAULT (datetime('now'))
            )"#,
        )
        .execute(&pool)
        .await
        .unwrap();
        sqlx::query("INSERT INTO api_tokens (name, token) VALUES ('legacy', ?)")
            .bind("legacy-downstream-token")
            .execute(&pool)
            .await
            .unwrap();

        crate::state::init_db(&pool).await.unwrap();

        let authenticated = lookup_enabled_downstream_token(&pool, "legacy-downstream-token")
            .await
            .unwrap();
        assert_eq!(authenticated.map(|(_, name)| name), Some("legacy".into()));

        let empty_hash = crate::db::token::token_digest("");
        sqlx::query(
            "INSERT INTO api_tokens (name, token, token_hash, token_preview) VALUES ('empty', ?, ?, '…')",
        )
        .bind(&empty_hash)
        .bind(&empty_hash)
        .execute(&pool)
        .await
        .unwrap();
        assert!(lookup_enabled_downstream_token(&pool, "")
            .await
            .unwrap()
            .is_none());
    }
}
