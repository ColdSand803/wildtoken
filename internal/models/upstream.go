package models

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

// Validate rejects weights outside the range the schema also enforces.
func (u *UpstreamIn) Validate() error {
	if u.Weight < 0 || u.Weight > 10000 {
		return ErrString("weight must be between 0 and 10000")
	}
	if _, err := u.NormalizedRateLimit(); err != nil {
		return err
	}
	return nil
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
	Action  string  `json:"action"`  // "created", "updated", "skipped", "failed"
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
	Action  string  `json:"action"`  // "created", "updated", "skipped", "failed"
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

