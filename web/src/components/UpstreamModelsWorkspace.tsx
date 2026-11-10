import { useEffect, useMemo, useRef, useState } from "react";

import { ModelChecklist } from "./ModelChecklist";
import type { ModelChecklistHandle } from "./ModelChecklist";

export interface UpstreamCatalog { names: string[]; source: string }

/** 渠道编辑里的“管理模型”：勾选列表加上拉取目录和批量输入。 */
export function UpstreamModelsWorkspace({ active, names, knownNames, catalog, stale, fetching, fetchError, notice, busy, manual, manualError, onBack, onFetch, onManual, onAdd, onChange }: {
  active: boolean;
  names: string[];
  knownNames: string[];
  catalog: UpstreamCatalog | null;
  stale: boolean;
  fetching: boolean;
  fetchError: string;
  notice: { text: string } | null;
  busy: boolean;
  manual: string;
  manualError?: string;
  onBack: () => void;
  onFetch: () => void;
  onManual: (value: string) => void;
  onAdd: () => boolean;
  onChange: (names: string[]) => void;
}) {
  const [manualOpen, setManualOpen] = useState(false);
  const manualRef = useRef<HTMLTextAreaElement>(null);
  const checklist = useRef<ModelChecklistHandle>(null);

  const selected = useMemo(() => new Set(names), [names]);
  const candidates = useMemo(() => [...new Set([...knownNames, ...(catalog?.names ?? []), ...names])], [knownNames, catalog, names]);
  // 连接变了，旧目录不能再拿来判断“本次未返回”。
  const returned = useMemo(() => (catalog && !stale ? new Set(catalog.names) : null), [catalog, stale]);

  // 有没处理完的输入或校验错误，进来就展开输入区并把焦点放过去。
  useEffect(() => {
    if (!active) return;
    const pending = Boolean(manualError || manual.trim());
    if (pending) setManualOpen(true);

    requestAnimationFrame(() => {
      if (pending || manualOpen) manualRef.current?.focus();
      else document.getElementById("ue-model-search")?.focus({ preventScroll: true });
    });
  }, [active, manualError]);

  function change(targets: readonly string[], pick: boolean) {
    const next = new Set(names);
    for (const name of targets) {
      if (pick) next.add(name);
      else next.delete(name);
    }
    onChange([...next]);
  }

  function toggleManual() {
    setManualOpen((open) => !open);
    if (!manualOpen) requestAnimationFrame(() => manualRef.current?.focus());
  }

  function add() {
    if (!onAdd()) return;
    setManualOpen(false);
    checklist.current?.revealSelectedEnd();
  }

  return (
    <ModelChecklist
      ref={checklist}
      active={active}
      title="管理模型"
      backLabel="模型规则"
      searchId="ue-model-search"
      candidates={candidates}
      selected={selected}
      returned={returned}
      disabled={busy}
      notice={notice}
      emptyText="还没有候选模型，可以拉取目录或批量输入。"
      onBack={onBack}
      onChange={change}
      actions={<>
        <button type="button" className="secondary" disabled={busy || fetching} onClick={onFetch}>{fetching ? "拉取中…" : "拉取目录"}</button>
        <button type="button" className="secondary" disabled={busy} aria-expanded={manualOpen} aria-controls="ue-manual-panel" onClick={toggleManual}>批量输入</button>
      </>}
    >
      {stale ? <p className="ue-warning">连接信息已变化，旧候选仍保留；重新拉取后再判断“本次未返回”。</p> : null}
      {fetchError ? <p className="ue-error" role="alert">{fetchError}</p> : null}

      <div id="ue-manual-panel" className="ue-manual" hidden={!manualOpen}>
        <textarea
          ref={manualRef}
          id="ue-manual"
          data-ue-field="manual"
          rows={4}
          value={manual}
          disabled={busy}
          spellCheck={false}
          aria-label="批量输入模型名"
          aria-invalid={Boolean(manualError)}
          aria-describedby="ue-manual-help"
          placeholder={"my-private-model\ngpt-4.1\n多个名称用空格、逗号或换行分隔"}
          onChange={(event) => onManual(event.currentTarget.value)}
        />
        <div className="ue-manual-foot">
          <span id="ue-manual-help" className={manualError ? "ue-error" : "field-hint"}>{manualError || "只填写模型名；保存渠道时也会收录尚未添加的输入。"}</span>
          <div className="ue-actions">
            <button type="button" className="ghost small" onClick={() => setManualOpen(false)}>收起</button>
            <button type="button" className="secondary small" disabled={busy || !manual.trim()} onClick={add}>添加到已选</button>
          </div>
        </div>
      </div>
    </ModelChecklist>
  );
}
