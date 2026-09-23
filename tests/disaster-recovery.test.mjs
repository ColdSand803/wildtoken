import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { h, loadTS, setupDOM, feedbackStub, jsonResponse } from "./react-harness.mjs";
const { BACKUP_MAGIC, parseBackup, bytesToBase64, backupFileName } = loadTS("web/src/archiveTools.ts");
function archiveBytes(header = { kind: "wildtoken.backup", schema_version: 1 }) { const encoded = new TextEncoder().encode(JSON.stringify(header)); const bytes = new Uint8Array(12 + encoded.length + 3); bytes.set(new TextEncoder().encode(BACKUP_MAGIC)); new DataView(bytes.buffer).setUint32(8, encoded.length, false); bytes.set(encoded, 12); return bytes; }
test("backup uses big-endian header length and preserves binary data", () => { const bytes = archiveBytes(); const value = parseBackup(bytes); assert.equal(value.header.kind, "wildtoken.backup"); assert.deepEqual(Buffer.from(value.archive, "base64"), Buffer.from(bytes)); });
for (const bytes of [new Uint8Array(0), new TextEncoder().encode('{"kind":"wildtoken.config"}'), archiveBytes({ kind: "wrong" })]) test(`bad backup is rejected before upload (${bytes.length} bytes)`, () => assert.throws(() => parseBackup(bytes)));
test("oversized and truncated headers are rejected", () => { const bytes = archiveBytes(); new DataView(bytes.buffer).setUint32(8, 65537, false); assert.throws(() => parseBackup(bytes)); new DataView(bytes.buffer).setUint32(8, 100, false); assert.throws(() => parseBackup(bytes)); });
test("base64 encoding handles files beyond JavaScript argument limits", () => { const bytes = Uint8Array.from({ length: 200000 }, (_, i) => i % 256); assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString("base64")); });
test("backup filename fallback and response header", () => { assert.equal(backupFileName(new Response()), "wildtoken-backup.wtbak"); assert.equal(backupFileName(new Response(null, { headers: { "content-disposition": 'attachment; filename="db.wtbak"' } })), "db.wtbak"); });
const ui = setupDOM(); after(() => ui.close()); afterEach(() => ui.cleanup());
const { DataManagement } = loadTS("web/src/components/DataManagement.tsx", { overrides: { "web/src/components/feedback.tsx": feedbackStub } });
const current = { app_version: "0.2.2", schema_version: 1, schema_fingerprint: "abcdef1234567890", size_bytes: 1024, compatible: true, encrypted: false };
const verified = { dry_run: true, verified: true, backup: current, current, warnings: [], staged: false, requires_restart: false };
test("restore requires preview and exact confirmation; schema edits invalidate preview", async () => {
  const calls = []; globalThis.fetch = async (url, init) => { if (url.endsWith("info")) return jsonResponse({ current, pending_restore: { pending: false } }); calls.push(JSON.parse(init.body)); return jsonResponse(verified); };
  const view = ui.render(h(DataManagement, { onChanged: async () => {} })); await view.findByText("0.2.2");
  ui.fireEvent.change(view.getByLabelText("数据库备份文件"), { target: { files: [{ arrayBuffer: async () => archiveBytes().buffer }] } });
  const apply = view.getByRole("button", { name: "暂存恢复（重启后覆盖全部数据）" }); assert.equal(apply.disabled, true);
  ui.fireEvent.click(view.getByRole("button", { name: "验证数据库备份" })); await view.findByText(/校验通过，未写入/); assert.equal(calls[0].dry_run, true); assert.equal("confirm" in calls[0], false);
  ui.fireEvent.change(view.getByLabelText("覆盖确认：输入 restore"), { target: { value: "restore" } }); assert.equal(apply.disabled, false);
  ui.fireEvent.click(view.getByLabelText(/允许结构指纹不一致/)); assert.equal(apply.disabled, true);
});
test("staged restore is visible and prevents another restore/import", async () => { globalThis.fetch = async () => jsonResponse({ current, pending_restore: { pending: true, staged_at: "today" } }); const view = ui.render(h(DataManagement, { onChanged: async () => {} })); await view.findByText("已有恢复暂存，等待重启"); assert.equal(view.getByLabelText("数据库备份文件").closest("fieldset").disabled, true); assert.equal(view.getByLabelText("配置归档文件").closest("fieldset").disabled, true); });
test("unavailable status is not misreported as no pending restore", async () => { globalThis.fetch = async () => jsonResponse({ detail: "unavailable" }, 503); const view = ui.render(h(DataManagement, { onChanged: async () => {} })); await view.findByText(/恢复状态暂不可用/); assert.equal(view.getByLabelText("数据库备份文件").closest("fieldset").disabled, true); });
