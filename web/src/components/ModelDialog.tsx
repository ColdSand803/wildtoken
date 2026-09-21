import { useEffect, useMemo, useRef, useState } from "react";
import { useDialog } from "../useDialog";

/** 一次选择的成果：精确模型名，加上「下游名 => 渠道名」的映射。 */
export interface ModelSelection {
  names: string[];
  mappings: Record<string, string>;
}

/** 去重保序。先出现的位置说了算。 */
function uniqueList(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

/**
 * 手动输入栏的解析。
 *
 * 逗号（中英文都收）和换行分段；段里带 `=>` 的登记为映射，否则按空白
 * 再切一次当成多个模型名。照抄旧版 parseManualModelEntry。
 */
export function parseManualEntry(value: string): { names: string[]; mappings: Record<string, string> } {
  const names: string[] = [];
  const mappings: Record<string, string> = {};

  for (const segment of String(value || "").split(/[,，\n]/)) {
    const clean = segment.trim();
    if (!clean) continue;

    const arrow = clean.indexOf("=>");
    if (arrow !== -1) {
      const downstream = clean.slice(0, arrow).trim();
      const upstream = clean.slice(arrow + 2).trim();
      if (downstream && upstream) mappings[downstream] = upstream;
      continue;
    }

    for (const name of clean.split(/\s+/)) {
      if (name.trim()) names.push(name.trim());
    }
  }

  return { names: uniqueList(names), mappings };
}

/**
 * 模型选择器。
 *
 * catalog 是这次从上游拉回来的列表，null 表示没拉——两种状态要分开，因为
 * 「未返回」这个判断只有拉过才成立。没拉却把已选模型标成未返回，等于告诉
 * 管理员一件没有依据的事。
 *
 * 组件不自己发请求：拉取由调用方做，结果当 props 传进来。
 */
export function ModelDialog({
  open,
  channelName,
  catalog,
  selection,
  busy,
  onSave,
  onClose,
}: {
  open: boolean;
  channelName: string;
  /** 上游返回的模型；null 表示本次没有拉取。 */
  catalog: string[] | null;
  selection: ModelSelection;
  busy: boolean;
  onSave: (next: ModelSelection) => void;
  onClose: () => void;
}) {
  const [models, setModels] = useState<string[]>([]);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [mappings, setMappings] = useState<Record<string, string>>({});
  const [selectedMappings, setSelectedMappings] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [selectedOnly, setSelectedOnly] = useState(false);
  const [manual, setManual] = useState("");
  const dialogRef = useDialog(open, onClose);
  const filterRef = useRef<HTMLInputElement>(null);

  /* 每次打开重新铺状态。列表是「拉回来的」并上「已经选中的」——已选但这次
     上游没返回的模型必须还在列表里，否则一保存就被悄悄丢掉。 */
  useEffect(() => {
    if (!open) return;
    setModels(uniqueList([...(catalog ?? []), ...selection.names]));
    setSelected(new Set(selection.names));
    setMappings({ ...selection.mappings });
    setSelectedMappings(new Set(Object.keys(selection.mappings)));
    setFilter("");
    setSelectedOnly(false);
    setManual("");
  }, [open, catalog, selection]);

  const available = useMemo(() => new Set(catalog ?? []), [catalog]);

  const visibleModels = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return models.filter((model) => {
      if (selectedOnly && !selected.has(model)) return false;
      return !needle || model.toLowerCase().includes(needle);
    });
  }, [models, filter, selectedOnly, selected]);

  const visibleMappings = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    return Object.entries(mappings).filter(([downstream, upstream]) => {
      if (selectedOnly && !selectedMappings.has(downstream)) return false;
      if (!needle) return true;
      return downstream.toLowerCase().includes(needle) || upstream.toLowerCase().includes(needle);
    });
  }, [mappings, filter, selectedOnly, selectedMappings]);

  /* 已选但这次上游没返回的。没拉取时恒为空——没有依据就不下判断。 */
  const unavailable = useMemo(
    () => (catalog === null ? [] : [...selected].filter((model) => !available.has(model))),
    [catalog, selected, available],
  );

  const summary = useMemo(() => {
    const parts = [`已选择 ${selected.size}`];
    if (catalog === null) {
      parts.push(`列表 ${models.length}`);
    } else {
      parts.push(`上游返回 ${available.size}`);
      if (unavailable.length > 0) parts.push(`${unavailable.length} 个未由上游返回`);
    }
    if (Object.keys(mappings).length > 0) parts.push(`映射 ${selectedMappings.size}`);
    return parts.join(" · ");
  }, [selected, catalog, models, available, unavailable, mappings, selectedMappings]);

  function toggleModel(model: string, checked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      if (checked) next.add(model);
      else next.delete(model);
      return next;
    });
  }

  function toggleMapping(downstream: string, checked: boolean) {
    setSelectedMappings((current) => {
      const next = new Set(current);
      if (checked) next.add(downstream);
      else next.delete(downstream);
      return next;
    });
  }

  /* 全选和清空只动可见项。筛出 20 个里的 3 个再点全选，不该把另外 17 个
     也一起选上——那是旧版的语义，也是唯一说得通的一种。 */
  function selectVisible(picked: boolean) {
    setSelected((current) => {
      const next = new Set(current);
      for (const model of visibleModels) {
        if (picked) next.add(model);
        else next.delete(model);
      }
      return next;
    });
    setSelectedMappings((current) => {
      const next = new Set(current);
      for (const [downstream] of visibleMappings) {
        if (picked) next.add(downstream);
        else next.delete(downstream);
      }
      return next;
    });
  }

  function removeUnavailable() {
    if (unavailable.length === 0) return;
    setSelected((current) => {
      const next = new Set(current);
      for (const model of unavailable) next.delete(model);
      return next;
    });
  }

  /* 加完清空筛选。不清的话新加的名字多半不匹配当前筛选词，加了像没加。 */
  function addManual() {
    const parsed = parseManualEntry(manual);
    const mappingEntries = Object.entries(parsed.mappings);
    if (parsed.names.length === 0 && mappingEntries.length === 0) return;

    if (parsed.names.length > 0) {
      setModels((current) => uniqueList([...current, ...parsed.names]));
      setSelected((current) => new Set([...current, ...parsed.names]));
    }
    if (mappingEntries.length > 0) {
      setMappings((current) => ({ ...current, ...parsed.mappings }));
      setSelectedMappings((current) => new Set([...current, ...mappingEntries.map(([key]) => key)]));
    }
    setManual("");
    setFilter("");
  }

  function save() {
    onSave({
      // 按列表顺序取，而不是按勾选先后——顺序稳定，diff 才看得懂。
      names: models.filter((model) => selected.has(model)),
      mappings: Object.fromEntries(
        Object.entries(mappings).filter(([downstream]) => selectedMappings.has(downstream)),
      ),
    });
  }

  const nothingVisible = visibleModels.length === 0 && visibleMappings.length === 0;

  return (
    <dialog className="model-dialog" ref={dialogRef} onCancel={onClose}>
      <div className="model-dialog-panel">
        <div className="modal-head">
          <div>
            <h2>{`选择模型：${channelName}`}</h2>
            <p>{summary}</p>
          </div>
          <div className="modal-head-actions">
            <button
              type="button"
              className="secondary ghost icon-close"
              aria-label="关闭"
              title="关闭"
              onClick={onClose}
            >
              <svg className="dialog-icon dialog-icon--close" viewBox="0 0 16 16" aria-hidden="true">
                <path d="M4 4l8 8M12 4L4 12" />
              </svg>
            </button>
          </div>
        </div>

        <div className="model-toolbar">
          <label className="field">
            <span className="field-label">筛选</span>
            <input
              ref={filterRef}
              type="search"
              autoComplete="off"
              placeholder="搜索模型"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
            />
          </label>
          <div className="model-toolbar-actions">
            <label className="model-selected-toggle">
              <input
                type="checkbox"
                checked={selectedOnly}
                onChange={(event) => setSelectedOnly(event.target.checked)}
              />
              <span>仅看已选</span>
            </label>
            <button type="button" className="secondary" onClick={() => selectVisible(true)}>
              全选
            </button>
            {/* 没拉过就不该出现——「未返回」在那种状态下没有依据。 */}
            {catalog === null ? null : (
              <button
                type="button"
                className="secondary"
                disabled={unavailable.length === 0}
                title={
                  unavailable.length > 0
                    ? `移除 ${unavailable.length} 个不在本次拉取列表中的已选模型`
                    : "没有需要移除的未返回模型"
                }
                onClick={removeUnavailable}
              >
                移除未返回
              </button>
            )}
            <button type="button" className="secondary" onClick={() => selectVisible(false)}>
              清空
            </button>
          </div>
        </div>

        <div className="model-manual-entry">
          <div className="model-manual-entry-body">
            <label className="field">
              <span className="field-label">模型名 / 映射</span>
              <input
                type="text"
                spellCheck={false}
                placeholder="gpt-5.5 gpt-5.6-sol 或 gpt-5.5 => grok-4.5"
                value={manual}
                onChange={(event) => setManual(event.target.value)}
                onKeyDown={(event) => {
                  // 单行输入框：回车是「添加」，不是提交整个对话框。
                  if (event.key !== "Enter") return;
                  event.preventDefault();
                  addManual();
                }}
              />
            </label>
            <button type="button" className="secondary" onClick={addManual}>
              添加到选择
            </button>
          </div>
        </div>

        <div className="model-options">
          {nothingVisible ? (
            <div className="empty">{selectedOnly ? "尚未选择匹配的模型。" : "没有匹配的模型。"}</div>
          ) : (
            <>
              {visibleMappings.map(([downstream, upstream]) => {
                const text = `${downstream} => ${upstream}`;
                const picked = selectedMappings.has(downstream);
                return (
                  <label
                    key={`mapping:${downstream}`}
                    className={picked ? "model-option is-mapping is-selected" : "model-option is-mapping"}
                    title={text}
                  >
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={(event) => toggleMapping(downstream, event.target.checked)}
                    />
                    <span className="model-option-tag">映射</span>
                    <span className="model-option-name">{text}</span>
                  </label>
                );
              })}
              {visibleModels.map((model) => {
                const picked = selected.has(model);
                const missing = catalog !== null && !available.has(model);
                return (
                  <label
                    key={`model:${model}`}
                    className={picked ? "model-option is-selected" : "model-option"}
                  >
                    <input
                      type="checkbox"
                      checked={picked}
                      onChange={(event) => toggleModel(model, event.target.checked)}
                    />
                    <span className="model-option-name">{model}</span>
                    {missing ? <span className="model-option-state">未返回</span> : null}
                  </label>
                );
              })}
            </>
          )}
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="button" disabled={busy} onClick={save}>
            {busy ? "保存中…" : "保存选择"}
          </button>
        </div>
      </div>
    </dialog>
  );
}
