// Package db owns the SQLite schema and every query WildToken issues.
package db

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"strings"
)

// ensureColumn adds a column when a database created by an older schema lacks it.
func ensureColumn(ctx context.Context, db *sql.DB, table, column, definition string) error {
	var exists int64
	query := fmt.Sprintf("SELECT COUNT(*) FROM pragma_table_info('%s') WHERE name = ?", table)
	if err := db.QueryRowContext(ctx, query, column).Scan(&exists); err != nil {
		return err
	}
	if exists != 0 {
		return nil
	}
	_, err := db.ExecContext(ctx, fmt.Sprintf("ALTER TABLE %s ADD COLUMN %s %s", table, column, definition))
	return err
}

// Init creates the current database schema, seeds defaults, and enables the
// SQLite runtime settings WildToken depends on.
func Init(ctx context.Context, db *sql.DB) error {
	statements := []string{
		"PRAGMA journal_mode=WAL;",
		"PRAGMA foreign_keys=ON;",
		createUpstreams,
		createModelTestPromptTemplates,
		seedModelTestPromptTemplates,
		createAdminCredential,
		"CREATE INDEX IF NOT EXISTS idx_upstreams_enabled_priority ON upstreams(enabled, priority, id);",
		createRequestLogs,
		createRequestLogPayloads,
		"CREATE INDEX IF NOT EXISTS idx_request_logs_created_at ON request_logs(created_at);",
		"CREATE INDEX IF NOT EXISTS idx_request_logs_created_at_id_desc ON request_logs(created_at DESC, id DESC);",
		"CREATE INDEX IF NOT EXISTS idx_request_logs_upstream_created_at ON request_logs(upstream_id, created_at);",
		"CREATE INDEX IF NOT EXISTS idx_request_logs_upstream_created_at_id_desc ON request_logs(upstream_id, created_at DESC, id DESC);",
		"CREATE INDEX IF NOT EXISTS idx_request_log_payloads_bodies_cleared ON request_log_payloads(bodies_cleared, request_log_id);",
		createAPITokens,
	}
	for _, statement := range statements {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("schema statement failed: %w", err)
		}
	}

	for _, column := range []struct{ name, definition string }{
		{"weight", "INTEGER NOT NULL DEFAULT 100 CHECK (weight BETWEEN 0 AND 10000)"},
		{"auto_weight_enabled", "INTEGER NOT NULL DEFAULT 1 CHECK (auto_weight_enabled IN (0, 1))"},
	} {
		if err := ensureColumn(ctx, db, "upstreams", column.name, column.definition); err != nil {
			return err
		}
	}

	for _, column := range []struct{ name, definition string }{
		{"request_model", "TEXT"},
		{"upstream_model", "TEXT"},
		{"prompt_cached_tokens", "INTEGER"},
		{"cache_creation_tokens", "INTEGER"},
		{"completion_reasoning_tokens", "INTEGER"},
	} {
		if err := ensureColumn(ctx, db, "request_logs", column.name, column.definition); err != nil {
			return err
		}
	}

	if err := ensureColumn(ctx, db, "api_tokens", "expires_at", "TEXT"); err != nil {
		return err
	}
	if err := MigrateLegacyTokenStorage(ctx, db); err != nil {
		return err
	}

	if _, err := db.ExecContext(ctx, createRuntimeSettings); err != nil {
		return err
	}
	for _, column := range []struct{ name, definition string }{
		{"max_retries", "INTEGER NOT NULL DEFAULT 1 CHECK (max_retries BETWEEN 0 AND 5)"},
		{"same_upstream_retry_interval_ms", "INTEGER NOT NULL DEFAULT 1000 CHECK (same_upstream_retry_interval_ms BETWEEN 0 AND 60000)"},
		{"auto_weight_failure_penalty", "INTEGER NOT NULL DEFAULT 20 CHECK (auto_weight_failure_penalty BETWEEN 0 AND 100)"},
		{"auto_weight_success_increment", "INTEGER NOT NULL DEFAULT 5 CHECK (auto_weight_success_increment BETWEEN 0 AND 100)"},
		{"auto_weight_recovery_increment", "INTEGER NOT NULL DEFAULT 10 CHECK (auto_weight_recovery_increment BETWEEN 0 AND 100)"},
		{"auto_weight_recovery_interval_seconds", "INTEGER NOT NULL DEFAULT 60 CHECK (auto_weight_recovery_interval_seconds BETWEEN 1 AND 3600)"},
	} {
		if err := ensureColumn(ctx, db, "runtime_settings", column.name, column.definition); err != nil {
			return err
		}
	}
	if _, err := db.ExecContext(ctx, seedRuntimeSettings); err != nil {
		return err
	}

	if _, err := db.ExecContext(ctx, createModelTestTemplates); err != nil {
		return err
	}
	if err := migrateModelTestTemplateKinds(ctx, db); err != nil {
		return err
	}
	for _, statement := range []string{
		renameCodexTemplate,
		renameOpenCodeTemplate,
		seedModelTestTemplates,
		upgradeShortDefaultTemplates,
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}

	return nil
}

// migrateModelTestTemplateKinds recreates model_test_templates when an older
// schema predates 'messages' as a valid request_kind. SQLite cannot alter a
// CHECK constraint in place.
func migrateModelTestTemplateKinds(ctx context.Context, db *sql.DB) error {
	var schema sql.NullString
	err := db.QueryRowContext(ctx,
		"SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'model_test_templates'").
		Scan(&schema)
	if err != nil {
		if err == sql.ErrNoRows {
			return nil
		}
		return err
	}
	if !schema.Valid || strings.Contains(schema.String, "'messages'") {
		return nil
	}

	for _, statement := range []string{
		"ALTER TABLE model_test_templates RENAME TO model_test_templates_old",
		createModelTestTemplatesTable,
		`INSERT INTO model_test_templates (id, name, request_kind, prompt, created_at, updated_at)
		 SELECT id, name, request_kind, prompt, created_at, updated_at FROM model_test_templates_old`,
		"DROP TABLE model_test_templates_old",
	} {
		if _, err := db.ExecContext(ctx, statement); err != nil {
			return err
		}
	}
	return nil
}

// CheckAutoVacuum warns when incremental auto-vacuum is not active, which means
// deleted log pages are never returned to the filesystem.
func CheckAutoVacuum(ctx context.Context, db *sql.DB) error {
	var mode int64
	if err := db.QueryRowContext(ctx, "PRAGMA auto_vacuum").Scan(&mode); err != nil {
		return err
	}
	if mode != 2 {
		slog.Warn("SQLite incremental auto-vacuum is not active; run a maintenance VACUUM once",
			"sqlite_auto_vacuum", mode)
	}
	return nil
}
