// 会话模式的解析器。重点在容错：日志正文几乎总是被截断的（正文上限 1MB，
// 而一轮 Claude Code 请求常常超过它），标准 JSON.parse 对绝大多数日志都会失败。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function conversationContext() {
  const context = vm.createContext({
    // 渲染要用 bootstrap.js 里的 escapeHtml，这里给一个等价实现。
    escapeHtml: (value) =>
      String(value).replace(/[&<>"']/g, (c) => (
        { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
      )),
    TextEncoder,
  });
  vm.runInContext(read("static/js/conversation.js"), context);
  return context;
}

function call(context, expression, value) {
  context.__input = value;
  return vm.runInContext(expression, context);
}

// 只取结构摘要，避开 vm realm 的原型差异。
const shape = (context, parsed) => {
  context.__parsed = parsed;
  return vm.runInContext(
    `__parsed === null ? null : JSON.stringify({
       roles: __parsed.messages.map((m) => m.role),
       kinds: __parsed.messages.map((m) => m.blocks.map((b) => b.kind).join("+")),
       complete: __parsed.complete,
     })`,
    context,
  );
};

const parseRequest = (context, text) =>
  shape(context, call(context, "parseConversationRequest(__input)", text));
const parseResponse = (context, text) =>
  shape(context, call(context, "parseConversationResponse(__input)", text));

/* ── 容错扫描 ─────────────────────────────────────────────── */

test("完整正文与截断正文解析出同样多的完整消息", () => {
  const context = conversationContext();
  const full = JSON.stringify({
    model: "claude-opus-5",
    messages: [
      { role: "user", content: "第一条" },
      { role: "assistant", content: "第二条" },
      { role: "user", content: "第三条" },
    ],
  });

  assert.equal(
    parseRequest(context, full),
    JSON.stringify({ roles: ["user", "assistant", "user"], kinds: ["text", "text", "text"], complete: true }),
  );

  // 从第三条消息中间砍断：前两条应当照常恢复，并标记为不完整。
  const cut = full.slice(0, full.indexOf("第三条") + 2);
  assert.equal(
    parseRequest(context, cut),
    JSON.stringify({ roles: ["user", "assistant"], kinds: ["text", "text"], complete: false }),
  );
});

test("字符串里的括号和转义引号不会骗过扫描器", () => {
  const context = conversationContext();
  const body = JSON.stringify({
    messages: [
      { role: "user", content: '这里有 {"看似":"对象"} 和一个转义引号 \\" 还有 ]}' },
      { role: "assistant", content: "正常" },
    ],
  });

  assert.equal(
    parseRequest(context, body),
    JSON.stringify({ roles: ["user", "assistant"], kinds: ["text", "text"], complete: true }),
  );
});

test("正文尾部被截断但消息数组已闭合时，会话算完整", () => {
  const context = conversationContext();
  // messages 完整，后面的 tools 被砍断——对话本身没有缺失。
  const body = '{"messages":[{"role":"user","content":"你好"}],"tools":[{"name":"Bash","desc":"截断';

  assert.equal(
    parseRequest(context, body),
    JSON.stringify({ roles: ["user"], kinds: ["text"], complete: true }),
  );
});

test("完全不是会话的正文返回 null", () => {
  const context = conversationContext();
  for (const body of ["", "   ", "not json at all", '{"foo":"bar"}', "<html>502</html>"]) {
    assert.equal(parseRequest(context, body), null, `输入: ${body}`);
  }
});

/* ── 请求格式 ─────────────────────────────────────────────── */

test("Anthropic 请求：system 两种写法与四类内容块", () => {
  const context = conversationContext();

  const stringSystem = JSON.stringify({
    system: "你是助手", messages: [{ role: "user", content: "在吗" }],
  });
  assert.equal(
    parseRequest(context, stringSystem),
    JSON.stringify({ roles: ["system", "user"], kinds: ["text", "text"], complete: true }),
  );

  const blockSystem = JSON.stringify({
    system: [{ type: "text", text: "你是助手" }],
    messages: [
      { role: "user", content: [{ type: "text", text: "看这个" }] },
      {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "先读文件" },
          { type: "text", text: "好的" },
          { type: "tool_use", name: "Read", id: "t1", input: { path: "a.go" } },
        ],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "文件内容" }] },
    ],
  });
  assert.equal(
    parseRequest(context, blockSystem),
    JSON.stringify({
      roles: ["system", "user", "assistant", "user"],
      kinds: ["text", "text", "thinking+text+tool_use", "tool_result"],
      complete: true,
    }),
  );
});

