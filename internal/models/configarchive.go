package models

import (
	"strings"
	"unicode/utf8"
)

// A portable configuration archive moves groups, channels, token policies and
// runtime settings between instances.
//
// Everything in here is keyed by name, never by the source instance's numeric ids.
// A channel exported with `group_ids: [3]` is meaningless on an instance whose
// group 3 is something else — it would silently place the channel in the wrong
// group, which is worse than failing, because routing would look configured and
// serve the wrong traffic. Names are the only identity two instances share.
const (
	// ConfigArchiveKind identifies the document. Distinct from the channel-only
	// `wildtoken.channels` export, which stays as it is: a caller pointing one at
	// the other's endpoint gets a refusal instead of a partial import.
	ConfigArchiveKind = "wildtoken.config"
	// ConfigArchiveSchemaVersion is the payload's shape. Bumped when a field's
	// meaning changes; an archive from a newer schema is refused rather than
	// read with fields ignored.
	//
	// 2 dropped the "pricing" scope along with the cost-estimation feature. A
	// version 1 archive is still readable, but a pricing section in one is
	// reported rather than skipped quietly — see ValidateEnvelope.
	ConfigArchiveSchemaVersion = 2
)

// ConfigArchiveSchemaVersionWithPricing is the last schema that carried prices.
// Named rather than written as a bare 1, so the reason that version is the one a
// pricing section can legitimately appear in stays attached to the number.
const ConfigArchiveSchemaVersionWithPricing = 1

// Archive scopes. An export names what it contains, so an import can report what
// it is about to touch rather than the caller having to infer it from which
// arrays are non-empty.
const (
	ConfigScopeGroups   = "groups"
	ConfigScopeChannels = "channels"
	ConfigScopeTokens   = "tokens"
	ConfigScopeSettings = "settings"
)

// ConfigScopePricing is the retired price-table scope.
//
// Kept as a constant so a version-1 archive naming it can be recognised and
// refused with an explanation. Deliberately absent from ConfigScopes, so it is
// never exported, never accepted as a request scope, and never applied.
const ConfigScopePricing = "pricing"

// ConfigScopes is every scope, in the order an import must apply them: groups
// exist before the channels and tokens that name them.
var ConfigScopes = []string{
	ConfigScopeGroups, ConfigScopeChannels, ConfigScopeTokens,
	ConfigScopeSettings,
}

// ValidConfigScope reports whether a name is a scope this service knows.
func ValidConfigScope(name string) bool {
	for _, scope := range ConfigScopes {
		if scope == name {
			return true
		}
	}
	return false
}

// Conflict policies decide what an import does about a name that already exists
// locally.
const (
	// ConfigConflictSkip leaves the existing row alone.
	ConfigConflictSkip = "skip"
	// ConfigConflictOverwrite replaces it with the archive's values.
	ConfigConflictOverwrite = "overwrite"
	// ConfigConflictFail refuses the whole import. Useful for a migration into
	// what is supposed to be a blank instance: anything already there means the
	// target is not what the operator thought.
	ConfigConflictFail = "fail"
)

// ValidConfigConflictPolicy reports whether a value names a policy.
func ValidConfigConflictPolicy(value string) bool {
	switch value {
	case ConfigConflictSkip, ConfigConflictOverwrite, ConfigConflictFail:
		return true
	default:
		return false
	}
}

// ConfigArchiveGroup is one group, identified by name.
type ConfigArchiveGroup struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// ConfigArchiveChannel is one channel.
//
// GroupNames replaces the numeric GroupIDs the channel-only export carries. That
// substitution is the reason this format exists.
type ConfigArchiveChannel struct {
	Name    string `json:"name"`
	BaseURL string `json:"base_url"`
	// APIKey is present only in an archive exported with secrets, which requires a
	// password — so a key is never written to disk in the clear by this endpoint.
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
	GroupNames        []string          `json:"group_names"`
}

