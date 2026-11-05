package db

import (
	"context"
	"database/sql"
	"slices"
	"strings"
	"testing"
)

// queryPlan renders EXPLAIN QUERY PLAN's details, one per line.
func queryPlan(t *testing.T, database *sql.DB, query string) string {
	t.Helper()
	rows, err := database.QueryContext(context.Background(), "EXPLAIN QUERY PLAN "+query)
	if err != nil {
		t.Fatalf("explain: %v", err)
	}
	defer rows.Close()

	var plan strings.Builder
	for rows.Next() {
		var id, parent, notUsed int64
		var detail string
		if err := rows.Scan(&id, &parent, &notUsed, &detail); err != nil {
			t.Fatalf("scan: %v", err)
		}
		plan.WriteString(detail + "\n")
	}
	return plan.String()
}

func TestLogClientTypesListsEachTypeOnceInNameOrder(t *testing.T) {
	database := memoryDB(t)
	ctx := context.Background()

	if types, err := LogClientTypes(ctx, database); err != nil || types == nil || len(types) != 0 {
		t.Fatalf("no logs: %#v, %v; want an empty list", types, err)
	}

	for _, clientType := range []string{"pi", "claude", "pi", "axonhub", "claude"} {
		if _, err := database.ExecContext(ctx,
			"INSERT INTO request_logs (method, path, client_type) VALUES ('POST', 'chat/completions', ?)",
			clientType); err != nil {
			t.Fatal(err)
		}
	}
	types, err := LogClientTypes(ctx, database)
	if err != nil || !slices.Equal(types, []string{"axonhub", "claude", "pi"}) {
		t.Fatalf("types = %v, %v", types, err)
	}
}

// The list seeks one index entry per type; a scan would read every log row
// each time the log page opens.
func TestLogClientTypesSeeksTheIndex(t *testing.T) {
	plan := queryPlan(t, memoryDB(t), logClientTypesQuery)
	if strings.Contains(plan, "SCAN request_logs") ||
		!strings.Contains(plan, "idx_request_logs_client_created_at") {
		t.Errorf("the list reads more than the index:\n%s", plan)
	}
}

// A page of one client comes off the index in order. Indexed on client_type
// alone, a common client's rows were all fetched and sorted per page.
func TestClientFilterPagesWithoutSorting(t *testing.T) {
	database := memoryDB(t)
	for _, query := range []string{
		"SELECT " + logListColumns + " FROM request_logs WHERE 1 = 1 AND client_type = 'pi'" +
			" ORDER BY created_at DESC, id DESC LIMIT 51 OFFSET 0",
		"SELECT " + logListColumns + " FROM request_logs WHERE 1 = 1 AND client_type = 'pi'" +
			" AND (created_at < '2026-11-05' OR (created_at = '2026-11-05' AND id < 9))" +
			" ORDER BY created_at DESC, id DESC LIMIT 51",
	} {
		plan := queryPlan(t, database, query)
		if strings.Contains(plan, "TEMP B-TREE") ||
			!strings.Contains(plan, "idx_request_logs_client_created_at") {
			t.Errorf("client page plan:\n%s", plan)
		}
	}
}
