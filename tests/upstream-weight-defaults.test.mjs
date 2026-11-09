import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

import { keyRowsFrom, keysPayload } from "../web/src/keyRows.ts";
import { joinMappingLines, parseMappingLines } from "../web/src/mappingLines.ts";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const dialog = read("web/src/components/UpstreamDialog.tsx");
const page = read("web/src/pages/UpstreamsPage.tsx");

function sourceFunction(source, name, indent = "") {
  const match = source.match(new RegExp(`function ${name}\\([\\s\\S]*?\\n${indent}}\\n`));
  assert.ok(match, `${name} must exist`);
  return match[0];
}

const helpers = dialog.slice(dialog.indexOf("function requiredNumber("), dialog.indexOf("interface FormState {"));
const functions = ["emptyForm", "formFromUpstream", "payloadFromForm"]
  .map((name) => sourceFunction(dialog, name)).join("\n");
const group = dialog.match(/const DEFAULT_GROUP_ID = \d+;/)[0];
const form = new Function("keyRowsFrom", "keysPayload", "joinMappingLines", "parseMappingLines",
  stripTypeScriptTypes(`${group}\n${helpers}\n${functions}`) +
  "\nreturn { emptyForm, formFromUpstream, payloadFromForm };",
)(keyRowsFrom, keysPayload, joinMappingLines, parseMappingLines);

function quickImportDraft() {
  let draft;
  const run = new Function("setQuickOpen", "setEditing",
    stripTypeScriptTypes(sourceFunction(page, "runQuickImport", "  ")) + "\nreturn runQuickImport;",
  )(() => {}, (value) => { draft = value; });
  run("imported", "https://example.test", null, ["test-model"]);
  return draft;
}

test("新建渠道默认固定权重，提交时关闭自动权重", () => {
  const fresh = form.emptyForm();
  assert.equal(fresh.fixedWeight, true);
  const payload = form.payloadFromForm(fresh);
  assert.equal(payload.auto_weight_enabled, false);
  assert.equal(payload.weight, 100);
  assert.equal(payload.priority, 100);
});

test("快速导入默认固定权重，保留原有优先级和基础权重", () => {
  const draft = quickImportDraft();
  assert.equal(draft.upstream.auto_weight_enabled, false);
  const filled = form.formFromUpstream(draft.upstream, draft.draftKeys);
  assert.equal(filled.fixedWeight, true);
  const payload = form.payloadFromForm(filled);
  assert.equal(payload.auto_weight_enabled, false);
  assert.equal(payload.priority, 999);
  assert.equal(payload.weight, 100);
});

test("用户仍可取消固定权重以启用自动权重", () => {
  const fresh = form.emptyForm();
  fresh.fixedWeight = false;
  assert.equal(form.payloadFromForm(fresh).auto_weight_enabled, true);
});

test("编辑和复制渠道保留原有权重策略，不套用新增默认值", () => {
  for (const id of [0, 7]) {
    for (const automatic of [false, true]) {
      const upstream = { ...quickImportDraft().upstream, id, auto_weight_enabled: automatic };
      const filled = form.formFromUpstream(upstream);
      assert.equal(filled.fixedWeight, !automatic);
      assert.equal(form.payloadFromForm(filled).auto_weight_enabled, automatic);
    }
  }
});
