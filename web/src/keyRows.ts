import type { DraftKey, Upstream } from "./types";

/**
 * 表单里的一行 key。
 *
 * id 为 0 是新加的。已保存的 key 不回显，value 留空表示不改；点眼睛取回的
 * 明文记在 revealed 里，提交时没改过就照样发空，明文不必再回传一趟。
 */
export interface KeyRow {
  /** 只在表单里区分行，给 React 当 key 用。 */
  row: number;
  id: number;
  name: string;
  value: string;
  enabled: boolean;
  revealed: string | null;
  coolingSeconds: number;
}

/** 提交给后端的一把 key。 */
export interface KeyPayload {
  id: number;
  name: string;
  api_key: string;
  enabled: boolean;
}

let lastRow = 0;

export function newKeyRow(draft?: DraftKey): KeyRow {
  return {
    row: ++lastRow,
    id: 0,
    name: draft?.name ?? "",
    value: draft?.api_key ?? "",
    enabled: draft?.enabled ?? true,
    revealed: null,
    coolingSeconds: 0,
  };
}

/**
 * 表单打开时的 key 行：有草稿用草稿（复制、快速导入），否则按名称和状态列出
 * 渠道已存的 key。一把都没有时给一行空的，省得先点「添加」。
 */
export function keyRowsFrom(upstream: Upstream | null, drafts?: DraftKey[]): KeyRow[] {
  if (drafts && drafts.length > 0) return drafts.map((draft) => newKeyRow(draft));
  // id 0 的草稿带着别的渠道的 key id，存下去会被后端拒掉。
  const saved = upstream && upstream.id > 0 ? (upstream.keys ?? []) : [];
  if (saved.length === 0) return [newKeyRow()];
  return saved.map((key) => ({
    row: ++lastRow,
    id: key.id,
    name: key.name,
    value: "",
    enabled: key.enabled,
    revealed: null,
    coolingSeconds: key.cooling_seconds ?? 0,
  }));
}

/** 提交用的 keys。没填值的新行丢掉；取回来没改的发空，表示不改。 */
export function keysPayload(rows: KeyRow[]): KeyPayload[] {
  return rows
    .filter((row) => row.id !== 0 || row.value.trim() !== "")
    .map((row) => ({
      id: row.id,
      name: row.name.trim(),
      api_key: row.revealed !== null && row.value === row.revealed ? "" : row.value.trim(),
      enabled: row.enabled,
    }));
}

/**
 * 探上游用哪把：第一把填了值的启用 key；都没填就让服务端用第一把已存的
 * 启用 key（storedKeyId），表单上一把启用的都没有就不带 key。
 */
export function probeKeyOf(rows: KeyRow[]): { apiKey: string | null; storedKeyId: number } {
  const typed = rows.find((row) => row.enabled && row.value.trim() !== "");
  if (typed) return { apiKey: typed.value.trim(), storedKeyId: 0 };
  const saved = rows.find((row) => row.enabled && row.id !== 0);
  return { apiKey: null, storedKeyId: saved?.id ?? 0 };
}
