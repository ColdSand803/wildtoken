# 凉砂（co1dsand）主题包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为 WildToken 控制台新增 `co1dsand-light`（凉砂·日）与 `co1dsand-dark`（凉砂·夜）两个主题包，移植 antfu.me 的极简纸感风格与左上角 SVG 扫过动画 logo。

**Architecture:** 两个纯 CSS 主题包，作用域一律 `html[data-theme="<id>"]`，样式表由 `admin.html` 运行时按 `data-theme-pack-css` 插在 `/static/styles.css` 之后，因此无需 `!important`。主体是 token 覆盖表；结构性覆盖只有四处（关掉 aurora、导航透明度阶梯、logo 显隐、`::selection`）。**不做左侧轨道**——`tests/theme-sidebar-layout.test.mjs:9-13` 的主题名单是写死的三个，凉砂不在其中；且 antfu.me 自己的导航就是顶部横排，保留 WildToken 默认顶栏更忠实。动态 logo 以第二个 `<svg>` 并列进 `.brand-mark`，靠主题作用域的 `display` 切换，其他主题完全不受影响。

**Tech Stack:** 原生 CSS（无预处理器、无构建）、原生 JS 全局脚本、Go 后端按目录扫描主题包（`internal/themes/themes.go`）、`node:test` 契约测试。

**Spec:** `docs/superpowers/specs/2026-09-03-co1dsand-theme-design.md`

> **注意：本计划修正了 spec 的 8 处缺陷**，以本计划的值为准。清单见文末「与 spec 的差异」。

## Global Constraints

- **主题 id**：`co1dsand-light`、`co1dsand-dark`。必须与目录名逐字相同，否则 `internal/themes/themes.go:87` 拒绝该包。
- **`theme.json` 字段**：`id` / `label` / `css` / `swatch` / `version` / `description`。**没有 `author` 字段**。`css` 必填且必须是相对 `.css` 路径，否则 `themes.go:94` 拒绝该包。
- **注册两处，缺一不可**：`static/js/events.js` 的 `BUNDLED_THEME_PACKS`，以及 `static/admin.html` 的 `bundledThemeCss`。只改一处的后果：`admin.html:27` 的成员资格校验判定 id 不合法，首屏直接回落 `dark`。
- **CSS 作用域**：每条规则前缀 `html[data-theme="co1dsand-light"]` 或 `html[data-theme="co1dsand-dark"]`。禁止裸选择器，禁止 `!important`。
- **颜色语法**：空格分隔的现代语法 `rgb(136 136 136 / 27%)`。仓库通行写法，不用 `rgba(136,136,136,0.27)`。
- **禁止触碰的三类选择器**（目录扫描型守卫会自动检查新包）：
  - 不写 `.summary-strip` 后跟后代/子/兄弟组合符的规则 —— `tests/channel-page-layout.test.mjs:131`
  - 若写 `.icon-close` 与 `.icon-maximize` 同列的规则，必须一并写上 `.icon-refresh` —— `tests/dialog-icon-family.test.mjs:34`。最省事的做法是完全不碰对话框图标。
  - 不写 `[data-view="…"]` 逐视图规则，也不写 `content: "01"` 型编号 —— 一旦写了，`tests/theme-view-coverage.test.mjs:43` 会要求覆盖全部 6 个视图。
- **字体**：`Inter` 已由 `admin.html:60` 的 Google Fonts 链接加载，无需 `@font-face`。中文走系统 fallback，不引入网络字体。
- **测试命令**：`node --test "tests/*.test.mjs"`。单文件：`node --test tests/<name>.test.mjs`。
- **提交**：每个 Task 末尾提交一次，message 用中文，遵循 `type(scope): 描述` 格式（参考 `git log --oneline`）。

---

### Task 1: 凉砂·日 主题包（token 表 + 注册）

**Files:**
- Create: `themes/co1dsand-light/theme.json`
- Create: `themes/co1dsand-light/theme.css`
- Modify: `static/js/events.js:15-22`（`BUNDLED_THEME_PACKS` 数组末尾追加一项）
- Modify: `static/admin.html:13-20`（`bundledThemeCss` 映射追加一项）
- Test: `tests/co1dsand-light-theme.test.mjs`

**Interfaces:**
- Produces: 主题 id `co1dsand-light`；CSS href `/theme-packs/co1dsand-light/theme.css`；label `凉砂·日`；swatch `["#ffffff", "#111111"]`；description `纸面留白、灰阶墨梯与半透明分隔线，改编自 antfu.me。`。Task 2 复用同一套结构，Task 3、4 往这个文件追加规则。

- [ ] **Step 1: 写失败的契约测试**

