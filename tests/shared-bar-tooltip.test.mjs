import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

function extractFunction(source, name) {
  const start = source.indexOf("function " + name + "(");
  assert.notEqual(start, -1, name + " 不在源码里");
  const asyncPrefix = "async ";
  const declarationStart = source.startsWith(asyncPrefix, start - asyncPrefix.length)
    ? start - asyncPrefix.length
    : start;

  let paramDepth = 0;
  let paramEnd = -1;
  for (let i = start + ("function " + name).length; i < source.length; i += 1) {
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
  throw new Error(name + " 的函数体没有闭合");
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => {
    const entities = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;",
    };
    return entities[char];
  });
}

function barContext(names) {
  const source = read("static/js/components.js");
  const context = vm.createContext({ escapeHtml });
  for (const name of names) {
    vm.runInContext(extractFunction(source, name), context);
  }
  return context;
}

test("components.js is loaded before every module that renders a segmented bar", () => {
  const markup = read("static/admin.html");
  const at = (file) => markup.indexOf(`js/${file}`);

  assert.ok(at("components.js") > -1, "components.js 挂在 admin.html 上");
  for (const consumer of ["dashboard.js", "logs.js", "upstreams.js"]) {
    assert.ok(
      at("components.js") < at(consumer),
      `components.js 必须先于 ${consumer} 加载，否则 wtSegmentBar 还没定义`,
    );
  }
});

test("wtSegment emits width only when provided and keeps string precision verbatim", () => {
  const context = barContext(["wtTipAttribute", "wtSegment"]);

  assert.equal(context.wtSegment(null), "", "空段落不产生节点");

  // 字符串宽度原样落进 style，各处的小数位数是有断言的。
  const stringWidth = context.wtSegment({ className: "ops-bar-seg ok", width: "4.8" });
  assert.ok(stringWidth.includes("style=\"width:4.8%\""), stringWidth);
  assert.ok(stringWidth.includes('class="wt-segbar-seg ops-bar-seg ok"'));
  assert.ok(!stringWidth.includes("is-hoverable"), "默认不是可悬浮的");
  assert.ok(!stringWidth.includes("tabindex"), "非交互段不进 Tab 序列");

  // 数字宽度补两位小数。
  assert.ok(context.wtSegment({ width: 33.333 }).includes("width:33.33%"));

  // 宽度缺省时完全不写 style（错误时间分布只用 opacity）。
  const noWidth = context.wtSegment({ className: "status-error-cell", opacity: "0.25" });
  assert.ok(noWidth.includes('style="opacity:0.25"'), noWidth);
  assert.ok(!noWidth.includes("width:"));
});

test("wtSegment renders data attributes, tips, title fallback and interactive roles", () => {
  const context = barContext(["wtTipAttribute", "wtSegment"]);

  const markup = context.wtSegment({
    className: "ops-bar-seg ok is-clickable",
    width: "50.00",
    interactive: true,
    data: { "drill-status": "2xx", empty: "", missing: null },
    tip: { title: "2xx 成功", lines: ["120 次", "占 50%"] },
    title: "正常成功响应",
    ariaLabel: "2xx 120",
  });

  assert.ok(markup.includes('data-drill-status="2xx"'));
  assert.ok(!markup.includes("data-empty"), "空值不落成属性");
  assert.ok(!markup.includes("data-missing"), "null 不落成属性");
  assert.ok(markup.includes("is-hoverable"));
  assert.ok(markup.includes('role="button"'), "交互段默认 role=button");
  assert.ok(markup.includes('tabindex="0"'), "键盘可达");
  /* 有悬浮卡就不出原生 title：指针停住时悬浮卡还在，浏览器的 title 一秒后照样弹，
     同一句话叠成两层。段上另有 aria-label，撤掉 title 不丢可访问信息。 */
  assert.ok(!markup.includes("title="), "悬浮卡在时不出原生 title，避免双弹层");
  assert.ok(markup.includes('aria-label="2xx 120"'));
  assert.ok(markup.includes("data-wt-tip="), markup);

  // 没有悬浮卡的段仍然保留 title——那时它是唯一的说明。
  const titleOnly = context.wtSegment({ width: "10", title: "无悬浮卡时的说明" });
  assert.ok(titleOnly.includes('title="无悬浮卡时的说明"'), "没有 tip 时 title 是唯一说明");
  assert.ok(!titleOnly.includes("data-wt-tip="));

  const role = context.wtSegment({ width: "10", interactive: true, role: "img" });
  assert.ok(role.includes('role="img"'), "role 可以被调用方覆盖");
});

