use serde::{Deserialize, Serialize};
use std::collections::HashMap;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogOut {
    pub id: i64,
    pub created_at: String,
    pub method: String,
    pub path: String,
    pub downstream_token_id: Option<i64>,
    pub downstream_token_name: Option<String>,
    pub client_type: String,
    pub upstream_id: Option<i64>,
    pub upstream_name: Option<String>,
    pub model: Option<String>,
    pub request_model: Option<String>,
    pub upstream_model: Option<String>,
    pub reasoning_effort: Option<String>,
    pub response_reasoning_effort: Option<String>,
    pub stream: i32,
    pub status_code: Option<i32>,
    pub prompt_tokens: Option<i32>,
    pub completion_tokens: Option<i32>,
    pub total_tokens: Option<i32>,
    pub prompt_cached_tokens: Option<i32>,
    pub cache_creation_tokens: Option<i32>,
    pub completion_reasoning_tokens: Option<i32>,
    pub duration_ms: Option<i32>,
    pub first_token_ms: Option<i32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogDetailOut {
    #[serde(flatten)]
    pub base: RequestLogOut,
    pub downstream_request: Option<serde_json::Value>,
    pub upstream_request: Option<serde_json::Value>,
    pub upstream_response: Option<serde_json::Value>,
    pub downstream_response: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogCursorOut {
    pub created_at: String,
    pub id: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogPage {
    pub items: Vec<RequestLogOut>,
    pub has_more: bool,
    pub recent_rpm: i64,
    pub recent_tpm: i64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub next_cursor: Option<RequestLogCursorOut>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsageWindowOut {
    pub total_tokens: i64,
    /// Total input/prompt tokens in the window.
    pub prompt_tokens: i64,
    /// Cache-hit/read input tokens in the window. Cache creation/write tokens are not hits.
    pub prompt_cached_tokens: i64,
    /// Requests with a recorded token total, retained for the token usage card hint.
    pub request_count: i64,
    /// Every request log in the window, including errors and responses without usage.
    pub all_request_count: i64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TokenUsageStatsOut {
    pub today: TokenUsageWindowOut,
    pub one_day: TokenUsageWindowOut,
    pub seven_days: TokenUsageWindowOut,
    pub thirty_days: TokenUsageWindowOut,
    pub all_time: TokenUsageWindowOut,
    /// Range the caller asked for. Absent on the multi-window response so older
    /// clients see exactly the payload they saw before.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range: Option<String>,
    /// Human-readable label for `range`, so the console does not maintain its
    /// own copy of the window wording.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub range_label: Option<String>,
}

// ── Dashboard time range ──────────────────────────────────────────────────────

/// Widest custom range the dashboard will aggregate in one query.
pub const DASHBOARD_MAX_CUSTOM_RANGE_DAYS: i64 = 366;

/// One dashboard time selection, parsed and validated from query parameters.
///
/// Every branch here must be handled by the token-usage and top-ranking
/// queries; adding a variant without wiring it up is what left the presets
/// silently returning the multi-window payload.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DashboardRange {
    /// Side-by-side comparison of every preset window.
    AllWindows,
    Today,
    OneDay,
    ThreeDays,
    SevenDays,
    ThirtyDays,
    AllTime,
    Custom {
        start: chrono::NaiveDate,
        end: chrono::NaiveDate,
    },
}

impl DashboardRange {
    /// Parse `range` plus the optional custom bounds.
    ///
    /// Errors are user-facing Chinese strings; callers map them to 400.
    pub fn from_query(
        range: Option<&str>,
        start_date: Option<&str>,
        end_date: Option<&str>,
    ) -> Result<Self, String> {
        let range = range.map(str::trim).filter(|value| !value.is_empty());
        match range.unwrap_or("default") {
            "default" => Ok(Self::AllWindows),
            "today" => Ok(Self::Today),
            "1d" => Ok(Self::OneDay),
            "3d" => Ok(Self::ThreeDays),
            "7d" => Ok(Self::SevenDays),
            "30d" => Ok(Self::ThirtyDays),
            "all" => Ok(Self::AllTime),
            "custom" => {
                let start = parse_range_date(start_date, "开始日期")?;
                let end = parse_range_date(end_date, "结束日期")?;
                if start > end {
                    return Err("开始日期不能晚于结束日期".into());
                }
                let span = (end - start).num_days() + 1;
                if span > DASHBOARD_MAX_CUSTOM_RANGE_DAYS {
                    return Err(format!(
                        "自定义区间最长 {DASHBOARD_MAX_CUSTOM_RANGE_DAYS} 天，当前 {span} 天"
                    ));
                }
                Ok(Self::Custom { start, end })
            }
            other => Err(format!("不支持的时间范围：{other}")),
        }
    }

    /// Value echoed back to the client, matching the accepted query values.
    pub fn as_query_value(self) -> &'static str {
        match self {
            Self::AllWindows => "default",
            Self::Today => "today",
            Self::OneDay => "1d",
            Self::ThreeDays => "3d",
            Self::SevenDays => "7d",
            Self::ThirtyDays => "30d",
            Self::AllTime => "all",
            Self::Custom { .. } => "custom",
        }
    }

    pub fn label(self) -> String {
        match self {
            Self::AllWindows => "所有窗口".into(),
            Self::Today => "今天".into(),
            Self::OneDay => "最近 24 小时".into(),
            Self::ThreeDays => "最近 3 天".into(),
            Self::SevenDays => "最近 7 天".into(),
            Self::ThirtyDays => "最近 30 天".into(),
            Self::AllTime => "全部时间".into(),
            Self::Custom { start, end } => format!("{start} 至 {end}"),
        }
    }

    /// True when the response should carry one aggregated window rather than
    /// the preset comparison set.
    pub fn is_single_window(self) -> bool {
        !matches!(self, Self::AllWindows)
    }
}

fn parse_range_date(value: Option<&str>, field: &str) -> Result<chrono::NaiveDate, String> {
    let value = value
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("自定义区间需要{field}"))?;
    chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
        .map_err(|_| format!("{field}格式应为 YYYY-MM-DD，实际为 {value}"))
}

#[cfg(test)]
mod dashboard_range_tests {
    use super::{DashboardRange, DASHBOARD_MAX_CUSTOM_RANGE_DAYS};

    fn parse(
        range: &str,
        start: Option<&str>,
        end: Option<&str>,
    ) -> Result<DashboardRange, String> {
        DashboardRange::from_query(Some(range), start, end)
    }

    #[test]
    fn every_preset_maps_to_its_own_variant() {
        // A preset that silently falls through to AllWindows is exactly the bug
        // this table guards: all four used to return the same payload.
        let cases = [
            ("default", DashboardRange::AllWindows),
            ("today", DashboardRange::Today),
            ("1d", DashboardRange::OneDay),
            ("3d", DashboardRange::ThreeDays),
            ("7d", DashboardRange::SevenDays),
            ("30d", DashboardRange::ThirtyDays),
            ("all", DashboardRange::AllTime),
        ];
        for (value, expected) in cases {
            assert_eq!(parse(value, None, None).unwrap(), expected, "{value}");
            assert_eq!(expected.as_query_value(), value);
            assert!(!expected.label().is_empty(), "{value} needs a label");
        }
        assert!(!DashboardRange::AllWindows.is_single_window());
        assert!(DashboardRange::Today.is_single_window());
    }

    #[test]
    fn a_missing_range_is_the_multi_window_comparison() {
        assert_eq!(
            DashboardRange::from_query(None, None, None).unwrap(),
            DashboardRange::AllWindows
        );
        assert_eq!(
            DashboardRange::from_query(Some("  "), None, None).unwrap(),
            DashboardRange::AllWindows
        );
    }

    #[test]
    fn an_unknown_range_is_rejected_instead_of_silently_defaulting() {
        let error = parse("last-century", None, None).unwrap_err();
        assert!(error.contains("last-century"), "{error}");
    }

    #[test]
    fn a_custom_range_keeps_inclusive_bounds() {
        let parsed = parse("custom", Some("2026-08-01"), Some("2026-08-10")).unwrap();
        let DashboardRange::Custom { start, end } = parsed else {
            panic!("expected a custom range, got {parsed:?}");
        };
        assert_eq!(start.to_string(), "2026-08-01");
        assert_eq!(end.to_string(), "2026-08-10");
        assert_eq!(parsed.label(), "2026-08-01 至 2026-08-10");

        // A single day must stay valid: start == end means that whole day.
        assert!(parse("custom", Some("2026-08-01"), Some("2026-08-01")).is_ok());
    }

    #[test]
    fn a_custom_range_rejects_missing_reversed_and_malformed_dates() {
        // Each of these silently returned zero before validation existed.
        assert!(parse("custom", None, Some("2026-08-10"))
            .unwrap_err()
            .contains("开始日期"));
        assert!(parse("custom", Some("2026-08-01"), None)
            .unwrap_err()
            .contains("结束日期"));
        assert!(parse("custom", Some("2026-08-10"), Some("2026-08-01"))
            .unwrap_err()
            .contains("不能晚于"));
        assert!(parse("custom", Some("not-a-date"), Some("2026-08-01"))
            .unwrap_err()
            .contains("YYYY-MM-DD"));
        assert!(parse("custom", Some("2026-08-01"), Some("whatever"))
            .unwrap_err()
            .contains("YYYY-MM-DD"));
        // Guards against a month/day swap sneaking through as valid.
        assert!(parse("custom", Some("2026-13-01"), Some("2026-13-02")).is_err());
    }

    #[test]
    fn a_custom_range_is_capped_to_bound_the_scan() {
        let ok = parse("custom", Some("2026-01-01"), Some("2026-12-31")).unwrap();
        assert!(matches!(ok, DashboardRange::Custom { .. }), "366 days fits");

        let error = parse("custom", Some("2025-01-01"), Some("2026-12-31")).unwrap_err();
        assert!(
            error.contains(&DASHBOARD_MAX_CUSTOM_RANGE_DAYS.to_string()),
            "{error}"
        );
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogTopItemOut {
    pub name: String,
    pub count: i64,
    /// Present for channel rankings grouped by `upstream_id`.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub id: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RequestLogTopStatsOut {
    pub window: String,
    /// Model ranking by request count. Kept as `models` for API compatibility.
    pub models: Vec<RequestLogTopItemOut>,
    /// Channel ranking by request count. Kept as `channels` for API compatibility.
    pub channels: Vec<RequestLogTopItemOut>,
    pub model_tokens: Vec<RequestLogTopItemOut>,
    pub channel_tokens: Vec<RequestLogTopItemOut>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TestRequest {
    #[serde(default = "default_path")]
    pub path: String,
}

fn default_path() -> String {
    "/v1/models".into()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelListOut {
    pub models: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ModelFetchIn {
    pub base_url: String,

    #[serde(default)]
    pub api_key: Option<String>,

    #[serde(default)]
    pub extra_headers: Option<HashMap<String, String>>,

    #[serde(default)]
    pub timeout_seconds: Option<f64>,
}
