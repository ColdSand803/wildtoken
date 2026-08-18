import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  const asyncPrefix = "async ";
  const declarationStart = source.startsWith(asyncPrefix, start - asyncPrefix.length)
    ? start - asyncPrefix.length
    : start;
  let paramDepth = 0;
  let paramEnd = -1;
  for (let i = start + `function ${name}`.length; i < source.length; i += 1) {
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

  throw new Error(`could not extract ${name}`);
}

const adminHtml = read("static/admin.html");
const dashboardJs = read("static/js/dashboard.js");
const dashboardCss = read("static/css/dashboard.css");
const shellJs = read("static/js/shell.js");

test("admin.html contains refresh selector and top tokens ranking cards", () => {
  assert.ok(adminHtml.includes('id="dashboard-refresh-select"'), "refresh select exists in HTML");
  assert.ok(adminHtml.includes('id="dashboard-top-tokens"'), "top tokens requests card exists in HTML");
  assert.ok(adminHtml.includes('id="dashboard-top-token-tokens"'), "top tokens tokens card exists in HTML");
  assert.ok(adminHtml.includes('id="dashboard-tokens-meta"'), "tokens meta label exists in HTML");
  assert.ok(adminHtml.includes('id="dashboard-token-tokens-meta"'), "token tokens meta label exists in HTML");
  assert.ok(
    adminHtml.includes("核心指标、趋势分布与 Top 排行均按所选周期全量统计"),
    "dashboard scope subtitle is updated",
  );
});

test("getStatusCodeAttribution provides human-readable explanations", () => {
  const source = extractFunction(dashboardJs, "getStatusCodeAttribution");
  const context = vm.createContext({});
  vm.runInContext(`${source}; this.getStatusCodeAttribution = getStatusCodeAttribution;`, context);
  const fn = context.getStatusCodeAttribution;

  assert.match(fn(200), /200 OK/);
  assert.match(fn(400), /400 Bad Request/);
  assert.match(fn(401), /401 Unauthorized/);
  assert.match(fn(403), /403 Forbidden/);
  assert.match(fn(404), /404 Not Found/);
  assert.match(fn(429), /429 Too Many Requests/);
  assert.match(fn(500), /500 Internal Error/);
  assert.match(fn(502), /502 Bad Gateway/);
  assert.match(fn(504), /504 Gateway Timeout/);
  assert.match(fn(null), /无响应/);
});

test("cacheHitRateCard calculates hit rate and carries detailed tooltip explanation", () => {
  const formatHitRateSource = extractFunction(dashboardJs, "formatDashboardCacheHitRate");
  const formatCompactSource = extractFunction(dashboardJs, "formatCompactNumber");
  const cardSource = extractFunction(dashboardJs, "cacheHitRateCard");

  const context = vm.createContext({});
  vm.runInContext(`
    ${formatHitRateSource}
    ${formatCompactSource}
    ${cardSource}
    this.cacheHitRateCard = cacheHitRateCard;
  `, context);

  const card = context.cacheHitRateCard("缓存率", {
    prompt_cached_tokens: 300,
    prompt_tokens: 700,
  }, "最近 24 小时");

  assert.equal(card.value, "43%");
  assert.ok(card.hint.includes("命中 300 / 输入 700"));
  assert.ok(card.tooltip.includes("Prompt 缓存命中率 = 缓存命中 Token 数"));
});

