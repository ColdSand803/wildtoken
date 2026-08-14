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
	// globalThreshold is the number of failures per globalWindow before the
	// callers counting against that gate are refused.
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

	gatesMu sync.Mutex
	// remote gates callers with an off-machine or unresolved address.
	remote globalState
	// loopback gates callers on the local machine, on its own counter.
	loopback globalState

	// now is swappable so tests can advance time without sleeping.
	now func() time.Time
}

func NewThrottle() *Throttle {
	now := time.Now()
	return &Throttle{
		clients:  map[netip.Addr]*clientState{},
		remote:   globalState{windowStart: now},
		loopback: globalState{windowStart: now},
		now:      time.Now,
	}
}

// gateFor returns the failure gate a caller counts against.
//
// Loopback keeps its own counter rather than being exempt from the gate. The
// exemption assumed a loopback peer really is the operator, which stops being
// true the moment the gateway sits behind a reverse proxy on the same host:
// every caller in the world then arrives as 127.0.0.1 and skips the gate
// altogether, leaving nothing but Argon2id's own cost between an attacker and
// the admin token.
//
// The counter stays separate rather than shared, because that is what the
// exemption was protecting: a remote flood must not be able to lock the operator
// out of the console it is attacking.
//
// The caller must hold gatesMu.
func (t *Throttle) gateFor(client Client) *globalState {
	if client.Kind == ClientLoopback {
		return &t.loopback
	}
	return &t.remote
}

// Admit reports whether client may pay for an Argon2id verification right now.
func (t *Throttle) Admit(client Client) bool {
	now := t.now()

	t.gatesMu.Lock()
	gate := t.gateFor(client)
	if !gate.cooldownUntil.IsZero() && now.Before(gate.cooldownUntil) {
		t.gatesMu.Unlock()
		return false
	}
	gate.cooldownUntil = time.Time{}
	t.gatesMu.Unlock()

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
	now := t.now()

	t.gatesMu.Lock()
	gate := t.gateFor(client)
	if now.Sub(gate.windowStart) >= globalWindow {
		gate.windowStart = now
		gate.failures = 0
	}
	gate.failures++
	if gate.failures >= globalThreshold {
		gate.cooldownUntil = now.Add(globalCooldown)
		gate.windowStart = now
		gate.failures = 0
	}
	t.gatesMu.Unlock()

	addr, ok := client.key()
	if !ok {
		return
	}

	t.clientsMu.Lock()
	defer t.clientsMu.Unlock()
	hasRoom := t.prune(now)
	state, tracked := t.clients[addr]
	if !tracked {
		if !hasRoom {
			// Every slot is held by a client still being penalised. This caller
			// is bounded by its gate rather than by an entry taken from one of
			// them.
			return
		}
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

// prune drops entries that have gone quiet and reports whether there is room to
// track another client.
//
// A map still full afterwards means the traffic is distributed rather than
// repetitive, and the gate is the limit that applies. Emptying the map to make
// room is what this must not do: it hands every penalised client its backoff
// back, which is the opposite of the right answer to an address flood.
//
// The caller must hold clientsMu.
func (t *Throttle) prune(now time.Time) bool {
	if len(t.clients) < maxTrackedClients {
		return true
	}
	for addr, state := range t.clients {
		quiet := now.Sub(state.lastFailure) >= clientResetAfter
		stillBlocked := !state.blockedUntil.IsZero() && now.Before(state.blockedUntil)
		if quiet && !stillBlocked {
			delete(t.clients, addr)
		}
	}
	return len(t.clients) < maxTrackedClients
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
