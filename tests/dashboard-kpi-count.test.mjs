import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

/* 看板 KPI 数字滚动的覆盖范围与格式契约。

   动画引擎逐帧调用 formatKpiCount(插值, format)，所以卡面上那串静态文本必须
   正好是 formatKpiCount(data-count-to, format) 的输出——差一档，滚动结束的瞬间
   数字就会再跳一下。这里把这条不变量对每种卡都验一遍。 */

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} must exist`);
  // 从参数表右括号后的 `{` 起算，否则 `placeholder = "—"` 这类默认值里的括号
  // 会先把计数配平。
  let paramDepth = 0;
  let paramEnd = -1;
  for (let i = start + `function ${name}`.length; i < source.length; i += 1) {
    if (source[i] === "(") paramDepth += 1;
    else if (source[i] === ")") {
      paramDepth -= 1;
      if (paramDepth === 0) {
        paramEnd = i;
        break;
      }
    }
  }
  const bodyStart = source.indexOf("{", paramEnd);
  let depth = 0;
  for (let i = bodyStart; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`could not extract ${name}`);
}

const bootstrapJs = read("static/js/bootstrap.js");
const dashboardJs = read("static/js/dashboard.js");

function kpiContext(extraNames = []) {
  const names = [
    "formatCompactNumber",
    "cnUnitDecimals",
    "formatChineseUnit",
    "formatCacheHitPercent",
    "formatDashboardCacheHitRate",
    "formatKpiCount",
    "kpiCountHtml",
    ...extraNames,
  ];
  /* formatChineseUnit 读一张模块级的单位表，只搬函数进来它会 ReferenceError。
     照搬源码里那段声明，别在用例里另抄一份阈值——抄一份就有两个真相。 */
  const cnUnits = /const CN_UNITS = \[[\s\S]*?\n\];/.exec(dashboardJs);
  assert.ok(cnUnits, "CN_UNITS 声明应能从源码里取到");
  const sources = [
    extractFunction(bootstrapJs, "escapeHtml"),
    cnUnits[0],
    ...names.map((name) => extractFunction(dashboardJs, name)),
  ];
  const exports = names.map((name) => `this.${name} = ${name};`).join("\n");
  const context = vm.createContext({});
  vm.runInContext(`${sources.join("\n")}\n${exports}`, context);
  return context;
}

/* 解析 kpiCountHtml 的产物。滚动动画只认这三个属性，用例直接对着它们断言。 */
function parseCountNode(html) {
  const key = html.match(/data-count-key="([^"]*)"/);
  const to = html.match(/data-count-to="([^"]*)"/);
  const format = html.match(/data-count-format="([^"]*)"/);
  const text = html.match(/>([^<]*)<\/span>/);
  return {
    key: key?.[1] ?? null,
    to: to ? Number(to[1]) : null,
    format: format?.[1] ?? null,
    text: text?.[1] ?? null,
  };
}

test("formatKpiCount 覆盖秒数与缓存率两种新格式", () => {
  const { formatKpiCount } = kpiContext();

  // 平均耗时固定一位小数，1.0s 不省略小数位（和卡面静态写法一致）。
  assert.equal(formatKpiCount(1, "seconds1"), "1.0s");
  assert.equal(formatKpiCount(2.34, "seconds1"), "2.3s");
  assert.equal(formatKpiCount(0.049, "seconds1"), "0.0s");

  // 缓存率分档：0 不带小数，10% 以下一位小数，10% 以上取整。
  assert.equal(formatKpiCount(0, "cacheRate"), "0%");
  assert.equal(formatKpiCount(4.26, "cacheRate"), "4.3%");
  assert.equal(formatKpiCount(42.9, "cacheRate"), "43%");
});

test("formatKpiCount 的 cacheRate 与静态命中率同源", () => {
  const { formatKpiCount, formatDashboardCacheHitRate } = kpiContext();
  const cases = [[0, 700], [30, 700], [300, 700], [699, 700], [700, 700]];
  for (const [hit, input] of cases) {
    const percent = (hit / input) * 100;
    assert.equal(
      formatKpiCount(percent, "cacheRate"),
      formatDashboardCacheHitRate(hit, input),
      `${hit}/${input} 两条路径必须给出同一串文本`,
    );
  }
});

test("kpiCountHtml 的卡面文本正好是滚动最后一帧的输出", () => {
  const { kpiCountHtml, formatKpiCount } = kpiContext();
  const cases = [
    [12_345, "compact"],
    [9.9996, "percent"],
    [10.04, "cacheRate"],
    [1.2499, "seconds1"],
    [7, "plain"],
  ];
  for (const [value, format] of cases) {
    const node = parseCountNode(kpiCountHtml("k", value, format));
    assert.equal(node.format, format);
    assert.equal(
      node.text,
      formatKpiCount(node.to, format),
      `${value} (${format}) 的静态文本与 formatKpiCount(data-count-to) 不一致，滚完会跳一下`,
    );
  }
});

/* k/M 是按一千进位的，中文按一万进位，两套刻度对不上：202.2M 要在脑子里还原成
   202200000 再切一次才读得出"2 亿多"。这一档换算就是替人做这一步。 */
test("formatChineseUnit 按万/亿换算，一万以下不换算", () => {
  const { formatChineseUnit } = kpiContext();

  // 一万以下卡面就是精确整数，再写一遍"≈"反而像是另一个数。
  for (const small of [0, 1, 999, 9_999]) {
    assert.equal(formatChineseUnit(small), "", `${small} 不该换算`);
  }

  assert.equal(formatChineseUnit(10_000), "1万");
  assert.equal(formatChineseUnit(202_200_000), "2.02亿", "用户点名的这个数");
  assert.equal(formatChineseUnit(10_000_000), "1000万", "10M 读作一千万");

  /* 小数位数跟着量级走，图的是和主数字相当的有效位数：固定两位的话 12.3M 会换出
     1234.57万，六位有效数字摆在三位有效数字的主数字旁边，只是更长不是更准。 */
  assert.equal(formatChineseUnit(12_345_678), "1235万");
  assert.equal(formatChineseUnit(1_234_567_890), "12.3亿");
  assert.equal(formatChineseUnit(98_765_432_100), "988亿");

  // 末尾的零去掉：1000.0万 不该写成那样。
  assert.equal(formatChineseUnit(20_220_000), "2022万");
  assert.equal(formatChineseUnit(100_000_000), "1亿");

  for (const empty of [null, undefined, NaN, Infinity]) {
    assert.equal(formatChineseUnit(empty), "", "拿不到数就不写换算");
  }
});

/* 挑单位这一步曾经写错过：判据是"round 完还大于等于 1 就用这一档"，于是
   5000万–1亿 整段都被推去写成带前导零的亿——82.9M 换出 0.83亿，比它要解释的
   82.9M 还难读。判据应该是"这一档的尾数装不下了才进上一档"。 */
test("万装得下就不写成零点几亿，装不下才进位", () => {
  const { formatChineseUnit } = kpiContext();

  // 这一整段的尾数都在 10000 以内，"万"装得下。
  assert.equal(formatChineseUnit(50_000_000), "5000万");
  assert.equal(formatChineseUnit(82_900_000), "8290万", "82.9M 不该写成 0.83亿");
  assert.equal(formatChineseUnit(99_000_000), "9900万");
  assert.equal(formatChineseUnit(99_500_000), "9950万");

  /* 交界处：尾数 round 到 10000 才进"亿"档。10000万 是个进位没进上去的写法，
     不该出现。 */
  assert.equal(formatChineseUnit(99_994_999), "9999万");
  assert.equal(formatChineseUnit(99_995_000), "1亿");
  assert.equal(formatChineseUnit(99_999_999), "1亿");

  // 任何量级都不该写出"10000万"这种没进上去的形式。
  for (let n = 10_000; n <= 200_000_000; n = Math.round(n * 1.037)) {
    const text = formatChineseUnit(n);
    assert.ok(!/^10000万/.test(text), `${n} 换出了没进位的 ${text}`);
    assert.ok(!/^0\./.test(text), `${n} 换出了带前导零的 ${text}`);
  }

  // 负数走同一套（Tokens 不会是负的，但这个函数不该在这里出意外）。
  assert.equal(formatChineseUnit(-82_900_000), "-8290万");
});

test("cnunit 这一档的滚动格式自带约等号，且与静态换算同源", () => {
  const { formatKpiCount, formatChineseUnit } = kpiContext();

  /* 约等号在 formatKpiCount 里拼，不写死在模板上：滚动动画整节点重写
     textContent，留在模板里第一帧就被抹掉。 */
  assert.equal(formatKpiCount(202_200_000, "cnunit"), "≈2.02亿");
  assert.equal(formatKpiCount(10_000_000, "cnunit"), "≈1000万");

  // 一万以下这一档没有换算，滚到这里应该是空串，而不是一个孤零零的"≈"。
  assert.equal(formatKpiCount(9_999, "cnunit"), "");
  assert.equal(formatKpiCount(0, "cnunit"), "");

  for (const value of [10_000, 12_345_678, 202_200_000, 1_234_567_890]) {
    assert.equal(
      formatKpiCount(value, "cnunit"),
      `≈${formatChineseUnit(value)}`,
      "两条路径必须给出同一串文本",
    );
  }
});

test("Tokens 卡的换算跟主数字一起滚，且是独立的 count key", () => {
  const context = kpiContext(["tokenUsageCard"]);
  const card = context.tokenUsageCard(
    "7d Tokens",
    { total_tokens: 202_200_000, request_count: 4_321 },
    "最近 7 天",
  );

  // 主数字仍是 k/M，换算跟在后面，压小降灰但同样带 data-count-to。
  const nodes = [...card.valueHtml.matchAll(
    /<span class="([^"]*)" data-count-key="([^"]*)" data-count-to="([^"]*)" data-count-format="([^"]*)">([^<]*)<\/span>/g,
  )];
  assert.equal(nodes.length, 2, "主数字和换算各是一个可滚节点");

  const [main, approx] = nodes;
  assert.equal(main[2], "token-usage:7d Tokens");
  assert.equal(main[4], "compact");
  assert.equal(main[5], "202.2M");

  assert.equal(approx[1], "kpi-number kpi-approx", "类名可加不可换，换算也要滚");
  assert.equal(approx[2], "token-usage-cn:7d Tokens", "和主数字不同 key，否则互相串号");
  assert.equal(approx[4], "cnunit");
  assert.equal(approx[5], "≈2.02亿");

  /* 两个节点喂同一个目标值：滚动同源，主数字滚到一半时换算不会停在上一轮的量级。 */
  assert.equal(approx[3], main[3], "同一个 target，两串数字才不会有半秒对不上");

  // card.value 是无 valueHtml 的降级路径用的，仍只是主数字。
  assert.equal(card.value, "202.2M");
});

test("一万以下的 Tokens 卡不挂换算节点，不留空标签", () => {
  const context = kpiContext(["tokenUsageCard"]);
  const card = context.tokenUsageCard("Tokens", { total_tokens: 9_999, request_count: 3 }, "范围");
  assert.equal(card.value, "9999");
  assert.ok(!card.valueHtml.includes("kpi-approx"), "这一档卡面已是精确整数，不换算");
  assert.ok(!card.valueHtml.includes("token-usage-cn"), "连 key 都不该留");
});

test("换算那串有自己的压小降灰样式", () => {
  const dashboardCss = read("static/css/dashboard.css");
  const rule = /\.kpi-approx\s*\{([^}]*)\}/.exec(dashboardCss);
  assert.ok(rule, ".kpi-approx 应有样式");
  assert.match(rule[1], /color:\s*var\(--muted\);/, "降灰，不跟主数字抢视线");
  // em 而不是 px：跟着 .dashboard-kpi-value 的 clamp 一起缩放。
  assert.match(rule[1], /font-size:\s*0\.\d+em;/, "字号用 em 才会跟着主数字缩放");
  assert.match(rule[1], /white-space:\s*nowrap;/);
});

test("kpiCountHtml 在无数据时只留 key，不留 data-count-to", () => {
  const { kpiCountHtml } = kpiContext();
  for (const empty of [null, undefined, NaN, Infinity]) {
    const node = parseCountNode(kpiCountHtml("k", empty, "percent"));
    assert.equal(node.key, "k");
    assert.equal(node.to, null, "没有目标值，引擎才会清掉记忆");
    assert.equal(node.format, null);
    assert.equal(node.text, "—");
  }
});

test("Tokens / 缓存率 / 请求 三种卡都带上滚动数字", () => {
  const context = kpiContext(["tokenUsageCard", "cacheHitRateCard", "requestCountCard"]);
  const usage = {
    total_tokens: 1_234_567,
    request_count: 42,
    prompt_cached_tokens: 300,
    prompt_tokens: 700,
    all_request_count: 88,
  };

  const tokens = parseCountNode(context.tokenUsageCard("Tokens", usage, "最近 24 小时").valueHtml);
  assert.equal(tokens.key, "token-usage:Tokens");
  assert.equal(tokens.to, 1_234_567);
  assert.equal(tokens.format, "compact");

  const cache = parseCountNode(context.cacheHitRateCard("缓存率", usage, "最近 24 小时").valueHtml);
  assert.equal(cache.key, "cache-rate:缓存率");
  assert.equal(cache.format, "cacheRate");
  assert.equal(cache.text, "43%");

  const requests = parseCountNode(context.requestCountCard("请求", usage, "最近 24 小时").valueHtml);
  assert.equal(requests.key, "request-count:请求");
  assert.equal(requests.to, 88);
  assert.equal(requests.format, "compact");
});

test("卡面文本与 card.value 保持一致，方便无 valueHtml 的降级路径", () => {
  const context = kpiContext(["tokenUsageCard", "cacheHitRateCard", "requestCountCard"]);
  const usage = {
    total_tokens: 20_500,
    prompt_cached_tokens: 120,
    prompt_tokens: 4_000,
    all_request_count: 9_999,
  };
  for (const card of [
    context.tokenUsageCard("Tokens", usage, "范围"),
    context.cacheHitRateCard("缓存率", usage, "范围"),
    context.requestCountCard("请求", usage, "范围"),
  ]) {
    assert.equal(parseCountNode(card.valueHtml).text, card.value, `${card.label} 两处文本应一致`);
  }
});

test("缓存率没有输入 token 时不给目标值", () => {
  const context = kpiContext(["cacheHitRateCard"]);
  const card = context.cacheHitRateCard("缓存率", { prompt_tokens: 0 }, "范围");
  const node = parseCountNode(card.valueHtml);
  assert.equal(card.value, "—");
  assert.equal(node.to, null);
  assert.equal(node.text, "—");
});

test("多窗口模式下五张同类卡的 count key 互不相同", () => {
  const context = kpiContext(["tokenUsageCard", "cacheHitRateCard", "requestCountCard"]);
  const labels = ["今天 Tokens", "1d Tokens", "7d Tokens", "30d Tokens", "全部 Tokens"];
  const usage = { total_tokens: 10, prompt_cached_tokens: 1, prompt_tokens: 2, all_request_count: 3 };
  const keys = [
    ...labels.map((label) => parseCountNode(context.tokenUsageCard(label, usage, "s").valueHtml).key),
    ...labels.map((label) => parseCountNode(context.cacheHitRateCard(label, usage, "s").valueHtml).key),
    ...labels.map((label) => parseCountNode(context.requestCountCard(label, usage, "s").valueHtml).key),
  ];
  assert.equal(new Set(keys).size, keys.length, "key 撞号会让不同窗口的数字互相滚");
});

test("看板每张有数字的 KPI 卡都接上了滚动", () => {
  // 覆盖范围靠源码断言：这些 key 出现在 renderDashboard 的卡片定义里。
  const expectedKeys = [
    "dashboard-requests",
    "dashboard-error-rate",
    "dashboard-avg-duration",
    "dashboard-enabled-channels",
    "runtime-active-sse",
    "runtime-sse-disconnects",
    "runtime-log-queue",
  ];
  for (const key of expectedKeys) {
    assert.ok(
      dashboardJs.includes(`kpiCountHtml("${key}"`),
      `${key} 应该经过 kpiCountHtml`,
    );
  }
  // 清理任务显示"运行中/空闲"，没有可滚的数字，不该被硬塞进来。
  assert.ok(
    !dashboardJs.includes('kpiCountHtml("runtime-cleanup"'),
    "非数值卡不参与滚动",
  );
});

test("延迟摘要六项都接上滚动，且与 formatSeconds 的写法一致", () => {
  const { kpiCountHtml, formatKpiCount } = kpiContext();
  // renderDashboard 里的 latencyNumber：毫秒 → 秒，seconds1。
  const latencyNumber = (key, ms) => kpiCountHtml(
    `latency-${key}`,
    ms == null ? null : Number(ms) / 1000,
    "seconds1",
  );
  // logs.js 的 formatSeconds，延迟摘要原来的写法，两边必须给出同一串文本。
  const formatSeconds = (ms) => (ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`);

  for (const ms of [0, 12, 850, 1500, 9_999, 123_456]) {
    const node = parseCountNode(latencyNumber("avg", ms));
    assert.equal(node.format, "seconds1");
    assert.equal(node.text, formatSeconds(ms), `${ms}ms 的写法与 formatSeconds 不一致`);
    assert.equal(node.text, formatKpiCount(node.to, "seconds1"));
  }

  // 分位数缺失时只留 key。
  const missing = parseCountNode(latencyNumber("p99", null));
  assert.equal(missing.key, "latency-p99");
  assert.equal(missing.to, null);
  assert.equal(missing.text, "—");

  // 六项都在源码里接上了，范围那格是 min–max 两个节点。
  for (const key of ["latest", "avg", "min", "max", "p50", "p95", "p99"]) {
    assert.ok(
      dashboardJs.includes(`latencyNumber("${key}"`),
      `延迟摘要的 ${key} 应经过 latencyNumber`,
    );
  }
  assert.ok(
    dashboardJs.includes("animateKpiNumbers(dashboardLatencyChart)"),
    "延迟摘要不经过 KPI 构建器，得手动扫一次才会滚",
  );
});

