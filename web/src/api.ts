/* 后端调用。认证方式和旧控制台一致：localStorage 里的
   wildtoken_admin_token，走 x-admin-token 头。同一个浏览器里两版
   共用一份令牌，切过去不用重新登录。 */

import type { Upstream } from "./types";

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
