import { clearLogDrilldown, logFilterQuery, matchesLogFilters, readLogDrilldown, saveLogDrilldown } from "../logFilters";
import type { LogFilters } from "../logFilters";
import { LogTiming } from "../components/LogTiming";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { UnauthorizedError, listLogs, listUpstreams } from "../api";
import { LogDetailDialog } from "../components/LogDetailDialog";
import {
  exactTokens,
  firstTokenTone,
  formatCount,
  formatSeconds,
  formatTimestamp,
  toneByThreshold,
} from "../logFormat";
import { reasoningChain } from "../reasoningChain";
import type { ReasoningSource } from "../reasoningChain";
import type { ActiveRequest, RequestLog, RequestLogPage } from "../types";
import { logMatchesFilters } from "../logFilter";
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

/** 客户端筛选的固定档位。后三个是控制台探测，不是真实客户端。 */
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
/* 旧版的遮罩就是固定六个星号，不按长度变。自造一个「前两位 + 点 + 后两位」
   的遮罩反而泄露了长度和首尾字符。 */
const SENSITIVE_MASK = "******";

function Masked() {
  return <span className="log-sensitive-value">{SENSITIVE_MASK}</span>;
}

/**
 * 渠道格：上下两行。上行 #ID，下行渠道名。
 *
 * 写成一行的话，同名不同 ID 的渠道在日志里分不出来；而过滤器按 ID 筛，
 * 没有 ID 就对不上号。
 */
function ChannelStack({
  log,
  sensitiveHidden,
}: {
  log: { upstream_id: number | null; upstream_name: string | null };
  sensitiveHidden: boolean;
}) {
  const name = (log.upstream_name ?? "").trim();
  const hidden = sensitiveHidden && Boolean(name);

  if (log.upstream_id === null || log.upstream_id === undefined) {
    if (!name) return <span className="muted">无（未匹配到渠道）</span>;
    return (
      <div className="channel-stack">
        <strong title={hidden ? undefined : name}>{hidden ? <Masked /> : name}</strong>
        <span className="muted">无 ID</span>
      </div>
    );
  }

  const shown = hidden ? SENSITIVE_MASK : name;
  return (
    <div className="channel-stack">
      <strong title={name ? `#${log.upstream_id} · ${shown}` : `#${log.upstream_id}`}>
        {`#${log.upstream_id}`}
      </strong>
      <ChannelStackName name={name} hidden={hidden} />
    </div>
  );
}

/** 下行：有名字就显（该遮就遮），没名字说清楚是没名而不是空着。 */
function ChannelStackName({ name, hidden }: { name: string; hidden: boolean }) {
  if (!name) return <span className="muted">无名称</span>;
  if (hidden) {
    return (
      <span className="muted">
        <Masked />
      </span>
    );
  }
  return (
    <span className="muted" title={name}>
      {name}
    </span>
  );
}

/** 压掉换行和连续空白，超长截断。错误正文常带堆栈，不压会把行高撑爆。 */
function compactText(value: string, maxLength: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/**
 * 总耗时的评级。四层兜底，顺序照抄旧版。
 *
 * 关键是第一层：非 2xx 优先标红。一个 3 秒就返回 500 的请求，按吞吐算会是
 * 绿的——快失败也是失败。其后依次按输出吞吐、总吞吐、绝对耗时。
 */
function durationRating(log: RequestLog): { tone: string; basis: string } {
  const status = log.status_code;
  if (status === null || !Number.isFinite(status)) {
    return { tone: "danger", basis: "请求无响应或状态码缺失" };
  }
  if (status < 200 || status >= 300) {
    return { tone: "danger", basis: `HTTP ${status} 错误，优先标红` };
  }

  const duration = log.duration_ms;
  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    return { tone: "neutral", basis: "总耗时无数据" };
  }

  const completion = log.completion_tokens;
  if (completion !== null && Number.isFinite(completion) && completion > 0) {
    const rate = completion / (duration / 1000);
    const shown = rate.toFixed(1).replace(/\.0$/, "");
    return {
      tone: toneByThreshold(rate, 20, 8),
      basis: `按全程输出吞吐 ${shown} t/s 判定`,
    };
  }

  const total = log.total_tokens;
  if (total !== null && Number.isFinite(total) && total > 0) {
    const rate = total / (duration / 1000);
    const shown = rate.toFixed(1).replace(/\.0$/, "");
    return {
      tone: toneByThreshold(rate, 80, 20),
      basis: `按总吞吐 ${shown} t/s 判定`,
    };
  }

  // 耗时是越小越好，取负值后跟上面两处同形。
  return {
    tone: toneByThreshold(-duration, -30000, -60000),
    basis: "无 token 数据，按绝对耗时兜底判定",
  };
}

