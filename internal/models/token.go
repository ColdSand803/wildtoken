package models

import (
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
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
	Enabled      int64
	ExpiresAt    *string
	CreatedAt    string
	UpdatedAt    string
	GroupID      int64
	UsedTokens   int64
	LimitTokens  *int64
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
}

// APITokenUpdateIn is a full replacement, so an absent `expires_at` clears the
// expiry rather than leaving it alone. The console always sends the field.
type APITokenUpdateIn struct {
	Name        string  `json:"name"`
	Description string  `json:"description"`
	ExpiresAt   *string `json:"expires_at"`
	GroupID     *int64  `json:"group_id"`
	// LimitExpression is a token limit such as 100M or 1B. Blank means no limit.
	LimitExpression string `json:"limit_expression"`
}

func validateTokenMetadata(name, description string) error {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" || utf8.RuneCountInString(name) > APITokenNameMaxChars {
		return ErrString("token name must be between 1 and 80 characters")
	}
	if strings.ContainsFunc(name, unicode.IsControl) {
		return ErrString("token name must not contain control characters")
	}
	if utf8.RuneCountInString(description) > APITokenDescriptionMaxChars {
		return ErrString("token description must be at most 200 characters")
	}
	if strings.ContainsFunc(description, unicode.IsControl) {
		return ErrString("token description must not contain control characters")
	}
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

func (t *APITokenIn) Validate() error {
	if err := validateTokenMetadata(t.Name, t.Description); err != nil {
		return err
	}
	if _, err := t.NormalizedExpiresAt(); err != nil {
		return err
	}
	if _, err := t.ParsedLimit(); err != nil {
		return err
	}
	if t.Token == nil {
		return nil
	}
	token := *t.Token
	if len(token) < APITokenMinBytes || len(token) > APITokenMaxBytes {
		return ErrString("custom token must be between 1 and 256 bytes")
	}
	if !isASCIIGraphic(token) {
		return ErrString("custom token must contain only printable ASCII characters without spaces")
	}
	return nil
}

func (t *APITokenIn) NormalizedExpiresAt() (*string, error) {
	return NormalizeExpiresAt(t.ExpiresAt)
}

// ParsedLimit resolves the limit expression into a stored token count.
func (t *APITokenIn) ParsedLimit() (*int64, error) {
	return ParseQuotaExpression(t.LimitExpression)
}

func (t *APITokenUpdateIn) Validate() error {
	if err := validateTokenMetadata(t.Name, t.Description); err != nil {
		return err
	}
	if _, err := t.NormalizedExpiresAt(); err != nil {
		return err
	}
	_, err := t.ParsedLimit()
	return err
}

func (t *APITokenUpdateIn) NormalizedExpiresAt() (*string, error) {
	return NormalizeExpiresAt(t.ExpiresAt)
}

// ParsedLimit resolves the limit expression into a stored token count.
func (t *APITokenUpdateIn) ParsedLimit() (*int64, error) {
	return ParseQuotaExpression(t.LimitExpression)
}

// APITokenOut never carries the full token value.
type APITokenOut struct {
	ID           int64      `json:"id"`
	Name         string     `json:"name"`
	Description  string     `json:"description"`
	TokenPreview string     `json:"token_preview"`
	Enabled      bool       `json:"enabled"`
	ExpiresAt    *string    `json:"expires_at"`
	CreatedAt    string     `json:"created_at"`
	UpdatedAt    string     `json:"updated_at"`
	GroupID      int64      `json:"group_id"`
	GroupName    string     `json:"group_name"`
	Quota        QuotaState `json:"quota"`
}

// APITokenCreatedOut is returned only by the creation endpoint, so the full
// token can be shown once.
type APITokenCreatedOut struct {
	ID           int64      `json:"id"`
	Name         string     `json:"name"`
	Description  string     `json:"description"`
	Token        string     `json:"token"`
	TokenPreview string     `json:"token_preview"`
	Enabled      bool       `json:"enabled"`
	ExpiresAt    *string    `json:"expires_at"`
	CreatedAt    string     `json:"created_at"`
	UpdatedAt    string     `json:"updated_at"`
	GroupID      int64      `json:"group_id"`
	GroupName    string     `json:"group_name"`
	Quota        QuotaState `json:"quota"`
}
