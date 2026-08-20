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

test("admin.html contains batch probe button and probe summary strip", () => {
  const markup = read("static/admin.html");
  assert.ok(markup.includes('id="batch-probe"'), "batch-probe button exists");
  assert.ok(markup.includes("一键测活"), "batch-probe text exists");
  assert.ok(markup.includes('id="upstream-probe-summary"'), "upstream probe summary strip exists");
});

test("enhancements.css defines probe badges and summary styles", () => {
  const css = read("static/css/enhancements.css");
  assert.ok(css.includes(".probe-badge {"), "probe badge exists");
  assert.ok(css.includes(".probe-badge--ok {"), "probe badge ok exists");
  assert.ok(css.includes(".probe-badge--failed {"), "probe badge failed exists");
  assert.ok(css.includes(".probe-badge--transport {"), "probe badge transport exists");
  assert.ok(css.includes(".probe-badge--skipped {"), "probe badge skipped exists");
  assert.ok(css.includes(".probe-badge--untested {"), "probe badge untested exists");
  assert.ok(css.includes(".probe-summary-dot.is-running"), "probe summary running dot exists");

  /* 这块不能再挂 .summary-strip：那是 KPI 数字条的样式，会把后代 span 拉成等宽格子
     （7px 的状态圆点被撑成椭圆）、把 strong 顶成独立一行的粗体。 */
  const markup = read("static/admin.html");
  const tag = /<div id="upstream-probe-summary"[^>]*>/.exec(markup)?.[0];
  assert.notEqual(tag, undefined, "probe summary must exist");
  assert.ok(!/\bsummary-strip\b/.test(tag), "不再借用 KPI 数字条的样式");
  assert.match(tag, /\bhidden\b/, "默认收起");

  /* 摘掉 .summary-strip 也摘掉了 base.css 里 .summary-strip[hidden] 的兜底，而这块
     正是靠 hidden 收起的。自己的 display 是作者样式，会压过 UA 的 [hidden]。 */
  assert.match(
    css,
    /\.upstream-probe-summary\[hidden\]\s*\{\s*display:\s*none;/,
    "hidden 兜底必须跟着搬过来，否则测活摘要收不回去",
  );
});

test("renderProbeBadgeMarkup renders all required badge states correctly", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({ escapeHtml });
  vm.runInContext(extractFunction(source, "renderProbeBadgeMarkup"), context);

  // 1. Untested / null
  const untested = vm.runInContext("renderProbeBadgeMarkup(null)", context);
  assert.ok(untested.includes('class="probe-badge probe-badge--untested"'));
  assert.ok(untested.includes("未测活"));

  // 2. Skipped
  const skipped = vm.runInContext("renderProbeBadgeMarkup({ skipped: true })", context);
  assert.ok(skipped.includes('class="probe-badge probe-badge--skipped"'));
  assert.ok(skipped.includes("已跳过"));

  // 3. HTTP 200 OK
  const okResult = {
    ok: true,
    status_code: 200,
    duration_ms: 45,
    checked_at: "2026-08-18 10:00:00",
  };
  context.okResult = okResult;
  const okMarkup = vm.runInContext("renderProbeBadgeMarkup(okResult)", context);
  assert.ok(okMarkup.includes('class="probe-badge probe-badge--ok"'));
  assert.ok(okMarkup.includes("HTTP 200 (45ms)"));
  assert.ok(okMarkup.includes("2026-08-18 10:00:00"));

  // 4. HTTP 502 Failed
  const failedResult = {
    ok: false,
    status_code: 502,
    duration_ms: 120,
    error_summary: "Bad Gateway from upstream",
    checked_at: "2026-08-18 10:05:00",
  };
  context.failedResult = failedResult;
  const failedMarkup = vm.runInContext("renderProbeBadgeMarkup(failedResult)", context);
  assert.ok(failedMarkup.includes('class="probe-badge probe-badge--failed"'));
  assert.ok(failedMarkup.includes("HTTP 502 (120ms)"));
  assert.ok(failedMarkup.includes("Bad Gateway from upstream"));

  // 5. Transport error (status_code is null)
  const transportResult = {
    ok: false,
    status_code: null,
    duration_ms: 3000,
    error_summary: "dial tcp: connect: connection refused",
    checked_at: "2026-08-18 10:10:00",
  };
  context.transportResult = transportResult;
  const transportMarkup = vm.runInContext("renderProbeBadgeMarkup(transportResult)", context);
  assert.ok(transportMarkup.includes('class="probe-badge probe-badge--transport"'));
  assert.ok(transportMarkup.includes("连接异常 (3000ms)"));
  assert.ok(transportMarkup.includes("connection refused"));
});

