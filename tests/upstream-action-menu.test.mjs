import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { h, loadTS, setupDOM, read } from "./react-harness.mjs";
const page = read("web/src/pages/UpstreamsPage.tsx");
test("clone and credential-copy remain separate actions", () => { assert.match(page, /key: "duplicate", label: "复制渠道"/); assert.match(page, /key: "copy-info", label: "复制渠道信息"/); assert.match(page, /formatUpstreamClipboardText\(detail\)/); const { formatUpstreamClipboardText } = loadTS("web/src/channelTransfer.ts"); assert.equal(formatUpstreamClipboardText({ base_url: "https://api.test", api_key: "secret" }), "baseURL: https://api.test\napiKey: secret"); });
test("archived menu restores instead of running probes", () => { const branch = page.slice(page.indexOf("if (upstream.archived)"), page.indexOf('/* 顺序照抄旧版')); assert.match(branch, /key: "unarchive"/); assert.doesNotMatch(branch, /key: "test"|key: "test-model"/); });
test("fixed weight and dynamic effective weight remain distinct", () => { assert.match(page, /有效权重 \/ 基础权重/); assert.match(page, /固定权重/); const { zeroWeightNote } = loadTS("web/src/pages/UpstreamsPage.tsx", { expose: ["zeroWeightNote"] }); assert.notEqual(zeroWeightNote({ auto_weight_enabled: false, weight: 0 }), zeroWeightNote({ auto_weight_enabled: true, weight: 10 })); });
const ui = setupDOM(); after(() => ui.close()); afterEach(() => ui.cleanup());
test("a stale balance response cannot overwrite a newer channel's balance", async () => {
  const pending = []; const { BalanceDialog } = loadTS("web/src/components/BalanceDialog.tsx", { overrides: { "web/src/api.ts": { UnauthorizedError: class extends Error {}, fetchUpstreamBalance: (id) => new Promise((resolve) => pending.push({ id, resolve })) } } });
  const close = () => {}; const view = ui.render(h(BalanceDialog, { open: true, upstream: { id: 1, name: "one" }, provider: "new-api", onClose: close }));
  view.rerender(h(BalanceDialog, { open: true, upstream: { id: 2, name: "two" }, provider: "new-api", onClose: close }));
  await ui.act(async () => pending[1].resolve({ ok: true, remaining_usd: 22 })); await view.findByText("$22");
  await ui.act(async () => pending[0].resolve({ ok: true, remaining_usd: 11 })); assert.equal(view.queryByText("$11"), null); assert.ok(view.getByText("$22"));
});
