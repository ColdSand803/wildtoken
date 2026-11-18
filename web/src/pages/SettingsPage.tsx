import { useState } from "react";

import { getSystemInfo } from "../api";
import { DataManagement } from "../components/DataManagement";
import { LoadError } from "../components/LoadError";
import { PreferencesCard } from "../components/settings/PreferencesCard";
import { PromptSettings } from "../components/settings/PromptSettings";
import { RuntimeSettingsCards } from "../components/settings/RuntimeSettingsCards";
import { SecuritySettings } from "../components/settings/SecuritySettings";
import { SystemInfoCard } from "../components/settings/SystemInfoCard";
import type { SystemInfo } from "../types";
import { useRemoteResource } from "../useRemoteResource";
import { useRuntimeSettings } from "../useRuntimeSettings";

export function SettingsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const [dataRevision, setDataRevision] = useState(0);
  const editor = useRuntimeSettings(onUnauthorized);
  const system = useRemoteResource(getSystemInfo, onUnauthorized);

  async function reloadAfterDataChange(): Promise<void> {
    await Promise.all([editor.reload(), system.reload()]);
    setDataRevision((revision) => revision + 1);
  }

  return (
    <section className="view settings-view" data-view="settings">
      <section className="panel settings-hero">
        <div className="panel-head">
          <div>
            <span className="eyebrow">CONSOLE CONTROL</span>
            <h2>设置</h2>
            <p>将本机偏好与网关运行策略分别管理；敏感凭证不会在此读取或保存。</p>
          </div>
        </div>
        <LoadError error={editor.error} label="运行策略" onRetry={editor.reload} />
        <div className="settings-stack">
          <PreferencesCard />
          {editor.loading ? <p className="settings-loading">加载中…</p> : null}
          <RuntimeSettingsCards cards={["log", "routing", "proxy"]} editor={editor} />
          <PromptSettings onUnauthorized={onUnauthorized} refreshKey={dataRevision} />
          <RuntimeSettingsCards cards={["timeout", "dashboard"]} editor={editor}
            defaultTimeout={system.data?.default_upstream_timeout_seconds} />
          <SecuritySettings onUnauthorized={onUnauthorized} />
          <DataManagement onChanged={reloadAfterDataChange} />
          <MetricsEndpointCard system={system.data} />
          <SystemInfoCard system={system.data} loading={system.loading} refreshing={system.pending}
            error={system.error} onRefresh={system.reload} />
        </div>
      </section>
    </section>
  );
}

function MetricsEndpointCard({ system }: { system: SystemInfo | null }) {
  const endpoint = system?.metrics_endpoint;
  return (
    <section className="settings-card metrics-endpoint-card">
      <div className="settings-card-head">
        <div><h3>Prometheus 监控端点</h3><p>由启动配置管理，只读，不显示访问凭证。</p></div>
      </div>
      {endpoint
        ? <p>{endpoint.enabled ? "已启用" : "已停用"} · <code>{endpoint.path}</code> · {endpoint.token_required ? "需要访问令牌" : "未设置访问令牌，请限制网络访问"}</p>
        : <p>端点状态暂不可用。</p>}
    </section>
  );
}
