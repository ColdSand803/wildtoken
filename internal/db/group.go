package db

import (
	"context"
	"database/sql"
	"errors"
	"strings"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// ListGroups returns every group with the counts the console needs to warn
// before a deletion that would strand tokens.
func ListGroups(ctx context.Context, database *sql.DB) ([]models.Group, error) {
	rows, err := database.QueryContext(ctx, `SELECT g.id, g.name, g.description,
              g.created_at, g.updated_at,
              (SELECT COUNT(*) FROM upstream_groups ug WHERE ug.group_id = g.id),
              (SELECT COUNT(*) FROM api_tokens t WHERE t.group_id = g.id)
       FROM groups AS g ORDER BY g.id ASC`)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	groups := []models.Group{}
	for rows.Next() {
		var group models.Group
		if err := rows.Scan(&group.ID, &group.Name, &group.Description,
			&group.CreatedAt, &group.UpdatedAt,
			&group.UpstreamCount, &group.TokenCount); err != nil {
			return nil, apperr.Database(err)
		}
		group.IsDefault = group.ID == models.DefaultGroupID
		groups = append(groups, group)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return groups, nil
}

// GetGroup returns ok=false when no group carries the id.
func GetGroup(ctx context.Context, database *sql.DB, id int64) (models.Group, bool, error) {
	var group models.Group
	err := database.QueryRowContext(ctx, `SELECT id, name, description, created_at, updated_at
       FROM groups WHERE id = ?`, id).
		Scan(&group.ID, &group.Name, &group.Description, &group.CreatedAt, &group.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return group, false, nil
	}
	if err != nil {
		return group, false, apperr.Database(err)
	}
	group.IsDefault = group.ID == models.DefaultGroupID
	return group, true, nil
}

func CreateGroup(ctx context.Context, database *sql.DB, input *models.GroupIn) (models.Group, error) {
	result, err := database.ExecContext(ctx,
		"INSERT INTO groups (name, description, created_at, updated_at) VALUES (?, ?, datetime('now'), datetime('now'))",
		strings.TrimSpace(input.Name), strings.TrimSpace(input.Description))
	if err != nil {
		return models.Group{}, apperr.Database(err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		return models.Group{}, apperr.Database(err)
	}
	group, ok, err := GetGroup(ctx, database, id)
	if err != nil {
		return models.Group{}, err
	}
	if !ok {
		return models.Group{}, apperr.Internal("group was not persisted")
	}
	return group, nil
}

// UpdateGroup renames a group. found=false when no group carries the id.
func UpdateGroup(ctx context.Context, database *sql.DB, id int64, input *models.GroupIn) (models.Group, bool, error) {
	result, err := database.ExecContext(ctx,
		"UPDATE groups SET name = ?, description = ?, updated_at = datetime('now') WHERE id = ?",
		strings.TrimSpace(input.Name), strings.TrimSpace(input.Description), id)
	if err != nil {
		return models.Group{}, false, apperr.Database(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return models.Group{}, false, apperr.Database(err)
	}
	if affected == 0 {
		return models.Group{}, false, nil
	}
	group, ok, err := GetGroup(ctx, database, id)
	return group, ok, err
}

// DeleteGroup removes a group, moving what belonged to it to the default group.
//
// A token must always name a group that exists, so the tokens move rather than
// being left dangling. Channels move for the same reason: the join table's
// cascade narrows what a channel serves, and for a channel that served only this
// group it narrows it to nothing — leaving it enabled in the console, reachable
// by no token, with nothing to say why. The channel stores hold that a channel
// always belongs to a group; deleting one is not an exception to it.
func DeleteGroup(ctx context.Context, database *sql.DB, id int64) (bool, error) {
	if id == models.DefaultGroupID {
		return false, apperr.BadRequest("the default group cannot be deleted")
	}

	tx, err := database.BeginTx(ctx, nil)
	if err != nil {
		return false, apperr.Database(err)
	}
	defer tx.Rollback()

	if _, err := tx.ExecContext(ctx,
		"UPDATE api_tokens SET group_id = ?, updated_at = datetime('now') WHERE group_id = ?",
		models.DefaultGroupID, id); err != nil {
		return false, apperr.Database(err)
	}

	// Channels this group was the last home of join the default group. Done
	// before the delete, so the cascade only has to clear the membership row
	// itself.
	if _, err := tx.ExecContext(ctx,
		`INSERT OR IGNORE INTO upstream_groups (upstream_id, group_id)
         SELECT upstream_id, ? FROM upstream_groups
         WHERE group_id = ? AND upstream_id NOT IN (
             SELECT upstream_id FROM upstream_groups WHERE group_id <> ?
         )`,
		models.DefaultGroupID, id, id); err != nil {
		return false, apperr.Database(err)
	}

	result, err := tx.ExecContext(ctx, "DELETE FROM groups WHERE id = ?", id)
	if err != nil {
		return false, apperr.Database(err)
	}
	affected, err := result.RowsAffected()
	if err != nil {
		return false, apperr.Database(err)
	}
	if affected == 0 {
		return false, nil
	}

	if err := tx.Commit(); err != nil {
		return false, apperr.Database(err)
	}
	return true, nil
}

// GroupExists reports whether an id names a real group, so a write can reject a
// reference the schema cannot enforce on its own.
func GroupExists(ctx context.Context, database Queryer, id int64) (bool, error) {
	var count int64
	if err := database.QueryRowContext(ctx,
		"SELECT COUNT(*) FROM groups WHERE id = ?", id).Scan(&count); err != nil {
		return false, apperr.Database(err)
	}
	return count == 1, nil
}

// ListUpstreamGroupIDs returns the groups one channel serves.
func ListUpstreamGroupIDs(ctx context.Context, database Queryer, upstreamID int64) ([]int64, error) {
	rows, err := database.QueryContext(ctx,
		"SELECT group_id FROM upstream_groups WHERE upstream_id = ? ORDER BY group_id", upstreamID)
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	ids := []int64{}
	for rows.Next() {
		var id int64
		if err := rows.Scan(&id); err != nil {
			return nil, apperr.Database(err)
		}
		ids = append(ids, id)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return ids, nil
}

// UpstreamGroupMembership loads membership for every channel in one query, so
// the routing snapshot and channel listing do not issue a query per row.
func UpstreamGroupMembership(ctx context.Context, database *sql.DB) (map[int64][]int64, error) {
	rows, err := database.QueryContext(ctx,
		"SELECT upstream_id, group_id FROM upstream_groups ORDER BY upstream_id, group_id")
	if err != nil {
		return nil, apperr.Database(err)
	}
	defer rows.Close()

	membership := map[int64][]int64{}
	for rows.Next() {
		var upstreamID, groupID int64
		if err := rows.Scan(&upstreamID, &groupID); err != nil {
			return nil, apperr.Database(err)
		}
		membership[upstreamID] = append(membership[upstreamID], groupID)
	}
	if err := rows.Err(); err != nil {
		return nil, apperr.Database(err)
	}
	return membership, nil
}

// ReplaceUpstreamGroups sets exactly which groups a channel serves.
//
// An empty selection falls back to the default group: a channel in no group at
// all is unreachable, which is never what an operator means by saving a form.
func ReplaceUpstreamGroups(ctx context.Context, tx *sql.Tx, upstreamID int64, groupIDs []int64) error {
	if _, err := tx.ExecContext(ctx,
		"DELETE FROM upstream_groups WHERE upstream_id = ?", upstreamID); err != nil {
		return apperr.Database(err)
	}

	unique := map[int64]bool{}
	for _, groupID := range groupIDs {
		unique[groupID] = true
	}
	if len(unique) == 0 {
		unique[models.DefaultGroupID] = true
	}

	for groupID := range unique {
		exists, err := GroupExists(ctx, tx, groupID)
		if err != nil {
			return err
		}
		if !exists {
			return apperr.BadRequest("group does not exist")
		}
		if _, err := tx.ExecContext(ctx,
			"INSERT INTO upstream_groups (upstream_id, group_id) VALUES (?, ?)",
			upstreamID, groupID); err != nil {
			return apperr.Database(err)
		}
	}
	return nil
}

// ListEnabledUpstreamsInGroup returns the enabled channels one group can reach.
func ListEnabledUpstreamsInGroup(ctx context.Context, database *sql.DB, groupID int64) ([]models.UpstreamRow, error) {
	return queryUpstreamRows(ctx, database,
		"SELECT "+upstreamColumns+` FROM upstreams
         WHERE enabled = 1 AND id IN (SELECT upstream_id FROM upstream_groups WHERE group_id = ?)
         ORDER BY priority DESC, id ASC`, groupID)
}
