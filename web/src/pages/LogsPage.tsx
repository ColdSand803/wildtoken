import { useCallback, useEffect, useMemo, useState } from "react";

import { UnauthorizedError, api } from "../api";
import type { ActiveRequest, RequestLog, RequestLogPage } from "../types";
import { useLogStream } from "../useLogStream";
import { elapsedMs, formatElapsed, useTicker } from "../useTicker";

/**
 * 日志页探针。
 *
 * 取的是渠道页没碰到的硬点：SSE 流、指数退避重连、批量渲染节流、在途
 * 请求 100ms 计时。详情弹窗、游标分页、列显隐、FLIP 动画故意不做——
 * 那些是常规活，量不出新东西。
 */
export function LogsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [page, setPage] = useState<RequestLogPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [clientFilter, setClientFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");

  const reload = useCallback(async () => {
    try {
      setPage(await api<RequestLogPage>("/api/admin/logs/?limit=50"));
      setError("");
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const stream = useLogStream(true, reload);

  /* 首屏用列表接口的数据，之后流推来的追加在前面。两边都可能有同一条，
     按 id 去重。 */
  const logs = useMemo(() => {
    const seen = new Set<number>();
    const merged: RequestLog[] = [];
    for (const log of [...stream.logs, ...(page?.items ?? [])]) {
      if (seen.has(log.id)) continue;
      seen.add(log.id);
      merged.push(log);
    }
    return merged.filter((log) => {
      if (clientFilter && log.client_type !== clientFilter) return false;
      if (statusFilter) {
        const code = log.status_code ?? 0;
        if (statusFilter === "none" && log.status_code != null) return false;
        if (statusFilter !== "none" && Math.floor(code / 100) !== Number(statusFilter[0])) {
          return false;
        }
      }
      return true;
    });
  }, [stream.logs, page?.items, clientFilter, statusFilter]);

  /* 流一连上就以它的快照为准；没连上时退回首屏那份。 */
  const active = stream.connected ? stream.active : (page?.active ?? []);
  const activeTotal = stream.connected ? stream.activeTotal : (page?.active_total ?? 0);
  const rpm = stream.rpm ?? page?.recent_rpm ?? null;
  const tpm = stream.tpm ?? page?.recent_tpm ?? null;

  return (
    <section className="view" data-view="logs">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">REQUEST STREAM</span>
            <h2>使用日志</h2>
            <p>实时请求流与在途请求。</p>
          </div>
        </div>

        <div className="log-rate-pills">
          <RatePill label="RPM" value={rpm} />
          <RatePill label="TPM" value={tpm} />
          <RatePill label="并发" value={activeTotal} />
        </div>

        <div className="log-toolbar">
          <label className="log-filter">
            <select
              aria-label="按客户端筛选日志"
              value={clientFilter}
              onChange={(event) => setClientFilter(event.target.value)}
            >
              <option value="">全部客户端</option>
              {[...new Set(logs.map((log) => log.client_type))].sort().map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
            </select>
          </label>
          <label className="log-filter">
            <select
              aria-label="按状态码筛选日志"
              value={statusFilter}
              onChange={(event) => setStatusFilter(event.target.value)}
            >
              <option value="">全部状态</option>
              <option value="2xx">2xx</option>
              <option value="4xx">4xx</option>
              <option value="5xx">5xx</option>
              <option value="none">无响应</option>
            </select>
          </label>
          <div className="actions toolbar-actions">
            <span className={`live-indicator${stream.connected ? " is-live" : ""}`}>
              <span className="live-dot" aria-hidden="true" />
              <span className="live-label">{stream.connected ? "实时" : "已断开"}</span>
            </span>
            <button type="button" className="secondary" onClick={() => void reload()}>
              刷新
            </button>
          </div>
        </div>

        {error ? (
          <p className="field-hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        <div className="table-wrap">
          <table className="admin-table log-table">
            <thead>
              <tr>
                <th data-col="time">时间</th>
                <th data-col="channel">渠道</th>
                <th data-col="client">客户端</th>
                <th data-col="model">模型</th>
                <th data-col="status">状态码</th>
                <th data-col="duration">响应性能</th>
                <th data-col="tokens">Tokens</th>
              </tr>
            </thead>
            <tbody>
              <ActiveRows active={active} />
              {loading && logs.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">加载中…</td>
                </tr>
              ) : logs.length === 0 && active.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">暂无请求日志</td>
                </tr>
              ) : (
                logs.map((log) => <LogRow key={log.id} log={log} />)
              )}
            </tbody>
          </table>
        </div>
      </section>
    </section>
  );
}

function RatePill({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="log-rate-pill">
      <span className="log-rate-label">{label}</span>
      <strong className="log-rate-value">{value ?? "—"}</strong>
    </span>
  );
}

/**
 * 在途请求行。
 *
 * 只在有在途请求时才开计时器——空列表还每秒醒 10 次没意义。
 * receivedAt 按快照身份重置：服务端发的是全量快照，换一批就要重新计时。
 */
function ActiveRows({ active }: { active: ActiveRequest[] }) {
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const signature = active.map((request) => request.id).join(",");

  useEffect(() => {
    setReceivedAt(Date.now());
  }, [signature]);

  const now = useTicker(active.length > 0);

  return (
    <>
      {active.map((request) => (
        <tr key={`active-${request.id}`} className="log-row log-row--active">
          <td className="time-cell" data-col="time">
            <span className="badge on">进行中</span>
          </td>
          <td className="channel-cell" data-col="channel">
            {request.upstream_name ?? <span className="muted">选择中</span>}
            {request.attempt > 1 ? (
              <span className="badge neutral">第 {request.attempt} 次</span>
            ) : null}
          </td>
          <td data-col="client">
            <span className="badge neutral">{request.client_type}</span>
          </td>
          <td className="model-cell" data-col="model">
            {request.upstream_model ?? request.model ?? <span className="muted">-</span>}
          </td>
          <td data-col="status">
            <span className="muted">—</span>
          </td>
          <td className="duration-cell" data-col="duration">
            <span className="latency-metrics">
              <span className="latency-metric">
                <small>已用时</small>
                <span className="duration-time neutral">
                  {formatElapsed(elapsedMs(request.elapsed_ms, receivedAt, now))}
                </span>
              </span>
            </span>
          </td>
          <td className="tokens-cell" data-col="tokens">
            <span className="muted">-</span>
          </td>
        </tr>
      ))}
    </>
  );
}

function LogRow({ log }: { log: RequestLog }) {
  return (
    <tr className="log-row">
      <td className="time-cell" data-col="time">
        <span>{formatTimestamp(log.created_at)}</span>
        <span className="muted">#{log.id}</span>
      </td>
      <td className="channel-cell" data-col="channel">
        {log.upstream_name ?? <span className="muted">-</span>}
      </td>
      <td data-col="client">
        <span className="badge neutral">{log.client_type}</span>
      </td>
      <td className="model-cell" data-col="model">
        {log.upstream_model ?? log.model ?? <span className="muted">-</span>}
      </td>
      <td data-col="status">
        <StatusBadge code={log.status_code} />
      </td>
      <td className="duration-cell" data-col="duration">
        <span className="latency-metrics">
          <span className="latency-metric">
            <small>首字</small>
            <span className="first-token-time neutral">
              {log.first_token_ms == null ? "-" : `${log.first_token_ms}ms`}
            </span>
          </span>
          <span className="latency-metric">
            <small>耗时</small>
            <span className="duration-time neutral">
              {log.duration_ms == null ? "-" : formatElapsed(log.duration_ms)}
            </span>
          </span>
        </span>
      </td>
      <td className="tokens-cell" data-col="tokens">
        <span className="token-io">
          <span className="token-io-line token-io-in">
            <span className="token-io-arrow" aria-hidden="true">↑</span>
            <b>{formatCount(log.prompt_tokens)}</b>
          </span>
          <span className="token-io-line token-io-out">
            <span className="token-io-arrow" aria-hidden="true">↓</span>
            <b>{formatCount(log.completion_tokens)}</b>
          </span>
        </span>
      </td>
    </tr>
  );
}

function StatusBadge({ code }: { code: number | null }) {
  if (code == null) return <span className="muted">无响应</span>;
  const bucket = Math.floor(code / 100);
  const tone = bucket === 2 ? "on" : bucket === 3 ? "neutral" : "danger";
  return <span className={`badge ${tone} status-${bucket}xx`}>{code}</span>;
}

/** 扫列表要的是量级，2500000 这种长度会挤掉别的列。 */
function formatCount(value: number | null): string {
  if (value == null) return "-";
  for (const [suffix, unit] of [
    ["M", 1e6],
    ["K", 1e3],
  ] as const) {
    if (value >= unit) {
      const scaled = value / unit;
      const text = scaled >= 100 || Number.isInteger(scaled)
        ? String(Math.round(scaled))
        : scaled.toFixed(1);
      return `${text}${suffix}`;
    }
  }
  return String(value);
}

function formatTimestamp(raw: string): string {
  // 后端给的是 UTC 且不带时区标记，补上 Z 才不会被当成本地时间。
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withZone = /[Z+]|-\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  if (Number.isNaN(date.getTime())) return raw;
  return date.toLocaleTimeString("zh-CN", { hour12: false });
}