创建 `tests/co1dsand-light-theme.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("themes/co1dsand-light/theme.json"));
const css = read("themes/co1dsand-light/theme.css");
const events = read("static/js/events.js");
const adminHtml = read("static/admin.html");

test("凉砂·日 的清单字段完整且与目录名一致", () => {
  assert.deepEqual(manifest, {
    id: "co1dsand-light",
    label: "凉砂·日",
    css: "theme.css",
    swatch: ["#ffffff", "#111111"],
    version: "1.0.0",
    description: "纸面留白、灰阶墨梯与半透明分隔线，改编自 antfu.me。",
  });
});

test("凉砂·日 铺开纸面底色与四级墨梯", () => {
  assert.match(css, /html\[data-theme="co1dsand-light"\]\s*\{/);
  for (const token of [
    "color-scheme: light;",
    "--bg: #ffffff;",
    "--bg-elevated: #fafafa;",
    "--text: #222222;",
    "--text-secondary: #555555;",
    "--muted-strong: #6b6b6b;",
    "--muted: #888888;",
    "--accent: #111111;",
    "--accent-strong: #000000;",
    "--accent-on: #ffffff;",
    "--brand-ink: #ffffff;",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
});

test("凉砂·日 的分隔线是同值适配明暗的半透明灰", () => {
  for (const token of [
    "--line: rgb(136 136 136 / 27%);",
    "--line-strong: rgb(136 136 136 / 47%);",
    "--line-soft: rgb(136 136 136 / 15%);",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
});

test("凉砂·日 收掉了渐变光晕：aurora 关闭、accent-glow 透明", () => {
  assert.ok(css.includes("--accent-glow: transparent;"));
  assert.ok(css.includes("--aurora-a: transparent;"));
  assert.match(css, /html\[data-theme="co1dsand-light"\] \.aurora\s*\{\s*display: none;/);
});

test("凉砂·日 的圆角比默认更克制，字体栈补了中文", () => {
  assert.ok(css.includes("--radius-sm: 4px;"));
  assert.ok(css.includes("--radius: 6px;"));
  assert.ok(css.includes("--radius-md: 8px;"));
  assert.match(css, /--font-sans: "Inter", "PingFang SC", "Microsoft YaHei"/);
});

test("凉砂·日 在主题注册表初始化前后都可选", () => {
  const cssHref = "/theme-packs/co1dsand-light/theme.css";
  assert.match(
    events,
    /\{ id: "co1dsand-light", label: "凉砂·日", swatch: \["#ffffff", "#111111"\], css: "\/theme-packs\/co1dsand-light\/theme\.css", description: ".*" \}/,
  );
  assert.ok(adminHtml.includes(`"co1dsand-light": "${cssHref}"`));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/co1dsand-light-theme.test.mjs`
Expected: FAIL，报 `ENOENT: no such file or directory ... themes/co1dsand-light/theme.json`

- [ ] **Step 3: 写清单文件**

创建 `themes/co1dsand-light/theme.json`：

```json
{
  "id": "co1dsand-light",
  "label": "凉砂·日",
  "css": "theme.css",
  "swatch": ["#ffffff", "#111111"],
  "version": "1.0.0",
  "description": "纸面留白、灰阶墨梯与半透明分隔线，改编自 antfu.me。"
}
```

- [ ] **Step 4: 写 token 表**

创建 `themes/co1dsand-light/theme.css`：

```css
/* 凉砂·日：纸面留白，灰阶墨梯，半透明分隔线。改编自 antfu.me。
   底色是纯白纸面，正文不用纯黑；层级几乎全靠墨色深浅与不透明度拉开，
   而非换色相。分隔线一律 #888 加 alpha —— 同一个值在明暗两套里都成立，
   这是这套风格的骨架。零渐变、零光晕、零毛玻璃。 */

html[data-theme="co1dsand-light"] {
  color-scheme: light;

  /* 纸面 —— 白，代码框下沉一档 */
  --bg: #ffffff;
  --bg-elevated: #fafafa;
  --panel: rgb(255 255 255 / 82%);
  --panel-solid: #ffffff;
  --panel-subtle: #fcfcfc;
  --panel-muted: #fafafa;
  --panel-elevated: #ffffff;
  --glass: rgb(255 255 255 / 82%);
  --glass-strong: rgb(255 255 255 / 94%);

  /* 墨梯 —— antfu 的四级前景色。#222 给标题与主文，#888 给附注，
     两端之间留两档过渡。#888 在白底上是 3.5:1，只用于次要信息。 */
  --text: #222222;
  --text-secondary: #555555;
  --muted-strong: #6b6b6b;
  --muted: #888888;

  /* 分隔线 —— 半透明灰，与凉砂·夜逐字相同 */
  --line: rgb(136 136 136 / 27%);
  --line-strong: rgb(136 136 136 / 47%);
  --line-soft: rgb(136 136 136 / 15%);

  /* 强调 —— 没有品牌色，最深的墨就是强调色 */
  --accent: #111111;
  --accent-strong: #000000;
  --accent-soft: rgb(17 17 17 / 5%);
  --accent-border: rgb(17 17 17 / 22%);
  --accent-glow: transparent;
  --accent-on: #ffffff;
  --brand-ink: #ffffff;
```

继续写入同一个 `html[data-theme="co1dsand-light"]` 块：

```css
  /* 语义色 —— 必须覆盖。base.css 的默认值是给深色底调的亮色，
     直接搬到白底上对比度不够。这里取低饱和版本，全部 ≥ 4.5:1。 */
  --danger: #b3453f;
  --danger-soft: rgb(179 69 63 / 9%);
  --danger-border: rgb(179 69 63 / 30%);
  --danger-strong: #8f322d;
  --ok: #3f7d58;
  --ok-soft: rgb(63 125 88 / 10%);
  --ok-border: rgb(63 125 88 / 30%);
  --ok-strong: #2f6344;
  --warning: #8a6414;
  --warning-soft: rgb(138 100 20 / 10%);
  --warning-border: rgb(138 100 20 / 30%);
  --warning-strong: #6f5010;
  --warning-text: #6f5010;

  /* 焦点与投影 —— antfu 几乎不投影，这里压到只剩一层耳语。
     --focus-ring 是完整的 box-shadow 值，不是颜色。 */
  --focus: #111111;
  --focus-ring: 0 0 0 3px rgb(17 17 17 / 16%);
  --shadow-xs: 0 1px 2px rgb(0 0 0 / 4%);
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 5%);
  --shadow-md: 0 4px 16px rgb(0 0 0 / 7%);
  --shadow-lg: 0 10px 34px rgb(0 0 0 / 10%);
  --shadow: var(--shadow-sm);
  --glow-accent: 0 0 0 1px rgb(17 17 17 / 10%);

  /* 代码框 —— 比纸面低一档，不反色 */
  --code-frame-bg: #fafafa;
  --code-bg: #f4f4f4;
  --code-text: #222222;
  --code-muted: #888888;
  --code-border: rgb(136 136 136 / 27%);

  /* 交互面 —— hover 用半透明灰压一层，不换色 */
  --row-hover: rgb(136 136 136 / 7%);
  --row-disabled: rgb(136 136 136 / 4%);
  --topbar-bg: rgb(255 255 255 / 88%);
  --backdrop: rgb(0 0 0 / 32%);
  --neutral-chip: rgb(136 136 136 / 15%);
  --toast-neutral: #555555;

  /* 极光关掉 —— 这套风格里没有渐变色团 */
  --aurora-a: transparent;
  --aurora-b: transparent;
  --aurora-c: transparent;

  /* 圆角收紧一档：默认是 6/8/12，这里 4/6/8 */
  --radius-sm: 4px;
  --radius: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;

  /* Inter 已由 admin.html 的 Google Fonts 链接加载；中文走系统字体 */
  --font-sans: "Inter", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Source Han Sans SC", system-ui, sans-serif;
}

/* 渐变色团整块拿掉，而不只是把颜色调成透明——省掉三个模糊层的合成开销。 */
html[data-theme="co1dsand-light"] .aurora {
  display: none;
}

/* 选中态也用那个半透明灰。 */
html[data-theme="co1dsand-light"] ::selection {
  background: rgb(136 136 136 / 27%);
}
```

