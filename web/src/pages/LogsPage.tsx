import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";

import { listLogClientTypes, listLogs } from "../api";
import { clientTypeOptions } from "../clientTypes";
import { ColumnMenu } from "../components/ColumnMenu";
import { LogDetailDialog } from "../components/LogDetailDialog";
import { RetriedMark } from "../components/RetriedMark";
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
import { activeMatchesFilters, logMatchesFilters } from "../logFilter";
import type { LogFilters } from "../logFilter";
import { readStored, writeStored } from "../storage";
import { useColumns } from "../useColumns";
import type { ColumnDef } from "../useColumns";
import { useFailure } from "../useFailure";
import { useLogStream } from "../useLogStream";
import { elapsedMs, formatElapsed, useTicker } from "../useTicker";

type ColumnKey =
  | "time" | "channel" | "token" | "client" | "model" | "reasoning" | "status" | "duration" | "tokens" | "ip" | "detail";

/**
 * 日志表的列，唯一来源：表头、列菜单、占位行的列数都从这里出。
 *
 * 行里的单元格仍是手写的，顺序要和这里一致——在途行和已完成行各有一份，
 * tests/in-flight-requests 逐列对着查。
 */
const COLUMNS: ReadonlyArray<ColumnDef<ColumnKey> & { className?: string }> = [
  { key: "time", label: "时间" },
  { key: "channel", label: "渠道" },
  { key: "token", label: "令牌" },
  { key: "client", label: "客户端" },
  { key: "model", label: "模型" },
  { key: "reasoning", label: "思考强度", className: "col-reasoning" },
  { key: "status", label: "状态码" },
  { key: "duration", label: "响应性能" },
  { key: "tokens", label: "Tokens" },
  { key: "ip", label: "IP" },
  { key: "detail", label: "详情" },
];

const COLUMNS_STORAGE_KEY = "wildtoken_log_columns";
const SENSITIVE_STORAGE_KEY = "wildtoken_log_sensitive_hidden";
const PAGE_SIZES = [20, 50, 100, 200];

/** 思考强度：请求、上游、响应各环节的值，写法和模型列一致。 */
function ReasoningCell({ log }: { log: ReasoningSource }) {
  const chain = reasoningChain(log);
  if (chain.length === 0) return <span className="muted">-</span>;

  const title = chain.map((step) => `${step.label}：${step.value}`).join("；");
  return <RouteChain chain={chain.map((step) => step.value)} title={title} />;
}

/**
 * 路由链：单值平铺，多值用 ↳ 逐级排下去。模型列和思考强度列共用。
 *
 * 例：["fast", "gpt-5.5-mini"] 画成两行，第二行带箭头。
 */
function RouteChain({ chain, title }: { chain: string[]; title: string }) {
  if (chain.length === 1) {
    return (
      <span className="model-text model-single" title={chain[0]}>
        {chain[0]}
      </span>
    );
  }

  const [first, ...rest] = chain;
  return (
    <span className="model-route" title={title}>
      <span className="model-route-line">
        <span className="model-text model-request">{first}</span>
      </span>
      {rest.map((value, index) => (
        <span key={index} className="model-route-line model-route-target">
          <span className="model-route-icon" aria-hidden="true">
            ↳
          </span>
          <span className="model-text model-upstream">{value}</span>
        </span>
      ))}
    </span>
  );
}

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
 *
 * keyName 只有在途行传：跑长流时要看出是哪把 Key 在跑。
 */
function ChannelStack({
  log,
  sensitiveHidden,
  keyName,
}: {
  log: { upstream_id: number | null; upstream_name: string | null };
  sensitiveHidden: boolean;
  keyName?: string;
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
      <ChannelStackName name={name} hidden={hidden} keyName={keyName} />
    </div>
  );
}

/**
 * 下行：有名字就显（该遮就遮），没名字说清楚是没名而不是空着。
 * 带 Key 时接在后面，例："主力 · key-2"。Key 名随渠道名一起遮。
 */
