package db

import (
	"encoding/json"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/secret"
)

// A map containing a static credential is sealed as a whole. Placeholders
// contain no credential; damaged JSON remains available for console diagnosis.
func hasHeaderSecrets(stored string) bool {
	var headers map[string]string
	if json.Unmarshal([]byte(stored), &headers) != nil {
		return false
	}
	for name, value := range headers {
		if secret.IsSensitiveHeaderName(name) && value != "" &&
			!strings.HasPrefix(value, "{client_header:") {
			return true
		}
	}
	return false
}
