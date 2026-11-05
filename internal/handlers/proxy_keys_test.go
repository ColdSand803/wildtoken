package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

// keyRecorder is an upstream that answers each key as told — 200 unless refuse
// names a status for it — and records the keys it was sent, in order.
type keyRecorder struct {
	mu     sync.Mutex
	seen   []string
	refuse map[string]int
}

func keyedUpstream(t *testing.T, refuse map[string]int) (*httptest.Server, *keyRecorder) {
	t.Helper()
	recorder := &keyRecorder{refuse: refuse}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		key := strings.TrimPrefix(r.Header.Get("authorization"), "Bearer ")
		recorder.mu.Lock()
		recorder.seen = append(recorder.seen, key)
		recorder.mu.Unlock()
		w.Header().Set("content-type", "application/json")
		if status := refuse[key]; status != 0 {
			w.WriteHeader(status)
			w.Write([]byte(`{"error":{"message":"refused"}}`))
			return
		}
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)
	return server, recorder
}

func (k *keyRecorder) keys() []string {
	k.mu.Lock()
	defer k.mu.Unlock()
	return slices.Clone(k.seen)
}

func keyedChannel(t *testing.T, state *appstate.State, name, baseURL string, priority int32,
	keys ...models.UpstreamKeyIn) int64 {
	t.Helper()
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL, input.Priority = name, baseURL, priority
	input.ModelNames = []string{"test-model"}
	input.Keys = &keys
	created, err := db.CreateUpstream(context.Background(), state.DB, &input)
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	return created.ID
}

func keyState(t *testing.T) (*appstate.State, http.Handler) {
	t.Helper()
	state := proxyRateLimitState(t)
	state.Keys = proxy.NewKeyPicker()
	insertCallerToken(t, state.DB, "caller-token")
	return state, proxyRateLimitRouter(state)
}

func disabled() *bool { v := false; return &v }

func TestRequestsRotateOverTheEnabledKeys(t *testing.T) {
	state, router := keyState(t)
	server, upstream := keyedUpstream(t, nil)
	keyedChannel(t, state, "multi", server.URL, 100,
		models.UpstreamKeyIn{APIKey: "sk-a"}, models.UpstreamKeyIn{APIKey: "sk-b"},
		models.UpstreamKeyIn{APIKey: "sk-off", Enabled: disabled()})

	for range 4 {
		if code := sendProxyRequest(router, "caller-token").Code; code != http.StatusOK {
			t.Fatalf("status %d", code)
		}
	}
	if got := upstream.keys(); !slices.Equal(got, []string{"sk-a", "sk-b", "sk-a", "sk-b"}) {
		t.Errorf("keys sent = %v, want a and b in turn, never the disabled one", got)
	}
}

// A key the upstream turns away hands the request to the channel's next key,
// sits out, and is passed over by the requests after it. The log names each.
func TestARefusedKeyHandsTheRequestToTheChannelsNextKey(t *testing.T) {
	for _, status := range []int{http.StatusUnauthorized, http.StatusForbidden, http.StatusTooManyRequests} {
		t.Run(http.StatusText(status), func(t *testing.T) {
			state, router := keyState(t)
			server, upstream := keyedUpstream(t, map[string]int{"sk-bad": status})
			keyedChannel(t, state, "multi", server.URL, 100,
				models.UpstreamKeyIn{Name: "bad", APIKey: "sk-bad"},
				models.UpstreamKeyIn{Name: "good", APIKey: "sk-good"})

			for range 2 {
				if code := sendProxyRequest(router, "caller-token").Code; code != http.StatusOK {
					t.Fatalf("status %d", code)
				}
			}
			if got := upstream.keys(); !slices.Equal(got, []string{"sk-bad", "sk-good", "sk-good"}) {
				t.Errorf("keys sent = %v, want bad once, then good for both requests", got)
			}

			state.LogWriter.Close()
			rows, err := state.DB.Query("SELECT upstream_key_name, status_code FROM request_logs ORDER BY id")
			if err != nil {
				t.Fatal(err)
			}
			defer rows.Close()
			var logged []string
			for rows.Next() {
				var name string
				var code int
				rows.Scan(&name, &code)
				logged = append(logged, name+":"+http.StatusText(code))
			}
			want := []string{"bad:" + http.StatusText(status), "good:OK", "good:OK"}
			if !slices.Equal(logged, want) {
				t.Errorf("logged %v, want %v", logged, want)
			}
		})
	}
}

// Once every key of a channel has refused a request, it moves on to the next
// channel.
func TestARequestEveryKeyRefusedMovesToTheNextChannel(t *testing.T) {
	state, router := keyState(t)
	settings := state.Runtime.Get()
	settings.MaxRetries = 2
	state.Runtime.Set(settings)

	server, upstream := keyedUpstream(t, map[string]int{"sk-bad1": 401, "sk-bad2": 401})
	keyedChannel(t, state, "revoked", server.URL, 200,
		models.UpstreamKeyIn{APIKey: "sk-bad1"}, models.UpstreamKeyIn{APIKey: "sk-bad2"})
	keyedChannel(t, state, "spare", server.URL, 100, models.UpstreamKeyIn{APIKey: "sk-spare"})

	if code := sendProxyRequest(router, "caller-token").Code; code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if got := upstream.keys(); !slices.Equal(got, []string{"sk-bad1", "sk-bad2", "sk-spare"}) {
		t.Errorf("keys sent = %v, want both revoked keys, then the spare channel", got)
	}
}

