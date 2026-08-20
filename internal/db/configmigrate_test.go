package db

import (
	"context"
	"database/sql"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

// migrationDB opens a fresh database with the current schema.
//
// A distinct name per caller so two instances can exist at once, which is what a
// migration test needs: the point is moving configuration from one to another.
func migrationDB(t *testing.T, name string) *sql.DB {
	t.Helper()
	database, err := sql.Open("sqlite", "file:"+t.Name()+"-"+name+"?mode=memory&cache=shared")
	if err != nil {
		t.Fatalf("open %s: %v", name, err)
	}
	database.SetMaxOpenConns(1)
	t.Cleanup(func() { database.Close() })
	if err := Init(context.Background(), database); err != nil {
		t.Fatalf("init %s: %v", name, err)
	}
	return database
}

func importOptions() ConfigImportOptions {
	return ConfigImportOptions{
		OnConflict:            models.ConfigConflictSkip,
		DefaultTimeoutSeconds: 300,
		// Deterministic, so a test can assert on the value a token was minted with.
		GenerateToken: func() (string, error) { return "generated-token-value", nil },
	}
}

func mustExport(t *testing.T, database *sql.DB, includeSecrets bool) *models.ConfigArchivePayload {
	t.Helper()
	payload, err := ExportConfig(context.Background(), database, models.ConfigScopes, includeSecrets)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	return payload
}

func mustImport(t *testing.T, database *sql.DB, payload *models.ConfigArchivePayload,
	options ConfigImportOptions) models.ConfigImportResponse {
	t.Helper()
	response, err := ImportConfig(context.Background(), database, payload, options)
	if err != nil {
		t.Fatalf("import: %v", err)
	}
	return response
}

// createGroupNamed inserts a group and returns its id.
func createGroupNamed(t *testing.T, database *sql.DB, name string) int64 {
	t.Helper()
	group, err := CreateGroup(context.Background(), database, &models.GroupIn{Name: name})
	if err != nil {
		t.Fatalf("create group %s: %v", name, err)
	}
	return group.ID
}

func createChannelIn(t *testing.T, database *sql.DB, name string, groupIDs []int64) models.UpstreamOut {
	t.Helper()
	timeout := 300.0
	key := "sk-" + name
	out, err := CreateUpstream(context.Background(), database, &models.UpstreamIn{
		Name: name, BaseURL: "https://" + name + ".example/v1", APIKey: &key,
		ModelNames: []string{"gpt-4o"}, Priority: 100, Weight: 100, Enabled: true,
		TimeoutSeconds: &timeout, GroupIDs: groupIDs,
	}, 300)
	if err != nil {
		t.Fatalf("create channel %s: %v", name, err)
	}
	return out
}

func channelGroupNames(t *testing.T, database *sql.DB, channelName string) []string {
	t.Helper()
	rows, err := database.QueryContext(context.Background(), `SELECT g.name
        FROM upstreams u
        JOIN upstream_groups ug ON ug.upstream_id = u.id
        JOIN groups g ON g.id = ug.group_id
        WHERE u.name = ? ORDER BY g.name`, channelName)
	if err != nil {
		t.Fatalf("read membership: %v", err)
	}
	defer rows.Close()

	names := []string{}
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			t.Fatalf("scan: %v", err)
		}
		names = append(names, name)
	}
	return names
}

func countRows(t *testing.T, database *sql.DB, table string) int64 {
	t.Helper()
	var count int64
	if err := database.QueryRowContext(context.Background(),
		"SELECT COUNT(*) FROM "+table).Scan(&count); err != nil {
		t.Fatalf("count %s: %v", table, err)
	}
	return count
}

