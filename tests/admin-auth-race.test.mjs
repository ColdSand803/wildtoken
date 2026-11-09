import assert from "node:assert/strict";
import test from "node:test";

import { loadTS } from "./react-harness.mjs";
const { getAdminToken, send, setAdminToken, UnauthorizedError } = loadTS("web/src/api.ts");

const storage = new Map();
globalThis.localStorage = {
  getItem: (key) => storage.get(key) ?? null,
  setItem: (key, value) => storage.set(key, value),
  removeItem: (key) => storage.delete(key),
};
globalThis.window = new EventTarget();

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function unauthorized(json) {
  return { ok: false, status: 401, statusText: "Unauthorized", json };
}

test("旧 401 读取完成前重新登录，重试使用新令牌", async () => {
  const reading = deferred();
  const body = deferred();
  const seen = [];
  let events = 0;
  const onUnauthorized = () => { events += 1; };
  window.addEventListener("console:unauthorized", onUnauthorized);
  const previousFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (_path, init) => {
      seen.push(init.headers.get("x-admin-token"));
      if (seen.length > 1) return new Response("{}", { status: 200 });
      return unauthorized(() => {
        reading.resolve();
        return body.promise;
      });
    };
    setAdminToken("old-token");
    const request = send("/api/admin/system");
    await reading.promise;
    setAdminToken("new-token");
    body.resolve({ error: "unauthorized" });
    assert.equal((await request).status, 200);
    assert.equal(getAdminToken(), "new-token");
    assert.deepEqual(seen, ["old-token", "new-token"]);
    assert.equal(events, 0);
  } finally {
    globalThis.fetch = previousFetch;
    window.removeEventListener("console:unauthorized", onUnauthorized);
  }
});

test("真正失效的当前令牌仍清除并通知登录", async () => {
  const previousFetch = globalThis.fetch;
  let events = 0;
  const listener = () => { events += 1; };
  window.addEventListener("console:unauthorized", listener);
  try {
    globalThis.fetch = async () => unauthorized(async () => ({ error: "unauthorized" }));
    setAdminToken("expired-token");
    await assert.rejects(send("/api/admin/system"), UnauthorizedError);
    assert.equal(getAdminToken(), "");
    assert.equal(events, 1);
  } finally {
    globalThis.fetch = previousFetch;
    window.removeEventListener("console:unauthorized", listener);
  }
});

test("退出登录后收到旧 401 不重新发送写请求", async () => {
  const reading = deferred();
  const body = deferred();
  const previousFetch = globalThis.fetch;
  let calls = 0;
  try {
    globalThis.fetch = async () => {
      calls += 1;
      return unauthorized(() => { reading.resolve(); return body.promise; });
    };
    setAdminToken("old-token");
    const request = send("/api/admin/settings/", { method: "PUT", body: "{}" });
    const rejected = assert.rejects(request, UnauthorizedError);
    await reading.promise;
    setAdminToken("");
    body.resolve({ error: "unauthorized" });
    await rejected;
    assert.equal(getAdminToken(), "");
    assert.equal(calls, 1);
  } finally {
    globalThis.fetch = previousFetch;
  }
});