// ConfigArchiveToken is one downstream credential's policy.
//
// Usage counters are deliberately absent. They describe what this instance has
// served, not how the credential is configured; carrying them over would either
// double-count a quota or reset one, and neither is something an operator asked a
// configuration migration to do.
type ConfigArchiveToken struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	// Token is the credential itself, present only in an archive with secrets.
	// Without it the import mints a new value, which the preview states outright:
	// a token whose value silently changed breaks every client already using it.
	Token         *string  `json:"token,omitempty"`
	Enabled       bool     `json:"enabled"`
	ExpiresAt     *string  `json:"expires_at,omitempty"`
	GroupName     string   `json:"group_name"`
	LimitTokens   *int64   `json:"limit_tokens,omitempty"`
	RateLimit     *string  `json:"rate_limit,omitempty"`
	AllowedModels []string `json:"allowed_models"`
	QuotaPeriod   string   `json:"quota_period"`
	QuotaTimezone string   `json:"quota_timezone"`
}

// ConfigArchiveSettings is the runtime policy row, without its revision.
//
// The revision is the target instance's compare-and-swap counter, so importing the
// source's value would either be refused as stale or overwrite a concurrent edit.
// The import reads the local revision and applies against that.
type ConfigArchiveSettings struct {
	LogBodyKeepCount                  int64  `json:"log_body_keep_count"`
	LogRetentionDays                  int64  `json:"log_retention_days"`
	LogBodyMaxBytes                   int64  `json:"log_body_max_bytes"`
	MaxRetries                        int64  `json:"max_retries"`
	SameUpstreamRetryIntervalMs       int64  `json:"same_upstream_retry_interval_ms"`
	AutoWeightFailurePenalty          int64  `json:"auto_weight_failure_penalty"`
	AutoWeightSuccessIncrement        int64  `json:"auto_weight_success_increment"`
	AutoWeightRecoveryIncrement       int64  `json:"auto_weight_recovery_increment"`
	AutoWeightRecoveryIntervalSeconds int64  `json:"auto_weight_recovery_interval_seconds"`
	ProxyEnabled                      bool   `json:"proxy_enabled"`
	ProxyURL                          string `json:"proxy_url"`
	LoadBalanceStrategy               string `json:"load_balance_strategy"`
}

// ConfigArchivePayload is the archive's contents — the part that is encrypted
// when a password is given, and the part the checksum covers.
type ConfigArchivePayload struct {
	Groups   []ConfigArchiveGroup   `json:"groups"`
	Channels []ConfigArchiveChannel `json:"channels"`
	Tokens   []ConfigArchiveToken   `json:"tokens"`
	// Settings is a pointer so "not in this archive" is distinguishable from "the
	// zero values". Applying zeroes would fail validation, but only after the
	// operator had been told the import would touch settings.
	Settings *ConfigArchiveSettings `json:"settings,omitempty"`
}

// ConfigArchiveEncryption records how to derive the key and open the box.
//
// The parameters travel with the archive rather than being fixed in code, so an
// archive stays readable after the defaults are raised. What does not travel is
// anything secret: salt and nonce are public inputs, and neither reveals the
// password.
type ConfigArchiveEncryption struct {
	// Algorithm names the AEAD. Only one value is accepted, but it is recorded so
	// a future change is a version negotiation rather than a silent misread.
	Algorithm string `json:"algorithm"`
	KDF       string `json:"kdf"`
	// Salt and Nonce are standard base64. A fresh random salt per archive is what
	// stops one derived key from being reused across archives, and a fresh nonce
	// is required for GCM to be safe at all.
	Salt  string `json:"salt"`
	Nonce string `json:"nonce"`
	// Argon2 cost parameters.
	TimeCost    uint32 `json:"time_cost"`
	MemoryKiB   uint32 `json:"memory_kib"`
	Parallelism uint8  `json:"parallelism"`
	KeyLength   uint32 `json:"key_length"`
	// Ciphertext is the sealed payload, standard base64. The GCM tag is appended
	// by the seal, so a tampered archive fails to open rather than decrypting to
	// something plausible.
	Ciphertext string `json:"ciphertext"`
}

