import { useCallback, useEffect, useId, useState } from "react";

import { UnauthorizedError, fetchDashboard } from "../api";
import type { LogOverview, RequestLog, TokenUsage, TopStats } from "../types";

/* 时间范围档。这些字符串直接进 query，必须是后端 parseDashboardRange 认的
   词——它只收 today/1d/3d/7d/30d/all/default/custom，别的一律 400。

   default（多窗口对比）和 custom（自定义区间）要额外的日期参数，留到看板页
   整体对齐旧版时一起做。 */
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
const DEFAULT_RANGE = "30d";
const MASK_KEY = "wildtoken_dashboard_mask_channels";

function readRange(): string {
  try {
    const raw = localStorage.getItem(RANGE_KEY);
    return RANGES.some((r) => r.key === raw) ? (raw as string) : DEFAULT_RANGE;
  } catch {
    return DEFAULT_RANGE;
  }
}

function readMask(): boolean {
  try {
    return localStorage.getItem(MASK_KEY) === "true";
  } catch {
    return false;
  }
}

/** 渠道名遮罩，和日志页同一套规则。 */
function mask(value: string): string {
  if (value.length <= 5) return "•".repeat(Math.max(3, value.length));
  return `${value.slice(0, 2)}${"•".repeat(4)}${value.slice(-2)}`;
}

