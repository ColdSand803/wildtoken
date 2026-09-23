import { SegmentBar } from "../components/SegmentBar";
import { AnimatedNumber, formatChineseUnit } from "../components/AnimatedNumber";
import { buildSmoothSparkPaths, smoothSeries } from "../sparkline";
import { navigateToLogs } from "../logFilters";
import type { LogFilters } from "../logFilters";
import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";

import { UnauthorizedError, fetchDashboard, getSystemInfo, listUpstreams } from "../api";
import type { LogOverview, RequestLog, SystemInfo, TokenUsage, TopItem, TopStats } from "../types";

/* 时间档。值直接进 query，必须是后端 parseDashboardRange 认的词。

   旧版还有一个「对比」档（default），它让 token-usage 返回一组窗口而不是单个
   汇总，形状完全不同。没实现之前不放这个按钮——标一个点了会显示错数的档位，
   比少一个档位糟得多。 */
const RANGES = [
  { key: "today", label: "今天" },
  { key: "1d", label: "24小时" },
  { key: "3d", label: "3天" },
  { key: "7d", label: "7天" },
  { key: "30d", label: "30天" },
  { label: "全部", key: "all" },
  { key: "default", label: "对比" },
] as const;

/* 和旧控制台同一个键，两版之间切换保持选择；默认值也照抄旧版的 30d。 */
const RANGE_KEY = "wildtoken_dashboard_range";
const CUSTOM_RANGE_KEY = "wildtoken_dashboard_custom_range";
const MASK_KEY = "wildtoken_dashboard_channel_name_hidden";
const DEFAULT_RANGE = "30d";

const VALID_RANGES = new Set([...RANGES.map((item) => item.key), "custom"]);

function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // 存不进去不影响当前页面。
  }
}

/**
 * 接受纯日期和带时刻两种。
 *
 * datetime-local 没填秒时交的是 YYYY-MM-DDTHH:MM，填了秒才带上 :SS；
 * 旧的落盘值又是纯日期。三种都要能认，否则老用户的偏好会被当成非法值丢掉。
 */
function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2})?)?$/.test(value);
}

/* 比大小用字典序：这几种写法都是固定宽度的大端格式，字典序和时间序
   一致。但纯日期和带时刻混着比时要补齐，否则 "2026-08-01" 会排在
   "2026-08-01T09:00" 前面——那正是我们要的语义（当天零点）。 */
function sameOrBefore(start: string, end: string): boolean {
  const pad = (value: string) => (value.includes("T") ? value : `${value}T00:00:00`);
  return pad(start) <= pad(end);
}

function readCustomRange(): { start: string; end: string } {
  const saved = readStored(CUSTOM_RANGE_KEY) ?? "";
  const [start, end] = saved.split("~");
  if (isDate(start) && isDate(end) && sameOrBefore(start, end)) return { start, end };
  return { start: "", end: "" };
}

function readRange(): string {
  const raw = readStored(RANGE_KEY) ?? "";
  if (!VALID_RANGES.has(raw)) return DEFAULT_RANGE;
  // 存着 custom 却没有日期时回落，否则看板一打开就发不出请求。
  if (raw === "custom") {
    const custom = readCustomRange();
    if (!custom.start || !custom.end) return DEFAULT_RANGE;
  }
  return raw;
}

/* 和日志页同一套：固定六个星号。按长度变化的遮罩会把名字长度和首尾字符
   泄露出去，那恰恰是遮罩要藏的东西。 */
const SENSITIVE_MASK = "******";

