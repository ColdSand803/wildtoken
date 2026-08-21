function getStatusCodeAttribution(statusCode) {
  if (statusCode === null || statusCode === undefined) {
    return "无响应 · 连接中断或请求未完成";
  }
  const code = Number(statusCode);
  switch (code) {
    case 200:
      return "200 OK · 请求成功";
    case 400:
      return "400 Bad Request · 请求参数错误或上下文超长";
    case 401:
      return "401 Unauthorized · 鉴权失败或 API Key 无效";
    case 403:
      return "403 Forbidden · 权限不足或上游拒绝访问";
    case 404:
      return "404 Not Found · 模型或接口路径不存在";
    case 429:
      return "429 Too Many Requests · 触发限流或配额耗尽";
    case 499:
      return "499 Client Closed · 客户端主动断开连接";
    case 500:
      return "500 Internal Error · 上游服务内部异常";
    case 502:
      return "502 Bad Gateway · 网关错误或上游无响应";
    case 503:
      return "503 Service Unavailable · 服务过载或维护中";
    case 504:
      return "504 Gateway Timeout · 上游响应超时";
    default:
      if (code >= 200 && code < 300) return `${code} · 成功响应`;
      if (code >= 400 && code < 500) return `${code} · 客户端请求错误`;
      if (code >= 500 && code < 600) return `${code} · 服务端/网关错误`;
      return `${code}`;
  }
}

function drillDownToLogs({
  search = "",
  upstreamId = "",
  status = "",
  downstreamTokenId = null,
  downstreamTokenName = "",
  start = "",
  end = "",
  rangeLabel = "",
} = {}) {
  if (typeof setLogDownstreamTokenId === "function") {
    setLogDownstreamTokenId(downstreamTokenId, downstreamTokenName);
  }
  const overview = typeof dashboardOverview !== "undefined" ? dashboardOverview : null;
  if (!start && !end && overview?.resolved_start && overview?.resolved_end) {
    start = overview.resolved_start;
    end = overview.resolved_end;
    if (!rangeLabel && typeof getTimeRangeLabel === "function" && typeof dashboardTimeRange !== "undefined") {
      rangeLabel = getTimeRangeLabel(dashboardTimeRange);
    }
  }
  if (typeof setLogTimeRange === "function") {
    setLogTimeRange(start, end, rangeLabel);
  }
  if (typeof logSearchInput !== "undefined" && logSearchInput) logSearchInput.value = search;
  if (typeof logUpstreamFilter !== "undefined" && logUpstreamFilter) logUpstreamFilter.value = upstreamId;
  if (typeof logStatusFilter !== "undefined" && logStatusFilter) logStatusFilter.value = status;
  if (typeof logClientFilter !== "undefined" && logClientFilter) logClientFilter.value = "";
  if (typeof logStreamFilter !== "undefined" && logStreamFilter) logStreamFilter.value = "";
  if (typeof logMinDurationInput !== "undefined" && logMinDurationInput) logMinDurationInput.value = "";
  if (typeof resetLogPagination === "function") {
    resetLogPagination();
  }
  if (typeof switchView === "function") {
    switchView("logs");
  }
  if (typeof restartLogStream === "function") {
    restartLogStream();
  }
}

// ── Dashboard ────────────────────────────────────────────
// Range state lives in bootstrap.js with the other shared view state.

