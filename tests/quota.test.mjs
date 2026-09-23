// 令牌限额的展示规则。纯函数直接 import 真实模块跑，剩下的锁在源码契约上。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { formatCount, quotaTone } from "../web/src/tokenFormat.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

test("token 数量缩写成 K/M/B，不在列里堆长数字", () => {
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
    assert.equal(formatCount(count), want, `formatCount(${count})`);
  }
});

test("用尽和接近用尽分别标红标黄", () => {
  assert.equal(quotaTone({ exhausted: false, used: 100, limit: 1000 }), "");
  assert.equal(quotaTone({ exhausted: false, used: 800, limit: 1000 }), "warn");
  assert.equal(quotaTone({ exhausted: true, used: 1000, limit: 1000 }), "danger");
});

/* exhausted 以服务端为准。自己比大小的话，两边算法一旦漂了，界面会说还有余量
   而请求已经被拒。 */
test("服务端说用尽就是用尽，不用比例复核", () => {
  assert.equal(quotaTone({ exhausted: true, used: 0, limit: 1000 }), "danger");
});

test("没有限额时不编造色调", () => {
  assert.equal(quotaTone({ exhausted: false, used: 5000, limit: 0 }), "");
});

test("不限额的令牌只显示已用量，不编造剩余值", () => {
  const source = read("web/src/pages/TokensPage.tsx");
  const branch = source.slice(
    source.indexOf("quota.limit_tokens === null"),
    source.indexOf("const limit = Number"),
  );
  assert.match(branch, /不限/);
  // 没有限额就不该出现第三段数字。
  assert.doesNotMatch(branch, /quota-limit/);
});

test("限额单元格展示服务端给的表达式，与输入框回填一致", () => {
  // 列里显示什么，编辑时输入框就回填什么，不动表单再保存不会改变限额。
  assert.match(read("web/src/pages/TokensPage.tsx"), /quota\.limit_expression/);
  assert.match(read("web/src/components/TokenDialog.tsx"), /limit_expression/);
});

test("重置用量按钮只出现在设了限额的令牌上", () => {
  const source = read("web/src/pages/TokensPage.tsx");
  // 不限额的令牌重置计数没有意义，按钮不该出现。
  assert.match(source, /token\.quota\.limit_tokens[\s\S]{0,200}?reset/i);
});

test("重置用量走服务端的重置接口，且要二次确认", () => {
  assert.match(read("web/src/api.ts"), /\/usage\/reset/);
  // 清零后已用尽的令牌会立刻恢复可用，值得停一下问一次。
  const source = read("web/src/pages/TokensPage.tsx");
  const branch = source.slice(source.indexOf("resetTokenUsage"));
  assert.match(branch.slice(0, 600), /confirm/i);
});

test("重置接口在路由里注册过", () => {
  const router = read("internal/app/router.go");
  assert.match(router, /tokens\.Post\("\/\{id\}\/usage\/reset", handlers\.AdminResetTokenUsage/);
});
