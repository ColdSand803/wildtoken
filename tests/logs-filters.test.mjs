import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notEqual(start, -1, name + " 不在源码里");
  const asyncPrefix = "async ";
  const declarationStart = source.startsWith(asyncPrefix, start - asyncPrefix.length)
    ? start - asyncPrefix.length
    : start;

  let paramDepth = 0;
  let paramEnd = -1;
  for (let i = start + ("function " + name).length; i < source.length; i += 1) {
    if (source[i] === "(") paramDepth += 1;
    else if (source[i] === ")") {
      paramDepth -= 1;
      if (paramDepth === 0) {
        paramEnd = i;
        break;
      }
    }
  }
  const bodyStart = source.indexOf("{", paramEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(declarationStart, index + 1);
      }
    }
  }
  throw new Error(name + " 的函数体没有闭合");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

/* 耗时瀑布现在由 static/js/components.js 的公共分段条渲染，
   formatLogDetailMeta 直接依赖这几个全局函数，得一起装进沙箱。 */
function installTimingHelpers(context, logsSource) {
  const componentsSource = read("static/js/components.js");
  for (const name of ["wtTipAttribute", "wtSegment", "wtSegmentBar"]) {
    vm.runInContext(extractFunction(componentsSource, name), context);
  }
  for (const name of ["formatLogTimingChips", "formatLogTimingBar"]) {
    vm.runInContext(extractFunction(logsSource, name), context);
  }
}

function formatSeconds(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) return "-";
  const n = Number(ms);
  if (n < 1000) return `${Math.round(n)}ms`;
  return `${(n / 1000).toFixed(2)}s`;
}

function firstTokenTone(ms) {
  if (ms === null || ms === undefined) return "neutral";
  if (ms < 500) return "ok";
  if (ms < 2000) return "warning";
  return "danger";
}

function totalDurationRating(log) {
  return { tone: "neutral", basis: "耗时评估" };
}

test("admin.html contains log range badge, stream filter select, and min duration input", () => {
  const markup = read("static/admin.html");
  assert.ok(markup.includes('id="log-range-filter-badge"'), "log range badge exists");
  assert.ok(markup.includes('id="log-range-filter-name"'), "log range name container exists");
  assert.ok(markup.includes('id="log-range-filter-clear"'), "log range clear button exists");
  assert.ok(markup.includes('id="log-stream-filter"'), "stream filter select exists");
  assert.ok(markup.includes('id="log-min-duration"'), "min duration input exists");
});

test("bootstrap.js manages setLogTimeRange, getLogTimeRange, clearLogTimeRange, and updates badge correctly", () => {
  const source = read("static/js/bootstrap.js");
  const badgeEl = { hidden: true };
  const nameEl = { textContent: "" };
  const tokenBadgeEl = { hidden: true };
  const tokenNameEl = { textContent: "" };

  const context = vm.createContext({
    logRangeFilterBadge: badgeEl,
    logRangeFilterName: nameEl,
    logTokenFilterBadge: tokenBadgeEl,
    logTokenFilterName: tokenNameEl,
    logDownstreamTokenId: null,
    logDownstreamTokenName: "",
    logRangeStart: "",
    logRangeEnd: "",
    logRangeLabel: "",
  });

  vm.runInContext(extractFunction(source, "updateLogFilterChips"), context);
  vm.runInContext(extractFunction(source, "setLogTimeRange"), context);
  vm.runInContext(extractFunction(source, "getLogTimeRange"), context);
  vm.runInContext(extractFunction(source, "clearLogTimeRange"), context);

  // Set time range
  vm.runInContext('setLogTimeRange("2026-08-18T00:00:00Z", "2026-08-19T00:00:00Z", "今天")', context);
  assert.equal(badgeEl.hidden, false);
  assert.equal(nameEl.textContent, "今天");
  const current = vm.runInContext("getLogTimeRange()", context);
  assert.equal(current.start, "2026-08-18T00:00:00Z");
  assert.equal(current.end, "2026-08-19T00:00:00Z");
  assert.equal(current.label, "今天");

  // Clear time range
  vm.runInContext("clearLogTimeRange()", context);
  assert.equal(badgeEl.hidden, true);
  assert.equal(nameEl.textContent, "");
  const cleared = vm.runInContext("getLogTimeRange()", context);
  assert.equal(cleared.start, "");
  assert.equal(cleared.end, "");
  assert.equal(cleared.label, "");
});

