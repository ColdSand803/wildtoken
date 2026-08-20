package models

import (
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/liguangsheng/wildtoken/internal/ratelimit"
)

const (
	APITokenNameMaxChars        = 80
	APITokenDescriptionMaxChars = 200
	// APITokenMinBytes no longer floors a custom token at 16 bytes. The console
	// warns and asks for a second confirmation below that, and the threshold
	// lives there (TOKEN_WEAK_BYTES in static/js/tokens.js) rather than here: a
	// stateless request cannot distinguish an operator who was warned and
	// accepted from one who never saw the warning, so enforcing it server-side
	// would either refuse the confirmed case or need a "yes I mean it" flag that
	// any client could set. What is left here is what is structurally invalid —
	// empty, or too long.
	APITokenMinBytes = 1
	APITokenMaxBytes = 256
)

// TimestampFormat is the shape SQLite's `datetime('now')` produces, and the only
// shape `expires_at` is ever stored in. Fixed width and zero padded, so lexical
// order is chronological order — which is what lets the authentication SQL in
// middleware and the checks in the token store compare expiries as plain strings
// and always reach the same verdict.
const TimestampFormat = "2006-01-02 15:04:05"

const expiryFormatError = ErrString(
	"token expiry must be an RFC 3339 timestamp or 'YYYY-MM-DD HH:MM:SS' in UTC")

// UTCNowTimestamp renders now in the stored timestamp shape, for comparison
// against an expiry.
func UTCNowTimestamp() string {
	return time.Now().UTC().Format(TimestampFormat)
}

// NormalizeExpiresAt converts a caller-supplied expiry into the stored UTC shape.
//
// A blank value means "never expires" and is reported as nil, so clearing the
// console's expiry field behaves the same whether the client sends `null` or
// `""`. Whether the result lies in the past is not decided here — that depends
// on the row being written, and lives in the token store.
func NormalizeExpiresAt(raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	value := strings.TrimSpace(*raw)
	if value == "" {
		return nil, nil
	}
	if parsed, err := time.Parse(time.RFC3339, value); err == nil {
		normalized := parsed.UTC().Format(TimestampFormat)
		return &normalized, nil
	}
	if parsed, err := time.Parse(TimestampFormat, value); err == nil {
		normalized := parsed.UTC().Format(TimestampFormat)
		return &normalized, nil
	}
	return nil, expiryFormatError
}

// APITokenRow mirrors a row of the `api_tokens` table.
type APITokenRow struct {
	ID           int64
	Name         string
	Description  string
	TokenPreview string
	// Token is the stored plaintext, empty for rows written before it was kept.
	Token       string
	Enabled     int64
	ExpiresAt   *string
	CreatedAt   string
	UpdatedAt   string
	GroupID     int64
	UsedTokens  int64
	LimitTokens *int64
	RateLimit   *string
	// AllowedModels is the stored JSON array. Nil covers a row written before the
	// column existed; both nil and "[]" mean unrestricted.
	AllowedModels *string
	// QuotaPeriod controls automatic quota rollover. None is the legacy lifetime
	// total; the other values bind usage to a calendar period in QuotaTimezone.
	QuotaPeriod   string
	QuotaTimezone string
	// QuotaPeriodStamp is the cycle UsedTokens was accumulated under, which is not
	// necessarily the current one — the counter is cleared by the first usage of a
	// new period, not on the boundary itself.
	QuotaPeriodStamp string
}

// UsedTokensNow reports the usage that counts against the limit at the given
// instant.
//
// A stored total naming a closed period reads as zero, because the row has not been
// cleared yet: clearing happens atomically with the first usage of the new period.
// Reporting the stale figure would show a token as exhausted through the whole
// first request of a fresh cycle, and the operator would see a quota that did not
// reset when it said it would.
//
// This mirrors DownstreamCredential.UsedTokensInCurrentPeriod, deliberately: the
// console and the admission path must not disagree about what has been spent.
func (r APITokenRow) UsedTokensNow(at time.Time) int64 {
	currentStamp := QuotaPeriodStamp(r.QuotaPeriod, at, LoadQuotaLocation(r.QuotaTimezone))
	if currentStamp == "" || r.QuotaPeriodStamp == currentStamp {
		return r.UsedTokens
	}
	// A different period *type* means the stamps are not comparable and the applying
	// statement carries the total forward, so it still counts.
	storedType, _, _ := strings.Cut(r.QuotaPeriodStamp, ":")
	currentType, _, _ := strings.Cut(currentStamp, ":")
	if storedType != currentType {
		return r.UsedTokens
	}
	return 0
}

