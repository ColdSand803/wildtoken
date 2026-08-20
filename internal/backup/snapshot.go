// Package backup produces and verifies consistent SQLite snapshots.
//
// Kept apart from internal/db, which speaks in rows: nothing here reads a table.
// The unit of work is the database file itself, which is what makes a backup a
// backup — assembling one by exporting every table would miss anything not
// exported, and would capture the tables at different instants.
package backup

import (
	"context"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
)

// Snapshot writes a consistent copy of the open database to path.
//
// VACUUM INTO rather than copying the file: a copy taken while the service is
// running catches pages mid-write and misses whatever is still in the WAL, so it
// restores as a corrupt database or, worse, as a subtly incomplete one. VACUUM INTO
// runs inside SQLite's own read transaction, so the result is the database as of one
// instant, with the WAL already applied and without blocking writers.
func Snapshot(ctx context.Context, database *sql.DB, path string) error {
	if database == nil {
		return errors.New("no database")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("prepare snapshot directory: %w", err)
	}
	// VACUUM INTO refuses to overwrite, which is the behaviour worth keeping for a
	// real target; a leftover from an interrupted run is removed here rather than
	// letting it fail the next attempt forever.
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return fmt.Errorf("clear previous snapshot: %w", err)
	}

	// The path is a parameter rather than interpolated: VACUUM INTO takes an
	// expression, so a filename with a quote in it would otherwise be a way to
	// change the statement.
	if _, err := database.ExecContext(ctx, "VACUUM INTO ?", path); err != nil {
		return fmt.Errorf("write snapshot: %w", err)
	}
	return nil
}

// SchemaFingerprint is the SHA-256 of the database's sorted DDL.
//
// Used instead of a version number because this service keeps none: every migration
// is an idempotent CREATE or ensureColumn, so there is no counter to compare. The
// DDL is the schema, and a fingerprint over it cannot claim a compatibility the
// tables do not have.
//
// Sorted because sqlite_master's order follows creation order, which differs between
// a database built by one release and the same schema reached through migrations.
// Indexes SQLite creates for itself are skipped: they have no DDL and their names
// are assigned in creation order.
func SchemaFingerprint(ctx context.Context, queryer interface {
	QueryContext(context.Context, string, ...any) (*sql.Rows, error)
}) (string, error) {
	rows, err := queryer.QueryContext(ctx,
		`SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`)
	if err != nil {
		return "", fmt.Errorf("read schema: %w", err)
	}
	defer rows.Close()

	statements := []string{}
	for rows.Next() {
		var statement string
		if err := rows.Scan(&statement); err != nil {
			return "", fmt.Errorf("read schema: %w", err)
		}
		// Whitespace is normalised so a reformatted CREATE statement does not read as
		// a different schema. The point of comparison is the tables, not the source.
		statements = append(statements, strings.Join(strings.Fields(statement), " "))
	}
	if err := rows.Err(); err != nil {
		return "", fmt.Errorf("read schema: %w", err)
	}
	sort.Strings(statements)

	digest := sha256.New()
	for _, statement := range statements {
		digest.Write([]byte(statement))
		// A separator, so ["AB", "C"] and ["A", "BC"] cannot hash alike.
		digest.Write([]byte{0})
	}
	return hex.EncodeToString(digest.Sum(nil)), nil
}

// FileChecksum is the SHA-256 of a file's bytes, hex encoded.
//
// Streamed rather than read whole: a database is exactly the kind of file that does
// not fit comfortably in memory, and a checksum has no reason to require it.
func FileChecksum(path string) (string, int64, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", 0, err
	}
	defer file.Close()

	digest := sha256.New()
	size, err := io.Copy(digest, file)
	if err != nil {
		return "", 0, err
	}
	return hex.EncodeToString(digest.Sum(nil)), size, nil
}

// BytesChecksum is the SHA-256 of a buffer, hex encoded.
func BytesChecksum(payload []byte) string {
	sum := sha256.Sum256(payload)
	return hex.EncodeToString(sum[:])
}

// SnapshotStats is what SQLite reports about a database file.
type SnapshotStats struct {
	PageSize  int64
	PageCount int64
}

