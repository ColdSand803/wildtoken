// Request log list, performance formatting, snapshots, and detail dialog.
const LOG_SENSITIVE_MASK = "******";
const FAILURE_STAGE_LABELS = {
  first_event: "首事件前失败",
  stream: "传输中断",
  client_cancelled: "客户端取消",
  connect: "连接建立失败",
  upstream_status: "上游状态异常",
  request_build: "请求构建失败",
  response_body: "响应体读取失败",
  no_route: "未找到路由",
  rate_limited: "渠道限流",
  gateway: "网关错误",
};

function formatFailureStage(stage) {
  if (!stage) return "";
  return FAILURE_STAGE_LABELS[stage] || String(stage);
}

function formatFailureRetryable(retryable) {
  if (retryable === null || retryable === undefined) return "";
  return retryable ? "可重试错误" : "不可重试错误";
}

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
const logRateReducedMotion = typeof window.matchMedia === "function"
  ? window.matchMedia("(prefers-reduced-motion: reduce)")
  : null;
const logRateElements = {
  rpm: logRpm?.querySelector('[data-log-rate="rpm"]') || null,
  tpm: logRpm?.querySelector('[data-log-rate="tpm"]') || null,
};
const logRateValues = { rpm: null, tpm: null };
const logRateDisplayedValues = { rpm: null, tpm: null };
const logRateAnimationFrames = { rpm: null, tpm: null };
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
  const attemptIndex = Number(log?.attempt_index) || 0;
  const attemptBadge = attemptIndex > 0
    ? `<span class="log-row-attempt-badge" title="重试第 ${attemptIndex} 次 (关联请求: ${escapeHtml(log?.request_uid || "-")})">重试 #${attemptIndex}</span>`
    : "";

  if (id === null || id === undefined) {
    if (name) {
      return `
        <div class="channel-stack">
          <strong${nameHidden ? " class=\"log-sensitive-value\"" : ` title="${escapeHtml(name)}"`}>${escapeHtml(nameHidden ? LOG_SENSITIVE_MASK : name)}</strong>
          <span class="muted">无 ID</span>
          ${attemptBadge}
        </div>
      `;
    }
    return attemptBadge
      ? `<div class="channel-stack"><span class="muted">无（未匹配到渠道）</span>${attemptBadge}</div>`
      : "<span class=\"muted\">无（未匹配到渠道）</span>";
  }
  const title = name ? `#${id} · ${displayName}` : `#${id}`;
  const nameLine = name
    ? `<span class="muted${nameHidden ? " log-sensitive-value" : ""}"${nameHidden ? "" : ` title="${escapeHtml(name)}"`}>${escapeHtml(displayName)}</span>`
    : "<span class=\"muted\">无名称</span>";
  return `
    <div class="channel-stack">
      <strong title="${escapeHtml(title)}">#${id}</strong>
      ${nameLine}
      ${attemptBadge}
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

function getReasoningEffortRoute(log) {
  const request = String(log?.reasoning_effort || "").trim();
  const response = String(log?.response_reasoning_effort || "").trim();
  const mapped = Boolean(request && response && request !== response);
  return { request, response, mapped };
}

function renderLogReasoningEffort(log) {
  const route = getReasoningEffortRoute(log);
  if (!route.request && !route.response) {
    return '<span class="muted">-</span>';
  }
  if (!route.mapped) {
    const value = route.request || route.response;
    return `<span class="model-text model-single" title="${escapeHtml(value)}">${escapeHtml(value)}</span>`;
  }
  const title = `请求强度：${route.request}；响应强度：${route.response}`;
  return `
    <span class="model-route" title="${escapeHtml(title)}">
      <span class="model-route-line">
        <span class="model-text model-request">${escapeHtml(route.request)}</span>
      </span>
      <span class="model-route-line model-route-target">
        <span class="model-route-icon" aria-hidden="true">↳</span>
        <span class="model-text model-upstream">${escapeHtml(route.response)}</span>
      </span>
    </span>
  `;
}

function formatTokens(log) {
  const part = (value) => (value === null || value === undefined ? "-" : value);
  const cacheHitRate = formatCacheHitRate(log);
  const metrics = [
    ["输入", log.prompt_tokens],
    ["输出", log.completion_tokens],
    ["总计", log.total_tokens],
    ["缓存命中", log.prompt_cached_tokens],
    ["缓存率", cacheHitRate],
    ["思考", log.completion_reasoning_tokens],
  ];
  /* The cache rate as a number as well as a label, so a theme can draw it as a
     meter instead of only printing it. formatCacheHitRate() has already done
     the arithmetic for the text; this publishes what it computed rather than
     deriving anything new, and clamps it because a stray value outside 0–100
     would push a fill past its track.

     Theme-agnostic on purpose: without a rule reading --cache-rate this is an
     unset custom property and nothing changes. Same arrangement as
     --pointer-x/y in events.js and data-tone-escalated in dashboard.js. */
  const rateMatch = /^(\d+(?:\.\d+)?)%$/.exec(String(cacheHitRate));
  const rateStyle = rateMatch
    ? ` style="--cache-rate:${Math.min(100, Math.max(0, Number(rateMatch[1])))}"`
    : "";

  return `
    <span class="token-triple" aria-label="输入 输出 总计 缓存命中 缓存率 思考 tokens">
      ${metrics.map(([label, value]) => `
        <span${label === "缓存率" ? rateStyle : ""}><b>${escapeHtml(String(part(value)))}</b><small>${escapeHtml(label)}</small></span>
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
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) {
    return `<span class="first-token-time neutral" title="首字耗时不可用">不可用</span>`;
  }
  const label = formatSeconds(ms);
  const tone = firstTokenTone(ms);
  return `<span class="first-token-time ${tone}" title="首字耗时 ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function formatGatewayPrepTime(ms, attemptIndex) {
  const isRetry = attemptIndex !== null && attemptIndex !== undefined && Number(attemptIndex) > 0;
  const titlePrefix = isRetry ? "网关准备（含前序重试与退避）" : "网关准备";
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) {
    return `<span class="first-token-time neutral" title="${escapeHtml(titlePrefix)}耗时不可用">不可用</span>`;
  }
  const label = formatSeconds(ms);
  return `<span class="first-token-time neutral" title="${escapeHtml(titlePrefix)} ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

function formatHeadersArrivalTime(ms) {
  if (ms === null || ms === undefined || !Number.isFinite(Number(ms))) {
    return `<span class="first-token-time neutral" title="连接与响应头耗时不可用">不可用</span>`;
  }
  const label = formatSeconds(ms);
  return `<span class="first-token-time neutral" title="连接与响应头 ${escapeHtml(label)}">${escapeHtml(label)}</span>`;
}

/* 耗时四段：原来是一行 `A 0.0s · B 5.4s · C 2.8s · ...` 的长句，而
   .log-detail-meta-card small 是 nowrap + ellipsis，三列网格里必然被截成
   "…总耗…"。改成会换行的小块流，每块自带一个和下面瀑布同色的色点，
   顺带把图例和数值合成一处。 */
function formatLogTimingChips(chips) {
  const body = chips.filter(Boolean).map((chip) => {
    const swatch = chip.segClass
      ? `<span class="log-timing-chip-dot ${chip.segClass}" aria-hidden="true"></span>`
      : "";
    return `<span class="log-timing-chip"${chip.title ? ` title="${escapeHtml(chip.title)}"` : ""}>
      ${swatch}<span class="log-timing-chip-label">${escapeHtml(chip.label)}</span>${chip.valueMarkup}
    </span>`;
  }).join("");
  return body ? `<div class="log-timing-chips">${body}</div>` : "";
}

/* 瀑布条。段的描述由调用方给（每段：宽度百分比字符串、皮肤 class、悬浮卡内容），
   几何/悬浮/键盘可达一律走 wtSegmentBar（static/js/components.js），
   和看板的状态分布、错误时间分布是同一套。 */
function formatLogTimingBar(segments, title) {
  const usable = segments.filter((seg) => seg && Number(seg.width) > 0);
  if (!usable.length) return "";
  return wtSegmentBar({
    trackClass: "log-detail-timing-bar",
    title,
    ariaLabel: title,
    segments: usable.map((seg) => ({
      className: `timing-seg ${seg.segClass}`,
      width: seg.width,
      interactive: true,
      tip: { title: seg.label, lines: [seg.value, `占总耗时 ${seg.width}%`] },
      title: seg.title,
      ariaLabel: `${seg.label} ${seg.value}`,
      role: "img",
    })),
  });
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
function updateLogRates(recentRpm, recentTpm) {
  if (!logRpm) return;

  const rpm = normalizeLogRate(recentRpm);
  const tpm = normalizeLogRate(recentTpm);
  const displayRpm = rpm === null ? "—" : rpm.toLocaleString("zh-CN");
  const displayTpm = tpm === null ? "—" : tpm.toLocaleString("zh-CN");
  const label = rpm === null || tpm === null
    ? "最近 60 秒成功请求数或 Token 数暂不可用"
    : `最近 60 秒成功请求数 ${displayRpm} RPM；成功请求 Token 总数 ${displayTpm} TPM`;
  const title = `${label}；不受当前筛选和分页影响`;
  if (logRpm.title !== title) logRpm.title = title;
  if (logRpm.getAttribute("aria-label") !== label) {
    logRpm.setAttribute("aria-label", label);
  }

  updateLogRateValue("rpm", rpm);
  updateLogRateValue("tpm", tpm);
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
  const raw = log?.status_code;
  if (raw === null || raw === undefined || raw === "" || !Number.isFinite(Number(raw))) {
    return status === "none" || status === "error";
  }
  const statusCode = Number(raw);
  if (status === "none") return false;
  if (status === "2xx") return statusCode >= 200 && statusCode < 300;
  if (status === "4xx") return statusCode >= 400 && statusCode < 500;
  if (status === "5xx") return statusCode >= 500 && statusCode < 600;
  if (status === "other") return (statusCode >= 100 && statusCode < 200) || (statusCode >= 300 && statusCode < 400);
  if (status === "error") return statusCode < 200 || statusCode >= 300;
  return true;
}

function parseUtcDateMs(val) {
  if (!val || typeof val !== "string") return NaN;
  const str = val.trim();
  if (!str) return NaN;
  if (str.includes("T") || str.endsWith("Z") || /[+-]\d{2}:\d{2}$/.test(str)) {
    return Date.parse(str);
  }
  return Date.parse(str.replace(" ", "T") + "Z");
}

function logMatchesTimeRange(createdAt, startIso, endIso) {
  if (!createdAt || !startIso || !endIso) return true;
  const logMs = parseUtcDateMs(createdAt);
  const startMs = parseUtcDateMs(startIso);
  const endMs = parseUtcDateMs(endIso);
  if (!Number.isFinite(logMs) || !Number.isFinite(startMs) || !Number.isFinite(endMs)) {
    return true;
  }
  return logMs >= startMs && logMs < endMs;
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
  if (!log || typeof log !== "object") return false;

  const upstreamId = typeof logUpstreamFilter !== "undefined" && logUpstreamFilter ? logUpstreamFilter.value : "";
  if (upstreamId && String(log.upstream_id ?? "") !== upstreamId) {
    return false;
  }
  const currentTokenId = typeof getLogDownstreamTokenId === "function"
    ? getLogDownstreamTokenId()
    : (typeof logDownstreamTokenId !== "undefined" ? logDownstreamTokenId : null);
  if (currentTokenId !== null && currentTokenId !== undefined) {
    if (log.downstream_token_id === null || log.downstream_token_id === undefined || Number(log.downstream_token_id) !== Number(currentTokenId)) {
      return false;
    }
  }
  const clientType = typeof logClientFilter !== "undefined" && logClientFilter ? logClientFilter.value : "";
  if (clientType && String(log.client_type || "unknown") !== clientType) {
    return false;
  }
  const status = typeof logStatusFilter !== "undefined" && logStatusFilter ? logStatusFilter.value : "";
  if (!logMatchesStatusFilter(log, status)) {
    return false;
  }
  const streamVal = typeof logStreamFilter !== "undefined" && logStreamFilter ? logStreamFilter.value : "";
  if (streamVal === "true" || streamVal === "false") {
    const isStream = Boolean(log.stream);
    if (isStream !== (streamVal === "true")) {
      return false;
    }
  }
  const minDurationVal = typeof logMinDurationInput !== "undefined" && logMinDurationInput ? logMinDurationInput.value.trim() : "";
  if (minDurationVal !== "") {
    const minMs = Number(minDurationVal);
    if (Number.isFinite(minMs) && minMs >= 0) {
      if (log.duration_ms === null || log.duration_ms === undefined || Number(log.duration_ms) < minMs) {
        return false;
      }
    }
  }
  const timeRange = typeof getLogTimeRange === "function" ? getLogTimeRange() : null;
  if (timeRange && timeRange.start && timeRange.end) {
    if (!logMatchesTimeRange(log.created_at, timeRange.start, timeRange.end)) {
      return false;
    }
  }
  return logMatchesSearchFilter(log, typeof logSearchInput !== "undefined" && logSearchInput ? logSearchInput.value : "");
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

function insertLiveLogRows(logs) {
  const rows = logs.filter((log) => !logRows.querySelector(`tr[data-log-id="${log.id}"]`));
  if (rows.length === 0) return;

  if (logRows.querySelector(".empty-state, .no-match-state, .skeleton-row")) {
    logRows.innerHTML = "";
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

function handleLogStreamEvent(event) {
  if (!shouldStreamLogs()) return;
  if (event.type === "resync") {
    scheduleLogStreamReload();
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

    const streamParams = new URLSearchParams();
    const upstreamId = typeof logUpstreamFilter !== "undefined" && logUpstreamFilter ? logUpstreamFilter.value : "";
    const currentTokenId = typeof getLogDownstreamTokenId === "function"
      ? getLogDownstreamTokenId()
      : (typeof logDownstreamTokenId !== "undefined" ? logDownstreamTokenId : null);
    const search = typeof logSearchInput !== "undefined" && logSearchInput ? (logSearchInput.value || "").trim() : "";
    const status = typeof logStatusFilter !== "undefined" && logStatusFilter ? logStatusFilter.value : "";
    const clientType = typeof logClientFilter !== "undefined" && logClientFilter ? logClientFilter.value : "";
    const streamVal = typeof logStreamFilter !== "undefined" && logStreamFilter ? logStreamFilter.value : "";
    const minDurationVal = typeof logMinDurationInput !== "undefined" && logMinDurationInput ? logMinDurationInput.value.trim() : "";
    const { start: rangeStart, end: rangeEnd } = typeof getLogTimeRange === "function" ? getLogTimeRange() : { start: "", end: "" };

    if (upstreamId) streamParams.set("upstream_id", upstreamId);
    if (currentTokenId !== null && currentTokenId !== undefined) streamParams.set("downstream_token_id", String(currentTokenId));
    if (search) streamParams.set("search", search);
    if (status) streamParams.set("status", status);
    if (clientType) streamParams.set("client_type", clientType);
    if (streamVal === "true" || streamVal === "false") streamParams.set("stream", streamVal);
    if (minDurationVal !== "" && /^\d+$/.test(minDurationVal)) streamParams.set("min_duration_ms", minDurationVal);
    if (rangeStart && rangeEnd) {
      streamParams.set("start", rangeStart);
      streamParams.set("end", rangeEnd);
    }

    const streamQuery = streamParams.toString();
    const streamPath = streamQuery ? `${LOG_STREAM_PATH}?${streamQuery}` : LOG_STREAM_PATH;

    const response = await fetch(streamPath, {
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
  updateLiveIndicator();
}

function restartLogStream() {
  if (logStreamController !== null || logStreamReconnectTimer !== null) {
    stopLogStream();
  }
  if (shouldStreamLogs()) {
    startLogStream();
  }
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

/* 详情卡整块重刷会把悬浮卡一起冲掉，所以写入和重绑必须成对出现——
   三个调用点（打开、脱敏切换、轮询刷新）都走这里。 */
function renderLogDetailMeta(detail) {
  if (!logDetailMeta) return;
  logDetailMeta.innerHTML = formatLogDetailMeta(detail);
  wtBindHoverCard(logDetailMeta);
}

function refreshOpenLogDetail() {
  if (!currentLogDetail || !logDetailDialog?.open) return;
  logDetailSummary.textContent = formatLogDetailSummary(currentLogDetail);
  renderLogDetailMeta(currentLogDetail);
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

function formatReasoningEffort(requestEffort, responseEffort, options = {}) {
  const { badge = true, fallback = '<span class="muted">-</span>' } = options;
  if (!requestEffort && !responseEffort) {
    return fallback;
  }

  const values = requestEffort === responseEffort
    ? [requestEffort]
    : [requestEffort, responseEffort].filter(Boolean);
  const escapedValues = values.map(escapeHtml);
  const value = escapedValues.join(" → ");
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
  const failureStage = log.failure_stage ? formatFailureStage(log.failure_stage) : "";
  const failureStageTag = failureStage
    ? `<span class="log-failure-stage-tag" title="失败阶段：${escapeHtml(failureStage)}">${escapeHtml(failureStage)}</span>`
    : "";
  const statusMarkup = failureStageTag
    ? `<div class="log-status-stack">${status}${failureStageTag}</div>`
    : status;
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
    <td data-col="status">${statusMarkup}</td>
    <td class="duration-cell" data-col="duration">
      <span class="latency-metrics">
        <span class="latency-metric"><small>首字</small>${formatFirstTokenTime(log.first_token_ms)}</span>
        <span class="latency-metric"><small>总耗时</small>${formatTotalDurationTime(log)}</span>
      </span>
      ${throughput}
    </td>
    <td class="tokens-cell" data-col="tokens">${formatTokens(log)}</td>
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

  logRows.innerHTML = "";

  if (logsLoading && !logsLoadedOnce) {
    logRows.innerHTML = skeletonRowsMarkup(9, 6);
    return;
  }

  if (items.length === 0) {
    if (noMatch) {
      logRows.innerHTML = noMatchStateCell(9, {
        title: "无匹配日志",
        copy: "全库中没有符合当前筛选条件的日志。",
        actionLabel: "清除筛选",
        actionId: "clear-log-filters",
      });
    } else {
      logRows.innerHTML = emptyStateCell(9, {
        title: emptyTitle,
        copy: emptyCopy,
        actionLabel: emptyActionLabel,
        actionId: emptyActionId,
      });
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
  const reasoning = formatReasoningEffort(detail.reasoning_effort, detail.response_reasoning_effort, { badge: false, fallback: "" });
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

  let timingLine = "";
  let timingBarHtml = "";

  const totalMs = detail.duration_ms != null && Number.isFinite(Number(detail.duration_ms))
    ? Number(detail.duration_ms)
    : null;

  const hasPreUpstream = detail.pre_upstream_ms != null && Number.isFinite(Number(detail.pre_upstream_ms));
  const preUpstreamMs = hasPreUpstream ? Math.max(0, Number(detail.pre_upstream_ms)) : null;

  const attemptIndex = detail.attempt_index != null && Number.isFinite(Number(detail.attempt_index))
    ? Number(detail.attempt_index)
    : null;
  const isRetry = attemptIndex !== null && attemptIndex > 0;
  const gatewayLabelName = isRetry ? "网关准备(含重试)" : "网关准备";
  const gatewayFullTitle = isRetry ? "网关准备（含前序重试与退避）" : "网关准备";

  const hasHeaders = detail.upstream_headers_ms != null && Number.isFinite(Number(detail.upstream_headers_ms));
  const upstreamHeadersMs = hasHeaders ? Math.max(0, Number(detail.upstream_headers_ms)) : null;

  const hasSampledOrigins = hasPreUpstream || hasHeaders;

  if (detail.stream) {
    const hasFirstToken = detail.first_token_ms != null && Number.isFinite(Number(detail.first_token_ms));
    const firstTokenMs = hasFirstToken ? Math.max(0, Number(detail.first_token_ms)) : null;
    const firstTokenLabel = hasFirstToken
      ? formatFirstTokenTime(firstTokenMs)
      : `<span class="first-token-time neutral" title="首字耗时不可用">不可用</span>`;

    const hasGeneration = hasFirstToken && hasHeaders && (firstTokenMs >= upstreamHeadersMs);
    const generationMs = hasGeneration ? Math.max(0, firstTokenMs - upstreamHeadersMs) : null;
    const generationLabel = hasGeneration
      ? formatSeconds(generationMs)
      : `<span class="first-token-time neutral" title="上游生成耗时不可用">不可用</span>`;

    const hasTransfer = hasFirstToken && totalMs != null && (totalMs >= firstTokenMs);
    const transferMs = hasTransfer ? Math.max(0, totalMs - firstTokenMs) : null;
    const transferLabel = hasTransfer
      ? formatSeconds(transferMs)
      : `<span class="first-token-time neutral" title="传输耗时不可用">不可用</span>`;

    if (hasSampledOrigins) {
      const gatewayValueMarkup = formatGatewayPrepTime(preUpstreamMs, attemptIndex);
      const headersValueMarkup = formatHeadersArrivalTime(upstreamHeadersMs);
      const generationValueMarkup = hasGeneration
        ? `<span class="first-token-time neutral" title="上游生成 ${escapeHtml(generationLabel)}">${escapeHtml(generationLabel)}</span>`
        : generationLabel;
      const transferValueMarkup = hasTransfer
        ? `<span class="first-token-time neutral" title="传输耗时 ${escapeHtml(transferLabel)}">${escapeHtml(transferLabel)}</span>`
        : transferLabel;

      /* 四段把首字拆成了「连接/Header」+「上游生成」，firstTokenMs 退化成两段的
         分界点，界面上就没有首字了——而它是流式请求最先要看的数。它横跨两段、
         不对应瀑布里任何单一色块，所以和「总耗时」一样不给色点：没有点正好说明
         这是累积到某一刻的读数，不是又一个独立分段。 */
      timingLine = formatLogTimingChips([
        { segClass: "timing-seg--gateway", label: gatewayLabelName, valueMarkup: gatewayValueMarkup, title: gatewayFullTitle },
        { segClass: "timing-seg--headers", label: "连接/Header", valueMarkup: headersValueMarkup, title: "连接与响应头" },
        { segClass: "timing-seg--generation", label: "上游生成", valueMarkup: generationValueMarkup, title: "上游收到请求到吐出首字" },
        { label: "首字", valueMarkup: firstTokenLabel, title: "首字耗时 (TTFB)：连接/Header + 上游生成" },
        { segClass: "timing-seg--transfer", label: "传输", valueMarkup: transferValueMarkup, title: "首字之后的流式传输" },
        { label: "总耗时", valueMarkup: formatTotalDurationTime(detail) },
      ]);

      if (hasFirstToken && totalMs != null && totalMs > 0) {
        const fullTotal = (preUpstreamMs || 0) + totalMs;
        if (fullTotal > 0) {
          const prePct = preUpstreamMs ? (preUpstreamMs / fullTotal * 100).toFixed(1) : "0.0";
          const hdrMs = hasHeaders ? Math.min(upstreamHeadersMs, firstTokenMs) : 0;
          const hdrPct = hdrMs ? (hdrMs / fullTotal * 100).toFixed(1) : "0.0";
          const genMs = hasGeneration ? generationMs : (hasFirstToken ? Math.max(0, firstTokenMs - hdrMs) : 0);
          const genPct = genMs ? (genMs / fullTotal * 100).toFixed(1) : "0.0";
          const txMs = hasTransfer ? transferMs : 0;
          const txPct = txMs ? (txMs / fullTotal * 100).toFixed(1) : "0.0";

          timingBarHtml = formatLogTimingBar([
            {
              segClass: "timing-seg--gateway",
              width: prePct,
              label: gatewayFullTitle,
              value: `${preUpstreamMs ?? 0}ms`,
              title: `${gatewayFullTitle}: ${preUpstreamMs}ms`,
            },
            {
              segClass: "timing-seg--headers",
              width: hdrPct,
              label: "连接与响应头",
              value: `${hdrMs}ms`,
              title: `连接与响应头: ${hdrMs}ms`,
            },
            {
              segClass: "timing-seg--generation",
              width: genPct,
              label: "上游生成",
              value: `${genMs}ms`,
              title: `上游生成: ${genMs}ms (首字 ${firstTokenMs}ms)`,
            },
            {
              segClass: "timing-seg--transfer",
              width: txPct,
              label: "传输耗时",
              value: `${txMs}ms`,
              title: `传输耗时: ${txMs}ms`,
            },
          ], `总耗时 ${totalMs}ms (网关 ${preUpstreamMs ?? "-"}ms + 连接 ${upstreamHeadersMs ?? "-"}ms + 生成 ${genMs}ms + 传输 ${txMs}ms)`);
        }
      }
    } else {
      // Legacy streaming fallback (when neither pre_upstream_ms nor upstream_headers_ms exists)
      timingLine = formatLogTimingChips([
        { segClass: "timing-seg--ttfb", label: "首字", valueMarkup: firstTokenLabel, title: "首字耗时 (TTFB)" },
        {
          segClass: "timing-seg--transfer",
          label: "传输",
          valueMarkup: escapeHtml(hasTransfer ? transferLabel : "-"),
          title: "首字之后的流式传输",
        },
        { label: "总耗时", valueMarkup: formatTotalDurationTime(detail) },
      ]);

      if (firstTokenMs != null && totalMs != null && totalMs > 0) {
        const ttfbRatio = Math.min(1, Math.max(0, firstTokenMs / totalMs));
        const transferRatio = Math.max(0, 1 - ttfbRatio);
        timingBarHtml = formatLogTimingBar([
          {
            segClass: "timing-seg--ttfb",
            width: (ttfbRatio * 100).toFixed(1),
            label: "首字耗时 (TTFB)",
            value: `${firstTokenMs}ms`,
            title: `首字耗时 (TTFB): ${firstTokenMs}ms`,
          },
          {
            segClass: "timing-seg--transfer",
            width: (transferRatio * 100).toFixed(1),
            label: "传输耗时",
            value: `${transferMs}ms`,
            title: `传输耗时: ${transferMs}ms`,
          },
        ], `总耗时 ${totalMs}ms (首字 ${firstTokenMs}ms + 传输 ${transferMs}ms)`);
      }
    }
  } else {
    // Non-streaming
    if (hasSampledOrigins) {
      const gatewayValueMarkup = formatGatewayPrepTime(preUpstreamMs, attemptIndex);
      const headersValueMarkup = formatHeadersArrivalTime(upstreamHeadersMs);
      const hasTransfer = hasHeaders && totalMs != null && totalMs >= upstreamHeadersMs;
      const transferMs = hasTransfer ? Math.max(0, totalMs - upstreamHeadersMs) : null;
      const transferLabel = hasTransfer ? formatSeconds(transferMs) : null;

      const gatewayChip = {
        segClass: "timing-seg--gateway",
        label: gatewayLabelName,
        valueMarkup: gatewayValueMarkup,
        title: gatewayFullTitle,
      };
      const headersChip = {
        segClass: "timing-seg--headers",
        label: "连接/Header",
        valueMarkup: headersValueMarkup,
        title: "连接与响应头",
      };
      if (hasHeaders && hasTransfer) {
        timingLine = formatLogTimingChips([
          gatewayChip,
          headersChip,
          {
            segClass: "timing-seg--transfer",
            label: "响应传输",
            valueMarkup: escapeHtml(transferLabel),
            title: "响应体传输",
          },
          { label: "总耗时", valueMarkup: formatTotalDurationTime(detail) },
        ]);
      } else if (hasHeaders) {
        timingLine = formatLogTimingChips([
          gatewayChip,
          headersChip,
          { label: "总耗时", valueMarkup: formatTotalDurationTime(detail) },
        ]);
      } else {
        timingLine = formatLogTimingChips([
          gatewayChip,
          { label: "上游耗时", valueMarkup: formatTotalDurationTime(detail) },
        ]);
      }

      if (totalMs != null && totalMs > 0) {
        const fullTotal = (preUpstreamMs || 0) + totalMs;
        if (fullTotal > 0) {
          const prePct = preUpstreamMs ? (preUpstreamMs / fullTotal * 100).toFixed(1) : "0.0";
          const hdrMs = hasHeaders ? Math.min(upstreamHeadersMs, totalMs) : 0;
          const hdrPct = hdrMs ? (hdrMs / fullTotal * 100).toFixed(1) : "0.0";
          const txMs = hasTransfer ? transferMs : (hasHeaders ? 0 : totalMs);
          const txPct = txMs ? (txMs / fullTotal * 100).toFixed(1) : "0.0";
          const txLabel = hasHeaders ? "响应传输" : "上游耗时";

          timingBarHtml = formatLogTimingBar([
            {
              segClass: "timing-seg--gateway",
              width: prePct,
              label: gatewayFullTitle,
              value: `${preUpstreamMs ?? 0}ms`,
              title: `${gatewayFullTitle}: ${preUpstreamMs}ms`,
            },
            {
              segClass: "timing-seg--headers",
              width: hdrPct,
              label: "连接与响应头",
              value: `${hdrMs}ms`,
              title: `连接与响应头: ${hdrMs}ms`,
            },
            {
              segClass: "timing-seg--transfer",
              width: txPct,
              label: txLabel,
              value: `${txMs}ms`,
              title: `${txLabel}: ${txMs}ms`,
            },
          ], `总耗时 ${totalMs}ms (网关 ${preUpstreamMs ?? "-"}ms + 连接 ${upstreamHeadersMs ?? "-"}ms + 传输 ${txMs}ms)`);
        }
      }
    } else {
      timingLine = formatLogTimingChips([
        { label: "总耗时", valueMarkup: formatTotalDurationTime(detail) },
      ]);
    }
  }

  let attemptBadge = "";
  if (attemptIndex !== null && attemptIndex > 0) {
    attemptBadge = `<small class="log-detail-route-attempt" title="重试第 ${attemptIndex} 次 (关联请求: ${escapeHtml(detail.request_uid || "-")})">重试 #${attemptIndex}</small>`;
  }

  let uidBadge = "";
  if (detail.request_uid) {
    const uid = escapeHtml(detail.request_uid);
    uidBadge = `<small class="log-detail-route-uid" title="请求唯一标识 (UID): ${uid}">UID: ${uid}</small>`;
  }

  const stageName = detail.failure_stage ? formatFailureStage(detail.failure_stage) : "";
  const stageBadge = stageName
    ? `<span class="log-detail-failure-stage-badge" title="失败阶段：${escapeHtml(stageName)}">阶段: ${escapeHtml(stageName)}</span>`
    : "";
  const retryableBadge = (detail.failure_retryable !== null && detail.failure_retryable !== undefined)
    ? `<span class="log-detail-retryable-badge ${detail.failure_retryable ? "is-retryable" : "is-non-retryable"}">${detail.failure_retryable ? "可重试错误" : "不可重试错误"}</span>`
    : "";
  const statusHeadMarkup = (stageBadge || retryableBadge)
    ? `<div class="log-detail-status-head"><span class="log-detail-status ${statusTone}">${escapeHtml(statusText)}</span>${stageBadge}${retryableBadge}</div>`
    : `<span class="log-detail-status ${statusTone}">${escapeHtml(statusText)}</span>`;

  return `
    <div class="log-detail-meta-card log-detail-route-card">
      <span class="log-detail-meta-label">请求路由</span>
      <strong title="${escapeHtml(channel)}">${escapeHtml(channel)}</strong>
      <small title="${modelLine}">${modelLine}</small>
      <small class="log-detail-route-request" title="${escapeHtml(detail.method)} /${escapeHtml(detail.path)} · ${escapeHtml(streamLabel)}">
        ${escapeHtml(detail.method)} /${escapeHtml(detail.path)} · ${escapeHtml(streamLabel)}
      </small>
      ${uidBadge}
      ${attemptBadge}
    </div>
    <div class="log-detail-meta-card">
      <span class="log-detail-meta-label">状态与耗时</span>
      <strong>${statusHeadMarkup}</strong>
      ${timingLine}
      ${timingBarHtml}
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

function renderLogDetailSection(details) {
  const pre = details.querySelector("pre");
  pre.textContent = currentLogDetail ? formatHttpSnapshot(currentLogDetail[details.dataset.field]) : "";
}


function renderLogRetryChain(detail) {
  const container = typeof logDetailRetryChain !== "undefined" && logDetailRetryChain
    ? logDetailRetryChain
    : (typeof document !== "undefined" ? document.querySelector("#log-detail-retry-chain") : null);
  if (!container) return;

  if (!detail || !detail.request_uid) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  const candidateMap = new Map();
  if (Array.isArray(logPageItems)) {
    for (const item of logPageItems) {
      if (item && item.request_uid === detail.request_uid) {
        candidateMap.set(item.id, item);
      }
    }
  }
  if (detail && detail.id) {
    candidateMap.set(detail.id, detail);
  }

  const attempts = Array.from(candidateMap.values());
  const maxAttemptIndex = attempts.reduce((max, item) => Math.max(max, Number(item.attempt_index) || 0), 0);

  if (attempts.length <= 1 && maxAttemptIndex === 0) {
    container.hidden = true;
    container.innerHTML = "";
    return;
  }

  attempts.sort((a, b) => {
    const idxA = Number(a.attempt_index) || 0;
    const idxB = Number(b.attempt_index) || 0;
    if (idxA !== idxB) return idxA - idxB;
    return (Number(a.id) || 0) - (Number(b.id) || 0);
  });

  container.hidden = false;
  const uid = escapeHtml(detail.request_uid);

  const stepsHtml = attempts.map((attempt) => {
    const isCurrent = Number(attempt.id) === Number(detail.id);
    const idx = Number(attempt.attempt_index) || 0;
    const stepLabel = idx === 0 ? "首次尝试" : `重试 #${idx}`;
    const statusText = attempt.status_code === null || attempt.status_code === undefined
      ? "无响应"
      : `HTTP ${attempt.status_code}`;
    const statusTone = attempt.status_code === null || attempt.status_code === undefined
      ? "neutral"
      : attempt.status_code >= 400
        ? "danger"
        : attempt.status_code >= 200 && attempt.status_code < 300
          ? "ok"
          : "neutral";
    const channelLabel = formatLogChannelLabel(attempt);
    const dur = attempt.duration_ms != null && Number.isFinite(Number(attempt.duration_ms))
      ? `${Math.round(Number(attempt.duration_ms))}ms`
      : "-";
    const stage = attempt.failure_stage ? (typeof formatFailureStage === "function" ? formatFailureStage(attempt.failure_stage) : String(attempt.failure_stage)) : "";
    const stageBadge = stage ? `<span class="retry-step-stage" title="失败阶段：${escapeHtml(stage)}">${escapeHtml(stage)}</span>` : "";

    return `
      <button
        type="button"
        class="retry-chain-step ${isCurrent ? "is-current" : ""}"
        data-retry-log-id="${attempt.id}"
        ${isCurrent ? 'aria-current="step"' : ""}
        title="查看尝试 #${idx} (ID #${attempt.id}) 详情"
      >
        <span class="retry-step-idx">${escapeHtml(stepLabel)}</span>
        <span class="retry-step-channel" title="${escapeHtml(channelLabel)}">${escapeHtml(channelLabel)}</span>
        <span class="retry-step-status ${statusTone}">${escapeHtml(statusText)}</span>
        <span class="retry-step-duration">${escapeHtml(dur)}</span>
        ${stageBadge}
      </button>
    `;
  }).join("");

  container.innerHTML = `
    <div class="retry-chain-header">
      <span class="retry-chain-title">请求重试链路</span>
      <span class="retry-chain-meta">共 ${attempts.length} 次尝试 · UID: ${uid}</span>
    </div>
    <div class="retry-chain-items">
      ${stepsHtml}
    </div>
  `;

  const buttons = container.querySelectorAll("button[data-retry-log-id]");
  buttons.forEach((btn) => {
    btn.addEventListener("click", () => {
      const targetId = Number(btn.dataset.retryLogId);
      if (targetId && targetId !== Number(detail.id)) {
        showLogDetail(targetId);
      }
    });
  });
}

