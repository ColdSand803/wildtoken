package models

import "strings"

// ValidResponseID accepts one opaque path segment.
func ValidResponseID(id string) bool {
	return id != "" && len(id) <= 512 && id != "." && id != ".." &&
		!strings.ContainsAny(id, "/\\%?#") && !strings.ContainsFunc(id, func(r rune) bool {
		return r <= ' ' || r == 127
	})
}

// ResponseRoute binds provider state to the token and account that created it.
type ResponseRoute struct {
	ResponseID       string
	TokenID          int64
	UpstreamID       int64
	KeyID            int64
	CredentialDigest string
	RequestModel     string
}
