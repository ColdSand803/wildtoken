import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { h, loadTS, read, setupDOM } from "./react-harness.mjs";
const { parseAllowedModelsInput, QUOTA_PERIOD_LABELS } = loadTS("web/src/tokenPolicy.ts");
for (const [raw, expected] of [["", []], [null, []], [" gpt-4, GPT-4\nclaude-* ", ["gpt-4", "claude-*"]], [["a", "b"], ["a", "b"]]]) test(`model whitelist normalizes ${JSON.stringify(raw)}`, () => assert.deepEqual(parseAllowedModelsInput(raw), { ok: true, allowedModels: expected }));
for (const raw of ["gpt-*-turbo", "a\tb", "x".repeat(201), Array.from({ length: 201 }, (_, i) => `m${i}`).join(",")]) test(`model whitelist rejects invalid rule ${raw.slice(0, 25)}`, () => assert.equal(parseAllowedModelsInput(raw).ok, false));
test("all supported quota periods are editable", () => assert.deepEqual(Object.keys(QUOTA_PERIOD_LABELS), ["none", "daily", "weekly", "monthly"]));
const ui = setupDOM(); after(() => ui.close()); afterEach(() => ui.cleanup());
const { TokenDialog } = loadTS("web/src/components/TokenDialog.tsx");
const token = { id: 1, name: "policy-token", description: "", enabled: true, group_id: 1, expires_at: null, rate_limit: null, quota: { limit_expression: "10M" }, allowed_models: ["gpt-*", "claude-3"], quota_period_state: { period: "weekly", timezone: "UTC" } };
test("editing a token round-trips whitelist, period and timezone without silently resetting them", async () => {
  let payload; const view = ui.render(h(TokenDialog, { open: true, token, groups: [{ id: 1, name: "default" }], busy: false, onSubmit: (value) => { payload = value; }, onClose() {} }));
  ui.fireEvent.click(view.getByRole("button", { name: "保存" }));
  await ui.waitFor(() => assert.ok(payload));
  assert.deepEqual(payload.allowed_models, token.allowed_models); assert.equal(payload.quota_period, "weekly"); assert.equal(payload.quota_timezone, "UTC"); assert.equal(payload.limit_expression, "10M");
});
test("invalid wildcard blocks submission and shows a useful error", () => {
  let saved = false; const view = ui.render(h(TokenDialog, { open: true, token, groups: [], busy: false, onSubmit() { saved = true; }, onClose() {} }));
  ui.fireEvent.change(view.getByLabelText(/允许模型/), { target: { value: "a*b" } });
  assert.equal(view.getByRole("button", { name: "保存" }).disabled, true); assert.equal(saved, false);
});
test("token table exposes allowed models and the next quota reset", () => { const source = read("web/src/pages/TokensPage.tsx"); assert.match(source, /<th>允许模型<\/th>/); assert.match(source, /next_reset_at/); assert.match(source, /colSpan=\{9\}/); });
