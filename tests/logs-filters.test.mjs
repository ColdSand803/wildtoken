import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadTS, read, setupDOM, jsonResponse } from "./react-harness.mjs";
const { logFilterQuery, matchesLogFilters, navigateToLogs, readLogDrilldown, saveLogDrilldown, clearLogDrilldown } = loadTS("web/src/logFilters.ts");
const log = { id: 4, created_at: "2026-09-23 01:00:00", upstream_id: 2, downstream_token_id: 7, client_type: "pi", status_code: 200, stream: 1, duration_ms: 1000, model: "gpt-5", client_ip: "192.0.2.1" };
const all = { search: " gpt ", clientType: "pi", status: "2xx", upstreamId: "2", tokenId: "7", start: "2026-09-23T00:00:00Z", end: "2026-09-23T02:00:00Z", stream: "true", minDurationMs: "0" };
test("all advanced fields serialize to the backend list/SSE contract, including zero", () => assert.deepEqual(Object.fromEntries(logFilterQuery(all)), { search: "gpt", client_type: "pi", status: "2xx", upstream_id: "2", downstream_token_id: "7", start: all.start, end: all.end, stream: "true", min_duration_ms: "0" }));
for (const [filters, expected] of [[{}, true], [all, true], [{ upstreamId: "9" }, false], [{ tokenId: "8" }, false], [{ clientType: "claude" }, false], [{ stream: "false" }, false], [{ minDurationMs: "1001" }, false], [{ minDurationMs: "1000" }, true], [{ search: "192.0.2" }, true], [{ search: "no-match" }, false], [{ start: "2026-09-23T02:00:00Z" }, false], [{ end: "2026-09-23T01:00:00Z" }, false], [{ start: "2026-09-23T09:00:00+08:00" }, true]]) test(`loaded and streamed rows agree with ${JSON.stringify(filters)}`, () => assert.equal(matchesLogFilters(log, filters), expected));
for (const [status, codes] of [["2xx", [200, 299]], ["4xx", [400, 499]], ["5xx", [500, 599]], ["other", [100, 199, 300, 399]], ["none", [null]], ["error", [null, 100, 302, 499, 500]]]) for (const code of codes) test(`status ${status} includes ${code}`, () => assert.equal(matchesLogFilters({ ...log, status_code: code }, { status }), true));
test("missing durations never pass a numeric threshold", () => assert.equal(matchesLogFilters({ ...log, duration_ms: null }, { minDurationMs: "0" }), false));
const ui = setupDOM(); after(() => ui.close());
test("drill-down preserves exact server timestamps and token identity", () => { navigateToLogs(all); assert.equal(window.location.hash, "#logs"); assert.deepEqual(readLogDrilldown(), all); });
test("listLogs sends all filters, with cursors kept separate", async () => {
  let url; globalThis.fetch = async (path) => { url = path; return jsonResponse({ items: [] }); };
  const { listLogs } = loadTS("web/src/api.ts"); await listLogs({ ...all, limit: 20, beforeCreatedAt: "2026-09-23 01:00:00", beforeId: 5 });
  const query = new URL(url, "http://localhost").searchParams; for (const [key, value] of logFilterQuery(all)) assert.equal(query.get(key), value); assert.equal(query.get("before_id"), "5");
});
test("SSE reconnects on filter changes, clears buffered rows, and stale list responses are ignored", () => { const stream = read("web/src/useLogStream.ts"), page = read("web/src/pages/LogsPage.tsx"); assert.match(stream, /\[enabled, filterQuery\]/); assert.match(stream, /setState\(\{ logs: \[\]/); assert.match(page, /version !== requestVersion.current/); assert.match(page, /matchesLogFilters\(log, filters\)/); });
test("clearing drill-down filters clears sessionStorage so refresh does not resurrect old search", () => { navigateToLogs({ search: "10086", start: "2026-09-23T00:00:00Z" }); assert.equal(readLogDrilldown().search, "10086"); saveLogDrilldown({ search: "" }); assert.equal(readLogDrilldown().search, undefined); clearLogDrilldown(); assert.deepEqual(readLogDrilldown(), {}); });
