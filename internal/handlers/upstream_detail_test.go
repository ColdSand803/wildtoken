package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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
)

func upstreamTestState(t *testing.T) *appstate.State {
	t.Helper()
	database, err := sql.Open("sqlite", "file:"+t.Name()+"?mode=memory&cache=shared")
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
		StartedAt:   time.Now(),
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

func itoa(value int64) string {
	return string([]byte{byte('0' + value)})
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
