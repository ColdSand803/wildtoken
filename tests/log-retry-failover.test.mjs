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

test("admin.html contains log detail retry chain container", () => {
  const markup = read("static/admin.html");
  assert.ok(markup.includes('id="log-detail-retry-chain"'), "log-detail-retry-chain exists");
});

test("enhancements.css defines retry failover and attempt badge styles", () => {
  const css = read("static/css/enhancements.css");
  assert.ok(css.includes(".log-row-attempt-badge"), "log row attempt badge exists");
  assert.ok(css.includes(".log-failure-stage-tag"), "log failure stage tag exists");
  assert.ok(css.includes(".log-detail-failure-stage-badge"), "log detail failure stage badge exists");
  assert.ok(css.includes(".log-detail-retryable-badge"), "log detail retryable badge exists");
  assert.ok(css.includes(".log-detail-retry-chain"), "log detail retry chain exists");
  assert.ok(css.includes(".retry-chain-step"), "retry chain step exists");
  assert.ok(css.includes(".retry-chain-step.is-current"), "retry chain step current exists");
});

test("formatFailureStage maps failure stages to descriptive Chinese labels", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf("const FAILURE_STAGE_LABELS"), source.indexOf("const LOG_RATE_ANIMATION_MS")), context);

  assert.equal(context.formatFailureStage("first_event"), "首事件前失败");
  assert.equal(context.formatFailureStage("stream"), "传输中断");
  assert.equal(context.formatFailureStage("client_cancelled"), "客户端取消");
  assert.equal(context.formatFailureStage("connect"), "连接建立失败");
  assert.equal(context.formatFailureStage("upstream_status"), "上游状态异常");
  assert.equal(context.formatFailureStage("no_route"), "未找到路由");
  assert.equal(context.formatFailureStage("rate_limited"), "渠道限流");
  assert.equal(context.formatFailureStage("gateway"), "网关错误");
  assert.equal(context.formatFailureStage("custom_unknown"), "custom_unknown");
  assert.equal(context.formatFailureStage(null), "");
});

test("formatFailureRetryable distinguishes retryable error and never renders as completed retry", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({});
  vm.runInContext(source.slice(source.indexOf("const FAILURE_STAGE_LABELS"), source.indexOf("const LOG_RATE_ANIMATION_MS")), context);

  const retryableText = context.formatFailureRetryable(true);
  const nonRetryableText = context.formatFailureRetryable(false);

  assert.equal(retryableText, "可重试错误");
  assert.notEqual(retryableText, "已重试", "Must never render failure_retryable as 已重试");
  assert.equal(nonRetryableText, "不可重试错误");
  assert.equal(context.formatFailureRetryable(null), "");
});

test("formatLogChannelStack renders attempt badge on retried requests", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({
    escapeHtml,
    logSensitiveHidden: false,
    LOG_SENSITIVE_MASK: "******",
  });
  vm.runInContext(extractFunction(source, "formatLogChannelStack"), context);

  // 1. Initial attempt (attempt_index = 0)
  const initialLog = { upstream_id: 1, upstream_name: "OpenAI-1", attempt_index: 0 };
  const initialMarkup = context.formatLogChannelStack(initialLog);
  assert.ok(!initialMarkup.includes("log-row-attempt-badge"), "Initial attempt does not have attempt badge");
  assert.ok(initialMarkup.includes("#1"));

  // 2. Retry attempt (attempt_index = 2)
  const retryLog = { upstream_id: 2, upstream_name: "OpenAI-2", attempt_index: 2, request_uid: "req_xyz" };
  const retryMarkup = context.formatLogChannelStack(retryLog);
  assert.ok(retryMarkup.includes("log-row-attempt-badge"), "Retry attempt has attempt badge");
  assert.ok(retryMarkup.includes("重试 #2"));
  assert.ok(retryMarkup.includes("req_xyz"));

  // 3. Unmatched channel with retry index
  const unmatchedRetry = { upstream_id: null, upstream_name: "", attempt_index: 1, request_uid: "req_abc" };
  const unmatchedMarkup = context.formatLogChannelStack(unmatchedRetry);
  assert.ok(unmatchedMarkup.includes("log-row-attempt-badge"));
  assert.ok(unmatchedMarkup.includes("重试 #1"));
});

