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

test("admin.html contains upstream routing summary strip and strategy select", () => {
  const markup = read("static/admin.html");
  assert.ok(markup.includes('id="upstream-routing-summary"'), "upstream-routing-summary exists");
  assert.ok(markup.includes('id="settings-load-balance-strategy"'), "settings-load-balance-strategy exists");
  assert.ok(markup.includes('value="weighted"'), "weighted option exists");
  assert.ok(markup.includes('value="least_latency"'), "least_latency option exists");
});

/* 路由摘要就是渠道面板标题下的那句说明，不再是列表上方一条独立的带框条。
   位置这件事只有 HTML 能证明，所以对着结构断言。 */
test("路由摘要长在面板抬头里，不再单独占一条", () => {
  const markup = read("static/admin.html");
  const viewStart = markup.indexOf('data-view="upstreams"');
  const at = (needle) => {
    const index = markup.indexOf(needle, viewStart);
    assert.notEqual(index, -1, needle + " 不在渠道视图里");
    return index;
  };

  // 抬头 → 摘要 → 抬头闭合 → 数字条 → 工具栏，顺序说明摘要在抬头内部。
  assert.ok(at('<div class="panel-head">') < at('id="upstream-routing-summary"'));
  assert.ok(at('id="upstream-routing-summary"') < at('class="summary-strip"'));
  assert.ok(at('class="summary-strip"') < at('class="view-toolbar upstream-toolbar"'));

  // 抬头里不能再留一句写死的 <p>，否则同一件事有两处文案。
  assert.ok(
    !markup.includes("<p>按模型匹配、硬优先级和有效权重路由上游请求。</p>"),
    "静态那句话交给渲染器兜底，不再单独写一个 <p>",
  );
});

test("enhancements.css defines upstream routing summary and latency tags", () => {
  const css = read("static/css/enhancements.css");
  assert.ok(css.includes(".upstream-routing-summary"), "upstream routing summary exists");
  assert.ok(css.includes(".routing-summary-strip-inner"), "routing summary inner exists");
  assert.ok(css.includes(".routing-summary-dot"), "routing summary dot exists");
  assert.ok(css.includes(".routing-chip"), "routing chip exists");
  assert.ok(css.includes(".routing-summary-rules-hint"), "routing rules hint exists");
  assert.ok(css.includes(".routing-summary-explain"), "routing explanation style exists");
  assert.ok(css.includes(".routing-summary-details"), "collapsed params style exists");
  assert.ok(css.includes(".latency-routing-tag"), "latency routing tag exists");
  assert.ok(css.includes(".latency-routing-tag--usable"), "usable latency tag exists");
  assert.ok(css.includes(".latency-routing-tag--sampling"), "sampling latency tag exists");
  assert.ok(css.includes(".latency-routing-tag--unmeasured"), "unmeasured latency tag exists");
});

test("formatLatencyRoutingBadge respects latency_active state and formats tags correctly", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({
    escapeHtml,
    latestRoutingData: null,
  });

  vm.runInContext(extractFunction(source, "formatLatencyRoutingBadge"), context);

  // 1. When latestRoutingData is null or latency_active is false: returns empty string
  assert.equal(context.formatLatencyRoutingBadge(1), "");
  context.latestRoutingData = { strategy: "weighted", latency_active: false, latency: [{ upstream_id: 1, usable: true, median_ms: 100, sample_count: 10 }] };
  assert.equal(context.formatLatencyRoutingBadge(1), "", "Must not display latency badge when latency is not active");

  // 2. When latency_active is true:
  context.latestRoutingData = {
    strategy: "least_latency",
    latency_active: true,
    rules: { min_samples: 5, stale_window_seconds: 300 },
    latency: [
      { upstream_id: 1, usable: true, median_ms: 42, sample_count: 12 },
      { upstream_id: 2, usable: false, median_ms: null, sample_count: 2 },
    ],
  };

  // 2a. Usable with median
  const usable = context.formatLatencyRoutingBadge(1);
  assert.ok(usable.includes("latency-routing-tag--usable"));
  assert.ok(usable.includes("42ms"));
  assert.ok(usable.includes("12"));

  // 2b. Sampling (sample_count < 5, median_ms is null)
  const sampling = context.formatLatencyRoutingBadge(2);
  assert.ok(sampling.includes("latency-routing-tag--sampling"));
  assert.ok(sampling.includes("采样中 (2/5)"));

  // 2c. Unmeasured (upstream 3 not in list)
  const unmeasured = context.formatLatencyRoutingBadge(3);
  assert.ok(unmeasured.includes("latency-routing-tag--unmeasured"));
  assert.ok(unmeasured.includes("未测量 (参与竞争)"));
});

