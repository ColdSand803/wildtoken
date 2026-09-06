import { existsSync, readFileSync, readdirSync } from "node:fs";
import test from "node:test";
import assert from "node:assert/strict";

/* 路径一律相对测试文件解析，不靠调用时的工作目录。
   仓库里 CSS 一律 CRLF，断言里的多行字面量写不出 \r\n，统一抹平再比。 */
const repo = (path) => new URL(`../${path}`, import.meta.url);
const read = (path) => readFileSync(repo(path), "utf8").replace(/\r\n/g, "\n");
const list = (path) => readdirSync(repo(path));

/* themes/ 下还有 README.md 之类的散文件，按"有 theme.css"认包，与
   theme-view-coverage 那边同一个判据。 */
const themePacks = () =>
  list("themes").filter((name) => existsSync(repo(`themes/${name}/theme.css`)));

/* 所有参与渲染的样式表：核心 + 每个主题包。手点名单会漏——上一次
   .live-indicator 的同类 bug 就是七个文件里点漏了一个。 */
function allStylesheets() {
  const sheets = list("static/css")
    .filter((name) => name.endsWith(".css"))
    .map((name) => `static/css/${name}`);
  for (const pack of themePacks()) {
    sheets.push(`themes/${pack}/theme.css`);
  }
  return sheets;
}

/* 粗粒度切规则：取 `选择器 { 声明 }` 的对。@media 的头会被当成"选择器"落到
   前一块，无所谓——我们只看声明里有没有那两条一起出现。 */
function rules(css) {
  const found = [];
  /* 先去注释：不去的话规则前面那段说明会连着落进选择器的捕获里，
     `选择器 === ".wt-segbar"` 这种等值判断就永远不成立。 */
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  css = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let match = pattern.exec(css);
  while (match) {
    found.push({ selector: match[1].trim(), body: match[2] });
    match = pattern.exec(css);
  }
  return found;
}

/* 底色取 var(--accent) 的地方，墨色必须也走 token。--accent 在浅色包里是近黑
   （素宣 #111111），在深色包里是近白（松烟 #f0f0f0）——写死 white 的话
   夜版就是白底白字，整个按钮糊成一片。base.css 的主按钮一直是 --accent-on，
   这条只是把漏网的拉回来。 */
test("底色是 --accent 的规则不写死白色墨水", () => {
  const offenders = [];
  for (const sheet of allStylesheets()) {
    for (const rule of rules(read(sheet))) {
      const paintsAccent = /(?:^|[\s;])background(?:-color)?:\s*var\(--accent\)/
        .test(rule.body);
      const hardWhite = /(?:^|[\s;])color:\s*(?:white|#fff(?:fff)?)\s*[;}]?/i
        .test(rule.body);
      if (paintsAccent && hardWhite) {
        offenders.push(`${sheet}: ${rule.selector}`);
      }
    }
  }
  assert.deepEqual(offenders, [],
    `这些规则把 --accent 当底色却写死了白墨水：\n${offenders.join("\n")}`);
});

/* 每个主题包都得有 --accent-on，否则上一条改出来的墨色在那个包里没值可取。 */
test("每个主题包都定义 --accent-on", () => {
  const missing = themePacks().filter(
    (pack) => !/--accent-on:/.test(read(`themes/${pack}/theme.css`)));
  assert.deepEqual(missing, [], `这些包没定义 --accent-on：${missing.join(", ")}`);
});

/* 端头的半圆是段自己的圆角，浏览器按段自己的盒子夹紧，夹到 min(半高, 段宽)。
   末段窄到几个像素时它就退化成小圆角，一条的两头于是一边圆一边方。地板宽等于
   半高，夹紧就只由高度说话。 */
test("公共分段条把端头地板宽算成半高", () => {
  const css = read("static/css/components.css");
  const segbar = rules(css).find((rule) => rule.selector === ".wt-segbar");
  assert.ok(segbar, "找不到 .wt-segbar 规则");
  assert.match(segbar.body,
    /--wt-segbar-cap:\s*calc\(var\(--wt-segbar-height,\s*0px\)\s*\/\s*2\)/,
    "--wt-segbar-cap 应当由 --wt-segbar-height 折半算出");

  const capped = rules(css).find((rule) =>
    /:first-child/.test(rule.selector) && /:last-child/.test(rule.selector)
    && /min-width:/.test(rule.body));
  assert.ok(capped, "首尾两段应当共用一条 min-width 规则");
  assert.match(capped.body, /min-width:\s*var\(--wt-segbar-cap\)/);
});

/* 药丸轨道必须报自己的高度，不然 cap 落回 0，不对称照旧。方角轨道不报——
   .status-error-strip 那种带 gap 的格子条不需要收边。 */
test("每条药丸轨道都报了 --wt-segbar-height", () => {
  const skins = [
    ["static/css/enhancements.css", ".ops-bar-track"],
    ["static/css/enhancements.css", ".log-detail-timing-bar"],
    ["static/css/dashboard.css", ".dashboard-chart .ops-bar-track"],
  ];
  for (const [sheet, selector] of skins) {
    const rule = rules(read(sheet)).find((one) => one.selector === selector);
    assert.ok(rule, `${sheet} 里找不到 ${selector}`);
    assert.match(rule.body, /--wt-segbar-height:\s*\d+px/,
      `${selector} 应当报出自己的高度`);
  }

  /* 高度只许从那个变量取，否则改了 height 而没改变量，圆角就和高度脱钩。 */
  const track = rules(read("static/css/enhancements.css"))
    .find((one) => one.selector === ".ops-bar-track");
  assert.match(track.body, /height:\s*var\(--wt-segbar-height\)/);
});

/* 标记在竖排轨道里放到 48px —— 与 antfu 站点导航里的 w-12 h-12 同尺寸。
   两包必须一致，日夜切换时标记不该跳大小。 */
test("凉砂两包的标记都是 48px，矮窗口都收到 30px", () => {
  for (const pack of ["co1dsand-light", "co1dsand-dark"]) {
    const css = read(`themes/${pack}/theme.css`);
    const marks = rules(css).filter((rule) =>
      rule.selector === `html[data-theme="${pack}"] .brand-mark`);
    assert.equal(marks.length, 2,
      `${pack} 应当有两条 .brand-mark：轨道 48px 与矮窗口 30px`);
    const sizes = marks.map((rule) => rule.body.match(/height:\s*(\d+)px/)?.[1]);
    assert.deepEqual(sizes, ["48", "30"], `${pack} 的标记尺寸不对：${sizes}`);
    for (const rule of marks) {
      const height = rule.body.match(/height:\s*(\d+)px/)?.[1];
      const width = rule.body.match(/width:\s*(\d+)px/)?.[1];
      assert.equal(width, height, `${pack} 的标记不是正方：${width}×${height}`);
    }
  }
});