// A channel whose keys all sit out waits while another can serve, and is used
// when none can.
func TestAChannelWhoseKeysAllSitOutWaitsForTheOthers(t *testing.T) {
	state, router := keyState(t)
	server, upstream := keyedUpstream(t, nil)
	cooling := keyedChannel(t, state, "cooling", server.URL, 200, models.UpstreamKeyIn{APIKey: "sk-cooling"})
	spare := keyedChannel(t, state, "spare", server.URL, 100, models.UpstreamKeyIn{APIKey: "sk-spare"})
	keys, _ := db.ListUpstreamKeys(context.Background(), state.DB, cooling)
	state.Keys.Bench(keys[0].ID, 0)

	sendProxyRequest(router, "caller-token")
	if got := upstream.keys(); !slices.Equal(got, []string{"sk-spare"}) {
		t.Fatalf("keys sent = %v, want the spare channel's", got)
	}

	if _, err := db.DeleteUpstream(context.Background(), state.DB, spare); err != nil {
		t.Fatal(err)
	}
	state.Routing.Invalidate()
	if code := sendProxyRequest(router, "caller-token").Code; code != http.StatusOK {
		t.Fatalf("status %d", code)
	}
	if got := upstream.keys(); !slices.Equal(got, []string{"sk-spare", "sk-cooling"}) {
		t.Errorf("keys sent = %v, want the cooling channel once it is the only one", got)
	}
}

// Reads describe keys by name and state; a key's value leaves only when asked
// for, one at a time, and only from its own channel.
func TestKeysStayOnTheServerUntilAsked(t *testing.T) {
	state, _ := keyState(t)
	channel := keyedChannel(t, state, "multi", "https://api.example.com", 100,
		models.UpstreamKeyIn{Name: "main", APIKey: "sk-main"},
		models.UpstreamKeyIn{Name: "spare", APIKey: "sk-spare", Enabled: disabled()})
	other := keyedChannel(t, state, "other", "https://api.example.com", 100,
		models.UpstreamKeyIn{APIKey: "sk-other"})
	ctx := context.Background()
	keys, _ := db.ListUpstreamKeys(ctx, state.DB, channel)
	otherKeys, _ := db.ListUpstreamKeys(ctx, state.DB, other)

	router := chi.NewRouter()
	router.Get("/api/admin/upstreams/{id}", AdminGetUpstream(state))
	router.Get("/api/admin/upstreams/{id}/credential", AdminRevealUpstreamKey(state))
	get := func(path string) *httptest.ResponseRecorder {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		return recorder
	}

	detail := get("/api/admin/upstreams/" + itoa(channel))
	if strings.Contains(detail.Body.String(), "sk-") {
		t.Errorf("the detail carries a key value: %s", detail.Body)
	}
	var out models.UpstreamDetailOut
	json.Unmarshal(detail.Body.Bytes(), &out)
	if len(out.Keys) != 2 || out.Keys[0].Name != "main" || out.Keys[1].Enabled {
		t.Errorf("detail keys = %+v", out.Keys)
	}

	for path, want := range map[string]string{
		"/api/admin/upstreams/" + itoa(channel) + "/credential":                            "sk-main",
		"/api/admin/upstreams/" + itoa(channel) + "/credential?key_id=" + itoa(keys[1].ID): "sk-spare",
	} {
		var credential models.UpstreamCredentialOut
		json.Unmarshal(get(path).Body.Bytes(), &credential)
		if credential.APIKey != want {
			t.Errorf("%s gave %q, want %q", path, credential.APIKey, want)
		}
	}
	if code := get("/api/admin/upstreams/" + itoa(channel) + "/credential?key_id=" +
		itoa(otherKeys[0].ID)).Code; code != http.StatusNotFound {
		t.Errorf("another channel's key: status %d, want 404", code)
	}
}

// While a request is out, the in-flight view names the key it went with.
func TestAnInFlightRequestNamesItsKey(t *testing.T) {
	state, router := keyState(t)
	state.ActiveRequests = proxy.NewActiveRegistry()

	arrived, release := make(chan struct{}), make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(arrived)
		<-release
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(`{"ok":true}`))
	}))
	t.Cleanup(server.Close)
	channel := keyedChannel(t, state, "multi", server.URL, 100,
		models.UpstreamKeyIn{Name: "main", APIKey: "sk-main"})
	keys, _ := db.ListUpstreamKeys(context.Background(), state.DB, channel)

	done := make(chan int)
	go func() { done <- sendProxyRequest(router, "caller-token").Code }()
	<-arrived

	requests := state.ActiveRequests.Snapshot().Requests
	close(release)
	if len(requests) != 1 || requests[0].UpstreamKeyID != keys[0].ID ||
		requests[0].UpstreamKeyName != "main" {
		t.Errorf("in flight = %+v, want key %d main", requests, keys[0].ID)
	}
	if code := <-done; code != http.StatusOK {
		t.Errorf("status %d", code)
	}
}
