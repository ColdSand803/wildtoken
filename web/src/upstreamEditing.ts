import { keysPayload } from "./keyRows";
import type { FormState } from "./components/UpstreamDialog";

export type UpstreamTab = "connection" | "models" | "traffic";
export type UpstreamErrors = Partial<Record<keyof FormState, string>>;
export interface UpstreamChange { field: keyof FormState; tab: UpstreamTab; label: string; before: string; after: string; note?: string }

export const UPSTREAM_FIELD_TABS: Record<keyof FormState, UpstreamTab> = {
  name: "connection", baseUrl: "connection", keys: "connection", extraHeaders: "connection", enabled: "connection",
  modelNames: "models", manual: "models", modelMappings: "models", modelPrefixes: "models", effortMappings: "models",
  groupIds: "traffic", priority: "traffic", weight: "traffic", fixedWeight: "traffic", timeoutSeconds: "traffic", rateLimit: "traffic",
};

const LABELS: Record<keyof FormState, string> = {
  name: "渠道名称", baseUrl: "接口地址", keys: "API Keys", extraHeaders: "额外请求头", enabled: "启用状态",
  modelNames: "精确模型", manual: "待添加模型", modelMappings: "模型映射", modelPrefixes: "前缀匹配", effortMappings: "思考强度映射",
  groupIds: "可访问分组", priority: "优先级", weight: "权重数值", fixedWeight: "权重模式", timeoutSeconds: "上游超时", rateLimit: "渠道限速",
};

function comparable(form: FormState, field: keyof FormState): unknown {
  if (field === "keys") return keysPayload(form.keys);
  if (field === "groupIds") return [...form.groupIds].sort((a, b) => a - b);
  if (field === "modelNames") return [...new Set(form.modelNames)].sort();
  if (field === "manual") return form.manual.trim();
  return form[field];
}

function description(form: FormState, field: keyof FormState, groups: Array<{ id: number; name: string }>): string {
  if (field === "keys") {
    const keys = keysPayload(form.keys);
    return `${keys.length} 把 · ${keys.filter((key) => key.enabled).length} 把启用`;
  }
  if (field === "extraHeaders") return form.extraHeaders.trim() ? "已配置" : "未配置";
  if (field === "baseUrl") {
    try { const url = new URL(form.baseUrl); return url.origin + (url.pathname === "/" ? "" : url.pathname); }
    catch { return form.baseUrl ? "地址待修正" : "未填写"; }
  }
  if (field === "enabled") return form.enabled ? "启用" : "停用";
  if (field === "fixedWeight") return form.fixedWeight ? "固定权重" : "随健康状态调整";
  if (field === "modelNames") return `${form.modelNames.length} 个模型`;
  if (field === "groupIds") return form.groupIds.length ? form.groupIds.map((id) => groups.find((group) => group.id === id)?.name ?? `#${id}`).join(", ") : "default";
  if (field === "timeoutSeconds") return !form.timeoutSeconds.trim() || Number(form.timeoutSeconds) === 0 ? "跟随全局默认" : `${form.timeoutSeconds} 秒`;
  if (field === "rateLimit") return form.rateLimit.trim() || "不限速";
  const value = String(form[field]);
  return value.length > 150 ? `${value.slice(0, 150)}…` : value || "未配置";
}

export function upstreamChanges(before: FormState, after: FormState, groups: Array<{ id: number; name: string }>): UpstreamChange[] {
  const changes: UpstreamChange[] = [];
  for (const field of Object.keys(LABELS) as Array<keyof FormState>) {
    if (JSON.stringify(comparable(before, field)) === JSON.stringify(comparable(after, field))) continue;
    let note: string | undefined;
    if (field === "keys") note = "密钥、备注或启用状态有变更，摘要不显示密钥值。";
    if (field === "extraHeaders") note = "请求头内容有变更，摘要不显示 Header 值。";
    if (field === "enabled" && !after.enabled) note = "保存后该渠道将不再参与路由。";
    if (field === "weight" && after.weight.trim() !== "" && Number(after.weight) === 0) note = "权重为 0，不参与池内路由。";
    if (field === "manual") note = "保存渠道时会校验并加入已选模型。";
    if (field === "modelNames") {
      const old = new Set(before.modelNames), next = new Set(after.modelNames);
      const added = after.modelNames.filter((name) => !old.has(name));
      const removed = before.modelNames.filter((name) => !next.has(name));
      const list = (names: string[]) => `${names.slice(0, 3).join(", ")}${names.length > 3 ? ` 等 ${names.length} 项` : ""}`;
      note = [added.length ? `新增：${list(added)}` : "", removed.length ? `移除：${list(removed)}` : ""].filter(Boolean).join("；");
    }
    changes.push({ field, tab: UPSTREAM_FIELD_TABS[field], label: LABELS[field], before: description(before, field, groups), after: description(after, field, groups), note });
  }
  return changes;
}

/** 明文显隐不改变连接身份，替换 Key 或 Header 才使目录过期。 */
export function upstreamConnectionStamp(form: FormState): string {
  return JSON.stringify([form.baseUrl.trim(), keysPayload(form.keys), form.extraHeaders, form.timeoutSeconds]);
}
