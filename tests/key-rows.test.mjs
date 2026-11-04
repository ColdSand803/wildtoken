// 渠道弹窗的 key 行：打开时怎么列、提交时怎么发、探上游用哪把。
import assert from "node:assert/strict";
import test from "node:test";

import { keyRowsFrom, keysPayload, newKeyRow, probeKeyOf } from "../web/src/keyRows.ts";

const saved = (id, extra = {}) => ({ ...newKeyRow(), id, ...extra });

test("提交时：没填值的新行丢掉，已存的留空表示不改", () => {
  const rows = [
    saved(1, { name: " 主号 " }),
    newKeyRow(),
    newKeyRow({ name: "新加", api_key: " sk-new ", enabled: false }),
  ];
  assert.deepEqual(keysPayload(rows), [
    { id: 1, name: "主号", api_key: "", enabled: true },
    { id: 0, name: "新加", api_key: "sk-new", enabled: false },
  ]);
});

test("取回的明文没改过照样发空，改过才发新值", () => {
  const untouched = saved(1, { revealed: "sk-old", value: "sk-old" });
  const edited = saved(2, { revealed: "sk-old", value: "sk-replaced" });
  assert.deepEqual(
    keysPayload([untouched, edited]).map((key) => key.api_key),
    ["", "sk-replaced"],
  );
});

test("打开时：编辑已有渠道按名称列出 key，值不回显；复制来的草稿 id 不带过去", () => {
  const upstream = {
    id: 7,
    keys: [
      { id: 3, name: "a", enabled: true, cooling_seconds: 40 },
      { id: 4, name: "b", enabled: false },
    ],
  };
  const rows = keyRowsFrom(upstream);
  assert.deepEqual(
    rows.map(({ id, name, value, enabled, coolingSeconds }) => ({ id, name, value, enabled, coolingSeconds })),
    [
      { id: 3, name: "a", value: "", enabled: true, coolingSeconds: 40 },
      { id: 4, name: "b", value: "", enabled: false, coolingSeconds: 0 },
    ],
  );

  // 复制出来的草稿 id 为 0，带着原渠道的 key id 存下去会被后端拒掉。
  const copied = keyRowsFrom({ ...upstream, id: 0 });
  assert.equal(copied.length, 1);
  assert.equal(copied[0].id, 0);

  const drafted = keyRowsFrom({ ...upstream, id: 0 }, [{ name: "a", api_key: "sk-a", enabled: true }]);
  assert.deepEqual(drafted.map(({ id, value }) => ({ id, value })), [{ id: 0, value: "sk-a" }]);
});

test("一把 key 都没有时给一行空的", () => {
  const rows = keyRowsFrom({ id: 5, keys: [] });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 0);
  assert.equal(rows[0].value, "");
});

test("探上游：先用填了值的启用 key，否则让服务端用第一把已存的启用 key", () => {
  assert.deepEqual(
    probeKeyOf([saved(1), newKeyRow({ name: "", api_key: "sk-typed", enabled: true })]),
    { apiKey: "sk-typed", storedKeyId: 0 },
  );
  assert.deepEqual(
    probeKeyOf([newKeyRow({ name: "", api_key: "sk-off", enabled: false }), saved(2, { enabled: false }), saved(3)]),
    { apiKey: null, storedKeyId: 3 },
  );
  assert.deepEqual(probeKeyOf([saved(4, { enabled: false })]), { apiKey: null, storedKeyId: 0 });
});
