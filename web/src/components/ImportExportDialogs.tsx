import { CHANNEL_DOCUMENT_KIND, parseChannelImportDocument } from "../channelTransfer";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";

import { useDialog } from "../useDialog";
import { copyText } from "../clipboard";

import type { ChannelExportDocument, ImportResult } from "../types";

/** 导出文档的固定头。导入时靠它拒掉不相干的 JSON。 */
export { CHANNEL_DOCUMENT_KIND, CHANNEL_DOCUMENT_VERSION } from "../channelTransfer";

/** 一次导入的条数上限，和后端一致。 */


/** 导入导出共用头部、滚动正文和固定底栏。 */
function TransferDialog({
  open,
  title,
  description,
  onClose,
  children,
  actions,
}: {
  open: boolean;
  title: string;
  description: string;
  onClose: () => void;
  children: ReactNode;
  actions: ReactNode;
}) {
  const ref = useDialog(open, onClose);

  // 初始焦点留给文本框，打开后可直接粘贴。
  useEffect(() => {
    if (open) ref.current?.querySelector("textarea")?.focus();
  }, [open]);

  return (
    <dialog className="quick-import-dialog dialog--drawer" ref={ref} onCancel={onClose} aria-label={title}>
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
          <button
            type="button"
            className="secondary"
            onClick={() => void copyText(json)}
          >
            复制
          </button>
          <button
            className="primary"
            type="button"
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
    try { const doc = parseChannelImportDocument(text); setParseError(""); return doc; }
    catch (error) { setParseError(error instanceof Error ? error.message : String(error)); return null; }
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
                .map((item) => (
                  <li key={item.name}>
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

/**
 * 快速导入：从一段乱文本里认出 Base URL 和 Key。
 *
 * 解析规则照抄旧版——sk- 开头取最长的那个；URL 按含 /v1 和 api 打分，
 * 取分最高的再退回 origin。
 */
export function parseQuickImport(text: string): { baseUrl: string | null; apiKey: string | null } {
  const keys = text.match(/sk-[a-zA-Z0-9_-]{16,}/g) ?? [];
  const apiKey = [...keys].sort((a, b) => b.length - a.length)[0] ?? null;

  const urls = (text.match(/https?:\/\/[^\s"'<>()[\]“”，、；]+/g) ?? [])
    .map((url) => url.replace(/[.,;:)\]}"'，。；、]+$/, ""))
    .filter(Boolean);

  const score = (url: string) => {
    const lower = url.toLowerCase();
    return (lower.includes("/v1") ? 2 : 0) + (lower.includes("api") ? 1 : 0);
  };

  let baseUrl: string | null = null;
  if (urls.length > 0) {
    const best = [...urls].sort((a, b) => score(b) - score(a))[0];
    try {
      baseUrl = new URL(best).origin;
    } catch {
      // 认不出来就让用户自己填。
      baseUrl = null;
    }
  }
  return { baseUrl, apiKey };
}

export function QuickImportDialog({
  open,
  busy,
  onSubmit,
  onClose,
}: {
  open: boolean;
  busy: boolean;
  onSubmit: (name: string, baseUrl: string, apiKey: string | null) => void;
  onClose: () => void;
}) {
  const [raw, setRaw] = useState("");
  const [name, setName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");

  useEffect(() => {
    if (!open) return;
    setRaw("");
    setName("");
    setBaseUrl("");
    setApiKey("");
  }, [open]);

  /** 从 URL 猜个名字，省得每次手打。 */
  function suggestName(url: string): string {
    try {
      return new URL(url).hostname.split(".").slice(0, -1).join("-") || "";
    } catch {
      return "";
    }
  }

  return (
    <TransferDialog
      open={open}
      title="快速导入"
      description="粘贴一段包含 Base URL 和 API Key 的文本，自动识别。"
      onClose={onClose}
      actions={
        <>
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button
            className="primary"
            type="button"
            disabled={busy || !name.trim() || !baseUrl.trim()}
            onClick={() => onSubmit(name.trim(), baseUrl.trim(), apiKey.trim() || null)}
          >
            {busy ? "创建中…" : "创建渠道"}
          </button>
        </>
      }
    >
      <label className="field">
        <span className="field-label">原始文本</span>
        <textarea
          rows={5}
          value={raw}
          placeholder="https://api.example.com/v1  sk-xxxxxxxxxxxxxxxx"
          onChange={(event) => {
            const next = event.target.value;
            setRaw(next);
            const parsed = parseQuickImport(next);
            if (parsed.baseUrl) {
              setBaseUrl(parsed.baseUrl);
              if (!name) setName(suggestName(parsed.baseUrl));
            }
            if (parsed.apiKey) setApiKey(parsed.apiKey);
          }}
        />
      </label>

      <label className="field">
        <span className="field-label">名称</span>
        <input value={name} onChange={(event) => setName(event.target.value)} autoComplete="off" />
      </label>

      <label className="field">
        <span className="field-label">Base URL</span>
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          autoComplete="off"
        />
      </label>

      <label className="field">
        <span className="field-label">API Key</span>
        <input
          type="password"
          value={apiKey}
          onChange={(event) => setApiKey(event.target.value)}
          autoComplete="off"
        />
      </label>
    </TransferDialog>
  );
}
