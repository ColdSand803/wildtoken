import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const adminHtml = read("static/admin.html");
const components = read("static/css/components.css");
const packs = {
  "co1dsand-light": read("themes/co1dsand-light/theme.css"),
  "co1dsand-dark": read("themes/co1dsand-dark/theme.css"),
};

/* 由 antfu 的 scripts/logo-skeleton.py 生成：每笔中心线的弧长，以及它在 13 秒
   周期里占的窗口。照搬这组数才能让动效和 antfu.me 一模一样。 */
const NIBS = [
  { dash: "176.8", start: "3%", end: "20.1%" },
  { dash: "109.3", start: "21.3%", end: "31.87%" },
  { dash: "183.67", start: "33.07%", end: "50.84%" },
  { dash: "81.63", start: "52.04%", end: "59.92%" },
  { dash: "112.54", start: "61.12%", end: "72%" },
];

const ruleBody = (css, selector) => {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`(?:^|[^,\\w-])${escaped}\\s*\\{([^}]*)\\}`, "m").exec(css);
  return match ? match[1] : null;
};

test("品牌位并列了凉砂的 logo，mask 是笔顺本身", () => {
  assert.match(adminHtml, /<svg class="co1dsand-logo"/);
  assert.ok(adminHtml.includes('id="co1dsand-logo-reveal"'), "缺少 mask defs");
  assert.match(adminHtml, /class="co1dsand-logo-ink"[\s\S]{0,4000}?mask="url\(#co1dsand-logo-reveal\)"/);

  /* 扫过式渐变已经换成笔顺书写，别把旧实现漏在里面。 */
  assert.ok(!adminHtml.includes("co1dsand-logo-sweep"), "不该残留扫过矩形");
  assert.ok(!adminHtml.includes("co1dsand-logo-edge"), "不该残留扫过用的渐变 defs");
});

/* 一笔一个元素，不是一条 path 带五个子路径：SVG 会在每个子路径重启 dash 图案，
   那样五笔会同时开画，就不是笔顺了。 */
test("mask 里是五条独立的笔画中心线，带圆头描边", () => {
  for (let i = 0; i < NIBS.length; i += 1) {
    assert.match(adminHtml, new RegExp(`<path class="co1dsand-nib-${i}" d="M`), `缺少第 ${i} 笔`);
  }
  assert.equal((adminHtml.match(/class="co1dsand-nib-\d"/g) ?? []).length, 5, "必须正好五笔");

  const group = /<g fill="none" stroke="#fff"([^>]*)>/.exec(adminHtml);
  assert.ok(group, "五笔必须包在一个描边组里");
  assert.match(group[1], /stroke-width="3\.6"/, "笔画粗细决定墨迹被带出多少");
  assert.match(group[1], /stroke-linecap="round"/);
  assert.match(group[1], /stroke-linejoin="round"/);

  /* 中心线到不了约 1.5% 的墨（剪掉的岔枝、钝笔尖外缘），靠这块补齐。 */
  assert.match(adminHtml, /<rect class="co1dsand-logo-settle" width="100" height="100" fill="#fff" \/>/);
});

/* base.css 的 `.brand-mark svg { display: block }` 会让两个 SVG 一起显示，
   所以默认隐藏必须挂在主题包之外，否则其它六套主题的品牌位会多出一个标记。 */
