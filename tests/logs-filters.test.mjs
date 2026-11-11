import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadTS, read, setupDOM, jsonResponse, renderStatic, h, feedbackStub } from "./react-harness.mjs";
const { logFilterQuery, matchesLogFilters, matchesActiveLogFilters, navigateToLogs, readLogDrilldown, saveLogDrilldown, clearLogDrilldown } = loadTS("web/src/logFilters.ts");
const log = { id: 4, created_at: "2026-09-23 01:00:00", upstream_id: 2, downstream_token_id: 7, client_type: "pi", status_code: 200, stream: 1, duration_ms: 1000, model: "gpt-5", client_ip: "192.0.2.1" };
const all = { search: " gpt ", clientType: "pi", status: "2xx", upstreamId: "2", tokenId: "7", start: "2026-09-23T00:00:00Z", end: "2026-09-23T02:00:00Z", stream: "true", minDurationMs: "0" };
test("all advanced fields serialize to the backend list/SSE contract, including zero", () => assert.deepEqual(Object.fromEntries(logFilterQuery(all)), { search: "gpt", client_type: "pi", status: "2xx", upstream_id: "2", downstream_token_id: "7", start: all.start, end: all.end, stream: "true", min_duration_ms: "0" }));
for (const [filters, expected] of [[{}, true], [all, true], [{ upstreamId: "9" }, false], [{ tokenId: "8" }, false], [{ clientType: "claude" }, false], [{ stream: "false" }, false], [{ minDurationMs: "1001" }, false], [{ minDurationMs: "1000" }, true], [{ search: "192.0.2" }, true], [{ search: "no-match" }, false], [{ start: "2026-09-23T02:00:00Z" }, false], [{ end: "2026-09-23T01:00:00Z" }, false], [{ start: "2026-09-23T09:00:00+08:00" }, true]]) test(`loaded and streamed rows agree with ${JSON.stringify(filters)}`, () => assert.equal(matchesLogFilters(log, filters), expected));
for (const [status, codes] of [["2xx", [200, 299]], ["4xx", [400, 499]], ["5xx", [500, 599]], ["other", [100, 199, 300, 399]], ["none", [null]], ["error", [null, 100, 302, 500]]]) for (const code of codes) test(`status ${status} includes ${code}`, () => assert.equal(matchesLogFilters({ ...log, status_code: code }, { status }), true));
test("missing durations never pass a numeric threshold", () => assert.equal(matchesLogFilters({ ...log, duration_ms: null }, { minDurationMs: "0" }), false));
const ui = setupDOM(); after(() => ui.close());
test("drill-down preserves exact server timestamps and token identity", () => { navigateToLogs(all); assert.equal(window.location.hash, "#logs"); assert.deepEqual(readLogDrilldown(), all); });
test("listLogs sends all filters, with cursors kept separate", async () => {
  let url; globalThis.fetch = async (path) => { url = path; return jsonResponse({ items: [] }); };
  const { listLogs } = loadTS("web/src/api.ts"); await listLogs({ ...all, limit: 20, beforeCreatedAt: "2026-09-23 01:00:00", beforeId: 5 });
  const query = new URL(url, "http://localhost").searchParams; for (const [key, value] of logFilterQuery(all)) assert.equal(query.get(key), value); assert.equal(query.get("before_id"), "5");
});
test("SSE reconnects on filter changes, clears buffered rows, and stale list responses are ignored", () => { const stream = read("web/src/useLogStream.ts"), page = read("web/src/pages/LogsPage.tsx"); assert.match(stream, /\[enabled, filterQuery\]/); assert.match(stream, /setState\(\{ logs: \[\]/); assert.match(page, /request !== loadRequest\.current/); assert.match(page, /matchesLogFilters\(log, filters\)/); });
test("clearing drill-down filters clears sessionStorage so refresh does not resurrect old search", () => { navigateToLogs({ search: "10086", start: "2026-09-23T00:00:00Z" }); assert.equal(readLogDrilldown().search, "10086"); saveLogDrilldown({ search: "" }); assert.equal(readLogDrilldown().search, undefined); clearLogDrilldown(); assert.deepEqual(readLogDrilldown(), {}); });
test("sensitive mask hides client IP alongside token and upstream name in log table and detail dialog", () => {
  const { IpCell } = loadTS("web/src/pages/LogsPage.tsx", { expose: ["IpCell"] });
  const normalHtml = renderStatic(h(IpCell, { ip: "192.0.2.1", sensitiveHidden: false }));
  assert.match(normalHtml, /192\.0\.2\.1/);
  assert.doesNotMatch(normalHtml, /\*{6}/);

  const maskedHtml = renderStatic(h(IpCell, { ip: "192.0.2.1", sensitiveHidden: true }));
  assert.doesNotMatch(maskedHtml, /192\.0\.2\.1/);
  assert.match(maskedHtml, /\*{6}/);

  const pageSource = read("web/src/pages/LogsPage.tsx");
  assert.match(pageSource, /IpCell ip=\{log\.client_ip\} sensitiveHidden=\{sensitiveHidden\}/);
  assert.match(pageSource, /IpCell ip=\{request\.client_ip\} sensitiveHidden=\{sensitiveHidden\}/);
});

test("a client cancellation remains a 4xx but is not a failed request", () => {
  const cancelled = { ...log, status_code: 499 };
  assert.equal(matchesLogFilters(cancelled, { status: "4xx" }), true);
  assert.equal(matchesLogFilters(cancelled, { status: "error" }), false);
});

const activeRequest = {
  id: 9001, started_at: "2026-09-23T01:00:00Z", elapsed_ms: 1200,
  upstream_id: 2, upstream_name: "channel", downstream_token_id: 7,
  downstream_token_name: "cli", client_type: "pi", client_ip: "192.0.2.1",
  model: "gpt-5", request_model: "gpt-5", upstream_model: "gpt-5",
};
test("in-flight filters preserve token, time and elapsed-duration drill-down", () => {
  const filters = { upstreamId: "2", tokenId: "7", clientType: "pi", status: "none",
    start: "2026-09-23T00:00:00Z", end: "2026-09-23T02:00:00Z", minDurationMs: "1200" };
  assert.equal(matchesActiveLogFilters(activeRequest, filters), true);
  for (const patch of [{ tokenId: "8" }, { minDurationMs: "1201" },
    { start: "2026-09-23T02:00:00Z" }, { end: "2026-09-23T01:00:00Z" }]) {
    assert.equal(matchesActiveLogFilters(activeRequest, { ...filters, ...patch }), false);
  }
});
test("in-flight search keeps IP filtering without borrowing registry ids or statuses", () => {
  assert.equal(matchesActiveLogFilters(activeRequest, { search: "192.0.2" }), true);
  assert.equal(matchesActiveLogFilters(activeRequest, { search: "Gpt" }), true);
  for (const search of ["9001", "200", "timeout"]) {
    assert.equal(matchesActiveLogFilters(activeRequest, { search }), false);
  }
});
test("in-flight snapshots do not invent completed status or stream metadata", () => {
  for (const status of ["2xx", "4xx", "5xx", "other", "error"]) {
    assert.equal(matchesActiveLogFilters(activeRequest, { status }), false);
  }
  for (const stream of ["true", "false"]) {
    assert.equal(matchesActiveLogFilters(activeRequest, { stream }), false);
  }
});
test("channel ID input retains saved drill-down, incoming navigation and clear actions", async () => {
  ui.cleanup();
  clearLogDrilldown();
  saveLogDrilldown({ upstreamId: "7", tokenId: "9" });
  const calls = [];
  const stream = { connected: true, logs: [], active: [], activeTotal: 0, evictedNewestId: 0 };
  const { LogsPage } = loadTS("web/src/pages/LogsPage.tsx", { overrides: {
    "web/src/api.ts": { UnauthorizedError: class extends Error {},
      listLogClientTypes: async () => [], listLogs: async (filters) => {
        calls.push(filters);
        return { items: [], has_more: false, active: [], active_total: 0 };
      } },
    "web/src/useLogStream.ts": { useLogStream: () => stream },
    "web/src/components/feedback.tsx": feedbackStub,
  } });
  const view = ui.render(h(LogsPage, { onUnauthorized() {} }));
  try {
    const channel = view.getByRole("textbox", { name: "按渠道 ID 筛选日志" });
    assert.equal(channel.value, "7");
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    assert.ok(calls.some((filters) => filters.upstreamId === "7" && filters.tokenId === "9"));
    await ui.act(async () => navigateToLogs({ upstreamId: "8", tokenId: "10" }));
    assert.equal(channel.value, "8");
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    assert.ok(calls.some((filters) => filters.upstreamId === "8" && filters.tokenId === "10"));
    await ui.act(async () => ui.fireEvent.click(view.getByRole("button", { name: "清除筛选" })));
    assert.equal(channel.value, "");
    await ui.act(async () => new Promise((resolve) => setTimeout(resolve, 450)));
    assert.equal(calls.at(-1).upstreamId, "");
    assert.deepEqual(readLogDrilldown(), {});
  } finally {
    ui.cleanup();
    clearLogDrilldown();
  }
});

test("stream overflow keeps the page capped while allowing the next page", async () => {
  ui.cleanup(); clearLogDrilldown();
  const base = { ...log, method: "POST", path: "messages", request_model: "gpt-5", upstream_model: "gpt-5",
    upstream_name: "channel", downstream_token_name: "cli", reasoning_effort: null,
    upstream_reasoning_effort: null, response_reasoning_effort: null, upstream_key_id: 0,
    upstream_key_name: "", prompt_tokens: 1, completion_tokens: 1, total_tokens: 2,
    prompt_cached_tokens: null, cache_creation_tokens: null, completion_reasoning_tokens: null,
    first_token_ms: 10, error: null, request_id: null, request_uid: null, attempt_index: null,
    pre_upstream_ms: null, upstream_headers_ms: null, failure_stage: null, failure_retryable: null, retried: false };
  const stream = { connected: true, logs: Array.from({ length: 60 }, (_, i) => ({ ...base, id: i + 1 })),
    active: [], activeTotal: 0, evictedNewestId: 0 };
  const { LogsPage } = loadTS("web/src/pages/LogsPage.tsx", { overrides: {
    "web/src/components/feedback.tsx": feedbackStub,
    "web/src/useLogStream.ts": { useLogStream: () => stream },
    "web/src/api.ts": { UnauthorizedError: class extends Error {}, listLogClientTypes: async () => [],
      listLogs: async () => ({ items: [], has_more: false, active: [], active_total: 0 }) },
  } });
  const view = ui.render(h(LogsPage, { onUnauthorized() {} }));
  try {
    await ui.waitFor(() => assert.equal(view.container.querySelectorAll("tbody > tr").length, 50));
    assert.equal(view.getByRole("button", { name: "下一页" }).disabled, false);
    ui.fireEvent.change(view.getByRole("combobox", { name: "日志每页条数" }), { target: { value: "20" } });
    await ui.waitFor(() => assert.equal(view.container.querySelectorAll("tbody > tr").length, 20));
    assert.equal(view.getByRole("button", { name: "下一页" }).disabled, false);
  } finally { ui.cleanup(); clearLogDrilldown(); }
});
