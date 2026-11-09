package proxy

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// ResponseCredentialDigest detects an edited account or base URL before a
// stored response is sent there. Only the digest is persisted.
func ResponseCredentialDigest(upstream *models.UpstreamRow, headers map[string]string) string {
	credentials := map[string]string{}
	for name, value := range headers {
		if IsSensitiveHeaderName(name) {
			credentials[name] = value
		}
	}
	var overrides map[string]string
	json.Unmarshal([]byte(upstream.ExtraHeaders), &overrides)
	encoded, _ := json.Marshal([]any{upstream.BaseURL, overrides, credentials})
	sum := sha256.Sum256(encoded)
	return hex.EncodeToString(sum[:])
}

func responseID(body []byte) string {
	var payload struct {
		ID       string `json:"id"`
		Response *struct {
			ID string `json:"id"`
		} `json:"response"`
	}
	if json.Unmarshal(body, &payload) != nil {
		return ""
	}
	if payload.Response != nil {
		return payload.Response.ID
	}
	return payload.ID
}
