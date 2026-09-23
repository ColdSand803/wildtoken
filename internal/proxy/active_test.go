package proxy

import (
	"sync"
	"testing"
)

func TestActiveRegistryTracksRequestUntilRelease(t *testing.T) {
	registry := NewActiveRegistry()

	if snapshot := registry.Snapshot(); len(snapshot.Requests) != 0 {
		t.Fatalf("expected an empty registry, got %d requests", len(snapshot.Requests))
	}

	request := registry.Begin("POST", "chat/completions")
	request.SetDownstreamToken(7, "laptop")
	request.SetClientType("codex")
	model := "gpt-5"
	request.SetModel(&model)
	forward := "gpt-5-mini"
	request.SetUpstream(3, "openrouter", &forward)

	requests := registry.Snapshot().Requests
	if len(requests) != 1 {
		t.Fatalf("expected 1 in-flight request, got %d", len(requests))
	}
	entry := requests[0]
	if entry.ClientType != "codex" || entry.Attempt != 1 {
		t.Fatalf("unexpected entry: client=%q attempt=%d", entry.ClientType, entry.Attempt)
	}
	if entry.DownstreamTokenID == nil || *entry.DownstreamTokenID != 7 {
		t.Fatalf("downstream token was not recorded: %+v", entry.DownstreamTokenID)
	}
	if entry.UpstreamID == nil || *entry.UpstreamID != 3 {
		t.Fatalf("upstream was not recorded: %+v", entry.UpstreamID)
	}
	// The forwarded model wins over the requested one, the same way the log row
	// reports it.
	if entry.Model == nil || *entry.Model != forward {
		t.Fatalf("expected the forwarded model, got %+v", entry.Model)
	}
	if entry.RequestModel == nil || *entry.RequestModel != model {
		t.Fatalf("expected the requested model to be retained, got %+v", entry.RequestModel)
	}
	if entry.StartedAt == "" || entry.ElapsedMs < 0 {
		t.Fatalf("unexpected timing: started=%q elapsed=%d", entry.StartedAt, entry.ElapsedMs)
	}

	// Both efforts are known before the upstream is called, which is the whole
	// point: a request that spends minutes thinking should show what it is
	// spending them at while it spends them.
	requested, rewritten := "high", "xhigh"
	request.SetReasoningEffort(&requested, &rewritten)
	requests = registry.Snapshot().Requests
	if requests[0].ReasoningEffort == nil || *requests[0].ReasoningEffort != requested {
		t.Fatalf("requested effort was not recorded: %+v", requests[0].ReasoningEffort)
	}
	if requests[0].UpstreamReasoningEffort == nil ||
		*requests[0].UpstreamReasoningEffort != rewritten {
		t.Fatalf("rewritten effort was not recorded: %+v", requests[0].UpstreamReasoningEffort)
	}

	request.Release()
	if snapshot := registry.Snapshot(); len(snapshot.Requests) != 0 {
		t.Fatalf("expected the released request to be gone, got %d", len(snapshot.Requests))
	}
}

func TestActiveRegistryCountsRetriedChannels(t *testing.T) {
	registry := NewActiveRegistry()

	request := registry.Begin("POST", "chat/completions")
	request.SetUpstream(1, "first", nil)
	request.SetUpstream(2, "second", nil)

	requests := registry.Snapshot().Requests
	if len(requests) != 1 {
		t.Fatalf("a retried request must stay one entry, got %d", len(requests))
	}
	if requests[0].Attempt != 2 {
		t.Fatalf("expected attempt 2, got %d", requests[0].Attempt)
	}
	if requests[0].UpstreamName == nil || *requests[0].UpstreamName != "second" {
		t.Fatalf("expected the current channel, got %+v", requests[0].UpstreamName)
	}
}

