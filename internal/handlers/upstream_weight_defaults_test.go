package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"testing"

	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

func TestNewChannelsUseFixedWeightUnlessExplicitlyOverridden(t *testing.T) {
	for _, tc := range []struct {
		name, field string
		automatic   bool
	}{
		{"default", "", false},
		{"fixed", `,"auto_weight_enabled":false`, false},
		{"automatic", `,"auto_weight_enabled":true`, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			state := upstreamTestState(t)
			response := adminCall(t, http.MethodPost, "/upstreams", "/upstreams",
				AdminCreateUpstream(state), `{"name":"created","base_url":"https://example.test"`+tc.field+`}`)
			if response.Code != http.StatusCreated {
				t.Fatalf("create returned %d: %s", response.Code, response.Body.String())
			}
			var created models.UpstreamOut
			if err := json.Unmarshal(response.Body.Bytes(), &created); err != nil {
				t.Fatal(err)
			}
			if created.AutoWeightEnabled != tc.automatic || created.Weight != 100 {
				t.Fatalf("automatic=%v weight=%d", created.AutoWeightEnabled, created.Weight)
			}
			row, found, err := db.GetUpstream(context.Background(), state.DB, created.ID)
			if err != nil || !found || (row.AutoWeightEnabled == 1) != tc.automatic {
				t.Fatalf("stored automatic=%d found=%v err=%v", row.AutoWeightEnabled, found, err)
			}
		})
	}
}

func TestNewDefaultDoesNotRewriteExistingAutomaticChannels(t *testing.T) {
	state := upstreamTestState(t)
	ctx := context.Background()
	input := models.DefaultUpstreamIn()
	input.Name, input.BaseURL = "existing", "https://example.test"
	input.AutoWeightEnabled = true
	created, err := db.CreateUpstream(ctx, state.DB, &input)
	if err != nil {
		t.Fatal(err)
	}
	response := adminCall(t, http.MethodPost, "/upstreams", "/upstreams",
		AdminCreateUpstream(state), `{"name":"new","base_url":"https://example.test"}`)
	if response.Code != http.StatusCreated {
		t.Fatal(response.Body.String())
	}
	if err := db.Init(ctx, state.DB); err != nil {
		t.Fatal(err)
	}
	row, found, err := db.GetUpstream(ctx, state.DB, created.ID)
	if err != nil || !found || row.AutoWeightEnabled != 1 {
		t.Fatalf("existing policy changed: automatic=%d found=%v err=%v", row.AutoWeightEnabled, found, err)
	}
}

func TestImportPreservesExplicitAutomaticWeight(t *testing.T) {
	state := upstreamTestState(t)
	response := adminCall(t, http.MethodPost, "/import", "/import", AdminImportUpstreams(state),
		`{"mode":"skip","channels":[{"name":"imported","base_url":"https://example.test","auto_weight_enabled":true}]}`)
	if response.Code != http.StatusOK {
		t.Fatal(response.Body.String())
	}
	row, found, err := db.GetUpstreamByName(context.Background(), state.DB, "imported")
	if err != nil || !found || row.AutoWeightEnabled != 1 {
		t.Fatalf("explicit import policy lost: automatic=%d found=%v err=%v", row.AutoWeightEnabled, found, err)
	}
}
