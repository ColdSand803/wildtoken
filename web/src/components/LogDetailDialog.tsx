import { LogTiming, RetryChain } from "./LogTiming";
import { formatFailureStage } from "../logTiming";
import { useEffect, useState } from "react";
import type { KeyboardEvent } from "react";

import { UnauthorizedError, getLogSnapshot } from "../api";
import {
  normalizeSnapshotBody,
  parseConversationRequest,
  parseConversationResponse,
} from "../conversation";
import type { SnapshotBody } from "../conversation";
import {
  formatDuration,
  formatExactCount,
  formatRelativeTime,
  formatShare,
  formatStatus,
  formatTimestamp,
  outputSpeed,
  reasonPhrase,
} from "../logFormat";
import {
  EMPTY_SNAPSHOTS,
  SNAPSHOT_SECTIONS,
  snapshotsFor,
  withSnapshot,
} from "../logSnapshots";
import type { SnapshotCache, SnapshotSection, SnapshotState } from "../logSnapshots";
import { reasoningChain } from "../reasoningChain";
import type { LogSnapshotField, RequestLog } from "../types";
import { Conversation } from "./Conversation";
import { useDialog } from "../useDialog";

type TabKey = "meta" | LogSnapshotField;
type ViewMode = "conversation" | "raw";

/* 查看模式跨会话保留。隐私模式下 storage 会直接抛，所以读写都包起来。 */
const VIEW_MODE_KEY = "wildtoken.logViewMode";

function readViewMode(): ViewMode {
  try {
    return localStorage.getItem(VIEW_MODE_KEY) === "raw" ? "raw" : "conversation";
  } catch {
    return "conversation";
  }
}

function prettyBody(text: string): string {
  const clean = String(text || "");
  const trimmed = clean.trim();
  if (!trimmed) return "<empty body>";
  try {
    return JSON.stringify(JSON.parse(trimmed), null, 2);
  } catch {
    return clean;
  }
}

type Snapshot = Record<string, unknown>;

/** 正文文本；拿不到文本的形态一律给空串。 */
function bodyText(body: SnapshotBody): string {
  return body.kind === "text" ? body.text : "";
}

/** 按 HTTP 报文排版，照抄旧版 formatHttpSnapshot。 */
function formatSnapshot(raw: unknown): string {
  if (!raw || typeof raw !== "object") {
    return "未记录\n\n这条历史日志没有保存这一项请求或响应详情。";
  }
  const snapshot = raw as Snapshot;

  // 保留策略可能把整个快照换成 { cleared: true }。
  if (snapshot.cleared && !snapshot.method && snapshot.status_code == null && snapshot.status == null) {
    return "日志正文已按保留策略清理，仅保留元数据。请查看较新的日志以获得完整请求/响应。";
  }

  const headers: Record<string, string> = { ...((snapshot.headers ?? {}) as Record<string, string>) };
  let firstLine: string;

  if (snapshot.method) {
    let target = (snapshot.url as string) || "/";
    try {
      const url = new URL(snapshot.url as string);
      target = `${url.pathname || "/"}${url.search}`;
      headers.host = url.host;
    } catch {
      // 老日志的 URL 可能不是绝对地址，原样保留。
    }
    firstLine = `${String(snapshot.method)} ${target} HTTP/1.1`;
  } else {
    const status = (snapshot.status_code ?? snapshot.status) as number | undefined;
    const reason = status === undefined ? undefined : reasonPhrase(status);
    firstLine = `HTTP/1.1 ${status ?? "-"}${reason ? ` ${reason}` : ""}`;
  }

  const lines = [firstLine];
  for (const [name, value] of Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`${name}: ${value}`);
  }
  lines.push("");

  const body = normalizeSnapshotBody(snapshot.body);
  if (body.kind === "cleared") {
    lines.push("[Body cleared by retention policy]");
  } else if (body.kind === "base64") {
    lines.push(`[Binary body encoded as base64; ${body.byteLength ?? 0} bytes captured]`);
    lines.push(body.base64);
  } else if (body.kind === "text") {
    lines.push(prettyBody(body.text));
  }
  // missing 和 empty 都是「报文头之后什么都没有」，不额外说话。

  if ((body.kind === "text" || body.kind === "base64") && body.truncated) {
    lines.push("");
    lines.push(`[Body truncated; original length: ${body.byteLength ?? "unknown"} bytes]`);
  }
  return lines.join("\n");
}

