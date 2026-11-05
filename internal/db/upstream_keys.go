package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"strings"
	"unicode/utf8"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// keyNameMaxLength bounds a key's name, which logs and the console show.
const keyNameMaxLength = 100

// routableKeys keeps out a channel whose keys are all disabled, which has no
// way left to sign in. One with no keys at all routes, signing in through its
// headers.
const routableKeys = ` AND (EXISTS (SELECT 1 FROM upstream_keys k WHERE k.upstream_id = upstreams.id AND k.enabled = 1)
      OR NOT EXISTS (SELECT 1 FROM upstream_keys k WHERE k.upstream_id = upstreams.id))`

// migrateUpstreamKeys turns each channel's single key into its first entry in
// upstream_keys. It runs on every start and only touches channels with a key
// and no entries, so a channel a pre-keys build added after a rollback comes
// across too.
func migrateUpstreamKeys(ctx context.Context, db *sql.DB) error {
	_, err := db.ExecContext(ctx, `INSERT INTO upstream_keys (upstream_id, name, api_key, enabled)
        SELECT id, '', api_key, 1 FROM upstreams
        WHERE api_key IS NOT NULL AND api_key <> ''
          AND NOT EXISTS (SELECT 1 FROM upstream_keys k WHERE k.upstream_id = upstreams.id)
        ORDER BY id`)
	return err
}

// ListEnabledUpstreamKeys returns every enabled key, opened, by channel and in
// the id order rotation follows.
func ListEnabledUpstreamKeys(ctx context.Context, db *sql.DB) (map[int64][]models.UpstreamKey, error) {
	keys, err := queryUpstreamKeys(ctx, db,
		"SELECT id, upstream_id, name, api_key, enabled FROM upstream_keys WHERE enabled = 1 ORDER BY upstream_id, id")
	if err != nil {
		return nil, err
	}
	byUpstream := map[int64][]models.UpstreamKey{}
	for _, key := range keys {
		byUpstream[key.UpstreamID] = append(byUpstream[key.UpstreamID], key)
	}
	return byUpstream, nil
}

