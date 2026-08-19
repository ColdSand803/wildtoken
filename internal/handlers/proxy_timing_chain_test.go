package handlers

import (
	"database/sql"
	"net/http"
	"net/http/httptest"
	"testing"
)

// attemptRow is one persisted attempt, in the order the rows were written.
type attemptRow struct {
	requestUID    sql.NullString
	attemptIndex  sql.NullInt64
	preUpstreamMs sql.NullInt64
	statusCode    sql.NullInt64
	upstreamName  sql.NullString
}

func readAttemptRows(t *testing.T, state interface{ DB() *sql.DB }) []attemptRow {
	t.Helper()
	rows, err := state.DB().Query(`SELECT request_uid, attempt_index, pre_upstream_ms,
	    status_code, upstream_name FROM request_logs ORDER BY id`)
	if err != nil {
		t.Fatalf("query attempts: %v", err)
	}
	defer rows.Close()

	var attempts []attemptRow
	for rows.Next() {
		var attempt attemptRow
		if err := rows.Scan(&attempt.requestUID, &attempt.attemptIndex,
			&attempt.preUpstreamMs, &attempt.statusCode, &attempt.upstreamName); err != nil {
			t.Fatalf("scan attempt: %v", err)
		}
		attempts = append(attempts, attempt)
	}
	if err := rows.Err(); err != nil {
		t.Fatalf("rows: %v", err)
	}
	return attempts
}

// failingUpstream serves a fixed 500 so the retry loop moves on to another
// channel, which is what produces more than one row for one request.
func failingUpstream(t *testing.T) *httptest.Server {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("content-type", "application/json")
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(`{"error":"upstream is down"}`))
	}))
	t.Cleanup(server.Close)
	return server
}

// TestRetriedAttemptsShareOneRequestUID is the correlation the console needs to
// present a retry as one request rather than as several unrelated failures that
// happened to land in the same second.
func TestRetriedAttemptsShareOneRequestUID(t *testing.T) {
	state := proxyRateLimitState(t)
	broken := failingUpstream(t)

	insertCallerToken(t, state.DB, "caller-token")
	createChannel(t, state, "broken", broken.URL, 100, nil)

	// The retry backoff would otherwise hold this test for a second: routing
	// re-selects the same failed channel, which is the path that waits.
	settings := state.Runtime.Get()
	settings.SameUpstreamRetryIntervalMs = 0
	state.Runtime.Set(settings)

	router := proxyRateLimitRouter(state)

	// The default retry budget is 1, so a persistent failure is attempted twice
	// and each attempt writes its own row.
	if response := sendProxyRequest(router, "caller-token"); response.Code != http.StatusInternalServerError {
		t.Fatalf("got %d, want the upstream's 500 after the retry was exhausted", response.Code)
	}

	state.LogWriter.Close()
	attempts := readAttemptRows(t, dbHolder{state.DB})

	if len(attempts) != 2 {
		t.Fatalf("wrote %d rows, want one per attempt", len(attempts))
	}
	first, second := attempts[0], attempts[1]

	if !first.requestUID.Valid || first.requestUID.String == "" {
		t.Fatal("first attempt has no request_uid")
	}
	if first.requestUID.String != second.requestUID.String {
		t.Errorf("attempts carry different uids (%q, %q): the chain cannot be reassembled",
			first.requestUID.String, second.requestUID.String)
	}

	if idx := first.attemptIndex; !idx.Valid || idx.Int64 != 0 {
		t.Errorf("first attempt_index = %+v, want 0", idx)
	}
	if idx := second.attemptIndex; !idx.Valid || idx.Int64 != 1 {
		t.Errorf("second attempt_index = %+v, want 1", idx)
	}

	// The retry's pre-upstream figure covers the failed attempt that preceded
	// it, so it cannot be smaller than the first attempt's. This is the reason
	// the field is not called queue_ms: on attempt 1 it is not queue time.
	if !first.preUpstreamMs.Valid || !second.preUpstreamMs.Valid {
		t.Fatal("pre_upstream_ms is NULL on a proxied attempt")
	}
	if second.preUpstreamMs.Int64 < first.preUpstreamMs.Int64 {
		t.Errorf("retry pre_upstream_ms %d is below the first attempt's %d",
			second.preUpstreamMs.Int64, first.preUpstreamMs.Int64)
	}

	if first.statusCode.Int64 != 500 || second.statusCode.Int64 != 500 {
		t.Errorf("statuses = (%d, %d), want both attempts to record the failure",
			first.statusCode.Int64, second.statusCode.Int64)
	}
}

// TestRejectionBeforeAnyAttemptHasNoAttemptIndex separates "no attempt was made"
// from "attempt 0". A zero here would report a channel call that never happened.
func TestRejectionBeforeAnyAttemptHasNoAttemptIndex(t *testing.T) {
	state := proxyRateLimitState(t)
	insertCallerToken(t, state.DB, "caller-token")
	// No channel serves this model, so routing produces no attempt at all.
	router := proxyRateLimitRouter(state)

	response := sendProxyRequest(router, "caller-token")
	if response.Code == http.StatusOK {
		t.Fatal("expected the request to be refused with no route")
	}

	state.LogWriter.Close()
	attempts := readAttemptRows(t, dbHolder{state.DB})
	if len(attempts) != 1 {
		t.Fatalf("wrote %d rows, want the single refusal", len(attempts))
	}

	refusal := attempts[0]
	if refusal.attemptIndex.Valid {
		t.Errorf("attempt_index = %d on a request that reached no upstream, want NULL",
			refusal.attemptIndex.Int64)
	}
	if refusal.preUpstreamMs.Valid {
		t.Errorf("pre_upstream_ms = %d with no attempt to precede, want NULL",
			refusal.preUpstreamMs.Int64)
	}
	// The uid is still present: the row belongs to a request, and the console
	// groups by it even when the chain has one link.
	if !refusal.requestUID.Valid || refusal.requestUID.String == "" {
		t.Error("request_uid is NULL on a refused request")
	}
}

// dbHolder adapts a bare *sql.DB to the accessor readAttemptRows takes, so the
// helper does not depend on the whole app state.
type dbHolder struct{ database *sql.DB }

func (h dbHolder) DB() *sql.DB { return h.database }
