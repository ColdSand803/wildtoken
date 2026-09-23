import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/** 取一段规则块（{ 到配对的 }），供断言高度来自变量而非写死的像素。 */
function rule(css, selector) {
  const start = css.indexOf(selector + " {");
  if (start === -1) return "";
  return css.slice(start, css.indexOf("}", start));
}

/* 渠道页工具栏那一排：搜索框、状态筛选、批量按钮、列菜单、视图切换、右侧
   动作组。它们必须等高，否则顶端参差不齐。

   等高靠的是所有人从同一个变量取高度。输入框和普通按钮本来就吃
   var(--control-h)，出过事的是两个图标控件：.col-menu-btn 写死 32px，
   以及视图切换按钮藏在带边框和内边距的容器里、长不到 --control-h。 */

test("工具栏控件的高度都来自 --control-h", () => {
  const base = read("static/css/base.css");
  assert.match(base, /--control-h:\s*34px/, "--control-h 该是 34px");

  const enhancements = read("static/css/enhancements.css");
  const colMenu = rule(enhancements, ".col-menu-btn");
  assert.match(colMenu, /min-height:\s*var\(--control-h\)/, ".col-menu-btn 应吃 --control-h");
  assert.doesNotMatch(colMenu, /min-height:\s*\d+px/, ".col-menu-btn 不许写死像素高度");

  const components = read("static/css/components.css");
  const toggleBtn = rule(components, ".view-toggle-btn");
  /* 关键在按钮本身要是 --control-h，不是容器。原来按钮吃 --control-h-sm，
     因为容器要用边框和内边距占掉 6px——那样按钮永远矮一截。实测它停在
     28px，旁边的搜索框是 34px。 */
  assert.match(toggleBtn, /min-height:\s*var\(--control-h\)/, ".view-toggle-btn 应吃 --control-h");
  assert.doesNotMatch(toggleBtn, /min-height:\s*var\(--control-h-sm\)/, "不许退回 --control-h-sm");
  assert.doesNotMatch(toggleBtn, /min-height:\s*\d+px/, "不许写死像素高度");
});

/* 视图切换的容器不能再给按钮加边框和内边距：外层要和别的控件一样高，
   里面的按钮就会被压到比 --control-h 矮。所以容器让位，边框由按钮自己出。 */
test("视图切换容器不占用按钮的高度", () => {
  const components = read("static/css/components.css");
  const wrap = rule(components, ".view-toggle-wrap");
  assert.doesNotMatch(wrap, /border:\s*\d+px/, "容器不该有边框，那会吃掉按钮的高度");
  assert.doesNotMatch(wrap, /padding:\s*\d+px/, "容器不该有内边距，同上");
  assert.doesNotMatch(wrap, /(?:^|\s)height:\s*\d+px/, "容器不该写死像素高度");
});

/* 所有控件等高后，flex-end 和 center 的结果一样。保留这条断言是防
   再有控件长得比别人高——按钮该贴输入框那条基线，而不是被顶到标签行
   中间去。 */
test("工具栏保持底端对齐", () => {
  const base = read("static/css/base.css");
  const toolbar = rule(base, ".view-toolbar");
  assert.match(toolbar, /align-items:\s*flex-end/);
});

/* 这次修的根因：筛选控件带一行文字标签（「搜索」「状态」），
   把整组撑到约 52px，而按钮只有 34px。标签去掉了，高度才齐。 */
test("筛选控件不带文字标签", () => {
  const pages = ["LogsPage", "UpstreamsPage", "TokensPage"].map((name) =>
    read(`web/src/pages/${name}.tsx`),
  );

  for (const source of pages) {
    for (const selector of ["filter-field", "log-filter"]) {
      /* <label className="..."> 和它的 input/select 之间不该有文字。
         允许紧跟注释或元素，不允许裸文本。 */
      const opens = [...source.matchAll(new RegExp(`<label className="${selector}[^"]*">`, "g"))];
      for (const open of opens) {
        const after = source.slice(open.index + open[0].length).trimStart();
        assert.ok(
          after.startsWith("<") || after.startsWith("{"),
          `${selector} 还带着文字标签：${after.slice(0, 40)}`,
        );
      }
    }
  }

  /* 去掉文字标签不能顺手去掉说明：每个筛选控件仍要有可访问名称。 */
  for (const source of pages) {
    const controls = [...source.matchAll(/<(input|select)\b[^>]*>/gs)];
    for (const control of controls) {
      const tag = control[0];
      // 复选框和开关由旁边的文字描述，不强制要求。
      if (/type="(checkbox|radio)"/.test(tag)) continue;
      if (!/(filter|search)/i.test(tag)) continue;
      assert.match(tag, /aria-label=/, `筛选控件缺 aria-label：${tag.slice(0, 60)}`);
    }
  }
});
