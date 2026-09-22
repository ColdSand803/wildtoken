// 渠道页按状态排序时，同一状态内部要按优先级降序，而不是摊成 id 顺序。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import {
  DEFAULT_UPSTREAM_SORT,
  UPSTREAM_SORT_KEY,
  compareUpstreams,
  readStoredSort,
} from "../web/src/upstreamSort.ts";

/** 排完只看 id 顺序，断言才读得懂。 */
const sortedIds = (sort, rows) =>
  rows.slice().sort(compareUpstreams(sort)).map((row) => row.id).join(",");

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const ch = (id, priority, enabled = true, effectiveWeight = 100) =>
  ({ id, priority, enabled, effective_weight: effectiveWeight });

test("按状态排序时，同状态内部按优先级降序", () => {
  const sort = { key: "status", desc: false };

  // 同为启用，优先级 300 > 200 > 100，与 id 顺序刻意相反。
  assert.equal(
    sortedIds(sort, [ch(1, 100), ch(2, 300), ch(3, 200)]),
    "2,3,1",
  );
});

test("状态分组仍是主因子，优先级不会把禁用渠道提前", () => {
  const sort = { key: "status", desc: false };

  const rows = [
    ch(1, 999, false),           // 禁用但优先级最高 → 仍排最后
    ch(2, 100, true, 0),         // 启用但有效权重 0 → 中间
    ch(3, 100, true),            // 启用且有效 → 最前
  ];
  assert.equal(sortedIds(sort, rows), "3,2,1");
});

test("优先级相同时仍按 id 升序兜底", () => {
  const sort = { key: "status", desc: false };

  assert.equal(sortedIds(sort, [ch(3, 100), ch(1, 100), ch(2, 100)]), "1,2,3");
});

// 次因子不跟着主列翻转：点第二下只调换三组状态的先后，组内顺序保持稳定，
// 否则同一批启用渠道会在两次点击之间上下颠倒。
test("状态列反向排序时，组内优先级顺序保持不变", () => {
  const sort = { key: "status", desc: true };

  const rows = [ch(1, 100), ch(2, 300), ch(3, 200), ch(4, 100, false)];
  // 禁用组整体提到最前，启用组内部仍是 300 > 200 > 100。
  assert.equal(sortedIds(sort, rows), "4,2,3,1");
});

test("其他排序列的行为不受影响", () => {
  // 按 id 排：优先级不参与，兜底仍是 id。
  const byId = { key: "id", desc: false };
  assert.equal(sortedIds(byId, [ch(3, 999), ch(1, 100), ch(2, 500)]), "1,2,3");

  // 按优先级排：优先级本身就是主因子，方向由列控制。
  const byPriority = { key: "priority", desc: true };
  assert.equal(sortedIds(byPriority, [ch(1, 100), ch(2, 300), ch(3, 200)]), "2,3,1");
});

// ---- 排序偏好落 localStorage：切页、刷新都不该回到默认排 ----

const storage = (raw) => ({ getItem: (key) => (key === UPSTREAM_SORT_KEY ? raw : null) });

test("存过的排序读得回来", () => {
  const stored = readStoredSort(storage(JSON.stringify({ key: "status", desc: true })));

  assert.deepEqual(stored, { key: "status", desc: true });
});

test("没存过时按默认排：高优先级在前", () => {
  assert.deepEqual(DEFAULT_UPSTREAM_SORT, { key: "priority", desc: true });
  assert.deepEqual(readStoredSort(storage(null)), DEFAULT_UPSTREAM_SORT);
  assert.deepEqual(readStoredSort(storage("")), DEFAULT_UPSTREAM_SORT);
});

test("读回的偏好真的改变列表顺序", () => {
  const rows = [ch(1, 100), ch(2, 300), ch(3, 200), ch(4, 100, false)];
  const order = (raw) =>
    sortedIds(readStoredSort(storage(raw)), rows);

  // 同一批渠道：默认按优先级降序，取回的偏好按状态倒序。两次结果必须不同，
  // 否则偏好读回来了也没喂进比较器。
  const byDefault = order(null);
  const byStored = order(JSON.stringify({ key: "status", desc: true }));
  assert.equal(byDefault, "2,3,1,4");
  assert.equal(byStored, "4,2,3,1");
});

test("坏内容整体回落默认，不抛", () => {
  const broken = [
    "not json",
    "{}",
    JSON.stringify({ key: "权重", desc: true }),      // 非法的 key
    JSON.stringify({ key: "status" }),               // 缺 desc
    JSON.stringify({ key: "status", desc: "yes" }),  // desc 不是布尔
    "null",
  ];

  for (const raw of broken) {
    assert.deepEqual(readStoredSort(storage(raw)), DEFAULT_UPSTREAM_SORT, raw);
  }
});

test("存储被挡住时回落默认，不抛", () => {
  const blocked = { getItem: () => { throw new Error("SecurityError"); } };

  assert.deepEqual(readStoredSort(blocked), DEFAULT_UPSTREAM_SORT);
  assert.deepEqual(readStoredSort(undefined), DEFAULT_UPSTREAM_SORT);
});

// 页面侧：读用 readStoredSort，四个表头都必须走 applySort——漏一个就变成
// 「那一列点了不生效且不记住」，而且看不出来。
test("四个表头都接到写入路径上", () => {
  const page = read("web/src/pages/UpstreamsPage.tsx");

  assert.match(page, /useState<[^>]*>\(\(\) => readStoredSort\(localStorage\)\)/);
  assert.equal(page.includes("onSort={setSort}"), false, "不能有绕过落盘的表头");
  assert.equal(page.match(/onSort=\{applySort\}/g).length, 4);
  assert.match(page, /localStorage\.setItem\(UPSTREAM_SORT_KEY, JSON\.stringify\(next\)\)/);
});
