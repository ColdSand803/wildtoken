import { ActionMenu } from "./ActionMenu";
import type { MenuEntry } from "./ActionMenu";
import type { Upstream, UpstreamStats } from "../types";

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

function MetricTile({ label, value, title }: { label: string; value: string; title?: string }) {
  return (
    <div className="metric-tile" title={title}>
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
  busy,
  menu,
  onToggle,
}: {
  upstream: Upstream;
  stats: UpstreamStats | null;
  busy: boolean;
  menu: MenuEntry[];
  onToggle: () => void;
}) {
  const sparkValues = stats?.sparkline.map((point) => point.count) ?? [];
  const sixHourTotal = stats ? formatMetric(sparkValues.reduce((sum, n) => sum + n, 0)) : "—";

  return (
    <div
      className={`channel-card${upstream.enabled ? "" : " channel-card--disabled"}`}
      data-card-upstream-id={upstream.id}
    >
      <div className="channel-card-header">
        <div className="channel-card-title">
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

      <div className="channel-card-metrics">
        <MetricTile label="总请求" value={stats ? formatMetric(stats.totalRequests) : "—"} />
        <MetricTile label="缓存命中" value={stats ? `${stats.cacheHitRate.toFixed(1)}%` : "—"} />
        <MetricTile
          label="平均 Token"
          value={stats ? formatMetric(Math.round(stats.avgTokensPer1M)) : "—"}
          title="本项目不存单价，这里是每百万请求的平均 Token 消耗，作为成本的代理指标"
        />
        <MetricTile label="有效权重" value={String(Math.round(upstream.effective_weight))} />
      </div>
    </div>
  );
}
