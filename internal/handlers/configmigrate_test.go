package handlers

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// configMigrateState is the shared handler fixture with its database named, because
// every test here needs a source and a target that are genuinely separate instances.
func configMigrateState(t *testing.T, instance string) *appstate.State {
	t.Helper()
	return namedTestState(t, instance)
}

// callMigration runs one of the two migration handlers against a body.
func callMigration(t *testing.T, handler http.HandlerFunc, path string,
	body any) *httptest.ResponseRecorder {
	t.Helper()
	encoded, err := json.Marshal(body)
	if err != nil {
		t.Fatalf("encode request: %v", err)
	}
	request := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(encoded))
	request.Header.Set("content-type", "application/json")
	recorder := httptest.NewRecorder()
	handler(recorder, request)
	return recorder
}

// exportArchive runs the export endpoint and decodes the archive it produced.
func exportArchive(t *testing.T, state *appstate.State,
	request models.ConfigExportRequest) *models.ConfigArchive {
	t.Helper()
	recorder := callMigration(t, AdminExportConfig(state), "/api/admin/config/export", request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("export returned %d: %s", recorder.Code, recorder.Body.String())
	}
	archive := &models.ConfigArchive{}
	if err := json.Unmarshal(recorder.Body.Bytes(), archive); err != nil {
		t.Fatalf("decode archive: %v", err)
	}
	return archive
}

// importArchive runs the import endpoint and decodes its report, whatever the status.
func importArchive(t *testing.T, state *appstate.State,
	request models.ConfigImportRequest) (int, models.ConfigImportResponse) {
	t.Helper()
	recorder := callMigration(t, AdminImportConfig(state), "/api/admin/config/import", request)
	var response models.ConfigImportResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &response); err != nil {
		t.Fatalf("decode report (status %d): %s", recorder.Code, recorder.Body.String())
	}
	return recorder.Code, response
}

// seedChannel gives an instance something worth exporting.
func seedChannel(t *testing.T, state *appstate.State, name string) {
	t.Helper()
	timeout := 300.0
	key := "sk-" + name
	if _, err := db.CreateUpstream(context.Background(), state.DB, &models.UpstreamIn{
		Name: name, BaseURL: "https://" + name + ".example/v1", APIKey: &key,
		ModelNames: []string{"gpt-4o"}, Priority: 100, Weight: 100, Enabled: true,
		TimeoutSeconds: &timeout, GroupIDs: []int64{models.DefaultGroupID},
	}, 300); err != nil {
		t.Fatalf("seed channel: %v", err)
	}
}

// TestAnEncryptedArchiveMigratesEndToEnd is the feature as an operator uses it:
// export from one instance with a password, import into another.
func TestAnEncryptedArchiveMigratesEndToEnd(t *testing.T) {
	source := configMigrateState(t, "source")
	seedChannel(t, source, "openai")

	archive := exportArchive(t, source, models.ConfigExportRequest{
		IncludeSecrets: true, Password: "correct horse battery",
	})
	if !archive.Encrypted() {
		t.Fatal("a password was given and the archive came back unencrypted")
	}
	if archive.Payload != nil {
		t.Fatal("an encrypted archive also carried a plaintext body")
	}
	if archive.Checksum == "" {
		t.Error("no checksum, so a truncated upload could not be detected")
	}
	if archive.AppVersion == "" || archive.ExportedAt == "" {
		t.Error("the archive does not say what produced it or when")
	}

	// The key must not be readable in the document that leaves the instance.
	encoded, err := json.Marshal(archive)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	if bytes.Contains(encoded, []byte("sk-openai")) {
		t.Error("the channel key is readable in an encrypted archive")
	}

	target := configMigrateState(t, "target")
	status, report := importArchive(t, target, models.ConfigImportRequest{
		Archive: archive, Password: "correct horse battery",
		OnConflict: models.ConfigConflictSkip,
	})
	if status != http.StatusOK || !report.Applied {
		t.Fatalf("import returned %d: %+v", status, report)
	}
	if report.Created == 0 {
		t.Error("nothing was created")
	}

	detail := getUpstreamDetail(t, target, 1)
	if detail.Name != "openai" {
		t.Errorf("channel name = %q, want openai", detail.Name)
	}
}

// TestTheWrongPasswordFailsBeforeAnythingIsWritten.
//
// The checklist's standard: a wrong password, a tampered archive or an incompatible
// version must fail before the write, not during it.
func TestTheWrongPasswordFailsBeforeAnythingIsWritten(t *testing.T) {
	source := configMigrateState(t, "source")
	seedChannel(t, source, "openai")
	archive := exportArchive(t, source, models.ConfigExportRequest{Password: "the-real-password"})

	target := configMigrateState(t, "target")
	recorder := callMigration(t, AdminImportConfig(target), "/api/admin/config/import",
		models.ConfigImportRequest{
			Archive: archive, Password: "not-the-password",
			OnConflict: models.ConfigConflictSkip,
		})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
	}

	var count int64
	if err := target.DB.QueryRowContext(context.Background(),
		"SELECT COUNT(*) FROM upstreams").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Errorf("%d channels written despite a failed decryption, want 0", count)
	}
}

