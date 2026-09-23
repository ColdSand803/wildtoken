// 归档渠道：从主列表移走，进折叠区，且只吃搜索词。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("web/src/pages/UpstreamsPage.tsx");

/** 主列表与归档区的分流那一段。 */
function splitBlock() {
  const start = source.indexOf("const active = upstreams.filter");
  assert.notEqual(start, -1, "分流逻辑必须存在");
  return source.slice(start, source.indexOf(".sort(compareUpstreams", start));
}

test("主列表排除归档渠道，归档区收留它们", () => {
  const block = splitBlock();
  // 停用但没归档的渠道该留在主列表——归档才是被移走的那个开关。
  assert.match(block, /const active = upstreams\.filter\(\(u\) => !u\.archived\)/);
  assert.match(block, /const archived = upstreams\.filter\(\(u\) => u\.archived/);
});

/* 状态筛选描述的是路由状态，而归档渠道本就不参与路由，拿它去筛只会把折叠区
   筛成空的。搜索词要生效，否则归档多了就翻不动。 */
test("归档区只用搜索词，状态筛选不影响它", () => {
  const block = splitBlock();
  assert.match(block, /u\.archived && matchesQuery\(u\)/, "归档区应按搜索词过滤");

  const archivedLine = /const archived = upstreams\.filter\([^;]+;/.exec(block)[0];
  for (const filterName of ["enabled", "disabled", "effective-zero"]) {
    assert.doesNotMatch(
      archivedLine,
      new RegExp(filterName),
      `归档区不该受 ${filterName} 状态筛选影响`,
    );
  }
});

test("搜索同时作用于主列表和归档区", () => {
  // 两边共用一个判定，分开写就会悄悄分叉。
  assert.match(source, /const matchesQuery = \(upstream: Upstream\)/);
  assert.equal([...source.matchAll(/matchesQuery\(u\)/g)].length, 2);
});

/** 归档是独立开关，不该和「停用」混为一谈。 */
test("归档与停用是两个开关", () => {
  const schema = read("internal/db/sql.go");
  assert.match(schema, /archived\s+INTEGER NOT NULL DEFAULT 0/);
  // 记住归档前的启用状态，恢复时才有的还原。
  assert.match(schema, /archived_prev_enabled INTEGER/);
});
