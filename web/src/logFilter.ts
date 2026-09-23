/**
 * 日志页筛选在前端的复刻。
 *
 * 分页走服务端筛选，但流推来的新日志没经过查询，得在前端按同一套规则再判
 * 一次，否则筛着 5xx 时一条 200 结束了也会插进列表。规则照抄
 * internal/db/log.go 的 appendFilters，两边改一处要同步另一处。
 */

import type { RequestLog } from "./types";

export interface LogFilters {
  /** 渠道 id 的字符串形式，空串 = 不筛。 */
  upstreamId: string;
  clientType: string;
  /** "" | "2xx" | "4xx" | "5xx" | "none" */
  status: string;
  search: string;
}

function matchesStatus(code: number | null, status: string): boolean {
  if (!status) return true;
  if (status === "none") return code === null;
  if (code === null) return false;

  const bucket = { "2xx": 200, "4xx": 400, "5xx": 500 }[status];
  // 不认识的档位服务端也不筛。
  if (bucket === undefined) return true;
  return code >= bucket && code < bucket + 100;
}

/** 大小写不敏感的子串匹配，字段同服务端 LIKE 的那八个。 */
function matchesSearch(row: RequestLog, search: string): boolean {
  const needle = search.trim().toLowerCase();
  if (!needle) return true;

  return [
    row.model,
    row.request_model,
    row.upstream_model,
    row.upstream_name,
    row.downstream_token_name,
    row.error,
    row.id,
    row.status_code,
  ].some((value) => value !== null && value !== undefined && String(value).toLowerCase().includes(needle));
}

export function logMatchesFilters(row: RequestLog, filters: LogFilters): boolean {
  if (filters.upstreamId && String(row.upstream_id ?? "") !== filters.upstreamId) return false;
  if (filters.clientType && row.client_type !== filters.clientType) return false;
  if (!matchesStatus(row.status_code, filters.status)) return false;
  return matchesSearch(row, filters.search);
}
