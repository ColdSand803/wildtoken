import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  // Keep an `async` keyword: without it the extracted body cannot await.
  const asyncPrefix = "async ";
  const declarationStart = source.startsWith(asyncPrefix, start - asyncPrefix.length)
    ? start - asyncPrefix.length
    : start;
  // The body starts after the parameter list closes, not at the first brace: a
  // destructured parameter such as ({ dryRun }) is a brace that opens and closes
  // before the body, and counting from there extracts only the signature.
  let parens = 0;
  let paramsEnd = -1;
  for (let index = source.indexOf("(", start); index < source.length; index += 1) {
    if (source[index] === "(") parens += 1;
    if (source[index] === ")") {
      parens -= 1;
      if (parens === 0) {
        paramsEnd = index;
        break;
      }
    }
  }
  assert.notEqual(paramsEnd, -1, `could not find the parameter list of ${name}`);

  const bodyStart = source.indexOf("{", paramsEnd);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(declarationStart, index + 1);
      }
    }
  }

  throw new Error(`could not extract ${name}`);
}

function parserContext() {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({
    CHANNEL_DOCUMENT_KIND: "wildtoken.channels",
    CHANNEL_DOCUMENT_VERSION: 1,
    CHANNEL_IMPORT_MAX_ENTRIES: 500,
    CHANNEL_IMPORT_MAX_BYTES: 2 * 1024 * 1024,
  });
  vm.runInContext(extractFunction(source, "parseChannelImportDocument"), context);
  return context;
}

function parse(context, value) {
  context.candidate = value;
  return vm.runInContext("parseChannelImportDocument(candidate)", context);
}

const validChannel = { name: "openai", base_url: "https://api.openai.com/v1" };

test("a well-formed channel document parses", () => {
  const context = parserContext();
  const document = parse(
    context,
    JSON.stringify({ kind: "wildtoken.channels", version: 1, channels: [validChannel] }),
  );

  assert.equal(document.channels.length, 1);
  assert.equal(document.channels[0].name, "openai");
});

test("a document without an envelope still parses", () => {
  const context = parserContext();
  const document = parse(context, JSON.stringify({ channels: [validChannel] }));

  assert.equal(document.channels.length, 1);
});

test("the parser rejects malformed documents before any request is sent", () => {
  const context = parserContext();
  const cases = [
    ["", /请选择文件或粘贴 JSON/],
    ["   ", /请选择文件或粘贴 JSON/],
    ["{not json", /不是合法 JSON/],
    ["[]", /顶层必须是一个 JSON 对象/],
    ['"a string"', /顶层必须是一个 JSON 对象/],
    [JSON.stringify({ kind: "wildtoken.tokens", channels: [validChannel] }), /不是渠道导出文件/],
    [JSON.stringify({ version: 99, channels: [validChannel] }), /文档版本 99/],
    [JSON.stringify({ channels: {} }), /缺少 channels 数组/],
    [JSON.stringify({ channels: [] }), /没有渠道/],
    [JSON.stringify({ channels: [null] }), /第 1 个渠道不是对象/],
    [JSON.stringify({ channels: [{ base_url: "https://a.test" }] }), /第 1 个渠道缺少 name/],
    [JSON.stringify({ channels: [{ name: "a" }] }), /缺少 base_url/],
  ];

  for (const [input, expected] of cases) {
    assert.throws(() => parse(context, input), expected, `input: ${input.slice(0, 40)}`);
  }
});

test("the parser enforces the same entry cap as the server", () => {
  const context = parserContext();
  const channels = Array.from({ length: 501 }, (_, index) => ({
    name: `channel-${index}`,
    base_url: "https://a.test",
  }));

  assert.throws(() => parse(context, JSON.stringify({ channels })), /最多导入 500/);
});

test("export scope prefers checked rows and otherwise covers every channel", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({
    selectedUpstreamIds: new Set(),
    upstreams: [{ id: 1 }, { id: 2 }, { id: 3 }],
  });
  vm.runInContext(extractFunction(source, "channelExportScope"), context);

  const all = vm.runInContext("channelExportScope()", context);
  assert.equal(all.all, true);
  assert.equal(all.ids, null, "a null id filter exports everything server-side");
  assert.equal(all.count, 3);

  context.selectedUpstreamIds.add(2);
  context.selectedUpstreamIds.add(3);
  const selected = vm.runInContext("channelExportScope()", context);
  assert.equal(selected.all, false);
  // Copy out of the vm realm: its Array has a different prototype.
  assert.deepEqual([...selected.ids], [2, 3]);
  assert.equal(selected.count, 2);
});

test("the export filename carries a sortable timestamp", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, "buildChannelExportFilename"), context);
  context.stamp = new Date(2026, 7, 13, 9, 5, 4);

  assert.equal(
    vm.runInContext("buildChannelExportFilename(stamp)", context),
    "wildtoken-channels-20260813-090504.json",
  );
});

test("the import result summary names only the actions that happened", () => {
  const source = read("static/js/upstreams.js");
  const context = vm.createContext({});
  vm.runInContext(extractFunction(source, "formatChannelImportResult"), context);

  const format = (result) => {
    context.result = result;
    return vm.runInContext("formatChannelImportResult(result)", context);
  };

  assert.equal(format({ created: 2, updated: 0, skipped: 1, failed: 0 }), "新增 2，跳过 1");
  assert.equal(format({ created: 0, updated: 0, skipped: 0, failed: 0 }), "没有变更");
  assert.match(format({ created: 0, updated: 0, skipped: 0, failed: 3 }), /失败 3/);
});

test("the channels view exposes export and import entry points", () => {
  const markup = read("static/admin.html");

  assert.match(markup, /id="channel-export"/);
  assert.match(markup, /id="channel-import"/);
  assert.match(markup, /<dialog id="channel-export-dialog"/);
  assert.match(markup, /<dialog id="channel-import-dialog"/);
  // Excluding keys must be reachable from the export dialog.
  assert.match(markup, /id="channel-export-include-keys"/);
  // Both conflict modes must be offered, with skip preselected.
  assert.match(markup, /name="channel-import-mode" value="skip" checked/);
  assert.match(markup, /name="channel-import-mode" value="overwrite"/);
});

test("both transfer dialogs reuse the shared dialog chrome so every theme covers them", () => {
  const markup = read("static/admin.html");
  const dialogClass = /<dialog id="channel-(?:ex|im)port-dialog" class="([^"]+)"/g;
  const classes = [...markup.matchAll(dialogClass)].map((match) => match[1]);

  assert.equal(classes.length, 2);
  for (const value of classes) {
    assert.ok(
      value.split(/\s+/).includes("quick-import-dialog"),
      "a new dialog class would need adding to every themes/*/theme.css selector list",
    );
  }
});

test("Escape closes both transfer dialogs", () => {
  const shell = read("static/js/shell.js");

  assert.match(shell, /dialog === channelExportDialog/);
  assert.match(shell, /dialog === channelImportDialog/);
});
