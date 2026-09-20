import assert from "node:assert/strict";
import test from "node:test";

import { createDomContext, extractFunction, read, vm } from "./dom-stub.mjs";

/* getFilteredUpstreams 排序这步对本次断言无关紧要（归档渠道根本进不到排序），
   但 sort(compareUpstreams) 会因找不到函数而抛错。给它一个稳定替身。
   真正要验的是「归档渠道不出现在主列表」这条过滤规则。 */
function filteredContext(upstreams) {
  const context = createDomContext();
  vm.runInContext(`const upstreams = ${JSON.stringify(upstreams)};`, context);
  const shell = read("static/js/shell.js");
  vm.runInContext(extractFunction(shell, "getFilteredUpstreams"), context);
  vm.runInContext(extractFunction(shell, "getFilteredArchivedUpstreams"), context);
  vm.runInContext("function compareUpstreams(a, b) { return a.id - b.id; }", context);
  context.upstreamSearchQuery = "";
  context.upstreamStatusFilterValue = "";
  return context;
}

/* vm.runInContext 返回的数组属于沙箱的 Array 原型，assert.deepEqual 认为
   结构相同但原型不同（Values have same structure but are not reference-equal）。
   既有测试只比字符串所以撞不到。这里在沙箱里先 join 成字符串再拿出来比。 */
function sandboxList(context, expression) {
  return vm.runInContext(`(${expression}).join("\\u0000")`, context).split("\u0000");
}

/** 归档渠道必须从主列表消失，并且在折叠区里出现。 */
test("主列表排除归档渠道，归档区收留它们", () => {
  const context = filteredContext([
    { id: 1, name: "live", enabled: true, archived: false, priority: 100 },
    { id: 2, name: "parked", enabled: false, archived: true, priority: 90 },
    { id: 3, name: "off", enabled: false, archived: false, priority: 80 },
  ]);

  // off 是停用但没归档——它该留在主列表，归档才是被移走的那个开关。
  assert.deepEqual(
    sandboxList(context, "getFilteredUpstreams().map((u) => u.name)"),
    ["live", "off"],
    "主列表出现归档渠道",
  );

  assert.deepEqual(
    sandboxList(context, "getFilteredArchivedUpstreams().map((u) => u.name)"),
    ["parked"],
    "归档区没收到归档渠道",
  );
});

/** 搜索归档渠道不该受状态筛选限制——主列表的筛选器管不到折叠区。 */
test("归档区只用搜索词，状态筛选不影响它", () => {
  const context = filteredContext([
    { id: 1, name: "live", enabled: true, archived: false, priority: 100 },
    { id: 2, name: "parked-alpha", enabled: false, archived: true, priority: 90 },
  ]);

  vm.runInContext(
    "upstreamSearchQuery = 'alpha'; upstreamStatusFilterValue = 'enabled';",
    context,
  );
  // 「启用」筛选下主列表不可能有 parked，但归档区仍该按名字找到它。
  assert.deepEqual(
    sandboxList(context, "getFilteredArchivedUpstreams().map((u) => u.name)"),
    ["parked-alpha"],
  );
});

/** 归档是独立开关，不该和「停用」混为一谈。 */
test("归档与停用是两个开关", () => {
  const schema = read("internal/db/sql.go");
  assert.match(schema, /archived\s+INTEGER NOT NULL DEFAULT 0/);
  // 记住归档前的启用状态，恢复时才有的还原。
  assert.match(schema, /archived_prev_enabled INTEGER/);
});