test("drillDownToLogs correctly inherits resolved_start and resolved_end from dashboardOverview", () => {
  const source = read("static/js/dashboard.js");
  let switchedView = "";
  let restartedStream = false;
  let receivedRange = null;

  const context = vm.createContext({
    dashboardOverview: {
      resolved_start: "2026-08-18T00:00:00Z",
      resolved_end: "2026-08-18T23:59:59Z",
    },
    dashboardTimeRange: "today",
    getTimeRangeLabel: (range) => range === "today" ? "今天" : range,
    setLogDownstreamTokenId: () => {},
    setLogTimeRange: (start, end, label) => {
      receivedRange = { start, end, label };
    },
    logSearchInput: { value: "old" },
    logUpstreamFilter: { value: "old" },
    logStatusFilter: { value: "old" },
    logClientFilter: { value: "old" },
    logStreamFilter: { value: "old" },
    logMinDurationInput: { value: "old" },
    resetLogPagination: () => {},
    switchView: (view) => { switchedView = view; },
    restartLogStream: () => { restartedStream = true; },
  });

  vm.runInContext(extractFunction(source, "drillDownToLogs"), context);

  vm.runInContext('drillDownToLogs({ status: "error" })', context);

  assert.equal(switchedView, "logs");
  assert.equal(restartedStream, true);
  assert.equal(receivedRange.start, "2026-08-18T00:00:00Z");
  assert.equal(receivedRange.end, "2026-08-18T23:59:59Z");
  assert.equal(receivedRange.label, "今天");
  assert.equal(context.logStatusFilter.value, "error");
  assert.equal(context.logStreamFilter.value, "");
  assert.equal(context.logMinDurationInput.value, "");
});

test("drillDownToLogs handles custom bucket start and end accurately", () => {
  const source = read("static/js/dashboard.js");
  let receivedRange = null;

  const context = vm.createContext({
    dashboardOverview: {
      resolved_start: "2026-08-18T00:00:00Z",
      resolved_end: "2026-08-19T00:00:00Z",
    },
    setLogDownstreamTokenId: () => {},
    setLogTimeRange: (start, end, label) => {
      receivedRange = { start, end, label };
    },
    logSearchInput: { value: "" },
    logUpstreamFilter: { value: "" },
    logStatusFilter: { value: "" },
    logClientFilter: { value: "" },
    logStreamFilter: { value: "" },
    logMinDurationInput: { value: "" },
    resetLogPagination: () => {},
    switchView: () => {},
    restartLogStream: () => {},
  });

  vm.runInContext(extractFunction(source, "drillDownToLogs"), context);

  // Custom bucket override
  vm.runInContext(`drillDownToLogs({
    status: "error",
    start: "2026-08-18T10:00:00Z",
    end: "2026-08-18T11:00:00Z",
    rangeLabel: "10:00 - 11:00"
  })`, context);

  assert.equal(receivedRange.start, "2026-08-18T10:00:00Z");
  assert.equal(receivedRange.end, "2026-08-18T11:00:00Z");
  assert.equal(receivedRange.label, "10:00 - 11:00");
});

test("drillDownToLogs clears time range when dashboard overview range=all (resolved is null)", () => {
  const source = read("static/js/dashboard.js");
  let receivedRange = null;

  const context = vm.createContext({
    dashboardOverview: {
      resolved_start: null,
      resolved_end: null,
    },
    dashboardTimeRange: "all",
    getTimeRangeLabel: () => "全部历史",
    setLogDownstreamTokenId: () => {},
    setLogTimeRange: (start, end, label) => {
      receivedRange = { start, end, label };
    },
    logSearchInput: { value: "" },
    logUpstreamFilter: { value: "" },
    logStatusFilter: { value: "" },
    logClientFilter: { value: "" },
    logStreamFilter: { value: "" },
    logMinDurationInput: { value: "" },
    resetLogPagination: () => {},
    switchView: () => {},
    restartLogStream: () => {},
  });

  vm.runInContext(extractFunction(source, "drillDownToLogs"), context);

  vm.runInContext('drillDownToLogs({ upstreamId: "3" })', context);

  assert.equal(receivedRange.start, "");
  assert.equal(receivedRange.end, "");
  assert.equal(receivedRange.label, "");
});