test("OpenAI chat/completions：tool_calls 与 role:tool 都能识别", () => {
  const context = conversationContext();
  const body = JSON.stringify({
    messages: [
      { role: "system", content: "系统提示" },
      { role: "user", content: "算一下" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "calc", arguments: '{"x":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "42" },
    ],
  });

  assert.equal(
    parseRequest(context, body),
    JSON.stringify({
      roles: ["system", "user", "assistant", "tool"],
      kinds: ["text", "text", "tool_use", "tool_result"],
      complete: true,
    }),
  );
});

test("Responses API：instructions 当系统提示，input 当消息数组", () => {
  const context = conversationContext();
  const body = JSON.stringify({
    instructions: "你是助手",
    input: [{ role: "user", content: [{ type: "input_text", text: "你好" }] }],
  });

  assert.equal(
    parseRequest(context, body),
    JSON.stringify({ roles: ["system", "user"], kinds: ["text", "text"], complete: true }),
  );
});

/* ── 响应重组 ─────────────────────────────────────────────── */

test("Anthropic 流式：按 index 累积文本并拼回 tool_use 的入参", () => {
  const context = conversationContext();
  const sse = [
    'event: message_start',
    'data: {"type":"message_start","message":{"role":"assistant","content":[]}}',
    'event: content_block_start',
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"你好"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"世界"}}',
    'data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"t1","name":"Bash","input":{}}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\\"cmd\\":"}}',
    'data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\\"ls\\"}"}}',
    'data: {"type":"message_delta","delta":{"stop_reason":"tool_use"}}',
    'data: {"type":"message_stop"}',
  ].join("\n");

  assert.equal(
    parseResponse(context, sse),
    JSON.stringify({ roles: ["assistant"], kinds: ["text+tool_use"], complete: true }),
  );

  const parsed = call(context, "parseConversationResponse(__input)", sse);
  context.__p = parsed;
  assert.equal(vm.runInContext("__p.messages[0].blocks[0].text", context), "你好世界");
  assert.equal(vm.runInContext("__p.messages[0].blocks[1].input", context), '{"cmd":"ls"}');
  assert.equal(vm.runInContext("__p.stopReason", context), "tool_use");
});

test("OpenAI 流式：累积 delta.content 并忽略 [DONE]", () => {
  const context = conversationContext();
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"部分"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"回答"}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
  ].join("\n");

  const parsed = call(context, "parseConversationResponse(__input)", sse);
  context.__p = parsed;
  assert.equal(vm.runInContext("__p.messages[0].blocks[0].text", context), "部分回答");
  assert.equal(vm.runInContext("__p.stopReason", context), "stop");
});

test("流式正文被截断时，最后一行残缺的 data 被跳过而不是抛错", () => {
  const context = conversationContext();
  const sse = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"已收到"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"被截断',
  ].join("\n");

  const parsed = call(context, "parseConversationResponse(__input)", sse);
  context.__p = parsed;
  assert.equal(vm.runInContext("__p.messages[0].blocks[0].text", context), "已收到");
});

test("非流式响应：Anthropic content[] 与 OpenAI choices[].message", () => {
  const context = conversationContext();

  assert.equal(
    parseResponse(context, JSON.stringify({ content: [{ type: "text", text: "回答" }], stop_reason: "end_turn" })),
    JSON.stringify({ roles: ["assistant"], kinds: ["text"], complete: true }),
  );
  assert.equal(
    parseResponse(context, JSON.stringify({ choices: [{ message: { role: "assistant", content: "回答" }, finish_reason: "stop" }] })),
    JSON.stringify({ roles: ["assistant"], kinds: ["text"], complete: true }),
  );
  // 网关的错误 JSON 也要能读出来，而不是整块显示不了。
  assert.equal(
    parseResponse(context, JSON.stringify({ error: { type: "rate_limit_error", message: "太快了" } })),
    JSON.stringify({ roles: ["assistant"], kinds: ["error"], complete: true }),
  );
});

/* ── 渲染 ─────────────────────────────────────────────────── */

