package app

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/config"
)

func TestRouterLoadsDesktopResourcesOutsideTheDataDirectory(t *testing.T) {
	resources := t.TempDir()
	for name, value := range map[string]string{
		"web/dist/index.html":    "<title>bundled-console</title>",
		"web/dist/assets/app.js": "bundled-script",
		"static/styles.css":      "bundled-style",
		"themes/ark/theme.css":   "bundled-theme",
	} {
		path := filepath.Join(resources, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(value), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	t.Chdir(t.TempDir())
	settings := config.Default()
	settings.ResourcesDir = resources
	settings.Themes.Dir = filepath.Join(resources, "themes")
	router := NewRouter(&appstate.State{Settings: settings})
	for path, want := range map[string]string{
		"/console": "bundled-console", "/console/assets/app.js": "bundled-script",
		"/static/styles.css": "bundled-style", "/theme-packs/ark/theme.css": "bundled-theme",
	} {
		response := httptest.NewRecorder()
		router.ServeHTTP(response, httptest.NewRequest(http.MethodGet, path, nil))
		if response.Code != http.StatusOK || !strings.Contains(response.Body.String(), want) {
			t.Errorf("%s = %d %q", path, response.Code, response.Body.String())
		}
	}
}

func TestCLIResourcesRemainWorkingDirectoryRelative(t *testing.T) {
	settings := config.Default()
	if path := settings.ResourcePath("static", "styles.css"); path != filepath.Join("static", "styles.css") {
		t.Fatalf("CLI resource path changed: %s", path)
	}
}