test("renderUpstreamRoutingSummary renders strategy, active state, rule chips, and fallback rules", () => {
  const source = read("static/js/upstreams.js");
  const summaryEl = { hidden: true, innerHTML: "" };
  const context = vm.createContext({
    escapeHtml,
    upstreamRoutingSummary: summaryEl,
    latestRoutingData: null,
  });

  vm.runInContext(extractFunction(source, "renderUpstreamRoutingSummary"), context);

  /* 1. 没拿到 /routing 时退回静态文案。这块现在是面板说明位，整块藏起来会让
        标题底下空一截，所以不再设 hidden，而是把那句话写回去。 */
  context.renderUpstreamRoutingSummary(null);
  assert.equal(summaryEl.hidden, true, "渲染器不再碰 hidden");
  assert.ok(
    summaryEl.innerHTML.includes("按模型匹配、硬优先级和有效权重路由上游请求。"),
    "无数据时留一句兜底文案",
  );
  assert.ok(summaryEl.innerHTML.includes("routing-summary-explain"), "兜底文案也走同一个排版类");

  // 2. Least latency active data
  const data = {
    strategy: "least_latency",
    latency_active: true,
    rules: {
      min_samples: 5,
      stale_window_seconds: 300,
      sample_capacity: 32,
      tolerance_ratio: 0.2,
      tolerance_floor_ms: 50,
    },
    latency: [],
  };

  context.renderUpstreamRoutingSummary(data);
  assert.ok(summaryEl.innerHTML.includes("最低延迟优先"));
  assert.ok(summaryEl.innerHTML.includes("延迟决策已激活"));
  // "层"要在界面上被解释出来，而不是让人猜。
  assert.ok(summaryEl.innerHTML.includes("同优先级渠道之间"), "leads with plain language");
  assert.ok(summaryEl.innerHTML.includes("请求先按优先级从高到低"), "explains what a tier is");
  assert.ok(summaryEl.innerHTML.includes("routing-summary-explain"), "has explanation paragraph");
  /* 说明和徽标合成一句：原来是标题行 + 说明段两行，塞不进面板抬头。
     徽标必须留在这句话里边，不能自己再起一行。 */
  const explain = /<div class="routing-summary-explain">([\s\S]*?)<\/div>\s*(<details|<\/div>)/.exec(summaryEl.innerHTML);
  assert.ok(explain, "说明是一个 div（不是 p：dark-theme 有一条压过徽标颜色的 .panel-head p 规则）");
  assert.ok(explain[1].includes("routing-summary-badge"), "徽标跟在句尾，不另起一行");
  assert.ok(!summaryEl.innerHTML.includes("routing-summary-header"), "标题行已经并进说明里");
  // 参数与退化规则收在 <details> 里，默认不展开。
  assert.ok(summaryEl.innerHTML.includes("<details class=\"routing-summary-details\">"), "params are collapsed");
  assert.ok(!summaryEl.innerHTML.includes("<details class=\"routing-summary-details\" open>"), "collapsed by default");
  assert.ok(summaryEl.innerHTML.includes("最小样本: <strong>5</strong>"));
  assert.ok(summaryEl.innerHTML.includes("过期窗口: <strong>300s</strong>"));
  assert.ok(summaryEl.innerHTML.includes("容忍带: <strong>20%</strong>"));
  assert.ok(summaryEl.innerHTML.includes("样本容量: <strong>32</strong>"));
  assert.ok(summaryEl.innerHTML.includes("同优先级内无可用样本 → 退化为加权随机"));
  assert.ok(summaryEl.innerHTML.includes("样本不足 5 个 → 视为未测量并保留竞争"));
  assert.ok(summaryEl.innerHTML.includes("样本过期 (> 300s) → 自动清除并标记为未测量"));

  // 3. Weighted inactive strategy
  const weightedData = {
    strategy: "weighted",
    latency_active: false,
    rules: { min_samples: 5, stale_window_seconds: 300, sample_capacity: 32, tolerance_ratio: 0.2, tolerance_floor_ms: 50 },
    latency: [],
  };
  context.renderUpstreamRoutingSummary(weightedData);
  assert.ok(summaryEl.innerHTML.includes("加权随机"));
  assert.ok(summaryEl.innerHTML.includes("延迟决策未激活"));
  assert.ok(summaryEl.innerHTML.includes("权重越大，被抽中的概率越高"), "explains weighted picking");
  // 加权随机下这些延迟参数全是死数字，不该出现。
  assert.ok(!summaryEl.innerHTML.includes("routing-summary-details"), "no latency params under weighted");
  assert.ok(!summaryEl.innerHTML.includes("最小样本"), "no sample chips under weighted");
});

