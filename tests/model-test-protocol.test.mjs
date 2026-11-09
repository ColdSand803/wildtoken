import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

const dialog = readFileSync(new URL("../web/src/components/ModelTestDialog.tsx", import.meta.url), "utf8");

function sourceFunction(name, indent = "") {
  const match = dialog.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?\\n${indent}}\\n`));
  assert.ok(match, `${name} must exist`);
  return match[0];
}

function run(source, bindings = {}) {
  const compiled = stripTypeScriptTypes(`function execute() {\n${source}\n}`);
  return new Function(...Object.keys(bindings), `${compiled}\nreturn execute();`)(...Object.values(bindings));
}

const helpers = run(
  ["modelSelection", "configuredModels", "sorted"].map((name) => sourceFunction(name)).join("\n") +
  "\nreturn { modelSelection, configuredModels, sorted };",
);
const { modelSelection } = helpers;

function selectionState(initial) {
  let value = initial;
  return {
    get value() { return value; },
    setSelection(next) { value = typeof next === "function" ? next(value) : next; },
  };
}

const cases = [
  ["gpt-5", "responses"],
  ["openai/GPT-4o", "responses"],
  ["custom-gPt-5-mini", "responses"],
  ["claude-sonnet-4-5", "messages"],
  ["anthropic/CLAUDE-opus-4.1", "messages"],
  ["custom-Claude-opus[1M]", "messages"],
  ["deepseek-chat", "chat_completions"],
  ["gemini-2.5-pro", "chat_completions"],
  ["qwen3", "chat_completions"],
  ["o3", "chat_completions"],
  ["", "chat_completions"],
];

for (const [model, protocol] of cases) {
  test(`模型名 ${model || "（空）"} 默认使用 ${protocol}，原名不变`, () => {
    assert.deepEqual(modelSelection(model), { model, protocol });
  });
}

test("同时包含 gpt 和 claude 时优先 Responses", () => {
  assert.deepEqual(modelSelection("CLAUDE-GPT"), { model: "CLAUDE-GPT", protocol: "responses" });
});

test("每次打开弹窗都按初始模型重置协议，包括同一模型再次打开", () => {
  const initialize = dialog.match(
    /    const available = sorted\(configuredModels\(upstream\)\);[\s\S]*?(?=\n    let cancelled = false;)/,
  );
  assert.ok(initialize);
  for (const [model, protocol] of cases) {
    const state = selectionState({ model, protocol: "manual" });
    run(initialize[0], {
      ...helpers,
      upstream: { model_names: model ? [model] : [] },
      setSelection: state.setSelection,
      setModels() {},
      setResult() {},
      setSending() {},
      setRefreshing() {},
      setKeys() {},
      setKeyId() {},
    });
    assert.deepEqual(state.value, { model, protocol });
  }
});

test("切换模型同步选择默认协议，仍可手动覆盖", () => {
  const modelChange = dialog.match(/<select value=\{model\} onChange=\{(.+)\} required>/);
  const protocolChange = dialog.match(/value=\{protocol\}\s+onChange=\{([\s\S]*?)\}\s+required/);
  assert.ok(modelChange);
  assert.ok(protocolChange);
  const state = selectionState(modelSelection(""));
  const bindings = { modelSelection, setSelection: state.setSelection };
  const chooseModel = run(`return (${modelChange[1]});`, bindings);
  const chooseProtocol = run(`return (${protocolChange[1]});`, bindings);

  for (const [model, protocol] of cases) {
    chooseModel({ target: { value: model } });
    assert.deepEqual(state.value, { model, protocol });
    const manual = protocol === "responses" ? "chat_completions" : "responses";
    chooseProtocol({ target: { value: manual } });
    assert.deepEqual(state.value, { model, protocol: manual });
  }
  assert.match(dialog, /testUpstreamModel\(upstream\.id, \{\s*model,\s*protocol,/);
});

function refresher(state, fetchUpstreamModels) {
  return run(sourceFunction("refreshModels", "  ") + "\nreturn refreshModels;", {
    ...helpers,
    upstream: { id: 7 },
    session: { current: 1 },
    fetchUpstreamModels,
    setSelection: state.setSelection,
    setRefreshing() {},
    setModels() {},
    UnauthorizedError: class extends Error {},
    toast(message) { assert.fail(message); },
  });
}

test("刷新后当前模型不存在，替换模型与默认协议一起更新", async () => {
  for (const [model, protocol] of cases) {
    const state = selectionState({ model: "removed-model", protocol: "messages" });
    await refresher(state, async () => ({ models: model ? [model] : [] }))();
    assert.deepEqual(state.value, { model, protocol });
  }
});

test("刷新后当前模型仍存在，保留手动选择的协议", async () => {
  const initial = { model: "gpt-5", protocol: "chat_completions" };
  const state = selectionState(initial);
  await refresher(state, async () => ({ models: ["claude-sonnet-4-5", "gpt-5"] }))();
  assert.strictEqual(state.value, initial);
});

test("刷新期间切换模型和协议，返回列表后保留最新选择", async () => {
  let resolve;
  const fetched = new Promise((done) => { resolve = done; });
  const state = selectionState(modelSelection("gpt-5"));
  const pending = refresher(state, () => fetched)();
  const latest = { model: "claude-sonnet-4-5", protocol: "chat_completions" };
  state.setSelection(latest);
  resolve({ models: ["gpt-5", "claude-sonnet-4-5"] });
  await pending;
  assert.strictEqual(state.value, latest);
});
