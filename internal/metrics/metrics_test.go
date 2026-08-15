package metrics

import (
	"testing"
	"time"
)

func TestRecentDisconnectsAreCountedPerSecondNotPerEvent(t *testing.T) {
	runtime := New()

	// A client can open and abandon streams as fast as it likes. The window
	// used to keep a timestamp for every one of them, so ten minutes of that
	// was hundreds of megabytes behind a number rendered as one integer.
	const disconnects = 20000
	for range disconnects {
		runtime.RecordSSEClientDisconnect()
	}

	snapshot := runtime.Snapshot()
	if snapshot.SSEClientDisconnectsTotal != disconnects {
		t.Errorf("total = %d, want %d", snapshot.SSEClientDisconnectsTotal, disconnects)
	}
	if snapshot.SSERecentDisconnects10m != disconnects {
		t.Errorf("recent = %d, want %d", snapshot.SSERecentDisconnects10m, disconnects)
	}

	runtime.recentMu.Lock()
	buckets := len(runtime.recentSSEDisconnects)
	runtime.recentMu.Unlock()

	// One bucket per second, so the window can never hold more than its own
	// length however many disconnects land in it.
	if maxBuckets := int(sseRecentDisconnectWindow/time.Second) + 1; buckets > maxBuckets {
		t.Errorf("held %d buckets for %d disconnects, want at most %d",
			buckets, disconnects, maxBuckets)
	}
}

func TestDisconnectsLeaveTheWindowWhenItSlides(t *testing.T) {
	runtime := New()
	runtime.RecordSSEClientDisconnect()

	// Age the recorded bucket past the window rather than waiting one out.
	runtime.recentMu.Lock()
	for i := range runtime.recentSSEDisconnects {
		runtime.recentSSEDisconnects[i].second -= int64(sseRecentDisconnectWindow/time.Second) + 60
	}
	runtime.recentMu.Unlock()

	snapshot := runtime.Snapshot()
	if snapshot.SSERecentDisconnects10m != 0 {
		t.Errorf("recent = %d, want the window to have slid past it",
			snapshot.SSERecentDisconnects10m)
	}
	// The lifetime total is not a window and must survive.
	if snapshot.SSEClientDisconnectsTotal != 1 {
		t.Errorf("total = %d, want 1", snapshot.SSEClientDisconnectsTotal)
	}
}
