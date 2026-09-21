import { useCallback, useEffect, useId, useState } from "react";

import { UnauthorizedError, fetchDashboard, getSystemInfo, listUpstreams } from "../api";
import type { LogOverview, RequestLog, SystemInfo, TokenUsage, TopStats } from "../types";

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
  { key: "all", label: "全部" },
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

function isDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function readCustomRange(): { start: string; end: string } {
  const saved = readStored(CUSTOM_RANGE_KEY) ?? "";
  const [start, end] = saved.split("~");
  if (isDate(start) && isDate(end) && start <= end) return { start, end };
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

/** 渠道名遮罩，和日志页同一套规则。 */
function mask(value: string): string {
  if (value.length <= 5) return "•".repeat(Math.max(3, value.length));
  return `${value.slice(0, 2)}${"•".repeat(4)}${value.slice(-2)}`;
}

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
}: {
  label: string;
  value: string;
  hint: string;
  tone?: string;
  denominator?: string;
}) {
  return (
    <div className={tone ? `dashboard-kpi ${tone}` : "dashboard-kpi"} title={hint}>
      <div className="dashboard-kpi-value">
        <span className="kpi-number">{value}</span>
        {denominator ? <span className="kpi-denominator">{denominator}</span> : null}
      </div>
      <div className="dashboard-kpi-label">{label}</div>
    </div>
  );
}

function MetricSection({
  className,
  title,
  sub,
  meta,
  children,
}: {
  className: string;
  title: string;
  sub: string;
  meta?: string;
  children: React.ReactNode;
}) {
  return (
    <section className={`dashboard-metric-section wt-section ${className}`}>
      <div className="dashboard-metric-head wt-section-head">
        <div className="wt-section-copy">
          <h3>{title}</h3>
          <p className="dashboard-card-sub wt-sub">{sub}</p>
        </div>
        {meta ? <span className="dashboard-card-meta wt-meta">{meta}</span> : null}
      </div>
      {children}
    </section>
  );
}

/** 延迟趋势。JSX 的 <svg> 走 createElementNS，属性齐全且真的会渲染。 */
function Sparkline({ values }: { values: number[] }) {
  const gradientId = useId();
  if (values.length < 2) return <div className="dashboard-chart-empty">所选范围内暂无请求</div>;

  const width = 320;
  const height = 100;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const line = values
    .map((value, index) => {
      const x = index * step;
      const y = height - (value / max) * height;
      return `${index === 0 ? "M" : "L"}${x.toFixed(1)} ${y.toFixed(1)}`;
    })
    .join(" ");

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
        d={`${line} L${width} ${height} L0 ${height} Z`}
        fill={`url(#${gradientId})`}
      />
      <path className="spark-morph-line" d={line} fill="none" stroke="currentColor" />
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
  ];

  return (
    <>
      <div className="ops-bar-track" role="img" aria-label="状态码分布">
        {segments.map((segment) =>
          segment.count > 0 ? (
            <span
              key={segment.label}
              className={`ops-bar-seg ${segment.tone}`}
              style={{ width: `${((segment.count / total) * 100).toFixed(2)}%` }}
              title={`${segment.label} ${segment.count}`}
            />
          ) : null,
        )}
      </div>
      <div className="status-legend">
        {segments.map((segment) => (
          <span key={segment.label} className="status-legend-item">
            <span className={`status-legend-dot ops-bar-seg ${segment.tone}`} aria-hidden="true" />
            <span className="status-legend-label">{segment.label}</span>
            <span className="status-legend-count">{segment.count}</span>
          </span>
        ))}
      </div>
    </>
  );
}

type RankRow = { name: string; request_count: number; total_tokens: number };

