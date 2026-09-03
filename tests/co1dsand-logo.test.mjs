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

/* 默认态停在画完的位置，动画被关掉时标记依然完整可见。 */
test("扫过动画默认停在画完的位置，并尊重降低动效与打印", () => {
  for (const [theme, css] of Object.entries(packs)) {
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.co1dsand-logo-sweep\\s*\\{[^}]*transform: translateX\\(70\\.7px\\);`),
      `${theme} 的 sweep 默认态必须是画完的`,
    );
    assert.match(css, /@keyframes co1dsand-logo-draw/, `${theme} 缺少动画定义`);
    assert.match(
      css,
      /@media \(prefers-reduced-motion: reduce\)\s*\{[\s\S]{0,300}?animation: none;/,
      `${theme} 必须在降低动效偏好下停掉动画`,
    );
    assert.match(
      css,
      /@media print\s*\{[\s\S]{0,300}?animation: none;/,
      `${theme} 必须在打印时停掉动画`,
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
