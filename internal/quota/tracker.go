// Package quota bounds how far a token's usage can overshoot its limit while
// requests are still in flight.
package quota

import "sync"

// ProvisionalCost is what one admitted request is charged against a limit until
// its real usage is known.
//
// A request's cost is only known once the response completes, so admission has
// to assume something. Assuming nothing is what let a limit be overshot without
// bound: every request of a burst read the same stored total, each saw the same
// room, and each was admitted. Charging a provisional amount caps how many
// requests can be in flight against the budget that is left, which is what turns
// the overshoot from "however many arrived at once" into a bounded quantity.
//
// The figure is a plausible request rather than a worst case. Too high refuses
// requests that would have fit; too low admits a burst the budget cannot cover.
//
// One charge covers a downstream request however many upstream attempts it
// takes. The attempts are sequential, and each one's usage is metered exactly as
// it becomes known, so the charge only ever stands in for the attempt currently
// running — the ones already finished are accounted for at their real cost.
const ProvisionalCost int64 = 4096

// Tracker accounts for the usage a token has committed to but that its stored
// total does not show yet.
//
// Two kinds of usage are invisible to the database. A request that is still
// running has no figure at all, and one that has finished has none stored until
// the batched writer commits its row. Admission has to weigh both, or it hands
// out budget that is already spent.
//
// The counters live in this process, which is where the gateway's other shared
// state already lives: the routing cache, the rate limiters and the SQLite file
// it fronts are all single-process too.
type Tracker struct {
	mu     sync.Mutex
	tokens map[tokenPeriod]*outstanding
}

// tokenPeriod scopes outstanding usage to one token's one reset cycle.
//
// Without the period in the key, holds taken before a boundary keep counting
// against the budget after it: the first requests of a fresh cycle would be
// weighed against traffic from the cycle that just ended, and a token with a busy
// midnight would be refused at the exact moment its budget refilled.
//
// The period is empty for a token that never resets, which collapses to the
// previous behaviour of one entry per token.
type tokenPeriod struct {
	tokenID   int64
	periodKey string
}

// outstanding is the usage of one token that its stored total has yet to catch
// up with.
type outstanding struct {
	// requests counts admitted requests whose usage is not known yet. Each is
	// weighed at ProvisionalCost.
	requests int64
	// metered is usage that is known but whose row has not committed, so the
	// stored total still understates it.
	metered int64
}

// NewTracker returns a tracker with nothing outstanding.
func NewTracker() *Tracker {
	return &Tracker{tokens: map[tokenPeriod]*outstanding{}}
}

// Reservation is one admitted request's hold on a token's budget.
//
// The zero value holds nothing, which is what an unlimited token gets: there is
// no budget to weigh, so there is nothing to track.
type Reservation struct {
	tracker *Tracker
	scope   tokenPeriod
	held    bool
}

// Release returns the hold once the request has finished, whatever its outcome.
//
// It is safe on a reservation that holds nothing and safe to call more than
// once, so a handler can defer it directly after admission.
func (r *Reservation) Release() {
	if r == nil || !r.held {
		return
	}
	r.held = false
	r.tracker.release(r.scope)
}

// Admit weighs a request against a token's limit and reserves room for it.
//
// stored is the total the database holds for periodKey; a nil limit is unlimited
// and always admits. periodKey is empty for a token that never resets.
//
// An admitted request must release its reservation exactly once.
func (t *Tracker) Admit(tokenID int64, periodKey string, stored int64,
	limit *int64) (Reservation, bool) {
	if limit == nil {
		return Reservation{}, true
	}
	scope := tokenPeriod{tokenID: tokenID, periodKey: periodKey}

	t.mu.Lock()
	defer t.mu.Unlock()

	projected := stored
	entry := t.tokens[scope]
	if entry != nil {
		projected += entry.metered + entry.requests*ProvisionalCost
	}
	if projected >= *limit {
		return Reservation{}, false
	}

	if entry == nil {
		entry = &outstanding{}
		t.tokens[scope] = entry
	}
	entry.requests++
	return Reservation{tracker: t, scope: scope, held: true}, true
}

// Meter records usage that is known but not yet committed, so admission keeps
// counting it until the stored total shows it.
func (t *Tracker) Meter(tokenID int64, periodKey string, used int64) {
	if used <= 0 {
		return
	}
	scope := tokenPeriod{tokenID: tokenID, periodKey: periodKey}

	t.mu.Lock()
	defer t.mu.Unlock()

	entry := t.tokens[scope]
	if entry == nil {
		entry = &outstanding{}
		t.tokens[scope] = entry
	}
	entry.metered += used
}

// Settle drops usage that no longer has to be held, because the row committed
// and the stored total now carries it, or because the write was abandoned and
// the total never will.
func (t *Tracker) Settle(tokenID int64, periodKey string, used int64) {
	if used <= 0 {
		return
	}
	scope := tokenPeriod{tokenID: tokenID, periodKey: periodKey}

	t.mu.Lock()
	defer t.mu.Unlock()

	entry := t.tokens[scope]
	if entry == nil {
		return
	}
	entry.metered = max(entry.metered-used, 0)
	t.discardIfIdle(scope, entry)
}

// Outstanding reports the usage currently held for a token beyond its stored
// total.
func (t *Tracker) Outstanding(tokenID int64, periodKey string) int64 {
	t.mu.Lock()
	defer t.mu.Unlock()

	entry := t.tokens[tokenPeriod{tokenID: tokenID, periodKey: periodKey}]
	if entry == nil {
		return 0
	}
	return entry.metered + entry.requests*ProvisionalCost
}

// Tracked reports how many tokens hold something, which is what a leak would
// show up in.
func (t *Tracker) Tracked() int {
	t.mu.Lock()
	defer t.mu.Unlock()
	return len(t.tokens)
}

func (t *Tracker) release(scope tokenPeriod) {
	t.mu.Lock()
	defer t.mu.Unlock()

	entry := t.tokens[scope]
	if entry == nil {
		return
	}
	entry.requests = max(entry.requests-1, 0)
	t.discardIfIdle(scope, entry)
}

// discardIfIdle drops a scope that holds nothing, so the tracker does not keep an
// entry for every token-period the gateway has ever served. This is also what
// bounds the map across period boundaries: a closed period's entry disappears once
// its last request has settled.
func (t *Tracker) discardIfIdle(scope tokenPeriod, entry *outstanding) {
	if entry.requests == 0 && entry.metered == 0 {
		delete(t.tokens, scope)
	}
}
