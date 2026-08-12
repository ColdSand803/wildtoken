package middleware

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/ratelimit"
)

func TestARateLimitedTokenIsRefusedOnceItsWindowFills(t *testing.T) {
	database := authTestDB(t)
	ctx := context.Background()

	rate := "2/m"
	created, err := db.CreateToken(ctx, database, &models.APITokenIn{
		Name: "throttled", Enabled: true, RateLimit: &rate,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	limiter := ratelimit.NewLimiter()
	defer limiter.Close()
	handler := RequireDownstream(database, limiter)(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))

	send := func(path string) (int, []byte) {
		request := httptest.NewRequest(http.MethodPost, path, nil)
		request.Header.Set("authorization", "Bearer "+created.Token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		return recorder.Code, recorder.Body.Bytes()
	}

	// The first two requests fit the 2/m window.
	for i := range 2 {
		if status, _ := send("/v1/chat/completions"); status != http.StatusOK {
			t.Fatalf("request %d got %d, want 200", i, status)
		}
	}

	// The third crosses the rate and is refused with the rate shape, which a
	// caller must be able to tell apart from a quota refusal: this one heals by
	// waiting, not by raising a limit.
	status, body := send("/v1/chat/completions")
	if status != http.StatusTooManyRequests {
		t.Fatalf("rate-limited request got %d, want 429", status)
	}
	var decoded map[string]any
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if decoded["code"] != RateLimitedCode {
		t.Errorf("top-level code = %v, want %s", decoded["code"], RateLimitedCode)
	}
	nested, _ := decoded["error"].(map[string]any)
	if nested["type"] != "rate_limit_exceeded" {
		t.Errorf("nested type = %v, want rate_limit_exceeded", nested["type"])
	}
	message, _ := nested["message"].(string)
	if !json.Valid(body) || message == "" {
		t.Errorf("refusal body should carry a message: %s", body)
	}

	// The Anthropic dialect keeps its own nested shape.
	status, body = send("/v1/messages")
	if status != http.StatusTooManyRequests {
		t.Fatalf("anthropic rate-limited request got %d, want 429", status)
	}
	decoded = map[string]any{}
	if err := json.Unmarshal(body, &decoded); err != nil {
		t.Fatalf("decode: %v", err)
	}
	nested, _ = decoded["error"].(map[string]any)
	if nested["type"] != "rate_limit_error" {
		t.Errorf("anthropic nested type = %v, want rate_limit_error", nested["type"])
	}
}

func TestATokenWithoutARateLimitIsNeverThrottled(t *testing.T) {
	database := authTestDB(t)
	ctx := context.Background()

	created, err := db.CreateToken(ctx, database, &models.APITokenIn{
		Name: "unthrottled", Enabled: true,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	limiter := ratelimit.NewLimiter()
	defer limiter.Close()
	handler := RequireDownstream(database, limiter)(http.HandlerFunc(
		func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))

	for i := range 50 {
		request := httptest.NewRequest(http.MethodPost, "/v1/chat/completions", nil)
		request.Header.Set("authorization", "Bearer "+created.Token)
		recorder := httptest.NewRecorder()
		handler.ServeHTTP(recorder, request)
		if recorder.Code != http.StatusOK {
			t.Fatalf("request %d got %d, want 200", i, recorder.Code)
		}
	}
}

func TestARateLimitExpressionSurvivesTheTokenRoundTrip(t *testing.T) {
	database := authTestDB(t)
	ctx := context.Background()

	rate := " 100/m "
	created, err := db.CreateToken(ctx, database, &models.APITokenIn{
		Name: "with-rate", Enabled: true, RateLimit: &rate,
	})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// Stored trimmed, echoed back verbatim.
	if created.RateLimit == nil || *created.RateLimit != "100/m" {
		t.Fatalf("created rate limit = %v, want 100/m", created.RateLimit)
	}

	// The authenticated credential carries it to the middleware.
	credential, found, err := LookupEnabledDownstreamToken(ctx, database, created.Token)
	if err != nil || !found {
		t.Fatalf("lookup: found=%v err=%v", found, err)
	}
	if credential.RateLimit == nil || *credential.RateLimit != "100/m" {
		t.Fatalf("credential rate limit = %v, want 100/m", credential.RateLimit)
	}

	// Clearing the field on an update removes the limit.
	updated, err := db.UpdateToken(ctx, database, created.ID, &models.APITokenUpdateIn{
		Name: "with-rate", GroupID: &created.GroupID,
	})
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if updated.RateLimit != nil {
		t.Fatalf("cleared rate limit = %v, want nil", updated.RateLimit)
	}
}

func TestAMalformedRateLimitExpressionIsRefusedAtTheDoor(t *testing.T) {
	database := authTestDB(t)
	ctx := context.Background()

	for _, expr := range []string{"100", "m/100", "100/x", "0/m", "abc"} {
		bad := expr
		_, err := db.CreateToken(ctx, database, &models.APITokenIn{
			Name: "bad-" + expr, Enabled: true, RateLimit: &bad,
		})
		if err == nil {
			t.Errorf("expression %q was accepted, want a validation error", expr)
		}
	}
}
