package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/middleware"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
	"github.com/liguangsheng/wildtoken/internal/ratelimit"
)

// proxyRateLimitState extends the shared handler state with the pieces a
// forwarded request needs: an HTTP client, a log writer, and both limiters.
func proxyRateLimitState(t *testing.T) *appstate.State {
	t.Helper()
	state := upstreamTestState(t)
	state.HTTPClient = &http.Client{}
	state.TokenRateLimiter = ratelimit.NewLimiter()
	state.UpstreamRateLimiter = ratelimit.NewLimiter()

	ctx, cancel := context.WithCancel(context.Background())
	// One book shared between the state and the writer, as the server wires it: a
	// second instance would let an admin write refresh a table the settlement path
	// never reads.
	state.Pricing = proxy.NewPricingBook()
	// Wired as the server wires it, so a proxied request in these tests moves the
	// same scrape counters production traffic does.
	state.Prometheus = metrics.NewPrometheus()
	state.LogWriter = proxy.NewLogWriter(ctx, state.DB, state.Metrics,
		db.NewLogStatsCache(), 64, state.Quotas, state.Pricing, state.Prometheus)
	t.Cleanup(func() {
		state.LogWriter.Close()
		state.TokenRateLimiter.Close()
		state.UpstreamRateLimiter.Close()
		cancel()
	})
	return state
}

// proxyRateLimitRouter wires ProxyHandler behind the real downstream auth, so a
// request travels the same path production traffic does.
func proxyRateLimitRouter(state *appstate.State) http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RequireDownstream(state.DB, state.TokenRateLimiter, state.Quotas))
	router.Handle("/v1/*", ProxyHandler(state))
	return router
}

func insertCallerToken(t *testing.T, database *sql.DB, value string) {
	t.Helper()
	digest := db.TokenDigest(value)
	if _, err := database.Exec(`INSERT INTO api_tokens
        (name, token, token_hash, token_preview) VALUES ('caller', ?, ?, '…')`,
		digest, digest); err != nil {
		t.Fatalf("insert token: %v", err)
	}
}

func createChannel(t *testing.T, state *appstate.State, name, baseURL string,
	priority int32, rateLimit *string) {
	t.Helper()
	input := models.DefaultUpstreamIn()
	input.Name = name
	input.BaseURL = baseURL
	input.ModelNames = []string{"test-model"}
	input.Priority = priority
	input.RateLimit = rateLimit
	if _, err := db.CreateUpstream(context.Background(), state.DB, &input, 30); err != nil {
		t.Fatalf("create channel %s: %v", name, err)
	}
}

// countingUpstream serves a fixed 200 response and counts how often it is hit.
func countingUpstream(t *testing.T) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

func sendProxyRequest(router http.Handler, token string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(`{"model":"test-model"}`))
	request.Header.Set("authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

func TestARateLimitedChannelFailsOverToTheNextCandidate(t *testing.T) {
	state := proxyRateLimitState(t)
	primary, primaryHits := countingUpstream(t)
	fallback, fallbackHits := countingUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	limit := "1/h"
	createChannel(t, state, "primary", primary.URL, 999, &limit)
	createChannel(t, state, "fallback", fallback.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	// The first request routes to the higher-priority channel and consumes its
	// one-request window.
	if first := sendProxyRequest(router, "caller-token"); first.Code != http.StatusOK {
		t.Fatalf("first request returned %d: %s", first.Code, first.Body.String())
	}
	if primaryHits.Load() != 1 {
		t.Fatalf("primary hits = %d, want 1", primaryHits.Load())
	}

	// The second finds the primary rate-limited and fails over instead of 429ing.
	if second := sendProxyRequest(router, "caller-token"); second.Code != http.StatusOK {
		t.Fatalf("second request returned %d: %s", second.Code, second.Body.String())
	}
	if fallbackHits.Load() != 1 {
		t.Errorf("fallback hits = %d, want 1", fallbackHits.Load())
	}
	if primaryHits.Load() != 1 {
		t.Errorf("the rate-limited channel was hit again (%d hits)", primaryHits.Load())
	}
}

func TestAllChannelsRateLimitedReturns429(t *testing.T) {
	state := proxyRateLimitState(t)
	server, hits := countingUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	limit := "1/h"
	createChannel(t, state, "only", server.URL, 100, &limit)
	router := proxyRateLimitRouter(state)

	if first := sendProxyRequest(router, "caller-token"); first.Code != http.StatusOK {
		t.Fatalf("first request returned %d: %s", first.Code, first.Body.String())
	}

	second := sendProxyRequest(router, "caller-token")
	if second.Code != http.StatusTooManyRequests {
		t.Fatalf("second request returned %d, want 429: %s", second.Code, second.Body.String())
	}
	if hits.Load() != 1 {
		t.Errorf("upstream hits = %d, want the refused request never forwarded", hits.Load())
	}

	// The refusal carries the proxy's own code at the top level and the OpenAI
	// rate-limit shape inside `error`, mirroring the token-side rejections.
	var body struct {
		Code  string `json:"code"`
		Error struct {
			Type string `json:"type"`
		} `json:"error"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode refusal: %v", err)
	}
	if body.Code != UpstreamRateLimitedCode {
		t.Errorf("code = %q, want %q", body.Code, UpstreamRateLimitedCode)
	}
	if body.Error.Type != "rate_limit_exceeded" {
		t.Errorf("error.type = %q, want rate_limit_exceeded", body.Error.Type)
	}
}
