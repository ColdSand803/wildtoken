import type { DraftKey, Upstream } from "../types";
import { keyRowsFrom, keysPayload } from "../keyRows";
import type { KeyPayload, KeyRow } from "../keyRows";
import { joinMappingLines, parseMappingLines } from "../mappingLines";
import { useUpstreamEditor } from "../useUpstreamEditor";
import type { UpstreamEditorProps } from "../useUpstreamEditor";
import { UpstreamEditorLayout } from "./UpstreamEditorLayout";

export interface UpstreamPayload {
  name: string;
  base_url: string;
  keys: KeyPayload[];
  model_names: string[];
  model_prefixes: string[];
  model_mappings: Record<string, string>;
  effort_mappings: Record<string, string>;
  priority: number;
  weight: number;
  auto_weight_enabled: boolean;
  timeout_seconds: number | null;
  enabled: boolean;
  extra_headers: Record<string, string>;
  rate_limit: string | null;
  group_ids: number[];
}

const DEFAULT_GROUP_ID = 1;

function requiredNumber(value: string, label: string): number {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error(`${label}不能为空。`);
  const parsed = Number(trimmed);
  if (!Number.isFinite(parsed)) throw new Error(`${label}必须是数字。`);
  return parsed;
}

function splitList(value: string): string[] {
  const seen = new Set<string>();
  for (const part of value.split(/[,，\n]/)) {
    const trimmed = part.trim();
    if (trimmed) seen.add(trimmed);
  }
  return [...seen];
}

const NON_OVERRIDABLE_HEADERS = new Set([
  "connection", "keep-alive", "transfer-encoding", "host", "content-length", "te", "trailer", "upgrade",
  "proxy-authorization", "proxy-authenticate", "x-wildtoken-upstream",
]);
const HEADER_NAME_PATTERN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

function addHeader(result: Record<string, string>, name: string, value: string): void {
  if (!HEADER_NAME_PATTERN.test(name)) throw new Error(`Header 名无效：${name || "（空）"}`);
  if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) throw new Error(`Header ${name} 的值包含非法控制字符。`);
  const normalized = name.toLowerCase();
  if (NON_OVERRIDABLE_HEADERS.has(normalized)) throw new Error(`Header ${name} 属于传输或内部路由头，不能覆盖。`);
  if (Object.hasOwn(result, normalized)) throw new Error(`Header 名大小写重复：${name}`);
  result[normalized] = value;
}

function parseHeaderLines(value: string): Record<string, string> {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "{}") return {};
  const result: Record<string, string> = {};
  if (trimmed.startsWith("{")) {
    let parsed: unknown;
    try { parsed = JSON.parse(trimmed); }
    catch { throw new Error("Header JSON 格式无效，也可以使用每行“名称: 值”的写法。"); }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("JSON 写法必须是由 Header 名和字符串值组成的对象。");
    for (const [name, headerValue] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof headerValue !== "string") throw new Error(`Header ${name} 的值必须是字符串。`);
      addHeader(result, name.trim(), headerValue);
    }
    return result;
  }
  for (const [index, raw] of trimmed.split("\n").entries()) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || line.startsWith("//")) continue;
    const colon = line.indexOf(":");
    if (colon === -1) throw new Error(`第 ${index + 1} 行缺少冒号，请使用“名称: 值”。`);
    const name = line.slice(0, colon).trim(), headerValue = line.slice(colon + 1).trim();
    if (!headerValue) throw new Error(`Header ${name} 没有值。`);
    addHeader(result, name, headerValue);
  }
  return result;
}

function joinHeaderLines(headers: Record<string, string>): string {
  return Object.entries(headers).map(([name, value]) => `${name}: ${value}`).join("\n");
}

export interface FormState {
  name: string;
  baseUrl: string;
  keys: KeyRow[];
  groupIds: number[];
  modelNames: string[];
  manual: string;
  modelMappings: string;
  modelPrefixes: string;
  priority: string;
  weight: string;
  timeoutSeconds: string;
  enabled: boolean;
  fixedWeight: boolean;
  extraHeaders: string;
  effortMappings: string;
  rateLimit: string;
}

function emptyForm(): FormState {
  return {
    name: "", baseUrl: "", keys: keyRowsFrom(null), groupIds: [DEFAULT_GROUP_ID], modelNames: [], manual: "",
    modelMappings: "", modelPrefixes: "", priority: "100", weight: "100", timeoutSeconds: "",
    enabled: true, fixedWeight: true, extraHeaders: "", effortMappings: "", rateLimit: "",
  };
}

function formFromUpstream(upstream: Upstream, draftKeys?: DraftKey[]): FormState {
  return {
    name: upstream.name, baseUrl: upstream.base_url, keys: keyRowsFrom(upstream, draftKeys),
    groupIds: upstream.group_ids.length > 0 ? upstream.group_ids : [DEFAULT_GROUP_ID],
    modelNames: upstream.model_names, manual: "", modelMappings: joinMappingLines(upstream.model_mappings ?? {}),
    modelPrefixes: upstream.model_prefixes.join(","), priority: String(upstream.priority), weight: String(upstream.weight),
    timeoutSeconds: upstream.timeout_seconds > 0 ? String(upstream.timeout_seconds) : "",
    enabled: upstream.enabled, fixedWeight: !upstream.auto_weight_enabled,
    extraHeaders: joinHeaderLines(upstream.extra_headers ?? {}), effortMappings: joinMappingLines(upstream.effort_mappings ?? {}),
    rateLimit: upstream.rate_limit ?? "",
  };
}

function payloadFromForm(form: FormState): UpstreamPayload {
  return {
    name: form.name.trim(),
    base_url: form.baseUrl.trim(),
    keys: keysPayload(form.keys),
    model_names: form.modelNames,
    model_prefixes: splitList(form.modelPrefixes),
    model_mappings: parseMappingLines(form.modelMappings, "模型映射"),
    effort_mappings: Object.fromEntries(Object.entries(parseMappingLines(form.effortMappings, "思考强度映射")).map(([key, value]) => [key.toLowerCase(), value])),
    priority: requiredNumber(form.priority, "优先级"),
    weight: requiredNumber(form.weight, "基础权重"),
    auto_weight_enabled: !form.fixedWeight,
    timeout_seconds: form.timeoutSeconds.trim() === "" ? 0 : Number(form.timeoutSeconds),
    enabled: form.enabled,
    extra_headers: parseHeaderLines(form.extraHeaders),
    rate_limit: form.rateLimit.trim() || null,
    group_ids: form.groupIds,
  };
}

const helpers = { emptyForm, formFromUpstream, payloadFromForm, parseHeaderLines };

export function UpstreamDialog(props: UpstreamEditorProps) {
  const editor = useUpstreamEditor(props, helpers);
  return <UpstreamEditorLayout {...props} editor={editor} />;
}
