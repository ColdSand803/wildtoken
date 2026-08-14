package handlers

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/authstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/middleware"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/themes"
)

// Version is the service version reported by the system endpoint.
//
// The release workflow parses this line to check that a tag matches, so its
// shape must stay `const Version = "..."`.
const Version = "0.2.0"

// maxLogListOffset caps how deep the offset-paged log list may reach.
const maxLogListOffset int32 = 100_000

// decodeJSON reads a JSON request body, ignoring fields the target does not
// declare.
//
// This is the lenient default because several console forms post a superset of
// what an endpoint reads. The channel form is the clearest case: it serves both
// create and update, so it always sends `clear_api_key`, which only the update
// payload declares.
func decodeJSON(w http.ResponseWriter, r *http.Request, target any) error {
	return decodeBody(w, r, target, false)
}

// decodeStrictJSON additionally rejects unknown fields, so a typo is reported
// rather than silently ignored. It is reserved for payloads whose clients send
// exactly the declared shape.
func decodeStrictJSON(w http.ResponseWriter, r *http.Request, target any) error {
	return decodeBody(w, r, target, true)
}

func decodeBody(w http.ResponseWriter, r *http.Request, target any, rejectUnknown bool) error {
	// The writer is what lets MaxBytesReader mark the connection for closing
	// when a body runs over. Passing nil left an oversized request reading on
	// against a connection the server would go on to reuse.
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024*1024))
	if rejectUnknown {
		decoder.DisallowUnknownFields()
	}
	if err := decoder.Decode(target); err != nil {
		return apperr.BadRequest("invalid request body: " + err.Error())
	}
	return nil
}

// pathID reads the {id} path parameter.
func pathID(r *http.Request) (int64, error) {
	id, err := strconv.ParseInt(chi.URLParam(r, "id"), 10, 64)
	if err != nil {
		return 0, apperr.BadRequest("id must be an integer")
	}
	return id, nil
}

// isUniqueViolation reports a UNIQUE constraint failure, which the console
// should see as a bad request rather than an internal error.
func isUniqueViolation(err error) bool { return db.IsUniqueViolation(err) }

// HealthCheck reports that the service and its database are reachable.
func HealthCheck(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if _, err := state.DB.ExecContext(r.Context(), "SELECT 1"); err != nil {
			apperr.WriteError(w, apperr.Database(err))
			return
		}
		apperr.WriteJSON(w, http.StatusOK, map[string]string{
			"status": "ok", "service": "WildToken",
		})
	}
}

// ListPublicThemePacks serves the theme packs the console may offer.
func ListPublicThemePacks(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		packs, err := themes.ListPacks(state.Settings.Themes.Dir)
		if err != nil {
			apperr.WriteError(w, apperr.Internal("failed to read theme packs: "+err.Error()))
			return
		}
		apperr.WriteJSON(w, http.StatusOK, packs)
	}
}

// AdminGetRuntimeSettings returns the current operator-editable policy.
func AdminGetRuntimeSettings(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		settings := state.Runtime.Get()
		apperr.WriteJSON(w, http.StatusOK, models.NewRuntimeSettingsOut(&settings))
	}
}

// AdminUpdateRuntimeSettings applies a policy edit under a revision check.
func AdminUpdateRuntimeSettings(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input models.RuntimeSettingsIn
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		updated, err := db.UpdateRuntimeSettings(r.Context(), state.DB, &input)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		// A concurrent update that committed a newer revision must not be rolled
		// back by this one's snapshot.
		if current := state.Runtime.Get(); updated.Revision > current.Revision {
			state.Runtime.Set(updated)
		}
		apperr.WriteJSON(w, http.StatusOK, models.NewRuntimeSettingsOut(&updated))
	}
}

func AdminListModelTestPromptTemplates(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		templates, err := db.ListModelTestPromptTemplates(r.Context(), state.DB)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, templates)
	}
}

func AdminCreateModelTestPromptTemplate(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		var input models.ModelTestPromptTemplateIn
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		template, err := db.CreateModelTestPromptTemplate(r.Context(), state.DB, &input)
		if err != nil {
			if isUniqueViolation(err) {
				apperr.WriteError(w, apperr.BadRequest("prompt template name already exists"))
				return
			}
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusCreated, template)
	}
}

func AdminUpdateModelTestPromptTemplate(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		var input models.ModelTestPromptTemplateIn
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		template, found, err := db.UpdateModelTestPromptTemplate(r.Context(), state.DB, id, &input)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("model test prompt template not found"))
			return
		}
		apperr.WriteJSON(w, http.StatusOK, template)
	}
}

