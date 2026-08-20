// Package config loads WildToken settings from TOML files and the environment.
package config

import (
	"bufio"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"github.com/BurntSushi/toml"
)

// Settings is the fully resolved startup configuration.
type Settings struct {
	Server   ServerSettings   `toml:"server"`
	Database DatabaseSettings `toml:"database"`
	Logging  LoggingSettings  `toml:"logging"`
	Upstream UpstreamSettings `toml:"upstream"`
	Admin    AdminSettings    `toml:"admin"`
	Themes   ThemeSettings    `toml:"themes"`
	Metrics  MetricsSettings  `toml:"metrics"`
}

type ServerSettings struct {
	Host string `toml:"host"`
	Port uint16 `toml:"port"`
}

type DatabaseSettings struct {
	URL                          string `toml:"url"`
	MaxConnections               int    `toml:"max_connections"`
	SQLiteCacheSizeKiB           int64  `toml:"sqlite_cache_size_kib"`
	SQLiteStatementCacheCapacity int    `toml:"sqlite_statement_cache_capacity"`
	SQLiteMmapSizeBytes          int64  `toml:"sqlite_mmap_size_bytes"`
	IdleTimeoutSeconds           int64  `toml:"idle_timeout_seconds"`
}

type LoggingSettings struct {
	LogQueueCapacity int `toml:"log_queue_capacity"`
}

type UpstreamSettings struct {
	DefaultTimeoutSeconds float64 `toml:"default_timeout_seconds"`
}

type AdminSettings struct {
	Token string `toml:"token"`
	// ClientIPHeader carries the real client address when WildToken sits behind
	// a reverse proxy, e.g. `x-forwarded-for`. Unset by default: the header is
	// caller-controlled, so trusting one that no proxy overwrites would let
	// every caller pick its own identity and shed its failure history.
	ClientIPHeader string `toml:"client_ip_header"`
}

type ThemeSettings struct {
	Dir string `toml:"dir"`
}

// MetricsSettings controls the Prometheus scrape endpoint.
//
// Disabled by default, which is the only safe default for an endpoint describing
// traffic volumes and channel health: enabling it silently on upgrade would
// publish that to anything able to reach the port.
type MetricsSettings struct {
	Enabled bool `toml:"enabled"`
	// Token guards the endpoint with `Authorization: Bearer <token>`.
	//
	// Deliberately separate from the admin credential rather than reusing it.
	// Prometheus keeps its scrape config in plain text and hands the value to a
	// long-lived process, so sharing the console's credential would put that
	// credential there too. Blank means no token, which is only appropriate when
	// the listener is already unreachable from outside — the server warns at
	// startup so that is never an accident.
	Token string `toml:"token"`
}

// EnabledWithoutToken reports the configuration that exposes metrics to any
// caller able to reach the port.
func (m MetricsSettings) EnabledWithoutToken() bool {
	return m.Enabled && strings.TrimSpace(m.Token) == ""
}

// Default returns the settings used when no file or environment overrides apply.
func Default() Settings {
	return Settings{
		Server: ServerSettings{Host: "127.0.0.1", Port: 3100},
		Database: DatabaseSettings{
			URL:                          "sqlite:wildtoken.db?mode=rwc",
			MaxConnections:               3,
			SQLiteCacheSizeKiB:           2048,
			SQLiteStatementCacheCapacity: 32,
			SQLiteMmapSizeBytes:          0,
			IdleTimeoutSeconds:           60,
		},
		Logging:  LoggingSettings{LogQueueCapacity: 512},
		Upstream: UpstreamSettings{DefaultTimeoutSeconds: 300.0},
		Admin:    AdminSettings{Token: "change-me"},
		Themes:   ThemeSettings{Dir: "themes"},
		// Off unless the operator asks for it. An upgrade must not begin publishing
		// traffic volumes and channel health to whatever can reach the port.
		Metrics: MetricsSettings{Enabled: false},
	}
}

// Load reads config/default.toml, config/<RUN_ENV>.toml, APP__* environment
// variables and the legacy .env names, in that order of increasing precedence.
func Load() (Settings, error) {
	loadDotEnv(".env")

	settings := Default()

	runEnv := os.Getenv("RUN_ENV")
	if runEnv == "" {
		runEnv = "development"
	}

	for _, name := range []string{"default", runEnv} {
		path := filepath.Join("config", name+".toml")
		if err := mergeTOMLFile(&settings, path); err != nil {
			return settings, err
		}
	}

	if err := applyEnvOverrides(&settings); err != nil {
		return settings, err
	}

	// Compatibility with legacy .env variables.
	if token := os.Getenv("ADMIN_TOKEN"); token != "" {
		settings.Admin.Token = token
	}
	if url := os.Getenv("DATABASE_URL"); url != "" {
		settings.Database.URL = url
	}
	if dir := os.Getenv("WILDTOKEN_THEME_DIR"); dir != "" {
		settings.Themes.Dir = dir
	}

	return settings, nil
}

