package db

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
	"github.com/liguangsheng/wildtoken/internal/secret"
)

func TestCredentialHeadersAreSealedOnCreateUpdateAndRead(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	useTestSecrets(t, mustCipher(t, "header-storage-key"))
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL = "headers", "https://example.test"
	input.ExtraHeaders = map[string]string{
		"Authorization": "Bearer header-credential", "x-custom-token": "second-secret",
		"x-region": "eu", "User-Agent": "{client_header:User-Agent}",
	}
	created, err := CreateUpstream(ctx, database, &input)
	if err != nil {
		t.Fatal(err)
	}
	check := func(want string) {
		t.Helper()
		stored := rawColumn(t, database, "SELECT extra_headers FROM upstreams WHERE id = ?", created.ID)
		assertSealed(t, stored, want)
		row, ok, err := GetUpstream(ctx, database, created.ID)
		if err != nil || !ok || !strings.Contains(row.ExtraHeaders, want) {
			t.Fatalf("opened headers=%q ok=%v err=%v", row.ExtraHeaders, ok, err)
		}
		listed, err := ListUpstreams(ctx, database)
		if err != nil || len(listed) != 1 || listed[0].ExtraHeaders["Authorization"] != want {
			t.Fatalf("list did not open the headers: %+v %v", listed, err)
		}
	}
	check("Bearer header-credential")
	input.ExtraHeaders["Authorization"] = "Bearer replaced-credential"
	if _, err := UpdateUpstream(ctx, database, created.ID, &models.UpstreamUpdate{UpstreamIn: input}); err != nil {
		t.Fatal(err)
	}
	check("Bearer replaced-credential")
}

func TestHeaderSecretsMigrateAndRotateWithoutASeparateAPIKey(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL = "legacy-headers", "https://example.test"
	input.ExtraHeaders = map[string]string{"x-api-key": "legacy-header-value", "X-Region": "eu"}
	created, err := CreateUpstream(ctx, database, &input)
	if err != nil {
		t.Fatal(err)
	}
	old := mustCipher(t, "old-header-key")
	report, err := SealSecrets(ctx, database, old, nil)
	if err != nil || report.Sealed != 1 {
		t.Fatalf("legacy migration %+v: %v", report, err)
	}
	if sealed, err := HasSealedSecrets(ctx, database); err != nil || !sealed {
		t.Fatalf("header-only sealed database not detected: %v %v", sealed, err)
	}
	stored := rawColumn(t, database, "SELECT extra_headers FROM upstreams WHERE id = ?", created.ID)
	if _, err := SealSecrets(ctx, database, mustCipher(t, "wrong"), nil); err == nil {
		t.Fatal("wrong encryption key accepted")
	}
	if after := rawColumn(t, database, "SELECT extra_headers FROM upstreams WHERE id = ?", created.ID); after != stored {
		t.Fatal("failed rotation changed stored headers")
	}
	current := mustCipher(t, "current-header-key")
	report, err = SealSecrets(ctx, database, current, old)
	if err != nil || report.Resealed != 1 {
		t.Fatalf("rotation %+v: %v", report, err)
	}
	useTestSecrets(t, current)
	row, _, err := GetUpstream(ctx, database, created.ID)
	if err != nil || !strings.Contains(row.ExtraHeaders, "legacy-header-value") {
		t.Fatalf("rotated headers unreadable: %q %v", row.ExtraHeaders, err)
	}
	stored = rawColumn(t, database, "SELECT extra_headers FROM upstreams WHERE id = ?", created.ID)
	if _, err := old.Open(stored); err == nil {
		t.Fatal("old key still opens the rotated header map")
	}
	if report, err := SealSecrets(ctx, database, current, nil); err != nil || report != (SealReport{}) {
		t.Fatalf("migration was not idempotent: %+v %v", report, err)
	}
}

func TestOrdinaryAndPlaceholderHeadersNeedNoSealing(t *testing.T) {
	for _, headers := range []map[string]string{
		{"X-Region": "eu"}, {"Authorization": "{client_header:X-Provider-Credential}"}, {},
	} {
		encoded, err := json.Marshal(headers)
		if err != nil {
			t.Fatal(err)
		}
		if hasHeaderSecrets(string(encoded)) || secret.IsSealed(string(encoded)) {
			t.Errorf("non-secret headers classified as a credential: %s", encoded)
		}
	}
}