function formatMetric(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

function formatMs(value: number | null): string {
  if (value === null) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

/**
 * 请求量迷你图。
 *
 * JSX 的 <svg> 走 createElementNS，不会像 createElement("path") 那样得到
 * 一个属性齐全但不渲染的 HTML 未知元素。
 */
function Sparkline({ values }: { values: number[] }) {
  // 渐变 id 必须每个实例唯一，否则同页多图会引用到同一个 defs。
  const gradientId = useId();
  if (values.length < 2) return <div className="dashboard-chart-empty">所选范围内暂无请求</div>;

  const width = 320;
  const height = 100;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((value, index) => ({
    x: index * step,
    y: height - (value / max) * height,
  }));
  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
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

export function DashboardPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [range, setRange] = useState(readRange);
  const [maskChannels, setMaskChannels] = useState(readMask);
  const [overview, setOverview] = useState<LogOverview | null>(null);
  const [top, setTop] = useState<TopStats | null>(null);
  const [usage, setUsage] = useState<TokenUsage | null>(null);
  const [recent, setRecent] = useState<RequestLog[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    try {
      const data = await fetchDashboard(range);
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
  }, [range, onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load]);

  function switchRange(next: string) {
    setRange(next);
    try {
      localStorage.setItem(RANGE_KEY, next);
    } catch {
      // 存储不可用时当前页面仍然生效。
      return;
    }
  }

  function toggleMask() {
    setMaskChannels((current) => {
      const next = !current;
      try {
        localStorage.setItem(MASK_KEY, String(next));
      } catch {
        return next;
      }
      return next;
    });
  }

  const errorRate =
    overview && overview.total_requests > 0
      ? ((overview.error_requests / overview.total_requests) * 100).toFixed(1)
      : "0.0";

  const requestSeries = overview?.request_series.map((bucket) => bucket.count) ?? [];

  return (
    <section className="view" data-view="dashboard">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">OVERVIEW</span>
            <h2>看板</h2>
            <p>{overview?.range_label ?? "按时间范围汇总请求、延迟与错误。"}</p>
          </div>
        </div>

        <div className="view-toolbar">
          {/* 时间档位用旧版的分段控件类 wt-seg；dashboard-time-chips 是 id 不是 class。 */}
          <div className="wt-seg" role="group" aria-label="看板统计时间范围">
            {RANGES.map((item) => (
              <button
                key={item.key}
                type="button"
                className="wt-seg-btn"
                aria-pressed={range === item.key}
                onClick={() => switchRange(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className="actions toolbar-actions">
            <button
              type="button"
              className={`secondary ghost${maskChannels ? " is-active" : ""}`}
              aria-pressed={maskChannels}
              title={maskChannels ? "渠道名已屏蔽" : "点击屏蔽渠道名"}
              onClick={toggleMask}
            >
              {maskChannels ? "显示渠道名" : "屏蔽渠道名"}
            </button>
            <button type="button" className="secondary" onClick={() => void load()}>
              刷新
            </button>
          </div>
        </div>

        {error ? (
          <p className="field-hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        <div className="dashboard-kpis">
          <Kpi label="总请求" value={overview ? formatMetric(overview.total_requests) : "—"} />
          <Kpi
            label="错误率"
            value={`${errorRate}%`}
            hint={overview ? `${overview.error_requests} 次失败` : undefined}
          />
          <Kpi label="平均耗时" value={overview ? formatMs(overview.avg_duration_ms) : "—"} />
          <Kpi label="P95" value={overview ? formatMs(overview.p95_duration_ms) : "—"} />
          <Kpi label="Tokens" value={usage ? formatMetric(usage.total_tokens) : "—"} />
          <Kpi
            label="缓存命中"
            value={
              usage && usage.prompt_tokens > 0
                ? `${((usage.prompt_cached_tokens / usage.prompt_tokens) * 100).toFixed(1)}%`
                : "—"
            }
          />
        </div>

        <div className="dashboard-card dashboard-card-wide">
          <div className="dashboard-card-head">
            <h3>请求量</h3>
            <span className="dashboard-card-sub">
              {overview ? `每格 ${Math.round(overview.bucket_seconds / 60)} 分钟` : ""}
            </span>
          </div>
          <div className="dashboard-chart">
            <Sparkline values={requestSeries} />
          </div>
        </div>

        <div className="dashboard-grid">
          <RankCard
            title="Top 模型"
            rows={top?.models ?? []}
            maskNames={false}
            loading={loading}
          />
          <RankCard
            title="Top 渠道"
            rows={top?.channels ?? []}
            maskNames={maskChannels}
            loading={loading}
          />
        </div>

        <div className="dashboard-card dashboard-card-wide">
          <div className="dashboard-card-head">
            <h3>最近失败</h3>
            <span className="dashboard-card-sub">近窗内 4xx/5xx/无响应</span>
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
        </div>
      </section>
    </section>
  );
}

function Kpi({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="dashboard-card">
      <span className="dashboard-kpi-label">{label}</span>
      <span className="dashboard-kpi-value">{value}</span>
      {hint ? <span className="dashboard-kpi-hint">{hint}</span> : null}
    </div>
  );
}

function RankCard({
  title,
  rows,
  maskNames,
  loading,
}: {
  title: string;
  rows: Array<{ name: string; request_count: number; total_tokens: number }>;
  maskNames: boolean;
  loading: boolean;
}) {
  const max = Math.max(...rows.map((row) => row.request_count), 1);
  return (
    <div className="dashboard-card">
      <div className="dashboard-card-head">
        <h3>{title}</h3>
        <span className="dashboard-card-sub">按请求数</span>
      </div>
      {loading ? (
        <p className="muted">加载中…</p>
      ) : rows.length === 0 ? (
        <p className="muted">暂无数据</p>
      ) : (
        rows.map((row, index) => (
          <div
            key={row.name}
            className="dashboard-rank-row"
            title={`${row.name} · ${formatMetric(row.request_count)} 次`}
          >
            <div className="dashboard-rank-head">
              <span className="dashboard-rank-index">{index + 1}</span>
              <span className={`dashboard-rank-name${maskNames ? " is-masked" : ""}`}>
                {maskNames ? mask(row.name) : row.name}
              </span>
              <span className="dashboard-rank-count">{formatMetric(row.request_count)}</span>
            </div>
            <div className="dashboard-rank-track" aria-hidden="true">
              <span
                className="dashboard-rank-fill"
                style={{ width: `${((row.request_count / max) * 100).toFixed(1)}%` }}
              />
            </div>
          </div>
        ))
      )}
    </div>
  );
}
