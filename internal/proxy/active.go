package proxy

import (
	"sort"
	"sync"
	"time"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// ActiveSnapshotLimit bounds one snapshot of the in-flight set.
//
// The console shows the newest requests first, and a page of them is already
// more than an operator reads. A gateway under load can hold far more open at
// once, and serializing all of them once a second per viewer is work nobody
// asked for.
const ActiveSnapshotLimit = 200

// ActiveRegistry holds the requests currently being proxied.
//
// It is the only view of a request between arrival and its committed log row,
// which for a streaming answer is the whole time anyone cares about it. Nothing
// here is persisted: a restart loses the set, which is correct, because a
// restart also ends every request in it.
type ActiveRegistry struct {
	mu      sync.Mutex
	nextID  int64
	entries map[int64]*ActiveRequest
	// version advances on every mutation, so a subscriber can tell "nothing
	// changed" from "everything changed" without diffing snapshots.
	version uint64
}

func NewActiveRegistry() *ActiveRegistry {
	return &ActiveRegistry{entries: map[int64]*ActiveRequest{}}
}

// ActiveRequest is one registered request. Every field is read under the
// registry's lock, because the proxy goroutine writes them while a console
// connection reads them.
type ActiveRequest struct {
	registry  *ActiveRegistry
	id        int64
	startedAt time.Time

	method                  string
	path                    string
	downstreamTokenID       *int64
	downstreamTokenName     *string
	clientIP                *string
	clientType              string
	upstreamID              *int64
	upstreamName            *string
	model                   *string
	requestModel            *string
	upstreamModel           *string
	reasoningEffort         *string
	upstreamReasoningEffort *string
	attempt                 int32
	released                bool
}

// Begin registers a request and returns the handle its proxying updates.
//
// A nil registry returns a nil handle, and every handle method tolerates one,
// so a caller assembled without a registry needs no branch of its own.
func (r *ActiveRegistry) Begin(method, path string) *ActiveRequest {
	if r == nil {
		return nil
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	r.nextID++
	request := &ActiveRequest{
		registry:   r,
		id:         r.nextID,
		startedAt:  time.Now(),
		method:     method,
		path:       path,
		clientType: "unknown",
	}
	r.entries[request.id] = request
	r.version++
	return request
}

// ActiveSnapshot is one reading of the in-flight set.
//
// Total counts everything in flight, while Requests is capped at
// ActiveSnapshotLimit. A console reporting concurrency has to read the count
// rather than the length of the list, or a gateway busy enough to overflow the
// cap would report exactly the cap and stop moving.
type ActiveSnapshot struct {
	Version  uint64
	Total    int
	Requests []models.ActiveRequestOut
}

// Snapshot returns the current set, newest first, with the version it was taken
// at and the true count behind it.
func (r *ActiveRegistry) Snapshot() ActiveSnapshot {
	if r == nil {
		return ActiveSnapshot{}
	}

	r.mu.Lock()
	defer r.mu.Unlock()

	now := time.Now()
	requests := make([]models.ActiveRequestOut, 0, len(r.entries))
	for _, entry := range r.entries {
		requests = append(requests, entry.snapshotLocked(now))
	}
	// Ties break on the id, which is assigned in arrival order, so two requests
	// that started in the same second keep a stable order between snapshots.
	sort.Slice(requests, func(i, j int) bool {
		if requests[i].ElapsedMs != requests[j].ElapsedMs {
			return requests[i].ElapsedMs < requests[j].ElapsedMs
		}
		return requests[i].ID > requests[j].ID
	})
	total := len(requests)
	if len(requests) > ActiveSnapshotLimit {
		requests = requests[:ActiveSnapshotLimit]
	}
	return ActiveSnapshot{Version: r.version, Total: total, Requests: requests}
}

// Version reports the current mutation counter, for a subscriber deciding
// whether a resend is warranted.
func (r *ActiveRegistry) Version() uint64 {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return r.version
}

// Len reports how many requests are in flight.
func (r *ActiveRegistry) Len() int {
	if r == nil {
		return 0
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(r.entries)
}

func (a *ActiveRequest) snapshotLocked(now time.Time) models.ActiveRequestOut {
	return models.ActiveRequestOut{
		ID:                      a.id,
		StartedAt:               a.startedAt.UTC().Format(models.TimestampFormat),
		ElapsedMs:               now.Sub(a.startedAt).Milliseconds(),
		Method:                  a.method,
		Path:                    a.path,
		DownstreamTokenID:       a.downstreamTokenID,
		DownstreamTokenName:     a.downstreamTokenName,
		ClientIP:                a.clientIP,
		ClientType:              a.clientType,
		UpstreamID:              a.upstreamID,
		UpstreamName:            a.upstreamName,
		Model:                   a.model,
		RequestModel:            a.requestModel,
		UpstreamModel:           a.upstreamModel,
		ReasoningEffort:         a.reasoningEffort,
		UpstreamReasoningEffort: a.upstreamReasoningEffort,
		Attempt:                 a.attempt,
	}
}

// update applies one mutation under the registry lock and bumps the version.
//
// A released handle ignores its late updates rather than resurrecting an entry
// the console has already been told is gone.
func (a *ActiveRequest) update(mutate func()) {
	if a == nil {
		return
	}

	a.registry.mu.Lock()
	defer a.registry.mu.Unlock()

	if a.released {
		return
	}
	mutate()
	a.registry.version++
}

// SetDownstreamToken records the caller the request authenticated as.
func (a *ActiveRequest) SetDownstreamToken(tokenID int64, tokenName string) {
	a.update(func() {
		a.downstreamTokenID = &tokenID
		a.downstreamTokenName = &tokenName
	})
}

// SetClientIP records the caller's address.
func (a *ActiveRequest) SetClientIP(address string) {
	if address == "" {
		return
	}
	a.update(func() { a.clientIP = &address })
}

// SetClientType records the detected downstream client.
func (a *ActiveRequest) SetClientType(clientType string) {
	a.update(func() { a.clientType = clientType })
}

// SetModel records the model the caller asked for.
func (a *ActiveRequest) SetModel(model *string) {
	a.update(func() {
		a.model = model
		a.requestModel = model
	})
}

// SetUpstream records the channel this attempt was handed to, counting it.
//
// The count is what makes a retry visible while it is happening: a request that
// has moved to its third channel looks the same as a slow first attempt without
// it.
func (a *ActiveRequest) SetUpstream(upstreamID int64, upstreamName string, forwardModel *string) {
	a.update(func() {
		a.upstreamID = &upstreamID
		a.upstreamName = &upstreamName
		a.upstreamModel = forwardModel
		if forwardModel != nil {
			a.model = forwardModel
		}
		a.attempt++
	})
}

// SetReasoningEffort records the effort the caller asked for and the one the
// channel's mapping rewrote it into.
//
// Both are known once the upstream request has been prepared, which is before
// the upstream is called — so a request that spends minutes thinking shows the
// effort it is spending them at, rather than only revealing it afterwards.
func (a *ActiveRequest) SetReasoningEffort(request, upstream *string) {
	a.update(func() {
		a.reasoningEffort = request
		a.upstreamReasoningEffort = upstream
	})
}

// Release removes the request from the set. It is safe to call more than once.
//
// It must happen after the response has been delivered, not when the upstream
// answered: a streamed answer is still in flight for as long as it is being
// written downstream, and that is the part worth watching.
func (a *ActiveRequest) Release() {
	if a == nil {
		return
	}

	a.registry.mu.Lock()
	defer a.registry.mu.Unlock()

	if a.released {
		return
	}
	a.released = true
	delete(a.registry.entries, a.id)
	a.registry.version++
}
