package models

import (
	"net/url"
	"strings"
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

// Validate rejects weights outside the range the schema also enforces, and a
// base URL the gateway could not forward to.
func (u *UpstreamIn) Validate() error {
	if u.Weight < 0 || u.Weight > 10000 {
		return ErrString("weight must be between 0 and 10000")
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

type UpstreamEnabledIn struct {
	Enabled bool `json:"enabled"`
}

type UpstreamPriorityIn struct {
	Priority int32 `json:"priority"`
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

// UpstreamDetailOut adds the decrypted API key for the single-item endpoint.
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
