// 日志详情抽屉：元信息一个页签，四份报文各一个页签，点到才请求。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  EMPTY_SNAPSHOTS,
  SNAPSHOT_SECTIONS,
  snapshotsFor,
  withSnapshot,
} from "../web/src/logSnapshots.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("四份报文按固定顺序各占一个页签，元信息排在最前", () => {
  assert.deepEqual(
    SNAPSHOT_SECTIONS.map((section) => section.key),
    ["downstream_request", "upstream_request", "upstream_response", "downstream_response"],
  );

  const dialog = read("web/src/components/LogDetailDialog.tsx");
  assert.match(dialog, /role="tablist"/);
  assert.match(dialog, /data-log-tab=\{item\.key\}/);
  assert.ok(dialog.includes('{ key: "meta", label: "元信息" }'), "缺少元信息页签");
  // 只渲染当前页签的面板，别的报文连解析都不做。
  assert.equal([...dialog.matchAll(/role="tabpanel"/g)].length, 2);
});

test("打开详情不发请求：元信息来自列表行，报文按页签单独拉", () => {
  const page = read("web/src/pages/LogsPage.tsx");
  assert.doesNotMatch(page, /getLogDetail/);
  assert.match(page, /function openDetail\(log: RequestLog\)/);

  const api = read("web/src/api.ts");
  assert.match(api, /\/api\/admin\/logs\/\$\{id\}\/snapshots\/\$\{field\}/);

  const dialog = read("web/src/components/LogDetailDialog.tsx");
  assert.match(dialog, /getLogSnapshot\(id, field\)/);
  assert.doesNotMatch(dialog, /getLogDetail/);
});

test("同一条日志的多份报文各自缓存，互不覆盖", () => {
  let cache = withSnapshot(EMPTY_SNAPSHOTS, 7, "downstream_request", { status: "loading" });
  cache = withSnapshot(cache, 7, "downstream_request", { status: "ready", raw: { a: 1 } });
  cache = withSnapshot(cache, 7, "upstream_response", { status: "error", message: "boom" });

  assert.deepEqual(snapshotsFor(cache, 7), {
    downstream_request: { status: "ready", raw: { a: 1 } },
    upstream_response: { status: "error", message: "boom" },
  });
  assert.deepEqual(snapshotsFor(cache, 8), {}, "别的日志看不到这份缓存");
});

test("换了日志后，上一条迟到的报文不会盖到新日志上", () => {
  let cache = withSnapshot(EMPTY_SNAPSHOTS, 1, "downstream_request", { status: "loading" });
  // 用户切到第 2 条并点开一份报文：缓存整个换成第 2 条的。
  cache = withSnapshot(cache, 2, "upstream_request", { status: "loading" });
  assert.equal(cache.id, 2);
  assert.deepEqual(snapshotsFor(cache, 1), {});

  // 第 1 条的响应这时才到，必须丢掉。
  cache = withSnapshot(cache, 1, "downstream_request", { status: "ready", raw: {} });
  assert.equal(cache.id, 2);
  assert.deepEqual(Object.keys(cache.items), ["upstream_request"]);

  cache = withSnapshot(cache, 2, "upstream_request", { status: "ready", raw: { b: 2 } });
  assert.deepEqual(snapshotsFor(cache, 2).upstream_request, { status: "ready", raw: { b: 2 } });
});

// 页签条塌成一根线：它是横向滚动容器，又是 grid 的项，CSS Grid 对「溢出不是
// visible 的项」按零算自动最小尺寸。正文章案一高出滚动区，页签那一行就停在 0，
// 40px 的页签被 align-items: flex-end 顶到条子上沿外——看着就是整条页签往上跑、
// 被抽屉头切掉。下限必须在，且至少要和页签自己的 min-height 一样高。
test("页签条有高度下限，不会在 grid 里塌成一根线", () => {
  const css = read("static/css/logs-tokens.css");

  const tabHeight = Number(css.match(/\.log-detail-tab\s*\{[^}]*min-height:\s*(\d+)px/)[1]);
  const bar = css.match(/\.log-detail-tabs\s*\{[^}]*\}/)[0];
  const barMin = Number(bar.match(/min-height:\s*(\d+)px/)[1]);

  assert.ok(Number.isFinite(barMin), "页签条必须写死 min-height");
  assert.ok(barMin >= tabHeight + 8, `页签条下限 ${barMin}px 撑不住 ${tabHeight}px 的页签加上内边距`);
});
