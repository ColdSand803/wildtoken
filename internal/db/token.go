package db

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

const tokenPreviewChars = 8

// tokenColumns lists every column of a token row, in the order APITokenRow
// declares them.
const tokenColumns = `t.id, t.name, t.description, t.token_preview, t.enabled,
    t.expires_at, t.created_at, t.updated_at,
    COALESCE(t.group_id, 1),
    COALESCE((SELECT g.name FROM groups g WHERE g.id = t.group_id), 'default')`

// tokenFrom is the FROM clause matching tokenColumns.
const tokenFrom = " FROM api_tokens AS t"

// GenerateAPIToken mints a fresh downstream token.
func GenerateAPIToken() (string, error) {
	bytes := make([]byte, 32)
	if _, err := rand.Read(bytes); err != nil {
		return "", apperr.Internal("could not generate an API token")
	}
	return "wildtoken_" + base64.RawURLEncoding.EncodeToString(bytes), nil
}

// TokenDigest is the only form of a token that is ever persisted.
func TokenDigest(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}

// TokenPreview renders the console hint, never revealing a short token in full.
func TokenPreview(token string) string {
	runes := []rune(token)
	visible := len(runes) / 2
	if len(runes) > tokenPreviewChars {
		visible = tokenPreviewChars
	}
	return string(runes[:visible]) + "…"
}

func scanTokenRow(row interface{ Scan(...any) error }) (models.APITokenRow, string, error) {
	var token models.APITokenRow
	var expiresAt sql.NullString
	var groupName string
	err := row.Scan(&token.ID, &token.Name, &token.Description, &token.TokenPreview,
		&token.Enabled, &expiresAt, &token.CreatedAt, &token.UpdatedAt,
		&token.GroupID, &groupName)
	if err != nil {
		return token, "", err
	}
	if expiresAt.Valid {
		token.ExpiresAt = &expiresAt.String
	}
	return token, groupName, nil
}

func tokenOut(row models.APITokenRow, groupName string) models.APITokenOut {
	return models.APITokenOut{
		ID:           row.ID,
		Name:         row.Name,
		Description:  row.Description,
		TokenPreview: row.TokenPreview,
		Enabled:      row.Enabled == 1,
		ExpiresAt:    row.ExpiresAt,
		CreatedAt:    row.CreatedAt,
		UpdatedAt:    row.UpdatedAt,
		GroupID:      row.GroupID,
		GroupName:    groupName,
	}
}

// rejectPastExpiry refuses an expiry that has already passed.
//
// Compared as text rather than as parsed instants: expires_at and SQLite's
// datetime('now') share one fixed-width UTC shape, so this reaches the same
// verdict as the authentication SQL in the auth middleware. Parsing here instead
// would open a window where the console accepts an expiry the proxy already
// treats as dead.
func rejectPastExpiry(expiresAt *string) error {
	if expiresAt == nil {
		return nil
	}
	if *expiresAt <= models.UTCNowTimestamp() {
		return apperr.BadRequest(
			"token expiry must be in the future; disable or delete the token to revoke it now")
	}
	return nil
}

// MigrateLegacyTokenStorage upgrades plaintext token rows in one transaction.
//
// The legacy `token` column is retained because its NOT NULL/UNIQUE constraints
// are part of deployed databases. Its values are overwritten with the same
// SHA-256 digest stored in `token_hash`, so no plaintext survives the commit.
func MigrateLegacyTokenStorage(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	columns, err := tableColumns(ctx, tx, "api_tokens")
	if err != nil {
		return err
	}
	hasLegacyToken := columns["token"]
	hasTokenHash := columns["token_hash"]
	hasTokenPreview := columns["token_preview"]

	if !hasLegacyToken {
		return errors.New("api_tokens is missing its compatibility token column")
	}
	if !hasTokenHash {
		if _, err := tx.ExecContext(ctx, "ALTER TABLE api_tokens ADD COLUMN token_hash TEXT"); err != nil {
			return err
		}
	}
	if !hasTokenPreview {
		if _, err := tx.ExecContext(ctx,
			"ALTER TABLE api_tokens ADD COLUMN token_preview TEXT NOT NULL DEFAULT ''"); err != nil {
			return err
		}
	}

	if !hasTokenHash {
		if err := hashLegacyPlaintextTokens(ctx, tx); err != nil {
			return err
		}
	}

	var missingHashes int64
	if err := tx.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM api_tokens WHERE token_hash IS NULL").Scan(&missingHashes); err != nil {
		return err
	}
	if missingHashes != 0 {
		return errors.New("api_tokens contains rows without a token digest")
	}

	// Clear compatibility-column plaintext after every startup. This is also a
	// repair guard for databases whose legacy column was modified out of band.
	if _, err := tx.ExecContext(ctx,
		"UPDATE api_tokens SET token = token_hash WHERE token <> token_hash"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx,
		"CREATE UNIQUE INDEX IF NOT EXISTS idx_api_tokens_token_hash ON api_tokens(token_hash)"); err != nil {
		return err
	}

	return tx.Commit()
}

