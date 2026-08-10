// Package metrics tracks in-process counters the admin console reports.
package metrics

import (
	"sync"
	"sync/atomic"
	"time"
)

// sseRecentDisconnectWindow bounds the rolling disconnect count.
const sseRecentDisconnectWindow = 10 * time.Minute

// Snapshot is a consistent read of every counter.
type Snapshot struct {
	ActiveSSEStreams          uint64
	SSECompletedTotal         uint64
	SSEClientDisconnectsTotal uint64
	SSERecentDisconnects10m   uint64
	SSEUpstreamErrorsTotal    uint64
	LogQueueDepth             uint64
	LogWrittenTotal           uint64
	LogWriteBatchesTotal      uint64
	LogDroppedTotal           uint64
	LogWriteFailuresTotal     uint64
	SlowDBOperationsTotal     uint64

	CleanupActive                  bool
	CleanupRunsTotal               uint64
	CleanupErrorsTotal             uint64
	CleanupRowsClearedTotal        uint64
	CleanupBatchesTotal            uint64
	CleanupCurrentRowsCleared      uint64
	CleanupCurrentBatches          uint64
	CleanupLastStartedUnixSeconds  *int64
	CleanupLastFinishedUnixSeconds *int64
	CleanupLastDurationMs          *uint64
	CleanupLastRowsCleared         uint64
}

// Runtime holds the live counters. The zero value is ready to use.
type Runtime struct {
	activeSSEStreams          atomic.Uint64
	sseCompletedTotal         atomic.Uint64
	sseClientDisconnectsTotal atomic.Uint64
	sseUpstreamErrorsTotal    atomic.Uint64
	logQueueDepth             atomic.Uint64
	logWrittenTotal           atomic.Uint64
	logWriteBatchesTotal      atomic.Uint64
	logDroppedTotal           atomic.Uint64
	logWriteFailuresTotal     atomic.Uint64
	slowDBOperationsTotal     atomic.Uint64

	cleanupActive                  atomic.Bool
	cleanupRunsTotal               atomic.Uint64
	cleanupErrorsTotal             atomic.Uint64
	cleanupRowsClearedTotal        atomic.Uint64
	cleanupBatchesTotal            atomic.Uint64
	cleanupCurrentRowsCleared      atomic.Uint64
	cleanupCurrentBatches          atomic.Uint64
	cleanupLastStartedUnixSeconds  atomic.Int64
	cleanupLastFinishedUnixSeconds atomic.Int64
	cleanupLastDurationMs          atomic.Uint64
	cleanupLastRowsCleared         atomic.Uint64

	recentMu             sync.Mutex
	recentSSEDisconnects []time.Time
}

func New() *Runtime { return &Runtime{} }

func (r *Runtime) StartSSEStream() { r.activeSSEStreams.Add(1) }

// FinishSSEStream decrements without wrapping past zero.
func (r *Runtime) FinishSSEStream() {
	for {
		current := r.activeSSEStreams.Load()
		if current == 0 {
			return
		}
		if r.activeSSEStreams.CompareAndSwap(current, current-1) {
			return
		}
	}
}

func (r *Runtime) RecordSSEComplete() { r.sseCompletedTotal.Add(1) }

func (r *Runtime) RecordSSEClientDisconnect() {
	r.sseClientDisconnectsTotal.Add(1)

	r.recentMu.Lock()
	defer r.recentMu.Unlock()
	r.recentSSEDisconnects = append(r.recentSSEDisconnects, time.Now())
	r.pruneRecentLocked(time.Now())
}

func (r *Runtime) RecordSSEUpstreamError() { r.sseUpstreamErrorsTotal.Add(1) }

func (r *Runtime) RecordLogEnqueue() { r.logQueueDepth.Add(1) }

// RecordLogDequeue subtracts without wrapping past zero.
func (r *Runtime) RecordLogDequeue(count uint64) {
	for {
		current := r.logQueueDepth.Load()
		next := uint64(0)
		if current > count {
			next = current - count
		}
		if r.logQueueDepth.CompareAndSwap(current, next) {
			return
		}
	}
}

func (r *Runtime) RecordLogWritten(count uint64) {
	if count == 0 {
		return
	}
	r.logWrittenTotal.Add(count)
	r.logWriteBatchesTotal.Add(1)
}

func (r *Runtime) RecordLogDrop() { r.logDroppedTotal.Add(1) }

