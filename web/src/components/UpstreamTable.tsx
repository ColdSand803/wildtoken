import { useState } from "react";
import type { ReactNode } from "react";

import { copyText } from "../clipboard";
import type { Upstream } from "../types";
import type { SortKey } from "../upstreamSort";
import type { ColumnDef } from "../useColumns";
import { ActionMenu } from "./ActionMenu";
import type { MenuEntry } from "./ActionMenu";
import { useToast } from "./feedback";

export type UpstreamColumnKey =
  | "check" | "id" | "name" | "models" | "groups" | "priority" | "weight" | "status" | "actions";

type UpstreamColumn = ColumnDef<UpstreamColumnKey> & { sortKey?: SortKey; className?: string };

/** 渠道表的列，唯一来源：表头、列菜单、占位行的列数都从这里出。 */
export const UPSTREAM_COLUMNS: ReadonlyArray<UpstreamColumn> = [
  { key: "check", label: "选择", locked: true, className: "col-check" },
  { key: "id", label: "ID", locked: true, sortKey: "id", className: "col-id" },
  { key: "name", label: "渠道名", locked: true, sortKey: "name" },
  { key: "models", label: "模型匹配" },
  { key: "groups", label: "分组" },
  { key: "priority", label: "优先级", sortKey: "priority", className: "col-priority" },
  { key: "weight", label: "权重", className: "col-weight" },
  { key: "status", label: "状态", sortKey: "status", className: "col-status" },
  { key: "actions", label: "操作", locked: true, className: "col-actions" },
];

type Sort = { key: SortKey; desc: boolean };

