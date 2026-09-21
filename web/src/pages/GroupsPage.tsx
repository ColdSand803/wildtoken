import { useCallback, useEffect, useRef, useState } from "react";

import {
  UnauthorizedError,
  createGroup,
  deleteGroup,
  listGroupsFull,
  updateGroup,
} from "../api";
import { useConfirm, useToast } from "../components/feedback";
import type { Group } from "../types";

export function GroupsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [groups, setGroups] = useState<Group[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<{ group: Group | null } | null>(null);
  const [saving, setSaving] = useState(false);

  const toast = useToast();
  const confirm = useConfirm();

  const reload = useCallback(async () => {
    try {
      setGroups(await listGroupsFull());
      setError("");
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void reload();
  }, [reload]);

  async function save(name: string, description: string) {
    const target = editing?.group;
    setSaving(true);
    try {
      const saved = target
        ? await updateGroup(target.id, { name, description })
        : await createGroup({ name, description });
      setEditing(null);
      await reload();
      toast(`分组 ${saved.name} 已${target ? "保存" : "创建"}。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`保存失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function remove(group: Group) {
    /* 后端也拦，但前端先说清楚后果：归属这个分组的渠道和令牌会掉进
       默认分组，而不是一起被删。 */
    const ok = await confirm({
      title: "删除分组？",
      message:
        group.upstream_count + group.token_count > 0
          ? `「${group.name}」下还有 ${group.upstream_count} 个渠道、${group.token_count} 个令牌，删除后它们会归入默认分组。`
          : `「${group.name}」将被删除。`,
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      await deleteGroup(group.id);
      await reload();
      toast(`分组「${group.name}」已删除。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`删除失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    }
  }

  return (
    <section className="view" data-view="groups">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">ACCESS SCOPE</span>
            <h2>分组</h2>
            <p>分组决定一个令牌能访问哪些渠道。</p>
          </div>
        </div>

        <div className="view-toolbar">
          <div className="actions toolbar-actions">
            <button type="button" className="secondary" onClick={() => void reload()}>
              刷新
            </button>
            <button type="button" onClick={() => setEditing({ group: null })}>
              新增分组
            </button>
          </div>
        </div>

        {error ? (
          <p className="field-hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>描述</th>
                <th className="numeric">渠道</th>
                <th className="numeric">令牌</th>
                <th className="actions-col">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={5} className="muted">加载中…</td>
                </tr>
              ) : groups.length === 0 ? (
                <tr>
                  <td colSpan={5} className="muted">暂无分组</td>
                </tr>
              ) : (
                groups.map((group) => (
                  <tr key={group.id}>
                    <td>
                      <span className="name-inline">
                        <strong>{group.name}</strong>
                        {group.is_default ? <span className="badge neutral">默认</span> : null}
                      </span>
                    </td>
                    <td>{group.description || <span className="muted">-</span>}</td>
                    <td className="numeric">{group.upstream_count}</td>
                    <td className="numeric">{group.token_count}</td>
                    <td className="actions-col">
                      <button
                        type="button"
                        className="secondary ghost"
                        onClick={() => setEditing({ group })}
                      >
                        编辑
                      </button>
                      {/* 默认分组不给删除按钮：令牌掉进空分组就什么渠道都访问不了。 */}
                      {group.is_default ? null : (
                        <button
                          type="button"
                          className="secondary ghost danger"
                          onClick={() => void remove(group)}
                        >
                          删除
                        </button>
                      )}
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <GroupDialog
        open={editing !== null}
        group={editing?.group ?? null}
        busy={saving}
        onSubmit={(name, description) => void save(name, description)}
        onClose={() => setEditing(null)}
      />
    </section>
  );
}

function GroupDialog({
  open,
  group,
  busy,
  onSubmit,
  onClose,
}: {
  open: boolean;
  group: Group | null;
  busy: boolean;
  onSubmit: (name: string, description: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? "");
    setDescription(group?.description ?? "");
  }, [open, group]);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog className="upstream-dialog" ref={ref} onCancel={onClose}>
      <form
        className="upstream-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !name.trim()) return;
          onSubmit(name.trim(), description.trim());
        }}
      >
        <div className="modal-head">
          <div>
            <h2>{group ? `编辑分组 #${group.id}` : "新增分组"}</h2>
            <p>分组决定一个令牌能访问哪些渠道。</p>
          </div>
          <button type="button" className="secondary ghost" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="form-grid">
          <label className="field">
            <span className="field-label">名称</span>
            <input
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              autoComplete="off"
              /* 默认分组改名会让依赖它的代码找不到目标，后端也会拒。 */
              disabled={group?.is_default}
            />
            {group?.is_default ? (
              <span className="field-hint">默认分组不能改名。</span>
            ) : null}
          </label>

          <label className="field">
            <span className="field-label">描述</span>
            <input
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              autoComplete="off"
            />
          </label>
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={busy || !name.trim()}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