func (r *Runtime) RecordLogWriteFailureCount(count uint64) { r.logWriteFailuresTotal.Add(count) }

func (r *Runtime) RecordSlowDBOperation() { r.slowDBOperationsTotal.Add(1) }

func (r *Runtime) BeginCleanup() {
	r.cleanupActive.Store(true)
	r.cleanupCurrentRowsCleared.Store(0)
	r.cleanupCurrentBatches.Store(0)
	r.cleanupLastStartedUnixSeconds.Store(time.Now().Unix())
	r.cleanupRunsTotal.Add(1)
}

func (r *Runtime) RecordCleanupBatch(rowsCleared uint64) {
	if rowsCleared == 0 {
		return
	}
	r.cleanupCurrentRowsCleared.Add(rowsCleared)
	r.cleanupRowsClearedTotal.Add(rowsCleared)
	r.cleanupCurrentBatches.Add(1)
	r.cleanupBatchesTotal.Add(1)
}

func (r *Runtime) FinishCleanup(success bool, duration time.Duration) {
	if !success {
		r.cleanupErrorsTotal.Add(1)
	}
	r.cleanupLastFinishedUnixSeconds.Store(time.Now().Unix())
	r.cleanupLastDurationMs.Store(uint64(duration.Milliseconds()))
	r.cleanupLastRowsCleared.Store(r.cleanupCurrentRowsCleared.Load())
	r.cleanupActive.Store(false)
}

// Snapshot reads every counter, pruning the rolling disconnect window first.
func (r *Runtime) Snapshot() Snapshot {
	r.recentMu.Lock()
	r.pruneRecentLocked(time.Now())
	recentDisconnects := uint64(len(r.recentSSEDisconnects))
	r.recentMu.Unlock()

	return Snapshot{
		ActiveSSEStreams:          r.activeSSEStreams.Load(),
		SSECompletedTotal:         r.sseCompletedTotal.Load(),
		SSEClientDisconnectsTotal: r.sseClientDisconnectsTotal.Load(),
		SSERecentDisconnects10m:   recentDisconnects,
		SSEUpstreamErrorsTotal:    r.sseUpstreamErrorsTotal.Load(),
		LogQueueDepth:             r.logQueueDepth.Load(),
		LogWrittenTotal:           r.logWrittenTotal.Load(),
		LogWriteBatchesTotal:      r.logWriteBatchesTotal.Load(),
		LogDroppedTotal:           r.logDroppedTotal.Load(),
		LogWriteFailuresTotal:     r.logWriteFailuresTotal.Load(),
		SlowDBOperationsTotal:     r.slowDBOperationsTotal.Load(),

		CleanupActive:                  r.cleanupActive.Load(),
		CleanupRunsTotal:               r.cleanupRunsTotal.Load(),
		CleanupErrorsTotal:             r.cleanupErrorsTotal.Load(),
		CleanupRowsClearedTotal:        r.cleanupRowsClearedTotal.Load(),
		CleanupBatchesTotal:            r.cleanupBatchesTotal.Load(),
		CleanupCurrentRowsCleared:      r.cleanupCurrentRowsCleared.Load(),
		CleanupCurrentBatches:          r.cleanupCurrentBatches.Load(),
		CleanupLastStartedUnixSeconds:  nonZeroInt64(r.cleanupLastStartedUnixSeconds.Load()),
		CleanupLastFinishedUnixSeconds: nonZeroInt64(r.cleanupLastFinishedUnixSeconds.Load()),
		CleanupLastDurationMs:          nonZeroUint64(r.cleanupLastDurationMs.Load()),
		CleanupLastRowsCleared:         r.cleanupLastRowsCleared.Load(),
	}
}

// pruneRecentLocked drops disconnects that fell out of the window. The caller
// must hold recentMu.
func (r *Runtime) pruneRecentLocked(now time.Time) {
	cutoff := now.Add(-sseRecentDisconnectWindow)
	kept := 0
	for _, at := range r.recentSSEDisconnects {
		if at.After(cutoff) || at.Equal(cutoff) {
			break
		}
		kept++
	}
	if kept > 0 {
		r.recentSSEDisconnects = r.recentSSEDisconnects[kept:]
	}
}

func nonZeroInt64(value int64) *int64 {
	if value <= 0 {
		return nil
	}
	return &value
}

func nonZeroUint64(value uint64) *uint64 {
	if value == 0 {
		return nil
	}
	return &value
}
