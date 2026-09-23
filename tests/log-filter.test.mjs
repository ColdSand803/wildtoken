// 流推来的日志没经过服务端查询，前端要按同一套筛选再判一次。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { logMatchesFilters } from "../web/src/logFilter.ts";

const none = { upstreamId: "", clientType: "", status: "", search: "" };
const only = (patch) => ({ ...none, ...patch });

const log = (patch = {}) => ({
  id: 101,
  upstream_id: 7,
  client_type: "claude-code",
  model: "claude-opus-5",
  request_model: "claude-opus-5",
  upstream_model: "claude-opus-5",
  upstream_name: "AA",
  downstream_token_name: "ci",
  status_code: 200,
  error: null,
  ...patch,
});

test("不筛时全部放行", () => {
  assert.equal(logMatchesFilters(log(), none), true);
});

test("状态档：200 不进 5xx，null 只进「无响应」", () => {
  assert.equal(logMatchesFilters(log(), only({ status: "5xx" })), false);
  assert.equal(logMatchesFilters(log({ status_code: 502 }), only({ status: "5xx" })), true);
  assert.equal(logMatchesFilters(log({ status_code: 299 }), only({ status: "2xx" })), true);
  assert.equal(logMatchesFilters(log({ status_code: 300 }), only({ status: "2xx" })), false);
  assert.equal(logMatchesFilters(log({ status_code: null }), only({ status: "none" })), true);
  assert.equal(logMatchesFilters(log(), only({ status: "none" })), false);
});

test("渠道和客户端精确匹配", () => {
  assert.equal(logMatchesFilters(log(), only({ upstreamId: "7" })), true);
  assert.equal(logMatchesFilters(log(), only({ upstreamId: "8" })), false);
  assert.equal(logMatchesFilters(log({ upstream_id: null }), only({ upstreamId: "7" })), false);
  assert.equal(logMatchesFilters(log(), only({ clientType: "codex" })), false);
});

test("搜索大小写不敏感，覆盖服务端的八个字段", () => {
  assert.equal(logMatchesFilters(log(), only({ search: "  OPUS " })), true);
  assert.equal(logMatchesFilters(log(), only({ search: "gpt" })), false);
  assert.equal(logMatchesFilters(log({ error: "upstream timeout" }), only({ search: "timeout" })), true);
  assert.equal(logMatchesFilters(log(), only({ search: "101" })), true);
  assert.equal(logMatchesFilters(log({ status_code: 429 }), only({ search: "429" })), true);
});

// 页面侧：流推来的行必须过筛选，在途请求不筛。
test("日志页对流套了筛选，在途原样显示", () => {
  const page = readFileSync(new URL("../web/src/pages/LogsPage.tsx", import.meta.url), "utf8");

  assert.match(page, /stream\.logs\.filter\(\(log\) => logMatchesFilters\(log, filters\)\)/);
  assert.match(page, /const active = onLatestPage \? activeLatest : \[\];/);
});