// A late update from a goroutine that has not noticed the request ended must not
// put the entry back, or a console would show a row that never clears.
func TestActiveRegistryIgnoresUpdatesAfterRelease(t *testing.T) {
	registry := NewActiveRegistry()

	request := registry.Begin("POST", "chat/completions")
	request.Release()
	request.SetClientType("codex")
	request.SetUpstream(9, "late", nil)

	if snapshot := registry.Snapshot(); len(snapshot.Requests) != 0 {
		t.Fatalf("a released request was resurrected: %d entries", len(snapshot.Requests))
	}
}

func TestActiveRegistryVersionMovesOnlyOnChange(t *testing.T) {
	registry := NewActiveRegistry()

	start := registry.Version()
	request := registry.Begin("GET", "models")
	afterBegin := registry.Version()
	if afterBegin == start {
		t.Fatal("registering a request must advance the version")
	}
	if registry.Version() != afterBegin {
		t.Fatal("reading the version must not advance it")
	}

	request.SetClientType("codex")
	afterUpdate := registry.Version()
	if afterUpdate == afterBegin {
		t.Fatal("an update must advance the version")
	}

	request.Release()
	if registry.Version() == afterUpdate {
		t.Fatal("releasing a request must advance the version")
	}
}

func TestActiveRegistryOrdersNewestFirst(t *testing.T) {
	registry := NewActiveRegistry()

	older := registry.Begin("POST", "chat/completions")
	newer := registry.Begin("POST", "messages")
	// Same-instant arrivals fall back to the id, which is assigned in order.
	requests := registry.Snapshot().Requests
	if len(requests) != 2 {
		t.Fatalf("expected 2 in-flight requests, got %d", len(requests))
	}
	if requests[0].Path != "messages" {
		t.Fatalf("expected the newest request first, got %q", requests[0].Path)
	}

	older.Release()
	newer.Release()
}

// The list is capped but the count is not: a console reading concurrency off
// the list length would report exactly the cap and stop moving.
func TestActiveSnapshotReportsTheTotalBehindTheCappedList(t *testing.T) {
	registry := NewActiveRegistry()

	const overflow = ActiveSnapshotLimit + 25
	for range overflow {
		registry.Begin("POST", "chat/completions")
	}

	snapshot := registry.Snapshot()
	if len(snapshot.Requests) != ActiveSnapshotLimit {
		t.Fatalf("expected the list to stop at %d, got %d",
			ActiveSnapshotLimit, len(snapshot.Requests))
	}
	if snapshot.Total != overflow {
		t.Fatalf("expected a total of %d, got %d", overflow, snapshot.Total)
	}
}

// Begin, the setters, Release, and Snapshot all run on different goroutines in
// the gateway: one per request, plus one per console connection.
func TestActiveRegistryIsSafeUnderConcurrency(t *testing.T) {
	registry := NewActiveRegistry()

	var waiting sync.WaitGroup
	for range 32 {
		waiting.Add(1)
		go func() {
			defer waiting.Done()
			request := registry.Begin("POST", "chat/completions")
			request.SetClientType("codex")
			request.SetUpstream(1, "upstream", nil)
			registry.Snapshot()
			request.Release()
		}()
	}
	for range 4 {
		waiting.Add(1)
		go func() {
			defer waiting.Done()
			for range 64 {
				registry.Snapshot()
				registry.Version()
				registry.Len()
			}
		}()
	}
	waiting.Wait()

	if registry.Len() != 0 {
		t.Fatalf("every request was released, but %d remain", registry.Len())
	}
}

// A registry that was never assembled must not force its callers to branch.
func TestNilActiveRegistryIsInert(t *testing.T) {
	var registry *ActiveRegistry

	request := registry.Begin("POST", "chat/completions")
	request.SetDownstreamToken(1, "token")
	request.SetClientType("codex")
	request.SetModel(nil)
	request.SetUpstream(1, "upstream", nil)
	request.SetReasoningEffort(nil, nil)
	request.Release()

	snapshot := registry.Snapshot()
	if snapshot.Version != 0 || snapshot.Requests != nil || snapshot.Total != 0 {
		t.Fatalf("a nil registry must report nothing: %+v", snapshot)
	}
	if registry.Len() != 0 || registry.Version() != 0 {
		t.Fatal("a nil registry must report nothing")
	}
}
