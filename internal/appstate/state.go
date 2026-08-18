// Package app wires the HTTP server, its shared state, and background tasks.
package appstate

import (
	"context"
	"database/sql"
	"encoding/json"
	"log/slog"
	"net/http"
	"sync"
	"time"

	"github.com/liguangsheng/wildtoken/internal/authstate"
	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
	"github.com/liguangsheng/wildtoken/internal/quota"
	"github.com/liguangsheng/wildtoken/internal/ratelimit"
)

// SettingsStore holds the operator-editable runtime policy.
//
// It is read on every proxied request and written only by the admin console, so
// reads take a shared lock and the value is copied out rather than shared.
type SettingsStore struct {
	mu      sync.RWMutex
	current models.RuntimeSettings
}

func NewSettingsStore(initial models.RuntimeSettings) *SettingsStore {
	return &SettingsStore{current: initial}
}

func (s *SettingsStore) Get() models.RuntimeSettings {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.current
}

func (s *SettingsStore) Set(settings models.RuntimeSettings) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.current = settings
}

// ModelsListCache caches the aggregated GET /v1/models response per group.
//
// The response is keyed by group because a token only reaches its own group's
// channels: one shared entry would advertise models a caller cannot route to.
//
// It is invalidated explicitly on upstream and group write operations.
// Concurrent misses may reload the same value, which is intentional and harmless.
type ModelsListCache struct {
	mu      sync.RWMutex
	byGroup map[int64]json.RawMessage
}

func NewModelsListCache() *ModelsListCache {
	return &ModelsListCache{byGroup: map[int64]json.RawMessage{}}
}

func (c *ModelsListCache) Get(groupID int64) json.RawMessage {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.byGroup[groupID]
}

func (c *ModelsListCache) Set(groupID int64, value json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.byGroup[groupID] = value
}

// Invalidate drops every group's entry, because one channel edit can change
// what several groups advertise.
func (c *ModelsListCache) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	clear(c.byGroup)
}

// ProbeResult is one channel's outcome from the most recent batch probe.
//
// This is deliberately separate from the 24h traffic health the channel cards
// also show: that one summarises real proxied requests, this one is a single
// synthetic request an operator asked for just now. Merging them would let a
// probe rewrite the traffic history, or a quiet channel look unreachable.
type ProbeResult struct {
	UpstreamID   int64   `json:"upstream_id"`
	OK           bool    `json:"ok"`
	StatusCode   *int32  `json:"status_code"`
	DurationMs   *int32  `json:"duration_ms"`
	ErrorSummary *string `json:"error_summary"`
	CheckedAt    string  `json:"checked_at"`
}

// ProbeRunState holds the last batch-probe results and serialises the runs.
//
// Results live in memory rather than SQLite: they describe reachability at one
// instant, which is stale by the time a restart is over, and persisting them
// would invite reading an old row as current status. The trade-off is that a
// restart clears the badges until the next run, which is noted in the API
// contract.
type ProbeRunState struct {
	mu      sync.RWMutex
	running bool
	results map[int64]ProbeResult
	// startedAt and finishedAt describe the most recent run for the console's
	// "last checked" line.
	startedAt  time.Time
	finishedAt time.Time
}

func NewProbeRunState() *ProbeRunState {
	return &ProbeRunState{results: map[int64]ProbeResult{}}
}

// TryStart claims the right to run a batch probe, returning false when one is
// already in flight.
//
// A batch probe sends one request per channel, so a double-clicked button or two
// open consoles would multiply that load against every upstream at once. The
// second caller is refused rather than queued: by the time the first finishes,
// its results are the answer the second wanted.
func (p *ProbeRunState) TryStart(now time.Time) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.running {
		return false
	}
	p.running = true
	p.startedAt = now
	return true
}

// Finish records a completed run and publishes its results.
//
// Results replace the previous run's entries for the channels probed and leave
// the rest alone, so probing a subset does not erase badges for the others.
func (p *ProbeRunState) Finish(results []ProbeResult, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for _, result := range results {
		p.results[result.UpstreamID] = result
	}
	p.running = false
	p.finishedAt = now
}

// Abandon releases the run lock without publishing results, for a run that was
// cancelled before it could finish.
func (p *ProbeRunState) Abandon() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.running = false
}

// Snapshot returns the cached results and whether a run is in flight.
func (p *ProbeRunState) Snapshot() (map[int64]ProbeResult, bool, time.Time) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	copied := make(map[int64]ProbeResult, len(p.results))
	for id, result := range p.results {
		copied[id] = result
	}
	return copied, p.running, p.finishedAt
}

// Forget drops a channel's cached result, for when that channel is deleted.
func (p *ProbeRunState) Forget(upstreamID int64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	delete(p.results, upstreamID)
}

// State is the shared application state every handler receives.
type State struct {
	DB          *sql.DB
	HTTPClient  *http.Client
	Settings    config.Settings
	AutoWeight  *proxy.AutoWeightManager
	Runtime     *SettingsStore
	Credentials *authstate.Credentials
	Throttle    *authstate.Throttle
	Metrics     *metrics.Runtime
	LogWriter   *proxy.LogWriter
	LogStats    *db.LogStatsCache
	ModelsCache *ModelsListCache
	Routing     *proxy.RoutingCache
	// TokenRateLimiter and UpstreamRateLimiter enforce the per-token and
	// per-channel rate expressions. They must stay separate instances: both key
	// their windows by an int64 id, so sharing one would let a token and a
	// channel with the same id count against each other.
	TokenRateLimiter    *ratelimit.Limiter
	UpstreamRateLimiter *ratelimit.Limiter
	// Quotas holds the usage that a token has committed to but that its stored
	// total does not show yet, so admission weighs requests still in flight.
	Quotas *quota.Tracker
	// ProbeRuns carries the last batch-probe results and keeps concurrent runs
	// from multiplying probe load across every channel.
	ProbeRuns *ProbeRunState
	StartedAt time.Time
}

// ProxyDeps assembles the dependencies one forwarded request needs.
func (s *State) ProxyDeps() proxy.Deps {
	return proxy.Deps{
		HTTPClient:     s.HTTPClient,
		AutoWeight:     s.AutoWeight,
		Metrics:        s.Metrics,
		LogWriter:      s.LogWriter,
		DefaultTimeout: time.Duration(s.Settings.Upstream.DefaultTimeoutSeconds * float64(time.Second)),
	}
}

// AutoWeightPolicy reads the current health policy.
func (s *State) AutoWeightPolicy() proxy.AutoWeightPolicy {
	settings := s.Runtime.Get()
	return proxy.NewAutoWeightPolicy(&settings)
}

// LoadRuntimeSettings reads the persisted policy, falling back to safe startup
// defaults if it is absent or invalid.
func LoadRuntimeSettings(ctx context.Context, database *sql.DB) models.RuntimeSettings {
	settings, ok, err := db.LoadRuntimeSettings(ctx, database)
	switch {
	case err != nil:
		slog.Warn("could not load runtime_settings; using startup defaults", "error", err)
		return models.DefaultRuntimeSettings()
	case !ok:
		slog.Warn("runtime_settings row is missing; using startup defaults")
		return models.DefaultRuntimeSettings()
	}
	if err := settings.Validate(); err != nil {
		slog.Warn("runtime_settings contains invalid values; using startup defaults", "error", err)
		return models.DefaultRuntimeSettings()
	}
	settings.DatabaseOverride = true
	return settings
}