function ChannelStackName({
  name,
  hidden,
  keyName,
}: {
  name: string;
  hidden: boolean;
  keyName?: string;
}) {
  const key = keyName ? (
    <>
      {" · "}
      {hidden ? <Masked /> : keyName}
    </>
  ) : null;

  if (!name) return <span className="muted">无名称{key}</span>;
  if (hidden) {
    return (
      <span className="muted">
        <Masked />
        {key}
      </span>
    );
  }
  return (
    <span className="muted" title={keyName ? `${name} · ${keyName}` : name}>
      {name}
      {key}
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
  // 客户端自己断开，快慢都不是这条请求的问题。
  if (status === 499) {
    return { tone: "neutral", basis: "客户端断开，不算失败" };
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
    return <RouteChain chain={[request || upstream]} title={request || upstream} />;
  }

  return <RouteChain chain={[request, upstream]} title={`请求模型：${request}；上游模型：${upstream}`} />;
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
  /* 渠道按 ID 筛：ID 在列表的渠道格里就写着 #142，抄过来即可，不必先
     记住名字再下拉里找。 */
  const [channelInput, setChannelInput] = useState("");
  const [clientTypes, setClientTypes] = useState<string[]>([]);
  /* 输入框的实时值和真正拿去查的值分开。每敲一下键都发一次查询的话，
     输一个模型名会打出十几次全库扫描。 */
  const [searchInput, setSearchInput] = useState("");
  const [search, setSearch] = useState("");
  const columns = useColumns(COLUMNS_STORAGE_KEY, COLUMNS);
  const [sensitiveHidden, setSensitiveHidden] = useState(() => readStored(SENSITIVE_STORAGE_KEY) === "true");
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
  const fail = useFailure(onUnauthorized);

  /* 每次加载一个序号，只收最新那次的结果。快速切筛选时，先发的请求可能后到，
     把 B 条件下的列表换成 A 的。 */
  const loadRequest = useRef(0);
  /* 最新页覆盖到的 id：不超过它的行要么在这一页，要么本就属于后面的页，挤出
     流也不缺。取加载开始时流里的最新 id：那些行已提交，一定在这次查询的范围
     里；查询发出后才到的可能不在，取完成时的值会把它们算成已覆盖。 */
  const coveredThrough = useRef(0);
  const streamNewest = useRef(0);

  const load = useCallback(
    async (cursor?: { created_at: string; id: number }) => {
      const request = ++loadRequest.current;
      const streamedBefore = streamNewest.current;
      try {
        const loaded = await listLogs({
          limit: pageSize,
          beforeCreatedAt: cursor?.created_at,
          beforeId: cursor?.id,
          search,
          clientType: clientFilter,
          status: statusFilter,
          upstreamId: upstreamFilter,
        });
        if (request !== loadRequest.current) return;
        setPage(loaded);
        if (!cursor) coveredThrough.current = Math.max(streamedBefore, loaded.items[0]?.id ?? 0);
        setError("");
      } catch (err) {
        if (request !== loadRequest.current) return;
        fail(err, { into: setError });
      } finally {
        if (request === loadRequest.current) setLoading(false);
      }
    },
    [fail, pageSize, search, clientFilter, statusFilter, upstreamFilter],
  );

  useEffect(() => {
    void load(cursors.at(-1));
  }, [load, cursors]);

  /* 换了筛选条件就回到第一页。旧游标是按旧条件算出来的，留着会把新结果集
     从一个不属于它的位置截断。

     和筛选值在同一次更新里清。放在 effect 里清的话，筛选一变先带着旧游标发
     一次请求，清完再发一次；前一次晚到，页面写着「第 1 页」却缺最新的行。 */
  const backToLatest = useCallback(() => {
    setCursors((current) => (current.length === 0 ? current : []));
  }, []);

  function applyFilter(set: (value: string) => void, value: string) {
    set(value);
    backToLatest();
  }

  // 400ms 后才落到真正的查询词。
  useEffect(() => {
    if (searchInput === search) return;
    const timer = setTimeout(() => {
      setSearch(searchInput);
      backToLatest();
    }, 400);
    return () => clearTimeout(timer);
  }, [searchInput, search, backToLatest]);

  // 渠道 ID 和搜索框一样等 400ms 再查，敲 142 不会打出三次全库扫描。
  useEffect(() => {
    const value = channelInput.replace(/^0+(?=\d)/, "");
    if (value === upstreamFilter) return;
    const timer = setTimeout(() => {
      setUpstreamFilter(value);
      backToLatest();
    }, 400);
    return () => clearTimeout(timer);
  }, [channelInput, upstreamFilter, backToLatest]);

  // 客户端下拉同理，取库里出现过的全部类型。
  useEffect(() => {
    listLogClientTypes()
      .then(setClientTypes)
      .catch(() => setClientTypes([]));
  }, []);

  const onResync = useCallback(() => {
    if (onLatestPage) void load();
    else setMissedNew(true);
  }, [load, onLatestPage]);

  const stream = useLogStream(true, onResync);

  /* 和 load 用同一组条件：新日志和在途快照都要在前端再筛一次。 */
  const filters = useMemo<LogFilters>(
    () => ({ upstreamId: upstreamFilter, clientType: clientFilter, status: statusFilter, search }),
    [upstreamFilter, clientFilter, statusFilter, search],
  );

  /* 流推来的新行只在最新页合并；翻到旧页时攒着，靠提示条告知。

     只算翻页之后才到的行。拿整个流缓冲来判的话，刚在第 1 页看过的行一翻页
     就被当成新日志，提示条立刻冒出来，回到第 1 页也不消失。 */
  const seenNewestId = useRef(0);
  useEffect(() => {
    if (onLatestPage) {
      for (const log of stream.logs) seenNewestId.current = Math.max(seenNewestId.current, log.id);
      setMissedNew(false);
      return;
    }
    if (stream.logs.some((log) => log.id > seenNewestId.current && logMatchesFilters(log, filters))) {
      setMissedNew(true);
    }
  }, [stream.logs, onLatestPage, filters]);

  /* 流只留最新 200 条。挤出去的行比这一页覆盖到的还新，流和页之间就断了一截，
     表里看不出来：重拉最新页补上。一截只拉一次，流满后每来约 200 条才会再有。 */
  useEffect(() => {
    for (const log of stream.logs) streamNewest.current = Math.max(streamNewest.current, log.id);
  }, [stream.logs]);
  useEffect(() => {
    if (!onLatestPage || stream.evictedNewestId <= coveredThrough.current) return;
    coveredThrough.current = stream.evictedNewestId;
    void load();
  }, [stream.evictedNewestId, onLatestPage, load]);

  const merged = useMemo(() => {
    const seen = new Set<number>();
    const merged: RequestLog[] = [];
    const streamed = onLatestPage ? stream.logs.filter((log) => logMatchesFilters(log, filters)) : [];
    for (const log of [...streamed, ...(page?.items ?? [])]) {
      if (seen.has(log.id)) continue;
      seen.add(log.id);
      merged.push(log);
    }
    /* id 就是写入顺序。流里的行不一定都比这一页新：断线重连补拉后，页里有
       的比流里攒着的还新，直接拼在前面顺序就乱了。 */
    return merged.sort((a, b) => b.id - a.id);
  }, [stream.logs, page?.items, onLatestPage, filters]);

  /* 最新页也只显示「每页」那么多行。流推来的新行把旧行挤到下一页，而不是让
     表格一直长下去：每页 20 时，不截的话进来 60 条就成了 80 行。 */
  const logs = useMemo(() => merged.slice(0, pageSize), [merged, pageSize]);
  const hasMore = Boolean(page?.has_more) || merged.length > logs.length;

  const clientOptions = useMemo(
    () =>
      clientTypeOptions(
        clientTypes,
        [...stream.logs, ...(page?.items ?? [])].map((log) => log.client_type),
        clientFilter,
      ),
    [clientTypes, stream.logs, page?.items, clientFilter],
  );

  /* 在途集合：只在最新页显示。流连着就以它为准，断了退回快照里的那份。 */
  const activeFromPage = page?.active ?? [];
  const activeLatest = stream.connected ? stream.active : activeFromPage;
  const active = onLatestPage
    ? activeLatest.filter((request) => activeMatchesFilters(request, filters))
    : [];
  const activeTotal = stream.connected ? stream.activeTotal : (page?.active_total ?? 0);

  function toggleSensitive() {
    const next = !sensitiveHidden;
    setSensitiveHidden(next);
    writeStored(SENSITIVE_STORAGE_KEY, String(next));
  }

  // 引用稳定：行组件是 memo 的，每次渲染换一个函数等于没 memo。
  const openDetail = useCallback((log: RequestLog) => {
    setDetail(log);
  }, []);

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
            <input
              type="text"
              inputMode="numeric"
              autoComplete="off"
              placeholder="渠道 ID"
              aria-label="按渠道 ID 筛选日志"
              value={channelInput}
              // 粘进来的 #142 也认：只留数字。
              onChange={(event) => setChannelInput(event.target.value.replace(/\D/g, ""))}
            />
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
              onChange={(event) => applyFilter(setClientFilter, event.target.value)}
            >
              <option value="">全部客户端</option>
              {clientOptions.clients.map((type) => (
                <option key={type} value={type}>
                  {type}
                </option>
              ))}
              {clientOptions.probes.length > 0 ? (
                <optgroup label="控制台探测">
                  {clientOptions.probes.map((type) => (
                    <option key={type} value={type}>
                      {type}
                    </option>
                  ))}
                </optgroup>
              ) : null}
            </select>
          </label>
          <label className="log-filter">
            <select
              aria-label="按状态码筛选日志"
              value={statusFilter}
              onChange={(event) => applyFilter(setStatusFilter, event.target.value)}
            >
              <option value="">全部状态</option>
              <option value="2xx">2xx</option>
              <option value="4xx">4xx</option>
              <option value="5xx">5xx</option>
              <option value="none">无响应</option>
            </select>
          </label>

          <ColumnMenu label="日志列显示" columns={COLUMNS} visible={columns.visible} onToggle={columns.toggle} />

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
          <p className="field-hint field-hint-error" role="alert">
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
          <table className={["admin-table", "log-table", ...columns.hiddenClasses].join(" ")}>
            <thead>
              <tr>
                {COLUMNS.map((column) => (
                  <th key={column.key} className={column.className} data-col={column.key}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <ActiveRows active={active} snapshot={activeLatest} sensitiveHidden={sensitiveHidden} />
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
              disabled={!hasMore}
              onClick={() => {
                // 取屏幕上的最后一行，不是查询结果的最后一行：截断后两者不一定相同。
                const last = logs.at(-1);
                if (!last) return;
                // 新页到之前 page 还是这一页，连点会把同一个游标压两次，页号和数据错开一页。
                setCursors((stack) =>
                  stack.at(-1)?.id === last.id ? stack : [...stack, { created_at: last.created_at, id: last.id }],
                );
              }}
            >
              下一页
            </button>
          </div>
        </div>
      </section>

      <LogDetailDialog open={detail !== null} log={detail} onClose={() => setDetail(null)} />
    </section>
  );
}

/* 占位行要横跨整表。写死字面量的话，加一列就会忘了改——加 IP 列时
   就漏了，加载态和空态都短一列。 */
export const LOG_TABLE_COLUMN_COUNT = COLUMNS.length;

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

/** 没配 Key 的渠道是 0；有 id 没名字时退回 #id。 */
function activeKeyName(request: ActiveRequest): string | undefined {
  if (!request.upstream_key_id) return undefined;
  return request.upstream_key_name || `#${request.upstream_key_id}`;
}

function ActiveRows({
  active,
  snapshot,
  sensitiveHidden,
}: {
  active: ActiveRequest[];
  snapshot: ActiveRequest[];
  sensitiveHidden: boolean;
}) {
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  /* 计时跟原始快照走，切筛选不重置。elapsed_ms 变了说明重试等状态已更新，
     基准时间也要随新快照更新。 */
  const signature = snapshot.map((request) => `${request.id}:${request.elapsed_ms}`).join(",");

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
              <ChannelStack
                log={request}
                sensitiveHidden={sensitiveHidden}
                keyName={activeKeyName(request)}
              />
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
            {request.client_ip ? (
              <span className="log-ip" title={request.client_ip}>
                {request.client_ip}
              </span>
            ) : (
              <span className="muted">-</span>
            )}
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
        <LogRow key={log.id} log={log} sensitiveHidden={sensitiveHidden} onOpenDetail={onOpenDetail} />
      ))}
    </>
  );
}

