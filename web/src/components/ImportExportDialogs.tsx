import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { useDialog } from "../useDialog";
import { useQuickImport } from "../useQuickImport";
import { QuickImportActions, QuickImportContent } from "./QuickImportContent";
import { copyText } from "../clipboard";

import type { ChannelExportDocument, ImportResult } from "../types";

export { parseQuickImport } from "../quickImport";

/** 导出文档的固定头。导入时靠它拒掉不相干的 JSON。 */
export const CHANNEL_DOCUMENT_KIND = "wildtoken.channels";
export const CHANNEL_DOCUMENT_VERSION = 1;
/** 一次导入的条数上限，和后端一致。 */
const MAX_IMPORT_ENTRIES = 500;

/** 导入导出共用头部、滚动正文和固定底栏。 */
function TransferDialog({
  open,
  title,
  description,
  onClose,
  children,
  actions,
  className = "",
  initialFocus = "textarea",
  onCancel,
}: {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
  className?: string;
  initialFocus?: string;
  onCancel?: () => void;
}) {
  const ref = useDialog(open, onClose);

  // 初始焦点留给文本框，打开后可直接粘贴。
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>(initialFocus)?.focus();
  }, [open, initialFocus]);

  return (
    <dialog className={["quick-import-dialog dialog--drawer", className].filter(Boolean).join(" ")} ref={ref}
      onCancel={(event) => { if (onCancel) { event.preventDefault(); onCancel(); } else onClose(); }} aria-label={title}>
      <div className="quick-import-panel">
        <div className="modal-head upstream-modal-head">
          <div>
            <h2>{title}</h2>
            <p>{description}</p>
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
        <div className="upstream-dialog-body">{children}</div>
        <div className="modal-footer">{actions}</div>
      </div>
    </dialog>
  );
}

export function ChannelExportDialog({
  open,
  document: doc,
  includeKeys,
  onToggleKeys,
  onClose,
}: {
  open: boolean;
  document: ChannelExportDocument | null;
  includeKeys: boolean;
  onToggleKeys: (next: boolean) => void;
  onClose: () => void;
}) {
  const json = doc ? JSON.stringify(doc, null, 2) : "";

  return (
    <TransferDialog
      open={open}
      title="导出渠道"
      description={
        doc
          ? `${doc.channels.length} 个渠道。导出为 JSON，包含模型、映射、优先级、权重与 Header 覆盖。`
          : "准备中…"
      }
      onClose={onClose}
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            关闭
          </button>
          {/* 文档没到之前没有可给的东西：空文件或者上一份文档都不对。 */}
          <button
            type="button"
            className="secondary"
            disabled={!doc}
            onClick={() => void copyText(json)}
          >
            复制
          </button>
          <button
            className="primary"
            type="button"
            disabled={!doc}
            onClick={() => {
              /* Blob + 临时链接下载。用 data: URL 在大文档上会被浏览器拦。 */
              const blob = new Blob([json], { type: "application/json" });
              const url = URL.createObjectURL(blob);
              const link = window.document.createElement("a");
              link.href = url;
              link.download = `wildtoken-channels-${new Date().toISOString().slice(0, 10)}.json`;
              link.click();
              URL.revokeObjectURL(url);
            }}
          >
            下载
          </button>
        </>
      }
    >
      {/* 默认带密钥。不带密钥的备份看着完整，导回去每个渠道都要重填。 */}
      <div className="toggle-list">
        <label className="toggle-row">
          <input
            type="checkbox"
            checked={includeKeys}
            onChange={(event) => onToggleKeys(event.target.checked)}
          />
          <span>
            <strong>包含 API Key</strong>
            <small>取消后导出文件不含密钥；用它覆盖导入时会保留目标渠道已有的密钥。</small>
          </span>
        </label>
      </div>

      <textarea readOnly rows={14} value={json} aria-label="导出的渠道 JSON" />
    </TransferDialog>
  );
}

