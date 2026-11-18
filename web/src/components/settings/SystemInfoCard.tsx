import type { SystemInfo } from "../../types";
import { LoadError } from "../LoadError";

const count = (value: number) => Number(value || 0).toLocaleString("zh-CN");

function bytes(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)}GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)}MB`;
  if (value >= 1024) return `${Math.round(value / 1024)}KB`;
  return `${value}B`;
}

function uptime(seconds: number): string {
  if (!Number.isFinite(seconds)) return "—";
  const total = Math.max(0, Math.floor(seconds));
  const days = Math.floor(total / 86400);
  const hours = Math.floor(total % 86400 / 3600);
  const minutes = Math.floor(total % 3600 / 60);
  const rest = total % 60;
  if (days > 0) return `${days} 天 ${hours} 小时 ${minutes} 分`;
  if (hours > 0) return `${hours} 小时 ${minutes} 分 ${rest} 秒`;
  if (minutes > 0) return `${minutes} 分 ${rest} 秒`;
  return `${rest} 秒`;
}

function duration(ms: number | null | undefined): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0).replace(/\.0$/, "")}s`;
}

export function SystemInfoCard({ system, loading, refreshing, error, onRefresh }: {
  system: SystemInfo | null;
  loading: boolean;
  refreshing: boolean;
  error: string;
  onRefresh: () => unknown;
}) {
  const metrics = system?.runtime_metrics;
  const cleanup = metrics?.cleanup;
  const items: Array<[string, string]> = system && metrics && cleanup ? [
    ["服务", system.service || "WildToken"],
    ["版本", system.version || "—"],
    ["运行时长", uptime(system.uptime_seconds)],
    ["当前服务器时间", system.current_server_time || "—"],
    ["数据库", system.database_ok ? "连接正常" : "不可用"],
    ["数据库已分配", bytes(system.database_allocated_bytes)],
    ["日志总数", count(system.total_log_count)],
    ["近 24 小时日志", count(system.log_count_24h)],
    ["启用渠道", `${system.enabled_upstream_count} / ${system.total_upstream_count}`],
    ["近 1 分钟成功请求", count(system.recent_one_minute_log_count)],
    ["活跃 SSE", count(metrics.active_sse_streams)],
    ["10 分钟 SSE 断连", count(metrics.sse_recent_disconnects_10m)],
    ["SSE 断连总数", count(metrics.sse_client_disconnects_total)],
    ["SSE 上游错误", count(metrics.sse_upstream_errors_total)],
    ["日志队列", count(metrics.log_queue_depth)],
    ["日志写入", count(metrics.log_written_total)],
    ["日志写批次", count(metrics.log_write_batches_total)],
    ["日志丢弃", count(metrics.log_dropped_total)],
    ["日志写失败", count(metrics.log_write_failures_total)],
    ["慢 DB 操作", count(metrics.slow_db_operations_total)],
    ["清理任务", cleanup.active ? "运行中" : "空闲"],
    ["清理进度", cleanup.active
      ? `${count(cleanup.current_rows_cleared)} 行 / ${count(cleanup.current_batches)} 批`
      : `${count(cleanup.last_rows_cleared ?? 0)} 行 · ${duration(cleanup.last_duration_ms)}`],
  ] : [];

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <div><h3>运行信息</h3><p>只展示服务状态与汇总信息，不包含环境路径或秘密。</p></div>
        <button type="button" className="secondary" disabled={refreshing} onClick={() => { onRefresh(); }}>
          {refreshing ? "刷新中…" : "刷新"}
        </button>
      </div>
      <LoadError error={error} label="运行信息" onRetry={onRefresh} />
      <div className="system-info-grid" aria-live="polite">
        {loading ? <p className="settings-loading">加载运行信息…</p> : items.map(([label, value]) => (
          <div key={label} className="system-info-item"><span>{label}</span><strong>{value}</strong></div>
        ))}
      </div>
    </section>
  );
}
