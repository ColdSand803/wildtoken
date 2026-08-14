package apperr

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestAWrappedAppErrorKeepsItsOwnStatus(t *testing.T) {
	// A bare type assertion missed anything a layer had wrapped with %w, so a
	// not-found that passed through one turned into a 500.
	wrapped := fmt.Errorf("loading the channel: %w", NotFound("upstream not found"))

	recorder := httptest.NewRecorder()
	WriteError(recorder, wrapped)

	if recorder.Code != http.StatusNotFound {
		t.Errorf("status = %d, want 404 for a wrapped not-found", recorder.Code)
	}

	var appErr *AppError
	if !errors.As(wrapped, &appErr) {
		t.Fatal("errors.As did not find the wrapped AppError")
	}
	if appErr.Kind != KindNotFound {
		t.Errorf("kind = %v, want KindNotFound", appErr.Kind)
	}
}

func TestErrorKindsMapOntoTheirStatuses(t *testing.T) {
	for _, testCase := range []struct {
		err        *AppError
		wantStatus int
	}{
		{NotFound("gone"), http.StatusNotFound},
		{BadRequest("bad"), http.StatusBadRequest},
		{Conflict("taken"), http.StatusConflict},
		{Upstream("upstream said no"), http.StatusBadGateway},
		{Internal("the detail that used to vanish"), http.StatusInternalServerError},
	} {
		status, message := testCase.err.StatusAndMessage()
		if status != testCase.wantStatus {
			t.Errorf("%v status = %d, want %d", testCase.err.Kind, status, testCase.wantStatus)
		}
		if message == "" {
			t.Errorf("%v produced an empty message", testCase.err.Kind)
		}
	}
}
