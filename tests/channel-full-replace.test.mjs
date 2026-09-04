// 渠道的 PUT/POST 都是整体替换：payload 里漏掉的字段会被后端按默认值写回，
// 也就是被清空。这里锁住那些「只改一部分、其余必须原样回填」的调用点。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  const asyncPrefix = "async ";
  const declarationStart = source.startsWith(asyncPrefix, start - asyncPrefix.length)
    ? start - asyncPrefix.length
    : start;
  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(declarationStart, index + 1);
      }
    }
  }

  throw new Error(`could not extract ${name}`);
}

// 一个各项都配置过的渠道，任何一项被 payload 漏掉都能在断言里看出来。
const configuredChannel = {
  id: 7,
  name: "full",
  base_url: "https://api.example.test/v1",
  model_names: ["a"],
  model_prefixes: ["gpt-"],
  model_mappings: { alias: "a" },
  effort_mappings: { max: "xhigh" },
  priority: 120,
  weight: 80,
  auto_weight_enabled: false,
  timeout_seconds: 120,
  enabled: true,
  extra_headers: { "x-tenant": "acme" },
  rate_limit: "100/m",
  group_ids: [2],
};

async function captureModelSavePayload(upstream) {
  const requests = [];
  const context = vm.createContext({
    modelDialogState: {
      upstream,
      mode: "upstream",
      models: ["a", "b"],
      selected: new Set(["a", "b"]),
      mappings: { alias: "a" },
      selectedMappings: new Set(["alias"]),
    },
    api: async (path, options) => {
      requests.push({ path, ...options, body: JSON.parse(options.body) });
      return {};
    },
    fields: { id: { value: "" }, modelMappings: { value: "" } },
    modelSaveSelectionButton: { textContent: "保存", disabled: false },
    joinModelMappings: () => "",
    setFormModels: () => {},
    closeModelDialog: () => {},
    loadUpstreams: async () => {},
    setStatus: () => {},
  });
  vm.runInContext(extractFunction(read("static/js/models.js"), "saveModelSelection"), context);
  await vm.runInContext("saveModelSelection()", context);

  assert.equal(requests.length, 1, "模型保存应当发出一次整体替换请求");
  assert.equal(requests[0].method, "PUT");
  return requests[0].body;
}

test("保存模型只改模型，其余渠道配置原样回填", async () => {
  const payload = await captureModelSavePayload(configuredChannel);

  // 这次操作要改的东西。
  assert.deepEqual([...payload.model_names], ["a", "b"]);

  // 这些是这次操作不该碰的，漏掉任何一项都会被后端清空。
  assert.equal(payload.rate_limit, "100/m", "限速被清空了");
  assert.deepEqual([...payload.group_ids], [2], "分组被重置为默认组了");
  assert.deepEqual({ ...payload.effort_mappings }, { max: "xhigh" }, "思考强度映射被清空了");
  assert.equal(payload.priority, 120);
  assert.equal(payload.weight, 80);
  assert.equal(payload.auto_weight_enabled, false);
  assert.equal(payload.timeout_seconds, 120);
  assert.deepEqual({ ...payload.extra_headers }, { "x-tenant": "acme" });
  assert.deepEqual([...payload.model_prefixes], ["gpt-"]);

  // api_key 不在弹窗里，靠 clear_api_key=false 让后端保留already存的那把。
  assert.equal(payload.clear_api_key, false);
  assert.equal(payload.api_key, null);
});

test("未配置这些项的渠道也要发出后端能接受的值", async () => {
  const bare = { id: 8, name: "bare", base_url: "https://a.test", model_names: [] };
  const payload = await captureModelSavePayload(bare);

  assert.equal(payload.rate_limit, null, "缺失的限速要发 null，不是 undefined");
  assert.deepEqual([...payload.group_ids], []);
  assert.deepEqual({ ...payload.effort_mappings }, {});
  assert.deepEqual({ ...payload.extra_headers }, {});
});

// 删除后的「撤销」是重建，漏掉的字段就是恢复后悄悄少掉的配置。
test("删除撤销的重建 payload 覆盖整张渠道配置", () => {
  const source = read("static/js/models.js");
  const start = source.indexOf("recreatePayload = {");
  assert.notEqual(start, -1, "recreatePayload must exist");
  const block = source.slice(start, source.indexOf("};", start));

  for (const field of [
    "name", "base_url", "api_key", "model_names", "model_prefixes", "model_mappings",
    "effort_mappings", "priority", "weight", "auto_weight_enabled", "timeout_seconds",
    "enabled", "extra_headers", "rate_limit", "group_ids",
  ]) {
    assert.match(block, new RegExp(`\\b${field}:`), `撤销重建漏了 ${field}`);
  }
});
