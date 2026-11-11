import { useState } from "react";

import { readStored, writeStored } from "./storage";

export interface ColumnDef<K extends string = string> {
  /** 也是 data-col 的值；隐藏靠表格上的 col-hide-{key} 类。 */
  key: K;
  label: string;
  /** 固定列不给隐藏：藏了行就认不出或点不了。 */
  locked?: boolean;
}

function readVisible<K extends string>(storageKey: string, columns: ReadonlyArray<ColumnDef<K>>): Record<K, boolean> {
  const visible = Object.fromEntries(columns.map((column) => [column.key, true])) as Record<K, boolean>;

  try {
    const stored = JSON.parse(readStored(storageKey) ?? "{}") as Record<string, unknown>;
    for (const column of columns) {
      // 旧存档里固定列可能是 false，读回时强制显示。
      if (!column.locked && stored[column.key] === false) visible[column.key] = false;
    }
  } catch {
    // 内容坏了：全部显示。
  }
  return visible;
}

/** 表格列的显隐，存在 localStorage 里。列定义是唯一来源：表头、菜单、占位行的列数都从它出。 */
export function useColumns<K extends string>(storageKey: string, columns: ReadonlyArray<ColumnDef<K>>) {
  const [visible, setVisible] = useState(() => readVisible(storageKey, columns));

  function toggle(key: K) {
    const next = { ...visible, [key]: !visible[key] };
    setVisible(next);
    writeStored(storageKey, JSON.stringify(next));
  }

  /** 挂到 table 上的类名，例："col-hide-weight col-hide-groups"。 */
  const hiddenClasses = columns.filter((column) => !visible[column.key]).map((column) => `col-hide-${column.key}`);

  return { visible, toggle, hiddenClasses };
}