// Inspect opens a database file read-only and reports what it is.
//
// Read-only on purpose: opening a candidate snapshot for writing would let SQLite
// roll back a hot journal in it, which changes the file whose checksum was just
// verified.
func Inspect(ctx context.Context, path string) (stats SnapshotStats, fingerprint string, err error) {
	database, err := openReadOnly(path)
	if err != nil {
		return stats, "", err
	}
	defer database.Close()

	if err := database.QueryRowContext(ctx, "PRAGMA page_size").Scan(&stats.PageSize); err != nil {
		return stats, "", fmt.Errorf("read page size: %w", err)
	}
	if err := database.QueryRowContext(ctx, "PRAGMA page_count").Scan(&stats.PageCount); err != nil {
		return stats, "", fmt.Errorf("read page count: %w", err)
	}
	fingerprint, err = SchemaFingerprint(ctx, database)
	if err != nil {
		return stats, "", err
	}
	return stats, fingerprint, nil
}

// Verify runs SQLite's own integrity check over a candidate file.
//
// A checksum only proves the bytes arrived as they left; it says nothing about
// whether they were a valid database when they left. This is what catches a snapshot
// taken from a database that was already damaged, which is precisely the situation a
// restore tends to follow.
func Verify(ctx context.Context, path string) error {
	database, err := openReadOnly(path)
	if err != nil {
		return err
	}
	defer database.Close()

	// quick_check rather than integrity_check: it does the page-level and index
	// structure work, and skips only the exhaustive per-index content comparison,
	// which on a large database turns a restore into a long wait during an incident.
	rows, err := database.QueryContext(ctx, "PRAGMA quick_check")
	if err != nil {
		return fmt.Errorf("integrity check failed to run: %w", err)
	}
	defer rows.Close()

	problems := []string{}
	for rows.Next() {
		var line string
		if err := rows.Scan(&line); err != nil {
			return fmt.Errorf("integrity check failed to run: %w", err)
		}
		if strings.TrimSpace(line) != "ok" {
			problems = append(problems, line)
		}
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("integrity check failed to run: %w", err)
	}
	if len(problems) > 0 {
		// Truncated: a badly damaged database reports thousands of lines, and an
		// error string that long is unreadable in a console and in a log.
		if len(problems) > 5 {
			problems = append(problems[:5], fmt.Sprintf("(and %d more)", len(problems)-5))
		}
		return fmt.Errorf("the snapshot is not a valid database: %s",
			strings.Join(problems, "; "))
	}
	return nil
}

// RequiredTables are the tables a file must have to be this service's database.
//
// Checked in addition to the fingerprint because the fingerprint is all-or-nothing:
// when it differs, this is what distinguishes "a WildToken database from another
// version" — which an operator may knowingly restore — from "some other SQLite
// file", which is never what they meant.
var RequiredTables = []string{
	"upstreams", "groups", "upstream_groups", "api_tokens",
	"request_logs", "runtime_settings",
}

// LooksLikeWildToken reports whether a file has this service's core tables.
func LooksLikeWildToken(ctx context.Context, path string) error {
	database, err := openReadOnly(path)
	if err != nil {
		return err
	}
	defer database.Close()

	missing := []string{}
	for _, table := range RequiredTables {
		var name string
		err := database.QueryRowContext(ctx,
			"SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?", table).Scan(&name)
		if errors.Is(err, sql.ErrNoRows) {
			missing = append(missing, table)
			continue
		}
		if err != nil {
			return fmt.Errorf("read schema: %w", err)
		}
	}
	if len(missing) > 0 {
		return fmt.Errorf("the file is not a WildToken database: missing %s",
			strings.Join(missing, ", "))
	}
	return nil
}

// openReadOnly opens a file as a read-only SQLite database.
func openReadOnly(path string) (*sql.DB, error) {
	if _, err := os.Stat(path); err != nil {
		return nil, fmt.Errorf("read snapshot: %w", err)
	}
	// immutable=0 with mode=ro: read-only, but SQLite may still consult a journal
	// alongside the file, which is what an honest verification wants.
	database, err := sql.Open("sqlite", "file:"+filepath.ToSlash(path)+"?mode=ro")
	if err != nil {
		return nil, fmt.Errorf("open snapshot: %w", err)
	}
	database.SetMaxOpenConns(1)
	if err := database.Ping(); err != nil {
		database.Close()
		// The most common cause is a file that is not a database at all, which the
		// driver reports as a malformed image rather than as a bad file.
		return nil, fmt.Errorf("the file is not a readable SQLite database: %w", err)
	}
	return database, nil
}
