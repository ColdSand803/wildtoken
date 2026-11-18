import { memo, useEffect, useState } from "react";

import { exactTokens, firstTokenTone, formatCount, formatSeconds, formatTimestamp } from "../../logFormat";
import type { ActiveRequest, RequestLog } from "../../types";
import { elapsedMs, formatElapsed, useTicker } from "../../useTicker";
import { RetriedMark } from "../RetriedMark";
import { LogTiming } from "../LogTiming";
import { COLUMNS } from "./columns";
import {
  ChannelStack,
  compactText,
  DurationTime,
  IpCell,
  ModelCell,
  ReasoningCell,
  StatusBadge,
  TokenCell,
} from "./LogCells";

export const LOG_TABLE_COLUMN_COUNT = COLUMNS.length;

export function LogTable({
  logs,
  active,
  activeLatest,
  loading,
  hiddenClasses,
  sensitiveHidden,
  onOpenDetail,
}: {
  logs: RequestLog[];
  active: ActiveRequest[];
  activeLatest: ActiveRequest[];
  loading: boolean;
  hiddenClasses: string[];
  sensitiveHidden: boolean;
  onOpenDetail: (log: RequestLog) => void;
}) {
  return (
    <div className="table-wrap">
      <table className={["admin-table", "log-table", ...hiddenClasses].join(" ")}>
        <thead>
          <tr>
            {COLUMNS.map((column) => (
              <th key={column.key} className={column.className} data-col={column.key}>
                {column.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          <ActiveRows active={active} snapshot={activeLatest} sensitiveHidden={sensitiveHidden} />
          <LogRows
            logs={logs}
            loading={loading}
            hasActive={active.length > 0}
            sensitiveHidden={sensitiveHidden}
            onOpenDetail={onOpenDetail}
          />
        </tbody>
      </table>
    </div>
  );
}

function activeKeyName(request: ActiveRequest): string | undefined {
  if (!request.upstream_key_id) return undefined;
  return request.upstream_key_name || `#${request.upstream_key_id}`;
}

function ActiveRows({ active, snapshot, sensitiveHidden }: {
  active: ActiveRequest[];
  snapshot: ActiveRequest[];
  sensitiveHidden: boolean;
}) {
  const [receivedAt, setReceivedAt] = useState(() => Date.now());
  const signature = snapshot.map((request) => `${request.id}:${request.elapsed_ms}`).join(",");
  useEffect(() => setReceivedAt(Date.now()), [signature]);
  const now = useTicker(active.length > 0);

  return (
    <>
      {active.map((request) => (
        <tr
          key={`active-${request.id}`}
          className="log-row log-row--active"
          title="请求进行中，完成后才会写入日志"
        >
          <td className="time-cell" data-col="time">
            <span>{formatTimestamp(request.started_at)}</span>
            <span className="muted">进行中</span>
          </td>
          <td className="channel-cell" data-col="channel">
            {request.upstream_id === null || request.upstream_id === undefined ? (
              <span className="muted">路由中…</span>
            ) : (
              <ChannelStack
                log={request}
                sensitiveHidden={sensitiveHidden}
                keyName={activeKeyName(request)}
              />
            )}
          </td>
          <td className="token-cell" data-col="token">
            <TokenCell log={request} sensitiveHidden={sensitiveHidden} />
          </td>
          <td data-col="client"><span className="badge neutral">{request.client_type || "unknown"}</span></td>
          <td className="model-cell" data-col="model"><ModelCell log={request} /></td>
          <td className="col-reasoning" data-col="reasoning"><ReasoningCell log={request} /></td>
          <td data-col="status">
            <span className="badge neutral status-active">
              <span className="status-active-dot" aria-hidden="true" />
              进行中
            </span>
            {request.attempt > 1 ? (
              <span className="badge warn active-attempt" title={`已换过 ${request.attempt} 个渠道`}>
                {`第 ${request.attempt} 次`}
              </span>
            ) : null}
          </td>
          <td className="duration-cell" data-col="duration">
            <span className="latency-metrics">
              <span className="latency-metric">
                <small>已用时</small>
                <span className="duration-time neutral">
                  {formatElapsed(elapsedMs(request.elapsed_ms, receivedAt, now))}
                </span>
              </span>
            </span>
          </td>
          <td className="tokens-cell" data-col="tokens"><span className="muted">-</span></td>
          <td className="ip-cell" data-col="ip">
            <IpCell ip={request.client_ip} sensitiveHidden={sensitiveHidden} />
          </td>
          <td className="detail-cell" data-col="detail"><span className="muted">-</span></td>
        </tr>
      ))}
    </>
  );
}

function LogRows({ logs, loading, hasActive, sensitiveHidden, onOpenDetail }: {
  logs: RequestLog[];
  loading: boolean;
  hasActive: boolean;
  sensitiveHidden: boolean;
  onOpenDetail: (log: RequestLog) => void;
}) {
  if (loading && logs.length === 0) {
    return <tr><td colSpan={LOG_TABLE_COLUMN_COUNT} className="muted">加载中…</td></tr>;
  }
  if (logs.length === 0 && !hasActive) {
    return <tr><td colSpan={LOG_TABLE_COLUMN_COUNT} className="muted">暂无请求日志</td></tr>;
  }
  return (
    <>
      {logs.map((log) => (
        <LogRow
          key={log.id}
          log={log}
          sensitiveHidden={sensitiveHidden}
          onOpenDetail={onOpenDetail}
        />
      ))}
    </>
  );
}

const LogRow = memo(function LogRow({ log, sensitiveHidden, onOpenDetail }: {
  log: RequestLog;
  sensitiveHidden: boolean;
  onOpenDetail: (log: RequestLog) => void;
}) {
  return (
    <tr
      className="log-row"
      title={log.error || "点击查看请求详情"}
      data-log-id={log.id}
      tabIndex={0}
      onClick={() => onOpenDetail(log)}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onOpenDetail(log);
      }}
    >
      <td className="time-cell" data-col="time">
        <span>{formatTimestamp(log.created_at)}</span>
        <span className="muted">#{log.id}</span>
      </td>
      <td className="channel-cell" data-col="channel">
        <ChannelStack log={log} sensitiveHidden={sensitiveHidden} />
        {log.attempt_index != null && log.attempt_index > 0 ? <span className="log-row-attempt-badge">重试 #{log.attempt_index}</span> : null}
      </td>
      <td className="token-cell" data-col="token">
        <TokenCell log={log} sensitiveHidden={sensitiveHidden} />
      </td>
      <td data-col="client"><span className="badge neutral">{log.client_type}</span></td>
      <td className="model-cell" data-col="model"><ModelCell log={log} /></td>
      <td className="col-reasoning" data-col="reasoning"><ReasoningCell log={log} /></td>
      <td data-col="status"><StatusBadge code={log.status_code} />{log.retried ? <RetriedMark /> : null}</td>
      <td className="duration-cell" data-col="duration">
        <span className="latency-metrics">
          <span className="latency-metric">
            <small>首字</small>
            <span className={`first-token-time ${firstTokenTone(log.first_token_ms)}`} title={`首字耗时 ${formatSeconds(log.first_token_ms)}`}>
              {formatSeconds(log.first_token_ms)}
            </span>
          </span>
          <span className="latency-metric"><small>耗时</small><DurationTime log={log} /></span>
        </span>
        <LogTiming log={log} compact />
      </td>
      <td className="tokens-cell" data-col="tokens">
        <span
          className="token-io"
          role="img"
          aria-label={`${exactTokens("输入", log.prompt_tokens)}，${exactTokens("输出", log.completion_tokens)}`}
        >
          <span className="token-io-line token-io-in" title={exactTokens("输入", log.prompt_tokens)}>
            <span className="token-io-arrow" aria-hidden="true">↑</span>
            <b>{formatCount(log.prompt_tokens)}</b>
          </span>
          <span className="token-io-line token-io-out" title={exactTokens("输出", log.completion_tokens)}>
            <span className="token-io-arrow" aria-hidden="true">↓</span>
            <b>{formatCount(log.completion_tokens)}</b>
          </span>
        </span>
      </td>
      <td className="ip-cell" data-col="ip">
        <IpCell ip={log.client_ip} sensitiveHidden={sensitiveHidden} />
      </td>
      <td className="detail-cell" data-col="detail">
        {log.error?.trim() ? (
          <span className="log-error-detail" title={log.error}>{compactText(log.error, 200)}</span>
        ) : (
          <span className="muted">-</span>
        )}
      </td>
    </tr>
  );
});