func mergeTOMLFile(settings *Settings, path string) error {
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("read %s: %w", path, err)
	}
	if err := toml.Unmarshal(data, settings); err != nil {
		return fmt.Errorf("parse %s: %w", path, err)
	}
	return nil
}

// envOverride binds one APP__SECTION__FIELD variable to a settings field.
type envOverride struct {
	name  string
	apply func(*Settings, string) error
}

func applyEnvOverrides(settings *Settings) error {
	overrides := []envOverride{
		{"APP__SERVER__HOST", func(s *Settings, v string) error { s.Server.Host = v; return nil }},
		{"APP__SERVER__PORT", func(s *Settings, v string) error {
			port, err := strconv.ParseUint(v, 10, 16)
			if err != nil {
				return err
			}
			s.Server.Port = uint16(port)
			return nil
		}},
		{"APP__DATABASE__URL", func(s *Settings, v string) error { s.Database.URL = v; return nil }},
		{"APP__DATABASE__MAX_CONNECTIONS", func(s *Settings, v string) error {
			return parseInt(v, func(n int64) { s.Database.MaxConnections = int(n) })
		}},
		{"APP__DATABASE__SQLITE_CACHE_SIZE_KIB", func(s *Settings, v string) error {
			return parseInt(v, func(n int64) { s.Database.SQLiteCacheSizeKiB = n })
		}},
		{"APP__DATABASE__SQLITE_STATEMENT_CACHE_CAPACITY", func(s *Settings, v string) error {
			return parseInt(v, func(n int64) { s.Database.SQLiteStatementCacheCapacity = int(n) })
		}},
		{"APP__DATABASE__SQLITE_MMAP_SIZE_BYTES", func(s *Settings, v string) error {
			return parseInt(v, func(n int64) { s.Database.SQLiteMmapSizeBytes = n })
		}},
		{"APP__DATABASE__IDLE_TIMEOUT_SECONDS", func(s *Settings, v string) error {
			return parseInt(v, func(n int64) { s.Database.IdleTimeoutSeconds = n })
		}},
		{"APP__LOGGING__LOG_QUEUE_CAPACITY", func(s *Settings, v string) error {
			return parseInt(v, func(n int64) { s.Logging.LogQueueCapacity = int(n) })
		}},
		{"APP__UPSTREAM__DEFAULT_TIMEOUT_SECONDS", func(s *Settings, v string) error {
			parsed, err := strconv.ParseFloat(v, 64)
			if err != nil {
				return err
			}
			s.Upstream.DefaultTimeoutSeconds = parsed
			return nil
		}},
		{"APP__ADMIN__TOKEN", func(s *Settings, v string) error { s.Admin.Token = v; return nil }},
		{"APP__ADMIN__CLIENT_IP_HEADER", func(s *Settings, v string) error { s.Admin.ClientIPHeader = v; return nil }},
		{"APP__THEMES__DIR", func(s *Settings, v string) error { s.Themes.Dir = v; return nil }},
		{"APP__METRICS__ENABLED", func(s *Settings, v string) error {
			parsed, err := strconv.ParseBool(v)
			if err != nil {
				return err
			}
			s.Metrics.Enabled = parsed
			return nil
		}},
		{"APP__METRICS__TOKEN", func(s *Settings, v string) error { s.Metrics.Token = v; return nil }},
	}

	for _, override := range overrides {
		value, ok := os.LookupEnv(override.name)
		if !ok {
			continue
		}
		if err := override.apply(settings, value); err != nil {
			return fmt.Errorf("invalid %s: %w", override.name, err)
		}
	}
	return nil
}

func parseInt(value string, assign func(int64)) error {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return err
	}
	assign(parsed)
	return nil
}

// loadDotEnv fills in variables from a .env file without overwriting the real
// environment, matching dotenvy's precedence.
func loadDotEnv(path string) {
	file, err := os.Open(path)
	if err != nil {
		return
	}
	defer file.Close()

	scanner := bufio.NewScanner(file)
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		line = strings.TrimPrefix(line, "export ")
		key, value, found := strings.Cut(line, "=")
		if !found {
			continue
		}
		key = strings.TrimSpace(key)
		value = strings.TrimSpace(value)
		if len(value) >= 2 && (value[0] == '"' && value[len(value)-1] == '"' ||
			value[0] == '\'' && value[len(value)-1] == '\'') {
			value = value[1 : len(value)-1]
		}
		if _, exists := os.LookupEnv(key); !exists {
			os.Setenv(key, value)
		}
	}
	if err := scanner.Err(); err != nil {
		// Scanning stops at the first line longer than its buffer, silently
		// skipping the rest of the file. A setting that never took effect is
		// hard to trace back to a long line several entries earlier.
		slog.Warn("stopped reading the env file early", "path", path, "error", err)
	}
}