test("fetchLatestRoutingData fetches /api/admin/upstreams/routing and updates state", async () => {
  const source = read("static/js/upstreams.js");
  const calls = [];
  const summaryEl = { hidden: true, innerHTML: "" };

  const context = vm.createContext({
    escapeHtml,
    upstreamRoutingSummary: summaryEl,
    latestRoutingData: null,
    priorityEditorIsOpen: () => false,
    renderRows: () => {},
    api: async (url) => {
      calls.push(url);
      return {
        strategy: "least_latency",
        latency_active: true,
        rules: { min_samples: 5, stale_window_seconds: 300, sample_capacity: 32, tolerance_ratio: 0.2, tolerance_floor_ms: 50 },
        latency: [{ upstream_id: 1, usable: true, median_ms: 55, sample_count: 8 }],
      };
    },
  });

  vm.runInContext(extractFunction(source, "renderUpstreamRoutingSummary"), context);
  vm.runInContext(extractFunction(source, "fetchLatestRoutingData"), context);

  const res = await vm.runInContext("fetchLatestRoutingData()", context);

  assert.equal(calls.length, 1);
  assert.equal(calls[0], "/api/admin/upstreams/routing");
  assert.equal(context.latestRoutingData.strategy, "least_latency");
  assert.ok(summaryEl.innerHTML.includes("最低延迟优先"));
});

test("weightCellMarkup and channel cards include latency badges", () => {
  const source = read("static/js/upstreams.js");
  assert.ok(source.includes("formatLatencyRoutingBadge(upstream.id)"));
});

test("shell.js loads and persists load_balance_strategy in runtimeSettingsPayload", () => {
  const shellSource = read("static/js/shell.js");

  // 1. nonIntegerSettingsKeys contains load_balance_strategy
  assert.ok(shellSource.includes('"load_balance_strategy"'), "nonIntegerSettingsKeys contains load_balance_strategy");

  // 2. fillServerSettings binds strategy to select element
  assert.ok(shellSource.includes("settingsLoadBalanceStrategy.value = settings.load_balance_strategy"), "fillServerSettings sets select value");

  // 3. runtimeSettingsPayload contains load_balance_strategy
  assert.ok(shellSource.includes("load_balance_strategy:"), "runtimeSettingsPayload includes load_balance_strategy");
});
