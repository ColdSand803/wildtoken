package handlers

import (
	"crypto/subtle"
	"net/http"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/appstate"
)

// PrometheusMetrics serves the scrape endpoint.
//
// Registered outside the admin router on purpose: Prometheus authenticates with a
// bearer token, not the console's `x-admin-token` header, and the two credentials
// are kept separate so a scrape config in plain text does not carry the credential
// that administers the gateway.
//
// A disabled endpoint answers 404 rather than 403. 403 confirms the endpoint exists
// and is merely closed, which tells a scanner something about the deployment; 404 is
// indistinguishable from a build without the feature.
func PrometheusMetrics(state *appstate.State) http.HandlerFunc {
	settings := state.Settings.Metrics

	return func(w http.ResponseWriter, r *http.Request) {
		if !settings.Enabled {
			http.NotFound(w, r)
			return
		}
		if !metricsTokenAccepted(r, settings.Token) {
			// No WWW-Authenticate header: this endpoint is for a configured
			// scraper, and advertising the scheme to an unauthenticated caller only
			// helps someone probing it.
			w.Header().Set("content-type", "text/plain; charset=utf-8")
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte("unauthorized\n"))
			return
		}

		// The version Prometheus's own exposition uses. Sending it keeps a scraper
		// from having to sniff the body.
		w.Header().Set("content-type", "text/plain; version=0.0.4; charset=utf-8")
		w.WriteHeader(http.StatusOK)
		w.Write([]byte(state.Prometheus.Render()))
	}
}

// metricsTokenAccepted checks the bearer token in constant time.
//
// A blank configured token means no authentication, which the server warns about at
// startup. Comparison is via subtle.ConstantTimeCompare rather than `==` because a
// scrape endpoint is polled on a timer by design: an attacker gets an unlimited
// supply of identically-shaped requests to time, which is the situation where a
// byte-by-byte early exit actually leaks.
func metricsTokenAccepted(r *http.Request, configured string) bool {
	configured = strings.TrimSpace(configured)
	if configured == "" {
		return true
	}

	scheme, credentials, found := strings.Cut(r.Header.Get("authorization"), " ")
	if !found || !strings.EqualFold(scheme, "bearer") {
		return false
	}
	presented := strings.TrimSpace(credentials)
	return subtle.ConstantTimeCompare([]byte(presented), []byte(configured)) == 1
}
