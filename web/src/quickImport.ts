export interface QuickImportUrlCandidate {
  value: string;
  label: string;
  score: number;
  trimmedEndpoint: boolean;
}

export interface QuickImportKeyCandidate {
  value: string;
  line: number;
}

export interface QuickImportCandidates {
  urls: QuickImportUrlCandidate[];
  keys: QuickImportKeyCandidate[];
  name: string;
}

export interface QuickImportConnection {
  baseUrl: string;
  apiKey: string;
}

export function isQuickImportUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value.trim()).protocol);
  } catch {
    return false;
  }
}

/** 摘要不显示 URL 中的认证信息和查询参数，实际提交值不变。 */
export function quickImportUrlLabel(value: string): string {
  try {
    const url = new URL(value);
    return url.origin + (url.pathname === "/" ? "" : url.pathname);
  } catch {
    return "未设置有效地址";
  }
}

export function maskQuickImportKey(value: string): string {
  return value ? `••••••••${value.slice(-4)}` : "未提供";
}

export function suggestQuickImportName(value: string): string {
  try {
    const host = new URL(value).hostname;
    const parts = host.split(".");
    if (parts.length > 1) parts.pop();
    return parts.filter((part) => !["api", "www", "gateway"].includes(part)).join("-") || host;
  } catch {
    return "";
  }
}

export function sameQuickImportConnection(a: QuickImportConnection, b: QuickImportConnection): boolean {
  return a.baseUrl.trim() === b.baseUrl.trim() && a.apiKey.trim() === b.apiKey.trim();
}

function normalizeUrl(value: string): QuickImportUrlCandidate {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("不是 HTTP 地址");
  const originalPath = url.pathname;
  // /proxy/v1/chat/completions → /proxy/v1，不丢网关的挂载路径。
  if (/\/v1(?:\/|$)/i.test(url.pathname)) {
    url.pathname = url.pathname.replace(/\/(?:chat\/completions|responses|messages|models)\/?$/i, "") || "/";
  }
  const trimmedEndpoint = originalPath !== url.pathname;
  url.hash = "";
  const normalized = url.pathname === "/" && !url.search ? url.href.slice(0, -1) : url.href;
  return {
    value: normalized,
    label: quickImportUrlLabel(normalized),
    score: (/\/v1(?:\/|$)/i.test(url.pathname) ? 4 : 0) + (/api/i.test(url.hostname) ? 2 : 0),
    trimmedEndpoint,
  };
}

export function parseQuickImportCandidates(raw: string): QuickImportCandidates {
  if (raw.length > 65_536) throw new Error("原文过长，请只保留一个渠道的连接信息。");
  const source = raw.replace(/\\\//g, "/");
  const urls = new Map<string, QuickImportUrlCandidate>();
  for (const match of source.matchAll(/https?:\/\/[^\s"'<>()[\]“”，、；]+/g)) {
    try {
      const candidate = normalizeUrl(match[0].replace(/[.,;:)\]}"'，。；、]+$/, ""));
      if (!urls.has(candidate.value)) urls.set(candidate.value, candidate);
    } catch {
      // 无效地址留给用户手动修正，不拿残缺字符串发请求。
    }
  }

  const keys = new Map<string, QuickImportKeyCandidate>();
  const addKey = (value: string, index: number) => {
    if (/^(?:YOUR_|REPLACE_|EXAMPLE_|sk-x{8,}$)/i.test(value) || keys.has(value)) return;
    keys.set(value, { value, line: source.slice(0, index).split("\n").length });
  };
  for (const match of source.matchAll(/sk-[a-zA-Z0-9_-]{16,}(?![a-zA-Z0-9._~+\/=-])/g)) addKey(match[0], match.index);
  for (const pattern of [
    /\bBearer\s+["']?([a-zA-Z0-9._~+\/=-]{12,})/gi,
    /\b(?:x-api-key|api[ _-]?key)\b["']?\s*[:：=]\s*["']?([a-zA-Z0-9._~+\/=-]{12,})/gi,
  ]) {
    for (const match of source.matchAll(pattern)) addKey(match[1], match.index);
  }

  let name = source.match(/(?:^|\n)\s*(?:渠道名称|名称|name)\s*[:：=]\s*["']?([^\n"']+)/i)?.[1]?.trim() ?? "";
  if (!name && raw.trim().startsWith("{")) {
    try {
      const value: unknown = JSON.parse(raw);
      if (value && typeof value === "object" && Object.hasOwn(value, "name")) {
        const candidate = (value as { name?: unknown }).name;
        if (typeof candidate === "string") name = candidate.trim();
      }
    } catch {
      // 混合文本不要求是完整 JSON，仍可使用上面的地址和 Key 候选。
    }
  }
  return {
    urls: [...urls.values()].sort((a, b) => b.score - a.score),
    keys: [...keys.values()].sort((a, b) => a.line - b.line),
    name,
  };
}

/** 旧调用形状保留；有歧义时不代替用户选地址或 Key。 */
export function parseQuickImport(raw: string): { baseUrl: string | null; apiKey: string | null } {
  const result = parseQuickImportCandidates(raw);
  return {
    baseUrl: result.urls.length === 1 ? result.urls[0].value : null,
    apiKey: result.keys.length === 1 ? result.keys[0].value : null,
  };
}

export function readQuickImportModels(payload: unknown): string[] {
  const models = payload && typeof payload === "object" ? (payload as { models?: unknown }).models : undefined;
  if (!Array.isArray(models) || !models.every((model): model is string => typeof model === "string")) {
    throw new Error("返回中没有有效的模型列表。");
  }
  return [...new Set(models.map((model) => model.trim()).filter(Boolean))];
}