test("wtTipAttribute serialises to escaped JSON and skips titleless tips", () => {
  const context = barContext(["wtTipAttribute"]);

  assert.equal(context.wtTipAttribute(null), "");
  assert.equal(context.wtTipAttribute({ lines: ["只有正文"] }), "", "没有标题就不弹框");

  const attr = context.wtTipAttribute({ title: '5xx "上游"', lines: ["12 次", "", null, "占 3%"] });
  assert.ok(attr.startsWith('data-wt-tip="'));
  assert.ok(attr.includes("&quot;"), "引号必须转义，否则属性会提前闭合");

  const json = attr.slice('data-wt-tip="'.length, -1)
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
  assert.deepEqual(JSON.parse(json), { title: '5xx "上游"', lines: ["12 次", "占 3%"] });
});

test("wtSegmentBar keeps the caller skin class, drops null segments and labels the track", () => {
  const context = barContext(["wtTipAttribute", "wtSegment", "wtSegmentBar"]);

  const bar = context.wtSegmentBar({
    trackClass: "ops-bar-track",
    ariaLabel: "2xx 10 · 5xx 1",
    segments: [
      { className: "ops-bar-seg ok", width: "90.00" },
      null,
      { className: "ops-bar-seg danger", width: "10.00" },
    ],
  });

  assert.ok(bar.startsWith('<div class="wt-segbar ops-bar-track"'), bar);
  assert.ok(bar.includes('role="img"'), "默认 role=img");
  assert.ok(bar.includes('aria-label="2xx 10 · 5xx 1"'));
  assert.equal(bar.match(/wt-segbar-seg/g).length, 2, "null 段被丢掉");

  const bare = context.wtSegmentBar({ segments: [] });
  assert.ok(bare.startsWith('<div class="wt-segbar"'), bare);
  assert.ok(bare.endsWith("></div>"));
});

test("wtSegmentBar drops the track title when any segment owns a hover card", () => {
  const context = barContext(["wtTipAttribute", "wtSegment", "wtSegmentBar"]);

  /* 原生 title 会由祖先代弹：段上撤掉 title 之后，指针停在段上时浏览器会往上找到
     轨道的 title 弹出来，双弹层原样复现。所以有悬浮卡时整条轨道都不出 title。 */
  const withTip = context.wtSegmentBar({
    trackClass: "log-detail-timing-bar",
    title: "总耗时 1000ms",
    ariaLabel: "首字 300ms",
    segments: [{ width: "100", tip: { title: "首字", lines: ["300ms"] } }],
  });
  assert.ok(!withTip.includes("title="), "轨道不能替段弹出原生 title");
  assert.ok(withTip.includes('aria-label="首字 300ms"'), "轨道仍然有可访问名称");

  // 整条都没有悬浮卡时，轨道的 title 是唯一说明，保留。
  const withoutTip = context.wtSegmentBar({
    title: "总耗时 1000ms",
    segments: [{ width: "100" }],
  });
  assert.ok(withoutTip.includes('title="总耗时 1000ms"'), "没有悬浮卡时轨道 title 保留");
});

test("wtSegmentTip parses data-wt-tip and stays silent on garbage", () => {
  const context = barContext(["wtSegmentTip"]);

  assert.equal(context.wtSegmentTip({}), null);
  assert.equal(context.wtSegmentTip({ dataset: {} }), null);
  assert.equal(context.wtSegmentTip({ dataset: { wtTip: "{不是 JSON" } }), null, "坏属性不弹乱码框");
  const parsed = context.wtSegmentTip({ dataset: { wtTip: '{"title":"传输","lines":["2.1s"]}' } });
  // 拷回本 realm 再比：vm 里的 Object/Array 原型和这边不是同一个。
  assert.deepEqual(JSON.parse(JSON.stringify(parsed)), { title: "传输", lines: ["2.1s"] });
});

