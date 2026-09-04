import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const packs = {
  "co1dsand-light": read("themes/co1dsand-light/theme.css"),
  "co1dsand-dark": read("themes/co1dsand-dark/theme.css"),
};

/* antfu 的可点元素靠不透明度分层，不靠换色：静止 0.6，hover 1，当前项 1。
   两套凉砂必须一致，否则日夜切换时导航的手感会不一样。 */
test("两套凉砂的导航都用不透明度分层", () => {
  for (const [theme, css] of Object.entries(packs)) {
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.nav-link\\s*\\{[^}]*opacity: 0\\.6;`),
      `${theme} 的导航静止态必须压到 0.6`,
    );
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.nav-link:hover\\s*\\{[^}]*opacity: 1;`),
      `${theme} 的导航 hover 必须升到 1`,
    );
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.nav-link\\.active\\s*\\{[^}]*opacity: 1;`),
      `${theme} 的当前项必须是 1`,
    );
  }
});

/* base.css:729 给导航的是 --radius-full 胶囊；antfu 的导航是方的。 */
test("两套凉砂的导航去掉了胶囊圆角", () => {
  for (const [theme, css] of Object.entries(packs)) {
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.nav-link\\s*\\{[^}]*border-radius: var\\(--radius-sm\\);`),
      `${theme} 的导航应收到 --radius-sm`,
    );
  }
});

/* 0.6 的不透明度会把前景往轨道底色 --panel-muted 拉，所以静止态的实际对比度取决于
   起始墨色：日版用 --text（#222222）合成后只有 4.21:1，过不了 WCAG AA 的 4.5:1；
   改用 --accent（#111111）合成到 #6e6e6e，4.87:1。夜版同样取 --accent 以保持日夜
   手感一致（6.51:1）。这条一旦被改回 --text，日版就会重新掉到 AA 线下。 */
test("两套凉砂的导航墨色取 --accent，保证 0.6 不透明度下仍过 AA", () => {
  for (const [theme, css] of Object.entries(packs)) {
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.nav-link\\s*\\{[^}]*color: var\\(--accent\\);`),
      `${theme} 的导航墨色必须是 var(--accent)——var(--text) 在 0.6 下过不了 AA`,
    );
  }
});

/* base.css 的 .nav-link.active 会叠 `var(--shadow-xs), 0 0 0 1px var(--accent-border)`，
   跟本包「零光晕」的自述冲突，两个包都必须显式关掉。 */
test("两套凉砂的当前项关掉了 base 的光环", () => {
  for (const [theme, css] of Object.entries(packs)) {
    assert.match(
      css,
      new RegExp(`html\\[data-theme="${theme}"\\] \\.nav-link\\.active\\s*\\{[^}]*box-shadow: none;`),
      `${theme} 的当前项必须 box-shadow: none，否则残留 base 的描边光环`,
    );
  }
});

/* hover 换颜色就破了「只动不透明度」这条规矩。 */
test("导航 hover 不改颜色", () => {
  for (const [theme, css] of Object.entries(packs)) {
    const hover = new RegExp(`html\\[data-theme="${theme}"\\] \\.nav-link:hover\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(hover, `${theme} 缺少 .nav-link:hover 规则`);
    assert.doesNotMatch(hover[1], /(?:^|[^-])color:/, `${theme} 的导航 hover 不应改 color`);
  }
});
