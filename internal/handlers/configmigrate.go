package handlers

import (
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/configpack"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// Portable configuration export and import.
//
// Kept separate from the disaster-recovery endpoints in backup.go, as the
// checklist requires: this one moves configuration between instances and is
// something an operator does routinely, while a database restore replaces
// everything the service has. Sharing one route group would mean one audit line
// and one authorization for two operations with very different consequences.

// AdminExportConfig builds a portable configuration archive.
//
// POST rather than GET even though it reads: the request carries a password and a
// scope selection, and a password in a query string lands in access logs and the
// browser's history.
func AdminExportConfig(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request models.ConfigExportRequest
		if err := decodeJSON(w, r, &request); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := request.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		scopes := request.SelectedScopes()
		payload, err := db.ExportConfig(r.Context(), state.DB, scopes, request.IncludeSecrets)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		archive, err := configpack.Seal(models.ConfigArchive{
			AppVersion:      Version,
			ExportedAt:      time.Now().UTC().Format(time.RFC3339),
			Scopes:          scopes,
			IncludesSecrets: request.IncludeSecrets,
		}, payload, request.Password)
		if err != nil {
			apperr.WriteError(w, apperr.Internal(err.Error()))
			return
		}

		// Audited without the password and without the archive: what is worth
		// recording is that credentials left the instance, not what they were.
		slog.Info("configuration archive exported",
			"scopes", scopes, "includes_secrets", request.IncludeSecrets,
			"encrypted", archive.Encrypted())
		apperr.WriteJSON(w, http.StatusOK, archive)
	}
}

// AdminImportConfig validates an archive and, unless this is a dry run, applies it.
//
// One endpoint for both rather than two, because the plan and the application must
// come from the same code: a preview produced by a separate path would eventually
// describe an outcome the real import does not produce, and that is exactly the
// kind of difference an operator relies on the preview to rule out.
func AdminImportConfig(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request models.ConfigImportRequest
		if err := decodeJSON(w, r, &request); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := request.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		payload, err := configpack.Open(request.Archive, request.Password)
		if err != nil {
			// A wrong password and a tampered archive are one case — AES-GCM cannot
			// tell them apart — and both are the caller's input, so 400 rather than
			// 500. Reported before anything is read from the payload, so a failed
			// unseal cannot have written anything.
			if errors.Is(err, configpack.ErrWrongPassword) {
				apperr.WriteError(w, apperr.BadRequest(err.Error()))
				return
			}
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		response, err := db.ImportConfig(r.Context(), state.DB, payload, db.ConfigImportOptions{
			OnConflict:            request.OnConflict,
			DryRun:                request.DryRun,
			Scopes:                request.Scopes,
			DefaultTimeoutSeconds: state.Settings.Upstream.DefaultTimeoutSeconds,
		})
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		// Echoed from the archive so the console can label the plan with where it
		// came from without parsing the archive a second time.
		response.SchemaVersion = request.Archive.SchemaVersion
		response.AppVersion = request.Archive.AppVersion
		response.ExportedAt = request.Archive.ExportedAt
		response.IncludesSecrets = request.Archive.IncludesSecrets
		response.Scopes = request.Archive.Scopes

		if response.Applied {
			// Every cache keyed on configuration is dropped, because an import can
			// have changed channels, groups and token policies at once. Narrowing this
			// to what the archive touched would be an optimisation whose failure mode
			// is the gateway routing on configuration that no longer exists.
			state.ModelsCache.Invalidate()
			state.Routing.Invalidate()
			reloadRuntimeSettings(r, state)
			slog.Info("configuration archive imported",
				"created", response.Created, "updated", response.Updated,
				"skipped", response.Skipped, "on_conflict", request.OnConflict)
		}

		status := http.StatusOK
		if len(response.Errors) > 0 {
			// 400 with the full report rather than a bare error: the item list names
			// which entry was refused, which is what the operator needs in order to fix
			// the archive. Nothing was written — the import rolls back on any refusal.
			status = http.StatusBadRequest
		}
		apperr.WriteJSON(w, status, response)
	}
}

// reloadRuntimeSettings republishes the settings row after an import wrote it.
//
// Without this the process keeps serving the previous policy until a restart, so
// an imported retry or log-retention setting would appear saved in the console and
// have no effect on traffic.
func reloadRuntimeSettings(r *http.Request, state *appstate.State) {
	settings, found, err := db.LoadRuntimeSettings(r.Context(), state.DB)
	if err != nil {
		slog.Warn("could not reload runtime settings after a configuration import",
			"error", err)
		return
	}
	if !found {
		return
	}
	settings.DatabaseOverride = true
	state.Runtime.Set(settings)
}