// APITokenIn is the create payload. A nil Token means "generate one".
type APITokenIn struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	Token       *string `json:"token"`
	Enabled     bool    `json:"enabled"`
	// ExpiresAt absent, null or blank means the token never expires.
	ExpiresAt *string `json:"expires_at"`
	// GroupID scopes which channels this token may reach. Absent means the
	// default group.
	GroupID *int64 `json:"group_id"`
	// LimitExpression is a token limit such as 100M or 1B. Blank means no limit.
	LimitExpression string `json:"limit_expression"`
	// RateLimit is a rate limit expression such as "100/m" or "1000/h". Blank means no limit.
	RateLimit *string `json:"rate_limit"`
	// AllowedModels restricts which models this credential may call. An absent
	// field, null and an empty array all mean unrestricted — the console can send
	// whichever its form produces without changing the outcome.
	AllowedModels []string `json:"allowed_models"`
	// QuotaPeriod is the reset cycle: none, daily, weekly or monthly. Absent or
	// blank means none, so a client that does not send the field gets the legacy
	// lifetime total.
	QuotaPeriod string `json:"quota_period"`
	// QuotaTimezone is the IANA zone the boundary falls in. Blank means UTC.
	QuotaTimezone string `json:"quota_timezone"`
}

// APITokenUpdateIn is a full replacement, so an absent `expires_at` clears the
// expiry rather than leaving it alone. The console always sends the field.
type APITokenUpdateIn struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	ExpiresAt   *string `json:"expires_at"`
	GroupID     *int64  `json:"group_id"`
	// Token replaces the credential itself. Unlike ExpiresAt this is not a full
	// replacement: absent, null and blank all leave the current value alone. The
	// console echoes the token back on every save, and reading a blank field as
	// "erase it" would leave a row nobody can authenticate with.
	Token *string `json:"token"`
	// LimitExpression is a token limit such as 100M or 1B. Blank means no limit.
	LimitExpression string `json:"limit_expression"`
	// RateLimit is a rate limit expression such as "100/m" or "1000/h". Blank means no limit.
	RateLimit *string `json:"rate_limit"`
	// AllowedModels is a full replacement, like ExpiresAt and unlike Token: an
	// absent or empty array clears the restriction. That is what the console's
	// "clear the whitelist" action produces, and reading it as "leave it alone"
	// would make a restriction impossible to remove.
	AllowedModels []string `json:"allowed_models"`
	// QuotaPeriod and QuotaTimezone are full replacements too. An absent period
	// means none, which is how an operator turns automatic resets off.
	QuotaPeriod   string `json:"quota_period"`
	QuotaTimezone string `json:"quota_timezone"`
}

// RequestedToken is the replacement value, or "" when this edit keeps the
// current one.
func (t *APITokenUpdateIn) RequestedToken() string {
	if t.Token == nil {
		return ""
	}
	return *t.Token
}

// NormalizeRateLimit validates and trims a rate limit expression.
//
// A nil or blank value means "no rate limit" and is reported as nil, matching
// how the expiry field treats absence. The parsed form is discarded here — the
// stored shape is the expression itself, so the console can echo back exactly
// what the operator wrote.
func NormalizeRateLimit(raw *string) (*string, error) {
	if raw == nil {
		return nil, nil
	}
	value := strings.TrimSpace(*raw)
	if value == "" {
		return nil, nil
	}
	if _, err := ratelimit.ParseRateLimit(value); err != nil {
		return nil, ErrString("rate limit must look like 100/m, 1000/h or 50/10s")
	}
	return &value, nil
}

// validateTokenMetadata judges the name and description that will be stored, and
// writes the trimmed values back through the pointers it is given.
//
// The stores trim before writing, so the check has to be against the trimmed
// value or it answers about a different string than the one that lands in the
// database: a name padded past the limit with spaces was refused for a length it
// would not have had, and the emptiness check was already trimming while the
// length check beside it was not.
func validateTokenMetadata(name, description *string) error {
	trimmedName := strings.TrimSpace(*name)
	if trimmedName == "" || utf8.RuneCountInString(trimmedName) > APITokenNameMaxChars {
		return ErrString("token name must be between 1 and 80 characters")
	}
	if strings.ContainsFunc(trimmedName, unicode.IsControl) {
		return ErrString("token name must not contain control characters")
	}

	trimmedDescription := strings.TrimSpace(*description)
	if utf8.RuneCountInString(trimmedDescription) > APITokenDescriptionMaxChars {
		return ErrString("token description must be at most 200 characters")
	}
	if strings.ContainsFunc(trimmedDescription, unicode.IsControl) {
		return ErrString("token description must not contain control characters")
	}

	*name = trimmedName
	*description = trimmedDescription
	return nil
}