test("renderProbeSummary renders running state and stats accurately", () => {
  const source = read("static/js/upstreams.js");
  const summaryEl = { hidden: true, innerHTML: "" };
  const batchProbeBtn = { disabled: false, textContent: "一键测活" };

  const context = vm.createContext({
    escapeHtml,
    upstreamProbeSummary: summaryEl,
    batchProbeBtn,
    probeRunning: false,
    latestProbeCheckedAt: null,
  });
  vm.runInContext(extractFunction(source, "renderProbeSummary"), context);

  // 1. Running state
  context.probeRunning = true;
  vm.runInContext("renderProbeSummary({ running: true })", context);
  assert.equal(summaryEl.hidden, false);
  assert.ok(summaryEl.innerHTML.includes("probe-summary-dot is-running"));
  assert.ok(summaryEl.innerHTML.includes("正在批量测活渠道"));
  assert.equal(batchProbeBtn.disabled, true);
  assert.equal(batchProbeBtn.textContent, "测活中...");

  // 2. Finished state with partial timeouts and skipped channels
  context.probeRunning = false;
  const data = {
    total: 5,
    succeeded: 3,
    failed: 1,
    skipped: 1,
    partial: true,
    checked_at: "2026-08-18 10:15:00",
  };
  context.probeData = data;
  vm.runInContext("renderProbeSummary(probeData)", context);
  assert.equal(summaryEl.hidden, false);
  assert.ok(summaryEl.innerHTML.includes("最近测活 (5 渠道)"));
  assert.ok(summaryEl.innerHTML.includes("成功 <strong>3</strong>"));
  assert.ok(summaryEl.innerHTML.includes("失败 <strong>1</strong>"));
  assert.ok(summaryEl.innerHTML.includes("跳过 <strong>1</strong>"));
  assert.ok(summaryEl.innerHTML.includes("[部分超时]"));
  assert.ok(summaryEl.innerHTML.includes("2026-08-18 10:15:00"));
  assert.equal(batchProbeBtn.disabled, false);
  assert.equal(batchProbeBtn.textContent, "一键测活");

  // 3. Null / empty state hides summary
  vm.runInContext("renderProbeSummary(null)", context);
  assert.equal(summaryEl.hidden, true);
});

test("fetchLatestProbeResults uses GET only and populates probe results map", async () => {
  const source = read("static/js/upstreams.js");
  const calls = [];
  const upstreamProbeResults = new Map();
  const summaryEl = { hidden: true, innerHTML: "" };
  const batchProbeBtn = { disabled: false, textContent: "一键测活" };

  const context = vm.createContext({
    escapeHtml,
    upstreamProbeResults,
    latestProbeCheckedAt: null,
    probeRunning: false,
    probePollTimer: null,
    upstreamProbeSummary: summaryEl,
    batchProbeBtn,
    priorityEditorIsOpen: () => false,
    renderRows: () => {},
    api: async (url, options) => {
      calls.push({ url, options });
      return {
        running: false,
        checked_at: "2026-08-18 10:20:00",
        results: [
          { upstream_id: 1, ok: true, status_code: 200, duration_ms: 15 },
          { upstream_id: 2, ok: false, status_code: 500, duration_ms: 80 },
        ],
      };
    },
  });

  vm.runInContext(extractFunction(source, "renderProbeSummary"), context);
  vm.runInContext(extractFunction(source, "fetchLatestProbeResults"), context);

  await vm.runInContext("fetchLatestProbeResults()", context);

  // Must call GET /api/admin/upstreams/probe-all without POST
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "/api/admin/upstreams/probe-all");
  assert.equal(calls[0].options, undefined);

  // Map must contain parsed items
  assert.equal(upstreamProbeResults.size, 2);
  assert.equal(upstreamProbeResults.get(1).status_code, 200);
  assert.equal(upstreamProbeResults.get(2).status_code, 500);
  assert.equal(context.latestProbeCheckedAt, "2026-08-18 10:20:00");
});

