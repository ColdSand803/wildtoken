import { logMatchesFilters } from "./logFilter.ts";
import type { LogFilters } from "./logFilter";
import type { RequestLog } from "./types";

export interface LogCursor {
  created_at: string;
  id: number;
}

/** 旧页不混入推送；最新页去重后按写入顺序排列。 */
export function mergeLogRows(
  items: readonly RequestLog[],
  streamed: readonly RequestLog[],
  latest: boolean,
  filters: LogFilters,
): RequestLog[] {
  const seen = new Set<number>();
  const merged: RequestLog[] = [];
  const incoming = latest ? streamed.filter((log) => logMatchesFilters(log, filters)) : [];

  for (const log of [...incoming, ...items]) {
    if (seen.has(log.id)) continue;
    seen.add(log.id);
    merged.push(log);
  }
  return merged.sort((a, b) => b.id - a.id);
}

/** 游标取屏幕末行；新页未到时连点不能把同一游标压两次。 */
export function appendLogCursor(stack: LogCursor[], rows: readonly RequestLog[]): LogCursor[] {
  const last = rows.at(-1);
  if (!last || stack.at(-1)?.id === last.id) return stack;
  return [...stack, { created_at: last.created_at, id: last.id }];
}

export function needsLogResync(evicted: number, covered: number, latest: boolean): boolean {
  return latest && evicted > covered;
}
