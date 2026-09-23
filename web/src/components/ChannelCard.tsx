import { ActionMenu } from "./ActionMenu";
import type { MenuEntry } from "./ActionMenu";
import type { Upstream, UpstreamHealth, UpstreamStats } from "../types";

/** 大数字缩到能扫的长度。旧版 formatMetric 同款。 */
function formatMetric(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k`;
  return String(Math.round(value));
}

/**
 * 请求量迷你图。
 *
 * JSX 里的 <svg> 走的就是 createElementNS，不会像 createElement("path")
 * 那样得到一个属性齐全但不渲染的 HTML 未知元素。
 */
function Sparkline({ values }: { values: number[] }) {
  if (values.length < 2) return <div className="sparkline-svg" />;

  const width = 100;
  const height = 40;
  const max = Math.max(...values, 1);
  const step = width / (values.length - 1);
  const points = values.map((value, index) => ({
    x: index * step,
    y: height - (value / max) * height,
  }));

  const line = points
    .map((p, i) => `${i === 0 ? "M" : "L"}${p.x.toFixed(1)} ${p.y.toFixed(1)}`)
    .join(" ");
  const area = `${line} L${width} ${height} L0 ${height} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <path className="spark-morph-area" d={area} />
      <path className="spark-morph-line" d={line} />
    </svg>
  );
}

