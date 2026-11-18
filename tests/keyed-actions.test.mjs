import assert from "node:assert/strict";
import test from "node:test";
import { KeyedActions } from "../web/src/driver/keyedActions.ts";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test("不同实体并发，完成一个不解除另一个的锁", async () => {
  const actions = new KeyedActions();
  const a = deferred();
  const b = deferred();
  const states = [];
  const changed = () => states.push([...actions.snapshot()]);
  const first = actions.run(1, () => a.promise, changed);
  const second = actions.run(2, () => b.promise, changed);
  assert.deepEqual([...actions.snapshot()], [1, 2]);
  a.resolve("A");
  assert.deepEqual(await first, { started: true, value: "A" });
  assert.deepEqual([...actions.snapshot()], [2]);
  b.resolve("B");
  await second;
  assert.deepEqual(states, [[1], [1, 2], [2], []]);
});

test("同一实体重复提交不调用操作函数", async () => {
  const actions = new KeyedActions();
  const pending = deferred();
  const first = actions.run(1, () => pending.promise, () => {});
  const second = await actions.run(1, async () => assert.fail("不应再次发送"), () => {});
  assert.deepEqual(second, { started: false });
  pending.resolve();
  await first;
  assert.deepEqual(await actions.run(1, async () => 2, () => {}), { started: true, value: 2 });
});

test("异常也释放锁，且不改变已返回的快照", async () => {
  const actions = new KeyedActions();
  const pending = deferred();
  const first = actions.run(7, () => pending.promise, () => {});
  const snapshot = actions.snapshot();
  pending.reject(new Error("offline"));
  await assert.rejects(first, /offline/);
  assert.deepEqual([...actions.snapshot()], []);
  assert.deepEqual([...snapshot], [7]);
});

test("同步抛错不会遗留锁", async () => {
  const actions = new KeyedActions();
  await assert.rejects(actions.run(1, () => { throw new Error("failed"); }, () => {}), /failed/);
  assert.equal(actions.snapshot().size, 0);
});
