package middleware

import (
	"context"
	"database/sql"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/authstate"
	"github.com/liguangsheng/wildtoken/internal/db"
)

func requestWithHeaders(headers map[string]string) *http.Request {
	request := httptest.NewRequest(http.MethodPost, "/v1/responses", nil)
	for name, value := range headers {
		request.Header.Set(name, value)
	}
	return request
}

func TestDistinguishesCodexTUIAndDesktopWithOriginatorPrecedence(t *testing.T) {
	tui := requestWithHeaders(map[string]string{
		"originator": "codex-tui",
		"user-agent": "Codex Desktop/0.144.2",
	})
	if got := DetectClientType(tui, false); got != "codex-tui" {
		t.Errorf("client type = %q, want codex-tui from the originator", got)
	}

	desktop := requestWithHeaders(map[string]string{
		"originator": "Codex Desktop",
		"user-agent": "codex-tui/0.144.3",
	})
	if got := DetectClientType(desktop, false); got != "codex-desktop" {
		t.Errorf("client type = %q, want codex-desktop from the originator", got)
	}
}

func TestFallsBackToUserAgentAndPreservesOtherClientTypes(t *testing.T) {
	for userAgent, want := range map[string]string{
		"codex-tui/0.144.3":     "codex-tui",
		"Codex Desktop/0.144.2": "codex-desktop",
		"codex-cli/0.1":         "codex",
		"opencode/1.0":          "opencode",
		"claude-cli/1.0":        "claude",
	} {
		request := requestWithHeaders(map[string]string{"user-agent": userAgent})
		if got := DetectClientType(request, false); got != want {
			t.Errorf("user-agent %q gave %q, want %q", userAgent, got, want)
		}
	}

	if got := DetectClientType(requestWithHeaders(nil), true); got != "claude" {
		t.Errorf("an Anthropic path gave %q, want claude", got)
	}
	if got := DetectClientType(requestWithHeaders(nil), false); got != "unknown" {
		t.Errorf("an unlabeled caller gave %q, want unknown", got)
	}
	anthropicVersion := requestWithHeaders(map[string]string{"anthropic-version": "2023-06-01"})
	if got := DetectClientType(anthropicVersion, false); got != "claude" {
		t.Errorf("anthropic-version gave %q, want claude", got)
	}
}

func TestMissingOrEmptyCredentialsAreRejectedBeforeLookup(t *testing.T) {
	if _, ok := extractDownstreamToken(requestWithHeaders(nil), false); ok {
		t.Error("a request without credentials produced a token")
	}
	if _, ok := extractDownstreamToken(
		requestWithHeaders(map[string]string{"authorization": "Bearer"}), false); ok {
		t.Error("a bare Bearer scheme produced a token")
	}
	if _, ok := extractDownstreamToken(
		requestWithHeaders(map[string]string{"x-api-key": ""}), true); ok {
		t.Error("an empty x-api-key produced a token")
	}
	// x-api-key is only accepted on the Anthropic path.
	if _, ok := extractDownstreamToken(
		requestWithHeaders(map[string]string{"x-api-key": "value"}), false); ok {
		t.Error("x-api-key was accepted outside the Anthropic path")
	}

	token, ok := extractDownstreamToken(
		requestWithHeaders(map[string]string{"authorization": "bEaReR valid-token-value"}), false)
	if !ok || token != "valid-token-value" {
		t.Errorf("token = %q (ok=%v), want the credential with a case-insensitive scheme", token, ok)
	}
}

