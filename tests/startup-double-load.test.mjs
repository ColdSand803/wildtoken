import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { h, loadTS, setupDOM, feedbackStub, jsonResponse } from "./react-harness.mjs";
const ui = setupDOM(); after(() => ui.close()); afterEach(() => ui.cleanup());
test("channel mount loads once; unrelated rerenders do not duplicate fetches", async () => {
  let count = 0; globalThis.fetch = async (url) => jsonResponse(url.includes("routing") ? { strategy: "weighted", latency_active: false, rules: {}, latency: [] } : { results: [], running: false });
  const { UpstreamsPage } = loadTS("web/src/pages/UpstreamsPage.tsx", { overrides: { "web/src/components/feedback.tsx": feedbackStub, "web/src/api.ts": { UnauthorizedError: class extends Error {}, api: async (url) => url.includes("routing") ? { strategy: "weighted", latency_active: false, rules: {}, latency: [] } : { results: [], running: false }, listUpstreams: async () => { count++; return []; }, listGroups: async () => [] } } });
  const onUnauthorized = () => {}; const view = ui.render(h(UpstreamsPage, { onUnauthorized })); await view.findByText(/暂无渠道/); assert.equal(count, 1);
  view.rerender(h(UpstreamsPage, { onUnauthorized })); assert.equal(count, 1); ui.fireEvent.click(view.getByRole("button", { name: "刷新", exact: true })); await ui.waitFor(() => assert.equal(count, 2));
});
