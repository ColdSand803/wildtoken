// Request log list, performance formatting, snapshots, and detail dialog.
const LOG_SENSITIVE_MASK = "******";
const LOG_RATE_ANIMATION_MS = 520;
const LOG_STREAM_PATH = "/api/admin/logs/stream";
const LOG_STREAM_RELOAD_DEBOUNCE_MS = 240;
const LOG_STREAM_BATCH_RENDER_MS = 80;
const LOG_ROW_PUSH_ANIMATION_MS = 420;
const LOG_ROW_PUSH_STAGGER_MS = 10;
const LOG_STREAM_RECONNECT_MIN_MS = 1000;
const LOG_STREAM_RECONNECT_MAX_MS = 30000;
const LOG_STREAM_STABLE_CONNECTION_MS = 5000;
const LOG_STREAM_MAX_BUFFER_CHARS = 256 * 1024;
/* 耗时显示到 0.1s，刷新率就得跟上：每秒一次的话小数位永远停在同一个数字上，
   整秒跳变，看着像卡住了。 */
const LOG_ACTIVE_TICK_MS = 100;
/* 表头声明了多少列，占位行的 colspan 就要是多少。写死的数字漏改一处，空态
   和骨架行就会横跨不到底。 */
const LOG_TABLE_COLUMN_COUNT = 10;
/* 错误文本在列表里只给一眼的量，完整内容留给 title 和详情弹窗。 */
const LOG_ERROR_PREVIEW_CHARS = 200;
const logRateReducedMotion = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : null;
const logRateElements = {
  rpm: logRatePills?.querySelector('[data-log-rate="rpm"]') || null,
  tpm: logRatePills?.querySelector('[data-log-rate="tpm"]') || null,
  concurrency: logRatePills?.querySelector('[data-log-rate="concurrency"]') || null,
};
const logRateValues = { rpm: null, tpm: null, concurrency: null };
const logRateDisplayedValues = { rpm: null, tpm: null, concurrency: null };
const logRateAnimationFrames = { rpm: null, tpm: null, concurrency: null };
const logRateAnimations = new WeakMap();
let logPageItems = [];
let logPageFiltersActive = false;
let logStreamController = null;
let logStreamReconnectTimer = null;
let logStreamReloadTimer = null;
let logStreamBatchTimer = null;
let logStreamPendingEntries = [];
let logStreamReconnectAttempts = 0;
let logLoadGeneration = 0;
let logLoadInFlight = false;
let logLoadQueued = false;
/* 在途请求：服务端每次只给全量快照，所以这里整份替换，不做增量合并。
   elapsed 由服务端测量，本地只按收到快照后的时间往前走，避免浏览器时钟
   偏差把耗时算歪。 */
let logActiveRequests = [];
let logActiveReceivedAt = 0;
let logActiveTicker = null;
/* 并发数读服务端给的总数，不是 logActiveRequests.length：后者被
   ActiveSnapshotLimit 截过，真实并发超过上限时它会停在上限不动。 */
let logActiveTotal = 0;

function formatLogUpstreamFilterLabel(upstream) {
  const id = upstream?.id;
  const name = String(upstream?.name || "").trim();
  if (logSensitiveHidden && name) {
    return `#${id} · ${LOG_SENSITIVE_MASK}`;
  }
  return name ? `#${id} ${name}` : `#${id}`;
}

function renderLogFilterOptions() {
  const selected = logUpstreamFilter.value;
  logUpstreamFilter.innerHTML = '<option value="">全部渠道</option>';
  for (const upstream of upstreams) {
    const option = document.createElement("option");
    option.value = upstream.id;
    option.textContent = formatLogUpstreamFilterLabel(upstream);
    logUpstreamFilter.append(option);
  }
  logUpstreamFilter.value = selected;
}

/** Plain-text channel label; prefer upstream_id, fall back to name. */
function formatLogChannelLabel(log) {
  const id = log?.upstream_id;
  const name = (log?.upstream_name || "").trim();
  if (id !== null && id !== undefined) {
    if (logSensitiveHidden && name) {
      return `#${id} · ${LOG_SENSITIVE_MASK}`;
    }
    return name ? `#${id} · ${name}` : `#${id}`;
  }
  if (logSensitiveHidden && name) {
    return LOG_SENSITIVE_MASK;
  }
  return name || "未匹配到渠道";
}

/** List-cell channel stack: id primary, name secondary. */
function formatLogChannelStack(log) {
  const id = log?.upstream_id;
  const name = (log?.upstream_name || "").trim();
  const nameHidden = logSensitiveHidden && Boolean(name);
  const displayName = nameHidden ? LOG_SENSITIVE_MASK : name;
  if (id === null || id === undefined) {
    if (name) {
      return `
        <div class="channel-stack">
          <strong${nameHidden ? " class=\"log-sensitive-value\"" : ` title="${escapeHtml(name)}"`}>${escapeHtml(nameHidden ? LOG_SENSITIVE_MASK : name)}</strong>
          <span class="muted">无 ID</span>
        </div>
      `;
    }
    return "<span class=\"muted\">无（未匹配到渠道）</span>";
  }
  const title = name ? `#${id} · ${displayName}` : `#${id}`;
  const nameLine = name
    ? `<span class="muted${nameHidden ? " log-sensitive-value" : ""}"${nameHidden ? "" : ` title="${escapeHtml(name)}"`}>${escapeHtml(displayName)}</span>`
    : "<span class=\"muted\">无名称</span>";
  return `
    <div class="channel-stack">
      <strong title="${escapeHtml(title)}">#${id}</strong>
      ${nameLine}
    </div>
  `;
}

function formatLogToken(log) {
  const name = String(log?.downstream_token_name || "").trim();
  if (!name) {
    return '<span class="muted">-</span>';
  }
  if (logSensitiveHidden) {
    return `<span class="log-sensitive-value">${LOG_SENSITIVE_MASK}</span>`;
  }
  return `<span title="#${log.downstream_token_id ?? "-"}">${escapeHtml(name)}</span>`;
}

function getLogModelRoute(log) {
  const requestModel = String(log.request_model || "").trim();
  const upstreamModel = String(log.upstream_model || "").trim();
  const fallbackModel = String(log.model || "").trim();
  const request = requestModel || fallbackModel;
  const upstream = upstreamModel || (requestModel ? fallbackModel : "");
  const mapped = Boolean(request && upstream && request !== upstream);
  return { request, upstream, mapped };
}

function formatLogModelText(log) {
  const route = getLogModelRoute(log);
  if (route.mapped) {
    return `${route.request} -> ${route.upstream}`;
  }
  return route.request || route.upstream || "-";
}

function renderLogModel(log) {
  const route = getLogModelRoute(log);
  if (!route.request && !route.upstream) {
    return '<span class="muted">-</span>';
  }
  if (!route.mapped) {
    const value = route.request || route.upstream;
    return `<span class="model-text model-single" title="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
  }
  const title = `请求模型：${route.request}；上游模型：${route.upstream}`;
  return `
    <span class="model-route" title="${escapeHtml(title)}">
      <span class="model-route-line">
        <span class="model-text model-request">${escapeHtml(route.request)}</span>
      </span>
      <span class="model-route-line model-route-target">
        <span class="model-route-icon" aria-hidden="true">↳</span>
        <span class="model-text model-upstream">${escapeHtml(route.upstream)}</span>
      </span>
    </span>
  `;
}

/* 思考强度有三个环节：下游请求的、实际发往上游的（渠道强度映射改写后）、
   上游回报的。相邻重复的环节会被合并，所以没发生改写、上游也没回报强度时，
   显示的仍然只是一个值。 */
function getReasoningEffortRoute(log) {
  const steps = [
    { label: "请求强度", value: String(log?.reasoning_effort || "").trim() },
    { label: "上游强度", value: String(log?.upstream_reasoning_effort || "").trim() },
    { label: "响应强度", value: String(log?.response_reasoning_effort || "").trim() },
  ].filter((step) => step.value);

  const chain = [];
  for (const step of steps) {
    if (chain.length > 0 && chain[chain.length - 1].value === step.value) {
      continue;
    }
    chain.push(step);
  }
  return { chain, mapped: chain.length > 1 };
}

function reasoningEffortTitle(chain) {
  return chain.map((step) => `${step.label}：${step.value}`).join("；");
}

function renderLogReasoningEffort(log) {
  const { chain } = getReasoningEffortRoute(log);
  if (chain.length === 0) {
    return '<span class="muted">-</span>';
  }
  if (chain.length === 1) {
    const value = chain[0].value;
    return `<span class="model-text model-single" title="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
  }
  const [first, ...rest] = chain;
  const followers = rest
    .map((step) => `
      <span class="model-route-line model-route-target">
        <span class="model-route-icon" aria-hidden="true">↳</span>
        <span class="model-text model-upstream">${escapeHtml(step.value)}</span>
      </span>
    `)
    .join("");
  return `
    <span class="model-route" title="${escapeHtml(reasoningEffortTitle(chain))}">
      <span class="model-route-line">
        <span class="model-text model-request">${escapeHtml(first.value)}</span>
      </span>
      ${followers}
    </span>
  `;
}

