import { useEffect, useMemo, useState } from "react";

import { UnauthorizedError, fetchModelsPreview } from "../api";
import type { Upstream } from "../types";
import { ModelDialog, parseManualEntry } from "./ModelDialog";
import type { ModelSelection } from "./ModelDialog";
import { useToast } from "./feedback";
import { useDialog } from "../useDialog";

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

/** 一个渠道不选分组时归进这里。和后端的兜底一致。 */
const DEFAULT_GROUP_ID = 1;

/** 芯片预览最多显示几项，多的折成 +N。照抄旧版 FORM_MODEL_PREVIEW_LIMIT。 */
const PREVIEW_LIMIT = 6;

/** 逗号或换行分隔的列表，去空去重。 */
function splitList(value: string): string[] {
  const seen = new Set<string>();
  for (const part of value.split(/[,\n]/)) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

/**
 * 每行一条 `键 => 值`，也收 `=` 和 `:`。
 *
 * 三种分隔符都要认：旧控制台显示成 `a => b`，从那边复制过来的内容必须能
 * 原样吃下。只找第一个 `=` 的写法会把 `a => b` 切成 `a` 和 `> b`，而且
 * 不报错——这种错法在界面上完全看不出来。
 */
function parseMappingLines(value: string, label: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of value.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = trimmed.match(/^(.+?)(?:=>|=|:)(.+)$/);
    if (!match) throw new Error(`${label}格式错误：${trimmed}`);
    const key = match[1].trim();
    const mapped = match[2].trim();
    if (key && mapped) result[key] = mapped;
  }
  return result;
}

function joinMappingLines(mappings: Record<string, string>): string {
  return Object.entries(mappings)
    .map(([key, value]) => `${key} => ${value}`)
    .join("\n");
}

/* 传输层和内部路由用的头，覆盖它们会直接弄坏请求。后端也拦，但报回来只是
   一条 400；在这里拦能直接指出是哪一个头。 */
const NON_OVERRIDABLE_HEADERS = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "host",
  "content-length",
  "te",
  "trailer",
  "upgrade",
  "proxy-authorization",
  "proxy-authenticate",
  "x-wildtoken-upstream",
]);

