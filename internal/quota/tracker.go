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
	tokens map[int64]*outstanding
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
	return &Tracker{tokens: map[int64]*outstanding{}}
}

// Reservation is one admitted request's hold on a token's budget.
//
// The zero value holds nothing, which is what an unlimited token gets: there is
// no budget to weigh, so there is nothing to track.
type Reservation struct {
	tracker *Tracker
	tokenID int64
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
	r.tracker.release(r.tokenID)
}

// Admit weighs a request against a token's limit and reserves room for it.
//
// stored is the total the database holds; a nil limit is unlimited and always
// admits. The usage it weighed comes back with the verdict, so a refusal is
// explained by the figure that produced it rather than by the stale stored one.
//
// An admitted request must release its reservation exactly once.
func (t *Tracker) Admit(tokenID int64, stored int64, limit *int64) (Reservation, int64, bool) {
	if limit == nil {
		return Reservation{}, stored, true
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	projected := stored
	entry := t.tokens[tokenID]
	if entry != nil {
		projected += entry.metered + entry.requests*ProvisionalCost
	}
	if projected >= *limit {
		return Reservation{}, projected, false
	}

	if entry == nil {
		entry = &outstanding{}
		t.tokens[tokenID] = entry
	}
	entry.requests++
	return Reservation{tracker: t, tokenID: tokenID, held: true}, projected, true
}

// Meter records usage that is known but not yet committed, so admission keeps
// counting it until the stored total shows it.
func (t *Tracker) Meter(tokenID int64, used int64) {
	if used <= 0 {
		return
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	entry := t.tokens[tokenID]
	if entry == nil {
		entry = &outstanding{}
		t.tokens[tokenID] = entry
	}
	entry.metered += used
}

// Settle drops usage that no longer has to be held, because the row committed
// and the stored total now carries it, or because the write was abandoned and
// the total never will.
func (t *Tracker) Settle(tokenID int64, used int64) {
	if used <= 0 {
		return
	}

	t.mu.Lock()
	defer t.mu.Unlock()

	entry := t.tokens[tokenID]
	if entry == nil {
		return
	}
	entry.metered = max(entry.metered-used, 0)
	t.discardIfIdle(tokenID, entry)
}

// Outstanding reports the usage currently held for a token beyond its stored
// total.
func (t *Tracker) Outstanding(tokenID int64) int64 {
	t.mu.Lock()
	defer t.mu.Unlock()

	entry := t.tokens[tokenID]
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

func (t *Tracker) release(tokenID int64) {
	t.mu.Lock()
	defer t.mu.Unlock()

	entry := t.tokens[tokenID]
	if entry == nil {
		return
	}
	entry.requests = max(entry.requests-1, 0)
	t.discardIfIdle(tokenID, entry)
}

// discardIfIdle drops a token that holds nothing, so the tracker does not keep
// an entry for every token the gateway has ever served.
func (t *Tracker) discardIfIdle(tokenID int64, entry *outstanding) {
	if entry.requests == 0 && entry.metered == 0 {
		delete(t.tokens, tokenID)
	}
}
