import { SegmentBar } from "./SegmentBar";
import { formatDuration } from "../logFormat";
import { formatFailureStage, retryChain, timingSegments } from "../logTiming";
import type { RequestLog } from "../types";

export function LogTiming({ log, compact = false }: { log: RequestLog; compact?: boolean }) {
  const stages = timingSegments(log);
  const total = stages.reduce((sum, stage) => sum + (stage.ms ?? 0), 0);
  const title = stages.map((stage) => `${stage.label}：${stage.ms === null ? "未采样" : formatDuration(stage.ms)}`).join("；");
  return <div className={`log-stage-timing${compact ? " is-compact" : ""}`}>
    {!compact && <div className="log-timing-chips">{stages.map((stage) => <span key={stage.tone}>{stage.label} <strong>{stage.ms === null ? "未采样" : formatDuration(stage.ms)}</strong></span>)}</div>}
    <SegmentBar label={title} className="log-timing-bar" segments={stages.map((stage) => ({ label: stage.label, width: (stage.ms ?? 0) / Math.max(total, 1) * 100, className: `log-timing-segment timing-${stage.tone}`, lines: [stage.ms === null ? "未采样" : formatDuration(stage.ms)] }))} />
    {log.failure_stage && <small className="log-failure-stage">{formatFailureStage(log.failure_stage)}{log.failure_retryable == null ? "" : log.failure_retryable ? " · 可重试" : " · 不可重试"}</small>}
  </div>;
}

export function RetryChain({ log, logs, onSelect }: { log: RequestLog; logs: RequestLog[]; onSelect?: (log: RequestLog) => void }) {
  const chain = retryChain(log, logs);
  if (chain.length < 2 && !log.attempt_index) return null;
  return <section className="log-detail-retry-chain" aria-label="请求重试链路">
    <p>请求重试链路 · 当前已加载 {chain.length} 次尝试 <code>{log.request_uid}</code></p>
    <div className="retry-chain-items">{chain.map((attempt) => <button key={attempt.id} type="button" className={`secondary retry-chain-step${attempt.id === log.id ? " is-current" : ""}`} aria-pressed={attempt.id === log.id} disabled={!onSelect} onClick={() => onSelect?.(attempt)}>#{attempt.attempt_index ?? 0} · {attempt.upstream_name ?? "未路由"} · {attempt.status_code ?? "无响应"}</button>)}</div>
  </section>;
}
