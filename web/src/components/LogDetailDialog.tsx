import { useEffect, useRef } from "react";

import type { RequestLogDetail } from "../types";

/** 四份快照的展示顺序，和旧版一致：先请求后响应，先下游后上游。 */
const SECTIONS = [
  { key: "downstream_request", label: "下游请求" },
  { key: "upstream_request", label: "上游请求" },
  { key: "upstream_response", label: "上游响应" },
  { key: "downstream_response", label: "下游响应" },
] as const;

/** 快照可能被保留策略清空，那时给一句话而不是空白框。 */
function formatSnapshot(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    // 循环引用之类：退回原始形态。
    return String(value);
  }
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
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog className="log-detail-dialog" ref={ref} onCancel={onClose}>
      <div className="log-detail-panel">
        <div className="modal-head log-detail-head">
          <div>
            <h2>请求详情</h2>
            <p>
              {detail
                ? `#${detail.id} · ${detail.method} ${detail.path}`
                : loading
                  ? "加载中…"
                  : ""}
            </p>
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
          </div>
        </div>

        {loading ? (
          <p className="log-detail-summary-state">加载中…</p>
        ) : (
          SECTIONS.map((section) => {
            const text = detail ? formatSnapshot(detail[section.key]) : null;
            return (
              <div key={section.key} className="log-detail-section">
                <div className="log-detail-section-title">
                  <span>{section.label}</span>
                  {text ? (
                    <button
                      type="button"
                      className="secondary ghost log-detail-section-copy"
                      onClick={() => void navigator.clipboard.writeText(text)}
                    >
                      复制
                    </button>
                  ) : null}
                </div>
                {text ? (
                  <pre className="log-detail-code-frame">{text}</pre>
                ) : (
                  /* 保留策略会按条数和体积清空身体，这不是错误。 */
                  <p className="log-detail-summary-state">这条记录没有保存该快照。</p>
                )}
              </div>
            );
          })
        )}
      </div>
    </dialog>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="log-detail-meta-card">
      <span className="field-label">{label}</span>
      <small>{value}</small>
    </div>
  );
}
