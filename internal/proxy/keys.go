package proxy

import (
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// A refused key sits out 10 s, twice as long with each refusal in a row, never
// past 5 min: 10, 20, 40, 80, 160, 300.
const (
	keyCooldownBase = 10 * time.Second
	keyCooldownMax  = 5 * time.Minute
)

// KeyPicker spreads each channel's requests over its keys and sits out a key
// the upstream refused. Both live in memory: a restart forgets them, at the
// cost of one refused request per bad key. A nil picker takes the first key
// and remembers nothing.
type KeyPicker struct {
	mu      sync.Mutex
	next    map[int64]uint64   // channel id → rotation position
	benched map[int64]keyBench // key id → its run of refusals
	now     func() time.Time
}

type keyBench struct {
	refusals int
	until    time.Time
}

func NewKeyPicker() *KeyPicker {
	return &KeyPicker{next: map[int64]uint64{}, benched: map[int64]keyBench{}, now: time.Now}
}

// Pick returns the next of a channel's keys in rotation that refused does not
// rule out, preferring one not sitting out. One sitting out still beats none,
// and benched says that is all there was; ok is false when refused rules out
// every key. Each call moves the rotation on, so requests arriving together
// start on different keys.
func (p *KeyPicker) Pick(upstreamID int64, keys []models.UpstreamKey,
	refused map[int64]bool) (key models.UpstreamKey, benched, ok bool) {
	if len(keys) == 0 {
		return models.UpstreamKey{}, false, false
	}
	if p == nil {
		for _, candidate := range keys {
			if !refused[candidate.ID] {
				return candidate, false, true
			}
		}
		return models.UpstreamKey{}, false, false
	}

	p.mu.Lock()
	defer p.mu.Unlock()
	start := p.next[upstreamID]
	p.next[upstreamID] = start + 1

	now := p.now()
	for i := range keys {
		candidate := keys[(start+uint64(i))%uint64(len(keys))]
		if refused[candidate.ID] {
			continue
		}
		if !ok {
			key, ok = candidate, true
		}
		if !p.sittingOutLocked(candidate.ID, now) {
			return candidate, false, true
		}
	}
	return key, ok, ok
}

// HasFresh reports whether a key besides those refused is not sitting out:
// whether staying on the channel for another key is worth it.
func (p *KeyPicker) HasFresh(keys []models.UpstreamKey, refused map[int64]bool) bool {
	if p != nil {
		p.mu.Lock()
		defer p.mu.Unlock()
	}
	for _, key := range keys {
		if !refused[key.ID] && (p == nil || !p.sittingOutLocked(key.ID, p.now())) {
			return true
		}
	}
	return false
}

// Bench sits a refused key out. retryAfter, when the upstream sent one,
// replaces the doubling, within the same cap.
func (p *KeyPicker) Bench(keyID int64, retryAfter time.Duration) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	bench := p.benched[keyID]
	bench.refusals++
	wait := keyCooldownBase << min(bench.refusals-1, 5)
	if retryAfter > 0 {
		wait = retryAfter
	}
	bench.until = p.now().Add(min(wait, keyCooldownMax))
	p.benched[keyID] = bench
}

// Clear forgets a key's refusals once it has served a request.
func (p *KeyPicker) Clear(keyID int64) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.benched, keyID)
}

// Remaining is how long a key still sits out, 0 when it does not.
func (p *KeyPicker) Remaining(keyID int64) time.Duration {
	if p == nil {
		return 0
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	return max(p.benched[keyID].until.Sub(p.now()), 0)
}

func (p *KeyPicker) sittingOutLocked(keyID int64, now time.Time) bool {
	return now.Before(p.benched[keyID].until)
}

// KeyRefused reports a status that blames the key rather than the channel:
// rejected credentials, or the account behind them out of quota.
func KeyRefused(status int) bool {
	return status == http.StatusUnauthorized || status == http.StatusForbidden ||
		status == http.StatusTooManyRequests
}

// RetryAfter reads a Retry-After header, in seconds or as a date; 0 when absent.
func RetryAfter(headers map[string]string) time.Duration {
	value := strings.TrimSpace(headers["retry-after"])
	if value == "" {
		return 0
	}
	if seconds, err := strconv.Atoi(value); err == nil {
		return max(time.Duration(seconds)*time.Second, 0)
	}
	if when, err := http.ParseTime(value); err == nil {
		return max(time.Until(when), 0)
	}
	return 0
}
