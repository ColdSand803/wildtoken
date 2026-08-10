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

func trimSpace(value string) string { return strings.TrimSpace(value) }

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
