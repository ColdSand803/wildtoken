package app

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// A redirect to another host leaves the channel's credentials behind: Go drops
// Authorization on its own, but x-api-key and override headers went along.
func TestARedirectToAnotherHostCarriesNoCredentials(t *testing.T) {
	received := make(chan http.Header, 1)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		received <- r.Header.Clone()
	}))
	defer target.Close()
	origin := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL+"/moved", http.StatusTemporaryRedirect)
	}))
	defer origin.Close()

	client := newHTTPClient(func() models.RuntimeSettings { return models.DefaultRuntimeSettings() })
	request, _ := http.NewRequest(http.MethodGet, origin.URL, nil)
	request.Header.Set("x-api-key", "channel-key")
	request.Header.Set("x-custom-token", "override-secret")
	request.Header.Set("x-region", "eu")
	response, err := client.Do(request)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()

	headers := <-received
	if headers.Get("x-api-key") != "" || headers.Get("x-custom-token") != "" {
		t.Errorf("credentials reached the other host: %v", headers)
	}
	if headers.Get("x-region") != "eu" {
		t.Error("an ordinary header was dropped too")
	}
}

func TestARedirectDowngradingToHTTPIsRefused(t *testing.T) {
	original, _ := http.NewRequest(http.MethodGet, "https://api.example.com/v1", nil)
	downgraded, _ := http.NewRequest(http.MethodGet, "http://api.example.com/v1", nil)
	if err := guardRedirect(downgraded, original); err == nil {
		t.Error("a redirect from https to http was followed")
	}
}

// The database holds keys and tokens in the clear, so it and its journal are
// the owner's alone, whether created now or found open to others.
func TestTheDatabaseIsReadableByItsOwnerAlone(t *testing.T) {
	directory := t.TempDir()
	fresh := filepath.Join(directory, "fresh.db")
	restrictDatabaseFiles(fresh)

	existing := filepath.Join(directory, "existing.db")
	for _, name := range []string{existing, existing + "-wal"} {
		if err := os.WriteFile(name, nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	restrictDatabaseFiles(existing)

	for _, name := range []string{fresh, existing, existing + "-wal"} {
		info, err := os.Stat(name)
		if err != nil {
			t.Fatal(err)
		}
		if perm := info.Mode().Perm(); perm != 0o600 {
			t.Errorf("%s mode = %o, want 600", filepath.Base(name), perm)
		}
	}
}
