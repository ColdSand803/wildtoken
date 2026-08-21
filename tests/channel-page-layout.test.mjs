import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

/* 渠道页这一轮的版面调整：路由说明搬进面板抬头（见 upstream-routing-strategy）、
   最近测活并进数字条、「列」和那三个选择控件跟着视图收起、6h 请求量的 hover 点
   回到曲线上。前三条是"什么在哪儿"，只有结构能证明；最后一条是几何。 */

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `${name} 不在源码里`);
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
  throw new Error(`${name} 的函数体没有闭合`);
}

const adminHtml = read("static/admin.html");
const baseCss = read("static/css/base.css");
const bootstrapJs = read("static/js/bootstrap.js");
const enhancementsCss = read("static/css/enhancements.css");
const responsiveCss = read("static/css/responsive.css");
const upstreamsJs = read("static/js/upstreams.js");

const indexIn = (markup, needle, from = 0) => {
  const index = markup.indexOf(needle, from);
  assert.notEqual(index, -1, `${needle} 不在标记里`);
  return index;
};

/* ── 最近测活并进数字条 ─────────────────────────────────────── */

test("最近测活是数字条最右边的一格，排在有效权重为 0 之后", () => {
  const stripStart = indexIn(adminHtml, '<div class="summary-strip"');
  const strip = adminHtml.slice(stripStart, indexIn(adminHtml, "</div>", indexIn(adminHtml, 'id="upstream-probe-summary"')));

  assert.ok(strip.includes('id="upstream-summary"'), "四个数字格在条里");
  assert.ok(strip.includes('id="upstream-probe-summary"'), "测活也在同一条里");
  assert.ok(
    strip.indexOf('id="upstream-summary"') < strip.indexOf('id="upstream-probe-summary"'),
    "测活排在数字格右边",
  );

  // 两块各自整块重写 innerHTML，所以必须是两个容器，而不是合进同一个。
  assert.ok(
    /<div id="upstream-summary" class="summary-strip-cells"><\/div>/.test(adminHtml),
    "数字格自己一个容器且初始为空",
  );
});

test("数字格容器不参与布局，窄屏那套分割线规则才不用改", () => {
  // display: contents —— 四个 span 直接落在 .summary-strip 这条 flex/grid 上。
  assert.match(baseCss, /\.summary-strip-cells\s*\{[^}]*display:\s*contents;/);

  /* 测活那格的框、背景、外边距交给 .summary-strip 统一给，自己只剩内边距和
     一条左分割线——画在自己左边，收起时才不会剩一条悬空的竖线。
     行首锚定：紧凑密度那条 html[data-density="compact"] .upstream-probe-summary
     排在文件更前面，不锚会先撞上它。 */
  const probeRule = /^\.upstream-probe-summary\s*\{([^}]*)\}/m.exec(enhancementsCss);
  assert.ok(probeRule, "probe summary 有样式");
  assert.ok(probeRule[1].includes("border-left"), "分割线画在自己左边");
  assert.ok(!probeRule[1].includes("background"), "背景由外层条带给");
  assert.ok(!probeRule[1].includes("margin"), "不再自己撑外边距");
  // 靠 hidden 收起，而 display 是作者样式，压过 UA 的 [hidden]{display:none}。
  assert.match(enhancementsCss, /\.upstream-probe-summary\[hidden\]\s*\{\s*display:\s*none;/);

  // 窄屏是两列网格，这格内容最长，占满整行，分割线跟着挪到上边。
  const narrow = responsiveCss.slice(indexIn(responsiveCss, "@media (max-width: 760px)"));
  const narrowProbe = /\.upstream-probe-summary\s*\{([^}]*)\}/.exec(narrow);
  assert.ok(narrowProbe, "窄屏下有覆盖规则");
  assert.match(narrowProbe[1], /grid-column:\s*1\s*\/\s*-1/);
  assert.match(narrowProbe[1], /border-top:/);
  assert.match(narrowProbe[1], /border-left:\s*0/);
});

