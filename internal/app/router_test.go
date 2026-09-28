package app

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// A preflight for a Bearer request names Authorization, which a bare "*" does
// not cover: the browser refused every such call from a web client.
func TestAPreflightIsAnsweredWithTheHeadersItAskedFor(t *testing.T) {
	handler := allowAnyOrigin(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		t.Error("a preflight reached the handler")
	}))
	request := httptest.NewRequest(http.MethodOptions, "/v1/chat/completions", nil)
	request.Header.Set("access-control-request-headers", "authorization, content-type")
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusNoContent {
		t.Errorf("status = %d, want 204", recorder.Code)
	}
	if got := recorder.Header().Get("access-control-allow-headers"); got != "authorization, content-type" {
		t.Errorf("allow-headers = %q, want the requested headers", got)
	}
}

// The mount point arrives with an empty path once its prefix is stripped, which
// the FileServer turned into "/" and listed.
func TestTheStaticMountPointIsNotListed(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "app.css"), []byte("body{}"), 0o644); err != nil {
		t.Fatal(err)
	}
	handler := http.StripPrefix("/static", noDirectoryListing(http.FileServer(http.Dir(dir))))

	for path, want := range map[string]int{
		"/static":         http.StatusNotFound,
		"/static/":        http.StatusNotFound,
		"/static/app.css": http.StatusOK,
	} {
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet, path, nil))
		if recorder.Code != want {
			t.Errorf("%s: status %d, want %d", path, recorder.Code, want)
		}
	}
}

// An IPv6 host is bracketed; "http://::1:3100" names nothing a browser opens.
func TestTheAdminURLBracketsAnIPv6Host(t *testing.T) {
	if got := AdminURLFromSettings("::1", 3100); got != "http://[::1]:3100/console" {
		t.Errorf("url = %q", got)
	}
	if got := AdminURLFromSettings("0.0.0.0", 3100); got != "http://127.0.0.1:3100/console" {
		t.Errorf("url = %q", got)
	}
}