async function showLogDetail(logId) {
  currentLogDetail = null;
  logDetailTitle.textContent = "请求详情";
  logDetailSummary.textContent = "正在加载...";
  if (logDetailRetryChain) {
    logDetailRetryChain.hidden = true;
    logDetailRetryChain.innerHTML = "";
  }
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
      renderLogDetailMeta(detail);
    }
    renderLogRetryChain(detail);
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
    if (logDetailRetryChain) {
      logDetailRetryChain.hidden = true;
      logDetailRetryChain.innerHTML = "";
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
    const upstreamId = typeof logUpstreamFilter !== "undefined" && logUpstreamFilter ? logUpstreamFilter.value : "";
    const search = typeof logSearchInput !== "undefined" && logSearchInput ? (logSearchInput.value || "").trim() : "";
    const status = typeof logStatusFilter !== "undefined" && logStatusFilter ? logStatusFilter.value : "";
    const clientType = typeof logClientFilter !== "undefined" && logClientFilter ? logClientFilter.value : "";
    const streamVal = typeof logStreamFilter !== "undefined" && logStreamFilter ? logStreamFilter.value : "";
    const minDurationVal = typeof logMinDurationInput !== "undefined" && logMinDurationInput ? logMinDurationInput.value.trim() : "";
    const currentTokenId = typeof getLogDownstreamTokenId === "function"
      ? getLogDownstreamTokenId()
      : (typeof logDownstreamTokenId !== "undefined" ? logDownstreamTokenId : null);
    const { start, end } = typeof getLogTimeRange === "function" ? getLogTimeRange() : { start: "", end: "" };

    const filtersActive = Boolean(
      upstreamId ||
      search ||
      status ||
      clientType ||
      (currentTokenId !== null && currentTokenId !== undefined) ||
      (start && end) ||
      (streamVal === "true" || streamVal === "false") ||
      (minDurationVal !== "" && /^\d+$/.test(minDurationVal))
    );
    const params = new URLSearchParams({
      limit: String(logPageSize),
    });
    appendLogPaginationParams(params);
    if (upstreamId) params.set("upstream_id", upstreamId);
    if (currentTokenId !== null && currentTokenId !== undefined) params.set("downstream_token_id", String(currentTokenId));
    if (search) params.set("search", search);
    if (status) params.set("status", status);
    if (clientType) params.set("client_type", clientType);
    if (streamVal === "true" || streamVal === "false") params.set("stream", streamVal);
    if (minDurationVal !== "" && /^\d+$/.test(minDurationVal)) params.set("min_duration_ms", minDurationVal);
    if (start && end) {
      params.set("start", start);
      params.set("end", end);
    }

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
