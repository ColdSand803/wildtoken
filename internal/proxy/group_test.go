package proxy

import (
	"context"
	"database/sql"
	"testing"

	_ "modernc.org/sqlite"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// joinGroup puts a channel in a group, replacing the default membership the
// schema backfilled.
func joinGroup(t *testing.T, database *sql.DB, upstreamName string, groupIDs ...int64) {
	t.Helper()
	var upstreamID int64
	if err := database.QueryRow(
		"SELECT id FROM upstreams WHERE name = ?", upstreamName).Scan(&upstreamID); err != nil {
		t.Fatalf("look up %s: %v", upstreamName, err)
	}
	if _, err := database.Exec(
		"DELETE FROM upstream_groups WHERE upstream_id = ?", upstreamID); err != nil {
		t.Fatalf("clear membership: %v", err)
	}
	for _, groupID := range groupIDs {
		if _, err := database.Exec(
			"INSERT INTO upstream_groups (upstream_id, group_id) VALUES (?, ?)",
			upstreamID, groupID); err != nil {
			t.Fatalf("join group %d: %v", groupID, err)
		}
	}
}

func createGroup(t *testing.T, database *sql.DB, name string) int64 {
	t.Helper()
	result, err := database.Exec("INSERT INTO groups (name) VALUES (?)", name)
	if err != nil {
		t.Fatalf("create group %s: %v", name, err)
	}
	id, err := result.LastInsertId()
	if err != nil {
		t.Fatalf("group id: %v", err)
	}
	return id
}

func selectInGroup(t *testing.T, database *sql.DB, groupID int64, model string) *Selection {
	t.Helper()
	selection, err := SelectUpstream(context.Background(), database, NewRoutingCache(),
		NewAutoWeightManager(), testPolicy(), nil, &model, groupID, nil)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	return selection
}

func TestATokenOnlyReachesItsOwnGroupsChannels(t *testing.T) {
	database := testDB(t)
	teamID := createGroup(t, database, "team-a")

	insertUpstream(t, database, "shared-model-default", []string{"shared"}, 100, 100, true)
	insertUpstream(t, database, "shared-model-team", []string{"shared"}, 100, 100, true)
	joinGroup(t, database, "shared-model-default", models.DefaultGroupID)
	joinGroup(t, database, "shared-model-team", teamID)

	// The same model exists in both groups, so only membership can decide.
	if selection := selectInGroup(t, database, models.DefaultGroupID, "shared"); selection == nil ||
		selection.Upstream.Name != "shared-model-default" {
		t.Fatalf("default group selected %+v, want its own channel", selection)
	}
	if selection := selectInGroup(t, database, teamID, "shared"); selection == nil ||
		selection.Upstream.Name != "shared-model-team" {
		t.Fatalf("team group selected %+v, want its own channel", selection)
	}
}

func TestAModelServedOnlyByAnotherGroupIsUnroutable(t *testing.T) {
	database := testDB(t)
	teamID := createGroup(t, database, "team-a")

	insertUpstream(t, database, "team-only", []string{"exclusive-model"}, 100, 100, true)
	joinGroup(t, database, "team-only", teamID)

	// Strict isolation: the default group gets no route rather than falling back.
	if selection := selectInGroup(t, database, models.DefaultGroupID,
		"exclusive-model"); selection != nil {
		t.Errorf("isolation leaked: default group reached %q", selection.Upstream.Name)
	}
	if selection := selectInGroup(t, database, teamID, "exclusive-model"); selection == nil {
		t.Error("the owning group could not reach its own channel")
	}
}

func TestAChannelCanServeSeveralGroups(t *testing.T) {
	database := testDB(t)
	teamID := createGroup(t, database, "team-a")

	insertUpstream(t, database, "multi-group", []string{"shared"}, 100, 100, true)
	joinGroup(t, database, "multi-group", models.DefaultGroupID, teamID)

	for _, groupID := range []int64{models.DefaultGroupID, teamID} {
		if selection := selectInGroup(t, database, groupID, "shared"); selection == nil ||
			selection.Upstream.Name != "multi-group" {
			t.Errorf("group %d selected %+v, want the shared channel", groupID, selection)
		}
	}
}

func TestAnExplicitChannelSelectorCannotEscapeTheGroup(t *testing.T) {
	database := testDB(t)
	teamID := createGroup(t, database, "team-a")

	insertUpstream(t, database, "team-only", []string{"model"}, 100, 100, true)
	joinGroup(t, database, "team-only", teamID)

	// A selector is a routing hint, not a way around isolation.
	for _, selector := range []string{"team-only", "1"} {
		selection, err := SelectUpstream(context.Background(), database, NewRoutingCache(),
			NewAutoWeightManager(), testPolicy(), &selector, ptr("model"),
			models.DefaultGroupID, nil)
		if err != nil {
			t.Fatalf("select: %v", err)
		}
		if selection != nil {
			t.Errorf("selector %q escaped the group into %q", selector, selection.Upstream.Name)
		}
	}

	// The owning group still routes through the same selector.
	selector := "team-only"
	selection, err := SelectUpstream(context.Background(), database, NewRoutingCache(),
		NewAutoWeightManager(), testPolicy(), &selector, ptr("model"), teamID, nil)
	if err != nil {
		t.Fatalf("select: %v", err)
	}
	if selection == nil {
		t.Error("the owning group could not use the selector")
	}
}

func TestExistingChannelsAreBackfilledIntoTheDefaultGroup(t *testing.T) {
	database := testDB(t)

	// Insert a channel the way a pre-groups database would have, with no
	// membership row, then re-run the schema migration.
	if _, err := database.Exec(`INSERT INTO upstreams
        (name, base_url, model_names, model_prefixes, model_mappings,
         priority, weight, auto_weight_enabled, enabled, extra_headers, timeout_seconds)
        VALUES ('legacy', 'https://example.test', '["legacy-model"]', '[]', '{}',
                100, 100, 1, 1, '{}', 300.0)`); err != nil {
		t.Fatalf("insert legacy channel: %v", err)
	}
	if _, err := database.Exec("DELETE FROM upstream_groups"); err != nil {
		t.Fatalf("clear membership: %v", err)
	}
	if err := db.Init(context.Background(), database); err != nil {
		t.Fatalf("re-run migration: %v", err)
	}

	// An upgraded database routes exactly as it did before groups existed.
	if selection := selectInGroup(t, database, models.DefaultGroupID,
		"legacy-model"); selection == nil {
		t.Error("a pre-groups channel was not reachable from the default group")
	}
}

func TestDeletingAGroupMovesItsTokensToTheDefault(t *testing.T) {
	database := testDB(t)
	ctx := context.Background()
	teamID := createGroup(t, database, "team-a")

	digest := db.TokenDigest("group-token-value")
	if _, err := database.Exec(`INSERT INTO api_tokens
        (name, token, token_hash, token_preview, group_id) VALUES ('scoped', ?, ?, '…', ?)`,
		digest, digest, teamID); err != nil {
		t.Fatalf("insert token: %v", err)
	}

	deleted, err := db.DeleteGroup(ctx, database, teamID)
	if err != nil || !deleted {
		t.Fatalf("delete group: %v (deleted=%v)", err, deleted)
	}

	// A token pointing at a deleted group would reach no channel at all, which
	// reads as a routing bug, so it moves to the default group instead.
	var groupID int64
	if err := database.QueryRow(
		"SELECT group_id FROM api_tokens WHERE name = 'scoped'").Scan(&groupID); err != nil {
		t.Fatalf("read token group: %v", err)
	}
	if groupID != models.DefaultGroupID {
		t.Errorf("token group = %d, want the default group", groupID)
	}

	// The default group itself is protected.
	if _, err := db.DeleteGroup(ctx, database, models.DefaultGroupID); err == nil {
		t.Error("the default group was deleted")
	}
}
