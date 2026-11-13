import { formatSeconds, toneByThreshold } from "../../logFormat";
import { reasoningChain } from "../../reasoningChain";
import type { ReasoningSource } from "../../reasoningChain";
import type { RequestLog } from "../../types";

export function ReasoningCell({ log }: { log: ReasoningSource }) {
  const chain = reasoningChain(log);
  if (chain.length === 0) return <span className="muted">-</span>;

  const title = chain.map((step) => `${step.label}：${step.value}`).join("；");
  return <RouteChain chain={chain.map((step) => step.value)} title={title} />;
}

function RouteChain({ chain, title }: { chain: string[]; title: string }) {
  if (chain.length === 1) {
    return <span className="model-text model-single" title={chain[0]}>{chain[0]}</span>;
  }

  const [first, ...rest] = chain;
  return (
    <span className="model-route" title={title}>
      <span className="model-route-line">
        <span className="model-text model-request">{first}</span>
      </span>
      {rest.map((value, index) => (
        <span key={index} className="model-route-line model-route-target">
          <span className="model-route-icon" aria-hidden="true">↳</span>
          <span className="model-text model-upstream">{value}</span>
        </span>
      ))}
    </span>
  );
}

const SENSITIVE_MASK = "******";

function Masked() {
  return <span className="log-sensitive-value">{SENSITIVE_MASK}</span>;
}

export function ChannelStack({ log, sensitiveHidden, keyName }: {
  log: { upstream_id: number | null; upstream_name: string | null };
  sensitiveHidden: boolean;
  keyName?: string;
}) {
  const name = (log.upstream_name ?? "").trim();
  const hidden = sensitiveHidden && Boolean(name);

  if (log.upstream_id === null || log.upstream_id === undefined) {
    if (!name) return <span className="muted">无（未匹配到渠道）</span>;
    return (
      <div className="channel-stack">
        <strong title={hidden ? undefined : name}>{hidden ? <Masked /> : name}</strong>
        <span className="muted">无 ID</span>
      </div>
    );
  }

  const shown = hidden ? SENSITIVE_MASK : name;
  return (
    <div className="channel-stack">
      <strong title={name ? `#${log.upstream_id} · ${shown}` : `#${log.upstream_id}`}>
        {`#${log.upstream_id}`}
      </strong>
      <ChannelStackName name={name} hidden={hidden} keyName={keyName} />
    </div>
  );
}

function ChannelStackName({ name, hidden, keyName }: {
  name: string;
  hidden: boolean;
  keyName?: string;
}) {
  const key = keyName ? <>{" · "}{hidden ? <Masked /> : keyName}</> : null;

  if (!name) return <span className="muted">无名称{key}</span>;
  if (hidden) return <span className="muted"><Masked />{key}</span>;
  return (
    <span className="muted" title={keyName ? `${name} · ${keyName}` : name}>
      {name}{key}
    </span>
  );
}

export function TokenCell({ log, sensitiveHidden }: {
  log: { downstream_token_id: number | null; downstream_token_name: string | null };
  sensitiveHidden: boolean;
}) {
  const name = (log.downstream_token_name ?? "").trim();
  if (!name) return <span className="muted">-</span>;
  if (sensitiveHidden) return <Masked />;
  return <span title={`#${log.downstream_token_id ?? "-"}`}>{name}</span>;
}

export function IpCell({ ip, sensitiveHidden }: {
  ip: string | null | undefined;
  sensitiveHidden: boolean;
}) {
  const value = (ip ?? "").trim();
  if (!value) return <span className="muted">-</span>;
  if (sensitiveHidden) return <Masked />;
  return <span className="log-ip" title={value}>{value}</span>;
}

export function ModelCell({ log }: {
  log: { request_model: string | null; upstream_model: string | null; model: string | null };
}) {
  const requestModel = (log.request_model ?? "").trim();
  const upstreamModel = (log.upstream_model ?? "").trim();
  const fallback = (log.model ?? "").trim();
  const request = requestModel || fallback;
  const upstream = upstreamModel || (requestModel ? fallback : "");

  if (!request && !upstream) return <span className="muted">-</span>;
  if (!request || !upstream || request === upstream) {
    return <RouteChain chain={[request || upstream]} title={request || upstream} />;
  }
  return <RouteChain chain={[request, upstream]} title={`请求模型：${request}；上游模型：${upstream}`} />;
}

export function compactText(value: string, maxLength: number): string {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

function durationRating(log: RequestLog): { tone: string; basis: string } {
  const status = log.status_code;
  if (status === null || !Number.isFinite(status)) {
    return { tone: "danger", basis: "请求无响应或状态码缺失" };
  }
  if (status === 499) return { tone: "neutral", basis: "客户端断开，不算失败" };
  if (status < 200 || status >= 300) {
    return { tone: "danger", basis: `HTTP ${status} 错误，优先标红` };
  }

  const duration = log.duration_ms;
  if (duration === null || !Number.isFinite(duration) || duration <= 0) {
    return { tone: "neutral", basis: "总耗时无数据" };
  }

  const completion = log.completion_tokens;
  if (completion !== null && Number.isFinite(completion) && completion > 0) {
    const rate = completion / (duration / 1000);
    return {
      tone: toneByThreshold(rate, 20, 8),
      basis: `按全程输出吞吐 ${rate.toFixed(1).replace(/\.0$/, "")} t/s 判定`,
    };
  }

  const total = log.total_tokens;
  if (total !== null && Number.isFinite(total) && total > 0) {
    const rate = total / (duration / 1000);
    return {
      tone: toneByThreshold(rate, 80, 20),
      basis: `按总吞吐 ${rate.toFixed(1).replace(/\.0$/, "")} t/s 判定`,
    };
  }

  return {
    tone: toneByThreshold(-duration, -30000, -60000),
    basis: "无 token 数据，按绝对耗时兜底判定",
  };
}

export function DurationTime({ log }: { log: RequestLog }) {
  const label = formatSeconds(log.duration_ms);
  const rating = durationRating(log);
  return (
    <span className={`duration-time ${rating.tone}`} title={`总耗时 ${label} · ${rating.basis}`}>
      {label}
    </span>
  );
}

export function StatusBadge({ code }: { code: number | null }) {
  if (code === null) return <span className="muted">无响应</span>;
  if (code >= 200 && code < 300) return <span className="badge on status-2xx">{code}</span>;
  if (code >= 300 && code < 400) return <span className="badge neutral status-3xx">{code}</span>;
  if (code === 499) return <span className="badge neutral status-4xx">{code}</span>;
  if (code >= 400 && code < 500) return <span className="badge danger status-4xx">{code}</span>;
  if (code >= 500) return <span className="badge danger status-5xx">{code}</span>;
  return <span className="badge neutral status-other">{code}</span>;
}