function formatCompactNumber(value) {
  if (!Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1_000_000) {
    return `${(value / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (Math.abs(value) >= 10_000) {
    return `${(value / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return String(Math.round(value));
}

/* k/M 是按一千进位的，中文习惯按一万进位，两套刻度对不上——"202.2M"要在脑子里
   先还原成 202200000 再切成"2.02亿"才读得出量级，这一步换算就是这张卡要替人做的。

   一万以下不换算：formatCompactNumber 在这一档给的已经是精确整数，再写一遍"≈"
   反而像是另一个数。返回空串表示"这一档不需要"，调用方据此决定还挂不挂那个节点。 */
/* 从小到大排，cap 是这一档能写到的上限：到了就该进上一档，8290万 不写成 0.83亿。 */
const CN_UNITS = [
  { divisor: 10_000, cap: 10_000, suffix: "万" },
  { divisor: 100_000_000, cap: Infinity, suffix: "亿" },
];

/* 小数位数跟着量级走，图的是和主数字相当的有效位数（都是三四位）：固定两位的话
   12.3M 会换出"1234.57万"，六位有效数字摆在一个三位有效数字的主数字旁边，看着像是
   更准，其实只是更长。 */
function cnUnitDecimals(scaled) {
  const abs = Math.abs(scaled);
  if (abs < 10) return 2;
  if (abs < 100) return 1;
  return 0;
}

function formatChineseUnit(value) {
  if (!Number.isFinite(value)) return "";
  const abs = Math.abs(value);
  // 一万以下这一档卡面就是精确整数，不换算。这条是硬门槛，写在挑单位之前。
  if (abs < 10_000) return "";
  for (let i = 0; i < CN_UNITS.length; i += 1) {
    const { divisor, cap, suffix } = CN_UNITS[i];
    const scaled = value / divisor;
    const rounded = Number(scaled.toFixed(cnUnitDecimals(scaled)));
    /* 挑最小的装得下的单位，判据是四舍五入之后的尾数而不是原值：99999999 按原值
       落在"万"档，尾数一 round 就是 10000万——那是个进位没进上去的写法，该读作
       1亿。反过来 82900000 的尾数是 8290，"万"装得下，不该被推去写 0.83亿。 */
    if (Math.abs(rounded) < cap || i === CN_UNITS.length - 1) {
      // 末尾的零去掉（1000.0万 → 1000万）。
      return `${rounded}${suffix}`;
    }
  }
  return "";
}

function tokenUsageCard(label, usage, scopeLabel) {
  const totalTokens = Number(usage?.total_tokens);
  const requestCount = Number(usage?.request_count);
  const safeTotal = Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0;
  const safeCount = Number.isFinite(requestCount) && requestCount > 0 ? requestCount : 0;
  const text = formatCompactNumber(safeTotal);
  /* 换算跟着主数字一起滚，不是渲染时算一次就钉住：主数字滚到一半时如果换算还停在
     上一轮的量级，两个数会有半秒对不上。同一个 target 喂两个节点，滚动同源。 */
  const approxKey = `token-usage-cn:${label}`;
  const approx = formatChineseUnit(safeTotal)
    ? kpiCountHtml(approxKey, safeTotal, "cnunit", "", "kpi-approx")
    : "";
  return {
    value: text,
    // 多窗口模式下五张同类卡同时在场，key 必须带 label 才不互相串号。
    valueHtml: `${kpiCountHtml(`token-usage:${label}`, safeTotal, "compact")}${approx}`,
    label,
    hint: safeCount
      ? `${scopeLabel} · ${formatCompactNumber(safeCount)} 条有 token 记录`
      : `${scopeLabel} · 暂无 token 记录`,
    tone: "",
  };
}

/// Labels mirror DashboardRange::label on the server. The server echoes
/// `range_label` for single windows; this covers the multi-window case and any
/// render that happens before the first response lands.
function getTimeRangeLabel(range) {
  switch (range) {
    case "today":
      return "今天";
    case "1d":
      return "最近 24 小时";
    case "3d":
      return "最近 3 天";
    case "7d":
      return "最近 7 天";
    case "30d":
      return "最近 30 天";
    case "all":
      return "全部时间";
    case "custom":
      if (dashboardCustomStartDate && dashboardCustomEndDate) {
        return `${dashboardCustomStartDate} 至 ${dashboardCustomEndDate}`;
      }
      return "自定义时间";
    default:
      return "所有窗口";
  }
}

/// True when one aggregated window is displayed instead of the preset
/// comparison set. "default" is the only multi-window range.
function dashboardShowsSingleWindow(range = dashboardTimeRange) {
  return range !== "default";
}

/// Query parameters shared by the token-usage and top-ranking requests.
function dashboardRangeParams(range = dashboardTimeRange) {
  const params = new URLSearchParams();
  if (range === "custom") {
    // Sending range=custom without both bounds is a guaranteed 400, so fall
    // back until the user has applied a range.
    if (dashboardCustomStartDate && dashboardCustomEndDate) {
      params.set("range", "custom");
      params.set("start_date", dashboardCustomStartDate);
      params.set("end_date", dashboardCustomEndDate);
    } else {
      params.set("range", DASHBOARD_DEFAULT_RANGE);
    }
    return params;
  }
  params.set("range", DASHBOARD_RANGE_VALUES.has(range) ? range : DASHBOARD_DEFAULT_RANGE);
  return params;
}

/* 命中率的分档写法。滚动动画逐帧套用同一个函数（formatKpiCount 的 cacheRate
   分支），两处必须共用一份实现，否则中间帧会跳出静态文本从不会出现的写法。 */
function formatCacheHitPercent(percent) {
  if (percent === 0) {
    return "0%";
  }
  if (percent < 10) {
    return `${percent.toFixed(1)}%`;
  }
  return `${Math.round(percent)}%`;
}

function formatDashboardCacheHitRate(cacheHitTokens, inputTokens) {
  if (
    !Number.isFinite(cacheHitTokens)
    || !Number.isFinite(inputTokens)
    || inputTokens <= 0
  ) {
    return "—";
  }
  return formatCacheHitPercent((cacheHitTokens / inputTokens) * 100);
}

function cacheHitRateCard(label, usage, scopeLabel) {
  const cacheHitTokens = Number(usage?.prompt_cached_tokens);
  const inputTokens = Number(usage?.prompt_tokens);
  const hasInput = Number.isFinite(inputTokens) && inputTokens > 0;
  const safeCacheHit = Number.isFinite(cacheHitTokens) && cacheHitTokens > 0 ? cacheHitTokens : 0;
  const text = formatDashboardCacheHitRate(cacheHitTokens, inputTokens);
  // 从静态文本反推有没有数值，两者的判空条件就不可能分家。
  const percent = text === "—" ? null : (cacheHitTokens / inputTokens) * 100;
  return {
    value: text,
    valueHtml: kpiCountHtml(`cache-rate:${label}`, percent, "cacheRate"),
    label,
    hint: hasInput
      ? `${scopeLabel} · 命中 ${formatCompactNumber(safeCacheHit)} / 输入 ${formatCompactNumber(inputTokens)}`
      : `${scopeLabel} · 暂无输入 token`,
    tooltip: "Prompt 缓存命中率 = 缓存命中 Token 数 / (缓存命中 Token 数 + 新输入 Token 数)；反映大模型对前缀提示词的复用效率与成本节省",
    tone: "",
  };
}

function requestCountCard(label, usage, scopeLabel) {
  const requestCount = Number(usage?.all_request_count);
  const safeCount = Number.isFinite(requestCount) && requestCount > 0 ? requestCount : 0;
  const text = formatCompactNumber(safeCount);
  return {
    value: text,
    valueHtml: kpiCountHtml(`request-count:${label}`, safeCount, "compact"),
    label,
    hint: `${scopeLabel} · 全部日志`,
    tone: "",
  };
}

function formatRuntimeDuration(ms) {
  const value = Number(ms);
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value < 1000) return `${Math.round(value)}ms`;
  return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`;
}

function cleanupRuntimeHint(cleanup) {
  if (!cleanup) return "等待首次运行";
  if (cleanup.active) {
    return `${formatCompactNumber(Number(cleanup.current_rows_cleared || 0))} 行 · ${formatCompactNumber(Number(cleanup.current_batches || 0))} 批`;
  }
  const duration = cleanup.last_duration_ms == null
    ? "—"
    : formatRuntimeDuration(cleanup.last_duration_ms);
  return `上次 ${duration} · ${formatCompactNumber(Number(cleanup.last_rows_cleared || 0))} 行`;
}

/* Tone of each KPI as it was on the previous render, keyed by container and
   label. The dashboard is rebuilt with `innerHTML =` on a five-second poll, so
   a CSS animation declared on `.tone-danger` would not play when a metric goes
   bad — it would replay every five seconds for as long as it stayed bad, which
   is the failure mode this console has to avoid above all others.

   Recording the previous tone lets the *transition* be marked instead of the
   state: `data-tone-escalated` is set for one render only, on the poll where a
   metric first gets worse than it was. Themes decide whether to draw anything
   for it; nothing here assumes they will. */
const kpiToneMemory = new WeakMap();

const TONE_RANK = { "": 0, "tone-ok": 0, "tone-warn": 1, "tone-danger": 2 };

function renderDashboardKpiCards(container, cards) {
  if (!container) return;
  const entering = container.childElementCount === 0;
  const previous = kpiToneMemory.get(container) || new Map();
  const next = new Map();
  const html = cards.map((card, index) => {
    const tone = card.tone || "";
    next.set(card.label, tone);
    const before = previous.get(card.label);
    // Only on a real worsening, and never on the first render — arriving at a
    // page that is already failing is a state, not an event.
    const escalated = before !== undefined
      && (TONE_RANK[tone] ?? 0) > (TONE_RANK[before] ?? 0);
    /* valueHtml / labelHtml 是调用方已经拼好的安全 HTML（分母缩小、呼吸圆点、
       环比箭头这类富内容）；不传则照旧走转义的纯文本。hoverHint 为 true 时
       说明文字挪进 title，鼠标滑过才显示，卡面留给数字。backgroundHtml 放在
       卡片最底层（低透明度趋势曲线之类）。cardKey 用于识别需要背景曲线过渡的卡。 */
    const valueHtml = card.valueHtml ?? escapeHtml(card.value);
    const labelHtml = card.labelHtml ?? escapeHtml(card.label);
    const finalTitle = card.tooltip || (card.hoverHint && card.hint ? card.hint : "");
    const hintTitle = finalTitle ? ` title="${escapeHtml(finalTitle)}"` : "";
    const hintBlock = card.hoverHint
      ? ""
      : `<div class="dashboard-kpi-hint">${escapeHtml(card.hint)}</div>`;
    const cardKeyAttr = card.cardKey ? ` data-card-key="${escapeHtml(card.cardKey)}"` : "";
    /* 背景曲线（SVG + 它的 hover tooltip）已经自带绝对定位容器，直接摊在
       卡片里：曲线贴卡片下半部，tooltip 作为卡片的直接子节点，才能浮在
       数字文本之上而不被曲线容器的层叠上下文压住。 */
    const backgroundBlock = card.backgroundHtml || "";
    return `
    <div class="dashboard-kpi ${tone}${entering ? " is-entering" : ""}"${escalated ? ' data-tone-escalated="true"' : ""}${entering ? ` style="--kpi-i:${index}"` : ""}${hintTitle}${cardKeyAttr}>
      ${backgroundBlock}
      <div class="dashboard-kpi-value">${valueHtml}</div>
      <div class="dashboard-kpi-label">${labelHtml}</div>
      ${hintBlock}
    </div>
  `;
  }).join("");
  kpiToneMemory.set(container, next);
  container.innerHTML = html;
  animateKpiNumbers(container);
}

/* ── KPI 数字滚动 ─────────────────────────────────────────────
   卡片每次刷新都是整体重建 innerHTML，数字会瞬间跳变。带 data-count-key 的
   节点（主数字、增长率/环比徽标里的百分比）在重建后从上一次的数值缓动滚到
   新值，格式化函数逐帧套用，滚动过程中显示的始终是合法格式（1.2k、6.0%）。
   徽标可能整个消失再出现（噪声下限、小基数保护），所以每个容器记住上一轮
   出现过哪些 key：本轮不在了就清记忆、掐掉在飞的动画帧，重新出现时不会从
   陈旧值滚起。 */
const kpiNumberMemory = new Map();
const kpiNumberFrames = new Map();
const kpiNumberContainerKeys = new Map();
const KPI_COUNT_DURATION_MS = 560;

/* 环比百分比要求的最小基数。低于这个数时百分比会放大成 28900% 这类量级，
   描述的是"上期几乎没流量"而非真实倍数，此时改显绝对增量或干脆不显示。 */
const GROWTH_RATE_MIN_BASE = 20;

function formatKpiCount(value, format) {
  if (format === "percent") {
    return `${value.toFixed(1).replace(/\.0$/, "")}%`;
  }
  if (format === "percent1") {
    return `${value.toFixed(1)}%`;
  }
  if (format === "cacheRate") {
    return formatCacheHitPercent(value);
  }
  if (format === "growth") {
    return Math.abs(value) >= 100
      ? `${Math.round(value)}%`
      : `${value.toFixed(1)}%`;
  }
  if (format === "seconds1") {
    return `${value.toFixed(1)}s`;
  }
  if (format === "compact") {
    return formatCompactNumber(Math.round(value));
  }
  /* k/M 旁边那句中文量级换算。"≈"在这里生成而不是写死在模板里：滚动动画逐帧套用
     这个函数、整节点重写 textContent，约等号若留在模板上第一帧就被抹掉。 */
  if (format === "cnunit") {
    const text = formatChineseUnit(Math.round(value));
    return text ? `≈${text}` : "";
  }
  return String(Math.round(value));
}

/* 把一个数字包成可滚动的 KPI 节点。value 不是有限数（这一轮无数据）时只留 key
   不留 data-count-to，animateKpiNumbers 会据此清掉记忆，下次有数据时不会从陈旧
   值滚起，卡面显示 placeholder。

   卡面文本由取整后的目标值反算，不由调用方传入：滚动的最后一帧写的是
   formatKpiCount(target)，两者同源才不可能差一档——9.9996% 按原值是 10.0%，按
   三位小数取整后的 10 是 10%，滚完就会跳一下。 */
function kpiCountHtml(key, value, format, placeholder = "—", extraClass = "") {
  const keyAttr = ` data-count-key="${escapeHtml(key)}"`;
  // 附属数字（换算之类）要压小降灰，但同样得滚，所以类名可加不可换。
  const cls = `kpi-number${extraClass ? ` ${escapeHtml(extraClass)}` : ""}`;
  if (!Number.isFinite(value)) {
    return `<span class="${cls}"${keyAttr}>${escapeHtml(placeholder)}</span>`;
  }
  // 属性里只留三位小数：高于任何一种格式实际显示的精度，又不至于写出长浮点。
  const target = Number(value.toFixed(3));
  const text = escapeHtml(formatKpiCount(target, format));
  return `<span class="${cls}"${keyAttr} data-count-to="${target}" data-count-format="${format}">${text}</span>`;
}

function dropKpiNumberKey(key) {
  kpiNumberMemory.delete(key);
  const frame = kpiNumberFrames.get(key);
  if (frame) {
    window.cancelAnimationFrame(frame);
    kpiNumberFrames.delete(key);
  }
}

function animateKpiNumbers(container) {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const previousKeys = kpiNumberContainerKeys.get(container) || new Set();
  const seenKeys = new Set();

  for (const node of container.querySelectorAll("[data-count-key]")) {
    const key = node.dataset.countKey;
    seenKeys.add(key);
    const target = Number(node.dataset.countTo);
    if (!Number.isFinite(target)) {
      // 本轮没有数值（显示 —），清掉记忆，下次有数据时不要从陈旧值滚起。
      dropKpiNumberKey(key);
      continue;
    }
    const from = kpiNumberMemory.get(key);
    kpiNumberMemory.set(key, target);
    if (reduceMotion || from === undefined || from === target) {
      continue; // 文本里已经是最终值
    }

    const format = node.dataset.countFormat || "plain";
    const startedAt = performance.now();
    const previousFrame = kpiNumberFrames.get(key);
    if (previousFrame) window.cancelAnimationFrame(previousFrame);

    const step = (now) => {
      // 节点可能已被下一轮重建换掉，别再往游离节点上写。
      if (!node.isConnected) {
        kpiNumberFrames.delete(key);
        return;
      }
      const progress = Math.min((now - startedAt) / KPI_COUNT_DURATION_MS, 1);
      const eased = 1 - (1 - progress) ** 3;
      node.textContent = formatKpiCount(from + (target - from) * eased, format);
      if (progress < 1) {
        kpiNumberFrames.set(key, window.requestAnimationFrame(step));
      } else {
        kpiNumberFrames.delete(key);
      }
    };
    kpiNumberFrames.set(key, window.requestAnimationFrame(step));
  }

  for (const key of previousKeys) {
    if (!seenKeys.has(key)) {
      dropKpiNumberKey(key);
    }
  }
  kpiNumberContainerKeys.set(container, seenKeys);
}

/* ── 图表时间范围过渡 ─────────────────────────────────────────
   时间范围切换时曲线的起伏逐帧插值：把旧/新序列都重采样到固定点数，
   插值出中间序列并重算平滑路径，曲线连续变形而不是整图淡入淡出。
   对任意桶数的数据都适用（今天 48 桶、30 天可能只有 30 桶）。 */
const SPARK_MORPH_SAMPLES = 72;
const SPARK_MORPH_MS = 420;

function resampleSeries(values, samples) {
  if (!values.length) return new Array(samples).fill(0);
  if (values.length === 1) return new Array(samples).fill(values[0]);
  const out = new Array(samples);
  for (let i = 0; i < samples; i++) {
    const pos = (i / (samples - 1)) * (values.length - 1);
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, values.length - 1);
    out[i] = values[lo] + (values[hi] - values[lo]) * (pos - lo);
  }
  return out;
}

function easeInOutCubic(t) {
  return t < 0.5 ? 4 * t * t * t : 1 - ((-2 * t + 2) ** 3) / 2;
}

/// 记录序列的重采样：对每个数值键独立做线性重采样，键合回记录。
/// 延迟图一次带均值和 P95 两条序列，共享同一套采样点才能同步变形。
function resampleRecords(records, keys, samples) {
  const perKey = new Map(keys.map((key) => [
    key,
    resampleSeries(records.map((record) => Number(record[key]) || 0), samples),
  ]));
  return Array.from({ length: samples }, (_, index) => {
    const record = {};
    for (const key of keys) record[key] = perKey.get(key)[index];
    return record;
  });
}

/// 轻度数值平滑：两遍 [1,2,1]/4 对称移动平均，压制逐桶抖动，让曲线
/// 圆滑但不过度削峰。端点保持原值，边界不被拉平。
function smoothSeries(values, passes = 2) {
  let current = values;
  for (let pass = 0; pass < passes; pass++) {
    const next = current.slice();
    for (let i = 1; i < current.length - 1; i++) {
      next[i] = (current[i - 1] + current[i] * 2 + current[i + 1]) / 4;
    }
    current = next;
  }
  return current;
}

/// svg 内的每条可变形 path 带 spark-morph-<name> 类（area / line / p95），
/// pathsForRecords 把一组记录映射成 { <name>: pathData }。卡片每次刷新都
/// 整体重建 innerHTML，所以上一序列由调用方按图表记在模块级变量里传
/// 进来；数据没变（实时刷新）时插值结果相同，直接落位。
function animateSparkMorph(svg, previousRecords, nextRecords, keys, pathsForRecords) {
  if (!svg) return;
  const paths = {};
  for (const name of ["area", "line", "p95"]) {
    const element = svg.querySelector(`.spark-morph-${name}`);
    if (element) paths[name] = element;
  }
  if (!Object.keys(paths).length) return;
  const from = resampleRecords(
    Array.isArray(previousRecords) && previousRecords.length >= 2 ? previousRecords : nextRecords,
    keys,
    SPARK_MORPH_SAMPLES,
  );
  const to = resampleRecords(nextRecords, keys, SPARK_MORPH_SAMPLES);
  const apply = (t) => {
    const mid = from.map((record, index) => {
      const blended = {};
      for (const key of keys) blended[key] = record[key] + (to[index][key] - record[key]) * t;
      return blended;
    });
    const pathData = pathsForRecords(mid);
    for (const [name, element] of Object.entries(paths)) {
      if (pathData[name] != null) element.setAttribute("d", pathData[name]);
    }
  };
  const unchanged = keys.every((key) => from.every(
    (record, index) => Math.abs(record[key] - to[index][key]) < 1e-9,
  ));
  if (unchanged || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    apply(1);
    return;
  }
  // 同步先摆到旧形态，避免首帧闪现最终曲线。
  apply(0);
  const start = performance.now();
  const tick = (now) => {
    const t = Math.min(1, (now - start) / SPARK_MORPH_MS);
    apply(easeInOutCubic(t));
    if (t < 1) window.requestAnimationFrame(tick);
  };
  window.requestAnimationFrame(tick);
}

let dashboardSparkGradientSeq = 0;
let lastRequestSparkRecords = null;
let lastLatencySparkRecords = null;

const KPI_SPARK_VIEW = { width: 100, height: 32 };

/// 请求数卡背景曲线的记录（{v}）→ 路径映射（viewBox 0 0 100 32）。
/// 渲染和形态插值动画共用，保证动画帧和落位形态完全一致。
function kpiBackgroundSparkPaths(records) {
  const { width, height } = KPI_SPARK_VIEW;
  const values = smoothSeries(records.map((record) => record.v));
  const max = Math.max(...values);
  const min = Math.min(...values);
  const range = max - min || 1;
  const coords = values.map((value, index) => ({
    x: (index / (values.length - 1)) * width,
    y: height - 2 - ((value - min) / range) * (height - 6),
  }));
  return buildSmoothSparkPaths(coords, {
    baselineY: height,
    minY: 2,
    maxY: height - 2,
  });
}

/// 鼠标横向位置（0..1）→ 命中的桶。整点位置直接落在那个桶上，桶之间线性
/// 插值，tooltip 报的数就是曲线在该处的真实高度。纯函数，方便测试。
function kpiSparkPointAtRatio(values, ratio) {
  const clamped = Math.max(0, Math.min(1, ratio));
  const position = clamped * Math.max(values.length - 1, 1);
  const index = Math.min(values.length - 1, Math.floor(position));
  const next = Math.min(values.length - 1, index + 1);
  const progress = next === index ? 0 : position - index;
  return {
    index,
    next,
    progress,
    value: values[index] + (values[next] - values[index]) * progress,
    x: clamped * KPI_SPARK_VIEW.width,
  };
}

/* 请求数卡的曲线 hover。命中区域是整张卡片而不只是曲线所在的下半部：
   曲线是压在卡面上的背景装饰，只有贴着它才出点会让人以为没做交互。纵向
   位置不参与取值，指到哪一列就报那一列——点的 y 直接从已渲染的 path 上取
   （getPointAtLength 二分找 x），所以点永远压在肉眼看到的曲线上，形态过渡
   动画进行到一半时也一样。 */
function bindKpiRequestSparkInteraction(card, values) {
  const svg = card?.querySelector(".kpi-bg-spark-svg");
  const line = svg?.querySelector(".spark-morph-line");
  const guide = svg?.querySelector(".kpi-spark-hover-guide");
  const dot = svg?.querySelector(".kpi-spark-hover-dot");
  const tooltip = card?.querySelector(".kpi-spark-tooltip");
  if (!svg || !line || !guide || !dot || !tooltip || !Array.isArray(values) || values.length < 2) return;
  const { width, height } = KPI_SPARK_VIEW;
  let frameId = null;
  let pendingEvent = null;

  const render = (event) => {
    const bounds = svg.getBoundingClientRect();
    if (!bounds.width || !bounds.height) return;
    const point = kpiSparkPointAtRatio(
      values,
      (event.clientX - bounds.left) / bounds.width,
    );
    // preserveAspectRatio="none" 把圆拉成椭圆，横向反向缩放补回来。
    const dotScaleX = (bounds.height * width) / Math.max(bounds.width * height, 1);
    const onCurve = sparkPathPointAtX(line, point.x);
    guide.setAttribute("x1", point.x);
    guide.setAttribute("x2", point.x);
    dot.setAttribute("transform", `scale(${dotScaleX} 1)`);
    dot.setAttribute("cx", point.x / dotScaleX);
    dot.setAttribute("cy", onCurve.y);

    tooltip.innerHTML = `<strong>请求数</strong><span>${formatCompactNumber(Math.round(point.value))}</span>`;
    tooltip.hidden = false;
    /* 点在 svg 里、tooltip 挂在卡片上，所以这里只做 SVG→卡片的坐标换算；翻边与夹紧
       交给公共的 wtPositionHoverCard（static/js/components.js）。原来这段是那个函数
       的逐行翻版（同样的 0.62 翻边、同样的双向夹紧），改掉一处手感就会和别处分叉。 */
    const cardBounds = card.getBoundingClientRect();
    wtPositionHoverCard(card, tooltip, {
      x: bounds.left - cardBounds.left + (point.x / width) * bounds.width,
      y: bounds.top - cardBounds.top + (onCurve.y / height) * bounds.height,
    });
  };

  const update = (event) => {
    pendingEvent = event;
    if (frameId != null) return;
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      if (pendingEvent) render(pendingEvent);
    });
  };
  const clear = () => {
    pendingEvent = null;
    if (frameId != null) window.cancelAnimationFrame(frameId);
    frameId = null;
    tooltip.hidden = true;
    svg.removeAttribute("data-hovering");
  };
  // 绑在卡片上：pointermove 从数字、标签这些子节点冒泡上来，整卡都能命中。
  card.addEventListener("pointerenter", (event) => {
    svg.dataset.hovering = "true";
    update(event);
  });
  card.addEventListener("pointermove", (event) => {
    svg.dataset.hovering = "true";
    update(event);
  });
  card.addEventListener("pointerleave", clear);
}

/* 请求数卡的背景趋势：压得很淡的平滑曲线，贴卡片底部，不抢数字。
   曲线容器只负责画，pointer-events 全关；hover 命中的是整张卡片（见
   bindKpiRequestSparkInteraction）。tooltip 是卡片的直接子节点，不放进
   曲线容器里——那个容器 z-index 低于文字层，塞进去会被数字压住。 */
function buildKpiBackgroundSpark(values) {
  if (!Array.isArray(values) || values.length < 2) return "";
  const { line, area } = kpiBackgroundSparkPaths(values.map((value) => ({ v: value })));
  const gradientId = `kpi-bg-gradient-${++dashboardSparkGradientSeq}`;
  return `
    <div class="kpi-bg-spark">
      <svg class="kpi-bg-spark-svg" viewBox="0 0 ${KPI_SPARK_VIEW.width} ${KPI_SPARK_VIEW.height}"
           preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stop-color="currentColor" stop-opacity="0.16" />
            <stop offset="100%" stop-color="currentColor" stop-opacity="0.02" />
          </linearGradient>
        </defs>
        <path class="spark-morph-area" d="${area}" fill="url(#${gradientId})" />
        <path class="spark-morph-line" d="${line}" fill="none" stroke="currentColor" stroke-opacity="0.45"
              stroke-width="1.2" vector-effect="non-scaling-stroke" />
        <line class="kpi-spark-hover-guide" x1="0" y1="0" x2="0" y2="${KPI_SPARK_VIEW.height}"
              vector-effect="non-scaling-stroke" />
        <circle class="kpi-spark-hover-dot" r="2.5" cx="0" cy="0" />
      </svg>
    </div>
    <div class="kpi-spark-tooltip" role="status" hidden></div>
  `;
}


/// 延迟趋势曲线的记录（{a: 均值, p: P95}）→ 路径映射。两条序列共享同一
/// 套纵向比例，P95 恒在均值上方。曲线数据带上下各留 pad 防描边被视口
/// 裁掉，但面积一直填到 viewBox 最底边——图表下方紧贴延迟摘要的分隔线，
/// 中间不能露出一条底色缝。
function latencySparkPointSeries(records, width, height) {
  const avg = smoothSeries(records.map((record) => record.a));
  const p95 = smoothSeries(records.map((record) => record.p));
  const max = Math.max(...avg, ...p95, 1);
  const min = Math.min(...avg, ...p95, 0);
  const span = Math.max(max - min, 1);
  const pad = 2;
  const xOf = (index) => pad + (index / Math.max(records.length - 1, 1)) * (width - pad * 2);
  const yOf = (value) => height - pad - ((value - min) / span) * (height - pad * 2);
  return {
    avg: avg.map((value, index) => ({ x: xOf(index), y: yOf(value), value })),
    p95: p95.map((value, index) => ({ x: xOf(index), y: yOf(value), value })),
  };
}

function latencySparkPaths(records, width, height) {
  const points = latencySparkPointSeries(records, width, height);
  /* 跟渠道卡片同一个平滑生成器和渐变画法，两处图表手感一致。 */
  const { line, area } = buildSmoothSparkPaths(points.avg, {
    baselineY: height,
    minY: 2,
    maxY: height - 2,
  });
  const { line: p95Line } = buildSmoothSparkPaths(points.p95, {
    baselineY: height,
    minY: 2,
    maxY: height - 2,
  });
  return { line, area, p95: p95Line };
}

function buildSparklineSvg(records, { width = 240, height = 44 } = {}) {
  if (!records.length) {
    return '<div class="dashboard-chart-empty">暂无耗时数据</div>';
  }
  const { line, area, p95 } = latencySparkPaths(records, width, height);
  const gradientId = `dashboard-spark-gradient-${++dashboardSparkGradientSeq}`;
  return `
    <svg class="ops-chart-svg dashboard-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="currentColor" stop-opacity="0.25" />
          <stop offset="100%" stop-color="currentColor" stop-opacity="0.04" />
        </linearGradient>
      </defs>
      <path class="spark-morph-area" d="${area}" fill="url(#${gradientId})" />
      <path class="spark-morph-p95" d="${p95}" fill="none" stroke="currentColor" stroke-opacity="0.35"
            stroke-width="1.2" stroke-dasharray="4 3" vector-effect="non-scaling-stroke" />
      <path class="spark-morph-line" d="${line}" fill="none" stroke="currentColor" stroke-width="1.8" vector-effect="non-scaling-stroke" />
      <line class="spark-hover-guide" x1="0" y1="2" x2="0" y2="100" vector-effect="non-scaling-stroke" />
      <circle class="spark-hover-dot spark-hover-dot--avg" r="3" cx="0" cy="0" />
      <circle class="spark-hover-dot spark-hover-dot--p95" r="3" cx="0" cy="0" />
      <rect class="spark-hit-area" x="0" y="0" width="${width}" height="${height}" />
    </svg>
  `;
}

function bindLatencySparkInteractions(container, records) {
  const svg = container?.querySelector(".dashboard-spark");
  const tooltip = container?.querySelector(".dashboard-chart-tooltip");
  if (!svg || !tooltip || !Array.isArray(records) || !records.length) return;
  const width = 320;
  const height = 100;
  const points = latencySparkPointSeries(records, width, height);
  const guide = svg.querySelector(".spark-hover-guide");
  const avgPath = svg.querySelector(".spark-morph-line");
  const p95Path = svg.querySelector(".spark-morph-p95");
  const avgDot = svg.querySelector(".spark-hover-dot--avg");
  const p95Dot = svg.querySelector(".spark-hover-dot--p95");
  const svgBounds = svg.getBoundingClientRect();
  const dotScaleX = (svgBounds.height * width) / Math.max(svgBounds.width * height, 1);
  avgDot.setAttribute("transform", `scale(${dotScaleX} 1)`);
  p95Dot.setAttribute("transform", `scale(${dotScaleX} 1)`);
  let activeSeries = "avg";
  let pendingEvent = null;
  let frameId = null;

  /* 摆放交给公共的 wtPositionHoverCard（static/js/components.js），这里只负责
     把 SVG 视图坐标换算成容器内坐标——翻边与夹紧的手感三处保持一致。 */
  const positionTooltip = (point) => {
    const bounds = container.getBoundingClientRect();
    const svgBounds = svg.getBoundingClientRect();
    wtPositionHoverCard(container, tooltip, {
      x: svgBounds.left - bounds.left + (point.x / width) * svgBounds.width,
      y: svgBounds.top - bounds.top + (point.y / height) * svgBounds.height,
    });
  };
  const formatPointTime = (record) => {
    const epoch = Number(record.bucket_epoch);
    return Number.isFinite(epoch) && epoch > 0
      ? logTimeFormatter.format(new Date(epoch * 1000))
      : "当前时间桶";
  };
  const renderAtPointer = (event) => {
    const bounds = svg.getBoundingClientRect();
    const ratio = Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width));
    const position = ratio * Math.max(records.length - 1, 1);
    const index = Math.min(records.length - 1, Math.floor(position));
    const nextIndex = Math.min(records.length - 1, index + 1);
    const progress = index === nextIndex ? 0 : position - index;
    const x = points.avg[index].x + (points.avg[nextIndex].x - points.avg[index].x) * progress;
    const svgY = Math.max(0, Math.min(height, (event.clientY - bounds.top) / bounds.height * height));
    const avg = sparkPathPointAtX(avgPath, x);
    const p95 = sparkPathPointAtX(p95Path, x);
    activeSeries = Math.abs(svgY - p95.y) < Math.abs(svgY - avg.y) ? "p95" : "avg";
    svg.dataset.activeSeries = activeSeries;
    guide.setAttribute("x1", x);
    guide.setAttribute("x2", x);
    avgDot.setAttribute("cx", avg.x / dotScaleX);
    avgDot.setAttribute("cy", avg.y);
    p95Dot.setAttribute("cx", p95.x / dotScaleX);
    p95Dot.setAttribute("cy", p95.y);

    const leftRecord = records[index];
    const rightRecord = records[nextIndex];
    const avgValue = Number(leftRecord.a) + (Number(rightRecord.a) - Number(leftRecord.a)) * progress;
    const p95Value = Number(leftRecord.p) + (Number(rightRecord.p) - Number(leftRecord.p)) * progress;
    const pointLabel = activeSeries === "p95" ? "P95" : "平均耗时";
    const pointValue = activeSeries === "p95" ? p95Value : avgValue;
    const displayRecord = progress >= 0.5 ? rightRecord : leftRecord;
    tooltip.innerHTML = `<strong>${escapeHtml(formatPointTime(displayRecord))}</strong><span>${pointLabel} ${escapeHtml(formatSeconds(pointValue))}</span>`;
    tooltip.hidden = false;
    positionTooltip(activeSeries === "p95" ? p95 : avg);
  };
  const update = (event) => {
    pendingEvent = event;
    if (frameId != null) return;
    frameId = window.requestAnimationFrame(() => {
      frameId = null;
      if (pendingEvent) renderAtPointer(pendingEvent);
    });
  };
  const clear = () => {
    pendingEvent = null;
    if (frameId != null) {
      window.cancelAnimationFrame(frameId);
      frameId = null;
    }
    delete svg.dataset.activeSeries;
    tooltip.hidden = true;
  };
  const hitArea = svg.querySelector(".spark-hit-area");
  hitArea.addEventListener("pointerenter", update);
  hitArea.addEventListener("pointermove", update);
  hitArea.addEventListener("pointerleave", clear);
}

/* 延迟序列的分桶宽度（秒）转成人话，给图表 meta 用。 */
function formatBucketSpan(seconds) {
  const value = Number(seconds) || 0;
  if (value <= 0) return "—";
  if (value < 3600) return `${Math.round(value / 60)} 分钟`;
  if (value < 86400) return `${Math.round(value / 3600)} 小时`;
  return `${Math.round(value / 86400)} 天`;
}

/* 切换时间范围时清掉错误率环比的基线：不同范围下的错误率没有可比性，
   跨范围的"涨跌"是误导。 */
function resetDashboardErrorRateBaseline() {
  previousErrorRatePct = null;
  lastErrorRateDelta = null;
}

function updateDashboardChannelNameToggle() {
  if (!dashboardChannelNameToggle) return;
  const hidden = dashboardChannelNameHidden;
  const label = hidden
    ? "渠道名已隐藏，点击显示"
    : "渠道名显示中，点击隐藏";
  dashboardChannelNameToggle.setAttribute("aria-pressed", String(hidden));
  dashboardChannelNameToggle.setAttribute("aria-label", label);
  dashboardChannelNameToggle.title = label;
  dashboardChannelNameToggle.classList.toggle("is-active", hidden);
}

function setDashboardChannelNameHidden(hidden) {
  dashboardChannelNameHidden = Boolean(hidden);
  try {
    localStorage.setItem(DASHBOARD_CHANNEL_NAME_HIDDEN_KEY, String(dashboardChannelNameHidden));
  } catch {
    // Preference still applies for the current page when storage is unavailable.
  }
  updateDashboardChannelNameToggle();
  if (!dashboardTopStats) return;
  // Re-render only ranking rows from cached top stats without a full refetch.
  const topChannelRequests = Array.isArray(dashboardTopStats.channels) ? dashboardTopStats.channels : [];
  const topChannelTokens = Array.isArray(dashboardTopStats.channel_tokens) ? dashboardTopStats.channel_tokens : [];
  renderDashboardRankList(dashboardTopChannels, topChannelRequests, "暂无渠道请求数据", {
    rankType: "channel",
    hideNames: dashboardChannelNameHidden,
    metaHtml: (row) => {
      const parts = [];
      if (row.avg_duration_ms != null) parts.push(formatSeconds(Number(row.avg_duration_ms)));
      if (row.error_rate != null) {
        parts.push(`${((Number(row.error_rate) || 0) * 100).toFixed(1)}% 错误`);
      }
      return parts.length
        ? `<span class="dashboard-rank-meta">${escapeHtml(parts.join(" · "))}</span>`
        : "";
    },
  });
  renderDashboardRankList(dashboardTopChannelTokens, topChannelTokens, "暂无渠道 token 数据", {
    rankType: "channel",
    formatValue: formatCompactNumber,
    hideNames: dashboardChannelNameHidden,
  });
}

function renderDashboardRankList(container, rows, emptyText, options = {}) {
  if (!container) return;
  if (!rows.length) {
    container.innerHTML = `<div class="dashboard-chart-empty">${escapeHtml(emptyText)}</div>`;
    return;
  }
  const formatValue = typeof options.formatValue === "function"
    ? options.formatValue
    : (value) => String(Math.round(value));
  const metaHtml = typeof options.metaHtml === "function" ? options.metaHtml : null;
  const hideNames = Boolean(options.hideNames);
  const rankType = options.rankType || "";
  const max = Math.max(...rows.map((row) => Number(row.count) || 0), 1);
  container.innerHTML = rows.map((row) => {
    const count = Number(row.count) || 0;
    const displayCount = formatValue(count);
    const width = Math.max(4, (count / max) * 100);
    const targetId = (() => {
      if (row.id == null || row.id === "") return null;
      const n = Number(row.id);
      return Number.isFinite(n) ? n : null;
    })();
    const idPrefix = rankType === "token" ? "令牌 #" : (rankType === "channel" ? "渠道 #" : "#");
    const idLabel = targetId == null ? "" : `#${targetId}`;
    const rawName = String(row.name || "");
    const displayName = hideNames ? "******" : rawName;
    const titleParts = [
      idLabel || null,
      hideNames ? null : rawName,
      displayCount,
      "点击在日志中查看",
    ].filter(Boolean);
    const idHtml = targetId == null
      ? ""
      : `<span class="dashboard-rank-index" title="${idPrefix}${targetId}">${escapeHtml(idLabel)}</span>`;
    const meta = metaHtml ? (metaHtml(row) || "") : "";
    const idAttr = targetId == null ? "" : ` data-target-id="${targetId}"`;
    const nameAttr = ` data-target-name="${escapeHtml(rawName)}"`;
    const typeAttr = rankType ? ` data-rank-type="${escapeHtml(rankType)}"` : "";
    return `
      <div class="dashboard-rank-row is-clickable" title="${escapeHtml(titleParts.join(" · "))}"${typeAttr}${idAttr}${nameAttr} tabindex="0" role="button">
        <div class="dashboard-rank-head">
          ${idHtml}
          <span class="dashboard-rank-name${hideNames ? " is-masked" : ""}">${escapeHtml(displayName)}</span>
          ${meta}
          <span class="dashboard-rank-count">${escapeHtml(displayCount)}</span>
        </div>
        <div class="dashboard-rank-track" aria-hidden="true">
          <span class="dashboard-rank-fill" style="width:${width.toFixed(1)}%"></span>
        </div>
      </div>
    `;
  }).join("");
}

