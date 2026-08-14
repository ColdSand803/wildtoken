package ratelimit

import (
	"sync"
	"testing"
	"time"
)

func TestLimiter_NoLimit(t *testing.T) {
	limiter := NewLimiter()
	defer limiter.Close()

	// No limits configured, should always allow
	for range 100 {
		if !limiter.Check(1, nil) {
			t.Fatal("expected request to be allowed when no limits configured")
		}
	}
}

func TestLimiter_RequestsPerMinute(t *testing.T) {
	if testing.Short() {
		t.Skip("waits out a full one-minute window")
	}
	limiter := NewLimiter()
	defer limiter.Close()

	rateLimit := &RateLimit{Requests: 10, Window: time.Minute}
	tokenID := int64(1)

	// First 10 requests should succeed
	for i := range 10 {
		if !limiter.Check(tokenID, rateLimit) {
			t.Fatalf("request %d should be allowed", i)
		}
	}

	// 11th request should be rate limited
	if limiter.Check(tokenID, rateLimit) {
		t.Fatal("expected request to be rate limited")
	}

	// Wait for the window to slide
	time.Sleep(61 * time.Second)

	// Should be allowed again
	if !limiter.Check(tokenID, rateLimit) {
		t.Fatal("expected request to be allowed after window expired")
	}
}

func TestLimiter_RequestsPerHour(t *testing.T) {
	limiter := NewLimiter()
	defer limiter.Close()

	rateLimit := &RateLimit{Requests: 5, Window: time.Hour}
	tokenID := int64(2)

	// First 5 requests should succeed
	for i := range 5 {
		if !limiter.Check(tokenID, rateLimit) {
			t.Fatalf("request %d should be allowed", i)
		}
	}

	// 6th request should be rate limited
	if limiter.Check(tokenID, rateLimit) {
		t.Fatal("expected request to be rate limited")
	}
}

func TestLimiter_CustomWindow(t *testing.T) {
	limiter := NewLimiter()
	defer limiter.Close()

	// 50 requests per 10 seconds
	rateLimit := &RateLimit{Requests: 50, Window: 10 * time.Second}
	tokenID := int64(3)

	// First 50 requests should succeed
	for i := range 50 {
		if !limiter.Check(tokenID, rateLimit) {
			t.Fatalf("request %d should be allowed", i)
		}
	}

	// 51st request should be rate limited
	if limiter.Check(tokenID, rateLimit) {
		t.Fatal("expected request to be rate limited")
	}
}

func TestLimiter_MultipleTokens(t *testing.T) {
	limiter := NewLimiter()
	defer limiter.Close()

	rateLimit := &RateLimit{Requests: 3, Window: time.Minute}

	// Token 1 uses its quota
	for i := range 3 {
		if !limiter.Check(1, rateLimit) {
			t.Fatalf("token 1 request %d should be allowed", i)
		}
	}
	if limiter.Check(1, rateLimit) {
		t.Fatal("token 1 should be rate limited")
	}

	// Token 2 should have its own quota
	for i := range 3 {
		if !limiter.Check(2, rateLimit) {
			t.Fatalf("token 2 request %d should be allowed", i)
		}
	}
	if limiter.Check(2, rateLimit) {
		t.Fatal("token 2 should be rate limited")
	}
}

func TestLimiter_Concurrent(t *testing.T) {
	limiter := NewLimiter()
	defer limiter.Close()

	rateLimit := &RateLimit{Requests: 100, Window: time.Minute}
	tokenID := int64(4)
	goroutines := 10
	requestsPerGoroutine := 20

	var wg sync.WaitGroup
	allowed := make(chan bool, goroutines*requestsPerGoroutine)

	for range goroutines {
		wg.Go(func() {
			for range requestsPerGoroutine {
				allowed <- limiter.Check(tokenID, rateLimit)
			}
		})
	}

	wg.Wait()
	close(allowed)

	allowedCount := 0
	for result := range allowed {
		if result {
			allowedCount++
		}
	}

	// First 100 should be allowed, rest blocked
	if allowedCount != 100 {
		t.Fatalf("expected 100 allowed requests, got %d", allowedCount)
	}
}

func TestLimiter_SlidingWindow(t *testing.T) {
	limiter := NewLimiter()
	defer limiter.Close()

	// 3 requests per 2 seconds
	rateLimit := &RateLimit{Requests: 3, Window: 2 * time.Second}
	tokenID := int64(5)

	// Use all 3 requests
	for i := range 3 {
		if !limiter.Check(tokenID, rateLimit) {
			t.Fatalf("request %d should be allowed", i)
		}
	}

	// 4th request should be blocked
	if limiter.Check(tokenID, rateLimit) {
		t.Fatal("expected request to be rate limited")
	}

	// Wait 1 second (half the window)
	time.Sleep(1 * time.Second)

	// Still should be blocked (oldest request still in window)
	if limiter.Check(tokenID, rateLimit) {
		t.Fatal("expected request to be rate limited after 1 second")
	}

	// Buckets are whole seconds and the window start is truncated to one, so a
	// bucket can stay in scope up to a second past the nominal window. Wait far
	// enough that the recording bucket has left even the widened window.
	time.Sleep(2500 * time.Millisecond)

	// Should be allowed again
	if !limiter.Check(tokenID, rateLimit) {
		t.Fatal("expected request to be allowed after window slid")
	}
}
