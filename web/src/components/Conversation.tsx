import type { ReactNode } from "react";

import type { Block, Conversation as Parsed, Message } from "../conversation";
import { formatByteSize } from "../conversation";

const ROLE_LABELS: Record<string, string> = {
  system: "系统",
  user: "用户",
  assistant: "助手",
  tool: "工具",
  developer: "开发者",
};

function formatCharCount(count: number): string {
  if (count >= 10000) return `${(count / 10000).toFixed(1)} 万字`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}k 字`;
  return `${count} 字`;
}

/**
 * 压掉噪音空白。
 *
 * 会话视图是拿来读的，而正文里成片的空行会把一条消息撑开好几屏——实测工具
 * 结果有接近一半的行是空行。这里压掉行尾空白、连续空行收成一个、去掉首尾。
 * 行内缩进原样保留：代码和 diff 的缩进是有意义的。要逐字节还原就切原始模式。
 */
function tidy(text: string): string {
  return String(text || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+$/gm, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * 工具入参。
 *
 * 流式重组出来的是拼接的 partial_json，能解析就美化。短入参排成一行——把
 * {"path":"a.go"} 缩进成三行纯属浪费高度，而这种一两个字段的调用占多数。
 */
function formatToolInput(input: unknown): string {
  if (input === null || input === undefined) return "";
  let value = input;
  if (typeof input === "string") {
    try {
      value = JSON.parse(input);
    } catch {
      return input;
    }
  }
  try {
    const compact = JSON.stringify(value);
    if (compact !== undefined && compact.length <= 120) return compact;
  } catch {
    // 转不了就走下面的缩进版本。
  }
  return safeStringify(value);
}

/**
 * 折叠块。默认展开：读一段对话不该先点开十几个块。
 *
 * summary 留着当标签用（「思考」、「调用 Bash」），展开状态下它仍然是有用的
 * 分隔，也让需要时能手动收起来。
 */
function CollapsibleBlock({
  className,
  summary,
  body,
}: {
  className: string;
  summary: ReactNode;
  body: string;
}) {
  return (
    <details className={`conv-block ${className}`} open>
      <summary>{summary}</summary>
      <pre className="conv-block-body">{body}</pre>
    </details>
  );
}

/**
 * 有标签的块：单行走内联，多行才折叠。
 *
 * 单行内容不值得一个可折叠块——摘要一行、正文一行，两行装一行的东西。
 */
function LabelledBlock({
  className,
  tag,
  meta,
  body,
}: {
  className: string;
  tag: ReactNode;
  meta?: string;
  body: string;
}) {
  if (body && !body.includes("\n")) {
    return (
      <div className={`conv-block conv-block--inline ${className}`}>
        {tag}
        <span className="conv-inline-body">{body}</span>
      </div>
    );
  }
  const summary = meta ? (
    <>
      {tag} <span className="conv-block-meta">{meta}</span>
    </>
  ) : (
    tag
  );
  return <CollapsibleBlock className={className} summary={summary} body={body} />;
}

function Tag({ children }: { children: ReactNode }) {
  return <span className="conv-block-tag">{children}</span>;
}

function ConversationBlock({ block }: { block: Block }) {
  switch (block.kind) {
    case "text": {
      // 正文一律平铺，不折叠。默认展开后，预览摘要会和全文一起显示。
      const text = tidy(block.text);
      if (!text) return null;
      return (
        <div className="conv-block conv-block--text">
          <pre className="conv-block-body">{text}</pre>
        </div>
      );
    }
    case "thinking": {
      const text = tidy(block.text);
      if (!text) return null;
      return (
        <LabelledBlock
          className="conv-block--thinking"
          tag={<Tag>思考</Tag>}
          meta={formatCharCount(text.length)}
          body={text}
        />
      );
    }
    case "tool_use":
      return (
        <LabelledBlock
          className="conv-block--tool-use"
          tag={
            <>
              <Tag>调用</Tag> {block.name || "工具"}
            </>
          }
          body={formatToolInput(block.input)}
        />
      );
    case "tool_result": {
      const text = tidy(block.text);
      return (
        <LabelledBlock
          className={block.isError ? "conv-block--tool-result is-error" : "conv-block--tool-result"}
          tag={<Tag>{block.isError ? "工具报错" : "工具结果"}</Tag>}
          meta={formatCharCount(text.length)}
          body={text}
        />
      );
    }
    case "image":
      return <div className="conv-block conv-block--image">{block.text || "[图片]"}</div>;
    case "error":
      return <div className="conv-block conv-block--error">{block.text || "错误"}</div>;
    default:
      return (
        <CollapsibleBlock
          className="conv-block--other"
          summary={<Tag>{block.label || "其他"}</Tag>}
          body={safeStringify(block.input)}
        />
      );
  }
}

function ConversationMessage({ message, index }: { message: Message; index: number }) {
  const blocks = message.blocks
    .map((block, position) => <ConversationBlock key={position} block={block} />)
    .filter(Boolean);
  if (blocks.every((node) => node === null)) return null;

  const role = String(message.role || "user");
  return (
    /* 角色放在左侧窄栏而不是单独一行：26% 的消息内容只有一两行，一个专门的
       标题行等于把它们的高度翻倍。 */
    <li className={`conv-msg conv-msg--${role}`}>
      <div className="conv-msg-role">
        <span className="conv-role-name">{ROLE_LABELS[role] ?? role}</span>
        <span className="conv-msg-index">{index + 1}</span>
      </div>
      <div className="conv-msg-blocks">{blocks}</div>
    </li>
  );
}

function Empty({ title, detail }: { title: string; detail: string }) {
  return (
    <div className="conv-empty">
      <strong>{title}</strong>
      <span>{detail}</span>
    </div>
  );
}

/** meta 来自 normalizeSnapshotBody：正文被截断时要说清楚丢了什么。 */
export function Conversation({
  parsed,
  byteLength,
  capturedLength,
  truncated,
}: {
  parsed: Parsed | null;
  byteLength: number | null;
  capturedLength: number | null;
  truncated: boolean;
}) {
  if (!parsed) {
    return (
      <Empty
        title="这段正文无法解析成会话"
        detail="可能不是对话请求，或上游返回的不是 JSON（例如网关的 HTML 错误页）。切换到原始模式查看完整内容。"
      />
    );
  }

  const messages = parsed.messages.filter((message) => message.blocks.length > 0);
  if (messages.length === 0) {
    return (
      <Empty
        title="没有可显示的消息"
        detail="正文解析成功，但其中不含消息内容。切换到原始模式查看完整内容。"
      />
    );
  }

  const summary: string[] = [];
  if (parsed.model) summary.push(parsed.model);
  summary.push(`${parsed.messages.length} 条消息`);
  if (parsed.toolCount > 0) summary.push(`${parsed.toolCount} 个工具`);
  if (parsed.stopReason) summary.push(`结束原因 ${parsed.stopReason}`);
  if (parsed.stream) summary.push("流式重组");

  // 正文被截断时说清楚恢复了多少、丢了多少，避免把残缺的会话误当成全部。
  const incomplete = !parsed.complete || truncated;
  const notice: string[] = [`已恢复 ${parsed.messages.length} 条消息`];
  const original = formatByteSize(byteLength);
  const captured = formatByteSize(capturedLength);
  if (original && captured && original !== captured) {
    notice.push(`原始正文 ${original}，日志仅记录前 ${captured}`);
  } else if (original) {
    notice.push(`原始正文 ${original}`);
  }

  return (
    <>
      <div className="conv-summary">
        <span>{summary.join(" · ")}</span>
      </div>
      <ol className="conv-list">
        {messages.map((message, index) => (
          <ConversationMessage key={index} message={message} index={index} />
        ))}
      </ol>
      {incomplete ? (
        <div className="conv-truncated">
          <strong>正文被截断，末尾的消息已丢失</strong>
          <span>{notice.join(" · ")}</span>
        </div>
      ) : null}
    </>
  );
}