/** 排行卡。按哪个字段排由 metric 决定，两种用法共用一张卡。 */
function RankCard({
  title,
  meta,
  rows,
  metric,
  maskNames,
}: {
  title: string;
  meta: string;
  rows: RankRow[];
  metric: "requests" | "tokens";
  maskNames: boolean;
}) {
  const valueOf = (row: RankRow) =>
    metric === "requests" ? row.request_count : row.total_tokens;
  const sorted = [...rows].sort((a, b) => valueOf(b) - valueOf(a));
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
            const display = maskNames ? mask(row.name) : row.name;
            return (
              <div
                key={row.name}
                className="dashboard-rank-row"
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
      const data = await fetchDashboard(range, custom);
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
    if (!isDate(draft.start) || !isDate(draft.end) || draft.start > draft.end) return;
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

  const rangeLabel = overview?.range_label ?? "";
  const total = overview?.total_requests ?? 0;
  const errorRate =
    overview && total > 0 ? ((overview.error_requests / total) * 100).toFixed(1) : null;
  const errorTone =
    errorRate === null ? "" : Number(errorRate) >= 10 ? "tone-danger" : Number(errorRate) >= 2 ? "tone-warn" : "";
  const metrics = system?.runtime_metrics;
  const cleanup = metrics?.cleanup;
  const cacheRate =
    usage && usage.prompt_tokens > 0
      ? `${((usage.prompt_cached_tokens / usage.prompt_tokens) * 100).toFixed(1)}%`
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
            <div className="wt-seg" role="group" aria-label="看板统计时间范围">
              <span className="wt-seg-thumb" aria-hidden="true" />
              {RANGES.map((item) => (
                <button
                  key={item.key}
                  type="button"
                  className="wt-seg-btn"
                  data-dashboard-range={item.key}
                  aria-pressed={range === item.key}
                  onClick={() => switchRange(item.key)}
                >
                  {item.label}
                </button>
              ))}
              <button
                type="button"
                className="wt-seg-btn dashboard-custom-chip"
                data-dashboard-range="custom"
                aria-pressed={range === "custom"}
                onClick={() => switchRange("custom")}
              >
                自定义
              </button>
            </div>

            <div className="dashboard-custom-range" hidden={range !== "custom"}>
              <div className="dashboard-custom-range-inner">
                <label className="dashboard-date-field">
                  <span className="dashboard-date-text">开始</span>
                  <input
                    type="date"
                    aria-label="开始日期"
                    value={draft.start}
                    onChange={(event) => setDraft({ ...draft, start: event.target.value })}
                  />
                </label>
                <span className="dashboard-date-sep">至</span>
                <label className="dashboard-date-field">
                  <span className="dashboard-date-text">结束</span>
                  <input
                    type="date"
                    aria-label="结束日期"
                    value={draft.end}
                    onChange={(event) => setDraft({ ...draft, end: event.target.value })}
                  />
                </label>
                <button
                  type="button"
                  className="secondary dashboard-apply-custom"
                  disabled={!isDate(draft.start) || !isDate(draft.end) || draft.start > draft.end}
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

        <div className="wt-page-body dashboard-layout">
          <MetricSection
            className="dashboard-hero"
            title="核心指标"
            sub="按所选时间范围统计"
            meta={rangeLabel}
          >
            <div className="dashboard-kpis wt-metric-grid kpi-flip">
              <Kpi
                label="请求数"
                value={compact(total)}
                hint={total ? `${rangeLabel} · 共 ${total} 条` : `${rangeLabel} · 暂无请求`}
              />
              <Kpi
                label="错误率"
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
            </div>
          </MetricSection>

          <div className="dashboard-ops wt-board">
            <MetricSection
              className="dashboard-ops-runtime"
              title="运行态"
              sub="当前流、断连、日志写入与清理状态"
              meta="实时"
            >
              <div className="dashboard-window-kpis wt-metric-grid">
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
            </MetricSection>

            <div className="dashboard-ops-usage">
              <MetricSection
                className="dashboard-ops-tokens"
                title="Tokens 统计"
                sub="按请求日志中的 token 用量汇总"
                meta={rangeLabel}
              >
                <div className="dashboard-window-kpis wt-metric-grid">
                  <Kpi
                    label="Tokens"
                    value={usage ? compact(usage.total_tokens) : "—"}
                    hint={`${rangeLabel} · 输入 ${compact(usage?.prompt_tokens ?? 0)}`}
                  />
                  <Kpi
                    label="缓存率"
                    value={cacheRate}
                    hint={`命中 ${compact(usage?.prompt_cached_tokens ?? 0)} / 输入 ${compact(usage?.prompt_tokens ?? 0)}`}
                  />
                </div>
              </MetricSection>

              <MetricSection
                className="dashboard-ops-requests"
                title="请求统计"
                sub="按全部请求日志条数汇总"
                meta={rangeLabel}
              >
                <div className="dashboard-window-kpis wt-metric-grid">
                  <Kpi
                    label="请求"
                    value={usage ? compact(usage.all_request_count) : "—"}
                    hint={`计入用量 ${compact(usage?.request_count ?? 0)} 条`}
                  />
                </div>
              </MetricSection>
            </div>
          </div>

          <div className="dashboard-grid dashboard-insight">
            <article className="dashboard-card wt-card">
              <div className="dashboard-card-head wt-card-head">
                <h3>状态分布</h3>
                <span className="dashboard-card-meta wt-meta">{rangeLabel}</span>
              </div>
              <div className="dashboard-chart">
                {overview ? <StatusBar overview={overview} /> : null}
              </div>
            </article>

            <article className="dashboard-card wt-card">
              <div className="dashboard-card-head wt-card-head">
                <h3>延迟趋势</h3>
                <span className="dashboard-card-meta wt-meta">
                  {overview ? `P95 ${formatMs(overview.p95_duration_ms)}` : ""}
                </span>
              </div>
              <div className="dashboard-chart">
                <Sparkline values={overview?.request_series.map((bucket) => bucket.count) ?? []} />
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
                  title={maskChannels ? "渠道名已屏蔽" : "点击屏蔽渠道名"}
                  onClick={toggleMask}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path
                      className="log-sensitive-eye"
                      d="M2.5 12s3.4-5.5 9.5-5.5S21.5 12 21.5 12 18.1 17.5 12 17.5 2.5 12 2.5 12Z"
                    />
                    {maskChannels ? <path className="log-sensitive-slash" d="m4 4 16 16" /> : null}
                  </svg>
                  {maskChannels ? "显示渠道名" : "屏蔽渠道名"}
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
                metric="requests"
                maskNames={maskChannels}
              />
              <RankCard
                title="Top 渠道 Tokens"
                meta={rangeLabel}
                rows={top?.channels ?? []}
                metric="tokens"
                maskNames={maskChannels}
              />
              <RankCard
                title="Top 模型请求"
                meta={rangeLabel}
                rows={top?.models ?? []}
                metric="requests"
                maskNames={false}
              />
              <RankCard
                title="Top 模型 Tokens"
                meta={rangeLabel}
                rows={top?.models ?? []}
                metric="tokens"
                maskNames={false}
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
                      <tr key={log.id} className="dashboard-error-row">
                        <td>{log.created_at.slice(11, 19)}</td>
                        <td>
                          {log.upstream_name
                            ? maskChannels
                              ? mask(log.upstream_name)
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
