import { useCallback, useEffect, useRef, useState } from "react";

import {
  UnauthorizedError,
  createPromptTemplate,
  deletePromptTemplate,
  getSettings,
  listPromptTemplates,
  rotateAdminToken,
  saveSettings,
  setAdminToken,
  updatePromptTemplate,
} from "../api";
import { useConfirm, useToast } from "../components/feedback";
import { BUILTIN_THEMES, THEME_LABELS, THEME_PACKS, applyTheme, currentTheme } from "../theme";
import type { PromptTemplate, RuntimeSettings } from "../types";

const DENSITY_KEY = "wildtoken_density";

/** 数字输入统一走这里：空串当 0，避免 NaN 提交到后端。 */
function num(raw: string): number {
  const value = Number(raw);
  return Number.isFinite(value) ? value : 0;
}

export function SettingsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [settings, setSettings] = useState<RuntimeSettings | null>(null);
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [theme, setTheme] = useState(currentTheme);
  const [density, setDensity] = useState(
    () => document.documentElement.getAttribute("data-density") ?? "comfortable",
  );
  const [editingTemplate, setEditingTemplate] = useState<{ template: PromptTemplate | null } | null>(
    null,
  );
  const [rotatedToken, setRotatedToken] = useState("");

  const toast = useToast();
  const confirm = useConfirm();

  const reload = useCallback(async () => {
    try {
      const [loaded, loadedTemplates] = await Promise.all([getSettings(), listPromptTemplates()]);
      setSettings(loaded);
      setTemplates(loadedTemplates);
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

  function patch<K extends keyof RuntimeSettings>(key: K, value: RuntimeSettings[K]) {
    setSettings((current) => (current ? { ...current, [key]: value } : current));
  }

  async function save() {
    if (!settings) return;
    setSaving(true);
    try {
      /* revision 原样带回去：后端靠它拒掉过期的写入。 */
      setSettings(await saveSettings(settings));
      toast("设置已保存。", { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`保存失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    } finally {
      setSaving(false);
    }
  }

  async function rotate() {
    const ok = await confirm({
      title: "轮换管理员令牌？",
      message: "旧令牌立刻失效，其他已登录的浏览器会被登出。新令牌只显示一次。",
      confirmLabel: "轮换",
    });
    if (!ok) return;
    try {
      const { token } = await rotateAdminToken();
      // 当前页面接着用新令牌，否则下一个请求就 401。
      setAdminToken(token);
      setRotatedToken(token);
      toast("管理员令牌已轮换，请立刻保存新值。", { tone: "warn", durationMs: 9000 });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`轮换失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    }
  }

  function switchTheme(next: string) {
    applyTheme(next);
    setTheme(next);
  }

  function switchDensity(next: string) {
    document.documentElement.setAttribute("data-density", next);
    setDensity(next);
    try {
      localStorage.setItem(DENSITY_KEY, next);
    } catch {
      // 存储不可用时当前页面仍然生效。
      return;
    }
  }

  async function saveTemplate(name: string, prompt: string) {
    const target = editingTemplate?.template;
    try {
      if (target) await updatePromptTemplate(target.id, { name, prompt });
      else await createPromptTemplate({ name, prompt });
      setEditingTemplate(null);
      setTemplates(await listPromptTemplates());
      toast(`Prompt「${name}」已${target ? "保存" : "创建"}。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`保存失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    }
  }

  async function removeTemplate(template: PromptTemplate) {
    const ok = await confirm({
      title: "删除 Prompt？",
      message: `「${template.name}」将被删除。`,
      confirmLabel: "删除",
    });
    if (!ok) return;
    try {
      await deletePromptTemplate(template.id);
      setTemplates(await listPromptTemplates());
      toast(`Prompt「${template.name}」已删除。`, { tone: "ok" });
    } catch (err) {
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else toast(`删除失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
    }
  }

  return (
    <section className="view" data-view="settings">
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">RUNTIME</span>
            <h2>设置</h2>
            <p>运行时行为、外观与模型测试 Prompt。</p>
          </div>
        </div>

        {error ? (
          <p className="field-hint" role="alert" style={{ color: "var(--danger)" }}>
            {error}
          </p>
        ) : null}

        <h3>外观</h3>
        <div className="form-grid">
          <label className="field">
            <span className="field-label">主题</span>
            <select value={theme} onChange={(event) => switchTheme(event.target.value)}>
              {[...BUILTIN_THEMES, ...Object.keys(THEME_PACKS)].map((id) => (
                <option key={id} value={id}>
                  {THEME_LABELS[id] ?? id}
                </option>
              ))}
            </select>
            <span className="field-hint">主题与旧控制台共用同一份设置。</span>
          </label>

          <label className="field">
            <span className="field-label">密度</span>
            <select value={density} onChange={(event) => switchDensity(event.target.value)}>
              <option value="comfortable">舒适</option>
              <option value="compact">紧凑</option>
            </select>
          </label>
        </div>

        {loading || !settings ? (
          <p className="muted">加载中…</p>
        ) : (
          <>
            <h3>日志保留</h3>
            <div className="form-grid">
              <NumberField
                label="保留天数"
                value={settings.log_retention_days}
                min={1}
                max={3650}
                hint="超过这个天数的日志会被清理。"
                onChange={(v) => patch("log_retention_days", v)}
              />
              <NumberField
                label="保留请求体条数"
                value={settings.log_body_keep_count}
                min={1}
                max={10000}
                hint="只有最近这么多条会留下请求与响应快照。"
                onChange={(v) => patch("log_body_keep_count", v)}
              />
              <NumberField
                label="单条请求体上限（字节）"
                value={settings.log_body_max_bytes}
                min={0}
                max={1048576}
                onChange={(v) => patch("log_body_max_bytes", v)}
              />
            </div>

            <h3>重试</h3>
            <div className="form-grid">
              <NumberField
                label="最大重试次数"
                value={settings.max_retries}
                min={0}
                max={5}
                onChange={(v) => patch("max_retries", v)}
              />
              <NumberField
                label="同渠道重试间隔（毫秒）"
                value={settings.same_upstream_retry_interval_ms}
                min={0}
                max={60000}
                onChange={(v) => patch("same_upstream_retry_interval_ms", v)}
              />
            </div>

            <h3>自动权重</h3>
            <div className="form-grid">
              <NumberField
                label="失败惩罚"
                value={settings.auto_weight_failure_penalty}
                min={0}
                max={100}
                onChange={(v) => patch("auto_weight_failure_penalty", v)}
              />
              <NumberField
                label="成功增量"
                value={settings.auto_weight_success_increment}
                min={0}
                max={100}
                onChange={(v) => patch("auto_weight_success_increment", v)}
              />
              <NumberField
                label="恢复增量"
                value={settings.auto_weight_recovery_increment}
                min={0}
                max={100}
                onChange={(v) => patch("auto_weight_recovery_increment", v)}
              />
              <NumberField
                label="恢复间隔（秒）"
                value={settings.auto_weight_recovery_interval_seconds}
                min={1}
                max={3600}
                onChange={(v) => patch("auto_weight_recovery_interval_seconds", v)}
              />
            </div>

            <h3>出站代理</h3>
            <div className="form-grid">
              <label className="field">
                <input
                  type="checkbox"
                  checked={settings.proxy_enabled}
                  onChange={(event) => patch("proxy_enabled", event.target.checked)}
                />
                <span>启用代理</span>
              </label>
              <label className="field">
                <span className="field-label">代理地址</span>
                <input
                  value={settings.proxy_url}
                  onChange={(event) => patch("proxy_url", event.target.value)}
                  placeholder="http://127.0.0.1:7890"
                  autoComplete="off"
                />
              </label>
            </div>

            <div className="modal-actions">
              <span className="muted">修订号 {settings.revision}</span>
              <button type="button" disabled={saving} onClick={() => void save()}>
                {saving ? "保存中…" : "保存设置"}
              </button>
            </div>
          </>
        )}
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">SECURITY</span>
            <h2>管理员令牌</h2>
            <p>轮换后旧令牌立刻失效，新值只显示一次。</p>
          </div>
        </div>

        {rotatedToken ? (
          <div className="form-grid">
            <label className="field">
              <span className="field-label">新令牌</span>
              <input readOnly value={rotatedToken} />
              <span className="field-hint">这个值不会再显示，现在就存好。</span>
            </label>
          </div>
        ) : null}

        <div className="modal-actions">
          <button type="button" className="secondary danger" onClick={() => void rotate()}>
            轮换管理员令牌
          </button>
        </div>
      </section>

      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">MODEL TEST</span>
            <h2>Prompt 模板</h2>
            <p>测试模型时可选的提示词。</p>
          </div>
        </div>

        <div className="view-toolbar">
          <div className="actions toolbar-actions">
            <button type="button" onClick={() => setEditingTemplate({ template: null })}>
              新增 Prompt
            </button>
          </div>
        </div>

        <div className="table-wrap">
          <table className="admin-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>内容</th>
                <th className="actions-col">操作</th>
              </tr>
            </thead>
            <tbody>
              {templates.length === 0 ? (
                <tr>
                  <td colSpan={3} className="muted">暂无 Prompt 模板</td>
                </tr>
              ) : (
                templates.map((template) => (
                  <tr key={template.id}>
                    <td>
                      <strong>{template.name}</strong>
                    </td>
                    <td className="muted">{template.prompt.slice(0, 60)}…</td>
                    <td className="actions-col">
                      <button
                        type="button"
                        className="secondary ghost"
                        onClick={() => setEditingTemplate({ template })}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        className="secondary ghost danger"
                        onClick={() => void removeTemplate(template)}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </section>

      <PromptDialog
        open={editingTemplate !== null}
        template={editingTemplate?.template ?? null}
        onSubmit={(name, prompt) => void saveTemplate(name, prompt)}
        onClose={() => setEditingTemplate(null)}
      />
    </section>
  );
}

function NumberField({
  label,
  value,
  min,
  max,
  hint,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  hint?: string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      <input
        type="number"
        min={min}
        max={max}
        value={value}
        onChange={(event) => onChange(num(event.target.value))}
      />
      {hint ? <span className="field-hint">{hint}</span> : null}
    </label>
  );
}

function PromptDialog({
  open,
  template,
  onSubmit,
  onClose,
}: {
  open: boolean;
  template: PromptTemplate | null;
  onSubmit: (name: string, prompt: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState("");
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    if (!open) return;
    setName(template?.name ?? "");
    setPrompt(template?.prompt ?? "");
  }, [open, template]);

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
          if (!name.trim() || !prompt.trim()) return;
          onSubmit(name.trim(), prompt.trim());
        }}
      >
        <div className="modal-head">
          <div>
            <h2>{template ? `编辑 Prompt #${template.id}` : "新增 Prompt"}</h2>
          </div>
          <button type="button" className="secondary ghost" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="form-grid">
          <label className="field">
            <span className="field-label">名称</span>
            <input value={name} onChange={(e) => setName(e.target.value)} required autoComplete="off" />
          </label>
          <label className="field">
            <span className="field-label">内容</span>
            <textarea rows={6} value={prompt} onChange={(e) => setPrompt(e.target.value)} required />
          </label>
        </div>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={!name.trim() || !prompt.trim()}>
            保存
          </button>
        </div>
      </form>
    </dialog>
  );
}
