package db

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

const upstreamColumns = `id, name, base_url, api_key, model_names, model_prefixes,
    model_mappings, priority, weight, auto_weight_enabled, enabled, extra_headers,
    timeout_seconds, rate_limit, created_at, updated_at`

func parseJSONArray(value string) ([]string, error) {
	parsed := []string{}
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return nil, apperr.JSON(err)
	}
	return parsed, nil
}

func parseJSONMap(value string) (map[string]string, error) {
	parsed := map[string]string{}
	if err := json.Unmarshal([]byte(value), &parsed); err != nil {
		return nil, apperr.JSON(err)
	}
	return parsed, nil
}

func scanUpstreamRow(row interface{ Scan(...any) error }) (models.UpstreamRow, error) {
	var upstream models.UpstreamRow
	var apiKey, rateLimit sql.NullString
	err := row.Scan(&upstream.ID, &upstream.Name, &upstream.BaseURL, &apiKey,
		&upstream.ModelNames, &upstream.ModelPrefixes, &upstream.ModelMappings,
		&upstream.Priority, &upstream.Weight, &upstream.AutoWeightEnabled,
		&upstream.Enabled, &upstream.ExtraHeaders, &upstream.TimeoutSeconds,
		&rateLimit, &upstream.CreatedAt, &upstream.UpdatedAt)
	if err != nil {
		return upstream, err
	}
	if apiKey.Valid {
		upstream.APIKey = &apiKey.String
	}
	if rateLimit.Valid && rateLimit.String != "" {
		upstream.RateLimit = &rateLimit.String
	}
	return upstream, nil
}

// RowToUpstreamOut converts a row into its API shape, leaving the runtime health
// fields at their neutral defaults for the caller to fill in.
func RowToUpstreamOut(row *models.UpstreamRow) (models.UpstreamOut, error) {
	modelNames, err := parseJSONArray(row.ModelNames)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	modelPrefixes, err := parseJSONArray(row.ModelPrefixes)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	modelMappings, err := parseJSONMap(row.ModelMappings)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	extraHeaders, err := parseJSONMap(row.ExtraHeaders)
	if err != nil {
		return models.UpstreamOut{}, err
	}

	return models.UpstreamOut{
		ID:                 row.ID,
		Name:               row.Name,
		BaseURL:            row.BaseURL,
		APIKeySet:          row.APIKey != nil,
		ModelNames:         modelNames,
		ModelPrefixes:      modelPrefixes,
		ModelMappings:      modelMappings,
		Priority:           row.Priority,
		Weight:             row.Weight,
		AutoWeightEnabled:  row.AutoWeightEnabled == 1,
		Enabled:            row.Enabled == 1,
		ExtraHeaders:       extraHeaders,
		TimeoutSeconds:     row.TimeoutSeconds,
		RateLimit:          row.RateLimit,
		CreatedAt:          row.CreatedAt,
		UpdatedAt:          row.UpdatedAt,
		RuntimeHealthScore: 100,
		EffectiveWeight:    float64(row.Weight),
	}, nil
}

