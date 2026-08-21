package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/metrics"
)

// metricsState builds a state with the scrape endpoint configured a given way.
func metricsState(t *testing.T, enabled bool, token string) *appstate.State {
	t.Helper()
	settings := config.Default()
	settings.Metrics = config.MetricsSettings{Enabled: enabled, Token: token}
	return &appstate.State{Settings: settings, Prometheus: metrics.NewPrometheus()}
}

// usageReportingUpstream answers with a body carrying the usage block a provider
// returns, so the token counters have something real to record.
func usageReportingUpstream(t *testing.T, promptTokens, completionTokens,
	cachedTokens int) *httptest.Server {
	t.Helper()
	body := `{"id":"x","choices":[{"message":{"content":"hi"}}],"usage":{` +
		`"prompt_tokens":` + itoa(int64(promptTokens)) +
		`,"completion_tokens":` + itoa(int64(completionTokens)) +
		`,"total_tokens":` + itoa(int64(promptTokens+completionTokens)) +
		`,"prompt_tokens_details":{"cached_tokens":` + itoa(int64(cachedTokens)) + `}}}`

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.Write([]byte(body))
	}))
	t.Cleanup(server.Close)
	return server
}

func scrape(state *appstate.State, bearer string) *httptest.ResponseRecorder {
	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	if bearer != "" {
		request.Header.Set("authorization", "Bearer "+bearer)
	}
	recorder := httptest.NewRecorder()
	PrometheusMetrics(state)(recorder, request)
	return recorder
}

// TestTheEndpointIsClosedByDefault is the safe default the checklist requires: an
// upgrade must not begin publishing traffic volumes and channel health.
func TestTheEndpointIsClosedByDefault(t *testing.T) {
	// config.Default is what a deployment with no metrics section gets.
	if config.Default().Metrics.Enabled {
		t.Fatal("metrics are enabled by default")
	}

	response := scrape(metricsState(t, false, ""), "")
	// 404 rather than 403: 403 confirms the endpoint exists and is merely closed,
	// which tells a scanner something about the deployment.
	if response.Code != http.StatusNotFound {
		t.Errorf("got %d, want 404 while disabled: %s", response.Code, response.Body.String())
	}
	if strings.Contains(response.Body.String(), "wildtoken_") {
		t.Error("a disabled endpoint served metrics")
	}
}

// TestAConfiguredTokenIsRequired covers the auth gate.
func TestAConfiguredTokenIsRequired(t *testing.T) {
	state := metricsState(t, true, "scrape-secret")

	for name, bearer := range map[string]string{
		"no credential":   "",
		"wrong token":     "not-the-secret",
		"prefix of it":    "scrape",
		"extended by one": "scrape-secretx",
	} {
		t.Run(name, func(t *testing.T) {
			if response := scrape(state, bearer); response.Code != http.StatusUnauthorized {
				t.Errorf("got %d, want 401", response.Code)
			}
		})
	}

	response := scrape(state, "scrape-secret")
	if response.Code != http.StatusOK {
		t.Fatalf("got %d for the correct token: %s", response.Code, response.Body.String())
	}
	if !strings.Contains(response.Body.String(), "wildtoken_http_requests_total") {
		t.Errorf("body does not look like an exposition:\n%s", response.Body.String())
	}
	// The content type Prometheus's own exposition sends, so a scraper does not
	// have to sniff the body.
	if got := response.Header().Get("content-type"); !strings.HasPrefix(got, "text/plain") {
		t.Errorf("content-type = %q, want text/plain", got)
	}
}

// TestAnEnabledEndpointWithNoTokenServesAnyone documents the open configuration.
//
// Allowed, because a listener bound to loopback or a private network is a real
// deployment — the server warns at startup so it is never an accident.
func TestAnEnabledEndpointWithNoTokenServesAnyone(t *testing.T) {
	state := metricsState(t, true, "")
	if response := scrape(state, ""); response.Code != http.StatusOK {
		t.Errorf("got %d, want 200 for an intentionally open endpoint", response.Code)
	}
	// And that configuration is the one the startup warning keys on.
	if !state.Settings.Metrics.EnabledWithoutToken() {
		t.Error("EnabledWithoutToken did not recognise the open configuration")
	}
	// A token configured means the warning does not fire.
	if metricsState(t, true, "x").Settings.Metrics.EnabledWithoutToken() {
		t.Error("EnabledWithoutToken fired with a token configured")
	}
}

// TestTheAdminHeaderIsNotAcceptedHere keeps the two credentials separate. Prometheus
// keeps its scrape config in plain text, so sharing the console's credential would
// put that credential there too.
func TestTheAdminHeaderIsNotAcceptedHere(t *testing.T) {
	state := metricsState(t, true, "scrape-secret")

	request := httptest.NewRequest(http.MethodGet, "/metrics", nil)
	request.Header.Set("x-admin-token", "change-me")
	recorder := httptest.NewRecorder()
	PrometheusMetrics(state)(recorder, request)

	if recorder.Code != http.StatusUnauthorized {
		t.Errorf("got %d, want the admin header rejected on the scrape endpoint", recorder.Code)
	}
}

