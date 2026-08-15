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

// age moves a window's recorded buckets into the past, standing in for elapsed
// time so a day-long window can be tested without waiting one out.
func age(t *testing.T, limiter *Limiter, tokenID int64, by time.Duration) {
	t.Helper()

	limiter.mu.RLock()
	window, ok := limiter.windows[tokenID]
	limiter.mu.RUnlock()
	if !ok {
		t.Fatalf("token %d should be tracked", tokenID)
	}

	window.mu.Lock()
	defer window.mu.Unlock()
	for i := range window.buckets {
		window.buckets[i].second -= int64(by.Seconds())
	}
	window.lastUsed = window.lastUsed.Add(-by)
}

func TestLimiter_CleanupKeepsLongWindowCounts(t *testing.T) {
	limiter := NewLimiter()
	defer limiter.Close()

	// Cleanup used to drop every bucket older than a fixed span, regardless of
	// the window the limit actually configured. A daily budget was handed out
	// again every couple of hours, admitting several times what it allowed.
	rateLimit := &RateLimit{Requests: 3, Window: 24 * time.Hour}
	tokenID := int64(11)

	for i := range 3 {
		if !limiter.Check(tokenID, rateLimit) {
			t.Fatalf("request %d should be allowed", i)
		}
	}

	age(t, limiter, tokenID, 3*time.Hour)
	limiter.cleanup()

	if limiter.Check(tokenID, rateLimit) {
		t.Fatal("expected a daily limit to stay exhausted three hours in")
	}
}

func TestLimiter_CleanupReclaimsIdleWindows(t *testing.T) {
	limiter := NewLimiter()
	defer limiter.Close()

	tokenID := int64(12)
	if !limiter.Check(tokenID, &RateLimit{Requests: 5, Window: time.Minute}) {
		t.Fatal("first request should be allowed")
	}

	age(t, limiter, tokenID, 2*time.Hour)
	limiter.cleanup()

	limiter.mu.RLock()
	_, tracked := limiter.windows[tokenID]
	limiter.mu.RUnlock()
	if tracked {
		t.Fatal("expected an idle window to be reclaimed rather than tracked for the life of the process")
	}
}

func TestLimiter_CleanupKeepsWindowInUse(t *testing.T) {
	limiter := NewLimiter()
	defer limiter.Close()

	rateLimit := &RateLimit{Requests: 2, Window: time.Hour}
	tokenID := int64(13)

	for i := range 2 {
		if !limiter.Check(tokenID, rateLimit) {
			t.Fatalf("request %d should be allowed", i)
		}
	}

	// Nothing has expired, so cleanup must leave the counts alone.
	limiter.cleanup()

	if limiter.Check(tokenID, rateLimit) {
		t.Fatal("expected the limit to remain exhausted across a cleanup pass")
	}
}

func TestLimiter_ExpiryReleasesBuckets(t *testing.T) {
	limiter := NewLimiter()
	defer limiter.Close()

	rateLimit := &RateLimit{Requests: 100, Window: 2 * time.Second}
	tokenID := int64(14)

	for range 50 {
		if !limiter.Check(tokenID, rateLimit) {
			t.Fatal("request should be allowed")
		}
	}

	// Buckets that leave the window must be released rather than accumulating
	// for as long as the token keeps making requests.
	age(t, limiter, tokenID, time.Hour)
	if !limiter.Check(tokenID, rateLimit) {
		t.Fatal("expected a request after the window slid to be allowed")
	}

	limiter.mu.RLock()
	window := limiter.windows[tokenID]
	limiter.mu.RUnlock()

	window.mu.Lock()
	live := len(window.buckets) - window.head
	total := window.total
	window.mu.Unlock()

	if live != 1 {
		t.Fatalf("expected 1 live bucket after expiry, got %d", live)
	}
	if total != 1 {
		t.Fatalf("expected the running total to track the live buckets, got %d", total)
	}
}