test("wtRenderHoverCard renders title plus non-empty lines only", () => {
  const context = barContext(["wtRenderHoverCard"]);
  const card = { innerHTML: "" };

  assert.equal(context.wtRenderHoverCard(card, null), false);
  assert.equal(context.wtRenderHoverCard(card, { lines: ["x"] }), false, "没标题不渲染");
  assert.equal(card.innerHTML, "", "渲染失败时不留半截内容");

  assert.equal(context.wtRenderHoverCard(card, { title: "上游生成", lines: ["2.8s", "", null] }), true);
  assert.equal(card.innerHTML, "<strong>上游生成</strong><span>2.8s</span>");
});

test("wtPositionHoverCard flips left near the right edge and clamps inside the container", () => {
  const context = barContext(["wtPositionHoverCard"]);
  const container = { getBoundingClientRect: () => ({ width: 400, height: 200 }) };
  const makeCard = () => ({ offsetWidth: 120, offsetHeight: 60, style: {} });

  // 左半边：卡片摆在锚点右侧，间距 12。
  const left = makeCard();
  context.wtPositionHoverCard(container, left, { x: 100, y: 150 });
  assert.equal(left.style.left, "112px");
  assert.equal(left.style.top, "78px");

  // 过了 62%（>248）翻到左边，否则贴着容器右缘被裁。
  const flipped = makeCard();
  context.wtPositionHoverCard(container, flipped, { x: 300, y: 150 });
  assert.equal(flipped.style.left, "168px");

  // 顶部一行的锚点会把卡片顶出容器，夹回 gap。
  const clamped = makeCard();
  context.wtPositionHoverCard(container, clamped, { x: 5, y: 0 });
  assert.equal(clamped.style.left, "17px");
  assert.equal(clamped.style.top, "12px");
});

test("components.css supplies the shared geometry, hover motion and hovercard skin", () => {
  const css = read("static/css/components.css");
  assert.ok(css.includes(".wt-segbar"), "分段条几何");
  assert.ok(css.includes(".wt-segbar-seg"), "段落几何");
  assert.ok(css.includes(".wt-segbar-seg.is-hoverable"), "可悬浮段");
  assert.ok(css.includes("scaleY(1.25)"), "悬浮时纵向放大，和错误时间分布一致");
  assert.ok(css.includes(".wt-hovercard"), "悬浮卡");
  // 延迟趋势的当前时间桶弹框和公共悬浮卡共用一套皮肤。
  assert.ok(css.includes(".dashboard-chart-tooltip"), "延迟趋势弹框并入同一套样式");
  assert.ok(css.includes("prefers-reduced-motion"), "尊重减少动效偏好");
});

/* 段间留缝时轨道底色会从缝里透出来，深色皮肤上就是一道黑线，看着像数据里多了一个
   极窄的分段，实际什么也不表示。无缝是公共分段条的默认，需要格子感的调用方自己加。 */
test("公共分段条默认无缝，状态分布不留黑线", () => {
  const components = read("static/css/components.css");
  const enhancements = read("static/css/enhancements.css");

  const shared = /^\.wt-segbar\s*\{([^}]*)\}/m.exec(components);
  assert.ok(shared, ".wt-segbar 应有几何规则");
  assert.match(shared[1], /gap:\s*0;/, "公共分段条默认不留缝");

  // 状态分布的皮肤只管高度/圆角/底色，不该自己再加 gap 把缝加回来。
  const track = /^\.ops-bar-track\s*\{([^}]*)\}/m.exec(enhancements);
  assert.ok(track, ".ops-bar-track 应有皮肤规则");
  assert.ok(!/gap:/.test(track[1]), "状态分布不该再留缝：" + track[1]);
});

/* 错误时间分布是另一回事：每格是一个时间桶，桶与桶本来就该分开数（数得出"连着
   几个桶在报错"），缝在这里是有意义的。这条用例是防止"顺手把 gap 全清了"。 */
test("错误时间分布保留格子感，缝不能被一起清掉", () => {
  const css = read("static/css/dashboard.css");
  const strip = /^\.status-error-strip\s*\{([^}]*)\}/m.exec(css);
  assert.ok(strip, ".status-error-strip 应有规则");
  assert.match(strip[1], /gap:\s*2px;/, "时间桶之间要留缝");
});

