import {
  animatePresence,
  applyRubberBandBounds,
  createSpringAnimator,
  createVelocityTracker,
  motionReduced,
} from "./motion";
import type { PresenceSpringOptions } from "./motion";
import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * 原生 <dialog> 的开关、「点遮罩关闭」与抽屉手势拖拽/越界回弹。
 *
 * 用 showModal 而不是 open 属性：前者自带焦点陷阱和 Esc。十二个对话框原先
 * 各写一遍同样的 effect，现在收在这里。
 *
 * 点遮罩关闭要求 pointerdown 和 click 都落在 dialog 元素自身上。只看 click
 * 的话，从框内拖选文本、松手时落在框外，会被当成点了遮罩——正在填的表单
 * 就这么没了。
 */
export function useDialog(open: boolean, onClose?: () => void) {
  const ref = useRef<HTMLDialogElement>(null);
  const exitHandOffRef = useRef<{ fromOffsetPx: number; velocityPxPerSec: number } | null>(null);

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const panel = (dialog.firstElementChild as HTMLElement | null) ?? dialog;
    const isDrawer = dialog.classList.contains("dialog--drawer");
    dialog.inert = !open;
    if (open) {
      exitHandOffRef.current = null;
      if (!dialog.open) dialog.showModal();
      const enterOptions: PresenceSpringOptions = isDrawer
        ? { axis: "x", offsetPx: 32, scaleFrom: 1 }
        : { axis: "y", offsetPx: -6, scaleFrom: 0.985 };
      return animatePresence(panel, true, undefined, enterOptions);
    }
    if (dialog.open) {
      const handOff = exitHandOffRef.current;
      exitHandOffRef.current = null;
      const exitOptions: PresenceSpringOptions = isDrawer
        ? {
            axis: "x",
            offsetPx: Math.max(48, Math.round((dialog.offsetWidth || 360) * 0.35)),
            scaleFrom: 1,
            fromOffsetPx: handOff?.fromOffsetPx,
            velocityPxPerSec: handOff?.velocityPxPerSec,
          }
        : { axis: "y", offsetPx: -6, scaleFrom: 0.985 };
      return animatePresence(panel, false, () => dialog.close(), exitOptions);
    }
  }, [open]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog || !onClose) return;

    let beganOnBackdrop = false;
    const onPointerDown = (event: PointerEvent) => {
      beganOnBackdrop = event.button === 0 && event.target === dialog;
    };
    const onPointerCancel = () => {
      beganOnBackdrop = false;
    };
    const onClick = (event: MouseEvent) => {
      const dismiss = beganOnBackdrop && event.target === dialog;
      beganOnBackdrop = false;
      if (dismiss) onClose();
    };

    dialog.addEventListener("pointerdown", onPointerDown);
    dialog.addEventListener("pointercancel", onPointerCancel);
    dialog.addEventListener("click", onClick);
    return () => {
      dialog.removeEventListener("pointerdown", onPointerDown);
      dialog.removeEventListener("pointercancel", onPointerCancel);
      dialog.removeEventListener("click", onClick);
    };
  }, [onClose]);

  // 右侧抽屉标题栏支持水平拖拽收起：向右带脱手速度收起，向左拉过打开边界走橡皮筋阻尼并 ζ = 1 回弹
  useEffect(() => {
    const dialog = ref.current;
    if (!open || !dialog || !onClose || !dialog.classList.contains("dialog--drawer")) return;
    const panel = (dialog.firstElementChild as HTMLElement | null) ?? dialog;

    let activePointerId: number | null = null;
    let startX = 0;
    let startY = 0;
    let dragging = false;
    let displayDx = 0;
    const tracker = createVelocityTracker(90, 3600);
    const rebound = createSpringAnimator(
      (x) => {
        if (Math.abs(x) < 0.25) {
          panel.style.transform = "";
        } else {
          panel.style.transform = `translateX(${x.toFixed(2)}px)`;
        }
      },
      { initial: 0, angularFrequency: 28, restDelta: 0.25, restSpeed: 2 },
    );

    const onHeadPointerDown = (event: PointerEvent) => {
      if (motionReduced() || event.button !== 0) return;
      const target = event.target as HTMLElement | null;
      if (!target?.closest(".modal-head")) return;
      if (target.closest("button, input, select, textarea, a, [role='button']")) return;
      activePointerId = event.pointerId;
      startX = event.clientX;
      startY = event.clientY;
      dragging = false;
      displayDx = 0;
      tracker.reset();
      tracker.push(0);
    };

    const onPointerMove = (event: PointerEvent) => {
      if (event.pointerId !== activePointerId) return;
      const rawDx = event.clientX - startX;
      const rawDy = event.clientY - startY;

      if (!dragging) {
        if (Math.abs(rawDy) > 8 && Math.abs(rawDy) > Math.abs(rawDx)) {
          activePointerId = null;
          return;
        }
        if (Math.abs(rawDx) < 6 || Math.abs(rawDx) <= Math.abs(rawDy) * 1.2) return;
        dragging = true;
        try {
          dialog.setPointerCapture?.(event.pointerId);
        } catch {}
      }

      const maxRight = Math.max(240, dialog.offsetWidth || 480);
      displayDx = applyRubberBandBounds(rawDx, 0, maxRight, 56, 0.45);
      tracker.push(displayDx);
      rebound.set(displayDx, tracker.velocity());
    };

    const finishGesture = (event: PointerEvent, cancelled: boolean) => {
      if (event.pointerId !== activePointerId) return;
      activePointerId = null;
      if (!dragging) return;
      dragging = false;

      const releaseVelocity = cancelled ? 0 : tracker.velocity();
      const drawerWidth = Math.max(240, dialog.offsetWidth || 480);
      const shouldDismiss =
        !cancelled &&
        displayDx > 16 &&
        (releaseVelocity > 480 || (displayDx > drawerWidth * 0.26 && releaseVelocity > -180));

      if (shouldDismiss) {
        exitHandOffRef.current = { fromOffsetPx: displayDx, velocityPxPerSec: releaseVelocity };
        rebound.stop();
        panel.style.transform = "";
        onClose();
        return;
      }

      rebound.to(0, {
        velocity: releaseVelocity,
        bounds: { min: 0, max: drawerWidth, maxOvershoot: 22 },
      });
    };

    const onPointerUp = (event: PointerEvent) => finishGesture(event, false);
    const onCancel = (event: PointerEvent) => finishGesture(event, true);

    dialog.addEventListener("pointerdown", onHeadPointerDown);
    dialog.addEventListener("pointermove", onPointerMove);
    dialog.addEventListener("pointerup", onPointerUp);
    dialog.addEventListener("pointercancel", onCancel);
    return () => {
      rebound.destroy();
      panel.style.transform = "";
      dialog.removeEventListener("pointerdown", onHeadPointerDown);
      dialog.removeEventListener("pointermove", onPointerMove);
      dialog.removeEventListener("pointerup", onPointerUp);
      dialog.removeEventListener("pointercancel", onCancel);
    };
  }, [open, onClose]);

  return ref;
}
