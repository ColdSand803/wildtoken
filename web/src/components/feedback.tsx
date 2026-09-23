import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";

export type ToastTone = "neutral" | "ok" | "error" | "warn";

export interface ToastOptions {
  tone?: ToastTone;
  /** 不给就按 tone 取默认值。 */
  durationMs?: number;
  /** 带一个动作按钮，例如删除后的「撤销」。 */
  actionLabel?: string;
  onAction?: () => void | Promise<void>;
}

interface Toast extends ToastOptions {
  id: number;
  message: string;
  tone: ToastTone;
  durationMs: number;
}

/* 和旧控制台一致：错误留久一点，成功次之，普通消息最短。 */
function defaultDuration(tone: ToastTone): number {
  if (tone === "error") return 6000;
  if (tone === "ok") return 4000;
  return 3000;
}

/** 同时最多 4 条，多了从最旧的开始挤掉。 */
const MAX_TOASTS = 4;

type ShowToast = (message: string, options?: ToastOptions) => void;

const ToastContext = createContext<ShowToast | null>(null);

/** 在任意组件里发消息。旧控制台里这个叫 setStatus。 */
export function useToast(): ShowToast {
  const show = useContext(ToastContext);
  if (!show) throw new Error("useToast 必须在 ToastProvider 内使用");
  return show;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const dismiss = useCallback((id: number) => {
    setToasts((list) => list.filter((toast) => toast.id !== id));
  }, []);

  const show = useCallback<ShowToast>((message, options = {}) => {
    const tone = options.tone ?? "neutral";
    setToasts((list) => {
      const toast: Toast = {
        ...options,
        id: nextId.current++,
        message,
        tone,
        durationMs: options.durationMs ?? defaultDuration(tone),
      };
      return [...list, toast].slice(-MAX_TOASTS);
    });
  }, []);

  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="toast-region" aria-live="polite">
        {toasts.map((toast) => (
          <ToastItem key={toast.id} toast={toast} onDismiss={() => dismiss(toast.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  );
}

function ToastItem({ toast, onDismiss }: { toast: Toast; onDismiss: () => void }) {
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);

  /* 悬停时暂停倒计时：正在读的消息不该自己消失。
     paused 变回 false 时重新计时，和旧版的 mouseleave 重启一致。 */
  useEffect(() => {
    if (paused || busy) return;
    const timer = window.setTimeout(onDismiss, toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [paused, busy, toast.durationMs, onDismiss]);

  const hasAction = Boolean(toast.actionLabel && toast.onAction);

  return (
    <div
      className={`toast${hasAction ? " has-action" : ""}`}
      data-tone={toast.tone}
      role={toast.tone === "error" ? "alert" : "status"}
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      <div className="toast-message">{toast.message}</div>
      {hasAction ? (
        <button
          type="button"
          className="toast-action"
          disabled={busy}
          onClick={async () => {
            // 动作跑完才收起，否则撤销还没发出去消息就没了。
            setBusy(true);
            try {
              await toast.onAction?.();
            } finally {
              onDismiss();
            }
          }}
        >
          {toast.actionLabel}
        </button>
      ) : null}
      <button type="button" className="toast-close" aria-label="关闭消息" title="关闭" onClick={onDismiss}>
        ×
      </button>
    </div>
  );
}

export interface ConfirmOptions {
  title?: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** 危险操作把确认按钮染成红色。删除类默认就是。 */
  danger?: boolean;
}

type RequestConfirm = (options?: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<RequestConfirm | null>(null);

/** 返回一个 Promise<boolean>，和旧控制台的 requestConfirm 同形。 */
export function useConfirm(): RequestConfirm {
  const confirm = useContext(ConfirmContext);
  if (!confirm) throw new Error("useConfirm 必须在 ConfirmProvider 内使用");
  return confirm;
}

interface PendingConfirm extends Required<ConfirmOptions> {
  resolve: (value: boolean) => void;
}

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [pending, setPending] = useState<PendingConfirm | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);

  const confirm = useCallback<RequestConfirm>(
    (options = {}) =>
      new Promise<boolean>((resolve) => {
        setPending({
          title: options.title ?? "确认操作",
          message: options.message ?? "",
          confirmLabel: options.confirmLabel ?? "删除",
          cancelLabel: options.cancelLabel ?? "取消",
          danger: options.danger ?? true,
          resolve,
        });
      }),
    [],
  );

  // showModal 才有焦点陷阱和 Esc 关闭，setAttribute("open") 没有。
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending && !dialog.open) dialog.showModal();
    else if (!pending && dialog.open) dialog.close();
  }, [pending]);

  const settle = useCallback((value: boolean) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  const value = useMemo(() => confirm, [confirm]);

  return (
    <ConfirmContext.Provider value={value}>
      {children}
      <dialog className="confirm-dialog" ref={dialogRef} onCancel={() => settle(false)}>
        {pending ? (
          <div className="confirm-panel">
            <div className="modal-head">
              <div>
                <h2>{pending.title}</h2>
                {pending.message ? <p>{pending.message}</p> : null}
              </div>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary" onClick={() => settle(false)}>
                {pending.cancelLabel}
              </button>
              <button
                type="button"
                className={pending.danger ? "danger" : undefined}
                onClick={() => settle(true)}
              >
                {pending.confirmLabel}
              </button>
            </div>
          </div>
        ) : null}
      </dialog>
    </ConfirmContext.Provider>
  );
}
