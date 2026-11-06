package db

import (
	"context"
	"database/sql"
	"path/filepath"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/models"
)

func TestResponseRoutesPersistAcrossReopenAndKeepAccountOwnership(t *testing.T) {
	ctx := context.Background()
	path := filepath.Join(t.TempDir(), "responses.db")
	open := func() *sql.DB {
		t.Helper()
		database, err := sql.Open("sqlite", path+"?_pragma=foreign_keys(1)")
		if err != nil {
			t.Fatal(err)
		}
		database.SetMaxOpenConns(1)
		if err := Init(ctx, database); err != nil {
			t.Fatal(err)
		}
		return database
	}
	database := open()
	token, err := CreateToken(ctx, database, &models.APITokenIn{Name: "owner", Enabled: true})
	if err != nil {
		t.Fatal(err)
	}
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL = "channel", "https://example.test"
	channel, err := CreateUpstream(ctx, database, &input)
	if err != nil {
		t.Fatal(err)
	}
	route := models.ResponseRoute{
		ResponseID: "resp_persistent", TokenID: token.ID, UpstreamID: channel.ID,
		KeyID: 19, CredentialDigest: "credential-digest", RequestModel: "model",
	}
	if err := StoreResponseRoute(ctx, database, route); err != nil {
		t.Fatal(err)
	}
	if err := database.Close(); err != nil {
		t.Fatal(err)
	}
	database = open()
	defer database.Close()
	stored, ok, err := GetResponseRoute(ctx, database, token.ID, route.ResponseID)
	if err != nil || !ok || stored != route {
		t.Fatalf("reopened route=%+v found=%v err=%v", stored, ok, err)
	}
	if err := StoreResponseRoute(ctx, database, route); err != nil {
		t.Fatalf("same account could not re-observe its response: %v", err)
	}
	conflict := route
	conflict.CredentialDigest = "another-account"
	if err := StoreResponseRoute(ctx, database, conflict); err == nil {
		t.Fatal("same ID overwritten with another account")
	}
	if _, err := database.Exec(`DELETE FROM api_tokens WHERE id = ?`, token.ID); err != nil {
		t.Fatal(err)
	}
	if _, ok, err := GetResponseRoute(ctx, database, token.ID, route.ResponseID); err != nil || ok {
		t.Fatalf("deleted token left ownership behind: found=%v err=%v", ok, err)
	}
}
