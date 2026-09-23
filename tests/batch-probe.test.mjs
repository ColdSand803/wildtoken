import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { h, loadTS, setupDOM, jsonResponse, renderStatic } from "./react-harness.mjs";
const ui = setupDOM(); after(() => ui.close()); afterEach(() => ui.cleanup());
const { useChannelDiagnostics, ChannelDiagnostics, ChannelDiagnosticBadge } = loadTS("web/src/components/ChannelDiagnostics.tsx");
const routing = { strategy: "least_latency", latency_active: true, rules: { min_samples: 5, stale_window_seconds: 300, tolerance_ratio: .2, tolerance_floor_ms: 50, sample_capacity: 32 }, latency: [{ upstream_id: 1, usable: true, median_ms: 123, sample_count: 6 }] };
const result = { upstream_id: 1, ok: false, status_code: 503, duration_ms: 300, checked_at: "2026-09-23 01:00:00", error_summary: "<upstream failed>" };
function Harness() { return h(ChannelDiagnostics, { state: useChannelDiagnostics() }); }
test("opening diagnostics reads cached results; only an explicit click POSTs a probe", async () => {
  const requests = []; globalThis.fetch = async (url, init) => { requests.push({ url, method: init?.method ?? "GET" }); return jsonResponse(url.includes("routing") ? routing : init?.method === "POST" ? { results: [result], skipped: 2, partial: true } : { running: false, results: [] }); };
  const view = ui.render(h(Harness)); await view.findByText(/最低延迟优先/); assert.equal(requests.some((item) => item.method === "POST"), false);
  ui.fireEvent.click(view.getByLabelText("包括停用渠道")); ui.fireEvent.click(view.getByRole("button", { name: "批量测活" }));
  await ui.waitFor(() => assert.ok(requests.find((item) => item.method === "POST"))); assert.match(requests.find((item) => item.method === "POST").url, /include_disabled=true/); await view.findByText(/跳过 2.*部分完成/);
});
test("failed probes remain distinct from usable routing latency and escape errors", () => {
  const state = { probe: { results: [result] }, routing, busy: false, error: "", reload() {}, run() {} };
  const html = renderStatic(h(ChannelDiagnosticBadge, { id: 1, state })); assert.match(html, /测活 失败/); assert.match(html, /决策 123ms/); assert.match(html, /&lt;upstream failed&gt;/);
});
test("insufficient samples never display fake zero latency", () => { const html = renderStatic(h(ChannelDiagnosticBadge, { id: 2, state: { probe: null, routing } })); assert.match(html, /采样 0\/5/); assert.doesNotMatch(html, /决策 0ms/); });
test("409 synchronizes the existing probe rather than posting again", async () => {
  let posts = 0, gets = 0; globalThis.fetch = async (url, init) => { if (init?.method === "POST") { posts++; return jsonResponse({ detail: "already running" }, 409); } if (url.includes("routing")) return jsonResponse(routing); gets++; return jsonResponse({ running: gets > 1, results: [] }); };
  const view = ui.render(h(Harness)); await view.findByText(/最低延迟优先/); ui.fireEvent.click(view.getByRole("button", { name: "批量测活" })); await view.findByRole("button", { name: "测活中…" }); await ui.waitFor(() => assert.ok(gets >= 2)); assert.equal(posts, 1);
});
