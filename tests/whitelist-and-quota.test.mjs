import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);

  const paramEnd = source.indexOf(")", start);
  const bodyStart = source.indexOf("{", paramEnd);
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
  const pattern = new RegExp(`^(?:const|let) ${name} =[\\s\\S]*?;$`, "m");
  const match = pattern.exec(source);
  assert.notEqual(match, null, `${name} must exist`);
  return match[0];
}

function createContext() {
  const bootstrap = read("static/js/bootstrap.js");
  const tokens = read("static/js/tokens.js");

  const context = vm.createContext({
    Intl,
    Date,
    Math,
    Number,
    String,
    Array,
    BigInt,
    Set,
    logSensitiveHidden: false,
    LOG_SENSITIVE_MASK: "******",
    escapeHtml: (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;"),
  });

  vm.runInContext(extractConst(bootstrap, "LOG_TIME_ZONE"), context);
  vm.runInContext(extractConst(bootstrap, "logTimeFormatter"), context);
  vm.runInContext(extractFunction(bootstrap, "parseLogTimestamp"), context);
  vm.runInContext(extractFunction(bootstrap, "consoleZoneFields"), context);
  vm.runInContext(extractFunction(bootstrap, "formatLogTimestamp"), context);

  // Tokens
  vm.runInContext(extractFunction(tokens, "parseAllowedModelsInput"), context);
  vm.runInContext(extractFunction(tokens, "allowedModelsCellMarkup"), context);
  vm.runInContext(extractConst(tokens, "QUOTA_UNITS"), context);
  vm.runInContext(extractFunction(tokens, "formatTokenCount"), context);
  vm.runInContext(extractConst(tokens, "QUOTA_PERIOD_LABELS"), context);
  vm.runInContext(extractFunction(tokens, "quotaCellMarkup"), context);

  return context;
}

test("parseAllowedModelsInput parses models, deduplicates, and validates trailing wildcards", () => {
  const context = createContext();

  const empty = vm.runInContext(`parseAllowedModelsInput("")`, context);
  assert.equal(empty.ok, true);
  assert.deepEqual(Array.from(empty.allowedModels), []);

  const nullVal = vm.runInContext(`parseAllowedModelsInput(null)`, context);
  assert.equal(nullVal.ok, true);
  assert.deepEqual(Array.from(nullVal.allowedModels), []);

  const normal = vm.runInContext(
    `parseAllowedModelsInput("gpt-4o, claude-3-5-sonnet\\nDEEPSEEK-V3, gpt-4o, claude-3-5-*")`,
    context,
  );
  assert.equal(normal.ok, true);
  assert.deepEqual(Array.from(normal.allowedModels), ["gpt-4o", "claude-3-5-sonnet", "DEEPSEEK-V3", "claude-3-5-*"]);

  const innerWildcard = vm.runInContext(`parseAllowedModelsInput("gpt-*-turbo")`, context);
  assert.equal(innerWildcard.ok, false);
  assert.match(innerWildcard.error, /通配符仅支持作为尾缀/);

  const controlChar = vm.runInContext(`parseAllowedModelsInput("gpt-4o\\x07")`, context);
  assert.equal(controlChar.ok, false);
  assert.match(controlChar.error, /控制字符/);

  const tooMany = Array.from({ length: 201 }, (_, i) => `model-${i}`).join(",");
  const limitCheck = vm.runInContext(`parseAllowedModelsInput(${JSON.stringify(tooMany)})`, context);
  assert.equal(limitCheck.ok, false);
  assert.match(limitCheck.error, /最多支持配置 200 项/);
});

test("allowedModelsCellMarkup formats all models, list tags, and overflow badges", () => {
  const context = createContext();

  const allMarkup = vm.runInContext(`allowedModelsCellMarkup([])`, context);
  assert.match(allMarkup, /全部模型/);
  assert.match(allMarkup, /token-model-all/);

  const twoMarkup = vm.runInContext(`allowedModelsCellMarkup(["gpt-4o", "claude-3-5-*"])`, context);
  assert.match(twoMarkup, /gpt-4o/);
  assert.match(twoMarkup, /claude-3-5-\*/);
  assert.doesNotMatch(twoMarkup, /token-model-more/);

  const fourMarkup = vm.runInContext(`allowedModelsCellMarkup(["gpt-4o", "gpt-4o-mini", "claude-3-5-sonnet", "deepseek-chat"])`, context);
  assert.match(fourMarkup, /gpt-4o/);
  assert.match(fourMarkup, /gpt-4o-mini/);
  assert.match(fourMarkup, /\+2/);
  assert.match(fourMarkup, /token-model-more/);
});

test("quotaCellMarkup displays period badge and next reset info", () => {
  const context = createContext();

  const tokenWithoutPeriod = {
    rate_limit: "60/m",
    quota: {
      limit_tokens: 1000000,
      used_tokens: 250000,
      remaining_tokens: 750000,
      limit_expression: "1M",
      exhausted: false,
    },
  };
  const markupNoPeriod = vm.runInContext(`quotaCellMarkup(${JSON.stringify(tokenWithoutPeriod)})`, context);
  assert.doesNotMatch(markupNoPeriod, /quota-period-badge/);
  assert.match(markupNoPeriod, /250K/);

  const tokenWithPeriod = {
    rate_limit: "",
    quota: {
      limit_tokens: 1000000,
      used_tokens: 850000,
      remaining_tokens: 150000,
      limit_expression: "1M",
      exhausted: false,
    },
    quota_period_state: {
      period: "monthly",
      timezone: "Asia/Shanghai",
      period_key: "monthly:2026-08",
      period_start: "2026-08-01T00:00:00+08:00",
      period_end: "2026-09-01T00:00:00+08:00",
      next_reset_at: "2026-09-01T00:00:00+08:00",
    },
  };
  const markupPeriod = vm.runInContext(`quotaCellMarkup(${JSON.stringify(tokenWithPeriod)})`, context);
  assert.match(markupPeriod, /quota-period-badge/);
  assert.match(markupPeriod, /月配额/);
  assert.match(markupPeriod, /下次重置/);
  assert.match(markupPeriod, /Asia\/Shanghai/);
});

test("admin.html and enhancements.css contain all required P2 elements and styles", () => {
  const html = read("static/admin.html");
  const css = read("static/css/enhancements.css");

  // Whitelist in tokens
  assert.match(html, /id="token-allowed-models"/);
  assert.match(html, /id="token-quota-period"/);
  assert.match(html, /id="token-quota-timezone"/);
  assert.match(html, /<th>允许模型<\/th>/);

  // Enhancements CSS
  assert.match(css, /\.token-models-cell/);
  assert.match(css, /\.token-model-tag/);
  assert.match(css, /\.quota-period-badge/);
});

// The cost estimate was removed rather than finished. Asserted here because the
// console reads its own markup at runtime: a leftover card or script tag would
// query elements that no longer exist and a leftover badge would print a price
// this build no longer computes.
test("no trace of the retired cost estimate remains in the console", () => {
  const html = read("static/admin.html");
  const css = read("static/css/enhancements.css");
  const logs = read("static/js/logs.js");

  assert.doesNotMatch(html, /pricing/, "admin.html still references the pricing UI");
  assert.doesNotMatch(css, /pricing|cost-/, "enhancements.css still carries pricing styles");
  assert.doesNotMatch(logs, /cost_micros|预估费用/, "logs.js still renders a cost");
});