/** 渠道列表。行内的优先级编辑态归它自己管，提交时才上报。 */
export function UpstreamTable({
  rows,
  groups,
  loading,
  emptyText,
  hiddenClasses,
  pendingId,
  selected,
  onSelect,
  sort,
  onSort,
  menuFor,
  renderDiagnostics,
  onPriority,
  onToggle,
}: {
  rows: Upstream[];
  groups: Array<{ id: number; name: string }>;
  loading: boolean;
  emptyText: string;
  hiddenClasses: string[];
  /** 正在请求中的渠道，它的行内操作暂时禁用。 */
  pendingId: number | null;
  selected: ReadonlySet<number>;
  onSelect: (next: Set<number>) => void;
  sort: Sort;
  onSort: (next: Sort) => void;
  menuFor: (upstream: Upstream) => MenuEntry[];
  renderDiagnostics?: (upstream: Upstream) => ReactNode;
  onPriority: (upstream: Upstream, raw: string) => void;
  onToggle: (upstream: Upstream) => void;
}) {
  const [editingPriority, setEditingPriority] = useState<number | null>(null);
  const allSelected = rows.length > 0 && rows.every((upstream) => selected.has(upstream.id));

  function check(id: number, next: boolean) {
    const copy = new Set(selected);
    if (next) copy.add(id);
    else copy.delete(id);
    onSelect(copy);
  }

  return (
    <div className="table-wrap">
      {/* 列显隐靠表格上的 col-hide-{key} 类，CSS 负责藏对应的 td/th。 */}
      <table className={["admin-table", "upstream-table", ...hiddenClasses].join(" ")}>
        <thead>
          <tr>
            {UPSTREAM_COLUMNS.map((column) => {
              if (column.key === "check") {
                return (
                  <th key={column.key} className={column.className} data-col={column.key}>
                    <input
                      type="checkbox"
                      aria-label="全选当前筛选渠道"
                      checked={allSelected}
                      onChange={(event) => onSelect(event.target.checked ? new Set(rows.map((u) => u.id)) : new Set())}
                    />
                  </th>
                );
              }
              if (column.sortKey) {
                return (
                  <SortableHeader
                    key={column.key}
                    label={column.label}
                    sortKey={column.sortKey}
                    col={column.key}
                    className={column.className}
                    sort={sort}
                    onSort={onSort}
                  />
                );
              }
              return (
                <th key={column.key} className={column.className} data-col={column.key}>
                  {column.label}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {loading || rows.length === 0 ? (
            <tr>
              <td colSpan={UPSTREAM_COLUMNS.length} className="muted">
                {loading ? "加载中…" : emptyText}
              </td>
            </tr>
          ) : (
            rows.map((upstream) => (
              <UpstreamRow
                key={upstream.id}
                upstream={upstream}
                groups={groups}
                busy={pendingId === upstream.id}
                menu={menuFor(upstream)}
                diagnostics={renderDiagnostics?.(upstream)}
                checked={selected.has(upstream.id)}
                onCheck={(next) => check(upstream.id, next)}
                editingPriority={editingPriority === upstream.id}
                onPriorityEdit={() => setEditingPriority(upstream.id)}
                onPriorityCommit={(raw) => {
                  setEditingPriority(null);
                  onPriority(upstream, raw);
                }}
                onPriorityCancel={() => setEditingPriority(null)}
                onToggle={() => onToggle(upstream)}
              />
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** 归档区的表：没有表头，只有 ID、名称、状态和操作。 */
export function ArchivedTable({
  rows,
  pendingId,
  menuFor,
}: {
  rows: Upstream[];
  pendingId: number | null;
  menuFor: (upstream: Upstream) => MenuEntry[];
}) {
  return (
    <div className="table-wrap">
      <table className="admin-table upstream-table">
        <tbody>
          {rows.map((upstream) => (
            <tr key={upstream.id} className="row-archived">
              <td className="col-id">{upstream.id}</td>
              <td className="name-cell">
                <div className="name-stack">
                  <strong title={upstream.name}>{upstream.name}</strong>
                  <span className="url-cell-inner">{upstream.base_url}</span>
                </div>
              </td>
              <td className="col-status">
                <span className="archived-tag">
                  <span className="archived-tag-dot" aria-hidden="true" />
                  已归档
                </span>
              </td>
              <td className="row-actions col-actions">
                <RowMenu upstream={upstream} entries={menuFor(upstream)} disabled={pendingId === upstream.id} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** 行尾的 ⋮ 菜单。 */
function RowMenu({ upstream, entries, disabled }: { upstream: Upstream; entries: MenuEntry[]; disabled: boolean }) {
  return (
    <ActionMenu
      label={`${upstream.name} 的操作菜单`}
      entries={entries}
      trigger={({ ref, onClick, expanded }) => (
        <button
          ref={ref}
          type="button"
          className="secondary action-menu-trigger"
          aria-haspopup="menu"
          aria-expanded={expanded}
          aria-label={`打开 ${upstream.name} 的操作菜单`}
          title="操作"
          disabled={disabled}
          onClick={onClick}
        >
          <span aria-hidden="true">⋮</span>
        </button>
      )}
    />
  );
}

/**
 * 可排序表头。
 *
 * aria-sort 和箭头跟着当前排序状态走，类名照抄旧版的 table-sort-button。
 * 点同一列翻转方向，点别的列从降序开始。
 */
function SortableHeader({
  label,
  sortKey,
  col,
  className,
  sort,
  onSort,
}: {
  label: string;
  sortKey: SortKey;
  col: string;
  className?: string;
  sort: { key: SortKey; desc: boolean };
  onSort: (next: { key: SortKey; desc: boolean }) => void;
}) {
  const activeSort = sort.key === sortKey;
  return (
    <th
      className={className}
      data-col={col}
      aria-sort={activeSort ? (sort.desc ? "descending" : "ascending") : "none"}
    >
      <button
        type="button"
        className="table-sort-button"
        onClick={() => onSort({ key: sortKey, desc: activeSort ? !sort.desc : true })}
      >
        {label} <span aria-hidden="true">{activeSort ? (sort.desc ? "↓" : "↑") : ""}</span>
      </button>
    </th>
  );
}

/**
 * 只放行 http(s)。
 *
 * base_url 是管理员填的，不校就把一个 javascript: 开头的值变成了可点击的
 * 脚本执行入口。照抄旧版 normalizeHttpUrl。
 */
function httpUrlOrNull(value: string): string | null {
  const raw = String(value || "").trim();
  if (!raw) return null;
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

/**
 * Base URL 格。
 *
 * 旧版是 code 加两个按钮：复制、在新标签打开。只渲染纯文本的话，想拿地址
 * 去试一下得自己选中拷贝，而这一格宽度有限、地址常常被截。
 */
function BaseUrlCell({ upstream }: { upstream: Upstream }) {
  const toast = useToast();
  const openable = httpUrlOrNull(upstream.base_url);

  async function copy() {
    try {
      await copyText(upstream.base_url);
      toast("Base URL 已复制。", { tone: "ok" });
    } catch {
      toast("复制失败：浏览器拒绝了剪贴板访问。", { tone: "error" });
    }
  }

  return (
    <div className="url-cell-inner">
      <code title={upstream.base_url}>{upstream.base_url}</code>
      <span className="url-cell-actions" aria-label="Base URL 操作">
        <button
          type="button"
          className="secondary ghost url-action"
          aria-label={`复制 ${upstream.name} 的 Base URL`}
          title="复制 Base URL"
          onClick={() => void copy()}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <rect x="9" y="9" width="10" height="10" rx="2" />
            <path d="M5 15V7a2 2 0 0 1 2-2h8" />
          </svg>
        </button>
        <button
          type="button"
          className="secondary ghost url-action"
          aria-label={`打开 ${upstream.name} 的 Base URL`}
          title={openable ? "打开 Base URL" : "不是可打开的 http(s) 地址"}
          disabled={openable === null}
          onClick={() => {
            /* 只放行 http/https：httpUrlOrNull 已经过一道，这里再卡一道协议，
               不让任何非白名单协议的地址进新标签。 */
            const url = httpUrlOrNull(upstream.base_url);
            if (!url || !/^https?:\/\//i.test(url)) return;
            window.open(url, "_blank", "noopener,noreferrer");
          }}
        >
          <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
            <path d="M14 5h5v5" />
            <path d="M10 14 19 5" />
            <path d="M19 14v3a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h3" />
          </svg>
        </button>
      </span>
    </div>
  );
}

/** 有效权重为 0 的原因。自动权重降到 0 时还要说清楚还有多久恢复。 */
function zeroWeightNote(upstream: Upstream): string {
  if (!upstream.auto_weight_enabled) return "固定权重 0 · 不参与路由";
  if (Number(upstream.weight) === 0) return "基础权重 0 · 不参与动态路由";
  const remaining = upstream.health_recovery_remaining_seconds;
  return remaining ? `有效权重 0 · ${remaining}s 后恢复` : "有效权重 0 · 等待恢复周期";
}

/** 整数不带小数点，非整数保留两位再去尾零。照抄旧版 formatEffectiveWeight。 */
function formatWeight(value: number): string {
  const number = Number(value);
  if (!Number.isFinite(number)) return "0";
  return Number.isInteger(number)
    ? String(number)
    : number.toFixed(2).replace(/0+$/, "").replace(/\.$/, "");
}

/** 只显示前几个，剩下的折成 +N；全量在 title 里。3 个加 +N 最多占两行，行高不被芯片撑开。 */
const MAX_MODEL_CHIPS = 3;

type Chip = { label: string; type: string };

/** 芯片列表。容器是 div 不是 span，全量标签放 title，和旧版 modelChipList 一致。 */
function ChipList({ items }: { items: Chip[] }) {
  const visible = items.slice(0, MAX_MODEL_CHIPS);
  const hiddenCount = items.length - visible.length;
  return (
    <div className="model-chip-list" title={items.map((item) => item.label).join(", ")}>
      {visible.map((item, index) => (
        <span key={`${item.type}-${item.label}-${index}`} className={`model-chip ${item.type}`}>
          {item.label}
        </span>
      ))}
      {hiddenCount > 0 ? <span className="model-chip more">{`+${hiddenCount}`}</span> : null}
    </div>
  );
}

/** 映射在前、精确名在中、前缀在后，顺序照抄旧版 modelMatchItems。 */
function modelMatchItems(upstream: Upstream): Chip[] {
  return [
    ...Object.entries(upstream.model_mappings || {}).map(([downstream, target]) => ({
      label: `${downstream}=>${target}`,
      type: "mapping",
    })),
    ...upstream.model_names.map((value) => ({ label: value, type: "name" })),
    ...upstream.model_prefixes.map((value) => ({ label: `${value}*`, type: "prefix" })),
  ];
}

function UpstreamRow({
  upstream,
  diagnostics,
  groups,
  busy,
  menu,
  checked,
  onCheck,
  editingPriority,
  onPriorityEdit,
  onPriorityCommit,
  onPriorityCancel,
  onToggle,
}: {
  upstream: Upstream;
  diagnostics?: ReactNode;
  groups: Array<{ id: number; name: string }>;
  busy: boolean;
  menu: MenuEntry[];
  checked: boolean;
  onCheck: (next: boolean) => void;
  editingPriority: boolean;
  onPriorityEdit: () => void;
  onPriorityCommit: (raw: string) => void;
  onPriorityCancel: () => void;
  onToggle: () => void;
}) {
  const zeroWeight = upstream.effective_weight <= 0;
  return (
    <tr className={upstream.enabled ? undefined : "row-disabled"}>
      <td className="col-check" data-col="check">
        <input
          type="checkbox"
          className="upstream-row-check"
          aria-label={`选择渠道 ${upstream.name}`}
          checked={checked}
          onChange={(event) => onCheck(event.target.checked)}
        />
      </td>
      <td className="col-id" data-col="id">{upstream.id}</td>
      <td className="name-cell" data-col="name">
        <div className="name-stack">
          {diagnostics}
          <span className="name-inline">
            <strong title={upstream.name}>{upstream.name}</strong>
            {/* 一把 key 的渠道照旧不标；多把才值得在列表里看到。 */}
            {upstream.key_count > 1 ? (
              <span className="badge neutral" title="这个渠道的 Key 数，以及其中启用的">
                {`${upstream.key_count} Key · ${upstream.enabled_key_count} 启用`}
              </span>
            ) : null}
          </span>
          <BaseUrlCell upstream={upstream} />
        </div>
      </td>
      <td className="match-cell" data-col="models">
        {modelMatchItems(upstream).length === 0 ? (
          <span className="muted">默认候选</span>
        ) : (
          <ChipList items={modelMatchItems(upstream)} />
        )}
      </td>

      {/* 分组格。漏了这一格表头 9 列、表体 8 列，其后所有单元格整体左移。 */}
      <td className="group-cell" data-col="groups">
        {upstream.group_ids.length === 0 ? (
          <span className="muted">—</span>
        ) : (
          <ChipList
            items={upstream.group_ids.map((id) => ({
              label: groups.find((group) => group.id === id)?.name ?? `#${id}`,
              type: "group",
            }))}
          />
        )}
      </td>

      <td className="col-priority" data-col="priority">
        {/* 点数字变输入框，和旧版一致。失焦或回车提交，Esc 放弃。 */}
        {editingPriority ? (
          <input
            type="number"
            className="priority-input"
            min={0}
            max={100000}
            step={1}
            defaultValue={upstream.priority}
            autoFocus
            aria-label={`渠道 ${upstream.name} 的优先级`}
            onBlur={(event) => onPriorityCommit(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") onPriorityCommit(event.currentTarget.value);
              else if (event.key === "Escape") onPriorityCancel();
            }}
          />
        ) : (
          <button
            type="button"
            className="priority-value"
            aria-label={`修改渠道 ${upstream.name} 的优先级`}
            title="点击修改优先级"
            disabled={busy}
            onClick={onPriorityEdit}
          >
            {upstream.priority}
          </button>
        )}
      </td>
      <td className="col-weight" data-col="weight">
        {/* 动态权重显示「有效 / 基础」双值；关掉自动权重时只有基础值，
            此时 effective_weight 不参与路由，拿出来显示会让人误以为它生效。 */}
        <div className="weight-stack">
          {upstream.auto_weight_enabled ? (
            <>
              <strong>{`${formatWeight(upstream.effective_weight)} / ${formatWeight(upstream.weight)}`}</strong>
              <span>有效权重 / 基础权重</span>
            </>
          ) : (
            <>
              <strong>{formatWeight(upstream.weight)}</strong>
              <span>固定权重</span>
            </>
          )}
        </div>
      </td>
      <td className="col-status" data-col="status">
        <div className="status-stack">
          <button
            type="button"
            className={`status-switch ${upstream.enabled ? "on" : "off"}`}
            role="switch"
            aria-checked={upstream.enabled}
            aria-label={`${upstream.enabled ? "停用" : "启用"}渠道 ${upstream.name}`}
            title={upstream.enabled ? "点击停用" : "点击启用"}
            disabled={busy}
            onClick={onToggle}
          >
            <span className="status-switch-track" aria-hidden="true">
              <span className="status-switch-thumb" />
            </span>
          </button>
          {/* 三种 0 要分开说：固定权重 0、基础权重 0、被动态降到 0。
              只说「有效权重为 0」的话，前两种看起来像故障，其实是配的。 */}
          {zeroWeight ? (
            <span className="effective-zero-note">{zeroWeightNote(upstream)}</span>
          ) : null}
        </div>
      </td>
      <td className="row-actions col-actions" data-col="actions">
        <RowMenu upstream={upstream} entries={menu} disabled={busy} />
      </td>
    </tr>
  );
}