// TestAChannelLandsInTheRightGroupOnAnInstanceWhoseIdsDiffer is the checklist's
// central requirement, and the reason this format exists.
//
// The source's group is id 2; on the target that id belongs to a different group
// entirely. An export carrying numeric ids would place the channel in the target's
// group 2 — routing would look configured and serve the wrong traffic, which is
// worse than failing.
func TestAChannelLandsInTheRightGroupOnAnInstanceWhoseIdsDiffer(t *testing.T) {
	source := migrationDB(t, "source")
	target := migrationDB(t, "target")

	// Source: "production" is id 2.
	productionID := createGroupNamed(t, source, "production")
	createChannelIn(t, source, "openai", []int64{productionID})

	// Target: id 2 is "staging", and "production" is id 3. Numeric ids therefore
	// disagree in both directions.
	stagingID := createGroupNamed(t, target, "staging")
	targetProductionID := createGroupNamed(t, target, "production")
	if productionID != stagingID {
		t.Fatalf("the fixture no longer collides: source production id %d, target staging id %d",
			productionID, stagingID)
	}
	if targetProductionID == productionID {
		t.Fatal("the fixture no longer differs: production has the same id on both instances")
	}

	payload := mustExport(t, source, false)
	// The archive must not carry ids at all.
	if len(payload.Channels) != 1 {
		t.Fatalf("exported %d channels, want 1", len(payload.Channels))
	}
	if got := payload.Channels[0].GroupNames; len(got) != 1 || got[0] != "production" {
		t.Fatalf("group_names = %v, want [production]", got)
	}

	response := mustImport(t, target, payload, importOptions())
	if !response.Applied {
		t.Fatalf("import was not applied: %+v", response)
	}

	if names := channelGroupNames(t, target, "openai"); len(names) != 1 || names[0] != "production" {
		t.Errorf("channel groups = %v, want [production]; a numeric id would have put it in staging",
			names)
	}
}

// TestAMissingGroupIsRefusedRatherThanSilentlyDefaulted.
//
// Quietly placing the channel in the default group would produce a gateway that
// looks configured and serves traffic the operator did not authorize for it.
func TestAMissingGroupIsRefusedRatherThanSilentlyDefaulted(t *testing.T) {
	target := migrationDB(t, "target")

	payload := &models.ConfigArchivePayload{
		Channels: []models.ConfigArchiveChannel{{
			Name: "openai", BaseURL: "https://api.openai.com/v1",
			Priority: 100, Weight: 100, Enabled: true, TimeoutSeconds: 300,
			GroupNames: []string{"production"},
		}},
	}

	// Only the channels scope: the group the channel names is not created.
	options := importOptions()
	options.Scopes = []string{models.ConfigScopeChannels}
	response := mustImport(t, target, payload, options)

	if response.Applied {
		t.Fatal("an import naming a nonexistent group was applied")
	}
	if len(response.Errors) == 0 {
		t.Fatal("no error reported")
	}
	if !strings.Contains(strings.Join(response.Errors, " "), "production") {
		t.Errorf("errors = %v, want the missing group named", response.Errors)
	}
	if count := countRows(t, target, "upstreams"); count != 0 {
		t.Errorf("%d channels written by a refused import, want 0", count)
	}
}

