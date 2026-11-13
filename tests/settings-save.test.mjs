import assert from "node:assert/strict";
import test from "node:test";
import { acceptSavedCard, CARD_FIELDS, rebaseSettings, settingsForCard } from "../web/src/settingsDraft.ts";

const base = {
  log_body_keep_count: 100, log_retention_days: 30, log_body_max_bytes: 204800,
  max_retries: 2, same_upstream_retry_interval_ms: 100, load_balance_strategy: "weighted", auto_weight_failure_penalty: 10,
  auto_weight_success_increment: 1, auto_weight_recovery_increment: 5,
  auto_weight_recovery_interval_seconds: 60, proxy_enabled: false, proxy_url: "",
  default_upstream_timeout_seconds: 300, image_storage_max_mb: 1024,
  dashboard_multiplier: 1, revision: 3, updated_at: "before",
};

test("每个可编辑字段恰好属于一张卡", () => {
  const fields = Object.values(CARD_FIELDS).flat();
  assert.equal(new Set(fields).size, fields.length);
  assert.deepEqual([...fields].sort(), Object.keys(base).filter((key) => !["revision", "updated_at"].includes(key)).sort());
});

for (const [card, fields] of Object.entries(CARD_FIELDS)) {
  test(`${card} 只提交自己的字段，revision 取服务端版本`, () => {
    const draft = Object.fromEntries(Object.entries(base).map(([key, value]) => [key,
      typeof value === "number" ? value + 1 : typeof value === "boolean" ? !value : `${value}-draft`,
    ]));
    const payload = settingsForCard(base, draft, card);
    for (const key of Object.keys(base)) assert.equal(payload[key], fields.includes(key) ? draft[key] : base[key]);
    assert.equal(base.revision, 3);
  });
}

test("保存结果保留其他卡片和保存期间新增的改动", () => {
  const submitted = { ...base, log_body_keep_count: 200 };
  const current = { ...submitted, log_body_keep_count: 300, proxy_url: "http://local-proxy" };
  const saved = { ...submitted, log_retention_days: 31, revision: 4, updated_at: "after" };
  const draft = acceptSavedCard(current, submitted, saved, "log");
  assert.equal(draft.log_body_keep_count, 300);
  assert.equal(draft.log_retention_days, 31);
  assert.equal(draft.proxy_url, "http://local-proxy");
  assert.equal(draft.revision, 4);
  assert.equal(draft.updated_at, "after");
});

test("版本冲突合并最新基线，不丢本地草稿", () => {
  const draft = { ...base, log_body_keep_count: 300, proxy_url: "http://local-proxy" };
  const latest = { ...base, max_retries: 4, log_body_keep_count: 200, revision: 10, updated_at: "remote" };
  const merged = rebaseSettings(base, draft, latest);
  assert.equal(merged.log_body_keep_count, 300);
  assert.equal(merged.proxy_url, "http://local-proxy");
  assert.equal(merged.max_retries, 4);
  assert.equal(merged.revision, 10);
  const retry = settingsForCard(latest, merged, "log");
  assert.equal(retry.revision, 10);
  assert.equal(retry.max_retries, 4);
  assert.equal(retry.proxy_url, "");
});
