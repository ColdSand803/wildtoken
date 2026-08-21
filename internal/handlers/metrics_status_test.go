package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// systemInfoTestState is the shared channel-list fixture, which already carries
// everything the system info endpoint reads.
func systemInfoTestState(t *testing.T) *appstate.State {
	t.Helper()
	return upstreamTestState(t)
}

// systemInfoMetricsStatus reads the scrape endpoint's reported policy out of the
// system info endpoint.
func systemInfoMetricsStatus(t *testing.T, state *appstate.State) models.MetricsEndpointStatusOut {
	t.Helper()

	recorder := httptest.NewRecorder()
	AdminSystemInfo(state)(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/system", nil))
	if recorder.Code != http.StatusOK {
		t.Fatalf("got %d from system info: %s", recorder.Code, recorder.Body.String())
	}

	var payload models.SystemInfoOut
	if err := json.Unmarshal(recorder.Body.Bytes(), &payload); err != nil {
		t.Fatalf("decode system info: %v", err)
	}
	return payload.MetricsEndpoint
}

// TestTheConsoleIsToldTheScrapePolicyWithoutTheToken is the whole point of the
// field: the console has to be able to say whether the endpoint is exposed and
// guarded, and it must be able to do so without the credential passing through a
// browser.
func TestTheConsoleIsToldTheScrapePolicyWithoutTheToken(t *testing.T) {
	state := systemInfoTestState(t)
	state.Settings.Metrics = config.MetricsSettings{Enabled: true, Token: "scrape-secret"}

	status := systemInfoMetricsStatus(t, state)
	if !status.Enabled {
		t.Error("an enabled endpoint reported as disabled")
	}
	if !status.TokenRequired {
		t.Error("a configured token was not reported as required")
	}
	if status.Path != "/metrics" {
		t.Errorf("path = %q, want /metrics so the console need not hardcode it", status.Path)
	}
	if !status.ConfiguredByFile {
		t.Error("the policy must be marked file-configured, or the console offers a switch that cannot save")
	}

	// The token itself must not be anywhere in the response. The console has no use
	// for it, and a credential rendered into a long-lived tab ends up in a
	// screenshot.
	recorder := httptest.NewRecorder()
	AdminSystemInfo(state)(recorder, httptest.NewRequest(http.MethodGet, "/api/admin/system", nil))
	if body := recorder.Body.String(); strings.Contains(body, "scrape-secret") {
		t.Errorf("the scrape token leaked into system info:\n%s", body)
	}
}

// TestTheOpenConfigurationIsDistinguishableFromTheGuardedOne: an enabled endpoint
// with no token is the case worth surfacing, so it must not read the same as a
// guarded one.
func TestTheOpenConfigurationIsDistinguishableFromTheGuardedOne(t *testing.T) {
	for name, testCase := range map[string]struct {
		settings          config.MetricsSettings
		wantEnabled       bool
		wantTokenRequired bool
	}{
		"disabled": {
			settings: config.MetricsSettings{Enabled: false, Token: ""},
		},
		// A token configured while disabled is still disabled: the endpoint answers
		// 404, so reporting it as guarded would suggest it serves.
		"disabled with a token": {
			settings:          config.MetricsSettings{Enabled: false, Token: "unused"},
			wantTokenRequired: true,
		},
		"enabled and open": {
			settings:    config.MetricsSettings{Enabled: true, Token: ""},
			wantEnabled: true,
		},
		// Whitespace is not a token. The handler trims before comparing, so
		// reporting this as guarded would contradict what the endpoint does.
		"enabled with only whitespace": {
			settings:    config.MetricsSettings{Enabled: true, Token: "   "},
			wantEnabled: true,
		},
		"enabled and guarded": {
			settings:          config.MetricsSettings{Enabled: true, Token: "secret"},
			wantEnabled:       true,
			wantTokenRequired: true,
		},
	} {
		t.Run(name, func(t *testing.T) {
			state := systemInfoTestState(t)
			state.Settings.Metrics = testCase.settings

			status := systemInfoMetricsStatus(t, state)
			if status.Enabled != testCase.wantEnabled {
				t.Errorf("enabled = %v, want %v", status.Enabled, testCase.wantEnabled)
			}
			if status.TokenRequired != testCase.wantTokenRequired {
				t.Errorf("token_required = %v, want %v", status.TokenRequired, testCase.wantTokenRequired)
			}
		})
	}
}

// TestTheReportedPolicyMatchesWhatTheEndpointDoes ties the two together. The card
// is only useful while it agrees with the handler; asserting each separately would
// let them drift into a console that says "guarded" about an open endpoint.
func TestTheReportedPolicyMatchesWhatTheEndpointDoes(t *testing.T) {
	for name, settings := range map[string]config.MetricsSettings{
		"disabled":         {Enabled: false},
		"enabled and open": {Enabled: true},
		"enabled guarded":  {Enabled: true, Token: "secret"},
	} {
		t.Run(name, func(t *testing.T) {
			state := systemInfoTestState(t)
			state.Settings.Metrics = settings
			status := systemInfoMetricsStatus(t, state)

			unauthenticated := scrape(state, "")
			switch {
			case !status.Enabled:
				if unauthenticated.Code != http.StatusNotFound {
					t.Errorf("reported disabled but the endpoint answered %d",
						unauthenticated.Code)
				}
			case status.TokenRequired:
				if unauthenticated.Code != http.StatusUnauthorized {
					t.Errorf("reported guarded but an unauthenticated scrape got %d",
						unauthenticated.Code)
				}
			default:
				if unauthenticated.Code != http.StatusOK {
					t.Errorf("reported open but an unauthenticated scrape got %d",
						unauthenticated.Code)
				}
			}
		})
	}
}
