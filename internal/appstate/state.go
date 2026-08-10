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

	"github.com/wildtoken/wildtoken/internal/authstate"
	"github.com/wildtoken/wildtoken/internal/config"
	"github.com/wildtoken/wildtoken/internal/db"
	"github.com/wildtoken/wildtoken/internal/metrics"
	"github.com/wildtoken/wildtoken/internal/models"
	"github.com/wildtoken/wildtoken/internal/proxy"
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

// ModelsListCache caches the aggregated GET /v1/models response.
//
// It is invalidated explicitly on upstream write operations. Concurrent misses
// may reload the same value, which is intentional and harmless.
type ModelsListCache struct {
	mu    sync.RWMutex
	value json.RawMessage
}

func NewModelsListCache() *ModelsListCache { return &ModelsListCache{} }

func (c *ModelsListCache) Get() json.RawMessage {
	c.mu.RLock()
	defer c.mu.RUnlock()
	return c.value
}

func (c *ModelsListCache) Set(value json.RawMessage) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.value = value
}

func (c *ModelsListCache) Invalidate() {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.value = nil
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
	StartedAt   time.Time
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
