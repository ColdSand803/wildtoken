import { useEffect, useMemo, useRef, useState } from "react";

import type { Upstream } from "../types";

/** 提交给 POST/PUT /api/admin/upstreams 的形状。 */
export interface UpstreamPayload {
  name: string;
  base_url: string;
  api_key: string | null;
  model_names: string[];
  model_prefixes: string[];
  model_mappings: Record<string, string>;
  effort_mappings: Record<string, string>;
  priority: number;
  weight: number;
  auto_weight_enabled: boolean;
  timeout_seconds: number;
  enabled: boolean;
  extra_headers: Record<string, string>;
  rate_limit: string | null;
  clear_api_key: boolean;
  group_ids: number[];
}

/** 逗号或换行分隔的列表，去空去重。 */
function splitList(value: string): string[] {
  const seen = new Set<string>();
  for (const part of value.split(/[,\n]/)) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/** 每行一条 `键: 值` 或 `键=值`。空行和缺分隔符的行跳过。 */
function parseMappingLines(value: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const separator = trimmed.search(/[:=]/);
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const mapped = trimmed.slice(separator + 1).trim();
    if (key && mapped) result[key] = mapped;
  }
  return result;
}

function joinMappingLines(mappings: Record<string, string>): string {
  return Object.entries(mappings)
    .map(([key, value]) => `${key}: ${value}`)
    .join("\n");
}

interface FormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
  modelNames: string;
  modelPrefixes: string;
  modelMappings: string;
  effortMappings: string;
  extraHeaders: string;
  priority: string;
  weight: string;
  timeoutSeconds: string;
  rateLimit: string;
  enabled: boolean;
  /* UI 上是「固定权重」，提交时取反才是 auto_weight_enabled。
     这个反转最容易搬错，所以状态里就按 UI 的说法存。 */
  fixedWeight: boolean;
  groupIds: number[];
}

function emptyForm(): FormState {
  return {
    name: "",
    baseUrl: "",
    apiKey: "",
    clearApiKey: false,
    modelNames: "",
    modelPrefixes: "",
    modelMappings: "",
    effortMappings: "",
    extraHeaders: "",
    priority: "100",
    weight: "100",
    timeoutSeconds: "300",
    rateLimit: "",
    enabled: true,
    fixedWeight: false,
    groupIds: [],
  };
}

function formFromUpstream(upstream: Upstream): FormState {
  return {
    name: upstream.name,
    baseUrl: upstream.base_url,
    apiKey: "",
    clearApiKey: false,
    modelNames: upstream.model_names.join("\n"),
    modelPrefixes: upstream.model_prefixes.join("\n"),
    modelMappings: joinMappingLines(upstream.model_mappings),
    effortMappings: joinMappingLines(upstream.effort_mappings),
    extraHeaders: joinMappingLines(upstream.extra_headers),
    priority: String(upstream.priority),
    weight: String(upstream.weight),
    timeoutSeconds: String(upstream.timeout_seconds),
    rateLimit: upstream.rate_limit ?? "",
    enabled: upstream.enabled,
    fixedWeight: !upstream.auto_weight_enabled,
    groupIds: upstream.group_ids,
  };
}

export function payloadFromForm(form: FormState): UpstreamPayload {
  return {
    name: form.name.trim(),
    base_url: form.baseUrl.trim(),
    api_key: form.apiKey.trim() || null,
    model_names: splitList(form.modelNames),
    model_prefixes: splitList(form.modelPrefixes),
    model_mappings: parseMappingLines(form.modelMappings),
    effort_mappings: parseMappingLines(form.effortMappings),
    priority: Number(form.priority || 100),
    weight: Number(form.weight || 100),
    // UI 勾的是「固定权重」，后端要的是「自动权重」。
    auto_weight_enabled: !form.fixedWeight,
    timeout_seconds: Number(form.timeoutSeconds || 300),
    enabled: form.enabled,
    extra_headers: parseMappingLines(form.extraHeaders),
    rate_limit: form.rateLimit.trim() || null,
    clear_api_key: form.clearApiKey,
    group_ids: form.groupIds,
  };
}

