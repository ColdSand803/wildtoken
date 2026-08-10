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
	CreatedAt         string
	UpdatedAt         string
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
	return nil
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
	CreatedAt                      string            `json:"created_at"`
	UpdatedAt                      string            `json:"updated_at"`
	RuntimeHealthScore             int64             `json:"runtime_health_score"`
	EffectiveWeight                float64           `json:"effective_weight"`
	HealthRecoveryRemainingSeconds *int64            `json:"health_recovery_remaining_seconds,omitempty"`
	GroupIDs                       []int64           `json:"group_ids"`
}
