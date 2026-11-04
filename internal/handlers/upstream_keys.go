package handlers

import (
	"context"
	"database/sql"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// probeKey is the key a console probe of a channel signs in with: the one
// asked for by id, disabled or not, else the first enabled. A channel whose
// keys are all disabled has none to offer, and the probe is refused rather
// than sent unsigned.
func probeKey(ctx context.Context, database *sql.DB, row *models.UpstreamRow, keyID int64) (*string, error) {
	if keyID != 0 {
		key, ok, err := db.GetUpstreamKey(ctx, database, row.ID, keyID)
		if err != nil {
			return nil, err
		}
		if !ok {
			return nil, apperr.NotFound(fmt.Sprintf("key %d not found on this channel", keyID))
		}
		return &key.APIKey, nil
	}
	if row.KeyCount > 0 && row.EnabledKeyCount == 0 {
		return nil, apperr.BadRequest("the channel has no enabled key")
	}
	return row.APIKey, nil
}

// upstreamKeysOut lists a channel's keys by name and state, with how long each
// still sits out.
func upstreamKeysOut(ctx context.Context, state *appstate.State, upstreamID int64) ([]models.UpstreamKeyOut, error) {
	keys, err := db.ListUpstreamKeys(ctx, state.DB, upstreamID)
	if err != nil {
		return nil, err
	}
	for i := range keys {
		keys[i].CoolingSeconds = int64(state.Keys.Remaining(keys[i].ID).Seconds())
	}
	return keys, nil
}

// AdminRevealUpstreamKey hands out one of a channel's keys in the clear, the
// only way one leaves the server short of an export; key_id absent asks for
// the first. Every key handed out is logged.
func AdminRevealUpstreamKey(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		var keyID int64
		if raw := r.URL.Query().Get("key_id"); raw != "" {
			if keyID, err = strconv.ParseInt(raw, 10, 64); err != nil || keyID < 0 {
				apperr.WriteError(w, apperr.BadRequest("key_id must be a key's id"))
				return
			}
		}

		row, found, err := db.GetUpstream(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("upstream not found"))
			return
		}
		key, ok, err := db.GetUpstreamKey(r.Context(), state.DB, id, keyID)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !ok {
			apperr.WriteError(w, apperr.NotFound("key not found on this channel"))
			return
		}

		slog.Info("handed out a channel key", "upstream", row.Name, "key_id", key.ID,
			"key_name", key.Name, "client", clientIP(r))
		apperr.WriteJSON(w, http.StatusOK, models.UpstreamCredentialOut{
			BaseURL: row.BaseURL, APIKey: key.APIKey, KeyID: key.ID, KeyName: key.Name,
		})
	}
}
