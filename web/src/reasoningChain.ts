/**
 * 思考强度链：请求 → 上游 → 响应。
 *
 * 单独成模块是为了能被直接测到：.tsx 里有 JSX，测试运行器只能擦类型、
 * 不能编译 JSX。
 */

export interface ReasoningSource {
  reasoning_effort: string | null;
  upstream_reasoning_effort: string | null;
  /** 在途请求还没有这一段。 */
  response_reasoning_effort?: string | null;
}

export interface ReasoningStep {
  label: string;
  value: string;
}

/**
 * 相邻两步相同就合并——没改写过的链路不该显示成三段一模一样的值。
 *
 * 合并只看相邻：请求 high、上游 low、响应 high 这种来回改写要三段都留着，
 * 去重成两段会把中间那次改写藏掉。
 */
export function reasoningChain(log: ReasoningSource): ReasoningStep[] {
  const steps = [
    { label: "请求强度", value: (log.reasoning_effort ?? "").trim() },
    { label: "上游强度", value: (log.upstream_reasoning_effort ?? "").trim() },
    { label: "响应强度", value: (log.response_reasoning_effort ?? "").trim() },
  ].filter((step) => step.value);

  const chain: ReasoningStep[] = [];
  for (const step of steps) {
    if (chain.length > 0 && chain[chain.length - 1].value === step.value) continue;
    chain.push(step);
  }
  return chain;
}