/* 列表里只留输入和输出两行。总计是两者相加，缓存和思考在扫列表时用不上——
   它们都还在详情面板里（formatTokenDetailPanel）。
   箭头指向模型：↑ 是发过去的，↓ 是收回来的。 */
/* 详情列：只有出错的请求有东西可看。成功的请求留空，否则整列都是占位符，
   反而把真正出错的那几行淹了。

   来源只能是日志行自带的 error 字段：列表不加载请求/响应快照，从响应体里
   掘错误文本（errorMessageFromSnapshot）是详情弹窗的事。 */
function renderLogErrorDetail(log) {
  const message = String(log?.error || "").trim();
  if (!message) {
    return '<span class="muted">-</span>';
  }
  const preview = compactText(message, LOG_ERROR_PREVIEW_CHARS);
  return `<span class="log-error-detail" title="${escapeHtml(message)}">${escapeHtml(preview)}</span>`;
}

function formatTokens(log) {
  const part = (value) => (value === null || value === undefined ? "-" : value);
  const lines = [
    ["↑", "输入", log.prompt_tokens, "in"],
    ["↓", "输出", log.completion_tokens, "out"],
  ];
  const label = lines
    .map(([, name, value]) => `${name} ${part(value)} tokens`)
    .join("，");
  return `
    <span class="token-io" aria-label="${escapeHtml(label)}">
      ${lines.map(([arrow, name, value, tone]) => `
        <span class="token-io-line token-io-${tone}" title="${escapeHtml(`${name} ${part(value)} tokens`)}">
          <span class="token-io-arrow" aria-hidden="true">${arrow}</span>
          <b>${escapeHtml(String(part(value)))}</b>
        </span>
      `).join("")}
    </span>
  `;
}

function formatCacheHitRate(log) {
  const cacheHit = Number(log.prompt_cached_tokens);
  const input = Number(log.prompt_tokens);
  if (
    !Number.isFinite(cacheHit)
    || !Number.isFinite(input)
    || input <= 0
  ) {
    return "-";
  }
  const percent = (cacheHit / input) * 100;
  if (percent === 0) {
    return "0%";
  }
  if (percent < 10) {
    return `${percent.toFixed(1)}%`;
  }
  return `${Math.round(percent)}%`;
}

function formatTokensPerSecondLine(log) {
  const rate = outputTokensPerSecond(log);
  if (rate === null) {
    return "";
  }
  const label = rate >= 100 ? String(Math.round(rate)) : rate.toFixed(1);
  const tone = rate >= 20 ? "ok" : rate >= 8 ? "warn" : "danger";
  return `<small><span class="duration-time ${tone}" title="输出吞吐 ${escapeHtml(label)} tokens/s">${escapeHtml(label)}</span> tokens/s</small>`;
}

function formatTokenDetailPanel(log) {
  const part = (value) => (value === null || value === undefined ? "-" : value);
  const metric = ([label, value, tone]) => `
    <span class="log-detail-token-metric ${escapeHtml(tone)}">
      <small>${escapeHtml(label)}</small>
      <b>${escapeHtml(String(part(value)))}</b>
    </span>
  `;
  const metrics = [
    ["输入", log.prompt_tokens, "input"],
    ["输出", log.completion_tokens, "output"],
    ["总计", log.total_tokens, "total"],
    ["缓存命中", log.prompt_cached_tokens, "cache-read"],
    ["缓存率", formatCacheHitRate(log), "cache-rate"],
    ["思考", log.completion_reasoning_tokens, "reasoning"],
  ];
  return `
    <div class="log-detail-token-panel" aria-label="输入 输出 总计 缓存命中 缓存率 思考 tokens">
      ${metrics.map(metric).join("")}
    </div>
  `;
}

function formatSeconds(ms) {
  return ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;
}

function firstTokenTone(ms) {
  if (ms === null || ms === undefined) {
    return "neutral";
  }
  const value = Number(ms);
  if (!Number.isFinite(value)) {
    return "neutral";
  }
  if (value < 5000) {
    return "ok";
  }
  if (value >= 10000) {
    return "danger";
  }
  return "warn";
}

