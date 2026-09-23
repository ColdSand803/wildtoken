export function parseAllowedModelsInput(raw: string | string[] | null | undefined): { ok: true; allowedModels: string[] } | { ok: false; error: string } {
  if (raw === null || raw === undefined) {
    return { ok: true, allowedModels: [] };
  }
  const text = Array.isArray(raw) ? raw.join("\n") : String(raw);
  const trimmed = text.trim();
  if (!trimmed) {
    return { ok: true, allowedModels: [] };
  }

  const entries = text
    .split(/[\n,]+/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (entries.length > 200) {
    return { ok: false, error: "允许模型最多支持配置 200 项。" };
  }

  const seen = new Set();
  const allowedModels: string[] = [];

  for (const entry of entries) {
    if (entry.length > 200) {
      return { ok: false, error: `模型名称「${entry.slice(0, 20)}...」过长，单个模型最多 200 字符。` };
    }
    if (/[\x00-\x1f\x7f]/.test(entry)) {
      return { ok: false, error: "模型名称不能包含不可见控制字符。" };
    }
    const withoutTrailingStars = entry.replace(/\*+$/, "");
    if (withoutTrailingStars.includes("*")) {
      return {
        ok: false,
        error: `模型规则「${entry}」无效：通配符仅支持作为尾缀使用（例如 claude-3-*），不支持内部通配。`,
      };
    }

    const normalized = entry.toLowerCase();
    if (!seen.has(normalized)) {
      seen.add(normalized);
      allowedModels.push(entry);
    }
  }

  return { ok: true, allowedModels };
}

export const QUOTA_PERIOD_LABELS: Record<string, string> = { none: "不自动重置", daily: "每日", weekly: "每周", monthly: "每月" };