// TestATamperedArchiveIsRefusedByTheEndpoint. An archive travels through files,
// chat clients and object storage; the endpoint is the last place to notice.
func TestATamperedArchiveIsRefusedByTheEndpoint(t *testing.T) {
	source := configMigrateState(t, "source")
	seedChannel(t, source, "openai")

	t.Run("an edited encrypted body", func(t *testing.T) {
		archive := exportArchive(t, source, models.ConfigExportRequest{Password: "pw-for-tamper"})
		if archive.Encrypted() {
			// Flip a byte of ciphertext.
			archive.Encryption.Ciphertext = strings.Replace(archive.Encryption.Ciphertext,
				archive.Encryption.Ciphertext[:1], "0", 1)
		}
		recorder := callMigration(t, AdminImportConfig(configMigrateState(t, "target")),
			"/api/admin/config/import", models.ConfigImportRequest{
				Archive: archive, Password: "pw-for-tamper",
				OnConflict: models.ConfigConflictSkip,
			})
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", recorder.Code)
		}
	})

	t.Run("an edited plaintext body", func(t *testing.T) {
		archive := exportArchive(t, source, models.ConfigExportRequest{})
		if archive.Payload == nil {
			t.Fatal("an unencrypted export carried no readable body")
		}
		archive.Payload.Channels[0].BaseURL = "https://attacker.example/v1"

		recorder := callMigration(t, AdminImportConfig(configMigrateState(t, "target")),
			"/api/admin/config/import", models.ConfigImportRequest{
				Archive: archive, OnConflict: models.ConfigConflictSkip,
			})
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400; an unencrypted archive still has a checksum",
				recorder.Code)
		}
		if body := recorder.Body.String(); !strings.Contains(body, "校验和") &&
			!strings.Contains(strings.ToLower(body), "checksum") {
			t.Errorf("the refusal does not say the checksum failed: %s", body)
		}
	})
}

// TestAnArchiveFromANewerVersionIsRefused: a schema this build does not know may
// carry fields whose absence changes behaviour, so guessing is worse than refusing.
func TestAnArchiveFromANewerVersionIsRefused(t *testing.T) {
	source := configMigrateState(t, "source")
	seedChannel(t, source, "openai")
	archive := exportArchive(t, source, models.ConfigExportRequest{})
	archive.SchemaVersion = models.ConfigArchiveSchemaVersion + 1

	recorder := callMigration(t, AdminImportConfig(configMigrateState(t, "target")),
		"/api/admin/config/import", models.ConfigImportRequest{
			Archive: archive, OnConflict: models.ConfigConflictSkip,
		})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
	}
}

// TestAnExportRefusesToShipSecretsUnprotected.
//
// The one combination that must not be possible: credentials in a file with no
// password on it. Everything else is the operator's call.
func TestAnExportRefusesToShipSecretsUnprotected(t *testing.T) {
	state := configMigrateState(t, "state")
	seedChannel(t, state, "openai")

	recorder := callMigration(t, AdminExportConfig(state), "/api/admin/config/export",
		models.ConfigExportRequest{IncludeSecrets: true})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
	}

	t.Run("and a password too short to be one", func(t *testing.T) {
		recorder := callMigration(t, AdminExportConfig(state), "/api/admin/config/export",
			models.ConfigExportRequest{IncludeSecrets: true, Password: "short"})
		if recorder.Code != http.StatusBadRequest {
			t.Errorf("status = %d, want 400", recorder.Code)
		}
	})

	t.Run("but a policy-only export needs no password", func(t *testing.T) {
		archive := exportArchive(t, state, models.ConfigExportRequest{})
		if archive.Encrypted() {
			t.Error("an export without a password came back encrypted")
		}
		if archive.Payload == nil {
			t.Fatal("no readable body")
		}
		// And it must genuinely carry no credentials.
		encoded, err := json.Marshal(archive)
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}
		if bytes.Contains(encoded, []byte("sk-openai")) {
			t.Error("a no-secrets export shipped the channel key anyway")
		}
	})
}

// TestADryRunPreviewIsNotAWrite. The console shows this before asking for
// confirmation, so a preview that wrote would make the confirmation meaningless.
func TestADryRunPreviewIsNotAWrite(t *testing.T) {
	source := configMigrateState(t, "source")
	seedChannel(t, source, "openai")
	archive := exportArchive(t, source, models.ConfigExportRequest{})

	target := configMigrateState(t, "target")
	status, plan := importArchive(t, target, models.ConfigImportRequest{
		Archive: archive, DryRun: true, OnConflict: models.ConfigConflictSkip,
	})
	if status != http.StatusOK {
		t.Fatalf("dry run returned %d: %+v", status, plan)
	}
	if plan.Applied {
		t.Error("a dry run reported itself applied")
	}
	if !plan.DryRun {
		t.Error("dry_run was not echoed, so the console cannot label the result")
	}
	if len(plan.Items) == 0 {
		t.Error("the plan lists no items, so there is nothing to preview")
	}

	var count int64
	if err := target.DB.QueryRowContext(context.Background(),
		"SELECT COUNT(*) FROM upstreams").Scan(&count); err != nil {
		t.Fatalf("count: %v", err)
	}
	if count != 0 {
		t.Errorf("%d channels written by a dry run, want 0", count)
	}
}

