// 思考强度映射的输入解析。和模型映射共用一套写法，三种分隔符都要认。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { joinMappingLines, parseMappingLines } from "../web/src/mappingLines.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const parse = (value) => parseMappingLines(value, "思考强度映射");

test("思考强度映射按行解析", () => {
  assert.deepEqual(parse("max => xhigh"), { max: "xhigh" });
  assert.deepEqual(parse("  max  =>  xhigh  "), { max: "xhigh" });
  assert.deepEqual(parse("max => xhigh\nxhigh => high"), {
    max: "xhigh",
    xhigh: "high",
  });
});

/* 键的大小写由后端抹平（normalizeEffortMappings），前端原样上送即可。
   两边都转的话，哪天后端改了规则前端还在按老规则折，就会对不上。 */
test("键的大小写原样上送，由后端统一", () => {
  assert.deepEqual(parse("MAX => xhigh"), { MAX: "xhigh" });
  assert.match(read("internal/models/upstream.go"), /normalizeEffortMappings/);
});

test("=、: 与空行的写法与模型映射保持一致", () => {
  assert.deepEqual(parse("max = xhigh"), { max: "xhigh" });
  assert.deepEqual(parse("max: xhigh"), { max: "xhigh" });
  assert.deepEqual(parse("\n\n  \n"), {});
});

/* `a => b` 只找第一个 `=` 的话会切成 `a` 和 `> b`，而且不报错——这种错法在
   界面上完全看不出来。 */
test("=> 不会被当成 = 加一个多余的 >", () => {
  assert.deepEqual(parse("max => xhigh"), { max: "xhigh" });
  assert.notDeepEqual(parse("max => xhigh"), { max: "> xhigh" });
});

test("写错格式时报的是思考强度映射，而不是模型映射", () => {
  assert.throws(() => parse("没有分隔符"), /思考强度映射/);
});

test("回填时还原成每行一条的编辑格式", () => {
  assert.equal(joinMappingLines({ max: "xhigh", xhigh: "high" }), "max => xhigh\nxhigh => high");
  assert.equal(joinMappingLines({}), "");
});
