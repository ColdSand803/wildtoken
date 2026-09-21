import { useEffect, useRef, useState } from "react";

import { setAdminToken } from "../api";

/**
 * 管理员令牌登录框。
 *
 * 类名照抄旧控制台的 admin-token-dialog / admin-token-panel / login-brand，
 * 主题 CSS 里这些名字带着整套观感。
 */
export function AdminTokenDialog({
  open,
  error,
  onClose,
  onSubmitted,
}: {
  open: boolean;
  error: string;
  onClose: () => void;
  onSubmitted: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  // showModal 而不是 hidden：原生 dialog 自带焦点陷阱和 Esc 关闭。
  useEffect(() => {
    const dialog = inputRef.current?.closest("dialog");
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
      inputRef.current?.focus();
    } else if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);

  return (
    <dialog className="admin-token-dialog" onCancel={onClose}>
      <form
        className="admin-token-panel"
        onSubmit={(event) => {
          event.preventDefault();
          const token = value.trim();
          if (!token) return;
          setAdminToken(token);
          setValue("");
          onSubmitted();
        }}
      >
        <div className="login-brand" aria-hidden="true">
          <span className="login-mark">
            <BrandMark />
          </span>
        </div>
        <div className="modal-head">
          <div>
            <h2>管理员登录</h2>
            <p>输入 Admin Token 进入控制台。</p>
          </div>
        </div>
        <label className="field">
          <span className="field-label">Admin Token</span>
          <input
            ref={inputRef}
            type="password"
            autoComplete="off"
            value={value}
            aria-label="Admin Token"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {/* 旧版把错误塞在一个 id 的 span 里。这里直接渲染——同一份信息，
            少一个 DOM 契约。 */}
        {error ? (
          <p className="field-hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}
        <div className="modal-actions">
          <button type="submit">进入</button>
        </div>
      </form>
    </dialog>
  );
}

function BrandMark() {
  return (
    <svg width="36" height="36" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <rect width="64" height="64" rx="14" fill="currentColor" />
      <path
        d="M32 14v18M32 32l15 10M32 32L17 42"
        stroke="var(--brand-ink)"
        strokeWidth="4"
        strokeLinecap="round"
      />
      <circle cx="32" cy="14" r="4.5" fill="var(--brand-ink)" />
      <circle cx="47" cy="42" r="4.5" fill="var(--brand-ink)" />
      <circle cx="17" cy="42" r="4.5" fill="var(--brand-ink)" />
      <circle cx="32" cy="32" r="7" fill="var(--brand-ink)" />
      <circle cx="32" cy="32" r="3" fill="currentColor" />
    </svg>
  );
}
