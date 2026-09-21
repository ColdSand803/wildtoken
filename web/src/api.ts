/* 后端调用。认证方式和旧控制台一致：localStorage 里的
   wildtoken_admin_token，走 x-admin-token 头。同一个浏览器里两版
   共用一份令牌，切过去不用重新登录。 */

import type { ChannelExportDocument, ImportResult, Upstream, UpstreamStats } from "./types";

const ADMIN_TOKEN_KEY = "wildtoken_admin_token";

export function getAdminToken(): string {
  return localStorage.getItem(ADMIN_TOKEN_KEY) ?? "";
}

export function setAdminToken(token: string): void {
  localStorage.setItem(ADMIN_TOKEN_KEY, token);
}

export function clearAdminToken(): void {
  localStorage.removeItem(ADMIN_TOKEN_KEY);
}

/** 401 时抛这个，让调用方能弹出登录框而不是显示一条普通错误。 */
export class UnauthorizedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnauthorizedError";
  }
}

/**
 * 401 往上一处报。
 *
 * 旧控制台是在 api() 里直接开弹窗；这里改成广播，由 App 集中接住。
 * 好处是各页面不必各自处理认证，也就不可能漏掉一处。
 */
function reportUnauthorized(message: string): void {
  window.dispatchEvent(new CustomEvent<string>("console:unauthorized", { detail: message }));
}

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  const token = getAdminToken();
  if (token) headers.set("x-admin-token", token);

  const response = await fetch(path, { ...init, headers });

  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const data = await response.json();
      message = data.detail || data.error?.message || data.error || message;
    } catch {
      // 非 JSON 错误体，保留 HTTP 状态说明。
    }
    if (response.status === 401) {
      clearAdminToken();
      reportUnauthorized(message);
      throw new UnauthorizedError(message);
    }
    throw new Error(message);
  }

  if (response.status === 204) return null as T;
  return (await response.json()) as T;
}

export function listUpstreams(): Promise<Upstream[]> {
  return api<Upstream[]>("/api/admin/upstreams/");
}

export function createUpstream(payload: unknown): Promise<Upstream> {
  return api<Upstream>("/api/admin/upstreams/", {
    method: "POST",
    body: JSON.stringify(payload),
  });
}

export function updateUpstream(id: number, payload: unknown): Promise<Upstream> {
  return api<Upstream>(`/api/admin/upstreams/${id}`, {
    method: "PUT",
    body: JSON.stringify(payload),
  });
}

export function deleteUpstream(id: number): Promise<null> {
  return api<null>(`/api/admin/upstreams/${id}`, { method: "DELETE" });
}

/** 返回完整渠道（含 api_key 与否），编辑和复制都需要。 */
export function getUpstream(id: number): Promise<Upstream> {
  return api<Upstream>(`/api/admin/upstreams/${id}`);
}

export function testUpstream(id: number, path = "/v1/models"): Promise<unknown> {
  return api<unknown>(`/api/admin/upstreams/${id}/test`, {
    method: "POST",
    body: JSON.stringify({ path }),
  });
}

export function fetchUpstreamModels(id: number): Promise<unknown> {
  return api<unknown>(`/api/admin/upstreams/${id}/models`, { method: "POST" });
}

/** new-api 与 sub2api 两种余额接口，路径不同。 */
export function fetchUpstreamBalance(id: number, provider: "new-api" | "sub2api"): Promise<unknown> {
  const path = provider === "sub2api"
    ? `/api/admin/upstreams/${id}/balance/sub2api`
    : `/api/admin/upstreams/${id}/balance`;
  return api<unknown>(path, { method: "POST" });
}

export function listGroups(): Promise<Array<{ id: number; name: string }>> {
  return api<Array<{ id: number; name: string }>>("/api/admin/groups/");
}

/** 卡片视图的统计，一次拿全部渠道——按渠道逐个请求会变成 N 次往返。 */
export function fetchUpstreamStats(): Promise<Record<string, UpstreamStats>> {
  return api<Record<string, UpstreamStats>>("/api/admin/upstreams/stats");
}

/** 导出文档。后端返回的是带 kind/version 的包装，直接存成文件。 */
export function exportUpstreams(ids?: number[]): Promise<ChannelExportDocument> {
  return api<ChannelExportDocument>("/api/admin/upstreams/export", {
    method: "POST",
    body: JSON.stringify(ids?.length ? { ids } : {}),
  });
}

export function importUpstreams(
  document: ChannelExportDocument,
  mode: "skip" | "overwrite",
): Promise<ImportResult> {
  return api<ImportResult>("/api/admin/upstreams/import", {
    method: "POST",
    body: JSON.stringify({ ...document, mode }),
  });
}

/** 快速导入：从一段文本里拿 Base URL 和 Key 后，再问上游要模型列表。 */
export function fetchModelsPreview(baseUrl: string, apiKey: string | null): Promise<{ models: string[] }> {
  return api<{ models: string[] }>("/api/admin/upstreams/fetch-models", {
    method: "POST",
    body: JSON.stringify({ base_url: baseUrl, api_key: apiKey }),
  });
}

export function setUpstreamArchived(id: number, archived: boolean): Promise<Upstream> {
  return api<Upstream>(`/api/admin/upstreams/${id}/archived`, {
    method: "PATCH",
    body: JSON.stringify({ archived }),
  });
}

export function setUpstreamEnabled(id: number, enabled: boolean): Promise<Upstream> {
  return api<Upstream>(`/api/admin/upstreams/${id}/enabled`, {
    method: "PATCH",
    body: JSON.stringify({ enabled }),
  });
}

export function setUpstreamPriority(id: number, priority: number): Promise<Upstream> {
  return api<Upstream>(`/api/admin/upstreams/${id}/priority`, {
    method: "PATCH",
    body: JSON.stringify({ priority }),
  });
}
