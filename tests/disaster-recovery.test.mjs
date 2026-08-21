// P3-3 frontend: the console downloads a database backup, verifies an uploaded one
// before staging it, says plainly that a restart is required, and locks the
// operations a staged restore would swallow.
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

const recoveryCode = shell.slice(
  shell.indexOf("// ── Disaster recovery"),
  shell.indexOf("function renderSystemInfo"),
);

// renderReport runs the real renderer against stand-in elements, so the assertions
// read the markup the console actually writes rather than a description of it.
function renderReport(result, options = { dryRun: true }) {
  const element = { innerHTML: "" };
  const context = vm.createContext({ restoreReport: element, escapeHtml });
  vm.runInContext(extractFunction(shell, "formatBytes"), context);
  vm.runInContext(extractFunction(shell, "shortFingerprint"), context);
  vm.runInContext(extractFunction(shell, "renderRestoreReport"), context);
  context.result = result;
  context.options = options;
  vm.runInContext("renderRestoreReport(result, options)", context);
  return element.innerHTML;
}

// controls stands in for the card's DOM so the lock logic can be exercised as a
// unit: which buttons are clickable in which state is the whole point of the
// restore flow, and asserting it against source text would prove nothing.
function controls(overrides = {}) {
  const button = () => ({ disabled: false });
  const field = (value = "") => ({ value, disabled: false });
  return {
    backupRun: button(),
    restoreVerify: button(),
    restoreApply: button(),
    restoreCancel: button(),
    restoreFile: field(),
    restorePassword: field(),
    restoreConfirm: field(),
    restoreAllowSchemaMismatch: { checked: false, disabled: false },
    configImportApply: button(),
    restorePending: { hidden: true },
    restorePendingDetail: { innerHTML: "" },
    restoreReport: { innerHTML: "<p>stale</p>" },
    restoreStatus: { textContent: "", dataset: {} },
    escapeHtml,
    ...overrides,
  };
}

function lockContext(state = {}) {
  const context = vm.createContext(controls(state.dom));
  vm.runInContext(extractFunction(shell, "formatBytes"), context);
  vm.runInContext(extractFunction(shell, "shortFingerprint"), context);
  vm.runInContext(extractFunction(shell, "applyDisasterRecoveryLocks"), context);
  vm.runInContext(extractFunction(shell, "renderPendingRestore"), context);
  vm.runInContext(extractFunction(shell, "renderRestoreReport"), context);
  vm.runInContext(extractFunction(shell, "setRestoreStatus"), context);
  vm.runInContext(extractFunction(shell, "resetRestoreState"), context);
  vm.runInContext(
    `let stagedBackupFile = ${state.staged ? "{ archive: 'x' }" : "null"};`
    + `let restoreVerified = ${Boolean(state.verified)};`
    + `let disasterRecoveryBusy = ${Boolean(state.busy)};`
    + `let restoreStagedAndPending = ${Boolean(state.pending)};`,
    context,
  );
  return context;
}

test("a verified backup is reported as verified, and an unverified one is not", () => {
  const passed = renderReport({ verified: true, backup: {}, current: {} });
  assert.match(passed, /校验通过/);
  assert.match(passed, /data-verified="true"/);

  const failed = renderReport({ verified: false, backup: {}, current: {} });
  assert.match(failed, /未通过校验/);
  assert.match(failed, /data-verified="false"/);
});

test("a dry run is labelled as not written and an applied restore is not labelled a preview", () => {
  const preview = renderReport({ verified: true, backup: {}, current: {} }, { dryRun: true });
  assert.match(preview, /校验结果/);
  assert.match(preview, /未写入/, "a check that wrote nothing must say so, or it reads as done");

  const applied = renderReport(
    { verified: true, staged: true, requires_restart: true, backup: {}, current: {} },
    { dryRun: false },
  );
  assert.doesNotMatch(applied, /校验结果/);
  assert.match(applied, /恢复结果/);
});

