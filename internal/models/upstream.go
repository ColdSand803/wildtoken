package models

import (
	"net/url"
	"strings"
	"unicode"
	"unicode/utf8"
)

// UpstreamRow mirrors a row of the `upstreams` table.
type UpstreamRow struct {
	ID                int64
	Name              string
	BaseURL           string
	APIKey            *string
	ModelNames        string // JSON array string "[]"
	ModelPrefixes     string // JSON array string "[]"
	ModelMappings     string // JSON object string "{}"
	Priority          int32
	Weight            int64
	AutoWeightEnabled int64 // 0 or 1
	Enabled           int64 // 0 or 1
	ExtraHeaders      string
	TimeoutSeconds    float64
	// RateLimit is the stored rate expression ("100/m"), nil when unlimited.
	RateLimit *string
	CreatedAt string
	UpdatedAt string
}

// UpstreamIn is the create payload for an upstream.
type UpstreamIn struct {
	Name              string            `json:"name"`
	BaseURL           string            `json:"base_url"`
	APIKey            *string           `json:"api_key"`
	ModelNames        []string          `json:"model_names"`
	ModelPrefixes     []string          `json:"model_prefixes"`
	ModelMappings     map[string]string `json:"model_mappings"`
	Priority          int32             `json:"priority"`
	Weight            int64             `json:"weight"`
	AutoWeightEnabled bool              `json:"auto_weight_enabled"`
	Enabled           bool              `json:"enabled"`
	ExtraHeaders      map[string]string `json:"extra_headers"`
	TimeoutSeconds    *float64          `json:"timeout_seconds"`
	RateLimit         *string           `json:"rate_limit"`
	// GroupIDs are the groups this channel serves. An empty selection falls
	// back to the default group, because a channel in no group is unreachable.
	GroupIDs []int64 `json:"group_ids"`
}

// DefaultUpstreamIn supplies the field defaults serde applied when a key is absent.
func DefaultUpstreamIn() UpstreamIn {
	return UpstreamIn{
		ModelNames:        []string{},
		ModelPrefixes:     []string{},
		ModelMappings:     map[string]string{},
		Priority:          100,
		Weight:            100,
		AutoWeightEnabled: true,
		Enabled:           true,
		ExtraHeaders:      map[string]string{},
	}
}

const (
	// UpstreamNameMaxChars bounds a channel name, matching the limit tokens use.
	UpstreamNameMaxChars = 80
	// UpstreamMaxTimeoutSeconds bounds a channel's per-request timeout.
	//
	// The value is multiplied by a second's worth of nanoseconds to make a
	// Duration, so an unchecked one overflows int64 and lands on a negative
	// duration — which fires its timer immediately and fails every request the
	// channel is given, reported as an upstream timeout rather than as the
	// configuration error it is.
	UpstreamMaxTimeoutSeconds = 3600
)

// Validate rejects weights outside the range the schema also enforces, a base
// URL the gateway could not forward to, and a name or timeout the rest of the
// service cannot work with.
func (u *UpstreamIn) Validate() error {
	name := strings.TrimSpace(u.Name)
	if name == "" || utf8.RuneCountInString(name) > UpstreamNameMaxChars {
		return ErrString("channel name must be between 1 and 80 characters")
	}
	if strings.ContainsFunc(name, unicode.IsControl) {
		return ErrString("channel name must not contain control characters")
	}
	u.Name = name

	if u.Weight < 0 || u.Weight > 10000 {
		return ErrString("weight must be between 0 and 10000")
	}
	// A nil timeout means "use the service default"; a stored zero means the
	// same thing to the proxy, so only a positive value is bounded here.
	if u.TimeoutSeconds != nil {
		seconds := *u.TimeoutSeconds
		if seconds < 0 || seconds > UpstreamMaxTimeoutSeconds {
			return ErrString("timeout_seconds must be between 0 and 3600")
		}
	}
	normalized, err := ValidateBaseURL(u.BaseURL)
	if err != nil {
		return err
	}
	u.BaseURL = normalized
	if _, err := u.NormalizedRateLimit(); err != nil {
		return err
	}
	return nil
}

// ValidateBaseURL checks that a channel's base URL is one the proxy can build a
// request from, and returns it trimmed.
//
// Nothing checked this before, so any string at all could be stored and was then
// concatenated into a request URL. That turned an operator's typo into a channel
// that fails at request time with an error about the URL rather than about the
// form, and left the scheme open to values the proxy has no business dialling.
//
// Addresses on the local machine and on private networks are deliberately
// allowed: a self-hosted model server is a first-class use of this gateway, and
// refusing them would break it for the sake of a restriction an operator with
// admin rights could lift anyway.
func ValidateBaseURL(raw string) (string, error) {
	value := strings.TrimSpace(raw)
	if value == "" {
		return "", ErrString("base_url is required")
	}
	if len(value) > 2048 {
		return "", ErrString("base_url must be at most 2048 bytes")
	}

	parsed, err := url.Parse(value)
	if err != nil {
		return "", ErrString("base_url is not a valid URL: " + err.Error())
	}
	if parsed.Scheme != "http" && parsed.Scheme != "https" {
		return "", ErrString("base_url must start with http:// or https://")
	}
	if parsed.Host == "" {
		return "", ErrString("base_url must include a host, for example https://api.example.com/v1")
	}
	// The path is concatenated onto, so a query or fragment here would end up in
	// the middle of the request URL rather than where it was written.
	if parsed.RawQuery != "" || parsed.ForceQuery {
		return "", ErrString("base_url must not carry a query string")
	}
	if parsed.Fragment != "" {
		return "", ErrString("base_url must not carry a fragment")
	}
	return value, nil
}

