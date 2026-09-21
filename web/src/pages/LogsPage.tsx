import { useCallback, useEffect, useMemo, useState } from "react";

import { UnauthorizedError, getLogDetail, listLogs, listUpstreams } from "../api";
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

/** 客户端筛选的固定档位，照抄旧版。后三个是控制台探测，不是真实客户端。 */
/**
 * 思考强度链：请求 → 上游 → 响应。
 *
 * 相邻两步相同就合并——没改写过的链路不该显示成三段一模一样的值。
 */
interface ReasoningSource {
  reasoning_effort: string | null;
  upstream_reasoning_effort: string | null;
  /** 在途请求还没有这一段。 */
  response_reasoning_effort?: string | null;
}

function reasoningChain(log: ReasoningSource): Array<{ label: string; value: string }> {
  const steps = [
    { label: "请求强度", value: (log.reasoning_effort ?? "").trim() },
    { label: "上游强度", value: (log.upstream_reasoning_effort ?? "").trim() },
    { label: "响应强度", value: (log.response_reasoning_effort ?? "").trim() },
  ].filter((step) => step.value);

  const chain: Array<{ label: string; value: string }> = [];
  for (const step of steps) {
    if (chain.length > 0 && chain[chain.length - 1].value === step.value) continue;
    chain.push(step);
  }
  return chain;
}

/** 单值平铺，多值用 ↳ 排成路由链，和模型列同一套写法。 */
function ReasoningCell({ log }: { log: ReasoningSource }) {
  const chain = reasoningChain(log);
  if (chain.length === 0) return <span className="muted">-</span>;

  const title = chain.map((step) => `${step.label}：${step.value}`).join("；");
  if (chain.length === 1) {
    return (
      <span className="model-text model-single" title={chain[0].value}>
        {chain[0].value}
      </span>
    );
  }

  const [first, ...rest] = chain;
  return (
    <span className="model-route" title={title}>
      <span className="model-route-line">
        <span className="model-text model-request">{first.value}</span>
      </span>
      {rest.map((step, index) => (
        <span key={index} className="model-route-line model-route-target">
          <span className="model-route-icon" aria-hidden="true">
            ↳
          </span>
          <span className="model-text model-upstream">{step.value}</span>
        </span>
      ))}
    </span>
  );
}

const CLIENT_TYPES = [
  "codex-desktop",
  "codex-tui",
  "codex",
  "opencode",
  "claude",
  "pi",
  "unknown",
  "model-test",
  "channel-test",
  "model-list",
  "balance",
];

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
  const [upstreamFilter, setUpstreamFilter] = useState("");
  const [upstreams, setUpstreams] = useState<Array<{ id: number; name: string }>>([]);
  /* 输入框的实时值和真正拿去查的值分开。每敲一下键都发一次查询的话，
     输一个模型名会打出十几次全库扫描。 */
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
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
            search,
            clientType: clientFilter,
            status: statusFilter,
            upstreamId: upstreamFilter,
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
    [onUnauthorized, pageSize, search, clientFilter, statusFilter, upstreamFilter],
  );

  useEffect(() => {
    void load(cursors.at(-1));
  }, [load, cursors]);

  // 400ms 后才落到真正的查询词。
  useEffect(() => {
    const timer = setTimeout(() => setSearch(searchInput), 400);
    return () => clearTimeout(timer);
  }, [searchInput]);

  /* 换了筛选条件就回到第一页。旧游标是按旧条件算出来的，留着会把新结果集
     从一个不属于它的位置截断。 */
  useEffect(() => {
    setCursors([]);
  }, [search, clientFilter, statusFilter, upstreamFilter]);

  /* 渠道下拉要全量渠道，不能从当前页数据里凑——凑出来的话，没出现在这
     50 行里的渠道就根本选不到。 */
  useEffect(() => {
    listUpstreams()
      .then((list) => setUpstreams(list.map((item) => ({ id: item.id, name: item.name }))))
      .catch(() => setUpstreams([]));
  }, []);

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
    /* 不在这里再过滤一遍。筛选已经回服务端，前端再筛一次只会把流推来的
       新行误删——它们没经过查询，但确实属于当前结果集。 */
    return merged;
  }, [stream.logs, page?.items, onLatestPage]);

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
          <label className="log-filter log-filter-channel">
            <select
              aria-label="按渠道筛选日志"
              value={upstreamFilter}
              onChange={(event) => setUpstreamFilter(event.target.value)}
            >
              <option value="">全部渠道</option>
              {upstreams.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </label>

          <label className="log-filter">
            <input
              type="search"
              id="log-search"
              autoComplete="off"
              placeholder="模型、渠道、令牌、状态码…"
              aria-label="搜索日志"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
            />
          </label>

          <label className="log-filter">
            <select
              aria-label="按客户端筛选日志"
              value={clientFilter}
              onChange={(event) => setClientFilter(event.target.value)}
            >
              <option value="">全部客户端</option>
              {/* 固定清单，和旧版一致。从当前页数据里凑的话，没出现在这几十行
                  里的客户端就根本选不到。 */}
              {CLIENT_TYPES.map((type) => (
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
              <path
                className="log-sensitive-eye"
                d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"
              />
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
          <p role="status" aria-live="polite">有新的请求日志。</p>
          <button type="button" className="secondary" onClick={goLatest}>
            返回最新
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
                <th className="col-reasoning" data-col="reasoning">思考强度</th>
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
                  <td colSpan={10} className="muted">加载中…</td>
                </tr>
              ) : logs.length === 0 && active.length === 0 ? (
                <tr>
                  <td colSpan={10} className="muted">暂无请求日志</td>
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

        <div className="pager log-pager">
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
          {/* 在途行也要占这一格，否则它和已完成的行差一列，整行错位。
              响应强度还没回来，链路自然只有前两段。 */}
          <td className="col-reasoning" data-col="reasoning">
            <ReasoningCell log={request} />
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
      {/* 漏掉这一格表头 10 列、表体 9 格，其后所有单元格整体左移。 */}
      <td className="col-reasoning" data-col="reasoning">
        <ReasoningCell log={log} />
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
