// Package authstate holds admission control and credential verification for
// admin authentication.
//
// Every miss on the verified-token cache costs an Argon2id verification: tens
// of milliseconds of CPU and ~19 MiB of memory, spent before the caller has
// proven anything. Guessing a high-entropy token that way is hopeless, but
// keeping the console busy is not — a steady stream of wrong tokens is enough.
//
// Three limits apply, cheapest first: a per-client backoff, a global failure
// gate for callers that rotate addresses, and a bound on how many requests may
// queue for the verification slot. Loopback callers skip the first two; the
// machine is already trusted, and locking the operator out of their own console
// is the failure mode worth avoiding most.
package authstate

import (
	"net/netip"
	"sync"
	"time"
)

const (
	// freeAttempts is the number of failures a client may accumulate before
	// backoff starts.
	freeAttempts uint32 = 5
	// baseBackoff is the first backoff step, doubled per failure beyond
	// freeAttempts.
	baseBackoff = time.Second
	maxBackoff  = 60 * time.Second
	// clientResetAfter is the idle period after which a client's failure streak
	// is forgotten.
	clientResetAfter = 15 * time.Minute
	// maxTrackedClients caps tracked clients, so address rotation cannot grow
	// the map without end.
	maxTrackedClients = 4096

	globalWindow = 60 * time.Second
	// globalThreshold is the number of failures per globalWindow before every
	// non-loopback caller is refused.
	globalThreshold uint32 = 100
	globalCooldown         = 30 * time.Second
)

// ClientKind distinguishes callers that can be tracked individually from those
// that cannot.
type ClientKind int

const (
	// ClientLoopback is a caller on the local machine, which is already trusted.
	ClientLoopback ClientKind = iota
	// ClientRemote is a caller with a known non-loopback address.
	ClientRemote
	// ClientUnknown covers requests whose peer address the server could not
	// determine. They are subject to the global gate but cannot be tracked
	// individually.
	ClientUnknown
)

// Client identifies who is asking.
type Client struct {
	Kind ClientKind
	Addr netip.Addr
}

// ClientFromAddr classifies a resolved peer address.
func ClientFromAddr(addr netip.Addr) Client {
	if addr.IsLoopback() {
		return Client{Kind: ClientLoopback}
	}
	return Client{Kind: ClientRemote, Addr: addr}
}

// UnknownClient is the caller whose address could not be resolved.
func UnknownClient() Client { return Client{Kind: ClientUnknown} }

func (c Client) exempt() bool { return c.Kind == ClientLoopback }

// key returns the tracking key, and false when the caller cannot be tracked.
func (c Client) key() (netip.Addr, bool) {
	if c.Kind == ClientRemote {
		return c.Addr, true
	}
	return netip.Addr{}, false
}

type clientState struct {
	failures     uint32
	blockedUntil time.Time
	lastFailure  time.Time
}

type globalState struct {
	windowStart   time.Time
	failures      uint32
	cooldownUntil time.Time
}

// Throttle gates how often unproven callers may pay for a verification.
type Throttle struct {
	clientsMu sync.Mutex
	clients   map[netip.Addr]*clientState

	globalMu sync.Mutex
	global   globalState

	// now is swappable so tests can advance time without sleeping.
	now func() time.Time
}

func NewThrottle() *Throttle {
	return &Throttle{
		clients: map[netip.Addr]*clientState{},
		global:  globalState{windowStart: time.Now()},
		now:     time.Now,
	}
}

// Admit reports whether client may pay for an Argon2id verification right now.
func (t *Throttle) Admit(client Client) bool {
	if client.exempt() {
		return true
	}
	now := t.now()

	t.globalMu.Lock()
	if !t.global.cooldownUntil.IsZero() && now.Before(t.global.cooldownUntil) {
		t.globalMu.Unlock()
		return false
	}
	t.global.cooldownUntil = time.Time{}
	t.globalMu.Unlock()

	addr, ok := client.key()
	if !ok {
		return true
	}

	t.clientsMu.Lock()
	defer t.clientsMu.Unlock()
	state, tracked := t.clients[addr]
	if !tracked || state.blockedUntil.IsZero() {
		return true
	}
	return !now.Before(state.blockedUntil)
}

