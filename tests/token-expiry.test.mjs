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
      if (depth === 0) return source.slice(start, index + 1);
    }
  }

  throw new Error(`could not extract ${name}`);
}

function extractConst(source, name) {
  const pattern = new RegExp(`^const ${name} =[\\s\\S]*?;$`, "m");
  const match = pattern.exec(source);
  assert.notEqual(match, null, `${name} must exist`);
  return match[0];
}

/**
 * The parser plus the console-timezone helpers it leans on, in a context with
 * no DOM. `Intl` and `Date` come from the host, so absolute times resolve
 * against the same zone the console renders in.
 */
function expiryContext() {
  const tokens = read("static/js/tokens.js");
  const bootstrap = read("static/js/bootstrap.js");
  const context = vm.createContext({ Intl, Date });

  vm.runInContext(extractConst(bootstrap, "LOG_TIME_ZONE"), context);
  vm.runInContext(extractConst(bootstrap, "logTimeFormatter"), context);
  vm.runInContext(extractFunction(bootstrap, "consoleZoneFields"), context);
  vm.runInContext(extractFunction(bootstrap, "consoleWallClockToTimestamp"), context);
  vm.runInContext(extractFunction(bootstrap, "toStoredTimestamp"), context);

  vm.runInContext(extractConst(tokens, "EXPIRY_UNIT_SECONDS"), context);
  vm.runInContext(extractConst(tokens, "EXPIRY_ABSOLUTE_PATTERN"), context);
  vm.runInContext(extractConst(tokens, "EXPIRY_INPUT_HINT"), context);
  vm.runInContext(extractConst(tokens, "EXPIRY_INPUT_ERROR"), context);
  vm.runInContext(extractConst(tokens, "EXPIRY_SOON_MS"), context);
  vm.runInContext(extractFunction(tokens, "parseExpiryInput"), context);
  vm.runInContext(extractFunction(tokens, "formatExpiryDistance"), context);
  vm.runInContext(extractFunction(tokens, "expiryBadgeTone"), context);

  const now = Date.UTC(2026, 7, 8, 0, 0, 0);
  return {
    now,
    parse: (raw) =>
      vm.runInContext(`parseExpiryInput(${JSON.stringify(raw)}, ${now})`, context),
    call: (expression) => vm.runInContext(expression, context),
  };
}

test("a duration expression adds up its segments", () => {
  const { now, parse } = expiryContext();
  const hour = 3600 * 1000;

  const cases = [
    ["30s", 30 * 1000],
    ["90m", 90 * 60 * 1000],
    ["3h", 3 * hour],
    ["30d", 30 * 24 * hour],
    ["2w", 14 * 24 * hour],
    ["1d3h", 27 * hour],
    ["1d 3h 30m", 27 * hour + 30 * 60 * 1000],
    ["1D3H", 27 * hour],
  ];

  for (const [input, expected] of cases) {
    const parsed = parse(input);
    assert.equal(parsed.ok, true, `${input} must parse`);
    assert.equal(parsed.expiresAtMs - now, expected, `${input} must span ${expected}ms`);
  }
});

test("a blank expiry means never expires, not zero", () => {
  const { parse } = expiryContext();
  // Field by field: objects built inside the vm context do not share the
  // host's Object prototype, so a deep-equal against a host literal fails.
  for (const input of ["", "   "]) {
    const parsed = parse(input);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.expiresAtMs, null);
  }
});

test("ambiguous or malformed durations are refused rather than guessed", () => {
  const { parse } = expiryContext();

  for (const input of [
    "30", // no unit — 30 days or 30 minutes has no unambiguous answer
    "1d2d", // the same unit twice
    "1d3x", // unknown unit
    "d3", // unit before its number
    "1d3h junk",
    "0d", // a zero-length validity is never what anyone means
    "tomorrow",
    "-1d",
  ]) {
    assert.equal(parse(input).ok, false, `${input} must be refused`);
  }
});