func queryUpstreamRows(ctx context.Context, db *sql.DB, query string, args ...any) ([]models.UpstreamRow, error) {
	rows, err := db.QueryContext(ctx, query, args...)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	upstreams := []models.UpstreamRow{}
	for rows.Next() {
		upstream, err := scanUpstreamRow(rows)
		if err != nil {
			return nil, apperr.Database(err)
		}
		upstreams = append(upstreams, upstream)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return upstreams, nil
}

func ListUpstreams(ctx context.Context, db *sql.DB) ([]models.UpstreamOut, error) {
	rows, err := queryUpstreamRows(ctx, db,
		"SELECT "+upstreamColumns+" FROM upstreams ORDER BY priority DESC, id ASC")
	if err != nil {
		return nil, err
	}
	membership, err := UpstreamGroupMembership(ctx, db)
	if err != nil {
		return nil, err
	}

	upstreams := make([]models.UpstreamOut, 0, len(rows))
	for i := range rows {
		out, err := RowToUpstreamOut(&rows[i])
		if err != nil {
			return nil, err
		}
		out.GroupIDs = membership[out.ID]
		if out.GroupIDs == nil {
			out.GroupIDs = []int64{}
		}
		upstreams = append(upstreams, out)
	}
	return upstreams, nil
}

func ListEnabledUpstreams(ctx context.Context, db *sql.DB) ([]models.UpstreamRow, error) {
	return queryUpstreamRows(ctx, db,
		"SELECT "+upstreamColumns+" FROM upstreams WHERE enabled = 1 ORDER BY priority DESC, id ASC")
}

// GetUpstream returns ok=false when no row carries the id.
func GetUpstream(ctx context.Context, db Queryer, id int64) (models.UpstreamRow, bool, error) {
	row := db.QueryRowContext(ctx, "SELECT "+upstreamColumns+" FROM upstreams WHERE id = ?", id)
	upstream, err := scanUpstreamRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return upstream, false, nil
	}
	if err != nil {
		return upstream, false, apperr.Database(err)
	}
	return upstream, true, nil
}

func GetUpstreamByName(ctx context.Context, db *sql.DB, name string) (models.UpstreamRow, bool, error) {
	row := db.QueryRowContext(ctx, "SELECT "+upstreamColumns+" FROM upstreams WHERE name = ?", name)
	upstream, err := scanUpstreamRow(row)
	if errors.Is(err, sql.ErrNoRows) {
		return upstream, false, nil
	}
	if err != nil {
		return upstream, false, apperr.Database(err)
	}
	return upstream, true, nil
}

// encodeUpstreamCollections serializes the four JSON-backed columns.
func encodeUpstreamCollections(input *models.UpstreamIn) (names, prefixes, mappings, headers string, err error) {
	encode := func(value any) (string, error) {
		encoded, err := json.Marshal(value)
		if err != nil {
			return "", apperr.JSON(err)
		}
		return string(encoded), nil
	}
	if names, err = encode(input.ModelNames); err != nil {
		return
	}
	if prefixes, err = encode(input.ModelPrefixes); err != nil {
		return
	}
	if mappings, err = encode(input.ModelMappings); err != nil {
		return
	}
	headers, err = encode(input.ExtraHeaders)
	return
}

func boolToInt64(value bool) int64 {
	if value {
		return 1
	}
	return 0
}

func CreateUpstream(ctx context.Context, db *sql.DB, input *models.UpstreamIn, defaultTimeout float64) (models.UpstreamOut, error) {
	timeout := defaultTimeout
	if input.TimeoutSeconds != nil {
		timeout = *input.TimeoutSeconds
	}
	modelNames, modelPrefixes, modelMappings, extraHeaders, err := encodeUpstreamCollections(input)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	rateLimit, err := input.NormalizedRateLimit()
	if err != nil {
		return models.UpstreamOut{}, apperr.BadRequest(err.Error())
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	defer tx.Rollback()

	result, err := tx.ExecContext(ctx, `INSERT INTO upstreams
        (name, base_url, api_key, model_names, model_prefixes, model_mappings,
         priority, weight, auto_weight_enabled, enabled, extra_headers, timeout_seconds,
         rate_limit, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), datetime('now'))`,
		input.Name, input.BaseURL, input.APIKey, modelNames, modelPrefixes, modelMappings,
		input.Priority, input.Weight, boolToInt64(input.AutoWeightEnabled),
		boolToInt64(input.Enabled), extraHeaders, timeout, rateLimit)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}

	// Membership commits with the channel, so a channel can never exist without
	// belonging to a group and therefore being unreachable.
	if err := ReplaceUpstreamGroups(ctx, tx, id, input.GroupIDs); err != nil {
		return models.UpstreamOut{}, err
	}

	// Read back inside the transaction, so the response describes the channel
	// this call created rather than what a concurrent edit had made of it by
	// the time the read ran.
	row, ok, err := GetUpstream(ctx, tx, id)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	if !ok {
		return models.UpstreamOut{}, apperr.Internal("upstream was not persisted")
	}
	out, err := RowToUpstreamOut(&row)
	if err != nil {
		return out, err
	}
	if out.GroupIDs, err = ListUpstreamGroupIDs(ctx, tx, id); err != nil {
		return out, err
	}

	if err := tx.Commit(); err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	return out, nil
}