func authTestDB(t *testing.T) *sql.DB {
	t.Helper()
	database, err := sql.Open("sqlite", "file:"+t.Name()+"?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	database.SetMaxOpenConns(1)
	t.Cleanup(func() { database.Close() })
	if err := db.Init(context.Background(), database); err != nil {
		t.Fatalf("init: %v", err)
	}
	return database
}

func insertToken(t *testing.T, database *sql.DB, name, plaintext string, expiresAt any) {
	t.Helper()
	digest := db.TokenDigest(plaintext)
	_, err := database.Exec(
		"INSERT INTO api_tokens (name, token, token_hash, token_preview, expires_at) VALUES (?, ?, ?, '…', ?)",
		name, digest, digest, expiresAt)
	if err != nil {
		t.Fatalf("insert token %s: %v", name, err)
	}
}

func TestAnEmptyTokenNeverAuthenticates(t *testing.T) {
	database := authTestDB(t)
	// A row whose digest is the digest of the empty string must not turn an
	// absent credential into a valid one.
	insertToken(t, database, "empty", "", nil)

	if _, _, _, found, err := LookupEnabledDownstreamToken(
		context.Background(), database, ""); err != nil || found {
		t.Errorf("an empty token authenticated: found=%v err=%v", found, err)
	}
}

func TestALapsedExpiryStopsAuthenticatingWithoutTouchingEnabled(t *testing.T) {
	database := authTestDB(t)
	ctx := context.Background()

	// Three enabled rows differing only in expiry: none, future, past.
	insertToken(t, database, "never", "token-never-expires", nil)
	insertToken(t, database, "future", "token-expires-later", "2099-01-01 00:00:00")
	insertToken(t, database, "lapsed", "token-already-expired", "2000-01-01 00:00:00")

	for _, plaintext := range []string{"token-never-expires", "token-expires-later"} {
		_, _, _, found, err := LookupEnabledDownstreamToken(ctx, database, plaintext)
		if err != nil || !found {
			t.Errorf("%s must still authenticate: found=%v err=%v", plaintext, found, err)
		}
	}

	if _, _, _, found, err := LookupEnabledDownstreamToken(
		ctx, database, "token-already-expired"); err != nil || found {
		t.Errorf("an expired token authenticated: found=%v err=%v", found, err)
	}

	// The row is still there and still enabled — expiry is a separate axis from
	// the operator's on/off switch, so it can be renewed in place.
	var enabled int64
	if err := database.QueryRow(
		"SELECT enabled FROM api_tokens WHERE name = 'lapsed'").Scan(&enabled); err != nil {
		t.Fatalf("read enabled: %v", err)
	}
	if enabled != 1 {
		t.Errorf("enabled = %d, want the expiry to leave the switch alone", enabled)
	}
}

func TestADisabledTokenDoesNotAuthenticate(t *testing.T) {
	database := authTestDB(t)
	insertToken(t, database, "disabled", "token-disabled", nil)
	if _, err := database.Exec(
		"UPDATE api_tokens SET enabled = 0 WHERE name = 'disabled'"); err != nil {
		t.Fatalf("disable: %v", err)
	}

	if _, _, _, found, err := LookupEnabledDownstreamToken(
		context.Background(), database, "token-disabled"); err != nil || found {
		t.Errorf("a disabled token authenticated: found=%v err=%v", found, err)
	}
}

func TestForwardedAddressesAreParsedAndAlwaysTreatedAsRemote(t *testing.T) {
	for _, value := range []string{
		"203.0.113.7",
		"203.0.113.7:4321",
		"2001:db8::1",
		"[2001:db8::1]:4321",
		"[2001:db8::1]",
		"  203.0.113.7  ",
	} {
		if _, ok := parseForwardedAddr(value); !ok {
			t.Errorf("parseForwardedAddr(%q) failed", value)
		}
	}
	for _, value := range []string{"", "not-an-address", "example.test"} {
		if _, ok := parseForwardedAddr(value); ok {
			t.Errorf("parseForwardedAddr(%q) unexpectedly succeeded", value)
		}
	}

	// A forwarded loopback address must not inherit the loopback exemption,
	// or any caller could claim it and shed their failure history.
	request := requestWithHeaders(map[string]string{"x-forwarded-for": "127.0.0.1"})
	request.RemoteAddr = "203.0.113.9:5000"
	client := adminClient(request, "x-forwarded-for")
	if client.Kind != authstate.ClientRemote {
		t.Error("a forwarded loopback address was not classified as remote")
	}

	// Only the first entry of a chain is honored.
	chained := requestWithHeaders(map[string]string{"x-forwarded-for": "203.0.113.7, 198.51.100.4"})
	chained.RemoteAddr = "10.0.0.1:5000"
	if got := adminClient(chained, "x-forwarded-for").Addr; got != netip.MustParseAddr("203.0.113.7") {
		t.Errorf("forwarded address = %v, want the first entry of the chain", got)
	}

	// Without a configured header the peer address decides, so a real loopback
	// caller keeps its exemption.
	direct := requestWithHeaders(map[string]string{"x-forwarded-for": "203.0.113.7"})
	direct.RemoteAddr = "127.0.0.1:5000"
	if client := adminClient(direct, ""); client.Kind != authstate.ClientLoopback {
		t.Error("an unconfigured header let a caller override its identity")
	}
}
