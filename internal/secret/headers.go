package secret

import "strings"

// RedactedHeaders names common credential headers.
var RedactedHeaders = []string{
	"authorization", "api-key", "x-api-key", "cookie", "set-cookie",
	"proxy-authorization", "proxy-authenticate", "x-admin-token",
	"x-auth-token", "x-access-token", "x-goog-api-key", "x-amz-security-token",
}

var sensitiveHeaderParts = map[string]bool{
	"auth": true, "authorization": true, "apikey": true,
	"credential": true, "credentials": true, "key": true, "secret": true,
	"signature": true, "token": true, "cookie": true,
}

// IsSensitiveHeaderName is shared by storage, logging and redirect filtering.
func IsSensitiveHeaderName(name string) bool {
	for _, header := range RedactedHeaders {
		if strings.EqualFold(name, header) {
			return true
		}
	}
	for _, part := range strings.FieldsFunc(strings.ToLower(name), func(r rune) bool {
		return r == '-' || r == '_'
	}) {
		if sensitiveHeaderParts[part] {
			return true
		}
	}
	return false
}
