// 日志页客户端下拉：服务端清单、页面上的行、当前选中值合在一起，探测类放最后。
import assert from "node:assert/strict";
import test from "node:test";

import { clientTypeOptions } from "../web/src/clientTypes.ts";

test("清单里的类型按名称排，探测类单独一组", () => {
  const options = clientTypeOptions(["pi", "axonhub", "channel-test", "claude", "balance"], [], "");
  assert.deepEqual(options.clients, ["axonhub", "claude", "pi"]);
  assert.deepEqual(options.probes, ["balance", "channel-test"]);
});

test("清单之后流进来的新类型也能选", () => {
  const options = clientTypeOptions(["pi"], ["dsh", "pi", "model-test"], "");
  assert.deepEqual(options.clients, ["dsh", "pi"]);
  assert.deepEqual(options.probes, ["model-test"]);
});

test("当前筛选值不在清单里也保留，空值不成项", () => {
  assert.deepEqual(clientTypeOptions([], [], "evo").clients, ["evo"]);
  assert.deepEqual(clientTypeOptions([], [""], ""), { clients: [], probes: [] });
});