/* 把测活那格搬进 .summary-strip，等于把它重新暴露给那条公共样式的后代选择器：
   span 被 flex:1 1 120px 拉成 120px 等宽格子并加竖分割线（连 7px 的状态圆点都被
   撑成椭圆），strong 被 display:block 顶成独立一行的 16px 粗体（"成功 3" 断成
   两行）。enhancements.css 里测活条和路由摘要各留了一段注释记着这个坑——两块当初
   都是靠"别挂 .summary-strip 这个类"绕开的，而现在它就坐在条里，绕不开了。
   所以那几条一律收窄成 .summary-strip-cells > …：数字格在自己的容器里，测活那格
   是条的直接子节点，选择器够不着。 */

/* 浏览器实际会加载的每一张样式表：公共那几张，加上运行时按 data-theme 挂上去的
   主题包（admin.html 里那张 /theme-packs/<name>/theme.css 的表）。列出来而不是写死
   文件名，新加一套主题时这条守卫自动跟着覆盖。 */
const CSS_FILES = [
  ...readdirSync(new URL("../static/css", import.meta.url))
    .filter((name) => name.endsWith(".css"))
    .map((name) => `static/css/${name}`),
  ...readdirSync(new URL("../themes", import.meta.url), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `themes/${entry.name}/theme.css`),
];

/* 逐条取出选择器：先抹掉注释（不然注释里那几句"曾挂着 .summary-strip"会被当成
   选择器），再抓每个不含嵌套的 `前缀 { 声明 }`，逗号拆开。@media 的前置条件因为
   带 { 匹配不上，会被自然跳过，里面的规则照常抓到。 */
function selectorsIn(css) {
  const selectors = [];
  for (const rule of css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{[^{}]*\}/g)) {
    for (const part of rule[1].split(",")) {
      const selector = part.trim();
      if (selector && !selector.startsWith("@")) selectors.push(selector);
    }
  }
  return selectors;
}

test("公共数字条样式不越过条本身，测活那格才不会被当成 KPI 格", () => {
  assert.ok(CSS_FILES.length >= 10, `样式表没扫全：${CSS_FILES.join(", ")}`);

  const leaking = [];
  for (const file of CSS_FILES) {
    for (const selector of selectorsIn(read(file))) {
      // (?![-\w]) 是为了不误伤 .summary-strip-cells，它是另一个类。
      const tail = /\.summary-strip(?![-\w])(.*)$/.exec(selector);
      if (!tail) continue;
      // 后面还跟着后代/子/兄弟组合符，就是能扫到条里其它内容的规则。
      if (/[\s>+~]\S/.test(tail[1])) leaking.push(`${file}: ${selector}`);
    }
  }
  assert.deepEqual(leaking, [], "这些规则会漏到测活那格上");

  /* 反过来确认格子的盒样式没被一起删掉，只是换了个起点；格子里的排版（标签、
     数字）已经改由显式类承担，压根不走后代选择器。 */
  assert.match(baseCss, /\.summary-strip-cells\s*>\s*span\s*\{[^}]*flex:\s*1\s*1\s*120px;/);
  assert.match(baseCss, /\.summary-strip-label\s*\{[^}]*display:\s*block;/);
  assert.match(baseCss, /\.summary-strip-value\s*\{[^}]*display:\s*block;/);
});

/* 标签在上、数字在下，标签压小、数字放大——四个数字格和最右边的测活格是同一套
   写法，靠的是两个公共类而不是各写各的。 */