// TestARefusedImportWritesNothingAtAll is the checklist's no-partial-write rule.
//
// The archive's first channel is valid and its second is not. Applying the first
// and refusing the second would leave the operator with a half-migrated instance
// and no way to know which half.
func TestARefusedImportWritesNothingAtAll(t *testing.T) {
	target := migrationDB(t, "target")

	payload := &models.ConfigArchivePayload{
		Groups: []models.ConfigArchiveGroup{{Name: "production"}},
		Channels: []models.ConfigArchiveChannel{
			{Name: "valid", BaseURL: "https://valid.example/v1", Priority: 100,
				Weight: 100, Enabled: true, TimeoutSeconds: 300,
				GroupNames: []string{"production"}},
			// An empty base URL fails channel validation.
			{Name: "broken", BaseURL: "", Priority: 100, Weight: 100,
				TimeoutSeconds: 300, GroupNames: []string{"production"}},
		},
	}

	response := mustImport(t, target, payload, importOptions())
	if response.Applied {
		t.Fatal("an import with an invalid entry was applied")
	}

	if count := countRows(t, target, "upstreams"); count != 0 {
		t.Errorf("%d channels survived a refused import, want 0", count)
	}
	// The group created before the failure must be gone too — it is in the same
	// transaction, and a stray group is configuration the operator did not ask for.
	var groups int64
	if err := target.QueryRowContext(context.Background(),
		"SELECT COUNT(*) FROM groups WHERE name = 'production'").Scan(&groups); err != nil {
		t.Fatalf("count: %v", err)
	}
	if groups != 0 {
		t.Error("a group created before the failing entry was left behind")
	}

	// The report still names which entry failed, which is what the operator fixes.
	var failed *models.ConfigImportItem
	for index := range response.Items {
		if response.Items[index].Action == models.ConfigImportFail {
			failed = &response.Items[index]
		}
	}
	if failed == nil {
		t.Fatalf("no failed item in the report: %+v", response.Items)
	}
	if failed.Name != "broken" {
		t.Errorf("failed item = %q, want broken", failed.Name)
	}
}

// TestADryRunPlansWithoutWriting, and reports the same plan the real import
// produces. They share one code path, so the preview cannot describe an outcome
// the import would not.
func TestADryRunPlansWithoutWriting(t *testing.T) {
	source := migrationDB(t, "source")
	target := migrationDB(t, "target")

	createGroupNamed(t, source, "production")
	createChannelIn(t, source, "openai", []int64{2})
	payload := mustExport(t, source, false)

	options := importOptions()
	options.DryRun = true
	plan := mustImport(t, target, payload, options)

	if plan.Applied {
		t.Error("a dry run reported itself as applied")
	}
	if !plan.DryRun {
		t.Error("dry_run was not echoed")
	}
	if plan.Created == 0 {
		t.Fatalf("the plan created nothing: %+v", plan)
	}
	if count := countRows(t, target, "upstreams"); count != 0 {
		t.Fatalf("%d channels written by a dry run, want 0", count)
	}

	// The same archive applied for real must produce the same counts. A preview an
	// operator cannot rely on is worse than none.
	options.DryRun = false
	applied := mustImport(t, target, payload, options)
	if !applied.Applied {
		t.Fatalf("the real import was not applied: %+v", applied)
	}
	if applied.Created != plan.Created || applied.Updated != plan.Updated ||
		applied.Skipped != plan.Skipped {
		t.Errorf("plan was created=%d updated=%d skipped=%d, but the import was created=%d updated=%d skipped=%d",
			plan.Created, plan.Updated, plan.Skipped,
			applied.Created, applied.Updated, applied.Skipped)
	}
}