/* memo：流每 80ms 推一批，没变的行不必跟着重渲染。 */
const LogRow = memo(function LogRow({
  log,
  sensitiveHidden,
  onOpenDetail,
}: {
  log: RequestLog;
  sensitiveHidden: boolean;
  onOpenDetail: (log: RequestLog) => void;
}) {
  return (
    /* 整行可点。tabIndex 让它能被键盘达到，回车和空格等同点击。 */
    <tr
      className="log-row"
      title={log.error || "点击查看请求详情"}
      data-log-id={log.id}
      tabIndex={0}
      onClick={() => onOpenDetail(log)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpenDetail(log);
      }}
    >
      <td className="time-cell" data-col="time">
        <span>{formatTimestamp(log.created_at)}</span>
        <span className="muted">#{log.id}</span>
      </td>
      <td className="channel-cell" data-col="channel">
        <ChannelStack log={log} sensitiveHidden={sensitiveHidden} />
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
        {log.retried ? <RetriedMark /> : null}
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
        {log.client_ip ? (
          <span className="log-ip" title={log.client_ip}>
            {log.client_ip}
          </span>
        ) : (
          <span className="muted">-</span>
        )}
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
});

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
  // 499 是客户端自己断开，不是失败，不标红。
  if (code === 499) return <span className="badge neutral status-4xx">{code}</span>;
  if (code >= 400 && code < 500) return <span className="badge danger status-4xx">{code}</span>;
  if (code >= 500) return <span className="badge danger status-5xx">{code}</span>;
  return <span className="badge neutral status-other">{code}</span>;
}
