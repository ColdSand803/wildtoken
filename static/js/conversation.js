// 把日志快照里的请求/响应正文解析成会话视图。
//
// 这里的正文几乎总是被截断的：日志正文上限是 1MB，而 Claude Code 一轮请求
// 常常超过它，截断保留开头、丢弃结尾。所以标准 JSON.parse 对绝大多数日志都
// 会失败，下面这套扫描器的存在意义就是从残缺 JSON 里尽量多地抢救出消息。

/* ── 容错 JSON 扫描 ───────────────────────────────────────── */

// 从 start 处读出一个完整的 JSON 值，返回 [值文本, 结束下标]；
// 读到文本末尾仍未闭合（即被截断）时返回 null。
function readJsonValue(text, start) {
  const first = text[start];

  if (first === '"') {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') return [text.slice(start, i + 1), i + 1];
      i += 1;
    }
    return null;
  }

  if (first === "{" || first === "[") {
    let depth = 0;
    let inString = false;
    let i = start;
    while (i < text.length) {
      const char = text[i];
      if (inString) {
        if (char === "\\") {
          i += 2;
          continue;
        }
        if (char === '"') inString = false;
        i += 1;
        continue;
      }
      if (char === '"') {
        inString = true;
      } else if (char === "{" || char === "[") {
        depth += 1;
      } else if (char === "}" || char === "]") {
        depth -= 1;
        if (depth === 0) return [text.slice(start, i + 1), i + 1];
      }
      i += 1;
    }
    return null;
  }

  const literal = /^(-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null)/.exec(text.slice(start));
  return literal ? [literal[1], start + literal[1].length] : null;
}

// 遍历根对象最外层的键值对。截断时返回已经读到的部分，最后一个键的值会带
// complete:false —— 调用方可以再对它做元素级抢救。
function scanTopLevelEntries(text) {
  const entries = new Map();
  let i = text.indexOf("{");
  if (i < 0) return entries;
  i += 1;

  while (i < text.length) {
    while (i < text.length && /[\s,]/.test(text[i])) i += 1;
    if (text[i] === "}" || i >= text.length) break;
    if (text[i] !== '"') break;

    const keyRead = readJsonValue(text, i);
    if (!keyRead) break;
    let key;
    try {
      key = JSON.parse(keyRead[0]);
    } catch {
      break;
    }
    i = keyRead[1];

    while (i < text.length && /\s/.test(text[i])) i += 1;
    if (text[i] !== ":") break;
    i += 1;
    while (i < text.length && /\s/.test(text[i])) i += 1;

    const valueRead = readJsonValue(text, i);
    if (!valueRead) {
      entries.set(key, { text: text.slice(i), complete: false });
      break;
    }
    entries.set(key, { text: valueRead[0], complete: true });
    i = valueRead[1];
  }

  return entries;
}

// 从一个可能不完整的 JSON 数组文本里，逐个取出能完整解析的元素。
function salvageArrayItems(arrayText) {
  const items = [];
  let i = arrayText.indexOf("[");
  if (i < 0) return { items, complete: false };
  i += 1;

  while (i < arrayText.length) {
    while (i < arrayText.length && /[\s,]/.test(arrayText[i])) i += 1;
    if (arrayText[i] === "]") return { items, complete: true };
    const read = readJsonValue(arrayText, i);
    if (!read) return { items, complete: false };
    try {
      items.push(JSON.parse(read[0]));
    } catch {
      return { items, complete: false };
    }
    i = read[1];
  }
  return { items, complete: false };
}