function formatFirstTokenTime(ms) {
  const label = formatSeconds(ms);
  const tone = firstTokenTone(ms);
  return `<span class="first-token-time ${tone}" title="首字耗时 ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function outputTokensPerSecond(log) {
  const completionTokens = Number(log.completion_tokens);
  const durationMs = Number(log.duration_ms);
  if (
    !Number.isFinite(completionTokens)
    || completionTokens <= 0
    || !Number.isFinite(durationMs)
    || durationMs <= 0
  ) {
    return null;
  }
  return completionTokens / (durationMs / 1000);
}

function totalDurationRating(log) {
  const statusCode = Number(log.status_code);
  if (!Number.isFinite(statusCode)) {
    return { tone: "danger", basis: "请求无响应或状态码缺失" };
  }
  if (statusCode < 200 || statusCode >= 300) {
    return { tone: "danger", basis: `HTTP ${statusCode} 错误，优先标红` };
  }

  const durationMs = Number(log.duration_ms);
  if (!Number.isFinite(durationMs) || durationMs <= 0) {
    return { tone: "neutral", basis: "总耗时无数据" };
  }

  const outputRate = outputTokensPerSecond(log);
  if (outputRate !== null) {
    const displayRate = outputRate.toFixed(1).replace(/\.0$/, "");
    return {
      tone: outputRate >= 20 ? "ok" : outputRate >= 8 ? "warn" : "danger",
      basis: `按全程输出吞吐 ${displayRate} t/s 判定`,
    };
  }

  const totalTokens = Number(log.total_tokens);
  if (Number.isFinite(totalTokens) && totalTokens > 0) {
    const totalRate = totalTokens / (durationMs / 1000);
    const displayRate = totalRate.toFixed(1).replace(/\.0$/, "");
    return {
      tone: totalRate >= 80 ? "ok" : totalRate >= 20 ? "warn" : "danger",
      basis: `按总吞吐 ${displayRate} t/s 判定`,
    };
  }

  return {
    tone: durationMs < 30000 ? "ok" : durationMs < 60000 ? "warn" : "danger",
    basis: "无 token 数据，按绝对耗时兜底判定",
  };
}

function formatTotalDurationTime(log) {
  const label = formatSeconds(log.duration_ms);
  const rating = totalDurationRating(log);
  return `<span class="duration-time ${rating.tone}" title="总耗时 ${escapeHtml(label)} · ${escapeHtml(rating.basis)}">${escapeHtml(label)}</span>`;
}

function formatThroughput(log) {
  if (!log.stream) {
    return "";
  }
  const rate = outputTokensPerSecond(log);
  const displayRate = rate === null ? "—" : rate.toFixed(1).replace(/\.0$/, "");
  const rateTitle = rate === null ? "暂无输出吞吐数据" : `输出吞吐 ${displayRate} tokens/s`;
  return `
    <span class="stream-throughput" title="${escapeHtml(rateTitle)}" aria-label="流式响应，${escapeHtml(rateTitle)}">
      <span class="stream-state"><span class="stream-state-dot" aria-hidden="true"></span>流式</span>
      <span class="throughput-stat"><small>TPS</small><strong>${escapeHtml(displayRate)}</strong></span>
    </span>
  `;
}

function normalizeLogRate(value) {
  if (value === null || value === undefined) return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function updateLogRateValue(kind, value) {
  const element = logRateElements[kind];
  if (!element) return;

  if (value !== null && value === logRateValues[kind] && logRateAnimationFrames[kind] !== null) {
    return;
  }

  const previousTarget = logRateValues[kind];
  const previousDisplayed = logRateDisplayedValues[kind];
  if (logRateAnimationFrames[kind] !== null) {
    window.cancelAnimationFrame(logRateAnimationFrames[kind]);
    logRateAnimationFrames[kind] = null;
  }
  const existingAnimation = logRateAnimations.get(element);
  if (existingAnimation) {
    existingAnimation.cancel();
    logRateAnimations.delete(element);
  }

  logRateValues[kind] = value;
  const viewHidden = Boolean(element.closest("[hidden]"));
  const shouldAnimate = previousTarget !== null
    && previousDisplayed !== null
    && value !== null
    && previousTarget !== value
    && !viewHidden
    && !document.hidden
    && !logRateReducedMotion?.matches
    && typeof window.requestAnimationFrame === "function";

  if (!shouldAnimate) {
    element.textContent = value === null ? "—" : value.toLocaleString("zh-CN");
    logRateDisplayedValues[kind] = value;
    return;
  }

  if (typeof element.animate === "function") {
    const offset = value > previousDisplayed ? "0.2em" : "-0.2em";
    const emphasis = element.animate(
      [
        { opacity: 0.55, transform: `translateY(${offset}) scale(0.97)` },
        { opacity: 1, transform: "translateY(0) scale(1)" },
      ],
      {
        duration: LOG_RATE_ANIMATION_MS,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
      },
    );
    logRateAnimations.set(element, emphasis);
    const clearAnimation = () => {
      if (logRateAnimations.get(element) === emphasis) {
        logRateAnimations.delete(element);
      }
    };
    emphasis.addEventListener("finish", clearAnimation, { once: true });
    emphasis.addEventListener("cancel", clearAnimation, { once: true });
  }

  const startedAt = performance.now();
  const delta = value - previousDisplayed;
  const renderFrame = (now) => {
    const progress = Math.min((now - startedAt) / LOG_RATE_ANIMATION_MS, 1);
    const eased = 1 - ((1 - progress) ** 3);
    const displayed = Math.round(previousDisplayed + (delta * eased));
    if (displayed !== logRateDisplayedValues[kind]) {
      element.textContent = displayed.toLocaleString("zh-CN");
      logRateDisplayedValues[kind] = displayed;
    }

    if (progress < 1 && logRateValues[kind] === value) {
      logRateAnimationFrames[kind] = window.requestAnimationFrame(renderFrame);
      return;
    }

    logRateAnimationFrames[kind] = null;
    if (logRateValues[kind] === value) {
      element.textContent = value.toLocaleString("zh-CN");
      logRateDisplayedValues[kind] = value;
    }
  };
  logRateAnimationFrames[kind] = window.requestAnimationFrame(renderFrame);
}

/** Render server-side request and token totals during the trailing minute. */
/* 三个胶囊读两种不同的量：RPM/TPM 是过去 60 秒的速率，并发是此刻的瞬时值。
   标签里写清楚，否则并列在一起会被当成同一个窗口的三个指标。 */
function updateLogRatesLabel() {
  if (!logRatePills) return;

  const { rpm, tpm, concurrency } = logRateValues;
  const show = (value) => (value === null ? "—" : value.toLocaleString("zh-CN"));
  const rate = rpm === null || tpm === null
    ? "最近 60 秒成功请求数或 Token 数暂不可用"
    : `最近 60 秒成功请求数 ${show(rpm)} RPM；成功请求 Token 总数 ${show(tpm)} TPM`;
  const label = `${rate}；当前并发请求 ${show(concurrency)} 个`;
  const title = `${label}；不受当前筛选和分页影响`;

  if (logRatePills.title !== title) logRatePills.title = title;
  if (logRatePills.getAttribute("aria-label") !== label) {
    logRatePills.setAttribute("aria-label", label);
  }
}

function updateLogRates(recentRpm, recentTpm) {
  if (!logRatePills) return;

  updateLogRateValue("rpm", normalizeLogRate(recentRpm));
  updateLogRateValue("tpm", normalizeLogRate(recentTpm));
  updateLogRatesLabel();
}

function normalizeLogCursor(cursor) {
  if (!cursor || typeof cursor.created_at !== "string") {
    return null;
  }
  const id = Number(cursor.id);
  if (!Number.isFinite(id) || id < 1) {
    return null;
  }
  return {
    created_at: cursor.created_at,
    id,
  };
}

function resetLogPagination() {
  logOffset = 0;
  logHasMore = false;
  logCursorStack = [];
  logCurrentCursor = null;
  logNextCursor = null;
  clearLogStreamPendingEntries();
  clearLogNewEntriesNotice();
}

function isOnLatestLogPage() {
  return logOffset === 0 && logCursorStack.length === 0 && !normalizeLogCursor(logCurrentCursor);
}

function clearLogNewEntriesNotice() {
  if (!logNewEntriesNotice) return;
  logNewEntriesNotice.hidden = true;
}

function showLogNewEntriesNotice() {
  if (!logNewEntriesNotice || !logNewEntriesNotice.hidden) return;
  logNewEntriesNotice.hidden = false;
}

function returnToLatestLogPage() {
  resetLogPagination();
  void loadLogs();
}

function shouldStreamLogs() {
  return pageVisible && currentViewFromHash() === "logs" && Boolean(getAdminToken());
}

function scheduleLogStreamReload() {
  if (!shouldStreamLogs()) return;
  if (!isOnLatestLogPage()) {
    showLogNewEntriesNotice();
    return;
  }
  if (logStreamReloadTimer !== null) return;
  logStreamReloadTimer = window.setTimeout(() => {
    logStreamReloadTimer = null;
    if (!shouldStreamLogs()) return;
    if (!isOnLatestLogPage()) {
      showLogNewEntriesNotice();
      return;
    }
    void loadLogs();
  }, LOG_STREAM_RELOAD_DEBOUNCE_MS);
}

function clearLogStreamPendingEntries() {
  if (logStreamBatchTimer !== null) {
    window.clearTimeout(logStreamBatchTimer);
    logStreamBatchTimer = null;
  }
  logStreamPendingEntries = [];
}

function normalizeLogListRow(log) {
  if (!log || typeof log !== "object") {
    return null;
  }
  const id = Number(log.id);
  if (!Number.isSafeInteger(id) || id < 1 || typeof log.created_at !== "string") {
    return null;
  }
  return { ...log, id };
}

function logMatchesStatusFilter(log, status) {
  if (!status) return true;
  const statusCode = Number(log.status_code);
  if (status === "none") {
    return log.status_code === null || log.status_code === undefined;
  }
  if (!Number.isFinite(statusCode)) {
    return false;
  }
  if (status === "2xx") return statusCode >= 200 && statusCode < 300;
  if (status === "4xx") return statusCode >= 400 && statusCode < 500;
  if (status === "5xx") return statusCode >= 500 && statusCode < 600;
  return true;
}

function logMatchesSearchFilter(log, search) {
  const needle = String(search || "").trim().toLowerCase();
  if (!needle) return true;
  const values = [
    log.model,
    log.request_model,
    log.upstream_model,
    log.upstream_name,
    log.downstream_token_name,
    log.error,
    log.id,
    log.status_code,
  ];
  return values.some((value) => (
    value !== null
      && value !== undefined
      && String(value).toLowerCase().includes(needle)
  ));
}

function logMatchesCurrentFilters(log) {
  const upstreamId = logUpstreamFilter.value;
  if (upstreamId && String(log.upstream_id ?? "") !== upstreamId) {
    return false;
  }
  const clientType = logClientFilter?.value || "";
  if (clientType && String(log.client_type || "unknown") !== clientType) {
    return false;
  }
  const status = logStatusFilter?.value || "";
  if (!logMatchesStatusFilter(log, status)) {
    return false;
  }
  return logMatchesSearchFilter(log, logSearchInput?.value || "");
}

function normalizeLogStreamPayload(data) {
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object") {
    return null;
  }
  const log = normalizeLogListRow(
    payload.log && typeof payload.log === "object" ? payload.log : payload,
  );
  if (!log) {
    return null;
  }
  return {
    log,
    recentRpm: normalizeLogRate(payload.recent_rpm),
    recentTpm: normalizeLogRate(payload.recent_tpm),
  };
}

function currentLogPageNumber() {
  return logCursorStack.length + 1;
}

function formatLogPageRange() {
  const count = Array.isArray(logPageItems) ? logPageItems.length : 0;
  if (count === 0) return "暂无记录";
  const start = logOffset + 1;
  const end = logOffset + count;
  return `${start}–${end} 条`;
}

function updateLogPaginationControls() {
  const onFirstPage = logCursorStack.length === 0;
  if (logFirstButton) logFirstButton.disabled = onFirstPage;
  if (logPrevButton) logPrevButton.disabled = onFirstPage;
  if (logNextButton) logNextButton.disabled = !logHasMore || !logNextCursor;
  if (logPageSizeSelect) logPageSizeSelect.value = String(logPageSize);
  if (logPageMeta) {
    const page = currentLogPageNumber();
    const range = formatLogPageRange();
    const moreHint = logHasMore ? " · 还有更多" : "";
    logPageMeta.textContent = countIsEmptyLogPage()
      ? `第 ${page} 页 · 暂无记录`
      : `第 ${page} 页 · ${range}${moreHint}`;
  }
}

function countIsEmptyLogPage() {
  return !Array.isArray(logPageItems) || logPageItems.length === 0;
}

function setLogPageSize(nextSize, { reload = true } = {}) {
  const size = Number(nextSize);
  if (!LOG_PAGE_SIZE_VALUES.has(size) || size === logPageSize) {
    if (logPageSizeSelect) logPageSizeSelect.value = String(logPageSize);
    return;
  }
  logPageSize = size;
  try {
    localStorage.setItem(LOG_PAGE_SIZE_KEY, String(logPageSize));
  } catch {
    /* ignore quota / private mode */
  }
  if (logPageSizeSelect) logPageSizeSelect.value = String(logPageSize);
  resetLogPagination();
  if (reload) void loadLogs();
}

function refreshLatestLogCursorFromItems() {
  const lastItem = logPageItems[logPageItems.length - 1];
  logNextCursor = lastItem ? normalizeLogCursor(lastItem) : null;
  updateLogPaginationControls();
}

function animateShiftedLogRow(row, previousRect, index) {
  if (
    !row
    || !previousRect
    || !row.isConnected
    || typeof row.animate !== "function"
    || logRateReducedMotion?.matches
    || document.hidden
  ) {
    return;
  }

  const currentRect = row.getBoundingClientRect();
  const deltaY = previousRect.top - currentRect.top;
  if (!Number.isFinite(deltaY) || Math.abs(deltaY) < 1) {
    return;
  }

  for (const animation of row.getAnimations?.() || []) {
    animation.cancel();
  }

  row.style.willChange = "transform, opacity";
  const animation = row.animate(
    [
      { transform: `translateY(${deltaY}px)`, opacity: 0.84 },
      { transform: "translateY(0)", opacity: 1 },
    ],
    {
      duration: LOG_ROW_PUSH_ANIMATION_MS,
      delay: Math.min(index * LOG_ROW_PUSH_STAGGER_MS, 90),
      easing: "cubic-bezier(0.16, 1, 0.3, 1)",
      fill: "both",
    },
  );
  const clearWillChange = () => {
    if (row.isConnected) {
      row.style.willChange = "";
    }
  };
  animation.addEventListener("finish", clearWillChange, { once: true });
  animation.addEventListener("cancel", clearWillChange, { once: true });
}

/* ── 进行中的请求 ─────────────────────────────────── */

function normalizeActiveRequest(request) {
  if (!request || typeof request !== "object") {
    return null;
  }
  const id = Number(request.id);
  if (!Number.isSafeInteger(id) || id < 1) {
    return null;
  }
  const elapsed = Number(request.elapsed_ms);
  return {
    ...request,
    id,
    elapsed_ms: Number.isFinite(elapsed) && elapsed >= 0 ? elapsed : 0,
  };
}

/* 进行中的请求走同一套筛选，但不参与 id 和状态码匹配：登记号和日志 id
   是两套编号，拿它去对搜索框里的数字会误中无关的行。状态码置空是实情，
   所以按 2xx/4xx/5xx 筛选时它们自然退场。 */
function activeMatchesCurrentFilters(request) {
  return logMatchesCurrentFilters({ ...request, id: null, status_code: null });
}

function visibleActiveRequests() {
  if (!isOnLatestLogPage()) return [];
  return logActiveRequests.filter(activeMatchesCurrentFilters);
}

function activeElapsedMs(request) {
  return Math.max(0, request.elapsed_ms + (Date.now() - logActiveReceivedAt));
}

function formatActiveElapsed(ms) {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) {
    return `${seconds.toFixed(1)}s`;
  }
  const minutes = Math.floor(seconds / 60);
  return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}

/* 路由还没选完时没有渠道，这和日志里的“未匹配到渠道”不是一回事。 */
function formatActiveChannel(request) {
  if (request.upstream_id === null || request.upstream_id === undefined) {
    return '<span class="muted">路由中…</span>';
  }
  return formatLogChannelStack(request);
}

function createActiveLogRow(request) {
  const row = document.createElement("tr");
  row.className = "log-row log-row--active";
  row.dataset.activeId = String(request.id);
  row.title = "请求进行中，完成后才会写入日志";
  const attempt = Number(request.attempt);
  const attemptBadge = Number.isFinite(attempt) && attempt > 1
    ? `<span class="badge warn active-attempt" title="已换过 ${attempt} 个渠道">第 ${attempt} 次</span>`
    : "";
  row.innerHTML = `
    <td class="time-cell" data-col="time">
      <span>${escapeHtml(formatLogTimestamp(request.started_at))}</span>
      <span class="muted">进行中</span>
    </td>
    <td class="channel-cell" data-col="channel">${formatActiveChannel(request)}</td>
    <td class="token-cell" data-col="token">${formatLogToken(request)}</td>
    <td data-col="client"><span class="badge neutral">${escapeHtml(request.client_type || "unknown")}</span></td>
    <td class="model-cell" data-col="model">${renderLogModel(request)}</td>
    <td class="col-reasoning" data-col="reasoning">${renderLogReasoningEffort(request)}</td>
    <td data-col="status">
      <span class="badge neutral status-active">
        <span class="status-active-dot" aria-hidden="true"></span>进行中
      </span>
      ${attemptBadge}
    </td>
    <td class="duration-cell" data-col="duration">
      <span class="latency-metrics">
        <span class="latency-metric">
          <small>已用时</small>
          <span class="duration-time neutral" data-active-elapsed>${escapeHtml(formatActiveElapsed(activeElapsedMs(request)))}</span>
        </span>
      </span>
    </td>
    <td class="tokens-cell" data-col="tokens"><span class="muted">-</span></td>
    <td class="detail-cell" data-col="detail"><span class="muted">-</span></td>
  `;
  return row;
}

function updateActiveElapsedCells() {
  const byId = new Map(logActiveRequests.map((request) => [String(request.id), request]));
  let rendered = 0;
  for (const row of logRows.querySelectorAll("tr[data-active-id]")) {
    const request = byId.get(row.dataset.activeId);
    const cell = row.querySelector("[data-active-elapsed]");
    if (!request || !cell) continue;
    // 超过一分钟后显示 m/s 不带小数，十次里有九次算出来是同一个字符串；
    // 比一下再写，省掉这些无谓的 DOM 改动。
    const text = formatActiveElapsed(activeElapsedMs(request));
    if (cell.textContent !== text) cell.textContent = text;
    rendered += 1;
  }
  if (rendered === 0) stopActiveElapsedTicker();
}

function startActiveElapsedTicker() {
  if (logActiveTicker !== null) return;
  logActiveTicker = window.setInterval(updateActiveElapsedCells, LOG_ACTIVE_TICK_MS);
}

function stopActiveElapsedTicker() {
  if (logActiveTicker === null) return;
  window.clearInterval(logActiveTicker);
  logActiveTicker = null;
}

/* 进行中的行每次重建，不做原地打补丁：只有快照真的变了服务端才会发，
   而计时走字只改单元格文本，所以这里不会频繁到把动画抹掉。 */
function syncActiveLogRows() {
  if (!logRows) return;

  for (const row of logRows.querySelectorAll("tr[data-active-id]")) {
    row.remove();
  }

  const visible = visibleActiveRequests();
  if (visible.length === 0) {
    stopActiveElapsedTicker();
    // 最后一条在途请求消失后，被它挤掉的空态要回来。
    if (!logRows.querySelector("tr")) {
      renderLogRows(logPageItems, logRenderOptions());
    }
    return;
  }

  // 有在途请求就不是“暂无记录”，占位行让位。
  for (const placeholder of logRows.querySelectorAll(".empty-state, .no-match-state")) {
    placeholder.closest("tr")?.remove();
  }

  const fragment = document.createDocumentFragment();
  for (const request of visible) {
    fragment.append(createActiveLogRow(request));
  }
  logRows.insertBefore(fragment, logRows.firstChild);
  applyAllColumnVisibility();
  startActiveElapsedTicker();
}

/* total 可以大于 requests.length：列表有上限，计数没有。缺失时退回列表长度，
   这是它能说的最大实话。 */
function setLogActiveRequests(requests, total) {
  logActiveRequests = Array.isArray(requests)
    ? requests.map(normalizeActiveRequest).filter(Boolean)
    : [];
  logActiveReceivedAt = Date.now();
  const counted = normalizeLogRate(total);
  logActiveTotal = counted === null ? logActiveRequests.length : counted;
  updateLogConcurrency();
  syncActiveLogRows();
}

function updateLogConcurrency() {
  updateLogRateValue("concurrency", logActiveTotal);
  updateLogRatesLabel();
}

function insertLiveLogRows(logs) {
  const rows = logs.filter((log) => !logRows.querySelector(`tr[data-log-id="${log.id}"]`));
  if (rows.length === 0) return;

  if (logRows.querySelector(".empty-state, .no-match-state, .skeleton-row")) {
    logRows.replaceChildren();
  }

  const existingRows = [...logRows.querySelectorAll("tr[data-log-id]")];
  const existingRowRects = new Map(
    existingRows.map((row) => [row.dataset.logId, row.getBoundingClientRect()]),
  );
  const fragment = document.createDocumentFragment();
  rows.forEach((log, index) => {
    fragment.append(createLogRow(log, {
      incoming: true,
      delayMs: index * 45,
    }));
  });
  logRows.insertBefore(fragment, logRows.firstChild);

  const visibleIds = new Set(logPageItems.map((log) => String(log.id)));
  for (const row of [...logRows.querySelectorAll("tr[data-log-id]")]) {
    if (!visibleIds.has(row.dataset.logId)) {
      row.remove();
    }
  }

  requestAnimationFrame(() => {
    if (logRateReducedMotion?.matches || document.hidden) {
      return;
    }

    for (const [index, row] of existingRows.entries()) {
      const previousRect = existingRowRects.get(row.dataset.logId);
      animateShiftedLogRow(row, previousRect, index);
    }
  });

  applyAllColumnVisibility();
  // 新日志行是插在最前面的，重排一次把进行中的行拉回顶部。
  syncActiveLogRows();
}

function flushLogStreamEntries() {
  if (logStreamBatchTimer !== null) {
    window.clearTimeout(logStreamBatchTimer);
    logStreamBatchTimer = null;
  }
  if (logStreamPendingEntries.length === 0) return;
  if (logLoadInFlight || logsLoading) return;
  if (!isOnLatestLogPage()) {
    logStreamPendingEntries = [];
    showLogNewEntriesNotice();
    return;
  }

  const pending = logStreamPendingEntries;
  logStreamPendingEntries = [];
  const existingIds = new Set(logPageItems.map((log) => Number(log.id)));
  const incoming = [];
  for (const entry of pending) {
    const log = entry.log;
    if (existingIds.has(log.id) || !logMatchesCurrentFilters(log)) {
      continue;
    }
    existingIds.add(log.id);
    incoming.push(log);
  }
  if (incoming.length === 0) return;

  const compareLogs = (a, b) => {
    const timeDelta = parseLogTimestamp(b.created_at) - parseLogTimestamp(a.created_at);
    return Number.isFinite(timeDelta) && timeDelta !== 0 ? timeDelta : b.id - a.id;
  };
  incoming.sort(compareLogs);
  const nextItems = [...incoming, ...logPageItems].sort(compareLogs);
  const seen = new Set();
  const uniqueItems = nextItems.filter((log) => {
    if (seen.has(log.id)) return false;
    seen.add(log.id);
    return true;
  });
  if (uniqueItems.length > logPageSize) {
    logHasMore = true;
  }
  logPageItems = uniqueItems.slice(0, logPageSize);

  const visibleIds = new Set(logPageItems.map((log) => log.id));
  insertLiveLogRows(incoming.filter((log) => visibleIds.has(log.id)));
  refreshLatestLogCursorFromItems();
  clearLogNewEntriesNotice();
}

function scheduleLogStreamBatchRender() {
  if (logStreamBatchTimer !== null) return;
  logStreamBatchTimer = window.setTimeout(flushLogStreamEntries, LOG_STREAM_BATCH_RENDER_MS);
}

function handleLogStreamRecord(record) {
  if (record.recentRpm !== null && record.recentTpm !== null) {
    updateLogRates(record.recentRpm, record.recentTpm);
  } else {
    scheduleLogStreamReload();
  }

  if (!isOnLatestLogPage()) {
    showLogNewEntriesNotice();
    return;
  }
  if (!logMatchesCurrentFilters(record.log)) {
    return;
  }
  logStreamPendingEntries.push(record);
  scheduleLogStreamBatchRender();
}

function parseLogStreamEvent(frame) {
  const event = {
    type: "message",
    data: [],
  };
  for (const line of frame.split(/\r\n|\n|\r/)) {
    if (!line || line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator === -1 ? line : line.slice(0, separator);
    let value = separator === -1 ? "" : line.slice(separator + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      event.type = value || "message";
    } else if (field === "data") {
      event.data.push(value);
    }
  }
  return {
    ...event,
    data: event.data.join("\n"),
  };
}

function normalizeActiveStreamPayload(data) {
  let payload;
  try {
    payload = JSON.parse(data);
  } catch {
    return null;
  }
  if (!payload || typeof payload !== "object" || !Array.isArray(payload.requests)) {
    return null;
  }
  return { requests: payload.requests, total: payload.total };
}

function handleLogStreamEvent(event) {
  if (!shouldStreamLogs()) return;
  if (event.type === "resync") {
    scheduleLogStreamReload();
    return;
  }
  if (event.type === "active") {
    const payload = normalizeActiveStreamPayload(event.data);
    if (payload) setLogActiveRequests(payload.requests, payload.total);
    return;
  }
  if (event.type !== "log" || !event.data) return;

  const record = normalizeLogStreamPayload(event.data);
  if (!record) {
    scheduleLogStreamReload();
    return;
  }
  handleLogStreamRecord(record);
}

async function consumeLogStream(responseBody, controller) {
  const reader = responseBody.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const processBufferedEvents = () => {
    while (true) {
      const boundary = /\r\n\r\n|\n\n|\r\r/.exec(buffer);
      if (!boundary) break;
      const frame = buffer.slice(0, boundary.index);
      buffer = buffer.slice(boundary.index + boundary[0].length);
      handleLogStreamEvent(parseLogStreamEvent(frame));
    }
  };

  try {
    while (!controller.signal.aborted) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      if (buffer.length > LOG_STREAM_MAX_BUFFER_CHARS) {
        throw new Error("日志实时连接返回了过大的未完成事件");
      }
      processBufferedEvents();
    }
    buffer += decoder.decode();
    if (buffer.length > LOG_STREAM_MAX_BUFFER_CHARS) {
      throw new Error("日志实时连接返回了过大的未完成事件");
    }
    processBufferedEvents();
    if (buffer.trim()) {
      handleLogStreamEvent(parseLogStreamEvent(buffer));
    }
  } finally {
    reader.releaseLock();
  }
}

async function getLogStreamErrorMessage(response) {
  let message = `${response.status} ${response.statusText}`;
  try {
    const data = await response.json();
    message = data.detail || data.error?.message || data.error || message;
  } catch {
    // Keep the HTTP status message when an SSE endpoint returns a non-JSON error.
  }
  return message;
}

function scheduleLogStreamReconnect() {
  if (!shouldStreamLogs() || logStreamReconnectTimer !== null) return;
  const exponent = Math.min(logStreamReconnectAttempts, 5);
  const baseDelay = Math.min(
    LOG_STREAM_RECONNECT_MIN_MS * (2 ** exponent),
    LOG_STREAM_RECONNECT_MAX_MS,
  );
  logStreamReconnectAttempts += 1;
  const delay = Math.round(baseDelay * (0.8 + (Math.random() * 0.4)));
  logStreamReconnectTimer = window.setTimeout(() => {
    logStreamReconnectTimer = null;
    startLogStream();
  }, delay);
  startLogRefresh();
  updateLiveIndicator();
}

async function openLogStream(controller) {
  let openedAt = 0;
  let shouldReconnect = true;
  try {
    const token = getAdminToken();
    if (!token) return;
    const headers = new Headers({ Accept: "text/event-stream" });
    headers.set("x-admin-token", token);
    const response = await fetch(LOG_STREAM_PATH, {
      cache: "no-store",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      const message = await getLogStreamErrorMessage(response);
      if (response.status === 401 && logStreamController === controller) {
        shouldReconnect = false;
        clearAdminToken();
        showAdminTokenError(message);
        openAdminTokenDialog();
      }
      throw new Error(message);
    }
    if (!response.body || typeof response.body.getReader !== "function") {
      throw new Error("日志实时连接不可用");
    }
    openedAt = Date.now();
    // Initial connects and reconnects can miss rows that committed while the
    // stream was unavailable. Reconcile once in those cases, then rely on
    // incremental inserts for steady-state updates.
    if (logStreamReconnectAttempts > 0 || !logsLoadedOnce) {
      scheduleLogStreamReload();
    }
    await consumeLogStream(response.body, controller);
  } catch (error) {
    if (controller.signal.aborted) return;
    // Reconnection is intentionally quiet. The existing list and manual refresh
    // remain available while the server or network is briefly unavailable.
  } finally {
    if (logStreamController !== controller) return;
    logStreamController = null;
    if (!shouldReconnect || !shouldStreamLogs()) {
      updateLiveIndicator();
      return;
    }
    if (openedAt && Date.now() - openedAt >= LOG_STREAM_STABLE_CONNECTION_MS) {
      logStreamReconnectAttempts = 0;
    }
    scheduleLogStreamReconnect();
  }
}

function startLogStream() {
  if (
    !shouldStreamLogs()
    || logStreamController !== null
    || logStreamReconnectTimer !== null
    || typeof window.fetch !== "function"
    || typeof window.AbortController !== "function"
    || typeof window.TextDecoder !== "function"
  ) {
    return;
  }
  const controller = new AbortController();
  logStreamController = controller;
  stopLogRefresh();
  updateLiveIndicator();
  void openLogStream(controller);
}

function stopLogStream() {
  if (logStreamReconnectTimer !== null) {
    window.clearTimeout(logStreamReconnectTimer);
    logStreamReconnectTimer = null;
  }
  if (logStreamReloadTimer !== null) {
    window.clearTimeout(logStreamReloadTimer);
    logStreamReloadTimer = null;
  }
  clearLogStreamPendingEntries();
  const controller = logStreamController;
  logStreamController = null;
  if (controller) controller.abort();
  logStreamReconnectAttempts = 0;
  // 断开后还留着的在途行只会永远计时下去。重连或下一次 loadLogs 会重新给。
  setLogActiveRequests([], 0);
  updateLiveIndicator();
}

function logRenderOptions() {
  return {
    noMatch: logPageFiltersActive && logPageItems.length === 0,
    emptyTitle: "暂无请求日志",
    emptyCopy: logPageFiltersActive ? "全库中没有符合当前筛选条件的日志。" : "暂无代理请求记录。",
  };
}

function renderCurrentLogPage() {
  renderLogRows(logPageItems, logRenderOptions());
  syncActiveLogRows();
}

function updateLogSensitiveToggle() {
  if (!logSensitiveToggle) return;
  const hidden = logSensitiveHidden;
  const label = hidden
    ? "敏感信息已屏蔽，点击显示令牌与渠道名"
    : "敏感信息显示中，点击屏蔽令牌与渠道名";
  logSensitiveToggle.setAttribute("aria-pressed", String(hidden));
  logSensitiveToggle.setAttribute("aria-label", label);
  logSensitiveToggle.title = label;
  logSensitiveToggle.classList.toggle("is-active", hidden);
}

function refreshOpenLogDetail() {
  if (!currentLogDetail || !logDetailDialog?.open) return;
  logDetailSummary.textContent = formatLogDetailSummary(currentLogDetail);
  if (logDetailMeta) {
    logDetailMeta.innerHTML = formatLogDetailMeta(currentLogDetail);
  }
}

function setLogSensitiveHidden(hidden) {
  logSensitiveHidden = Boolean(hidden);
  try {
    localStorage.setItem(LOG_SENSITIVE_HIDDEN_KEY, String(logSensitiveHidden));
  } catch {
    // The current-page preference still applies when storage is unavailable.
  }
  updateLogSensitiveToggle();
  renderLogFilterOptions();
  renderCurrentLogPage();
  refreshOpenLogDetail();
}

function appendLogPaginationParams(params) {
  const cursor = normalizeLogCursor(logCurrentCursor);
  if (cursor) {
    params.set("before_created_at", cursor.created_at);
    params.set("before_id", String(cursor.id));
  } else {
    params.set("offset", String(logOffset));
  }
}

function formatStatusBadge(statusCode) {
  if (statusCode === null || statusCode === undefined) {
    return '<span class="muted">无响应</span>';
  }
  if (statusCode >= 200 && statusCode < 300) {
    return `<span class="badge on status-2xx">${statusCode}</span>`;
  }
  if (statusCode >= 300 && statusCode < 400) {
    return `<span class="badge neutral status-3xx">${statusCode}</span>`;
  }
  if (statusCode >= 400 && statusCode < 500) {
    return `<span class="badge danger status-4xx">${statusCode}</span>`;
  }
  if (statusCode >= 500) {
    return `<span class="badge danger status-5xx">${statusCode}</span>`;
  }
  return `<span class="badge neutral status-other">${statusCode}</span>`;
}

// 详情页的单行写法，环节的取值和合并规则与列表里的 getReasoningEffortRoute 一致。
function formatReasoningEffort(log, options = {}) {
  const { badge = true, fallback = '<span class="muted">-</span>' } = options;
  const { chain } = getReasoningEffortRoute(log);
  if (chain.length === 0) {
    return fallback;
  }

  const value = chain.map((step) => escapeHtml(step.value)).join(" → ");
  return badge ? `<span class="badge neutral">${value}</span>` : value;
}

function createLogRow(log, options = {}) {
  const row = document.createElement("tr");
  row.className = "log-row";
  if (options.incoming) {
    row.classList.add("log-row--incoming");
    row.style.setProperty("--log-row-delay", `${Math.max(0, options.delayMs || 0)}ms`);
  }
  row.dataset.logId = log.id;
  row.tabIndex = 0;
  row.title = log.error || "点击查看请求详情";
  const time = formatLogTimestamp(log.created_at);
  const channel = formatLogChannelStack(log);
  const status = formatStatusBadge(log.status_code);
  const throughput = formatThroughput(log);
  row.innerHTML = `
    <td class="time-cell" data-col="time">
      <span>${escapeHtml(time)}</span>
      <span class="muted">#${log.id}</span>
    </td>
    <td class="channel-cell" data-col="channel">${channel}</td>
    <td class="token-cell" data-col="token">${formatLogToken(log)}</td>
    <td data-col="client"><span class="badge neutral">${escapeHtml(log.client_type || "unknown")}</span></td>
    <td class="model-cell" data-col="model">${renderLogModel(log)}</td>
    <td class="col-reasoning" data-col="reasoning">
      ${renderLogReasoningEffort(log)}
    </td>
    <td data-col="status">${status}</td>
    <td class="duration-cell" data-col="duration">
      <span class="latency-metrics">
        <span class="latency-metric"><small>首字</small>${formatFirstTokenTime(log.first_token_ms)}</span>
        <span class="latency-metric"><small>总耗时</small>${formatTotalDurationTime(log)}</span>
      </span>
      ${throughput}
    </td>
    <td class="tokens-cell" data-col="tokens">${formatTokens(log)}</td>
    <td class="detail-cell" data-col="detail">${renderLogErrorDetail(log)}</td>
  `;
  return row;
}

function renderLogRows(items, options = {}) {
  const {
    emptyTitle = "暂无请求日志",
    emptyCopy = "当前范围内还没有代理请求记录。",
    emptyActionLabel = "刷新日志",
    emptyActionId = "refresh-logs",
    noMatch = false,
  } = options;

  logRows.replaceChildren();

  if (logsLoading && !logsLoadedOnce) {
    replaceChildren(logRows, skeletonRows(LOG_TABLE_COLUMN_COUNT, 6));
    return;
  }

  if (items.length === 0) {
    if (noMatch) {
      replaceChildren(logRows, noMatchStateRow(LOG_TABLE_COLUMN_COUNT, {
        title: "无匹配日志",
        copy: "全库中没有符合当前筛选条件的日志。",
        actionLabel: "清除筛选",
        actionId: "clear-log-filters",
      }));
    } else {
      replaceChildren(logRows, emptyStateRow(LOG_TABLE_COLUMN_COUNT, {
        title: emptyTitle,
        copy: emptyCopy,
        actionLabel: emptyActionLabel,
        actionId: emptyActionId,
      }));
    }
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const log of items) {
    fragment.append(createLogRow(log));
  }
  logRows.append(fragment);
  applyAllColumnVisibility();
}

function formatByteCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "未知大小";
  }
  if (value < 1024) {
    return `${value} B`;
  }
  if (value < 1024 * 1024) {
    return `${(value / 1024).toFixed(1).replace(/\.0$/, "")} KB`;
  }
  return `${(value / (1024 * 1024)).toFixed(1).replace(/\.0$/, "")} MB`;
}

function prettyBodyText(text) {
  const clean = String(text || "");
  const trimmed = clean.trim();
  if (!trimmed) {
    return "<empty body>";
  }
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch (_) {
    return clean;
  }
}

function formatBodyHeading(body) {
  const parts = ["Body"];
  if (!body || typeof body !== "object") {
    return parts.join(" · ");
  }
  if (body.encoding) {
    parts.push(body.encoding);
  }
  const byteLength = typeof body.byte_length === "number"
    ? body.byte_length
    : (typeof body.size === "number" ? body.size : null);
  if (typeof byteLength === "number") {
    parts.push(formatByteCount(byteLength));
  }
  if (body.truncated) {
    parts.push("已截断");
  }
  return parts.join(" · ");
}

function normalizeSnapshotBody(rawBody) {
  // Retention marker on the whole snapshot is handled by the caller.
  if (rawBody === null || rawBody === undefined) {
    return { kind: "missing" };
  }
  // Legacy backend stored plain UTF-8 string bodies.
  if (typeof rawBody === "string") {
    return {
      kind: "text",
      text: rawBody,
      byte_length: new TextEncoder().encode(rawBody).length,
    };
  }
  if (typeof rawBody !== "object") {
    return { kind: "missing" };
  }
  if (rawBody.cleared) {
    return { kind: "cleared" };
  }
  const byteLength = typeof rawBody.byte_length === "number"
    ? rawBody.byte_length
    : (typeof rawBody.size === "number" ? rawBody.size : null);

  if (typeof rawBody.text === "string") {
    return {
      kind: "text",
      text: rawBody.text,
      byte_length: byteLength,
      encoding: rawBody.encoding,
      truncated: Boolean(rawBody.truncated),
    };
  }

  const base64 = typeof rawBody.base64 === "string"
    ? rawBody.base64
    : (typeof rawBody.base64_truncated === "string" ? rawBody.base64_truncated : null);
  if (base64 !== null) {
    return {
      kind: "base64",
      base64,
      byte_length: byteLength,
      encoding: rawBody.encoding || "base64",
      truncated: Boolean(rawBody.truncated || rawBody.base64_truncated),
    };
  }

  if (byteLength === 0) {
    return { kind: "empty", byte_length: 0 };
  }
  return { kind: "missing" };
}

function compactText(value, maxLength = 360) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function firstErrorMessageFromValue(value) {
  if (!value) return "";
  if (typeof value === "string") return compactText(value);
  if (Array.isArray(value)) {
    for (const item of value) {
      const message = firstErrorMessageFromValue(item);
      if (message) return message;
    }
    return "";
  }
  if (typeof value !== "object") return "";

  if (value.error) {
    const nested = firstErrorMessageFromValue(value.error);
    if (nested) return nested;
  }

  for (const key of ["message", "detail", "error_message", "msg", "reason"]) {
    if (typeof value[key] === "string" && value[key].trim()) {
      return compactText(value[key]);
    }
  }

  if (value.errors) {
    const nested = firstErrorMessageFromValue(value.errors);
    if (nested) return nested;
  }

  return "";
}

function snapshotBodyText(snapshot) {
  const normalized = normalizeSnapshotBody(snapshot?.body);
  if (normalized.kind === "text") {
    return normalized.text || "";
  }
  // Legacy: body stored as plain string at snapshot.body
  if (typeof snapshot?.body === "string") {
    return snapshot.body;
  }
  return "";
}

function errorMessageFromSnapshot(snapshot) {
  const text = snapshotBodyText(snapshot).trim();
  if (!text) return "";

  try {
    const message = firstErrorMessageFromValue(JSON.parse(text));
    if (message) return message;
  } catch (_) {
    // Non-JSON error bodies are handled below.
  }

  const status = snapshot?.status_code ?? snapshot?.status;
  if (status >= 400 && !text.startsWith("<")) {
    return compactText(text);
  }
  return "";
}

function extractLogDetailError(detail) {
  return (
    errorMessageFromSnapshot(detail.downstream_response)
    || errorMessageFromSnapshot(detail.upstream_response)
    || compactText(detail.error)
  );
}

function formatLogDetailSummary(detail) {
  const time = formatLogTimestamp(detail.created_at);
  const channel = formatLogChannelLabel(detail);
  const status = detail.status_code === null || detail.status_code === undefined
    ? "无响应"
    : `HTTP ${detail.status_code}`;
  return `#${detail.id} · ${time} · ${channel} · ${formatLogModelText(detail)} · ${status}`;
}