// TestTheConflictPolicyDecidesWhatHappensToAnExistingName.
func TestTheConflictPolicyDecidesWhatHappensToAnExistingName(t *testing.T) {
	source := migrationDB(t, "source")
	createChannelIn(t, source, "openai", []int64{models.DefaultGroupID})
	payload := mustExport(t, source, false)
	// Change the archived value so an overwrite is observable.
	payload.Channels[0].BaseURL = "https://migrated.example/v1"

	t.Run("skip leaves the existing channel alone", func(t *testing.T) {
		target := migrationDB(t, "skip")
		createChannelIn(t, target, "openai", []int64{models.DefaultGroupID})

		options := importOptions()
		options.OnConflict = models.ConfigConflictSkip
		response := mustImport(t, target, payload, options)
		if !response.Applied || response.Skipped == 0 {
			t.Fatalf("expected a skip: %+v", response)
		}

		var baseURL string
		if err := target.QueryRowContext(context.Background(),
			"SELECT base_url FROM upstreams WHERE name = 'openai'").Scan(&baseURL); err != nil {
			t.Fatalf("read: %v", err)
		}
		if baseURL == "https://migrated.example/v1" {
			t.Error("skip overwrote the existing channel")
		}
	})

	t.Run("overwrite replaces it", func(t *testing.T) {
		target := migrationDB(t, "overwrite")
		createChannelIn(t, target, "openai", []int64{models.DefaultGroupID})

		options := importOptions()
		options.OnConflict = models.ConfigConflictOverwrite
		response := mustImport(t, target, payload, options)
		if !response.Applied || response.Updated == 0 {
			t.Fatalf("expected an update: %+v", response)
		}

		var baseURL string
		if err := target.QueryRowContext(context.Background(),
			"SELECT base_url FROM upstreams WHERE name = 'openai'").Scan(&baseURL); err != nil {
			t.Fatalf("read: %v", err)
		}
		if baseURL != "https://migrated.example/v1" {
			t.Errorf("base_url = %q, want the archived value", baseURL)
		}
	})

	t.Run("fail refuses the whole import", func(t *testing.T) {
		target := migrationDB(t, "fail")
		createChannelIn(t, target, "openai", []int64{models.DefaultGroupID})

		options := importOptions()
		options.OnConflict = models.ConfigConflictFail
		response := mustImport(t, target, payload, options)
		if response.Applied {
			t.Error("the fail policy applied an import over an existing name")
		}
		if len(response.Errors) == 0 {
			t.Error("no error reported")
		}
	})
}

// TestTheFailPolicyIgnoresTheSeededDefaultGroup.
//
// Every instance is created with the default group, so a full archive always names
// it. Counting that as a conflict would make the fail policy unusable for the case
// it is for — importing into a fresh instance — by refusing on a row nobody
// configured. A group whose description differs is a real disagreement and still
// fails.
func TestTheFailPolicyIgnoresTheSeededDefaultGroup(t *testing.T) {
	source := migrationDB(t, "source")
	createChannelIn(t, source, "openai", []int64{models.DefaultGroupID})
	payload := mustExport(t, source, false)

	options := importOptions()
	options.OnConflict = models.ConfigConflictFail

	t.Run("an untouched default group is not a conflict", func(t *testing.T) {
		target := migrationDB(t, "fresh")
		response := mustImport(t, target, payload, options)
		if !response.Applied {
			t.Fatalf("a fresh instance refused a full archive: %v", response.Errors)
		}
		if count := countRows(t, target, "upstreams"); count != 1 {
			t.Errorf("%d channels imported, want 1", count)
		}
	})

	t.Run("an edited default group still fails", func(t *testing.T) {
		target := migrationDB(t, "edited")
		if _, err := target.ExecContext(context.Background(),
			"UPDATE groups SET description = 'locally edited' WHERE id = ?",
			models.DefaultGroupID); err != nil {
			t.Fatalf("edit description: %v", err)
		}

		response := mustImport(t, target, payload, options)
		if response.Applied {
			t.Error("a group whose description disagrees was accepted under the fail policy")
		}
		if count := countRows(t, target, "upstreams"); count != 0 {
			t.Errorf("%d channels written by a refused import, want 0", count)
		}
	})
}