test("dashboard.css leaves hover motion to the shared component", () => {
  const css = read("static/css/dashboard.css");
  // dashboard.css 排在 components.css 之后，同优先级的 hover 规则会盖掉
  // 公共组件的 transform，所以这里只能留指针形状。
  assert.ok(css.includes(".ops-bar-seg.is-clickable"), "钻取语义仍在");
  assert.ok(css.includes(".status-error-cell.is-clickable"), "错误格钻取语义仍在");
  assert.ok(
    !/\.ops-bar-seg\.is-clickable:hover/.test(css),
    "状态分布不能自己再写一份 hover，否则会覆盖公共动效",
  );
  assert.ok(
    !/\.status-error-cell\.is-clickable:hover/.test(css),
    "错误时间分布同理",
  );
});

test("dashboard status chart and error strip both go through wtSegmentBar", () => {
  const source = read("static/js/dashboard.js");
  assert.ok(source.includes('trackClass: "ops-bar-track"'), "状态分布用公共分段条");
  assert.ok(source.includes('trackClass: "status-error-strip"'), "错误时间分布用公共分段条");
  // innerHTML 整体重刷会连悬浮卡一起冲掉，每次渲染后必须重绑。
  assert.ok(source.includes("wtBindHoverCard(dashboardStatusChart"), "重渲染后重绑悬浮卡");
  assert.ok(source.includes("wtPositionHoverCard("), "延迟趋势复用公共定位");

  /* 图例项和条上的段说的是同一件事，得走同一个悬浮卡：默认 target 只认
     .wt-segbar-seg，图例就只能退回浏览器默认弹层，同一张图两种观感。 */
  assert.ok(
    source.includes('target: ".wt-segbar-seg, .status-legend-item"'),
    "图例项也纳入悬浮卡",
  );
  assert.ok(
    !/class="status-legend-item[^"]*"[^>]*title="/.test(source),
    "图例项不再挂原生 title",
  );
  assert.ok(
    !/class="status-delta [^"]*"[^>]*title="/.test(source),
    "环比徽标不再挂原生 title（父子两层 title 会叠着弹）",
  );
});

/* 四套弹层原本各写一遍摆放。延迟趋势早就复用了公共定位，另两处是手写的：KPI 卡那段
   是公共函数的逐行翻版，渠道卡那段还和别处不一致（固定上移 32px、没有翻边、用
   clientWidth 夹紧）。这里锁住"不许再回到手写"，否则手感会重新分叉。 */
test("every hover card places itself through the shared positioner", () => {
  for (const file of ["static/js/dashboard.js", "static/js/upstreams.js"]) {
    const source = read(file);
    assert.ok(source.includes("wtPositionHoverCard("), `${file} 复用公共定位`);
    assert.ok(
      !source.includes("* 0.62"),
      `${file} 不再手写 62% 翻边判定`,
    );
    assert.ok(
      !/tooltip\.style\.(left|top)\s*=/.test(source),
      `${file} 不再自己写 tooltip 的 left/top`,
    );
  }
});

test("log detail timing waterfall uses the shared bar and rebinds its hovercard", () => {
  const source = read("static/js/logs.js");
  assert.ok(source.includes('trackClass: "log-detail-timing-bar"'), "耗时瀑布用公共分段条");
  assert.ok(source.includes("wtBindHoverCard(logDetailMeta)"), "详情卡重刷后重绑悬浮卡");

  const css = read("static/css/enhancements.css");
  // 悬浮时纵向放大 1.25 倍，裁剪会把放大的部分切掉。
  const bar = css.slice(css.indexOf(".log-detail-timing-bar {"));
  const block = bar.slice(0, bar.indexOf("}"));
  assert.ok(!block.includes("overflow: hidden"), "瀑布条不能裁剪，否则放大动效被切");
  assert.ok(block.includes("height: 10px"), "6px 太薄，放大了也看不出来");
});