function formatLogDetailMeta(detail) {
  const channel = formatLogChannelLabel(detail);
  const statusText = detail.status_code === null || detail.status_code === undefined
    ? "无响应"
    : `HTTP ${detail.status_code}`;
  const statusTone = detail.status_code === null || detail.status_code === undefined
    ? "neutral"
    : detail.status_code >= 400
      ? "danger"
      : detail.status_code >= 200 && detail.status_code < 300
        ? "ok"
        : "neutral";
  const reasoning = formatReasoningEffort(detail, { badge: false, fallback: "" });
  const modelText = formatLogModelText(detail);
  const modelLine = [escapeHtml(modelText), reasoning].filter(Boolean).join(" · ");
  const streamLabel = detail.stream ? "流式" : "非流式";
  const extractedError = extractLogDetailError(detail);
  const statusErrorLine = extractedError
    ? `<small class="log-detail-status-error" title="${escapeHtml(extractedError)}">错误：${escapeHtml(extractedError)}</small>`
    : "";
  const errorCard = extractedError
    ? `
      <div class="log-detail-meta-card log-detail-error-card">
        <span class="log-detail-meta-label">错误详情</span>
        <strong>${escapeHtml(extractedError)}</strong>
      </div>
    `
    : "";

  return `
    <div class="log-detail-meta-card log-detail-route-card">
      <span class="log-detail-meta-label">请求路由</span>
      <strong title="${escapeHtml(channel)}">${escapeHtml(channel)}</strong>
      <small title="${modelLine}">${modelLine}</small>
      <small class="log-detail-route-request" title="${escapeHtml(detail.method)} /${escapeHtml(detail.path)} · ${escapeHtml(streamLabel)}">
        ${escapeHtml(detail.method)} /${escapeHtml(detail.path)} · ${escapeHtml(streamLabel)}
      </small>
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">状态与耗时</span>
      <strong><span class="log-detail-status ${statusTone}">${escapeHtml(statusText)}</span></strong>
      <small>首字 ${formatFirstTokenTime(detail.first_token_ms)} · 总耗时 ${formatTotalDurationTime(detail)}</small>
      ${formatTokensPerSecondLine(detail)}
      ${statusErrorLine}
    </div>
    <div class="log-detail-meta-card log-detail-token-card">
      <span class="log-detail-meta-label">Tokens</span>
      ${formatTokenDetailPanel(detail)}
    </div>
    ${errorCard}
  `;
}

