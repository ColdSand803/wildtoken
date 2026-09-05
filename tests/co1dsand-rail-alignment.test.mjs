import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

/* 仓库里 CRLF 与 LF 两种行尾都有，选择器跨行的规则要能在两种下都匹配。 */
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replace(/\r\n/g, "\n");
const rail = read("static/css/console-rail.css");
const darkTheme = read("static/css/dark-theme.css");
const packs = {
  "co1dsand-light": read("themes/co1dsand-light/theme.css"),
  "co1dsand-dark": read("themes/co1dsand-dark/theme.css"),
};

/** 取一条规则的声明块。 */
function ruleBody(css, selector) {
  const match = new RegExp(`${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  assert.ok(match, `缺少规则 ${selector}`);
  return match[1];
}

/** 取一个自定义属性的字面值。 */
function customProp(css, name) {
  const match = new RegExp(`${name}:\\s*([^;]+);`).exec(css);
  assert.ok(match, `缺少变量 ${name}`);
  return match[1].trim();
}

const ICONS = ["dashboard", "upstreams", "logs", "tokens", "groups", "settings", "density", "logout"];

/* console-rail.css 把选择器写死在两个内置主题上，主题包各自带一份轨道。抄一份
   就有漂移的风险：改了内置的图标而忘了包里的，同一个页签在两套主题下会是两个
   形状。这条把 8 个 data URI 逐字锁在一起。 */
test("两套凉砂的轨道图标与内置逐字相同", () => {
  for (const [theme, css] of Object.entries(packs)) {
    for (const icon of ICONS) {
      assert.equal(
        customProp(css, `--rail-icon-${icon}`),
        customProp(rail, `--rail-icon-${icon}`),
        `${theme} 的 --rail-icon-${icon} 与 console-rail.css 不一致`,
      );
    }
  }
});

/* 图标盒、底部记号尺寸、图标与标签的间距，三者一起决定了行的几何。任一处与内置
   不同，凉砂的轨道就会和内置的对不上 —— 这正是用户当初指出的那种「看着不一样」。 */
test("两套凉砂的轨道行几何与内置一致", () => {
  for (const [theme, css] of Object.entries(packs)) {
    for (const token of ["--rail-icon-box", "--rail-icon-foot", "--rail-gap"]) {
      assert.equal(
        customProp(css, token),
        customProp(rail, token),
        `${theme} 的 ${token} 与 console-rail.css 不一致`,
      );
    }
  }
});

/* 内置轨道的宽度是 118px：14px 左缩进 + 16px 图标 + 9px 间距 + 13px 的两字标签
   + 10px 尾部留白。凉砂必须取同一个数，否则两套主题的舞台起始位置会跳。 */
test("凉砂的轨道宽度与内置的 118px 对齐", () => {
  const builtin = customProp(darkTheme, "--dk-rail-width");
  assert.equal(builtin, "118px", "内置轨道宽度变了，这条测试的基准要跟着改");
  for (const [theme, css] of Object.entries(packs)) {
    assert.equal(
      customProp(css, "--co1dsand-rail-width"),
      builtin,
      `${theme} 的轨道宽度必须与内置一致`,
    );
  }
});

/* 图标靠 --rail-icon-<view> 变量 + mask-image 规则两处配合，少任何一处那个页签
   左边就是空白。 */
test("两套凉砂的六个视图都绑到了图标", () => {
  for (const [theme, css] of Object.entries(packs)) {
    for (const view of ["dashboard", "upstreams", "logs", "tokens", "groups", "settings"]) {
      assert.match(
        css,
        new RegExp(
          `html\\[data-theme="${theme}"\\] \\.nav-link\\[data-view="${view}"\\]::before[\\s\\S]{0,120}?mask-image:\\s*var\\(--rail-icon-${view}\\)`,
        ),
        `${theme} 缺少 ${view} 的 mask-image 绑定`,
      );
    }
  }
});

/* 本包的导航是整行压到 opacity 0.6 的，图标是这一行的后代。若 ::before 再自带一层
   0.6，合成后是 0.36 —— 图标会比标签明显淡一档，而 console-rail.css 里那份恰恰
   带着 opacity: 0.6（内置轨道不压整行，所以那边是对的）。照抄就会踩这个坑。 */
test("凉砂的轨道图标不再叠一层不透明度", () => {
  assert.match(
    ruleBody(rail, 'html[data-theme="dark"] .nav-link::before,\nhtml[data-theme="light"] .nav-link::before'),
    /opacity: 0\.6;/,
    "内置那份本来就带 opacity，这条前提没了则本测试失去意义",
  );

  for (const [theme, css] of Object.entries(packs)) {
    for (const selector of [
      `html[data-theme="${theme}"] .nav-link::before`,
      `html[data-theme="${theme}"] .topbar-actions .density-toggle::before`,
    ]) {
      assert.doesNotMatch(
        ruleBody(css, selector),
        /opacity:/,
        `${theme} 的 ${selector} 不应自带 opacity——整行已经压过一层`,
      );
    }
  }
});

/* 用户最先看出来的就是这个：内置是标记在上、字在下整块居中，凉砂当初写成了横排
   左对齐，于是「看着和默认的深色侧边栏不太一样」。 */
test("两套凉砂的品牌区竖排居中", () => {
  for (const [theme, css] of Object.entries(packs)) {
    assert.match(
      ruleBody(css, `html[data-theme="${theme}"] .topbar-brand`),
      /flex-direction: column;/,
      `${theme} 的品牌区必须竖排`,
    );
    assert.match(
      ruleBody(css, `html[data-theme="${theme}"] .brand-text`),
      /text-align: center;/,
      `${theme} 的品牌文字必须居中`,
    );
  }
});

/* 轨道只有 118px，而菜单的 min-width 是 156px。base.css 让它 `right: 0; top:
   calc(100% + 8px)` 往下掉，在竖排轨道里会溢出视口右边缘。 */
test("两套凉砂的主题菜单从轨道旁边推出", () => {
  for (const [theme, css] of Object.entries(packs)) {
    const body = ruleBody(css, `html[data-theme="${theme}"] .theme-menu`);
    assert.match(body, /left: calc\(100% \+ 12px\);/, `${theme} 的主题菜单必须开在轨道右侧`);
    assert.match(body, /right: auto;/, `${theme} 必须解掉 base 的 right: 0`);
  }
});

/* 轨道主题里滚的是舞台而不是整页，滚动条因此画在滚动容器的右边界上。base.css 把
   .content 卡在 --content-max（1440px）并 margin-inline: auto 居中——内置深色为此
   专门解掉这个上限，把它挪到里层的 .view 上，滚动条才落在舞台右缘。凉砂两包接管
   了滚动却漏掉这一步，于是宽屏下滚动条缩进到 1440px 文本列的右侧，和内置的位置
   差着一段。窗口窄于 1440px 时两者恰好重合，所以这个差只在宽屏上看得见。 */
test("两套凉砂的舞台滚动条与内置一样贴在舞台右缘", () => {
  assert.match(
    ruleBody(darkTheme, 'html[data-theme="dark"] .content'),
    /max-width: none;/,
    "内置若不再解掉上限，这条测试的基准要跟着改",
  );
  assert.match(
    ruleBody(darkTheme, 'html[data-theme="dark"] .content > .view'),
    /max-width: var\(--content-max\);/,
    "内置若不再把上限挪到 .view，这条测试的基准要跟着改",
  );

  for (const [theme, css] of Object.entries(packs)) {
    const content = ruleBody(css, `html[data-theme="${theme}"] .content`);
    assert.match(
      content,
      /max-width: none;/,
      `${theme} 的 .content 必须解掉 base 的 --content-max，否则滚动条缩进到文本列右侧`,
    );
    assert.match(content, /overflow-x: hidden;/, `${theme} 的 .content 满幅后要挡住横向溢出`);

    const view = ruleBody(css, `html[data-theme="${theme}"] .content > .view`);
    assert.match(view, /margin-inline: auto;/, `${theme} 的视图必须自己居中`);
    assert.match(
      view,
      /max-width: var\(--content-max\);/,
      `${theme} 的 --content-max 上限要挪到视图上`,
    );
  }
});