test("drillDownToLogs updates log filters and switches view", () => {
  const source = extractFunction(dashboardJs, "drillDownToLogs");
  const fakeLogSearch = { value: "" };
  const fakeUpstreamFilter = { value: "" };
  const fakeStatusFilter = { value: "" };
  let switchedTo = "";
  let paginationReset = false;

  const context = vm.createContext({
    logSearchInput: fakeLogSearch,
    logUpstreamFilter: fakeUpstreamFilter,
    logStatusFilter: fakeStatusFilter,
    logClientFilter: { value: "prev" },
    resetLogPagination: () => { paginationReset = true; },
    switchView: (view) => { switchedTo = view; },
  });

  vm.runInContext(`${source}; this.drillDownToLogs = drillDownToLogs;`, context);
  context.drillDownToLogs({ search: "gpt-4o", upstreamId: "5", status: "4xx" });

  assert.equal(fakeLogSearch.value, "gpt-4o");
  assert.equal(fakeUpstreamFilter.value, "5");
  assert.equal(fakeStatusFilter.value, "4xx");
  assert.equal(switchedTo, "logs");
  assert.equal(paginationReset, true);
});

test("updateDashboardRefreshInterval persists to localStorage and resets timer", () => {
  const source = extractFunction(shellJs, "updateDashboardRefreshInterval");
  const storage = {};
  let stopped = false;
  let started = false;

  const context = vm.createContext({
    dashboardRefreshIntervalMs: 15000,
    DASHBOARD_REFRESH_KEY: "wildtoken_dashboard_refresh_interval",
    DASHBOARD_DEFAULT_REFRESH_MS: 15000,
    localStorage: {
      setItem: (k, v) => { storage[k] = String(v); },
      getItem: (k) => storage[k] ?? null,
    },
    stopDashboardRefresh: () => { stopped = true; },
    startDashboardRefresh: () => { started = true; },
    currentViewFromHash: () => "dashboard",
  });

  vm.runInContext(`${source}; this.updateDashboardRefreshInterval = updateDashboardRefreshInterval;`, context);
  context.updateDashboardRefreshInterval(30000);

  assert.equal(storage["wildtoken_dashboard_refresh_interval"], "30000");
  assert.equal(context.dashboardRefreshIntervalMs, 30000);
  assert.equal(stopped, true);
  assert.equal(started, true);
});

test("latency summary explains P50/P95/P99 quantiles in detail", () => {
  assert.ok(dashboardJs.includes("中位数耗时：50% 的请求快于此时间"), "P50 explanation present");
  assert.ok(dashboardJs.includes("95分位耗时：95% 的请求快于此时间，反映绝大多数用户的体验"), "P95 explanation present");
  assert.ok(dashboardJs.includes("99分位耗时：99% 的请求快于此时间，体现极端长尾延迟与服务毛刺"), "P99 explanation present");
});

test("dashboard CSS defines interactive drilldown, 3-column grid and refresh styling", () => {
  assert.ok(dashboardCss.includes(".dashboard-rank-row.is-clickable"), "rank row clickable style exists");
  assert.ok(dashboardCss.includes(".ops-bar-seg.is-clickable"), "status bar clickable style exists");
  assert.ok(dashboardCss.includes(".status-legend-item.is-clickable"), "legend item clickable style exists");
  assert.ok(dashboardCss.includes(".status-error-cell.is-clickable"), "error cell clickable style exists");
  assert.ok(dashboardCss.includes(".dashboard-refresh-select"), "refresh select style exists");
  assert.ok(dashboardCss.includes(".dashboard-rank-grid"), "rank grid style exists");
  assert.ok(dashboardCss.includes("@media (min-width: 1400px)"), "wide screen media query exists");
});

const logsJs = read("static/js/logs.js");
const upstreamsJs = read("static/js/upstreams.js");

