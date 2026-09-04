import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const packs = {
  "co1dsand-light": read("themes/co1dsand-light/theme.css"),
  "co1dsand-dark": read("themes/co1dsand-dark/theme.css"),
};

const ruleBody = (css, selector) => {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  return match ? match[1] : null;
};

/* tables.css:798 把滑块写死成 #fff。凉砂两套的轨道底色是 --panel-muted，
   日版 #fafafa 对白只有 1.04:1，关闭态的滑块肉眼看不见。必须两套都覆盖，
   否则日夜切换时开关的可见度不一样。 */
test("两套凉砂都把开关滑块从写死的白色接回 token", () => {
  for (const [theme, css] of Object.entries(packs)) {
    const off = ruleBody(css, `html[data-theme="${theme}"] .status-switch-thumb`);
    assert.ok(off, `${theme} 缺少 .status-switch-thumb 覆盖`);
    assert.match(off, /background: var\(--muted-strong\);/, `${theme} 关闭态滑块应取 --muted-strong`);

    const on = ruleBody(css, `html[data-theme="${theme}"] .status-switch.on .status-switch-thumb`);
    assert.ok(on, `${theme} 缺少开启态滑块覆盖`);
    assert.match(on, /background: var\(--accent-on\);/, `${theme} 开启态滑块应取 --accent-on`);
  }
});

/* 本包自述「零光晕」，base 那层 0 1px 2px rgb(15 23 42 / 25%) 得关掉。 */
test("开关滑块不留 base 的投影", () => {
  for (const [theme, css] of Object.entries(packs)) {
    const off = ruleBody(css, `html[data-theme="${theme}"] .status-switch-thumb`);
    assert.match(off, /box-shadow: none;/, `${theme} 应关掉滑块投影`);
  }
});

/* enhancements.css:1054 的紫字落在自己 12% 紫的淡底上是 3.43:1，字号 11px，
   AA 要 4.5:1。紫色相也是这套灰阶配色里唯一的外来色。 */
test("两套凉砂都把配额徽章的紫色收进灰阶", () => {
  for (const [theme, css] of Object.entries(packs)) {
    const body = ruleBody(css, `html[data-theme="${theme}"] .quota-period-badge`);
    assert.ok(body, `${theme} 缺少 .quota-period-badge 覆盖`);
    assert.match(body, /color: var\(--text\);/, `${theme} 徽章文字应取 --text`);
    assert.match(body, /background: var\(--neutral-chip\);/, `${theme} 徽章底应取 --neutral-chip`);
    assert.match(body, /border-color: var\(--line\);/, `${theme} 徽章描边应取 --line`);
    assert.doesNotMatch(body, /#a855f7|168 85 247/i, `${theme} 徽章不该残留紫色`);
  }
});

/* 覆盖一律走 token，写死颜色会在后续调色时失同步。 */
test("这两组覆盖里没有写死的十六进制颜色", () => {
  for (const [theme, css] of Object.entries(packs)) {
    for (const selector of [
      `html[data-theme="${theme}"] .status-switch-thumb`,
      `html[data-theme="${theme}"] .status-switch.on .status-switch-thumb`,
      `html[data-theme="${theme}"] .quota-period-badge`,
    ]) {
      const body = ruleBody(css, selector);
      assert.doesNotMatch(body, /#[0-9a-f]{3,8}\b/i, `${selector} 不该写死颜色`);
    }
  }
});