- [ ] **Step 5: 注册到运行时主题表**

修改 `static/js/events.js`，在 `BUNDLED_THEME_PACKS` 的 `gojo` 那一项之后（第 21 行后）追加：

```javascript
  { id: "co1dsand-light", label: "凉砂·日", swatch: ["#ffffff", "#111111"], css: "/theme-packs/co1dsand-light/theme.css", description: "纸面留白、灰阶墨梯与半透明分隔线，改编自 antfu.me。" },
```

- [ ] **Step 6: 注册到首屏防闪脚本**

修改 `static/admin.html`，在 `bundledThemeCss` 的 `gojo` 那一行之后（第 19 行后）追加：

```javascript
            "co1dsand-light": "/theme-packs/co1dsand-light/theme.css",
```

注意键名带连字符，必须加引号。

- [ ] **Step 7: 跑测试确认通过**

Run: `node --test tests/co1dsand-light-theme.test.mjs`
Expected: PASS，6 个 test 全绿

- [ ] **Step 8: 跑目录扫描型守卫，确认新包没踩线**

Run: `node --test tests/theme-view-coverage.test.mjs tests/dialog-icon-family.test.mjs tests/channel-page-layout.test.mjs tests/theme-sidebar-layout.test.mjs`
Expected: PASS。这四个里有三个按目录扫描 `themes/*`，新包会自动进入检查范围；`theme-sidebar-layout` 用写死名单，凉砂不在其中，不要求左侧轨道。

- [ ] **Step 9: 提交**

```bash
git add themes/co1dsand-light tests/co1dsand-light-theme.test.mjs static/js/events.js static/admin.html
git commit -m "feat(themes): 新增凉砂·日主题包"
```

---

### Task 2: 凉砂·夜 主题包（token 表 + 注册）

**Files:**
- Create: `themes/co1dsand-dark/theme.json`
- Create: `themes/co1dsand-dark/theme.css`
- Modify: `static/js/events.js`（`BUNDLED_THEME_PACKS` 追加第二项，紧跟 Task 1 那项之后）
- Modify: `static/admin.html`（`bundledThemeCss` 追加第二项）
- Test: `tests/co1dsand-dark-theme.test.mjs`

**Interfaces:**
- Consumes: Task 1 建立的包结构与注册位置。
- Produces: 主题 id `co1dsand-dark`；label `凉砂·夜`；swatch `["#050505", "#f0f0f0"]`；description `近黑纸面、灰阶墨梯与半透明分隔线，改编自 antfu.me。`。

- [ ] **Step 1: 写失败的契约测试**

创建 `tests/co1dsand-dark-theme.test.mjs`：

```javascript
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("themes/co1dsand-dark/theme.json"));
const css = read("themes/co1dsand-dark/theme.css");
const events = read("static/js/events.js");
const adminHtml = read("static/admin.html");
const lightCss = read("themes/co1dsand-light/theme.css");

test("凉砂·夜 的清单字段完整且与目录名一致", () => {
  assert.deepEqual(manifest, {
    id: "co1dsand-dark",
    label: "凉砂·夜",
    css: "theme.css",
    swatch: ["#050505", "#f0f0f0"],
    version: "1.0.0",
    description: "近黑纸面、灰阶墨梯与半透明分隔线，改编自 antfu.me。",
  });
});

test("凉砂·夜 铺开近黑底色与反向墨梯", () => {
  assert.match(css, /html\[data-theme="co1dsand-dark"\]\s*\{/);
  for (const token of [
    "color-scheme: dark;",
    "--bg: #050505;",
    "--bg-elevated: #0e0e0e;",
    "--text: #dddddd;",
    "--text-secondary: #bbbbbb;",
    "--muted-strong: #a0a0a0;",
    "--muted: #888888;",
    "--accent: #f0f0f0;",
    "--accent-strong: #ffffff;",
    "--accent-on: #050505;",
    "--brand-ink: #050505;",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
});

test("两套凉砂共用同一组半透明灰分隔线", () => {
  for (const token of [
    "--line: rgb(136 136 136 / 27%);",
    "--line-strong: rgb(136 136 136 / 47%);",
    "--line-soft: rgb(136 136 136 / 15%);",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
    assert.ok(lightCss.includes(token), `凉砂·日 也必须有 ${token}`);
  }
});

test("凉砂·夜 收掉了渐变光晕：aurora 关闭、accent-glow 透明", () => {
  assert.ok(css.includes("--accent-glow: transparent;"));
  assert.ok(css.includes("--aurora-a: transparent;"));
  assert.match(css, /html\[data-theme="co1dsand-dark"\] \.aurora\s*\{\s*display: none;/);
});

test("凉砂·夜 在主题注册表初始化前后都可选", () => {
  const cssHref = "/theme-packs/co1dsand-dark/theme.css";
  assert.match(
    events,
    /\{ id: "co1dsand-dark", label: "凉砂·夜", swatch: \["#050505", "#f0f0f0"\], css: "\/theme-packs\/co1dsand-dark\/theme\.css", description: ".*" \}/,
  );
  assert.ok(adminHtml.includes(`"co1dsand-dark": "${cssHref}"`));
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/co1dsand-dark-theme.test.mjs`
Expected: FAIL，报 `ENOENT ... themes/co1dsand-dark/theme.json`