/* 引擎本身的两条行为。之前只有源码断言，但"上一轮有、这一轮没有就清记忆"
   才是分位数缺失/范围内无请求时不从陈旧值滚起的依据。 */
function animateContext() {
  const names = ["formatCompactNumber", "formatCacheHitPercent", "formatKpiCount", "dropKpiNumberKey", "animateKpiNumbers"];
  const frames = [];
  let now = 0;
  const context = vm.createContext({
    window: {
      matchMedia: () => ({ matches: false }),
      requestAnimationFrame: (cb) => frames.push(cb),
      cancelAnimationFrame: () => {},
    },
    performance: { now: () => now },
  });
  vm.runInContext(`
    const kpiNumberMemory = new Map();
    const kpiNumberFrames = new Map();
    const kpiNumberContainerKeys = new Map();
    const KPI_COUNT_DURATION_MS = 560;
    ${names.map((name) => extractFunction(dashboardJs, name)).join("\n")}
    this.animateKpiNumbers = animateKpiNumbers;
    this.readMemory = (key) => kpiNumberMemory.get(key);
  `, context);
  return {
    animate: context.animateKpiNumbers,
    readMemory: context.readMemory,
    frames,
    setNow: (value) => { now = value; },
  };
}

const countNode = (key, to, format) => ({
  dataset: to == null ? { countKey: key } : { countKey: key, countTo: String(to), countFormat: format },
  isConnected: true,
  textContent: "",
});

