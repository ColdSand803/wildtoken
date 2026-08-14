// Package ratelimit implements token-based rate limiting with sliding window counters.
package ratelimit

import (
	"sync"
	"time"
)

// Limiter manages rate limits for API tokens using sliding window counters.
type Limiter struct {
	mu      sync.RWMutex
	windows map[int64]*tokenWindow
	// 清理间隔
	cleanupInterval time.Duration
	done            chan struct{}
}

// tokenWindow tracks request counts in sliding time windows for one token.
type tokenWindow struct {
	mu      sync.Mutex
	buckets map[int64]int64 // timestamp -> count
}

// NewLimiter creates a rate limiter with automatic cleanup of expired windows.
func NewLimiter() *Limiter {
	limiter := &Limiter{
		windows:         make(map[int64]*tokenWindow),
		cleanupInterval: 5 * time.Minute,
		done:            make(chan struct{}),
	}
	go limiter.cleanupLoop()
	return limiter
}

// Close stops the background cleanup goroutine.
func (l *Limiter) Close() {
	close(l.done)
}

// Check verifies if a request should be allowed under the configured rate limit.
// Returns true if allowed, false if rate limit exceeded.
//
// Counting is per whole second and the window start is truncated to one, so the
// effective window can run up to a second longer than configured. The error is
// on the strict side — a request is never admitted that a precise window would
// have refused — which is the right direction for a limit.
func (l *Limiter) Check(tokenID int64, rateLimit *RateLimit) bool {
	if rateLimit == nil {
		return true
	}

	now := time.Now()
	window := l.getOrCreateWindow(tokenID)
	window.mu.Lock()
	defer window.mu.Unlock()

	// Check if request count in the sliding window exceeds the limit
	windowStart := now.Add(-rateLimit.Window).Unix()
	count := window.countSince(windowStart)
	if count >= rateLimit.Requests {
		return false
	}

	// Record this request
	bucket := now.Unix()
	window.buckets[bucket]++
	return true
}

// getOrCreateWindow returns the window for a token, creating it if needed.
func (l *Limiter) getOrCreateWindow(tokenID int64) *tokenWindow {
	l.mu.RLock()
	window, exists := l.windows[tokenID]
	l.mu.RUnlock()

	if exists {
		return window
	}

	l.mu.Lock()
	defer l.mu.Unlock()

	// Double-check after acquiring write lock
	if window, exists = l.windows[tokenID]; exists {
		return window
	}

	window = &tokenWindow{
		buckets: make(map[int64]int64),
	}
	l.windows[tokenID] = window
	return window
}

// countSince returns the number of requests since the given timestamp.
func (w *tokenWindow) countSince(since int64) int64 {
	var count int64
	for bucket, c := range w.buckets {
		if bucket >= since {
			count += c
		}
	}
	return count
}

// cleanup removes expired buckets older than 1 hour.
func (w *tokenWindow) cleanup(cutoff int64) {
	w.mu.Lock()
	defer w.mu.Unlock()

	for bucket := range w.buckets {
		if bucket < cutoff {
			delete(w.buckets, bucket)
		}
	}
}

// cleanupLoop periodically removes expired windows and buckets.
func (l *Limiter) cleanupLoop() {
	ticker := time.NewTicker(l.cleanupInterval)
	defer ticker.Stop()

	for {
		select {
		case <-l.done:
			return
		case <-ticker.C:
			l.cleanup()
		}
	}
}

// cleanup removes expired buckets from all windows.
func (l *Limiter) cleanup() {
	cutoff := time.Now().Add(-2 * time.Hour).Unix()

	l.mu.RLock()
	windows := make([]*tokenWindow, 0, len(l.windows))
	for _, w := range l.windows {
		windows = append(windows, w)
	}
	l.mu.RUnlock()

	for _, w := range windows {
		w.cleanup(cutoff)
	}
}