// NormalizedRateLimit validates the rate limit expression for storage.
func (u *UpstreamIn) NormalizedRateLimit() (*string, error) {
	return NormalizeRateLimit(u.RateLimit)
}

// Normalize replaces nil collections so callers can index them freely.
func (u *UpstreamIn) Normalize() {
	if u.ModelNames == nil {
		u.ModelNames = []string{}
	}
	if u.ModelPrefixes == nil {
		u.ModelPrefixes = []string{}
	}
	if u.ModelMappings == nil {
		u.ModelMappings = map[string]string{}
	}
	if u.ExtraHeaders == nil {
		u.ExtraHeaders = map[string]string{}
	}
	if u.GroupIDs == nil {
		u.GroupIDs = []int64{}
	}
}

// UpstreamUpdate is the replace payload; ClearAPIKey removes a stored key.
type UpstreamUpdate struct {
	UpstreamIn
	ClearAPIKey bool `json:"clear_api_key"`
}

// UpstreamEnabledIn toggles a channel.
//
// The field is a pointer so that "not mentioned" is distinguishable from
// "false". As a plain bool, a body of {} decoded to false and disabled the
// channel — as did a misspelled key — with nothing reported to the caller who
// meant the opposite. Rejecting unknown fields alone does not cover {}, which
// carries no unknown field at all.
type UpstreamEnabledIn struct {
	Enabled *bool `json:"enabled"`
}

// Value returns the requested state, or an error when the body named none.
func (u *UpstreamEnabledIn) Value() (bool, error) {
	if u.Enabled == nil {
		return false, ErrString("enabled is required")
	}
	return *u.Enabled, nil
}

// UpstreamPriorityIn sets a channel's routing priority. The field is a pointer
// for the same reason UpstreamEnabledIn's is.
type UpstreamPriorityIn struct {
	Priority *int32 `json:"priority"`
}

// Value returns the requested priority, or an error when the body named none.
func (u *UpstreamPriorityIn) Value() (int32, error) {
	if u.Priority == nil {
		return 0, ErrString("priority is required")
	}
	return *u.Priority, nil
}

// UpstreamOut is the list representation; the API key is never included.
type UpstreamOut struct {
	ID                             int64             `json:"id"`
	Name                           string            `json:"name"`
	BaseURL                        string            `json:"base_url"`
	APIKeySet                      bool              `json:"api_key_set"`
	ModelNames                     []string          `json:"model_names"`
	ModelPrefixes                  []string          `json:"model_prefixes"`
	ModelMappings                  map[string]string `json:"model_mappings"`
	Priority                       int32             `json:"priority"`
	Weight                         int64             `json:"weight"`
	AutoWeightEnabled              bool              `json:"auto_weight_enabled"`
	Enabled                        bool              `json:"enabled"`
	ExtraHeaders                   map[string]string `json:"extra_headers"`
	TimeoutSeconds                 float64           `json:"timeout_seconds"`
	RateLimit                      *string           `json:"rate_limit"`
	CreatedAt                      string            `json:"created_at"`
	UpdatedAt                      string            `json:"updated_at"`
	RuntimeHealthScore             int64             `json:"runtime_health_score"`
	EffectiveWeight                float64           `json:"effective_weight"`
	HealthRecoveryRemainingSeconds *int64            `json:"health_recovery_remaining_seconds,omitempty"`
	GroupIDs                       []int64           `json:"group_ids"`
}

// ExportUpstreamsRequest is the request payload for /api/admin/upstreams/export.
type ExportUpstreamsRequest struct {
	IDs            []int64 `json:"ids"`
	IncludeAPIKeys bool    `json:"include_api_keys"`
}

// ChannelExportItem is one channel in an export document.
type ChannelExportItem struct {
	Name              string            `json:"name"`
	BaseURL           string            `json:"base_url"`
	APIKey            *string           `json:"api_key,omitempty"`
	ModelNames        []string          `json:"model_names"`
	ModelPrefixes     []string          `json:"model_prefixes"`
	ModelMappings     map[string]string `json:"model_mappings"`
	Priority          int32             `json:"priority"`
	Weight            int64             `json:"weight"`
	AutoWeightEnabled bool              `json:"auto_weight_enabled"`
	Enabled           bool              `json:"enabled"`
	ExtraHeaders      map[string]string `json:"extra_headers"`
	TimeoutSeconds    float64           `json:"timeout_seconds"`
	RateLimit         *string           `json:"rate_limit,omitempty"`
	GroupIDs          []int64           `json:"group_ids"`
}