func AdminDeleteModelTestPromptTemplate(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		deleted, err := db.DeleteModelTestPromptTemplate(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !deleted {
			apperr.WriteError(w, apperr.NotFound("model test prompt template not found"))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// AdminRotateAdminToken replaces the admin credential under a version check.
func AdminRotateAdminToken(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.AdminAuthFrom(r.Context())
		if !ok {
			apperr.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}

		var input models.AdminTokenRotateIn
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !input.Confirm {
			apperr.WriteError(w, apperr.BadRequest("explicit confirmation is required"))
			return
		}

		token, err := input.ValidatedToken()
		if err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}
		hash, err := authstate.HashAdminToken(token)
		if err != nil {
			apperr.WriteError(w, apperr.Internal("could not hash admin credential"))
			return
		}

		credential, rotated, err := db.RotateAdminCredential(r.Context(), state.DB, hash,
			auth.CredentialVersion)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !rotated {
			apperr.WriteError(w, apperr.Conflict("admin credential version conflict"))
			return
		}

		// The snapshot is published only after the credential transaction
		// commits. Publication is monotonic even if concurrent rotations finish
		// out of order.
		state.Credentials.Publish(credential)
		w.WriteHeader(http.StatusNoContent)
	}
}

// AdminSystemInfo reports service, database, and runtime status.
func AdminSystemInfo(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		_, err := state.DB.ExecContext(r.Context(), "SELECT 1")
		databaseOK := err == nil

		var databaseAllocatedBytes *int64
		if databaseOK {
			var allocated int64
			err := state.DB.QueryRowContext(r.Context(),
				"SELECT (SELECT page_count FROM pragma_page_count()) * (SELECT page_size FROM pragma_page_size())").
				Scan(&allocated)
			if err == nil {
				databaseAllocatedBytes = &allocated
			}
		}

		logStats := state.LogStats.Snapshot()
		recentOneMinuteLogCount, err := db.RecentOneMinuteLogCount(r.Context(), state.DB)
		if err != nil {
			recentOneMinuteLogCount = 0
		}

		var enabledUpstreamCount, totalUpstreamCount int64
		if err := state.DB.QueryRowContext(r.Context(),
			"SELECT COALESCE(SUM(CASE WHEN enabled = 1 THEN 1 ELSE 0 END), 0), COUNT(*) FROM upstreams").
			Scan(&enabledUpstreamCount, &totalUpstreamCount); err != nil {
			// The page still renders, but the zeros it would otherwise show are
			// indistinguishable from having no channels at all.
			slog.Warn("could not count channels for the system info panel", "error", err)
		}

		settings := state.Runtime.Get()
		apperr.WriteJSON(w, http.StatusOK, models.SystemInfoOut{
			Service:                       "WildToken",
			Version:                       Version,
			DefaultUpstreamTimeoutSeconds: state.Settings.Upstream.DefaultTimeoutSeconds,
			UptimeSeconds:                 uint64(time.Since(state.StartedAt).Seconds()),
			CurrentServerTime:             time.Now().Format(time.RFC3339),
			DatabaseOK:                    databaseOK,
			DatabaseAllocatedBytes:        databaseAllocatedBytes,
			TotalLogCount:                 logStats.TotalLogCount,
			LogCount24h:                   logStats.LogCount24h,
			EnabledUpstreamCount:          enabledUpstreamCount,
			TotalUpstreamCount:            totalUpstreamCount,
			RecentOneMinuteLogCount:       recentOneMinuteLogCount,
			RuntimeLogSettings: models.RuntimeLogSettingsSummary{
				LogBodyKeepCount: settings.LogBodyKeepCount,
				LogRetentionDays: settings.LogRetentionDays,
				LogBodyMaxBytes:  settings.LogBodyMaxBytes,
				Revision:         settings.Revision,
			},
			RuntimeMetrics: runtimeMetricsOut(state.Metrics.Snapshot()),
		})
	}
}

// AdminRuntimeMetrics reports the in-process counters alone.
func AdminRuntimeMetrics(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		apperr.WriteJSON(w, http.StatusOK, runtimeMetricsOut(state.Metrics.Snapshot()))
	}
}

