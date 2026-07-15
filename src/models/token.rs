use serde::{Deserialize, Serialize};

pub const API_TOKEN_NAME_MAX_CHARS: usize = 80;
pub const API_TOKEN_DESCRIPTION_MAX_CHARS: usize = 200;
pub const API_TOKEN_MIN_BYTES: usize = 16;
pub const API_TOKEN_MAX_BYTES: usize = 256;

// ── DB row ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ApiTokenRow {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub token_preview: String,
    pub enabled: i64, // 0 / 1
    pub created_at: String,
    pub updated_at: String,
}

// ── Input models ─────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiTokenIn {
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// If None, a token will be auto-generated.
    pub token: Option<String>,
    #[serde(default = "default_enabled")]
    pub enabled: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiTokenUpdateIn {
    pub name: String,
    #[serde(default)]
    pub description: String,
}

fn default_enabled() -> bool {
    true
}

fn validate_metadata(name: &str, description: &str) -> Result<(), &'static str> {
    if name.trim().is_empty() || name.chars().count() > API_TOKEN_NAME_MAX_CHARS {
        return Err("token name must be between 1 and 80 characters");
    }
    if name.chars().any(char::is_control) {
        return Err("token name must not contain control characters");
    }
    if description.chars().count() > API_TOKEN_DESCRIPTION_MAX_CHARS {
        return Err("token description must be at most 200 characters");
    }
    if description.chars().any(char::is_control) {
        return Err("token description must not contain control characters");
    }
    Ok(())
}

impl ApiTokenIn {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_metadata(&self.name, &self.description)?;
        let Some(token) = self.token.as_deref() else {
            return Ok(());
        };
        if !(API_TOKEN_MIN_BYTES..=API_TOKEN_MAX_BYTES).contains(&token.len()) {
            return Err("custom token must be between 16 and 256 bytes");
        }
        if !token.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err("custom token must contain only printable ASCII characters without spaces");
        }
        Ok(())
    }
}

impl ApiTokenUpdateIn {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_metadata(&self.name, &self.description)
    }
}

// ── Output models ───────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ApiTokenOut {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub token_preview: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

/// Returned only by the creation endpoint so the full token can be shown once.
#[derive(Debug, Clone, Serialize)]
pub struct ApiTokenCreatedOut {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub token: String,
    pub token_preview: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
}

#[cfg(test)]
mod tests {
    use super::{ApiTokenIn, ApiTokenOut, ApiTokenUpdateIn};

    fn valid_create_input() -> ApiTokenIn {
        ApiTokenIn {
            name: "client A".into(),
            description: "integration token".into(),
            token: Some("custom-token-value-1234".into()),
            enabled: true,
        }
    }

    #[test]
    fn validates_custom_token_and_metadata_boundaries() {
        assert!(valid_create_input().validate().is_ok());

        for token in ["", "too-short", "contains whitespace"] {
            let mut input = valid_create_input();
            input.token = Some(token.into());
            assert!(input.validate().is_err(), "{token:?} must be rejected");
        }

        let mut input = valid_create_input();
        input.name = "   ".into();
        assert!(input.validate().is_err());

        let mut input = valid_create_input();
        input.description = "x".repeat(201);
        assert!(input.validate().is_err());

        let update = ApiTokenUpdateIn {
            name: "valid".into(),
            description: "line\nbreak".into(),
        };
        assert!(update.validate().is_err());
    }

    #[test]
    fn regular_output_never_serializes_a_full_token() {
        let value = serde_json::to_value(ApiTokenOut {
            id: 1,
            name: "client".into(),
            description: String::new(),
            token_preview: "wildtoke…".into(),
            enabled: true,
            created_at: "2026-01-01 00:00:00".into(),
            updated_at: "2026-01-01 00:00:00".into(),
        })
        .unwrap();

        assert!(value.get("token").is_none());
        assert_eq!(value["token_preview"], "wildtoke…");
    }
}
