package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// fullTokenUpdate is a complete token edit, as the console sends one.
func fullTokenUpdate() map[string]any {
	return map[string]any{
		"name": "caller", "description": "", "expires_at": nil, "group_id": 1,
		"limit_expression": "1M", "rate_limit": "10/m", "allowed_models": []string{"gpt-5"},
	}
}

func putToken(t *testing.T, state *appstate.State, id int64,
	fields map[string]any) (int, models.APITokenOut) {
	t.Helper()
	encoded, err := json.Marshal(fields)
	if err != nil {
		t.Fatal(err)
	}
	path := "/api/admin/tokens/" + strconv.FormatInt(id, 10)
	response := adminCall(t, http.MethodPut, "/api/admin/tokens/{id}", path,
		AdminUpdateToken(state), string(encoded))
	var out models.APITokenOut
	json.Unmarshal(response.Body.Bytes(), &out)
	return response.Code, out
}

// A token edit that leaves a field out is refused. Absent, each read as its
// most permissive value: a rename lifted the quota and the model allowlist.
// The switch the edit form shows is honoured, and absent keeps the state.
func TestATokenEditIsCompleteAndCarriesItsSwitch(t *testing.T) {
	state := upstreamTestState(t)
	created, err := db.CreateToken(context.Background(), state.DB, &models.APITokenIn{
		Name: "caller", Enabled: true, AllowedModels: []string{"gpt-5"},
	})
	if err != nil {
		t.Fatal(err)
	}

	partial := map[string]any{"name": "renamed", "description": ""}
	if code, _ := putToken(t, state, created.ID, partial); code != http.StatusBadRequest {
		t.Errorf("a partial edit returned %d, want 400", code)
	}

	disable := fullTokenUpdate()
	disable["enabled"] = false
	if code, out := putToken(t, state, created.ID, disable); code != http.StatusOK || out.Enabled {
		t.Errorf("disabling returned %d enabled=%v, want the token off", code, out.Enabled)
	}

	code, out := putToken(t, state, created.ID, fullTokenUpdate())
	if code != http.StatusOK || out.Enabled || !strings.EqualFold(out.AllowedModels[0], "gpt-5") {
		t.Errorf("an edit without enabled returned %d enabled=%v, want it left off", code, out.Enabled)
	}
}