// TestAnImportWithoutSecretsKeepsTheTargetsWorkingKey.
//
// Clearing the key would break a working channel as a side effect of a migration
// that never mentioned credentials.
func TestAnImportWithoutSecretsKeepsTheTargetsWorkingKey(t *testing.T) {
	source := migrationDB(t, "source")
	createChannelIn(t, source, "openai", []int64{models.DefaultGroupID})
	// Exported without secrets, which is the default and the safe one.
	payload := mustExport(t, source, false)
	if payload.Channels[0].APIKey != nil {
		t.Fatal("a no-secrets export carried an API key")
	}

	target := migrationDB(t, "target")
	createChannelIn(t, target, "openai", []int64{models.DefaultGroupID})

	options := importOptions()
	options.OnConflict = models.ConfigConflictOverwrite
	response := mustImport(t, target, payload, options)
	if !response.Applied {
		t.Fatalf("import failed: %+v", response)
	}

	var key *string
	if err := target.QueryRowContext(context.Background(),
		"SELECT api_key FROM upstreams WHERE name = 'openai'").Scan(&key); err != nil {
		t.Fatalf("read: %v", err)
	}
	if key == nil || *key != "sk-openai" {
		t.Errorf("api_key = %v, want the target's existing key preserved", key)
	}
	// And the operator is told, rather than finding out from a failing request.
	var detail string
	for _, item := range response.Items {
		if item.Scope == models.ConfigScopeChannels {
			detail = item.Detail
		}
	}
	if detail == "" {
		t.Error("nothing said the key was left as it was")
	}
}

// TestASecretsExportCarriesTheKeyAndTheTokenValue, so a migration can produce an
// instance clients reach without reconfiguring them.
func TestASecretsExportCarriesTheKeyAndTheTokenValue(t *testing.T) {
	source := migrationDB(t, "source")
	createChannelIn(t, source, "openai", []int64{models.DefaultGroupID})
	tokenValue := "tok-source-value"
	if _, err := CreateToken(context.Background(), source, &models.APITokenIn{
		Name: "app", Token: &tokenValue, Enabled: true,
	}); err != nil {
		t.Fatalf("create token: %v", err)
	}

	payload := mustExport(t, source, true)
	if payload.Channels[0].APIKey == nil || *payload.Channels[0].APIKey != "sk-openai" {
		t.Error("the channel key was not exported")
	}
	if len(payload.Tokens) != 1 {
		t.Fatalf("exported %d tokens, want 1", len(payload.Tokens))
	}
	if payload.Tokens[0].Token == nil || *payload.Tokens[0].Token != tokenValue {
		t.Fatalf("token value = %v, want the source's", payload.Tokens[0].Token)
	}

	target := migrationDB(t, "target")
	if response := mustImport(t, target, payload, importOptions()); !response.Applied {
		t.Fatalf("import failed: %+v", response)
	}

	// The credential authenticates on the target, which is the point of carrying it.
	var stored string
	if err := target.QueryRowContext(context.Background(),
		"SELECT token_hash FROM api_tokens WHERE name = 'app'").Scan(&stored); err != nil {
		t.Fatalf("read: %v", err)
	}
	if stored != TokenDigest(tokenValue) {
		t.Error("the imported token does not authenticate with the archived value")
	}
}

// TestATokenImportedWithoutItsValueIsReportedAsRegenerated.
//
// A token whose value silently changed breaks every client already configured with
// it, and nothing about the row would show why.
func TestATokenImportedWithoutItsValueIsReportedAsRegenerated(t *testing.T) {
	source := migrationDB(t, "source")
	if _, err := CreateToken(context.Background(), source, &models.APITokenIn{
		Name: "app", Enabled: true,
	}); err != nil {
		t.Fatalf("create token: %v", err)
	}
	payload := mustExport(t, source, false)
	if payload.Tokens[0].Token != nil {
		t.Fatal("a no-secrets export carried a token value")
	}

	target := migrationDB(t, "target")
	response := mustImport(t, target, payload, importOptions())
	if !response.Applied {
		t.Fatalf("import failed: %+v", response)
	}

	var detail string
	for _, item := range response.Items {
		if item.Scope == models.ConfigScopeTokens {
			detail = item.Detail
		}
	}
	if detail == "" {
		t.Fatal("nothing said the token value was regenerated")
	}

	var plain string
	if err := target.QueryRowContext(context.Background(),
		"SELECT token_plain FROM api_tokens WHERE name = 'app'").Scan(&plain); err != nil {
		t.Fatalf("read: %v", err)
	}
	if plain != "generated-token-value" {
		t.Errorf("token_plain = %q, want the minted value", plain)
	}
}

