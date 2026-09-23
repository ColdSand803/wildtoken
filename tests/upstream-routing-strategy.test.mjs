import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadTS, read, setupDOM, jsonResponse } from "./react-harness.mjs";
const ui = setupDOM(); after(() => ui.close());
test("settings preserves least-latency and main's online timeout together", async () => {
  let body; globalThis.fetch = async (_url, options) => { body = JSON.parse(options.body); return jsonResponse(body); };
  const { saveSettings } = loadTS("web/src/api.ts"); await saveSettings({ load_balance_strategy: "least_latency", default_upstream_timeout_seconds: 120, revision: 8, updated_at: "not-input" });
  assert.equal(body.load_balance_strategy, "least_latency"); assert.equal(body.default_upstream_timeout_seconds, 120); assert.equal(body.revision, 8); assert.equal("updated_at" in body, false);
});
test("settings exposes both strategies and first-event failover", () => { const source = read("web/src/pages/SettingsPage.tsx"); assert.match(source, /value="weighted"/); assert.match(source, /value="least_latency"/); assert.match(source, /首个有效事件/); });
test("routing rules are server-sourced", () => { const source = read("web/src/components/ChannelDiagnostics.tsx"); for (const field of ["min_samples", "stale_window_seconds", "sample_capacity", "tolerance_ratio", "tolerance_floor_ms"]) assert.ok(source.includes(`routing.rules.${field}`)); });