// 把正文解析成一个浅层对象：完整正文走标准解析，截断正文逐键抢救。
// arrayKeys 里的键在自身被截断时还会做元素级抢救。
function parseLenientRoot(text, arrayKeys) {
  const raw = String(text || "").trim();
  if (!raw) return null;

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    return { value: parsed, complete: true, salvagedKeys: new Set() };
  } catch {
    // 截断，往下走抢救。
  }

  const entries = scanTopLevelEntries(raw);
  if (entries.size === 0) return null;

  const value = {};
  const salvagedKeys = new Set();
  let complete = true;
  for (const [key, entry] of entries) {
    if (entry.complete) {
      try {
        value[key] = JSON.parse(entry.text);
      } catch {
        complete = false;
      }
      continue;
    }
    complete = false;
    if (!arrayKeys.includes(key)) continue;
    const salvaged = salvageArrayItems(entry.text);
    if (salvaged.items.length > 0) {
      value[key] = salvaged.items;
      salvagedKeys.add(key);
    }
  }
  return { value, complete, salvagedKeys };
}

/* ── 请求解析 ─────────────────────────────────────────────── */

// 把一条消息的 content 归一成统一的块数组，渲染层只认这一种形状。
function normalizeContentBlocks(content) {
  if (typeof content === "string") {
    return content ? [{ kind: "text", text: content }] : [];
  }
  if (!Array.isArray(content)) return [];

  const blocks = [];
  for (const block of content) {
    if (typeof block === "string") {
      blocks.push({ kind: "text", text: block });
      continue;
    }
    if (!block || typeof block !== "object") continue;

    switch (block.type) {
      case "text":
      case "input_text":
      case "output_text":
        blocks.push({ kind: "text", text: String(block.text ?? "") });
        break;
      case "thinking":
      case "redacted_thinking":
        blocks.push({ kind: "thinking", text: String(block.thinking ?? block.data ?? "") });
        break;
      case "tool_use":
      case "function_call":
        blocks.push({
          kind: "tool_use",
          name: String(block.name ?? "工具"),
          id: block.id ?? block.call_id ?? null,
          input: block.input ?? block.arguments ?? null,
        });
        break;
      case "tool_result":
      case "function_call_output":
        blocks.push({
          kind: "tool_result",
          id: block.tool_use_id ?? block.call_id ?? null,
          isError: Boolean(block.is_error),
          text: stringifyToolResult(block.content ?? block.output),
        });
        break;
      case "image":
      case "input_image":
        blocks.push({ kind: "image", text: describeImageBlock(block) });
        break;
      default:
        blocks.push({ kind: "other", label: String(block.type ?? "未知块"), input: block });
    }
  }
  return blocks;
}

function stringifyToolResult(content) {
  if (content === null || content === undefined) return "";
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof part.text === "string") return part.text;
        return safeStringify(part);
      })
      .join("\n");
  }
  return safeStringify(content);
}

function describeImageBlock(block) {
  const source = block.source || {};
  const mediaType = source.media_type || source.type || "image";
  if (typeof source.data === "string") {
    return `[图片 ${mediaType}，${formatApproxBytes(source.data.length)}]`;
  }
  if (typeof source.url === "string") return `[图片 ${source.url}]`;
  return `[图片 ${mediaType}]`;
}