/** RFC 7230 的 token 字符集。 */
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/** Header 覆盖是 JSON 对象，和旧控制台同一种写法。 */
function parseHeaderJSON(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`Header 覆盖不是合法 JSON：${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Header 覆盖必须是由 Header 名和字符串值组成的 JSON 对象。");
  }

  const result: Record<string, string> = {};
  for (const [name, headerValue] of Object.entries(parsed as Record<string, unknown>)) {
    if (!HEADER_NAME_PATTERN.test(name)) throw new Error(`Header 名无效：${name || "（空）"}`);
    if (typeof headerValue !== "string") throw new Error(`Header ${name} 的值必须是字符串。`);
    // 控制字符会把一个头拆成两个（响应拆分）。
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(headerValue)) {
      throw new Error(`Header ${name} 的值包含非法控制字符。`);
    }

    const normalized = name.toLowerCase();
    if (NON_OVERRIDABLE_HEADERS.has(normalized)) {
      throw new Error(`Header ${name} 属于传输或内部路由头，不能覆盖。`);
    }
    // 名字对 HTTP 来说不区大小写，写两遍只是后一个默默赢了。
    if (Object.hasOwn(result, normalized)) {
      throw new Error(`Header 名大小写重复：${name}`);
    }
    result[normalized] = headerValue;
  }
  return result;
}

interface FormState {
  name: string;
  baseUrl: string;
  apiKey: string;
  clearApiKey: boolean;
  groupIds: number[];
  modelNames: string[];
  modelMappings: Record<string, string>;
  /** 手动添加输入框里还没提交的文本。 */
  manual: string;
  modelPrefixes: string;
  priority: string;
  weight: string;
  timeoutSeconds: string;
  enabled: boolean;
  /* UI 上是「固定权重」，提交时取反才是 auto_weight_enabled。
     这个反转最容易搬错，所以状态里就按 UI 的说法存。 */
  fixedWeight: boolean;
  extraHeaders: string;
  effortMappings: string;
  rateLimit: string;
}

function emptyForm(): FormState {
  return {
    name: "",
    baseUrl: "",
    apiKey: "",
    clearApiKey: false,
    groupIds: [DEFAULT_GROUP_ID],
    modelNames: [],
    modelMappings: {},
    manual: "",
    modelPrefixes: "",
    priority: "100",
    weight: "100",
    timeoutSeconds: "300",
    enabled: true,
    fixedWeight: false,
    extraHeaders: "{}",
    effortMappings: "",
    rateLimit: "",
  };
}

function formFromUpstream(upstream: Upstream): FormState {
  return {
    name: upstream.name,
    baseUrl: upstream.base_url,
    apiKey: "",
    clearApiKey: false,
    groupIds: upstream.group_ids.length > 0 ? upstream.group_ids : [DEFAULT_GROUP_ID],
    modelNames: upstream.model_names,
    modelMappings: upstream.model_mappings ?? {},
    manual: "",
    modelPrefixes: upstream.model_prefixes.join(","),
    priority: String(upstream.priority),
    weight: String(upstream.weight),
    timeoutSeconds: String(upstream.timeout_seconds),
    enabled: upstream.enabled,
    fixedWeight: !upstream.auto_weight_enabled,
    extraHeaders: JSON.stringify(upstream.extra_headers ?? {}, null, 2),
    effortMappings: joinMappingLines(upstream.effort_mappings ?? {}),
    rateLimit: upstream.rate_limit ?? "",
  };
}

/** 抛出的错误由调用方接住展示。解析失败不该变成一次半截的保存。 */
function payloadFromForm(form: FormState): UpstreamPayload {
  return {
    name: form.name.trim(),
    base_url: form.baseUrl.trim(),
    api_key: form.apiKey.trim() || null,
    model_names: form.modelNames,
    model_prefixes: splitList(form.modelPrefixes),
    model_mappings: form.modelMappings,
    // 思考强度不区分大小写，键转小写存——后端存的也是小写。
    effort_mappings: Object.fromEntries(
      Object.entries(parseMappingLines(form.effortMappings, "思考强度映射")).map(([key, value]) => [
        key.toLowerCase(),
        value,
      ]),
    ),
    priority: Number(form.priority || 100),
    weight: Number(form.weight || 100),
    // UI 勾的是「固定权重」，后端要的是「自动权重」。
    auto_weight_enabled: !form.fixedWeight,
    timeout_seconds: Number(form.timeoutSeconds || 300),
    enabled: form.enabled,
    extra_headers: parseHeaderJSON(form.extraHeaders),
    rate_limit: form.rateLimit.trim() || null,
    clear_api_key: form.clearApiKey,
    group_ids: form.groupIds,
  };
}

/** 已选模型与映射的芯片预览，每个都能就地摘掉。 */
function SelectionPreview({
  names,
  mappings,
  onRemoveName,
  onRemoveMapping,
}: {
  names: string[];
  mappings: Record<string, string>;
  onRemoveName: (name: string) => void;
  onRemoveMapping: (key: string) => void;
}) {
  const entries = Object.entries(mappings);
  const total = names.length + entries.length;

  if (total === 0) {
    return (
      <div className="model-selection-preview" aria-live="polite">
        <span className="model-selection-empty">未配置精确模型</span>
      </div>
    );
  }

  // 映射排在前面，和旧版一致：它们改写请求，比单纯的名字匹配更需要被看见。
  const chips: Array<{ key: string; label: string; mapping: boolean }> = [
    ...entries.map(([key, value]) => ({ key, label: `${key} => ${value}`, mapping: true })),
    ...names.map((name) => ({ key: name, label: name, mapping: false })),
  ];
  const visible = chips.slice(0, PREVIEW_LIMIT);
  const hidden = chips.length - visible.length;

  return (
    <div className="model-selection-preview" aria-live="polite">
      {visible.map((chip) => (
        <span
          key={`${chip.mapping ? "m" : "n"}:${chip.key}`}
          className={chip.mapping ? "model-selection-chip is-mapping" : "model-selection-chip"}
          title={chip.label}
        >
          <span className="model-selection-chip-name">{chip.label}</span>
          <button
            type="button"
            className="model-selection-remove"
            aria-label={`移除${chip.mapping ? "映射" : "模型"} ${chip.label}`}
            title={`移除${chip.mapping ? "映射" : "模型"} ${chip.label}`}
            onClick={() => (chip.mapping ? onRemoveMapping(chip.key) : onRemoveName(chip.key))}
          >
            ×
          </button>
        </span>
      ))}
      {hidden > 0 ? (
        <span className="model-selection-more" title={`还有 ${hidden} 项`}>{`+${hidden}`}</span>
      ) : null}
    </div>
  );
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
  /* catalog 为 null 表示「没拉取，只是来管理已选」。整块跟着一个对象走，
     否则它们每次渲染都是新引用，会把选择器里的状态不断重置。 */
  const [picker, setPicker] = useState<{ catalog: string[] | null; selection: ModelSelection } | null>(
    null,
  );
  const [fetching, setFetching] = useState(false);
  const dialogRef = useDialog(open, onClose);
  const toast = useToast();

  /* 每次打开都按当前渠道重置。不重置的话，关掉再开会留着上一个渠道的值。 */
  useEffect(() => {
    if (!open) return;
    setForm(upstream ? formFromUpstream(upstream) : emptyForm());
    // 配过高级项的渠道直接展开，否则那些值藏起来像丢了。
    setAdvanced(
      Boolean(
        upstream &&
          (Object.keys(upstream.effort_mappings ?? {}).length ||
            Object.keys(upstream.extra_headers ?? {}).length ||
            upstream.rate_limit),
      ),
    );
  }, [open, upstream]);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((current) => ({ ...current, [key]: value }));

  /**
   * 把手动输入框里的内容并进选择。
   *
   * 保存时也要先走一遍：框里还留着字就点保存，那些字应该算数，而不是被
   * 悄悄丢掉。
   */
  function commitManual(current: FormState): FormState {
    const parsed = parseManualEntry(current.manual);
    const mappingKeys = Object.keys(parsed.mappings);
    if (parsed.names.length === 0 && mappingKeys.length === 0) return current;
    return {
      ...current,
      modelNames: [...new Set([...current.modelNames, ...parsed.names])],
      modelMappings: { ...current.modelMappings, ...parsed.mappings },
      manual: "",
    };
  }

  function addManual() {
    setForm((current) => {
      const next = commitManual(current);
      if (next === current) return current;
      const added =
        next.modelNames.length - current.modelNames.length +
        (Object.keys(next.modelMappings).length - Object.keys(current.modelMappings).length);
      toast(added > 0 ? `已添加 ${added} 项，保存渠道后生效。` : "输入的内容都已在列表中。", {
        tone: added > 0 ? "ok" : "neutral",
      });
      return next;
    });
  }

  /** 当前表单里的选择，开选择器时带进去。 */
  function currentSelection(state: FormState): ModelSelection {
    return { names: state.modelNames, mappings: state.modelMappings };
  }

  /**
   * 拿哪把 Key 去探上游。
   *
   * 输入框留空意思是「保持不变」，此时要用已存的那把；勾了清除就真的不带。
   * 不这么判的话，编辑一个已配好的渠道时点拉取总是拿不到模型。
   */
  function probeApiKey(): string | null {
    if (form.clearApiKey) return null;
    return form.apiKey.trim() || upstream?.api_key || null;
  }

  async function fetchCatalog() {
    const baseUrl = form.baseUrl.trim();
    if (!baseUrl) {
      toast("请先填写 Base URL 再拉取模型。", { tone: "error" });
      return;
    }

    let headers: Record<string, string>;
    try {
      headers = parseHeaderJSON(form.extraHeaders);
    } catch (err) {
      setAdvanced(true);
      toast(err instanceof Error ? err.message : String(err), { tone: "error" });
      return;
    }

    setFetching(true);
    try {
      const result = await fetchModelsPreview(baseUrl, probeApiKey(), {
        extraHeaders: headers,
        timeoutSeconds: Number(form.timeoutSeconds || 300),
      });
      setForm((current) => {
        const next = commitManual(current);
        setPicker({ catalog: result.models, selection: currentSelection(next) });
        return next;
      });
      toast(`已拉取 ${result.models.length} 个模型。`, { tone: "ok" });
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        toast(`拉取模型失败：${err instanceof Error ? err.message : String(err)}`, { tone: "error" });
      }
    } finally {
      setFetching(false);
    }
  }

  function openManager() {
    setForm((current) => {
      const next = commitManual(current);
      setPicker({ catalog: null, selection: currentSelection(next) });
      return next;
    });
  }

  /* 选择器只写回表单，不碰服务端——这个渠道可能还没存下来。 */
  function applySelection(next: ModelSelection) {
    setForm((current) => ({ ...current, modelNames: next.names, modelMappings: next.mappings }));
    setPicker(null);
  }

  function submit() {
    const committed = commitManual(form);
    let payload: UpstreamPayload;
    try {
      payload = payloadFromForm(committed);
    } catch (err) {
      // 解析失败的两项都在高级区，收着的话看不到错在哪。
      setAdvanced(true);
      toast(err instanceof Error ? err.message : String(err), { tone: "error" });
      return;
    }
    setForm(committed);
    onSubmit(payload);
  }

  const title = upstream ? `编辑渠道 #${upstream.id}` : "新增渠道";
  const canSubmit = useMemo(
    () => form.name.trim() !== "" && form.baseUrl.trim() !== "",
    [form.name, form.baseUrl],
  );
  const selectionCount = form.modelNames.length + Object.keys(form.modelMappings).length;

  return (
    <dialog className="upstream-dialog" ref={dialogRef} onCancel={onClose}>
      <form
        className="upstream-dialog-panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (!canSubmit || busy) return;
          submit();
        }}
      >
        <div className="modal-head upstream-modal-head">
          <div>
            <h2>{title}</h2>
            <p>配置路由可用的上游渠道。</p>
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

        <div className="upstream-dialog-body">
          <section className="form-section">
            <div className="form-section-head">
              <div>
                <h3>基础信息</h3>
                <p>名称、接口地址与密钥。</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="field">
                <span className="field-label">名称</span>
                <input
                  value={form.name}
                  onChange={(event) => set("name", event.target.value)}
                  required
                  maxLength={80}
                  placeholder="openai"
                  autoComplete="off"
                />
              </label>

              <label className="field span-2">
                <span className="field-label">Base URL</span>
                <input
                  value={form.baseUrl}
                  onChange={(event) => set("baseUrl", event.target.value)}
                  required
                  placeholder="https://api.openai.com 或 https://host/v1"
                  autoComplete="off"
                />
                <span className="field-hint">支持根地址或已包含 /v1 的地址。</span>
              </label>

              <label className="field span-2">
                <span className="field-label">API Key</span>
                <input
                  type="password"
                  value={form.apiKey}
                  onChange={(event) => set("apiKey", event.target.value)}
                  placeholder={upstream?.api_key_set ? "留空保持不变" : "未配置时留空"}
                  autoComplete="off"
                  spellCheck={false}
                />
                <span className="field-hint">留空保持原有密钥；复制渠道需重新填写。</span>
              </label>

              <div className="field span-2">
                <span className="field-label">分组</span>
                <div className="group-checklist">
                  {groups.map((group) => (
                    <label key={group.id} className="group-checkbox">
                      <input
                        type="checkbox"
                        value={group.id}
                        checked={form.groupIds.includes(group.id)}
                        onChange={(event) =>
                          set(
                            "groupIds",
                            event.target.checked
                              ? [...form.groupIds, group.id]
                              : form.groupIds.filter((id) => id !== group.id),
                          )
                        }
                      />{" "}
                      <span>{group.name}</span>
                    </label>
                  ))}
                </div>
                <span className="field-hint">
                  可同时加入多个分组；不选则归入 default。只有同分组的令牌能路由到本渠道。
                </span>
              </div>

              {upstream?.api_key_set ? (
                <div className="toggle-list span-2">
                  <label className="toggle-row span-2">
                    <input
                      type="checkbox"
                      checked={form.clearApiKey}
                      onChange={(event) => set("clearApiKey", event.target.checked)}
                    />
                    <span>
                      <strong>清空 API Key</strong>
                      <small>保存后会移除当前渠道密钥。</small>
                    </span>
                  </label>
                </div>
              ) : null}
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <div>
                <h3>模型路由</h3>
                <p>精确模型、前缀与名称映射。</p>
              </div>
              <div className="form-section-head-actions">
                <button type="button" className="secondary" onClick={openManager}>
                  管理模型
                </button>
                <button
                  type="button"
                  className="secondary"
                  disabled={fetching}
                  onClick={() => void fetchCatalog()}
                >
                  {fetching ? "拉取中…" : "拉取模型"}
                </button>
              </div>
            </div>
            <div className="form-grid">
              <div className="field span-2">
                <div className="model-picker-label-row">
                  <span className="field-label">模型名</span>
                  <span className="model-selection-count">
                    {selectionCount > 0 ? `${selectionCount} 项` : "未选择"}
                  </span>
                </div>
                <div className="model-picker" aria-label="已选模型">
                  <SelectionPreview
                    names={form.modelNames}
                    mappings={form.modelMappings}
                    onRemoveName={(name) =>
                      set(
                        "modelNames",
                        form.modelNames.filter((item) => item !== name),
                      )
                    }
                    onRemoveMapping={(key) =>
                      set(
                        "modelMappings",
                        Object.fromEntries(
                          Object.entries(form.modelMappings).filter(([item]) => item !== key),
                        ),
                      )
                    }
                  />
                </div>
                <div className="model-manual-entry">
                  <div className="model-manual-entry-body">
                    <label className="field">
                      <span className="field-label">手动添加</span>
                      <input
                        type="text"
                        spellCheck={false}
                        placeholder="gpt-5.5 claude-sonnet-5 或 gpt-5.5 => grok-4.5"
                        value={form.manual}
                        onChange={(event) => set("manual", event.target.value)}
                        onKeyDown={(event) => {
                          // 回车是「添加」，不是提交整个表单。
                          if (event.key !== "Enter") return;
                          event.preventDefault();
                          addManual();
                        }}
                      />
                    </label>
                    <button type="button" className="secondary" onClick={addManual}>
                      添加
                    </button>
                  </div>
                </div>
                <span className="field-hint">
                  精确匹配所选模型；也可以只配置模型前缀。多个模型名用空白分隔，回车快速添加；写成
                  「下游 =&gt; 渠道」则登记为映射，命中后把请求里的模型名替换为渠道模型名。
                </span>
              </div>

              <label className="field span-2">
                <span className="field-label">模型前缀</span>
                <input
                  value={form.modelPrefixes}
                  onChange={(event) => set("modelPrefixes", event.target.value)}
                  placeholder="gpt-,claude-"
                  autoComplete="off"
                />
                <span className="field-hint">多个前缀用逗号分隔。</span>
              </label>
            </div>
          </section>

          <section className="form-section">
            <div className="form-section-head">
              <div>
                <h3>运行设置</h3>
                <p>硬优先级、同层权重、超时与启用状态。</p>
              </div>
            </div>
            <div className="form-grid">
              <label className="field">
                <span className="field-label">优先级</span>
                <input
                  type="number"
                  min={0}
                  max={100000}
                  value={form.priority}
                  onChange={(event) => set("priority", event.target.value)}
                />
                <span className="field-hint">数字越大越优先；高优先级不会与低优先级混合分流。</span>
              </label>

              <label className="field">
                <span className="field-label">基础权重</span>
                <input
                  type="number"
                  min={0}
                  max={10000}
                  required
                  value={form.weight}
                  onChange={(event) => set("weight", event.target.value)}
                />
                <span className="field-hint">
                  动态时作为有效权重上限；固定时直接作为路由权重；0 表示不参与池内路由。
                </span>
              </label>

              <label className="field">
                <span className="field-label">超时秒数</span>
                <input
                  type="number"
                  min={1}
                  max={3600}
                  value={form.timeoutSeconds}
                  onChange={(event) => set("timeoutSeconds", event.target.value)}
                />
              </label>

              <div className="toggle-list span-2">
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={form.enabled}
                    onChange={(event) => set("enabled", event.target.checked)}
                  />
                  <span>
                    <strong>启用</strong>
                    <small>保存后参与路由选择。</small>
                  </span>
                </label>
                <label className="toggle-row">
                  <input
                    type="checkbox"
                    checked={form.fixedWeight}
                    onChange={(event) => set("fixedWeight", event.target.checked)}
                  />
                  <span>
                    <strong>固定权重</strong>
                    <small>选中后始终使用基础权重；未选中时按失败、成功和恢复动态调整有效权重。</small>
                  </span>
                </label>
              </div>
            </div>
          </section>

          <details
            className="form-section form-section-collapsible"
            open={advanced}
            onToggle={(event) => setAdvanced(event.currentTarget.open)}
          >
            <summary>
              <span>
                <span className="section-title">高级设置</span>
                <span className="section-copy">Header 覆盖 JSON、思考强度映射与限速</span>
              </span>
              <span className="section-summary-state" aria-hidden="true" />
            </summary>

            <label className="field">
              <span className="field-label">Header 覆盖（JSON）</span>
              <textarea
                rows={5}
                spellCheck={false}
                value={form.extraHeaders}
                onChange={(event) => set("extraHeaders", event.target.value)}
                placeholder={'{"User-Agent":"WildToken/1.0"}'}
              />
              <span className="field-hint">
                Header 名大小写不敏感；这里的值最后写入，可覆盖下游请求头和渠道 API Key 生成的认证头。
              </span>
            </label>

            <label className="field">
              <span className="field-label">思考强度映射（可选）</span>
              <textarea
                rows={3}
                spellCheck={false}
                value={form.effortMappings}
                onChange={(event) => set("effortMappings", event.target.value)}
                placeholder={"max => xhigh\nxhigh => high"}
              />
              <span className="field-hint">
                每行一条「下游 =&gt; 渠道」，用于上游不支持某个思考强度时改写。未列出的强度原样转发。
              </span>
            </label>

            <label className="field">
              <span className="field-label">限速（可选）</span>
              <input
                value={form.rateLimit}
                onChange={(event) => set("rateLimit", event.target.value)}
                maxLength={24}
                placeholder="留空则不限速，如 100/m、1000/h、50/10s"
                autoComplete="off"
                spellCheck={false}
              />
              <span className="field-hint">
                格式为 次数/时间窗口，单位支持 s/m/h/d。被限速的渠道会在路由时被跳过。
              </span>
            </label>
          </details>
        </div>

        <div className="modal-footer">
          <button type="button" className="secondary" onClick={onClose}>
            取消
          </button>
          <button type="submit" disabled={!canSubmit || busy}>
            {busy ? "保存中…" : "保存渠道"}
          </button>
        </div>
      </form>

      {/* 嵌在渠道对话框里。两个 modal dialog 叠在 top layer 上，选择器在上面。 */}
      {picker ? (
        <ModelDialog
          open
          channelName={form.name.trim() || "当前渠道"}
          catalog={picker.catalog}
          selection={picker.selection}
          busy={false}
          onSave={applySelection}
          onClose={() => setPicker(null)}
        />
      ) : null}
    </dialog>
  );
}