- [ ] **Step 3: 写清单文件**

创建 `themes/co1dsand-dark/theme.json`：

```json
{
  "id": "co1dsand-dark",
  "label": "凉砂·夜",
  "css": "theme.css",
  "swatch": ["#050505", "#f0f0f0"],
  "version": "1.0.0",
  "description": "近黑纸面、灰阶墨梯与半透明分隔线，改编自 antfu.me。"
}
```

- [ ] **Step 4: 写 token 表（前半：纸面、墨梯、分隔线、强调）**

创建 `themes/co1dsand-dark/theme.css`：

```css
/* 凉砂·夜：近黑纸面，灰阶墨梯，半透明分隔线。改编自 antfu.me。
   底色 #050505 比代码框还深一档——这是原作的选择，让代码块自然浮起。
   分隔线与凉砂·日逐字相同：#888 加 alpha 在两套底色上都成立。 */

html[data-theme="co1dsand-dark"] {
  color-scheme: dark;

  /* 纸面 —— 近黑，代码框反而浮起一档 */
  --bg: #050505;
  --bg-elevated: #0e0e0e;
  --panel: rgb(14 14 14 / 82%);
  --panel-solid: #0e0e0e;
  --panel-subtle: #0a0a0a;
  --panel-muted: #0c0c0c;
  --panel-elevated: #121212;
  --glass: rgb(5 5 5 / 82%);
  --glass-strong: rgb(5 5 5 / 94%);

  /* 墨梯 —— 与日版反向。#888 是两套共用的那一档。 */
  --text: #dddddd;
  --text-secondary: #bbbbbb;
  --muted-strong: #a0a0a0;
  --muted: #888888;

  /* 分隔线 —— 与凉砂·日逐字相同 */
  --line: rgb(136 136 136 / 27%);
  --line-strong: rgb(136 136 136 / 47%);
  --line-soft: rgb(136 136 136 / 15%);

  /* 强调 —— 最亮的墨 */
  --accent: #f0f0f0;
  --accent-strong: #ffffff;
  --accent-soft: rgb(240 240 240 / 8%);
  --accent-border: rgb(240 240 240 / 26%);
  --accent-glow: transparent;
  --accent-on: #050505;
  --brand-ink: #050505;
```

- [ ] **Step 5: 写 token 表（后半：语义色、焦点、代码框、交互面、骨架）**

继续写入同一个 `html[data-theme="co1dsand-dark"]` 块：

```css
  /* 语义色 —— 深底上取偏亮的低饱和版本 */
  --danger: #e07b74;
  --danger-soft: rgb(224 123 116 / 12%);
  --danger-border: rgb(224 123 116 / 32%);
  --danger-strong: #ec938c;
  --ok: #6bbf8a;
  --ok-soft: rgb(107 191 138 / 12%);
  --ok-border: rgb(107 191 138 / 32%);
  --ok-strong: #85d1a1;
  --warning: #d9a441;
  --warning-soft: rgb(217 164 65 / 12%);
  --warning-border: rgb(217 164 65 / 32%);
  --warning-strong: #e8bf72;
  --warning-text: #e8bf72;

  /* 焦点与投影 —— --focus-ring 是完整的 box-shadow 值 */
  --focus: #f0f0f0;
  --focus-ring: 0 0 0 3px rgb(240 240 240 / 20%);
  --shadow-xs: 0 1px 2px rgb(0 0 0 / 40%);
  --shadow-sm: 0 1px 2px rgb(0 0 0 / 48%);
  --shadow-md: 0 4px 16px rgb(0 0 0 / 55%);
  --shadow-lg: 0 10px 34px rgb(0 0 0 / 62%);
  --shadow: var(--shadow-sm);
  --glow-accent: 0 0 0 1px rgb(240 240 240 / 10%);

  /* 代码框 —— 比纸面浮起一档 */
  --code-frame-bg: #0e0e0e;
  --code-bg: #121212;
  --code-text: #dddddd;
  --code-muted: #888888;
  --code-border: rgb(136 136 136 / 27%);

  /* 交互面 */
  --row-hover: rgb(136 136 136 / 7%);
  --row-disabled: rgb(136 136 136 / 4%);
  --topbar-bg: rgb(5 5 5 / 88%);
  --backdrop: rgb(0 0 0 / 62%);
  --neutral-chip: rgb(136 136 136 / 15%);
  --toast-neutral: #bbbbbb;

  /* 极光关掉 */
  --aurora-a: transparent;
  --aurora-b: transparent;
  --aurora-c: transparent;

  /* 圆角与字体 —— 与日版一致 */
  --radius-sm: 4px;
  --radius: 6px;
  --radius-md: 8px;
  --radius-lg: 12px;
  --font-sans: "Inter", "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", "Source Han Sans SC", system-ui, sans-serif;
}

html[data-theme="co1dsand-dark"] .aurora {
  display: none;
}

html[data-theme="co1dsand-dark"] ::selection {
  background: rgb(136 136 136 / 27%);
}
```

- [ ] **Step 6: 注册到运行时主题表**

修改 `static/js/events.js`，在 Task 1 追加的 `co1dsand-light` 那一项之后追加：

