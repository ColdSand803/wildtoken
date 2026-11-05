package db

import (
	"context"
	"database/sql"
	"errors"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/apperr"
	"github.com/liguangsheng/wildtoken/internal/models"
)

func keyChannel(t *testing.T, db *sql.DB, name string, keys ...models.UpstreamKeyIn) models.UpstreamOut {
	t.Helper()
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL = name, "https://api.example.com"
	input.Keys = &keys
	created, err := CreateUpstream(context.Background(), db, &input)
	if err != nil {
		t.Fatalf("create %s: %v", name, err)
	}
	return created
}

func updateKeys(db *sql.DB, id int64, keys []models.UpstreamKeyIn) error {
	ctx := context.Background()
	row, _, err := GetUpstream(ctx, db, id)
	if err != nil {
		return err
	}
	input := models.UpstreamUpdate{UpstreamIn: models.DefaultUpstreamIn()}
	input.Name, input.BaseURL, input.Enabled = row.Name, row.BaseURL, true
	input.Keys = &keys
	_, err = UpdateUpstream(ctx, db, id, &input)
	return err
}

func off() *bool { v := false; return &v }

func keyValues(t *testing.T, db *sql.DB, id int64) map[string]bool {
	t.Helper()
	keys, err := ListUpstreamKeyValues(context.Background(), db, id)
	if err != nil {
		t.Fatal(err)
	}
	values := map[string]bool{}
	for _, key := range keys {
		values[key.APIKey] = key.Enabled
	}
	return values
}

// An upgrade turns the one key a channel had into its first entry, and running
// again adds nothing.
func TestASingleKeyBecomesTheFirstEntryOnUpgrade(t *testing.T) {
	db := memoryDB(t)
	ctx := context.Background()
	if _, err := db.Exec(`INSERT INTO upstreams (name, base_url, api_key) VALUES ('old', 'https://x', 'sk-old'),
        ('keyless', 'https://y', NULL), ('blank', 'https://z', '')`); err != nil {
		t.Fatal(err)
	}

	for range 2 {
		if err := migrateUpstreamKeys(ctx, db); err != nil {
			t.Fatal(err)
		}
	}
	if got := countRows(t, db, "SELECT COUNT(*) FROM upstream_keys"); got != 1 {
		t.Fatalf("%d keys, want the one from the channel that had one", got)
	}
	key, ok, err := GetUpstreamKey(ctx, db, 1, 0)
	if err != nil || !ok || key.APIKey != "sk-old" || key.Name != "" || !key.Enabled {
		t.Errorf("key = %+v, %v, %v", key, ok, err)
	}
}

func TestKeysAreReplacedAsListed(t *testing.T) {
	db := memoryDB(t)
	ctx := context.Background()
	channel := keyChannel(t, db, "multi",
		models.UpstreamKeyIn{Name: "a", APIKey: "sk-a"},
		models.UpstreamKeyIn{Name: "b", APIKey: "sk-b"},
		models.UpstreamKeyIn{Name: "c", APIKey: "sk-c", Enabled: off()},
		models.UpstreamKeyIn{APIKey: "sk-a"}, // repeats a: dropped
		models.UpstreamKeyIn{Name: "blank"},  // no value: dropped
	)
	if channel.KeyCount != 3 || channel.EnabledKeyCount != 2 || !channel.APIKeySet {
		t.Fatalf("counts %d/%d, set %v; want 3 keys, 2 enabled", channel.KeyCount, channel.EnabledKeyCount, channel.APIKeySet)
	}
	listed, _ := ListUpstreamKeys(ctx, db, channel.ID)
	a, b, c := listed[0], listed[1], listed[2]

	// a renamed with its value kept, b dropped, c switched on, d added; e
	// repeats a and is dropped.
	if err := updateKeys(db, channel.ID, []models.UpstreamKeyIn{
		{ID: a.ID, Name: "a2"},
		{ID: c.ID, Name: "c"},
		{APIKey: "sk-d"},
		{APIKey: "sk-a"},
	}); err != nil {
		t.Fatal(err)
	}
	if got := keyValues(t, db, channel.ID); len(got) != 3 || !got["sk-a"] || !got["sk-c"] || !got["sk-d"] {
		t.Errorf("keys = %v, want a, c and d, all enabled", got)
	}
	if renamed, _, _ := GetUpstreamKey(ctx, db, channel.ID, a.ID); renamed.Name != "a2" {
		t.Errorf("a is named %q, want a2", renamed.Name)
	}

	other := keyChannel(t, db, "other", models.UpstreamKeyIn{APIKey: "sk-other"})
	otherKeys, _ := ListUpstreamKeys(ctx, db, other.ID)
	for label, keys := range map[string][]models.UpstreamKeyIn{
		"another channel's key": {{ID: otherKeys[0].ID}},
		"a negative id":         {{ID: -1}},
		"one key twice":         {{ID: a.ID}, {ID: a.ID}},
		"a key removed earlier": {{ID: b.ID}},
	} {
		var appErr *apperr.AppError
		if err := updateKeys(db, channel.ID, keys); !errors.As(err, &appErr) || appErr.Kind != apperr.KindBadRequest {
			t.Errorf("%s: %v, want a 400", label, err)
		}
	}

	if err := updateKeys(db, channel.ID, []models.UpstreamKeyIn{}); err != nil {
		t.Fatal(err)
	}
	if row, _, _ := GetUpstream(ctx, db, channel.ID); row.KeyCount != 0 || row.APIKey != nil {
		t.Errorf("after an empty list: %d keys, copy %v", row.KeyCount, row.APIKey)
	}
}

