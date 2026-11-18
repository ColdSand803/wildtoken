import assert from "node:assert/strict";
import test from "node:test";
import { LatestRequest } from "../web/src/driver/latestRequest.ts";

test("新读取取消旧读取，旧回调失去提交资格", () => {
  const requests = new LatestRequest();
  const first = requests.start();
  const second = requests.start();
  assert.equal(first.signal.aborted, true);
  assert.equal(first.current(), false);
  assert.equal(second.current(), true);
});

test("失效后到达的成功或失败都不能提交", async () => {
  const requests = new LatestRequest();
  let release;
  const pending = new Promise((resolve) => { release = resolve; });
  const request = requests.start();
  const result = pending.then(() => request.current() ? "committed" : "ignored");
  requests.invalidate();
  release();
  assert.equal(await result, "ignored");
  assert.equal(request.signal.aborted, true);
});

test("卸载后的再次挂载不复用已取消的信号", () => {
  const requests = new LatestRequest();
  const previous = requests.start();
  requests.invalidate();
  requests.invalidate();
  const current = requests.start();
  assert.equal(previous.current(), false);
  assert.equal(current.signal.aborted, false);
  assert.equal(current.current(), true);
});