// ExportUpstreamsResponse is the response envelope for /api/admin/upstreams/export.
type ExportUpstreamsResponse struct {
	Kind       string              `json:"kind"`
	Version    int                 `json:"version"`
	ExportedAt string              `json:"exported_at"`
	Channels   []ChannelExportItem `json:"channels"`
}

// ImportUpstreamsRequest is the request payload for /api/admin/upstreams/import.
type ImportUpstreamsRequest struct {
	Kind     string              `json:"kind"`
	Version  int                 `json:"version"`
	Channels []ChannelExportItem `json:"channels"`
	Mode     string              `json:"mode"` // "skip" or "overwrite"
}

// ImportResultItem represents one channel's import outcome.
type ImportResultItem struct {
	Name    string  `json:"name"`
	Action  string  `json:"action"` // "created", "updated", "skipped", "failed"
	Message *string `json:"message,omitempty"`
}

// ImportUpstreamsResponse is the response body for /api/admin/upstreams/import.
type ImportUpstreamsResponse struct {
	Created int                `json:"created"`
	Updated int                `json:"updated"`
	Skipped int                `json:"skipped"`
	Failed  int                `json:"failed"`
	Items   []ImportResultItem `json:"items"`
}

// UpstreamDetailOut adds the channel's API key for the single-item endpoint,
// which the console's edit form needs in order to save the channel back.
//
// The key is stored as written — nothing in this service encrypts it — so this
// endpoint hands out a credential in the clear to anyone holding the admin
// token.
type UpstreamDetailOut struct {
	ID                             int64             `json:"id"`
	Name                           string            `json:"name"`
	BaseURL                        string            `json:"base_url"`
	APIKey                         *string           `json:"api_key"`
	APIKeySet                      bool              `json:"api_key_set"`
	ModelNames                     []string          `json:"model_names"`
	ModelPrefixes                  []string          `json:"model_prefixes"`
	ModelMappings                  map[string]string `json:"model_mappings"`
	Priority                       int32             `json:"priority"`
	Weight                         int64             `json:"weight"`
	AutoWeightEnabled              bool              `json:"auto_weight_enabled"`
	Enabled                        bool              `json:"enabled"`
	ExtraHeaders                   map[string]string `json:"extra_headers"`
	TimeoutSeconds                 float64           `json:"timeout_seconds"`
	RateLimit                      *string           `json:"rate_limit"`
	CreatedAt                      string            `json:"created_at"`
	UpdatedAt                      string            `json:"updated_at"`
	RuntimeHealthScore             int64             `json:"runtime_health_score"`
	EffectiveWeight                float64           `json:"effective_weight"`
	HealthRecoveryRemainingSeconds *int64            `json:"health_recovery_remaining_seconds,omitempty"`
	GroupIDs                       []int64           `json:"group_ids"`
}

// UpstreamLatencyOut is one channel's routing latency as the console shows it.
//
// This is the figure routing actually used, read from the in-memory tracker
// rather than recomputed from request_logs. The dashboard's latency charts scan
// that table, and a channel card that scanned it too would report a different
// number than the one the decision was made on — which is worse than reporting
// nothing.
type UpstreamLatencyOut struct {
	UpstreamID int64 `json:"upstream_id"`
	// MedianMs is null until the channel has enough fresh samples to be ranked.
	MedianMs *int32 `json:"median_ms"`
	// SampleCount is present even below the minimum, so the console can say
	// "collecting samples (2/5)" instead of "no data".
	SampleCount int `json:"sample_count"`
	// Usable reports whether this reading may rank the channel. False with a
	// non-zero SampleCount is the under-sampled state.
	Usable bool `json:"usable"`
}

// RoutingRulesOut is the strategy and the constants behind it, so the console can
// explain a routing decision without hard-coding the numbers a second time.
//
// These are code constants rather than settings. They are published because an
// operator looking at "no samples" needs to know how many would be enough and
// how long one lasts; they are not published as editable, because nothing in the
// admin API writes them.
type RoutingRulesOut struct {
	MinSamples         int     `json:"min_samples"`
	StaleWindowSeconds int64   `json:"stale_window_seconds"`
	SampleCapacity     int     `json:"sample_capacity"`
	ToleranceRatio     float64 `json:"tolerance_ratio"`
	ToleranceFloorMs   int32   `json:"tolerance_floor_ms"`
}

// UpstreamRoutingOut answers "what is routing doing right now".
type UpstreamRoutingOut struct {
	// Strategy is the effective load-balance strategy. See the LoadBalance*
	// constants.
	Strategy string `json:"strategy"`
	// LatencyActive reports whether Latency figures take part in the decision. It
	// is false under the weighted strategy even though samples are still being
	// collected, so the console does not present a column that changes nothing.
	LatencyActive bool                 `json:"latency_active"`
	Rules         RoutingRulesOut      `json:"rules"`
	Latency       []UpstreamLatencyOut `json:"latency"`
}
