import { formatTimestamp } from "../../logFormat";
import { CARD_FIELDS } from "../../settingsDraft";
import type { NumericSetting, SettingsCard } from "../../settingsDraft";
import type { RuntimeSettingsEditor } from "../../useRuntimeSettings";
import type { RuntimeSettings } from "../../types";
import { NumberField } from "./NumberField";
import { RoutingGuide } from "./RoutingGuide";

interface NumberSpec {
  label: string;
  min: number;
  max: number;
  step?: number;
  hint?: string;
  className?: string;
}

const FIELDS: Record<NumericSetting, NumberSpec> = {
  log_body_keep_count: { label: "正文保留数量", min: 1, max: 100000, hint: "保留完整正文的最近日志条数，更早的只留元数据和请求头。" },
  log_retention_days: { label: "日志保留天数", min: 1, max: 3650, hint: "超过期限的日志会在下一轮清理时移除。" },
  log_body_max_bytes: { label: "原始正文采集上限（字节）", min: 0, max: 134217728, className: "span-2", hint: "最大 128 MiB。设为 0 时只保留元数据和请求头，不采集正文。" },
  image_storage_max_mb: {
    label: "生图图片存储上限（GB）", min: 0, max: 1024, step: 0.01, className: "span-2",
    hint: "生图结果另存为文件，日志里只留链接，链接可直接下载。超出上限时从最旧的图删起，约每五分钟检查一次。设为 0 不再保存，并清空已存的图。",
  },
  max_retries: { label: "最大重试次数", min: 0, max: 5, hint: "额外尝试次数；0 表示不重试。" },
  same_upstream_retry_interval_ms: { label: "同渠道重试间隔（毫秒）", min: 0, max: 60000, hint: "换到不同渠道时不会等待。" },
  auto_weight_failure_penalty: { label: "失败降幅", min: 0, max: 100, hint: "每次渠道失败都会降低动态有效权重。" },
  auto_weight_success_increment: { label: "成功恢复幅度", min: 0, max: 100, hint: "每次正常完成后提高动态有效权重，最高不超过基础权重。" },
  auto_weight_recovery_increment: { label: "定时恢复幅度", min: 0, max: 100, hint: "有效权重为 0 后，每经过一个完整周期恢复一次。" },
  auto_weight_recovery_interval_seconds: { label: "恢复周期（秒）", min: 1, max: 3600, hint: "有效权重变化后重新开始计时。" },
  default_upstream_timeout_seconds: { label: "默认上游超时（秒）", min: 0, max: 3600 },
  dashboard_multiplier: { label: "显示倍率", min: 0.01, max: 1000, step: 0.01, hint: "1 表示按实际显示。可填小数，如 1.5；结果取整。" },
};

const CARDS: Record<SettingsCard, { title: string; description: string; save: string }> = {
  log: { title: "日志与存储", description: "这些策略由服务端保存，保存后用于新的快照；正文清理通常在一分钟内生效，过期日志按小时删除。", save: "保存日志策略" },
  routing: { title: "路由、有效权重与重试", description: "这些参数由服务端保存，并用于保存后的新请求。", save: "保存路由策略" },
  proxy: { title: "出站代理", description: "启用后网关向上游发起的请求（转发、渠道探测、模型测试）都会经过该代理；保存后对新建立的连接立即生效。", save: "保存代理设置" },
  timeout: { title: "网关默认值", description: "渠道没有自己的超时时用这个值；新建渠道也以它为初始值。", save: "保存默认超时" },
  dashboard: { title: "看板显示", description: "看板上的请求数和 Tokens 数乘上这个倍率再显示。日志、令牌用量和配额不受影响。", save: "保存显示倍率" },
};

export function RuntimeSettingsCards({ cards, editor, defaultTimeout }: {
  cards: readonly SettingsCard[];
  editor: RuntimeSettingsEditor;
  defaultTimeout?: number;
}) {
  const settings = editor.settings;
  if (!settings) return null;
  return <>{cards.map((card) => {
    const spec = CARDS[card];
    const numeric = CARD_FIELDS[card].filter((key): key is NumericSetting => key in FIELDS);
    return (
      <section key={card} className="settings-card" data-settings-card={card}>
        <div className="settings-card-head">
          <div><h3>{spec.title}</h3><p>{spec.description}</p></div>
          {card === "log" ? <span className="settings-revision">修订 {settings.revision}</span>
            : <span className="settings-readonly-tag">全局</span>}
        </div>
        {card === "routing" ? <RoutingGuide /> : null}
        <form className="settings-server-form" onSubmit={(event) => {
          event.preventDefault();
          void editor.save(card);
        }}>
          <div className={`settings-fields-grid${card === "routing" ? " routing-settings-grid" : ""}`}>
            {card === "routing" ? <label className="field span-2"><span className="field-label">负载均衡策略</span><select aria-label="负载均衡策略" value={settings.load_balance_strategy} onChange={(event) => editor.patch("load_balance_strategy", event.target.value as RuntimeSettings["load_balance_strategy"])}><option value="weighted">有效权重随机</option><option value="least_latency">最低延迟优先</option></select><span className="field-hint">仅在同优先级内比较；样本不足时回退到有效权重。</span></label> : null}
            {numeric.map((key) => {
              const field = FIELDS[key];
              const hint = key === "default_upstream_timeout_seconds"
                ? `0 表示沿用启动配置（当前 ${defaultTimeout === undefined ? "读取中" : `${defaultTimeout} 秒`}）。保存后立即生效，不用重启。`
                : field.hint;
              return <NumberField key={key} name={key} {...field} hint={hint}
                value={key === "image_storage_max_mb" ? Math.round(settings[key] / 1024 * 100) / 100 : settings[key]}
                onChange={(value) => editor.patch(key, key === "image_storage_max_mb" ? Math.round(value * 1024) : value)}
              />;
            })}
            {card === "proxy" ? (
              <>
                <div className="toggle-list span-2">
                  <label className="toggle-row">
                    <input type="checkbox" checked={settings.proxy_enabled} onChange={(event) => editor.patch("proxy_enabled", event.target.checked)} />
                    <span><strong>启用出站代理</strong><small>关闭时不走此处配置的代理（仍遵循系统 HTTP_PROXY/HTTPS_PROXY 环境变量）。</small></span>
                  </label>
                </div>
                <label className="field span-2">
                  <span className="field-label">代理地址</span>
                  <input type="text" name="proxy_url" value={settings.proxy_url} required={settings.proxy_enabled}
                    onChange={(event) => editor.patch("proxy_url", event.target.value)}
                    placeholder="http://127.0.0.1:7890" spellCheck={false} autoComplete="off" />
                  <span className="field-hint">支持 http://、https://、socks5:// 与 socks5h://，可带账号密码。启用时必填。</span>
                </label>
              </>
            ) : null}
          </div>
          <div className="settings-save-row">
            <p className="settings-inline-status" role="status">{card === "log" ? `上次更新 ${formatTimestamp(settings.updated_at)}` : ""}</p>
            <button type="submit" className="primary" disabled={editor.savingCard !== null}>
              {editor.savingCard === card ? "保存中…" : spec.save}
            </button>
          </div>
        </form>
      </section>
    );
  })}</>;
}