```javascript
  { id: "co1dsand-dark", label: "凉砂·夜", swatch: ["#050505", "#f0f0f0"], css: "/theme-packs/co1dsand-dark/theme.css", description: "近黑纸面、灰阶墨梯与半透明分隔线，改编自 antfu.me。" },
```

- [ ] **Step 7: 注册到首屏防闪脚本**

修改 `static/admin.html`，在 Task 1 追加的那一行之后追加：

```javascript
            "co1dsand-dark": "/theme-packs/co1dsand-dark/theme.css",
```

- [ ] **Step 8: 跑两套主题的测试确认通过**

Run: `node --test tests/co1dsand-light-theme.test.mjs tests/co1dsand-dark-theme.test.mjs`
Expected: PASS，11 个 test 全绿

- [ ] **Step 9: 提交**

```bash
git add themes/co1dsand-dark tests/co1dsand-dark-theme.test.mjs static/js/events.js static/admin.html
git commit -m "feat(themes): 新增凉砂·夜主题包"
```

---

### Task 3: 导航透明度阶梯

**Files:**
- Modify: `themes/co1dsand-light/theme.css`（文件末尾追加）
- Modify: `themes/co1dsand-dark/theme.css`（文件末尾追加）
- Test: `tests/co1dsand-nav-ink.test.mjs`

**背景：** spec 里那条「链接底边框」在这个项目上无处落地 —— `static/admin.html` 里一个 `<a>` 都没有（导航是 `<button class="nav-link">`），`static/css/**` 里也没有任何 `a` 选择器，JS 里三处 `createElement("a")` 全是点完即删的下载触发器。写了就是死代码。

antfu 真正贯穿全站的交互其实是另一条：**可点元素平时压到半透明，hover 才升到全不透明，且不换颜色**。WildToken 的 `.nav-link` 正是同构的元素，把这条移过来。同时按 antfu 的做法去掉胶囊底色 —— `base.css:729` 给的是 `--radius-full`，凉砂改成方角。

**Interfaces:**
- Consumes: Task 1、2 产出的两个 theme.css。
- Produces: 两个包末尾各一段 `.nav-link` 规则；无新增 token。

- [ ] **Step 1: 写失败的测试**

创建 `tests/co1dsand-nav-ink.test.mjs`：

```javascript
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
      new RegExp(`html\\[data-theme="${theme}"\\] \\.nav-link\\.is-active\\s*\\{[^}]*opacity: 1;`),
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

/* hover 换颜色就破了「只动不透明度」这条规矩。 */
test("导航 hover 不改颜色", () => {
  for (const [theme, css] of Object.entries(packs)) {
    const hover = new RegExp(`html\\[data-theme="${theme}"\\] \\.nav-link:hover\\s*\\{([^}]*)\\}`).exec(css);
    assert.ok(hover, `${theme} 缺少 .nav-link:hover 规则`);
    assert.doesNotMatch(hover[1], /(?:^|[^-])color:/, `${theme} 的导航 hover 不应改 color`);
  }
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/co1dsand-nav-ink.test.mjs`
Expected: FAIL，报 `凉砂·日 的导航静止态必须压到 0.6`（三个 test 都失败）

- [ ] **Step 3: 给凉砂·日 追加导航规则**

在 `themes/co1dsand-light/theme.css` 末尾追加：

```css
/* 导航：antfu 的做法是可点元素平时压到半透明，hover 只升不透明度、不换色。
   base.css 给的是 --radius-full 胶囊加 --muted-strong 墨色，这里收成方角，
   墨色交给不透明度去分层。 */
html[data-theme="co1dsand-light"] .nav-link {
  border-radius: var(--radius-sm);
  color: var(--text);
  opacity: 0.6;
  transition: opacity 0.2s ease-out;
}

html[data-theme="co1dsand-light"] .nav-link:hover {
  background: transparent;
  opacity: 1;
}

html[data-theme="co1dsand-light"] .nav-link.is-active {
  background: var(--accent-soft);
  opacity: 1;
}
```

- [ ] **Step 4: 给凉砂·夜 追加导航规则**

在 `themes/co1dsand-dark/theme.css` 末尾追加同构的一段（选择器前缀换成 `co1dsand-dark`）：

```css
/* 导航：同凉砂·日，只是墨色由 token 自己翻过来。 */
html[data-theme="co1dsand-dark"] .nav-link {
  border-radius: var(--radius-sm);
  color: var(--text);
  opacity: 0.6;
  transition: opacity 0.2s ease-out;
}

html[data-theme="co1dsand-dark"] .nav-link:hover {
  background: transparent;
  opacity: 1;
}

html[data-theme="co1dsand-dark"] .nav-link.is-active {
  background: var(--accent-soft);
  opacity: 1;
}
```

- [ ] **Step 5: 确认当前项的类名与代码一致**

Run: `grep -rn "is-active\|nav-link.*classList" static/js/shell.js | head -20`
Expected: 输出里能看到 `.nav-link` 被加上 `is-active`（或等价类名）。**若实际类名不是 `is-active`**，把 Step 1、3、4 里的 `.is-active` 全部替换成实际类名，再重跑 Step 2。

- [ ] **Step 6: 跑测试确认通过**

Run: `node --test tests/co1dsand-nav-ink.test.mjs`
Expected: PASS，3 个 test 全绿

- [ ] **Step 7: 提交**

```bash
git add themes/co1dsand-light/theme.css themes/co1dsand-dark/theme.css tests/co1dsand-nav-ink.test.mjs
git commit -m "feat(themes): 凉砂导航改用不透明度分层"
```

---

### Task 4: 动态 logo

**Files:**
- Modify: `static/admin.html:81-91`（`.brand-mark` 内并列第二个 `<svg>`）
- Modify: `themes/co1dsand-light/theme.css`（末尾追加）
- Modify: `themes/co1dsand-dark/theme.css`（末尾追加）
- Test: `tests/co1dsand-logo.test.mjs`

