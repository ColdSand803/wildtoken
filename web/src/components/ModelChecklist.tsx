import { useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { ReactNode, Ref } from "react";

type Scope = "all" | "selected" | "unselected" | "missing";

const SCOPES: ReadonlyArray<readonly [Scope, string]> = [
  ["all", "全部"],
  ["selected", "已选"],
  ["unselected", "未选"],
  ["missing", "本次未返回"],
];

export interface ModelChecklistHandle {
  /** 切到“已选”并滚到末尾，让刚加进来的名字露出来。 */
  revealSelectedEnd: () => void;
}

interface Undo {
  names: string[];
  pick: boolean;
}

/**
 * 模型勾选列表：搜索、范围筛选、批量勾选和撤销。
 *
 * 渠道编辑和快速导入共用。选择由调用方持有，这里只报“哪些名字、勾还是取消”。
 */
export function ModelChecklist({
  ref,
  active,
  title,
  backLabel,
  searchId,
  candidates,
  selected,
  returned,
  resetKey = "",
  disabled = false,
  notice,
  emptyText,
  actions,
  children,
  onBack,
  onChange,
}: {
  ref?: Ref<ModelChecklistHandle>;
  active: boolean;
  title: string;
  backLabel: string;
  searchId: string;
  candidates: readonly string[];
  selected: ReadonlySet<string>;
  /** 本次目录返回的名字。null 是没有可比对的目录，“本次未返回”不可用。 */
  returned: ReadonlySet<string> | null;
  /** 变了就清空搜索和筛选，例如换了连接。 */
  resetKey?: string;
  disabled?: boolean;
  /** 一次性提示，占状态位，用户下一次操作后让回匹配数。新对象算新提示。 */
  notice?: { text: string } | null;
  /** 一个候选都没有时的说明。 */
  emptyText: string;
  /** 搜索框右侧的按钮。 */
  actions?: ReactNode;
  /** 工具区下方的附加内容：警告、批量输入。 */
  children?: ReactNode;
  onBack: () => void;
  onChange: (names: readonly string[], pick: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [scope, setScope] = useState<Scope>("all");
  const [undo, setUndo] = useState<Undo | null>(null);
  const [seenNotice, setSeenNotice] = useState<{ text: string } | null>(null);
  const [toEnd, setToEnd] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // 目录作废后“本次未返回”无从判断，退回全部。
  const current: Scope = scope === "missing" && !returned ? "all" : scope;

  const matches = useMemo(() => {
    const needle = query.trim().toLowerCase();

    return candidates.filter((name) => name.toLowerCase().includes(needle)
      && (current !== "selected" || selected.has(name))
      && (current !== "unselected" || !selected.has(name))
      && (current !== "missing" || !returned?.has(name)));
  }, [candidates, selected, returned, query, current]);

  const pickedMatches = useMemo(() => matches.filter((name) => selected.has(name)), [matches, selected]);
  const freeMatches = matches.length - pickedMatches.length;

  useEffect(() => {
    setQuery("");
    setScope("all");
    setUndo(null);
  }, [resetKey]);

  useEffect(() => {
    if (disabled) setUndo(null);
  }, [disabled]);

  useEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0;
  }, [query, current, resetKey]);

  // 排在回顶之后：同一轮里筛选也变了，以滚到末尾为准。
  useEffect(() => {
    if (toEnd && listRef.current) listRef.current.scrollTop = listRef.current.scrollHeight;
  }, [toEnd]);

  useImperativeHandle(ref, () => ({
    revealSelectedEnd() {
      setQuery("");
      setScope("selected");
      setToEnd((value) => value + 1);
    },
  }), []);

  function touch() {
    setSeenNotice(notice ?? null);
  }

  function batch(pick: boolean) {
    const names = matches.filter((name) => selected.has(name) !== pick);
    if (!names.length) return;

    touch();
    setUndo({ names, pick });
    onChange(names, pick);
  }

  function toggle(name: string, pick: boolean, index: number) {
    touch();
    setUndo(null);
    onChange([name], pick);

    // “已选”“未选”下勾一下这行就消失，焦点交给顶上来的那一行。
    requestAnimationFrame(() => {
      const inputs = Array.from(listRef.current?.querySelectorAll<HTMLInputElement>("input") ?? []);
      const next = inputs.find((input) => input.value === name) ?? inputs[Math.min(index, inputs.length - 1)] ?? searchRef.current;
      next?.focus({ preventScroll: true });
    });
  }

  const liveNotice = notice && notice !== seenNotice ? notice.text : "";
  const status = undo ? `已${undo.pick ? "选中" : "取消"} ${undo.names.length} 项` : liveNotice || `匹配 ${matches.length} 项`;

  return (
    <section className="mc" hidden={!active} aria-labelledby={`${searchId}-title`}>
      <div className="mc-head">
        <button type="button" className="ghost small mc-back" onClick={onBack}>← {backLabel}</button>
        <h3 id={`${searchId}-title`}>{title}</h3>
        <span className="mc-count"><strong>{selected.size}</strong> / {candidates.length} 已选</span>
      </div>

      <div className="mc-tools">
        <div className="mc-search">
          <input
            ref={searchRef}
            id={searchId}
            type="search"
            value={query}
            aria-label="搜索模型名或前缀"
            placeholder="搜索模型名或前缀"
            onChange={(event) => { touch(); setQuery(event.currentTarget.value); }}
          />
          {actions}
        </div>

        <div className="mc-bar">
          <div className="mc-scopes" role="group" aria-label="模型范围">
            {SCOPES.map(([value, label]) => (
              <button
                type="button"
                key={value}
                className={current === value ? "secondary is-active" : "ghost"}
                aria-pressed={current === value}
                disabled={value === "missing" && !returned}
                title={value === "missing" && !returned ? "拉取当前连接的目录后才能判断" : undefined}
                onClick={() => { touch(); setScope(value); }}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="mc-batch">
            <span className="field-hint" role="status">{status}</span>
            {undo ? (
              <button type="button" className="ghost small" disabled={disabled} onClick={() => { onChange(undo.names, !undo.pick); setUndo(null); }}>
                撤销
              </button>
            ) : null}
            <button type="button" className="ghost small" disabled={disabled || freeMatches === 0} onClick={() => batch(true)}>
              选中匹配（{freeMatches}）
            </button>
            <button type="button" className="ghost small" disabled={disabled || pickedMatches.length === 0} onClick={() => batch(false)}>
              取消匹配（{pickedMatches.length}）
            </button>
          </div>
        </div>

        {children}
      </div>

      <div className="mc-list" ref={listRef} role={matches.length ? "list" : "group"} aria-label="候选模型" tabIndex={0}>
        {matches.length ? matches.map((name, index) => (
          <div key={name} className="mc-row" role="listitem">
            <label>
              <input
                type="checkbox"
                value={name}
                checked={selected.has(name)}
                disabled={disabled}
                onChange={(event) => toggle(name, event.currentTarget.checked, index)}
              />
              <code title={name}>{name}</code>
            </label>
            {returned && !returned.has(name) ? (
              <span title="本次未返回不代表不可用，已有选择不会自动取消。">本次未返回</span>
            ) : null}
          </div>
        )) : (
          <p className="mc-empty">{candidates.length ? "当前范围没有匹配项，可更换筛选或关键词。" : emptyText}</p>
        )}
      </div>
    </section>
  );
}
