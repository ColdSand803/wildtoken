// Package middleware authenticates admin and downstream API callers.
package middleware

import (
	"context"
	"database/sql"
	"errors"
	"net"
	"net/http"
	"net/netip"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/authstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

type contextKey int

const (
	adminAuthKey contextKey = iota
	downstreamAuthKey
)

// AdminAuth records the credential snapshot a request authenticated against.
type AdminAuth struct {
	// CredentialVersion is the generation this request proved itself against.
	// Handlers that mutate the credential use it as their CAS precondition.
	CredentialVersion int64
}

// AdminAuthFrom returns the admin authentication attached to an authorized
// request.
func AdminAuthFrom(ctx context.Context) (AdminAuth, bool) {
	auth, ok := ctx.Value(adminAuthKey).(AdminAuth)
	return auth, ok
}

// DownstreamAuth identifies the API token a proxied request presented.
type DownstreamAuth struct {
	TokenID    int64
	TokenName  string
	ClientType string
	// GroupID scopes which channels this token may reach.
	GroupID int64
	// UsedTokens and LimitTokens carry the quota state this request was admitted
	// under. LimitTokens is nil when the token is unlimited.
	UsedTokens  int64
	LimitTokens *int64
}

// DownstreamAuthFrom returns the downstream authentication attached to an
// authorized request.
func DownstreamAuthFrom(ctx context.Context) (DownstreamAuth, bool) {
	auth, ok := ctx.Value(downstreamAuthKey).(DownstreamAuth)
	return auth, ok
}

// RequireAdmin verifies the `x-admin-token` header against the current Argon2id
// credential snapshot. All authentication failures are deliberately
// indistinguishable to callers.
//
// clientIPHeader names the forwarded header to trust, and is empty when no
// proxy sits in front of the service.
func RequireAdmin(credentials *authstate.Credentials, clientIPHeader string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			token := r.Header.Get("x-admin-token")
			if token == "" {
				writeUnauthorized(w)
				return
			}

			client := adminClient(r, clientIPHeader)
			credentialVersion, ok := credentials.Authenticate(token, client)
			if !ok {
				writeUnauthorized(w)
				return
			}

			ctx := context.WithValue(r.Context(), adminAuthKey,
				AdminAuth{CredentialVersion: credentialVersion})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func writeUnauthorized(w http.ResponseWriter) {
	apperr.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
}

// adminClient identifies the caller for throttling purposes.
//
// A forwarded header is only consulted when the operator has named one, and an
// address learned that way is always treated as remote — otherwise anyone could
// claim 127.0.0.1 and inherit the loopback exemption.
func adminClient(r *http.Request, clientIPHeader string) authstate.Client {
	if clientIPHeader != "" {
		forwarded := r.Header.Get(clientIPHeader)
		if forwarded != "" {
			first, _, _ := strings.Cut(forwarded, ",")
			if addr, ok := parseForwardedAddr(first); ok {
				return authstate.Client{Kind: authstate.ClientRemote, Addr: addr}
			}
		}
	}

	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		host = r.RemoteAddr
	}
	addr, err := netip.ParseAddr(host)
	if err != nil {
		return authstate.UnknownClient()
	}
	return authstate.ClientFromAddr(addr.Unmap())
}

// parseForwardedAddr accepts the bare address, `host:port` and `[v6]:port`
// forms proxies sometimes emit.
func parseForwardedAddr(value string) (netip.Addr, bool) {
	value = strings.TrimSpace(value)
	if value == "" {
		return netip.Addr{}, false
	}
	if addr, err := netip.ParseAddr(value); err == nil {
		return addr.Unmap(), true
	}
	if addrPort, err := netip.ParseAddrPort(value); err == nil {
		return addrPort.Addr().Unmap(), true
	}
	if host, _, err := net.SplitHostPort(value); err == nil {
		if addr, err := netip.ParseAddr(host); err == nil {
			return addr.Unmap(), true
		}
	}
	// A bracketed literal without a port is not valid for either parser above.
	if trimmed := strings.TrimSuffix(strings.TrimPrefix(value, "["), "]"); trimmed != value {
		if addr, err := netip.ParseAddr(trimmed); err == nil {
			return addr.Unmap(), true
		}
	}
	return netip.Addr{}, false
}

// RequireDownstream validates the caller's API token against the api_tokens
// table, accepting only enabled and unexpired rows.
func RequireDownstream(database *sql.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			// Anthropic clients authenticate with x-api-key and expect their own
			// error shape.
			anthropic := strings.TrimRight(r.URL.Path, "/") == "/v1/messages"

			token, ok := extractDownstreamToken(r, anthropic)
			if !ok {
				writeDownstreamRejection(w, anthropic, http.StatusUnauthorized,
					"Incorrect API key provided")
				return
			}

			credential, found, err := LookupEnabledDownstreamToken(r.Context(), database, token)
			if err != nil {
				writeDownstreamRejection(w, anthropic, http.StatusInternalServerError,
					"database error")
				return
			}
			if !found {
				writeDownstreamRejection(w, anthropic, http.StatusUnauthorized,
					"Incorrect API key provided")
				return
			}

			/* An exhausted quota is refused before the request reaches an
			   upstream. The check is on the total recorded so far, so the request
			   that crosses the limit is allowed to finish: its cost is only known
			   once the response completes. */
			if credential.LimitTokens != nil && credential.UsedTokens >= *credential.LimitTokens {
				writeDownstreamQuotaRejection(w, anthropic,
					models.QuotaExceededMessage(credential.UsedTokens, *credential.LimitTokens))
				return
			}

			ctx := context.WithValue(r.Context(), downstreamAuthKey, DownstreamAuth{
				TokenID:     credential.TokenID,
				TokenName:   credential.TokenName,
				ClientType:  DetectClientType(r, anthropic),
				GroupID:     credential.GroupID,
				UsedTokens:  credential.UsedTokens,
				LimitTokens: credential.LimitTokens,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func writeDownstreamRejection(w http.ResponseWriter, anthropic bool, status int, message string) {
	writeDownstreamError(w, anthropic, status, message, "invalid_api_key", "authentication_error")
}

// writeDownstreamQuotaRejection reports an exhausted quota.
//
// The error type deliberately differs from a bad credential: a client that reads
// invalid_api_key is expected to stop and have its key replaced, whereas a quota
// refusal is resolved by raising the limit or resetting usage. Both vendors have
// a rate-limit shape for exactly this, so it is reused.
func writeDownstreamQuotaRejection(w http.ResponseWriter, anthropic bool, message string) {
	writeDownstreamError(w, anthropic, http.StatusTooManyRequests, message,
		"insufficient_quota", "rate_limit_error")
}

func writeDownstreamError(w http.ResponseWriter, anthropic bool, status int,
	message, openAIType, anthropicType string) {
	if anthropic {
		apperr.WriteJSON(w, status, map[string]any{
			"type":  "error",
			"error": map[string]string{"type": anthropicType, "message": message},
		})
		return
	}
	apperr.WriteJSON(w, status, map[string]any{
		"error": map[string]string{
			"message": message,
			"type":    openAIType,
			"code":    openAIType,
		},
	})
}

// DetectClientType labels the caller from its originator and user-agent headers.
func DetectClientType(r *http.Request, anthropic bool) string {
	originator := strings.ToLower(r.Header.Get("originator"))
	userAgent := strings.ToLower(r.Header.Get("user-agent"))

	switch {
	case strings.Contains(originator, "codex desktop"):
		return "codex-desktop"
	case strings.Contains(originator, "codex-tui"):
		return "codex-tui"
	case strings.Contains(userAgent, "codex desktop"):
		return "codex-desktop"
	case strings.Contains(userAgent, "codex-tui"):
		return "codex-tui"
	case strings.Contains(userAgent, "opencode"):
		return "opencode"
	case strings.Contains(originator, "codex") || strings.Contains(userAgent, "codex"):
		return "codex"
	case anthropic || strings.Contains(userAgent, "claude") || r.Header.Get("anthropic-version") != "":
		return "claude"
	default:
		return "unknown"
	}
}

// extractDownstreamToken reads a bearer token, falling back to x-api-key for
// Anthropic-style requests.
func extractDownstreamToken(r *http.Request, anthropic bool) (string, bool) {
	authorization := r.Header.Get("authorization")
	if scheme, credentials, found := strings.Cut(authorization, " "); found &&
		strings.EqualFold(scheme, "bearer") {
		if token := strings.TrimSpace(credentials); token != "" {
			return token, true
		}
	}
	if !anthropic {
		return "", false
	}
	if token := strings.TrimSpace(r.Header.Get("x-api-key")); token != "" {
		return token, true
	}
	return "", false
}

// DownstreamCredential is the authenticated token's routing and quota state.
type DownstreamCredential struct {
	TokenID     int64
	TokenName   string
	GroupID     int64
	UsedTokens  int64
	LimitTokens *int64
}

// LookupEnabledDownstreamToken resolves a token to its row.
//
// A lapsed expiry filters the row out here rather than being reported
// separately, so an expired token is indistinguishable from a disabled or
// nonexistent one. Anything else would turn the error body into an oracle for
// which tokens once existed.
//
// An exhausted quota is deliberately not filtered here: the caller reports it
// separately, because a credential that is merely out of budget should say so
// rather than look like a wrong key.
func LookupEnabledDownstreamToken(ctx context.Context, database *sql.DB,
	token string) (DownstreamCredential, bool, error) {
	if token == "" {
		return DownstreamCredential{}, false, nil
	}

	// A row predating groups, or one whose group was removed out of band, reads
	// as the default group rather than as no group: a token that reaches nothing
	// would look like a routing bug rather than a configuration choice.
	var credential DownstreamCredential
	var storedGroupID, storedLimit sql.NullInt64
	err := database.QueryRowContext(ctx,
		`SELECT id, name, group_id, COALESCE(used_tokens, 0), limit_tokens FROM api_tokens
        WHERE token_hash = ? AND enabled = 1
          AND (expires_at IS NULL OR expires_at > datetime('now'))`,
		db.TokenDigest(token)).
		Scan(&credential.TokenID, &credential.TokenName, &storedGroupID,
			&credential.UsedTokens, &storedLimit)
	if errors.Is(err, sql.ErrNoRows) {
		return DownstreamCredential{}, false, nil
	}
	if err != nil {
		return DownstreamCredential{}, false, err
	}

	credential.GroupID = models.DefaultGroupID
	if storedGroupID.Valid && storedGroupID.Int64 > 0 {
		credential.GroupID = storedGroupID.Int64
	}
	if storedLimit.Valid && storedLimit.Int64 > 0 {
		credential.LimitTokens = &storedLimit.Int64
	}
	return credential, true, nil
}
