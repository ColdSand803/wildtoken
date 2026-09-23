import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadTS, setupDOM, jsonResponse, read } from "./react-harness.mjs";
const ui = setupDOM(); after(() => ui.close());
const { readRange } = loadTS("web/src/pages/DashboardPage.tsx", { expose: ["readRange"] });
for (const range of ["today", "1d", "3d", "7d", "30d", "all", "default"]) test(`dashboard restores ${range} including comparison mode`, () => { localStorage.setItem("wildtoken_dashboard_range", range); assert.equal(readRange(), range); });
test("invalid stored range falls back instead of issuing an invalid API query", () => { localStorage.setItem("wildtoken_dashboard_range", "bad"); assert.equal(readRange(), "30d"); });
test("custom range is shared by overview, ranking and usage; recent failures get the resolved UTC interval", async () => {
  const urls = []; const overview = { resolved_start: "2026-09-22T00:00:00Z", resolved_end: "2026-09-23T00:00:00Z" };
  globalThis.fetch = async (url) => { urls.push(new URL(url, "http://localhost")); return jsonResponse(url.includes("overview") ? overview : {}); };
  const { fetchDashboard } = loadTS("web/src/api.ts"); await fetchDashboard("custom", { start: "2026-09-22T08:00:00", end: "2026-09-23T08:00:00" });
  for (const url of urls.slice(0, 3)) { assert.equal(url.searchParams.get("start_date"), "2026-09-22T08:00:00"); assert.equal(url.searchParams.get("end_date"), "2026-09-23T08:00:00"); }
  const logs = urls.at(-1).searchParams; assert.equal(logs.get("start"), overview.resolved_start); assert.equal(logs.get("end"), overview.resolved_end); assert.equal(logs.get("status"), "error");
});
test("comparison mode only falls back for single-window overview", async () => { const urls = []; globalThis.fetch = async (url) => { urls.push(url); return jsonResponse({}); }; await loadTS("web/src/api.ts").fetchDashboard("default"); assert.ok(urls.some((url) => url.includes("overview?range=30d"))); assert.ok(urls.some((url) => url.includes("token-usage?range=default"))); });
test("refresh preference preserves dev's millisecond storage and the slider measures its active button", () => { const source = read("web/src/pages/DashboardPage.tsx"); assert.match(source, /String\(next \* 1000\)/); assert.match(source, /active.offsetLeft/); assert.match(source, /clearInterval/); });
