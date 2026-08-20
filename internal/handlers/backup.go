package handlers

import (
	"bytes"
	"encoding/base64"
	"errors"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/backup"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// Disaster recovery is routed and audited separately from configuration migration.
//
// The two look similar from the console and are not: a configuration import writes
// named settings into a running instance, while a restore replaces every row it has —
// request logs, quota counters, and the admin credential included. One route group
// and one audit line for both would mean an operator's approval of the smaller
// operation reads as approval of the larger.

// databaseBackupPath returns the live database's path, or an error the operator can
// act on.
//
// Refused rather than guessed: staging a restore beside the wrong file would write a
// database nothing reads and report success.
func databaseBackupPath(state *appstate.State) (string, error) {
	if strings.TrimSpace(state.DatabasePath) == "" {
		return "", apperr.Internal(
			"the database file path is unknown, so backup and restore are unavailable")
	}
	return state.DatabasePath, nil
}

// AdminBackupInfo describes the instance's own database, so the console can show what
// a backup would contain before one is taken.
func AdminBackupInfo(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path, err := databaseBackupPath(state)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		fingerprint, err := backup.SchemaFingerprint(r.Context(), state.DB)
		if err != nil {
			apperr.WriteError(w, apperr.Internal(err.Error()))
			return
		}

		info := models.BackupInfoOut{
			AppVersion:        Version,
			SchemaVersion:     models.BackupSchemaVersion,
			SchemaFingerprint: fingerprint,
			Compatible:        true,
		}
		// Reported from the live database rather than from the file: the file on disk
		// excludes whatever is still in the WAL, so its size understates the data.
		var pageSize, pageCount int64
		if err := state.DB.QueryRowContext(r.Context(), "PRAGMA page_size").
			Scan(&pageSize); err == nil {
			info.PageSize = pageSize
		}
		if err := state.DB.QueryRowContext(r.Context(), "PRAGMA page_count").
			Scan(&pageCount); err == nil {
			info.PageCount = pageCount
		}
		info.SizeBytes = pageSize * pageCount
		if stat, err := os.Stat(path); err == nil && info.SizeBytes == 0 {
			info.SizeBytes = stat.Size()
		}

		pending := models.PendingRestoreOut{}
		if marker, found, err := backup.ReadMarker(backup.PathsFor(path)); err == nil && found {
			// Surfaced so a staged restore is not something an operator discovers by
			// restarting and finding a different database.
			pending = models.PendingRestoreOut{
				Pending: true, StagedAt: marker.StagedAt,
				SizeBytes: marker.SizeBytes, Checksum: marker.Checksum,
			}
		}

		apperr.WriteJSON(w, http.StatusOK, map[string]any{
			"current":         info,
			"pending_restore": pending,
		})
	}
}

// AdminCreateBackup streams a consistent snapshot of the database.
//
// POST rather than GET: the request carries the archive password, and a password in a
// query string lands in access logs and the browser's history. It also means a backup
// cannot be triggered by a link.
func AdminCreateBackup(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			Password string `json:"password"`
		}
		// A body is optional: an unencrypted backup needs nothing from the caller.
		if r.ContentLength > 0 {
			if err := decodeJSON(w, r, &request); err != nil {
				apperr.WriteError(w, err)
				return
			}
		}
		password := strings.TrimSpace(request.Password)
		if password != "" && len(password) < models.ConfigExportMinPasswordLen {
			apperr.WriteError(w, apperr.BadRequest(fmt.Sprintf(
				"the backup password must be at least %d characters",
				models.ConfigExportMinPasswordLen)))
			return
		}

		path, err := databaseBackupPath(state)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		// Written into a temporary directory and removed afterwards: the snapshot is a
		// full copy of the database, including credentials, and leaving it beside the
		// live file would be a second copy nobody is watching.
		workspace, err := os.MkdirTemp(filepath.Dir(path), ".wildtoken-backup-")
		if err != nil {
			apperr.WriteError(w, apperr.Internal("prepare backup workspace: "+err.Error()))
			return
		}
		defer os.RemoveAll(workspace)

		snapshotPath := filepath.Join(workspace, "snapshot.db")
		if err := backup.Snapshot(r.Context(), state.DB, snapshotPath); err != nil {
			apperr.WriteError(w, apperr.Internal(err.Error()))
			return
		}

		checksum, size, err := backup.FileChecksum(snapshotPath)
		if err != nil {
			apperr.WriteError(w, apperr.Internal("checksum snapshot: "+err.Error()))
			return
		}
		stats, fingerprint, err := backup.Inspect(r.Context(), snapshotPath)
		if err != nil {
			apperr.WriteError(w, apperr.Internal(err.Error()))
			return
		}
		// Verified before it is handed over, so a backup this service reports as taken
		// is one it has read back.
		if err := backup.Verify(r.Context(), snapshotPath); err != nil {
			apperr.WriteError(w, apperr.Internal(
				"the snapshot did not pass its integrity check: "+err.Error()))
			return
		}

		header := models.BackupHeader{
			Kind:              models.BackupKind,
			SchemaVersion:     models.BackupSchemaVersion,
			AppVersion:        Version,
			CreatedAt:         time.Now().UTC().Format(time.RFC3339),
			SchemaFingerprint: fingerprint,
			Checksum:          checksum,
			SizeBytes:         size,
			PageSize:          stats.PageSize,
			PageCount:         stats.PageCount,
		}

		containerPath := filepath.Join(workspace, "backup.wtbak")
		if err := backup.WriteContainer(containerPath, header, snapshotPath, password); err != nil {
			apperr.WriteError(w, apperr.Internal(err.Error()))
			return
		}

		file, err := os.Open(containerPath)
		if err != nil {
			apperr.WriteError(w, apperr.Internal("read backup: "+err.Error()))
			return
		}
		defer file.Close()
		stat, err := file.Stat()
		if err != nil {
			apperr.WriteError(w, apperr.Internal("read backup: "+err.Error()))
			return
		}

		// Audited without the password: what is worth recording is that a full copy of
		// the database left the instance.
		slog.Warn("database backup created",
			"size_bytes", size, "encrypted", password != "",
			"schema_fingerprint", fingerprint)

		name := fmt.Sprintf("wildtoken-%s.wtbak",
			time.Now().UTC().Format("20060102-150405"))
		w.Header().Set("content-type", "application/octet-stream")
		w.Header().Set("content-disposition", `attachment; filename="`+name+`"`)
		w.Header().Set("content-length", fmt.Sprint(stat.Size()))
		// Not cached anywhere: this response is the database.
		w.Header().Set("cache-control", "no-store")
		w.Header().Set("x-backup-checksum", checksum)
		http.ServeContent(w, r, name, time.Now(), file)
	}
}

