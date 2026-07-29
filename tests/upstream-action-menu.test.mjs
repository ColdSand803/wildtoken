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