func isASCIIGraphic(value string) bool {
	for i := 0; i < len(value); i++ {
		if value[i] <= 0x20 || value[i] >= 0x7f {
			return false
		}
	}
	return true
}

// validateTokenValue judges an operator-supplied credential. Creation and
// editing share it so a value the create endpoint refuses cannot be smuggled in
// through an update.
func validateTokenValue(token string) error {
	if len(token) < APITokenMinBytes || len(token) > APITokenMaxBytes {
		return ErrString("custom token must be between 1 and 256 bytes")
	}
	if !isASCIIGraphic(token) {
		return ErrString("custom token must contain only printable ASCII characters without spaces")
	}
	return nil
}

func (t *APITokenIn) Validate() error {
	if err := validateTokenMetadata(&t.Name, &t.Description); err != nil {
		return err
	}
	if _, err := t.NormalizedExpiresAt(); err != nil {
		return err
	}
	if _, err := t.ParsedLimit(); err != nil {
		return err
	}
	if _, err := t.NormalizedRateLimit(); err != nil {
		return err
	}
	if _, err := t.NormalizedAllowedModels(); err != nil {
		return err
	}
	if _, _, err := t.NormalizedQuotaCycle(); err != nil {
		return err
	}
	if t.Token == nil {
		return nil
	}
	return validateTokenValue(*t.Token)
}

// NormalizedAllowedModels renders the whitelist for storage.
func (t *APITokenIn) NormalizedAllowedModels() (string, error) {
	return NormalizeAllowedModels(t.AllowedModels)
}

// NormalizedQuotaCycle validates and resolves the reset cycle for storage.
func (t *APITokenIn) NormalizedQuotaCycle() (period, timezone string, err error) {
	return normalizeQuotaCycle(t.QuotaPeriod, t.QuotaTimezone)
}

// NormalizeQuotaCycle is normalizeQuotaCycle for callers outside the console's
// create and update payloads — the configuration import writes a token row
// directly, and resolving the cycle a second way there is how the two would come
// to disagree about what a blank timezone means.
func NormalizeQuotaCycle(rawPeriod, rawTimezone string) (period, timezone string, err error) {
	return normalizeQuotaCycle(rawPeriod, rawTimezone)
}

// normalizeQuotaCycle resolves a submitted cycle, defaulting a blank period to
// none and a blank timezone to UTC.
//
// An unrecognised period is refused rather than silently defaulted: a console that
// sends "monthy" would otherwise store a token that never resets while its form
// shows a monthly cycle.
func normalizeQuotaCycle(rawPeriod, rawTimezone string) (string, string, error) {
	period := strings.ToLower(strings.TrimSpace(rawPeriod))
	if period == "" {
		period = DefaultQuotaPeriod
	}
	if !ValidQuotaPeriod(period) {
		return "", "", ErrString("quota_period must be none, daily, weekly or monthly")
	}

	timezone := strings.TrimSpace(rawTimezone)
	if timezone == "" {
		timezone = DefaultQuotaTimezone
	}
	if err := ValidateQuotaTimezone(timezone); err != nil {
		return "", "", err
	}
	return period, timezone, nil
}

func (t *APITokenIn) NormalizedExpiresAt() (*string, error) {
	return NormalizeExpiresAt(t.ExpiresAt)
}

// ParsedLimit resolves the limit expression into a stored token count.
func (t *APITokenIn) ParsedLimit() (*int64, error) {
	return ParseQuotaExpression(t.LimitExpression)
}

// NormalizedRateLimit validates the rate limit expression for storage.
func (t *APITokenIn) NormalizedRateLimit() (*string, error) {
	return NormalizeRateLimit(t.RateLimit)
}

func (t *APITokenUpdateIn) Validate() error {
	if err := validateTokenMetadata(&t.Name, &t.Description); err != nil {
		return err
	}
	if _, err := t.NormalizedExpiresAt(); err != nil {
		return err
	}
	if _, err := t.ParsedLimit(); err != nil {
		return err
	}
	if _, err := t.NormalizedRateLimit(); err != nil {
		return err
	}
	if _, err := t.NormalizedAllowedModels(); err != nil {
		return err
	}
	if _, _, err := t.NormalizedQuotaCycle(); err != nil {
		return err
	}
	// A blank token means "leave it alone", so it never reaches the value rules.
	if requested := t.RequestedToken(); requested != "" {
		return validateTokenValue(requested)
	}
	return nil
}