test("logMatchesTimeRange correctly handles [start, end) interval with ISO and SQLite UTC strings", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, "parseUtcDateMs"), context);
  vm.runInContext(extractFunction(source, "logMatchesTimeRange"), context);

  const startIso = "2026-08-18T10:00:00Z";
  const endIso = "2026-08-18T11:00:00Z";

  // Inside interval [10:00, 11:00)
  assert.equal(
    vm.runInContext(`logMatchesTimeRange("2026-08-18 10:00:00", "${startIso}", "${endIso}")`, context),
    true,
    "start boundary is inclusive"
  );
  assert.equal(
    vm.runInContext(`logMatchesTimeRange("2026-08-18 10:30:00", "${startIso}", "${endIso}")`, context),
    true,
    "middle point is inside"
  );

  // Exact end boundary is exclusive [start, end)
  assert.equal(
    vm.runInContext(`logMatchesTimeRange("2026-08-18 11:00:00", "${startIso}", "${endIso}")`, context),
    false,
    "end boundary is exclusive"
  );

  // Outside
  assert.equal(
    vm.runInContext(`logMatchesTimeRange("2026-08-18 09:59:59", "${startIso}", "${endIso}")`, context),
    false,
    "before start is outside"
  );
  assert.equal(
    vm.runInContext(`logMatchesTimeRange("2026-08-18 11:00:01", "${startIso}", "${endIso}")`, context),
    false,
    "after end is outside"
  );
});

test("logMatchesCurrentFilters handles stream, min_duration_ms, and token filters", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({
    escapeHtml,
    logUpstreamFilter: { value: "" },
    logSearchInput: { value: "" },
    logStatusFilter: { value: "" },
    logClientFilter: { value: "" },
    logStreamFilter: { value: "" },
    logMinDurationInput: { value: "" },
    getLogDownstreamTokenId: () => null,
    getLogTimeRange: () => ({ start: "", end: "" }),
  });

  vm.runInContext(extractFunction(source, "parseUtcDateMs"), context);
  vm.runInContext(extractFunction(source, "logMatchesTimeRange"), context);
  vm.runInContext(extractFunction(source, "logMatchesStatusFilter"), context);
  vm.runInContext(extractFunction(source, "logMatchesSearchFilter"), context);
  vm.runInContext(extractFunction(source, "logMatchesCurrentFilters"), context);

  const streamLog = { id: 1, stream: true, duration_ms: 1500, downstream_token_id: 10, status_code: 200 };
  const nonStreamLog = { id: 2, stream: false, duration_ms: 400, downstream_token_id: 20, status_code: 200 };
  const nullDurationLog = { id: 3, stream: true, duration_ms: null, downstream_token_id: 10, status_code: 504 };

  context.streamLog = streamLog;
  context.nonStreamLog = nonStreamLog;
  context.nullDurationLog = nullDurationLog;

  // 1. Stream filter = true
  context.logStreamFilter.value = "true";
  assert.equal(vm.runInContext("logMatchesCurrentFilters(streamLog)", context), true);
  assert.equal(vm.runInContext("logMatchesCurrentFilters(nonStreamLog)", context), false);

  // 2. Stream filter = false
  context.logStreamFilter.value = "false";
  assert.equal(vm.runInContext("logMatchesCurrentFilters(streamLog)", context), false);
  assert.equal(vm.runInContext("logMatchesCurrentFilters(nonStreamLog)", context), true);
  context.logStreamFilter.value = "";

  // 3. Min duration filter >= 1000ms
  context.logMinDurationInput.value = "1000";
  assert.equal(vm.runInContext("logMatchesCurrentFilters(streamLog)", context), true);
  assert.equal(vm.runInContext("logMatchesCurrentFilters(nonStreamLog)", context), false);
  assert.equal(vm.runInContext("logMatchesCurrentFilters(nullDurationLog)", context), false, "null duration cannot match min_duration_ms");
  context.logMinDurationInput.value = "";

  // 4. Downstream token ID filter = 10
  context.getLogDownstreamTokenId = () => 10;
  assert.equal(vm.runInContext("logMatchesCurrentFilters(streamLog)", context), true);
  assert.equal(vm.runInContext("logMatchesCurrentFilters(nonStreamLog)", context), false);
  assert.equal(vm.runInContext("logMatchesCurrentFilters(nullDurationLog)", context), true);
  context.getLogDownstreamTokenId = () => null;
});

