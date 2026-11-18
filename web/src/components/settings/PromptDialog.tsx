import { useEffect, useState } from "react";

import type { PromptTemplate } from "../../types";
import { useDialog } from "../../useDialog";

export function PromptDialog({ open, template, busy, onSubmit, onClose }: {
  open: boolean;
  template: PromptTemplate | null;
  busy: boolean;
  onSubmit: (name: string, prompt: string) => void;
  onClose: () => void;
}) {
  const close = () => { if (!busy) onClose(); };
  const ref = useDialog(open, close);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? "");
    setPrompt(template?.prompt ?? "");
  }, [open, template]);

  return (
    <dialog className="confirm-dialog" ref={ref} onCancel={(event) => { if (busy) event.preventDefault(); else onClose(); }} aria-label="Prompt 模板">
      <form className="confirm-panel" onSubmit={(event) => {
        event.preventDefault();
        if (!busy && name.trim() && prompt.trim()) onSubmit(name.trim(), prompt.trim());
      }}>
        <div className="modal-head">
          <div><h2>{template ? `编辑 Prompt #${template.id}` : "新增 Prompt"}</h2><p>测试窗口会从这些模板中选择。</p></div>
          <div className="modal-head-actions">
            <button type="button" className="secondary ghost icon-close" aria-label="关闭" title="关闭" disabled={busy} onClick={close}>
              <svg className="dialog-icon dialog-icon--close" viewBox="0 0 16 16" aria-hidden="true"><path d="M4 4l8 8M12 4L4 12" /></svg>
            </button>
          </div>
        </div>
        <div className="form-grid">
          <label className="field span-2">
            <span className="field-label">Prompt 名称</span>
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={80} required
              placeholder="例如：代码审查" autoComplete="off" disabled={busy} />
          </label>
          <label className="field span-2">
            <span className="field-label">Prompt 内容</span>
            <textarea rows={8} maxLength={20000} required value={prompt} disabled={busy} onChange={(event) => setPrompt(event.target.value)} />
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button>
          <button type="submit" className="primary" disabled={busy || !name.trim() || !prompt.trim()}>
            {busy ? "保存中…" : "保存 Prompt"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
