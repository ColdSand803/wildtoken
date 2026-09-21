import { useCallback, useEffect, useMemo, useState } from "react";

import { UnauthorizedError, getLogDetail, listLogs } from "../api";
import { LogDetailDialog } from "../components/LogDetailDialog";
import type { ActiveRequest, RequestLog, RequestLogDetail, RequestLogPage } from "../types";
import { useLogStream } from "../useLogStream";
import { elapsedMs, formatElapsed, useTicker } from "../useTicker";

/** 可显隐的列。键就是 data-col 的值，隐藏靠表格上的 col-hide-{key}。 */
const COLUMNS = [
  { key: "time", label: "时间" },
  { key: "channel", label: "渠道" },
  { key: "token", label: "令牌" },
  { key: "client", label: "客户端" },
  { key: "model", label: "模型" },
  { key: "status", label: "状态码" },
  { key: "duration", label: "响应性能" },
  { key: "tokens", label: "Tokens" },
  { key: "detail", label: "详情" },
] as const;

type ColumnKey = (typeof COLUMNS)[number]["key"];

const COLUMNS_STORAGE_KEY = "wildtoken_log_columns";
const SENSITIVE_STORAGE_KEY = "wildtoken_log_sensitive_hidden";
const PAGE_SIZES = [20, 50, 100, 200];

function readColumns(): Record<ColumnKey, boolean> {
  const fallback = Object.fromEntries(COLUMNS.map((c) => [c.key, true])) as Record<ColumnKey, boolean>;
  try {
    const raw = localStorage.getItem(COLUMNS_STORAGE_KEY);
    return raw ? { ...fallback, ...(JSON.parse(raw) as Record<string, boolean>) } : fallback;
  } catch {
    return fallback;
  }
}

function readSensitiveHidden(): boolean {
  try {
    return localStorage.getItem(SENSITIVE_STORAGE_KEY) === "true";
  } catch {
    return false;
  }
}

/** 遮罩：留首尾各两个字符，中间打点。太短的整串遮掉。 */
function mask(value: string): string {
  if (value.length <= 5) return "•".repeat(Math.max(3, value.length));
  return `${value.slice(0, 2)}${"•".repeat(4)}${value.slice(-2)}`;
}

/**
 * 日志页。
 *
 * SSE、在途计时和批量节流在 useLogStream/useTicker 里，这里只负责列表、
 * 筛选、分页和详情。
 */