/** 令牌格：名字带上 #ID 作 title，遮罩时整个换成星号。 */
function TokenCell({
  log,
  sensitiveHidden,
}: {
  log: { downstream_token_id: number | null; downstream_token_name: string | null };
  sensitiveHidden: boolean;
}) {
  const name = (log.downstream_token_name ?? "").trim();
  if (!name) return <span className="muted">-</span>;
  if (sensitiveHidden) return <Masked />;
  return <span title={`#${log.downstream_token_id ?? "-"}`}>{name}</span>;
}

/** IP 格：屏蔽时换成星号。 */
function IpCell({
  ip,
  sensitiveHidden,
}: {
  ip: string | null | undefined;
  sensitiveHidden: boolean;
}) {
  const value = (ip ?? "").trim();
  if (!value) return <span className="muted">-</span>;
  if (sensitiveHidden) return <Masked />;
  return (
    <span className="log-ip" title={value}>
      {value}
    </span>
  );
}

/**
 * 模型格。
 *
 * 请求模型和上游模型不同时排成两行路由链——渠道配了模型映射时，只显示
 * 一个名字会让人分不清到底转发了什么。
 */
function ModelCell({ log }: { log: { request_model: string | null; upstream_model: string | null; model: string | null } }) {
  const requestModel = (log.request_model ?? "").trim();
  const upstreamModel = (log.upstream_model ?? "").trim();
  const fallback = (log.model ?? "").trim();
  const request = requestModel || fallback;
  const upstream = upstreamModel || (requestModel ? fallback : "");

  if (!request && !upstream) return <span className="muted">-</span>;

  if (!request || !upstream || request === upstream) {
    const value = request || upstream;
    return (
      <span className="model-text model-single" title={value}>
        {value}
      </span>
    );
  }

  return (
    <span className="model-route" title={`请求模型：${request}；上游模型：${upstream}`}>
      <span className="model-route-line">
        <span className="model-text model-request">{request}</span>
      </span>
      <span className="model-route-line model-route-target">
        <span className="model-route-icon" aria-hidden="true">
          ↳
        </span>
        <span className="model-text model-upstream">{upstream}</span>
      </span>
    </span>
  );
}

/**
 * 日志页。
 *
 * SSE、在途计时和批量节流在 useLogStream/useTicker 里，这里只负责列表、
 * 筛选、分页和详情。
 */
