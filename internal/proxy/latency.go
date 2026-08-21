package proxy

import (
	"sort"
	"sync"
	"time"
)

// LatencySampleCapacity is how many recent measurements one channel keeps.
//
// Bounded because this lives on the routing hot path: the dashboard's latency
// figures come from scanning request_logs, which is a query no request can
// afford to make before choosing a channel. A ring of this size is a few hundred
// bytes per channel and answers in constant time.
//
// Sized to cover a minute or two of steady traffic on a busy channel — long
// enough that one slow request does not move the median, short enough that a
// channel which has genuinely become slow is reflected within seconds.
const LatencySampleCapacity = 32

// LatencyStaleWindow is how old a sample may be and still describe the channel.
//
// Past it the measurement is dropped rather than aged down. A channel that
// served traffic an hour ago and has been idle since has no current latency, and
// reporting the old figure as its speed is how a channel that has degraded in
// the meantime keeps winning every routing decision.
const LatencyStaleWindow = 5 * time.Minute

// LatencyMinSamples is how many fresh samples a channel needs before its median
// is used to rank it.
//
// Below this the figure is one or two requests, which is noise: a single lucky
// 40ms response would otherwise take every request from a channel that has
// answered a thousand in 60ms. An under-sampled channel is not excluded — it is
// treated as unmeasured, which keeps it in contention so it can earn its samples.
const LatencyMinSamples = 5

// latencyRing is one channel's bounded sample history.
type latencyRing struct {
	// values and takenAt are parallel: values[i] was measured at takenAt[i].
	values  []int32
	takenAt []time.Time
	next    int
}

func (r *latencyRing) record(value int32, now time.Time) {
	if len(r.values) < LatencySampleCapacity {
		r.values = append(r.values, value)
		r.takenAt = append(r.takenAt, now)
		return
	}
	r.values[r.next] = value
	r.takenAt[r.next] = now
	r.next = (r.next + 1) % LatencySampleCapacity
}

// fresh returns the samples still inside the staleness window.
func (r *latencyRing) fresh(now time.Time) []int32 {
	cutoff := now.Add(-LatencyStaleWindow)
	fresh := make([]int32, 0, len(r.values))
	for i, takenAt := range r.takenAt {
		if takenAt.After(cutoff) {
			fresh = append(fresh, r.values[i])
		}
	}
	return fresh
}

// LatencyReading is what routing and the console see of one channel's speed.
type LatencyReading struct {
	// MedianMs is the middle of the fresh samples. Valid only when Usable.
	MedianMs int32
	// SampleCount is how many fresh samples backed it, including when there were
	// too few to be usable — the console shows that as "collecting samples"
	// rather than as no data at all.
	SampleCount int
	// Usable reports whether the reading may rank this channel: enough fresh
	// samples to be more than noise.
	Usable bool
}

// LatencyTracker keeps a bounded rolling latency per upstream.
//
// The median is used rather than the mean, because one 30-second outlier — a
// cold start, a retried TLS handshake, a provider hiccup — pulls a mean of eight
// samples past every competitor and keeps it there for the whole window. The
// median ignores it, which is the outlier handling this needs; no separate
// trimming rule is required.
type LatencyTracker struct {
	mu    sync.Mutex
	rings map[int64]*latencyRing
	// now is swappable so tests can advance time without sleeping, matching
	// AutoWeightManager.
	now func() time.Time
}

func NewLatencyTracker() *LatencyTracker {
	return &LatencyTracker{rings: map[int64]*latencyRing{}, now: time.Now}
}

// Record folds one successful attempt's time-to-first-byte into a channel's
// history.
//
// A nil measurement is ignored rather than stored as zero: a response whose
// timing was not sampled is not a fast response. A nil tracker is also ignored,
// so a caller assembled without one — a test harness, a probe — does not have to
// guard every call site.
func (t *LatencyTracker) Record(upstreamID int64, measuredMs *int32) {
	if t == nil || measuredMs == nil || *measuredMs < 0 {
		return
	}
	now := t.now()

	t.mu.Lock()
	defer t.mu.Unlock()

	ring, ok := t.rings[upstreamID]
	if !ok {
		ring = &latencyRing{}
		t.rings[upstreamID] = ring
	}
	ring.record(*measuredMs, now)
}

// Read reports a channel's current latency.
func (t *LatencyTracker) Read(upstreamID int64) LatencyReading {
	if t == nil {
		return LatencyReading{}
	}
	now := t.now()

	t.mu.Lock()
	defer t.mu.Unlock()

	ring, ok := t.rings[upstreamID]
	if !ok {
		return LatencyReading{}
	}
	fresh := ring.fresh(now)
	if len(fresh) == 0 {
		// Every sample aged out. The ring is dropped so an idle channel stops
		// costing memory, and the next request re-creates it.
		delete(t.rings, upstreamID)
		return LatencyReading{}
	}

	reading := LatencyReading{SampleCount: len(fresh)}
	if len(fresh) < LatencyMinSamples {
		return reading
	}
	sort.Slice(fresh, func(i, j int) bool { return fresh[i] < fresh[j] })
	reading.MedianMs = fresh[len(fresh)/2]
	reading.Usable = true
	return reading
}

// ReadAll reports every channel that currently has samples.
//
// Built for the console, which needs one answer covering all channels rather
// than a Read per row. Channels with no samples are simply absent: the caller
// knows which channels exist, and the absence is what "no data" means.
func (t *LatencyTracker) ReadAll() map[int64]LatencyReading {
	if t == nil {
		return nil
	}
	now := t.now()

	t.mu.Lock()
	defer t.mu.Unlock()

	readings := make(map[int64]LatencyReading, len(t.rings))
	for upstreamID, ring := range t.rings {
		fresh := ring.fresh(now)
		if len(fresh) == 0 {
			// Same bookkeeping Read does: an idle channel stops costing memory.
			delete(t.rings, upstreamID)
			continue
		}
		reading := LatencyReading{SampleCount: len(fresh)}
		if len(fresh) >= LatencyMinSamples {
			sort.Slice(fresh, func(i, j int) bool { return fresh[i] < fresh[j] })
			reading.MedianMs = fresh[len(fresh)/2]
			reading.Usable = true
		}
		readings[upstreamID] = reading
	}
	return readings
}

// Reset drops a channel's history, for a channel that was edited or deleted.
//
// A base URL or model mapping change makes the old measurements describe
// something the channel no longer is.
func (t *LatencyTracker) Reset(upstreamID int64) {
	if t == nil {
		return
	}
	t.mu.Lock()
	defer t.mu.Unlock()
	delete(t.rings, upstreamID)
}