export function LogsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [page, setPage] = useState<RequestLogPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [clientFilter, setClientFilter] = useState("");
  const [statusFilter, setStatusFilter] = useState("");
  const [columns, setColumns] = useState<Record<ColumnKey, boolean>>(readColumns);
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const [sensitiveHidden, setSensitiveHidden] = useState(readSensitiveHidden);
  const [pageSize, setPageSize] = useState(50);
  /* 游标栈：每翻一页压一个起点，回退时弹出。纯 offset 在持续写入时会
     重复或漏行——新日志插在头部会把后面的整体挤后。 */
  const [cursors, setCursors] = useState<Array<{ created_at: string; id: number }>>([]);
  const [detailId, setDetailId] = useState<number | null>(null);
  const [detail, setDetail] = useState<RequestLogDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  /* 不在最新页时流推来的新行不能直接插进去——那会和当前游标页混在一起。
     改成提示条，点一下回到最新页。 */
  const [missedNew, setMissedNew] = useState(false);

  const onLatestPage = cursors.length === 0;

  const load = useCallback(
    async (cursor?: { created_at: string; id: number }) => {
      try {
        setPage(
          await listLogs({
            limit: pageSize,
            beforeCreatedAt: cursor?.created_at,
            beforeId: cursor?.id,
          }),
        );
        setError("");
      } catch (err) {
        if (err instanceof UnauthorizedError) onUnauthorized(err.message);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [onUnauthorized, pageSize],
  );

  useEffect(() => {
    void load(cursors.at(-1));
  }, [load, cursors]);

  const onResync = useCallback(() => {
    if (onLatestPage) void load();
    else setMissedNew(true);
  }, [load, onLatestPage]);

  const stream = useLogStream(true, onResync);

  /* 流推来的新行只在最新页合并；翻到旧页时攒着，靠提示条告知。 */
  useEffect(() => {
    if (!onLatestPage && stream.logs.length > 0) setMissedNew(true);
  }, [stream.logs.length, onLatestPage]);

  const logs = useMemo(() => {
    const seen = new Set<number>();
    const merged: RequestLog[] = [];
    const source = onLatestPage ? [...stream.logs, ...(page?.items ?? [])] : (page?.items ?? []);
    for (const log of source) {
      if (seen.has(log.id)) continue;
      seen.add(log.id);
      merged.push(log);
    }
    return merged.filter((log) => {
      if (clientFilter && log.client_type !== clientFilter) return false;
      if (statusFilter) {
        if (statusFilter === "none") return log.status_code === null;
        return Math.floor((log.status_code ?? 0) / 100) === Number(statusFilter[0]);
      }
      return true;
    });
  }, [stream.logs, page?.items, clientFilter, statusFilter, onLatestPage]);

  const active = onLatestPage ? (stream.connected ? stream.active : (page?.active ?? [])) : [];
  const activeTotal = stream.connected ? stream.activeTotal : (page?.active_total ?? 0);

  function toggleColumn(key: ColumnKey) {
    setColumns((current) => {
      const next = { ...current, [key]: !current[key] };
      try {
        localStorage.setItem(COLUMNS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        return next;
      }
      return next;
    });
  }

  function toggleSensitive() {
    setSensitiveHidden((current) => {
      const next = !current;
      try {
        localStorage.setItem(SENSITIVE_STORAGE_KEY, String(next));
      } catch {
        return next;
      }
      return next;
    });
  }

  async function openDetail(id: number) {
    setDetailId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      setDetail(await getLogDetail(id));
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else setError(err instanceof Error ? err.message : String(err));
      setDetailId(null);
    } finally {
      setDetailLoading(false);
    }
  }

  function goLatest() {
    setCursors([]);
    setMissedNew(false);
  }

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
          <RatePill label="RPM" value={stream.rpm ?? page?.recent_rpm ?? null} />
          <RatePill label="TPM" value={stream.tpm ?? page?.recent_tpm ?? null} />
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

          <div className="col-menu-wrap">
            <button
              type="button"
              className="secondary ghost col-menu-btn"
              aria-haspopup="true"
              aria-expanded={colMenuOpen}
              onClick={() => setColMenuOpen((open) => !open)}
            >
              列
            </button>
            <div className="col-menu" hidden={!colMenuOpen} role="menu" aria-label="日志列显示">
              {COLUMNS.map((column) => (
                <label key={column.key}>
                  <input
                    type="checkbox"
                    checked={columns[column.key]}
                    onChange={() => toggleColumn(column.key)}
                  />
                  <span>{column.label}</span>
                </label>
              ))}
            </div>
          </div>

          <button
            type="button"
            className={`secondary ghost log-sensitive-toggle${sensitiveHidden ? " is-active" : ""}`}
            aria-pressed={sensitiveHidden}
            aria-label={sensitiveHidden ? "敏感信息已屏蔽，点击显示" : "敏感信息显示中，点击屏蔽"}
            title={sensitiveHidden ? "敏感信息已屏蔽" : "点击屏蔽令牌与渠道名"}
            onClick={toggleSensitive}
          >
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z" />
              <circle cx="12" cy="12" r="3" />
              {sensitiveHidden ? <line className="log-sensitive-slash" x1="3" y1="3" x2="21" y2="21" /> : null}
            </svg>
          </button>

          <div className="actions toolbar-actions">
            <span className={`live-indicator${stream.connected ? " is-live" : ""}`}>
              <span className="live-dot" aria-hidden="true" />
              <span className="live-label">{stream.connected ? "实时" : "已断开"}</span>
            </span>
            <button type="button" className="secondary" onClick={() => void load(cursors.at(-1))}>
              刷新
            </button>
          </div>
        </div>

        {error ? (
          <p className="field-hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        {/* 翻到旧页时新日志不插进列表，用提示条告知并给一键回到最新。 */}
        <div className="log-new-entries-notice" hidden={!missedNew}>
          <p>有新的日志写入。</p>
          <button type="button" className="secondary" onClick={goLatest}>
            回到最新
          </button>
        </div>

        <div className="table-wrap">
          <table
            className={[
              "admin-table",
              "log-table",
              ...COLUMNS.filter((c) => !columns[c.key]).map((c) => `col-hide-${c.key}`),
            ].join(" ")}
          >
            <thead>
              <tr>
                <th data-col="time">时间</th>
                <th data-col="channel">渠道</th>
                <th data-col="token">令牌</th>
                <th data-col="client">客户端</th>
                <th data-col="model">模型</th>
                <th data-col="status">状态码</th>
                <th data-col="duration">响应性能</th>
                <th data-col="tokens">Tokens</th>
                <th data-col="detail">详情</th>
              </tr>
            </thead>
            <tbody>
              <ActiveRows active={active} sensitiveHidden={sensitiveHidden} />
              {loading && logs.length === 0 ? (
                <tr>
                  <td colSpan={9} className="muted">加载中…</td>
                </tr>
              ) : logs.length === 0 && active.length === 0 ? (
                <tr>
                  <td colSpan={9} className="muted">暂无请求日志</td>
                </tr>
              ) : (
                logs.map((log) => (
                  <LogRow
                    key={log.id}
                    log={log}
                    sensitiveHidden={sensitiveHidden}
                    onOpenDetail={() => void openDetail(log.id)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="pager">
          <div className="pager-meta">
            <span className="pager-meta-text">第 {cursors.length + 1} 页</span>
            <label className="pager-size-field">
              <span className="pager-size-label">每页</span>
              <select
                aria-label="日志每页条数"
                value={pageSize}
                onChange={(event) => {
                  setPageSize(Number(event.target.value));
                  // 改了每页条数，旧游标的页号对不上了，回到最新页。
                  setCursors([]);
                }}
              >
                {PAGE_SIZES.map((size) => (
                  <option key={size} value={size}>
                    {size}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="pager-actions">
            <button type="button" className="secondary" disabled={onLatestPage} onClick={goLatest}>
              首页
            </button>
            <button
              type="button"
              className="secondary"
              disabled={onLatestPage}
              onClick={() => setCursors((stack) => stack.slice(0, -1))}
            >
              上一页
            </button>
            <button
              type="button"
              className="secondary"
              disabled={!page?.has_more}
              onClick={() => {
                const last = page?.items.at(-1);
                if (last) setCursors((stack) => [...stack, { created_at: last.created_at, id: last.id }]);
              }}
            >
              下一页
            </button>
          </div>
        </div>
      </section>

      <LogDetailDialog
        open={detailId !== null}
        detail={detail}
        loading={detailLoading}
        onClose={() => {
          setDetailId(null);
          setDetail(null);
        }}
      />
    </section>
  );
}

function RatePill({ label, value }: { label: string; value: number | null }) {
  return (
    <span className="log-rate-pill">
      <span className="log-rate-pill-label">{label}</span>
      <span className="log-rate-value">{value ?? "—"}</span>
    </span>
  );
}

function ActiveRows({
  active,
  sensitiveHidden,
}: {
  active: ActiveRequest[];
  sensitiveHidden: boolean;
}) {
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
            {request.upstream_name ? (
              sensitiveHidden ? mask(request.upstream_name) : request.upstream_name
            ) : (
              <span className="muted">选择中</span>
            )}
            {request.attempt > 1 ? (
              <span className="badge neutral">第 {request.attempt} 次</span>
            ) : null}
          </td>
          <td className="token-cell" data-col="token">
            <span className="muted">-</span>
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
          <td className="detail-cell" data-col="detail">
            <span className="muted">-</span>
          </td>
        </tr>
      ))}
    </>
  );
}

function LogRow({
  log,
  sensitiveHidden,
  onOpenDetail,
}: {
  log: RequestLog;
  sensitiveHidden: boolean;
  onOpenDetail: () => void;
}) {
  const channel = log.upstream_name ?? "";
  const token = log.downstream_token_name ?? "";
  return (
    <tr className="log-row">
      <td className="time-cell" data-col="time">
        <span>{formatTimestamp(log.created_at)}</span>
        <span className="muted">#{log.id}</span>
      </td>
      <td className="channel-cell" data-col="channel">
        {channel ? (sensitiveHidden ? mask(channel) : channel) : <span className="muted">-</span>}
      </td>
      <td className="token-cell" data-col="token">
        {token ? (sensitiveHidden ? mask(token) : token) : <span className="muted">-</span>}
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
              {log.first_token_ms === null ? "-" : `${log.first_token_ms}ms`}
            </span>
          </span>
          <span className="latency-metric">
            <small>耗时</small>
            <span className="duration-time neutral">
              {log.duration_ms === null ? "-" : formatElapsed(log.duration_ms)}
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
      <td className="detail-cell" data-col="detail">
        <button type="button" className="secondary" onClick={onOpenDetail}>
          {log.error ? "错误" : "查看"}
        </button>
      </td>
    </tr>
  );
}

function StatusBadge({ code }: { code: number | null }) {
  if (code === null) return <span className="muted">无响应</span>;
  const bucket = Math.floor(code / 100);
  const tone = bucket === 2 ? "on" : bucket === 3 ? "neutral" : "danger";
  return <span className={`badge ${tone} status-${bucket}xx`}>{code}</span>;
}

/** 扫列表要的是量级，2500000 这种长度会挤掉别的列。 */
function formatCount(value: number | null): string {
  if (value === null) return "-";
  for (const [suffix, unit] of [
    ["M", 1e6],
    ["K", 1e3],
  ] as const) {
    if (value >= unit) {
      const scaled = value / unit;
      const text = scaled >= 100 || Number.isInteger(scaled) ? String(Math.round(scaled)) : scaled.toFixed(1);
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
  return Number.isNaN(date.getTime()) ? raw : date.toLocaleTimeString("zh-CN", { hour12: false });
}
