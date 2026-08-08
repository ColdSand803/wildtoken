use chrono::{DateTime, NaiveDateTime, Utc};
use serde::{Deserialize, Serialize};

pub const API_TOKEN_NAME_MAX_CHARS: usize = 80;
pub const API_TOKEN_DESCRIPTION_MAX_CHARS: usize = 200;
/// A custom token is no longer floored at 16 bytes. The console warns and asks
/// for a second confirmation below that, and the threshold lives there
/// (TOKEN_WEAK_BYTES in static/js/tokens.js) rather than here: a stateless
/// request cannot distinguish an operator who was warned and accepted from one
/// who never saw the warning, so enforcing it server-side would either refuse
/// the confirmed case or need a "yes I mean it" flag that any client could set.
/// What is left here is what is structurally invalid — empty, or too long.
pub const API_TOKEN_MIN_BYTES: usize = 1;
pub const API_TOKEN_MAX_BYTES: usize = 256;

/// The shape SQLite's `datetime('now')` produces, and the only shape
/// `expires_at` is ever stored in. Fixed width and zero padded, so lexical
/// order is chronological order — which is what lets the authentication SQL in
/// `middleware::auth` and the checks in `db::token` compare expiries as plain
/// strings and always reach the same verdict.
pub const TIMESTAMP_FORMAT: &str = "%Y-%m-%d %H:%M:%S";

const EXPIRY_FORMAT_ERROR: &str =
    "token expiry must be an RFC 3339 timestamp or 'YYYY-MM-DD HH:MM:SS' in UTC";

/// Now, in the stored timestamp shape, for comparison against an expiry.
pub fn utc_now_timestamp() -> String {
    Utc::now().format(TIMESTAMP_FORMAT).to_string()
}

/// Normalize a caller-supplied expiry into the stored UTC shape.
///
/// A blank value means "never expires" and is reported as `None`, so clearing
/// the console's expiry field behaves the same whether the client sends `null`
/// or `""`. Whether the result lies in the past is not decided here — that
/// depends on the row being written, and lives in `db::token`.
pub fn normalize_expires_at(raw: Option<&str>) -> Result<Option<String>, &'static str> {
    let Some(value) = raw.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let utc = if let Ok(parsed) = DateTime::parse_from_rfc3339(value) {
        parsed.with_timezone(&Utc)
    } else if let Ok(naive) = NaiveDateTime::parse_from_str(value, TIMESTAMP_FORMAT) {
        naive.and_utc()
    } else {
        return Err(EXPIRY_FORMAT_ERROR);
    };
    Ok(Some(utc.format(TIMESTAMP_FORMAT).to_string()))
}

// ── DB row ──────────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, sqlx::FromRow)]
pub struct ApiTokenRow {
    pub id: i64,
    pub name: String,
    pub description: String,
    pub token_preview: String,
    pub enabled: i64, // 0 / 1
    pub expires_at: Option<String>,
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
    /// Absent, null or blank means the token never expires.
    #[serde(default)]
    pub expires_at: Option<String>,
}

/// The update endpoint is a full replacement, so an absent `expires_at` clears
/// the expiry rather than leaving it alone. The console always sends the field.
#[derive(Debug, Clone, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct ApiTokenUpdateIn {
    pub name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default)]
    pub expires_at: Option<String>,
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
        self.normalized_expires_at()?;
        let Some(token) = self.token.as_deref() else {
            return Ok(());
        };
        if !(API_TOKEN_MIN_BYTES..=API_TOKEN_MAX_BYTES).contains(&token.len()) {
            return Err("custom token must be between 1 and 256 bytes");
        }
        if !token.bytes().all(|byte| byte.is_ascii_graphic()) {
            return Err("custom token must contain only printable ASCII characters without spaces");
        }
        Ok(())
    }

    pub fn normalized_expires_at(&self) -> Result<Option<String>, &'static str> {
        normalize_expires_at(self.expires_at.as_deref())
    }
}

impl ApiTokenUpdateIn {
    pub fn validate(&self) -> Result<(), &'static str> {
        validate_metadata(&self.name, &self.description)?;
        self.normalized_expires_at()?;
        Ok(())
    }

    pub fn normalized_expires_at(&self) -> Result<Option<String>, &'static str> {
        normalize_expires_at(self.expires_at.as_deref())
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
    pub expires_at: Option<String>,
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
    pub expires_at: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[cfg(test)]
mod tests {
    use super::{normalize_expires_at, ApiTokenIn, ApiTokenOut, ApiTokenUpdateIn};

    fn valid_create_input() -> ApiTokenIn {
        ApiTokenIn {
            name: "client A".into(),
            description: "integration token".into(),
            token: Some("custom-token-value-1234".into()),
            enabled: true,
            expires_at: None,
        }
    }

    #[test]
    fn validates_custom_token_and_metadata_boundaries() {
        assert!(valid_create_input().validate().is_ok());

        for token in ["", "contains whitespace", &"x".repeat(257)] {
            let mut input = valid_create_input();
            input.token = Some(token.into());
            assert!(input.validate().is_err(), "{token:?} must be rejected");
        }

        // Short custom tokens are accepted here on purpose. The console warns
        // and asks for a second confirmation below 16 bytes; the server cannot
        // tell a warned-and-accepted request from an unwarned one, so it only
        // rejects what is structurally invalid.
        for token in ["x", "too-short"] {
            let mut input = valid_create_input();
            input.token = Some(token.into());
            assert!(input.validate().is_ok(), "{token:?} must be accepted");
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
            expires_at: None,
        };
        assert!(update.validate().is_err());
    }

    #[test]
    fn expiry_normalizes_every_accepted_form_to_stored_utc() {
        // Absent, null and blank all mean the same thing: never expires.
        for raw in [None, Some(""), Some("   ")] {
            assert_eq!(normalize_expires_at(raw), Ok(None));
        }

        // An offset is honored, then converted; a bare timestamp is UTC already.
        for raw in [
            "2026-09-01T12:00:00Z",
            "2026-09-01T20:00:00+08:00",
            "2026-09-01 12:00:00",
        ] {
            assert_eq!(
                normalize_expires_at(Some(raw)),
                Ok(Some("2026-09-01 12:00:00".into())),
                "{raw} must normalize to stored UTC"
            );
        }

        for raw in [
            "2026-09-01",          // no time of day
            "2026-09-01 12:00",    // no seconds
            "01/09/2026 12:00:00", // not ISO order
            "30d",                 // relative expressions are the console's job
            "tomorrow",
        ] {
            assert!(
                normalize_expires_at(Some(raw)).is_err(),
                "{raw} must be rejected"
            );
        }
    }

    #[test]
    fn a_malformed_expiry_fails_validation_on_both_endpoints() {
        let mut input = valid_create_input();
        input.expires_at = Some("not a timestamp".into());
        assert!(input.validate().is_err());

        input.expires_at = Some("2026-09-01T12:00:00Z".into());
        assert!(input.validate().is_ok());

        let update = ApiTokenUpdateIn {
            name: "valid".into(),
            description: String::new(),
            expires_at: Some("not a timestamp".into()),
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
            expires_at: Some("2026-09-01 12:00:00".into()),
            created_at: "2026-01-01 00:00:00".into(),
            updated_at: "2026-01-01 00:00:00".into(),
        })
        .unwrap();

        assert!(value.get("token").is_none());
        assert_eq!(value["token_preview"], "wildtoke…");
    }
}