export function LogsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [initial] = useState(readLogDrilldown);
  const [advanced, setAdvanced] = useState<LogFilters>(() => ({ start: initial.start, end: initial.end, tokenId: initial.tokenId, stream: initial.stream, minDurationMs: initial.minDurationMs }));
  const [rangeStart, setRangeStart] = useState("");
  const [rangeEnd, setRangeEnd] = useState("");
  const [live, setLive] = useState(true);
  const requestVersion = useRef(0);
  const [page, setPage] = useState<RequestLogPage | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [clientFilter, setClientFilter] = useState(initial.clientType ?? "");
  const [statusFilter, setStatusFilter] = useState(initial.status ?? "");
  const [upstreamFilter, setUpstreamFilter] = useState(initial.upstreamId ?? "");
  const [upstreams, setUpstreams] = useState<Array<{ id: number; name: string }>>([]);
  /* 输入框的实时值和真正拿去查的值分开。每敲一下键都发一次查询的话，
     输一个模型名会打出十几次全库扫描。 */
  const [searchInput, setSearchInput] = useState(initial.search ?? "");
  const [search, setSearch] = useState(initial.search ?? "");
  const [columns, setColumns] = useState<Record<ColumnKey, boolean>>(readColumns);
  const [colMenuOpen, setColMenuOpen] = useState(false);
  const [sensitiveHidden, setSensitiveHidden] = useState(readSensitiveHidden);
  const [pageSize, setPageSize] = useState(50);
  /* 游标栈：每翻一页压一个起点，回退时弹出。纯 offset 在持续写入时会
     重复或漏行——新日志插在头部会把后面的整体挤后。 */
  const [cursors, setCursors] = useState<Array<{ created_at: string; id: number }>>([]);
  /* 详情窗直接用列表行：元信息都在行上，报文由窗内按页签拉。 */
  const [detail, setDetail] = useState<RequestLog | null>(null);
  /* 不在最新页时流推来的新行不能直接插进去——那会和当前游标页混在一起。
     改成提示条，点一下回到最新页。 */
  const [missedNew, setMissedNew] = useState(false);

  const onLatestPage = cursors.length === 0;
  const filters = useMemo<LogFilters>(() => ({ ...advanced, search, clientType: clientFilter, status: statusFilter, upstreamId: upstreamFilter }), [advanced, search, clientFilter, statusFilter, upstreamFilter]);
  const filterQuery = logFilterQuery(filters).toString();
  const historical = Boolean(advanced.end && Date.parse(advanced.end) < Date.now() - 2000);
  useEffect(() => {
    saveLogDrilldown(filters);
  }, [filters]);
  useEffect(() => {
    const receive = (event: Event) => {
      const next = (event as CustomEvent<LogFilters>).detail;
      setAdvanced(next); setSearchInput(next.search ?? ""); setSearch(next.search ?? "");
      setClientFilter(next.clientType ?? ""); setStatusFilter(next.status ?? ""); setUpstreamFilter(next.upstreamId ?? "");
    };
    window.addEventListener("console:log-filters", receive);
    return () => window.removeEventListener("console:log-filters", receive);
  }, []);

  const load = useCallback(
    async (cursor?: { created_at: string; id: number }) => {
      const version = ++requestVersion.current;
      try {
        const result = await listLogs({
            ...filters,
            limit: pageSize,
            beforeCreatedAt: cursor?.created_at,
            beforeId: cursor?.id,
            search,
            clientType: clientFilter,
            status: statusFilter,
            upstreamId: upstreamFilter,
          });
        if (version !== requestVersion.current) return;
        setPage(result);
        setError("");
      } catch (err) {
        if (version !== requestVersion.current) return;
        if (err instanceof UnauthorizedError) onUnauthorized(err.message);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        if (version === requestVersion.current) setLoading(false);
      }
    },
    [onUnauthorized, pageSize, filters, search, clientFilter, statusFilter, upstreamFilter],
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
    setCursors((current) => current.length ? [] : current);
    setPage(null);
  }, [filterQuery]);

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

  const stream = useLogStream(live && !historical, onResync, filterQuery);

  /* 流推来的新行只在最新页合并；翻到旧页时攒着，靠提示条告知。 */
  useEffect(() => {
    if (!onLatestPage && stream.logs.some((log) => logMatchesFilters(log, filters))) setMissedNew(true);
  }, [stream.logs, onLatestPage, filters]);

  const logs = useMemo(() => {
    const seen = new Set<number>();
    const merged: RequestLog[] = [];
    const streamed = onLatestPage ? stream.logs.filter((log) => logMatchesFilters(log, filters)) : [];
    for (const log of [...streamed, ...(page?.items ?? [])]) {
      if (seen.has(log.id) || !matchesLogFilters(log, filters)) continue;
      seen.add(log.id);
      merged.push(log);
    }
    return merged.slice(0, pageSize);
  }, [stream.logs, page?.items, onLatestPage, filters, pageSize]);

  /* 在途集合：只在最新页显示。流连着就以它为准，断了退回快照里的那份。 */
  const activeFromPage = page?.active ?? [];
  const activeLatest = stream.connected ? stream.active : activeFromPage;
  const active = onLatestPage ? activeLatest : [];
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

  function openDetail(log: RequestLog) {
    setDetail(log);
  }

  function goLatest() {
    setCursors([]);
    setMissedNew(false);
  }

  return (
    <section className="view" data-view="logs">
      <section className="panel">
        {/* 速率胶囊在 panel-head 里面，和旧版一致。放到外面的话它吃不到
            panel-head 的 padding-bottom + margin-bottom，会直接贴着筛选行。

            而且必须是 <p>：CSS 写的是 .panel p.log-rate-pills，换成 div 就没有
            flex、没有 gap。 */}
        <div className="panel-head">
          <div>
            <span className="eyebrow">REQUEST STREAM</span>
            <h2>使用日志</h2>
            <p>实时请求流与在途请求。</p>
            <p className="log-rate-pills" aria-live="polite" aria-atomic="true">
              <RatePill label="RPM" value={stream.rpm ?? page?.recent_rpm ?? null} />
              <RatePill label="TPM" value={stream.tpm ?? page?.recent_tpm ?? null} />
              <RatePill label="并发" value={activeTotal} />
            </p>
          </div>
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
              onChange={(event) => {
                const value = event.target.value;
                setSearchInput(value);
                if (!value.trim()) {
                  setSearch("");
                  saveLogDrilldown({ ...filters, search: "" });
                }
              }}
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
              <option value="other">其他状态</option>
              <option value="error">全部失败</option>
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
            title={sensitiveHidden ? "敏感信息已屏蔽" : "点击屏蔽令牌、渠道名与 IP"}
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
              <span className="live-label">{historical ? "历史时间窗" : !live ? "已暂停" : stream.connected ? "实时" : "已断开"}</span>
            </span>
            <button type="button" className="secondary" onClick={() => void load(cursors.at(-1))}>
              刷新
            </button>
          </div>
        </div>

        <form className="log-advanced-filters" onSubmit={(event) => {
          event.preventDefault();
          const start = Date.parse(rangeStart), end = Date.parse(rangeEnd);
          if (!Number.isFinite(start) || !Number.isFinite(end) || start >= end || end - start > 366 * 86400000) { setError("请选择完整起止时间，开始须早于结束，范围不超过 366 天。"); return; }
          setAdvanced((value) => ({ ...value, start: new Date(start).toISOString(), end: new Date(end).toISOString() }));
        }}>
          <label>开始<input type="datetime-local" step="1" value={rangeStart} onChange={(e) => setRangeStart(e.target.value)} /></label>
          <label>结束<input type="datetime-local" step="1" value={rangeEnd} onChange={(e) => setRangeEnd(e.target.value)} /></label>
          <button type="submit" className="secondary">应用时间</button>
          <label>传输<select aria-label="日志传输方式" value={advanced.stream ?? ""} onChange={(e) => setAdvanced((value) => ({ ...value, stream: e.target.value }))}><option value="">全部</option><option value="true">流式 SSE</option><option value="false">非流式</option></select></label>
          <label>最小耗时（ms）<input aria-label="最小耗时" type="number" min="0" step="1" value={advanced.minDurationMs ?? ""} onChange={(e) => setAdvanced((value) => ({ ...value, minDurationMs: e.target.value }))} /></label>
          <label>令牌 ID<input aria-label="日志令牌 ID" type="number" min="1" value={advanced.tokenId ?? ""} onChange={(e) => setAdvanced((value) => ({ ...value, tokenId: e.target.value }))} /></label>
          <button type="button" className="secondary" onClick={() => { clearLogDrilldown(); setAdvanced({}); setRangeStart(""); setRangeEnd(""); setSearchInput(""); setSearch(""); setStatusFilter(""); setClientFilter(""); setUpstreamFilter(""); }}>清除筛选</button>
          <button type="button" className="secondary" aria-pressed={live} onClick={() => setLive((value) => !value)}>{live ? "暂停实时" : "恢复实时"}</button>
          {advanced.start && advanced.end && <span className="field-hint">{new Date(advanced.start).toLocaleString("zh-CN")} — {new Date(advanced.end).toLocaleString("zh-CN")}{historical ? " · 历史时间窗" : ""}</span>}
        </form>

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
                <th data-col="ip">IP</th>
                <th data-col="detail">详情</th>
              </tr>
            </thead>
            <tbody>
              <ActiveRows active={active} sensitiveHidden={sensitiveHidden} />
              <LogRows
                logs={logs}
                loading={loading}
                hasActive={active.length > 0}
                sensitiveHidden={sensitiveHidden}
                onOpenDetail={openDetail}
              />
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

      <LogDetailDialog open={detail !== null} log={detail} logs={logs} sensitiveHidden={sensitiveHidden} onSelect={setDetail} onClose={() => setDetail(null)} />
    </section>
  );
}

