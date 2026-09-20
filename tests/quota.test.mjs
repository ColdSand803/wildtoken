import assert from "node:assert/strict";
import test from "node:test";

import { createDomContext, extractFunction, read, vm } from "./dom-stub.mjs";

/** 把限额单元格跑起来：真实的 el()，配上最小 DOM。 */
function quotaContext(source) {
  const context = createDomContext();
  // 缩写器已经移到 bootstrap.js，因为日志列表和令牌限额都要用。
  const shared = read("static/js/bootstrap.js");
  vm.runInContext(
    shared.slice(shared.indexOf("const QUOTA_UNITS"), shared.indexOf("function formatTokenCount")),
    context,
  );
  vm.runInContext(extractFunction(shared, "formatTokenCount"), context);
  vm.runInContext(extractFunction(source, "quotaCell"), context);
  return context;
}

/** 跑一次 quotaCell，把结果节点树序列化成标记供断言。 */
function quotaMarkup(context, argument) {
  return vm.runInContext(`quotaCell(${argument}).outerHTML`, context);
}

test("限额字段名与服务端一致", () => {
  const source = read("static/js/tokens.js");
  // 服务端读 limit_expression；名字不一致会被静默忽略，限额就设不上。
  assert.match(source, /limit_expression: tokenLimitInput\?\.value\.trim\(\) \|\| ""/);
});

test("令牌表的限额列在表头与行渲染里齐全", () => {
  const markup = read("static/admin.html");
  const table = markup.slice(
    markup.indexOf('<table class="admin-table token-table">'),
    markup.indexOf('<tbody id="token-rows">'),
  );
  assert.match(table, /<th>限额<\/th>/);
  assert.match(read("static/js/tokens.js"), /el\("td", \{ class: "col-quota" \}, quotaCell\(t\)\)/);
});

test("token 数量缩写成 K/M/B，不在列里堆长数字", () => {
  const context = quotaContext(read("static/js/tokens.js"));
  for (const [count, want] of [
    [0, "0"],
    [999, "999"],
    [1_000, "1K"],
    [2_500, "2.5K"],
    [1_000_000, "1M"],
    [1_500_000, "1.5M"],
    [100_000_000, "100M"],
    [1_000_000_000, "1B"],
  ]) {
    const got = vm.runInContext(`formatTokenCount(${count})`, context);
    assert.equal(got, want, `formatTokenCount(${count})`);
  }
});

test("不限额的令牌只显示已用量，不编造剩余值", () => {
  const context = quotaContext(read("static/js/tokens.js"));
  const html = quotaMarkup(context, '{ quota: { used_tokens: 5000, limit_tokens: null } }');
  assert.match(html, /5K/);
  assert.match(html, /不限/);
  // 没有限额就不该出现第三段数字。
  assert.doesNotMatch(html, /quota-limit/);
});

test("用尽和接近用尽分别标红标黄", () => {
  const context = quotaContext(read("static/js/tokens.js"));

  const healthy = quotaMarkup(context,
    '{ quota: { used_tokens: 100, limit_tokens: 1000, remaining_tokens: 900, exhausted: false } }');
  assert.doesNotMatch(healthy, /danger|warn/);

  const near = quotaMarkup(context,
    '{ quota: { used_tokens: 850, limit_tokens: 1000, remaining_tokens: 150, exhausted: false } }');
  assert.match(near, /warn/);

  const exhausted = quotaMarkup(context,
    '{ quota: { used_tokens: 1000, limit_tokens: 1000, remaining_tokens: 0, exhausted: true } }');
  assert.match(exhausted, /danger/);
});

test("限额单元格展示服务端给的表达式，与输入框回填一致", () => {
  const context = quotaContext(read("static/js/tokens.js"));
  const html = quotaMarkup(context,
    '{ quota: { used_tokens: 0, limit_tokens: 100000000, remaining_tokens: 100000000, limit_expression: "100M" } }');
  // 列里显示 100M，编辑时输入框回填的也是 100M，不动表单再保存不会改变限额。
  assert.match(html, /100M/);
  assert.match(read("static/js/tokens.js"), /token\.quota\?\.limit_expression \|\| ""/);
});

test("新建令牌会清掉上一次的限额残留", () => {
  const source = read("static/js/tokens.js");
  assert.match(source, /tokenLimitInput\.value = "";/);
});

test("重置用量按钮只出现在设了限额的令牌上", () => {
  const source = read("static/js/tokens.js");
  // 不限额的令牌重置计数没有意义，按钮不该出现。
  const branch = source.slice(
    source.indexOf("t.quota?.limit_tokens"),
    source.indexOf("dataset: { tokenAction: \"delete\""),
  );
  assert.match(branch, /tokenAction: "reset-usage"/);
  // 条件为假时给 null，appendChildren 会把它跳过，不会多出一个空节点。
  assert.match(branch, /:\s*null,/);
});

test("重置用量走服务端的重置接口，且要二次确认", () => {
  const source = read("static/js/tokens.js");
  assert.match(source, /\/api\/admin\/tokens\/\$\{id\}\/usage\/reset/);
  assert.match(source, /method: "POST"/);
  // 清零后已用尽的令牌会立刻恢复可用，值得停一下问一次。
  const branch = source.slice(
    source.indexOf('=== "reset-usage"'),
    source.indexOf('=== "enable"'),
  );
  assert.match(branch, /requestConfirm/);
  assert.match(branch, /title: "重置用量"/);
});

test("重置接口在路由里注册过", () => {
  const router = read("internal/app/router.go");
  assert.match(router, /tokens\.Post\("\/\{id\}\/usage\/reset", handlers\.AdminResetTokenUsage/);
});
