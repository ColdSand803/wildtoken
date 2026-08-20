package metrics

import "sync"

// The Prometheus exposition format is written by hand rather than through
// prometheus/client_golang.
//
// Four metric families do not justify that dependency tree — it pulls in
// protobuf, procfs and a process collector this service does not want — and the
// text format is a stable, documented contract of two line shapes. What the
// library would buy is correctness of the format; the tests here assert that
// directly instead.

// Label values are a closed set on purpose. Everything below is bounded by
// configuration, not by request content.
const (
	// ProtocolOpenAI and ProtocolAnthropic name the dialect a request spoke.
	ProtocolOpenAI    = "openai"
	ProtocolAnthropic = "anthropic"

	// Status classes mirror the log status buckets, which is what makes a
	// Prometheus alert and a console filter agree about what failed.
	StatusClass2xx   = "2xx"
	StatusClass4xx   = "4xx"
	StatusClass5xx   = "5xx"
	StatusClassOther = "other"
	StatusClassNone  = "none"
)

// Token dimension labels, matching the usage fields the log row records.
const (
	TokenKindPrompt      = "prompt"
	TokenKindCompletion  = "completion"
	TokenKindCacheRead   = "cache_read"
	TokenKindCacheCreate = "cache_create"
	TokenKindReasoning   = "reasoning"
)

// StatusClassOf maps a status code onto its bucket. A nil code is "none",
// meaning the request never got a status — not that it succeeded.
func StatusClassOf(status *int32) string {
	if status == nil {
		return StatusClassNone
	}
	switch code := *status; {
	case code >= 200 && code <= 299:
		return StatusClass2xx
	case code >= 400 && code <= 499:
		return StatusClass4xx
	case code >= 500 && code <= 599:
		return StatusClass5xx
	default:
		return StatusClassOther
	}
}

// durationBuckets are the histogram's upper bounds in seconds.
//
// Chosen for what this service actually proxies: an LLM call is slow, and the
// default client_golang buckets (topping out at 10s) would put most traffic in
// +Inf and answer no latency question at all. The spread runs from a fast cached
// completion to a long reasoning stream.
// A fixed-size array rather than a slice, so histogram.counts can be sized from
// it at compile time and so a histogram remains copyable by value — the renderer
// takes a snapshot under the lock and formats it outside, which a slice would
// undermine by sharing its backing array.
const durationBucketCount = 11

var durationBuckets = [durationBucketCount]float64{
	0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300,
}

// requestKey is one series of the request counter and the duration histogram.
//
// Every field is bounded: upstream_id by the configured channels, status_class by
// the five constants above, protocol by two. Deliberately absent are token id,
// token name and the model string — the checklist forbids them, and the reason is
// that a model name arrives from the client, so labelling by it lets any caller
// mint unbounded time series by varying one JSON field.
type requestKey struct {
	upstreamID  int64
	statusClass string
	protocol    string
}

// maxRequestSeries bounds the series map.
//
// The labels are bounded by configuration, so this is not reachable in a healthy
// deployment. It exists because SQLite reuses channel ids and an operator churning
// channels over a long uptime would otherwise accumulate series for channels that
// no longer exist. Reaching it drops new series rather than evicting old ones:
// dropping is visible as a missing channel, whereas evicting silently corrupts the
// counters that remain, and a counter that goes backwards makes rate() produce
// garbage.
const maxRequestSeries = 4096

// histogram is one series' bucket counts plus its sum.
type histogram struct {
	// counts[i] is the number of observations at or below durationBuckets[i].
	// Cumulative totals are produced at render time, so an observation only
	// touches one bucket.
	// counts[i] is the number of observations at or below durationBuckets[i]; the
	// extra trailing slot is +Inf. Cumulative totals are produced at render time,
	// so an observation only touches one bucket.
	counts [durationBucketCount + 1]uint64
	sum    float64
	total  uint64
}

func (h *histogram) observe(seconds float64) {
	h.total++
	h.sum += seconds
	for index, bound := range durationBuckets {
		if seconds <= bound {
			h.counts[index]++
			return
		}
	}
	h.counts[durationBucketCount]++
}