test("凉砂 logo 默认隐藏，且默认隐藏不写在主题包里", () => {
  assert.match(components, /\.brand-mark \.co1dsand-logo\s*\{\s*display: none;/);
  for (const [theme, css] of Object.entries(packs)) {
    assert.doesNotMatch(
      css,
      /\.brand-mark \.co1dsand-logo\s*\{\s*display: none;/,
      `${theme} 不该自己写默认隐藏——那样只在它激活时才生效，等于没写`,
    );
  }
});

test("两套凉砂都把品牌位换成自己的 logo", () => {
  for (const [theme, css] of Object.entries(packs)) {
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.brand-mark > svg:first-child\\s*\\{\\s*display: none;`),
      `${theme} 必须藏掉原 logo`,
    );
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.brand-mark \\.co1dsand-logo\\s*\\{\\s*display: block;`),
      `${theme} 必须显示凉砂 logo`,
    );
  }
});

test("logo 墨色跟随主题 token，不写死", () => {
  for (const [theme, css] of Object.entries(packs)) {
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.co1dsand-logo-ink\\s*\\{[^}]*fill: var\\(--text\\);`),
      `${theme} 的 logo 墨色应取 var(--text)`,
    );
  }
});

/* 书写机制与配色无关，两套凉砂逐字相同。留在 components.css 一份，写进主题包就
   得复制两份、日夜各一，早晚漂移。 */
test("书写机制放在主题包之外，且主题包不复制一份", () => {
  for (let i = 0; i < NIBS.length; i += 1) {
    assert.ok(components.includes(`@keyframes co1dsand-nib-${i}`), `components.css 缺第 ${i} 笔的关键帧`);
  }
  for (const [theme, css] of Object.entries(packs)) {
    assert.ok(!/@keyframes co1dsand-(nib-\d|logo-)/.test(css), `${theme} 不该自带书写关键帧`);
    assert.ok(!/stroke-dasharray/.test(css), `${theme} 不该自带 dash 声明`);
  }
});

/* 时间按弧长比例分配，笔速才是一个匀速；窗口之间的空档就是提笔。
   这组数照搬 antfu 的 Logo.vue，动效与原作一致全靠它。 */
test("五笔的 dash 长度与时间窗与 antfu 的 Logo.vue 逐字一致", () => {
  NIBS.forEach(({ dash, start, end }, i) => {
    const body = ruleBody(components, `.co1dsand-nib-${i}`);
    assert.ok(body, `缺少 .co1dsand-nib-${i} 规则`);
    assert.match(body, new RegExp(`stroke-dasharray: ${dash};`), `第 ${i} 笔的弧长应为 ${dash}`);
    /* 静止值 = 写完：动画被关掉时标记完整，不是缺一半。 */
    assert.match(body, /stroke-dashoffset: 0;/, `第 ${i} 笔的静止态必须是写完的`);
    assert.match(body, /animation: co1dsand-nib-\d+ 13s linear infinite both;/, `第 ${i} 笔必须走 13 秒线性周期`);

    const frames = new RegExp(`@keyframes co1dsand-nib-${i}\\s*\\{([\\s\\S]*?)\\n\\}`).exec(components);
    assert.ok(frames, `缺少 @keyframes co1dsand-nib-${i}`);
    assert.match(
      frames[1],
      new RegExp(`0%,\\s*${start.replace(".", "\\.")}\\s*\\{\\s*stroke-dashoffset: ${dash};`),
      `第 ${i} 笔应等到 ${start} 才落笔`,
    );
    assert.match(
      frames[1],
      new RegExp(`${end.replace(".", "\\.")},\\s*97\\.5%\\s*\\{\\s*stroke-dashoffset: 0;`),
      `第 ${i} 笔应在 ${end} 写完并保持到 97.5%`,
    );
  });
});

/* 末笔在 72% 落定，settle 紧跟着淡入；墨迹 94% 起淡出，mask 趁不可见时回卷，
   下一轮才从白纸开始，而不是把自己反着擦掉。 */
test("收笔补墨与整体淡出的时序与原作一致", () => {
  const settle = ruleBody(components, ".co1dsand-logo-settle");
  assert.ok(settle, "缺少 .co1dsand-logo-settle 规则");
  assert.match(settle, /opacity: 1;/, "静止态必须补齐");
  assert.match(settle, /animation: co1dsand-logo-settle 13s linear infinite both;/);

  const settleFrames = /@keyframes co1dsand-logo-settle\s*\{([\s\S]*?)\n\}/.exec(components);
  assert.ok(settleFrames, "缺少 @keyframes co1dsand-logo-settle");
  assert.match(settleFrames[1], /0%,\s*72%\s*\{\s*opacity: 0;/, "补墨要等末笔落定（72%）");
  assert.match(settleFrames[1], /76%,\s*97\.5%\s*\{\s*opacity: 1;/);

  const cycle = /@keyframes co1dsand-logo-cycle\s*\{([\s\S]*?)\n\}/.exec(components);
  assert.ok(cycle, "缺少 @keyframes co1dsand-logo-cycle");
  assert.match(cycle[1], /0%,\s*94%\s*\{\s*opacity: 1;/, "写完要停住再淡出");
  assert.match(cycle[1], /97\.5%,\s*99\.9%\s*\{\s*opacity: 0;/, "mask 必须趁不可见时回卷");
});

/* @media 里嵌着规则块，非贪婪的 `[\s\S]*?\}` 会停在第一条规则的收尾花括号上，
   所以得数括号。 */
const atRuleBody = (css, at) => {
  const head = css.indexOf(at);
  if (head < 0) return null;
  const open = css.indexOf("{", head);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  return null;
};

test("降低动效偏好与打印下停掉全部书写动画", () => {
  /* 只看 logo 那两条 @media：这两个 at-rule 在 components.css 里还有别的用途。 */
  const tail = components.slice(components.indexOf("@keyframes co1dsand-logo-cycle"));
  for (const [label, at] of [
    ["降低动效", "@media (prefers-reduced-motion: reduce)"],
    ["打印", "@media print"],
  ]) {
    const body = atRuleBody(tail, at);
    assert.ok(body, `缺少${label}下的 @media`);
    for (let i = 0; i < NIBS.length; i += 1) {
      assert.match(body, new RegExp(`\\.co1dsand-nib-${i}[,\\s]`), `${label}下漏了第 ${i} 笔`);
    }
    assert.match(body, /\.co1dsand-logo-settle[,\s]/, `${label}下漏了补墨块`);
    assert.match(body, /\.co1dsand-logo-ink[,\s]/, `${label}下漏了墨迹淡出`);
    assert.match(body, /animation: none;/);
  }
});
