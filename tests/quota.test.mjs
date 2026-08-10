import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

/** 取出单个顶层函数体，好在不加载整个模块的情况下单独跑它。 */
function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} 不在源码里`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的函数体没有闭合`);
}

function quotaContext(source) {
  const context = vm.createContext({
    escapeHtml: (value) => String(value),
    Number,
    Math,
    String,
    isNaN,
  });
  vm.runInContext(extractFunction(source, "formatTokenCount"), context);
  vm.runInContext(
    source.slice(source.indexOf("const QUOTA_UNITS"), source.indexOf("function formatTokenCount")),
    context,
  );
  vm.runInContext(extractFunction(source, "formatTokenCount"), context);
  vm.runInContext(extractFunction(source, "quotaCellMarkup"), context);
  return context;
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
  assert.match(read("static/js/tokens.js"), /class="col-quota">\$\{quotaCellMarkup\(t\)\}/);
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
  const html = vm.runInContext(
    'quotaCellMarkup({ quota: { used_tokens: 5000, limit_tokens: null } })',
    context,
  );
  assert.match(html, /5K/);
  assert.match(html, /不限/);
  // 没有限额就不该出现第三段数字。
  assert.doesNotMatch(html, /quota-limit/);
});

test("用尽和接近用尽分别标红标黄", () => {
  const context = quotaContext(read("static/js/tokens.js"));

  const healthy = vm.runInContext(
    'quotaCellMarkup({ quota: { used_tokens: 100, limit_tokens: 1000, remaining_tokens: 900, exhausted: false } })',
    context,
  );
  assert.doesNotMatch(healthy, /danger|warn/);

  const near = vm.runInContext(
    'quotaCellMarkup({ quota: { used_tokens: 850, limit_tokens: 1000, remaining_tokens: 150, exhausted: false } })',
    context,
  );
  assert.match(near, /warn/);

  const exhausted = vm.runInContext(
    'quotaCellMarkup({ quota: { used_tokens: 1000, limit_tokens: 1000, remaining_tokens: 0, exhausted: true } })',
    context,
  );
  assert.match(exhausted, /danger/);
});

test("限额单元格展示服务端给的表达式，与输入框回填一致", () => {
  const context = quotaContext(read("static/js/tokens.js"));
  const html = vm.runInContext(
    'quotaCellMarkup({ quota: { used_tokens: 0, limit_tokens: 100000000, remaining_tokens: 100000000, limit_expression: "100M" } })',
    context,
  );
  // 列里显示 100M，编辑时输入框回填的也是 100M，不动表单再保存不会改变限额。
  assert.match(html, /100M/);
  assert.match(read("static/js/tokens.js"), /token\.quota\?\.limit_expression \|\| ""/);
});

test("新建令牌会清掉上一次的限额残留", () => {
  const source = read("static/js/tokens.js");
  assert.match(source, /tokenLimitInput\.value = "";/);
});