test("截断的会话渲染出提示，并说明恢复了多少", () => {
  const context = conversationContext();
  const parsed = call(context, "parseConversationRequest(__input)",
    '{"messages":[{"role":"user","content":"你好"},{"role":"assistant","content":"被截');
  context.__parsed = parsed;
  context.__meta = { truncated: true, byteLength: 1800000, capturedLength: 1000000 };
  const html = vm.runInContext("renderConversationHtml(__parsed, __meta)", context);

  assert.match(html, /conv-truncated/);
  assert.match(html, /已恢复 1 条消息/);
  assert.match(html, /1\.7MB/);
});

test("解析不出会话时给出切回原始模式的提示", () => {
  const context = conversationContext();
  const html = vm.runInContext("renderConversationHtml(null, {})", context);
  assert.match(html, /无法解析成会话/);
  assert.match(html, /原始模式/);
});

test("渲染对内容做 HTML 转义", () => {
  const context = conversationContext();
  const parsed = call(context, "parseConversationRequest(__input)",
    JSON.stringify({ messages: [{ role: "user", content: "<img src=x onerror=alert(1)>" }] }));
  context.__parsed = parsed;
  const html = vm.runInContext("renderConversationHtml(__parsed, {})", context);

  assert.doesNotMatch(html, /<img src=x/);
  assert.match(html, /&lt;img src=x/);
});

// 读一段对话不该先点开十几个块，所以正文平铺、其余块默认展开。
test("长正文平铺显示，不折叠也不加预览摘要", () => {
  const context = conversationContext();
  const long = "很长的内容".repeat(200);
  const parsed = call(context, "parseConversationRequest(__input)",
    JSON.stringify({ messages: [{ role: "user", content: long }] }));
  context.__parsed = parsed;
  const html = vm.runInContext("renderConversationHtml(__parsed, {})", context);

  assert.doesNotMatch(html, /<details/, "正文不应折叠");
  assert.match(html, /conv-block--text/);
  // 全文直接在页面上，而不是藏在摘要后面。
  assert.ok(html.includes(long), "正文应当完整平铺");
});

test("多行的思考与工具块用可折叠块，且默认展开", () => {
  const context = conversationContext();
  const parsed = call(context, "parseConversationRequest(__input)", JSON.stringify({
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先看文件\n再决定改哪里" },
        { type: "tool_use", name: "Edit", id: "t1", input: { path: "a.go", body: "x".repeat(200) } },
      ],
    }],
  }));
  context.__parsed = parsed;
  const html = vm.runInContext("renderConversationHtml(__parsed, {})", context);

  const details = html.match(/<details[^>]*>/g) || [];
  assert.equal(details.length, 2, "思考与工具各是一个折叠块");
  for (const tag of details) {
    assert.match(tag, /\bopen\b/, `默认应展开：${tag}`);
  }
  assert.match(html, /思考/);
  assert.match(html, /Edit/);
});

/* 单行内容占三行高度（角色行 + 摘要行 + 正文行）是这个视图最主要的空间浪费：
   实测 39% 的块只有一行内容。 */
test("单行内容内联成一行，不套折叠块", () => {
  const context = conversationContext();
  const parsed = call(context, "parseConversationRequest(__input)", JSON.stringify({
    messages: [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: "先看文件" },
        { type: "tool_use", name: "Read", id: "t1", input: { path: "a.go" } },
        { type: "tool_result", tool_use_id: "t1", content: "ok" },
      ],
    }],
  }));
  context.__parsed = parsed;
  const html = vm.runInContext("renderConversationHtml(__parsed, {})", context);

  assert.doesNotMatch(html, /<details/, "单行内容不该套折叠块");
  assert.equal((html.match(/conv-block--inline/g) || []).length, 3, "三个块都应内联");
  // 标签仍在，类型提示不丢。
  assert.match(html, /思考/);
  assert.match(html, /工具结果/);
});

test("短工具入参排成一行而不是缩进成三行", () => {
  const context = conversationContext();
  context.__input = { path: "a.go" };
  const short = vm.runInContext("renderToolInput(__input)", context);
  assert.equal(short, '{"path":"a.go"}', "短入参应当是紧凑单行");

  // 超过阈值就回到缩进版本，长入参挤成一行反而看不清。
  context.__input = { path: "a.go", body: "x".repeat(200) };
  const long = vm.runInContext("renderToolInput(__input)", context);
  assert.match(long, /\n/, "长入参应当保留缩进换行");
});