test("runBatchProbe triggers POST, handles 409 conflict by polling GET, and prevents double clicks", async () => {
  const source = read("static/js/upstreams.js");
  const calls = [];
  const upstreamProbeResults = new Map();
  const summaryEl = { hidden: true, innerHTML: "" };
  const batchProbeBtn = { disabled: false, textContent: "一键测活" };
  const statusMessages = [];

  let postShould409 = true;

  const context = vm.createContext({
    escapeHtml,
    upstreamProbeResults,
    latestProbeCheckedAt: null,
    probeRunning: false,
    probePollTimer: null,
    upstreamProbeSummary: summaryEl,
    batchProbeBtn,
    priorityEditorIsOpen: () => false,
    renderRows: () => {},
    setStatus: (msg, tone) => statusMessages.push({ msg, tone }),
    setTimeout: (fn) => fn(), // execute immediately for test
    clearTimeout: () => {},
    api: async (url, options = {}) => {
      calls.push({ url, method: options.method || "GET" });
      if (options.method === "POST") {
        if (postShould409) {
          const err = new Error("409 Conflict");
          err.status = 409;
          throw err;
        }
        return {
          total: 1,
          succeeded: 1,
          failed: 0,
          skipped: 0,
          results: [{ upstream_id: 1, ok: true, status_code: 200, duration_ms: 10, checked_at: "2026-08-18 10:30:00" }],
        };
      }
      // GET probe-all response when polling
      return {
        running: false,
        checked_at: "2026-08-18 10:30:00",
        results: [{ upstream_id: 1, ok: true, status_code: 200, duration_ms: 10, checked_at: "2026-08-18 10:30:00" }],
      };
    },
  });

  vm.runInContext(extractFunction(source, "renderProbeSummary"), context);
  vm.runInContext(extractFunction(source, "fetchLatestProbeResults"), context);
  vm.runInContext(extractFunction(source, "runBatchProbe"), context);

  // 1. When server returns 409, automatically degrades to GET polling
  await vm.runInContext("runBatchProbe()", context);

  assert.ok(calls.some(c => c.method === "POST" && c.url.includes("/api/admin/upstreams/probe-all")));
  assert.ok(calls.some(c => c.method === "GET" && c.url === "/api/admin/upstreams/probe-all"));
  assert.equal(upstreamProbeResults.get(1)?.status_code, 200);

  // 2. Normal POST success
  postShould409 = false;
  calls.length = 0;
  statusMessages.length = 0;
  await vm.runInContext("runBatchProbe()", context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0].method, "POST");
  assert.equal(statusMessages.length, 1);
  assert.ok(statusMessages[0].msg.includes("批量测活完成：成功 1，失败 0"));
  assert.equal(statusMessages[0].tone, "success");

  // 3. Concurrency guard: when probeRunning is true, second call does nothing
  calls.length = 0;
  context.probeRunning = true;
  await vm.runInContext("runBatchProbe()", context);
  assert.equal(calls.length, 0, "No new request when probe is already running");
});

test("three decoupled independent badges are present in table and card templates", () => {
  const source = read("static/js/upstreams.js");

  // Table row col-status contains status-switch and probe badge
  assert.ok(source.includes('<td class="col-status" data-col="status">'));
  assert.ok(source.includes("status-switch"));
  assert.ok(source.includes("renderProbeBadgeMarkup(upstreamProbeResults.get(upstream.id))"));

  // Card header contains priority badge, probe badge, and status switch
  assert.ok(source.includes('class="channel-card-header-actions"'));
  assert.ok(source.includes("channel-card-badge"));

  // Card health section is separate from probe badge
  assert.ok(source.includes('class="channel-card-health"'));
  assert.ok(source.includes("24h 流量健康"));
});
