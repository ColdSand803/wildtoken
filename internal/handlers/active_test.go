package handlers

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/proxy"
)

// The count is for a deploy asking from inside the container; a forwarding
// header claiming loopback does not make a remote caller local.
func TestActiveCountAnswersOnlyThisMachine(t *testing.T) {
	state := &appstate.State{ActiveRequests: proxy.NewActiveRegistry()}
	handle := state.ActiveRequests.Begin(http.MethodPost, "/v1/chat/completions")
	defer handle.Release()

	for addr, want := range map[string]int{
		"127.0.0.1:50000":  http.StatusOK,
		"[::1]:50000":      http.StatusOK,
		"192.0.2.10:50000": http.StatusNotFound,
	} {
		request := httptest.NewRequest(http.MethodGet, "/health/active", nil)
		request.RemoteAddr = addr
		request.Header.Set("x-forwarded-for", "127.0.0.1")
		recorder := httptest.NewRecorder()
		ActiveCount(state)(recorder, request)

		if recorder.Code != want {
			t.Errorf("%s: status %d, want %d", addr, recorder.Code, want)
			continue
		}
		if want != http.StatusOK {
			continue
		}
		var body struct{ Active int }
		if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil || body.Active != 1 {
			t.Errorf("%s: body %s, want one active request", addr, recorder.Body)
		}
	}
}