test("logMatchesStatusFilter aligns all status buckets and error semantics", () => {
  const source = extractFunction(logsJs, "logMatchesStatusFilter");
  const context = vm.createContext({});
  vm.runInContext(`${source}; this.logMatchesStatusFilter = logMatchesStatusFilter;`, context);
  const fn = context.logMatchesStatusFilter;

  // empty status matches everything
  assert.equal(fn({ status_code: 200 }, ""), true);
  assert.equal(fn({ status_code: 404 }, ""), true);
  assert.equal(fn({ status_code: null }, ""), true);

  // 2xx
  assert.equal(fn({ status_code: 200 }, "2xx"), true);
  assert.equal(fn({ status_code: 204 }, "2xx"), true);
  assert.equal(fn({ status_code: 404 }, "2xx"), false);
  assert.equal(fn({ status_code: null }, "2xx"), false);

  // 4xx
  assert.equal(fn({ status_code: 400 }, "4xx"), true);
  assert.equal(fn({ status_code: 404 }, "4xx"), true);
  assert.equal(fn({ status_code: 429 }, "4xx"), true);
  assert.equal(fn({ status_code: 499 }, "4xx"), true);
  assert.equal(fn({ status_code: 200 }, "4xx"), false);
  assert.equal(fn({ status_code: 500 }, "4xx"), false);
  assert.equal(fn({ status_code: null }, "4xx"), false);

  // 5xx
  assert.equal(fn({ status_code: 500 }, "5xx"), true);
  assert.equal(fn({ status_code: 502 }, "5xx"), true);
  assert.equal(fn({ status_code: 504 }, "5xx"), true);
  assert.equal(fn({ status_code: 200 }, "5xx"), false);
  assert.equal(fn({ status_code: 404 }, "5xx"), false);
  assert.equal(fn({ status_code: null }, "5xx"), false);

  // other (1xx, 3xx)
  assert.equal(fn({ status_code: 101 }, "other"), true);
  assert.equal(fn({ status_code: 301 }, "other"), true);
  assert.equal(fn({ status_code: 302 }, "other"), true);
  assert.equal(fn({ status_code: 200 }, "other"), false);
  assert.equal(fn({ status_code: 404 }, "other"), false);
  assert.equal(fn({ status_code: null }, "other"), false);

  // none (null / missing status)
  assert.equal(fn({ status_code: null }, "none"), true);
  assert.equal(fn({ status_code: undefined }, "none"), true);
  assert.equal(fn({ status_code: "" }, "none"), true);
  assert.equal(fn({ status_code: 200 }, "none"), false);
  assert.equal(fn({ status_code: 500 }, "none"), false);

  // error (all non-2xx + none)
  assert.equal(fn({ status_code: null }, "error"), true);
  assert.equal(fn({ status_code: 400 }, "error"), true);
  assert.equal(fn({ status_code: 404 }, "error"), true);
  assert.equal(fn({ status_code: 429 }, "error"), true);
  assert.equal(fn({ status_code: 499 }, "error"), true);
  assert.equal(fn({ status_code: 500 }, "error"), true);
  assert.equal(fn({ status_code: 502 }, "error"), true);
  assert.equal(fn({ status_code: 101 }, "error"), true);
  assert.equal(fn({ status_code: 302 }, "error"), true);
  assert.equal(fn({ status_code: 200 }, "error"), false);
  assert.equal(fn({ status_code: 204 }, "error"), false);
});

test("logMatchesCurrentFilters supports token ID exact filtering", () => {
  const matchFilterSource = extractFunction(logsJs, "logMatchesCurrentFilters");
  const matchStatusSource = extractFunction(logsJs, "logMatchesStatusFilter");
  const matchSearchSource = extractFunction(logsJs, "logMatchesSearchFilter");

  let currentTokenId = null;
  const context = vm.createContext({
    logUpstreamFilter: { value: "" },
    logStatusFilter: { value: "" },
    logClientFilter: { value: "" },
    logSearchInput: { value: "" },
    getLogDownstreamTokenId: () => currentTokenId,
  });

  vm.runInContext(`
    ${matchStatusSource}
    ${matchSearchSource}
    ${matchFilterSource}
    this.logMatchesCurrentFilters = logMatchesCurrentFilters;
  `, context);

  const fn = context.logMatchesCurrentFilters;

  // When no token filtered, matches all
  assert.equal(fn({ downstream_token_id: 10 }), true);
  assert.equal(fn({ downstream_token_id: 20 }), true);
  assert.equal(fn({ downstream_token_id: null }), true);

  // When token 10 filtered
  currentTokenId = 10;
  assert.equal(fn({ downstream_token_id: 10 }), true);
  assert.equal(fn({ downstream_token_id: 20 }), false);
  assert.equal(fn({ downstream_token_id: null }), false);
});