// ListUpstreamKeys describes a channel's keys, without their values.
func ListUpstreamKeys(ctx context.Context, db Queryer, upstreamID int64) ([]models.UpstreamKeyOut, error) {
	rows, err := db.QueryContext(ctx,
		"SELECT id, name, enabled FROM upstream_keys WHERE upstream_id = ? ORDER BY id", upstreamID)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	keys := []models.UpstreamKeyOut{}
	for rows.Next() {
		var key models.UpstreamKeyOut
		if err := rows.Scan(&key.ID, &key.Name, &key.Enabled); err != nil {
			return nil, apperr.Database(err)
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return keys, nil
}

// ListUpstreamKeyValues returns a channel's keys, opened, enabled or not: what
// an export with keys carries.
func ListUpstreamKeyValues(ctx context.Context, db Queryer, upstreamID int64) ([]models.UpstreamKey, error) {
	return queryUpstreamKeys(ctx, db,
		"SELECT id, upstream_id, name, api_key, enabled FROM upstream_keys WHERE upstream_id = ? ORDER BY id",
		upstreamID)
}

// GetUpstreamKey returns one of a channel's keys, opened, enabled or not; id 0
// asks for its first. ok is false when the channel has no such key — one of
// another channel's included.
func GetUpstreamKey(ctx context.Context, db Queryer, upstreamID, keyID int64) (models.UpstreamKey, bool, error) {
	query := "SELECT id, upstream_id, name, api_key, enabled FROM upstream_keys WHERE upstream_id = ?"
	args := []any{upstreamID}
	if keyID != 0 {
		query += " AND id = ?"
		args = append(args, keyID)
	}
	keys, err := queryUpstreamKeys(ctx, db, query+" ORDER BY id LIMIT 1", args...)
	if err != nil || len(keys) == 0 {
		return models.UpstreamKey{}, false, err
	}
	return keys[0], true, nil
}

// FirstEnabledUpstreamKey returns a channel's first enabled key, opened: the
// one upstreams.api_key mirrors, which a probe naming no key signs in with.
func FirstEnabledUpstreamKey(ctx context.Context, db Queryer, upstreamID int64) (models.UpstreamKey, bool, error) {
	keys, err := queryUpstreamKeys(ctx, db, `SELECT id, upstream_id, name, api_key, enabled
        FROM upstream_keys WHERE upstream_id = ? AND enabled = 1 ORDER BY id LIMIT 1`, upstreamID)
	if err != nil || len(keys) == 0 {
		return models.UpstreamKey{}, false, err
	}
	return keys[0], true, nil
}

func queryUpstreamKeys(ctx context.Context, db Queryer, query string, args ...any) ([]models.UpstreamKey, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	var keys []models.UpstreamKey
	for rows.Next() {
		var key models.UpstreamKey
		var stored string
		if err := rows.Scan(&key.ID, &key.UpstreamID, &key.Name, &stored, &key.Enabled); err != nil {
			return nil, apperr.Database(err)
		}
		if key.APIKey, err = openSecret(stored); err != nil {
			return nil, apperr.Database(fmt.Errorf("key %d: %w", key.ID, err))
		}
		keys = append(keys, key)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return keys, nil
}

// replaceUpstreamKeys makes keys the channel's whole key list, inside the
// transaction of the write that carries them:
//
//   - a listed id keeps its key, renamed and switched as listed, its value
//     replaced only when one is given;
//   - id 0 adds a key, unless it is blank or repeats one the channel keeps;
//   - a key not listed is deleted.
//
// Another channel's id is refused, so a stale form cannot move a key across.
func replaceUpstreamKeys(ctx context.Context, tx Queryer, upstreamID int64, keys []models.UpstreamKeyIn) error {
	stored, err := queryUpstreamKeys(ctx, tx,
		"SELECT id, upstream_id, name, api_key, enabled FROM upstream_keys WHERE upstream_id = ?", upstreamID)
	if err != nil {
		return err
	}
	current := map[int64]models.UpstreamKey{}
	for _, key := range stored {
		current[key.ID] = key
	}

	listed := map[int64]bool{}
	for _, key := range keys {
		if utf8.RuneCountInString(strings.TrimSpace(key.Name)) > keyNameMaxLength {
			return apperr.BadRequest(fmt.Sprintf("a key name is longer than %d characters", keyNameMaxLength))
		}
		switch {
		case key.ID < 0:
			return apperr.BadRequest("key id must not be negative")
		case key.ID == 0:
			continue
		case current[key.ID].ID == 0:
			return apperr.BadRequest(fmt.Sprintf("key %d does not belong to this channel", key.ID))
		case listed[key.ID]:
			return apperr.BadRequest(fmt.Sprintf("key %d is listed twice", key.ID))
		}
		listed[key.ID] = true
	}

	for id := range current {
		if !listed[id] {
			if _, err := tx.ExecContext(ctx, "DELETE FROM upstream_keys WHERE id = ?", id); err != nil {
				return apperr.Database(err)
			}
		}
	}

	// A new key repeating one already kept would only double its turn.
	kept := map[string]bool{}
	for _, key := range keys {
		if key.ID != 0 {
			kept[keyValue(key, current[key.ID].APIKey)] = true
		}
	}

	for _, key := range keys {
		name := strings.TrimSpace(key.Name)
		enabled := boolToInt64(key.Enabled == nil || *key.Enabled)
		value := strings.TrimSpace(key.APIKey)

		if key.ID != 0 {
			if err := updateUpstreamKey(ctx, tx, key.ID, name, enabled, value); err != nil {
				return err
			}
			continue
		}
		if value == "" || kept[value] {
			continue
		}
		kept[value] = true
		sealed, err := sealSecret(value)
		if err != nil {
			return apperr.Internal("could not seal the API key")
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO upstream_keys (upstream_id, name, api_key, enabled) VALUES (?, ?, ?, ?)",
			upstreamID, name, sealed, enabled); err != nil {
			return apperr.Database(err)
		}
	}
	return syncKeyMirror(ctx, tx, upstreamID)
}

// keyValue is what a listed key will hold: the value given, else the stored.
func keyValue(key models.UpstreamKeyIn, stored string) string {
	if value := strings.TrimSpace(key.APIKey); value != "" {
		return value
	}
	return stored
}

func updateUpstreamKey(ctx context.Context, tx Queryer, id int64, name string, enabled int64, value string) error {
	query := "UPDATE upstream_keys SET name = ?, enabled = ?, updated_at = datetime('now')"
	args := []any{name, enabled}
	if value != "" {
		sealed, err := sealSecret(value)
		if err != nil {
			return apperr.Internal("could not seal the API key")
		}
		query += ", api_key = ?"
		args = append(args, sealed)
	}
	if _, err := tx.ExecContext(ctx, query+" WHERE id = ?", append(args, id)...); err != nil {
		return apperr.Database(err)
	}
	return nil
}

// setLegacyKey is the older single-key write: it replaces the value of the
// channel's first key, or adds one when there is none. A blank value changes
// nothing; clearing keys is clear_api_key's job.
func setLegacyKey(ctx context.Context, tx Queryer, upstreamID int64, value string) error {
	value = strings.TrimSpace(value)
	if value == "" {
		return nil
	}

	var firstID int64
	err := tx.QueryRowContext(ctx,
		"SELECT id FROM upstream_keys WHERE upstream_id = ? ORDER BY id LIMIT 1", upstreamID).Scan(&firstID)
	switch {
	case errors.Is(err, sql.ErrNoRows):
		return replaceUpstreamKeys(ctx, tx, upstreamID, []models.UpstreamKeyIn{{APIKey: value}})
	case err != nil:
		return apperr.Database(err)
	}

	sealed, err := sealSecret(value)
	if err != nil {
		return apperr.Internal("could not seal the API key")
	}
	if _, err := tx.ExecContext(ctx,
		"UPDATE upstream_keys SET api_key = ?, updated_at = datetime('now') WHERE id = ?",
		sealed, firstID); err != nil {
		return apperr.Database(err)
	}
	return syncKeyMirror(ctx, tx, upstreamID)
}

// syncKeyMirror copies the first enabled key into upstreams.api_key, sealed as
// it is, or clears the column when there is none.
func syncKeyMirror(ctx context.Context, tx Queryer, upstreamID int64) error {
	if _, err := tx.ExecContext(ctx, `UPDATE upstreams SET api_key =
        (SELECT api_key FROM upstream_keys WHERE upstream_id = ? AND enabled = 1 ORDER BY id LIMIT 1)
        WHERE id = ?`, upstreamID, upstreamID); err != nil {
		return apperr.Database(err)
	}
	return nil
}
