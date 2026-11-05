package handlers

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// The log page's client filter reads this list, so its shape is pinned here.
func TestLogClientTypesListsTheClientsInTheLogs(t *testing.T) {
	state := upstreamTestState(t)
	for _, clientType := range []string{"pi", "axonhub", "pi"} {
		if _, err := state.DB.Exec(
			"INSERT INTO request_logs (method, path, client_type) VALUES ('POST', 'chat/completions', ?)",
			clientType); err != nil {
			t.Fatal(err)
		}
	}

	recorder := httptest.NewRecorder()
	AdminListLogClientTypes(state).ServeHTTP(recorder,
		httptest.NewRequest(http.MethodGet, "/api/admin/logs/clients", nil))
	body := strings.TrimSpace(recorder.Body.String())
	if recorder.Code != http.StatusOK || body != `{"client_types":["axonhub","pi"]}` {
		t.Errorf("status %d, body %s", recorder.Code, body)
	}
}
