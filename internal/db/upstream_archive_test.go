package db

import (
	"context"
	"database/sql"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// ArchiveSemantics pins the three things an operator relies on: a parked channel
// stops routing, archiving it switches it off, and unarchiving puts back the
// state it had rather than assuming it was on.
func TestArchiveSemantics(t *testing.T) {
	ctx := context.Background()
	db := memoryDB(t)

	newChannel := func(name string) models.UpstreamRow {
		t.Helper()
		input := models.DefaultUpstreamIn()
		input.Name = name
		input.BaseURL = "https://api.example.com"
		if _, err := CreateUpstream(ctx, db, &input, 300); err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
		return byName(t, ctx, db, name)
	}

	on := newChannel("on-before-archiving")
	off := newChannel("off-before-archiving")
	if _, err := SetUpstreamEnabled(ctx, db, off.ID, false); err != nil {
		t.Fatalf("disable: %v", err)
	}

	for _, id := range []int64{on.ID, off.ID} {
		if _, err := SetUpstreamArchived(ctx, db, id, true); err != nil {
			t.Fatalf("archive %d: %v", id, err)
		}
	}

	t.Run("parked channels stop routing", func(t *testing.T) {
		// Both list functions feed the proxy: one for every group a token may
		// reach, one for the group the token actually belongs to. Missing either
		// leaves a way back in.
		for _, path := range []struct {
			name string
			list func() ([]models.UpstreamRow, error)
		}{
			{"ListEnabledUpstreams", func() ([]models.UpstreamRow, error) {
				return ListEnabledUpstreams(ctx, db)
			}},
			{"ListEnabledUpstreamsInGroup", func() ([]models.UpstreamRow, error) {
				return ListEnabledUpstreamsInGroup(ctx, db, 1)
			}},
		} {
			rows, err := path.list()
			if err != nil {
				t.Fatalf("%s: %v", path.name, err)
			}
			for _, row := range rows {
				if row.Archived == 1 {
					t.Errorf("%s still returns archived channel %s (%d)",
						path.name, row.Name, row.ID)
				}
			}
		}
	})

	// 兜底场景用独立渠道：它要把 enabled 强行写回 1，会污染共享状态。
	leaked := newChannel("archived-but-enabled")
	if _, err := SetUpstreamArchived(ctx, db, leaked.ID, true); err != nil {
		t.Fatal(err)
	}
	t.Run("an archived channel that is switched back on still does not route", func(t *testing.T) {
		/* 归档只把 enabled 置 0，而编辑表单会把 enabled 原样写回。所以
	   "WHERE enabled = 1" 这一个条件挡不住归档渠道——真正的兜底是
	   查询里的 archived = 0。这里把 enabled 强行改回 1，模拟那条泄漏。 */
		if _, err := db.ExecContext(ctx,
			"UPDATE upstreams SET enabled = 1 WHERE name = ?", leaked.Name); err != nil {
			t.Fatal(err)
		}

		for _, path := range []struct {
			name string
			list func() ([]models.UpstreamRow, error)
		}{
			{"ListEnabledUpstreams", func() ([]models.UpstreamRow, error) {
				return ListEnabledUpstreams(ctx, db)
			}},
			{"ListEnabledUpstreamsInGroup", func() ([]models.UpstreamRow, error) {
				return ListEnabledUpstreamsInGroup(ctx, db, 1)
			}},
		} {
			rows, err := path.list()
			if err != nil {
				t.Fatalf("%s: %v", path.name, err)
			}
			for _, row := range rows {
				if row.Name == leaked.Name {
					t.Errorf("%s returns an archived channel that was switched back on",
						path.name)
				}
			}
		}
	})

	t.Run("archiving switches off and remembers", func(t *testing.T) {
		for name, wantPrevious := range map[string]int64{
			"on-before-archiving":  1,
			"off-before-archiving": 0,
		} {
			row := byName(t, ctx, db, name)
			if row.Enabled != 0 {
				t.Errorf("%s: enabled=%d after archiving, want 0", name, row.Enabled)
			}
			if row.Archived != 1 {
				t.Errorf("%s: archived=%d, want 1", name, row.Archived)
			}
			if row.ArchivedPrevEnabled == nil || *row.ArchivedPrevEnabled != wantPrevious {
				t.Errorf("%s: archived_prev_enabled=%v, want %d — this is what unarchiving restores",
					name, row.ArchivedPrevEnabled, wantPrevious)
			}
		}
	})

	t.Run("unarchiving restores the remembered state", func(t *testing.T) {
		if _, err := SetUpstreamArchived(ctx, db, byName(t, ctx, db, "on-before-archiving").ID, false); err != nil {
			t.Fatal(err)
		}
		if row := byName(t, ctx, db, "on-before-archiving"); row.Enabled != 1 {
			t.Errorf("enabled=%d after restoring, want 1", row.Enabled)
		}

		if _, err := SetUpstreamArchived(ctx, db, byName(t, ctx, db, "off-before-archiving").ID, false); err != nil {
			t.Fatal(err)
		}
		row := byName(t, ctx, db, "off-before-archiving")
		if row.Enabled != 0 {
			t.Errorf("enabled=%d after restoring, want 0 — a channel that was off must not come back on",
				row.Enabled)
		}
		if row.ArchivedPrevEnabled != nil {
			t.Errorf("archived_prev_enabled=%v after restoring, want NULL", row.ArchivedPrevEnabled)
		}
	})

	t.Run("a restored channel routes again", func(t *testing.T) {
		rows, err := ListEnabledUpstreams(ctx, db)
		if err != nil {
			t.Fatal(err)
		}
		found := false
		for _, row := range rows {
			if row.Name == "on-before-archiving" {
				found = true
			}
		}
		if !found {
			t.Error("the restored channel is not routing again")
		}
	})
}

func byName(t *testing.T, ctx context.Context, db *sql.DB, name string) models.UpstreamRow {
	t.Helper()
	row, found, err := GetUpstreamByName(ctx, db, name)
	if err != nil {
		t.Fatalf("get %s: %v", name, err)
	}
	if !found {
		t.Fatalf("channel %s not found", name)
	}
	return row
}
