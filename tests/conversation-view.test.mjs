// 会话模式的解析器。重点在容错：日志正文几乎总是被截断的（正文上限 1MB，
// 而一轮 Claude Code 请求常常超过它），标准 JSON.parse 对绝大多数日志都会失败。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/* 直接 import 真实模块（Node 能擦除 TS 类型），而不是在 vm 里跑源码字符串：
   测的就是控制台真正加载的那份代码，也不再需要绕开 realm 原型差异。 */
import {
  pairToolCalls,
  parseConversationRequest,
  parseConversationResponse,
} from "../web/src/conversation.ts";

/** 只取结构摘要：角色序列、每条的块类型、是否完整。 */
const shape = (parsed) =>
  parsed === null
    ? null
    : JSON.stringify({
        roles: parsed.messages.map((message) => message.role),
        kinds: parsed.messages.map((message) =>
          message.blocks.map((block) => block.kind).join("+"),
        ),
        complete: parsed.complete,
      });

const parseRequest = (text) => shape(parseConversationRequest(text));
const parseResponse = (text) => shape(parseConversationResponse(text));

/* ── 容错扫描 ─────────────────────────────────────────────── */

test("完整正文与截断正文解析出同样多的完整消息", () => {
  const full = JSON.stringify({
    model: "claude-opus-5",
    messages: [
      { role: "user", content: "第一条" },
      { role: "assistant", content: "第二条" },
      { role: "user", content: "第三条" },
    ],
  });

  assert.equal(
    parseRequest(full),
    JSON.stringify({ roles: ["user", "assistant", "user"], kinds: ["text", "text", "text"], complete: true }),
  );

  // 从第三条消息中间砍断：前两条应当照常恢复，并标记为不完整。
  const cut = full.slice(0, full.indexOf("第三条") + 2);
  assert.equal(
    parseRequest(cut),
    JSON.stringify({ roles: ["user", "assistant"], kinds: ["text", "text"], complete: false }),
  );
});

test("字符串里的括号和转义引号不会骗过扫描器", () => {
  const body = JSON.stringify({
    messages: [
      { role: "user", content: '这里有 {"看似":"对象"} 和一个转义引号 \\" 还有 ]}' },
      { role: "assistant", content: "正常" },
    ],
  });

  assert.equal(
    parseRequest(body),
    JSON.stringify({ roles: ["user", "assistant"], kinds: ["text", "text"], complete: true }),
  );
});

test("正文尾部被截断但消息数组已闭合时，会话算完整", () => {
  // messages 完整，后面的 tools 被砍断——对话本身没有缺失。
  const body = '{"messages":[{"role":"user","content":"你好"}],"tools":[{"name":"Bash","desc":"截断';

  assert.equal(
    parseRequest(body),
    JSON.stringify({ roles: ["user"], kinds: ["text"], complete: true }),
  );
});

test("完全不是会话的正文返回 null", () => {
  for (const body of ["", "   ", "not json at all", '{"foo":"bar"}', "<html>502</html>"]) {
    assert.equal(parseRequest(body), null, `输入: ${body}`);
  }
});

/* ── 请求格式 ─────────────────────────────────────────────── */

test("Anthropic 请求：system 两种写法与四类内容块", () => {

  const stringSystem = JSON.stringify({
    system: "你是助手", messages: [{ role: "user", content: "在吗" }],
  });
  assert.equal(
    parseRequest(stringSystem),
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
    parseRequest(blockSystem),
    JSON.stringify({
      roles: ["system", "user", "assistant", "user"],
      kinds: ["text", "text", "thinking+text+tool_use", "tool_result"],
      complete: true,
    }),
  );
});

test("OpenAI chat/completions：tool_calls 与 role:tool 都能识别", () => {
  const body = JSON.stringify({
    messages: [
      { role: "system", content: "系统提示" },
      { role: "user", content: "算一下" },
      { role: "assistant", content: null, tool_calls: [{ id: "c1", function: { name: "calc", arguments: '{"x":1}' } }] },
      { role: "tool", tool_call_id: "c1", content: "42" },
    ],
  });

  assert.equal(
    parseRequest(body),
    JSON.stringify({
      roles: ["system", "user", "assistant", "tool"],
      kinds: ["text", "text", "tool_use", "tool_result"],
      complete: true,
    }),
  );
});