function SnapshotBodyView({
  section,
  raw,
  mode,
}: {
  section: SnapshotSection;
  raw: unknown;
  mode: ViewMode;
}) {
  const snapshot = raw && typeof raw === "object" ? (raw as Snapshot) : null;
  const body = normalizeSnapshotBody(snapshot?.body);
  const text = bodyText(body);
  const parsed =
    mode === "conversation" && text
      ? section.side === "request"
        ? parseConversationRequest(text)
        : parseConversationResponse(text)
      : null;

  if (mode === "raw") {
    return <pre>{formatSnapshot(raw)}</pre>;
  }
  return (
    <div className="log-conversation">
      <Conversation
        parsed={parsed}
        byteLength={body.kind === "text" || body.kind === "base64" ? body.byteLength : null}
        capturedLength={text ? new TextEncoder().encode(text).length : null}
        truncated={(body.kind === "text" || body.kind === "base64") && body.truncated}
      />
    </div>
  );
}

function SnapshotPanel({
  section,
  state,
  mode,
  onSwitchMode,
  onRetry,
}: {
  section: SnapshotSection;
  state: SnapshotState | undefined;
  mode: ViewMode;
  onSwitchMode: (next: ViewMode) => void;
  onRetry: () => void;
}) {
  return (
    <div
      className="log-detail-tabpanel"
      role="tabpanel"
      id={`log-detail-panel-${section.key}`}
      aria-labelledby={`log-detail-tab-${section.key}`}
      data-field={section.key}
    >
      <div className="log-detail-panel-head">
        <p>{section.copy}</p>
        <div className="log-view-mode" role="group" aria-label="查看模式">
          <button
            type="button"
            className="log-view-mode-button"
            data-log-view-mode="conversation"
            aria-pressed={mode === "conversation"}
            onClick={() => onSwitchMode("conversation")}
          >
            会话
          </button>
          <button
            type="button"
            className="log-view-mode-button"
            data-log-view-mode="raw"
            aria-pressed={mode === "raw"}
            onClick={() => onSwitchMode("raw")}
          >
            原始
          </button>
        </div>
      </div>

      {!state || state.status === "loading" ? (
        <p className="log-detail-state" aria-live="polite">
          加载中…
        </p>
      ) : state.status === "error" ? (
        <p className="log-detail-state is-error" role="alert">
          {state.message}
          <button type="button" className="secondary ghost" onClick={onRetry}>
            重试
          </button>
        </p>
      ) : (
        <div className="log-detail-code-frame">
          <SnapshotBodyView section={section} raw={state.raw} mode={mode} />
        </div>
      )}
    </div>
  );
}

