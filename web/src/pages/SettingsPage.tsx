import { getSystemInfo } from "../api";
import { LoadError } from "../components/LoadError";
import { PreferencesCard } from "../components/settings/PreferencesCard";
import { PromptSettings } from "../components/settings/PromptSettings";
import { RuntimeSettingsCards } from "../components/settings/RuntimeSettingsCards";
import { SecuritySettings } from "../components/settings/SecuritySettings";
import { SystemInfoCard } from "../components/settings/SystemInfoCard";
import { useRemoteResource } from "../useRemoteResource";
import { useRuntimeSettings } from "../useRuntimeSettings";

export function SettingsPage({ onUnauthorized }: { onUnauthorized: (message: string) => void }) {
  const editor = useRuntimeSettings(onUnauthorized);
  const system = useRemoteResource(getSystemInfo, onUnauthorized);

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
          <PromptSettings onUnauthorized={onUnauthorized} />
          <RuntimeSettingsCards cards={["timeout", "dashboard"]} editor={editor}
            defaultTimeout={system.data?.default_upstream_timeout_seconds} />
          <SecuritySettings onUnauthorized={onUnauthorized} />
          <SystemInfoCard system={system.data} loading={system.loading} refreshing={system.pending}
            error={system.error} onRefresh={system.reload} />
        </div>
      </section>
    </section>
  );
}
