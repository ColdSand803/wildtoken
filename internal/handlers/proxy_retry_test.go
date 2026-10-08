package handlers

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// statusUpstream answers every request with one status and counts the hits.
func retryStatusUpstream(t *testing.T, status int) (*httptest.Server, *atomic.Int64) {
	t.Helper()
	var hits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(status)
		w.Write([]byte(`{"error":{"message":"rejected"}}`))
	}))
	t.Cleanup(server.Close)
	return server, &hits
}

func channelScore(t *testing.T, state *appstate.State, name string) int64 {
	t.Helper()
	row, found, err := db.GetUpstreamByName(context.Background(), state.DB, name)
	if err != nil || !found {
		t.Fatalf("channel %s: found=%v err=%v", name, found, err)
	}
	return state.AutoWeight.Snapshot(row.ID, row.Weight, row.AutoWeightEnabled == 1,
		state.AutoWeightPolicy()).Score
}

func sendBody(router http.Handler, path, token, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	request.Header.Set("authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

// A request the channel rejects — one too long for any model — says nothing
// about the channel. Charging it let three such requests take the only channel
// out of routing, and every caller after them got a 503.
func TestRequestsAChannelRejectsDoNotTakeItOutOfRouting(t *testing.T) {
	state := proxyRateLimitState(t)
	var badHits atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		w.Header().Set("content-type", "application/json")
		if strings.Contains(string(body), "too-long") {
			badHits.Add(1)
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":{"message":"prompt is too long"}}`))
			return
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	defer server.Close()

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "only", server.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	for range 5 {
		if code := sendBody(router, "/v1/chat/completions", "caller-token",
			`{"model":"test-model","messages":"too-long"}`).Code; code != http.StatusBadRequest {
			t.Fatalf("rejected request returned %d, want the upstream's 400", code)
		}
	}
	if code := sendProxyRequest(router, "caller-token").Code; code != http.StatusOK {
		t.Errorf("a valid request after them returned %d, want 200", code)
	}
	// Asked again, the channel would refuse the same request the same way.
	if hits := badHits.Load(); hits != 5 {
		t.Errorf("the rejected requests reached the channel %d times, want once each", hits)
	}
	if score := channelScore(t, state, "only"); score != 100 {
		t.Errorf("health = %d, want untouched by the requests' own errors", score)
	}
}

// When another channel serves the request one refused, the refusal was the
// channel's: it is charged then, and only then.
func TestAChannelThatRejectsWhatAnotherServesIsCharged(t *testing.T) {
	state := proxyRateLimitState(t)
	rejecting, rejectingHits := retryStatusUpstream(t, http.StatusBadRequest)
	serving, servingHits := countingUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "rejecting", rejecting.URL, 999, nil)
	createChannel(t, state, "serving", serving.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	if code := sendProxyRequest(router, "caller-token").Code; code != http.StatusOK {
		t.Fatalf("returned %d, want the second channel's 200", code)
	}
	if rejectingHits.Load() != 1 || servingHits.Load() != 1 {
		t.Errorf("hits = %d rejecting / %d serving, want 1 / 1",
			rejectingHits.Load(), servingHits.Load())
	}
	if score := channelScore(t, state, "rejecting"); score >= 100 {
		t.Error("the channel that refused a request another served was not charged")
	}
	if score := channelScore(t, state, "serving"); score != 100 {
		t.Errorf("the serving channel's health = %d, want 100", score)
	}
}

// count_tokens is part of the Messages API: Claude Code calls it with the same
// x-api-key it sends to messages, and Anthropic expects the key back that way.
func TestCountTokensSpeaksTheMessagesAPI(t *testing.T) {
	state := proxyRateLimitState(t)
	received := make(chan http.Header, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"input_tokens":3}`))
	}))
	defer server.Close()

	insertCallerToken(t, state.DB, "caller-token")
	key := "channel-key"
	input := models.DefaultUpstreamIn()
	input.Name = "anthropic"
	input.BaseURL = server.URL
	input.APIKey = &key
	input.ModelNames = []string{"test-model"}
	if _, err := db.CreateUpstream(context.Background(), state.DB, &input); err != nil {
		t.Fatal(err)
	}
	router := proxyRateLimitRouter(state)

	request := httptest.NewRequest(http.MethodPost, "/v1/messages/count_tokens",
		strings.NewReader(`{"model":"test-model"}`))
	request.Header.Set("x-api-key", "caller-token")
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("x-api-key on count_tokens returned %d: %s", recorder.Code, recorder.Body.String())
	}

	headers := <-received
	if headers.Get("x-api-key") != key || headers.Get("authorization") != "" {
		t.Errorf("upstream got x-api-key=%q authorization=%q, want the key as x-api-key only",
			headers.Get("x-api-key"), headers.Get("authorization"))
	}
	if headers.Get("anthropic-version") == "" {
		t.Error("no anthropic-version was sent")
	}
}

// ?upstream= is this gateway's routing hint, not something the channel asked for.
func TestTheRoutingHintIsNotForwarded(t *testing.T) {
	state := proxyRateLimitState(t)
	query := make(chan string, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		query <- r.URL.RawQuery
		w.Write([]byte(`{}`))
	}))
	defer server.Close()

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "only", server.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	if code := sendBody(router, "/v1/chat/completions?upstream=only&api-version=2", "caller-token",
		`{"model":"test-model"}`).Code; code != http.StatusOK {
		t.Fatalf("returned %d", code)
	}
	if got := <-query; got != "api-version=2" {
		t.Errorf("upstream query = %q, want only the caller's own parameters", got)
	}
}

// The allowlist admits the name asked for. Fuzzy matching must not turn it into
// another model the token may not use; an operator's explicit mapping may.
func TestAnAllowlistAlsoBindsTheForwardedModel(t *testing.T) {
	state := proxyRateLimitState(t)
	ctx := context.Background()
	server, hits := countingUpstream(t)

	created, err := db.CreateToken(ctx, state.DB, &models.APITokenIn{
		Name: "restricted", Enabled: true, AllowedModels: []string{"gpt-4"},
	})
	if err != nil {
		t.Fatal(err)
	}
	fuzzy := models.DefaultUpstreamIn()
	fuzzy.Name = "fuzzy"
	fuzzy.BaseURL = server.URL
	fuzzy.ModelNames = []string{"gpt-4.5-preview"}
	if _, err := db.CreateUpstream(ctx, state.DB, &fuzzy); err != nil {
		t.Fatal(err)
	}
	router := proxyRateLimitRouter(state)

	if code := sendBody(router, "/v1/chat/completions", created.Token,
		`{"model":"gpt-4"}`).Code; code != http.StatusServiceUnavailable {
		t.Errorf("fuzzy match to another model returned %d, want 503", code)
	}
	if hits.Load() != 0 {
		t.Error("the request reached a channel forwarding a model outside the allowlist")
	}

	mapped := models.DefaultUpstreamIn()
	mapped.Name = "mapped"
	mapped.BaseURL = server.URL
	mapped.ModelMappings = map[string]string{"gpt-4": "gpt-4.5-preview"}
	if _, err := db.CreateUpstream(ctx, state.DB, &mapped); err != nil {
		t.Fatal(err)
	}
	state.Routing.Invalidate()

	if code := sendBody(router, "/v1/chat/completions", created.Token,
		`{"model":"gpt-4"}`).Code; code != http.StatusOK {
		t.Errorf("an explicit mapping returned %d, want 200", code)
	}
}