/* 占位行要横跨整表。写死字面量的话，加一列就会忘了改——加 IP 列时
   就漏了，加载态和空态都短一列。 */
export const LOG_TABLE_COLUMN_COUNT = 11;

function RatePill({ label, value }: { label: string; value: number | null }) {
  /* 千分位分隔。TPM 常常五六位，不分隔读不出量级。RPM 走同一个组件，
     不足一千时显示不变。 */
  const shown =
    value === null || value === undefined ? "—" : value.toLocaleString("zh-CN");
  return (
    <span className="log-rate-pill">
      <span className="log-rate-pill-label">{label}</span>
      <span className="log-rate-value">{shown}</span>
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
        <tr
          key={`active-${request.id}`}
          className="log-row log-row--active"
          title="请求进行中，完成后才会写入日志"
        >
          {/* 时间格和已完成的行同形：上行时间、下行注解。写成一个 badge 的话
              这一列会在两种行之间跳来跳去。 */}
          <td className="time-cell" data-col="time">
            <span>{formatTimestamp(request.started_at)}</span>
            <span className="muted">进行中</span>
          </td>
          <td className="channel-cell" data-col="channel">
            {request.upstream_id === null || request.upstream_id === undefined ? (
              <span className="muted">路由中…</span>
            ) : (
              <ChannelStack log={request} sensitiveHidden={sensitiveHidden} />
            )}
          </td>
          <td className="token-cell" data-col="token">
            <TokenCell log={request} sensitiveHidden={sensitiveHidden} />
          </td>
          <td data-col="client">
            <span className="badge neutral">{request.client_type || "unknown"}</span>
          </td>
          <td className="model-cell" data-col="model">
            <ModelCell log={request} />
          </td>
          {/* 在途行也要占这一格，否则它和已完成的行差一列，整行错位。
              响应强度还没回来，链路自然只有前两段。 */}
          <td className="col-reasoning" data-col="reasoning">
            <ReasoningCell log={request} />
          </td>
          {/* 重试次数跟在状态旁边，不在渠道格里——它描述的是这次请求的处境，
              不是某个渠道的属性。 */}
          <td data-col="status">
            <span className="badge neutral status-active">
              <span className="status-active-dot" aria-hidden="true" />
              进行中
            </span>
            {request.attempt > 1 ? (
              <span className="badge warn active-attempt" title={`已换过 ${request.attempt} 个渠道`}>
                {`第 ${request.attempt} 次`}
              </span>
            ) : null}
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
          {/* 在途行同样要占这一格。IP 在请求一进来就知道了，不必等完成。 */}
          <td className="ip-cell" data-col="ip">
            <IpCell ip={request.client_ip} sensitiveHidden={sensitiveHidden} />
          </td>
          <td className="detail-cell" data-col="detail">
            <span className="muted">-</span>
          </td>
        </tr>
      ))}
    </>
  );
}

