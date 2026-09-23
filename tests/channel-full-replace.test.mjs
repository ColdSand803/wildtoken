/* 渠道更新是整体替换：后端按 PUT 全量覆盖，请求体里漏掉的字段会被清空。
   所以任何只想改一两项的操作，都必须把其余配置原样回填。 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const source = read("web/src/pages/UpstreamsPage.tsx");

/** UpstreamIn 要求的全部字段。 */
const REQUIRED_FIELDS = [
  "name",
  "base_url",
  "api_key",
  "model_names",
  "model_prefixes",
  "model_mappings",
  "effort_mappings",
  "priority",
  "weight",
  "auto_weight_enabled",
  "timeout_seconds",
  "enabled",
  "extra_headers",
  "rate_limit",
  "group_ids",
];

test("保存模型只改模型，其余渠道配置原样回填", () => {
  const start = source.indexOf("async function saveModelSelection");
  assert.notEqual(start, -1, "saveModelSelection must exist");
  const body = source.slice(start, source.indexOf("setPicker(null)", start));

  // 这次操作要改的东西。
  assert.match(body, /model_names: next\.names/);
  assert.match(body, /model_mappings: next\.mappings/);

  // 其余都必须从 target 回填；漏掉任何一项都会被后端清空。
  for (const field of REQUIRED_FIELDS) {
    assert.match(body, new RegExp(`\\b${field}:`), `模型保存漏了 ${field}`);
  }

  // api_key 不在弹窗里，靠 clear_api_key=false 让后端保留已经存的那把。
  assert.match(body, /api_key: null/);
  assert.match(body, /clear_api_key: false/);
});

/* 缺失的可选项要发 null / 空集合，而不是 undefined——JSON.stringify 会把
   undefined 整个键丢掉，后端严格解码时就成了「没提供这个必填字段」。 */
test("未配置这些项的渠道也要发出后端能接受的值", () => {
  const start = source.indexOf("async function saveModelSelection");
  const body = source.slice(start, source.indexOf("setPicker(null)", start));

  assert.match(body, /rate_limit: target\.rate_limit \?\? null/);
  assert.match(body, /group_ids: target\.group_ids \?\? \[\]/);
  assert.match(body, /effort_mappings: target\.effort_mappings \|\| \{\}/);
  assert.match(body, /extra_headers: target\.extra_headers \|\| \{\}/);
});

/* 删除后的「撤销」是重建，漏掉的字段就是恢复后悄悄少掉的配置。整份快照
   解构比逐字段列举更难漏：新增字段自动跟着走。 */
test("删除撤销的重建 payload 覆盖整张渠道配置", () => {
  const start = source.indexOf("const snapshot = await getUpstream");
  assert.notEqual(start, -1, "删除前必须先取快照");
  const block = source.slice(start, source.indexOf("} catch (err)", start));

  assert.match(
    block,
    /const \{ id: _id, api_key_set: _set, \.\.\.rest \} = snapshot/,
    "撤销应整份解构快照，而不是逐字段挑",
  );
  assert.match(block, /createUpstream\(rest\)/);
  // API Key 回不来，文案要说清楚，别让人以为恢复得一模一样。
  assert.match(block, /API Key \u9700\u91cd\u65b0\u586b\u5199/);
});
