import { useCallback, useEffect, useMemo, useState } from "react";

import { UnauthorizedError, setAdminToken } from "./api";
import { AdminTokenDialog } from "./components/AdminTokenDialog";
import { CommandPalette } from "./components/CommandPalette";
import type { Command } from "./components/CommandPalette";
import { ConfirmProvider, ToastProvider } from "./components/feedback";
import { Topbar } from "./components/Topbar";
import {
  BUILTIN_THEMES,
  THEME_LABELS,
  THEME_PACKS,
  applyDensity,
  applyTheme,
  currentDensity,
  currentTheme,
} from "./theme";
import { DashboardPage } from "./pages/DashboardPage";
import { GroupsPage } from "./pages/GroupsPage";
import { LogsPage } from "./pages/LogsPage";
import { SettingsPage } from "./pages/SettingsPage";
import { TokensPage } from "./pages/TokensPage";
import { UpstreamsPage } from "./pages/UpstreamsPage";
import { getAdminToken } from "./api";

export type ViewId = "dashboard" | "upstreams" | "logs" | "tokens" | "groups" | "settings";

export function App() {
  const [view, setView] = useState<ViewId>("upstreams");
  const [needsToken, setNeedsToken] = useState(() => getAdminToken() === "");
  const [tokenError, setTokenError] = useState("");
  /* <main> 的 key。自增一次就把当前页重挂载一遍，它自己会重新取数。

     两个场合用到：登录成功（401 那一刻页面已经取数失败并停在空态，光关掉
     登录框界面会一直空着），和命令面板的「刷新当前视图」。都不必让页面
     知道这两件事。 */
  const [contentEpoch, setContentEpoch] = useState(0);

  /* 401 从任何请求里冒出来时统一处理：清掉令牌、弹登录框。旧控制台是在
     api() 里直接开弹窗，这里改成往上抛，由一处集中接住——组件不需要知道
     认证这回事。 */
  const handleUnauthorized = useCallback((message: string) => {
    setTokenError(message);
    setNeedsToken(true);
  }, []);

  useEffect(() => {
    const onUnauthorized = (event: Event) => {
      handleUnauthorized((event as CustomEvent<string>).detail);
    };
    window.addEventListener("console:unauthorized", onUnauthorized);
    return () => window.removeEventListener("console:unauthorized", onUnauthorized);
  }, [handleUnauthorized]);

  /* 只放真的能执行的命令。旧版面板里那些「G D」「R」标签从来没绑过键，
     标一个按下去没反应的快捷键比不标更糟。 */
  const commands = useMemo<Command[]>(() => {
    const views: Array<{ id: ViewId; label: string; hint: string }> = [
      { id: "dashboard", label: "看板", hint: "请求量、延时与错误汇总" },
      { id: "upstreams", label: "渠道", hint: "查看与管理上游渠道" },
      { id: "logs", label: "日志", hint: "查看代理请求日志" },
      { id: "tokens", label: "令牌", hint: "管理下游 API 令牌" },
      { id: "groups", label: "分组", hint: "隔离令牌可访问的渠道范围" },
      { id: "settings", label: "设置", hint: "控制台偏好与网关策略" },
    ];
    const themeIds = [...BUILTIN_THEMES, ...Object.keys(THEME_PACKS)];

    return [
      ...views.map((item) => ({
        id: `view-${item.id}`,
        title: `切换到${item.label}`,
        subtitle: item.hint,
        run: () => setView(item.id),
      })),
      {
        id: "refresh",
        title: "刷新当前视图",
        subtitle: "重新加载当前页数据",
        run: () => setContentEpoch((epoch) => epoch + 1),
      },
      {
        id: "theme",
        title: "切换主题",
        subtitle: themeIds.map((id) => THEME_LABELS[id] ?? id).join(" / "),
        run: () => {
          const next = themeIds[(themeIds.indexOf(currentTheme()) + 1) % themeIds.length];
          applyTheme(next);
        },
      },
      {
        id: "density",
        title: "切换密度",
        subtitle: "舒适 / 紧凑",
        run: () => applyDensity(currentDensity() === "compact" ? "comfortable" : "compact"),
      },
      {
        id: "logout",
        title: "退出登录",
        subtitle: "清除 Admin Token 并重新登录",
        run: () => {
          setAdminToken("");
          broadcastUnauthorized("已退出，请重新输入管理员令牌。");
        },
      },
    ];
  }, []);

  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="app-shell">
          <Topbar view={view} onNavigate={setView} />
          <main className="content" key={contentEpoch}>
            {view === "upstreams" ? (
              <UpstreamsPage onUnauthorized={handleUnauthorized} />
            ) : view === "logs" ? (
              <LogsPage onUnauthorized={handleUnauthorized} />
            ) : view === "tokens" ? (
              <TokensPage onUnauthorized={handleUnauthorized} />
            ) : view === "groups" ? (
              <GroupsPage onUnauthorized={handleUnauthorized} />
            ) : view === "settings" ? (
              <SettingsPage onUnauthorized={handleUnauthorized} />
            ) : view === "dashboard" ? (
              <DashboardPage onUnauthorized={handleUnauthorized} />
            ) : (
              <NotImplemented view={view} />
            )}
          </main>
          <AdminTokenDialog
            open={needsToken}
            error={tokenError}
            onClose={() => setNeedsToken(false)}
            onSubmitted={() => {
              setNeedsToken(false);
              setTokenError("");
              setContentEpoch((epoch) => epoch + 1);
            }}
          />

          <CommandPalette commands={commands} />
        </div>
      </ConfirmProvider>
    </ToastProvider>
  );
}

/**
 * 探针阶段只做渠道页。其余视图留个明确的占位，而不是空白——
 * 空白看起来像坏了。
 */
function NotImplemented({ view }: { view: ViewId }) {
  return (
    <section className="view" data-view={view}>
      <section className="panel">
        <div className="panel-head">
          <div>
            <span className="eyebrow">NOT PORTED YET</span>
            <h2>这个视图还没搬到新控制台</h2>
            <p>
              新控制台目前只实现了渠道页和日志页。旧版仍在 <a href="/admin">/admin</a> 上可用。
            </p>
          </div>
        </div>
      </section>
    </section>
  );
}

/** 供请求层在 401 时广播，App 统一接住。 */
export function broadcastUnauthorized(message: string): void {
  window.dispatchEvent(new CustomEvent("console:unauthorized", { detail: message }));
}

export { UnauthorizedError };