func tableColumns(ctx context.Context, tx *sql.Tx, table string) (map[string]bool, error) {
	rows, err := tx.QueryContext(ctx,
		fmt.Sprintf("SELECT name FROM pragma_table_info('%s') ORDER BY cid", table))
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	columns := map[string]bool{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		columns[name] = true
	}
	return columns, rows.Err()
}

// hashLegacyPlaintextTokens replaces every plaintext value with its digest,
// using a collision-free marker for the legacy UNIQUE column.
func hashLegacyPlaintextTokens(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, "SELECT id, token FROM api_tokens ORDER BY id")
	if err != nil {
		return err
	}
	type legacyToken struct {
		id        int64
		plaintext string
	}
	var legacy []legacyToken
	for rows.Next() {
		var entry legacyToken
		if err := rows.Scan(&entry.id, &entry.plaintext); err != nil {
			rows.Close()
			return err
		}
		legacy = append(legacy, entry)
	}
	rows.Close()
	if err := rows.Err(); err != nil {
		return err
	}

	markerPrefix, err := uniqueMarkerPrefix(legacy)
	if err != nil {
		return err
	}

	for _, entry := range legacy {
		_, err := tx.ExecContext(ctx,
			"UPDATE api_tokens SET token = ?, token_hash = ?, token_preview = ? WHERE id = ?",
			fmt.Sprintf("%s%d", markerPrefix, entry.id),
			TokenDigest(entry.plaintext), TokenPreview(entry.plaintext), entry.id)
		if err != nil {
			return err
		}
	}
	return nil
}

func uniqueMarkerPrefix[T any](rows []T) (string, error) {
	_ = rows
	bytes := make([]byte, 16)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	return fmt.Sprintf("__wildtoken_token_migration_%s__",
		base64.RawURLEncoding.EncodeToString(bytes)), nil
}

func ListTokens(ctx context.Context, db *sql.DB) ([]models.APITokenOut, error) {
	rows, err := db.QueryContext(ctx,
		"SELECT "+tokenColumns+tokenFrom+" ORDER BY t.id ASC")
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	tokens := []models.APITokenOut{}
	for rows.Next() {
		row, groupName, err := scanTokenRow(rows)
		if err != nil {
			return nil, apperr.Database(err)
		}
		tokens = append(tokens, tokenOut(row, groupName))
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return tokens, nil
}

// GetToken returns ok=false when no row carries the id.
func GetToken(ctx context.Context, db *sql.DB, id int64) (models.APITokenOut, bool, error) {
	row := db.QueryRowContext(ctx, "SELECT "+tokenColumns+tokenFrom+" WHERE t.id = ?", id)
	entry, groupName, err := scanTokenRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return models.APITokenOut{}, false, nil
	}
	if err != nil {
		return models.APITokenOut{}, false, apperr.Database(err)
	}
	return tokenOut(entry, groupName), true, nil
}

