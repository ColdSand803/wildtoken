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

test("品牌位并列了凉砂的 logo，且带 mask 与渐变两个 defs", () => {
  assert.match(adminHtml, /<svg class="co1dsand-logo"/);
  assert.ok(adminHtml.includes('id="co1dsand-logo-edge"'), "缺少渐变 defs");
  assert.ok(adminHtml.includes('id="co1dsand-logo-reveal"'), "缺少 mask defs");
  assert.match(adminHtml, /class="co1dsand-logo-sweep"[\s\S]{0,200}?fill="url\(#co1dsand-logo-edge\)"/);
  assert.match(adminHtml, /class="co1dsand-logo-ink"[\s\S]{0,4000}?mask="url\(#co1dsand-logo-reveal\)"/);
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

/* 默认态停在画完的位置，动画被关掉时标记依然完整可见。
   两条 @media 的 `animation: none` 必须锚到本主题的 .co1dsand-logo-sweep 上：
   只断言这两个 at-rule 里「某处」有 animation: none，换成任何别的选择器都能骗过去。 */
test("扫过动画默认停在画完的位置，并尊重降低动效与打印", () => {
  for (const [theme, css] of Object.entries(packs)) {
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.co1dsand-logo-sweep\\s*\\{[^}]*transform: translateX\\(70\\.7px\\);`),
      `${theme} 的 sweep 默认态必须是画完的`,
    );
    assert.match(css, /@keyframes co1dsand-logo-draw/, `${theme} 缺少动画定义`);
    for (const [atRule, pattern, label] of [
      ["prefers-reduced-motion", /@media \(prefers-reduced-motion: reduce\)\s*\{([\s\S]*?)\n\}/, "降低动效偏好下"],
      ["print", /@media print\s*\{([\s\S]*?)\n\}/, "打印时"],
    ]) {
      const block = pattern.exec(css);
      assert.ok(block, `${theme} 缺少 @media ${atRule} 区块`);
      assert.match(
        block[1],
        new RegExp(`html\\[data-theme="${theme}"\\] \\.co1dsand-logo-sweep\\s*\\{[^}]*animation: none;`),
        `${theme} 必须在${label}停掉 .co1dsand-logo-sweep 的动画，而不是别的选择器`,
      );
    }
  }
});

/* 关键帧两端与默认态是一组不变量：默认态的 70.7px 必须和 42%/86% 帧同值，
   否则动画每轮结束时标记会跳一下；-58.3px 是起笔位置，改了就会露出未画完的字形。 */
test("扫过动画的关键帧端点锁死，且与默认态同值", () => {
  for (const [theme, css] of Object.entries(packs)) {
    const frames = /@keyframes co1dsand-logo-draw\s*\{([\s\S]*?)\n\}/.exec(css);
    assert.ok(frames, `${theme} 缺少 @keyframes co1dsand-logo-draw`);
    assert.ok(frames[1].includes("-58.3px"), `${theme} 的关键帧缺少起笔端点 -58.3px`);
    assert.ok(frames[1].includes("70.7px"), `${theme} 的关键帧缺少画完端点 70.7px`);
    assert.match(
      frames[1],
      /42%,\s*86%\s*\{\s*transform: translateX\(70\.7px\);/,
      `${theme} 的 42%/86% 帧必须停在 70.7px`,
    );
    const settled = new RegExp(
      `html\\[data-theme="${theme}"\\] \\.co1dsand-logo-sweep\\s*\\{[^}]*transform: translateX\\(70\\.7px\\);`,
    );
    assert.match(css, settled, `${theme} 的默认态必须与 42%/86% 帧同值，否则每轮收尾会跳`);
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