test("timing chips wrap outside the ellipsis rule so 网关准备 that line never truncates", () => {
  const source = read("static/js/logs.js");
  assert.ok(source.includes("function formatLogTimingChips("), "四段耗时走可换行的 chip 流");
  assert.ok(source.includes("log-timing-chip-dot"), "每个 chip 带一个和瀑布段同色的圆点");

  const css = read("static/css/enhancements.css");
  assert.ok(css.includes(".log-timing-chips"), "chip 容器");
  assert.ok(css.includes(".log-timing-chip-dot"), "色点");

  // 截断的根因是 .log-detail-meta-card small 的 nowrap + ellipsis，
  // chip 流不在那条规则下；中间那列还要更宽一点才装得下四段。
  const logsCss = read("static/css/logs-tokens.css");
  assert.ok(logsCss.includes("minmax(0, 1.4fr)"), "状态与耗时那一列更宽");
});

/* HTTP 200 这类状态徽标以前套在 <strong> 里，吃到 .log-detail-meta-card strong 的
   overflow:hidden + ellipsis——那套截断是给渠道名那种纯文本写的。徽标自己 22px 顶开
   13px×1.25 的行盒，上下余量正好 0，换个字体栈或缩放比、圆整方向一反就把边框切掉，
   于是"有时候"上下像被裁。这条用例钉住"徽标不在截断规则下"。 */
test("状态徽标不套在会截断的 strong 里，上下不会被裁", () => {
  const source = read("static/js/logs.js");
  const head = /const statusHeadMarkup = [\s\S]*?;\s*?[\r\n]/.exec(source);
  assert.ok(head, "状态徽标那一行应由 statusHeadMarkup 统一产出");
  assert.ok(!/<strong/.test(head[0]), "徽标不能再套 strong：" + head[0]);
  assert.match(head[0], /class="log-detail-status-head"/, "外层恒定是这一层");

  // 调用点也不能再补一层 strong 包回去。
  assert.ok(source.includes("${statusHeadMarkup}"), "状态与耗时卡里应插入 statusHeadMarkup");
  assert.ok(
    !/<strong[^>]*>\s*\$\{statusHeadMarkup\}/.test(source),
    "插入点外面不能再包 strong，那层带着截断规则",
  );

  const css = read("static/css/enhancements.css");
  const block = /^\.log-detail-status-head\s*\{([^}]*)\}/m.exec(css);
  assert.ok(block, ".log-detail-status-head 应有规则");
  assert.ok(!/overflow:/.test(block[1]), "这一层不设 overflow，徽标该换行就换行：" + block[1]);
  assert.match(block[1], /flex-wrap:\s*wrap;/, "徽标多了要能换行，而不是挤在一行里被裁");
});

/* 快捷时间切换之后"请求统计卡片上边被裁"的根因不是徽标，是主数字自己：overflow:hidden
   是为横向省略号服务的，但它同时也纵向裁，line-height 收得比字形盒矮时裁掉的就是数字
   的上沿。1.15 在 clamp 到 ~35px 的字号下算出 40.8px 行盒，等宽字形盒 42px，上边切掉
   1px。各主题 --font-mono 不同（Fira Code / JetBrains Mono / IBM Plex Mono），字形盒
   高度本来就有差，所以这里要留真余量而不是刚好压线。 */
test("看板 KPI 数字的行盒高于字形盒，不会自裁上下沿", () => {
  const css = read("static/css/dashboard.css");
  const block = /^\.kpi-value,\s*\.dashboard-kpi-value\s*\{([^}]*)\}/m.exec(css);
  assert.ok(block, ".kpi-value / .dashboard-kpi-value 应有共同规则");

  const lh = /line-height:\s*([\d.]+);/.exec(block[1]);
  assert.ok(lh, "应显式写 line-height，别落回继承值：" + block[1]);
  assert.ok(
    Number(lh[1]) >= 1.25,
    `line-height 至少 1.25 才够容下等宽字形盒（1.2 em 上下）：当前 ${lh[1]}`,
  );

  // 横向省略号还得留着——纵向的余量是靠 line-height 让出来的，不是靠去掉裁剪。
  assert.match(block[1], /overflow:\s*hidden;/, "数字太长仍要用省略号收住");
  assert.match(block[1], /text-overflow:\s*ellipsis;/, "省略号规则不能一起删掉");
});