**做法：** 原 logo 留在原位不动，凉砂的 logo 作为第二个 `<svg class="co1dsand-logo">` 并列进 `.brand-mark`，默认 `display: none`。只有 `html[data-theme^="co1dsand-"]` 命中时才换过来。路径与动画参数照搬 `F:\dev\antfu-co1dsand\src\components\Logo.vue`，但 id 与 class 全部加 `co1dsand-` 前缀避免与页面其它 SVG 撞车。

**关键点：** `base.css:677` 有一条 `.brand-mark svg { display: block; height: 100%; width: 100% }`，它会让两个 SVG 都显示。所以隐藏必须写在主题包之外——用一条不带主题前缀的规则挂在 `.co1dsand-logo` 上做默认隐藏。这是唯一一处允许的裸选择器，因为它服务的是「其它主题下不要显示」这个跨主题约束；写进任何单个主题包都到不了。放在 `static/css/components.css` 末尾。

**Interfaces:**
- Consumes: Task 1、2 的两个 theme.css。
- Produces: `.co1dsand-logo` / `.co1dsand-logo-ink` / `.co1dsand-logo-sweep` 三个 class，`#co1dsand-logo-edge` / `#co1dsand-logo-reveal` 两个 SVG id，`@keyframes co1dsand-logo-draw`（两个包各定义一份，名字相同、内容相同 —— 同名 keyframes 后者覆盖前者，因为两套主题永不同时激活，等价）。

- [ ] **Step 1: 写失败的测试**

创建 `tests/co1dsand-logo.test.mjs`：

```javascript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `node --test tests/co1dsand-logo.test.mjs`
Expected: FAIL，5 个 test 全部失败，首条报 `/<svg class="co1dsand-logo"/` 不匹配

- [ ] **Step 3: 并列 logo 到品牌位**

修改 `static/admin.html`，把 `.brand-mark`（第 81-91 行）整块替换为下面这段。原 SVG 一字不动，只在它后面并列第二个：

```html
          <span class="brand-mark" aria-hidden="true">
            <svg width="22" height="22" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
              <rect width="64" height="64" rx="14" fill="currentColor" />
              <path d="M32 14v18M32 32l15 10M32 32L17 42" stroke="var(--brand-ink)" stroke-width="4" stroke-linecap="round" />
              <circle cx="32" cy="14" r="4.5" fill="var(--brand-ink)" />
              <circle cx="47" cy="42" r="4.5" fill="var(--brand-ink)" />
              <circle cx="17" cy="42" r="4.5" fill="var(--brand-ink)" />
              <circle cx="32" cy="32" r="7" fill="var(--brand-ink)" />
              <circle cx="32" cy="32" r="3" fill="currentColor" />
            </svg>
            <!-- 凉砂主题的标记：一道斜向渐变从 mask 里扫过，把笔画逐段带出来。
                 默认停在画完的位置（见 components.css 与主题包），动效被关掉时
                 标记依然完整。几何参数照搬 antfu.me 的 Logo.vue。 -->
            <svg class="co1dsand-logo" width="22" height="22" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
              <defs>
                <linearGradient id="co1dsand-logo-edge" x1="0" y1="0" x2="1" y2="0">
                  <stop offset="0" stop-color="#fff" />
                  <stop offset="0.9167" stop-color="#fff" />
                  <stop offset="1" stop-color="#fff" stop-opacity="0" />
                </linearGradient>
                <mask id="co1dsand-logo-reveal">
                  <g transform="translate(50 50) rotate(116.2)">
                    <rect class="co1dsand-logo-sweep" x="-240" y="-95" width="240" height="190" fill="url(#co1dsand-logo-edge)" />
                  </g>
                </mask>
              </defs>
              <path class="co1dsand-logo-ink" d="…" mask="url(#co1dsand-logo-reveal)" />
            </svg>
          </span>
```

`d="…"` 处填入 `F:\dev\antfu-co1dsand\src\components\Logo.vue` **第 21 行** `<path class="ink" d="` 之后、`" mask=` 之前的那串路径数据，逐字复制，不要重排也不要换行。原串以 `M82.1 43.88L83.5 44.05L8` 开头、以 `82.28 46.85L82.63 45.63Z` 结尾，长度 3080 字符。

注意 `<linearGradient>` 的 `stop-color` 保持 `#fff` 不动 —— 它喂的是 mask，mask 里只有亮度有意义，与主题配色无关；真正的墨色由 `.co1dsand-logo-ink` 的 `fill` 决定。

- [ ] **Step 4: 校验路径没被截断**

Run: `node -e "const m=require('fs').readFileSync('static/admin.html','utf8').match(/class=\"co1dsand-logo-ink\" d=\"([^\"]+)\"/); console.log(m ? m[1].length : 'NOT FOUND')"`
Expected: `3080`。若不是这个数，路径复制不完整，回到 Step 3 重做。

- [ ] **Step 5: 写跨主题的默认隐藏**

在 `static/css/components.css` 末尾追加：

```css
/* 凉砂主题的品牌标记 —— 平时不显示。
   这条不带主题前缀是刻意的：`.brand-mark svg` 在 base.css 里是 display: block，
   两个标记会一起画出来。要在「其它主题下」藏住它，规则就必须活在主题作用域之外；
   写进任一主题包只在那套主题激活时生效，等于没写。凉砂自己再把它显示回来。 */
.brand-mark .co1dsand-logo {
  display: none;
}
```

- [ ] **Step 6: 给凉砂·日 追加 logo 规则**

在 `themes/co1dsand-light/theme.css` 末尾追加：

