import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

export interface MenuItem {
  key: string;
  label: string;
  /** danger 染红，primary 用强调色。 */
  tone?: "danger" | "primary";
  onSelect: () => void;
}

/** 分隔线：把测试类、编辑类、危险动作分开。 */
export const MENU_SEPARATOR = "separator" as const;

export type MenuEntry = MenuItem | typeof MENU_SEPARATOR;

interface Position {
  left: number;
  top: number;
}

/** 视口边缘留这么多，菜单不贴边。 */
const VIEWPORT_GAP = 8;
/** 菜单与触发按钮的间距。 */
const TRIGGER_GAP = 6;

/**
 * 挂在触发按钮上的操作菜单。
 *
 * 定位规则照抄旧控制台：右对齐触发按钮、开在下方，下方放不下就翻到
 * 上方，再夹进视口。锚点 rect 全 0 时关掉而不是画在角落——那种情况是
 * 按钮落进了 display:none 的子树（比如切到卡片视图后表格被隐藏）。
 */
export function ActionMenu({
  trigger,
  entries,
  label,
}: {
  trigger: (props: { ref: React.Ref<HTMLButtonElement>; onClick: () => void; expanded: boolean }) => ReactNode;
  entries: MenuEntry[];
  label: string;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<Position | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const reposition = useCallback(() => {
    const button = triggerRef.current;
    const menu = menuRef.current;
    if (!button || !menu) return;

    const rect = button.getBoundingClientRect();
    // 脱离文档或在隐藏子树里：rect 全 0，按它算会把菜单夹到视口角落。
    if (!button.isConnected || (!rect.width && !rect.height)) {
      setOpen(false);
      return;
    }

    const menuRect = menu.getBoundingClientRect();
    let left = rect.right - menuRect.width;
    let top = rect.bottom + TRIGGER_GAP;

    if (top + menuRect.height > window.innerHeight - VIEWPORT_GAP) {
      top = rect.top - menuRect.height - TRIGGER_GAP;
    }
    left = Math.min(Math.max(VIEWPORT_GAP, left), window.innerWidth - menuRect.width - VIEWPORT_GAP);
    top = Math.min(Math.max(VIEWPORT_GAP, top), window.innerHeight - menuRect.height - VIEWPORT_GAP);
    setPosition({ left: Math.round(left), top: Math.round(top) });
  }, []);

  /* useLayoutEffect 而不是 useEffect：菜单要先量到尺寸才能算位置，
     用 useEffect 会先以 (0,0) 画一帧再跳过去，看得见闪。 */
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open) {
      setPosition(null);
      if (menu?.matches(":popover-open")) menu.hidePopover();
      return;
    }
    /* 必须进顶层（top layer）。祖先 .panel 带了 transform，那会把
       position:fixed 的包含块从视口改成 panel 本身，按视口算的坐标全偏。
       popover 元素不受祖先 transform 影响——旧控制台也是这么做的。 */
    if (menu && !menu.matches(":popover-open")) menu.showPopover();
    reposition();
  }, [open, reposition]);

  useEffect(() => {
    if (!open) return;
    const onScrollOrResize = () => reposition();
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        triggerRef.current?.focus();
      }
    };
    // capture：滚动可能发生在任意祖先容器上，冒泡阶段收不到。
    window.addEventListener("scroll", onScrollOrResize, true);
    window.addEventListener("resize", onScrollOrResize);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("scroll", onScrollOrResize, true);
      window.removeEventListener("resize", onScrollOrResize);
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open, reposition]);

  return (
    <>
      {trigger({ ref: triggerRef, onClick: () => setOpen((value) => !value), expanded: open })}
      {open ? (
        <div
          ref={menuRef}
          /* 类名必须是 upstream-action-menu：它自带 display:grid（竖排）、
             position:fixed 和 168px 宽。写成 .action-menu 会一样式都拿不到，
             菜单会横向铺开并溢出屏幕。 */
          className="upstream-action-menu"
          role="menu"
          aria-label={label}
          popover="manual"
          style={{
            left: position?.left ?? 0,
            top: position?.top ?? 0,
            // 量到尺寸前先藏着，避免定位前那一帧出现在左上角。
            visibility: position ? "visible" : "hidden",
          }}
        >
          {entries.map((entry, index) =>
            entry === MENU_SEPARATOR ? (
              <div key={`sep-${index}`} className="action-menu-separator" role="separator" />
            ) : (
              <button
                key={entry.key}
                type="button"
                role="menuitem"
                className={entry.tone}
                onClick={() => {
                  setOpen(false);
                  entry.onSelect();
                }}
              >
                {entry.label}
              </button>
            ),
          )}
        </div>
      ) : null}
    </>
  );
}