test("数字格是标签在上、数字在下，字号拉开层级", () => {
  const context = vm.createContext({
    upstreamSummary: { innerHTML: "" },
    upstreams: [
      { enabled: true, effective_weight: 5 },
      { enabled: true, effective_weight: 0 },
      { enabled: false, effective_weight: 3 },
    ],
    lastSummarySignature: null,
  });
  vm.runInContext(
    `${extractFunction(bootstrapJs, "renderUpstreamSummaryCore")}; this.render = renderUpstreamSummaryCore;`,
    context,
  );
  context.render();
  const html = context.upstreamSummary.innerHTML;

  for (const [label, value] of [["渠道总数", 3], ["启用", 2], ["停用", 1], ["有效权重为 0", 1]]) {
    const cell = new RegExp(
      `<span class="summary-strip-label">${label}</span><strong class="summary-strip-value">${value}</strong>`,
    );
    assert.match(html, cell, `${label} 的标签在数字上方`);
  }

  /* 标签原来是 strong 后面的一个裸文本节点，压不了字号也降不了灰，所以必须
     先有个自己的元素。 */
  assert.equal((html.match(/summary-strip-label/g) || []).length, 4, "四格都有独立的标签元素");

  // 有效权重为 0 那格非零时整格转警示色，靠的是格子上的 .summary-warn。
  assert.match(html, /<span class="summary-warn"/, "非零时标出警示");

  /* 格子里只有标签和数字两行，那句"会按恢复周期重新加入"退到 title——它是一句固定
     说明不是数据，摊在格面上要占两行，把这一格撑高一截，另外几格的数字底下就空着
     同样高的一块白。和看板 KPI 卡的 hoverHint 是同一套做法。 */
  assert.ok(!html.includes("summary-hint"), "格面不留说明行");
  assert.match(html, /title="有效权重为 0 的动态渠道会按恢复周期重新加入"/, "说明退到 title");
  assert.equal((html.match(/title=/g) || []).length, 1, "只有非零那格挂 title，别留空 tooltip");

  // 字号层级：标签 11px、数字 26px，紧凑密度下数字降到 20px。
  assert.match(baseCss, /\.summary-strip-label\s*\{[^}]*font-size:\s*var\(--text-xs\);/);
  assert.match(baseCss, /\.summary-strip-value\s*\{[^}]*font-size:\s*var\(--text-3xl\);/);
  assert.match(
    enhancementsCss,
    /html\[data-density="compact"\] \.summary-strip-value\s*\{\s*font-size:\s*var\(--text-2xl\);/,
  );

  /* 行高收着写：格子高度是标签行 + 数字行撑起来的，行高留松了数字底下就空出一条
     和字号不相称的白——这正是"数字和下方空白太多"那次反馈的根。 */
  assert.match(baseCss, /\.summary-strip-value\s*\{[^}]*line-height:\s*1\.05;/);
});

test("测活那格是条的直接子节点，不能塞进数字格容器里", () => {
  /* 数字格容器每次由 renderUpstreamSummaryCore 整块重写 innerHTML，测活那格挪进去
     会被下一次渲染顺手抹掉；而且落进容器里就又变成 .summary-strip-cells 的子节点，
     上面那套 KPI 格样式立刻扫到它。 */
  assert.match(
    adminHtml,
    /<div class="summary-strip"[^>]*>\s*<div id="upstream-summary" class="summary-strip-cells"><\/div>\s*<div id="upstream-probe-summary"/,
    "两个容器是条的平级子节点",
  );

  // 窄屏两列网格靠 nth-child 画分割线，数字格容器里必须只有那四格。
  const narrow = responsiveCss.slice(indexIn(responsiveCss, "@media (max-width: 760px)"));
  assert.match(narrow, /\.summary-strip-cells\s*>\s*span:nth-child\(2n\)/);
  assert.match(narrow, /\.summary-strip-cells\s*>\s*span:nth-last-child\(-n \+ 2\)/);
});

/* ── 「列」与选择控件跟着视图收起 ───────────────────────────── */

test("计数、全选、清空收在一层里，默认（列表视图）不显示", () => {
  const groupStart = indexIn(adminHtml, 'id="upstream-select-controls"');
  const openTag = adminHtml.slice(adminHtml.lastIndexOf("<span", groupStart), indexIn(adminHtml, ">", groupStart) + 1);
  assert.ok(openTag.includes("hidden"), "列表是默认视图，JS 跑起来之前先别闪一下：" + openTag);

  // 组里正好是那三个，批量启用/停用作用于选中集合本身，与"怎么选"无关，留在组外。
  const group = adminHtml.slice(groupStart, indexIn(adminHtml, 'id="batch-enable"', groupStart));
  for (const id of ["upstream-selection-count", "upstream-select-visible", "upstream-clear-selection"]) {
    assert.ok(group.includes(`id="${id}"`), `${id} 在这一组里`);
  }
  assert.ok(group.includes("</span>"), "组在批量按钮之前就闭合了");

  assert.ok(adminHtml.includes('id="upstream-col-menu-wrap"'), "「列」的外壳可寻址");
  // display 是作者样式，得自己补一条 [hidden]。
  assert.match(enhancementsCss, /\.batch-select-group\[hidden\]\s*\{\s*display:\s*none;/);
});

test("applyUpstreamViewChrome 按视图收起「列」和选择控件", () => {
  const context = vm.createContext({
    upstreamColMenuWrap: { hidden: false },
    upstreamSelectControls: { hidden: false },
    closes: 0,
  });
  context.closeColMenus = () => { context.closes += 1; };
  vm.runInContext(
    `${extractFunction(upstreamsJs, "applyUpstreamViewChrome")}; this.apply = applyUpstreamViewChrome;`,
    context,
  );

  context.apply("grid");
  assert.equal(context.upstreamColMenuWrap.hidden, true, "卡片视图没有表格列可配");
  assert.equal(context.upstreamSelectControls.hidden, false, "卡片视图靠这三个选渠道");
  assert.equal(context.closes, 1, "外壳消失前先关掉展开的菜单，否则 aria-expanded 留在 true");

  context.apply("list");
  assert.equal(context.upstreamColMenuWrap.hidden, false);
  assert.equal(context.upstreamSelectControls.hidden, true, "列表视图表头第一列就是全选框");
  assert.equal(context.closes, 1, "切回列表时菜单本来就没开着");
});

/* 「列」配的是表格列的显隐，切到卡片视图时整格消失（见上一条）。它排在视图切换右边：
   读法上"当前视图的配置"跟在视图后面，而且消失的那一格落在这一段的末尾，不会在筛选器
   中间留个洞。 */
test("「列」排在视图切换右边，卡片视图下消失的那格不在中间", () => {
  const toolbar = adminHtml.slice(
    indexIn(adminHtml, `<div class="view-toolbar upstream-toolbar">`),
    indexIn(adminHtml, `<div class="table-wrap">`, indexIn(adminHtml, `<div class="view-toolbar upstream-toolbar">`)),
  );
  const viewToggle = indexIn(toolbar, `<div class="view-toggle-wrap">`);
  const colMenu = indexIn(toolbar, `id="upstream-col-menu-wrap"`);
  assert.ok(viewToggle < colMenu, "视图切换应在「列」之前");

  // 也不能被推到批量动作组后面去：那一组挂着 auto margin，「列」会被顶到行尾之外。
  const actions = indexIn(toolbar, `<div class="actions toolbar-actions">`);
  assert.ok(colMenu < actions, "「列」仍在批量动作组之前");
});

test("两个视图在启动时都会被应用一遍", () => {
  assert.ok(
    upstreamsJs.includes("applyUpstreamViewChrome(view);"),
    "setUpstreamView 里走同一条路，两个分支都覆盖",
  );
  /* 原来只在恢复出 grid 时调一次 setUpstreamView，列表分支一次都不跑——
     那样列表视图下这两组控件永远停在 HTML 里写死的初始状态。 */
  assert.match(
    upstreamsJs,
    /^setUpstreamView\(currentUpstreamView\);$/m,
    "启动时无条件应用一次当前视图",
  );
  assert.ok(
    !upstreamsJs.includes('if (currentUpstreamView === "grid") {\n  setUpstreamView("grid");'),
    "旧的单分支初始化已经去掉",
  );
});

/* ── 6h 请求量的 hover 点回到曲线上 ─────────────────────────── */

test("sparkPathPointAtX 二分收敛到 path 上横坐标为 x 的点", () => {
  const context = vm.createContext({});
  vm.runInContext(
    `${extractFunction(bootstrapJs, "sparkPathPointAtX")}; this.at = sparkPathPointAtX;`,
    context,
  );
  // 弧长参数化成 x = len 的一条曲线，y 随便给一个非线性的形状。
  const path = {
    getTotalLength: () => 100,
    getPointAtLength: (len) => ({ x: len, y: 40 - 35 * Math.sin((Math.PI * len) / 200) }),
  };
  for (const x of [0, 12.5, 50, 87.3, 100]) {
    const point = context.at(path, x);
    assert.ok(Math.abs(point.x - x) < 0.02, `x=${x} 收敛到 ${point.x}`);
    assert.ok(Math.abs(point.y - (40 - 35 * Math.sin((Math.PI * x) / 200))) < 0.02);
  }
});

/* 曲线是 Catmull-Rom 平滑过的，采样点之间不走直线。原来 hover 的点按
   height - ((value - min) / range) * (height - 5) 自己算一遍 y，等于沿着折线
   走——拐点附近能差出好几像素，点就悬在曲线外面。现在直接从画出来的 path 上取。 */
test("hover 的点取自画出来的曲线，而不是按数值重算一遍", () => {
  const frames = [];
  const placed = [];
  const context = vm.createContext({
    window: {
      requestAnimationFrame: (callback) => frames.push(callback),
      cancelAnimationFrame: () => {},
    },
    formatMetric: (value) => String(value),
    wtPositionHoverCard: (container, tooltip, point) => { placed.push(point); },
  });
  vm.runInContext(`
    const CHANNEL_SPARK_VIEW = { width: 100, height: 40 };
    ${extractFunction(bootstrapJs, "sparkDotScaleX")}
    ${extractFunction(bootstrapJs, "sparkPathPointAtX")}
    ${extractFunction(upstreamsJs, "bindChannelSparklineInteraction")}
    this.bind = bindChannelSparklineInteraction;
  `, context);

  // 曲线在 x=50 处报 y=25；按数值线性插值算出来是 y=5，两者差 20 个视图单位。
  const linePath = {
    getTotalLength: () => 100,
    getPointAtLength: (len) => ({ x: len, y: 40 - 0.3 * len }),
  };
  const attrNode = () => ({ attrs: {}, setAttribute(name, value) { this.attrs[name] = value; } });
  const guide = attrNode();
  const dot = attrNode();
  const listeners = {};
  const hitArea = { addEventListener: (type, handler) => { listeners[type] = handler; } };
  const tooltip = { hidden: true, innerHTML: "" };
  const svg = {
    dataset: {},
    removeAttribute: () => {},
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 260, height: 48 }),
    querySelector: (selector) => ({
      ".sparkline-line": linePath,
      ".channel-spark-hit-area": hitArea,
      ".channel-spark-hover-guide": guide,
      ".channel-spark-hover-dot": dot,
    }[selector] ?? null),
  };
  const container = {
    querySelector: (selector) => (selector === ".sparkline-svg" ? svg : selector === ".channel-spark-tooltip" ? tooltip : null),
  };

  const values = [0, 10, 0];
  context.bind(container, values);
  listeners.pointermove({ clientX: 130 }); // 容器宽 260 → ratio 0.5 → x = 50
  assert.equal(frames.length, 1, "每帧只排一次");
  frames.shift()();

  const cy = Number(dot.attrs.cy);
  assert.ok(Math.abs(cy - 25) < 0.05, `点落在曲线上（期望 25，实际 ${cy}）`);

  // 旧写法在同一位置给的是 40 - (10 - 0)/10 * 35 = 5。
  const min = Math.min(...values);
  const range = Math.max(...values) - min || 1;
  const legacyY = 40 - ((values[1] - min) / range) * 35;
  assert.equal(legacyY, 5);
  assert.ok(Math.abs(cy - legacyY) > 1, "不再是按数值重算的那个 y");

  // 竖线和点用同一个 x，弹层用同一个 y，三者不会各说各话。
  assert.equal(Number(guide.attrs.x1), 50);
  assert.equal(Number(guide.attrs.x2), 50);
  assert.equal(placed.length, 1);
  assert.ok(Math.abs(placed[0].y - (cy * 48) / 40) < 0.01, "弹层跟着同一个 y 走");
  assert.equal(tooltip.hidden, false);
});

test("曲线那条 path 可寻址，取点才有对象可取", () => {
  assert.ok(upstreamsJs.includes('<path class="sparkline-line"'), "描边路径带类名");
  assert.ok(
    upstreamsJs.includes('svg?.querySelector(".sparkline-line")'),
    "hover 逻辑按类名取它",
  );
  // 三处迷你图 hover 都用同一个取点函数，手感才一致。
  const dashboardJs = read("static/js/dashboard.js");
  assert.equal(
    (dashboardJs.match(/sparkPathPointAtX\(/g) || []).length,
    3,
    "看板请求数卡 1 处 + 延迟趋势 2 处",
  );
  assert.ok(!dashboardJs.includes("const pathPointAtX ="), "各自一份的二分实现已经收归公共");
});
