package db

import (
	"context"
	"database/sql"
	"errors"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

const createResponseRoutes = `CREATE TABLE IF NOT EXISTS response_routes (
    token_id INTEGER NOT NULL REFERENCES api_tokens(id) ON DELETE CASCADE,
    response_id TEXT NOT NULL,
    upstream_id INTEGER NOT NULL REFERENCES upstreams(id) ON DELETE CASCADE,
    key_id INTEGER NOT NULL,
    credential_digest TEXT NOT NULL,
    request_model TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (token_id, response_id)
) WITHOUT ROWID;`

func GetResponseRoute(ctx context.Context, database Queryer, tokenID int64,
	responseID string) (models.ResponseRoute, bool, error) {
	var route models.ResponseRoute
	err := database.QueryRowContext(ctx, `SELECT response_id, token_id, upstream_id,
        key_id, credential_digest, request_model FROM response_routes
        WHERE token_id = ? AND response_id = ?`, tokenID, responseID).
		Scan(&route.ResponseID, &route.TokenID, &route.UpstreamID, &route.KeyID,
			&route.CredentialDigest, &route.RequestModel)
	if errors.Is(err, sql.ErrNoRows) {
		return route, false, nil
	}
	if err != nil {
		return route, false, apperr.Database(err)
	}
	return route, true, nil
}

// StoreResponseRoute refuses an ID reused by another provider account.
func StoreResponseRoute(ctx context.Context, database Queryer, route models.ResponseRoute) error {
	var id string
	err := database.QueryRowContext(ctx, `INSERT INTO response_routes
        (token_id, response_id, upstream_id, key_id, credential_digest, request_model)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (token_id, response_id) DO UPDATE SET response_id = excluded.response_id
        WHERE upstream_id = excluded.upstream_id AND key_id = excluded.key_id
          AND credential_digest = excluded.credential_digest
        RETURNING response_id`, route.TokenID, route.ResponseID, route.UpstreamID,
		route.KeyID, route.CredentialDigest, route.RequestModel).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return apperr.Conflict("response ID already belongs to another account")
	}
	if err != nil {
		return apperr.Database(err)
	}
	return nil
}
