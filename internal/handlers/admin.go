package handlers

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/authstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/middleware"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
	"github.com/liguangsheng/wildtoken/internal/themes"
)

// Version is the service version reported by the system endpoint.
//
// The release workflow parses this line to check that a tag matches, so its
// shape must stay `const Version = "..."`.
const Version = "0.2.1"

// maxLogListOffset caps how deep the offset-paged log list may reach.
const maxLogListOffset int32 = 100_000

// maxLogSearchChars caps a log search term.
const maxLogSearchChars = 200

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
			RuntimeMetrics:  runtimeMetricsOut(state.Metrics.Snapshot()),
			MetricsEndpoint: metricsEndpointStatus(state),
		})
	}
}

// metricsEndpointStatus reports the scrape endpoint's access policy.
//
// Read from the startup configuration rather than the runtime settings row,
// because that is where it lives: exposing the endpoint is a deployment decision
// (it changes what the listener answers), not a policy the console can edit. The
// console renders this read-only for that reason.
func metricsEndpointStatus(state *appstate.State) models.MetricsEndpointStatusOut {
	metricsSettings := state.Settings.Metrics
	return models.MetricsEndpointStatusOut{
		Enabled: metricsSettings.Enabled,
		Path:    "/metrics",
		// Derived from the configuration rather than reported as the token itself:
		// what the console needs to show is whether the endpoint is guarded, and an
		// enabled endpoint with no token is the case worth surfacing.
		TokenRequired:    strings.TrimSpace(metricsSettings.Token) != "",
		ConfiguredByFile: true,
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
		var input models.TokenEnabledIn
		if err := decodeStrictJSON(w, r, &input); err != nil {
			apperr.WriteError(w, err)
			return
		}
		enabled, err := input.Value()
		if err != nil {
			apperr.WriteError(w, apperr.BadRequest(err.Error()))
			return
		}

		if _, found, err := db.GetToken(r.Context(), state.DB, id); err != nil {
			apperr.WriteError(w, err)
			return
		} else if !found {
			apperr.WriteError(w, apperr.NotFound("token not found"))
			return
		}

		updated, err := db.SetTokenEnabled(r.Context(), state.DB, id, enabled)
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

		filter, err := parseLogFilter(query)
		if err != nil {
			apperr.WriteError(w, err)
			return
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

		// The live stream takes the same filters as the paginated list, so a
		// filtered console view does not receive events it would never show.
		filter, err := parseLogFilter(r.URL.Query())
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		filter = openEndedForLiveStream(filter, time.Now())

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
				if !filter.Matches(event.Log) {
					continue
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

const dashboardDateLayout = "2006-01-02"

type dashboardRangeSelection struct {
	Value   string
	Label   string
	Window  db.LogTopWindow
	StartAt string
	EndAt   string
}

func parseDashboardRange(value, startValue, endValue, fallback string) (dashboardRangeSelection, error) {
	value = strings.TrimSpace(value)
	if value == "" {
		value = fallback
	}
	window, ok := db.ParseLogTopWindow(value)
	if !ok {
		return dashboardRangeSelection{}, apperr.BadRequest(
			"range must be one of: today, 1d, 3d, 7d, 30d, all, default, custom")
	}

	selection := dashboardRangeSelection{Value: value, Window: window}
	switch value {
	case "today":
		selection.Label = "今天"
	case "1d":
		selection.Label = "最近 24 小时"
	case "3d":
		selection.Label = "最近 3 天"
	case "7d":
		selection.Label = "最近 7 天"
	case "30d":
		selection.Label = "最近 30 天"
	case "all":
		selection.Label = "全部时间"
	case "default":
		selection.Label = "所有窗口"
	case "custom":
		startValue = strings.TrimSpace(startValue)
		endValue = strings.TrimSpace(endValue)
		if startValue == "" || endValue == "" {
			return dashboardRangeSelection{}, apperr.BadRequest(
				"start_date and end_date are required when range is custom")
		}
		startDate, startErr := time.ParseInLocation(dashboardDateLayout, startValue, time.Local)
		endDate, endErr := time.ParseInLocation(dashboardDateLayout, endValue, time.Local)
		if startErr != nil || endErr != nil {
			return dashboardRangeSelection{}, apperr.BadRequest(
				"start_date and end_date must use YYYY-MM-DD")
		}
		if startDate.After(endDate) {
			return dashboardRangeSelection{}, apperr.BadRequest(
				"start_date must not be after end_date")
		}
		if endDate.After(startDate.AddDate(0, 0, 365)) {
			return dashboardRangeSelection{}, apperr.BadRequest(
				"custom date range must not exceed 366 days")
		}
		selection.Label = startValue + " 至 " + endValue
		selection.StartAt = startDate.UTC().Format(models.TimestampFormat)
		selection.EndAt = endDate.AddDate(0, 0, 1).UTC().Format(models.TimestampFormat)
	}
	return selection, nil
}

// resolvedRange reports the concrete [start, end) the selection covers, as
// RFC3339 UTC, for the console to carry into a log drill-down.
//
// Presets are resolved against now; a custom range already parsed its own
// bounds and only needs reshaping. "全部时间" has no bounds and returns nils,
// which the drill-down reads as "do not filter by time".
func (s dashboardRangeSelection) resolvedRange(now time.Time) (*string, *string) {
	var start, end time.Time
	if s.Window == db.LogTopWindowCustom {
		var startErr, endErr error
		start, startErr = time.Parse(models.TimestampFormat, s.StartAt)
		end, endErr = time.Parse(models.TimestampFormat, s.EndAt)
		if startErr != nil || endErr != nil {
			return nil, nil
		}
	} else {
		var ok bool
		start, end, ok = db.ResolveWindowRange(s.Window, now)
		if !ok {
			return nil, nil
		}
	}
	startValue := start.UTC().Format(time.RFC3339)
	endValue := end.UTC().Format(time.RFC3339)
	return &startValue, &endValue
}

// AdminTokenUsageStats reports token usage for the selected dashboard range.
func AdminTokenUsageStats(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		selection, err := parseDashboardRange(
			query.Get("range"), query.Get("start_date"), query.Get("end_date"), "default")
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		stats := state.LogStats.Snapshot().TokenUsage
		if selection.Value == "default" {
			apperr.WriteJSON(w, http.StatusOK, stats)
			return
		}

		var usage models.TokenUsageWindowOut
		switch selection.Window {
		case db.LogTopWindowToday:
			usage = stats.Today
		case db.LogTopWindowOneDay:
			usage = stats.OneDay
		case db.LogTopWindowSevenDays:
			usage = stats.SevenDays
		case db.LogTopWindowThirtyDays:
			usage = stats.ThirtyDays
		case db.LogTopWindowAll:
			usage = stats.AllTime
		default:
			usage, err = db.QueryTokenUsage(r.Context(), state.DB, selection.Window,
				selection.StartAt, selection.EndAt)
			if err != nil {
				apperr.WriteError(w, err)
				return
			}
		}

		stats.Today = usage
		stats.Range = selection.Value
		stats.RangeLabel = selection.Label
		apperr.WriteJSON(w, http.StatusOK, stats)
	}
}

// AdminLogOverview returns range-scoped dashboard aggregates: request and
// error totals, status buckets, latency stats, and a time-bucketed latency
// series. The dashboard's KPI cards and charts read this instead of doing
// client-side math over whatever logs happen to be loaded.
func AdminLogOverview(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		selection, err := parseDashboardRange(
			query.Get("range"), query.Get("start_date"), query.Get("end_date"), "today")
		if err != nil {
			apperr.WriteError(w, err)
			return
		}

		overview, err := db.LogOverview(r.Context(), state.DB,
			selection.Window, selection.StartAt, selection.EndAt)
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		overview.Range = selection.Value
		overview.RangeLabel = selection.Label
		overview.ResolvedStart, overview.ResolvedEnd = selection.resolvedRange(time.Now())
		apperr.WriteJSON(w, http.StatusOK, overview)
	}
}

// AdminTopLogStats ranks models and channels over a window.
func AdminTopLogStats(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		query := r.URL.Query()
		selection, err := parseDashboardRange(
			query.Get("window"), query.Get("start_date"), query.Get("end_date"), "today")
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		limit := clampInt64(queryInt64(query.Get("limit"), 10), 1, 20)

		var stats models.RequestLogTopStatsOut
		if selection.Window == db.LogTopWindowCustom {
			stats, err = db.TopLogStatsCustom(r.Context(), state.DB,
				selection.StartAt, selection.EndAt, limit)
		} else {
			stats, err = db.TopLogStats(r.Context(), state.DB, selection.Window, limit)
		}
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

// AdminUpstreamHealthHistory reports per-channel hourly success rate and
// latency over the trailing hours (default 24), for the channel cards' mini
// health trend.
//
// Console probes are excluded: this card answers "how is the channel serving
// real traffic", and a probe an operator just fired is not that.
func AdminUpstreamHealthHistory(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		hours := clampInt64(queryInt64(r.URL.Query().Get("hours"), 24), 1, 24*7)
		health, err := db.UpstreamHealthHistory(r.Context(), state.DB, hours, probeClientTypes())
		if err != nil {
			apperr.WriteError(w, err)
			return
		}
		apperr.WriteJSON(w, http.StatusOK, map[string]any{
			"hours":   hours,
			"entries": health,
		})
	}
}

// AdminUpstreamsRouting reports the effective load-balance strategy, the rules
// behind it, and each channel's current routing latency.
//
// Separate from AdminListUpstreams because that endpoint answers with a bare JSON
// array: there is no envelope to add these fields to, and giving it one would
// break every existing caller. Separate from the dashboard's latency charts
// because those scan request_logs, while this reads the in-memory samples routing
// actually decided on.
func AdminUpstreamsRouting(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		settings := state.Runtime.Get()
		readings := state.Latency.ReadAll()

		latency := make([]models.UpstreamLatencyOut, 0, len(readings))
		for upstreamID, reading := range readings {
			entry := models.UpstreamLatencyOut{
				UpstreamID:  upstreamID,
				SampleCount: reading.SampleCount,
				Usable:      reading.Usable,
			}
			// Left null below the minimum: a median of two samples is a number the
			// console would have to explain away, and routing did not use it.
			if reading.Usable {
				median := reading.MedianMs
				entry.MedianMs = &median
			}
			latency = append(latency, entry)
		}
		// Ordered so the response is stable between polls; a map's order is not.
		sort.Slice(latency, func(i, j int) bool {
			return latency[i].UpstreamID < latency[j].UpstreamID
		})

		apperr.WriteJSON(w, http.StatusOK, models.UpstreamRoutingOut{
			Strategy:      settings.LoadBalanceStrategy,
			LatencyActive: settings.LoadBalanceStrategy == models.LoadBalanceLeastLatency,
			Rules: models.RoutingRulesOut{
				MinSamples:         proxy.LatencyMinSamples,
				StaleWindowSeconds: int64(proxy.LatencyStaleWindow.Seconds()),
				SampleCapacity:     proxy.LatencySampleCapacity,
				ToleranceRatio:     proxy.LatencyToleranceRatio,
				ToleranceFloorMs:   proxy.LatencyToleranceFloorMs,
			},
			Latency: latency,
		})
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

// maxLogRangeDays bounds an explicit log range, matching the dashboard's own
// custom-range ceiling so a drill-down can always carry the window it came from.
const maxLogRangeDays = 366

// parseLogFilter builds the filter shared by the paginated list and the live
// stream.
//
// Both endpoints must agree on what the operator asked for — a console showing a
// filtered history while receiving unfiltered live events was the bug this
// contract exists to prevent — so they read their parameters here rather than
// each keeping their own copy of the parsing.
func parseLogFilter(query url.Values) (db.LogFilter, error) {
	filter := db.LogFilter{
		UpstreamID:        optionalQueryInt64(query.Get("upstream_id")),
		DownstreamTokenID: optionalQueryInt64(query.Get("downstream_token_id")),
		// The search term becomes eight LIKE patterns evaluated against every
		// row the query examines, so its length is a multiplier on the cost of
		// the whole scan. Nothing an operator types to find a request is longer
		// than this.
		Search:     boundedQueryString(query.Get("search"), maxLogSearchChars),
		ClientType: boundedQueryString(query.Get("client_type"), maxLogSearchChars),
	}

	if rawStatus, present := query["status"]; present && len(rawStatus) > 0 {
		status := strings.TrimSpace(rawStatus[0])
		if !db.ValidLogStatus(status) {
			return db.LogFilter{}, apperr.BadRequest(
				"status must be one of: 2xx, 4xx, 5xx, other, none, error")
		}
		filter.Status = &status
	}

	start, end, err := parseLogRange(query.Get("start"), query.Get("end"))
	if err != nil {
		return db.LogFilter{}, err
	}
	filter.Start, filter.End = start, end

	if raw := strings.TrimSpace(query.Get("stream")); raw != "" {
		value, err := strconv.ParseBool(raw)
		if err != nil {
			return db.LogFilter{}, apperr.BadRequest("stream must be true or false")
		}
		filter.Stream = &value
	}

	// Unlike the older optional integers, an unparseable threshold is rejected
	// rather than dropped. Silently ignoring it would return the unfiltered page
	// under a UI that says a threshold is active — the operator would read "no
	// requests slower than this" off a list that was never filtered.
	if raw := strings.TrimSpace(query.Get("min_duration_ms")); raw != "" {
		value, err := strconv.ParseInt(raw, 10, 64)
		if err != nil || value < 0 {
			return db.LogFilter{}, apperr.BadRequest(
				"min_duration_ms must be a non-negative integer")
		}
		filter.MinDurationMs = &value
	}

	return filter, nil
}

// openEndedForLiveStream drops an upper bound that has not passed yet, for the
// live stream only.
//
// A dashboard preset like "最近 24 小时" resolves to an end of "now", and the
// console forwards that pair to both endpoints. Applied literally to a stream,
// that bound is in the past a second later, so every event after the connection
// is filtered out: the log view goes permanently quiet with no error to explain
// it. The window the operator picked means "up to now, ongoing", so the stream
// keeps the lower bound and lets the future through.
//
// A range whose end has already passed is a closed historical window, and that
// bound is kept — the stream then delivers nothing, which is the intended
// "paused" behaviour for a historical view rather than an accident.
//
// This lives here rather than in parseLogFilter because it is exactly the
// difference between the two endpoints: the list renders a fixed window, the
// stream renders what arrives next.
func openEndedForLiveStream(filter db.LogFilter, now time.Time) db.LogFilter {
	if filter.End == nil {
		return filter
	}
	// Both sides are the fixed-width UTC storage shape, so comparing as strings
	// compares as time.
	if *filter.End >= now.UTC().Format(models.TimestampFormat) {
		filter.End = nil
	}
	return filter
}

// parseLogRange validates the [start, end) pair and converts it to the UTC
// shape created_at stores.
//
// RFC3339 is what the browser can produce from a Date without hand-formatting,
// but created_at is 'YYYY-MM-DD HH:MM:SS' in UTC. Comparing the two forms
// directly is the failure worth guarding: SQLite would compare the strings
// happily and silently match nothing, so the offset is resolved and the literal
// reshaped here instead.
func parseLogRange(startValue, endValue string) (*string, *string, error) {
	startValue = strings.TrimSpace(startValue)
	endValue = strings.TrimSpace(endValue)
	if startValue == "" && endValue == "" {
		return nil, nil, nil
	}
	// A half-open range would quietly widen the view to everything on one side
	// of the bound, which is indistinguishable from a filter that failed to
	// apply. Requiring both makes the mistake visible.
	if startValue == "" || endValue == "" {
		return nil, nil, apperr.BadRequest("start and end must be provided together")
	}

	start, err := time.Parse(time.RFC3339, startValue)
	if err != nil {
		return nil, nil, apperr.BadRequest("start must be an RFC3339 timestamp")
	}
	end, err := time.Parse(time.RFC3339, endValue)
	if err != nil {
		return nil, nil, apperr.BadRequest("end must be an RFC3339 timestamp")
	}
	if !start.Before(end) {
		return nil, nil, apperr.BadRequest("start must be before end")
	}
	if end.Sub(start) > maxLogRangeDays*24*time.Hour {
		return nil, nil, apperr.BadRequest("log range must not exceed 366 days")
	}

	normalizedStart := start.UTC().Format(models.TimestampFormat)
	normalizedEnd := end.UTC().Format(models.TimestampFormat)
	return &normalizedStart, &normalizedEnd, nil
}

func optionalQueryString(value string) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	return &trimmed
}

// boundedQueryString is optionalQueryString with a ceiling on the length, for
// values that end up inside a query's cost rather than beside it.
func boundedQueryString(value string, maxChars int) *string {
	trimmed := strings.TrimSpace(value)
	if trimmed == "" {
		return nil
	}
	if utf8.RuneCountInString(trimmed) > maxChars {
		trimmed = truncateRunes(trimmed, maxChars)
	}
	return &trimmed
}

func clampInt32(value, low, high int32) int32 { return min(max(value, low), high) }

func clampInt64(value, low, high int64) int64 { return min(max(value, low), high) }

// upstreamSparklinePoint is one 30-minute request-count bucket.
type upstreamSparklinePoint struct {
	Bucket string `json:"bucket"`
	Count  int64  `json:"count"`
}

// upstreamChannelStats is the per-channel block of the bulk stats response.
type upstreamChannelStats struct {
	Sparkline      []upstreamSparklinePoint `json:"sparkline"`
	TotalRequests  int64                    `json:"totalRequests"`
	CacheHitRate   float64                  `json:"cacheHitRate"`
	AvgTokensPer1M float64                  `json:"avgTokensPer1M"`
}

// AdminGetUpstreamsStats returns card statistics for every channel in one
// response, keyed by upstream id. One request replaces the per-channel
// endpoint the card view used before: with N channels that meant N HTTP
// round trips and 4N queries firing together every time the console's stats
// cache expired.
func AdminGetUpstreamsStats(state *appstate.State) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		stats := map[string]*upstreamChannelStats{}
		channel := func(id int64) *upstreamChannelStats {
			key := strconv.FormatInt(id, 10)
			entry, ok := stats[key]
			if !ok {
				entry = &upstreamChannelStats{Sparkline: []upstreamSparklinePoint{}}
				stats[key] = entry
			}
			return entry
		}

		// 6-hour sparkline: 30-minute buckets, grouped per channel.
		sixHoursAgo := time.Now().Add(-6 * time.Hour)
		rows, err := state.DB.QueryContext(r.Context(), `
			SELECT
				upstream_id,
				strftime('%Y-%m-%d %H:%M:00', created_at,
					'-' || (strftime('%M', created_at) % 30) || ' minutes') AS bucket,
				COUNT(*) AS count
			FROM request_logs
			WHERE upstream_id IS NOT NULL AND created_at >= datetime(?, 'unixepoch')
			GROUP BY upstream_id, bucket
			ORDER BY upstream_id, bucket ASC
		`, sixHoursAgo.Unix())
		if err != nil {
			apperr.WriteError(w, apperr.Internal("failed to fetch sparkline data"))
			return
		}
		defer rows.Close()
		for rows.Next() {
			var upstreamID int64
			var point upstreamSparklinePoint
			if err := rows.Scan(&upstreamID, &point.Bucket, &point.Count); err != nil {
				apperr.WriteError(w, apperr.Internal("failed to scan sparkline row"))
				return
			}
			entry := channel(upstreamID)
			entry.Sparkline = append(entry.Sparkline, point)
		}
		if err := rows.Err(); err != nil {
			apperr.WriteError(w, apperr.Internal("failed to read sparkline data"))
			return
		}

		// Lifetime totals per channel: request count, cache hit rate over
		// prompt tokens, and average tokens per thousand requests (the
		// cost proxy — no pricing data is stored anywhere in this project).
		totals, err := state.DB.QueryContext(r.Context(), `
			SELECT
				upstream_id,
				COUNT(*),
				COALESCE(SUM(prompt_cached_tokens), 0),
				COALESCE(SUM(prompt_tokens), 0),
				COALESCE(SUM(total_tokens), 0)
			FROM request_logs
			WHERE upstream_id IS NOT NULL
			GROUP BY upstream_id
		`)
		if err != nil {
			apperr.WriteError(w, apperr.Internal("failed to fetch channel totals"))
			return
		}
		defer totals.Close()
		for totals.Next() {
			var upstreamID, requests, cachedTokens, promptTokens, totalTokens int64
			if err := totals.Scan(&upstreamID, &requests, &cachedTokens, &promptTokens, &totalTokens); err != nil {
				apperr.WriteError(w, apperr.Internal("failed to scan channel totals"))
				return
			}
			entry := channel(upstreamID)
			entry.TotalRequests = requests
			if promptTokens > 0 {
				entry.CacheHitRate = float64(cachedTokens) / float64(promptTokens) * 100
			}
			if requests > 0 {
				entry.AvgTokensPer1M = float64(totalTokens) / float64(requests) * 1000
			}
		}
		if err := totals.Err(); err != nil {
			apperr.WriteError(w, apperr.Internal("failed to read channel totals"))
			return
		}

		apperr.WriteJSON(w, http.StatusOK, map[string]any{"stats": stats})
	}
}
