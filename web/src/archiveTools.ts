export interface ConfigArchive { kind: "wildtoken.config"; encryption?: unknown; [key: string]: unknown }
export function parseConfigArchive(text: string): ConfigArchive {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("该文件不是 JSON 配置归档。"); }
  if (!value || typeof value !== "object" || !("kind" in value) || value.kind !== "wildtoken.config") throw new Error("该文件不是 WildToken 配置归档；数据库备份请使用灾备恢复。");
  return value as ConfigArchive;
}
export function bytesToBase64(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 0x8000) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 0x8000)));
  return btoa(chunks.join(""));
}
export const BACKUP_MAGIC = `WTBAK1${String.fromCharCode(0, 0)}`;
export const MAX_BACKUP_HEADER_BYTES = 64 * 1024;
export function parseBackup(bytes: Uint8Array): { header: Record<string, unknown>; archive: string } {
  if (bytes.length < 12 || String.fromCharCode(...bytes.subarray(0, 8)) !== BACKUP_MAGIC) throw new Error("该文件不是 WildToken 数据库备份；配置归档请使用配置迁移。");
  const length = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, false);
  if (!length || length > MAX_BACKUP_HEADER_BYTES || 12 + length > bytes.length) throw new Error("备份文件头长度不合法。");
  let header: Record<string, unknown>;
  try { header = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + length))); } catch { throw new Error("备份文件头无法解析。"); }
  if (!header || header.kind !== "wildtoken.backup") throw new Error("该文件不是 WildToken 数据库备份。");
  return { header, archive: bytesToBase64(bytes) };
}
export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url; anchor.download = filename; document.body.append(anchor);
  try { anchor.click(); } finally { anchor.remove(); setTimeout(() => URL.revokeObjectURL(url), 0); }
}
export function backupFileName(response: Response): string {
  const name = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1];
  return name ? name.replace(/[\\/:*?"<>|]/g, "_").slice(0, 180) : "wildtoken-backup.wtbak";
}
