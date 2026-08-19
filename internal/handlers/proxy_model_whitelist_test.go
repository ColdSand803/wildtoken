package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/middleware"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// restrictCallerToken narrows an existing token to a whitelist, the way the
// console's save does.
func restrictCallerToken(t *testing.T, database *sql.DB, allowed string) {
	t.Helper()
	if _, err := database.Exec(
		"UPDATE api_tokens SET allowed_models = ? WHERE name = 'caller'", allowed); err != nil {
		t.Fatalf("restrict token: %v", err)
	}
}

// sendProxyRequestForModel posts a request naming a specific model.
func sendProxyRequestForModel(router http.Handler, token, body string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions",
		strings.NewReader(body))
	request.Header.Set("authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)
	return recorder
}

// TestAWhitelistedModelReachesItsChannel is the permitting half: the restriction
// must not break the traffic it was configured to allow.
func TestAWhitelistedModelReachesItsChannel(t *testing.T) {
	state := noBackoffState(t)
	upstream, hits := countingUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	restrictCallerToken(t, state.DB, `["test-model"]`)
	createChannel(t, state, "primary", upstream.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	response := sendProxyRequestForModel(router, "caller-token", `{"model":"test-model"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("got %d, want the whitelisted model to be forwarded: %s",
			response.Code, response.Body.String())
	}
	if hits.Load() != 1 {
		t.Errorf("upstream hits = %d, want 1", hits.Load())
	}
}

// TestAModelOutsideTheWhitelistIsRefusedBeforeAnyUpstream is the point of the
// feature: the refusal must happen in the gateway, so a restricted key cannot
// spend money at a provider.
func TestAModelOutsideTheWhitelistIsRefusedBeforeAnyUpstream(t *testing.T) {
	state := noBackoffState(t)
	upstream, hits := countingUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	restrictCallerToken(t, state.DB, `["cheap-model"]`)
	createChannel(t, state, "primary", upstream.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	response := sendProxyRequestForModel(router, "caller-token", `{"model":"test-model"}`)
	if response.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403: %s", response.Code, response.Body.String())
	}
	if hits.Load() != 0 {
		t.Errorf("upstream hits = %d, want the request refused before any upstream call",
			hits.Load())
	}

	// The OpenAI-compatible shape an SDK reads, plus the top-level code a caller
	// written against this proxy can branch on without knowing the dialect.
	var body struct {
		Code  string `json:"code"`
		Error struct {
			Message string `json:"message"`
			Type    string `json:"type"`
			Code    string `json:"code"`
		} `json:"error"`
	}
	if err := json.Unmarshal(response.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode refusal: %v", err)
	}
	if body.Code != ModelNotAllowedCode {
		t.Errorf("top-level code = %q, want %q", body.Code, ModelNotAllowedCode)
	}
	if body.Error.Code != "model_not_allowed" {
		t.Errorf("error.code = %q, want model_not_allowed", body.Error.Code)
	}
	if !strings.Contains(body.Error.Message, "test-model") {
		t.Errorf("message %q does not name the refused model", body.Error.Message)
	}
	if !strings.Contains(body.Error.Message, "cheap-model") {
		t.Errorf("message %q does not name what is allowed", body.Error.Message)
	}

	// The refusal is logged, so an operator can see a key being used for models it
	// may not call rather than having the requests vanish.
	state.LogWriter.Close()
	rows := readFailureRows(t, state.DB)
	if len(rows) != 1 {
		t.Fatalf("wrote %d log rows, want the refusal recorded", len(rows))
	}
	if rows[0].statusCode.Int64 != http.StatusForbidden {
		t.Errorf("logged status = %d, want 403", rows[0].statusCode.Int64)
	}
	if rows[0].upstreamName.Valid {
		t.Errorf("logged upstream %q, want none: no channel was involved",
			rows[0].upstreamName.String)
	}
}

// TestTheWhitelistIsJudgedOnTheClientsModelNotTheMappedOne is the ordering the
// checklist requires. A channel that maps one id onto another must not be able to
// launder a model past the check, and the operator wrote the list in terms of what
// their callers send.
func TestTheWhitelistIsJudgedOnTheClientsModelNotTheMappedOne(t *testing.T) {
	state := noBackoffState(t)
	upstream, hits := countingUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	// The whitelist names the upstream-side id. The client asks for the
	// client-side id, which maps onto it — and must still be refused, because the
	// list does not name what the client asked for.
	restrictCallerToken(t, state.DB, `["upstream-only-model"]`)

	input := models.DefaultUpstreamIn()
	input.Name = "mapping"
	input.BaseURL = upstream.URL
	input.ModelNames = []string{"upstream-only-model"}
	input.ModelMappings = map[string]string{"client-model": "upstream-only-model"}
	if _, err := db.CreateUpstream(context.Background(), state.DB, &input, 30); err != nil {
		t.Fatalf("create channel: %v", err)
	}
	router := proxyRateLimitRouter(state)

	response := sendProxyRequestForModel(router, "caller-token", `{"model":"client-model"}`)
	if response.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403: a mapping must not launder a model past the whitelist: %s",
			response.Code, response.Body.String())
	}
	if hits.Load() != 0 {
		t.Errorf("upstream hits = %d, want none", hits.Load())
	}
}

// TestARestrictedTokenIsRefusedWhenTheBodyNamesNoModel fixes the fail-closed
// direction end to end. The alternative makes an unreadable body a way past the
// whitelist.
func TestARestrictedTokenIsRefusedWhenTheBodyNamesNoModel(t *testing.T) {
	state := noBackoffState(t)
	upstream, hits := countingUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	restrictCallerToken(t, state.DB, `["test-model"]`)
	createChannel(t, state, "primary", upstream.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	response := sendProxyRequestForModel(router, "caller-token", `{"messages":[]}`)
	if response.Code != http.StatusForbidden {
		t.Fatalf("got %d, want 403 for a restricted key that named no model: %s",
			response.Code, response.Body.String())
	}
	if hits.Load() != 0 {
		t.Errorf("upstream hits = %d, want none", hits.Load())
	}
}

// TestAnUnrestrictedTokenIsUnaffectedByTheFeature guards the upgrade path: every
// existing credential must keep working exactly as it did, including on a request
// that names no model at all — the case a restricted token is refused for.
func TestAnUnrestrictedTokenIsUnaffectedByTheFeature(t *testing.T) {
	for name, allowed := range map[string]string{
		"empty array":   "[]",
		"bare wildcard": `["*"]`,
	} {
		t.Run(name, func(t *testing.T) {
			state := noBackoffState(t)
			upstream, hits := countingUpstream(t)

			insertCallerToken(t, state.DB, "caller-token")
			restrictCallerToken(t, state.DB, allowed)
			createChannel(t, state, "primary", upstream.URL, 100, nil)
			router := proxyRateLimitRouter(state)

			// A body with no model, which routing serves from any channel and which
			// a restricted token is refused for. That asymmetry is the whole of what
			// "unrestricted" has to preserve.
			response := sendProxyRequestForModel(router, "caller-token", `{"messages":[]}`)
			if response.Code != http.StatusOK {
				t.Fatalf("got %d, want an unrestricted token to be unaffected: %s",
					response.Code, response.Body.String())
			}
			if hits.Load() != 1 {
				t.Errorf("upstream hits = %d, want 1", hits.Load())
			}
		})
	}
}

// TestAWhitelistEditedOutOfBandAdmitsRatherThanRefuses matches how an
// unparseable rate limit is treated: the row survived validation at write time, so
// a parse failure means it was edited out of band, and refusing live traffic over
// a config error the caller cannot fix is the worse outcome.
func TestAWhitelistEditedOutOfBandAdmitsRatherThanRefuses(t *testing.T) {
	state := noBackoffState(t)
	upstream, hits := countingUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	restrictCallerToken(t, state.DB, `{"not":"an array"}`)
	createChannel(t, state, "primary", upstream.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	response := sendProxyRequestForModel(router, "caller-token", `{"model":"test-model"}`)
	if response.Code != http.StatusOK {
		t.Fatalf("got %d, want a malformed whitelist to admit rather than refuse: %s",
			response.Code, response.Body.String())
	}
	if hits.Load() != 1 {
		t.Errorf("upstream hits = %d, want 1", hits.Load())
	}
}

// modelsListRouter mounts the list endpoint behind the real middleware, so the
// policy is loaded from the row rather than injected.
func modelsListRouter(state *appstate.State) http.Handler {
	router := chi.NewRouter()
	router.Use(middleware.RequireDownstream(state.DB, state.TokenRateLimiter, state.Quotas))
	router.Get("/v1/models", ListModelsHandler(state))
	return router
}

// listModelIDs reads the ids the endpoint advertises.
func listModelIDs(t *testing.T, router http.Handler, token string) []string {
	t.Helper()
	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request.Header.Set("authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("models list returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var body struct {
		Data []struct{ ID string } `json:"data"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode models list: %v", err)
	}
	ids := make([]string, 0, len(body.Data))
	for _, entry := range body.Data {
		ids = append(ids, entry.ID)
	}
	return ids
}

// insertNamedToken adds a second credential with its own whitelist, so the two
// can be shown not to read each other's cached list.
func insertNamedToken(t *testing.T, database *sql.DB, name, value, allowed string) {
	t.Helper()
	digest := db.TokenDigest(value)
	if _, err := database.Exec(`INSERT INTO api_tokens
        (name, token, token_hash, token_preview, allowed_models)
        VALUES (?, ?, ?, '…', ?)`, name, digest, digest, allowed); err != nil {
		t.Fatalf("insert token %s: %v", name, err)
	}
}

// channelServingModels registers a channel advertising concrete model ids.
func channelServingModels(t *testing.T, state *appstate.State, name string, modelNames []string) {
	t.Helper()
	input := models.DefaultUpstreamIn()
	input.Name = name
	input.BaseURL = "http://127.0.0.1:1/v1"
	input.ModelNames = modelNames
	if _, err := db.CreateUpstream(context.Background(), state.DB, &input, 30); err != nil {
		t.Fatalf("create channel %s: %v", name, err)
	}
}

// TestTheModelsListIsIntersectedWithTheWhitelist is the second half of the "same
// authorization for both paths" requirement: a model the proxy would refuse must
// not be advertised as available.
func TestTheModelsListIsIntersectedWithTheWhitelist(t *testing.T) {
	state := noBackoffState(t)
	channelServingModels(t, state, "primary",
		[]string{"gpt-4o", "gpt-4o-mini", "claude-3-opus", "claude-3-haiku"})

	insertNamedToken(t, state.DB, "restricted", "restricted-token",
		`["gpt-4o", "claude-3-*"]`)
	insertNamedToken(t, state.DB, "open", "open-token", "[]")
	router := modelsListRouter(state)

	restricted := listModelIDs(t, router, "restricted-token")
	want := map[string]bool{"gpt-4o": true, "claude-3-opus": true, "claude-3-haiku": true}
	if len(restricted) != len(want) {
		t.Fatalf("restricted list = %v, want the three permitted ids", restricted)
	}
	for _, id := range restricted {
		if !want[id] {
			t.Errorf("restricted list advertises %q, which the proxy would refuse", id)
		}
	}

	// The unrestricted token still sees everything, so the intersection did not
	// leak across credentials.
	if open := listModelIDs(t, router, "open-token"); len(open) != 4 {
		t.Errorf("unrestricted list = %v, want all four ids", open)
	}
}

// TestTokensWithDifferentWhitelistsDoNotShareACachedList is the cache-key half.
//
// The list is cached per group, and before the policy fingerprint joined the key
// the first caller's response was served to every other token in the group — so a
// restricted key would read the unrestricted list, or worse, an unrestricted key
// would read a restricted one.
func TestTokensWithDifferentWhitelistsDoNotShareACachedList(t *testing.T) {
	state := noBackoffState(t)
	channelServingModels(t, state, "primary", []string{"gpt-4o", "gpt-4o-mini"})

	insertNamedToken(t, state.DB, "open", "open-token", "[]")
	insertNamedToken(t, state.DB, "restricted", "restricted-token", `["gpt-4o"]`)
	router := modelsListRouter(state)

	// The unrestricted token goes first, filling the cache for this group.
	if open := listModelIDs(t, router, "open-token"); len(open) != 2 {
		t.Fatalf("unrestricted list = %v, want both ids", open)
	}
	restricted := listModelIDs(t, router, "restricted-token")
	if len(restricted) != 1 || restricted[0] != "gpt-4o" {
		t.Fatalf("restricted list = %v, want only gpt-4o: it read the cached unrestricted list",
			restricted)
	}
	// And the reverse order, so neither direction depends on who warmed the cache.
	if open := listModelIDs(t, router, "open-token"); len(open) != 2 {
		t.Errorf("unrestricted list = %v after the restricted read, want both ids", open)
	}
}

// TestEditingAWhitelistTakesEffectWithoutInvalidatingTheCache is why the
// fingerprint is in the key rather than being a version an edit has to bump: token
// writes do not invalidate this cache at all, so an edit has to move the token to a
// different entry by itself.
func TestEditingAWhitelistTakesEffectWithoutInvalidatingTheCache(t *testing.T) {
	state := noBackoffState(t)
	channelServingModels(t, state, "primary", []string{"gpt-4o", "gpt-4o-mini"})

	insertNamedToken(t, state.DB, "editable", "editable-token", `["gpt-4o"]`)
	router := modelsListRouter(state)

	if first := listModelIDs(t, router, "editable-token"); len(first) != 1 {
		t.Fatalf("list = %v, want only gpt-4o", first)
	}

	// Widen the whitelist, with no cache invalidation of any kind.
	if _, err := state.DB.Exec(
		`UPDATE api_tokens SET allowed_models = '["gpt-4o","gpt-4o-mini"]'
	     WHERE name = 'editable'`); err != nil {
		t.Fatalf("widen whitelist: %v", err)
	}
	if widened := listModelIDs(t, router, "editable-token"); len(widened) != 2 {
		t.Errorf("list = %v after widening, want both ids: the edit hit a stale entry",
			widened)
	}

	// And narrowing it again, which is the direction that would over-advertise.
	if _, err := state.DB.Exec(
		`UPDATE api_tokens SET allowed_models = '["gpt-4o-mini"]' WHERE name = 'editable'`); err != nil {
		t.Fatalf("narrow whitelist: %v", err)
	}
	narrowed := listModelIDs(t, router, "editable-token")
	if len(narrowed) != 1 || narrowed[0] != "gpt-4o-mini" {
		t.Errorf("list = %v after narrowing, want only gpt-4o-mini", narrowed)
	}
}

// TestAWhitelistMatchingNothingReachableAdvertisesAnEmptyList keeps the response
// well formed: an SDK that reads data[] must not receive null.
func TestAWhitelistMatchingNothingReachableAdvertisesAnEmptyList(t *testing.T) {
	state := noBackoffState(t)
	channelServingModels(t, state, "primary", []string{"gpt-4o"})
	insertNamedToken(t, state.DB, "narrow", "narrow-token", `["model-no-channel-serves"]`)

	request := httptest.NewRequest(http.MethodGet, "/v1/models", nil)
	request.Header.Set("authorization", "Bearer narrow-token")
	recorder := httptest.NewRecorder()
	modelsListRouter(state).ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("got %d, want 200: %s", recorder.Code, recorder.Body.String())
	}
	if !strings.Contains(recorder.Body.String(), `"data":[]`) {
		t.Errorf("body = %s, want an empty data array rather than null",
			recorder.Body.String())
	}
}
