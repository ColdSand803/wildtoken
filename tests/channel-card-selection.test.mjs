import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { h, loadTS, setupDOM, read, feedbackStub } from "./react-harness.mjs";
const ui = setupDOM(); after(() => ui.close()); afterEach(() => ui.cleanup());
const { ChannelCard } = loadTS("web/src/components/ChannelCard.tsx");
const upstream = { id: 1, name: "channel", enabled: true, priority: 1, weight: 1, effective_weight: 1, auto_weight_enabled: true, model_names: [], model_prefixes: [], group_ids: [] };
test("card selection is labelled and does not trigger channel enable", () => { let checked, toggled = false; const view = ui.render(h(ChannelCard, { upstream, stats: null, health: null, busy: false, menu: [], checked: false, onCheck(value) { checked = value; }, onToggle() { toggled = true; }, onOpenDetail() {} })); ui.fireEvent.click(view.getByRole("checkbox", { name: "选择渠道 channel" })); assert.equal(checked, true); assert.equal(toggled, false); });
test("cards and list share the current visible selection", () => { const source = read("web/src/pages/UpstreamsPage.tsx"); assert.match(source, /checked=\{selected.has\(upstream.id\)\}/); assert.match(source, /visibleSelected = filtered.filter/); assert.match(source, /选择当前筛选全部渠道/); });
test("selected cards have a visual state", () => { const view = ui.render(h(ChannelCard, { upstream, stats: null, health: null, busy: false, menu: [], checked: true, onToggle() {}, onOpenDetail() {} })); assert.ok(view.container.querySelector(".channel-card.is-selected")); assert.equal(view.getByRole("checkbox").checked, true); assert.match(read("static/css/react-integration.css"), /\.channel-card.is-selected/); });
test("clicking card body selects it while interactive controls do not toggle selection", () => { let checked = false, toggled = false, detailOpened = false; const view = ui.render(h(ChannelCard, { upstream, stats: null, health: null, busy: false, menu: [], checked: false, onCheck(value) { checked = value; }, onToggle() { toggled = true; }, onOpenDetail() { detailOpened = true; } })); const card = view.container.querySelector(".channel-card"); assert.ok(card); const checkbox = view.getByRole("checkbox", { name: "选择渠道 channel" }); assert.ok(checkbox.classList.contains("channel-card-check")); ui.fireEvent.click(card); assert.equal(checked, true); checked = false; ui.fireEvent.click(view.getByRole("switch")); assert.equal(toggled, true); assert.equal(checked, false); const detailBtn = view.container.querySelector(".channel-card-action"); assert.ok(detailBtn); ui.fireEvent.click(detailBtn); assert.equal(detailOpened, true); assert.equal(checked, false); });

test("refactored card and table views retain selection and diagnostic badges", async () => {
  localStorage.setItem("wildtoken_upstream_view", "grid");
  const row = { ...upstream, base_url: "https://api.test", key_count: 0, enabled_key_count: 0,
    model_mappings: {}, effort_mappings: {}, extra_headers: {}, timeout_seconds: 60 };
  const state = {};
  const { UpstreamsPage } = loadTS("web/src/pages/UpstreamsPage.tsx", { overrides: {
    "web/src/components/feedback.tsx": feedbackStub,
    "web/src/components/ChannelDiagnostics.tsx": {
      useChannelDiagnostics: () => state, ChannelDiagnostics: () => null,
      ChannelDiagnosticBadge: ({ id }) => h("span", { "data-testid": "diagnostic-" + id }, "diagnostic"),
    },
    "web/src/api.ts": { UnauthorizedError: class extends Error {},
      listUpstreams: async () => [row], listGroups: async () => [],
      fetchUpstreamStats: async () => ({}), fetchUpstreamHealth: async () => ({}),
    },
  } });
  const view = ui.render(h(UpstreamsPage, { onUnauthorized() {} }));
  const selected = await view.findByRole("checkbox", { name: "选择渠道 channel" });
  ui.fireEvent.click(selected);
  assert.equal(selected.checked, true);
  assert.equal(view.getAllByRole("button", { name: "批量启用", exact: true }).length, 1);
  assert.ok(view.getByTestId("diagnostic-1"));
  ui.fireEvent.click(view.getByRole("button", { name: "列表视图" }));
  assert.equal(view.getByRole("checkbox", { name: "选择渠道 channel" }).checked, true);
  assert.ok(view.getByTestId("diagnostic-1"));
  assert.equal(view.getAllByRole("button", { name: "批量启用", exact: true }).length, 1);
  ui.fireEvent.click(view.getByRole("button", { name: "卡片视图" }));
  assert.equal(view.getByRole("checkbox", { name: "选择渠道 channel" }).checked, true);
  localStorage.removeItem("wildtoken_upstream_view");
});
