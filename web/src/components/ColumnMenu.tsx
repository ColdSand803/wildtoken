import { useEffect, useRef, useState } from "react";

import type { ColumnDef } from "../useColumns";

/** “列”按钮和它的勾选菜单。点菜单外面或按 Esc 收起。 */
export function ColumnMenu<K extends string>({
  label,
  columns,
  visible,
  onToggle,
}: {
  /** 菜单的无障碍名称，例："渠道列显示"。 */
  label: string;
  columns: ReadonlyArray<ColumnDef<K>>;
  visible: Record<K, boolean>;
  onToggle: (key: K) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      wrapRef.current?.querySelector("button")?.focus();
    };

    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="col-menu-wrap" ref={wrapRef}>
      <button
        type="button"
        className="secondary ghost col-menu-btn"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        列
      </button>
      <div className="col-menu" hidden={!open} role="group" aria-label={label}>
        {columns.map((column) => (
          <label key={column.key} className={column.locked ? "is-locked" : undefined}>
            <input
              type="checkbox"
              checked={visible[column.key]}
              disabled={column.locked}
              onChange={() => onToggle(column.key)}
            />
            <span>{column.label + (column.locked ? "（固定）" : "")}</span>
          </label>
        ))}
      </div>
    </div>
  );
}
