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
  const pricing = read("static/js/pricing.js");
  const logs = read("static/js/logs.js");

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

  // Pricing
  vm.runInContext(extractFunction(pricing, "unitPriceToMicros"), context);
  vm.runInContext(extractFunction(pricing, "formatPricingRate"), context);

  // Logs
  vm.runInContext(extractFunction(logs, "formatLogCostText"), context);
  vm.runInContext(extractFunction(logs, "formatCacheHitRate"), context);
  vm.runInContext(extractFunction(logs, "formatTokens"), context);
  vm.runInContext(extractFunction(logs, "formatLogChannelLabel"), context);
  vm.runInContext(extractFunction(logs, "getLogModelRoute"), context);
  vm.runInContext(extractFunction(logs, "formatLogModelText"), context);
  vm.runInContext(extractFunction(logs, "formatReasoningEffort"), context);
  context.extractLogDetailError = (d) => d.error || "";
  vm.runInContext(extractFunction(logs, "formatFirstTokenTime"), context);
  vm.runInContext(extractFunction(logs, "firstTokenTone"), context);
  vm.runInContext(extractFunction(logs, "formatGatewayPrepTime"), context);
  vm.runInContext(extractFunction(logs, "formatHeadersArrivalTime"), context);
  vm.runInContext(extractFunction(logs, "formatSeconds"), context);
  vm.runInContext(extractFunction(logs, "totalDurationRating"), context);
  vm.runInContext(extractFunction(logs, "formatTotalDurationTime"), context);
  vm.runInContext(extractFunction(logs, "formatTokensPerSecondLine"), context);
  vm.runInContext(extractFunction(logs, "outputTokensPerSecond"), context);
  vm.runInContext(extractFunction(logs, "formatTokenDetailPanel"), context);
  vm.runInContext(extractConst(logs, "FAILURE_STAGE_LABELS"), context);
  vm.runInContext(extractFunction(logs, "formatFailureStage"), context);
  vm.runInContext(extractFunction(logs, "formatLogDetailMeta"), context);

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

test("unitPriceToMicros converts major rate per million tokens to integer micros", () => {
  const context = createContext();

  assert.equal(vm.runInContext(`unitPriceToMicros("2.50")`, context), 2500000);
  assert.equal(vm.runInContext(`unitPriceToMicros("10.00")`, context), 10000000);
  assert.equal(vm.runInContext(`unitPriceToMicros("0.000250")`, context), 250);
  assert.equal(vm.runInContext(`unitPriceToMicros("0")`, context), 0);
  assert.equal(vm.runInContext(`unitPriceToMicros("")`, context), 0);
  assert.equal(vm.runInContext(`unitPriceToMicros(null)`, context), 0);
});

test("formatPricingRate formats rate with currency symbols and decimals", () => {
  const context = createContext();

  assert.equal(vm.runInContext(`formatPricingRate(2500000, "USD")`, context), "$2.50 / 1M");
  assert.equal(vm.runInContext(`formatPricingRate(10000000, "USD")`, context), "$10.00 / 1M");
  assert.equal(vm.runInContext(`formatPricingRate(250, "USD")`, context), "$0.000250 / 1M");
  assert.equal(vm.runInContext(`formatPricingRate(2500000, "CNY")`, context), "¥2.50 / 1M");
  assert.equal(vm.runInContext(`formatPricingRate(null, "USD")`, context), "-");
});

