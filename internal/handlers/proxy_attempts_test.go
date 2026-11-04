package handlers

import (
	"context"
	"database/sql"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strconv"
	"testing"

	"github.com/go-chi/chi/v5"

	"github.com/liguangsheng/wildtoken/internal/appstate"
	"github.com/liguangsheng/wildtoken/internal/db"
	"github.com/liguangsheng/wildtoken/internal/models"
)

// loggedAttempt is one request_logs row as the attempt tests read it.
type loggedAttempt struct {
	id        int64
	upstream  string
	status    int
	requestID sql.NullInt64
	retried   bool
}

// loggedAttempts flushes the log writer and reads every row, oldest first.
func loggedAttempts(t *testing.T, state *appstate.State) []loggedAttempt {
	t.Helper()
	state.LogWriter.Close()
	rows, err := state.DB.Query(`SELECT id, COALESCE(upstream_name, ''), COALESCE(status_code, 0),
        request_id, retried FROM request_logs ORDER BY id`)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()

	var logged []loggedAttempt
	for rows.Next() {
		var row loggedAttempt
		if err := rows.Scan(&row.id, &row.upstream, &row.status, &row.requestID, &row.retried); err != nil {
			t.Fatal(err)
		}
		logged = append(logged, row)
	}
	return logged
}

// shape renders rows as "name:status:retried" for comparison.
func shape(logged []loggedAttempt) []string {
	out := make([]string, len(logged))
	for i, row := range logged {
		mark := "final"
		if row.retried {
			mark = "retried"
		}
		out[i] = row.upstream + ":" + http.StatusText(row.status) + ":" + mark
	}
	return out
}

// oneRequest checks that the rows share a request id that is set.
func oneRequest(t *testing.T, logged []loggedAttempt) {
	t.Helper()
	for _, row := range logged {
		if !row.requestID.Valid || row.requestID != logged[0].requestID {
			t.Fatalf("rows %+v do not share one request id", logged)
		}
	}
}

func usageRequests(t *testing.T, state *appstate.State) (requests, errors int64) {
	t.Helper()
	if err := state.DB.QueryRow(`SELECT COALESCE(SUM(requests), 0), COALESCE(SUM(errors), 0)
        FROM usage_hourly`).Scan(&requests, &errors); err != nil {
		t.Fatal(err)
	}
	return requests, errors
}

// The attempt a failover replaced is on the log, marked retried, so the
// request counts once and is not a failure.
func TestAFailoverLogsTheReplacedAttemptAsRetried(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	rejecting, _ := statusUpstream(t, http.StatusBadRequest)
	serving, _ := countingUpstream(t)
	createChannel(t, state, "rejecting", rejecting.URL, 999, nil)
	createChannel(t, state, "serving", serving.URL, 100, nil)

	if code := sendProxyRequest(proxyRateLimitRouter(state), "caller-token").Code; code != http.StatusOK {
		t.Fatalf("status %d, want the serving channel's 200", code)
	}

	logged := loggedAttempts(t, state)
	want := []string{"rejecting:Bad Request:retried", "serving:OK:final"}
	if got := shape(logged); !slices.Equal(got, want) {
		t.Fatalf("logged %v, want %v", got, want)
	}
	oneRequest(t, logged)
	if requests, errors := usageRequests(t, state); requests != 1 || errors != 0 {
		t.Errorf("usage counted %d requests, %d errors; want 1 and 0", requests, errors)
	}

	detail, found, err := db.GetLogDetail(context.Background(), state.DB, logged[1].id)
	if err != nil || !found {
		t.Fatalf("detail: found=%v err=%v", found, err)
	}
	if len(detail.Attempts) != 2 || !detail.Attempts[0].Retried || detail.Attempts[1].Retried {
		t.Errorf("detail lists attempts %+v, want the retried one, then this one", detail.Attempts)
	}

	// The console reads the same chain without the payloads.
	router := chi.NewRouter()
	router.Get("/api/admin/logs/{id}/attempts", AdminListLogAttempts(state))
	recorder := httptest.NewRecorder()
	router.ServeHTTP(recorder, httptest.NewRequest(http.MethodGet,
		"/api/admin/logs/"+strconv.FormatInt(logged[0].id, 10)+"/attempts", nil))
	var page struct {
		Items []models.RequestLogOut `json:"items"`
	}
	if err := json.Unmarshal(recorder.Body.Bytes(), &page); err != nil {
		t.Fatalf("attempts: %d %s", recorder.Code, recorder.Body.String())
	}
	if len(page.Items) != 2 || page.Items[0].ID != logged[0].id || page.Items[1].ID != logged[1].id {
		t.Errorf("attempts endpoint listed %+v, want both rows in order", page.Items)
	}
}

