import { useState } from "react";

import { UnauthorizedError, revealUpstreamKey } from "../api";
import { newKeyRow } from "../keyRows";
import type { KeyRow } from "../keyRows";
import { useToast } from "./feedback";

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

  function update(row: number, patch: Partial<KeyRow>) {
    onChange((current) => current.map((item) => (item.row === row ? { ...item, ...patch } : item)));
  }

  async function reveal(item: KeyRow) {
    setRevealing(item.row);
    try {
      const credential = await revealUpstreamKey(upstreamId, item.id);
      // 只填还空着的框：取的这会儿可能已经开始改了。
      onChange((current) =>
        current.map((row) =>
          row.row === item.row
            ? { ...row, revealed: credential.api_key, value: row.value === "" ? credential.api_key : row.value }
            : row,
        ),
      );
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
        const masked = item.id !== 0 && item.revealed === null;
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
              <input
                className="key-row-secret"
                type={masked ? "password" : "text"}
                value={item.value}
                onChange={(event) => update(item.row, { value: event.target.value })}
                placeholder={item.id !== 0 ? "已保存，留空不修改" : "sk-…"}
                autoComplete="off"
                spellCheck={false}
                aria-label={`第 ${index + 1} 把 Key`}
              />
              {masked ? (
                <button
                  type="button"
                  className="secondary field-action"
                  title="查看已保存的 Key"
                  aria-label={`查看第 ${index + 1} 把已保存的 Key`}
                  disabled={revealing === item.row}
                  onClick={() => void reveal(item)}
                >
                  <svg viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z" />
                    <circle cx="12" cy="12" r="3" />
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