test("loadLogs constructs query params including start, end, stream, min_duration_ms, and downstream_token_id", async () => {
  const source = read("static/js/logs.js");
  const calls = [];

  const context = vm.createContext({
    URLSearchParams,
    logLoadGeneration: 0,
    logLoadInFlight: false,
    logLoadQueued: false,
    logsLoadedOnce: true,
    logsLoading: false,
    logPageSize: 50,
    logHasMore: false,
    logNextCursor: null,
    logPageItems: [],
    logPageFiltersActive: false,
    logStreamPendingEntries: [],
    logUpstreamFilter: { value: "2" },
    logSearchInput: { value: "claude-3" },
    logStatusFilter: { value: "error" },
    logClientFilter: { value: "web" },
    logStreamFilter: { value: "true" },
    logMinDurationInput: { value: "3000" },
    getLogDownstreamTokenId: () => 42,
    getLogTimeRange: () => ({ start: "2026-08-18T00:00:00Z", end: "2026-08-19T00:00:00Z" }),
    appendLogPaginationParams: (params) => {},
    renderLogRows: () => {},
    renderCurrentLogPage: () => {},
    normalizeLogCursor: (c) => c,
    isOnLatestLogPage: () => true,
    clearLogNewEntriesNotice: () => {},
    updateLogRates: () => {},
    updateLogPaginationControls: () => {},
    renderUpstreamSummary: () => {},
    setStatus: () => {},
    flushLogStreamEntries: () => {},
    api: async (url) => {
      calls.push(url);
      return { logs: [], total: 0, page: 1, limit: 50 };
    },
  });

  vm.runInContext(extractFunction(source, "loadLogs"), context);
  await vm.runInContext("loadLogs()", context);

  assert.equal(calls.length, 1);
  const url = calls[0];
  assert.ok(url.includes("upstream_id=2"), "includes upstream_id");
  assert.ok(url.includes("downstream_token_id=42"), "includes downstream_token_id");
  assert.ok(url.includes("search=claude-3"), "includes search");
  assert.ok(url.includes("status=error"), "includes status");
  assert.ok(url.includes("client_type=web"), "includes client_type");
  assert.ok(url.includes("stream=true"), "includes stream=true");
  assert.ok(url.includes("min_duration_ms=3000"), "includes min_duration_ms=3000");
  assert.ok(url.includes("start=2026-08-18T00%3A00%3A00Z") || url.includes("start=2026-08-18T00:00:00Z"), "includes start");
  assert.ok(url.includes("end=2026-08-19T00%3A00%3A00Z") || url.includes("end=2026-08-19T00:00:00Z"), "includes end");
});

