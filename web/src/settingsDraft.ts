import type { RuntimeSettings } from "./types";

export const CARD_FIELDS = {
  log: ["log_body_keep_count", "log_retention_days", "log_body_max_bytes", "image_storage_max_mb"],
  routing: [
    "max_retries", "same_upstream_retry_interval_ms", "load_balance_strategy",
    "auto_weight_failure_penalty", "auto_weight_success_increment",
    "auto_weight_recovery_increment", "auto_weight_recovery_interval_seconds",
  ],
  proxy: ["proxy_enabled", "proxy_url"],
  timeout: ["default_upstream_timeout_seconds"],
  dashboard: ["dashboard_multiplier"],
} as const satisfies Record<string, readonly (keyof RuntimeSettings)[]>;

export type SettingsCard = keyof typeof CARD_FIELDS;
export type SettingsField = (typeof CARD_FIELDS)[SettingsCard][number];
export type NumericSetting = Exclude<SettingsField, "proxy_enabled" | "proxy_url" | "load_balance_strategy">;

function withFields<K extends keyof RuntimeSettings>(
  base: RuntimeSettings, source: RuntimeSettings, keys: readonly K[],
): RuntimeSettings {
  const next = { ...base };
  for (const key of keys) next[key] = source[key];
  return next;
}

/** 只提交本卡草稿，其余字段及 revision 取已保存版本。 */
export function settingsForCard(base: RuntimeSettings, draft: RuntimeSettings, card: SettingsCard): RuntimeSettings {
  return withFields(base, draft, CARD_FIELDS[card]);
}

/** 保存过程中又改过的字段保留，不被服务器回包覆盖。 */
export function acceptSavedCard(
  current: RuntimeSettings, submitted: RuntimeSettings, saved: RuntimeSettings, card: SettingsCard,
): RuntimeSettings {
  const unchanged = CARD_FIELDS[card].filter((key) => Object.is(current[key], submitted[key]));
  return {
    ...withFields(current, saved, unchanged),
    revision: saved.revision,
    updated_at: saved.updated_at,
  };
}

/** 冲突后采用最新版本，保留尚未提交的本地字段。 */
export function rebaseSettings(base: RuntimeSettings, draft: RuntimeSettings, latest: RuntimeSettings): RuntimeSettings {
  const dirty = Object.values(CARD_FIELDS).flat().filter((key) => !Object.is(base[key], draft[key]));
  return withFields(latest, draft, dirty);
}