// TestScrapeSeriesRecordTheLabelsTheLogRowCarries is P3-1 end to end: a real
// proxied request must move the counters.
func TestScrapeSeriesRecordTheLabelsTheLogRowCarries(t *testing.T) {
	state := noBackoffState(t)
	upstream := usageReportingUpstream(t, 1200, 300, 0)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "primary", upstream.URL, 100, nil)
	router := proxyRateLimitRouter(state)

	if response := sendProxyRequestForModel(router, "caller-token",
		`{"model":"test-model"}`); response.Code != http.StatusOK {
		t.Fatalf("got %d: %s", response.Code, response.Body.String())
	}

	rendered := state.Prometheus.Render()
	if !strings.Contains(rendered, `status_class="2xx"`) {
		t.Errorf("no 2xx series after a successful request:\n%s", rendered)
	}
	if !strings.Contains(rendered, `protocol="openai"`) {
		t.Errorf("no openai protocol label:\n%s", rendered)
	}
	// The usage reached the token counters.
	if !strings.Contains(rendered, `wildtoken_tokens_total{type="prompt"} 1200`) {
		t.Errorf("prompt tokens not recorded:\n%s", rendered)
	}
	if !strings.Contains(rendered, `wildtoken_tokens_total{type="completion"} 300`) {
		t.Errorf("completion tokens not recorded:\n%s", rendered)
	}
	// The model the client asked for must not appear anywhere: it is client-supplied
	// text, and a label built from it is unbounded cardinality.
	if strings.Contains(rendered, "test-model") {
		t.Errorf("the model name leaked into the exposition:\n%s", rendered)
	}
}

// TestARefusedRequestIsStillCounted: a scrape has to show failures, and the counters
// must not depend on the log row committing — an alert on traffic must not go quiet
// exactly when logging is in trouble.
func TestARefusedRequestIsStillCounted(t *testing.T) {
	state := noBackoffState(t)

	insertCallerToken(t, state.DB, "caller-token")
	restrictCallerToken(t, state.DB, `["only-this-model"]`)
	createChannel(t, state, "primary", "http://127.0.0.1:1/v1", 100, nil)
	router := proxyRateLimitRouter(state)

	if response := sendProxyRequestForModel(router, "caller-token",
		`{"model":"some-other-model"}`); response.Code != http.StatusForbidden {
		t.Fatalf("got %d, want the whitelist refusal", response.Code)
	}

	rendered := state.Prometheus.Render()
	if !strings.Contains(rendered, `status_class="4xx"`) {
		t.Errorf("the 403 was not counted:\n%s", rendered)
	}
	// It reached no channel, so it is recorded under channel 0 rather than dropped:
	// "requests that never routed" is what an alert on a misconfigured gateway needs.
	if !strings.Contains(rendered, `upstream_id="0"`) {
		t.Errorf("a request that reached no channel was not counted:\n%s", rendered)
	}
}

// TestTheTwoPackagesLabelConstantsAgree guards the duplication.
//
// internal/proxy holds its own copies so it need not import internal/metrics (see
// proxy.ScrapeRecorder). That duplication is only safe while the values match, and
// a drift would silently split every series in two.
func TestTheTwoPackagesLabelConstantsAgree(t *testing.T) {
	state := noBackoffState(t)
	upstream := usageReportingUpstream(t, 10, 10, 0)
	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "primary", upstream.URL, 100, nil)

	if response := sendProxyRequestForModel(proxyRateLimitRouter(state), "caller-token",
		`{"model":"test-model"}`); response.Code != http.StatusOK {
		t.Fatalf("got %d", response.Code)
	}

	// The values the proxy package wrote must be the ones the metrics package
	// declares, or the label would not match what a dashboard queries.
	rendered := state.Prometheus.Render()
	if !strings.Contains(rendered, `status_class="`+metrics.StatusClass2xx+`"`) {
		t.Errorf("proxy wrote a status class metrics does not declare:\n%s", rendered)
	}
	if !strings.Contains(rendered, `protocol="`+metrics.ProtocolOpenAI+`"`) {
		t.Errorf("proxy wrote a protocol metrics does not declare:\n%s", rendered)
	}
	for _, kind := range []string{metrics.TokenKindPrompt, metrics.TokenKindCompletion} {
		if !strings.Contains(rendered, `type="`+kind+`"`) {
			t.Errorf("token kind %q missing from the exposition:\n%s", kind, rendered)
		}
	}
}