test("openLogStream constructs query params with new filter options", async () => {
  const source = read("static/js/logs.js");
  const fetchCalls = [];

  const context = vm.createContext({
    URLSearchParams,
    Headers,
    LOG_STREAM_PATH: "/api/admin/logs/stream",
    getAdminToken: () => "test-token",
    logUpstreamFilter: { value: "5" },
    logSearchInput: { value: "gpt-4o" },
    logStatusFilter: { value: "5xx" },
    logClientFilter: { value: "api" },
    logStreamFilter: { value: "false" },
    logMinDurationInput: { value: "5000" },
    getLogDownstreamTokenId: () => 99,
    getLogTimeRange: () => ({ start: "2026-08-18T00:00:00Z", end: "2026-08-19T00:00:00Z" }),
    fetch: async (path, options) => {
      fetchCalls.push({ path, options });
      return { ok: false, status: 500 };
    },
    getLogStreamErrorMessage: async () => "error",
    logStreamController: null,
    controller: { signal: {} },
  });

  vm.runInContext(extractFunction(source, "openLogStream"), context);
  await vm.runInContext("openLogStream(controller)", context);

  assert.equal(fetchCalls.length, 1);
  const path = fetchCalls[0].path;
  assert.ok(path.includes("upstream_id=5"), "stream includes upstream_id");
  assert.ok(path.includes("downstream_token_id=99"), "stream includes downstream_token_id");
  assert.ok(path.includes("search=gpt-4o"), "stream includes search");
  assert.ok(path.includes("status=5xx"), "stream includes status");
  assert.ok(path.includes("client_type=api"), "stream includes client_type");
  assert.ok(path.includes("stream=false"), "stream includes stream=false");
  assert.ok(path.includes("min_duration_ms=5000"), "stream includes min_duration_ms=5000");
  assert.ok(path.includes("start=2026-08-18T00%3A00%3A00Z") || path.includes("start=2026-08-18T00:00:00Z"), "stream includes start");
  assert.ok(path.includes("end=2026-08-19T00%3A00%3A00Z") || path.includes("end=2026-08-19T00:00:00Z"), "stream includes end");
});

test("enhancements.css defines 4-stage timing waterfall styles and retry attempt badge", () => {
  const css = read("static/css/enhancements.css");
  assert.ok(css.includes(".timing-seg--gateway"), "has gateway timing segment CSS");
  assert.ok(css.includes(".timing-seg--headers"), "has headers timing segment CSS");
  assert.ok(css.includes(".timing-seg--generation"), "has generation timing segment CSS");
  assert.ok(css.includes(".timing-seg--ttfb"), "has legacy ttfb timing segment CSS");
  assert.ok(css.includes(".timing-seg--transfer"), "has transfer timing segment CSS");
  assert.ok(css.includes(".log-detail-route-attempt"), "has attempt badge CSS");
});

test("formatGatewayPrepTime and formatHeadersArrivalTime handle timings, attempt states, and missing values safely", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({
    escapeHtml,
    formatSeconds,
  });

  vm.runInContext(extractFunction(source, "formatGatewayPrepTime"), context);
  vm.runInContext(extractFunction(source, "formatHeadersArrivalTime"), context);

  // Gateway prep attempt 0
  const gw0 = vm.runInContext("formatGatewayPrepTime(120, 0)", context);
  assert.ok(gw0.includes("120ms"), "shows ms for gateway prep");
  assert.ok(gw0.includes("网关准备 120ms"), "title is clean gateway prep");

  // Gateway prep attempt > 0 (retry)
  const gwRetry = vm.runInContext("formatGatewayPrepTime(350, 1)", context);
  assert.ok(gwRetry.includes("350ms"), "shows ms for retry gateway prep");
  assert.ok(gwRetry.includes("网关准备（含前序重试与退避） 350ms"), "title mentions retries and backoff");

  // Gateway prep missing
  const gwNull = vm.runInContext("formatGatewayPrepTime(null, 0)", context);
  assert.ok(gwNull.includes("不可用"), "marks missing gateway prep as unavailable");

  // Headers arrival
  const hdrOk = vm.runInContext("formatHeadersArrivalTime(200)", context);
  assert.ok(hdrOk.includes("200ms"), "shows ms for headers arrival");
  assert.ok(hdrOk.includes("连接与响应头 200ms"), "title is connection and headers");

  // Headers arrival missing
  const hdrNull = vm.runInContext("formatHeadersArrivalTime(null)", context);
  assert.ok(hdrNull.includes("不可用"), "marks missing headers arrival as unavailable");
});