test("drillDownToLogs supports token ID and status drilldown with stream restart", () => {
  const source = extractFunction(dashboardJs, "drillDownToLogs");
  const fakeLogSearch = { value: "" };
  const fakeUpstreamFilter = { value: "" };
  const fakeStatusFilter = { value: "" };
  let switchedTo = "";
  let paginationReset = false;
  let setTokenId = null;
  let setTokenName = "";
  let restartedStream = false;

  const context = vm.createContext({
    logSearchInput: fakeLogSearch,
    logUpstreamFilter: fakeUpstreamFilter,
    logStatusFilter: fakeStatusFilter,
    logClientFilter: { value: "prev" },
    setLogDownstreamTokenId: (id, name) => {
      setTokenId = id;
      setTokenName = name;
    },
    resetLogPagination: () => { paginationReset = true; },
    switchView: (view) => { switchedTo = view; },
    restartLogStream: () => { restartedStream = true; },
  });

  vm.runInContext(`${source}; this.drillDownToLogs = drillDownToLogs;`, context);
  context.drillDownToLogs({
    downstreamTokenId: 42,
    downstreamTokenName: "prod-key",
    status: "error",
  });

  assert.equal(setTokenId, 42);
  assert.equal(setTokenName, "prod-key");
  assert.equal(fakeStatusFilter.value, "error");
  assert.equal(switchedTo, "logs");
  assert.equal(paginationReset, true);
  assert.equal(restartedStream, true);
});

test("clearLogFilters resets token filter, all dropdowns and restarts stream", () => {
  const source = extractFunction(shellJs, "clearLogFilters");
  const fakeLogSearch = { value: "some-search" };
  const fakeUpstreamFilter = { value: "2" };
  const fakeStatusFilter = { value: "5xx" };
  const fakeClientFilter = { value: "openai" };
  let setTokenId = 42;
  let paginationReset = false;
  let loadedLogs = false;
  let restartedStream = false;

  const context = vm.createContext({
    logSearchInput: fakeLogSearch,
    logUpstreamFilter: fakeUpstreamFilter,
    logStatusFilter: fakeStatusFilter,
    logClientFilter: fakeClientFilter,
    setLogDownstreamTokenId: (id) => { setTokenId = id; },
    resetLogPagination: () => { paginationReset = true; },
    loadLogs: () => { loadedLogs = true; },
    restartLogStream: () => { restartedStream = true; },
  });

  vm.runInContext(`${source}; this.clearLogFilters = clearLogFilters;`, context);
  context.clearLogFilters();

  assert.equal(fakeLogSearch.value, "");
  assert.equal(fakeUpstreamFilter.value, "");
  assert.equal(fakeStatusFilter.value, "");
  assert.equal(fakeClientFilter.value, "");
  assert.equal(setTokenId, null);
  assert.equal(paginationReset, true);
  assert.equal(loadedLogs, true);
  assert.equal(restartedStream, true);
});

test("channel card renders 24h 流量健康 with timedCount latency handling", () => {
  assert.ok(upstreamsJs.includes("24h 流量健康"), "label uses 24h 流量健康");
  assert.ok(
    upstreamsJs.includes("health.timedCount != null ? health.timedCount === 0 : !health.avgMs"),
    "health latency distinguishes timedCount === 0 from valid 0ms",
  );
  assert.ok(
    upstreamsJs.includes("24 小时在线率（正常响应占总请求比例，排除客户端主动中断）"),
    "success rate tooltip updated",
  );
  assert.ok(
    upstreamsJs.includes("24 小时平均耗时（仅统计有耗时采样的请求）"),
    "avg latency tooltip updated",
  );
});
