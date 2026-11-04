package app

import (
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"net/http"
	"regexp"
	"strings"
)

// policyTail is the part of the Content-Security-Policy every console-side
// response shares. Scripts are what the policy locks down: the admin token
// sits in localStorage, within reach of any script on this origin. Styles,
// fonts, images and connections stay open, since the console loads Google
// Fonts and theme packs and shows images from wherever an upstream put them.
const policyTail = "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'"

// defaultPolicy covers every console-side response but index.html, none of
// which needs an inline script.
const defaultPolicy = "script-src 'self'; " + policyTail

// inlineScript matches a script element, capturing its attributes and body.
var inlineScript = regexp.MustCompile(`(?is)<script([^>]*)>(.*?)</script>`)

// securityHeaders limits what a browser may do with a response: which scripts
// run, who may frame it, whether its type may be sniffed. A handler that sets
// its own policy replaces this one, as the image store does with "sandbox".
func securityHeaders(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		header := w.Header()
		header.Set("content-security-policy", defaultPolicy)
		header.Set("x-content-type-options", "nosniff")
		header.Set("x-frame-options", "DENY")
		header.Set("referrer-policy", "same-origin")
		next.ServeHTTP(w, r)
	})
}

// consolePolicy is index.html's policy: this origin's scripts plus the page's
// inline ones, allowed by hash. Computed from the bytes being served, so a
// rebuilt console needs no restart and no edit here.
//
// The browser hashes a script after its parser turns CRLF into LF. A checkout
// with CRLF endings is hashed the same way here, or its console would not run.
func consolePolicy(html []byte) string {
	sources := []string{"'self'"}
	for _, match := range inlineScript.FindAllSubmatch(html, -1) {
		if bytes.Contains(bytes.ToLower(match[1]), []byte("src=")) {
			continue
		}

		body := bytes.ReplaceAll(match[2], []byte("\r\n"), []byte("\n"))
		body = bytes.ReplaceAll(body, []byte("\r"), []byte("\n"))
		sum := sha256.Sum256(body)
		sources = append(sources, "'sha256-"+base64.StdEncoding.EncodeToString(sum[:])+"'")
	}
	return "script-src " + strings.Join(sources, " ") + "; " + policyTail
}
