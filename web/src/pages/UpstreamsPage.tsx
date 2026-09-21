import { useEffect, useMemo, useState } from "react";

import { UnauthorizedError, listUpstreams, setUpstreamArchived, setUpstreamEnabled } from "../api";
import type { Upstream } from "../types";

type StatusFilter = "" | "enabled" | "disabled";

/**
 * 渠道页探针。
 *
 * 只做列表、搜索、状态筛选、启停、归档——弹窗和操作菜单那些重交互故意
 * 不做，目的是量出组件化的真实成本，不是一次做完。
 *
 * 类名照抄旧控制台：主题 CSS 有 138 个类选择器，其中约 38 个由 JS 输出。
 * 照抄这些名字，6215 行主题样式一行不用改。
 */
export function UpstreamsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [upstreams, setUpstreams] = useState<Upstream[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("");
  const [pending, setPending] = useState<number | null>(null);
  // 归档区默认收起，和旧版一致。
  const [archivedOpen, setArchivedOpen] = useState(false);

  const reload = useMemo(
    () => async () => {
      try {
        setUpstreams(await listUpstreams());
        setError("");
      } catch (err) {
        if (err instanceof UnauthorizedError) onUnauthorized(err.message);
        else setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [onUnauthorized],
  );

  useEffect(() => {
    void reload();
  }, [reload]);

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
                    onToggle={() => void mutate(upstream.id, () => setUpstreamEnabled(upstream.id, !upstream.enabled))}
                    onArchive={() => void mutate(upstream.id, () => setUpstreamArchived(upstream.id, true))}
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
                          <button
                            type="button"
                            className="secondary"
                            disabled={pending === upstream.id}
                            onClick={() =>
                              void mutate(upstream.id, () => setUpstreamArchived(upstream.id, false))
                            }
                          >
                            恢复
                          </button>
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
  onToggle,
  onArchive,
}: {
  upstream: Upstream;
  busy: boolean;
  onToggle: () => void;
  onArchive: () => void;
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
        <button type="button" className="secondary" disabled={busy} onClick={onArchive}>
          归档
        </button>
      </td>
    </tr>
  );
}
