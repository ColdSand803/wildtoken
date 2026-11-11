import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { upstreamCredentialsText } from "../web/src/upstreamCopy.ts";

const key = (api_key, patch = {}) => ({ name: "primary", api_key, enabled: true, ...patch });

test("单 Key 只复制渠道地址和明文，不带其他配置", () => {
  assert.equal(
    upstreamCredentialsText("https://api.example.com/v1", [key("sk-primary")]),
    "Base URL: https://api.example.com/v1\nAPI Key: sk-primary",
  );
});

test("多 Key 按原顺序逐行复制，停用 Key 也保留", () => {
  assert.equal(
    upstreamCredentialsText("https://api.example.com", [
      key("sk-first", { name: "first" }),
      key("sk-disabled", { name: "disabled", enabled: false }),
      key("sk-last", { name: "last" }),
    ]),
    "Base URL: https://api.example.com\nAPI Key: sk-first\nAPI Key: sk-disabled\nAPI Key: sk-last",
  );
});

test("未配置 Key 时只复制地址，不填假的 Key", () => {
  assert.equal(upstreamCredentialsText("https://api.example.com", []), "Base URL: https://api.example.com");
});

test("地址和 Key 原样保留，不截断或改写", () => {
  const baseUrl = "https://api.example.com/proxy/v1/?region=cn";
  const keys = [key("key_+/=.-")];
  const before = structuredClone(keys);
  assert.equal(upstreamCredentialsText(baseUrl, keys), `Base URL: ${baseUrl}\nAPI Key: key_+/=.-`);
  assert.deepEqual(keys, before);
});

const page = readFileSync(new URL("../web/src/pages/UpstreamsPage.tsx", import.meta.url), "utf8");

test("普通和归档渠道的菜单都明确写复制地址和 API Key", () => {
  assert.equal(
    [...page.matchAll(/label: "复制地址和 API Key", onSelect: \(\) => void copyCredentials\(upstream\)/g)].length,
    2,
  );
  assert.doesNotMatch(page, /label: "复制渠道信息"/);
});

test("复制前重新获取渠道和全部 Key，不把失败降级成无 Key", () => {
  const start = page.indexOf("  async function copyCredentials(");
  assert.notEqual(start, -1);
  const block = page.slice(start, page.indexOf("\n  /**", start));
  assert.match(block, /const full = await getUpstream\(upstream\.id\);/);
  assert.match(block, /const keys = await revealAllKeys\(full\);/);
  assert.match(block, /await copyText\(upstreamCredentialsText\(full\.base_url, keys\)\);/);
  assert.doesNotMatch(block, /\.catch\(/);
  assert.match(block, /fail\(err, \{ prefix: "复制失败" \}\)/);
  assert.match(block, /未配置 API Key/);
});
