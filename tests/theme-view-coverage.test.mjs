import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

/** 控制台的全部视图，按导航里的顺序。 */
function consoleViews() {
  const markup = read("static/admin.html");
  const nav = markup.slice(
    markup.indexOf('<div class="topbar-nav"'),
    markup.indexOf("</div>", markup.indexOf('<div class="topbar-nav"')),
  );
  const views = [...nav.matchAll(/data-view="([a-z-]+)"/g)].map((match) => match[1]);
  assert.notEqual(views.length, 0, "导航里必须有视图");
  return views;
}

/** 逐个视图写死规则的主题。这类主题加视图必须同步补规则。 */
function themesWithPerViewRules() {
  const themesDir = path.join(root, "themes");
  return fs
    .readdirSync(themesDir)
    .filter((name) => fs.existsSync(path.join(themesDir, name, "theme.css")))
    .map((name) => ({ name, css: read(`themes/${name}/theme.css`) }))
    .filter((theme) => /\[data-view="[a-z-]+"\]/.test(theme.css));
}

test("导航项与视图节点成对出现", () => {
  const markup = read("static/admin.html");
  for (const view of consoleViews()) {
    // 少了视图节点，点导航就没反应。
    assert.match(
      markup,
      new RegExp(`<section class="view[^"]*" data-view="${view}"`),
      `${view} 缺少视图节点`,
    );
  }
});

test("逐视图写死规则的主题覆盖了每一个视图", () => {
  const views = consoleViews();
  const themes = themesWithPerViewRules();
  assert.notEqual(themes.length, 0, "至少应有一个逐视图定制的主题");

  for (const theme of themes) {
    const covered = new Set(
      [...theme.css.matchAll(/\[data-view="([a-z-]+)"\]/g)].map((match) => match[1]),
    );
    for (const view of views) {
      /* 这类主题给每个视图配了编号、标题或水印。漏一个视图，那一页就会缺编号或
         缺标题——加导航标签时最容易忘的正是这里。 */
      assert.ok(
        covered.has(view),
        `主题 ${theme.name} 没有覆盖视图 ${view}`,
      );
    }
  }
});

test("编号型主题的序号连续且不重复", () => {
  for (const theme of themesWithPerViewRules()) {
    // 只看形如 content: "01" 或 "01 / TITLE" 的编号。
    const numbers = [...theme.css.matchAll(/content:\s*"(\d{2})(?:\s*\/[^"]*)?"/g)]
      .map((match) => match[1]);
    if (numbers.length === 0) {
      continue;
    }

    // 同一编号可以出现在多处（编号本身 + 带标题的那份），按去重后的集合检查连续性。
    const unique = [...new Set(numbers)].sort();
    for (const [index, value] of unique.entries()) {
      const expected = String(index + 1).padStart(2, "0");
      assert.equal(
        value,
        expected,
        `主题 ${theme.name} 的编号不连续：出现 ${value}，期望 ${expected}`,
      );
    }
  }
});

test("每个导航项都有对应的轨道图标", () => {
  const css = read("static/css/console-rail.css");
  for (const view of consoleViews()) {
    /* 图标靠 --rail-icon-<view> 变量 + mask-image 规则两处配合。少任何一处，
       那个页签左边就是空白——加导航项时最容易漏的正是这里。 */
    assert.match(
      css,
      new RegExp(`--rail-icon-${view}:\\s*url\\("data:image/svg\\+xml,`),
      `缺少 --rail-icon-${view} 变量`,
    );
    assert.match(
      css,
      new RegExp(`\\.nav-link\\[data-view="${view}"\\]::before[\\s\\S]{0,200}?mask-image:\\s*var\\(--rail-icon-${view}\\)`),
      `缺少 ${view} 的 mask-image 绑定`,
    );
  }
});

test("轨道图标的线稿风格保持一致", () => {
  const css = read("static/css/console-rail.css");
  const icons = [...css.matchAll(/--rail-icon-([a-z]+):\s*url\("data:image\/svg\+xml,([^"]+)"\)/g)];
  assert.ok(icons.length >= 6, "图标数量异常");

  for (const [, name, encoded] of icons) {
    const svg = decodeURIComponent(encoded);
    // 混进不同的画布尺寸或线宽，图标在同一行里会明显轻重不一。
    assert.match(svg, /viewBox='0 0 24 24'/, `${name} 画布尺寸不一致`);
    assert.match(svg, /stroke-width='1\.8'/, `${name} 线宽不一致`);
    assert.match(svg, /stroke-linecap='round'/, `${name} 线端样式不一致`);
  }
});
