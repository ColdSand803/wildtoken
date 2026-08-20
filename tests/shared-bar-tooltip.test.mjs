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
  // 触屏和禁用 JS 时悬浮卡不会出现，原生 title 是唯一说明。
  assert.ok(markup.includes('title="正常成功响应"'));
  assert.ok(markup.includes('aria-label="2xx 120"'));
  assert.ok(markup.includes("data-wt-tip="), markup);

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
  assert.ok(source.includes("wtBindHoverCard(dashboardStatusChart)"), "重渲染后重绑悬浮卡");
  assert.ok(source.includes("wtPositionHoverCard("), "延迟趋势复用公共定位");
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
