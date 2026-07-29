import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(start, index + 1);
      }
    }
  }

  throw new Error(`could not extract ${name}`);
}

test("upstream action menu distinguishes channel clone and credential copy actions", () => {
  const source = read("static/js/upstreams.js");

  assert.match(source, /data-action="duplicate" data-id="\$\{upstreamId\}">复制渠道<\/button>/);
  assert.match(source, /data-action="copy-info" data-id="\$\{upstreamId\}">复制渠道信息<\/button>/);
  assert.doesNotMatch(source, /data-action="duplicate" data-id="\$\{upstreamId\}">复制<\/button>/);
});

test("upstream credential clipboard text keeps the requested two-line shape", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, "formatUpstreamClipboardText"), context);

  const text = vm.runInContext(
    'formatUpstreamClipboardText({ base_url: "https://api.example.com/v1", api_key: "sk-test" })',
    context,
  );

  assert.equal(text, "baseURL: https://api.example.com/v1\napiKey: sk-test");
});

test("fixed weight checkbox maps to the existing dynamic-weight API field", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({
    fields: {
      name: { value: "fixed" },
      baseUrl: { value: "https://api.example.test/v1" },
      apiKey: { value: "" },
      modelMappings: { value: "{}" },
      modelPrefixes: { value: "" },
      priority: { value: "100" },
      weight: { value: "25" },
      fixedWeightEnabled: { checked: true },
      timeoutSeconds: { value: "300" },
      enabled: { checked: true },
      clearApiKey: { checked: false },
    },
    parseHeaderOverrides: () => ({}),
    parseModelMappings: () => ({}),
    getFormModels: () => [],
    splitList: () => [],
  });
  vm.runInContext(extractFunction(source, "payloadFromForm"), context);

  assert.equal(vm.runInContext("payloadFromForm().auto_weight_enabled", context), false);
  context.fields.fixedWeightEnabled.checked = false;
  assert.equal(vm.runInContext("payloadFromForm().auto_weight_enabled", context), true);
});

test("upstream weight cell uses fixed and effective weight wording", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, "formatEffectiveWeight"), context);
  vm.runInContext(extractFunction(source, "isFixedWeight"), context);
  vm.runInContext(extractFunction(source, "weightCellMarkup"), context);

  const fixedMarkup = vm.runInContext(
    "weightCellMarkup({ weight: 80, effective_weight: 12, auto_weight_enabled: false })",
    context,
  );
  assert.match(fixedMarkup, /<strong>80<\/strong>/);
  assert.match(fixedMarkup, /固定权重/);
  assert.doesNotMatch(fixedMarkup, /有效权重 \/ 基础权重/);

  const dynamicMarkup = vm.runInContext(
    "weightCellMarkup({ weight: 80, effective_weight: 0, auto_weight_enabled: true })",
    context,
  );
  assert.match(dynamicMarkup, /<strong>0 \/ 80<\/strong>/);
  assert.match(dynamicMarkup, /有效权重 \/ 基础权重/);
});
