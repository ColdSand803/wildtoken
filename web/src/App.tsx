import { useCallback, useEffect, useState } from "react";

import { UnauthorizedError } from "./api";
import { AdminTokenDialog } from "./components/AdminTokenDialog";
import { ConfirmProvider, ToastProvider } from "./components/feedback";
import { Topbar } from "./components/Topbar";
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
  /* 登录成功后自增，作为 <main> 的 key。

     401 的那一刻页面已经取数失败并停在空态，而每个页面的取数只在挂载时
     跑一次——光关掉登录框，界面会一直空着，看起来像坏了。重挂载让当前页
     自己重新取数，不必每个页面都知道有认证这回事。 */
  const [authEpoch, setAuthEpoch] = useState(0);

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

  return (
    <ToastProvider>
      <ConfirmProvider>
        <div className="app-shell">
          <Topbar view={view} onNavigate={setView} />
          <main className="content" key={authEpoch}>
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
              setAuthEpoch((epoch) => epoch + 1);
            }}
          />
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
