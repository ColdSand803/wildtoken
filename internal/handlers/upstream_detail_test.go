package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/go-chi/chi/v5"
	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/config"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/metrics"
	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/proxy"
	"github.com/liguangsheng/wildtoken/internal/quota"
)

func upstreamTestState(t *testing.T) *appstate.State {
	t.Helper()
	return namedTestState(t, "")
}

// namedTestState is upstreamTestState with the database name qualified, so one test
// can hold two independent instances at once.
//
// The name is part of the shared-cache URI: two states built from the same name are
// the same database, which silently turns a migration test into an instance
// importing its own configuration.
func namedTestState(t *testing.T, instance string) *appstate.State {
	t.Helper()
	name := t.Name()
	if instance != "" {
		name += "-" + instance
	}
	database, err := sql.Open("sqlite", "file:"+name+"?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	database.SetMaxOpenConns(1)
	t.Cleanup(func() { database.Close() })
	if err := db.Init(context.Background(), database); err != nil {
		t.Fatalf("init: %v", err)
	}

	settings := config.Default()
	return &appstate.State{
		DB:          database,
		Settings:    settings,
		AutoWeight:  proxy.NewAutoWeightManager(),
		Runtime:     appstate.NewSettingsStore(models.DefaultRuntimeSettings()),
		Metrics:     metrics.New(),
		ModelsCache: appstate.NewModelsListCache(),
		Routing:     proxy.NewRoutingCache(),
		Quotas:      quota.NewTracker(),
		ProbeRuns:   appstate.NewProbeRunState(),
		// Wired because the server does (internal/app/server.go): the token-usage
		// endpoint reads this snapshot before it looks at any request, so a nil
		// cache here is a panic rather than an empty result.
		LogStats: db.NewLogStatsCache(),
		// Wired because the server does: applyRuntimeHealth publishes the scrape
		// gauge from the channel-list path, so a state without it would only stay
		// safe on the nil-receiver guard rather than exercising what production runs.
		Prometheus: metrics.NewPrometheus(),
		StartedAt:  time.Now(),
	}
}

// getUpstreamDetail runs the detail handler the console's edit form reads.
func getUpstreamDetail(t *testing.T, state *appstate.State, id int64) models.UpstreamDetailOut {
	t.Helper()
	router := chi.NewRouter()
	router.Get("/api/admin/upstreams/{id}", AdminGetUpstream(state))

	request := httptest.NewRequest(http.MethodGet,
		"/api/admin/upstreams/"+itoa(id), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	if recorder.Code != http.StatusOK {
		t.Fatalf("detail returned %d: %s", recorder.Code, recorder.Body.String())
	}
	var detail models.UpstreamDetailOut
	if err := json.Unmarshal(recorder.Body.Bytes(), &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	return detail
}

// itoa renders an integer for a test URL or JSON body.
//
// This was `string([]byte{byte('0' + value)})`, which is correct only for 0-9 and
// silently emits a garbage byte past that rather than failing — a body built with
// it parsed as malformed JSON, and the test it broke reported a missing value
// rather than a bad fixture.
func itoa(value int64) string {
	return strconv.FormatInt(value, 10)
}

// TestTheDetailResponseCarriesTheChannelsGroups guards the regression that made
// editing a channel silently drop its groups: the edit form fills itself from
// this response, and an absent membership list reads as "no groups", which the
// form renders as default only.
func TestTheDetailResponseCarriesTheChannelsGroups(t *testing.T) {
	state := upstreamTestState(t)
	ctx := context.Background()

	teamID, err := db.CreateGroup(ctx, state.DB, &models.GroupIn{Name: "team-a"})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}

	input := models.DefaultUpstreamIn()
	input.Name = "multi"
	input.BaseURL = "https://example.test"
	input.GroupIDs = []int64{models.DefaultGroupID, teamID.ID}
	created, err := db.CreateUpstream(ctx, state.DB, &input,
		state.Settings.Upstream.DefaultTimeoutSeconds)
	if err != nil {
		t.Fatalf("create upstream: %v", err)
	}

	detail := getUpstreamDetail(t, state, created.ID)
	if len(detail.GroupIDs) != 2 {
		t.Fatalf("detail group_ids = %v, want both groups", detail.GroupIDs)
	}

	// The list and the detail must agree, or the console shows one thing and
	// saves another.
	listed, err := db.ListUpstreams(ctx, state.DB)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	var listedIDs []int64
	for _, upstream := range listed {
		if upstream.ID == created.ID {
			listedIDs = upstream.GroupIDs
		}
	}
	if len(listedIDs) != len(detail.GroupIDs) {
		t.Fatalf("list %v and detail %v disagree", listedIDs, detail.GroupIDs)
	}
	for i := range listedIDs {
		if listedIDs[i] != detail.GroupIDs[i] {
			t.Errorf("list %v and detail %v disagree", listedIDs, detail.GroupIDs)
		}
	}
}

// TestASingleGroupChannelKeepsItAfterAnEditRoundTrip walks the path the operator
// took: open the form, change nothing about groups, save.
func TestASingleGroupChannelKeepsItAfterAnEditRoundTrip(t *testing.T) {
	state := upstreamTestState(t)
	ctx := context.Background()

	group, err := db.CreateGroup(ctx, state.DB, &models.GroupIn{Name: "free"})
	if err != nil {
		t.Fatalf("create group: %v", err)
	}

	input := models.DefaultUpstreamIn()
	input.Name = "scoped"
	input.BaseURL = "https://example.test"
	input.GroupIDs = []int64{group.ID}
	created, err := db.CreateUpstream(ctx, state.DB, &input,
		state.Settings.Upstream.DefaultTimeoutSeconds)
	if err != nil {
		t.Fatalf("create upstream: %v", err)
	}

	// The form is filled from the detail response.
	detail := getUpstreamDetail(t, state, created.ID)
	if len(detail.GroupIDs) != 1 || detail.GroupIDs[0] != group.ID {
		t.Fatalf("detail group_ids = %v, want [%d]", detail.GroupIDs, group.ID)
	}

	// Saving it back unchanged must not move the channel into default.
	update := models.UpstreamUpdate{UpstreamIn: models.DefaultUpstreamIn()}
	update.Name = detail.Name
	update.BaseURL = detail.BaseURL
	update.GroupIDs = detail.GroupIDs
	saved, err := db.UpdateUpstream(ctx, state.DB, created.ID, &update)
	if err != nil {
		t.Fatalf("update: %v", err)
	}
	if len(saved.GroupIDs) != 1 || saved.GroupIDs[0] != group.ID {
		t.Errorf("after save group_ids = %v, want [%d]", saved.GroupIDs, group.ID)
	}
}

// TestAChannelInNoGroupReportsAnEmptyListNotNull keeps the console able to tell
// "no groups" apart from "the field is missing".
func TestAChannelInNoGroupReportsAnEmptyListNotNull(t *testing.T) {
	state := upstreamTestState(t)
	ctx := context.Background()

	input := models.DefaultUpstreamIn()
	input.Name = "bare"
	input.BaseURL = "https://example.test"
	created, err := db.CreateUpstream(ctx, state.DB, &input,
		state.Settings.Upstream.DefaultTimeoutSeconds)
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	// An empty selection falls back to the default group at the store, so clear
	// membership directly to reach the bare case.
	if _, err := state.DB.Exec(
		"DELETE FROM upstream_groups WHERE upstream_id = ?", created.ID); err != nil {
		t.Fatalf("clear membership: %v", err)
	}

	router := chi.NewRouter()
	router.Get("/api/admin/upstreams/{id}", AdminGetUpstream(state))
	request := httptest.NewRequest(http.MethodGet,
		"/api/admin/upstreams/"+itoa(created.ID), nil)
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, request)

	var raw map[string]json.RawMessage
	if err := json.Unmarshal(recorder.Body.Bytes(), &raw); err != nil {
		t.Fatalf("decode: %v", err)
	}
	if string(raw["group_ids"]) != "[]" {
		t.Errorf("group_ids = %s, want []", raw["group_ids"])
	}
}

func TestTogglingAChannelRefusesABodyThatNamesNothing(t *testing.T) {
	state := upstreamTestState(t)
	input := models.DefaultUpstreamIn()
	input.Name = "primary"
	input.BaseURL = "https://api.example.com"
	created, err := db.CreateUpstream(context.Background(), state.DB, &input, 300)
	if err != nil {
		t.Fatalf("create: %v", err)
	}

	router := chi.NewRouter()
	router.Patch("/api/admin/upstreams/{id}/enabled", AdminSetUpstreamEnabled(state))

	patch := func(body string) int {
		request := httptest.NewRequest(http.MethodPatch,
			"/api/admin/upstreams/"+itoa(created.ID)+"/enabled", strings.NewReader(body))
		recorder := httptest.NewRecorder()
		router.ServeHTTP(recorder, request)
		return recorder.Code
	}

	// The field is not a pointer, so an absent one reads as false. Decoding
	// loosely turned an empty body and a misspelled key into "disable this
	// channel", with nothing reported to the caller who meant the opposite.
	if status := patch(`{}`); status != http.StatusBadRequest {
		t.Errorf("an empty body got %d, want 400", status)
	}
	if status := patch(`{"enable":true}`); status != http.StatusBadRequest {
		t.Errorf("a misspelled field got %d, want 400", status)
	}

	row, found, reloadErr := db.GetUpstream(context.Background(), state.DB, created.ID)
	if reloadErr != nil || !found {
		t.Fatalf("reload: %v", reloadErr)
	}
	if row.Enabled != 1 {
		t.Error("a refused request disabled the channel anyway")
	}

	if status := patch(`{"enabled":false}`); status != http.StatusOK {
		t.Fatalf("a well-formed request got %d, want 200", status)
	}
}