test("Responses API：instructions 当系统提示，input 当消息数组", () => {
  const body = JSON.stringify({
    instructions: "你是助手",
    input: [{ role: "user", content: [{ type: "input_text", text: "你好" }] }],
  });

  assert.equal(
    parseRequest(body),
    JSON.stringify({ roles: ["system", "user"], kinds: ["text", "text"], complete: true }),
  );
});

/* ── 响应重组 ─────────────────────────────────────────────── */

test("Anthropic 流式：按 index 累积文本并拼回 tool_use 的入参", () => {
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
    parseResponse(sse),
    JSON.stringify({ roles: ["assistant"], kinds: ["text+tool_use"], complete: true }),
  );

  const parsed = parseConversationResponse(sse);
  assert.equal(parsed.messages[0].blocks[0].text, "你好世界");
  assert.equal(parsed.messages[0].blocks[1].input, '{"cmd":"ls"}');
  assert.equal(parsed.stopReason, "tool_use");
});

test("OpenAI 流式：累积 delta.content 并忽略 [DONE]", () => {
  const sse = [
    'data: {"choices":[{"index":0,"delta":{"content":"部分"}}]}',
    'data: {"choices":[{"index":0,"delta":{"content":"回答"}}]}',
    'data: {"choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
    "data: [DONE]",
  ].join("\n");

  const parsed = parseConversationResponse(sse);
  assert.equal(parsed.messages[0].blocks[0].text, "部分回答");
  assert.equal(parsed.stopReason, "stop");
});

test("流式正文被截断时，最后一行残缺的 data 被跳过而不是抛错", () => {
  const sse = [
    'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"已收到"}}',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"被截断',
  ].join("\n");

  const parsed = parseConversationResponse(sse);
  assert.equal(parsed.messages[0].blocks[0].text, "已收到");
});