test("formatLogDetailMeta renders full 4-stage streaming waterfall with accurate math and styles", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({
    escapeHtml,
    formatSeconds,
    firstTokenTone,
    totalDurationRating,
    formatLogChannelLabel: (detail) => detail.upstream_name || "未知渠道",
    formatLogModelText: (detail) => detail.model || "未知模型",
    formatReasoningEffort: () => "",
    extractLogDetailError: (detail) => detail.error || null,
    formatTotalDurationTime: (log) => `<span class="duration-time">${formatSeconds(log?.duration_ms)}</span>`,
    formatTokensPerSecondLine: () => "",
    formatTokenDetailPanel: () => "<span>Token Panel</span>",
  });

  vm.runInContext(extractFunction(source, "formatFirstTokenTime"), context);
  vm.runInContext(extractFunction(source, "formatGatewayPrepTime"), context);
  vm.runInContext(extractFunction(source, "formatHeadersArrivalTime"), context);
  installTimingHelpers(context, source);
  vm.runInContext(extractFunction(source, "formatLogDetailMeta"), context);

  // 4-stage stream log:
  // pre_upstream_ms = 50
  // upstream_headers_ms = 100
  // first_token_ms = 300
  // duration_ms = 1000
  // attempt_index = 0
  // fullTotal = 1050ms
  // Gateway = 50ms (4.8%)
  // Headers = 100ms (9.5%)
  // Generation = 200ms (19.0%)
  // Transfer = 700ms (66.7%)
  const streamDetail = {
    method: "POST",
    path: "/v1/chat/completions",
    stream: true,
    pre_upstream_ms: 50,
    upstream_headers_ms: 100,
    first_token_ms: 300,
    duration_ms: 1000,
    attempt_index: 0,
    upstream_name: "Channel 1",
    model: "claude-3-5-sonnet",
    status_code: 200,
  };
  context.streamDetail = streamDetail;
  const markup = vm.runInContext("formatLogDetailMeta(streamDetail)", context);

  assert.ok(markup.includes("网关准备"), "has gateway label");
  assert.ok(markup.includes("连接/Header"), "has headers label");
  assert.ok(markup.includes("上游生成"), "has generation label");
  assert.ok(markup.includes("传输"), "has transfer label");
  assert.ok(markup.includes("总耗时"), "has total duration label");

  assert.ok(markup.includes("log-detail-timing-bar"), "has timing bar");
  assert.ok(markup.includes("timing-seg--gateway"), "has gateway timing segment");
  assert.ok(markup.includes("timing-seg--headers"), "has headers timing segment");
  assert.ok(markup.includes("timing-seg--generation"), "has generation timing segment");
  assert.ok(markup.includes("timing-seg--transfer"), "has transfer timing segment");

  assert.ok(markup.includes("width:4.8%"), "gateway is 50/1050 = 4.8%");
  assert.ok(markup.includes("width:9.5%"), "headers is 100/1050 = 9.5%");
  assert.ok(markup.includes("width:19.0%"), "generation is 200/1050 = 19.0%");
  assert.ok(markup.includes("width:66.7%"), "transfer is 700/1050 = 66.7%");
});

test("formatLogDetailMeta handles retry attempt badges and custom gateway preparation copy", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({
    escapeHtml,
    formatSeconds,
    firstTokenTone,
    totalDurationRating,
    formatLogChannelLabel: (detail) => detail.upstream_name || "未知渠道",
    formatLogModelText: (detail) => detail.model || "未知模型",
    formatReasoningEffort: () => "",
    extractLogDetailError: (detail) => detail.error || null,
    formatTotalDurationTime: (log) => `<span class="duration-time">${formatSeconds(log?.duration_ms)}</span>`,
    formatTokensPerSecondLine: () => "",
    formatTokenDetailPanel: () => "<span>Token Panel</span>",
  });

  vm.runInContext(extractFunction(source, "formatFirstTokenTime"), context);
  vm.runInContext(extractFunction(source, "formatGatewayPrepTime"), context);
  vm.runInContext(extractFunction(source, "formatHeadersArrivalTime"), context);
  installTimingHelpers(context, source);
  vm.runInContext(extractFunction(source, "formatLogDetailMeta"), context);

  const retriedDetail = {
    method: "POST",
    path: "/v1/chat/completions",
    stream: true,
    pre_upstream_ms: 120,
    upstream_headers_ms: 80,
    first_token_ms: 280,
    duration_ms: 800,
    attempt_index: 2,
    request_uid: "req-uid-xyz-789",
    upstream_name: "Channel 2",
    model: "claude-3-5-sonnet",
    status_code: 200,
  };
  context.retriedDetail = retriedDetail;
  const markup = vm.runInContext("formatLogDetailMeta(retriedDetail)", context);

  assert.ok(markup.includes("网关准备(含重试)"), "gateway label indicates retry");
  assert.ok(markup.includes("重试 #2"), "route card shows attempt index badge");
  assert.ok(markup.includes("req-uid-xyz-789"), "attempt badge references request UID");
  assert.ok(markup.includes("log-detail-route-attempt"), "uses attempt badge styling");
});

