// 流推来的日志没经过服务端查询，前端要按同一套筛选再判一次。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { activeMatchesFilters, logMatchesFilters } from "../web/src/logFilter.ts";

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

const active = (patch = {}) => ({
  id: 9001,
  started_at: "2026-11-05T12:00:00Z",
  elapsed_ms: 1200,
  method: "POST",
  path: "/v1/messages",
  upstream_id: 7,
  upstream_name: "AA",
  upstream_key_id: 2,
  upstream_key_name: "primary",
  downstream_token_id: 3,
  downstream_token_name: "ci",
  client_ip: "127.0.0.1",
  client_type: "claude-code",
  model: "claude-opus-5",
  request_model: "claude-opus-5",
  upstream_model: "claude-opus-5",
  reasoning_effort: null,
  upstream_reasoning_effort: null,
  attempt: 1,
  ...patch,
});

test("在途请求不筛时放行，渠道和客户端精确匹配", () => {
  assert.equal(activeMatchesFilters(active(), none), true);
  assert.equal(activeMatchesFilters(active(), only({ upstreamId: "7" })), true);
  assert.equal(activeMatchesFilters(active(), only({ upstreamId: "8" })), false);
  assert.equal(activeMatchesFilters(active(), only({ clientType: "claude-code" })), true);
  assert.equal(activeMatchesFilters(active(), only({ clientType: "codex" })), false);
  assert.equal(activeMatchesFilters(active({ upstream_id: null }), none), true);
  assert.equal(activeMatchesFilters(active({ upstream_id: null }), only({ upstreamId: "7" })), false);
});

test("在途搜索覆盖模型、渠道和令牌，不借用登记 ID 或虚构状态码", () => {
  const fields = ["model", "request_model", "upstream_model", "upstream_name", "downstream_token_name"];
  const empty = Object.fromEntries(fields.map((field) => [field, null]));
  for (const field of fields) {
    assert.equal(
      activeMatchesFilters(active({ ...empty, [field]: "Filter-Target" }), only({ search: "  TARGET " })),
      true,
      field,
    );
  }
  for (const search of ["gpt", "9001", "200", "timeout"]) {
    assert.equal(activeMatchesFilters(active(), only({ search })), false, search);
  }
  assert.equal(activeMatchesFilters(active(empty), only({ search: "target" })), false);
});

test("在途没有最终状态码，只匹配全部状态和无响应", () => {
  for (const status of ["", "none"]) {
    assert.equal(activeMatchesFilters(active(), only({ status })), true, status);
  }
  for (const status of ["2xx", "4xx", "5xx"]) {
    assert.equal(activeMatchesFilters(active(), only({ status })), false, status);
  }
});

test("在途组合筛选取交集", () => {
  const filters = { upstreamId: "7", clientType: "claude-code", status: "none", search: "opus" };
  assert.equal(activeMatchesFilters(active(), filters), true);
  for (const patch of [
    { upstreamId: "8" },
    { clientType: "codex" },
    { status: "2xx" },
    { search: "gpt" },
  ]) {
    assert.equal(activeMatchesFilters(active(), { ...filters, ...patch }), false);
  }
});

test("重试换渠道和上游模型后按新快照筛", () => {
  const before = active();
  const after = active({ upstream_id: 8, upstream_name: "BB", upstream_model: "gpt-4o", attempt: 2 });
  const filters = only({ upstreamId: "7" });
  assert.equal(activeMatchesFilters(before, filters), true);
  assert.equal(activeMatchesFilters(after, filters), false);
  assert.equal(activeMatchesFilters(after, only({ upstreamId: "8", search: "gpt-4o" })), true);
});

test("日志页对新日志、SSE 在途和断线快照套同一组筛选", () => {
  const page = readFileSync(new URL("../web/src/useLogQuery.ts", import.meta.url), "utf8");
  const merge = readFileSync(new URL("../web/src/logQuery.ts", import.meta.url), "utf8");

  assert.match(merge, /streamed\.filter\(\(log\) => logMatchesFilters\(log, filters\)\)/);
  assert.match(page, /const activeLatest = stream\.connected \? stream\.active : activeFromPage;/);
  assert.match(page, /const active = onLatestPage\s*\? activeLatest\.filter\(\(request\) => activeMatchesFilters\(request, filters\)\)\s*: \[\];/);
  assert.match(readFileSync(new URL("../web/src/pages/LogsPage.tsx", import.meta.url), "utf8"), /active=\{query\.active\}/);
});

test("切筛选不重置在途计时基准", () => {
  const table = readFileSync(new URL("../web/src/components/logs/LogTable.tsx", import.meta.url), "utf8");
  assert.match(table, /<ActiveRows active=\{active\} snapshot=\{activeLatest\}/);
  assert.match(table, /const signature = snapshot\.map\(/);
});
