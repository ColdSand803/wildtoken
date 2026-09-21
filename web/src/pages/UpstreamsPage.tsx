import { useCallback, useEffect, useState } from "react";

import {
  UnauthorizedError,
  createUpstream,
  deleteUpstream,
  fetchUpstreamBalance,
  fetchUpstreamModels,
  getUpstream,
  listGroups,
  listUpstreams,
  setUpstreamArchived,
  setUpstreamEnabled,
  testUpstream,
  updateUpstream,
} from "../api";
import { ActionMenu, MENU_SEPARATOR } from "../components/ActionMenu";
import type { MenuEntry } from "../components/ActionMenu";
import { UpstreamDialog } from "../components/UpstreamDialog";
import type { UpstreamPayload } from "../components/UpstreamDialog";
import { useConfirm, useToast } from "../components/feedback";
import type { Upstream } from "../types";

type StatusFilter = "" | "enabled" | "disabled";

/**
 * 渠道页。
 *
 * 类名照抄旧控制台：主题 CSS 有 138 个类选择器，其中约 38 个由 JS 输出。
 * 照抄这些名字，6215 行主题样式一行不用改。
 */
export function UpstreamsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [groups, setGroups] = useState<Array<{ id: number; name: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [pending, setPending] = useState<number | null>(null);
  // 归档区默认收起，和旧版一致。
  const [archivedOpen, setArchivedOpen] = useState(false);
  // null = 关闭；{ upstream: null } = 新增；{ upstream } = 编辑。
  const [editing, setEditing] = useState<{ upstream: Upstream | null } | null>(null);
  const [saving, setSaving] = useState(false);

  const toast = useToast();
  const confirm = useConfirm();

  const reload = useCallback(async () => {
    try {
      setUpstreams(await listUpstreams());
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

  /* 分组只为表单里的多选服务，拿不到不影响列表。 */
  useEffect(() => {
    listGroups()
      .then(setGroups)
      .catch(() => setGroups([]));
  }, []);

  /* 归档渠道走折叠区，不在主列表——和旧版一致。 */
  const active = upstreams.filter((u) => !u.archived);
  const archived = upstreams.filter((u) => u.archived);

  const filtered = active.filter((u) => {
    if (status === "enabled" && !u.enabled) return false;
    if (status === "disabled" && u.enabled) return false;
    const q = query.trim().toLowerCase();
    if (!q) return true;
    return [u.name, u.base_url, String(u.id), ...u.model_names, ...u.model_prefixes]
      .join(" ")
      .toLowerCase()
      .includes(q);
  });

  async function mutate(id: number, run: () => Promise<Upstream>) {
    setPending(id);
    try {
      const updated = await run();
      setUpstreams((list) => list.map((u) => (u.id === updated.id ? updated : u)));
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPending(null);
    }
  }

  /** 跑一个只报结果、不改列表的动作（测连接、拉模型、查余额）。 */
  async function runAction(id: number, label: string, run: () => Promise<unknown>) {
    setPending(id);
    try {
      await run();
      toast(`${label}成功。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`${label}失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      setPending(null);
    }
  }

  async function saveUpstream(payload: UpstreamPayload) {
    const target = editing?.upstream;
    setSaving(true);
    try {
      const saved = target ? await updateUpstream(target.id, payload) : await createUpstream(payload);
      setEditing(null);
      await reload();
      toast(`渠道 ${saved.name} 已${target ? "保存" : "创建"}。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`保存失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  /** 编辑前重拉一次：列表里的那份可能不是最新的。 */
  async function openEditor(upstream: Upstream) {
    try {
      setEditing({ upstream: await getUpstream(upstream.id) });
    } catch {
      setEditing({ upstream });
    }
  }

  /** 复制：拿完整配置开一个新建表单，名字加后缀。API Key 不会回来，得重填。 */
  async function duplicate(upstream: Upstream) {
    const full = await getUpstream(upstream.id).catch(() => upstream);
    setEditing({ upstream: { ...full, id: 0, name: `${full.name}-copy`, api_key_set: false } });
  }

  async function removeUpstream(upstream: Upstream) {
    const confirmed = await confirm({
      title: "删除渠道？",
      message: `「${upstream.name}」将被删除。已产生的日志保留，但不再关联到这个渠道。`,
      confirmLabel: "删除",
    });
    if (!confirmed) return;

    /* 先把配置拿到手，删掉之后才能提供「撤销」——后端没有回收站，
       撤销实际上是用同一份配置重建。API Key 回不来。 */
    const snapshot = await getUpstream(upstream.id).catch(() => null);
    try {
      await deleteUpstream(upstream.id);
      await reload();
      toast(`渠道「${upstream.name}」已删除。`, {
        tone: "ok",
        durationMs: 9000,
        actionLabel: snapshot ? "撤销" : undefined,
        onAction: snapshot
          ? async () => {
              const { id: _id, api_key_set: _set, ...rest } = snapshot;
              await createUpstream(rest);
              await reload();
              toast(`已恢复渠道「${snapshot.name}」，API Key 需重新填写。`, { tone: "ok" });
            }
          : undefined,
      });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`删除失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    }
  }

  async function copyInfo(upstream: Upstream) {
    const text = [
      `名称: ${upstream.name}`,
      `Base URL: ${upstream.base_url}`,
      `优先级: ${upstream.priority}`,
      `权重: ${upstream.weight}`,
      upstream.model_names.length ? `模型: ${upstream.model_names.join(", ")}` : null,
      upstream.model_prefixes.length ? `前缀: ${upstream.model_prefixes.join(", ")}` : null,
    ]
      .filter(Boolean)
      .join("\n");
    try {
      await navigator.clipboard.writeText(text);
      toast("渠道信息已复制。", { tone: "ok" });
    } catch {
      toast("复制失败：浏览器拒绝了剪贴板访问。", { tone: "error" });
    }
  }

  /** 归档渠道的菜单不给测试类动作——对不路由的渠道测连接说明不了任何事。 */
  function menuFor(upstream: Upstream): MenuEntry[] {
    if (upstream.archived) {
      return [
        { key: "unarchive", label: "恢复", tone: "primary", onSelect: () => void mutate(upstream.id, () => setUpstreamArchived(upstream.id, false)) },
        { key: "edit", label: "编辑", onSelect: () => void openEditor(upstream) },
        { key: "copy-info", label: "复制渠道信息", onSelect: () => void copyInfo(upstream) },
        MENU_SEPARATOR,
        { key: "delete", label: "删除", tone: "danger", onSelect: () => void removeUpstream(upstream) },
      ];
    }
    return [
      { key: "test", label: "测试连接", onSelect: () => void runAction(upstream.id, "测试连接", () => testUpstream(upstream.id)) },
      { key: "models", label: "拉取模型", onSelect: () => void runAction(upstream.id, "拉取模型", () => fetchUpstreamModels(upstream.id)) },
      { key: "balance", label: "查询 new-api 余额", onSelect: () => void runAction(upstream.id, "查询余额", () => fetchUpstreamBalance(upstream.id, "new-api")) },
      { key: "balance-sub2api", label: "查询 sub2api 余额", onSelect: () => void runAction(upstream.id, "查询余额", () => fetchUpstreamBalance(upstream.id, "sub2api")) },
      MENU_SEPARATOR,
      { key: "edit", label: "编辑", onSelect: () => void openEditor(upstream) },
      { key: "duplicate", label: "复制渠道", onSelect: () => void duplicate(upstream) },
      { key: "copy-info", label: "复制渠道信息", onSelect: () => void copyInfo(upstream) },
      MENU_SEPARATOR,
      { key: "archive", label: "归档", onSelect: () => void mutate(upstream.id, () => setUpstreamArchived(upstream.id, true)) },
      { key: "delete", label: "删除", tone: "danger", onSelect: () => void removeUpstream(upstream) },
    ];
  }

  return (
    <section className="view" data-view="upstreams">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">UPSTREAM ROUTING</span>
            <h2>渠道</h2>
            <p>按模型匹配、硬优先级和有效权重路由上游请求。</p>
          </div>
        </div>

        <div id="upstream-summary" className="summary-strip" aria-live="polite">
          <Summary label="渠道" value={active.length} />
          <Summary label="启用" value={active.filter((u) => u.enabled).length} />
          <Summary label="归档" value={archived.length} />
        </div>

        <div className="view-toolbar upstream-toolbar">
          <label className="filter-field">
            <input
              type="search"
              autoComplete="off"
              aria-label="搜索渠道"
              placeholder="名称、Base URL、模型…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </label>
          <label className="filter-field">
            <select
              aria-label="按状态筛选渠道"
              value={status}
              onChange={(event) => setStatus(event.target.value as StatusFilter)}
            >
              <option value="">全部</option>
              <option value="enabled">启用</option>
              <option value="disabled">停用</option>
            </select>
          </label>
          <div className="actions toolbar-actions">
            <button type="button" className="secondary" onClick={() => void reload()}>
              刷新
            </button>
            <button type="button" onClick={() => setEditing({ upstream: null })}>
              新增渠道
            </button>
          </div>
        </div>

        {error ? (
          <p className="field-hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        <div className="table-wrap">
          <table className="admin-table upstream-table">
            <thead>
              <tr>
                <th className="col-id" data-col="id">ID</th>
                <th data-col="name">渠道名</th>
                <th data-col="models">模型匹配</th>
                <th className="col-priority" data-col="priority">优先级</th>
                <th className="col-weight" data-col="weight">权重</th>
                <th className="col-status" data-col="status">状态</th>
                <th className="col-actions" data-col="actions">操作</th>
              </tr>
            </thead>
            <tbody>
              {loading ? (
                <tr>
                  <td colSpan={7} className="muted">加载中…</td>
                </tr>
              ) : filtered.length === 0 ? (
                <tr>
                  <td colSpan={7} className="muted">
                    {active.length === 0 ? "暂无渠道" : "无匹配渠道"}
                  </td>
                </tr>
              ) : (
                filtered.map((upstream) => (
                  <UpstreamRow
                    key={upstream.id}
                    upstream={upstream}
                    busy={pending === upstream.id}
                    menu={menuFor(upstream)}
                    onToggle={() => void mutate(upstream.id, () => setUpstreamEnabled(upstream.id, !upstream.enabled))}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {archived.length > 0 ? (
          <section className="archived-panel">
            {/* 默认收起。归档渠道是「暂时不用但不想删」的，日常不该占着视线；
                展开状态不持久化，刷新回到收起，和旧版一致。 */}
            <button
              type="button"
              className={`archived-toggle${archivedOpen ? " is-open" : ""}`}
              aria-expanded={archivedOpen}
              onClick={() => setArchivedOpen((open) => !open)}
            >
              <span className="archived-chevron" aria-hidden="true">
                ▸
              </span>
              <span className="archived-title">已归档渠道</span>
              <span className="archived-count">{archived.length}</span>
              <span className="archived-hint">不参与路由</span>
            </button>
            <div className="archived-body" hidden={!archivedOpen}>
              <div className="table-wrap">
                <table className="admin-table upstream-table">
                  <tbody>
                    {archived.map((upstream) => (
                      <tr key={upstream.id} className="row-archived">
                        <td className="col-id">{upstream.id}</td>
                        <td className="name-cell">
                          <div className="name-stack">
                            <strong title={upstream.name}>{upstream.name}</strong>
                            <span className="base-url">{upstream.base_url}</span>
                          </div>
                        </td>
                        <td className="col-status">
                          <span className="archived-tag">
                            <span className="archived-tag-dot" aria-hidden="true" />
                            已归档
                          </span>
                        </td>
                        <td className="row-actions col-actions">
                          <ActionMenu
                            label={`${upstream.name} 的操作菜单`}
                            entries={menuFor(upstream)}
                            trigger={({ ref, onClick, expanded }) => (
                              <button
                                ref={ref}
                                type="button"
                                className="secondary action-menu-trigger"
                                aria-haspopup="menu"
                                aria-expanded={expanded}
                                aria-label={`打开 ${upstream.name} 的操作菜单`}
                                title="操作"
                                disabled={pending === upstream.id}
                                onClick={onClick}
                              >
                                <span aria-hidden="true">⋮</span>
                              </button>
                            )}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          </section>
        ) : null}
      </section>

      <UpstreamDialog
        open={editing !== null}
        upstream={editing?.upstream ?? null}
        groups={groups}
        busy={saving}
        onSubmit={(payload) => void saveUpstream(payload)}
        onClose={() => setEditing(null)}
      />
    </section>
  );
}

function Summary({ label, value }: { label: string; value: number }) {
  return (
    <span className="summary-item">
      <span className="summary-label">{label}</span>
      <strong className="summary-value">{value}</strong>
    </span>
  );
}

function UpstreamRow({
  upstream,
  busy,
  menu,
  onToggle,
}: {
  upstream: Upstream;
  busy: boolean;
  menu: MenuEntry[];
  onToggle: () => void;
}) {
  const zeroWeight = upstream.effective_weight <= 0;
  return (
    <tr className={upstream.enabled ? undefined : "row-disabled"}>
      <td className="col-id" data-col="id">{upstream.id}</td>
      <td className="name-cell" data-col="name">
        <div className="name-stack">
          <strong title={upstream.name}>{upstream.name}</strong>
          <span className="base-url">{upstream.base_url}</span>
        </div>
      </td>
      <td className="match-cell" data-col="models">
        {upstream.model_names.length === 0 && upstream.model_prefixes.length === 0 ? (
          <span className="muted">全部模型</span>
        ) : (
          <span className="model-chips">
            {[...upstream.model_names, ...upstream.model_prefixes].map((name) => (
              <span key={name} className="badge neutral">{name}</span>
            ))}
          </span>
        )}
      </td>
      <td className="col-priority" data-col="priority">{upstream.priority}</td>
      <td className="col-weight" data-col="weight">
        <div className="weight-stack">{Math.round(upstream.effective_weight)}</div>
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
          {zeroWeight ? <span className="effective-zero-note">有效权重为 0</span> : null}
        </div>
      </td>
      <td className="row-actions col-actions" data-col="actions">
        <ActionMenu
          label={`${upstream.name} 的操作菜单`}
          entries={menu}
          trigger={({ ref, onClick, expanded }) => (
            <button
              ref={ref}
              type="button"
              className="secondary action-menu-trigger"
              aria-haspopup="menu"
              aria-expanded={expanded}
              aria-label={`打开 ${upstream.name} 的操作菜单`}
              title="操作"
              disabled={busy}
              onClick={onClick}
            >
              <span aria-hidden="true">⋮</span>
            </button>
          )}
        />
      </td>
    </tr>
  );
}
