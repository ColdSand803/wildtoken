package app

import (
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/imagestore"
)

// consoleFixture has two inline scripts, as web/index.html does, and the
// bundle's module script, which 'self' covers.
const consoleFixture = `<!doctype html>
<html>
  <head>
    <script>
      document.documentElement.setAttribute("data-theme", "dark");
    </script>
    <script type="module" crossorigin src="/console/assets/index.js"></script>
    <SCRIPT>document.write('<link rel="stylesheet" href="/x.css" />');</SCRIPT>
  </head>
</html>
`

func scriptHash(body string) string {
	sum := sha256.Sum256([]byte(body))
	return "'sha256-" + base64.StdEncoding.EncodeToString(sum[:]) + "'"
}

// Each inline script is allowed by its hash; the bundle loads under 'self'.
func TestTheConsolePolicyAllowsItsInlineScriptsByHash(t *testing.T) {
	want := "script-src 'self' " +
		scriptHash("\n      document.documentElement.setAttribute(\"data-theme\", \"dark\");\n    ") + " " +
		scriptHash(`document.write('<link rel="stylesheet" href="/x.css" />');`) +
		"; " + policyTail

	if got := consolePolicy([]byte(consoleFixture)); got != want {
		t.Errorf("policy = %q\nwant     %q", got, want)
	}
}

// The browser's parser turns CRLF into LF before hashing, so a CRLF checkout
// gets the same hashes.
func TestACRLFCheckoutGetsTheSameHashes(t *testing.T) {
	crlf := strings.ReplaceAll(consoleFixture, "\n", "\r\n")
	if got, want := consolePolicy([]byte(crlf)), consolePolicy([]byte(consoleFixture)); got != want {
		t.Errorf("crlf policy = %q\nwant          %q", got, want)
	}
}

// The console side is hardened; the relay passes the upstream's answer through
// untouched; a saved image keeps its own sandbox policy.
func TestOnlyTheRelayIsLeftWithoutBrowserHeaders(t *testing.T) {
	t.Chdir(t.TempDir())
	writeFixture(t, filepath.Join("web", "dist", "index.html"), consoleFixture)

	images := t.TempDir()
	image := "2026-11-04/0123456789abcdef0123456789abcdef.png"
	writeFixture(t, filepath.Join(images, image), "\x89PNG")

	router := NewRouter(&appstate.State{
		Settings: config.Default(),
		Images:   imagestore.New(images, func() bool { return true }),
	})

	for _, c := range []struct {
		method, path string
		policy       string
		hardened     bool
	}{
		{http.MethodGet, "/console", consolePolicy([]byte(consoleFixture)), true},
		{http.MethodGet, "/api/admin/system", defaultPolicy, true},
		{http.MethodGet, "/images/" + image, "sandbox", true},
		{http.MethodPost, "/v1/chat/completions", "", false},
	} {
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, httptest.NewRequest(c.method, c.path, nil))
		header := recorder.Header()

		if got := header.Get("content-security-policy"); got != c.policy {
			t.Errorf("%s: csp = %q, want %q", c.path, got, c.policy)
		}

		frame, referrer := "", ""
		if c.hardened {
			frame, referrer = "DENY", "same-origin"
			if got := header.Get("x-content-type-options"); got != "nosniff" {
				t.Errorf("%s: nosniff = %q", c.path, got)
			}
		}
		if got := header.Get("x-frame-options"); got != frame {
			t.Errorf("%s: x-frame-options = %q, want %q", c.path, got, frame)
		}
		if got := header.Get("referrer-policy"); got != referrer {
			t.Errorf("%s: referrer-policy = %q, want %q", c.path, got, referrer)
		}
	}
}

func writeFixture(t *testing.T, path, content string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}