// NormalizedAllowedModels renders the whitelist for storage.
func (t *APITokenUpdateIn) NormalizedAllowedModels() (string, error) {
	return NormalizeAllowedModels(t.AllowedModels)
}

// NormalizedQuotaCycle validates and resolves the reset cycle for storage.
func (t *APITokenUpdateIn) NormalizedQuotaCycle() (period, timezone string, err error) {
	return normalizeQuotaCycle(t.QuotaPeriod, t.QuotaTimezone)
}

func (t *APITokenUpdateIn) NormalizedExpiresAt() (*string, error) {
	return NormalizeExpiresAt(t.ExpiresAt)
}

// ParsedLimit resolves the limit expression into a stored token count.
func (t *APITokenUpdateIn) ParsedLimit() (*int64, error) {
	return ParseQuotaExpression(t.LimitExpression)
}

// NormalizedRateLimit validates the rate limit expression for storage.
func (t *APITokenUpdateIn) NormalizedRateLimit() (*string, error) {
	return NormalizeRateLimit(t.RateLimit)
}

// APITokenOut carries the full token value so the console can hand a credential
// back to the operator who owns it.
type APITokenOut struct {
	ID          int64  `json:"id"`
	Name        string `json:"name"`
	Description string `json:"description"`
	// Token is the plaintext, or "" for a row issued before plaintext was
	// stored — those cannot be recovered. Always serialized, never null, so a
	// client can test one field instead of distinguishing absent from empty.
	Token        string     `json:"token"`
	TokenPreview string     `json:"token_preview"`
	Enabled      bool       `json:"enabled"`
	ExpiresAt    *string    `json:"expires_at"`
	CreatedAt    string     `json:"created_at"`
	UpdatedAt    string     `json:"updated_at"`
	GroupID      int64      `json:"group_id"`
	GroupName    string     `json:"group_name"`
	Quota        QuotaState `json:"quota"`
	RateLimit    *string    `json:"rate_limit"`
	// AllowedModels is the operator's own list, always serialized as an array so
	// a client tests one field. An empty array is the wire form of "unrestricted";
	// there is no null variant, so no client has to distinguish the two.
	AllowedModels []string `json:"allowed_models"`
	// QuotaPeriodState reports the cycle, the current period and the next reset,
	// all derived server-side. The console must not compute a boundary itself: a
	// browser in another timezone would show a reset at the wrong hour, and one
	// with a skewed clock would show a period the gateway is not using.
	QuotaPeriodState QuotaPeriodState `json:"quota_period_state"`
}

// APITokenCreatedOut is what the creation endpoint answers with.
//
// It carries the full token, but so does APITokenOut: the console lets an
// operator copy a credential back out at any time, so token_plain is stored and
// the list and detail endpoints return it too. This is not a one-time reveal,
// and reading it as one understates where plaintext tokens are exposed.
type APITokenCreatedOut struct {
	ID               int64            `json:"id"`
	Name             string           `json:"name"`
	Description      string           `json:"description"`
	Token            string           `json:"token"`
	TokenPreview     string           `json:"token_preview"`
	Enabled          bool             `json:"enabled"`
	ExpiresAt        *string          `json:"expires_at"`
	CreatedAt        string           `json:"created_at"`
	UpdatedAt        string           `json:"updated_at"`
	GroupID          int64            `json:"group_id"`
	GroupName        string           `json:"group_name"`
	Quota            QuotaState       `json:"quota"`
	RateLimit        *string          `json:"rate_limit"`
	AllowedModels    []string         `json:"allowed_models"`
	QuotaPeriodState QuotaPeriodState `json:"quota_period_state"`
}

// TokenEnabledIn toggles a token.
//
// It mirrors UpstreamEnabledIn rather than reusing it, so the endpoint's
// contract names what it operates on, and it is a pointer for the same reason:
// a body of {} must not read as "disable this credential".
type TokenEnabledIn struct {
	Enabled *bool `json:"enabled"`
}

// Value returns the requested state, or an error when the body named none.
func (t *TokenEnabledIn) Value() (bool, error) {
	if t.Enabled == nil {
		return false, ErrString("enabled is required")
	}
	return *t.Enabled, nil
}