// upstreams.api_key follows the first enabled key, which is what probes use
// and what a rollback to a build without keys signs in with.
func TestTheFirstEnabledKeyIsCopiedOntoTheChannel(t *testing.T) {
	db := memoryDB(t)
	ctx := context.Background()
	channel := keyChannel(t, db, "multi",
		models.UpstreamKeyIn{APIKey: "sk-first"}, models.UpstreamKeyIn{APIKey: "sk-second"})
	listed, _ := ListUpstreamKeys(ctx, db, channel.ID)

	copied := func() string {
		row, _, _ := GetUpstream(ctx, db, channel.ID)
		if row.APIKey == nil {
			return ""
		}
		return *row.APIKey
	}
	if got := copied(); got != "sk-first" {
		t.Fatalf("copy = %q, want sk-first", got)
	}

	if err := updateKeys(db, channel.ID, []models.UpstreamKeyIn{
		{ID: listed[0].ID, Enabled: off()}, {ID: listed[1].ID},
	}); err != nil {
		t.Fatal(err)
	}
	if got := copied(); got != "sk-second" {
		t.Errorf("with the first disabled, copy = %q, want sk-second", got)
	}

	// The older single-key field rewrites the first key.
	input := models.UpstreamUpdate{UpstreamIn: models.DefaultUpstreamIn()}
	input.Name, input.BaseURL, input.Enabled = "multi", "https://api.example.com", true
	legacy := "sk-rewritten"
	input.APIKey = &legacy
	if _, err := UpdateUpstream(ctx, db, channel.ID, &input); err != nil {
		t.Fatal(err)
	}
	got := keyValues(t, db, channel.ID)
	enabled, rewritten := got["sk-rewritten"]
	if _, stale := got["sk-first"]; len(got) != 2 || !rewritten || enabled || stale || !got["sk-second"] {
		t.Errorf("keys = %v, want the disabled first rewritten and the second kept", got)
	}
}

// A channel whose keys are all disabled cannot sign in, so it leaves routing; one
// with no keys at all signs in through its headers and stays.
func TestAChannelWithOnlyDisabledKeysDoesNotRoute(t *testing.T) {
	db := memoryDB(t)
	ctx := context.Background()
	keyChannel(t, db, "disabled", models.UpstreamKeyIn{APIKey: "sk-off", Enabled: off()})
	keyChannel(t, db, "keyless")
	keyChannel(t, db, "keyed", models.UpstreamKeyIn{APIKey: "sk-on"})

	rows, err := ListEnabledUpstreams(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	var names []string
	for _, row := range rows {
		names = append(names, row.Name)
	}
	if len(names) != 2 || names[0] == "disabled" || names[1] == "disabled" {
		t.Errorf("routable = %v, want keyless and keyed", names)
	}
	inGroup, _ := ListEnabledUpstreamsInGroup(ctx, db, models.DefaultGroupID)
	if len(inGroup) != 2 {
		t.Errorf("%d routable in the default group, want 2", len(inGroup))
	}

	keys, err := ListEnabledUpstreamKeys(ctx, db)
	if err != nil {
		t.Fatal(err)
	}
	if len(keys) != 1 {
		t.Errorf("enabled keys by channel = %v, want only keyed's", keys)
	}
}

func TestKeysAreSealedAtRest(t *testing.T) {
	db := memoryDB(t)
	useTestSecrets(t, mustCipher(t, "test passphrase"))
	channel := keyChannel(t, db, "sealed", models.UpstreamKeyIn{APIKey: "sk-sealed-key"})

	assertSealed(t, rawColumn(t, db, storedKeyList, channel.ID), "sk-sealed-key")
	assertSealed(t, rawColumn(t, db, storedAPIKey, channel.ID), "sk-sealed-key")
	if got := keyValues(t, db, channel.ID); !got["sk-sealed-key"] {
		t.Errorf("keys read back as %v", got)
	}
}