test("the report compares the file against this instance rather than describing it alone", () => {
  const markup = renderReport({
    verified: true,
    backup: {
      app_version: "1.4.0", created_at: "2026-08-20T10:00:00Z",
      schema_fingerprint: "aaaaaaaaaaaaaaaaaaaabbbb", size_bytes: 5 * 1024 * 1024, encrypted: true,
    },
    current: { app_version: "1.5.0", schema_fingerprint: "cccccccccccccccccccc" },
  });
  assert.match(markup, /备份文件/);
  assert.match(markup, /当前实例/);
  assert.match(markup, /1\.4\.0/);
  assert.match(markup, /1\.5\.0/, "the instance's own version has to be beside the file's");
  assert.match(markup, /aaaaaaaaaaaaaaaa/);
  assert.match(markup, /cccccccccccccccc/);
  assert.match(markup, /5\.0 MB/);
});

test("a staged restore says a restart is required and where the old database went", () => {
  const markup = renderReport({
    verified: true, staged: true, requires_restart: true,
    rollback_path: "/data/wildtoken.db.pre-restore-20260820-100000",
    backup: {}, current: {},
  }, { dryRun: false });
  assert.match(markup, /已暂存/);
  assert.match(markup, /尚未生效/, "staged is not applied, and conflating the two loses data");
  assert.match(markup, /下次启动|重启/);
  assert.match(markup, /pre-restore-20260820-100000/, "the rollback copy is what saves a wrong restore");
});

test("an overridden schema mismatch is carried into the report as a warning", () => {
  const markup = renderReport({
    verified: true,
    warnings: ["backup schema does not match this instance; restored anyway"],
    backup: {}, current: {},
  });
  assert.match(markup, /schema does not match/);
  assert.match(css, /\.restore-warnings/);
});

test("everything the server sends is escaped before it reaches the page", () => {
  const markup = renderReport({
    verified: false,
    warnings: ["<script>alert(1)</script>"],
    staged: true,
    rollback_path: `<img src=x onerror=alert(1)>`,
    backup: { app_version: "<b>1.0</b>" },
    current: {},
  }, { dryRun: false });
  assert.doesNotMatch(markup, /<script>/);
  assert.doesNotMatch(markup, /<img /);
  assert.doesNotMatch(markup, /<b>/);
  assert.match(markup, /&lt;script&gt;/);
});

test("restoring is locked until the file is verified and the overwrite is confirmed", () => {
  // Verified but unconfirmed: the operator has seen the check pass and still has to
  // say they mean to replace everything.
  const unconfirmed = lockContext({ verified: true });
  vm.runInContext("applyDisasterRecoveryLocks()", unconfirmed);
  assert.equal(unconfirmed.restoreApply.disabled, true,
    "a restore must not be one click away from a verified file");

  // Confirmed but unverified: the phrase alone is not a check of the file.
  const unverified = lockContext({ dom: { restoreConfirm: { value: "restore", disabled: false } } });
  vm.runInContext("applyDisasterRecoveryLocks()", unverified);
  assert.equal(unverified.restoreApply.disabled, true);

  const ready = lockContext({
    verified: true,
    dom: { restoreConfirm: { value: "restore", disabled: false } },
  });
  vm.runInContext("applyDisasterRecoveryLocks()", ready);
  assert.equal(ready.restoreApply.disabled, false, "both conditions met must unlock the restore");
});

test("the confirmation has to be the exact phrase", () => {
  for (const typed of ["", " ", "RESTORE", "restore now", "yes"]) {
    const context = lockContext({
      verified: true,
      dom: { restoreConfirm: { value: typed, disabled: false } },
    });
    vm.runInContext("applyDisasterRecoveryLocks()", context);
    assert.equal(context.restoreApply.disabled, true,
      `${JSON.stringify(typed)} must not pass as confirmation`);
  }
  // Surrounding whitespace is forgiven; the word is not.
  const padded = lockContext({
    verified: true,
    dom: { restoreConfirm: { value: "  restore  ", disabled: false } },
  });
  vm.runInContext("applyDisasterRecoveryLocks()", padded);
  assert.equal(padded.restoreApply.disabled, false);
});