/** 秒与毫秒分界：健康区的均延迟跟旧版用秒。 */
function formatSeconds(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * 24h 逐小时健康条。
 *
 * 每根是一小时，高度按该小时请求量，颜色按错误占比。没有流量的小时不画
 * ——留白比一根零高的柱更诚实。
 */
function HealthBars({ health }: { health: UpstreamHealth | null }) {
  const buckets = health?.buckets ?? [];
  if (buckets.length === 0) return <div className="health-bars-empty">24h 无请求</div>;

  const max = Math.max(...buckets.map((bucket) => bucket.total || 0), 1);
  return (
    <div
      className="health-bars"
      role="img"
      aria-label={`24 小时逐小时健康，共 ${health?.total ?? 0} 请求，失败 ${health?.errors ?? 0}`}
    >
      {buckets.map((bucket, index) => {
        const total = bucket.total || 0;
        const errors = bucket.errors || 0;
        const ratio = total > 0 ? errors / total : 1;
        const tone = ratio === 0 ? "ok" : ratio < 0.5 ? "warn" : "bad";
        const hour = new Date(bucket.bucket_epoch * 1000);
        const label =
          `${String(hour.getHours()).padStart(2, "0")}:00 · ${total} 请求` +
          (errors > 0 ? ` · 失败 ${errors}` : "");
        return (
          <span
            key={index}
            className={`health-bar health-bar--${tone}`}
            style={{ height: `${Math.max(12, Math.round((total / max) * 100))}%` }}
            title={label}
          />
        );
      })}
    </div>
  );
}

function MetricTile({
  label,
  value,
  title,
  wide,
}: {
  label: string;
  value: string;
  title?: string;
  wide?: boolean;
}) {
  return (
    <div className={wide ? "metric-tile metric-tile--wide" : "metric-tile"} title={title}>
      <span className="metric-label">{label}</span>
      <span className="metric-value">{value}</span>
    </div>
  );
}

/**
 * 渠道卡片。
 *
 * 统计还没到时出占位符而不是把卡片藏起来——藏起来的话切到卡片视图
 * 会看见一片空白，像坏了。
 */
export function ChannelCard({
  upstream,
  stats,
  health,
  busy,
  menu,
  onToggle,
  onOpenDetail,
  checked = false,
  onCheck,
  diagnostics,
}: {
  upstream: Upstream;
  stats: UpstreamStats | null;
  health: UpstreamHealth | null;
  busy: boolean;
  menu: MenuEntry[];
  onToggle: () => void;
  onOpenDetail: () => void;
  checked?: boolean;
  onCheck?: (checked: boolean) => void;
  diagnostics?: import("react").ReactNode;
}) {
  const sparkValues = stats?.sparkline.map((point) => point.count) ?? [];
  const sixHourTotal = stats ? formatMetric(sparkValues.reduce((sum, n) => sum + n, 0)) : "—";

  /* 没流量时 success_rate 是 null，不能当 0 用——那会把一个没人用过的渠道
     标成红色的「在线率 0%」。 */
  const rate = health?.success_rate ?? null;
  const successLabel = rate === null ? "—" : `${(rate * 100).toFixed(1)}%`;
  const successTone = rate === null ? "" : rate >= 0.99 ? " is-ok" : rate >= 0.9 ? " is-warn" : " is-bad";
  const latencyLabel = !health || health.total === 0 ? "—" : formatSeconds(health.avg_ms);

  return (
    <div
      className={`channel-card${upstream.enabled ? "" : " channel-card--disabled"}${checked ? " channel-card--selected is-selected" : ""}`}
      data-card-upstream-id={upstream.id}
      onClick={(event) => {
        const target = event.target as HTMLElement | null;
        if (target?.closest("button, input, a, select, textarea, [role='button'], [role='menuitem'], [role='switch']")) {
          return;
        }
        onCheck?.(!checked);
      }}
    >
      {diagnostics}
      <div className="channel-card-header">
        <div className="channel-card-title">
          <input
            type="checkbox"
            className="channel-card-check"
            aria-label={`选择渠道 ${upstream.name}`}
            checked={checked}
            onChange={(event) => onCheck?.(event.target.checked)}
          />
          <span className={`status-dot status-dot--${upstream.enabled ? "live" : "offline"}`} />
          <h3 title={upstream.name}>{upstream.name}</h3>
        </div>
        <div className="channel-card-header-actions">
          <span className="channel-card-badge">优先级 {upstream.priority}</span>
          <button
            type="button"
            className={`status-switch ${upstream.enabled ? "on" : "off"}`}
            role="switch"
            aria-checked={upstream.enabled}
            aria-label={`${upstream.enabled ? "停用" : "启用"}渠道 ${upstream.name}`}
            title={upstream.enabled ? "点击停用" : "点击启用"}
            disabled={busy}
            onClick={onToggle}
          >
            <span className="status-switch-track" aria-hidden="true">
              <span className="status-switch-thumb" />
            </span>
          </button>
          <ActionMenu
            label={`${upstream.name} 的操作菜单`}
            entries={menu}
            trigger={({ ref, onClick, expanded }) => (
              <button
                ref={ref}
                type="button"
                className="secondary action-menu-trigger"
                aria-haspopup="menu"
                aria-expanded={expanded}
                aria-label={`打开 ${upstream.name} 的操作菜单`}
                title="操作"
                disabled={busy}
                onClick={onClick}
              >
                <span aria-hidden="true">⋮</span>
              </button>
            )}
          />
        </div>
      </div>

      <div className="channel-card-sparkline">
        <div className="sparkline-header">
          <span className="sparkline-label">请求量 (6h)</span>
          <span className="sparkline-value">{sixHourTotal}</span>
        </div>
        <Sparkline values={sparkValues} />
      </div>

      <div className="channel-card-health">
        <div className="sparkline-header">
          <span className="sparkline-label">24h 健康</span>
          <span className="health-summary">
            <span className={`health-stat${successTone}`} title="24 小时成功率">
              {`在线率 ${successLabel}`}
            </span>
            <span className="health-stat" title="24 小时平均耗时">
              {`均延迟 ${latencyLabel}`}
            </span>
          </span>
        </div>
        <HealthBars health={health} />
      </div>

      <div className="channel-card-metrics">
        <MetricTile label="总请求" value={stats ? formatMetric(stats.totalRequests) : "—"} />
        <MetricTile label="缓存命中" value={stats ? `${stats.cacheHitRate.toFixed(1)}%` : "—"} />
        <MetricTile
          label="平均 Token / 千次请求"
          value={stats ? formatMetric(Math.round(stats.avgTokensPer1M)) : "—"}
          title="项目未存储价格数据，此处为每千次请求的平均 Token 消耗"
          wide
        />
      </div>

      <button type="button" className="channel-card-action" onClick={onOpenDetail}>
        查看详情 →
      </button>
    </div>
  );
}
