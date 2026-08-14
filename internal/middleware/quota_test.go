package middleware

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/ratelimit"
)

func TestAnExhaustedQuotaIsRefusedBeforeReachingAnUpstream(t *testing.T) {
	database := authTestDB(t)
	ctx := context.Background()

	created, err := db.CreateToken(ctx, database, &models.APITokenIn{
		Name: "limited", Enabled: true, LimitExpression: "1M",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	plaintext := created.Token

	// Just under the limit: the request is still admitted.
	if _, err := database.Exec(
		"UPDATE api_tokens SET used_tokens = 999999 WHERE id = ?", created.ID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	if status, _ := probeDownstream(t, database, plaintext); status != http.StatusOK {
		t.Errorf("a token below its limit got %d, want 200", status)
	}

	// At the limit exactly: refused. The request that crossed the limit was
	// already allowed to finish, so the boundary is "used >= limit".
	if _, err := database.Exec(
		"UPDATE api_tokens SET used_tokens = 1000000 WHERE id = ?", created.ID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}
	status, body := probeDownstream(t, database, plaintext)
	if status != http.StatusTooManyRequests {
		t.Fatalf("an exhausted token got %d, want 429", status)
	}

	// A quota refusal must not look like a bad credential: a client reading
	// invalid_api_key is expected to stop and have its key replaced, whereas this
	// is resolved by raising the limit or resetting usage.
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode body: %v", err)
	}
	errorObject, _ := decoded["error"].(map[string]any)
	message, _ := errorObject["message"].(string)
	if message == "" || message == "Incorrect API key provided" {
		t.Errorf("refusal message = %q, want it to name the quota", message)
	}
	if errorType, _ := errorObject["type"].(string); errorType != "insufficient_quota" {
		t.Errorf("error type = %q, want insufficient_quota", errorType)
	}
}

func TestAQuotaRefusalCarriesBothATopLevelCodeAndTheVendorShape(t *testing.T) {
	database := authTestDB(t)
	ctx := context.Background()

	created, err := db.CreateToken(ctx, database, &models.APITokenIn{
		Name: "limited", Enabled: true, LimitExpression: "1K",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := database.Exec(
		"UPDATE api_tokens SET used_tokens = 1000 WHERE id = ?", created.ID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	for _, route := range []struct {
		name, path, wantNestedType string
	}{
		{"openai", "/v1/chat/completions", "insufficient_quota"},
		{"anthropic", "/v1/messages", "rate_limit_error"},
	} {
		t.Run(route.name, func(t *testing.T) {
			limiter := ratelimit.NewLimiter()
			handler := RequireDownstream(database, limiter)(http.HandlerFunc(
				func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
			request := httptest.NewRequest(http.MethodPost, route.path, nil)
			request.Header.Set("authorization", "Bearer "+created.Token)
			recorder := httptest.NewRecorder()
			handler.ServeHTTP(recorder, request)

			if recorder.Code != http.StatusTooManyRequests {
				t.Fatalf("status = %d, want 429", recorder.Code)
			}

			var decoded map[string]any
			if err := json.Unmarshal(recorder.Body.Bytes(), &decoded); err != nil {
				t.Fatalf("decode: %v", err)
			}

			// A caller written against this proxy branches on the top level and
			// does not need to know which vendor dialect the route speaks.
			if decoded["code"] != QuotaExhaustedCode {
				t.Errorf("top-level code = %v, want %s", decoded["code"], QuotaExhaustedCode)
			}
			if decoded["message"] != QuotaExhaustedMessage {
				t.Errorf("top-level message = %v, want %s", decoded["message"], QuotaExhaustedMessage)
			}

			// A vendor SDK only looks inside error, so that shape has to survive.
			nested, ok := decoded["error"].(map[string]any)
			if !ok {
				t.Fatalf("error object missing: %s", recorder.Body.String())
			}
			if nested["type"] != route.wantNestedType {
				t.Errorf("nested type = %v, want %s", nested["type"], route.wantNestedType)
			}
			// The figures stay in the nested message where they were before.
			if message, _ := nested["message"].(string); !strings.Contains(message, "1K") {
				t.Errorf("nested message = %q, want the usage figures", message)
			}
		})
	}
}

func TestAQuotaRefusalIsDistinguishableFromABadKey(t *testing.T) {
	database := authTestDB(t)
	ctx := context.Background()

	created, err := db.CreateToken(ctx, database, &models.APITokenIn{
		Name: "limited", Enabled: true, LimitExpression: "1K",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := database.Exec(
		"UPDATE api_tokens SET used_tokens = 1000 WHERE id = ?", created.ID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	// A wrong key stays 401 invalid_api_key; an exhausted quota is 429
	// insufficient_quota. Collapsing the two would make a client give up on a
	// credential that is merely out of budget.
	badStatus, _ := probeDownstream(t, database, "not-a-real-token")
	if badStatus != http.StatusUnauthorized {
		t.Errorf("a wrong key got %d, want 401", badStatus)
	}
	quotaStatus, _ := probeDownstream(t, database, created.Token)
	if quotaStatus != http.StatusTooManyRequests {
		t.Errorf("an exhausted quota got %d, want 429", quotaStatus)
	}
}

func TestAnUnlimitedTokenIsNeverRefusedForQuota(t *testing.T) {
	database := authTestDB(t)
	ctx := context.Background()

	created, err := db.CreateToken(ctx, database, &models.APITokenIn{
		Name: "unlimited", Enabled: true,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// A large total must not trip a limit the token does not have.
	if _, err := database.Exec(
		"UPDATE api_tokens SET used_tokens = 999999999999 WHERE id = ?", created.ID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	if status, _ := probeDownstream(t, database, created.Token); status != http.StatusOK {
		t.Errorf("an unlimited token got %d, want 200", status)
	}
}

func TestTheAdmittedRequestCarriesItsQuotaState(t *testing.T) {
	database := authTestDB(t)
	ctx := context.Background()

	created, err := db.CreateToken(ctx, database, &models.APITokenIn{
		Name: "limited", Enabled: true, LimitExpression: "5M",
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if _, err := database.Exec(
		"UPDATE api_tokens SET used_tokens = 2000000 WHERE id = ?", created.ID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	var seen DownstreamAuth
	limiter := ratelimit.NewLimiter()
	handler := RequireDownstream(database, limiter)(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) {
			seen, _ = DownstreamAuthFrom(r.Context())
		}))

	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	request.Header.Set("authorization", "Bearer "+created.Token)
	handler.ServeHTTP(httptest.NewRecorder(), request)

	if seen.UsedTokens != 2_000_000 {
		t.Errorf("used = %d, want 2000000", seen.UsedTokens)
	}
	if seen.LimitTokens == nil || *seen.LimitTokens != 5_000_000 {
		t.Errorf("limit = %v, want 5000000", seen.LimitTokens)
	}
}

// probeDownstream runs one request through the middleware and reports what the
// caller would have seen.
func probeDownstream(t *testing.T, database *sql.DB, token string) (int, []byte) {
	t.Helper()
	limiter := ratelimit.NewLimiter()
	handler := RequireDownstream(database, limiter)(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))

	request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
	request.Header.Set("authorization", "Bearer "+token)
	recorder := httptest.NewRecorder()
	handler.ServeHTTP(recorder, request)
	return recorder.Code, recorder.Body.Bytes()
}