func runtimeMetricsOut(snapshot metrics.Snapshot) models.RuntimeMetricsOut {
	return models.RuntimeMetricsOut{
		ActiveSSEStreams:          snapshot.ActiveSSEStreams,
		SSECompletedTotal:         snapshot.SSECompletedTotal,
		SSEClientDisconnectsTotal: snapshot.SSEClientDisconnectsTotal,
		SSERecentDisconnects10m:   snapshot.SSERecentDisconnects10m,
		SSEUpstreamErrorsTotal:    snapshot.SSEUpstreamErrorsTotal,
		LogQueueDepth:             snapshot.LogQueueDepth,
		LogWrittenTotal:           snapshot.LogWrittenTotal,
		LogWriteBatchesTotal:      snapshot.LogWriteBatchesTotal,
		LogDroppedTotal:           snapshot.LogDroppedTotal,
		LogWriteFailuresTotal:     snapshot.LogWriteFailuresTotal,
		SlowDBOperationsTotal:     snapshot.SlowDBOperationsTotal,
		Cleanup: models.RuntimeCleanupMetricsOut{
			Active:                  snapshot.CleanupActive,
			RunsTotal:               snapshot.CleanupRunsTotal,
			ErrorsTotal:             snapshot.CleanupErrorsTotal,
			RowsClearedTotal:        snapshot.CleanupRowsClearedTotal,
			BatchesTotal:            snapshot.CleanupBatchesTotal,
			CurrentRowsCleared:      snapshot.CleanupCurrentRowsCleared,
			CurrentBatches:          snapshot.CleanupCurrentBatches,
			LastStartedUnixSeconds:  snapshot.CleanupLastStartedUnixSeconds,
			LastFinishedUnixSeconds: snapshot.CleanupLastFinishedUnixSeconds,
			LastDurationMs:          snapshot.CleanupLastDurationMs,
			LastRowsCleared:         snapshot.CleanupLastRowsCleared,
		},
	}
}

// AdminListTokens returns every downstream API token.
func AdminListTokens(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		tokens, err := db.ListTokens(r.Context(), state.DB)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, tokens)
	}
}

func AdminGetToken(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		token, found, err := db.GetToken(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("token not found"))
			return
		}
		apperr.WriteJSON(w, http.StatusOK, token)
	}
}

func AdminCreateToken(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		input := models.APITokenIn{Enabled: true}
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		created, err := db.CreateToken(r.Context(), state.DB, &input)
		if err != nil {
			if isUniqueViolation(err) {
				apperr.WriteError(w, apperr.BadRequest("token name or value already exists"))
				return
			}
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusCreated, created)
	}
}

func AdminUpdateToken(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		var input models.APITokenUpdateIn
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		if err := input.Validate(); err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		// UpdateToken reads the existing row to decide whether the expiry
		// changed, and reports NotFound itself, so no separate check is needed.
		updated, err := db.UpdateToken(r.Context(), state.DB, id, &input)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, updated)
	}
}

func AdminSetTokenEnabled(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		var input models.UpstreamEnabledIn
		if err := decodeJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}

		if _, found, err := db.GetToken(r.Context(), state.DB, id); err != nil {
			apperr.WriteError(w, err)
			return
		} else if !found {
			apperr.WriteError(w, apperr.NotFound("token not found"))
			return
		}

		updated, err := db.SetTokenEnabled(r.Context(), state.DB, id, input.Enabled)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, updated)
	}
}

// AdminResetTokenUsage clears a token's consumed total.
func AdminResetTokenUsage(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		updated, err := db.ResetTokenUsage(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, updated)
	}
}

func AdminDeleteToken(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		deleted, err := db.DeleteToken(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !deleted {
			apperr.WriteError(w, apperr.NotFound("token not found"))
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}
}

// AdminListLogs serves one page of request logs.
func AdminListLogs(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		limit := clampInt32(queryInt32(query.Get("limit"), 50), 1, 200)
		// SQLite reaches an OFFSET by scanning and discarding the rows before
		// it, so an unbounded one lets a single request walk the whole log
		// table and hold one of the few pooled connections for as long as that
		// takes. Deep pages are what the cursor endpoint is for.
		offset := clampInt32(queryInt32(query.Get("offset"), 0), 0, maxLogListOffset)

		filter := db.LogFilter{
			UpstreamID: optionalQueryInt64(query.Get("upstream_id")),
			Search:     optionalQueryString(query.Get("search")),
			ClientType: optionalQueryString(query.Get("client_type")),
		}
		if status := query.Get("status"); status == "2xx" || status == "4xx" ||
			status == "5xx" || status == "none" {
			filter.Status = &status
		}

		var cursor *db.LogCursor
		beforeCreatedAt := strings.TrimSpace(query.Get("before_created_at"))
		beforeID := optionalQueryInt64(query.Get("before_id"))
		if beforeCreatedAt != "" && beforeID != nil {
			cursor = &db.LogCursor{CreatedAt: beforeCreatedAt, ID: *beforeID}
		}

		// One extra row is requested, so the page knows whether more follow
		// without a second count query.
		items, err := db.ListLogs(r.Context(), state.DB, limit+1, offset, cursor, filter)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		hasMore := int32(len(items)) > limit
		if hasMore {
			items = items[:limit]
		}

		var nextCursor *models.RequestLogCursorOut
		if hasMore && len(items) > 0 {
			last := items[len(items)-1]
			nextCursor = &models.RequestLogCursorOut{CreatedAt: last.CreatedAt, ID: last.ID}
		}

		recentRate, err := db.RecentOneMinuteLogRate(r.Context(), state.DB)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		apperr.WriteJSON(w, http.StatusOK, models.RequestLogPage{
			Items:      items,
			HasMore:    hasMore,
			RecentRPM:  recentRate.RequestCount,
			RecentTPM:  recentRate.TotalTokens,
			NextCursor: nextCursor,
		})
	}
}

