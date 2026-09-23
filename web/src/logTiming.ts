import type { RequestLog } from "./types";

export const FAILURE_STAGE_LABELS: Record<string, string> = {
  first_event: "首事件前失败", stream: "传输中断", client_cancelled: "客户端取消", connect: "连接建立失败", upstream_status: "上游状态异常", request_build: "请求构建失败", response_body: "响应体读取失败", no_route: "未找到路由", rate_limited: "渠道限流", gateway: "网关错误",
};
export function formatFailureStage(stage: string | null): string {
  return stage ? FAILURE_STAGE_LABELS[stage] ?? stage : "未记录";
}
export interface TimingSegment { label: string; ms: number | null; tone: string }
const sampled = (value: number | null | undefined): number | null => typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
/** Each timestamp is measured from the upstream attempt, except gateway prep. Never invent unsampled stages. */
export function timingSegments(log: RequestLog): TimingSegment[] {
  const total = sampled(log.duration_ms), headers = sampled(log.upstream_headers_ms), first = sampled(log.first_token_ms);
  const prep = sampled(log.pre_upstream_ms);
  const delta = (end: number | null, start: number | null) => end !== null && start !== null && end >= start ? end - start : null;
  return [
    { label: log.attempt_index ? "累计前置" : "网关准备", ms: prep, tone: "prep" },
    { label: "响应头", ms: headers !== null && total !== null && headers <= total ? headers : null, tone: "headers" },
    ...(log.stream ? [{ label: "等待首字", ms: delta(first, headers), tone: "first" }] : []),
    { label: log.stream ? "流式传输" : "响应体", ms: delta(total, log.stream ? first : headers), tone: "body" },
  ];
}
export function retryChain(log: RequestLog, candidates: RequestLog[]): RequestLog[] {
  if (!log.request_uid) return [];
  const entries = new Map<number, RequestLog>();
  for (const entry of [...candidates, log]) if (entry.request_uid === log.request_uid) entries.set(entry.id, entry);
  return [...entries.values()].sort((a, b) => (a.attempt_index ?? 0) - (b.attempt_index ?? 0) || a.id - b.id);
}
