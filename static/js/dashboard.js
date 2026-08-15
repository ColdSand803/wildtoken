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

function tokenUsageCard(label, usage, scopeLabel) {
  const totalTokens = Number(usage?.total_tokens);
  const requestCount = Number(usage?.request_count);
  const safeTotal = Number.isFinite(totalTokens) && totalTokens > 0 ? totalTokens : 0;
  const safeCount = Number.isFinite(requestCount) && requestCount > 0 ? requestCount : 0;
  return {
    value: formatCompactNumber(safeTotal),
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

function formatDashboardCacheHitRate(cacheHitTokens, inputTokens) {
  if (
    !Number.isFinite(cacheHitTokens)
    || !Number.isFinite(inputTokens)
    || inputTokens <= 0
  ) {
    return "—";
  }
  const percent = (cacheHitTokens / inputTokens) * 100;
  if (percent === 0) {
    return "0%";
  }
  if (percent < 10) {
    return `${percent.toFixed(1)}%`;
  }
  return `${Math.round(percent)}%`;
}

function cacheHitRateCard(label, usage, scopeLabel) {
  const cacheHitTokens = Number(usage?.prompt_cached_tokens);
  const inputTokens = Number(usage?.prompt_tokens);
  const hasInput = Number.isFinite(inputTokens) && inputTokens > 0;
  const safeCacheHit = Number.isFinite(cacheHitTokens) && cacheHitTokens > 0 ? cacheHitTokens : 0;
  return {
    value: formatDashboardCacheHitRate(cacheHitTokens, inputTokens),
    label,
    hint: hasInput
      ? `${scopeLabel} · 命中 ${formatCompactNumber(safeCacheHit)} / 输入 ${formatCompactNumber(inputTokens)}`
      : `${scopeLabel} · 暂无输入 token`,
    tone: "",
  };
}

function requestCountCard(label, usage, scopeLabel) {
  const requestCount = Number(usage?.all_request_count);
  const safeCount = Number.isFinite(requestCount) && requestCount > 0 ? requestCount : 0;
  return {
    value: formatCompactNumber(safeCount),
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
       说明文字挪进 title，鼠标滑过才显示，卡面留给数字。 */
    const valueHtml = card.valueHtml ?? escapeHtml(card.value);
    const labelHtml = card.labelHtml ?? escapeHtml(card.label);
    const hintTitle = card.hoverHint && card.hint ? ` title="${escapeHtml(card.hint)}"` : "";
    const hintBlock = card.hoverHint
      ? ""
      : `<div class="dashboard-kpi-hint">${escapeHtml(card.hint)}</div>`;
    return `
    <div class="dashboard-kpi ${tone}${entering ? " is-entering" : ""}"${escalated ? ' data-tone-escalated="true"' : ""}${entering ? ` style="--kpi-i:${index}"` : ""}${hintTitle}>
      <div class="dashboard-kpi-value">${valueHtml}</div>
      <div class="dashboard-kpi-label">${labelHtml}</div>
      ${hintBlock}
    </div>
  `;
  }).join("");
  kpiToneMemory.set(container, next);
  container.innerHTML = html;
}

let dashboardSparkGradientSeq = 0;

function buildSparklineSvg(values, { width = 240, height = 44 } = {}) {
  if (!values.length) {
    return '<div class="dashboard-chart-empty">暂无耗时数据</div>';
  }
  const max = Math.max(...values, 1);
  const min = Math.min(...values, 0);
  const span = Math.max(max - min, 1);
  const pad = 2;
  const coords = values.map((value, index) => ({
    x: pad + (index / Math.max(values.length - 1, 1)) * (width - pad * 2),
    y: height - pad - ((value - min) / span) * (height - pad * 2),
  }));
  /* 跟渠道卡片同一个平滑生成器和渐变画法，两处图表手感一致。曲线本身的
     数据带上下各留 pad 防描边被视口裁掉，但面积一直填到 viewBox 最底边——
     图表下方紧贴延迟摘要的分隔线，中间不能露出一条底色缝。 */
  const { line, area } = buildSmoothSparkPaths(coords, {
    baselineY: height,
    minY: pad,
    maxY: height - pad,
  });
  const gradientId = `dashboard-spark-gradient-${++dashboardSparkGradientSeq}`;
  return `
    <svg class="ops-chart-svg dashboard-spark" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none" aria-hidden="true">
      <defs>
        <linearGradient id="${gradientId}" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stop-color="currentColor" stop-opacity="0.25" />
          <stop offset="100%" stop-color="currentColor" stop-opacity="0.04" />
        </linearGradient>
      </defs>
      <path d="${area}" fill="url(#${gradientId})" />
      <path d="${line}" fill="none" stroke="currentColor" stroke-width="1.8" vector-effect="non-scaling-stroke" />
    </svg>
  `;
}

function countStatusBuckets(items) {
  let c2 = 0;
  let c4 = 0;
  let c5 = 0;
  let cOther = 0;
  for (const item of items) {
    const code = item.status_code;
    if (code === null || code === undefined) {
      cOther += 1;
      continue;
    }
    const value = Number(code);
    if (value >= 200 && value < 300) c2 += 1;
    else if (value >= 400 && value < 500) c4 += 1;
    else if (value >= 500) c5 += 1;
    else cOther += 1;
  }
  return { c2, c4, c5, cOther };
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
    hideNames: dashboardChannelNameHidden,
  });
  renderDashboardRankList(dashboardTopChannelTokens, topChannelTokens, "暂无渠道 token 数据", {
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
  const hideNames = Boolean(options.hideNames);
  const max = Math.max(...rows.map((row) => Number(row.count) || 0), 1);
  container.innerHTML = rows.map((row) => {
    const count = Number(row.count) || 0;
    const displayCount = formatValue(count);
    const width = Math.max(4, (count / max) * 100);
    const channelId = (() => {
      if (row.id == null || row.id === "") return null;
      const n = Number(row.id);
      return Number.isFinite(n) ? n : null;
    })();
    const idLabel = channelId == null ? "" : `#${channelId}`;
    const displayName = hideNames ? "******" : String(row.name || "");
    const titleParts = [
      idLabel || null,
      hideNames ? null : (row.name || null),
      displayCount,
    ].filter(Boolean);
    const idHtml = channelId == null
      ? ""
      : `<span class="dashboard-rank-index" title="渠道 #${channelId}">${escapeHtml(idLabel)}</span>`;
    return `
      <div class="dashboard-rank-row" title="${escapeHtml(titleParts.join(" · "))}">
        <div class="dashboard-rank-head">
          ${idHtml}
          <span class="dashboard-rank-name${hideNames ? " is-masked" : ""}">${escapeHtml(displayName)}</span>
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
  const n = items.length;
  const totalChannels = upstreams.length;
  const enabledCount = upstreams.filter((item) => item.enabled).length;
  const disabledCount = totalChannels - enabledCount;

  let errorCount = 0;
  let durationSum = 0;
  let durationCount = 0;
  const durations = [];
  for (const item of items) {
    const statusCode = item.status_code;
    if (statusCode === null || statusCode === undefined) {
      errorCount += 1;
    } else {
      const code = Number(statusCode);
      if (!Number.isFinite(code) || code < 200 || code >= 300) {
        errorCount += 1;
      }
    }
    const durationMs = Number(item.duration_ms);
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      durationSum += durationMs;
      durationCount += 1;
      durations.push(durationMs);
    }
  }

  const errorRateLabel = n > 0
    ? `${((errorCount / n) * 100).toFixed(1).replace(/\.0$/, "")}%`
    : "—";
  const avgDurationLabel = durationCount > 0
    ? `${(durationSum / durationCount / 1000).toFixed(1)}s`
    : "—";

  if (dashboardScope) {
    dashboardScope.textContent = n > 0
      ? `近窗图表基于已加载的近 ${n} 条日志与 ${totalChannels} 个渠道状态；Top 排行按所选周期查询日志库`
      : "近窗图表基于已加载日志；Top 排行按所选周期查询日志库";
  }

  const errorTone = n === 0
    ? ""
    : errorCount / n >= 0.2
      ? "tone-danger"
      : errorCount / n >= 0.05
        ? "tone-warn"
        : "tone-ok";

  // 错误率的环比变化（百分点）。0.05pp 以下当作噪声，不算一次变化。
  const errorRatePct = n > 0 ? (errorCount / n) * 100 : null;
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
    errorDeltaHtml = `<span class="kpi-delta ${up ? "kpi-delta--up" : "kpi-delta--down"}" title="较最近一次变化前">${up ? "↑" : "↓"}${Math.abs(lastErrorRateDelta).toFixed(1)}%</span>`;
  }

  renderDashboardKpiCards(dashboardKpis, [
    {
      value: String(n),
      label: "近窗请求",
      hint: n ? "已加载日志条数" : "暂无近窗数据",
      hoverHint: true,
      tone: "",
    },
    {
      value: errorRateLabel,
      valueHtml: `${escapeHtml(errorRateLabel)}${errorDeltaHtml}`,
      label: "错误率",
      labelHtml: '<span class="kpi-pulse-dot" aria-hidden="true"></span>错误率',
      hint: n ? `${errorCount} / ${n} 条失败` : "暂无日志",
      hoverHint: true,
      tone: errorTone,
    },
    {
      value: avgDurationLabel,
      label: "平均耗时",
      hint: durationCount ? `有效 ${durationCount} 条` : "暂无耗时",
      hoverHint: true,
      tone: "",
    },
    {
      value: `${enabledCount}/${totalChannels}`,
      valueHtml: `${enabledCount}<span class="kpi-denominator">/${totalChannels}</span>`,
      label: "启用渠道",
      hint: totalChannels ? `停用 ${disabledCount}` : "暂无渠道",
      hoverHint: true,
      tone: "",
    },
  ]);

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
      label: "活跃流",
      hint: "当前 SSE 连接",
      tone: activeSse > 0 ? "tone-ok" : "",
    },
    {
      value: formatCompactNumber(recentDisconnects),
      label: "10m 断连",
      hint: `累计 ${formatCompactNumber(Number(metrics.sse_client_disconnects_total || 0))}`,
      tone: recentDisconnects > 0 ? "tone-warn" : "",
    },
    {
      value: formatCompactNumber(logQueueDepth),
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

  const { c2, c4, c5, cOther } = countStatusBuckets(items);
  if (dashboardStatusMeta) {
    dashboardStatusMeta.textContent = `近 ${n} 条`;
  }
  if (dashboardStatusChart) {
    if (n === 0) {
      dashboardStatusChart.innerHTML = '<div class="dashboard-chart-empty">暂无近窗日志</div>';
    } else {
      const pct = (count) => (count / n) * 100;
      const barSeg = (cls, count) => {
        const width = pct(count);
        if (width <= 0) return "";
        return `<span class="ops-bar-seg ${cls}" style="width:${width.toFixed(2)}%" title="${count}"></span>`;
      };
      dashboardStatusChart.innerHTML = `
        <div class="ops-bar-track" role="img" aria-label="2xx ${c2} · 4xx ${c4} · 5xx ${c5} · 其他 ${cOther}">
          ${barSeg("ok", c2)}${barSeg("warn", c4)}${barSeg("danger", c5)}${barSeg("muted", cOther)}
        </div>
        <div class="ops-chart-legend">
          <span>2xx ${c2}</span>
          <span>4xx ${c4}</span>
          <span>5xx ${c5}</span>
          <span>其他 ${cOther}</span>
        </div>
      `;
    }
  }

  // sparkline: reverse so oldest is left
  const spark = durations.slice(0, 40).reverse();
  if (dashboardLatencyMeta) {
    dashboardLatencyMeta.textContent = durationCount ? `近窗有效 ${durationCount} 条` : "暂无数据";
  }
  if (dashboardLatencyChart) {
    if (!durationCount) {
      dashboardLatencyChart.innerHTML = '<div class="dashboard-chart-empty">暂无近窗有效耗时</div>';
    } else {
      const latestDuration = durations[0];
      const minDuration = Math.min(...durations);
      const maxDuration = Math.max(...durations);
      const averageDuration = durationSum / durationCount;
      dashboardLatencyChart.innerHTML = `
        ${buildSparklineSvg(spark, { width: 320, height: 100 })}
        <dl class="dashboard-latency-summary" aria-label="已加载近窗 ${durationCount} 条有效耗时的延迟摘要">
          <div><dt>最近</dt><dd>${escapeHtml(formatSeconds(latestDuration))}</dd></div>
          <div><dt>平均</dt><dd>${escapeHtml(formatSeconds(averageDuration))}</dd></div>
          <div><dt>范围</dt><dd>${escapeHtml(formatSeconds(minDuration))}–${escapeHtml(formatSeconds(maxDuration))}</dd></div>
        </dl>
      `;
    }
  }

  const topModelRequests = Array.isArray(dashboardTopStats?.models) ? dashboardTopStats.models : [];
  const topChannelRequests = Array.isArray(dashboardTopStats?.channels) ? dashboardTopStats.channels : [];
  const topModelTokens = Array.isArray(dashboardTopStats?.model_tokens) ? dashboardTopStats.model_tokens : [];
  const topChannelTokens = Array.isArray(dashboardTopStats?.channel_tokens) ? dashboardTopStats.channel_tokens : [];
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
  renderDashboardRankList(dashboardTopChannels, topChannelRequests, "暂无渠道请求数据", {
    hideNames: dashboardChannelNameHidden,
  });
  renderDashboardRankList(dashboardTopChannelTokens, topChannelTokens, "暂无渠道 token 数据", {
    formatValue: formatCompactNumber,
    hideNames: dashboardChannelNameHidden,
  });
  renderDashboardRankList(dashboardTopModels, topModelRequests, "暂无模型请求数据");
  renderDashboardRankList(dashboardTopModelTokens, topModelTokens, "暂无模型 token 数据", {
    formatValue: formatCompactNumber,
  });

  if (dashboardErrorRows) {
    const errors = items
      .filter((item) => {
        const code = item.status_code;
        return code === null || code === undefined || Number(code) >= 400;
      })
      .slice(0, 8);
    if (errors.length === 0) {
      dashboardErrorRows.innerHTML = `
        <tr>
          <td colspan="5" class="empty">
            <span class="muted">${n ? "近窗内暂无 4xx/5xx/无响应记录" : "暂无近窗日志"}</span>
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
        return `
          <tr class="log-row dashboard-error-row" data-log-id="${log.id}" tabindex="0" title="点击查看请求详情">
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

async function loadDashboardData() {
  if (dashboardLoading) return;
  dashboardLoading = true;
  try {
    if (!upstreamsLoadedOnce) {
      await loadUpstreams();
    } else {
      // Refresh the upstream snapshot for enabled and effective-weight counts.
      try {
        const list = await api("/api/admin/upstreams");
        upstreams = list;
        for (const upstream of upstreams) {
          upstream.effectiveRecoveryAtMs = upstream.health_recovery_remaining_seconds
            ? Date.now() + upstream.health_recovery_remaining_seconds * 1000
            : null;
        }
        upstreamsLoadedOnce = true;
      } catch {
        // Keep previous upstreams cache if refresh fails.
      }
    }

    const params = new URLSearchParams({
      limit: String(DASHBOARD_LOG_LIMIT),
      offset: "0",
    });

    // One range, two endpoints: token cards and rankings stay in agreement.
    const tokenUsageParams = dashboardRangeParams();
    const topParams = dashboardRangeParams();
    // /logs/top names the parameter `window` and has no multi-window mode.
    topParams.set("window", topParams.get("range"));
    topParams.delete("range");
    topParams.set("limit", String(DASHBOARD_TOP_LIMIT));

    const [page, tokenUsage, runtimeMetrics, topStats] = await Promise.all([
      api(`/api/admin/logs?${params}`),
      api(`/api/admin/logs/token-usage?${tokenUsageParams}`),
      api("/api/admin/system/metrics"),
      api(`/api/admin/logs/top?${topParams}`),
    ]);
    dashboardLogItems = page.items || [];
    dashboardTokenUsage = tokenUsage;
    dashboardRuntimeMetrics = runtimeMetrics || null;
    dashboardTopStats = topStats || null;
    lastDashboardLoadError = "";
    renderDashboard();
  } catch (error) {
    const message = `看板加载失败：${error.message}`;
    if (message !== lastDashboardLoadError) {
      setStatus(message, "error");
      lastDashboardLoadError = message;
    }
    if (dashboardScope) {
      dashboardScope.textContent = message;
    }
  } finally {
    dashboardLoading = false;
  }
}

const scheduleRenderUpstreamSummary = debounce(() => {
  renderUpstreamSummaryCore();
}, 120);

let dashboardCustomRangeHideTimer = 0;
const DASHBOARD_CUSTOM_RANGE_MOTION_MS = 260;

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
  const chips = document.querySelector("#dashboard-time-chips");
  window.clearTimeout(dashboardCustomRangeHideTimer);
  chips?.classList.toggle("is-custom", open);

  const finishHide = () => {
    if (el.classList.contains("is-open")) return;
    el.hidden = true;
    window.requestAnimationFrame(syncDashboardRangeThumb);
  };

  if (open) {
    const alreadyOpen = el.classList.contains("is-open") && !el.hidden;
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    syncDashboardDateMirrors();
    if (alreadyOpen) {
      window.requestAnimationFrame(syncDashboardRangeThumb);
      return;
    }
    const reveal = () => {
      el.classList.add("is-open");
      window.requestAnimationFrame(() => {
        syncDashboardRangeThumb();
        el.scrollIntoView({ inline: "end", block: "nearest", behavior: "smooth" });
      });
    };
    if (prefersReducedDashboardMotion()) {
      reveal();
      return;
    }
    window.requestAnimationFrame(reveal);
    return;
  }

  if (el.hidden && !el.classList.contains("is-open")) {
    window.requestAnimationFrame(syncDashboardRangeThumb);
    return;
  }
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
  const customOpen = chips?.classList.contains("is-custom");
  const active = customOpen
    ? chips.querySelector(".dashboard-custom-range")
    : chips?.querySelector("[data-dashboard-range].is-active");
  if (!chips || !thumb || !active || (customOpen && active.hidden)) {
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
window.addEventListener("resize", () => {
  window.requestAnimationFrame(syncDashboardRangeThumb);
});