// TestTheReportSaysWhereTheArchiveCameFrom, so the console can label a plan without
// re-parsing the archive it just uploaded.
func TestTheReportSaysWhereTheArchiveCameFrom(t *testing.T) {
	source := configMigrateState(t, "source")
	seedChannel(t, source, "openai")
	archive := exportArchive(t, source, models.ConfigExportRequest{
		IncludeSecrets: true, Password: "a-long-enough-password",
	})

	_, report := importArchive(t, configMigrateState(t, "target"), models.ConfigImportRequest{
		Archive: archive, Password: "a-long-enough-password",
		DryRun: true, OnConflict: models.ConfigConflictSkip,
	})

	if report.SchemaVersion != archive.SchemaVersion {
		t.Errorf("schema_version = %d, want %d", report.SchemaVersion, archive.SchemaVersion)
	}
	if report.AppVersion != archive.AppVersion {
		t.Errorf("app_version = %q, want %q", report.AppVersion, archive.AppVersion)
	}
	if report.ExportedAt != archive.ExportedAt {
		t.Errorf("exported_at = %q, want %q", report.ExportedAt, archive.ExportedAt)
	}
	if !report.IncludesSecrets {
		t.Error("includes_secrets was not echoed, so the console cannot warn that credentials are being written")
	}
	if len(report.Scopes) == 0 {
		t.Error("scopes were not echoed")
	}
}

// TestAFailedImportReturnsTheReportNotJustAnError: the item list names which entry
// was refused, which is what the operator fixes. A bare message would send them
// back to the archive to guess.
func TestAFailedImportReturnsTheReportNotJustAnError(t *testing.T) {
	source := configMigrateState(t, "source")
	seedChannel(t, source, "openai")
	archive := exportArchive(t, source, models.ConfigExportRequest{})

	// The target already has this name, and the fail policy refuses a collision.
	target := configMigrateState(t, "target")
	seedChannel(t, target, "openai")

	status, report := importArchive(t, target, models.ConfigImportRequest{
		Archive: archive, OnConflict: models.ConfigConflictFail,
	})
	if status != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400", status)
	}
	if report.Applied {
		t.Error("a refused import reported itself applied")
	}
	if len(report.Errors) == 0 {
		t.Fatal("no errors listed")
	}
	if !strings.Contains(strings.Join(report.Errors, " "), "openai") {
		t.Errorf("errors = %v, want the colliding name", report.Errors)
	}
}

// TestAnImportedRoutingChangeTakesEffectWithoutARestart.
//
// An import that changed channels while the routing cache still held the old set
// would have the console showing the new configuration and traffic following the
// old one.
func TestAnImportedRoutingChangeTakesEffectWithoutARestart(t *testing.T) {
	source := configMigrateState(t, "source")
	seedChannel(t, source, "openai")
	archive := exportArchive(t, source, models.ConfigExportRequest{})

	target := configMigrateState(t, "target")
	// Warm the model list an unrestricted token would read, so an invalidation is
	// observable rather than indistinguishable from a cache that was never filled.
	key := appstate.ModelsCacheKey{GroupID: models.DefaultGroupID}
	target.ModelsCache.Set(key, json.RawMessage(`{"data":[{"id":"stale-model"}]}`))

	status, report := importArchive(t, target, models.ConfigImportRequest{
		Archive: archive, OnConflict: models.ConfigConflictSkip,
	})
	if status != http.StatusOK || !report.Applied {
		t.Fatalf("import returned %d: %+v", status, report)
	}

	if cached := target.ModelsCache.Get(key); cached != nil {
		t.Errorf("the models cache still holds the pre-import list (%s); /v1/models would advertise models the imported channels do not offer",
			cached)
	}
}

// TestAnUnknownScopeIsRefusedRatherThanIgnored.
//
// Ignoring it would tell the operator their selection was applied when part of it
// was silently dropped.
func TestAnUnknownScopeIsRefusedRatherThanIgnored(t *testing.T) {
	state := configMigrateState(t, "state")

	recorder := callMigration(t, AdminExportConfig(state), "/api/admin/config/export",
		models.ConfigExportRequest{Scopes: []string{"channels", "everything"}})
	if recorder.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400: %s", recorder.Code, recorder.Body.String())
	}
	if body := recorder.Body.String(); !strings.Contains(body, "everything") {
		t.Errorf("the refusal does not name the unknown scope: %s", body)
	}
}