// Prometheus holds the labelled series the scrape endpoint renders.
//
// It is separate from Runtime, whose counters serve the console's JSON endpoint.
// The two are kept apart because they are different contracts: the JSON shape may
// change with the console, while a Prometheus metric name and its label set are
// something an operator's dashboards and alert rules are written against.
type Prometheus struct {
	mu        sync.Mutex
	requests  map[requestKey]uint64
	durations map[requestKey]*histogram
	tokens    map[string]uint64
	// seriesDropped counts series refused at the cardinality cap, so a scrape can
	// show that the numbers are incomplete rather than looking merely quiet.
	seriesDropped uint64
	// health is the last reported score per channel, a gauge rather than a counter.
	health map[int64]float64
}

func NewPrometheus() *Prometheus {
	return &Prometheus{
		requests:  map[requestKey]uint64{},
		durations: map[requestKey]*histogram{},
		tokens:    map[string]uint64{},
		health:    map[int64]float64{},
	}
}

// RecordRequest folds one completed upstream attempt into the counters.
//
// upstreamID is 0 for a request that reached no channel; it is recorded under that
// id rather than dropped, because "requests that never routed" is exactly what an
// alert on a misconfigured gateway needs to see.
//
// durationSeconds is negative when the request had no measured duration, in which
// case the histogram is left alone: a request whose timing is unknown is not a fast
// request, and folding it in as zero would pull every latency quantile down.
//
// A nil receiver is a no-op, so a caller assembled without metrics — a test
// harness, a probe — needs no guard at the call site.
func (p *Prometheus) RecordRequest(upstreamID int64, statusClass, protocol string,
	durationSeconds float64) {
	if p == nil {
		return
	}
	key := requestKey{upstreamID: upstreamID, statusClass: statusClass, protocol: protocol}

	p.mu.Lock()
	defer p.mu.Unlock()

	if _, known := p.requests[key]; !known && len(p.requests) >= maxRequestSeries {
		p.seriesDropped++
		return
	}
	p.requests[key]++

	if durationSeconds < 0 {
		return
	}
	bucket := p.durations[key]
	if bucket == nil {
		bucket = &histogram{}
		p.durations[key] = bucket
	}
	bucket.observe(durationSeconds)
}

// RecordTokens adds one request's usage to the per-dimension totals.
//
// The dimensions are the five the log row records, with no model or token label —
// this is a fleet-wide total, and the per-model breakdown lives in the console
// where it can be shown without becoming a permanent time series.
func (p *Prometheus) RecordTokens(prompt, completion, cacheRead, cacheCreate, reasoning int64) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	for kind, amount := range map[string]int64{
		TokenKindPrompt:      prompt,
		TokenKindCompletion:  completion,
		TokenKindCacheRead:   cacheRead,
		TokenKindCacheCreate: cacheCreate,
		TokenKindReasoning:   reasoning,
	} {
		if amount > 0 {
			p.tokens[kind] += uint64(amount)
		}
	}
}

// SetHealth publishes a channel's current health score.
//
// A gauge, so it is set rather than accumulated, and it is written from the
// routing path rather than sampled at scrape time: sampling would need the scrape
// handler to reach into the routing cache and the database, which puts a query on
// an endpoint that must stay cheap enough to poll every fifteen seconds.
func (p *Prometheus) SetHealth(upstreamID int64, score float64) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()
	p.health[upstreamID] = score
}

// ForgetUpstream drops a deleted channel's series.
//
// Without this, SQLite reusing the id would let a new channel inherit its
// predecessor's counters — and a counter that jumps is indistinguishable from real
// traffic to anything computing a rate.
func (p *Prometheus) ForgetUpstream(upstreamID int64) {
	if p == nil {
		return
	}
	p.mu.Lock()
	defer p.mu.Unlock()

	delete(p.health, upstreamID)
	for key := range p.requests {
		if key.upstreamID == upstreamID {
			delete(p.requests, key)
			delete(p.durations, key)
		}
	}
}