/// Compact label for the ranking card headers, which have less room than the
/// section metas. Rankings follow the same range as everything else.
function dashboardTopWindowLabel(value) {
  switch (value) {
    case "today":
      return "今日";
    case "1d":
      return "1d";
    case "3d":
      return "3d";
    case "7d":
      return "7d";
    case "30d":
      return "30d";
    case "all":
      return "全部";
    case "custom":
      return dashboardCustomStartDate && dashboardCustomEndDate
        ? `${dashboardCustomStartDate} 至 ${dashboardCustomEndDate}`
        : "自定义";
    default:
      // The multi-window comparison has no single ranking period; rankings then
      // cover 30 days, matching the server's fallback.
      return "30d";
  }
}

/* 上一轮刷新的错误率（百分点），给卡片上的环比箭头当基线。只在拿到有效
   数据时更新：中间夹一轮空窗不该把基线冲掉。 */
let previousErrorRatePct = null;

/* 最近一次真实变化的差值（百分点）。箭头渲染用它而不是逐轮差值：没有新
   请求时逐轮差值是 0，箭头闪一轮就没了——应该一直挂着最近那次变化，直到
   下一次变化把它换掉。 */
let lastErrorRateDelta = null;

function renderDashboard() {
  const items = Array.isArray(dashboardLogItems) ? dashboardLogItems : [];
  const totalChannels = upstreams.length;
  const enabledCount = upstreams.filter((item) => item.enabled).length;
  const disabledCount = totalChannels - enabledCount;

  /* KPI 卡、状态分布、延迟趋势读服务端按范围的聚合。"最近 200 条"是条数
     窗口不是时间窗口——含义随流量漂移；积累/健康类指标统一跟着顶部的时间
     范围选择器走，只有"最近失败"保持近窗列表语义（继续用 items）。 */
  const overview = dashboardOverview;
  const total = Number(overview?.total_requests) || 0;
  const errorTotal = Number(overview?.error_requests) || 0;
  const durationCount = Number(overview?.duration_count) || 0;
  const avgMs = Number(overview?.avg_duration_ms) || 0;
  const overviewRangeLabel = overview?.range_label || getTimeRangeLabel(dashboardTimeRange);

  const errorRateLabel = total > 0
    ? `${((errorTotal / total) * 100).toFixed(1).replace(/\.0$/, "")}%`
    : "—";
  const avgDurationSeconds = durationCount > 0 ? avgMs / 1000 : null;
  const avgDurationLabel = avgDurationSeconds === null
    ? "—"
    : `${avgDurationSeconds.toFixed(1)}s`;

  if (dashboardScope) {
    dashboardScope.textContent = total > 0
      ? `指标与图表按「${overviewRangeLabel}」统计 ${formatCompactNumber(total)} 条请求；最近失败为实时近窗`
      : `「${overviewRangeLabel}」内暂无请求；最近失败为实时近窗`;
  }
  const overviewMeta = document.querySelector("#dashboard-overview-meta");
  if (overviewMeta) {
    overviewMeta.textContent = overviewRangeLabel;
  }

  const errorTone = total === 0
    ? ""
    : errorTotal / total >= 0.2
      ? "tone-danger"
      : errorTotal / total >= 0.05
        ? "tone-warn"
        : "tone-ok";

  // 错误率的环比变化（百分点）。0.05pp 以下当作噪声，不算一次变化。
  const errorRatePct = total > 0 ? (errorTotal / total) * 100 : null;
  if (errorRatePct !== null && previousErrorRatePct !== null) {
    const delta = errorRatePct - previousErrorRatePct;
    if (Math.abs(delta) >= 0.05) {
      lastErrorRateDelta = delta;
    }
  }
  if (errorRatePct !== null) {
    previousErrorRatePct = errorRatePct;
  }
  let errorDeltaHtml = "";
  if (errorRatePct !== null && lastErrorRateDelta !== null) {
    const up = lastErrorRateDelta > 0;
    const magnitude = Math.abs(lastErrorRateDelta);
    errorDeltaHtml = `<span class="kpi-delta ${up ? "kpi-delta--up" : "kpi-delta--down"}" title="较最近一次变化前">${up ? "↑" : "↓"}<span data-count-key="dashboard-error-delta" data-count-to="${magnitude.toFixed(3)}" data-count-format="percent1">${magnitude.toFixed(1)}%</span></span>`;
  }

  /* 请求数的环比增长率：对比上一同长周期（今天 vs 昨天同时段）。基数为 0
     或没有上一周期（"全部"）时不显示——没有可比基数的百分比是误导。
     配色语义与错误率相反：请求涨通常是好事，涨绿跌灰。

     小基数保护：上一周期只有个位数请求时，百分比会飙到 28900% 这种量级，
     它描述的其实是"上期几乎没流量"，不是真的涨了 289 倍。这种情况下改显
     绝对增量（+289 条），信息更诚实。 */
  const previousTotal = overview?.previous_total;
  let requestTrendHtml = "";
  if (total > 0 && typeof previousTotal === "number" && previousTotal > 0) {
    const up = total > previousTotal;
    const toneClass = up ? "kpi-trend--up" : "kpi-trend--down";
    const title = `较上一同长周期（${previousTotal} 条）`;
    if (previousTotal < GROWTH_RATE_MIN_BASE) {
      const diff = Math.abs(total - previousTotal);
      if (diff > 0) {
        requestTrendHtml = `<span class="kpi-trend ${toneClass}" title="${title}">${up ? "↑" : "↓"}<span data-count-key="dashboard-request-growth-abs" data-count-to="${diff}" data-count-format="compact">${escapeHtml(formatCompactNumber(diff))}</span> 条</span>`;
      }
    } else {
      const growth = ((total - previousTotal) / previousTotal) * 100;
      if (Math.abs(growth) >= 0.05) {
        const magnitude = Math.abs(growth);
        requestTrendHtml = `<span class="kpi-trend ${toneClass}" title="${title}">${up ? "↑" : "↓"}<span data-count-key="dashboard-request-growth" data-count-to="${magnitude.toFixed(3)}" data-count-format="growth">${formatKpiCount(magnitude, "growth")}</span></span>`;
      }
    }
  }
  const requestSeries = Array.isArray(overview?.request_series) ? overview.request_series : [];
  const requestSparkValues = requestSeries.map((bucket) => Number(bucket.count) || 0);
  const requestSparkHtml = buildKpiBackgroundSpark(requestSparkValues);

  renderDashboardKpiCards(dashboardKpis, [
    {
      value: formatCompactNumber(total),
      valueHtml: `${kpiCountHtml("dashboard-requests", total, "compact")}${requestTrendHtml}`,
      backgroundHtml: requestSparkHtml,
      label: "请求数",
      hint: total ? `${overviewRangeLabel} · 共 ${total} 条` : `${overviewRangeLabel} · 暂无请求`,
      hoverHint: true,
      tone: "",
      cardKey: "requests",
    },
    {
      value: errorRateLabel,
      valueHtml: errorRatePct === null
        ? kpiCountHtml("dashboard-error-rate", null, "percent")
        : `${kpiCountHtml("dashboard-error-rate", errorRatePct, "percent")}${errorDeltaHtml}`,
      label: "错误率",
      labelHtml: '<span class="kpi-pulse-dot" aria-hidden="true"></span>错误率',
      hint: total ? `${errorTotal} / ${total} 条失败` : "暂无日志",
      hoverHint: true,
      tone: errorTone,
    },
    {
      value: avgDurationLabel,
      valueHtml: kpiCountHtml("dashboard-avg-duration", avgDurationSeconds, "seconds1"),
      label: "平均耗时",
      hint: durationCount ? `有效 ${durationCount} 条` : "暂无耗时",
      hoverHint: true,
      tone: "",
    },
    {
      value: `${enabledCount}/${totalChannels}`,
      /* 只滚分子。分母是渠道总数，只在人为增删渠道时变，跟着滚一遍反而像在
         抖动。 */
      valueHtml: `${kpiCountHtml("dashboard-enabled-channels", enabledCount, "plain")}<span class="kpi-denominator">/${totalChannels}</span>`,
      label: "启用渠道",
      hint: totalChannels ? `停用 ${disabledCount}` : "暂无渠道",
      hoverHint: true,
      tone: "",
    },
  ]);

  // 请求数卡的背景曲线在范围切换时逐帧变形到新形态
  if (dashboardKpis && requestSparkValues.length >= 2) {
    const sparkSvg = dashboardKpis.querySelector('[data-card-key="requests"] .kpi-bg-spark-svg');
    const sparkRecords = requestSparkValues.map((value) => ({ v: value }));
    animateSparkMorph(sparkSvg, lastRequestSparkRecords, sparkRecords, ["v"], kpiBackgroundSparkPaths);
    bindKpiRequestSparkInteraction(
      dashboardKpis.querySelector('[data-card-key="requests"]'),
      requestSparkValues,
    );
    lastRequestSparkRecords = sparkRecords;
  } else {
    lastRequestSparkRecords = null;
  }

  // Prefer the label the server echoed for the range it actually served, so a
  // stale local state cannot mislabel the numbers on screen.
  const rangeLabel = dashboardTokenUsage?.range_label || getTimeRangeLabel(dashboardTimeRange);
  const servedRange = dashboardTokenUsage?.range || dashboardTimeRange;
  if (dashboardPanel) {
    dashboardPanel.dataset.dashboardWindow = dashboardShowsSingleWindow(servedRange) ? "single" : "multi";
  }

  for (const meta of [dashboardTokenRangeMeta, dashboardSelectedRangeMeta]) {
    if (meta) meta.textContent = rangeLabel;
  }

  if (dashboardShowsSingleWindow(servedRange)) {
    // Single window: the server puts the aggregate in `today` regardless of
    // which window was asked for.
    const usage = dashboardTokenUsage?.today;
    renderDashboardKpiCards(dashboardTokenKpis, [
      tokenUsageCard("Tokens", usage, rangeLabel),
      cacheHitRateCard("缓存率", usage, rangeLabel),
    ]);
    renderDashboardKpiCards(dashboardRequestKpis, [
      requestCountCard("请求", usage, rangeLabel),
    ]);
  } else {
    // Default: show all windows
    renderDashboardKpiCards(dashboardTokenKpis, [
      tokenUsageCard("今天 Tokens", dashboardTokenUsage?.today, "本地日累计"),
      tokenUsageCard("1d Tokens", dashboardTokenUsage?.one_day, "最近 24 小时"),
      tokenUsageCard("7d Tokens", dashboardTokenUsage?.seven_days, "最近 7 天"),
      tokenUsageCard("30d Tokens", dashboardTokenUsage?.thirty_days, "最近 30 天"),
      tokenUsageCard("全部 Tokens", dashboardTokenUsage?.all_time, "全部时间统计"),
      cacheHitRateCard("今天缓存率", dashboardTokenUsage?.today, "本地日累计"),
      cacheHitRateCard("1d 缓存率", dashboardTokenUsage?.one_day, "最近 24 小时"),
      cacheHitRateCard("7d 缓存率", dashboardTokenUsage?.seven_days, "最近 7 天"),
      cacheHitRateCard("30d 缓存率", dashboardTokenUsage?.thirty_days, "最近 30 天"),
      cacheHitRateCard("全部缓存率", dashboardTokenUsage?.all_time, "全部时间统计"),
    ]);
    renderDashboardKpiCards(dashboardRequestKpis, [
      requestCountCard("今天请求", dashboardTokenUsage?.today, "本地日累计"),
      requestCountCard("1d 请求", dashboardTokenUsage?.one_day, "最近 24 小时"),
      requestCountCard("7d 请求", dashboardTokenUsage?.seven_days, "最近 7 天"),
      requestCountCard("30d 请求", dashboardTokenUsage?.thirty_days, "最近 30 天"),
      requestCountCard("全部请求", dashboardTokenUsage?.all_time, "全部时间统计"),
    ]);
  }
  const metrics = dashboardRuntimeMetrics || {};
  const cleanup = metrics.cleanup || {};
  const activeSse = Number(metrics.active_sse_streams || 0);
  const recentDisconnects = Number(metrics.sse_recent_disconnects_10m || 0);
  const logQueueDepth = Number(metrics.log_queue_depth || 0);
  const logDropped = Number(metrics.log_dropped_total || 0);
  const logWriteFailures = Number(metrics.log_write_failures_total || 0);
  const slowDbOperations = Number(metrics.slow_db_operations_total || 0);
  renderDashboardKpiCards(dashboardRuntimeKpis, [
    {
      value: formatCompactNumber(activeSse),
      valueHtml: kpiCountHtml("runtime-active-sse", activeSse, "compact"),
      label: "活跃流",
      hint: "当前 SSE 连接",
      tone: activeSse > 0 ? "tone-ok" : "",
    },
    {
      value: formatCompactNumber(recentDisconnects),
      valueHtml: kpiCountHtml("runtime-sse-disconnects", recentDisconnects, "compact"),
      label: "10m 断连",
      hint: `累计 ${formatCompactNumber(Number(metrics.sse_client_disconnects_total || 0))}`,
      tone: recentDisconnects > 0 ? "tone-warn" : "",
    },
    {
      value: formatCompactNumber(logQueueDepth),
      valueHtml: kpiCountHtml("runtime-log-queue", logQueueDepth, "compact"),
      label: "日志队列",
      hint: `失败 ${formatCompactNumber(logWriteFailures)} · 丢弃 ${formatCompactNumber(logDropped)} · 慢 DB ${formatCompactNumber(slowDbOperations)}`,
      tone: logWriteFailures > 0 || logDropped > 0 || slowDbOperations > 0 ? "tone-danger" : "",
    },
    {
      value: cleanup.active ? "运行中" : "空闲",
      label: "清理任务",
      hint: cleanupRuntimeHint(cleanup),
      tone: cleanup.active ? "tone-warn" : "",
    },
  ]);

  const c2 = Number(overview?.status_2xx) || 0;
  const c4 = Number(overview?.status_4xx) || 0;
  const c5 = Number(overview?.status_5xx) || 0;
  const cOther = Number(overview?.status_other) || 0;
  const cNone = Number(overview?.status_none) || 0;
  const requestSeriesForStatus = Array.isArray(overview?.request_series) ? overview.request_series : [];
  if (dashboardStatusMeta) {
    dashboardStatusMeta.textContent = overviewRangeLabel;
  }
  if (dashboardStatusChart) {
    if (total === 0) {
      dashboardStatusChart.innerHTML = '<div class="dashboard-chart-empty">所选范围内暂无请求</div>';
    } else {
      const pct = (count) => (count / total) * 100;
      /* 分段条与下面的错误细带都走公共组件（static/js/components.js），所以这里
         只描述"这一段是什么"，几何、悬浮卡与键盘可达由组件统一负责。 */
      const barSeg = (cls, count, statusVal, label, desc) => {
        const width = pct(count);
        if (width <= 0) return null;
        const share = `${count} 条 · ${width.toFixed(1)}%`;
        return {
          className: `ops-bar-seg ${cls} is-clickable`,
          width: width.toFixed(2),
          interactive: true,
          data: { "drill-status": statusVal },
          tip: { title: label, lines: [share, desc, "点击在日志中查看"] },
          title: `${label} (${share}) · ${desc} · 点击在日志中查看`,
          ariaLabel: `${label} ${share}`,
        };
      };

      /* 图例的环比徽标。小基数保护：上一周期不足 10 条时百分比全是噪声
         （5xx 从 1 涨到 3 会显示 +200%），直接不标。配色语义按类别分：
         2xx 涨绿跌灰（跌通常只是流量降，报警交给错误类），错误类涨红跌绿。 */
      const prevStatus = overview?.previous_status;
      const legendDelta = (key, current, previous, upClass, downClass) => {
        if (typeof previous !== "number" || previous < GROWTH_RATE_MIN_BASE) return "";
        const growth = ((current - previous) / previous) * 100;
        if (Math.abs(growth) < 0.5) return "";
        const up = growth > 0;
        const magnitude = Math.abs(growth);
        /* 基线文案不再挂在这个 span 的 title 上，改由外层图例项的悬浮卡带出去：
           父子各挂一个 title 时，指针移到环比徽标上会先弹图例项的、再弹这个，
           两层叠着出现。返回 baseline 让 legendItem 并进 tip 的 lines。 */
        return {
          html: `<span class="status-delta ${up ? upClass : downClass}">${up ? "↑" : "↓"}<span data-count-key="status-delta-${key}" data-count-to="${magnitude.toFixed(3)}" data-count-format="growth">${formatKpiCount(magnitude, "growth")}</span></span>`,
          baseline: `较上一同长周期（${previous} 条）`,
        };
      };
      /* 图例项和条上的段说的是同一件事，交互契约也一样（role=button + tabindex），
         所以走同一个悬浮卡，而不是留原生 title——同一张图里条上弹自绘卡、紧贴其下的
         图例弹浏览器默认框，是两种观感。绑定处的 target 一并放开到 .status-legend-item。 */
      const legendItem = (seg, label, count, countKey, statusVal, desc, delta) => {
        const tip = wtTipAttribute({
          title: label,
          lines: [`${count} 条`, desc, delta?.baseline, "点击在日志中查看"],
        });
        return `
        <span class="status-legend-item is-clickable" data-drill-status="${statusVal}" ${tip} role="button" tabindex="0" aria-label="${escapeHtml(`${label} ${count} 条`)}">
          <span class="status-legend-dot ops-bar-seg ${seg}" aria-hidden="true"></span>
          <span class="status-legend-label">${label}</span>
          <strong class="status-legend-count" data-count-key="status-count-${countKey}" data-count-to="${count}" data-count-format="compact">${formatCompactNumber(count)}</strong>
          ${delta?.html || ""}
        </span>`;
      };
      const legendHtml = [
        legendItem("ok", "2xx", c2, "2xx", "2xx", "正常成功响应",
          legendDelta("2xx", c2, prevStatus?.status_2xx, "status-delta--good", "status-delta--calm")),
        legendItem("warn", "4xx", c4, "4xx", "4xx", "客户端错误 (含 429 限流/配额、401/403 鉴权、400 格式/超长)",
          legendDelta("4xx", c4, prevStatus?.status_4xx, "status-delta--bad", "status-delta--good")),
        legendItem("danger", "5xx", c5, "5xx", "5xx", "服务端/网关错误 (含 504 超时、502 坏网关、500/503 内部错误)",
          legendDelta("5xx", c5, prevStatus?.status_5xx, "status-delta--bad", "status-delta--good")),
        legendItem("info", "其他", cOther, "other", "other", "1xx / 3xx 重定向及其他 HTTP 状态",
          legendDelta("other", cOther, prevStatus?.status_other, "status-delta--bad", "status-delta--good")),
        legendItem("muted", "无响应", cNone, "none", "none", "无响应 / 连接中断 / 未完成",
          legendDelta("none", cNone, prevStatus?.status_none, "status-delta--bad", "status-delta--good")),
      ].join("");

      /* 错误时间细带：每桶一格，颜色深浅随该桶错误率，回答"错误发生在何时、
         是集中爆发还是均匀散布"——分段条本身没有时间维度。 */
      let stripHtml = "";
      if (requestSeriesForStatus.length >= 2) {
        const cells = requestSeriesForStatus.map((bucket) => {
          const count = Number(bucket.count) || 0;
          const bucketErrors = Number(bucket.errors) || 0;
          const when = logTimeFormatter.format(new Date((Number(bucket.bucket_epoch) || 0) * 1000));
          if (!bucketErrors) {
            return {
              className: "status-error-cell is-clean",
              tip: { title: when, lines: [`${count} 条 · 无错误`] },
              title: `${when} · ${count} 条 · 无错误`,
            };
          }
          const rate = count > 0 ? bucketErrors / count : 0;
          // 错误率 50% 及以上就到满色；下限 0.25 保证个位数错误也看得见。
          const opacity = (0.25 + 0.75 * Math.min(1, rate / 0.5)).toFixed(2);
          const startEpoch = Number(bucket.bucket_epoch) || 0;
          const bucketSec = Number(bucket.bucket_seconds) || 0;
          const data = { "drill-status": "error" };
          if (startEpoch > 0 && bucketSec > 0) {
            data.start = new Date(startEpoch * 1000).toISOString();
            data.end = new Date((startEpoch + bucketSec) * 1000).toISOString();
            data["range-label"] = when;
          }
          const share = `错误 ${bucketErrors}/${count} (${(rate * 100).toFixed(1)}%)`;
          return {
            className: "status-error-cell is-clickable",
            opacity,
            interactive: true,
            data,
            tip: { title: when, lines: [share, "点击在日志中查看"] },
            title: `${when} · ${share} · 点击在日志中查看`,
            ariaLabel: `${when} ${share}`,
          };
        });
        stripHtml = `
          <div class="status-error-strip-wrap">
            <span class="status-error-strip-label">错误时间分布</span>
            ${wtSegmentBar({
              trackClass: "status-error-strip",
              ariaLabel: "按时间桶的错误分布",
              segments: cells,
            })}
          </div>`;
      }

      dashboardStatusChart.innerHTML = `
        ${wtSegmentBar({
          trackClass: "ops-bar-track",
          ariaLabel: `2xx ${c2} · 4xx ${c4} · 5xx ${c5} · 其他 ${cOther} · 无响应 ${cNone}`,
          segments: [
            barSeg("ok", c2, "2xx", "2xx 成功", "正常成功响应"),
            barSeg("warn", c4, "4xx", "4xx 客户端错误", "含 429 限流/配额、401/403 鉴权、400 格式/超长"),
            barSeg("danger", c5, "5xx", "5xx 服务端错误", "含 504 超时、502 坏网关、500/503 内部错误"),
            barSeg("info", cOther, "other", "其他 HTTP 状态", "1xx / 3xx 重定向及其他 HTTP 状态"),
            barSeg("muted", cNone, "none", "无响应", "无响应 / 连接中断 / 未完成"),
          ],
        })}
        <div class="status-legend">${legendHtml}</div>
        ${stripHtml}
      `;
      /* innerHTML 整体重刷会连悬浮卡一起冲掉，所以每次渲染后重绑；
         wtBindHoverCard 会先解掉上一次的监听器。
         target 放开到图例项：默认只认 .wt-segbar-seg，图例就只能退回原生 title。 */
      wtBindHoverCard(dashboardStatusChart, {
        target: ".wt-segbar-seg, .status-legend-item",
      });
    }
    // 图例的数量与环比徽标也走数字滚动（这块不经过 KPI 构建器，手动扫一次）。
    animateKpiNumbers(dashboardStatusChart);
  }

  // 延迟趋势：按时间分桶的平均耗时序列，横轴就是真实时间而不是"最近 N 条"。
  // 每桶带均值和 P95，两条序列共享纵向比例同步变形。
  const latencySeries = Array.isArray(overview?.latency_series) ? overview.latency_series : [];
  const sparkRecords = latencySeries.map((bucket) => ({
    a: Number(bucket.avg_ms) || 0,
    p: bucket.p95_ms != null ? Number(bucket.p95_ms) : (Number(bucket.avg_ms) || 0),
  }));
  if (dashboardLatencyMeta) {
    dashboardLatencyMeta.textContent = latencySeries.length
      ? `${overviewRangeLabel} · 每桶 ${formatBucketSpan(overview?.bucket_seconds)}`
      : "暂无数据";
  }
  if (dashboardLatencyChart) {
    if (latencySeries.length === 0) {
      dashboardLatencyChart.innerHTML = '<div class="dashboard-chart-empty">所选范围内暂无有效耗时</div>';
      lastLatencySparkRecords = null;
    } else {
      const latestAvg = Number(latencySeries[latencySeries.length - 1].avg_ms) || 0;
      const minDuration = Number(overview?.min_duration_ms) || 0;
      const maxDuration = Number(overview?.max_duration_ms) || 0;
      /* 摘要里六个数字也走 KPI 滚动。服务端给的是毫秒、卡面显示秒，seconds1
         的输出与 formatSeconds 一致（一位小数 + s）。分位数可能缺，传 null 让
         kpiCountHtml 只留 key 不留目标值，显示 — 并清掉上一轮的记忆。 */
      const latencyNumber = (key, ms) => kpiCountHtml(
        `latency-${key}`,
        ms == null ? null : Number(ms) / 1000,
        "seconds1",
      );
      dashboardLatencyChart.innerHTML = `
        ${buildSparklineSvg(sparkRecords, { width: 320, height: 100 })}
        <div class="dashboard-chart-tooltip" role="status" hidden></div>
        <dl class="dashboard-latency-summary" aria-label="「${overviewRangeLabel}」${durationCount} 条有效耗时的延迟摘要">
          <div><dt>最近</dt><dd>${latencyNumber("latest", latestAvg)}</dd></div>
          <div><dt>平均</dt><dd>${latencyNumber("avg", avgMs)}</dd></div>
          <div><dt>范围</dt><dd>${latencyNumber("min", minDuration)}–${latencyNumber("max", maxDuration)}</dd></div>
          <div><dt title="中位数耗时：50% 的请求快于此时间">P50</dt><dd title="中位数耗时：50% 的请求快于此时间">${latencyNumber("p50", overview?.p50_duration_ms)}</dd></div>
          <div><dt title="95分位耗时：95% 的请求快于此时间，反映绝大多数用户的体验">P95</dt><dd title="95分位耗时：95% 的请求快于此时间，反映绝大多数用户的体验">${latencyNumber("p95", overview?.p95_duration_ms)}</dd></div>
          <div><dt title="99分位耗时：99% 的请求快于此时间，体现极端长尾延迟与服务毛刺">P99</dt><dd title="99分位耗时：99% 的请求快于此时间，体现极端长尾延迟与服务毛刺">${latencyNumber("p99", overview?.p99_duration_ms)}</dd></div>
        </dl>
      `;
      // 曲线起伏从上一形态逐帧变形到新形态，而不是整图跳变
      animateSparkMorph(
        dashboardLatencyChart.querySelector(".ops-chart-svg"),
        lastLatencySparkRecords,
        sparkRecords,
        ["a", "p"],
        (records) => latencySparkPaths(records, 320, 100),
      );
      bindLatencySparkInteractions(dashboardLatencyChart, sparkRecords);
      lastLatencySparkRecords = sparkRecords;
    }
    /* 延迟摘要同样不经过 KPI 构建器，手动扫一次。空数据那条分支也要扫：
       容器里一个 count key 都没有，引擎正好把上一轮的记忆清干净，等数据
       回来时不会从旧值滚起。 */
    animateKpiNumbers(dashboardLatencyChart);
  }

  const topModelRequests = Array.isArray(dashboardTopStats?.models) ? dashboardTopStats.models : [];
  const topChannelRequests = Array.isArray(dashboardTopStats?.channels) ? dashboardTopStats.channels : [];
  const topModelTokens = Array.isArray(dashboardTopStats?.model_tokens) ? dashboardTopStats.model_tokens : [];
  const topChannelTokens = Array.isArray(dashboardTopStats?.channel_tokens) ? dashboardTopStats.channel_tokens : [];
  const topTokenRequests = Array.isArray(dashboardTopStats?.tokens) ? dashboardTopStats.tokens : [];
  const topTokenTokens = Array.isArray(dashboardTopStats?.token_tokens) ? dashboardTopStats.token_tokens : [];

  const topWindowLabel = dashboardTopWindowLabel(dashboardTopStats?.window || dashboardTimeRange);
  if (dashboardModelsMeta) {
    dashboardModelsMeta.textContent = `${topWindowLabel} · 请求 Top ${topModelRequests.length || 0}`;
  }
  if (dashboardChannelsMeta) {
    dashboardChannelsMeta.textContent = `${topWindowLabel} · 请求 Top ${topChannelRequests.length || 0}`;
  }
  if (dashboardModelTokensMeta) {
    dashboardModelTokensMeta.textContent = `${topWindowLabel} · Tokens Top ${topModelTokens.length || 0}`;
  }
  if (dashboardChannelTokensMeta) {
    dashboardChannelTokensMeta.textContent = `${topWindowLabel} · Tokens Top ${topChannelTokens.length || 0}`;
  }
  if (dashboardTokensMeta) {
    dashboardTokensMeta.textContent = `${topWindowLabel} · 请求 Top ${topTokenRequests.length || 0}`;
  }
  if (dashboardTokenTokensMeta) {
    dashboardTokenTokensMeta.textContent = `${topWindowLabel} · Tokens Top ${topTokenTokens.length || 0}`;
  }

  renderDashboardRankList(dashboardTopChannels, topChannelRequests, "暂无渠道请求数据", {
    rankType: "channel",
    hideNames: dashboardChannelNameHidden,
    metaHtml: (row) => {
      const parts = [];
      if (row.avg_duration_ms != null) parts.push(formatSeconds(Number(row.avg_duration_ms)));
      if (row.error_rate != null) {
        parts.push(`${((Number(row.error_rate) || 0) * 100).toFixed(1)}% 错误`);
      }
      return parts.length
        ? `<span class="dashboard-rank-meta">${escapeHtml(parts.join(" · "))}</span>`
        : "";
    },
  });
  renderDashboardRankList(dashboardTopChannelTokens, topChannelTokens, "暂无渠道 token 数据", {
    rankType: "channel",
    formatValue: formatCompactNumber,
    hideNames: dashboardChannelNameHidden,
  });
  renderDashboardRankList(dashboardTopModels, topModelRequests, "暂无模型请求数据", {
    rankType: "model",
    metaHtml: (row) => {
      const parts = [];
      if (row.avg_duration_ms != null) parts.push(formatSeconds(Number(row.avg_duration_ms)));
      if (row.error_rate != null) {
        parts.push(`${((Number(row.error_rate) || 0) * 100).toFixed(1)}% 错误`);
      }
      return parts.length
        ? `<span class="dashboard-rank-meta">${escapeHtml(parts.join(" · "))}</span>`
        : "";
    },
  });
  renderDashboardRankList(dashboardTopModelTokens, topModelTokens, "暂无模型 token 数据", {
    rankType: "model",
    formatValue: formatCompactNumber,
  });
  renderDashboardRankList(dashboardTopTokens, topTokenRequests, "暂无令牌请求数据", {
    rankType: "token",
    metaHtml: (row) => {
      const parts = [];
      if (row.avg_duration_ms != null) parts.push(formatSeconds(Number(row.avg_duration_ms)));
      if (row.error_rate != null) {
        parts.push(`${((Number(row.error_rate) || 0) * 100).toFixed(1)}% 错误`);
      }
      return parts.length
        ? `<span class="dashboard-rank-meta">${escapeHtml(parts.join(" · "))}</span>`
        : "";
    },
  });
  renderDashboardRankList(dashboardTopTokenTokens, topTokenTokens, "暂无令牌 token 数据", {
    rankType: "token",
    formatValue: formatCompactNumber,
  });

  if (dashboardErrorRows) {
    const errors = items
      .filter((item) => {
        const code = item.status_code;
        return code === null || code === undefined || !Number.isFinite(Number(code)) || Number(code) < 200 || Number(code) >= 300;
      })
      .slice(0, 8);
    if (errors.length === 0) {
      dashboardErrorRows.innerHTML = `
        <tr>
          <td colspan="5" class="empty">
            <span class="muted">${items.length ? "近窗内暂无非 2xx/无响应记录" : "暂无近窗日志"}</span>
          </td>
        </tr>
      `;
    } else {
      dashboardErrorRows.innerHTML = errors.map((log) => {
        const time = formatLogTimestamp(log.created_at);
        const channel = log.upstream_name
          ? escapeHtml(log.upstream_name)
          : '<span class="muted">未匹配</span>';
        const model = log.model
          ? `<code title="${escapeHtml(log.model)}">${escapeHtml(log.model)}</code>`
          : '<span class="muted">-</span>';
        const attribution = getStatusCodeAttribution(log.status_code);
        const errorDesc = log.error ? ` · 详情: ${log.error}` : "";
        return `
          <tr class="log-row dashboard-error-row" data-log-id="${log.id}" tabindex="0" title="${escapeHtml(attribution + errorDesc)} · 点击查看请求详情">
            <td class="time-cell"><span>${escapeHtml(time)}</span><span class="muted">#${log.id}</span></td>
            <td class="channel-cell">${channel}</td>
            <td class="model-cell">${model}</td>
            <td>${formatStatusBadge(log.status_code)}</td>
            <td class="duration-cell">${escapeHtml(formatSeconds(log.duration_ms))}</td>
          </tr>
        `;
      }).join("");
    }
  }
}