```css
/* 品牌位换成凉砂的标记。base.css 给 .brand-mark 挂了
   `filter: drop-shadow(0 0 10px var(--accent-glow))`，--accent-glow 已经是
   transparent，所以这里不必再处理光晕。 */
html[data-theme="co1dsand-light"] .brand-mark > svg:first-child {
  display: none;
}

html[data-theme="co1dsand-light"] .brand-mark .co1dsand-logo {
  display: block;
}

html[data-theme="co1dsand-light"] .co1dsand-logo-ink {
  fill: var(--text);
  fill-rule: nonzero;
}

/* 默认态就是画完的位置：动画一旦被关，标记仍然完整。 */
html[data-theme="co1dsand-light"] .co1dsand-logo-sweep {
  transform: translateX(70.7px);
  animation: co1dsand-logo-draw 10s ease-in-out infinite both;
}

@keyframes co1dsand-logo-draw {
  0%,
  4% {
    transform: translateX(-58.3px);
  }
  42%,
  86% {
    transform: translateX(70.7px);
  }
  98%,
  to {
    transform: translateX(-58.3px);
  }
}

@media (prefers-reduced-motion: reduce) {
  html[data-theme="co1dsand-light"] .co1dsand-logo-sweep {
    animation: none;
  }
}

@media print {
  html[data-theme="co1dsand-light"] .co1dsand-logo-sweep {
    animation: none;
  }
}
```

- [ ] **Step 7: 给凉砂·夜 追加 logo 规则**

在 `themes/co1dsand-dark/theme.css` 末尾追加同一段，选择器前缀换成 `co1dsand-dark`：

```css
/* 品牌位换成凉砂的标记，墨色由 --text 自己翻过来。
   @keyframes 与日版同名同内容——两套主题永不同时激活，重复定义无副作用。 */
html[data-theme="co1dsand-dark"] .brand-mark > svg:first-child {
  display: none;
}

html[data-theme="co1dsand-dark"] .brand-mark .co1dsand-logo {
  display: block;
}

html[data-theme="co1dsand-dark"] .co1dsand-logo-ink {
  fill: var(--text);
  fill-rule: nonzero;
}

html[data-theme="co1dsand-dark"] .co1dsand-logo-sweep {
  transform: translateX(70.7px);
  animation: co1dsand-logo-draw 10s ease-in-out infinite both;
}

@keyframes co1dsand-logo-draw {
  0%,
  4% {
    transform: translateX(-58.3px);
  }
  42%,
  86% {
    transform: translateX(70.7px);
  }
  98%,
  to {
    transform: translateX(-58.3px);
  }
}

@media (prefers-reduced-motion: reduce) {
  html[data-theme="co1dsand-dark"] .co1dsand-logo-sweep {
    animation: none;
  }
}

@media print {
  html[data-theme="co1dsand-dark"] .co1dsand-logo-sweep {
    animation: none;
  }
}
```

- [ ] **Step 8: 跑测试确认通过**

Run: `node --test tests/co1dsand-logo.test.mjs`
Expected: PASS，5 个 test 全绿

- [ ] **Step 9: 提交**

```bash
git add static/admin.html static/css/components.css themes/co1dsand-light/theme.css themes/co1dsand-dark/theme.css tests/co1dsand-logo.test.mjs
git commit -m "feat(themes): 凉砂主题的品牌位换成扫过式动态标记"
```

---

### Task 5: 全量验收

**Files:**
- Modify: `themes/README.md`（主题清单追加两行，若该文件有清单）
- 可能 Modify: 两个 `theme.css`（按实机检查结果补微调）

**Interfaces:**
- Consumes: Task 1-4 的全部产出。
- Produces: 通过的全量测试 + 实机确认过的两套主题。

- [ ] **Step 1: 跑全量测试**

Run: `node --test "tests/*.test.mjs"`
Expected: 全绿。基线是 `6d7bfff` 记录的 237/237，加上本计划新增的 4 个文件共 15 个 test，应为 252/252 上下。**若有既有测试转红，先修，不要跳过。**

- [ ] **Step 2: 跑 Go 侧测试，确认主题包能被扫到**

Run: `go test ./internal/themes/...`
Expected: PASS

- [ ] **Step 3: 起服务**

Run: `go run ./cmd/wildtoken`（或仓库 README 里给的启动命令）
Expected: 服务起来，控制台可访问。

- [ ] **Step 4: 确认 /api/themes 返回了两个新包**

Run: `curl -s localhost:8080/api/themes | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const ids=JSON.parse(s).map(t=>t.id);console.log(ids.filter(i=>i.startsWith('co1dsand')))})"`
Expected: `[ 'co1dsand-dark', 'co1dsand-light' ]`（端口按实际配置调整）

- [ ] **Step 5: 实机逐视图检查**

在浏览器里选中「凉砂·日」，依次走过 6 个视图：看板、渠道、日志、令牌、分组、设置。每一页确认：

1. 没有色块糊成一片 —— 尤其看板的 KPI 卡、分段条、延迟曲线
2. 表格边框是淡灰细线，不是深色实线
3. 弹层（渠道详情、日志详情、任一表单）背景不透光、边框可见
4. 品牌位是凉砂标记，且能看到扫过动画（10 秒一轮）
5. 导航静止半透明、hover 变实、当前项有淡底

然后切「凉砂·夜」重走一遍。

**记录所有观感不对的位置**（文件 + 视图 + 现象），下一步统一修。

- [ ] **Step 6: 查硬编码颜色穿帮**

spec 第 3.3 节列了 core 层约 50 处硬编码，其中 `enhancements.css` 有 9 处形如 `var(--ok, #10b981)` 的暗色回退。这些在**变量存在时不会穿帮**——两套凉砂都定义了 `--ok`/`--danger`/`--warning`，所以回退不会触发。但下面这些是**裸色值**，会在凉砂·日下穿帮：

