package db

import (
	"context"
	"database/sql"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/apperr"
)

// Queryer is the subset of *sql.DB and *sql.Tx the stores need, so a query can
// run inside or outside a transaction.
type Queryer interface {
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
}

// SQLiteTxLock is the driver's `_txlock` connection parameter, carried by the
// DSN the server builds.
//
// Every transaction in this package writes, and several read before they write.
// Under SQLite's default deferred locking such a transaction takes its read
// snapshot first and only asks for the write lock later, so a concurrent commit
// in between fails it with SQLITE_BUSY_SNAPSHOT — an error busy_timeout cannot
// wait out, because the snapshot is already stale. Taking the write lock at BEGIN
// turns that race into a wait, which is what lets a store trust a value it read
// moments earlier.
const SQLiteTxLock = "immediate"

func trimSpace(value string) string { return strings.TrimSpace(value) }

// IsUniqueViolation reports a UNIQUE constraint failure, which a caller turns
// into a business error: the driver's wording names columns the console does not
// know about. Matched on the message because the SQLite driver reports it as a
// plain error rather than a typed one.
func IsUniqueViolation(err error) bool {
	return err != nil && strings.Contains(strings.ToUpper(err.Error()), "UNIQUE")
}

// execAffectsOne reports whether the statement changed exactly one row.
func execAffectsOne(ctx context.Context, db Queryer, query string, args ...any) (bool, error) {
	result, err := db.ExecContext(ctx, query, args...)
	if err != nil {
		return false, apperr.Database(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, apperr.Database(err)
	}
	return affected == 1, nil
}

// execAffectsAny reports whether the statement changed at least one row.
func execAffectsAny(ctx context.Context, db Queryer, query string, args ...any) (bool, error) {
	result, err := db.ExecContext(ctx, query, args...)
	if err != nil {
		return false, apperr.Database(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, apperr.Database(err)
	}
	return affected > 0, nil
}