test("角色不再独占一行", () => {
  const context = conversationContext();
  const parsed = call(context, "parseConversationRequest(__input)",
    JSON.stringify({ messages: [{ role: "user", content: "你好" }] }));
  context.__parsed = parsed;
  const html = vm.runInContext("renderConversationHtml(__parsed, {})", context);

  // 角色与序号仍在，但和内容并排（靠 CSS grid 分栏），不再是一个标题行。
  assert.match(html, /conv-msg-role/);
  assert.match(html, /conv-role-name/);
  assert.doesNotMatch(html, /#1<\/span>/, "序号前不该再带 # 号占宽");
});

// 实测工具结果有近一半的行是空行，最长一次连着 80 行，会把一条消息撑开好几屏。
test("压掉成片空行，但保留行内缩进", () => {
  const context = conversationContext();
  const messy = "\n\n  开头有空行\n\n\n\n\n中间连着五个换行\n    缩进的代码行\n\t制表符行  \n\n\n";
  context.__x = messy;
  const tidy = vm.runInContext("tidyBlockText(__x)", context);

  assert.equal(tidy.startsWith("开头有空行"), true, "首尾空白应被去掉");
  assert.equal(tidy.endsWith("制表符行"), true, "行尾空白与末尾空行应被去掉");
  assert.doesNotMatch(tidy, /\n{3,}/, "不应再有连续两个以上的空行");
  assert.match(tidy, /\n\n中间连着五个换行/, "段落之间保留一个空行");
  assert.match(tidy, /\n {4}缩进的代码行/, "行内缩进必须原样保留");
  assert.match(tidy, /\n\t制表符行/, "制表符缩进必须原样保留");
});

test("正文、思考、工具结果都会做空白清理", () => {
  const context = conversationContext();
  const messy = "开头\n\n\n\n\n结尾";
  const parsed = call(context, "parseConversationRequest(__input)", JSON.stringify({
    messages: [{
      role: "assistant",
      content: [
        { type: "text", text: messy },
        { type: "thinking", thinking: messy },
        { type: "tool_result", tool_use_id: "t1", content: messy },
      ],
    }],
  }));
  context.__parsed = parsed;
  const html = vm.runInContext("renderConversationHtml(__parsed, {})", context);

  assert.doesNotMatch(html, /开头\n{3,}/, "三种块都不应残留成片空行");
  assert.equal((html.match(/开头\n\n结尾/g) || []).length, 3, "三种块都应压成一个空行");
});

test("会话头部提供一键全部折叠的出口", () => {
  const context = conversationContext();
  const parsed = call(context, "parseConversationRequest(__input)",
    JSON.stringify({ messages: [{ role: "user", content: "你好" }] }));
  context.__parsed = parsed;
  const html = vm.runInContext("renderConversationHtml(__parsed, {})", context);

  assert.match(html, /data-conv-fold="collapse"/);
  assert.match(html, /全部折叠/);
});

/* 会话块用的是嵌套的 pre / summary。详情面板给自己那一层写的样式如果用后代
   选择器，就会连带命中会话块——实测 `.request-detail-grid pre` 的
   min-height:220px 和 `.log-detail-section summary` 的 min-height:56px 会把
   每个块撑开，一句话的消息底下全是空白。这些规则必须用直接子选择器。 */
test("详情面板的 pre 与 summary 样式不会漏进会话块", () => {
  const css = read("static/css/logs-tokens.css") + "\n" + read("static/css/responsive.css");
  const leaky = css.match(
    /\.(log-detail-section|request-detail-grid|log-detail-code-frame)[^,{>]*\s+(pre|summary)\s*[,{:]/g,
  ) || [];

  assert.deepEqual(leaky, [], `这些选择器会漏进会话块，需改成直接子选择器：\n  ${leaky.join("\n  ")}`);
});

test("会话块自身不设最小高度", () => {
  const css = read("static/css/logs-tokens.css");
  const convRules = css.match(/\.conv-[^{]*\{[^}]*\}/g) || [];
  const withMinHeight = convRules.filter((rule) => /min-height/.test(rule));

  assert.deepEqual(withMinHeight, [], `会话块不该有最小高度：\n${withMinHeight.join("\n")}`);
});
