import assert from "node:assert/strict";
import test from "node:test";
import { appendLogCursor, mergeLogRows, needsLogResync } from "../web/src/logQuery.ts";

const filters = { search: "", clientType: "", upstreamId: "", status: "" };
const row = (id, status_code = 200) => ({ id, created_at: `time-${id}`, status_code });

test("最新页的查询和推送去重，查询里更晚的行仍排在前面", () => {
  const pushed = row(3);
  const merged = mergeLogRows([row(5), row(3), row(1)], [pushed, row(4)], true, filters);
  assert.deepEqual(merged.map((item) => item.id), [5, 4, 3, 1]);
  assert.equal(merged.find((item) => item.id === 3), pushed);
});

test("旧游标页不接纳实时推送", () => {
  assert.deepEqual(mergeLogRows([row(2), row(1)], [row(3)], false, filters).map((item) => item.id), [2, 1]);
});

test("推送使用与查询相同的筛选条件", () => {
  assert.deepEqual(mergeLogRows([], [row(3, 200), row(2, 503)], true, { ...filters, status: "5xx" }).map((item) => item.id), [2]);
});

test("分页取截断后的可见末行，连点不重复压栈", () => {
  const rows = [row(4), row(3), row(2)];
  const stack = appendLogCursor([], rows.slice(0, 2));
  assert.deepEqual(stack, [{ id: 3, created_at: "time-3" }]);
  assert.equal(appendLogCursor(stack, rows.slice(0, 2)), stack);
  assert.equal(appendLogCursor(stack, []), stack);
});

test("只对最新页未覆盖的缓冲缺口补拉", () => {
  assert.equal(needsLogResync(101, 100, true), true);
  assert.equal(needsLogResync(100, 100, true), false);
  assert.equal(needsLogResync(99, 100, true), false);
  assert.equal(needsLogResync(101, 100, false), false);
});
