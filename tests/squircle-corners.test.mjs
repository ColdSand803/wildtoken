import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

const stylesEntry = read("static/styles.css");
const squircleCss = read("static/css/squircle.css");

test("全局样式接入连续曲率圆角表，并包裹在 @supports (corner-shape: squircle) 中做渐进增强", () => {
  assert.match(stylesEntry, /@import url\("\.\/css\/squircle\.css"\);/);
  assert.match(squircleCss, /@supports\s*\(corner-shape:\s*squircle\)/);

  // 确保所有非注释 corner-shape 声明都位于 @supports 块内部，不支持的浏览器保持原有圆弧
  const stripped = squircleCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const firstSupports = stripped.indexOf("@supports (corner-shape: squircle)");
  for (const match of stripped.matchAll(/\bcorner-shape\s*:/g)) {
    assert.ok(match.index > firstSupports, "corner-shape 不得泄漏到 @supports 之外");
  }
});

test("有圆角的主题启用 squircle 与视觉半径补偿，直角/像素主题保持方角", () => {
  assert.match(squircleCss, /:root\s*\{[^}]*--corner-shape:\s*squircle;/s);

  for (const sharpTheme of ["ark", "endfield", "minegrub"]) {
    assert.match(
      squircleCss,
      new RegExp(`html\\[data-theme="${sharpTheme}"\\][\\s\\S]*?--corner-shape:\\s*round;`),
      `${sharpTheme} 应关闭连续曲率`,
    );
    assert.match(
      squircleCss,
      new RegExp(`:not\\(\\[data-theme="${sharpTheme}"\\]\\)`),
      `共享选择器应排除直角主题 ${sharpTheme}`,
    );
    assert.doesNotMatch(
      read(`themes/${sharpTheme}/theme.css`),
      /corner-shape:\s*squircle/,
      `${sharpTheme} 自身不应开启 squircle`,
    );
  }

  for (const co1dsand of ["co1dsand-dark", "co1dsand-light"]) {
    const css = read(`themes/${co1dsand}/theme.css`);
    assert.match(css, /@supports\s*\(corner-shape:\s*squircle\)\s*\{[\s\S]*?--radius:\s*8px;/);
  }

  const gojoCss = read("themes/gojo/theme.css");
  assert.match(gojoCss, /@supports\s*\(corner-shape:\s*squircle\)\s*\{[\s\S]*?--gojo-control-radius:\s*8px;/);
  assert.match(squircleCss, /html\[data-theme="gojo"\]\s*:is\([\s\S]*?\.view > \.panel/);
});

test("核心圆角表面与控件覆盖 squircle，同时排除抽屉、正圆点与全圆角胶囊", () => {
  for (const selector of [
    "dialog:not(.dialog--drawer)",
    ".command-palette-panel",
    ".select-panel",
    ".theme-menu",
    ".col-menu",
    ".upstream-action-menu",
    ".toast",
    ".dashboard-kpi",
    ".kpi-card",
    ".dashboard-card",
    ".settings-card",
    ".wt-card",
    ".channel-card",
    ".table-wrap",
    ".status",
    ".summary-strip",
    "button:not(.conv-fold-all)",
    'input:not([type="radio"])',
    "select",
    "textarea",
    ".wt-seg",
    ".wt-seg-thumb",
    ".segmented-control",
  ]) {
    assert.ok(squircleCss.includes(selector), `${selector} 应纳入连续曲率圆角`);
  }

  // 抽屉维持 0 圆角与 round
  assert.match(
    squircleCss,
    /:root dialog\.dialog--drawer[\s\S]*?border-radius:\s*0;\s*corner-shape:\s*round;/,
  );

  // 正圆点与胶囊轨道不能挂进 squircle 规则，否则正圆变方圆、胶囊端帽变平
  const stripped = squircleCss.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const preservedRound of [
    ".status-switch-thumb",
    ".theme-swatch",
    ".live-dot",
    ".aurora-blob",
    ".log-rate-pill",
    ".status-switch-track",
    ".wt-segbar",
  ]) {
    const escaped = preservedRound.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    // 注意区分五条悟里单独改成有限圆角的局部轨道与全局胶囊
    assert.doesNotMatch(stripped, new RegExp(`${escaped}(?![\\w-])`));
  }
});

test("手机端底部导航菜单启用连续曲率圆角，且 ark / endfield / minegrub 保持原样", () => {
  const stripped = squircleCss.replace(/\/\*[\s\S]*?\*\//g, "");
  const mobileDockSelector =
    'html[data-theme]:not([data-theme="ark"]):not([data-theme="endfield"]):not([data-theme="minegrub"]) .app-shell .topbar .topbar-nav';

  // 1) 在移动端断点下恢复 --radius-md 圆角（压过各主题桌面端的 border-radius: 0）
  assert.ok(stripped.includes(mobileDockSelector), "缺少排除直角/像素风主题的手机底栏选择器");
  assert.match(
    stripped,
    /@media\s*\(max-width:\s*760px\),\s*\(orientation:\s*portrait\)\s*and\s*\(max-width:\s*960px\)\s*\{[\s\S]*?\.app-shell \.topbar \.topbar-nav\s*\{\s*border-radius:\s*var\(--radius-md\);/,
  );

  // 2) 在 @supports (corner-shape: squircle) 的移动端断点内接入连续曲率
  const supportsSlice = stripped.slice(stripped.indexOf("@supports (corner-shape: squircle)"));
  assert.match(
    supportsSlice,
    /@media\s*\(max-width:\s*760px\),\s*\(orientation:\s*portrait\)\s*and\s*\(max-width:\s*960px\)\s*\{[\s\S]*?\.app-shell \.topbar \.topbar-nav\s*\{\s*corner-shape:\s*var\(--corner-shape\);/,
  );
});
