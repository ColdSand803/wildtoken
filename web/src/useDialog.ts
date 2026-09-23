import { animatePresence } from "./motion";
import { useEffect, useLayoutEffect, useRef } from "react";

/**
 * 原生 <dialog> 的开关加「点遮罩关闭」。
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

  useLayoutEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    const panel = (dialog.firstElementChild as HTMLElement | null) ?? dialog;
    dialog.inert = !open;
    if (open) {
      if (!dialog.open) dialog.showModal();
      return animatePresence(panel, true);
    }
    if (dialog.open) return animatePresence(panel, false, () => dialog.close());
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

  return ref;
}