let dashboardLoadGeneration = 0;
let dashboardAbortController = null;

async function loadDashboardData() {
  if (dashboardAbortController) {
    try {
      dashboardAbortController.abort();
    } catch {
      // ignore
    }
  }
  const controller = typeof AbortController !== "undefined" ? new AbortController() : null;
  dashboardAbortController = controller;
  const currentGen = ++dashboardLoadGeneration;

  dashboardLoading = true;
  try {
    const fetchOptions = controller ? { signal: controller.signal } : {};
    if (!upstreamsLoadedOnce) {
      await loadUpstreams(fetchOptions);
      if (currentGen !== dashboardLoadGeneration) return;
    } else {
      // Refresh the upstream snapshot for enabled and effective-weight counts.
      try {
        const list = await api("/api/admin/upstreams", fetchOptions);
        if (currentGen !== dashboardLoadGeneration) return;
        upstreams = list;
        for (const upstream of upstreams) {
          upstream.effectiveRecoveryAtMs = upstream.health_recovery_remaining_seconds
            ? Date.now() + upstream.health_recovery_remaining_seconds * 1000
            : null;
        }
        upstreamsLoadedOnce = true;
      } catch (err) {
        if (currentGen !== dashboardLoadGeneration || err?.name === "AbortError") return;
        // Keep previous upstreams cache if refresh fails.
      }
    }

    const params = new URLSearchParams({
      limit: String(DASHBOARD_LOG_LIMIT),
      offset: "0",
    });

    // One range, three endpoints: KPI/charts, token cards, and rankings all
    // answer for the same window.
    const tokenUsageParams = dashboardRangeParams();
    const overviewParams = dashboardRangeParams();
    // "default" 是 Token 卡的多窗口对照模式；KPI/图表必须取单一窗口，
    // 落到默认范围并让标签如实显示。
    if (overviewParams.get("range") === "default") {
      overviewParams.set("range", DASHBOARD_DEFAULT_RANGE);
    }
    const topParams = dashboardRangeParams();
    // /logs/top names the parameter `window` and has no multi-window mode.
    topParams.set("window", topParams.get("range"));
    topParams.delete("range");
    topParams.set("limit", String(DASHBOARD_TOP_LIMIT));

    const [page, tokenUsage, runtimeMetrics, topStats, overview] = await Promise.all([
      api(`/api/admin/logs?${params}`, fetchOptions),
      api(`/api/admin/logs/token-usage?${tokenUsageParams}`, fetchOptions),
      api("/api/admin/system/metrics", fetchOptions),
      api(`/api/admin/logs/top?${topParams}`, fetchOptions),
      api(`/api/admin/logs/overview?${overviewParams}`, fetchOptions),
    ]);
    if (currentGen !== dashboardLoadGeneration) return;

    dashboardLogItems = page.items || [];
    dashboardTokenUsage = tokenUsage;
    dashboardRuntimeMetrics = runtimeMetrics || null;
    dashboardTopStats = topStats || null;
    dashboardOverview = overview || null;
    lastDashboardLoadError = "";
    renderDashboard();
  } catch (error) {
    if (currentGen !== dashboardLoadGeneration || error?.name === "AbortError") {
      return;
    }
    const message = `看板加载失败：${error.message}`;
    if (message !== lastDashboardLoadError) {
      setStatus(message, "error");
      lastDashboardLoadError = message;
    }
    if (dashboardScope) {
      dashboardScope.textContent = message;
    }
  } finally {
    if (currentGen === dashboardLoadGeneration) {
      dashboardLoading = false;
    }
  }
}