export function ChannelImportDialog({
  open,
  busy,
  result,
  onImport,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  result: ImportResult | null;
  onImport: (document: ChannelExportDocument, mode: "skip" | "overwrite") => void;
  onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [mode, setMode] = useState<"skip" | "overwrite">("skip");
  const [parseError, setParseError] = useState("");

  useEffect(() => {
    if (!open) return;
    setText("");
    setParseError("");
  }, [open]);

  /** 解析并校验。错在这一步就不发请求——后端的错误信息没有这里具体。 */
  function parse(): ChannelExportDocument | null {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      setParseError("不是合法的 JSON。");
      return null;
    }
    // 粘进来的可能是 null、数组或字符串：读 null.kind 会抛错，按钮点了没反应。
    const doc = parsed as Partial<ChannelExportDocument> | null;
    if (!doc || typeof doc !== "object" || doc.kind !== CHANNEL_DOCUMENT_KIND) {
      setParseError(`这不是渠道导出文件（kind 应为 ${CHANNEL_DOCUMENT_KIND}）。`);
      return null;
    }
    if (!Array.isArray(doc.channels) || doc.channels.length === 0) {
      setParseError("文档里没有渠道。");
      return null;
    }
    if (doc.channels.length > MAX_IMPORT_ENTRIES) {
      setParseError(`一次最多导入 ${MAX_IMPORT_ENTRIES} 个渠道，当前 ${doc.channels.length} 个。`);
      return null;
    }
    // 名字和地址是最少要有的；其余字段缺了由后端按新建渠道的默认值补。
    const incomplete = doc.channels.findIndex(
      (channel: unknown) =>
        !channel ||
        typeof channel !== "object" ||
        typeof (channel as { name?: unknown }).name !== "string" ||
        typeof (channel as { base_url?: unknown }).base_url !== "string",
    );
    if (incomplete !== -1) {
      setParseError(`第 ${incomplete + 1} 个渠道缺少 name 或 base_url。`);
      return null;
    }
    setParseError("");
    return {
      kind: CHANNEL_DOCUMENT_KIND,
      version: doc.version ?? CHANNEL_DOCUMENT_VERSION,
      channels: doc.channels,
    };
  }

  return (
    <TransferDialog
      open={open}
      title="导入渠道"
      description="粘贴导出的 JSON，或选择文件。"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            关闭
          </button>
          <button
            className="primary"
            type="button"
            disabled={busy || text.trim() === ""}
            onClick={() => {
              const doc = parse();
              if (doc) onImport(doc, mode);
            }}
          >
            {busy ? "导入中…" : "导入"}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">选择文件</span>
        <input
          type="file"
          accept="application/json,.json"
          onChange={async (event) => {
            const file = event.target.files?.[0];
            if (!file) return;
            setText(await file.text());
            setParseError("");
          }}
        />
      </label>

      <label className="field">
        <span className="field-label">JSON</span>
        <textarea
          rows={10}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setParseError("");
          }}
          placeholder={`{"kind":"${CHANNEL_DOCUMENT_KIND}","version":1,"channels":[…]}`}
        />
      </label>

      <label className="field">
        <span className="field-label">重名时</span>
        <select value={mode} onChange={(event) => setMode(event.target.value as "skip" | "overwrite")}>
          <option value="skip">跳过</option>
          <option value="overwrite">覆盖</option>
        </select>
      </label>

      {parseError ? (
        <p className="field-hint" role="alert" style={{ color: "var(--danger)" }}>
          {parseError}
        </p>
      ) : null}

      {result ? (
        <div className="channel-transfer-summary">
          <p>
            新建 {result.created} · 更新 {result.updated} · 跳过 {result.skipped} · 失败{" "}
            {result.failed}
          </p>
          {result.failed > 0 ? (
            <ul>
              {result.items
                .filter((item) => item.action === "failed")
                .map((item, index) => (
                  // 文档里可以有同名渠道，名字当 key 会撞。
                  <li key={`${index}-${item.name}`}>
                    {item.name}：{item.message ?? "未知原因"}
                  </li>
                ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </TransferDialog>
  );
}

export function QuickImportDialog({
  open,
  onSubmit,
  onClose,
  onUnauthorized,
}: {
  open: boolean;
  /** 只把识别到的值交回调用方填进表单，不发创建请求，所以没有 busy 态。 */
  onSubmit: (name: string, baseUrl: string, apiKey: string | null, modelNames: string[]) => void;
  onClose: () => void;
  onUnauthorized: (message: string) => void;
}) {
  const editor = useQuickImport({ open, onSubmit, onClose, onUnauthorized });
  return (
    <TransferDialog
      open={open}
      title="快速导入渠道"
      description="识别连接信息，填入一条新增草稿。不直接创建渠道。"
      className={["quick-import-recognition", editor.view === "models" && "qi-is-models"].filter(Boolean).join(" ")}
      initialFocus={editor.initialFocus}
      onClose={editor.close}
      onCancel={editor.cancel}
      actions={<QuickImportActions editor={editor} />}
    >
      <QuickImportContent editor={editor} />
    </TransferDialog>
  );
}