test("上一轮出现过的 count key 本轮消失时记忆被清掉", () => {
  const { animate, readMemory } = animateContext();
  const nodes = [countNode("latency-p95", 1.5, "seconds1")];
  const container = { querySelectorAll: () => nodes };

  animate(container);
  assert.equal(readMemory("latency-p95"), 1.5);

  // 范围内没有有效耗时，整块摘要被换成空提示，容器里一个 key 都不剩。
  nodes.length = 0;
  animate(container);
  assert.equal(readMemory("latency-p95"), undefined, "记忆没清掉，数据回来时会从旧值滚起");
});

test("本轮显示 — 时同样清掉记忆", () => {
  const { animate, readMemory } = animateContext();
  const nodes = [countNode("latency-p99", 2, "seconds1")];
  const container = { querySelectorAll: () => nodes };

  animate(container);
  assert.equal(readMemory("latency-p99"), 2);

  nodes[0] = countNode("latency-p99", null);
  animate(container);
  assert.equal(readMemory("latency-p99"), undefined);
});

test("滚动逐帧写出合法格式，最后一帧落在目标值上", () => {
  const { animate, frames, setNow } = animateContext();
  const first = countNode("latency-avg", 1.5, "seconds1");
  let nodes = [first];
  const container = { querySelectorAll: () => nodes };

  // 第一轮只记数值，没有起点可滚。
  animate(container);
  assert.equal(frames.length, 0, "首轮不该起动画");

  const second = countNode("latency-avg", 3, "seconds1");
  nodes = [second];
  setNow(0);
  animate(container);
  assert.equal(frames.length, 1);

  // 半程：缓动后 1.5 + 1.5 * 0.875 = 2.8125，写出来是 2.8s 而不是长浮点。
  frames.shift()(280);
  assert.equal(second.textContent, "2.8s");

  // 末帧正好是目标值的格式化结果。
  frames.shift()(560);
  assert.equal(second.textContent, "3.0s");
  assert.equal(frames.length, 0, "跑到 100% 后不该再排帧");
});

test("启用渠道只滚分子，分母仍是静态的缩小样式", () => {
  const marker = 'kpiCountHtml("dashboard-enabled-channels", enabledCount, "plain")';
  const index = dashboardJs.indexOf(marker);
  assert.notEqual(index, -1, "分子应经过 kpiCountHtml");
  const tail = dashboardJs.slice(index + marker.length, index + marker.length + 120);
  assert.ok(tail.includes('class="kpi-denominator"'), "分母紧跟在后面，且不带 data-count-key");
  assert.ok(!tail.slice(0, tail.indexOf("</span>") + 7).includes("data-count-key"));
});