test("formatLogCostText renders '未定价' for unpriced logs and exact formatted currency for priced logs", () => {
  const context = createContext();

  // costMicros == null MUST return "未定价", strictly forbidden to show "$0.00"
  assert.equal(vm.runInContext(`formatLogCostText(null, "USD")`, context), "未定价");
  assert.equal(vm.runInContext(`formatLogCostText(undefined, "USD")`, context), "未定价");
  assert.equal(vm.runInContext(`formatLogCostText("invalid", "USD")`, context), "未定价");

  // Zero & standard rates
  assert.equal(vm.runInContext(`formatLogCostText(0, "USD")`, context), "$0.00");
  assert.equal(vm.runInContext(`formatLogCostText(2500000, "USD")`, context), "$2.50");
  assert.equal(vm.runInContext(`formatLogCostText(125000, "USD")`, context), "$0.13");

  // Small fraction of a cent (< 10000 micros) retains 6 decimal digits
  assert.equal(vm.runInContext(`formatLogCostText(250, "USD")`, context), "$0.000250");
  assert.equal(vm.runInContext(`formatLogCostText(15, "USD")`, context), "$0.000015");

  // CNY
  assert.equal(vm.runInContext(`formatLogCostText(2500000, "CNY")`, context), "¥2.50");
  assert.equal(vm.runInContext(`formatLogCostText(250, "CNY")`, context), "¥0.000250");

  // Negative
  assert.equal(vm.runInContext(`formatLogCostText(-2500000, "USD")`, context), "-$2.50");
});

test("formatTokens and formatLogDetailMeta render cost badge and disclaimer card", () => {
  const context = createContext();

  const logPriced = {
    prompt_tokens: 1000,
    completion_tokens: 200,
    total_tokens: 1200,
    prompt_cached_tokens: 0,
    completion_reasoning_tokens: 0,
    cost_micros: 2500000,
    cost_currency: "USD",
    pricing_rule_id: 42,
  };

  const tokensMarkup = vm.runInContext(`formatTokens(${JSON.stringify(logPriced)})`, context);
  assert.match(tokensMarkup, /log-token-cost-badge/);
  assert.match(tokensMarkup, /\$2\.50/);
  assert.match(tokensMarkup, /规则版本 #42/);

  const detailPriced = {
    ...logPriced,
    id: 101,
    status_code: 200,
    stream: false,
    duration_ms: 500,
    channel_name: "OpenAI-Main",
    model: "gpt-4o",
    method: "POST",
    path: "v1/chat/completions",
  };

  const metaMarkup = vm.runInContext(`formatLogDetailMeta(${JSON.stringify(detailPriced)})`, context);
  assert.match(metaMarkup, /log-detail-cost-card/);
  assert.match(metaMarkup, /预估费用/);
  assert.match(metaMarkup, /\$2\.50/);
  assert.match(metaMarkup, /定价规则：版本 #42/);
  assert.match(metaMarkup, /估算金额，不等同于供应商最终账单/);

  const detailUnpriced = {
    ...detailPriced,
    cost_micros: null,
    cost_currency: null,
    pricing_rule_id: null,
  };
  const unpricedMeta = vm.runInContext(`formatLogDetailMeta(${JSON.stringify(detailUnpriced)})`, context);
  assert.match(unpricedMeta, /未定价/);
  assert.doesNotMatch(unpricedMeta, /\$0\.00/);
});

test("admin.html and enhancements.css contain all required P2 elements and styles", () => {
  const html = read("static/admin.html");
  const css = read("static/css/enhancements.css");

  // Whitelist in tokens
  assert.match(html, /id="token-allowed-models"/);
  assert.match(html, /id="token-quota-period"/);
  assert.match(html, /id="token-quota-timezone"/);
  assert.match(html, /<th>允许模型<\/th>/);

  // Pricing in settings
  assert.match(html, /id="pricing-settings-title"/);
  assert.match(html, /id="pricing-rule-rows"/);
  assert.match(html, /id="new-pricing-rule-button"/);
  assert.match(html, /id="pricing-rule-dialog"/);
  assert.match(html, /id="pricing-model-pattern"/);
  assert.match(html, /<script src="\/static\/js\/pricing\.js"><\/script>/);

  // Enhancements CSS
  assert.match(css, /\.token-models-cell/);
  assert.match(css, /\.token-model-tag/);
  assert.match(css, /\.quota-period-badge/);
  assert.match(css, /\.pricing-table-wrap/);
  assert.match(css, /\.pricing-model-code/);
  assert.match(css, /\.log-token-cost-badge/);
  assert.match(css, /\.log-detail-cost-card/);
  assert.match(css, /\.log-cost-disclaimer/);
});