test("a staged restore locks the restore controls and the configuration import too", () => {
  const context = lockContext({});
  context.pendingPayload = {
    pending: true, staged_at: "2026-08-20T10:00:00Z",
    size_bytes: 2 * 1024 * 1024, checksum: "abcdef0123456789abcdef",
  };
  vm.runInContext("renderPendingRestore(pendingPayload)", context);

  assert.equal(context.restorePending.hidden, false, "a waiting restore must be visible");
  assert.match(context.restorePendingDetail.innerHTML, /等待重启生效/);
  assert.match(context.restorePendingDetail.innerHTML, /需要重启服务/);
  assert.match(context.restorePendingDetail.innerHTML, /2\.0 MB/);

  assert.equal(context.restoreVerify.disabled, true);
  assert.equal(context.restoreApply.disabled, true);
  assert.equal(context.restoreFile.disabled, true);
  assert.equal(context.restorePassword.disabled, true);
  // The configuration import is locked as well: an import written now would land in
  // a database that the next start replaces, so it would be silently lost.
  assert.equal(context.configImportApply.disabled, true);
  // Cancelling has to stay available, or a staged restore cannot be undone.
  assert.equal(context.restoreCancel.disabled, false);
  // And a backup of the still-current database is still worth taking.
  assert.equal(context.backupRun.disabled, false);
});

test("no pending restore leaves the banner hidden and the controls usable", () => {
  const context = lockContext({});
  vm.runInContext("renderPendingRestore({ pending: false })", context);
  assert.equal(context.restorePending.hidden, true);
  assert.equal(context.restoreVerify.disabled, false);
  assert.equal(context.restoreFile.disabled, false);
});

test("a request in flight locks the buttons without pretending a restore is staged", () => {
  const context = lockContext({ busy: true, verified: true, dom: { restoreConfirm: { value: "restore", disabled: false } } });
  vm.runInContext("applyDisasterRecoveryLocks()", context);
  assert.equal(context.backupRun.disabled, true, "a second click would duplicate the work");
  assert.equal(context.restoreVerify.disabled, true);
  assert.equal(context.restoreApply.disabled, true);
  assert.equal(context.restoreCancel.disabled, true);
  assert.equal(context.restorePending.hidden, true, "being busy is not a staged restore");
});

test("changing what would be restored discards the verification", () => {
  const context = lockContext({
    staged: true, verified: true,
    dom: { restoreConfirm: { value: "restore", disabled: false } },
  });
  vm.runInContext("resetRestoreState()", context);
  assert.equal(vm.runInContext("restoreVerified", context), false);
  assert.equal(vm.runInContext("stagedBackupFile", context), null);
  assert.equal(context.restoreApply.disabled, true,
    "a file, password or schema-override change describes a different restore");
  assert.equal(context.restoreReport.innerHTML, "",
    "a report from the previous file must not survive a change of file");

  // And every input that changes the outcome is wired to it.
  assert.match(events, /restoreFile\?\.addEventListener\("change", resetRestoreState\)/);
  assert.match(events, /restorePassword\?\.addEventListener\("input", resetRestoreState\)/);
  assert.match(events, /restoreAllowSchemaMismatch\?\.addEventListener\("change", resetRestoreState\)/);
  // The confirmation phrase does not change the restore, only whether it may run,
  // so it re-evaluates the locks instead of throwing the verification away.
  assert.match(events, /restoreConfirm\?\.addEventListener\("input", applyDisasterRecoveryLocks\)/);
});

