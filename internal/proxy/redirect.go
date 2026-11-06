package proxy

import (
	"context"
	"fmt"
	"net/http"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/models"
)

type relayRootKey struct{}

func markRelayRequest(request *http.Request, path string) *http.Request {
	root := strings.TrimSuffix(request.URL.Path, path)
	return request.WithContext(context.WithValue(request.Context(), relayRootKey{}, root))
}

// ValidateRelayRedirect keeps a relayed request inside its endpoint allowlist.
// Console probes carry no relay root and keep their own URL semantics.
func ValidateRelayRedirect(request, original *http.Request) error {
	root, relay := original.Context().Value(relayRootKey{}).(string)
	if !relay {
		return nil
	}
	path, underRoot := strings.CutPrefix(request.URL.Path, root)
	if !underRoot || !models.ProxyEndpointAllowed(request.Method, path) {
		return fmt.Errorf("upstream redirected outside the allowed endpoints")
	}
	return nil
}
