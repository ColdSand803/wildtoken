// 日志列表的 Tokens 列与响应性能列。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { exactTokens, firstTokenTone, formatCount, formatSeconds } from "../web/src/logFormat.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("web/src/pages/LogsPage.tsx");

/**
 * 取一个单元格的源码。
 *
 * 按下一个 data-col 定界而不是找 </td>：格内有嵌套标签，从开头往后找
 * 第一个 </td> 会切在内层。
 */
function cellSource(col) {
  // 从 LogRow 开始找：data-col 在表头先出现一轮，从头找会切到表头去。
  const rowAt = source.indexOf("function LogRow");
  assert.notEqual(rowAt, -1, "日志行组件必须存在");

  const start = source.indexOf(`data-col="${col}"`, rowAt);
  assert.notEqual(start, -1, `${col} 单元格必须存在`);
  const next = source.indexOf("data-col=", start + 10);
  return source.slice(start, next === -1 ? source.length : next);
}

const listTokenCell = () => cellSource("tokens");

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
  const arrows = [...cell.matchAll(/>(↑|↓)</g)].map((match) => match[1]);
  assert.deepEqual(arrows, ["↑", "↓"], "输入在上、输出在下");

  // 两行而非并排：容器是单列 grid，不声明 grid-template-columns。
  const css = read("static/css/logs-tokens.css");
  const start = css.indexOf(".token-io {");
  const container = css.slice(start, css.indexOf("}", start));
  assert.match(container, /display:\s*grid/);
  assert.doesNotMatch(container, /grid-template-columns/);
});

test("箭头对读屏隐藏，数值另有文字标签", () => {
  const cell = listTokenCell();
  // 读屏念不出 ↑↓，所以整体挂 aria-label，箭头本身隐藏。
  assert.equal([...cell.matchAll(/aria-hidden="true"/g)].length, 2);
  assert.match(cell, /role="img"/);
  assert.match(cell, /aria-label=/);
});

/* 扫列表要的是量级，2500000 这种长数字会挤掉别的列。但缩写不能把数字弄丢，
   精确值必须还能看到。 */
test("列里显示缩写，精确值留在 title 和 aria-label", () => {
  assert.equal(formatCount(2_500_000), "2.5M");
  assert.equal(formatCount(1234), "1.2K");
  assert.equal(exactTokens("输入", 2_500_000), "输入 2,500,000 tokens");
  assert.equal(exactTokens("输出", 1234), "输出 1,234 tokens");
});

test("缺失的 token 数显示为 -，不编造 0", () => {
  // 0 和「没有记录」是两回事，一个失败的请求不该看起来像用了 0 个 token。
  assert.equal(formatCount(null), "-");
  assert.equal(formatCount(0), "0");
  assert.equal(exactTokens("输入", null), "输入 - tokens");
});

test("耗时一律用秒，缺失同样是 -", () => {
  assert.equal(formatSeconds(1234), "1.2s");
  assert.equal(formatSeconds(null), "-");
});

/* 首字只看绝对值。写死成 neutral 的话，CSS 里 ok/warn/danger 三条规则一条
   都不会触发，整列永远是灰的。 */
test("首字耗时按绝对值分档", () => {
  assert.equal(firstTokenTone(1000), "ok");
  assert.equal(firstTokenTone(7000), "warn");
  assert.equal(firstTokenTone(12_000), "danger");
  assert.equal(firstTokenTone(null), "neutral");
});

test("响应性能列只有首字和总耗时两行", () => {
  const cell = cellSource("duration");

  const labels = [...cell.matchAll(/<small>([^<]+)<\/small>/g)].map((match) => match[1]);
  // 两个标签等宽，两行的数值才对得齐（「总耗时」三字会把第二行推出去）。
  assert.deepEqual(labels, ["首字", "耗时"]);
  assert.equal(new Set(labels.map((label) => label.length)).size, 1, "两个标签应等长");

  // 流式标签和 TPS 已移除，否则这一列又会回到三行。
  assert.doesNotMatch(source, /formatThroughput/);
  assert.doesNotMatch(read("static/css/tables.css"), /stream-throughput|throughput-stat/);
});

test("标签与数值同行，两项竖向堆叠", () => {
  /* 两行而不是四行：容器是单列 grid，每项内部是 flex（标签+值同行）。
     反过来写就是原来那个占三行的版本。 */
  const css = read("static/css/tables.css");
  const metricsAt = css.indexOf(".latency-metrics {");
  const metrics = css.slice(metricsAt, css.indexOf("}", metricsAt));
  assert.match(metrics, /display:\s*grid/);
  assert.doesNotMatch(metrics, /grid-template-columns|display:\s*flex/);

  const metricAt = css.indexOf(".latency-metric {");
  const metric = css.slice(metricAt, css.indexOf("}", metricAt));
  assert.match(metric, /display:\s*flex/);
});

test("旧的三列类名没有残留", () => {
  // 留着会是一条指向不存在元素的规则，下一个人得先证明它是死的。
  for (const file of [
    "web/src/pages/LogsPage.tsx",
    "static/css/logs-tokens.css",
    "static/css/responsive.css",
    "static/css/tables.css",
  ]) {
    assert.doesNotMatch(read(file), /token-total|token-cached|token-reasoning/, file);
  }
});