// TestUsageCountersAreNotCarriedAcrossInstances.
//
// They describe what the source served. Carrying them would hand a fresh instance
// a spent quota; the archive is configuration, not history.
func TestUsageCountersAreNotCarriedAcrossInstances(t *testing.T) {
	source := migrationDB(t, "source")
	created, err := CreateToken(context.Background(), source, &models.APITokenIn{
		Name: "app", Enabled: true, LimitExpression: "1M",
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}
	if _, err := source.ExecContext(context.Background(),
		"UPDATE api_tokens SET used_tokens = 900000 WHERE id = ?", created.ID); err != nil {
		t.Fatalf("spend quota: %v", err)
	}

	payload := mustExport(t, source, true)
	target := migrationDB(t, "target")
	if response := mustImport(t, target, payload, importOptions()); !response.Applied {
		t.Fatalf("import failed: %+v", response)
	}

	var used int64
	var limit *int64
	if err := target.QueryRowContext(context.Background(),
		"SELECT used_tokens, limit_tokens FROM api_tokens WHERE name = 'app'").
		Scan(&used, &limit); err != nil {
		t.Fatalf("read: %v", err)
	}
	if used != 0 {
		t.Errorf("used_tokens = %d on a fresh instance, want 0", used)
	}
	// The limit is configuration and must survive.
	if limit == nil || *limit != 1_000_000 {
		t.Errorf("limit_tokens = %v, want the configured 1M", limit)
	}
}

// TestOverwritingATokenLeavesItsQuotaPeriodBookkeepingAlone.
//
// quota_period_key records which period the stored usage belongs to. Rewriting it
// during an import would either drop real usage or hand back spent quota — the same
// reason UpdateToken does not touch it.
func TestOverwritingATokenLeavesItsQuotaPeriodBookkeepingAlone(t *testing.T) {
	source := migrationDB(t, "source")
	if _, err := CreateToken(context.Background(), source, &models.APITokenIn{
		Name: "app", Enabled: true, QuotaPeriod: "monthly",
	}); err != nil {
		t.Fatalf("create token: %v", err)
	}
	payload := mustExport(t, source, false)

	target := migrationDB(t, "target")
	created, err := CreateToken(context.Background(), target, &models.APITokenIn{
		Name: "app", Enabled: true, QuotaPeriod: "monthly",
	})
	if err != nil {
		t.Fatalf("create token: %v", err)
	}
	if _, err := target.ExecContext(context.Background(),
		"UPDATE api_tokens SET used_tokens = 500, quota_period_key = 'monthly:2026-08' WHERE id = ?",
		created.ID); err != nil {
		t.Fatalf("seed usage: %v", err)
	}

	options := importOptions()
	options.OnConflict = models.ConfigConflictOverwrite
	if response := mustImport(t, target, payload, options); !response.Applied {
		t.Fatalf("import failed: %+v", response)
	}

	var used int64
	var stamp string
	if err := target.QueryRowContext(context.Background(),
		"SELECT used_tokens, quota_period_key FROM api_tokens WHERE name = 'app'").
		Scan(&used, &stamp); err != nil {
		t.Fatalf("read: %v", err)
	}
	if used != 500 {
		t.Errorf("used_tokens = %d, want the target's own 500 untouched", used)
	}
	if stamp != "monthly:2026-08" {
		t.Errorf("quota_period_key = %q, want it left as stored", stamp)
	}
}

// TestSettingsAreAppliedAgainstTheTargetsOwnRevision.
//
// The archive's revision is the source's compare-and-swap counter; using it would
// either be refused as stale or overwrite a concurrent edit.
func TestSettingsAreAppliedAgainstTheTargetsOwnRevision(t *testing.T) {
	source := migrationDB(t, "source")
	if _, err := UpdateRuntimeSettings(context.Background(), source, &models.RuntimeSettingsIn{
		LogBodyKeepCount: 42, LogRetentionDays: 7, LogBodyMaxBytes: 1000,
		MaxRetries: 3, SameUpstreamRetryIntervalMs: 500,
		AutoWeightFailurePenalty: 20, AutoWeightSuccessIncrement: 5,
		AutoWeightRecoveryIncrement: 10, AutoWeightRecoveryIntervalSeconds: 60,
		LoadBalanceStrategy: models.LoadBalanceLeastLatency, Revision: 1,
	}); err != nil {
		t.Fatalf("update source settings: %v", err)
	}
	payload := mustExport(t, source, false)
	if payload.Settings == nil {
		t.Fatal("settings were not exported")
	}

	target := migrationDB(t, "target")
	// Move the target's revision away from the source's, which is the situation the
	// revision must not be carried through.
	for range 3 {
		current, _, err := LoadRuntimeSettings(context.Background(), target)
		if err != nil {
			t.Fatalf("load: %v", err)
		}
		if _, err := UpdateRuntimeSettings(context.Background(), target,
			&models.RuntimeSettingsIn{
				LogBodyKeepCount: 100, LogRetentionDays: 30, LogBodyMaxBytes: 200000,
				MaxRetries: 1, SameUpstreamRetryIntervalMs: 1000,
				AutoWeightFailurePenalty: 20, AutoWeightSuccessIncrement: 5,
				AutoWeightRecoveryIncrement: 10, AutoWeightRecoveryIntervalSeconds: 60,
				LoadBalanceStrategy: models.LoadBalanceWeighted, Revision: current.Revision,
			}); err != nil {
			t.Fatalf("bump target revision: %v", err)
		}
	}

	if response := mustImport(t, target, payload, importOptions()); !response.Applied {
		t.Fatalf("import failed: %+v", response)
	}

	applied, found, err := LoadRuntimeSettings(context.Background(), target)
	if err != nil || !found {
		t.Fatalf("load applied settings: %v", err)
	}
	if applied.LogBodyKeepCount != 42 {
		t.Errorf("log_body_keep_count = %d, want the archived 42", applied.LogBodyKeepCount)
	}
	if applied.LoadBalanceStrategy != models.LoadBalanceLeastLatency {
		t.Errorf("load_balance_strategy = %q, want the archived least_latency",
			applied.LoadBalanceStrategy)
	}
	// The revision moved forward from the target's own, not to the source's.
	if applied.Revision <= 4 {
		t.Errorf("revision = %d, want it advanced from the target's own counter",
			applied.Revision)
	}
}

// TestAScopedImportTouchesNothingElse: an operator migrating only their token
// policies must not find their channels replaced.
func TestAScopedImportTouchesNothingElse(t *testing.T) {
	source := migrationDB(t, "source")
	createChannelIn(t, source, "openai", []int64{models.DefaultGroupID})
	tokenValue := "tok-source-value"
	if _, err := CreateToken(context.Background(), source, &models.APITokenIn{
		Name: "app", Token: &tokenValue, Enabled: true,
	}); err != nil {
		t.Fatalf("create token: %v", err)
	}
	payload := mustExport(t, source, true)

	target := migrationDB(t, "target")
	options := importOptions()
	options.Scopes = []string{models.ConfigScopeTokens}
	response := mustImport(t, target, payload, options)
	if !response.Applied {
		t.Fatalf("import failed: %+v", response)
	}

	if count := countRows(t, target, "api_tokens"); count != 1 {
		t.Errorf("%d tokens, want the scoped import applied", count)
	}
	if count := countRows(t, target, "upstreams"); count != 0 {
		t.Errorf("%d channels, want a token-only import to leave channels alone", count)
	}
	for _, item := range response.Items {
		if item.Scope != models.ConfigScopeTokens {
			t.Errorf("a token-only import reported work in scope %q", item.Scope)
		}
	}
}

// TestAnExportOfAnEmptyInstanceProducesArraysRatherThanNulls.
//
// A null array would make a console iterate over nothing and a re-import read
// "absent" where the operator meant "empty".
func TestAnExportOfAnEmptyInstanceProducesArraysRatherThanNulls(t *testing.T) {
	database := migrationDB(t, "empty")
	payload := mustExport(t, database, false)

	if payload.Groups == nil || payload.Channels == nil || payload.Tokens == nil {
		t.Fatalf("an export produced a nil collection: %+v", payload)
	}
	// The seeded default group is real configuration and must be there.
	if len(payload.Groups) != 1 || payload.Groups[0].Name != DefaultGroupName {
		t.Errorf("groups = %+v, want the seeded default", payload.Groups)
	}
}

// TestAFullRoundTripReproducesTheSourcesConfiguration is the migration this feature
// exists for: export everything, import into a blank instance, compare.
func TestAFullRoundTripReproducesTheSourcesConfiguration(t *testing.T) {
	source := migrationDB(t, "source")
	productionID := createGroupNamed(t, source, "production")
	stagingID := createGroupNamed(t, source, "staging")
	createChannelIn(t, source, "primary", []int64{productionID})
	createChannelIn(t, source, "backup", []int64{productionID, stagingID})
	if _, err := CreateToken(context.Background(), source, &models.APITokenIn{
		Name: "app", Enabled: true, GroupID: &productionID,
		AllowedModels: []string{"gpt-4o", "claude-*"}, QuotaPeriod: "monthly",
		QuotaTimezone: "Asia/Shanghai", LimitExpression: "10M",
	}); err != nil {
		t.Fatalf("create token: %v", err)
	}

	payload := mustExport(t, source, true)
	target := migrationDB(t, "target")
	if response := mustImport(t, target, payload, importOptions()); !response.Applied {
		t.Fatalf("import failed: %+v", response)
	}

	// Re-exporting the target must produce the same configuration. Comparing the two
	// exports rather than counting rows: this is the property an operator actually
	// depends on, and it catches a field the import silently drops.
	reexported := mustExport(t, target, true)

	if len(reexported.Groups) != len(payload.Groups) {
		t.Errorf("groups: %d after migration, %d before", len(reexported.Groups),
			len(payload.Groups))
	}
	if len(reexported.Channels) != len(payload.Channels) {
		t.Fatalf("channels: %d after migration, %d before", len(reexported.Channels),
			len(payload.Channels))
	}
	for index := range payload.Channels {
		before, after := payload.Channels[index], reexported.Channels[index]
		if before.Name != after.Name || before.BaseURL != after.BaseURL {
			t.Errorf("channel %d differs: %+v vs %+v", index, before, after)
		}
		if strings.Join(before.GroupNames, ",") != strings.Join(after.GroupNames, ",") {
			t.Errorf("channel %s membership = %v, want %v", after.Name,
				after.GroupNames, before.GroupNames)
		}
	}
	if len(reexported.Tokens) != 1 {
		t.Fatalf("tokens: %d after migration", len(reexported.Tokens))
	}
	migrated := reexported.Tokens[0]
	if migrated.GroupName != "production" {
		t.Errorf("token group = %q, want production", migrated.GroupName)
	}
	if strings.Join(migrated.AllowedModels, ",") != "gpt-4o,claude-*" {
		t.Errorf("allowed_models = %v, want the source's whitelist", migrated.AllowedModels)
	}
	if migrated.QuotaPeriod != "monthly" || migrated.QuotaTimezone != "Asia/Shanghai" {
		t.Errorf("quota cycle = %s/%s, want monthly/Asia/Shanghai",
			migrated.QuotaPeriod, migrated.QuotaTimezone)
	}
	if migrated.LimitTokens == nil || *migrated.LimitTokens != 10_000_000 {
		t.Errorf("limit_tokens = %v, want 10M", migrated.LimitTokens)
	}
}