/** 表体三态：加载中、空、有行。在途行单独渲染，所以空态要把它也算上。 */
function LogRows({
  logs,
  loading,
  hasActive,
  sensitiveHidden,
  onOpenDetail,
}: {
  logs: RequestLog[];
  loading: boolean;
  hasActive: boolean;
  sensitiveHidden: boolean;
  onOpenDetail: (log: RequestLog) => void;
}) {
  if (loading && logs.length === 0) {
    return (
      <tr>
        <td colSpan={LOG_TABLE_COLUMN_COUNT} className="muted">加载中…</td>
      </tr>
    );
  }
  if (logs.length === 0 && !hasActive) {
    return (
      <tr>
        <td colSpan={LOG_TABLE_COLUMN_COUNT} className="muted">暂无请求日志</td>
      </tr>
    );
  }
  return (
    <>
      {logs.map((log) => (
        <LogRow
          key={log.id}
          log={log}
          sensitiveHidden={sensitiveHidden}
          onOpenDetail={() => onOpenDetail(log)}
        />
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
  return (
    /* 整行可点。tabIndex 让它能被键盘达到，回车和空格等同点击。 */
    <tr
      className="log-row"
      title={log.error || "点击查看请求详情"}
      data-log-id={log.id}
      tabIndex={0}
      onClick={onOpenDetail}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpenDetail();
      }}
    >
      <td className="time-cell" data-col="time">
        <span>{formatTimestamp(log.created_at)}</span>
        <span className="muted">#{log.id}</span>
      </td>
      <td className="channel-cell" data-col="channel">
        <ChannelStack log={log} sensitiveHidden={sensitiveHidden} />
        {"attempt_index" in log && Number(log.attempt_index) > 0 && <span className="log-row-attempt-badge">重试 #{String(log.attempt_index)}</span>}
      </td>
      <td className="token-cell" data-col="token">
        <TokenCell log={log} sensitiveHidden={sensitiveHidden} />
      </td>
      <td data-col="client">
        <span className="badge neutral">{log.client_type}</span>
      </td>
      <td className="model-cell" data-col="model">
        <ModelCell log={log} />
      </td>
      {/* 漏掉这一格表头 10 列、表体 9 格，其后所有单元格整体左移。 */}
      <td className="col-reasoning" data-col="reasoning">
        <ReasoningCell log={log} />
      </td>
      <td data-col="status">
        <StatusBadge code={log.status_code} />
      </td>
      {/* 色调不能写死成 neutral——CSS 里 ok/warn/danger 各有规则，写死了这一列
          就永远是灰的，扫一眼看不出哪条慢。 */}
      <td className="duration-cell" data-col="duration">
        <span className="latency-metrics">
          <span className="latency-metric">
            <small>首字</small>
            <span
              className={`first-token-time ${firstTokenTone(log.first_token_ms)}`}
              title={`首字耗时 ${formatSeconds(log.first_token_ms)}`}
            >
              {formatSeconds(log.first_token_ms)}
            </span>
          </span>
          <span className="latency-metric">
            <small>耗时</small>
            <DurationTime log={log} />
          </span>
        </span>
        <LogTiming log={log} compact />
      </td>
      {/* 列里只给量级，精确值放 title 和 aria-label——缩写不该把数字弄丢，
          1.2M 可能是 115 万也可能是 125 万。 */}
      <td className="tokens-cell" data-col="tokens">
        {/* role="img" 配 aria-label：箭头加缩写的组合读屏念不成句，整格当一个
            整体报读精确值。裸 span 不支持 aria-label。 */}
        <span
          className="token-io"
          role="img"
          aria-label={`${exactTokens("输入", log.prompt_tokens)}，${exactTokens("输出", log.completion_tokens)}`}
        >
          <span className="token-io-line token-io-in" title={exactTokens("输入", log.prompt_tokens)}>
            <span className="token-io-arrow" aria-hidden="true">↑</span>
            <b>{formatCount(log.prompt_tokens)}</b>
          </span>
          <span className="token-io-line token-io-out" title={exactTokens("输出", log.completion_tokens)}>
            <span className="token-io-arrow" aria-hidden="true">↓</span>
            <b>{formatCount(log.completion_tokens)}</b>
          </span>
        </span>
      </td>
      {/* 建列之前的旧行这一格是 null，显示破折号而不是编一个地址出来。
          用 span 不用 code：主题包给所有 code 元素上了底色和边框，IP 是表格里的
          一格数据，不是代码片段。 */}
      <td className="ip-cell" data-col="ip">
        <IpCell ip={log.client_ip} sensitiveHidden={sensitiveHidden} />
      </td>
      {/* 这一列是错误信息，不是按钮。放按钮的话，列表里根本看不出错在哪，
          每行都得点开才知道。打开详情靠整行点击。 */}
      <td className="detail-cell" data-col="detail">
        {log.error?.trim() ? (
          <span className="log-error-detail" title={log.error}>
            {compactText(log.error, 200)}
          </span>
        ) : (
          <span className="muted">-</span>
        )}
      </td>
    </tr>
  );
}

function DurationTime({ log }: { log: RequestLog }) {
  const label = formatSeconds(log.duration_ms);
  const rating = durationRating(log);
  return (
    <span className={`duration-time ${rating.tone}`} title={`总耗时 ${label} · ${rating.basis}`}>
      {label}
    </span>
  );
}

function StatusBadge({ code }: { code: number | null }) {
  if (code === null) return <span className="muted">无响应</span>;
  /* 1xx 和 6xx+ 走 other，和旧版一致。按百位拼类名会造出 status-1xx 这种
     CSS 里不存在的名字，那一格就没颜色了。 */
  if (code >= 200 && code < 300) return <span className="badge on status-2xx">{code}</span>;
  if (code >= 300 && code < 400) return <span className="badge neutral status-3xx">{code}</span>;
  if (code >= 400 && code < 500) return <span className="badge danger status-4xx">{code}</span>;
  if (code >= 500) return <span className="badge danger status-5xx">{code}</span>;
  return <span className="badge neutral status-other">{code}</span>;
}

/** 扫列表要的是量级，2500000 这种长度会挤掉别的列。 */
/* 缩写档位要到 T。只到 M 的话，25 亿 token 会显示成 2500M，还不如不缩。 */
