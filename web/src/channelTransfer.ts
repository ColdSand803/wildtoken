import type { ChannelExportDocument } from "./types";
export const CHANNEL_DOCUMENT_KIND = "wildtoken.channels";
export const CHANNEL_DOCUMENT_VERSION = 1;
export function parseChannelImportDocument(text: string): ChannelExportDocument {
  const raw = text.trim();
  if (!raw) throw new Error("请选择文件或粘贴 JSON 内容。");
  if (new TextEncoder().encode(raw).length > 2 * 1024 * 1024) throw new Error("文档过大，请拆分后导入。");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new Error("不是合法的 JSON。"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("文档顶层必须是 JSON 对象。");
  const doc = parsed as Partial<ChannelExportDocument>;
  if (doc.kind !== undefined && doc.kind !== CHANNEL_DOCUMENT_KIND) throw new Error("这不是渠道导出文件。");
  if (doc.version !== undefined && (!Number.isInteger(doc.version) || doc.version < 1 || doc.version > CHANNEL_DOCUMENT_VERSION)) throw new Error("不支持的渠道文档版本。");
  if (!Array.isArray(doc.channels) || !doc.channels.length || doc.channels.length > 500) throw new Error("channels 必须包含 1 到 500 个渠道。");
  for (const item of doc.channels) {
    if (!item || typeof item !== "object" || Array.isArray(item) || typeof item.name !== "string" || !item.name.trim() || typeof item.base_url !== "string" || !item.base_url.trim()) throw new Error("每个渠道必须包含 name 和 base_url。");
  }
  return { kind: CHANNEL_DOCUMENT_KIND, version: CHANNEL_DOCUMENT_VERSION, channels: doc.channels };
}
export function formatUpstreamClipboardText(detail: { base_url?: string; api_key?: string | null }): string {
  return `baseURL: ${detail.base_url ?? ""}\napiKey: ${detail.api_key ?? ""}`;
}