test("formatLogDetailMeta renders failure stage and retryable badges in status head", () => {
  const source = read("static/js/logs.js");
  const context = vm.createContext({
    escapeHtml,
    logSensitiveHidden: false,
    LOG_SENSITIVE_MASK: "******",
    formatFailureStage: (s) => (s === "first_event" ? "首事件前失败" : s),
    formatFailureRetryable: (r) => (r ? "可重试错误" : "不可重试错误"),
    formatLogChannelLabel: (d) => "#" + (d.upstream_id || 1) + " · " + (d.upstream_name || "test"),
    formatLogModelText: (d) => d.model || "",
    formatReasoningEffort: () => "",
    extractLogDetailError: () => "",
    formatTotalDurationTime: () => "120ms",
    formatTokensPerSecondLine: () => "",
    formatTokenDetailPanel: () => "",
    formatSeconds: (ms) => ms + "ms",
  });

  vm.runInContext(extractFunction(source, "formatFirstTokenTime"), context);
  vm.runInContext(extractFunction(source, "formatGatewayPrepTime"), context);
  vm.runInContext(extractFunction(source, "formatHeadersArrivalTime"), context);
  /* 耗时瀑布走 static/js/components.js 的公共分段条，沙箱里得先有这几个全局。 */
  const componentsSource = read("static/js/components.js");
  for (const name of ["wtTipAttribute", "wtSegment", "wtSegmentBar"]) {
    vm.runInContext(extractFunction(componentsSource, name), context);
  }
  for (const name of ["formatLogTimingChips", "formatLogTimingBar"]) {
    vm.runInContext(extractFunction(source, name), context);
  }
  vm.runInContext(extractFunction(source, "formatLogDetailMeta"), context);

  // 1. Failed retryable log
  const detail = {
    id: 101,
    request_uid: "req_flow_123",
    attempt_index: 1,
    method: "POST",
    path: "v1/chat/completions",
    stream: true,
    model: "gpt-4o",
    upstream_id: 2,
    upstream_name: "Secondary",
    status_code: 502,
    failure_stage: "first_event",
    failure_retryable: true,
  };

  const metaHtml = context.formatLogDetailMeta(detail);
  assert.ok(metaHtml.includes("log-detail-failure-stage-badge"), "includes failure stage badge");
  assert.ok(metaHtml.includes("阶段: 首事件前失败"), "includes stage text");
  assert.ok(metaHtml.includes("log-detail-retryable-badge is-retryable"), "includes retryable badge");
  assert.ok(metaHtml.includes("可重试错误"), "includes retryable text");
  assert.ok(metaHtml.includes("UID: req_flow_123"), "includes UID badge");
  assert.ok(metaHtml.includes("重试 #1"), "includes route attempt badge");

  // 2. Non-retryable 401 error
  const authFail = {
    id: 102,
    request_uid: "req_auth_456",
    attempt_index: 0,
    method: "POST",
    path: "v1/chat/completions",
    stream: false,
    model: "gpt-4o",
    upstream_id: 1,
    upstream_name: "Primary",
    status_code: 401,
    failure_stage: "upstream_status",
    failure_retryable: false,
  };

  const authHtml = context.formatLogDetailMeta(authFail);
  assert.ok(authHtml.includes("log-detail-retryable-badge is-non-retryable"));
  assert.ok(authHtml.includes("不可重试错误"));
  assert.ok(!authHtml.includes("已重试"));
});

