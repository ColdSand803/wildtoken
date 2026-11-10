import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { stripTypeScriptTypes } from "node:module";
import test from "node:test";

import { UnauthorizedError } from "../web/src/api.ts";

const page = readFileSync(new URL("../web/src/pages/UpstreamsPage.tsx", import.meta.url), "utf8");
const source = page.match(/  async function openEditor\([\s\S]*?\n  }\n/)[0];
const compiled = stripTypeScriptTypes(source);

function editor(getUpstream) {
  const opened = [];
  const errors = [];
  const auth = [];
  // fail 是页面统一的失败出口（useFailure）：未授权交给登录，其余弹提示。
  const fail = (err, options) => {
    if (err instanceof UnauthorizedError) auth.push(err.message);
    else errors.push(`${options.prefix}：${err.message}`);
  };
  const open = new Function("getUpstream", "setEditing", "fail",
    compiled + "\nreturn openEditor;",
  )(getUpstream, (value) => opened.push(value), fail);
  return { open, opened, errors, auth };
}

const listed = { id: 7, name: "channel", api_key_set: true, key_count: 2 };

test("详情失败时不以缺少 Key 列表的简略数据打开编辑表单", async () => {
  const state = editor(async () => { throw new Error("temporary failure"); });
  await state.open(listed);
  assert.deepEqual(state.opened, []);
  assert.equal(state.errors.length, 1);
  assert.match(state.errors[0], /temporary failure/);
});

test("编辑只使用详情返回的完整 Key 列表", async () => {
  const full = { ...listed, keys: [{ id: 11 }, { id: 12 }] };
  const state = editor(async (id) => {
    assert.equal(id, listed.id);
    return full;
  });
  await state.open(listed);
  assert.deepEqual(state.opened, [{ upstream: full }]);
  assert.deepEqual(state.errors, []);
});

test("详情认证失败交给登录处理，编辑器保持关闭", async () => {
  const state = editor(async () => { throw new UnauthorizedError("expired"); });
  await state.open(listed);
  assert.deepEqual(state.opened, []);
  assert.deepEqual(state.auth, ["expired"]);
  assert.deepEqual(state.errors, []);
});