Run: `grep -n "background: #a855f7\|background: #38bdf8\|color: #a855f7" static/css/enhancements.css; grep -n "background: #fff" static/css/tables.css`
Expected: 命中 `enhancements.css:538,542,1054` 与 `tables.css:798`。

逐个到浏览器里找到对应元素，确认在凉砂·日下是否真的难看。**只修真出问题的**：在对应主题包末尾加一条覆盖规则，不要改 core 文件（那是独立任务，见 spec 第八节）。

- [ ] **Step 7: 查对比度**

用 Chrome DevTools 的 Elements → Accessibility 面板，在两套主题下各取三处采样：正文段落、`--muted` 的附注文字、表格表头。

Expected：正文与表头 ≥ 4.5:1。`--muted` 的 `#888888` 在白底是 3.5:1 —— 这是照抄 antfu 的值，只用于次要信息，可接受；但**若发现它被用在了正文或表单标签上**，把那处改取 `--muted-strong`。

- [ ] **Step 8: 按 Step 5-7 的记录补微调**

把记录下来的问题逐条修进对应主题包末尾。每条加一句注释说明为什么需要它。

若这一步没有任何要改的，跳过。

- [ ] **Step 9: 更新主题清单文档**

Run: `grep -n "sakura-mist\|anthropic\|gojo" themes/README.md | head`

若 `themes/README.md` 有主题清单表，按同样格式追加「凉砂·日 / 凉砂·夜」两行，注明改编自 antfu.me、CSS-only、无左侧轨道。若没有清单，跳过。

- [ ] **Step 10: 收尾跑一遍全量测试**

Run: `node --test "tests/*.test.mjs"`
Expected: 全绿

- [ ] **Step 11: 提交**

```bash
git add -A
git commit -m "feat(themes): 凉砂主题实机校准与清单登记"
```

---

## 与 spec 的差异

实现前核对代码时发现 spec 有 8 处与实际不符，本计划已按实际修正。**以计划为准**，spec 留作设计意图的记录。

| # | spec 的说法 | 实际情况 | 不改的后果 |
|---|---|---|---|
| 1 | `theme.json` 有 `author` 字段 | 字段是 `id`/`label`/`css`/`swatch`/`version`/`description`，**`css` 必填** | `internal/themes/themes.go:94` 直接拒收整个包 |
| 2 | 未提注册 | 必须同时登记进 `events.js:15-22` 的 `BUNDLED_THEME_PACKS` 与 `admin.html:13-20` 的 `bundledThemeCss` | `admin.html:27` 判 id 不合法，首屏回落 `dark`，主题根本选不到 |
| 3 | `--brand-ink: #555555`（等于 `--text`） | 它是 logo 的**镂空色**，等于底色：`base.css:38` 深色 `#020617`、`:161` 浅色 `#ffffff` | 原 logo 内部的线与点糊进底板，看不见 |
| 4 | `--focus-ring` 是颜色 | 是完整的 `box-shadow` 值，如 `0 0 0 3px rgb(…)` | 焦点环失效，键盘导航看不出焦点在哪 |
| 5 | 语义色与 aurora「不覆盖」 | 必须覆盖。`base.css` 的语义色是给深色底调的亮色；aurora 是渐变色团，与「零渐变」的风格直接冲突 | 凉砂·日 上语义色对比度不足；两套主题背后都飘着彩色光斑 |
| 6 | `rgba(136,136,136,0.27)` | 仓库通行的是空格语法 `rgb(136 136 136 / 27%)` | 与既有六个包风格不一，review 会挑 |
| 7 | 做「链接底边框」 | **控制台里一个可见 `<a>` 都没有**：`admin.html` 零命中，`static/css/**` 无 `a` 选择器，JS 三处 `createElement("a")` 全是点完即删的下载触发器 | 纯死代码。已替换为 antfu 另一条同样标志性、且在本项目有落点的交互：导航不透明度分层（Task 3） |
| 8 | 未提左侧轨道 | **不需要做**。`tests/theme-sidebar-layout.test.mjs:9-13` 的名单写死为 anthropic/anthropic-dark/sakura-mist，凉砂不在其中；且 antfu.me 自己的导航就是顶部横排 | 无。这是省下的工作量，也更忠实于原作 |

另外三条目录扫描型守卫会自动把新包纳入检查，Global Constraints 里已列出规避方式：`channel-page-layout`（`.summary-strip` 后代选择器）、`dialog-icon-family`（对话框图标三件套）、`theme-view-coverage`（逐视图规则与编号连续性）。凉砂做成纯 token 包 + 四处结构覆盖，天然不触发这三条。

## 自查

**spec 覆盖**：token 映射 → Task 1、2；链接交互 → Task 3（已改为导航不透明度，理由见差异表第 7 条）；动态 logo → Task 4；契约测试 → 各 Task 的 Step 1；实机验收与对比度 → Task 5；README 登记 → Task 5 Step 9。spec 第八节列为「当前不做」的五项（core 层硬编码、slide-enter、transition 时长、语义色、View Transitions）——其中语义色已按差异表第 5 条改为必做，其余四项确认不做。

**占位符**：无 TBD/TODO。唯一没有逐字展开的是 logo 的 `d` 属性（3080 字符），给的是精确来源（`Logo.vue:21`）、首尾片段与长度，并配了 Task 4 Step 4 的长度校验命令。

**命名一致**：`.co1dsand-logo` / `.co1dsand-logo-ink` / `.co1dsand-logo-sweep`、`#co1dsand-logo-edge` / `#co1dsand-logo-reveal`、`@keyframes co1dsand-logo-draw` 在 HTML、两个包、测试三处逐字一致。主题 id `co1dsand-light` / `co1dsand-dark` 在目录名、`theme.json` 的 `id`、`events.js`、`admin.html`、测试文件五处一致。`.nav-link.is-active` 的类名有 Task 3 Step 5 兜底核对。











