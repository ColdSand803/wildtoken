import { useState } from "react";

import { UnauthorizedError, revealUpstreamKey } from "../api";
import { hideKey, newKeyRow, showKey } from "../keyRows";
import type { KeyRow } from "../keyRows";
import { useToast } from "./feedback";

/** 已保存的 key 在框里的样子。定长，不透露真实长度。 */
const SAVED_MASK = "*".repeat(16);

export function KeyListEditor({
  upstreamId,
  rows,
  onChange,
}: {
  upstreamId: number;
  rows: KeyRow[];
  /** 传更新函数而不是新数组：取明文是异步的，回来时表单可能已经变了。 */
  onChange: (update: (rows: KeyRow[]) => KeyRow[]) => void;
}) {
  const toast = useToast();
  const [revealing, setRevealing] = useState<number | null>(null);

  /** 按最新的行改，不按点下去那一刻的快照：取明文是异步的。 */
  function apply(row: number, change: (item: KeyRow) => KeyRow) {
    onChange((current) => current.map((item) => (item.row === row ? change(item) : item)));
  }

  function update(row: number, patch: Partial<KeyRow>) {
    apply(row, (item) => ({ ...item, ...patch }));
  }

  async function toggle(item: KeyRow) {
    if (item.shown) {
      apply(item.row, hideKey);
      return;
    }

    // 框里有字或取过明文就不再取：每取一次后端记一条审计日志。
    if (item.value !== "" || item.revealed !== null) {
      apply(item.row, showKey);
      return;
    }

    setRevealing(item.row);
    try {
      const credential = await revealUpstreamKey(upstreamId, item.id);
      // 取的这会儿可能已经开始改了，showKey 只填还空着的框。
      apply(item.row, (row) => showKey({ ...row, revealed: credential.api_key }));
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        toast(`取 Key 失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
      }
    } finally {
      setRevealing(null);
    }
  }

  return (
    <div className="key-list">
      {rows.map((item, index) => {
        const saved = item.id !== 0;
        return (
          <div key={item.row} className="key-row">
            <input
              className="key-row-name"
              value={item.name}
              onChange={(event) => update(item.row, { name: event.target.value })}
              placeholder="名称（可选）"
              maxLength={100}
              aria-label={`第 ${index + 1} 把 Key 的名称`}
            />
            <div className="field-with-action">
              {/* 已保存没动过的框是空的，星号是占位符：直接输入即替换，清空即恢复。 */}
              <input
                className="key-row-secret"
                type={saved && !item.shown ? "password" : "text"}
                value={item.value}
                onChange={(event) => update(item.row, { value: event.target.value })}
                placeholder={saved ? SAVED_MASK : "sk-…"}
                autoComplete="off"
                spellCheck={false}
                aria-label={`第 ${index + 1} 把 Key`}
              />
              {saved ? (
                <button
                  type="button"
                  className="secondary field-action"
                  title={item.shown ? "隐藏明文" : "显示明文"}
                  aria-label={`显示第 ${index + 1} 把 Key 的明文`}
                  aria-pressed={item.shown}
                  disabled={revealing === item.row}
                  onClick={() => void toggle(item)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                    <circle cx="12" cy="12" r="3" />
                    {/* 亮着时划一道：再点就遮回去。 */}
                    {item.shown ? <line x1="3" y1="3" x2="21" y2="21" /> : null}
                  </svg>
                </button>
              ) : null}
            </div>
            <label className="key-row-enabled">
              <input
                type="checkbox"
                checked={item.enabled}
                onChange={(event) => update(item.row, { enabled: event.target.checked })}
              />
              启用
            </label>
            <button
              type="button"
              className="ghost small"
              aria-label={`删除第 ${index + 1} 把 Key`}
              onClick={() => onChange((current) => current.filter((row) => row.row !== item.row))}
            >
              删除
            </button>
            {item.coolingSeconds > 0 ? (
              <span className="key-row-cooling">
                上游刚拒绝过这把 Key，还要冷却 {item.coolingSeconds} 秒，期间排在其他 Key 后面。
              </span>
            ) : null}
          </div>
        );
      })}
      <button type="button" className="secondary small key-list-add" onClick={() => onChange((current) => [...current, newKeyRow()])}>
        添加 Key
      </button>
    </div>
  );
}
