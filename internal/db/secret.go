package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"log/slog"
	"sync/atomic"
	"time"

	"github.com/liguangsheng/wildtoken/internal/secret"
)

// secrets seals channel API keys and token plaintext on the way into the
// database and opens them on the way out. Nil stores them as given, which only
// tests rely on: the server installs a cipher before it serves.
var secrets atomic.Pointer[secret.Cipher]

// UseSecrets installs the cipher every credential read and write goes through.
func UseSecrets(c *secret.Cipher) { secrets.Store(c) }

// errSecretUnreadable fails the read of a credential no installed key opens.
// Startup proves every stored one opens, so only a value written behind the
// service's back gets here.
var errSecretUnreadable = errors.New("a stored credential does not open with the configured key")

func sealSecret(plain string) (string, error) {
	c := secrets.Load()
	if c == nil {
		return plain, nil
	}
	return c.Seal(plain)
}

func sealOptionalSecret(plain *string) (*string, error) {
	if plain == nil {
		return nil, nil
	}
	sealed, err := sealSecret(*plain)
	if err != nil {
		return nil, err
	}
	return &sealed, nil
}

// openSecret reads a stored credential. Plaintext stored before sealing
// existed passes through until startup seals it.
func openSecret(stored string) (string, error) {
	if !secret.IsSealed(stored) {
		return stored, nil
	}
	c := secrets.Load()
	if c == nil {
		return "", errSecretUnreadable
	}
	plain, err := c.Open(stored)
	if err != nil {
		return "", errSecretUnreadable
	}
	return plain, nil
}

// secretColumns are the columns holding a credential.
var secretColumns = []struct{ table, column string }{
	{"upstreams", "api_key"},
	{"api_tokens", "token_plain"},
}

// storedSecret is one credential as the database holds it.
type storedSecret struct {
	table, column string
	id            int64
	value         string
}

func loadStoredSecrets(ctx context.Context, db Queryer) ([]storedSecret, error) {
	var stored []storedSecret
	for _, c := range secretColumns {
		rows, err := db.QueryContext(ctx, fmt.Sprintf(
			"SELECT id, %[2]s FROM %[1]s WHERE %[2]s IS NOT NULL AND %[2]s <> ''", c.table, c.column))
		if err != nil {
			return nil, err
		}
		for rows.Next() {
			s := storedSecret{table: c.table, column: c.column}
			if err := rows.Scan(&s.id, &s.value); err != nil {
				rows.Close()
				return nil, err
			}
			stored = append(stored, s)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return nil, err
		}
	}
	return stored, nil
}

// HasSealedSecrets reports whether any stored credential is sealed, which a
// newly made key could not open.
func HasSealedSecrets(ctx context.Context, db *sql.DB) (bool, error) {
	stored, err := loadStoredSecrets(ctx, db)
	if err != nil {
		return false, err
	}
	for _, s := range stored {
		if secret.IsSealed(s.value) {
			return true, nil
		}
	}
	return false, nil
}

// SealReport counts what SealSecrets rewrote.
type SealReport struct {
	// Sealed were plaintext, stored before sealing existed.
	Sealed int
	// Resealed opened only with the previous key.
	Resealed int
}

// SealSecrets brings every stored credential under key: plaintext stored
// before sealing existed, and values sealed under previous — the key file once
// ENCRYPTION_KEY has taken its place. previous may be nil.
//
// Nothing is written unless every sealed value opens with one of the two, so a
// wrong key cannot strand what is stored.
func SealSecrets(ctx context.Context, db *sql.DB, key, previous *secret.Cipher) (SealReport, error) {
	stored, err := loadStoredSecrets(ctx, db)
	if err != nil {
		return SealReport{}, err
	}

	type rewrite struct {
		storedSecret
		plain string
	}
	var report SealReport
	var rewrites []rewrite
	unreadable := 0
	for _, s := range stored {
		switch {
		case !secret.IsSealed(s.value):
			rewrites = append(rewrites, rewrite{s, s.value})
			report.Sealed++
			continue
		case opens(key, s.value):
			continue
		}
		if plain, err := previousOpen(previous, s.value); err == nil {
			rewrites = append(rewrites, rewrite{s, plain})
			report.Resealed++
			continue
		}
		unreadable++
	}
	if unreadable > 0 {
		return SealReport{}, fmt.Errorf("%d of %d stored credentials do not open with the configured key",
			unreadable, len(stored))
	}
	if len(rewrites) == 0 {
		return report, nil
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return SealReport{}, err
	}
	defer tx.Rollback()
	for _, r := range rewrites {
		sealed, err := key.Seal(r.plain)
		if err != nil {
			return SealReport{}, err
		}
		if _, err := tx.ExecContext(ctx, fmt.Sprintf("UPDATE %s SET %s = ? WHERE id = ?", r.table, r.column),
			sealed, r.id); err != nil {
			return SealReport{}, err
		}
	}
	if err := tx.Commit(); err != nil {
		return SealReport{}, err
	}

	if report.Sealed > 0 {
		scrubPlaintext(ctx, db)
	}
	return report, nil
}

// scrubPlaintext rewrites the database file so plaintext from before sealing
// is gone from the bytes on disk, not only from the columns.
//
// An UPDATE leaves the old bytes in free space and the WAL: of 120 channels'
// keys, 33 survived on disk, and 25 with secure_delete on. VACUUM builds every
// page afresh. It runs once, needs free space about the database's size, and a
// failure only leaves the old copies where they were.
func scrubPlaintext(ctx context.Context, db *sql.DB) {
	started := time.Now()
	if _, err := db.ExecContext(ctx, "VACUUM"); err != nil {
		slog.Warn("could not vacuum plaintext credentials out of free space", "error", err)
		return
	}

	// The pages VACUUM replaced stay in the WAL until it is truncated.
	var busy, frames, done int
	if err := db.QueryRowContext(ctx, "PRAGMA wal_checkpoint(TRUNCATE)").
		Scan(&busy, &frames, &done); err != nil || busy != 0 {
		slog.Warn("could not truncate the WAL after vacuuming", "busy", busy, "error", err)
	}
	slog.Info("vacuumed plaintext credentials out of the database file",
		"took", time.Since(started).Round(time.Millisecond))
}

func opens(key *secret.Cipher, stored string) bool {
	_, err := key.Open(stored)
	return err == nil
}

func previousOpen(previous *secret.Cipher, stored string) (string, error) {
	if previous == nil {
		return "", secret.ErrWrongKey
	}
	return previous.Open(stored)
}
