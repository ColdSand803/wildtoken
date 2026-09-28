/* 优先级、权重清空后曾悄悄存成 100：保存出去的不是表单上看到的值。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../web/src/components/UpstreamDialog.tsx", import.meta.url), "utf8");

test("优先级和权重留空时报错，不回落默认值", () => {
  const start = source.indexOf("function payloadFromForm");
  assert.notEqual(start, -1, "payloadFromForm must exist");
  const body = source.slice(start, source.indexOf("\n}\n", start));

  assert.match(body, /priority: requiredNumber\(form\.priority, "优先级"\)/);
  assert.match(body, /weight: requiredNumber\(form\.weight, "基础权重"\)/);
  assert.doesNotMatch(body, /\|\| 100/);
});
