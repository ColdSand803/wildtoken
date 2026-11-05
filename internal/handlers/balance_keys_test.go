package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// balanceOut is the balance endpoints' answer, one entry per key.
type balanceOut struct {
	Keys []struct {
		KeyID        int64    `json:"key_id"`
		KeyName      string   `json:"key_name"`
		OK           bool     `json:"ok"`
		Message      string   `json:"message"`
		RemainingUSD *float64 `json:"remaining_usd"`
	} `json:"keys"`
}

func postBalance(t *testing.T, state *appstate.State, path string) (int, balanceOut) {
	t.Helper()
	router := chi.NewRouter()
	router.Post("/api/admin/upstreams/{id}/balance", AdminFetchUpstreamBalance(state))
	router.Post("/api/admin/upstreams/{id}/balance/sub2api", AdminFetchUpstreamSub2APIBalance(state))

	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodPost, path, nil))
	var out balanceOut
	json.Unmarshal(recorder.Body.Bytes(), &out)
	return recorder.Code, out
}

// loggedKeys flushes the log writer and reads each row's key as "id:name".
func loggedKeys(t *testing.T, state *appstate.State) []string {
	t.Helper()
	state.LogWriter.Close()
	rows, err := state.DB.Query(`SELECT COALESCE(upstream_key_id, 0) || ':' || COALESCE(upstream_key_name, '')
        FROM request_logs ORDER BY upstream_key_id, id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	var keys []string
	for rows.Next() {
		var key string
		rows.Scan(&key)
		keys = append(keys, key)
	}
	return keys
}

// Each enabled key may be its own account: every one is read, a refused one
// fails alone, and the disabled one is never sent.
func TestBalanceReadsEveryEnabledKey(t *testing.T) {
	state, _ := keyState(t)
	// Keys are read side by side.
	var mu sync.Mutex
	var seen []string
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
		mu.Lock()
		seen = append(seen, key+" "+r.URL.Path)
		mu.Unlock()
		if key == "sk-b" {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		// sk-a: a $10 limit with 250 cents spent.
		if strings.HasSuffix(r.URL.Path, "/subscription") {
			w.Write([]byte(`{"hard_limit_usd": 10}`))
			return
		}
		w.Write([]byte(`{"total_usage": 250}`))
	}))
	t.Cleanup(upstream.Close)

	channel := keyedChannel(t, state, "multi", upstream.URL, 100,
		models.UpstreamKeyIn{Name: "a", APIKey: "sk-a"},
		models.UpstreamKeyIn{Name: "off", APIKey: "sk-off", Enabled: disabled()},
		models.UpstreamKeyIn{APIKey: "sk-b"})

	code, out := postBalance(t, state, "/api/admin/upstreams/"+itoa(channel)+"/balance")
	if code != http.StatusOK || len(out.Keys) != 2 {
		t.Fatalf("status %d, keys %+v", code, out.Keys)
	}

	first, second := out.Keys[0], out.Keys[1]
	if first.KeyName != "a" || !first.OK || first.RemainingUSD == nil || *first.RemainingUSD != 7.5 {
		t.Errorf("key a = %+v", first)
	}
	if second.KeyName != "" || second.KeyID <= first.KeyID || second.OK ||
		!strings.Contains(second.Message, "401") {
		t.Errorf("key b = %+v", second)
	}

	mu.Lock()
	for _, request := range seen {
		if strings.HasPrefix(request, "sk-off") {
			t.Errorf("the disabled key was sent: %v", seen)
		}
	}
	mu.Unlock()

	// Both of a's reads and b's one, each logged under its key.
	a, b := itoa(first.KeyID)+":a", itoa(second.KeyID)+":"
	if got := loggedKeys(t, state); !slices.Equal(got, []string{a, a, b}) {
		t.Errorf("logged keys = %v, want %v", got, []string{a, a, b})
	}
}

// A channel without keys signs in through its headers and is read once.
func TestBalanceReadsAChannelWithoutKeysOnce(t *testing.T) {
	state, _ := keyState(t)
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(`{"remaining": 3, "unit": "USD"}`))
	}))
	t.Cleanup(upstream.Close)
	channel := keyedChannel(t, state, "bare", upstream.URL, 100)

	code, out := postBalance(t, state, "/api/admin/upstreams/"+itoa(channel)+"/balance/sub2api")
	if code != http.StatusOK || len(out.Keys) != 1 {
		t.Fatalf("status %d, keys %+v", code, out.Keys)
	}
	if got := out.Keys[0]; got.KeyID != 0 || !got.OK || got.RemainingUSD == nil || *got.RemainingUSD != 3 {
		t.Errorf("result = %+v", got)
	}
	if got := loggedKeys(t, state); !slices.Equal(got, []string{"0:"}) {
		t.Errorf("logged keys = %v", got)
	}
}

// Keys all disabled leave nothing to sign in with: refused, nothing sent.
func TestBalanceRefusesAChannelWithNoEnabledKey(t *testing.T) {
	state, _ := keyState(t)
	upstream, recorder := keyedUpstream(t, nil)
	channel := keyedChannel(t, state, "off", upstream.URL, 100,
		models.UpstreamKeyIn{APIKey: "sk-off", Enabled: disabled()})

	if code, _ := postBalance(t, state, "/api/admin/upstreams/"+itoa(channel)+"/balance"); code != http.StatusBadRequest {
		t.Errorf("status %d, want 400", code)
	}
	if got := recorder.keys(); len(got) != 0 {
		t.Errorf("keys sent = %v", got)
	}
}
