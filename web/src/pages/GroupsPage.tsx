import { useCallback, useEffect, useState } from "react";

import { useDialog } from "../useDialog";

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
                    {/* 和令牌页同形：desc-cell + muted，空值用破折号，有值带 title。 */}
                    <td className="desc-cell">
                      {group.description.trim() ? (
                        <span className="muted" title={group.description}>
                          {group.description}
                        </span>
                      ) : (
                        <span className="muted is-empty">—</span>
                      )}
                    </td>
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
  /* 不传 onClose：旧版的分组框故意不支持点遮罩关闭。 */
  const ref = useDialog(open);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? "");
    setDescription(group?.description ?? "");
  }, [open, group]);

  return (
    <dialog className="upstream-dialog group-dialog dialog--drawer" ref={ref} onCancel={onClose}>
      <form
        className="upstream-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || !name.trim()) return;
          onSubmit(name.trim(), description.trim());
        }}
      >
        <div className="modal-head upstream-modal-head">
          <div>
            <h2>{group ? `编辑分组 #${group.id}` : "新增分组"}</h2>
            <p>分组决定一个令牌能访问哪些渠道。</p>
          </div>
          {/* 和其他抽屉同形：icon-close 加 SVG，不是一个字符×。 */}
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

        {/* 三段：头、可滚动的正文、钉底的页脚。缺中间那层的话，满高抽屉里
            按钮不钉底。 */}
        <div className="upstream-dialog-body">
          <section className="form-section">
            <div className="form-section-head">
              <div>
                <h3>基础信息</h3>
                <p>名称在令牌和渠道两边都按它引用，建后尽量不改。</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="field span-2">
                <span className="field-label">名称</span>
                <input
                  value={name}
                  onChange={(event) => setName(event.target.value)}
                  required
                  maxLength={60}
                  autoComplete="off"
                  /* 默认分组改名会让依赖它的代码找不到目标，后端也会拒。 */
                  disabled={group?.is_default}
                />
                <span className="field-hint">
                  {group?.is_default
                    ? "默认分组不能改名：没指定分组的令牌和渠道都落在这里。"
                    : "只有同分组的令牌能路由到该分组下的渠道。"}
                </span>
              </label>

              <label className="field span-2">
                <span className="field-label">描述（可选）</span>
                <input
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                  maxLength={200}
                  placeholder="这个分组用来做什么"
                  autoComplete="off"
                />
              </label>
            </div>
          </section>

          {group ? (
            <section className="form-section">
              <div className="form-section-head">
                <div>
                  <h3>引用情况</h3>
                  <p>删除前先看这里：还有令牌挂在上面的话，它们会无处可去。</p>
                </div>
              </div>
              <div className="form-grid">
                <div className="field">
                  <span className="field-label">渠道</span>
                  <strong>{group.upstream_count}</strong>
                </div>
                <div className="field">
                  <span className="field-label">令牌</span>
                  <strong>{group.token_count}</strong>
                </div>
              </div>
            </section>
          ) : null}
        </div>

        {/* modal-footer 而不是 modal-actions：面板的第三行是钉底的。 */}
        <div className="modal-footer">
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
