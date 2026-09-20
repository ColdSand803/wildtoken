import assert from "node:assert/strict";
import test from "node:test";

import { createDomContext, extractFunction, read, vm } from "./dom-stub.mjs";

/** 真跑一次 formatTokens，拿它实际造出的节点树断言。 */
function renderTokenCell(log) {
  const context = createDomContext();
  vm.runInContext(extractFunction(read("static/js/logs.js"), "formatTokens"), context);
  context.log = log;
  return vm.runInContext("formatTokens(log).outerHTML", context);
}

/** 列表里那个 Tokens 单元格的构造函数。 */
function listTokenCell() {
  const source = read("static/js/logs.js");
  const start = source.indexOf("function formatTokens(log)");
  assert.notEqual(start, -1, "列表的 tokens 渲染函数必须存在");
  return source.slice(start, source.indexOf("\n}", start));
}

test("列表的 Tokens 列只有输入和输出两项", () => {
  const cell = listTokenCell();
  const fields = [...cell.matchAll(/log\.(\w+)/g)].map((match) => match[1]);
  assert.deepEqual(
    [...new Set(fields)].sort(),
    ["completion_tokens", "prompt_tokens"],
    "列表只读输入和输出；总计是两者相加，缓存与思考留在详情面板",
  );
});

test("输入输出各占一行，用上下箭头区分", () => {
  const cell = listTokenCell();
  // 箭头指向模型：↑ 发出去，↓ 收回来。顺序反了含义就反了。
  const arrows = [...cell.matchAll(/"(↑|↓)"/g)].map((match) => match[1]);
  assert.deepEqual(arrows, ["↑", "↓"], "输入在上、输出在下");

  // 两行而非并排：容器是单列 grid，不声明 grid-template-columns。
  const css = read("static/css/logs-tokens.css");
  const container = css.slice(css.indexOf(".token-io {"), css.indexOf("}", css.indexOf(".token-io {")));
  assert.match(container, /display:\s*grid/);
  assert.doesNotMatch(container, /grid-template-columns/);
});

test("箭头对读屏隐藏，数值另有文字标签", () => {
  const html = renderTokenCell({ prompt_tokens: 1234, completion_tokens: 567 });
  // 读屏念不出 ↑↓，所以整体挂 aria-label，箭头本身隐藏。
  assert.match(html, /aria-label="输入 1234 tokens，输出 567 tokens"/);
  assert.match(html, /aria-hidden="true">↑</);
  assert.match(html, /aria-hidden="true">↓</);
  assert.match(html, /<b>1234<\/b>/);
  assert.match(html, /<b>567<\/b>/);
});

test("缺失的 token 数显示为 -，不编造 0", () => {
  // 0 和“没有记录”是两回事，一个失败的请求不该看起来像用了 0 个 token。
  const html = renderTokenCell({ prompt_tokens: null, completion_tokens: undefined });
  assert.match(html, /<b>-<\/b>/);
  assert.doesNotMatch(html, /<b>0<\/b>/);
});

test("旧的三列类名没有残留", () => {
  // 留着会是一条指向不存在元素的规则，下一个人得先证明它是死的。
  for (const file of [
    "static/js/logs.js",
    "static/css/logs-tokens.css",
    "static/css/responsive.css",
    "static/css/tables.css",
  ]) {
    assert.doesNotMatch(read(file), /token-triple/, `${file} 仍引用 token-triple`);
  }
});