// When every attempt fails, the last one is how the request ended.
func TestARequestFailingEverywhereEndsOnItsLastAttempt(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	rejecting, _ := statusUpstream(t, http.StatusBadRequest)
	broken, _ := statusUpstream(t, http.StatusBadGateway)
	createChannel(t, state, "rejecting", rejecting.URL, 999, nil)
	createChannel(t, state, "broken", broken.URL, 100, nil)

	if code := sendProxyRequest(proxyRateLimitRouter(state), "caller-token").Code; code != http.StatusBadGateway {
		t.Fatalf("status %d, want the last channel's 502", code)
	}

	logged := loggedAttempts(t, state)
	want := []string{"rejecting:Bad Request:retried", "broken:Bad Gateway:final"}
	if got := shape(logged); !slices.Equal(got, want) {
		t.Fatalf("logged %v, want %v", got, want)
	}
	oneRequest(t, logged)
	if requests, errors := usageRequests(t, state); requests != 1 || errors != 1 {
		t.Errorf("usage counted %d requests, %d errors; want 1 and 1", requests, errors)
	}
}

// An attempt that gets no answer is held until the next one runs, then
// written as retried; the last is written as the outcome.
func TestUnansweredAttemptsAreWrittenOnceTheirFateIsKnown(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	settings := state.Runtime.Get()
	settings.MaxRetries = 2
	settings.SameUpstreamRetryIntervalMs = 0
	state.Runtime.Set(settings)

	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()
	createChannel(t, state, "gone", gone.URL, 100, nil)

	if code := sendProxyRequest(proxyRateLimitRouter(state), "caller-token").Code; code != http.StatusBadGateway {
		t.Fatalf("status %d, want 502", code)
	}

	logged := loggedAttempts(t, state)
	want := []string{"gone:Bad Gateway:retried", "gone:Bad Gateway:retried", "gone:Bad Gateway:final"}
	if got := shape(logged); !slices.Equal(got, want) {
		t.Fatalf("logged %v, want %v", got, want)
	}
	oneRequest(t, logged)
}

// Channels whose stored headers no longer build a request are attempts. When
// no other channel is left, a row of its own records the request's outcome.
func TestMisconfiguredChannelsAreAttempts(t *testing.T) {
	for _, withHealthy := range []bool{true, false} {
		name := "only broken"
		if withHealthy {
			name = "broken then healthy"
		}
		t.Run(name, func(t *testing.T) {
			state := proxyRateLimitState(t)
			insertCallerToken(t, state.DB, "caller-token")
			broken, _ := countingUpstream(t)
			createChannel(t, state, "broken", broken.URL, 999, nil)
			if withHealthy {
				healthy, _ := countingUpstream(t)
				createChannel(t, state, "healthy", healthy.URL, 100, nil)
			}
			if _, err := state.DB.Exec(`UPDATE upstreams SET extra_headers = '{"Bad Header":"x"}'
                WHERE name = 'broken'`); err != nil {
				t.Fatal(err)
			}
			state.Routing.Invalidate()

			code := sendProxyRequest(proxyRateLimitRouter(state), "caller-token").Code
			logged := loggedAttempts(t, state)
			want := []string{"broken:Bad Gateway:retried", ":Bad Gateway:final"}
			wantCode := http.StatusBadGateway
			if withHealthy {
				want = []string{"broken:Bad Gateway:retried", "healthy:OK:final"}
				wantCode = http.StatusOK
			}
			if code != wantCode {
				t.Fatalf("status %d, want %d", code, wantCode)
			}
			if got := shape(logged); !slices.Equal(got, want) {
				t.Fatalf("logged %v, want %v", got, want)
			}
			oneRequest(t, logged)
		})
	}
}