// ConfigArchive is the whole document as it is written and read.
type ConfigArchive struct {
	Kind          string `json:"kind"`
	SchemaVersion int    `json:"schema_version"`
	// AppVersion is the exporting build. Recorded for the operator's benefit and
	// not enforced: refusing an archive from a different patch release would make
	// migration impossible between two instances that are perfectly compatible.
	// SchemaVersion is the field that gates compatibility.
	AppVersion string   `json:"app_version"`
	ExportedAt string   `json:"exported_at"`
	Scopes     []string `json:"scopes"`
	// IncludesSecrets records whether channel keys and token values are inside.
	// The console needs it to warn before an import replaces a working credential,
	// and an import needs it to explain why a token's value will change.
	IncludesSecrets bool `json:"includes_secrets"`
	// Checksum is the SHA-256 of the canonical payload JSON, hex encoded. It is
	// verified before anything is written.
	//
	// For an encrypted archive this is redundant with the AEAD tag, and it is kept
	// anyway: an unencrypted archive has no tag at all, and a checksum that is only
	// present in one of the two cases is one an operator cannot rely on.
	Checksum string `json:"checksum"`
	// Exactly one of Payload and Encryption is present.
	Payload    *ConfigArchivePayload    `json:"payload,omitempty"`
	Encryption *ConfigArchiveEncryption `json:"encryption,omitempty"`
}

// ConfigExportRequest is the export payload.
type ConfigExportRequest struct {
	// Scopes selects what to export. Empty means every scope, which is what a
	// migration wants and what the console's default offers.
	Scopes []string `json:"scopes"`
	// IncludeSecrets carries channel API keys and token values. It requires a
	// password: writing a working credential to a file in the clear is not
	// something to make available by forgetting a field.
	IncludeSecrets bool `json:"include_secrets"`
	// Password enables encryption. Blank means an unencrypted archive, which is
	// only allowed without secrets.
	Password string `json:"password"`
}

// ConfigExportMinPasswordLen floors the password protecting an archive.
//
// The archive is a file that leaves the machine, so a weak password is checked
// offline at whatever rate the attacker's hardware allows — the request throttling
// that protects the admin token does not apply to it.
const ConfigExportMinPasswordLen = 8

func (r *ConfigExportRequest) Validate() error {
	for _, scope := range r.Scopes {
		if !ValidConfigScope(scope) {
			return ErrString("unknown export scope: " + scope)
		}
	}
	password := strings.TrimSpace(r.Password)
	if password != "" {
		if utf8.RuneCountInString(password) < ConfigExportMinPasswordLen {
			return ErrString("password must be at least 8 characters")
		}
		if len(password) > 256 {
			return ErrString("password must be at most 256 bytes")
		}
	}
	if r.IncludeSecrets && password == "" {
		// Refused rather than exported in the clear. An archive with keys in it is
		// as good as the keys themselves, and an operator who forgot the password
		// field would have no indication of that.
		return ErrString("include_secrets requires a password: an archive containing credentials must be encrypted")
	}
	r.Password = password
	return nil
}

// SelectedScopes resolves the requested scopes, with empty meaning all of them.
func (r *ConfigExportRequest) SelectedScopes() []string {
	if len(r.Scopes) == 0 {
		return ConfigScopes
	}
	// Ordered by ConfigScopes rather than by the request, so an import applies
	// groups before the channels naming them regardless of how the caller listed
	// them, and so the recorded scope list is comparable between archives.
	selected := make([]string, 0, len(ConfigScopes))
	for _, scope := range ConfigScopes {
		for _, requested := range r.Scopes {
			if requested == scope {
				selected = append(selected, scope)
				break
			}
		}
	}
	return selected
}

// ConfigImportRequest is the import payload.
type ConfigImportRequest struct {
	Archive  *ConfigArchive `json:"archive"`
	Password string         `json:"password"`
	// OnConflict decides what happens to a name that already exists. Blank means
	// skip, the policy that changes nothing already configured.
	OnConflict string `json:"on_conflict"`
	// DryRun validates and plans without writing. The plan is produced by the same
	// code either way, so a preview cannot describe an outcome the real import
	// would not produce.
	DryRun bool `json:"dry_run"`
	// Scopes narrows what to apply from the archive. Empty means every scope the
	// archive contains.
	Scopes []string `json:"scopes"`
}

