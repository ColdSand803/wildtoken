import { useCallback, useEffect, useRef, useState } from "react";
import { api, HTTPError } from "../api";
import { formatTimestamp } from "../logFormat";

export interface ProbeResult { upstream_id: number; ok: boolean; status_code: number | null; duration_ms: number | null; error_summary: string | null; checked_at: string }
export interface ProbeRun { running?: boolean; checked_at?: string | null; results: ProbeResult[]; total?: number; skipped?: number; partial?: boolean }
export interface RoutingInfo {
  strategy: string; latency_active: boolean;
  rules: { min_samples: number; stale_window_seconds: number; sample_capacity: number; tolerance_ratio: number; tolerance_floor_ms: number };
  latency: Array<{ upstream_id: number; median_ms: number | null; sample_count: number; usable: boolean }>;
}
export function useChannelDiagnostics() {
  const [probe, setProbe] = useState<ProbeRun | null>(null);
  const [routing, setRouting] = useState<RoutingInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const controller = useRef<AbortController | null>(null);
  const reload = useCallback(async (signal?: AbortSignal) => {
    const [last, policy] = await Promise.all([api<ProbeRun>("/api/admin/upstreams/probe-all", { signal }), api<RoutingInfo>("/api/admin/upstreams/routing", { signal })]);
    if (!signal?.aborted) { setProbe(last); setRouting(policy); }
  }, []);
  useEffect(() => {
    const loadController = new AbortController();
    void reload(loadController.signal).catch(() => {});
    return () => { loadController.abort(); controller.current?.abort(); };
  }, [reload]);
  useEffect(() => {
    if (!probe?.running) return;
    const loadController = new AbortController();
    const timer = setTimeout(() => { void reload(loadController.signal).catch(() => setError("无法同步测活状态，请刷新重试。")); }, 1500);
    return () => { clearTimeout(timer); loadController.abort(); };
  }, [probe, reload]);
  async function run(includeDisabled: boolean) {
    if (busy || probe?.running) return;
    const current = new AbortController(); controller.current = current;
    setBusy(true); setError("");
    try {
      const result = await api<ProbeRun>(`/api/admin/upstreams/probe-all${includeDisabled ? "?include_disabled=true" : ""}`, { method: "POST", signal: current.signal });
      setProbe({ ...result, running: false });
    } catch (err) {
      if (current.signal.aborted) return;
      if (err instanceof HTTPError && err.status === 409) await reload(current.signal).catch(() => setError("已有测活任务，状态同步失败，请刷新重试。"));
      else setError(err instanceof Error ? err.message : String(err));
    } finally { if (!current.signal.aborted) setBusy(false); }
  }
  return { probe, routing, busy, error, run, reload };
}
export function ChannelDiagnostics({ state }: { state: ReturnType<typeof useChannelDiagnostics> }) {
  const [includeDisabled, setIncludeDisabled] = useState(false);
  const success = state.probe?.results.filter((item) => item.ok).length ?? 0;
  const failed = (state.probe?.results.length ?? 0) - success;
  const routing = state.routing;
  return <div className="channel-diagnostics">
    <div className="probe-controls"><button type="button" className="secondary" disabled={state.busy || state.probe?.running} onClick={() => void state.run(includeDisabled)}>{state.busy || state.probe?.running ? "测活中…" : "批量测活"}</button>
      <label><input type="checkbox" checked={includeDisabled} disabled={state.busy} onChange={(event) => setIncludeDisabled(event.target.checked)} />包括停用渠道</label>
      <span role="status">{state.probe ? `成功 ${success} · 失败 ${failed}${state.probe.skipped ? ` · 跳过 ${state.probe.skipped}` : ""}${state.probe.partial ? " · 部分完成" : ""}` : "暂无测活记录"}</span>
      <button type="button" className="secondary ghost" onClick={() => void state.reload().catch(() => {})}>刷新诊断</button>
    </div>
    {state.error && <p role="alert">{state.error}</p>}
    {routing && <div id="upstream-routing-summary"><p>同优先级路由：<strong>{routing.strategy === "least_latency" ? "最低延迟优先" : "有效权重随机"}</strong> · {routing.latency_active ? "延迟决策已激活" : "延迟决策未激活"}</p>
      {routing.strategy === "least_latency" && <details><summary>延迟采样参数与回退规则</summary><p>最小样本 {routing.rules.min_samples}；过期 {routing.rules.stale_window_seconds}s；容量 {routing.rules.sample_capacity}；容忍带 {Math.round(routing.rules.tolerance_ratio * 100)}%（至少 {routing.rules.tolerance_floor_ms}ms）。无可用样本时回退到权重随机；未测量渠道保留竞争。</p></details>}
    </div>}
  </div>;
}
export function ChannelDiagnosticBadge({ id, state }: { id: number; state: ReturnType<typeof useChannelDiagnostics> }) {
  const result = state.probe?.results.find((item) => item.upstream_id === id);
  const latency = state.routing?.latency.find((item) => item.upstream_id === id);
  return <span className="channel-diagnostic-badges">
    {result && <span className={`badge ${result.ok ? "ok" : "danger"}`} title={`${formatTimestamp(result.checked_at)} · ${result.error_summary ?? result.status_code ?? "无响应"}`}>测活 {result.ok ? "成功" : "失败"}{result.duration_ms == null ? "" : ` · ${result.duration_ms}ms`}</span>}
    {state.routing?.latency_active && <span className="badge neutral">{latency?.usable && latency.median_ms != null ? `决策 ${latency.median_ms}ms` : `采样 ${latency?.sample_count ?? 0}/${state.routing.rules.min_samples}`}</span>}
  </span>;
}
