// 令牌预览格右侧的图标：复制与封存两态。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { tokenPreview } from "../web/src/tokenFormat.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("web/src/pages/TokensPage.tsx");

/* 封存令牌（明文取不回来）和普通令牌用不同图标，别弄混：一个是锁梁，
   一个是叠层。 */
test("封存与可复制用的是两个不同图标", () => {
  // 锁梁
  assert.match(source, /M8 11V8a4 4 0 0 1 8 0v3/);
  // 叠层
  assert.match(source, /M5 15V7a2 2 0 0 1 2-2h8/);
});

/* 图标必须是每次调用新建的节点。改回共享常量的话，第二行的图标会被第一行
   偷走——DOM 里一个节点只能挂在一处。 */
test("图标是函数而不是共享常量", () => {
  assert.match(source, /const copyGlyph = \(\) =>/);
  assert.match(source, /const sealedGlyph = \(\) =>/);
});

/* 明文取不回来时退回后端存的前缀预览，而不是显示空白或编一个出来。 */
test("封存令牌回落到后端给的预览", () => {
  assert.equal(tokenPreview("", "sk-abc…"), "sk-abc…");
  assert.equal(tokenPreview("sk-1234567890ab", "sk-123…"), "sk-1****90ab");
});

test("按明文是否存在切换图标", () => {
  const row = source.slice(source.indexOf("function TokenRow"));
  assert.match(row, /sealed \? sealedGlyph\(\) : copyGlyph\(\)/);
  assert.match(source, /const sealed = !token\.token/);
});
