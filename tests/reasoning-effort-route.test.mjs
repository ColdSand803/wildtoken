// 日志里的思考强度有三个环节：下游请求的、实际发往上游的、上游回报的。
// 这里锁住合并规则——改写发生时必须看得见真实发出的那个值。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { reasoningChain } from "../web/src/reasoningChain.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/** 只取每个环节的值，断言才读得懂。 */
const chainOf = (log) =>
  reasoningChain({
    reasoning_effort: null,
    upstream_reasoning_effort: null,
    ...log,
  })
    .map((step) => step.value)
    .join(">");

test("渠道改写过强度时，实际发往上游的值出现在链路里", () => {
  // 上游没回报强度：没有上游环节的话，日志就只剩 max，等于把真实值藏了。
  assert.equal(chainOf({ reasoning_effort: "max", upstream_reasoning_effort: "xhigh" }), "max>xhigh");

  // 上游回报的和发出去的一致，合并掉，不重复显示。
  assert.equal(
    chainOf({
      reasoning_effort: "max",
      upstream_reasoning_effort: "xhigh",
      response_reasoning_effort: "xhigh",
    }),
    "max>xhigh",
  );

  // 三个环节都不同，就都要显示出来。
  assert.equal(
    chainOf({
      reasoning_effort: "max",
      upstream_reasoning_effort: "xhigh",
      response_reasoning_effort: "high",
    }),
    "max>xhigh>high",
  );
});

test("没有改写时的显示与从前一致", () => {
  // 未配置映射：请求与发出一致，合并成单值。
  assert.equal(chainOf({ reasoning_effort: "high", upstream_reasoning_effort: "high" }), "high");
  // 旧日志行没有 upstream 字段，也不能凭空多出环节。
  assert.equal(chainOf({ reasoning_effort: "high" }), "high");
  // 请求没写强度、只有上游回报。
  assert.equal(chainOf({ response_reasoning_effort: "medium" }), "medium");
  // 请求与响应不同仍然成链。
  assert.equal(
    chainOf({ reasoning_effort: "high", response_reasoning_effort: "low" }),
    "high>low",
  );
  // 完全没有强度信息。
  assert.equal(chainOf({}), "");
});

/* 单值是一段纯文本，多环节才画成带箭头的路由并把完整说明放进 title。
   单值也套路由外壳的话，绝大多数行会白白多出一层缩进。 */
test("单值渲染成纯文本，多环节渲染成带 title 的路由", () => {
  const source = read("web/src/pages/LogsPage.tsx");
  const cell = source.slice(
    source.indexOf("function ReasoningCell"),
    source.indexOf("const CLIENT_TYPES"),
  );

  assert.match(cell, /chain\.length === 1/, "单值要单独一条分支");
  assert.match(cell, /className="model-text model-single"/);
  assert.match(cell, /className="model-route" title=\{title\}/);
  // title 把三段完整写出来，列里放不下的信息在这里补齐。
  assert.match(cell, /chain\.map\(\(step\) => `\$\{step\.label\}：\$\{step\.value\}`\)/);
});