test("非流式响应：Anthropic content[] 与 OpenAI choices[].message", () => {

  assert.equal(
    parseResponse(JSON.stringify({ content: [{ type: "text", text: "回答" }], stop_reason: "end_turn" })),
    JSON.stringify({ roles: ["assistant"], kinds: ["text"], complete: true }),
  );
  assert.equal(
    parseResponse(JSON.stringify({ choices: [{ message: { role: "assistant", content: "回答" }, finish_reason: "stop" }] })),
    JSON.stringify({ roles: ["assistant"], kinds: ["text"], complete: true }),
  );
  // 网关的错误 JSON 也要能读出来，而不是整块显示不了。
  assert.equal(
    parseResponse(JSON.stringify({ error: { type: "rate_limit_error", message: "太快了" } })),
    JSON.stringify({ roles: ["assistant"], kinds: ["error"], complete: true }),
  );
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

/* agent 长会话里工具调用和结果各占一条消息，实测中位 234 条消息的会话有
   120 对。合成一块后读者不用自己把上下两条对上。 */
test("工具调用和紧接着的结果合成一块，其余原样", () => {
  const paired = pairToolCalls([
    { role: "system", blocks: [{ kind: "text", text: "s" }] },
    {
      role: "assistant",
      blocks: [
        { kind: "text", text: "看一下" },
        { kind: "tool_use", name: "read", id: "a", input: { path: "x" } },
        { kind: "tool_use", name: "grep", id: "b", input: {} },
      ],
    },
    {
      role: "user",
      blocks: [
        { kind: "tool_result", id: "b", isError: true, text: "no match" },
        { kind: "tool_result", id: "a", isError: false, text: "content" },
        { kind: "text", text: "顺手补一句" },
      ],
    },
    { role: "assistant", blocks: [{ kind: "text", text: "好" }] },
  ]);

  assert.equal(paired.length, 4, "结果消息被吞掉，留下的那句话单独成一条");
  const call = paired[1].blocks;
  assert.deepEqual(
    call.map((b) => b.kind),
    ["text", "tool_call", "tool_call"],
  );
  assert.deepEqual(call[1].result, { isError: false, text: "content" }, "按 id 配，不按顺序");
  assert.deepEqual(call[2].result, { isError: true, text: "no match" });
  assert.deepEqual(paired[2], { role: "user", blocks: [{ kind: "text", text: "顺手补一句" }] });
});

/* OpenAI 把 N 个 tool_calls 的结果拆成 N 条连续的 role:tool 消息，每条一个。
   只看「紧接着的下一条」的话，第二个之后的结果全落单——实测 25 条真实会话里
   有 26 个调用因此配不上。 */
test("OpenAI：一条消息多个调用，结果分成多条连续 tool 消息", () => {
  const paired = pairToolCalls([
    {
      role: "assistant",
      blocks: [
        { kind: "tool_use", name: "read", id: "c1", input: {} },
        { kind: "tool_use", name: "read", id: "c2", input: {} },
        { kind: "tool_use", name: "grep", id: "c3", input: {} },
      ],
    },
    { role: "tool", blocks: [{ kind: "tool_result", id: "c1", isError: false, text: "r1" }] },
    { role: "tool", blocks: [{ kind: "tool_result", id: "c2", isError: false, text: "r2" }] },
    { role: "tool", blocks: [{ kind: "tool_result", id: "c3", isError: true, text: "r3" }] },
    { role: "assistant", blocks: [{ kind: "text", text: "读完了" }] },
  ]);

  assert.equal(paired.length, 2, "三条 tool 消息全被吸收");
  assert.deepEqual(
    paired[0].blocks.map((b) => b.result?.text),
    ["r1", "r2", "r3"],
  );
  assert.equal(paired[0].blocks[2].result.isError, true);
  assert.equal(paired[1].blocks[0].text, "读完了");
});

test("连续吸收在遇到别的内容时停下", () => {
  const paired = pairToolCalls([
    {
      role: "assistant",
      blocks: [
        { kind: "tool_use", name: "a", id: "c1", input: {} },
        { kind: "tool_use", name: "b", id: "c2", input: {} },
      ],
    },
    { role: "tool", blocks: [{ kind: "tool_result", id: "c1", isError: false, text: "r1" }] },
    {
      role: "user",
      blocks: [
        { kind: "tool_result", id: "c2", isError: false, text: "r2" },
        { kind: "text", text: "另外" },
      ],
    },
    { role: "user", blocks: [{ kind: "text", text: "下一句" }] },
  ]);

  assert.equal(paired.length, 3);
  assert.deepEqual(
    paired[0].blocks.map((b) => b.result?.text),
    ["r1", "r2"],
  );
  assert.deepEqual(paired[1], { role: "user", blocks: [{ kind: "text", text: "另外" }] });
  assert.equal(paired[2].blocks[0].text, "下一句");
});

test("结果不在紧接着的下一条里就不配对，调用块标成未记录结果", () => {
  const paired = pairToolCalls([
    { role: "assistant", blocks: [{ kind: "tool_use", name: "read", id: "a", input: {} }] },
    { role: "assistant", blocks: [{ kind: "text", text: "中间插了一条" }] },
    { role: "user", blocks: [{ kind: "tool_result", id: "a", isError: false, text: "late" }] },
  ]);

  assert.equal(paired.length, 3, "隔了一条的结果不动");
  assert.equal(paired[0].blocks[0].kind, "tool_call");
  assert.equal(paired[0].blocks[0].result, null);
  assert.equal(paired[2].blocks[0].kind, "tool_result", "落单的结果保持原样");
});

test("没有 id 的调用不配对", () => {
  const paired = pairToolCalls([
    { role: "assistant", blocks: [{ kind: "tool_use", name: "old", id: null, input: {} }] },
    { role: "user", blocks: [{ kind: "tool_result", id: null, isError: false, text: "r" }] },
  ]);
  assert.deepEqual(
    paired.map((m) => m.blocks[0].kind),
    ["tool_use", "tool_result"],
  );
});
