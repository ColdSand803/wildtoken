package db

import (
	"context"
	"database/sql"
	"fmt"
	"os"
)

// Backup writes a consistent copy of the database to path, without log bodies.
//
// VACUUM INTO reads one snapshot while the service keeps writing, and writes a
// copy with no free pages, so nothing deleted — a plaintext key from before
// sealing, say — comes along. The bodies are then dropped from the copy the
// way the keep-count cleanup drops them, flagged as cleared: they are a rolling
// diagnostic window, and keeping them would make every backup a log archive.
//
// The copy is one self-contained file, journal mode DELETE: restoring it means
// putting it where the database was.
func Backup(ctx context.Context, database *sql.DB, path string) error {
	// Made empty and owner-only first. VACUUM INTO keeps an empty file's mode,
	// and the copy holds every sealed credential and the admin credential.
	file, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0o600)
	if err != nil {
		return err
	}
	file.Close()

	if _, err := database.ExecContext(ctx, "VACUUM INTO ?", path); err != nil {
		return fmt.Errorf("copy the database: %w", err)
	}

	copied, err := sql.Open("sqlite", path)
	if err != nil {
		return err
	}
	defer copied.Close()
	copied.SetMaxOpenConns(1)

	for _, statement := range []string{
		"PRAGMA journal_mode = DELETE",
		"UPDATE request_log_snapshots SET bodies_cleared = 1",
		"DELETE FROM request_log_bodies",
		"DELETE FROM log_chunks",
		"VACUUM",
	} {
		if _, err := copied.ExecContext(ctx, statement); err != nil {
			return fmt.Errorf("strip log bodies from the copy: %w", err)
		}
	}

	var check string
	if err := copied.QueryRowContext(ctx, "PRAGMA integrity_check").Scan(&check); err != nil {
		return err
	}
	if check != "ok" {
		return fmt.Errorf("the copy fails its integrity check: %s", check)
	}
	return copied.Close()
}