test("formatLogDetailMeta renders non-streaming logs with sampled gateway and connection timings", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({
    escapeHtml,
    formatSeconds,
    firstTokenTone,
    totalDurationRating,
    formatLogChannelLabel: (detail) => detail.upstream_name || "未知渠道",
    formatLogModelText: (detail) => detail.model || "未知模型",
    formatReasoningEffort: () => "",
    extractLogDetailError: (detail) => detail.error || null,
    formatTotalDurationTime: (log) => `<span class="duration-time">${formatSeconds(log?.duration_ms)}</span>`,
    formatTokensPerSecondLine: () => "",
    formatTokenDetailPanel: () => "<span>Token Panel</span>",
  });

  vm.runInContext(extractFunction(source, "formatFirstTokenTime"), context);
  vm.runInContext(extractFunction(source, "formatGatewayPrepTime"), context);
  vm.runInContext(extractFunction(source, "formatHeadersArrivalTime"), context);
  installTimingHelpers(context, source);
  vm.runInContext(extractFunction(source, "formatLogDetailMeta"), context);

  // Non-stream log:
  // pre_upstream_ms = 40
  // upstream_headers_ms = 160
  // duration_ms = 600
  // attempt_index = 0
  // fullTotal = 640ms
  // Gateway = 40ms (6.3%)
  // Headers = 160ms (25.0%)
  // Response transfer = 440ms (68.8%)
  const nonStreamDetail = {
    method: "POST",
    path: "/v1/chat/completions",
    stream: false,
    pre_upstream_ms: 40,
    upstream_headers_ms: 160,
    first_token_ms: null,
    duration_ms: 600,
    attempt_index: 0,
    upstream_name: "Channel 1",
    model: "gpt-4o",
    status_code: 200,
  };
  context.nonStreamDetail = nonStreamDetail;
  const markup = vm.runInContext("formatLogDetailMeta(nonStreamDetail)", context);

  assert.ok(markup.includes("网关准备"), "shows gateway prep");
  assert.ok(markup.includes("连接/Header"), "shows headers");
  assert.ok(markup.includes("响应传输"), "shows response transfer");
  assert.ok(markup.includes("总耗时"), "shows total duration");
  assert.ok(!markup.includes("首字"), "non-stream does not mention first token");
  assert.ok(!markup.includes("上游生成"), "non-stream does not mention upstream generation");

  assert.ok(markup.includes("log-detail-timing-bar"), "has timing bar");
  assert.ok(markup.includes("timing-seg--gateway"), "has gateway segment");
  assert.ok(markup.includes("timing-seg--headers"), "has headers segment");
  assert.ok(markup.includes("timing-seg--transfer"), "has transfer segment");
  assert.ok(markup.includes("width:6.3%"), "gateway is 40/640 = 6.3%");
  assert.ok(markup.includes("width:25.0%"), "headers is 160/640 = 25.0%");
  assert.ok(markup.includes("width:68.8%"), "transfer is 440/640 = 68.8%");
});

