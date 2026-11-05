package handlers

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/liguangsheng/wildtoken/internal/db"
)

func TestDailyUsageCoversTheConsolesLast53Weeks(t *testing.T) {
	state := upstreamTestState(t)
	ok, tokens := int32(200), int32(10)

	tally := db.UsageTally{}
	tally.Add(time.Now(), &ok, &tokens, false)
	// A day past the calendar's first column.
	tally.Add(time.Now().AddDate(0, 0, -dailyUsageDays-1), &ok, &tokens, false)
	if err := db.AddUsage(context.Background(), state.DB, tally); err != nil {
		t.Fatalf("add usage: %v", err)
	}

	request := httptest.NewRequest(http.MethodGet, "/api/admin/logs/daily?tz_offset=480", nil)
	recorder := httptest.NewRecorder()
	AdminDailyUsage(state).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusOK {
		t.Fatalf("daily usage returned %d: %s", recorder.Code, recorder.Body.String())
	}

	var body dailyUsageResponse
	if err := json.Unmarshal(recorder.Body.Bytes(), &body); err != nil {
		t.Fatalf("decode: %v", err)
	}
	today := time.Now().In(time.FixedZone("", 8*3600)).Format(dashboardDateLayout)
	if body.Today != today {
		t.Errorf("today = %q, want %q", body.Today, today)
	}
	if len(body.Days) != 1 || body.Days[0].Day != today || body.Days[0].Requests != 1 {
		t.Errorf("days = %+v, want only today's request", body.Days)
	}

	request = httptest.NewRequest(http.MethodGet, "/api/admin/logs/daily?tz_offset=abc", nil)
	recorder = httptest.NewRecorder()
	AdminDailyUsage(state).ServeHTTP(recorder, request)
	if recorder.Code != http.StatusBadRequest {
		t.Errorf("a malformed tz_offset returned %d", recorder.Code)
	}
}
