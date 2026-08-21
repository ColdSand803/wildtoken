package db

import (
	"context"
	"database/sql"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// applyUsageInPeriod is the whole of quota rollover.
//
// There is no scheduled job and no `used_tokens = 0`. Usage is applied by a
// statement that names the period stamp it was earned under, and the row decides
// what that means relative to the stamp it currently holds:
//
//   - the same stamp → accumulate, which is the ordinary case
//   - a later stamp of the same period type → this is the first usage of a new
//     cycle, so the counter restarts from this row's usage and the row adopts the
//     new stamp. The rollover is performed by the first request of the new period,
//     atomically with recording that request: there is no window in which the
//     counter has been cleared but the request that cleared it is unaccounted for.
//   - an earlier stamp of the same period type → late-arriving usage from a cycle
//     that has closed. Its amount is dropped rather than added to the current
//     counter, which is the pollution the checklist forbids: a request admitted
//     before midnight whose log row commits after it must not spend the new
//     period's budget.
//   - a different period type → the two stamps are not comparable at all, so the
//     usage accumulates into the current period and the stamp is left alone. It was
//     genuinely spent, and an operator changing the cycle is not a reason to forget
//     it or to hand the balance back.
//
// The period type is compared as the stamp's prefix up to and including its colon.
// substr(x, 1, instr(x, ':')) yields ” when there is no colon, so a token that
// never resets — whose stamp is empty — compares equal to itself and accumulates.
//
// The whole decision is one UPDATE, so it is atomic without an explicit
// transaction: SQLite evaluates the CASE expressions against the row it is writing
// while holding the write lock.
const applyUsageInPeriod = `
UPDATE api_tokens SET
    used_tokens = CASE
        WHEN COALESCE(quota_period_key, '') = :stamp THEN COALESCE(used_tokens, 0) + :used
        WHEN substr(COALESCE(quota_period_key, ''), 1,
                    instr(COALESCE(quota_period_key, ''), ':'))
             <> substr(:stamp, 1, instr(:stamp, ':'))  THEN COALESCE(used_tokens, 0) + :used
        WHEN COALESCE(quota_period_key, '') < :stamp   THEN :used
        ELSE COALESCE(used_tokens, 0)
    END,
    quota_period_key = CASE
        WHEN COALESCE(quota_period_key, '') = :stamp THEN COALESCE(quota_period_key, '')
        WHEN substr(COALESCE(quota_period_key, ''), 1,
                    instr(COALESCE(quota_period_key, ''), ':'))
             <> substr(:stamp, 1, instr(:stamp, ':'))  THEN :stamp
        WHEN COALESCE(quota_period_key, '') < :stamp   THEN :stamp
        ELSE COALESCE(quota_period_key, '')
    END
WHERE id = :id`

// ApplyTokenUsage records usage against a token, rolling its period over when this
// is the first usage of a new cycle.
//
// periodStamp must be the one that was in force when the request ran, not when the
// row is written. The two differ by however long the log queue is, and using the
// write time is exactly how a request from the closing minutes of a period comes to
// be charged against the next one.
//
// An empty stamp means the token does not reset, and the usage simply accumulates.
func ApplyTokenUsage(ctx context.Context, tx interface {
	ExecContext(context.Context, string, ...any) (sql.Result, error)
}, tokenID int64, used int64, periodStamp string) error {
	_, err := tx.ExecContext(ctx, applyUsageInPeriod,
		sql.Named("stamp", periodStamp),
		sql.Named("used", used),
		sql.Named("id", tokenID))
	return err
}

// TokenQuotaCycle is a token's stored cycle configuration.
type TokenQuotaCycle struct {
	Period      string
	Timezone    string
	PeriodStamp string
}

// ReadTokenQuotaCycle loads the cycle a token is configured for.
//
// An unrecognised stored period reads as 'none'. That keeps a row edited out of
// band accumulating as a lifetime total rather than resetting on a boundary nobody
// configured — the conservative direction, since the alternative silently hands
// back budget.
func ReadTokenQuotaCycle(ctx context.Context, db Queryer,
	tokenID int64) (TokenQuotaCycle, bool, error) {
	var period, timezone, periodKey sql.NullString
	err := db.QueryRowContext(ctx,
		"SELECT quota_period, quota_timezone, quota_period_key FROM api_tokens WHERE id = ?",
		tokenID).Scan(&period, &timezone, &periodKey)
	if err == sql.ErrNoRows {
		return TokenQuotaCycle{}, false, nil
	}
	if err != nil {
		return TokenQuotaCycle{}, false, err
	}

	cycle := TokenQuotaCycle{
		Period:      models.DefaultQuotaPeriod,
		Timezone:    models.DefaultQuotaTimezone,
		PeriodStamp: periodKey.String,
	}
	if period.Valid && models.ValidQuotaPeriod(period.String) {
		cycle.Period = period.String
	}
	if timezone.Valid && timezone.String != "" {
		cycle.Timezone = timezone.String
	}
	return cycle, true, nil
}
