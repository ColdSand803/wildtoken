// 渠道页按状态排序时，同一状态内部要按优先级降序，而不是摊成 id 顺序。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`could not extract ${name}`);
}

function sortContext(upstreamSort) {
  const source = read("static/js/shell.js");
  const context = vm.createContext({ upstreamSort });
  for (const name of ["upstreamStatusRank", "compareUpstreams"]) {
    vm.runInContext(extractFunction(source, name), context);
  }
  return context;
}

// 排完之后只看 id 顺序，避开 vm realm 的原型差异。
function sortedIds(context, rows) {
  context.rows = rows;
  return vm.runInContext("rows.slice().sort(compareUpstreams).map((r) => r.id).join(',')", context);
}

const ch = (id, priority, enabled = true, effectiveWeight = 100) =>
  ({ id, priority, enabled, effective_weight: effectiveWeight });

test("按状态排序时，同状态内部按优先级降序", () => {
  const context = sortContext({ key: "status", direction: "asc" });

  // 同为启用，优先级 300 > 200 > 100，与 id 顺序刻意相反。
  assert.equal(
    sortedIds(context, [ch(1, 100), ch(2, 300), ch(3, 200)]),
    "2,3,1",
  );
});

test("状态分组仍是主因子，优先级不会把禁用渠道提前", () => {
  const context = sortContext({ key: "status", direction: "asc" });

  const rows = [
    ch(1, 999, false),           // 禁用但优先级最高 → 仍排最后
    ch(2, 100, true, 0),         // 启用但有效权重 0 → 中间
    ch(3, 100, true),            // 启用且有效 → 最前
  ];
  assert.equal(sortedIds(context, rows), "3,2,1");
});

test("优先级相同时仍按 id 升序兜底", () => {
  const context = sortContext({ key: "status", direction: "asc" });

  assert.equal(sortedIds(context, [ch(3, 100), ch(1, 100), ch(2, 100)]), "1,2,3");
});

// 次因子不跟着主列翻转：点第二下只调换三组状态的先后，组内顺序保持稳定，
// 否则同一批启用渠道会在两次点击之间上下颠倒。
test("状态列反向排序时，组内优先级顺序保持不变", () => {
  const context = sortContext({ key: "status", direction: "desc" });

  const rows = [ch(1, 100), ch(2, 300), ch(3, 200), ch(4, 100, false)];
  // 禁用组整体提到最前，启用组内部仍是 300 > 200 > 100。
  assert.equal(sortedIds(context, rows), "4,2,3,1");
});

test("其他排序列的行为不受影响", () => {
  // 按 id 排：优先级不参与，兜底仍是 id。
  const byId = sortContext({ key: "id", direction: "asc" });
  assert.equal(sortedIds(byId, [ch(3, 999), ch(1, 100), ch(2, 500)]), "1,2,3");

  // 按优先级排：优先级本身就是主因子，方向由列控制。
  const byPriority = sortContext({ key: "priority", direction: "desc" });
  assert.equal(sortedIds(byPriority, [ch(1, 100), ch(2, 300), ch(3, 200)]), "2,3,1");
});