export function LogDetailDialog({
  open,
  log,
  logs = [],
  onSelect,
  onClose,
}: {
  open: boolean;
  log: RequestLog | null;
  logs?: RequestLog[];
  onSelect?: (log: RequestLog) => void;
  onClose: () => void;
}) {
  const logId = log?.id ?? null;
  const [mode, setMode] = useState<ViewMode>(readViewMode);
  /* 页签选择绑在日志 id 上：换一条日志就回到元信息，不用等 effect 跑一轮，
     也就不会用上一条的页签给新日志多发一次请求。 */
  const [selection, setSelection] = useState<{ id: number | null; tab: TabKey }>({
    id: null,
    tab: "meta",
  });
  const tab: TabKey = selection.id === logId ? selection.tab : "meta";
  const [cache, setCache] = useState<SnapshotCache>(EMPTY_SNAPSHOTS);
  const snapshots = snapshotsFor(cache, logId);
  const ref = useDialog(open, onClose);

  // 关窗回到元信息。重开同一条也从头看起，缓存留着，报文不用再拉。
  useEffect(() => {
    if (!open) setSelection({ id: null, tab: "meta" });
  }, [open]);

  function load(id: number, field: LogSnapshotField) {
    setCache((current) => withSnapshot(current, id, field, { status: "loading" }));
    getLogSnapshot(id, field)
      .then((raw) => {
        setCache((current) => withSnapshot(current, id, field, { status: "ready", raw }));
      })
      .catch((err: unknown) => {
        // 401 由 App 统一接住弹登录框；这里只把加载态撤掉，登录后重开再拉。
        if (err instanceof UnauthorizedError) {
          setCache((current) => (current.id === id ? EMPTY_SNAPSHOTS : current));
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        setCache((current) => withSnapshot(current, id, field, { status: "error", message }));
      });
  }

  // 点到哪份报文才拉哪份。已经在拉或拉过的不重复请求。
  const pendingField: LogSnapshotField | null =
    open && logId !== null && tab !== "meta" && !snapshots[tab] ? tab : null;
  useEffect(() => {
    if (pendingField === null || logId === null) return;
    load(logId, pendingField);
  }, [pendingField, logId]);

  function switchMode(next: ViewMode) {
    setMode(next);
    try {
      localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      // 存不进去不影响当前页面。
    }
  }

  function selectTab(next: TabKey) {
    setSelection({ id: logId, tab: next });
  }

  const tabs: Array<{ key: TabKey; label: string }> = [
    { key: "meta", label: "元信息" },
    ...SNAPSHOT_SECTIONS.map((section) => ({ key: section.key, label: section.label })),
  ];

  /* 左右方向键在页签间移动并切换，符合 tablist 的键盘约定。 */
  function onTabsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = tabs.findIndex((item) => item.key === tab);
    const step = event.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(index + step + tabs.length) % tabs.length];
    selectTab(next.key);
    event.currentTarget
      .querySelector<HTMLButtonElement>(`[data-log-tab="${next.key}"]`)
      ?.focus();
  }

  const section = SNAPSHOT_SECTIONS.find((item) => item.key === tab);

  return (
    <dialog className="log-detail-dialog dialog--drawer" ref={ref} onCancel={onClose}>
      <div className="log-detail-panel">
        <div className="modal-head upstream-modal-head log-detail-head">
          <div>
            <h2>请求详情</h2>
            <p>{log ? `#${log.id} · ${log.method} ${log.path}` : ""}</p>
          </div>
          <div className="modal-head-actions">
            <button
              type="button"
              className="secondary ghost icon-close"
              aria-label="关闭"
              title="关闭"
              onClick={onClose}
            >
              <svg className="dialog-icon dialog-icon--close" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4L4 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="upstream-dialog-body">
          <div
            className="log-detail-tabs"
            role="tablist"
            aria-label="请求详情"
            onKeyDown={onTabsKeyDown}
          >
            {tabs.map((item) => (
              <button
                key={item.key}
                type="button"
                className="log-detail-tab"
                role="tab"
                id={`log-detail-tab-${item.key}`}
                aria-selected={tab === item.key}
                aria-controls={`log-detail-panel-${item.key}`}
                tabIndex={tab === item.key ? 0 : -1}
                data-log-tab={item.key}
                onClick={() => selectTab(item.key)}
              >
                {item.label}
              </button>
            ))}
          </div>

          {section ? (
            <SnapshotPanel
              key={section.key}
              section={section}
              state={snapshots[section.key]}
              mode={mode}
              onSwitchMode={switchMode}
              onRetry={() => logId !== null && load(logId, section.key)}
            />
          ) : (
            <div
              className="log-detail-tabpanel log-detail-tabpanel--meta"
              role="tabpanel"
              id="log-detail-panel-meta"
              aria-labelledby="log-detail-tab-meta"
            >
              {log ? <><MetaPanel log={log} /><LogTiming log={log} /><RetryChain log={log} logs={logs} onSelect={onSelect} /></> : null}
            </div>
          )}
        </div>
      </div>
    </dialog>
  );
}

