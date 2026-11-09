package handlers

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

func TestResponseOwnershipStillHonorsGroupAndModelRestrictions(t *testing.T) {
	state := proxyRateLimitState(t)
	state.Keys = proxy.NewKeyPicker()
	insertCallerToken(t, state.DB, "caller-token")
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"resp_policy"}`)
	}))
	t.Cleanup(upstream.Close)
	channel := responseChannel(t, state, "only", upstream.URL, 100)
	router := proxyRateLimitRouter(state)
	response := proxyCall(router, http.MethodPost, "/v1/responses", `{"model":"test-model"}`)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	if _, err := state.DB.Exec(`UPDATE api_tokens SET allowed_models = '["test-model"]'`); err != nil {
		t.Fatal(err)
	}
	response = proxyCall(router, http.MethodGet, "/v1/responses/resp_policy", "")
	if response.Code != http.StatusOK {
		t.Fatalf("known model on a restricted token refused: %d", response.Code)
	}
	if _, err := state.DB.Exec(`UPDATE api_tokens SET allowed_models = '["other-model"]'`); err != nil {
		t.Fatal(err)
	}
	response = proxyCall(router, http.MethodGet, "/v1/responses/resp_policy", "")
	if response.Code != http.StatusForbidden || hits.Load() != 2 {
		t.Errorf("changed allowlist bypassed: status=%d hits=%d", response.Code, hits.Load())
	}
	if _, err := state.DB.Exec(`UPDATE api_tokens SET allowed_models = '[]'`); err != nil {
		t.Fatal(err)
	}
	group, err := db.CreateGroup(context.Background(), state.DB, &models.GroupIn{Name: "elsewhere"})
	if err != nil {
		t.Fatal(err)
	}
	if _, err := state.DB.Exec(`UPDATE api_tokens SET group_id = ?`, group.ID); err != nil {
		t.Fatal(err)
	}
	response = proxyCall(router, http.MethodGet, "/v1/responses/resp_policy", "")
	if response.Code != http.StatusNotFound || hits.Load() != 2 {
		t.Errorf("response escaped token group: status=%d hits=%d channel=%d", response.Code, hits.Load(), channel.ID)
	}
}

func TestResponseSelectorCannotOverrideTheOwningChannel(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"resp_selector"}`)
	}))
	t.Cleanup(upstream.Close)
	responseChannel(t, state, "owner", upstream.URL, 999)
	other, otherHits := countingUpstream(t)
	responseChannel(t, state, "other", other.URL, 100)
	router := proxyRateLimitRouter(state)
	response := proxyCall(router, http.MethodPost, "/v1/responses", `{"model":"test-model"}`)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	response = proxyCall(router, http.MethodGet, "/v1/responses/resp_selector?upstream=other", "")
	if response.Code != http.StatusNotFound || otherHits.Load() != 0 {
		t.Errorf("explicit selector changed response ownership: status=%d hits=%d", response.Code, otherHits.Load())
	}
}

func TestNumericChannelNameCannotReplaceADisabledResponseOwner(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	var hits atomic.Int64
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"resp_numeric"}`)
	}))
	t.Cleanup(upstream.Close)
	createChannel(t, state, "owner", upstream.URL, 999, nil)
	router := proxyRateLimitRouter(state)
	response := proxyCall(router, http.MethodPost, "/v1/responses", `{"model":"test-model"}`)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	var ownerID int64
	if err := state.DB.QueryRow(`SELECT id FROM upstreams WHERE name = 'owner'`).Scan(&ownerID); err != nil {
		t.Fatal(err)
	}
	createChannel(t, state, fmt.Sprint(ownerID), upstream.URL, 100, nil)
	if _, err := state.DB.Exec(`UPDATE upstreams SET enabled = 0 WHERE id = ?`, ownerID); err != nil {
		t.Fatal(err)
	}
	state.Routing.Invalidate()
	response = proxyCall(router, http.MethodGet, "/v1/responses/resp_numeric", "")
	if response.Code != http.StatusNotFound || hits.Load() != 1 {
		t.Errorf("numeric name replaced the owner: status=%d hits=%d", response.Code, hits.Load())
	}
}

func TestUnstoredResponsesDoNotGrowTheRouteTable(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"id":"resp_unstored"}`)
	}))
	t.Cleanup(upstream.Close)
	responseChannel(t, state, "only", upstream.URL, 100)
	response := proxyCall(proxyRateLimitRouter(state), http.MethodPost, "/v1/responses",
		`{"model":"test-model","store":false}`)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	var count int
	if err := state.DB.QueryRow(`SELECT COUNT(*) FROM response_routes`).Scan(&count); err != nil || count != 0 {
		t.Fatalf("unstored response route count=%d err=%v", count, err)
	}
}
