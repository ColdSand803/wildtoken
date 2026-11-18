import { useEffect, useState } from "react";

import { rotateAdminToken, setAdminToken } from "../../api";
import { useDialog } from "../../useDialog";
import { useFailure } from "../../useFailure";
import { useKeyedActions } from "../../useKeyedActions";
import { useToast } from "../feedback";

const ADMIN_TOKEN_PATTERN = /^[\x21-\x7E]{8,256}$/;

function randomAdminToken(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  while (token.length < 32) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < 248 && token.length < 32) token += alphabet[byte % alphabet.length];
    }
  }
  return token;
}

export function SecuritySettings({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [open, setOpen] = useState(false);
  const [rotatedToken, setRotatedToken] = useState("");
  const { pendingIds, run } = useKeyedActions<"rotate">();
  const toast = useToast();
  const fail = useFailure(onUnauthorized);

  async function rotate(token: string) {
    await run("rotate", async () => {
      try {
        await rotateAdminToken(token);
        setAdminToken(token);
        setRotatedToken(token);
        setOpen(false);
        toast("管理员令牌已更换，当前控制台已改用新令牌。", { tone: "warn", durationMs: 9000 });
      } catch (error) {
        fail(error, { prefix: "更换失败" });
      }
    });
  }

  return (
    <>
      <section className="settings-card settings-security">
        <div className="settings-card-head">
          <div><h3>安全</h3><p>管理员令牌可由你自行设置；更换后旧令牌会立即失效。</p></div>
          <span className="settings-security-mark">敏感操作</span>
        </div>
        <div className="settings-action-row">
          <div><strong>更换管理员令牌</strong><p>保存后当前控制台会自动改用新令牌，新值只显示一次。</p></div>
          <button type="button" className="danger" onClick={() => setOpen(true)}>更换令牌</button>
        </div>
        {rotatedToken ? <label className="field">
          <span className="field-label">新令牌</span><input readOnly value={rotatedToken} />
          <span className="field-hint">这个值不会再显示，现在就存好。</span>
        </label> : null}
      </section>
      <RotateDialog open={open} busy={pendingIds.has("rotate")} onSubmit={(token) => void rotate(token)} onClose={() => setOpen(false)} />
    </>
  );
}

function RotateDialog({ open, busy, onSubmit, onClose }: {
  open: boolean;
  busy: boolean;
  onSubmit: (token: string) => void;
  onClose: () => void;
}) {
  const close = () => { if (!busy) onClose(); };
  const ref = useDialog(open, close);
  const [token, setToken] = useState("");
  const [understood, setUnderstood] = useState(false);
  useEffect(() => { if (open) { setToken(""); setUnderstood(false); } }, [open]);
  const valid = ADMIN_TOKEN_PATTERN.test(token.trim());

  return (
    <dialog className="confirm-dialog" ref={ref} onCancel={(event) => { if (busy) event.preventDefault(); else onClose(); }} aria-label="更换管理员令牌">
      <form className="confirm-panel" onSubmit={(event) => { event.preventDefault(); if (!busy && valid && understood) onSubmit(token.trim()); }}>
        <div className="modal-head"><div>
          <h2>更换管理员令牌</h2><p>保存后旧令牌立即失效，其他已登录的浏览器会被登出，当前控制台自动改用新令牌。</p>
        </div></div>
        <div className="form-grid">
          <label className="field span-2">
            <span className="field-label">新令牌</span>
            <input value={token} onChange={(event) => setToken(event.target.value)} minLength={8} maxLength={256} required
              disabled={busy} spellCheck={false} autoComplete="new-password" placeholder="8–256 位可打印字符，不含空格" />
            <span className="field-hint">保存前先把它存好，之后只会在本页显示一次。</span>
          </label>
          <label className="rotate-confirm-check span-2">
            <input type="checkbox" checked={understood} disabled={busy} onChange={(event) => setUnderstood(event.target.checked)} />
            <span>我了解保存后旧令牌会立即失效。</span>
          </label>
        </div>
        <div className="modal-actions">
          <button type="button" className="secondary" disabled={busy} onClick={() => setToken(randomAdminToken())}>随机生成</button>
          <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button>
          <button type="submit" className="danger" disabled={busy || !valid || !understood}>{busy ? "更换中…" : "保存并更换"}</button>
        </div>
      </form>
    </dialog>
  );
}