// AdminStreamLogs streams lightweight list-row events for request logs that
// have committed to SQLite.
//
// The endpoint intentionally does not replay historical rows. A disconnected or
// lagged client reloads the normal paginated endpoint, which remains the source
// of truth and keeps cursor pagination stable.
func AdminStreamLogs(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		auth, ok := middleware.AdminAuthFrom(r.Context())
		if !ok {
			apperr.WriteJSON(w, http.StatusUnauthorized, map[string]string{"error": "unauthorized"})
			return
		}
		flusher, canFlush := w.(http.Flusher)
		if !canFlush {
			apperr.WriteError(w, apperr.Internal("streaming is not supported"))
			return
		}

		events, unsubscribe := state.LogWriter.Subscribe()
		defer unsubscribe()

		w.Header().Set("content-type", "text/event-stream")
		w.Header().Set("cache-control", "no-store")
		w.Header().Set("connection", "keep-alive")
		w.WriteHeader(http.StatusOK)
		flusher.Flush()

		// A rotation invalidates this stream, so a revoked operator stops
		// receiving live logs without waiting for their connection to drop.
		authCheck := time.NewTicker(15 * time.Second)
		defer authCheck.Stop()

		for {
			select {
			case <-r.Context().Done():
				return

			case event, open := <-events:
				if !open {
					return
				}
				if state.Credentials.Version() != auth.CredentialVersion {
					return
				}
				encoded, err := json.Marshal(event)
				if err != nil {
					encoded = fmt.Appendf(nil, `{"log":{"id":%d}}`, event.Log.ID)
				}
				fmt.Fprintf(w, "event: log\nid: %d\ndata: %s\n\n", event.Log.ID, encoded)
				flusher.Flush()

			case <-authCheck.C:
				if state.Credentials.Version() != auth.CredentialVersion {
					return
				}
				// A comment frame keeps intermediaries from closing an idle
				// connection.
				fmt.Fprint(w, ": keepalive\n\n")
				flusher.Flush()
			}
		}
	}
}

// AdminTokenUsageStats reports the cached token usage windows.
func AdminTokenUsageStats(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		apperr.WriteJSON(w, http.StatusOK, state.LogStats.Snapshot().TokenUsage)
	}
}

// AdminTopLogStats ranks models and channels over a window.
func AdminTopLogStats(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		windowValue := strings.TrimSpace(r.URL.Query().Get("window"))
		if windowValue == "" {
			windowValue = "today"
		}
		window, ok := db.ParseLogTopWindow(windowValue)
		if !ok {
			apperr.WriteError(w, apperr.BadRequest(
				"window must be one of: today, 1d, 3d, 7d, 30d"))
			return
		}
		limit := clampInt64(queryInt64(r.URL.Query().Get("limit"), 10), 1, 20)

		stats, err := db.TopLogStats(r.Context(), state.DB, window, limit)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, stats)
	}
}

// AdminGetLogDetail returns one log with its captured payloads.
func AdminGetLogDetail(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		id, err := pathID(r)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		detail, found, err := db.GetLogDetail(r.Context(), state.DB, id)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		if !found {
			apperr.WriteError(w, apperr.NotFound("request log not found"))
			return
		}
		apperr.WriteJSON(w, http.StatusOK, detail)
	}
}

func queryInt32(value string, fallback int32) int32 {
	parsed, err := strconv.ParseInt(value, 10, 32)
	if err != nil {
		return fallback
	}
	return int32(parsed)
}

func queryInt64(value string, fallback int64) int64 {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return fallback
	}
	return parsed
}

func optionalQueryInt64(value string) *int64 {
	parsed, err := strconv.ParseInt(value, 10, 64)
	if err != nil {
		return nil
	}
	return &parsed
}

func optionalQueryString(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

func clampInt32(value, low, high int32) int32 { return min(max(value, low), high) }

func clampInt64(value, low, high int64) int64 { return min(max(value, low), high) }