function formatHttpSnapshot(snapshot) {
  if (!snapshot) {
    return "未记录\n\n这条历史日志没有保存这一项请求或响应详情。";
  }

  // Retention cleanup may replace the whole snapshot with { cleared: true }.
  if (snapshot.cleared && !snapshot.method && snapshot.status_code == null && snapshot.status == null) {
    return "日志正文已按保留策略清理，仅保留元数据。请查看较新的日志以获得完整请求/响应。";
  }

  const status = snapshot.status_code ?? snapshot.status;
  const headers = { ...(snapshot.headers || {}) };
  let firstLine;

  if (snapshot.method) {
    let target = snapshot.url || "/";
    try {
      const url = new URL(snapshot.url);
      target = `${url.pathname || "/"}${url.search}`;
      if (!Object.keys(headers).some((name) => name.toLowerCase() === "host")) {
        headers.host = url.host;
      }
    } catch {
      // Older logs may have a non-absolute URL. Keep the recorded target intact.
    }
    firstLine = `${snapshot.method} ${target} HTTP/1.1`;
  } else {
    const reason = {
      200: "OK",
      201: "Created",
      202: "Accepted",
      204: "No Content",
      400: "Bad Request",
      401: "Unauthorized",
      403: "Forbidden",
      404: "Not Found",
      429: "Too Many Requests",
      500: "Internal Server Error",
      502: "Bad Gateway",
      503: "Service Unavailable",
      504: "Gateway Timeout",
    }[status];
    firstLine = `HTTP/1.1 ${status ?? "-"}${reason ? ` ${reason}` : ""}`;
  }

  const lines = [firstLine];
  for (const [name, value] of Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}: ${value}`);
  }
  lines.push("");

  const normalized = normalizeSnapshotBody(snapshot.body);
  if (normalized.kind === "cleared") {
    lines.push("[Body cleared by retention policy]");
  } else if (normalized.kind === "missing") {
    // No content follows the HTTP header terminator.
  } else if (normalized.kind === "empty") {
    // No content follows the HTTP header terminator.
  } else if (normalized.kind === "base64") {
    lines.push(`[Binary body encoded as base64; ${normalized.byte_length ?? 0} bytes captured]`);
    lines.push(normalized.base64 || "");
  } else {
    lines.push(prettyBodyText(normalized.text || ""));
  }
  if (normalized.truncated) {
    lines.push("");
    lines.push(`[Body truncated; original length: ${normalized.byte_length ?? "unknown"} bytes]`);
  }
  return lines.join("\n");
}

function closeLogDetailDialog() {
  requestDetailGrid?.classList.remove("is-focused");
  for (const button of document.querySelectorAll(".log-detail-expand")) {
    button.textContent = "放大查看";
    button.setAttribute("aria-pressed", "false");
  }
  clearDialogMaximized(logDetailDialog);
  if (logDetailDialog.open && typeof logDetailDialog.close === "function") {
    logDetailDialog.close();
  } else {
    logDetailDialog.removeAttribute("open");
  }
}

function openLogDetailDialog() {
  if (typeof logDetailDialog.showModal === "function") {
    logDetailDialog.showModal();
  } else {
    logDetailDialog.setAttribute("open", "");
  }
}

/* 查看模式在会话与原始之间切换，记在 localStorage 里跨会话保留。隐私模式下
   storage 会直接抛，所以读写都包起来，失败就退回默认值。 */
const LOG_VIEW_MODE_STORAGE_KEY = "wildtoken.logViewMode";
let logDetailViewMode = readStoredLogViewMode();

function readStoredLogViewMode() {
  try {
    return window.localStorage.getItem(LOG_VIEW_MODE_STORAGE_KEY) === "raw" ? "raw" : "conversation";
  } catch {
    return "conversation";
  }
}

function storeLogViewMode(mode) {
  try {
    window.localStorage.setItem(LOG_VIEW_MODE_STORAGE_KEY, mode);
  } catch {
    // 存不下就只在本次会话里生效。
  }
}

// 从快照里取出正文文本和它的截断信息，供会话解析与截断提示使用。
function snapshotBodyForConversation(snapshot) {
  if (!snapshot || typeof snapshot !== "object" || snapshot.cleared) return null;
  const normalized = normalizeSnapshotBody(snapshot.body);
  if (normalized.kind !== "text" || !normalized.text) return null;
  return {
    text: normalized.text,
    meta: {
      truncated: Boolean(normalized.truncated),
      byteLength: normalized.byte_length,
      capturedLength: new TextEncoder().encode(normalized.text).length,
    },
  };
}

function renderLogConversation(container, field, snapshot) {
  const body = snapshotBodyForConversation(snapshot);
  if (!body) {
    container.innerHTML = `
      <div class="conv-empty">
        <strong>没有可解析的正文</strong>
        <span>这条记录没有保存正文，或正文已按保留策略清理。</span>
      </div>
    `;
    return;
  }
  const parsed = field.endsWith("_response")
    ? parseConversationResponse(body.text)
    : parseConversationRequest(body.text);
  container.innerHTML = renderConversationHtml(parsed, body.meta);
}

function renderLogDetailSection(details) {
  const field = details.dataset.field;
  const pre = details.querySelector("pre");
  const conversation = details.querySelector(".log-conversation");
  const snapshot = currentLogDetail ? currentLogDetail[field] : null;
  const showConversation = logDetailViewMode === "conversation";

  pre.hidden = showConversation;
  if (conversation) conversation.hidden = !showConversation;

  if (!currentLogDetail) {
    pre.textContent = "";
    if (conversation) conversation.innerHTML = "";
    return;
  }
  if (showConversation && conversation) {
    renderLogConversation(conversation, field, snapshot);
    return;
  }
  pre.textContent = formatHttpSnapshot(snapshot);
}

// 切模式后，已经展开的面板要立刻按新模式重画。
function setLogDetailViewMode(mode) {
  logDetailViewMode = mode === "raw" ? "raw" : "conversation";
  storeLogViewMode(logDetailViewMode);
  updateLogViewModeControls();
  for (const details of logDetailSections) {
    if (details.open) renderLogDetailSection(details);
  }
}

function updateLogViewModeControls() {
  for (const button of document.querySelectorAll("[data-log-view-mode]")) {
    button.setAttribute("aria-pressed", String(button.dataset.logViewMode === logDetailViewMode));
  }
}

async function showLogDetail(logId) {
  currentLogDetail = null;
  logDetailTitle.textContent = "请求详情";
  logDetailSummary.textContent = "正在加载...";
  if (logDetailMeta) {
    logDetailMeta.innerHTML = `
      <div class="log-detail-meta-card log-detail-loading-card">
        <span class="log-detail-meta-label">加载中</span>
        <strong>正在读取日志详情</strong>
        <small>请求 / 响应快照会在展开卡片时渲染。</small>
      </div>
    `;
  }
  for (const details of logDetailSections) {
    details.open = false;
    details.querySelector("pre").textContent = "";
    const conversation = details.querySelector(".log-conversation");
    if (conversation) conversation.innerHTML = "";
  }
  requestDetailGrid?.classList.remove("is-focused");
  for (const button of document.querySelectorAll(".log-detail-expand")) {
    button.textContent = "放大查看";
    button.setAttribute("aria-pressed", "false");
  }
  openLogDetailDialog();

  try {
    const detail = await api(`/api/admin/logs/${logId}`);
    currentLogDetail = detail;
    logDetailTitle.textContent = "请求详情";
    logDetailSummary.textContent = formatLogDetailSummary(detail);
    if (logDetailMeta) {
      logDetailMeta.innerHTML = formatLogDetailMeta(detail);
    }
    for (const details of logDetailSections) {
      if (details.open) {
        renderLogDetailSection(details);
      }
    }
  } catch (error) {
    logDetailSummary.textContent = `加载失败：${error.message}`;
    if (logDetailMeta) {
      logDetailMeta.innerHTML = `
        <div class="log-detail-meta-card log-detail-error-card">
          <span class="log-detail-meta-label">加载失败</span>
          <strong>${escapeHtml(error.message)}</strong>
          <small>请稍后重试或刷新日志列表。</small>
        </div>
      `;
    }
  }
}

async function loadLogs() {
  const requestGeneration = ++logLoadGeneration;
  if (logLoadInFlight) {
    logLoadQueued = true;
    return;
  }
  logLoadInFlight = true;
  const showSkeleton = !logsLoadedOnce;
  if (showSkeleton) {
    logsLoading = true;
    renderLogRows([]);
  }

  try {
    const upstreamId = logUpstreamFilter.value;
    const search = (logSearchInput?.value || "").trim();
    const status = logStatusFilter?.value || "";
    const clientType = logClientFilter?.value || "";
    const filtersActive = Boolean(upstreamId || search || status || clientType);
    const params = new URLSearchParams({
      limit: String(logPageSize),
    });
    appendLogPaginationParams(params);
    if (upstreamId) params.set("upstream_id", upstreamId);
    if (search) params.set("search", search);
    if (status) params.set("status", status);
    if (clientType) params.set("client_type", clientType);

    const page = await api(`/api/admin/logs?${params}`);
    if (requestGeneration !== logLoadGeneration) return;
    const items = page.items || [];
    logHasMore = Boolean(page.has_more);
    logNextCursor = normalizeLogCursor(page.next_cursor)
      || (logHasMore && items.length > 0 ? normalizeLogCursor(items[items.length - 1]) : null);
    logsLoadedOnce = true;
    logPageItems = items;
    logPageFiltersActive = filtersActive;
    renderCurrentLogPage();
    // 服务端只在第一页附带在途请求；在其他页上不要拿空值覆盖推送给的快照。
    if (isOnLatestLogPage()) setLogActiveRequests(page.active || [], page.active_total);
    if (isOnLatestLogPage()) clearLogNewEntriesNotice();
    if (logStreamPendingEntries.length === 0) {
      updateLogRates(page.recent_rpm, page.recent_tpm);
    }
    updateLogPaginationControls();
    renderUpstreamSummary();
  } catch (error) {
    if (requestGeneration !== logLoadGeneration) return;
    updateLogRates(null, null);
    setStatus(`加载日志失败：${error.message}`, "error");
  } finally {
    logLoadInFlight = false;
    logsLoading = false;
    if (logLoadQueued) {
      logLoadQueued = false;
      void loadLogs();
    } else {
      flushLogStreamEntries();
    }
  }
}

updateLogSensitiveToggle();
logNewEntriesButton?.addEventListener("click", returnToLatestLogPage);