function compact(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatMs(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

function formatDuration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`;
}

/** KPI 卡。hint 放 title，卡面留给数字——照抄旧版 hoverHint 的做法。 */
function Kpi({
  label,
  value,
  hint,
  tone = "",
  denominator,
  onClick,
  rawValue,
  background,
  trend,
}: {
  label: string;
  value: string;
  hint: string;
  tone?: string;
  denominator?: string;
  onClick?: () => void;
  rawValue?: number;
  background?: number[];
  trend?: number | null;
}) {
  return (
    <div className={tone ? `dashboard-kpi ${tone}` : "dashboard-kpi"} title={hint} role={onClick ? "button" : undefined} tabIndex={onClick ? 0 : undefined} onClick={onClick} onKeyDown={(event) => { if (onClick && (event.key === "Enter" || event.key === " ")) { event.preventDefault(); onClick(); } }}>
      {background && <div className="kpi-bg-spark" aria-hidden="true"><Sparkline values={background} variant="kpi" /></div>}
      <div className="dashboard-kpi-value">
        <AnimatedNumber value={value} />
        {rawValue !== undefined && formatChineseUnit(rawValue) && <small className="kpi-approx">≈{formatChineseUnit(rawValue)}</small>}
        {denominator ? <span className="kpi-denominator">{denominator}</span> : null}
      </div>
      <div className="dashboard-kpi-label">{label}{trend != null && <small className="kpi-trend" title="与上一同长周期比较">{trend >= 0 ? " ↑" : " ↓"}{Math.abs(trend).toFixed(1)}%</small>}</div>
    </div>
  );
}

/** 延迟趋势与背景趋势曲线。JSX 的 <svg> 走 createElementNS，属性齐全且真的会渲染。 */
function Sparkline({
  values,
  variant = "default",
}: {
  values: number[];
  variant?: "default" | "kpi";
}) {
  const gradientId = useId();
  if (values.length < 2) return <div className="dashboard-chart-empty">所选范围内暂无请求</div>;

  const smoothed = smoothSeries(values, 2);

  if (variant === "kpi") {
    // 请求数卡片背景曲线：贴卡片底部，平滑淡雅，动态范围相对自适应
    const width = 100;
    const height = 32;
    const max = Math.max(...smoothed);
    const min = Math.min(...smoothed);
    const range = max - min || 1;
    const coords = smoothed.map((value, index) => ({
      x: (index / Math.max(smoothed.length - 1, 1)) * width,
      y: height - 2 - ((value - min) / range) * (height - 6),
    }));
    const { line, area } = buildSmoothSparkPaths(coords, {
      baselineY: height,
      minY: 2,
      maxY: height - 2,
    });

    return (
      <svg
        className="kpi-bg-spark-svg"
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        aria-hidden="true"
      >
        <defs>
          <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
            <stop offset="0%" stopColor="currentColor" stopOpacity={0.16} />
            <stop offset="100%" stopColor="currentColor" stopOpacity={0.02} />
          </linearGradient>
        </defs>
        <path className="spark-morph-area" d={area} fill={`url(#${gradientId})`} />
        <path
          className="spark-morph-line"
          d={line}
          fill="none"
          stroke="currentColor"
          strokeOpacity={0.45}
          strokeWidth="1.2"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  }

  // 延迟趋势曲线：以 0 为地面，Catmull-Rom 三次贝塞尔平滑，上下留 pad 防裁切
  const width = 320;
  const height = 100;
  const max = Math.max(...smoothed, 1);
  const min = Math.min(...smoothed, 0);
  const span = Math.max(max - min, 1);
  const pad = 2;
  const coords = smoothed.map((value, index) => ({
    x: pad + (index / Math.max(smoothed.length - 1, 1)) * (width - pad * 2),
    y: height - pad - ((value - min) / span) * (height - pad * 2),
  }));
  const { line, area } = buildSmoothSparkPaths(coords, {
    baselineY: height,
    minY: 2,
    maxY: height - 2,
  });

  return (
    <svg
      className="ops-chart-svg dashboard-spark"
      viewBox={`0 0 ${width} ${height}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={gradientId} x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="currentColor" stopOpacity={0.25} />
          <stop offset="100%" stopColor="currentColor" stopOpacity={0.04} />
        </linearGradient>
      </defs>
      <path
        className="spark-morph-area"
        d={area}
        fill={`url(#${gradientId})`}
      />
      <path
        className="spark-morph-line"
        d={line}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.8"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

/** 状态分布：一条按 2xx/4xx/5xx/其他 分段的横条。 */
function StatusBar({ overview }: { overview: LogOverview }) {
  const total = overview.total_requests;
  if (total === 0) return <div className="dashboard-chart-empty">所选范围内暂无请求</div>;

  /* 四档的类名就是 ok/warn/danger/muted，和 .ops-bar-seg 组合出颜色。图例的
     小圆点复用同一组类——几何由 status-legend-dot 压成圆点。 */
  const segments = [
    { tone: "ok", label: "2xx", count: overview.status_2xx },
    { tone: "warn", label: "4xx", count: overview.status_4xx },
    { tone: "danger", label: "5xx", count: overview.status_5xx },
    { tone: "muted", label: "其他", count: overview.status_other },
    { tone: "danger", label: "无响应", count: overview.status_none },
  ];

  return (
    <>
      <SegmentBar className="ops-bar-track" label="状态码分布" segments={segments.map((segment) => ({ label: segment.label, width: segment.count / total * 100, className: `ops-bar-seg ${segment.tone}`, lines: [`${segment.count} 条 · ${(segment.count / total * 100).toFixed(1)}%`], onSelect: () => navigateToLogs({ start: overview.resolved_start ?? undefined, end: overview.resolved_end ?? undefined, status: segment.label === "其他" ? "other" : segment.label === "无响应" ? "none" : segment.label }) }))} />
      <div className="status-legend">
        {segments.map((segment) => (
          <button type="button" key={segment.label} className="secondary ghost status-legend-item" onClick={() => navigateToLogs({ start: overview.resolved_start ?? undefined, end: overview.resolved_end ?? undefined, status: segment.label === "其他" ? "other" : segment.label === "无响应" ? "none" : segment.label })}>
            <span className={`status-legend-dot ops-bar-seg ${segment.tone}`} aria-hidden="true" />
            <span className="status-legend-label">{segment.label}</span>
            <span className="status-legend-count">{segment.count}</span>
          </button>
        ))}
      </div>
    </>
  );
}

/**
 * 排行卡。
 *
 * 数值字段就叫 count——请求榜和 Tokens 榜是接口返回的**两组独立数据**，
 * 不是同一组换个字段排序。按 request_count / total_tokens 取到的是 undefined，
 * 算出来全是 NaN。
 */
function RankCard({
  title,
  meta,
  rows,
  maskNames,
  onSelect,
}: {
  title: string;
  meta: string;
  rows: TopItem[];
  maskNames: boolean;
  onSelect: (row: TopItem) => void;
}) {
  // 后端已经排好序，这里不再排；只防一下非法值。
  const valueOf = (row: TopItem) => (Number.isFinite(row.count) ? row.count : 0);
  const sorted = rows;
  const max = Math.max(...sorted.map(valueOf), 1);

  return (
    <article className="dashboard-card wt-card">
      <div className="dashboard-card-head wt-card-head">
        <h3>{title}</h3>
        <span className="dashboard-card-meta wt-meta">{meta}</span>
      </div>
      <div className="dashboard-list">
        {sorted.length === 0 ? (
          <div className="dashboard-chart-empty">暂无数据</div>
        ) : (
          sorted.map((row) => {
            const display = maskNames ? SENSITIVE_MASK : row.name;
            return (
              <div
                key={row.name}
                className="dashboard-rank-row"
                role="button" tabIndex={0} onClick={() => onSelect(row)} onKeyDown={(event) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); onSelect(row); } }}
                title={`${display} · ${compact(valueOf(row))}`}
              >
                <div className="dashboard-rank-head">
                  <span className={maskNames ? "dashboard-rank-name is-masked" : "dashboard-rank-name"}>
                    {display}
                  </span>
                  <span className="dashboard-rank-count">{compact(valueOf(row))}</span>
                </div>
                <div className="dashboard-rank-track" aria-hidden="true">
                  <span
                    className="dashboard-rank-fill"
                    style={{ width: `${((valueOf(row) / max) * 100).toFixed(1)}%` }}
                  />
                </div>
              </div>
            );
          })
        )}
      </div>
    </article>
  );
}

export function DashboardPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [range, setRange] = useState(readRange);
  const [refreshSeconds, setRefreshSeconds] = useState(() => { const stored = Number(readStored("wildtoken_dashboard_refresh_interval") ?? 15000) / 1000; return [0, 5, 15, 30, 60].includes(stored) ? stored : 15; });
  const loadVersion = useRef(0);
  const [custom, setCustom] = useState(readCustomRange);
  /* 草稿和已生效的区间分开。日期框每改一下就发请求的话，输到一半的月份会
     打出一堆没人要的查询。点「应用」才落到 custom。 */
  const [draft, setDraft] = useState(readCustomRange);
  const [maskChannels, setMaskChannels] = useState(() => readStored(MASK_KEY) === "true");
  const [overview, setOverview] = useState<LogOverview | null>(null);
  const [top, setTop] = useState<TopStats | null>(null);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [system, setSystem] = useState<SystemInfo | null>(null);
  const [channels, setChannels] = useState<{ enabled: number; total: number } | null>(null);
  const [recent, setRecent] = useState<RequestLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  /* 选了自定义但日期还没填齐时不发请求。点一下那个档位就能打出三个
     start_date= 空值的 400，而界面上只会变成一片破折号。 */
  const pending = range === "custom" && !(isDate(custom.start) && isDate(custom.end));

  const load = useCallback(async () => {
    if (pending) {
      setLoading(false);
      return;
    }
    try {
      const version = ++loadVersion.current;
      const data = await fetchDashboard(range, custom);
      if (version !== loadVersion.current) return;
      setOverview(data.overview);
      setTop(data.top);
      setUsage(data.usage);
      // 最近失败只取有错或非 2xx 的行。
      setRecent(
        (data.recent.items ?? []).filter(
          (log) => log.error !== null || log.status_code === null || log.status_code >= 400,
        ),
      );
      setError("");
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [range, custom, pending, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (!refreshSeconds) return;
    const timer = window.setInterval(() => { if (!document.hidden) { void load(); void getSystemInfo().then(setSystem).catch(() => {}); } }, refreshSeconds * 1000);
    return () => window.clearInterval(timer);
  }, [load, refreshSeconds]);

  /* 运行态和渠道计数不随时间范围变，单独拉一次。 */
  useEffect(() => {
    getSystemInfo()
      .then(setSystem)
      .catch(() => setSystem(null));
    listUpstreams()
      .then((list) => {
        const active = list.filter((item) => !item.archived);
        setChannels({ enabled: active.filter((item) => item.enabled).length, total: active.length });
      })
      .catch(() => setChannels(null));
  }, []);

  function switchRange(next: string) {
    setRange(next);
    writeStored(RANGE_KEY, next);
  }

  function applyCustom() {
    if (!isDate(draft.start) || !isDate(draft.end)) return;
    if (!sameOrBefore(draft.start, draft.end) || draft.start === draft.end) return;
    setCustom(draft);
    setRange("custom");
    writeStored(RANGE_KEY, "custom");
    writeStored(CUSTOM_RANGE_KEY, `${draft.start}~${draft.end}`);
  }

  function toggleMask() {
    setMaskChannels((current) => {
      const next = !current;
      writeStored(MASK_KEY, String(next));
      return next;
    });
  }

  function drillDown(filters: LogFilters = {}) {
    navigateToLogs({ start: overview?.resolved_start ?? undefined, end: overview?.resolved_end ?? undefined, ...filters });
  }
  const rangeLabel = overview?.range_label ?? "";
  const total = overview?.total_requests ?? 0;
  const errorRate =
    overview && total > 0 ? ((overview.error_requests / total) * 100).toFixed(1) : null;
  const errorTone =
    errorRate === null ? "" : Number(errorRate) >= 10 ? "tone-danger" : Number(errorRate) >= 2 ? "tone-warn" : "";
  const metrics = system?.runtime_metrics;
  const cleanup = metrics?.cleanup;
  /* 响应总是嵌套的：选了具体时间窗时，服务端把该窗的聚合值塞进 today。
     按扁平结构取字段全是 undefined，卡片渲染成 NaN。 */
  /* 滑块要量选中那个按钮的实际几何。用 layout effect 是为了在浏览器绘制前
     就定位，否则切档时能看见它从旧位置跳过去。 */
  const segRef = useRef<HTMLDivElement>(null);
  const thumbRef = useRef<HTMLSpanElement>(null);

  useLayoutEffect(() => {
    const thumb = thumbRef.current;
    const active = segRef.current?.querySelector<HTMLElement>("[data-dashboard-range].is-active");
    if (!thumb) return;
    if (!active) {
      thumb.style.opacity = "0";
      return;
    }
    thumb.style.width = `${active.offsetWidth}px`;
    thumb.style.height = `${active.offsetHeight}px`;
    thumb.style.transform = `translate(${active.offsetLeft}px, ${active.offsetTop}px)`;
    thumb.style.opacity = "1";
  }, [range]);

  // 不叫 window：会遮蔽全局对象。
  const usageWindow = range === "default" ? usage?.thirty_days : usage?.today;
  const cacheRate =
    usageWindow && usageWindow.prompt_tokens > 0
      ? `${((usageWindow.prompt_cached_tokens / usageWindow.prompt_tokens) * 100).toFixed(1)}%`
      : "—";

  return (
    <section className="view" data-view="dashboard">
      <section className="panel dashboard-panel wt-page" data-dashboard-window="single">
        <div className="panel-head wt-page-head">
          <div className="wt-page-copy">
            <span className="eyebrow">TRAFFIC OVERVIEW</span>
            <h2>数据看板</h2>
            <p>近窗图表基于已加载日志；Top 排行按所选周期查询日志库</p>
          </div>

          <div className="dashboard-time-filter wt-toolbar">
            <div className="wt-seg" role="group" aria-label="看板统计时间范围" ref={segRef}>
              {/* 滑块基线是 opacity 0，尺寸和位置全靠脚本算——只放个空 span 的话
                  它永远不显示。 */}
              <span className="wt-seg-thumb" aria-hidden="true" ref={thumbRef} />
              {RANGES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  /* is-active 是选中态的唯一凭据：CSS 里没有任何规则看 aria-pressed，
                     只设无障碍属性的话屏上看不出选中了哪个档。 */
                  className={range === item.key ? "wt-seg-btn is-active" : "wt-seg-btn"}
                  data-dashboard-range={item.key}
                  aria-pressed={range === item.key}
                  onClick={() => switchRange(item.key)}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                className={
                  range === "custom"
                    ? "wt-seg-btn dashboard-custom-chip is-active"
                    : "wt-seg-btn dashboard-custom-chip"
                }
                data-dashboard-range="custom"
                aria-pressed={range === "custom"}
                onClick={() => switchRange("custom")}
              >
                自定义
              </button>
            </div>

            {/* is-open 是可见性开关，不是装饰：基线规则是 opacity 0，只拿掉 hidden
                面板仍然全透明，点“自定义”像没反应。内部元素还有同样一道门。 */}
            <div
              className={
                range === "custom"
                  ? "dashboard-custom-range is-open"
                  : "dashboard-custom-range"
              }
              hidden={range !== "custom"}
              aria-hidden={range !== "custom"}
            >
              <div className="dashboard-custom-range-inner">
                {/* step=1 才会出秒位；不给的话控件只到分钟。 */}
                <label className="dashboard-date-field">
                  <span className="dashboard-date-text">开始</span>
                  <input
                    type="datetime-local"
                    step="1"
                    aria-label="开始时间"
                    value={draft.start}
                    onChange={(event) => setDraft({ ...draft, start: event.target.value })}
                  />
                </label>
                <span className="dashboard-date-sep">至</span>
                <label className="dashboard-date-field">
                  <span className="dashboard-date-text">结束</span>
                  <input
                    type="datetime-local"
                    step="1"
                    aria-label="结束时间"
                    value={draft.end}
                    onChange={(event) => setDraft({ ...draft, end: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="secondary dashboard-apply-custom"
                  /* 起止相等也不行：空区间选不出任何东西，后端也会 400。 */
                  disabled={
                    !isDate(draft.start) ||
                    !isDate(draft.end) ||
                    !sameOrBefore(draft.start, draft.end) ||
                    draft.start === draft.end
                  }
                  onClick={applyCustom}
                >
                  应用
                </button>
              </div>
            </div>
          </div>
        </div>

        {error ? (
          <p className="settings-inline-status" role="alert">
            {error}
          </p>
        ) : null}

        <label className="dashboard-refresh-choice">自动刷新 <select aria-label="看板自动刷新" value={refreshSeconds} onChange={(event) => { const next = Number(event.target.value); setRefreshSeconds(next); writeStored("wildtoken_dashboard_refresh_interval", String(next * 1000)); }}>{[0, 5, 15, 30, 60].map((seconds) => <option key={seconds} value={seconds}>{seconds ? `${seconds} 秒` : "关闭"}</option>)}</select></label>
        <div className="wt-page-body dashboard-layout">
          {range === "default" && usage && <section className="dashboard-card wt-card"><h3>多窗口用量对比</h3><div className="table-wrap"><table className="admin-table"><thead><tr><th>时间窗</th><th>全部请求</th><th>计入用量</th><th>Tokens</th><th>缓存命中</th></tr></thead><tbody>{([["今天", usage.today], ["24 小时", usage.one_day], ["7 天", usage.seven_days], ["30 天", usage.thirty_days], ["全部", usage.all_time]] as const).map(([label, item]) => <tr key={label}><th>{label}</th><td>{compact(item.all_request_count)}</td><td>{compact(item.request_count)}</td><td title={item.total_tokens.toLocaleString("zh-CN")}>{compact(item.total_tokens)} {formatChineseUnit(item.total_tokens)}</td><td>{item.prompt_tokens > 0 ? `${(item.prompt_cached_tokens / item.prompt_tokens * 100).toFixed(1)}%` : "—"}</td></tr>)}</tbody></table></div></section>}
          {/* 四个度量区打散成一片：去掉标题和外框，卡片直接进同一个网格。
              每张卡自带标签和注解，分组标题只是多一层边框。 */}
          <div className="dashboard-kpis wt-metric-grid kpi-flip dashboard-kpis--flat">
            <Kpi
                label="请求数"
                background={overview?.request_series.map((bucket) => bucket.count)}
                trend={overview?.previous_total ? (total / overview.previous_total - 1) * 100 : null}
                onClick={() => drillDown()}
                value={compact(total)}
                hint={total ? `${rangeLabel} · 共 ${total} 条` : `${rangeLabel} · 暂无请求`}
              />
              <Kpi
                label="错误率"
                onClick={() => drillDown({ status: "error" })}
                value={errorRate === null ? "—" : `${errorRate}%`}
                hint={total ? `${overview?.error_requests ?? 0} / ${total} 条失败` : "暂无日志"}
                tone={errorTone}
              />
              <Kpi
                label="平均耗时"
                value={overview ? formatMs(overview.avg_duration_ms) : "—"}
                hint={overview?.duration_count ? `有效 ${overview.duration_count} 条` : "暂无耗时"}
              />
              {/* 归档渠道不计入分母。算进去的话「2/3」看起来像有一个只是被停用，
                  而它其实已经退出路由了。 */}
            <Kpi
              label="启用渠道"
              value={channels ? String(channels.enabled) : "—"}
              denominator={channels ? `/${channels.total}` : undefined}
              hint={channels ? `停用 ${channels.total - channels.enabled}` : "暂无渠道"}
            />
            <Kpi
              label="Tokens"
              rawValue={usageWindow?.total_tokens}
              value={usageWindow ? compact(usageWindow.total_tokens) : "—"}
              hint={`${rangeLabel} · 输入 ${compact(usageWindow?.prompt_tokens ?? 0)}`}
            />
            <Kpi
              label="缓存率"
              value={cacheRate}
              hint={`命中 ${compact(usageWindow?.prompt_cached_tokens ?? 0)} / 输入 ${compact(usageWindow?.prompt_tokens ?? 0)}`}
            />
            <Kpi
              label="请求（全部）"
              value={usageWindow ? compact(usageWindow.all_request_count) : "—"}
              hint={`计入用量 ${compact(usageWindow?.request_count ?? 0)} 条`}
            />
            <Kpi
                  label="活跃流"
                  value={compact(metrics?.active_sse_streams ?? 0)}
                  hint="当前 SSE 连接"
                  tone={(metrics?.active_sse_streams ?? 0) > 0 ? "tone-ok" : ""}
                />
                <Kpi
                  label="10m 断连"
                  value={compact(metrics?.sse_recent_disconnects_10m ?? 0)}
                  hint={`累计 ${compact(metrics?.sse_client_disconnects_total ?? 0)}`}
                  tone={(metrics?.sse_recent_disconnects_10m ?? 0) > 0 ? "tone-warn" : ""}
                />
                <Kpi
                  label="日志队列"
                  value={compact(metrics?.log_queue_depth ?? 0)}
                  hint={`失败 ${compact(metrics?.log_write_failures_total ?? 0)} · 丢弃 ${compact(metrics?.log_dropped_total ?? 0)} · 慢 DB ${compact(metrics?.slow_db_operations_total ?? 0)}`}
                  tone={
                    (metrics?.log_write_failures_total ?? 0) > 0 ||
                    (metrics?.log_dropped_total ?? 0) > 0 ||
                    (metrics?.slow_db_operations_total ?? 0) > 0
                      ? "tone-danger"
                      : ""
                  }
                />
            <Kpi
              label="清理任务"
              value={cleanup?.active ? "运行中" : "空闲"}
              hint={
                cleanup?.active
                  ? `${compact(cleanup.current_rows_cleared)} 行 / ${compact(cleanup.current_batches)} 批`
                  : `上次 ${compact(cleanup?.last_rows_cleared ?? 0)} 行 · ${formatDuration(cleanup?.last_duration_ms)}`
              }
              tone={cleanup?.active ? "tone-warn" : ""}
            />
          </div>

          <div className="dashboard-grid dashboard-insight">
            <article className="dashboard-card wt-card">
              <div className="dashboard-card-head wt-card-head">
                <h3>状态分布</h3>
                <span className="dashboard-card-meta wt-meta">{rangeLabel}</span>
              </div>
              <div className="dashboard-chart">
                {overview ? <><StatusBar overview={overview} /><p className="field-hint">错误时间分布（选择时间桶下钻）</p><SegmentBar label="错误时间分布" className="ops-error-timeline" segments={overview.request_series.map((bucket) => ({ label: new Date(bucket.bucket_epoch * 1000).toLocaleString("zh-CN"), width: 100 / Math.max(overview.request_series.length, 1), className: `ops-bar-seg ${bucket.errors ? "danger" : "muted"}`, lines: [`请求 ${bucket.count} · 失败 ${bucket.errors ?? 0}`], onSelect: () => drillDown({ status: "error", start: new Date(bucket.bucket_epoch * 1000).toISOString(), end: new Date((bucket.bucket_epoch + overview.bucket_seconds) * 1000).toISOString() }) }))} /></> : null}
              </div>
            </article>

            <article className="dashboard-card wt-card">
              <div className="dashboard-card-head wt-card-head">
                <h3>延迟趋势</h3>
                <span className="dashboard-card-meta wt-meta">
                  {overview ? `P50 ${formatMs(overview.p50_duration_ms)} · P95 ${formatMs(overview.p95_duration_ms)} · P99 ${formatMs(overview.p99_duration_ms)}` : ""}
                </span>
              </div>
              <div className="dashboard-chart">
                <Sparkline values={overview?.latency_series.map((bucket) => bucket.avg_ms) ?? []} />
              </div>
            </article>
          </div>

          <section className="wt-section dashboard-rankings">
            <div className="dashboard-ranking-toolbar wt-section-head">
              <div className="wt-section-copy">
                <h3>Top 排行</h3>
                <p className="dashboard-card-sub wt-sub">
                  渠道请求、渠道 Tokens、模型请求、模型 Tokens 按所选周期统计；模型按实际转发给上游的名称归类
                </p>
              </div>
              <div className="dashboard-ranking-controls">
                <button
                  type="button"
                  className={
                    maskChannels
                      ? "secondary ghost log-sensitive-toggle is-active"
                      : "secondary ghost log-sensitive-toggle"
                  }
                  aria-pressed={maskChannels}
                  /* 只留图标，说明走 title 和 aria-label——和日志页的同类按钮一致。 */
                  aria-label={maskChannels ? "显示渠道名" : "屏蔽渠道名"}
                  title={maskChannels ? "渠道名已屏蔽，点击显示" : "点击屏蔽渠道名"}
                  onClick={toggleMask}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      className="log-sensitive-eye"
                      d="M2.5 12s3.4-5.5 9.5-5.5S21.5 12 21.5 12 18.1 17.5 12 17.5 2.5 12 2.5 12Z"
                    />
                    {maskChannels ? <path className="log-sensitive-slash" d="m4 4 16 16" /> : null}
                  </svg>
                </button>
                <button type="button" className="secondary" onClick={() => void load()}>
                  刷新
                </button>
              </div>
            </div>

            <div className="dashboard-grid dashboard-rank-grid">
              <RankCard
                title="Top 渠道请求"
                meta={rangeLabel}
                rows={top?.channels ?? []}
                maskNames={maskChannels}
                onSelect={(row) => drillDown({ upstreamId: row.id == null ? undefined : String(row.id), search: row.id == null ? row.name : undefined })}
              />
              {/* Tokens 榜走 channel_tokens，不是把请求榜换个字段重排。 */}
              <RankCard
                title="Top 渠道 Tokens"
                meta={rangeLabel}
                rows={top?.channel_tokens ?? []}
                maskNames={maskChannels}
                onSelect={(row) => drillDown({ upstreamId: row.id == null ? undefined : String(row.id), search: row.id == null ? row.name : undefined })}
              />
              <RankCard
                title="Top 模型请求"
                meta={rangeLabel}
                rows={top?.models ?? []}
                maskNames={false}
                onSelect={(row) => drillDown({ search: row.name })}
              />
              <RankCard
                title="Top 模型 Tokens"
                meta={rangeLabel}
                rows={top?.model_tokens ?? []}
                maskNames={false}
                onSelect={(row) => drillDown({ search: row.name })}
              />
            </div>
          </section>

          <article className="dashboard-card dashboard-card-wide wt-card">
            <div className="panel-head dashboard-card-head wt-card-head">
              <div>
                <h3>最近失败</h3>
                <p className="dashboard-card-sub wt-sub">近窗内 4xx/5xx/无响应</p>
              </div>
            </div>
            <div className="table-wrap">
              <table className="admin-table dashboard-error-table">
                <thead>
                  <tr>
                    <th>时间</th>
                    <th>渠道</th>
                    <th>模型</th>
                    <th>状态</th>
                    <th>耗时</th>
                  </tr>
                </thead>
                <tbody>
                  {loading ? (
                    <tr>
                      <td colSpan={5} className="muted">加载中…</td>
                    </tr>
                  ) : recent.length === 0 ? (
                    <tr>
                      <td colSpan={5} className="muted">近窗内没有失败请求</td>
                    </tr>
                  ) : (
                    recent.map((log) => (
                      <tr key={log.id} className="dashboard-error-row" tabIndex={0} onClick={() => drillDown({ search: String(log.id) })} onKeyDown={(event) => { if (event.key === "Enter") drillDown({ search: String(log.id) }); }}>
                        <td>{log.created_at.slice(11, 19)}</td>
                        <td>
                          {log.upstream_name
                            ? maskChannels
                              ? SENSITIVE_MASK
                              : log.upstream_name
                            : "-"}
                        </td>
                        <td>{log.upstream_model ?? log.model ?? "-"}</td>
                        <td>
                          {log.status_code === null ? (
                            <span className="muted">无响应</span>
                          ) : (
                            <span className="badge danger">{log.status_code}</span>
                          )}
                        </td>
                        <td>{log.duration_ms === null ? "-" : formatMs(log.duration_ms)}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </article>
        </div>
      </section>
    </section>
  );
}