test("an absolute time is read in the console's timezone, not the browser's", () => {
  const { parse, call } = expiryContext();

  // Rendering the parsed instant back through the console's own formatter must
  // return the reading that was typed — that round trip is the whole contract.
  for (const [input, expected] of [
    ["2026-09-01 12:00:00", "2026-09-01 12:00:00"],
    ["2026-09-01 12:00", "2026-09-01 12:00:00"],
    ["2026-09-01", "2026-09-01 00:00:00"],
  ]) {
    const parsed = parse(input);
    assert.equal(parsed.ok, true, `${input} must parse`);
    const zoned = call(`consoleZoneFields(${parsed.expiresAtMs})`);
    const pad = (value) => String(value).padStart(2, "0");
    const rendered =
      `${zoned.year}-${pad(zoned.month)}-${pad(zoned.day)} ` +
      `${pad(zoned.hour)}:${pad(zoned.minute)}:${pad(zoned.second)}`;
    assert.equal(rendered, expected);
  }
});

test("impossible calendar readings do not roll forward silently", () => {
  const { parse } = expiryContext();
  for (const input of ["2026-02-31", "2026-13-01", "2026-09-01 24:00", "2026-09-01 12:60"]) {
    assert.equal(parse(input).ok, false, `${input} must be refused`);
  }
});

test("what the server stores round-trips back to the same instant", () => {
  const { parse, call } = expiryContext();
  const parsed = parse("1d3h");
  const stored = call(`toStoredTimestamp(${parsed.expiresAtMs})`);

  assert.match(stored, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(Date.parse(`${stored.replace(" ", "T")}Z`), parsed.expiresAtMs);
});

test("remaining time reads down to the unit that still matters", () => {
  const { call } = expiryContext();
  const minute = 60 * 1000;

  for (const [deltaMs, expected] of [
    [-1, "已过期"],
    [0, "已过期"],
    [30 * 1000, "不到 1 分钟"],
    [5 * minute, "5 分钟后"],
    [90 * minute, "1 小时后"],
    [23 * 60 * minute, "23 小时后"],
    [3 * 24 * 60 * minute, "3 天后"],
  ]) {
    assert.equal(call(`formatExpiryDistance(${deltaMs})`), expected);
  }
});

test("the expiry badge warns before the token lapses, not after", () => {
  const { call } = expiryContext();
  const day = 24 * 60 * 60 * 1000;

  assert.equal(call(`expiryBadgeTone(${-day})`), "danger");
  assert.equal(call("expiryBadgeTone(0)"), "danger");
  assert.equal(call(`expiryBadgeTone(${3 * day})`), "neutral");
  assert.equal(call(`expiryBadgeTone(${30 * day})`), "on");
});

test("a form field toggled hidden from script actually disappears", () => {
  // `.field { display: grid }` outranks the UA stylesheet's [hidden] rule, so
  // without an explicit override the created-token readout and the
  // custom-token row stay on screen in every dialog that hides them.
  const css = read("static/css/forms-dialogs.css");
  assert.match(css, /\.field\[hidden\]\s*\{\s*display:\s*none;/);

  const markup = read("static/admin.html");
  for (const id of ["token-value-row", "token-custom-row"]) {
    const tag = new RegExp(`<[a-z]+ id="${id}"[^>]*>`).exec(markup)?.[0];
    assert.notEqual(tag, undefined, `${id} must exist`);
    assert.match(tag, /class="[^"]*\bfield\b/, `${id} relies on the .field rule`);
  }
});

test("the token table header and its body cells agree on the column count", () => {
  const markup = read("static/admin.html");
  const table = markup.slice(
    markup.indexOf('<table class="admin-table token-table">'),
    markup.indexOf('<tbody id="token-rows">'),
  );
  const headerCount = [...table.matchAll(/<th[\s>]/g)].length;

  const source = read("static/js/tokens.js");
  // 名称、描述、令牌预览、分组、限额、有效期、状态、操作
  assert.equal(headerCount, 8);
  assert.match(source, /skeletonRowsMarkup\(8, 5\)/);
  assert.match(source, /emptyStateCell\(8, \{/);
  assert.match(source, /noMatchStateCell\(8, \{/);
});