func CreateToken(ctx context.Context, db *sql.DB, input *models.APITokenIn) (models.APITokenCreatedOut, error) {
	if err := input.Validate(); err != nil {
		return models.APITokenCreatedOut{}, apperr.BadRequest(err.Error())
	}
	expiresAt, err := input.NormalizedExpiresAt()
	if err != nil {
		return models.APITokenCreatedOut{}, apperr.BadRequest(err.Error())
	}
	if err := rejectPastExpiry(expiresAt); err != nil {
		return models.APITokenCreatedOut{}, err
	}

	tokenValue := ""
	if input.Token != nil {
		tokenValue = *input.Token
	} else {
		if tokenValue, err = GenerateAPIToken(); err != nil {
			return models.APITokenCreatedOut{}, err
		}
	}
	digest := TokenDigest(tokenValue)
	preview := TokenPreview(tokenValue)

	groupID, err := resolveTokenGroup(ctx, db, input.GroupID)
	if err != nil {
		return models.APITokenCreatedOut{}, err
	}

	result, err := db.ExecContext(ctx, `INSERT INTO api_tokens
        (name, description, token, token_hash, token_preview, enabled, expires_at, group_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
		trimSpace(input.Name), trimSpace(input.Description), digest, digest, preview,
		boolToInt64(input.Enabled), expiresAt, groupID)
	if err != nil {
		return models.APITokenCreatedOut{}, apperr.Database(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return models.APITokenCreatedOut{}, apperr.Database(err)
	}

	created, ok, err := GetToken(ctx, db, id)
	if err != nil {
		return models.APITokenCreatedOut{}, err
	}
	if !ok {
		return models.APITokenCreatedOut{}, apperr.Internal("token was not persisted")
	}

	return models.APITokenCreatedOut{
		ID:           created.ID,
		Name:         created.Name,
		Description:  created.Description,
		Token:        tokenValue,
		TokenPreview: created.TokenPreview,
		Enabled:      created.Enabled,
		ExpiresAt:    created.ExpiresAt,
		CreatedAt:    created.CreatedAt,
		UpdatedAt:    created.UpdatedAt,
		GroupID:      created.GroupID,
		GroupName:    created.GroupName,
	}, nil
}

// resolveTokenGroup validates a requested group, defaulting when absent.
//
// A token must always name a group that exists: with no group it would reach no
// channel, which reads as a routing bug rather than a configuration choice.
func resolveTokenGroup(ctx context.Context, db *sql.DB, requested *int64) (int64, error) {
	groupID := models.DefaultGroupID
	if requested != nil && *requested > 0 {
		groupID = *requested
	}
	exists, err := GroupExists(ctx, db, groupID)
	if err != nil {
		return 0, err
	}
	if !exists {
		return 0, apperr.BadRequest("group does not exist")
	}
	return groupID, nil
}

func UpdateToken(ctx context.Context, db *sql.DB, id int64, input *models.APITokenUpdateIn) (models.APITokenOut, error) {
	if err := input.Validate(); err != nil {
		return models.APITokenOut{}, apperr.BadRequest(err.Error())
	}
	expiresAt, err := input.NormalizedExpiresAt()
	if err != nil {
		return models.APITokenOut{}, apperr.BadRequest(err.Error())
	}

	existing, ok, err := GetToken(ctx, db, id)
	if err != nil {
		return models.APITokenOut{}, err
	}
	if !ok {
		return models.APITokenOut{}, apperr.NotFound("token not found")
	}

	// Only a changed expiry has to be in the future. Editing a token that has
	// already lapsed sends its own past expiry back unchanged, and rejecting
	// that would make renaming an expired token impossible without renewing it.
	if !equalOptionalString(expiresAt, existing.ExpiresAt) {
		if err := rejectPastExpiry(expiresAt); err != nil {
			return models.APITokenOut{}, err
		}
	}

	groupID, err := resolveTokenGroup(ctx, db, input.GroupID)
	if err != nil {
		return models.APITokenOut{}, err
	}

	_, err = db.ExecContext(ctx,
		"UPDATE api_tokens SET name = ?, description = ?, expires_at = ?, group_id = ?, updated_at = datetime('now') WHERE id = ?",
		trimSpace(input.Name), trimSpace(input.Description), expiresAt, groupID, id)
	if err != nil {
		return models.APITokenOut{}, apperr.Database(err)
	}

	return reloadToken(ctx, db, id)
}

func SetTokenEnabled(ctx context.Context, db *sql.DB, id int64, enabled bool) (models.APITokenOut, error) {
	_, err := db.ExecContext(ctx,
		"UPDATE api_tokens SET enabled = ?, updated_at = datetime('now') WHERE id = ?",
		boolToInt64(enabled), id)
	if err != nil {
		return models.APITokenOut{}, apperr.Database(err)
	}
	return reloadToken(ctx, db, id)
}

func reloadToken(ctx context.Context, db *sql.DB, id int64) (models.APITokenOut, error) {
	token, ok, err := GetToken(ctx, db, id)
	if err != nil {
		return models.APITokenOut{}, err
	}
	if !ok {
		return models.APITokenOut{}, apperr.NotFound("token not found")
	}
	return token, nil
}

func DeleteToken(ctx context.Context, db *sql.DB, id int64) (bool, error) {
	return execAffectsAny(ctx, db, "DELETE FROM api_tokens WHERE id = ?", id)
}

func equalOptionalString(left, right *string) bool {
	if left == nil || right == nil {
		return left == nil && right == nil
	}
	return *left == *right
}
