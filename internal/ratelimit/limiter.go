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
	closeOnce       sync.Once
}

// secondBucket counts the requests recorded during one whole second.
type secondBucket struct {
	second int64
	count  int64
}

// tokenWindow tracks request counts in sliding time windows for one token.
//
// Buckets are kept in ascending order because time only moves forward: a new
// request lands on the tail and expiry drains the head, so counting costs
// amortized constant time instead of a scan over every bucket per request.
type tokenWindow struct {
	mu      sync.Mutex
	buckets []secondBucket
	// head indexes the oldest live bucket. The drained prefix is reclaimed in
	// bulk rather than on every expiry.
	head int
	// total is the sum of the live buckets, maintained by expire and record so
	// admission never has to add them up.
	total int64
	// retain is the window the most recent check used, and it is what cleanup
	// prunes against. A fixed retention is what this replaces: it truncated an
	// hour- or day-long limit to its own span, so a daily budget was handed out
	// again every couple of hours.
	//
	// The most recent window is the right retention rather than the widest ever
	// seen. Once a limit is narrowed the older buckets can no longer be counted
	// by anything, so holding them would only waste memory.
	retain time.Duration
	// lastUsed is when a check last touched this window. Cleanup waits for a
	// window to be idle before reclaiming it, so one a concurrent check has
	// only just created is never dropped out from under it.
	lastUsed time.Time
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

// Close stops the background cleanup goroutine. It is safe to call more than
// once, because shutdown paths can overlap.
func (l *Limiter) Close() {
	l.closeOnce.Do(func() { close(l.done) })
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
	window := l.getOrCreateWindow(tokenID, rateLimit.Window, now)
	window.mu.Lock()
	defer window.mu.Unlock()

	// Recording the window on every check is what lets cleanup keep exactly the
	// history this limit still counts.
	window.retain = rateLimit.Window
	window.lastUsed = now

	window.expire(now.Add(-rateLimit.Window).Unix())
	if window.total >= rateLimit.Requests {
		return false
	}
	window.record(now.Unix())
	return true
}

// getOrCreateWindow returns the window for a token, creating it if needed.
func (l *Limiter) getOrCreateWindow(tokenID int64, retain time.Duration, now time.Time) *tokenWindow {
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

	window = &tokenWindow{retain: retain, lastUsed: now}
	l.windows[tokenID] = window
	return window
}

// empty reports whether no live bucket is left to count.
func (w *tokenWindow) empty() bool { return w.head >= len(w.buckets) }

// expire drops the buckets that have left the window and keeps the running
// total in step. The scan stops at the first live bucket, because the slice is
// ascending.
func (w *tokenWindow) expire(since int64) {
	for w.head < len(w.buckets) && w.buckets[w.head].second < since {
		w.total -= w.buckets[w.head].count
		w.head++
	}
	// Reclaim the drained prefix once it dominates the slice, so a long window
	// does not keep its whole history alive.
	if w.head > 0 && w.head*2 >= len(w.buckets) {
		w.compact()
	}
}

// compact moves the live buckets to the front, releasing the drained prefix.
func (w *tokenWindow) compact() {
	w.buckets = append(w.buckets[:0], w.buckets[w.head:]...)
	w.head = 0
}

// record counts one request in the bucket for the given second.
func (w *tokenWindow) record(second int64) {
	w.total++
	if !w.empty() {
		newest := &w.buckets[len(w.buckets)-1]
		// A clock stepping backwards must not break the ascending order expiry
		// relies on, so an out-of-order tick joins the newest bucket.
		if newest.second >= second {
			newest.count++
			return
		}
	}
	w.buckets = append(w.buckets, secondBucket{second: second, count: 1})
}

// prune drops what this token's own window no longer counts, and reports
// whether the window is empty and idle enough to be reclaimed.
func (w *tokenWindow) prune(now time.Time, idleFor time.Duration) bool {
	w.mu.Lock()
	defer w.mu.Unlock()

	w.expire(now.Add(-w.retain).Unix())
	if w.head > 0 {
		w.compact()
	}
	return w.empty() && now.Sub(w.lastUsed) >= idleFor
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

// cleanup expires every window against its own configured span and reclaims the
// ones left empty, so a limiter does not hold one window per token it has ever
// seen for the life of the process.
func (l *Limiter) cleanup() {
	now := time.Now()

	type trackedWindow struct {
		id     int64
		window *tokenWindow
	}

	l.mu.RLock()
	tracked := make([]trackedWindow, 0, len(l.windows))
	for id, window := range l.windows {
		tracked = append(tracked, trackedWindow{id: id, window: window})
	}
	l.mu.RUnlock()

	var reclaim []int64
	for _, entry := range tracked {
		if entry.window.prune(now, l.cleanupInterval) {
			reclaim = append(reclaim, entry.id)
		}
	}
	if len(reclaim) == 0 {
		return
	}

	l.mu.Lock()
	defer l.mu.Unlock()
	for _, id := range reclaim {
		window, ok := l.windows[id]
		if !ok {
			continue
		}
		// Re-check while the map is held: a request may have landed since the
		// prune, and dropping the window would lose the count it just made.
		window.mu.Lock()
		if window.empty() {
			delete(l.windows, id)
		}
		window.mu.Unlock()
	}
}