test("renderLogRetryChain displays multi-attempt steps and hides on single normal attempt", () => {
  const source = read("static/js/logs.js");
  const container = { hidden: true, innerHTML: "", querySelectorAll: () => [] };
  const showLogDetailCalls = [];

  const context = vm.createContext({
    escapeHtml,
    logDetailRetryChain: container,
    logPageItems: [
      { id: 10, request_uid: "req_multi", attempt_index: 0, upstream_id: 1, upstream_name: "Upstream A", status_code: 502, duration_ms: 300, failure_stage: "first_event" },
      { id: 11, request_uid: "req_multi", attempt_index: 1, upstream_id: 2, upstream_name: "Upstream B", status_code: 200, duration_ms: 800, failure_stage: null },
      { id: 99, request_uid: "req_other", attempt_index: 0, upstream_id: 1, upstream_name: "Upstream A", status_code: 200, duration_ms: 100 },
    ],
    formatLogChannelLabel: (l) => "#" + (l.upstream_id || 0) + " · " + (l.upstream_name || ""),
    formatFailureStage: (s) => (s === "first_event" ? "首事件前失败" : s),
    showLogDetail: (id) => showLogDetailCalls.push(id),
  });

  vm.runInContext(extractFunction(source, "renderLogRetryChain"), context);

  // 1. Single attempt request (id: 99)
  context.renderLogRetryChain({ id: 99, request_uid: "req_other", attempt_index: 0 });
  assert.equal(container.hidden, true, "Container should be hidden for single attempt index 0");
  assert.equal(container.innerHTML, "");

  // 2. Multi-attempt request viewing attempt 0 (id: 10)
  context.renderLogRetryChain({ id: 10, request_uid: "req_multi", attempt_index: 0, failure_stage: "first_event" });
  assert.equal(container.hidden, false, "Container should be visible for multi-attempt request");
  assert.ok(container.innerHTML.includes("请求重试链路"));
  assert.ok(container.innerHTML.includes("共 2 次尝试"));
  assert.ok(container.innerHTML.includes("UID: req_multi"));
  assert.ok(container.innerHTML.includes("首次尝试"));
  assert.ok(container.innerHTML.includes("重试 #1"));
  assert.ok(container.innerHTML.includes("is-current"));
  assert.ok(container.innerHTML.includes('aria-current="step"'));
  assert.ok(container.innerHTML.includes("首事件前失败"));

  // 3. Viewing attempt 1 (id: 11)
  context.renderLogRetryChain({ id: 11, request_uid: "req_multi", attempt_index: 1 });
  assert.equal(container.hidden, false);
  assert.ok(container.innerHTML.includes('data-retry-log-id="11"'));
});

/* 重试链路的每一步是 <button>，所以 base.css 的 button:hover 会给它设
   color: var(--accent-on)——那是"实心强调色底"的反色（暗色主题近黑、Anthropic 近白）。
   这里底色只是 8% 的淡色，所以只要 :hover / .is-current 自己不写 color，
   悬浮瞬间文字就与背景同色、整行消失。这条 bug 与主题包无关，六个主题全中。 */
test("retry chain hover and current states pin their own text colour", () => {
  const css = read("static/css/enhancements.css");

  // 取 selector 后面第一个 { ... } 块，不绕正则转义。
  const ruleBody = (selector) => {
    const at = css.indexOf(`${selector} {`);
    if (at === -1) return undefined;
    const open = css.indexOf("{", at);
    const close = css.indexOf("}", open);
    return close === -1 ? undefined : css.slice(open + 1, close);
  };

  for (const selector of [".retry-chain-step:hover", ".retry-chain-step.is-current"]) {
    const block = ruleBody(selector);
    assert.notEqual(block, undefined, `${selector} 必须存在`);
    assert.match(
      block,
      /color:\s*var\(--text\)/,
      `${selector} 必须自己钉住 color，否则被 button:hover 的 --accent-on 顶掉`,
    );
  }

  /* 状态徽章一律走语义令牌：六个主题包各自在改这些 token，写死等于脱离主题。
     先剥掉注释再断言——注释里会引用被换掉的旧色值作为说明。 */
  const badges = css
    .slice(css.indexOf(".retry-step-status {"), css.indexOf(".retry-step-duration"))
    .replace(/\/\*[\s\S]*?\*\//g, "");
  assert.ok(!/rgb\(\s*\d+\s+\d+\s+\d+/.test(badges), "徽章不许硬编码色值");
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(badges), "徽章不许硬编码十六进制色");

  // 选中且悬浮时不能丢掉选中的描边。
  assert.match(
    css,
    /\.retry-chain-step\.is-current:hover\s*\{[^}]*box-shadow:\s*0 0 0 1px var\(--accent\)/,
    "选中态的描边在悬浮时要保住",
  );
});
