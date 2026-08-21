// P3-2 frontend: the console exports a scoped archive, previews an import before
// applying it, and never keeps the archive password.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const shell = read("static/js/shell.js");
const events = read("static/js/events.js");
const bootstrap = read("static/js/bootstrap.js");
const html = read("static/admin.html");
const css = read("static/css/enhancements.css");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

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
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(declarationStart, index + 1);
    }
  }
  throw new Error(`could not extract ${name}`);
}

const escapeHtml = (value) =>
  String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");

// reportContext runs the real renderer against a stand-in element, so the
// assertions read the markup the console actually writes.
function reportContext() {
  const element = { innerHTML: "" };
  const context = vm.createContext({ configImportReport: element, escapeHtml });
  const constants = shell.slice(
    shell.indexOf("const CONFIG_SCOPE_LABELS"),
    shell.indexOf("function setConfigExportStatus"),
  );
  vm.runInContext(constants, context);
  vm.runInContext(extractFunction(shell, "renderConfigImportReport"), context);
  return { context, element };
}

function renderReport(report, options = { dryRun: true }) {
  const { context, element } = reportContext();
  context.report = report;
  context.options = options;
  vm.runInContext("renderConfigImportReport(report, options)", context);
  return element.innerHTML;
}

test("a dry-run report is labelled as not written", () => {
  const markup = renderReport(
    { created: 2, updated: 0, skipped: 1, items: [{ scope: "channels", name: "openai", action: "create" }] },
    { dryRun: true },
  );
  assert.match(markup, /预览/);
  assert.match(markup, /未写入/, "a preview must say nothing was written, or an operator reads it as done");
  assert.match(markup, /新建 2/);
  assert.match(markup, /跳过 1/);
});

test("an applied report is not labelled as a preview", () => {
  const markup = renderReport({ created: 1, updated: 0, skipped: 0, items: [] }, { dryRun: false });
  assert.doesNotMatch(markup, /预览/, "a completed import must not read as a plan");
  assert.match(markup, /导入结果/);
});

test("scope and action names are shown in the console's own language", () => {
  const markup = renderReport({
    items: [
      { scope: "groups", name: "production", action: "create" },
      { scope: "tokens", name: "app", action: "skip", detail: "已存在，保留现有令牌" },
      { scope: "channels", name: "openai", action: "update" },
    ],
  });
  assert.match(markup, /分组/);
  assert.match(markup, /令牌策略/);
  assert.match(markup, /渠道/);
  assert.match(markup, /新建/);
  assert.match(markup, /跳过/);
  assert.match(markup, /覆盖/);
  // The per-item detail is what explains a skip or a regenerated credential.
  assert.match(markup, /保留现有令牌/);
});

test("a refused import names the entry at fault and says nothing was written", () => {
  const markup = renderReport({
    created: 0,
    errors: ["channels openai: base_url is required"],
    items: [
      { scope: "groups", name: "production", action: "create" },
      { scope: "channels", name: "openai", action: "fail", detail: "base_url is required" },
    ],
  });
  assert.match(markup, /未写入任何内容/, "the operator must know the earlier items were rolled back too");
  assert.match(markup, /openai/);
  assert.match(markup, /base_url is required/);
  assert.match(markup, /data-action="fail"/, "the refused row must be findable in a long list");
});

test("an archive carrying credentials is called out before it is applied", () => {
  const markup = renderReport({
    includes_secrets: true,
    app_version: "1.2.3",
    exported_at: "2026-08-20T00:00:00Z",
    schema_version: 1,
    items: [],
  });
  assert.match(markup, /含密钥/, "writing credentials must be visible in the plan");
  assert.match(markup, /1\.2\.3/);
  assert.match(markup, /2026-08-20/);
});

test("report text is escaped rather than injected", () => {
  const markup = renderReport({
    errors: ["<img src=x onerror=alert(1)>"],
    items: [{ scope: "channels", name: "<script>bad()</script>", action: "fail" }],
  });
  assert.doesNotMatch(markup, /<script>/, "a name from an uploaded file must not become markup");
  assert.doesNotMatch(markup, /<img /);
  assert.match(markup, /&lt;script&gt;/);
});

test("an empty archive is described rather than rendered as a blank panel", () => {
  const markup = renderReport({ created: 0, updated: 0, skipped: 0, items: [] });
  assert.match(markup, /没有需要处理的条目/);
});

test("the export refuses to ship secrets without a password, before any request", () => {
  const source = extractFunction(shell, "runConfigExport");
  // The client-side guard exists so the operator is told immediately; the server
  // enforces the same rule, which is what actually protects the archive.
  assert.match(source, /include_secrets/);
  assert.match(source, /8/, "the minimum password length must be checked client-side too");
  const guardIndex = source.indexOf("includeSecrets && password");
  const requestIndex = source.indexOf("api(");
  assert.notEqual(guardIndex, -1, "the secrets-without-password combination must be refused");
  assert.ok(guardIndex < requestIndex, "the refusal must come before the request, not after");
});

test("the archive password is never persisted", () => {
  const migrationCode = shell.slice(
    shell.indexOf("let stagedConfigArchive"),
    // Bounded by the disaster-recovery card that now follows rather than by
    // renderSystemInfo, so this stays a statement about the migration card.
    shell.indexOf("// ── Disaster recovery"),
  );
  assert.doesNotMatch(migrationCode, /localStorage/, "a password in localStorage outlives the tab");
  assert.doesNotMatch(migrationCode, /sessionStorage/);
  // And it is cleared from the DOM once used, so it is not readable for the rest of
  // the session.
  assert.match(migrationCode, /configExportPassword\.value = ""/);
  assert.match(migrationCode, /configImportPassword\.value = ""/);
});

