import { parseLogTime } from "./logFormat";
import type { RequestLog } from "./types";

export interface LogFilters {
  search?: string;
  clientType?: string;
  status?: string;
  upstreamId?: string;
  tokenId?: string;
  start?: string;
  end?: string;
  stream?: string;
  minDurationMs?: string;
}

/** List and SSE must receive exactly the same filters. */
export function logFilterQuery(filters: LogFilters): URLSearchParams {
  const query = new URLSearchParams();
  const names: Record<keyof LogFilters, string> = { search: "search", clientType: "client_type", status: "status", upstreamId: "upstream_id", tokenId: "downstream_token_id", start: "start", end: "end", stream: "stream", minDurationMs: "min_duration_ms" };
  for (const [key, name] of Object.entries(names)) {
    const value = filters[key as keyof LogFilters]?.trim();
    if (value) query.set(name, value);
  }
  return query;
}

export function matchesLogFilters(log: RequestLog, filters: LogFilters): boolean {
  if (filters.upstreamId && String(log.upstream_id) !== filters.upstreamId) return false;
  if (filters.tokenId && String(log.downstream_token_id) !== filters.tokenId) return false;
  if (filters.clientType && log.client_type !== filters.clientType) return false;
  const status = log.status_code;
  if (filters.status === "none" && status != null) return false;
  if (filters.status === "error" && status != null && status >= 200 && status < 300) return false;
  if (filters.status === "other" && !(status != null && ((status >= 100 && status < 200) || (status >= 300 && status < 400)))) return false;
  if (/^[245]xx$/.test(filters.status ?? "")) {
    const base = Number(filters.status![0]) * 100;
    if (status == null || status < base || status >= base + 100) return false;
  }
  if (filters.stream && Boolean(log.stream) !== (filters.stream === "true")) return false;
  if (filters.minDurationMs && (log.duration_ms == null || log.duration_ms < Number(filters.minDurationMs))) return false;
  const at = parseLogTime(log.created_at)?.getTime();
  if (filters.start && (at === undefined || at < Date.parse(filters.start))) return false;
  if (filters.end && (at === undefined || at >= Date.parse(filters.end))) return false;
  const needle = filters.search?.trim().toLowerCase();
  return !needle || [log.id, log.model, log.request_model, log.upstream_model, log.upstream_name, log.downstream_token_name, log.client_ip, log.error, log.status_code].some((value) => value != null && String(value).toLowerCase().includes(needle));
}

const DRILLDOWN_KEY = "wildtoken_log_drilldown";
export function navigateToLogs(filters: LogFilters): void {
  try { sessionStorage.setItem(DRILLDOWN_KEY, JSON.stringify(filters)); } catch { /* In-memory event still works. */ }
  window.location.hash = "logs";
  window.dispatchEvent(new CustomEvent("console:log-filters", { detail: filters }));
}
export function saveLogDrilldown(filters: LogFilters): void {
  try {
    const cleaned = Object.fromEntries(
      Object.entries(filters).filter(([, v]) => typeof v === "string" && v.trim() !== "")
    );
    if (Object.keys(cleaned).length === 0) {
      sessionStorage.removeItem(DRILLDOWN_KEY);
    } else {
      sessionStorage.setItem(DRILLDOWN_KEY, JSON.stringify(cleaned));
    }
  } catch { /* Storage not accessible */ }
}
export function clearLogDrilldown(): void {
  try { sessionStorage.removeItem(DRILLDOWN_KEY); } catch { /* Storage not accessible */ }
}
export function readLogDrilldown(): LogFilters {
  try {
    const value: unknown = JSON.parse(sessionStorage.getItem(DRILLDOWN_KEY) ?? "{}");
    if (!value || typeof value !== "object") return {};
    return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === "string"));
  } catch { return {}; }
}
