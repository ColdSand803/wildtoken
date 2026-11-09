package handlers

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

func responseChannel(t *testing.T, state *appstate.State, name, url string, priority int32) models.UpstreamOut {
	t.Helper()
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL, input.Priority = name, url, priority
	input.ModelNames = []string{"test-model"}
	keys := []models.UpstreamKeyIn{{APIKey: name + "-a"}, {APIKey: name + "-b"}}
	input.Keys = &keys
	created, err := db.CreateUpstream(context.Background(), state.DB, &input)
	if err != nil {
		t.Fatal(err)
	}
	return created
}

func TestStoredResponsesKeepTheirChannelKeyAndOwner(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprintf("stream=%v", stream), func(t *testing.T) {
			state := proxyRateLimitState(t)
			state.Keys = proxy.NewKeyPicker()
			insertCallerToken(t, state.DB, "caller-token")
			var owner string
			var ownerMu sync.Mutex
			var hits atomic.Int64
			upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				ownerMu.Lock()
				defer ownerMu.Unlock()
				hits.Add(1)
				if r.Method == http.MethodPost && r.URL.Path == "/v1/responses" {
					var input map[string]any
					json.NewDecoder(r.Body).Decode(&input)
					if input["previous_response_id"] != nil && r.Header.Get("Authorization") != owner {
						t.Error("continuation used another account")
					}
					owner = r.Header.Get("Authorization")
					if stream {
						w.Header().Set("Content-Type", "text/event-stream")
						fmt.Fprint(w, "event: response.created\ndata: {\"type\":\"response.created\",\"response\":{\"id\":\"resp_owned\"}}\n\n")
						w.(http.Flusher).Flush()
						fmt.Fprint(w, "data: {\"type\":\"response.completed\",\"response\":{\"id\":\"resp_owned\",\"usage\":{\"total_tokens\":5}}}\n\n")
						return
					}
					w.Header().Set("Content-Type", "application/json")
					fmt.Fprint(w, `{"id":"resp_owned","object":"response","usage":{"total_tokens":5}}`)
					return
				}
				if r.Header.Get("Authorization") != owner {
					w.WriteHeader(http.StatusNotFound)
					return
				}
				w.Header().Set("Content-Type", "application/json")
				fmt.Fprint(w, `{"id":"resp_owned","status":"completed"}`)
			}))
			t.Cleanup(upstream.Close)
			channel := responseChannel(t, state, "primary", upstream.URL, 100)
			router := proxyRateLimitRouter(state)
			created := proxyCall(router, http.MethodPost, "/v1/responses",
				fmt.Sprintf(`{"model":"test-model","stream":%v,"store":true}`, stream))
			if created.Code != http.StatusOK {
				t.Fatalf("create=%d %s", created.Code, created.Body.String())
			}
			// Rebuild transient state and add a higher-priority channel: persisted
			// response ownership must outlive the original picker and routing cache.
			state.Keys, state.Routing = proxy.NewKeyPicker(), proxy.NewRoutingCache()
			fallback, fallbackHits := countingUpstream(t)
			responseChannel(t, state, "other", fallback.URL, 999)
			for _, path := range []string{"/v1/responses/resp_owned", "/v1/responses/resp_owned/input_items"} {
				response := proxyCall(router, http.MethodGet, path, "")
				if response.Code != http.StatusOK {
					t.Fatalf("retrieve=%d %s", response.Code, response.Body.String())
				}
			}
			continued := proxyCall(router, http.MethodPost, "/v1/responses",
				`{"model":"test-model","previous_response_id":"resp_owned"}`)
			if continued.Code != http.StatusOK || fallbackHits.Load() != 0 {
				t.Fatalf("continuation=%d other_hits=%d", continued.Code, fallbackHits.Load())
			}
			before := hits.Load()
			foreign := "foreign-token"
			_, err := db.CreateToken(context.Background(), state.DB, &models.APITokenIn{
				Name: "other-owner", Token: &foreign, Enabled: true,
			})
			if err != nil {
				t.Fatal(err)
			}
			request := httptest.NewRequest(http.MethodGet, "/v1/responses/resp_owned", nil)
			request.Header.Set("Authorization", "Bearer "+foreign)
			response := httptest.NewRecorder()
			router.ServeHTTP(response, request)
			if response.Code != http.StatusNotFound || hits.Load() != before {
				t.Errorf("another token reached response: status=%d hits=%d", response.Code, hits.Load())
			}
			if _, err := state.DB.Exec(`UPDATE upstreams SET enabled = 0 WHERE id = ?`, channel.ID); err != nil {
				t.Fatal(err)
			}
			state.Routing.Invalidate()
			response = proxyCall(router, http.MethodGet, "/v1/responses/resp_owned", "")
			if response.Code != http.StatusNotFound || hits.Load() != before || fallbackHits.Load() != 0 {
				t.Errorf("disabled response channel failed over: %d", response.Code)
			}
		})
	}
}

func TestStoredResponseNeverFallsOverToAnotherKey(t *testing.T) {
	state := proxyRateLimitState(t)
	state.Keys = proxy.NewKeyPicker()
	insertCallerToken(t, state.DB, "caller-token")
	calls := make(chan string, 8)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls <- r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		if r.Method == http.MethodPost {
			fmt.Fprint(w, `{"id":"resp_refused"}`)
			return
		}
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"error":"expired upstream key"}`)
	}))
	t.Cleanup(upstream.Close)
	channel := responseChannel(t, state, "only", upstream.URL, 100)
	router := proxyRateLimitRouter(state)
	proxyCall(router, http.MethodPost, "/v1/responses", `{"model":"test-model"}`)
	response := proxyCall(router, http.MethodGet, "/v1/responses/resp_refused", "")
	if response.Code != http.StatusUnauthorized || len(calls) != 2 {
		t.Fatalf("status=%d calls=%d", response.Code, len(calls))
	}
	first, second := <-calls, <-calls
	if first != second {
		t.Fatalf("account changed from %q to %q", first, second)
	}
	if _, err := state.DB.Exec(`UPDATE upstream_keys SET api_key = 'replacement'
        WHERE upstream_id = ? AND id = (SELECT MIN(id) FROM upstream_keys WHERE upstream_id = ?)`, channel.ID, channel.ID); err != nil {
		t.Fatal(err)
	}
	state.Routing.Invalidate()
	response = proxyCall(router, http.MethodGet, "/v1/responses/resp_refused", "")
	if response.Code != http.StatusConflict || len(calls) != 0 {
		t.Errorf("edited credential was used: status=%d calls=%d", response.Code, len(calls))
	}
	response = proxyCall(router, http.MethodGet, "/v1/responses/resp_unknown", "")
	if response.Code != http.StatusNotFound || len(calls) != 0 || strings.Contains(response.Body.String(), "replacement") {
		t.Errorf("unknown response was relayed: %d", response.Code)
	}
}
