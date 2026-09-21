import { useEffect, useRef, useState } from "react";

import {
  normalizeSnapshotBody,
  parseConversationRequest,
  parseConversationResponse,
} from "../conversation";
import type { SnapshotBody } from "../conversation";
import type { RequestLogDetail } from "../types";
import { Conversation } from "./Conversation";

/** 四份快照的展示顺序，和旧版一致：先请求后响应，先下游后上游。 */
const SECTIONS = [
  {
    key: "downstream_request",
    label: "下游完整请求",
    copy: "客户端发给 WildToken 的原始请求。",
    side: "request",
  },
  {
    key: "upstream_request",
    label: "发往渠道的完整请求",
    copy: "转发到渠道前的请求快照。",
    side: "request",
  },
  {
    key: "upstream_response",
    label: "渠道完整响应",
    copy: "渠道返回给 WildToken 的响应。",
    side: "response",
  },
  {
    key: "downstream_response",
    label: "返回下游的完整响应",
    copy: "最终返回给客户端的响应快照。",
    side: "response",
  },
] as const;

type SectionKey = (typeof SECTIONS)[number]["key"];
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

/** 常见状态码的原因短语，只为让首行读起来像 HTTP 报文。 */
const REASON_PHRASES: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

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
    const reason = status === undefined ? undefined : REASON_PHRASES[status];
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

function SnapshotSection({
  section,
  raw,
  mode,
  focused,
  onToggleFocus,
}: {
  section: (typeof SECTIONS)[number];
  raw: unknown;
  mode: ViewMode;
  focused: boolean;
  onToggleFocus: () => void;
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

  return (
    <details
      className={focused ? "log-detail-section is-focused" : "log-detail-section"}
      data-field={section.key}
      open
    >
      <summary>
        <span>
          <span className="log-detail-section-title">{section.label}</span>
          <span className="log-detail-section-copy">{section.copy}</span>
        </span>
        <span className="log-detail-summary-state" aria-hidden="true" />
      </summary>
      <div className="log-detail-code-frame">
        <button
          type="button"
          className="secondary ghost log-detail-expand"
          aria-pressed={focused}
          onClick={onToggleFocus}
        >
          {focused ? "退出放大" : "放大查看"}
        </button>
        {mode === "raw" ? (
          <pre>{formatSnapshot(raw)}</pre>
        ) : (
          <div className="log-conversation">
            <Conversation
              parsed={parsed}
              byteLength={body.kind === "text" || body.kind === "base64" ? body.byteLength : null}
              capturedLength={text ? new TextEncoder().encode(text).length : null}
              truncated={(body.kind === "text" || body.kind === "base64") && body.truncated}
            />
          </div>
        )}
      </div>
    </details>
  );
}

export function LogDetailDialog({
  open,
  detail,
  loading,
  onClose,
}: {
  open: boolean;
  detail: RequestLogDetail | null;
  loading: boolean;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<ViewMode>(readViewMode);
  const [focused, setFocused] = useState<SectionKey | null>(null);
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
    // 关窗清掉放大状态，下次打开不该带着上一条日志的取景。
    if (!open) setFocused(null);
  }, [open]);

  function switchMode(next: ViewMode) {
    setMode(next);
    try {
      localStorage.setItem(VIEW_MODE_KEY, next);
    } catch {
      // 存不进去不影响当前页面。
    }
  }

  return (
    <dialog className="log-detail-dialog" ref={ref} onCancel={onClose}>
      <div className="log-detail-panel">
        <div className="modal-head log-detail-head">
          <div>
            <h2>请求详情</h2>
            <p>{detail ? `#${detail.id} · ${detail.method} ${detail.path}` : loading ? "加载中…" : ""}</p>
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

        <div className="log-detail-meta" aria-live="polite">
          {detail ? (
            <>
              <MetaItem label="渠道" value={detail.upstream_name ?? "-"} />
              <MetaItem label="令牌" value={detail.downstream_token_name ?? "-"} />
              <MetaItem label="客户端" value={detail.client_type} />
              <MetaItem label="模型" value={detail.upstream_model ?? detail.model ?? "-"} />
              <MetaItem
                label="状态码"
                value={detail.status_code === null ? "无响应" : String(detail.status_code)}
              />
              <MetaItem
                label="耗时"
                value={detail.duration_ms === null ? "-" : `${detail.duration_ms}ms`}
              />
              <MetaItem
                label="首字"
                value={detail.first_token_ms === null ? "-" : `${detail.first_token_ms}ms`}
              />
              <MetaItem
                label="Tokens"
                value={`↑${detail.prompt_tokens ?? "-"} ↓${detail.completion_tokens ?? "-"}`}
              />
            </>
          ) : null}
        </div>

        {detail?.error ? (
          <p className="log-detail-summary-state" role="alert">
            {detail.error}
          </p>
        ) : null}

        <div className="log-detail-sections-head">
          <div>
            <h3>请求 / 响应快照</h3>
            <p>会话模式把正文还原成对话；逐字节核对时切到原始模式。</p>
          </div>
          <div className="log-view-mode" role="group" aria-label="查看模式">
            <button
              type="button"
              className="log-view-mode-button"
              data-log-view-mode="conversation"
              aria-pressed={mode === "conversation"}
              onClick={() => switchMode("conversation")}
            >
              会话
            </button>
            <button
              type="button"
              className="log-view-mode-button"
              data-log-view-mode="raw"
              aria-pressed={mode === "raw"}
              onClick={() => switchMode("raw")}
            >
              原始
            </button>
          </div>
        </div>

        {loading ? (
          <p className="log-detail-summary-state">加载中…</p>
        ) : (
          /* 放大时整格换成单栏，未放大的那几节收起——四份快照并排读不了细节。 */
          <div className={focused ? "request-detail-grid is-focused" : "request-detail-grid"}>
            {SECTIONS.map((section) => (
              <SnapshotSection
                key={section.key}
                section={section}
                raw={detail ? detail[section.key] : null}
                mode={mode}
                focused={focused === section.key}
                onToggleFocus={() =>
                  setFocused((current) => (current === section.key ? null : section.key))
                }
              />
            ))}
          </div>
        )}
      </div>
    </dialog>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="log-detail-meta-card">
      <span className="log-detail-meta-label">{label}</span>
      <strong title={value}>{value}</strong>
    </div>
  );
}
