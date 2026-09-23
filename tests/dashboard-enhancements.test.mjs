import assert from "node:assert/strict";
import test from "node:test";
import { h, loadTS, read, renderStatic } from "./react-harness.mjs";
const page = read("web/src/pages/DashboardPage.tsx");
test("request background uses counts while latency chart uses sampled duration", () => { assert.match(page, /background=\{overview\?\.request_series.map/); assert.match(page, /<Sparkline values=\{overview\?\.latency_series.map\(\(bucket\) => bucket.avg_ms\)/); for (const quantile of ["p50_duration_ms", "p95_duration_ms", "p99_duration_ms"]) assert.ok(page.includes(quantile)); });
test("status distribution keeps no-response separate and links buckets to exact log windows", () => { assert.match(page, /count: overview.status_none/); assert.match(page, /错误时间分布/); assert.match(page, /bucket.bucket_epoch \+ overview.bucket_seconds/); assert.match(page, /resolved_start/); assert.match(page, /token|Tokens/); });
test("request KPI supports keyboard drill-down and same-window comparison", () => { const { Kpi } = loadTS("web/src/pages/DashboardPage.tsx", { expose: ["Kpi"] }); const html = renderStatic(h(Kpi, { label: "请求", value: "10", hint: "window", trend: 50, onClick() {} })); assert.match(html, /role="button"/); assert.match(html, /tabindex="0"/); assert.match(html, /50.0%/); });
test("each ranking uses its independent backend array and preserves ID based channel filtering", () => { for (const key of ["channels", "channel_tokens", "models", "model_tokens"]) assert.ok(page.includes(`rows={top?.${key} ?? []}`)); assert.match(page, /upstreamId: row.id/); });