export function UpstreamDialog({
  open,
  upstream,
  groups,
  busy,
  onSubmit,
  onClose,
}: {
  open: boolean;
  /** null 表示新增。 */
  upstream: Upstream | null;
  groups: Array<{ id: number; name: string }>;
  busy: boolean;
  onSubmit: (payload: UpstreamPayload) => void;
  onClose: () => void;
}) {
  const [form, setForm] = useState<FormState>(emptyForm);
  const [advanced, setAdvanced] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);

  /* 每次打开都按当前渠道重置。不重置的话，关掉再开会留着上一个渠道的值。 */
  useEffect(() => {
    if (!open) return;
    setForm(upstream ? formFromUpstream(upstream) : emptyForm());
    // 有映射或额外头的渠道直接把高级区展开，否则那些值藏起来像丢了。
    setAdvanced(
      Boolean(
        upstream &&
          (Object.keys(upstream.model_mappings).length ||
            Object.keys(upstream.effort_mappings).length ||
            Object.keys(upstream.extra_headers).length ||
            upstream.rate_limit),
      ),
    );
  }, [open, upstream]);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    else if (!open && dialog.open) dialog.close();
  }, [open]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  const title = upstream ? `编辑渠道 #${upstream.id}` : "新增渠道";
  const canSubmit = useMemo(
    () => form.name.trim() !== "" && form.baseUrl.trim() !== "",
    [form.name, form.baseUrl],
  );

  return (
    <dialog className="upstream-dialog" ref={dialogRef} onCancel={onClose}>
      <form
        className="upstream-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || busy) return;
          onSubmit(payloadFromForm(form));
        }}
      >
        <div className="modal-head">
          <div>
            <h2>{title}</h2>
            <p>按模型匹配与优先级路由；未填模型则接收全部请求。</p>
          </div>
          <button type="button" className="secondary ghost" onClick={onClose} aria-label="关闭">
            ×
          </button>
        </div>

        <div className="form-grid">
          <label className="field">
            <span className="field-label">名称</span>
            <input
              value={form.name}
              onChange={(event) => set("name", event.target.value)}
              required
              autoComplete="off"
            />
          </label>

          <label className="field">
            <span className="field-label">Base URL</span>
            <input
              value={form.baseUrl}
              onChange={(event) => set("baseUrl", event.target.value)}
              placeholder="https://api.example.com"
              required
              autoComplete="off"
            />
          </label>

          <label className="field">
            <span className="field-label">API Key</span>
            <input
              type="password"
              value={form.apiKey}
              onChange={(event) => set("apiKey", event.target.value)}
              placeholder={upstream?.api_key_set ? "留空保持不变" : ""}
              autoComplete="off"
            />
            {upstream?.api_key_set ? (
              <label className="field">
                <input
                  type="checkbox"
                  checked={form.clearApiKey}
                  onChange={(event) => set("clearApiKey", event.target.checked)}
                />
                <span>清除已保存的 Key</span>
              </label>
            ) : null}
          </label>

          <label className="field">
            <span className="field-label">模型名（每行一个）</span>
            <textarea
              rows={3}
              value={form.modelNames}
              onChange={(event) => set("modelNames", event.target.value)}
              placeholder="gpt-4o"
            />
            <span className="field-hint">留空表示接收全部模型。</span>
          </label>

          <label className="field">
            <span className="field-label">模型前缀（每行一个）</span>
            <textarea
              rows={2}
              value={form.modelPrefixes}
              onChange={(event) => set("modelPrefixes", event.target.value)}
              placeholder="gpt-"
            />
          </label>

          <label className="field">
            <span className="field-label">分组</span>
            <select
              multiple
              size={Math.min(4, Math.max(2, groups.length))}
              value={form.groupIds.map(String)}
              onChange={(event) =>
                set(
                  "groupIds",
                  [...event.target.selectedOptions].map((option) => Number(option.value)),
                )
              }
            >
              {groups.map((group) => (
                <option key={group.id} value={group.id}>
                  {group.name}
                </option>
              ))}
            </select>
            <span className="field-hint">不选则归入默认分组——没有分组的渠道无法被访问。</span>
          </label>

          <label className="field">
            <span className="field-label">优先级</span>
            <input
              type="number"
              min={0}
              max={100000}
              value={form.priority}
              onChange={(event) => set("priority", event.target.value)}
            />
            <span className="field-hint">数值大的先被选中。</span>
          </label>

          <label className="field">
            <span className="field-label">权重</span>
            <input
              type="number"
              min={0}
              max={10000}
              value={form.weight}
              onChange={(event) => set("weight", event.target.value)}
            />
            <label className="field">
              <input
                type="checkbox"
                checked={form.fixedWeight}
                onChange={(event) => set("fixedWeight", event.target.checked)}
              />
              <span>固定权重（关闭自动调整）</span>
            </label>
          </label>

          <label className="field">
            <span className="field-label">超时（秒）</span>
            <input
              type="number"
              min={1}
              max={3600}
              step={0.5}
              value={form.timeoutSeconds}
              onChange={(event) => set("timeoutSeconds", event.target.value)}
            />
          </label>

          <label className="field">
            <input
              type="checkbox"
              checked={form.enabled}
              onChange={(event) => set("enabled", event.target.checked)}
            />
            <span>启用</span>
          </label>
        </div>

        <details open={advanced} onToggle={(event) => setAdvanced(event.currentTarget.open)}>
          <summary>高级设置</summary>
          <div className="form-grid">
            <label className="field">
              <span className="field-label">模型映射</span>
              <textarea
                rows={3}
                value={form.modelMappings}
                onChange={(event) => set("modelMappings", event.target.value)}
                placeholder={"别名: 真实模型名"}
              />
              <span className="field-hint">每行一条，把下游请求的模型名改写成上游的。</span>
            </label>

            <label className="field">
              <span className="field-label">思考强度映射</span>
              <textarea
                rows={2}
                value={form.effortMappings}
                onChange={(event) => set("effortMappings", event.target.value)}
                placeholder={"max: xhigh"}
              />
              <span className="field-hint">没有对应条目的强度原样转发。</span>
            </label>

            <label className="field">
              <span className="field-label">额外请求头</span>
              <textarea
                rows={2}
                value={form.extraHeaders}
                onChange={(event) => set("extraHeaders", event.target.value)}
                placeholder={"x-tenant: acme"}
              />
            </label>

            <label className="field">
              <span className="field-label">限速</span>
              <input
                value={form.rateLimit}
                onChange={(event) => set("rateLimit", event.target.value)}
                placeholder="100/m"
                autoComplete="off"
              />
              <span className="field-hint">留空表示不限速。</span>
            </label>
          </div>
        </details>

        <div className="modal-actions">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={!canSubmit || busy}>
            {busy ? "保存中…" : "保存"}
          </button>
        </div>
      </form>
    </dialog>
  );
}