// AdminRestoreBackup verifies an uploaded backup and, unless this is a dry run,
// stages it for the next start.
//
// One endpoint for both, so the verification an operator approves is the verification
// that runs: a separate preview path would eventually accept a file the real restore
// rejects, or worse, the reverse.
func AdminRestoreBackup(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var request models.RestoreRequest
		if err := decodeJSON(w, r, &request); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := request.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		path, err := databaseBackupPath(state)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		raw, err := base64.StdEncoding.DecodeString(request.Archive)
		if err != nil {
			apperr.WriteError(w, apperr.BadRequest("the uploaded backup is not valid base64"))
			return
		}

		response, err := stageRestore(r, state, path, raw, request)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, response)
	}
}

// stageRestore does the verification and, for a real restore, the staging.
//
// Split out so the ordering is readable in one place: every check happens before
// anything is written, and the rollback copy is taken before the marker exists.
func stageRestore(r *http.Request, state *appstate.State, databasePath string,
	raw []byte, request models.RestoreRequest) (models.RestoreResponse, error) {
	response := models.RestoreResponse{DryRun: request.DryRun, Warnings: []string{}}

	reader := bytes.NewReader(raw)
	header, err := backup.ReadHeader(reader)
	if err != nil {
		return response, apperr.BadRequest(err.Error())
	}
	response.Backup = models.BackupInfoOut{
		AppVersion: header.AppVersion, SchemaVersion: header.SchemaVersion,
		SchemaFingerprint: header.SchemaFingerprint, CreatedAt: header.CreatedAt,
		SizeBytes: header.SizeBytes, PageSize: header.PageSize,
		PageCount: header.PageCount, Encrypted: header.Encrypted(),
	}

	currentFingerprint, err := backup.SchemaFingerprint(r.Context(), state.DB)
	if err != nil {
		return response, apperr.Internal(err.Error())
	}
	response.Current = models.BackupInfoOut{
		AppVersion: Version, SchemaVersion: models.BackupSchemaVersion,
		SchemaFingerprint: currentFingerprint, Compatible: true,
	}

	paths := backup.PathsFor(databasePath)
	// Staged into the final location's directory even for a dry run, because that is
	// the filesystem the real restore writes to: a dry run that verified on a
	// different device would not have proven the space exists.
	workspace, err := os.MkdirTemp(filepath.Dir(databasePath), ".wildtoken-restore-")
	if err != nil {
		return response, apperr.Internal("prepare restore workspace: " + err.Error())
	}
	defer os.RemoveAll(workspace)

	candidate := filepath.Join(workspace, "candidate.db")
	if err := backup.OpenBody(reader, header, candidate, request.Password); err != nil {
		// A wrong password, a tampered file and a truncated upload are all the
		// caller's input, so 400 rather than 500. Reported before anything of the
		// instance's own has been touched.
		if errors.Is(err, backup.ErrWrongPassword) {
			return response, apperr.BadRequest(err.Error())
		}
		return response, apperr.BadRequest(err.Error())
	}

	if err := backup.LooksLikeWildToken(r.Context(), candidate); err != nil {
		return response, apperr.BadRequest(err.Error())
	}
	if err := backup.Verify(r.Context(), candidate); err != nil {
		return response, apperr.BadRequest(err.Error())
	}

	_, candidateFingerprint, err := backup.Inspect(r.Context(), candidate)
	if err != nil {
		return response, apperr.BadRequest(err.Error())
	}
	if candidateFingerprint != currentFingerprint {
		message := "the backup's schema differs from this instance's; " +
			"it was taken by a different version of WildToken"
		if !request.AllowSchemaMismatch {
			// Refused by default, but overridable: a backup taken minutes before an
			// upgrade is exactly what someone reaches for during an incident, and the
			// migrations here are idempotent CREATE and ensureColumn statements, so an
			// older schema is brought forward on the next start.
			response.Backup.Compatible = false
			response.Backup.Incompatibility = message
			return response, apperr.BadRequest(message +
				`; set allow_schema_mismatch to restore it anyway`)
		}
		response.Warnings = append(response.Warnings, message+
			"，已按要求继续；下次启动会补齐缺失的表与列")
	}
	response.Verified = true

	if request.DryRun {
		return response, nil
	}

	// The rollback copy is a snapshot, not a file copy: the live database is open and
	// being written to, and a byte copy of it can land mid-write — which would make
	// the operator's only fallback unrestorable.
	rollbackPath := backup.RollbackName(databasePath)
	if err := backup.Snapshot(r.Context(), state.DB, rollbackPath); err != nil {
		return response, apperr.Internal("take the pre-restore backup: " + err.Error())
	}
	if err := backup.Verify(r.Context(), rollbackPath); err != nil {
		os.Remove(rollbackPath)
		return response, apperr.Internal(
			"the pre-restore backup did not verify, so the restore was not staged: " + err.Error())
	}
	response.RollbackPath = rollbackPath

	// Moved into place only now, after everything about it has been checked and after
	// the fallback exists.
	if err := os.Rename(candidate, paths.Staged); err != nil {
		os.Remove(rollbackPath)
		return response, apperr.Internal("stage the restore: " + err.Error())
	}
	stagedChecksum, stagedSize, err := backup.FileChecksum(paths.Staged)
	if err != nil {
		backup.ClearStaged(paths)
		os.Remove(rollbackPath)
		return response, apperr.Internal("verify the staged restore: " + err.Error())
	}

	// The marker is written last. Its presence is what makes the next start adopt the
	// file, so it must not exist before the file is in place and checked.
	if err := backup.WriteMarker(paths, backup.Marker{
		StagedAt:         time.Now().UTC().Format(time.RFC3339),
		Checksum:         stagedChecksum,
		SizeBytes:        stagedSize,
		SourceAppVersion: header.AppVersion,
		RollbackPath:     rollbackPath,
	}); err != nil {
		backup.ClearStaged(paths)
		return response, apperr.Internal(err.Error())
	}

	response.Staged = true
	// Always true when something was staged: this process holds the database open, so
	// the swap happens at the next start and not before.
	response.RequiresRestart = true

	slog.Warn("database restore staged",
		"source_app_version", header.AppVersion, "size_bytes", header.SizeBytes,
		"rollback", rollbackPath, "schema_mismatch_allowed", request.AllowSchemaMismatch)
	return response, nil
}

// AdminCancelRestore discards a staged restore.
//
// Offered because staging is deliberately not the same as applying: between the two
// there is a window in which an operator can change their mind, and without this the
// only way out is editing files on the server.
func AdminCancelRestore(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		path, err := databaseBackupPath(state)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		paths := backup.PathsFor(path)

		marker, found, err := backup.ReadMarker(paths)
		if err != nil {
			apperr.WriteError(w, apperr.Internal(err.Error()))
			return
		}
		if !found {
			apperr.WriteError(w, apperr.BadRequest("no restore is staged"))
			return
		}
		if err := backup.ClearStaged(paths); err != nil {
			apperr.WriteError(w, apperr.Internal(err.Error()))
			return
		}

		// The rollback copy is deliberately kept: it is a verified snapshot of the
		// current database, and deleting it because the restore was cancelled would
		// discard something an operator may still want.
		slog.Warn("staged database restore cancelled", "staged_at", marker.StagedAt)
		apperr.WriteJSON(w, http.StatusOK, map[string]any{
			"cancelled":     true,
			"rollback_kept": marker.RollbackPath,
		})
	}
}