func UpdateUpstream(ctx context.Context, db *sql.DB, id int64, input *models.UpstreamUpdate) (models.UpstreamOut, error) {
	modelNames, modelPrefixes, modelMappings, extraHeaders, err := encodeUpstreamCollections(&input.UpstreamIn)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	rateLimit, err := input.NormalizedRateLimit()
	if err != nil {
		return models.UpstreamOut{}, apperr.BadRequest(err.Error())
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	defer tx.Rollback()

	// The fields this edit does not carry are read inside the transaction that
	// writes them back. Reading them before it meant a save could carry a value
	// another edit had already replaced — restoring an API key that had just
	// been cleared, because the form that did not mention the key still wrote
	// the one it had loaded.
	existing, ok, err := GetUpstream(ctx, tx, id)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	if !ok {
		return models.UpstreamOut{}, apperr.NotFound(fmt.Sprintf("upstream %d not found", id))
	}

	apiKey := existing.APIKey
	switch {
	case input.ClearAPIKey:
		apiKey = nil
	case input.APIKey != nil:
		apiKey = input.APIKey
	}

	timeout := existing.TimeoutSeconds
	if input.TimeoutSeconds != nil {
		timeout = *input.TimeoutSeconds
	}

	_, err = tx.ExecContext(ctx, `UPDATE upstreams
        SET name = ?, base_url = ?, api_key = ?,
            model_names = ?, model_prefixes = ?, model_mappings = ?,
            priority = ?, weight = ?, auto_weight_enabled = ?, enabled = ?, extra_headers = ?,
            timeout_seconds = ?, rate_limit = ?, updated_at = datetime('now')
        WHERE id = ?`,
		input.Name, input.BaseURL, apiKey, modelNames, modelPrefixes, modelMappings,
		input.Priority, input.Weight, boolToInt64(input.AutoWeightEnabled),
		boolToInt64(input.Enabled), extraHeaders, timeout, rateLimit, id)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	if err := ReplaceUpstreamGroups(ctx, tx, id, input.GroupIDs); err != nil {
		return models.UpstreamOut{}, err
	}
	if err := tx.Commit(); err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}

	return reloadUpstreamOut(ctx, db, id)
}

func SetUpstreamEnabled(ctx context.Context, db *sql.DB, id int64, enabled bool) (models.UpstreamOut, error) {
	_, err := db.ExecContext(ctx,
		"UPDATE upstreams SET enabled = ?, updated_at = datetime('now') WHERE id = ?",
		boolToInt64(enabled), id)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	return reloadUpstreamOut(ctx, db, id)
}

func SetUpstreamPriority(ctx context.Context, db *sql.DB, id int64, priority int32) (models.UpstreamOut, error) {
	_, err := db.ExecContext(ctx,
		"UPDATE upstreams SET priority = ?, updated_at = datetime('now') WHERE id = ?",
		priority, id)
	if err != nil {
		return models.UpstreamOut{}, apperr.Database(err)
	}
	return reloadUpstreamOut(ctx, db, id)
}

func reloadUpstreamOut(ctx context.Context, db *sql.DB, id int64) (models.UpstreamOut, error) {
	row, ok, err := GetUpstream(ctx, db, id)
	if err != nil {
		return models.UpstreamOut{}, err
	}
	if !ok {
		return models.UpstreamOut{}, apperr.NotFound(fmt.Sprintf("upstream %d not found", id))
	}
	out, err := RowToUpstreamOut(&row)
	if err != nil {
		return out, err
	}
	out.GroupIDs, err = ListUpstreamGroupIDs(ctx, db, id)
	return out, err
}

func DeleteUpstream(ctx context.Context, db *sql.DB, id int64) (bool, error) {
	return execAffectsAny(ctx, db, "DELETE FROM upstreams WHERE id = ?", id)
}