test("formatLogDetailMeta degrades gracefully to legacy 2-stage or missing samples", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({
    escapeHtml,
    formatSeconds,
    firstTokenTone,
    totalDurationRating,
    formatLogChannelLabel: (detail) => detail.upstream_name || "未知渠道",
    formatLogModelText: (detail) => detail.model || "未知模型",
    formatReasoningEffort: () => "",
    extractLogDetailError: (detail) => detail.error || null,
    formatTotalDurationTime: (log) => `<span class="duration-time">${formatSeconds(log?.duration_ms)}</span>`,
    formatTokensPerSecondLine: () => "",
    formatTokenDetailPanel: () => "<span>Token Panel</span>",
  });

  vm.runInContext(extractFunction(source, "formatFirstTokenTime"), context);
  vm.runInContext(extractFunction(source, "formatGatewayPrepTime"), context);
  vm.runInContext(extractFunction(source, "formatHeadersArrivalTime"), context);
  installTimingHelpers(context, source);
  vm.runInContext(extractFunction(source, "formatLogDetailMeta"), context);

  // 1. Stream log with legacy format (no pre_upstream_ms or upstream_headers_ms)
  const legacyStream = {
    method: "POST",
    path: "/v1/chat/completions",
    stream: true,
    first_token_ms: 200,
    duration_ms: 1000,
    upstream_name: "Channel 1",
    model: "claude-3-5-sonnet",
    status_code: 200,
  };
  context.legacyStream = legacyStream;
  const markup1 = vm.runInContext("formatLogDetailMeta(legacyStream)", context);
  assert.ok(markup1.includes("首字"), "legacy stream has first token label");
  assert.ok(markup1.includes("传输"), "legacy stream has transfer label");
  assert.ok(markup1.includes("timing-seg--ttfb"), "legacy stream uses TTFB segment");
  assert.ok(markup1.includes("timing-seg--transfer"), "legacy stream uses transfer segment");
  assert.ok(markup1.includes("width:20.0%"), "legacy TTFB width 20.0%");

  // 2. Stream log with partial missing samples (pre_upstream present, but headers missing)
  const partialMissingStream = {
    method: "POST",
    path: "/v1/chat/completions",
    stream: true,
    pre_upstream_ms: 20,
    upstream_headers_ms: null,
    first_token_ms: null,
    duration_ms: 5000,
    upstream_name: "Channel 1",
    model: "claude-3-5-sonnet",
    status_code: 504,
  };
  context.partialMissingStream = partialMissingStream;
  const markup2 = vm.runInContext("formatLogDetailMeta(partialMissingStream)", context);
  assert.ok(markup2.includes("不可用"), "marks missing samples as unavailable");

  // 3. Legacy non-stream log (no timing bar, just total duration)
  const legacyNonStream = {
    method: "POST",
    path: "/v1/chat/completions",
    stream: false,
    first_token_ms: null,
    duration_ms: 500,
    upstream_name: "Channel 1",
    model: "gpt-4o",
    status_code: 200,
  };
  context.legacyNonStream = legacyNonStream;
  const markup3 = vm.runInContext("formatLogDetailMeta(legacyNonStream)", context);
  assert.ok(!markup3.includes("log-detail-timing-bar"), "legacy non-stream does not show timing bar");
  assert.ok(markup3.includes("总耗时"), "legacy non-stream shows total duration");
});

test("clearLogFilters clears all new filters including time range, stream, and min duration", () => {
  const source = read("static/js/shell.js");
  let timeRangeCleared = false;
  let tokenCleared = false;
  let paginationReset = false;
  let logsLoaded = false;

  const context = vm.createContext({
    logSearchInput: { value: "test" },
    logUpstreamFilter: { value: "1" },
    logStatusFilter: { value: "4xx" },
    logClientFilter: { value: "web" },
    logStreamFilter: { value: "true" },
    logMinDurationInput: { value: "2000" },
    clearLogTimeRange: () => { timeRangeCleared = true; },
    setLogDownstreamTokenId: (id) => { if (id === null) tokenCleared = true; },
    resetLogPagination: () => { paginationReset = true; },
    loadLogs: () => { logsLoaded = true; },
    restartLogStream: () => {},
  });

  vm.runInContext(extractFunction(source, "clearLogFilters"), context);
  vm.runInContext("clearLogFilters()", context);

  assert.equal(context.logSearchInput.value, "");
  assert.equal(context.logUpstreamFilter.value, "");
  assert.equal(context.logStatusFilter.value, "");
  assert.equal(context.logClientFilter.value, "");
  assert.equal(context.logStreamFilter.value, "");
  assert.equal(context.logMinDurationInput.value, "");
  assert.equal(timeRangeCleared, true);
  assert.equal(tokenCleared, true);
  assert.equal(paginationReset, true);
  assert.equal(logsLoaded, true);
});
