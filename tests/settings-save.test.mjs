/* 设置页：每张卡只保存自己的字段，数字框清空不回写 0。原先整页提交，另一张卡
   没确认的改动跟着落库；图片上限清空按 0 存，已存的图就全删了。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/src/pages/SettingsPage.tsx", import.meta.url), "utf8");

test("保存只提交本卡的字段，其余取服务端最近一次的值", () => {
  assert.match(source, /saveSettings\(withFields\(saved, settings, CARD_FIELDS\[card\]\)\)/);
  assert.doesNotMatch(source, /saveSettings\(settings\)/);
});

test("页面上改得到的设置都归属某张卡", () => {
  const cards = source.slice(source.indexOf("const CARD_FIELDS"), source.indexOf("satisfies Record"));
  const patched = [...source.matchAll(/patch\("([a-z_]+)"/g)].map((match) => match[1]);
  assert.ok(patched.length > 0);
  for (const field of patched) {
    assert.match(cards, new RegExp(`"${field}"`), `${field} 不在任何一张卡里，保存时不会提交`);
  }
});

test("数字框清空不回写", () => {
  const field = source.slice(source.indexOf("function NumberField"));
  assert.match(field, /if \(raw !== "" && Number\.isFinite\(value\)\) onChange\(value\)/);
});