test("the password fields are password inputs and are not autofilled from the browser", () => {
  const exportField = html.match(/<input id="config-export-password"[^>]*>/)?.[0];
  const importField = html.match(/<input id="config-import-password"[^>]*>/)?.[0];
  assert.ok(exportField, "the export password field must exist");
  assert.ok(importField, "the import password field must exist");
  assert.match(exportField, /type="password"/, "a visible password ends up in a screenshot");
  assert.match(importField, /type="password"/);
  assert.match(importField, /autocomplete="off"/);
});

test("apply is locked until a preview has been seen", () => {
  const button = html.match(/<button id="config-import-apply"[^>]*>/)?.[0];
  assert.ok(button, "the apply button must exist");
  assert.match(button, /disabled/, "apply must start locked, or an operator can import unseen");

  const source = extractFunction(shell, "submitConfigImport");
  assert.match(source, /dryRun[\s\S]*configImportApply\.disabled = false/,
    "only a successful dry run may unlock apply");
});

test("changing the input relocks apply, so the plan and the archive cannot diverge", () => {
  assert.match(events, /configImportFile\?\.addEventListener\("change", resetConfigImportState\)/);
  assert.match(events, /configImportConflict\?\.addEventListener/);
  assert.match(events, /configImportPassword\?\.addEventListener/);

  const reset = extractFunction(shell, "resetConfigImportState");
  assert.match(reset, /stagedConfigArchive = null/);
  assert.match(reset, /configImportApply\.disabled = true/);
});

test("the previewed bytes are the applied bytes", () => {
  const source = extractFunction(shell, "submitConfigImport");
  // The archive is held rather than re-read on apply: a file swapped between the two
  // clicks would otherwise be applied against a plan the operator never saw.
  assert.match(source, /stagedConfigArchive/);
  assert.match(source, /archive: stagedConfigArchive/);
});

test("every export scope the backend defines has a checkbox", () => {
  for (const scope of ["groups", "channels", "tokens", "settings"]) {
    assert.match(html, new RegExp(`data-export-scope="${scope}"`),
      `${scope} must be selectable, or part of the configuration cannot be migrated`);
  }
});

test("all three conflict policies are offered", () => {
  const select = html.match(/<select id="config-import-conflict"[\s\S]*?<\/select>/)?.[0];
  assert.ok(select, "the conflict policy control must exist");
  for (const policy of ["skip", "overwrite", "fail"]) {
    assert.match(select, new RegExp(`value="${policy}"`));
  }
  // Skip is first because it is the policy that changes nothing already configured.
  assert.match(select, /<option value="skip"/);
  assert.ok(select.indexOf('value="skip"') < select.indexOf('value="overwrite"'),
    "the non-destructive policy must be the default");
});

test("a refused import still renders its report", () => {
  const source = extractFunction(shell, "submitConfigImport");
  assert.match(source, /error\.report/,
    "a 400 answers with the item list; discarding it leaves the operator only a message");
  // And the request helper has to keep it for that to be possible. It lives in
  // rawApi, which api() is a JSON-parsing wrapper around, so both paths report a
  // rejection the same way.
  const rawApi = extractFunction(shell, "rawApi");
  assert.match(rawApi, /error\.report = payload/);
});

test("an unusable file is refused before a password is requested", () => {
  const source = extractFunction(shell, "readArchiveFile");
  assert.match(source, /JSON\.parse/);
  assert.match(source, /wildtoken\.config/, "the archive kind must be checked");
  assert.doesNotMatch(source, /api\(/, "the file must be validated locally, not by uploading it");
});

test("the archive download is revoked rather than left reachable", () => {
  const source = extractFunction(shell, "downloadArchive");
  assert.match(source, /createObjectURL/);
  assert.match(source, /revokeObjectURL/, "an archive may hold credentials; the blob URL must not outlive the click");
  assert.match(source, /encrypted|plain/, "the filename should say whether the archive is encrypted");
});

test("the card is wired end to end", () => {
  for (const ref of [
    "configExportSecrets", "configExportPassword", "configExportRun", "configExportStatus",
    "configImportFile", "configImportPassword", "configImportConflict",
    "configImportPreview", "configImportApply", "configImportStatus", "configImportReport",
  ]) {
    assert.match(bootstrap, new RegExp(`const ${ref} = document\\.querySelector`),
      `${ref} must be resolved in bootstrap, like every other console reference`);
  }
  assert.match(events, /configExportRun\?\.addEventListener\("click", runConfigExport\)/);
  assert.match(events, /configImportPreview\?\.addEventListener/);
  assert.match(events, /configImportApply\?\.addEventListener/);
  assert.match(css, /\.config-migrate\b/, "the card needs its layout, or the two panes interleave");
  assert.match(css, /config-import-table tr\[data-action="fail"\]/);
});

test("the secrets checkbox is visually marked as the one that writes credentials", () => {
  assert.match(html, /config-secret-row/);
  assert.match(css, /\.config-secret-row/);
  // Unchecked by default: the safe archive is the one an accidental click produces.
  const box = html.match(/<input id="config-export-secrets"[^>]*>/)?.[0];
  assert.ok(box, "the secrets checkbox must exist");
  assert.doesNotMatch(box, /checked/, "credentials must not be exported by default");
});
