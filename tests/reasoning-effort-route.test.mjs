// 日志里的思考强度有三个环节：下游请求的、实际发往上游的、上游回报的。
// 这里锁住合并规则——改写发生时必须看得见真实发出的那个值。
import assert from "node:assert/strict";
import test from "node:test";

import { createDomContext, extractFunction, read, vm } from "./dom-stub.mjs";

function routeContext() {
  const source = read("static/js/logs.js");
  // 渲染返回节点，所以沙箱要带 DOM 和真实的 el()。
  const context = createDomContext();
  for (const name of [
    "getReasoningEffortRoute",
    "reasoningEffortTitle",
    "routeFollowerLine",
    "renderLogReasoningEffort",
  ]) {
    vm.runInContext(extractFunction(source, name), context);
  }
  return context;
}

// 只取每个环节的值，避开 vm realm 的原型差异。
function chainOf(context, log) {
  context.candidate = log;
  return vm.runInContext(
    "getReasoningEffortRoute(candidate).chain.map((s) => s.value).join('>')",
    context,
  );
}

test("渠道改写过强度时，实际发往上游的值出现在链路里", () => {
  const context = routeContext();

  // 上游没回报强度：没有上游环节的话，日志就只剩 max，等于把真实值藏了。
  assert.equal(
    chainOf(context, { reasoning_effort: "max", upstream_reasoning_effort: "xhigh" }),
    "max>xhigh",
  );

  // 上游回报的和发出去的一致，合并掉，不重复显示。
  assert.equal(
    chainOf(context, {
      reasoning_effort: "max",
      upstream_reasoning_effort: "xhigh",
      response_reasoning_effort: "xhigh",
    }),
    "max>xhigh",
  );

  // 三个环节都不同，就都要显示出来。
  assert.equal(
    chainOf(context, {
      reasoning_effort: "max",
      upstream_reasoning_effort: "xhigh",
      response_reasoning_effort: "high",
    }),
    "max>xhigh>high",
  );
});

test("没有改写时的显示与从前一致", () => {
  const context = routeContext();

  // 未配置映射：请求与发出一致，合并成单值。
  assert.equal(
    chainOf(context, { reasoning_effort: "high", upstream_reasoning_effort: "high" }),
    "high",
  );
  // 旧日志行没有 upstream 字段，也不能凭空多出环节。
  assert.equal(chainOf(context, { reasoning_effort: "high" }), "high");
  // 请求没写强度、只有上游回报。
  assert.equal(chainOf(context, { response_reasoning_effort: "medium" }), "medium");
  // 请求与响应不同仍然成链，这是改动前就有的行为。
  assert.equal(
    chainOf(context, { reasoning_effort: "high", response_reasoning_effort: "low" }),
    "high>low",
  );
  // 完全没有强度信息。
  assert.equal(chainOf(context, {}), "");
});

test("单值渲染成纯文本，多环节渲染成带 title 的路由", () => {
  const context = routeContext();

  const render = (log) => {
    context.candidate = log;
    return vm.runInContext("renderLogReasoningEffort(candidate).outerHTML", context);
  };

  const single = render({ reasoning_effort: "high", upstream_reasoning_effort: "high" });
  assert.match(single, /model-single/);
  assert.doesNotMatch(single, /model-route/);

  const routed = render({ reasoning_effort: "max", upstream_reasoning_effort: "xhigh" });
  assert.match(routed, /model-route/);
  assert.match(routed, /请求强度：max；上游强度：xhigh/);
  assert.match(routed, /xhigh/);

  assert.match(render({}), /muted/);
});