const scheduleRenderUpstreamSummary = debounce(() => {
  renderUpstreamSummaryCore();
}, 120);

let dashboardCustomRangeHideTimer = 0;
const DASHBOARD_CUSTOM_RANGE_MOTION_MS = 220;

function prefersReducedDashboardMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatDashboardDateLabel(value) {
  if (!value) return "";
  const [year, month, day] = String(value).split("-");
  if (!year || !month || !day) return value;
  return `${year}/${month}/${day}`;
}

function syncDashboardDateMirrors() {
  document.querySelectorAll(".dashboard-date-field").forEach((field) => {
    const input = field.querySelector("input[type='date']");
    const mirror = field.querySelector(".dashboard-date-text");
    if (!input || !mirror) return;
    const label = formatDashboardDateLabel(input.value);
    mirror.textContent = label || field.dataset.placeholder || "";
    field.classList.toggle("is-empty", !label);
  });
}

function setDashboardCustomRangeOpen(open) {
  if (!dashboardCustomRange) return;
  const el = dashboardCustomRange;
  window.clearTimeout(dashboardCustomRangeHideTimer);

  if (open) {
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    el.classList.add("is-open");
    syncDashboardDateMirrors();
    window.requestAnimationFrame(syncDashboardRangeThumb);
    return;
  }

  const finishHide = () => {
    if (el.classList.contains("is-open")) return;
    el.hidden = true;
  };
  if (el.hidden && !el.classList.contains("is-open")) return;
  el.setAttribute("aria-hidden", "true");
  el.classList.remove("is-open");
  window.requestAnimationFrame(syncDashboardRangeThumb);
  if (prefersReducedDashboardMotion()) {
    finishHide();
    return;
  }
  dashboardCustomRangeHideTimer = window.setTimeout(finishHide, DASHBOARD_CUSTOM_RANGE_MOTION_MS);
}