function safeStringify(value) {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatApproxBytes(length) {
  const bytes = Math.floor((length * 3) / 4);
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

// system 可以是字符串，也可以是 [{type:"text"}]（Anthropic 的写法）。
function normalizeSystemPrompt(system, instructions) {
  const source = system ?? instructions;
  if (!source) return null;
  const blocks = normalizeContentBlocks(source);
  return blocks.length > 0 ? { role: "system", blocks } : null;
}

// 把请求正文解析成会话。返回 null 表示这不是一个能识别的会话请求。
function parseConversationRequest(bodyText) {
  const root = parseLenientRoot(bodyText, ["messages", "input"]);
  if (!root) return null;

  const body = root.value;
  const rawMessages = Array.isArray(body.messages)
    ? body.messages
    : (Array.isArray(body.input) ? body.input : null);
  if (!rawMessages) return null;

  const messages = [];
  const system = normalizeSystemPrompt(body.system, body.instructions);
  if (system) messages.push(system);

  for (const entry of rawMessages) {
    if (!entry || typeof entry !== "object") continue;
    const blocks = normalizeContentBlocks(entry.content);
    // chat/completions 把工具调用放在消息对象上而不是 content 里。
    if (Array.isArray(entry.tool_calls)) {
      for (const call of entry.tool_calls) {
        blocks.push({
          kind: "tool_use",
          name: String(call?.function?.name ?? call?.name ?? "工具"),
          id: call?.id ?? null,
          input: call?.function?.arguments ?? call?.arguments ?? null,
        });
      }
    }
    if (entry.role === "tool" && typeof entry.content === "string") {
      // OpenAI 的工具返回是一条 role:tool 的普通消息。
      messages.push({
        role: "tool",
        blocks: [{ kind: "tool_result", id: entry.tool_call_id ?? null, text: entry.content }],
      });
      continue;
    }
    if (blocks.length === 0) continue;
    messages.push({ role: String(entry.role || "user"), blocks });
  }

  const messagesKey = Array.isArray(body.messages) ? "messages" : "input";
  return {
    kind: "request",
    model: typeof body.model === "string" ? body.model : null,
    messages,
    toolCount: Array.isArray(body.tools) ? body.tools.length : 0,
    // 会话本身是否完整，取决于消息数组有没有被截断——正文尾部的 tools 之类
    // 被截掉不影响已经读全的对话。
    complete: root.complete || !root.salvagedKeys.has(messagesKey),
  };
}

/* ── 响应解析 ─────────────────────────────────────────────── */

// 取出 SSE 里每个 data: 行的负载。事件名不需要——每条负载自己带 type 字段，
// 而且截断的最后一行直接丢掉。
function readSsePayloads(text) {
  const payloads = [];
  for (const line of String(text).split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("data:")) continue;
    const raw = trimmed.slice(5).trim();
    if (!raw || raw === "[DONE]") continue;
    try {
      payloads.push(JSON.parse(raw));
    } catch {
      // 截断的最后一行，或非 JSON 的心跳，跳过。
    }
  }
  return payloads;
}

// Anthropic 流式：按 index 累积 content_block，delta 往上拼。
function reassembleAnthropicStream(payloads) {
  const blocks = new Map();
  let stopReason = null;
  let sawStream = false;

  const ensure = (index, seed) => {
    if (!blocks.has(index)) blocks.set(index, seed);
    return blocks.get(index);
  };

  for (const event of payloads) {
    const type = event?.type;
    if (type === "content_block_start") {
      sawStream = true;
      const start = event.content_block || {};
      ensure(event.index, {
        type: start.type || "text",
        text: typeof start.text === "string" ? start.text : "",
        thinking: typeof start.thinking === "string" ? start.thinking : "",
        name: start.name || null,
        id: start.id || null,
        partialJson: "",
      });
    } else if (type === "content_block_delta") {
      sawStream = true;
      const block = ensure(event.index, {
        type: "text", text: "", thinking: "", name: null, id: null, partialJson: "",
      });
      const delta = event.delta || {};
      if (typeof delta.text === "string") block.text += delta.text;
      if (typeof delta.thinking === "string") block.thinking += delta.thinking;
      if (typeof delta.partial_json === "string") block.partialJson += delta.partial_json;
    } else if (type === "message_delta") {
      if (event.delta && event.delta.stop_reason) stopReason = event.delta.stop_reason;
    } else if (type === "error" && event.error) {
      sawStream = true;
      ensure(-1, {
        type: "error", text: String(event.error.message || event.error.type || "上游返回错误"),
        thinking: "", name: null, id: null, partialJson: "",
      });
    }
  }
  if (!sawStream) return null;

  const ordered = [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block);
  return { blocks: ordered.map(toRenderBlock), stopReason };
}

function toRenderBlock(block) {
  if (block.type === "thinking" || block.type === "redacted_thinking") {
    return { kind: "thinking", text: block.thinking || block.text };
  }
  if (block.type === "tool_use") {
    return { kind: "tool_use", name: block.name || "工具", id: block.id, input: block.partialJson };
  }
  if (block.type === "error") {
    return { kind: "error", text: block.text };
  }
  return { kind: "text", text: block.text };
}

// OpenAI 流式：把 choices[].delta 累积起来。
function reassembleOpenAIStream(payloads) {
  let text = "";
  const toolCalls = new Map();
  let finishReason = null;
  let sawStream = false;

  for (const event of payloads) {
    const choice = Array.isArray(event?.choices) ? event.choices[0] : null;
    if (!choice) continue;
    sawStream = true;
    if (choice.finish_reason) finishReason = choice.finish_reason;
    const delta = choice.delta || {};
    if (typeof delta.content === "string") text += delta.content;
    if (typeof delta.reasoning_content === "string") text += delta.reasoning_content;
    for (const call of Array.isArray(delta.tool_calls) ? delta.tool_calls : []) {
      const key = call.index ?? call.id ?? toolCalls.size;
      const existing = toolCalls.get(key) || { name: "", id: call.id || null, args: "" };
      if (call.function?.name) existing.name = call.function.name;
      if (call.id) existing.id = call.id;
      if (typeof call.function?.arguments === "string") existing.args += call.function.arguments;
      toolCalls.set(key, existing);
    }
  }
  if (!sawStream) return null;

  const blocks = [];
  if (text) blocks.push({ kind: "text", text });
  for (const call of toolCalls.values()) {
    blocks.push({ kind: "tool_use", name: call.name || "工具", id: call.id, input: call.args });
  }
  return { blocks, stopReason: finishReason };
}

// Responses API 流式：增量事件带 delta 字符串。
function reassembleResponsesStream(payloads) {
  let text = "";
  let sawStream = false;
  for (const event of payloads) {
    if (typeof event?.type !== "string" || !event.type.startsWith("response.")) continue;
    if (typeof event.delta === "string") {
      sawStream = true;
      text += event.delta;
    }
  }
  return sawStream ? { blocks: text ? [{ kind: "text", text }] : [], stopReason: null } : null;
}

// 非流式响应：Anthropic 的 content[]，OpenAI 的 choices[].message。
function parseNonStreamResponse(body) {
  if (Array.isArray(body.content)) {
    return { blocks: normalizeContentBlocks(body.content), stopReason: body.stop_reason ?? null };
  }
  const choice = Array.isArray(body.choices) ? body.choices[0] : null;
  if (choice && choice.message) {
    const blocks = normalizeContentBlocks(choice.message.content);
    for (const call of Array.isArray(choice.message.tool_calls) ? choice.message.tool_calls : []) {
      blocks.push({
        kind: "tool_use",
        name: String(call?.function?.name ?? "工具"),
        id: call?.id ?? null,
        input: call?.function?.arguments ?? null,
      });
    }
    return { blocks, stopReason: choice.finish_reason ?? null };
  }
  if (Array.isArray(body.output)) {
    const blocks = [];
    for (const item of body.output) {
      blocks.push(...normalizeContentBlocks(item?.content));
    }
    return { blocks, stopReason: body.status ?? null };
  }
  if (body.error) {
    const message = body.error.message || body.error.type || "上游返回错误";
    return { blocks: [{ kind: "error", text: String(message) }], stopReason: null };
  }
  return null;
}

// 把响应正文解析成会话。返回 null 表示识别不了。
function parseConversationResponse(bodyText) {
  const raw = String(bodyText || "").trim();
  if (!raw) return null;

  if (/^data:/m.test(raw)) {
    const payloads = readSsePayloads(raw);
    if (payloads.length === 0) return null;
    const assembled = reassembleAnthropicStream(payloads)
      || reassembleOpenAIStream(payloads)
      || reassembleResponsesStream(payloads);
    if (!assembled) return null;
    return {
      kind: "response",
      stream: true,
      messages: assembled.blocks.length > 0
        ? [{ role: "assistant", blocks: assembled.blocks }]
        : [],
      stopReason: assembled.stopReason,
      // 流式正文按行解析，截断只会丢掉最后一行，前面重组出的内容依然可信。
      complete: true,
    };
  }

  const root = parseLenientRoot(raw, ["content", "choices", "output"]);
  if (!root) return null;
  const assembled = parseNonStreamResponse(root.value);
  if (!assembled) return null;
  return {
    kind: "response",
    stream: false,
    messages: assembled.blocks.length > 0
      ? [{ role: "assistant", blocks: assembled.blocks }]
      : [],
    stopReason: assembled.stopReason,
    complete: root.complete,
  };
}

/* ── 渲染 ─────────────────────────────────────────────────── */

const CONVERSATION_ROLE_LABELS = {
  system: "系统",
  user: "用户",
  assistant: "助手",
  tool: "工具",
  developer: "开发者",
};

function conversationRoleLabel(role) {
  return CONVERSATION_ROLE_LABELS[role] || role;
}

function formatCharCount(count) {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k 字`;
  return `${count} 字`;
}

// 折叠块：摘要一行，展开才看到全文。
// 默认展开：读一段对话不该先点开十几个块。summary 留着当标签用（"思考"、
// "调用 Bash"），展开状态下它仍然是有用的分隔，也让需要时能手动收起来。
function renderCollapsibleBlock(className, summary, body) {
  return `
    <details class="conv-block ${className}" open>
      <summary>${summary}</summary>
      <pre class="conv-block-body">${escapeHtml(body)}</pre>
    </details>
  `;
}

// 正文一律平铺，不做折叠。之前给长文加的预览摘要在默认展开后就成了重复内容
// ——摘要和全文会一起显示。
/* 会话视图是拿来读的，而正文里成片的空行会把一条消息撑开好几屏——实测工具
   结果有接近一半的行是空行，最长一次连着 80 行。这里压掉行尾空白、把连续空行
   收成一个、并去掉首尾空白；行内缩进原样保留，代码和 diff 的缩进是有意义的。
   需要逐字节还原的场合切原始模式。 */
function tidyBlockText(text) {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function renderTextBlock(text) {
  const value = tidyBlockText(text);
  if (!value) return "";
  return `<div class="conv-block conv-block--text"><pre class="conv-block-body">${escapeHtml(value)}</pre></div>`;
}

function renderToolInput(input) {
  if (input === null || input === undefined) return "";
  let value = input;
  if (typeof input === "string") {
    // 流式重组出来的是拼接的 partial_json，能解析就美化一下。
    try {
      value = JSON.parse(input);
    } catch {
      return input;
    }
  }
  // 短入参排成一行：把 {"path":"a.go"} 缩进成三行纯属浪费高度，而这种
  // 一两个字段的调用占了工具调用的多数。
  try {
    const compact = JSON.stringify(value);
    if (compact !== undefined && compact.length <= 120) return compact;
  } catch {
    // 转不了就走下面的缩进版本。
  }
  return safeStringify(value);
}

// 单行内容不值得一个可折叠块：摘要一行、正文一行，两行装一行的东西。
// 这里把标签和内容排在同一行，仍然保留标签的类型提示。
function renderInlineBlock(className, tag, body) {
  return `
    <div class="conv-block conv-block--inline ${className}">
      <span class="conv-block-tag">${tag}</span>
      <span class="conv-inline-body">${escapeHtml(body)}</span>
    </div>
  `;
}

// 内容只有一行时走内联，多行才用折叠块。
function renderLabelledBlock(className, tag, meta, body) {
  if (body && !body.includes("\n")) {
    return renderInlineBlock(className, tag, body);
  }
  const summary = meta ? `${tag} <span class="conv-block-meta">${meta}</span>` : tag;
  return renderCollapsibleBlock(className, summary, body);
}

function renderConversationBlock(block) {
  switch (block.kind) {
    case "text":
      return renderTextBlock(block.text);
    case "thinking": {
      const text = tidyBlockText(block.text);
      if (!text) return "";
      return renderLabelledBlock(
        "conv-block--thinking", '<span class="conv-block-tag">思考</span>',
        formatCharCount(text.length), text,
      );
    }
    case "tool_use": {
      const body = renderToolInput(block.input);
      const tag = `<span class="conv-block-tag">调用</span> ${escapeHtml(block.name || "工具")}`;
      return renderLabelledBlock("conv-block--tool-use", tag, "", body);
    }
    case "tool_result": {
      const text = tidyBlockText(block.text);
      const label = block.isError ? "工具报错" : "工具结果";
      return renderLabelledBlock(
        `conv-block--tool-result${block.isError ? " is-error" : ""}`,
        `<span class="conv-block-tag">${label}</span>`,
        formatCharCount(text.length), text,
      );
    }
    case "image":
      return `<div class="conv-block conv-block--image">${escapeHtml(block.text || "[图片]")}</div>`;
    case "error":
      return `<div class="conv-block conv-block--error">${escapeHtml(block.text || "错误")}</div>`;
    default: {
      const summary = `<span class="conv-block-tag">${escapeHtml(block.label || "其他")}</span>`;
      return renderCollapsibleBlock("conv-block--other", summary, safeStringify(block.input));
    }
  }
}

function renderConversationMessage(message, index) {
  const blocks = message.blocks.map(renderConversationBlock).join("");
  if (!blocks) return "";
  const role = String(message.role || "user");
  /* 角色放在左侧窄栏而不是单独一行：26% 的消息内容只有一两行，一个专门的
     标题行等于把它们的高度翻倍。 */
  return `
    <li class="conv-msg conv-msg--${escapeHtml(role)}">
      <div class="conv-msg-role">
        <span class="conv-role-name">${escapeHtml(conversationRoleLabel(role))}</span>
        <span class="conv-msg-index">${index + 1}</span>
      </div>
      <div class="conv-msg-blocks">${blocks}</div>
    </li>
  `;
}

function formatByteSize(bytes) {
  if (typeof bytes !== "number" || !Number.isFinite(bytes)) return null;
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

// meta 来自 normalizeSnapshotBody：{ truncated, byteLength, capturedLength }
function renderConversationHtml(parsed, meta = {}) {
  if (!parsed) {
    return `
      <div class="conv-empty">
        <strong>这段正文无法解析成会话</strong>
        <span>可能不是对话请求，或上游返回的不是 JSON（例如网关的 HTML 错误页）。切换到原始模式查看完整内容。</span>
      </div>
    `;
  }

  const rendered = parsed.messages.map(renderConversationMessage).filter(Boolean).join("");
  if (!rendered) {
    return `
      <div class="conv-empty">
        <strong>没有可显示的消息</strong>
        <span>正文解析成功，但其中不含消息内容。切换到原始模式查看完整内容。</span>
      </div>
    `;
  }

  const summary = [];
  if (parsed.model) summary.push(escapeHtml(parsed.model));
  summary.push(`${parsed.messages.length} 条消息`);
  if (parsed.toolCount > 0) summary.push(`${parsed.toolCount} 个工具`);
  if (parsed.stopReason) summary.push(`结束原因 ${escapeHtml(parsed.stopReason)}`);
  if (parsed.stream) summary.push("流式重组");

  // 正文被截断时说清楚恢复了多少、丢了多少，避免把残缺的会话误当成全部。
  let notice = "";
  if (!parsed.complete || meta.truncated) {
    const parts = [`已恢复 ${parsed.messages.length} 条消息`];
    const original = formatByteSize(meta.byteLength);
    const captured = formatByteSize(meta.capturedLength);
    if (original && captured && original !== captured) {
      parts.push(`原始正文 ${original}，日志仅记录前 ${captured}`);
    } else if (original) {
      parts.push(`原始正文 ${original}`);
    }
    notice = `
      <div class="conv-truncated">
        <strong>正文被截断，末尾的消息已丢失</strong>
        <span>${escapeHtml(parts.join(" · "))}</span>
      </div>
    `;
  }

  /* 默认全部展开，但几百条消息的会话铺开会很长，所以给一个一键收起的出口。
     按钮的实际开合由 logs.js 的委托处理，这里只出标记。 */
  const controls = `
    <button type="button" class="conv-fold-all" data-conv-fold="collapse">全部折叠</button>
  `;

  return `
    <div class="conv-summary">
      <span>${summary.join(" · ")}</span>
      ${controls}
    </div>
    <ol class="conv-list">${rendered}</ol>
    ${notice}
  `;
}
