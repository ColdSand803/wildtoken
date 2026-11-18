import { useEffect, useState } from "react";

import { readStored, writeStored } from "../../storage";
import {
  APPEARANCE_EVENT, BUILTIN_THEMES, THEME_LABELS, THEME_PACKS,
  applyDensity, applyTheme, currentDensity, currentTheme,
} from "../../theme";

const DEFAULT_HOME_KEY = "wildtoken_default_home";
const HOMES = [
  ["dashboard", "看板"], ["upstreams", "渠道"], ["logs", "日志"], ["tokens", "令牌"],
  ["groups", "分组"], ["debug", "调试"], ["images", "生图"], ["settings", "设置"],
];

export function PreferencesCard() {
  const [theme, setTheme] = useState(currentTheme);
  const [density, setDensity] = useState(currentDensity);
  const [home, setHome] = useState(() => readStored(DEFAULT_HOME_KEY) ?? "dashboard");

  useEffect(() => {
    const sync = () => { setTheme(currentTheme()); setDensity(currentDensity()); };
    window.addEventListener(APPEARANCE_EVENT, sync);
    return () => window.removeEventListener(APPEARANCE_EVENT, sync);
  }, []);

  return (
    <section className="settings-card">
      <div className="settings-card-head">
        <div><h3>控制台偏好</h3><p>仅保存在当前浏览器，并立即生效。</p></div>
        <span className="settings-local-tag">本地</span>
      </div>
      <div className="settings-preferences-grid">
        <fieldset className="settings-choice-group settings-theme-choice-group">
          <legend>主题</legend>
          <select aria-label="主题" value={theme} onChange={(event) => applyTheme(event.target.value)}>
            {[...BUILTIN_THEMES, ...Object.keys(THEME_PACKS)].map((id) => (
              <option key={id} value={id}>{THEME_LABELS[id] ?? id}</option>
            ))}
          </select>
          <span className="field-hint">主题与旧控制台共用同一份设置。</span>
        </fieldset>
        <label className="field">
          <span className="field-label">默认首页</span>
          <select aria-label="默认首页" value={home} onChange={(event) => {
            setHome(event.target.value);
            writeStored(DEFAULT_HOME_KEY, event.target.value);
          }}>
            {HOMES.map(([id, label]) => <option key={id} value={id}>{label}</option>)}
          </select>
          <span className="field-hint">地址栏带着页面锚点时，仍优先进那一页。</span>
        </label>
        <fieldset className="settings-choice-group">
          <legend>显示密度</legend>
          <div className="segmented-control" aria-label="显示密度">
            <button type="button" data-density-choice="comfortable" aria-pressed={density === "comfortable"} onClick={() => applyDensity("comfortable")}>
              舒适
            </button>
            <button type="button" data-density-choice="compact" aria-pressed={density === "compact"} onClick={() => applyDensity("compact")}>
              紧凑
            </button>
          </div>
        </fieldset>
      </div>
    </section>
  );
}
