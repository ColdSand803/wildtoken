import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  animatePresence,
  applyRubberBandBounds,
  createSpringAnimator,
  createVelocityTracker,
  motionReduced,
} from "../motion";

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

/**
 * 当前最上层的模态对话框，没有则 null。
 *
 * showModal 打开的对话框会让它之外的整个文档变成 inert：提示哪怕画在最上面，
 * 点击也会穿过去——点提示上的 ×，落到的是底下抽屉的关闭按钮。所以提示区要
 * 挂进这个对话框里面。
 */
function useTopModalDialog(): HTMLDialogElement | null {
  const [top, setTop] = useState<HTMLDialogElement | null>(null);

  useEffect(() => {
    const update = () => {
      const modals = [...document.querySelectorAll("dialog[open]")].filter((dialog) =>
        dialog.matches(":modal"),
      ) as HTMLDialogElement[];
      setTop(modals.at(-1) ?? null);
    };
    update();

    // 对话框开合只改 open 属性；增删节点也可能带走一个开着的对话框。
    const observer = new MutationObserver(update);
    observer.observe(document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ["open"] });
    return () => observer.disconnect();
  }, []);

  return top;
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);
  const regionRef = useRef<HTMLDivElement>(null);
  const newestId = toasts.at(-1)?.id ?? 0;
  const host = useTopModalDialog();

  /* 抽屉和对话框用 showModal 打开，进的是浏览器顶层，z-index 多大都盖不过。
     提示区也做成 popover 进顶层；每来一条新消息、或换了宿主，就重新弹一次，
     排到当前所有对话框之上——抽屉里保存失败的报错，正是这时候弹出来的。 */
  useEffect(() => {
    const region = regionRef.current;
    if (!region || typeof region.showPopover !== "function") return;
    try {
      if (region.matches(":popover-open")) region.hidePopover();
      if (newestId > 0) region.showPopover();
    } catch {
      // 不支持 popover 时退回普通的 fixed 定位，至少对话框外看得见。
    }
  }, [newestId, host]);

  // 全部消息收起后退出顶层，别留一个空层压在对话框上。
  useEffect(() => {
    const region = regionRef.current;
    if (toasts.length === 0 && region?.matches?.(":popover-open")) region.hidePopover();
  }, [toasts.length]);

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
      {createPortal(
        <div className="toast-region" ref={regionRef} popover="manual" aria-live="polite">
          {toasts.map((toast) => (
            <ToastItem key={toast.id} toast={toast} onDismiss={dismiss} />
          ))}
        </div>,
        host ?? document.body,
      )}
    </ToastContext.Provider>
  );
}

/* onDismiss 收 id 而不是现包一个闭包：闭包每次渲染都是新的，倒计时 effect
   跟着重跑，来一条新消息、切一次页面，已显示的提示就从头计时。 */
function ToastItem({ toast, onDismiss: dismissById }: { toast: Toast; onDismiss: (id: number) => void }) {
  const [paused, setPaused] = useState(false);
  const [busy, setBusy] = useState(false);
  const toastRef = useRef<HTMLDivElement>(null);
  const onDismiss = useCallback(() => dismissById(toast.id), [dismissById, toast.id]);

  useLayoutEffect(() => {
    const el = toastRef.current;
    if (!el) return;
    return animatePresence(el, true, undefined, { axis: "x", offsetPx: 20, scaleFrom: 0.985 });
  }, []);

  /* 悬停时暂停倒计时：正在读的消息不该自己消失。
     paused 变回 false 时重新计时，和旧版的 mouseleave 重启一致。 */
  useEffect(() => {
    if (paused || busy) return;
    const timer = window.setTimeout(onDismiss, toast.durationMs);
    return () => window.clearTimeout(timer);
  }, [paused, busy, toast.durationMs, onDismiss]);

  // 支持横向滑动移除：向右脱手滑出继承速度，向左越过静止边界走橡皮筋阻尼并 ζ = 1 回弹
  useEffect(() => {
    const el = toastRef.current;
    if (!el) return;

    let pointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let displayDx = 0;
    let dismissed = false;
    let exitCancel: (() => void) | null = null;
    const tracker = createVelocityTracker(90, 3200);
    const spring = createSpringAnimator(
      (x) => {
        if (dismissed) return;
        if (Math.abs(x) < 0.2) {
          el.style.transform = "";
          el.style.opacity = "";
        } else {
          el.style.transform = `translateX(${x.toFixed(2)}px)`;
          el.style.opacity = x > 0 ? String(Math.max(0.25, 1 - x / 280)) : "";
        }
      },
      { initial: 0, angularFrequency: 30 },
    );

    const onPointerDown = (event: PointerEvent) => {
      if (motionReduced() || dismissed || event.button !== 0) return;
      if ((event.target as HTMLElement | null)?.closest("button")) return;
      pointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
      displayDx = 0;
      tracker.reset();
      tracker.push(0);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== pointerId || dismissed) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!dragging) {
        if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) {
          pointerId = null;
          return;
        }
        if (Math.abs(dx) < 5) return;
        dragging = true;
        setPaused(true);
        try {
          el.setPointerCapture?.(event.pointerId);
        } catch {}
      }
      displayDx = applyRubberBandBounds(dx, 0, 360, 44, 0.45);
      tracker.push(displayDx);
      spring.set(displayDx, tracker.velocity());
    };

    const finish = (event: PointerEvent, cancelled: boolean) => {
      if (event.pointerId !== pointerId) return;
      pointerId = null;
      if (!dragging) return;
      dragging = false;

      const releaseVel = cancelled ? 0 : tracker.velocity();
      if (!cancelled && displayDx > 16 && (releaseVel > 400 || (displayDx > 88 && releaseVel > -150))) {
        dismissed = true;
        spring.stop();
        el.style.transform = "";
        el.style.opacity = "";
        exitCancel = animatePresence(el, false, onDismiss, {
          axis: "x",
          offsetPx: 260,
          fromOffsetPx: displayDx,
          velocityPxPerSec: releaseVel,
          scaleFrom: 1,
        });
        return;
      }

      setPaused(false);
      spring.to(0, {
        velocity: releaseVel,
        bounds: { min: 0, max: 360, maxOvershoot: 16 },
      });
    };

    const onPointerUp = (event: PointerEvent) => finish(event, false);
    const onPointerCancel = (event: PointerEvent) => finish(event, true);

    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("pointermove", onPointerMove);
    el.addEventListener("pointerup", onPointerUp);
    el.addEventListener("pointercancel", onPointerCancel);
    return () => {
      exitCancel?.();
      spring.destroy();
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("pointermove", onPointerMove);
      el.removeEventListener("pointerup", onPointerUp);
      el.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [onDismiss]);

  const hasAction = Boolean(toast.actionLabel && toast.onAction);

  return (
    <div
      ref={toastRef}
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
  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (pending) {
      if (!dialog.open) dialog.showModal();
      const panel = (dialog.firstElementChild as HTMLElement | null) ?? dialog;
      return animatePresence(panel, true);
    }
    if (dialog.open) dialog.close();
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
