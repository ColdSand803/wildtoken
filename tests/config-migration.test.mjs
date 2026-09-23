import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { h, loadTS, setupDOM, feedbackStub, jsonResponse } from "./react-harness.mjs";
const { parseConfigArchive } = loadTS("web/src/archiveTools.ts");
for (const value of ["invalid", "null", "[]", '{"kind":"wildtoken.backup"}']) test(`config parser rejects ${value}`, () => assert.throws(() => parseConfigArchive(value)));
test("encrypted config envelopes stay intact", () => { const archive = { kind: "wildtoken.config", encryption: { ciphertext: "opaque" } }; assert.deepEqual(parseConfigArchive(JSON.stringify(archive)), archive); });
const ui = setupDOM(); after(() => ui.close()); afterEach(() => ui.cleanup());
const { ConfigMigration } = loadTS("web/src/components/ConfigMigration.tsx", { overrides: { "web/src/components/feedback.tsx": feedbackStub } });
const archive = { kind: "wildtoken.config", scopes: ["channels"] };
const report = { dry_run: true, applied: false, created: 1, updated: 0, skipped: 0, failed: 0, items: [{ scope: "channels", name: "<script>alert(1)</script>", action: "create" }], errors: [] };
function choose(view) { ui.fireEvent.change(view.getByLabelText("配置归档文件"), { target: { files: [{ text: async () => JSON.stringify(archive) }] } }); }
test("configuration apply needs a matching successful preview; password edits invalidate it", async () => {
  const requests = []; globalThis.fetch = async (url, init) => { requests.push({ url, body: JSON.parse(init.body) }); return jsonResponse(report); };
  const view = ui.render(h(ConfigMigration, { locked: false, onChanged: async () => {} })); const apply = view.getByRole("button", { name: "执行配置导入" }); assert.equal(apply.disabled, true); choose(view);
  ui.fireEvent.click(view.getByRole("button", { name: "预览配置导入" })); await ui.waitFor(() => assert.equal(apply.disabled, false));
  assert.equal(requests.length, 1); assert.equal(requests[0].body.dry_run, true); assert.deepEqual(requests[0].body.archive, archive); assert.equal(view.container.querySelector("script"), null);
  ui.fireEvent.change(view.getByLabelText("解密密码"), { target: { value: "changed" } }); assert.equal(apply.disabled, true);
});
test("failed preview cannot enable import", async () => { globalThis.fetch = async () => jsonResponse({ ...report, failed: 1, errors: ["bad reference"] }); const view = ui.render(h(ConfigMigration, { locked: false, onChanged: async () => {} })); choose(view); ui.fireEvent.click(view.getByRole("button", { name: "预览配置导入" })); await view.findByText("bad reference"); assert.equal(view.getByRole("button", { name: "执行配置导入" }).disabled, true); });
test("secret export requires a password before making any request", async () => { let called = false; globalThis.fetch = async () => { called = true; return jsonResponse(archive); }; const view = ui.render(h(ConfigMigration, { locked: false, onChanged: async () => {} })); ui.fireEvent.click(view.getByLabelText("包含密钥及令牌明文")); ui.fireEvent.click(view.getByRole("button", { name: "导出配置归档" })); await view.findByText(/至少 8 位归档密码/); assert.equal(called, false); });
test("pending recovery locks import but not export", () => { const view = ui.render(h(ConfigMigration, { locked: true, onChanged: async () => {} })); assert.equal(view.getByLabelText("配置归档文件").closest("fieldset").disabled, true); assert.equal(view.getByRole("button", { name: "导出配置归档" }).closest("fieldset").disabled, false); });