function MetaPanel({ log }: { log: RequestLog }) {
  return (
    <>
      <div className="log-detail-meta">
        {metaRows(log).map((row) => (
          <MetaItem key={row.label} label={row.label} value={row.value} />
        ))}
      </div>

      {log.error ? (
        <p className="log-detail-state is-error" role="alert">
          {log.error}
        </p>
      ) : null}
    </>
  );
}

/**
 * 元信息表的行。
 *
 * 顺序按排查时的问法走：什么时候、谁发的、发去哪里、结果如何、花了多少。
 * 可选行（缓存、思考 token、强度链、速度）没值就不出现——没记录的东西摆一排
 * 破折号只会把真正有用的行挤下去。
 */
function metaRows(log: RequestLog): Array<{ label: string; value: string }> {
  const rows: Array<{ label: string; value: string }> = [];
  const push = (label: string, value: string | null) => {
    if (value !== null && value !== "") rows.push({ label, value });
  };

  const relative = formatRelativeTime(log.created_at);
  push("时间", `${formatTimestamp(log.created_at)}${relative ? `（${relative}）` : ""}`);
  push("请求", `${log.method} ${log.path}`);
  push("客户端", log.client_type);
  push("来源 IP", log.client_ip ?? "-");
  push("令牌", log.downstream_token_name ?? "-");
  push("渠道", log.upstream_name ?? "-");
  push("模型", modelChain(log));

  for (const step of reasoningChain(log)) push(step.label, step.value);

  push("传输方式", log.stream ? "流式" : "一次性返回");
  push("状态", formatStatus(log.status_code));
  push("总耗时", formatDuration(log.duration_ms));
  push("首字延迟", formatDuration(log.first_token_ms));
  push("请求 UID", log.request_uid);
  if (log.attempt_index != null) push("尝试序号", String(log.attempt_index));
  if (log.failure_stage) push("失败阶段", formatFailureStage(log.failure_stage));
  if (log.failure_retryable != null) push("失败可重试", log.failure_retryable ? "是" : "否");
  push("输出速度", outputSpeed(log.completion_tokens, log.duration_ms, log.first_token_ms));

  push("输入 tokens", formatExactCount(log.prompt_tokens));

  // 缓存命中单看绝对值没意义，要知道它占输入的多少。
  if (log.prompt_cached_tokens !== null) {
    const share = formatShare(log.prompt_cached_tokens, log.prompt_tokens);
    push(
      "└ 缓存命中",
      `${formatExactCount(log.prompt_cached_tokens)}${share ? `（占 ${share}）` : ""}`,
    );
  }
  if (log.cache_creation_tokens !== null) {
    push("└ 缓存写入", formatExactCount(log.cache_creation_tokens));
  }

  push("输出 tokens", formatExactCount(log.completion_tokens));
  if (log.completion_reasoning_tokens !== null) {
    push("└ 思考", formatExactCount(log.completion_reasoning_tokens));
  }
  push("合计 tokens", formatExactCount(log.total_tokens));

  return rows;
}

/**
 * 模型链：客户端要的 → 路由选的 → 实际发给上游的。
 *
 * 三者一致时只显示一个；不一致说明中间做了映射，那正是排查「怎么跑到另一个
 * 模型上去了」时要看的东西。相邻去重不跨步，避免藏掉来回改写。
 */
function modelChain(log: RequestLog): string {
  const steps = [log.request_model, log.model, log.upstream_model]
    .map((value) => (value ?? "").trim())
    .filter(Boolean);

  const chain: string[] = [];
  for (const step of steps) {
    if (chain.length > 0 && chain[chain.length - 1] === step) continue;
    chain.push(step);
  }
  return chain.length > 0 ? chain.join(" → ") : "-";
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="log-detail-meta-card">
      <span className="log-detail-meta-label">{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}