func (r *ConfigImportRequest) Validate() error {
	if r.Archive == nil {
		return ErrString("archive is required")
	}
	if strings.TrimSpace(r.OnConflict) == "" {
		r.OnConflict = ConfigConflictSkip
	}
	if !ValidConfigConflictPolicy(r.OnConflict) {
		return ErrString("on_conflict must be skip, overwrite, or fail")
	}
	for _, scope := range r.Scopes {
		if !ValidConfigScope(scope) {
			return ErrString("unknown import scope: " + scope)
		}
	}
	return r.Archive.ValidateEnvelope()
}

// ValidateEnvelope checks the header before any decryption is attempted.
//
// Kept separate from the payload's own validation because these are the checks
// that decide whether the document is even this format — running them first is
// what turns "someone uploaded the wrong file" into a clear refusal instead of a
// password error.
func (a *ConfigArchive) ValidateEnvelope() error {
	if a.Kind != ConfigArchiveKind {
		return ErrString("not a WildToken configuration archive (expected kind " +
			ConfigArchiveKind + ")")
	}
	if a.SchemaVersion < 1 {
		return ErrString("archive schema_version is missing or invalid")
	}
	if a.SchemaVersion > ConfigArchiveSchemaVersion {
		// Refused rather than read with unknown fields dropped. A newer schema may
		// have changed what an existing field means, and importing it as understood
		// would write values that look right and are not.
		return ErrString("archive was written by a newer schema than this build supports")
	}
	if strings.TrimSpace(a.Checksum) == "" {
		return ErrString("archive checksum is missing")
	}
	switch {
	case a.Payload == nil && a.Encryption == nil:
		return ErrString("archive contains neither a payload nor an encrypted body")
	case a.Payload != nil && a.Encryption != nil:
		// Both present is ambiguous: whichever one is read, the other might differ,
		// so there is no answer to what the archive says.
		return ErrString("archive contains both a plain payload and an encrypted body")
	}
	for _, scope := range a.Scopes {
		// Named before the generic unknown-scope refusal, so an archive from a build
		// that still had prices is told what happened to the feature rather than
		// being called malformed. Refused rather than skipped: the archive says it
		// carries prices, and applying the rest while silently dropping them is the
		// case where an operator believes a migration was complete.
		if scope == ConfigScopePricing {
			return ErrString("this archive carries model prices, which this build no " +
				"longer supports; re-export it from the source instance without the " +
				"pricing scope")
		}
		if !ValidConfigScope(scope) {
			return ErrString("archive names an unknown scope: " + scope)
		}
	}
	return nil
}

// Encrypted reports whether the body needs a password.
func (a *ConfigArchive) Encrypted() bool { return a.Encryption != nil }

// ConfigImportItem is one planned or applied change.
type ConfigImportItem struct {
	Scope string `json:"scope"`
	Name  string `json:"name"`
	// Action is create, update, skip, or fail. In a dry run these are what would
	// happen; the planning code is shared, so the words mean the same thing in
	// both responses.
	Action string `json:"action"`
	// Detail explains anything the action alone does not, such as a token whose
	// value will be regenerated because the archive carried no secrets.
	Detail string `json:"detail,omitempty"`
}

// Import item actions.
const (
	ConfigImportCreate = "create"
	ConfigImportUpdate = "update"
	ConfigImportSkip   = "skip"
	ConfigImportFail   = "fail"
)

// ConfigImportResponse reports a plan or an applied import.
type ConfigImportResponse struct {
	DryRun bool `json:"dry_run"`
	// Applied is false for a dry run, and false for a failed import — which is the
	// same thing here, because a validation failure writes nothing at all.
	Applied         bool               `json:"applied"`
	SchemaVersion   int                `json:"schema_version"`
	AppVersion      string             `json:"app_version"`
	ExportedAt      string             `json:"exported_at"`
	IncludesSecrets bool               `json:"includes_secrets"`
	Scopes          []string           `json:"scopes"`
	Created         int                `json:"created"`
	Updated         int                `json:"updated"`
	Skipped         int                `json:"skipped"`
	Failed          int                `json:"failed"`
	Items           []ConfigImportItem `json:"items"`
	// Errors lists why the import was refused. Non-empty means nothing was
	// written, whether or not this was a dry run.
	Errors []string `json:"errors,omitempty"`
}