function syncDashboardRangeThumb() {
  const chips = document.querySelector("#dashboard-time-chips");
  const thumb = chips?.querySelector(".wt-seg-thumb");
  const active = chips?.querySelector("[data-dashboard-range].is-active");
  if (!chips || !thumb || !active) {
    if (thumb) thumb.style.opacity = "0";
    return;
  }
  thumb.style.width = `${active.offsetWidth}px`;
  thumb.style.height = `${active.offsetHeight}px`;
  thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
  thumb.style.opacity = "1";
}

function syncDashboardRangeChips() {
  const value = dashboardTimePreset?.value || dashboardTimeRange;
  document.querySelectorAll("[data-dashboard-range]").forEach((button) => {
    const on = button.dataset.dashboardRange === value;
    button.classList.toggle("is-active", on);
    button.setAttribute("aria-pressed", on ? "true" : "false");
  });
  setDashboardCustomRangeOpen(value === "custom");
}

syncDashboardDateMirrors();
syncDashboardRangeChips();
["#dashboard-start-date", "#dashboard-end-date"].forEach((selector) => {
  const input = document.querySelector(selector);
  input?.addEventListener("input", syncDashboardDateMirrors);
  input?.addEventListener("change", syncDashboardDateMirrors);
});
// The native calendar indicator is invisible (opacity 0 overlay), so clicks on
// the field text only focus the input. Show the picker for the whole field.
document.querySelectorAll(".dashboard-date-field").forEach((field) => {
  const input = field.querySelector("input[type='date']");
  if (!input) return;
  field.addEventListener("click", () => {
    input.focus();
    try {
      input.showPicker();
    } catch {
      // Browsers without showPicker fall back to the native indicator click.
    }
  });
});
window.addEventListener("resize", () => {
  window.requestAnimationFrame(syncDashboardRangeThumb);
});
