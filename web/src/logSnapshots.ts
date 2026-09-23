/**
 * 日志详情的报文页签：四份快照的定义，以及按日志缓存的加载状态。
 *
 * 抽成独立模块是为了能被直接测到：换日志后迟到的响应不能盖到新日志上，
 * 这条规则靠源码字符串断言锁不住。
 */

import type { LogSnapshotField } from "./types";

/** 四份快照的展示顺序：先请求后响应，先下游后上游。 */
export const SNAPSHOT_SECTIONS = [
  {
    key: "downstream_request",
    label: "下游请求",
    copy: "客户端发给 WildToken 的原始请求。",
    side: "request",
  },
  {
    key: "upstream_request",
    label: "上游请求",
    copy: "转发到渠道前的请求快照。",
    side: "request",
  },
  {
    key: "upstream_response",
    label: "上游响应",
    copy: "渠道返回给 WildToken 的响应。",
    side: "response",
  },
  {
    key: "downstream_response",
    label: "下游响应",
    copy: "最终返回给客户端的响应快照。",
    side: "response",
  },
] as const satisfies ReadonlyArray<{
  key: LogSnapshotField;
  label: string;
  copy: string;
  side: "request" | "response";
}>;

export type SnapshotSection = (typeof SNAPSHOT_SECTIONS)[number];

export type SnapshotState =
  | { status: "loading" }
  | { status: "ready"; raw: unknown }
  | { status: "error"; message: string };

/** 一条日志已拉过的快照。id 为 null 表示还没为任何日志拉过。 */
export interface SnapshotCache {
  id: number | null;
  items: Partial<Record<LogSnapshotField, SnapshotState>>;
}

export const EMPTY_SNAPSHOTS: SnapshotCache = { id: null, items: {} };

/** 当前日志的快照；缓存属于别的日志时视作空。 */
export function snapshotsFor(
  cache: SnapshotCache,
  id: number | null,
): SnapshotCache["items"] {
  return cache.id === id ? cache.items : {};
}

/**
 * 记下一份快照的状态。
 *
 * 开始加载另一条日志会整个换掉缓存；之后上一条日志的结果才到，id 对不上，
 * 直接丢掉，不然会显示成新日志的报文。
 */
export function withSnapshot(
  cache: SnapshotCache,
  id: number,
  field: LogSnapshotField,
  state: SnapshotState,
): SnapshotCache {
  if (cache.id === id) {
    return { id, items: { ...cache.items, [field]: state } };
  }
  if (state.status === "loading") {
    return { id, items: { [field]: state } };
  }
  return cache;
}