// RecordSuccess clears a client's failure streak. It is called only after a
// real Argon2id verification succeeds, so a valid token always buys its way
// back in.
func (t *Throttle) RecordSuccess(client Client) {
	addr, ok := client.key()
	if !ok {
		return
	}
	t.clientsMu.Lock()
	defer t.clientsMu.Unlock()
	delete(t.clients, addr)
}

// RecordFailure charges a failed verification to the client and the global gate.
func (t *Throttle) RecordFailure(client Client) {
	if client.exempt() {
		return
	}
	now := t.now()

	t.globalMu.Lock()
	if now.Sub(t.global.windowStart) >= globalWindow {
		t.global.windowStart = now
		t.global.failures = 0
	}
	t.global.failures++
	if t.global.failures >= globalThreshold {
		t.global.cooldownUntil = now.Add(globalCooldown)
		t.global.windowStart = now
		t.global.failures = 0
	}
	t.globalMu.Unlock()

	addr, ok := client.key()
	if !ok {
		return
	}

	t.clientsMu.Lock()
	defer t.clientsMu.Unlock()
	t.prune(now)
	state, tracked := t.clients[addr]
	if !tracked {
		state = &clientState{lastFailure: now}
		t.clients[addr] = state
	}
	state.failures++
	state.lastFailure = now
	if delay, penalized := backoff(state.failures); penalized {
		state.blockedUntil = now.Add(delay)
	} else {
		state.blockedUntil = time.Time{}
	}
}

// backoff returns the delay for the failures-th consecutive failure. penalized
// is false while the client is still within its free attempts.
func backoff(failures uint32) (time.Duration, bool) {
	if failures <= freeAttempts {
		return 0, false
	}
	exponent := failures - freeAttempts - 1
	if exponent >= 63 {
		return maxBackoff, true
	}
	delay := baseBackoff << exponent
	// The shift overflows into a negative duration long before it reaches the
	// cap, so treat any non-positive result as saturated.
	if delay <= 0 || delay > maxBackoff {
		return maxBackoff, true
	}
	return delay, true
}

// prune drops entries that have gone quiet. If the map is still full afterwards
// the traffic is distributed rather than repetitive, and the global gate is the
// limit that applies; refuse to grow further rather than track it all.
//
// The caller must hold clientsMu.
func (t *Throttle) prune(now time.Time) {
	if len(t.clients) < maxTrackedClients {
		return
	}
	for addr, state := range t.clients {
		quiet := now.Sub(state.lastFailure) >= clientResetAfter
		stillBlocked := !state.blockedUntil.IsZero() && now.Before(state.blockedUntil)
		if quiet && !stillBlocked {
			delete(t.clients, addr)
		}
	}
	if len(t.clients) >= maxTrackedClients {
		clear(t.clients)
	}
}

// trackedClients reports the map size, for tests asserting the bound holds.
func (t *Throttle) trackedClients() int {
	t.clientsMu.Lock()
	defer t.clientsMu.Unlock()
	return len(t.clients)
}

// maxVerificationWaiters bounds the requests allowed to queue for the
// verification slot. Beyond this the queue itself becomes the amplifier, so
// surplus callers are refused outright.
const maxVerificationWaiters = 8

// verificationQueue bounds the queue for the single verification slot.
type verificationQueue struct {
	mu      sync.Mutex
	waiting int
	slot    chan struct{}
}

func newVerificationQueue() *verificationQueue {
	queue := &verificationQueue{slot: make(chan struct{}, 1)}
	queue.slot <- struct{}{}
	return queue
}

// enter waits for the verification slot. release is nil when too many requests
// are already queued for it.
func (q *verificationQueue) enter() (release func(), admitted bool) {
	q.mu.Lock()
	if q.waiting >= maxVerificationWaiters {
		q.mu.Unlock()
		return nil, false
	}
	q.waiting++
	q.mu.Unlock()

	<-q.slot

	q.mu.Lock()
	q.waiting--
	q.mu.Unlock()

	var once sync.Once
	return func() { once.Do(func() { q.slot <- struct{}{} }) }, true
}

// waitingCount reports the queue depth, for tests.
func (q *verificationQueue) waitingCount() int {
	q.mu.Lock()
	defer q.mu.Unlock()
	return q.waiting
}