test("a wrong password or a damaged file is reported as having changed nothing", () => {
  const source = extractFunction(shell, "submitRestore");
  const catchBlock = source.slice(source.indexOf("} catch (error)"));
  assert.match(catchBlock, /当前数据库未被修改/,
    "the operator's first question after a failure is whether the instance survived it");
  assert.match(catchBlock, /restoreVerified = false/,
    "a failed attempt must not leave apply unlocked");
  assert.match(catchBlock, /renderRestoreReport\(null/,
    "a stale report beside a failure reads as a result");
});

test("an unusable file is refused locally, before a password or an upload", () => {
  const source = extractFunction(shell, "readBackupFile");
  assert.doesNotMatch(source, /api\(/, "the file must be checked here, not by uploading a database");
  assert.match(source, /BACKUP_MAGIC/, "the container's magic identifies the format");
  assert.match(source, /BACKUP_KIND/);
  assert.match(source, /MAX_BACKUP_HEADER_BYTES/,
    "a declared header length has to be bounded before it is trusted");
  // The likeliest mistake is the configuration archive from the card above, so it is
  // named rather than reported as a generic parse failure.
  assert.match(source, /配置迁移/);
});

test("the local header check accepts a real container and refuses the near misses", async () => {
  const context = vm.createContext({ TextDecoder, btoa, DataView, Uint8Array, JSON });
  vm.runInContext(recoveryCode.slice(
    recoveryCode.indexOf("const BACKUP_MAGIC"),
    recoveryCode.indexOf("function setBackupStatus"),
  ), context);
  vm.runInContext(extractFunction(shell, "bytesToBase64"), context);
  vm.runInContext(extractFunction(shell, "readBackupFile"), context);

  const build = (header, body = "sqlite-bytes", magic = `WTBAK1${String.fromCharCode(0, 0)}`) => {
    const headerBytes = new TextEncoder().encode(JSON.stringify(header));
    const bytes = new Uint8Array(magic.length + 4 + headerBytes.length + body.length);
    for (let index = 0; index < magic.length; index += 1) bytes[index] = magic.charCodeAt(index);
    new DataView(bytes.buffer).setUint32(magic.length, headerBytes.length, false);
    bytes.set(headerBytes, magic.length + 4);
    bytes.set(new TextEncoder().encode(body), magic.length + 4 + headerBytes.length);
    return { arrayBuffer: async () => bytes.buffer };
  };

  context.good = build({ kind: "wildtoken.backup", schema_version: 1, checksum: "abc" });
  const parsed = await vm.runInContext("readBackupFile(good)", context);
  assert.equal(parsed.header.kind, "wildtoken.backup");
  assert.ok(parsed.archive.length > 0, "the file has to be encoded for the request");

  // A configuration archive: valid JSON, wrong format.
  context.configArchive = {
    arrayBuffer: async () =>
      new TextEncoder().encode(JSON.stringify({ kind: "wildtoken.config" })).buffer,
  };
  await assert.rejects(
    () => vm.runInContext("readBackupFile(configArchive)", context),
    /配置迁移/,
  );

  // A backup whose header says it is something else.
  context.wrongKind = build({ kind: "something.else", schema_version: 1 });
  await assert.rejects(() => vm.runInContext("readBackupFile(wrongKind)", context), /数据库备份/);

  // A header length that runs past the end of the file.
  const truncated = build({ kind: "wildtoken.backup", schema_version: 1 });
  const bytes = new Uint8Array(await truncated.arrayBuffer());
  new DataView(bytes.buffer).setUint32(8, 1_000_000, false);
  context.overlong = { arrayBuffer: async () => bytes.buffer };
  await assert.rejects(() => vm.runInContext("readBackupFile(overlong)", context), /损坏/);

  // An empty file cannot even hold the magic.
  context.empty = { arrayBuffer: async () => new Uint8Array(3).buffer };
  await assert.rejects(() => vm.runInContext("readBackupFile(empty)", context), /数据库备份/);
});

test("the verified bytes are the staged bytes", () => {
  const source = extractFunction(shell, "submitRestore");
  assert.match(source, /stagedBackupFile/);
  assert.match(source, /archive: stagedBackupFile\.archive/,
    "a file swapped between the check and the apply would be staged unverified");
  assert.match(source, /body\.confirm = "restore"/);
  assert.match(source, /dry_run: dryRun/);
  assert.match(source, /allow_schema_mismatch/);
  // The confirmation is only sent on a real restore; a dry run has nothing to confirm.
  assert.match(source, /if \(!dryRun\) body\.confirm/);
});

test("a cancelled restore says the database was left alone", () => {
  const source = extractFunction(shell, "cancelStagedRestore");
  assert.match(source, /method: "DELETE"/);
  assert.match(source, /当前数据库不受影响/);
  assert.match(source, /renderPendingRestore\(\{ pending: false \}\)/,
    "the banner has to go, or the card still claims a restore is waiting");
  assert.match(source, /rollback_kept/,
    "the pre-restore copy is kept on the server and the operator should be told");
  assert.match(source, /loadDisasterRecoveryInfo/, "the card is reloaded from the server, not assumed");
});

test("a successful restore clears the credentials and reloads the card", () => {
  const source = extractFunction(shell, "submitRestore");
  const applied = source.slice(source.indexOf("} else {"));
  assert.match(applied, /restorePassword\.value = ""/, "a password left in the DOM is readable all session");
  assert.match(applied, /restoreConfirm\.value = ""/);
  assert.match(applied, /restoreFile\.value = ""/);
  assert.match(applied, /stagedBackupFile = null/);
  assert.match(applied, /需要重启/, "the status line has to say the restore is not in effect yet");
  assert.match(applied, /loadDisasterRecoveryInfo/);
});

test("the backup password is never persisted and is cleared once used", () => {
  assert.doesNotMatch(recoveryCode, /localStorage/, "a password in localStorage outlives the tab");
  assert.doesNotMatch(recoveryCode, /sessionStorage/);
  assert.match(recoveryCode, /backupPassword\.value = ""/);
  assert.match(recoveryCode, /restorePassword\.value = ""/);

  for (const id of ["backup-password", "restore-password"]) {
    const field = html.match(new RegExp(`<input id="${id}"[^>]*>`))?.[0];
    assert.ok(field, `${id} must exist`);
    assert.match(field, /type="password"/, "a visible password ends up in a screenshot");
  }
  assert.match(html.match(/<input id="restore-password"[^>]*>/)[0], /autocomplete="off"/);
});

test("the backup download is a byte stream, not JSON, and is not left reachable", () => {
  const run = extractFunction(shell, "runDatabaseBackup");
  // api() parses JSON; the backup's body is the database, so it would fail there.
  assert.match(run, /rawApi\(/);
  assert.match(run, /response\.blob\(\)/);
  assert.doesNotMatch(run, /\bawait api\(/);

  const download = extractFunction(shell, "downloadBackupBlob");
  assert.match(download, /createObjectURL/);
  assert.match(download, /revokeObjectURL/,
    "the blob is the whole database, credentials included; it must not outlive the click");

  const name = extractFunction(shell, "backupFileName");
  assert.match(name, /content-disposition/, "the server names the file; the console should not invent one");
});

test("the archive is encoded in chunks so a real database does not overflow the call", () => {
  const source = extractFunction(shell, "bytesToBase64");
  assert.match(source, /subarray/);
  assert.match(source, /0x8000|32768/,
    "fromCharCode over a whole database exceeds the argument limit and throws");
});

test("a backup password shorter than the minimum is refused before the request", () => {
  const source = extractFunction(shell, "runDatabaseBackup");
  const guard = source.indexOf("password.trim().length < 8");
  const request = source.indexOf("rawApi(");
  assert.notEqual(guard, -1, "a too-short password must be caught");
  assert.ok(guard < request, "the refusal must come before the request, not after");
  // An empty password is a deliberate choice, not a short one.
  assert.match(source, /if \(password && password\.trim\(\)\.length < 8\)/);
});

test("the card is wired end to end", () => {
  for (const ref of [
    "backupCurrentInfo", "backupPassword", "backupRun", "backupStatus",
    "restoreFile", "restorePassword", "restoreAllowSchemaMismatch", "restoreConfirm",
    "restoreVerify", "restoreApply", "restoreStatus", "restoreReport",
    "restorePending", "restorePendingDetail", "restoreCancel",
  ]) {
    assert.match(bootstrap, new RegExp(`const ${ref} = document\\.querySelector`),
      `${ref} must be resolved in bootstrap, like every other console reference`);
  }
  assert.match(events, /backupRun\?\.addEventListener\("click", runDatabaseBackup\)/);
  assert.match(events, /restoreVerify\?\.addEventListener/);
  assert.match(events, /restoreApply\?\.addEventListener/);
  assert.match(events, /restoreCancel\?\.addEventListener\("click", cancelStagedRestore\)/);
  assert.match(css, /\.restore-pending\b/);
  assert.match(css, /\.restore-compare\b/);
  assert.match(css, /\.restore-staged\b/);

  // And the card loads its own state when the settings page does, so a staged
  // restore is visible without a restart being the way to find out.
  const load = extractFunction(shell, "loadSettingsPage");
  assert.match(load, /loadDisasterRecoveryInfo\(\)/);
});

test("the card is marked as the more dangerous of the two migration paths", () => {
  const cardStart = html.indexOf('aria-labelledby="disaster-recovery-title"');
  assert.notEqual(cardStart, -1, "the disaster recovery card must exist");
  const card = html.slice(cardStart, html.indexOf("</section>", cardStart));
  assert.match(card, /高危操作/);
  assert.match(card, /请求日志|管理员令牌/,
    "a restore replaces more than configuration and the card should say what");
  // Apply starts locked in the markup, not only once the script runs.
  assert.match(card.match(/<button id="restore-apply"[^>]*>/)[0], /disabled/);
  // The file picker names the format, so the configuration archive is not offered.
  assert.match(card.match(/<input id="restore-file"[^>]*>/)[0], /accept="\.wtbak"/);
  // The schema override is off by default: the refusal is the safe answer.
  assert.doesNotMatch(card.match(/<input id="restore-allow-schema-mismatch"[^>]*>/)[0], /checked/);
});

test("a failed info load does not report that no restore is staged", () => {
  const source = extractFunction(shell, "loadDisasterRecoveryInfo");
  const catchBlock = source.slice(source.indexOf("} catch (error)"));
  assert.doesNotMatch(catchBlock, /renderPendingRestore/,
    "a failed load says nothing about whether a restore is waiting");
  assert.match(catchBlock, /renderBackupInfo\(null\)/);
});

test("the current database is described before a backup is taken", () => {
  const element = { innerHTML: "" };
  const context = vm.createContext({ backupCurrentInfo: element, escapeHtml });
  vm.runInContext(extractFunction(shell, "formatBytes"), context);
  vm.runInContext(extractFunction(shell, "shortFingerprint"), context);
  vm.runInContext(extractFunction(shell, "renderBackupInfo"), context);
  context.info = {
    app_version: "1.5.0", schema_version: 1, schema_fingerprint: "0123456789abcdef0123",
    size_bytes: 3 * 1024 * 1024 * 1024, page_size: 4096, page_count: 786432,
  };
  vm.runInContext("renderBackupInfo(info)", context);
  assert.match(element.innerHTML, /1\.5\.0/);
  assert.match(element.innerHTML, /0123456789abcdef/);
  // A multi-gigabyte database is the case where the size matters most, so it is not
  // reported as four thousand megabytes.
  assert.match(element.innerHTML, /3\.00 GB/);
  assert.match(element.innerHTML, /786,432 页/);

  vm.runInContext("renderBackupInfo(null)", context);
  assert.match(element.innerHTML, /暂不可用/, "unknown must not render as zero");
});
