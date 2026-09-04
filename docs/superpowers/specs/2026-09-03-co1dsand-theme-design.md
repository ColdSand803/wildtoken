# 凉砂（co1dsand）主题设计文档

**日期**：2026-09-03  
**作者**：co1dsand  
**状态**：待审查

---

## 概述

为 WildToken 新建两个主题包 `co1dsand-light`（凉砂·日）和 `co1dsand-dark`（凉砂·夜），移植 [antfu.me](https://github.com/antfu/antfu.me) 的设计风格——极简克制纸感，灰阶层级，半透明边框，链接底边框交互，以及左上角动态 logo（仅 co1dsand 主题下启用）。

### 设计目标

1. **配色忠实复刻** antfu.me 的四级前景色体系（`--fg-deeper/deep/regular/light`）和半透明灰边框
2. **精选特征移植**：链接底边框 hover、小圆角、中文字体栈、动态 logo
3. **主题包独立性**：不改 wildtoken core 层代码（除了 admin.html 加一个 SVG），与现有 6 个主题包平级
4. **适配控制台场景**：不做全站逐段落 slide-enter（会很吵），保持 wildtoken 原有交互节奏

---

## 一、主题包元数据

### 目录结构

```
themes/
├── co1dsand-light/
│   ├── theme.json
│   └── theme.css
└── co1dsand-dark/
    ├── theme.json
    └── theme.css
```

### theme.json（两个主题）

**co1dsand-light/theme.json**：
```json
{
  "id": "co1dsand-light",
  "label": "凉砂·日",
  "description": "极简纸感，灰阶克制，链接底边框。改编自 antfu.me。",
  "author": "co1dsand (adapted from antfu.me)",
  "swatch": ["#ffffff", "#555555"]
}
```

**co1dsand-dark/theme.json**：
```json
{
  "id": "co1dsand-dark",
  "label": "凉砂·夜",
  "description": "极简纸感，灰阶克制，链接底边框。改编自 antfu.me。",
  "author": "co1dsand (adapted from antfu.me)",
  "swatch": ["#050505", "#bbbbbb"]
}
```

---

## 二、Token 映射表

将 antfu.me 的配色体系映射到 WildToken 的 105 个 token。关键策略：

1. **四级前景色**：antfu 的 `--fg-deeper/deep/regular/light` → wildtoken 的 `--text/--muted-strong/--muted/--text-secondary`
2. **半透明灰边框**：`rgba(136,136,136,0.27)` 同值适配明暗（antfu 的灵魂特征）
3. **无品牌主色**：antfu 的 accent 就是最深前景色（黑/白），直接映射到 `--accent`
4. **语义色保持**：wildtoken 的 `--ok/--danger/--warning` 不变（antfu 几乎不用语义色）

### 完整映射表

| wildtoken token | co1dsand-light | co1dsand-dark | 说明 |
|---|---|---|---|
| **Surfaces** | | | |
| `--bg` | `#ffffff` | `#050505` | 页面背景，antfu 的纯白/近黑 |
| `--bg-elevated` | `#fafafa` | `#0e0e0e` | 浮起面，代码块背景 |
| `--panel` | `rgba(250,250,250,0.72)` | `rgba(14,14,14,0.72)` | 半透明面板 |
| `--panel-solid` | `#fafafa` | `#0e0e0e` | 不透明面板 |
| `--panel-subtle` | `rgba(250,250,250,0.5)` | `rgba(14,14,14,0.5)` | 更淡的面板 |
| `--panel-muted` | `#f5f5f5` | `#0a0a0a` | 静默面 |
| `--panel-elevated` | `#ffffff` | `#0e0e0e` | 最高浮起 |
| `--glass` | `rgba(255,255,255,0.8)` | `rgba(5,5,5,0.8)` | 玻璃效果（虽然 antfu 不用毛玻璃，但保留 token） |
| `--glass-strong` | `rgba(255,255,255,0.95)` | `rgba(5,5,5,0.95)` | 强玻璃 |
| **Text（核心）** | | | |
| `--text` | `#555555` | `#bbbbbb` | 正文，antfu `--fg` |
| `--text-secondary` | `#888888` | `#888888` | 次要文字，antfu `--fg-light`，**两边故意相同** |
| `--muted` | `#aaaaaa` | `#666666` | 更淡的文字 |
| `--muted-strong` | `#222222` | `#dddddd` | 次强文字，antfu `--fg-deep` |
| **Borders（灵魂）** | | | |
| `--line` | `rgba(136,136,136,0.27)` | `rgba(136,136,136,0.27)` | **antfu 半透明灰，同值适配明暗** |
| `--line-strong` | `rgba(136,136,136,0.47)` | `rgba(136,136,136,0.47)` | 稍强的边框，同值 |
| `--line-soft` | `rgba(136,136,136,0.15)` | `rgba(136,136,136,0.15)` | 更淡的边框 |
| **Accent** | | | |
| `--accent` | `#000000` | `#ffffff` | 强调色，antfu `--fg-deeper`（黑/白） |
| `--accent-strong` | `#222222` | `#dddddd` | 深一档 |
| `--accent-soft` | `rgba(0,0,0,0.06)` | `rgba(255,255,255,0.06)` | 淡底色 |
| `--accent-border` | `rgba(0,0,0,0.2)` | `rgba(255,255,255,0.2)` | 强调边框 |
| `--accent-glow` | `rgba(0,0,0,0.1)` | `rgba(255,255,255,0.1)` | 发光效果（保留但 antfu 不用） |
| `--accent-on` | `#ffffff` | `#000000` | 强调色上的文字（反色） |
| `--brand-ink` | `#555555` | `#bbbbbb` | 品牌墨色，与 `--text` 同值 |
| **Semantic（保持 wildtoken 原值）** | | | |
| `--danger` / `--ok` / `--warning` 及其变体 | *不覆盖* | *不覆盖* | antfu 几乎不用语义色，保持 wildtoken 默认 |
| **Focus/Elevation** | | | |
| `--focus` | `#888888` | `#888888` | 焦点色，低对比 |
| `--focus-ring` | `rgba(136,136,136,0.5)` | `rgba(136,136,136,0.5)` | 焦点环 |
| `--shadow-xs` | `0 1px 2px rgba(0,0,0,0.05)` | `0 1px 2px rgba(0,0,0,0.2)` | 极小阴影 |
| `--shadow-sm` | `0 1px 3px rgba(0,0,0,0.08)` | `0 1px 3px rgba(0,0,0,0.3)` | 小阴影 |
| `--shadow-md` | `0 2px 6px rgba(0,0,0,0.1)` | `0 2px 6px rgba(0,0,0,0.4)` | 中阴影 |
| `--shadow-lg` | `0 4px 12px rgba(0,0,0,0.12)` | `0 4px 12px rgba(0,0,0,0.5)` | 大阴影 |
| `--shadow` | `0 1px 3px rgba(0,0,0,0.08)` | `0 1px 3px rgba(0,0,0,0.3)` | 默认阴影 |
| `--glow-accent` | `0 0 0 transparent` | `0 0 0 transparent` | antfu 不用发光 |
| **Code** | | | |
| `--code-frame-bg` | `#fafafa` | `#0e0e0e` | 代码块背景，与 `--bg-elevated` 同 |
| `--code-bg` | `#f5f5f5` | `#0a0a0a` | 行内代码背景 |
| `--code-text` | `#222222` | `#dddddd` | 代码文字 |
| `--code-muted` | `#888888` | `#888888` | 代码次要（行号等） |
| `--code-border` | `rgba(136,136,136,0.27)` | `rgba(136,136,136,0.27)` | 代码边框 |
| **交互面** | | | |
| `--row-hover` | `rgba(136,136,136,0.08)` | `rgba(136,136,136,0.08)` | 行 hover |
| `--row-disabled` | `rgba(136,136,136,0.05)` | `rgba(136,136,136,0.05)` | 禁用行 |
| `--topbar-bg` | `rgba(255,255,255,0.8)` | `rgba(5,5,5,0.8)` | 顶栏背景 |
| `--backdrop` | `rgba(0,0,0,0.5)` | `rgba(0,0,0,0.7)` | 遮罩 |
| `--neutral-chip` | `rgba(136,136,136,0.15)` | `rgba(136,136,136,0.15)` | 中性标签 |
| `--toast-neutral` | `#555555` | `#bbbbbb` | toast 文字 |
| **Aurora（保持 wildtoken 原值）** | | | |
| `--aurora-a/b/c` | *不覆盖* | *不覆盖* | 背景装饰，保持原有 |
| **Radius（更克制）** | | | |
| `--radius-sm` | `4px` | `4px` | 小圆角（wildtoken 原 6px） |
| `--radius` | `6px` | `6px` | 默认圆角（wildtoken 原 8px） |
| `--radius-md` | `8px` | `8px` | 中圆角（wildtoken 原 12px） |
| `--radius-lg` | `12px` | `12px` | 大圆角（wildtoken 原 16px） |
| `--radius-full` | `999px` | `999px` | 完全圆（不变） |
| **Font（补中文）** | | | |
| `--font-sans` | `Inter, "PingFang SC", "Microsoft YaHei", "Hiragino Sans GB", STHeiti, sans-serif` | 同 | antfu 的 Inter + 系统中文 fallback |
| `--font-mono` | *不覆盖* | *不覆盖* | 保持 wildtoken 的 Fira Code |
| `--font-secret` | *不覆盖* | *不覆盖* | 保持 JetBrains Mono |

### 不覆盖的 token（继承 wildtoken base.css）

- **Spacing**：`--space-1..8` —— 骨架 token，主题无关
- **Type scale**：`--text-xs..3xl` —— 字号阶梯，主题无关
- **Layout**：`--topbar-height` / `--content-max` / `--control-h` 等 —— 几何 token，主题无关
- **Transition**：`--transition` —— 保持 wildtoken 的 180ms cubic-bezier(.2,.8,.2,1)，不改为 antfu 的 300ms（控制台场景需要快节奏）

---

## 三、链接样式覆盖（antfu 招牌交互）

### 核心规则

```css
/* 两个主题包都需要这段 */
html[data-theme="co1dsand-light"] a:not(.nav-link):not([class*="btn"]):not(.channel-card-link):not(.ops-bar a):not(.toolbar a),
html[data-theme="co1dsand-dark"] a:not(.nav-link):not([class*="btn"]):not(.channel-card-link):not(.ops-bar a):not(.toolbar a) {
  text-decoration: none;
  border-bottom: 1px solid rgba(125, 125, 125, 0.3);
  transition: border 0.3s ease-in-out;
}

html[data-theme="co1dsand-light"] a:not(.nav-link):not([class*="btn"]):not(.channel-card-link):not(.ops-bar a):not(.toolbar a):hover,
html[data-theme="co1dsand-dark"] a:not(.nav-link):not([class*="btn"]):not(.channel-card-link):not(.ops-bar a):not(.toolbar a):hover {
  border-bottom: 1px solid var(--text);
}
```

### 排除列表（不应有底边框的链接）

实现时需逐个验证 wildtoken 的所有链接位置，确保排除：

1. **导航按钮**：`.nav-link` —— 顶栏标签
2. **工具栏按钮**：`.ops-bar a` / `.toolbar a` —— 表格/列表上方的操作栏
3. **卡片链接**：`.channel-card-link` / `.settings-card > a` —— 整卡可点击
4. **按钮形态的链接**：`[class*="btn"]` —— 任何带 `btn` class 的 `<a>`
5. **表格内操作**：`td a.action` 之类（实现时补充）

### 覆盖位置（需要底边框的链接）

根据 wildtoken 现有结构，以下位置的链接应该生效：

- 日志详情弹层内的外链（如果有）
- 设置页的文档链接（如果有）
- `.prose` 区域内的链接（如果引入 Markdown 内容）
- 页脚的外链（如果有）

**注意**：wildtoken 是控制台应用，链接很少。实现时先加这条通用规则，测试时检查是否有误伤（把不该有底边框的链接也加了）。

---

## 四、动态 Logo 实现（仅 co1dsand 主题）

### 目标

把 antfu.me 的 SVG mask 扫过动画移植到 wildtoken 左上角的 `.brand-mark`，仅在 `co1dsand-light` / `co1dsand-dark` 主题下启用。

### HTML 改动（admin.html:81-90）

在 `.brand-mark` 内新增一个 `.antfu-logo` SVG，默认隐藏：

```html
<span class="brand-mark" aria-hidden="true">
  <!-- 原 wildtoken logo，保持不变 -->
  <svg width="22" height="22" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect width="64" height="64" rx="14" fill="currentColor" />
    <path d="M32 14v18M32 32l15 10M32 32L17 42" stroke="var(--brand-ink)" stroke-width="4" stroke-linecap="round" />
    <circle cx="32" cy="14" r="4.5" fill="var(--brand-ink)" />
    <circle cx="47" cy="42" r="4.5" fill="var(--brand-ink)" />
    <circle cx="17" cy="42" r="4.5" fill="var(--brand-ink)" />
    <circle cx="32" cy="32" r="7" fill="var(--brand-ink)" />
    <circle cx="32" cy="32" r="3" fill="currentColor" />
  </svg>
  
  <!-- 新增：antfu 动态 logo，默认隐藏 -->
  <svg class="antfu-logo" width="22" height="22" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="co1dsand-logo-edge" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0" stop-color="currentColor" />
        <stop offset="0.9167" stop-color="currentColor" />
        <stop offset="1" stop-color="currentColor" stop-opacity="0" />
      </linearGradient>
      <mask id="co1dsand-logo-reveal">
        <g transform="translate(50 50) rotate(116.2)">
          <rect class="co1dsand-logo-sweep" x="-240" y="-95" width="240" height="190" fill="url(#co1dsand-logo-edge)" />
        </g>
      </mask>
    </defs>
    <path class="co1dsand-logo-ink" d="M82.1 43.88L83.5 44.05L83.85 46.33L81.75 50.52L77.73 56.12L75.63 61.02L73.53 68.37L73.53 74.67L72.83 74.67L72.13 73.97L71.08 71.87L71.08 66.8L67.76 71.52L64.61 74.14L63.03 73.79L63.03 72.39L62.33 72.74L61.28 72.39L61.11 70.47L57.44 74.67L56.56 74.67L56.04 73.97L56.56 70.82L53.59 74.32L52.71 74.49L52.01 73.97L51.84 72.22L50.09 73.97L49.04 74.49L47.64 74.49L46.94 73.62L46.94 72.57L48.34 70.12L50.09 68.72L49.21 68.54L40.64 70.12L39.94 71.52L34.87 75.89L30.49 78.52L23.15 81.84L19.47 83.07L14.05 84.12L11.07 84.12L9.67 83.24L10.02 81.67L11.6 80.27L20.35 75.19L28.92 71.69L39.24 68.54L39.07 66.45L37.14 64.7L33.47 62.95L25.94 60.32L23.5 59.1L21.92 57.7L21.75 56.12L22.27 55.07L24.19 53.32L28.92 50.52L36.09 47.55L38.72 46.85L40.29 47.03L39.59 48.08L36.44 50.35L35.22 51.75L34.87 51.75L35.04 51.05L38.89 47.9L38.54 47.55L35.74 48.6L26.12 53.85L23.67 55.77L23.32 57L24.02 57.87L26.47 59.1L34.87 61.9L38.89 63.82L40.82 65.75L41.34 68.19L48.51 66.97L53.94 66.8L54.29 67.15L54.11 67.84L52.01 68.54L50.44 69.77L48.69 71.87L48.34 73.09L50.26 72.22L53.41 68.37L54.29 68.54L53.59 72.04L57.44 67.32L58.49 67.32L58.83 68.02L58.31 71.34L61.98 67.5L63.21 67.67L63.03 70.47L65.13 67.5L66.88 66.1L67.41 66.27L67.58 66.97L65.13 69.77L64.43 71.52L64.43 72.22L64.78 72.22L67.41 69.07L73.18 59.97L79.3 47.55L81.4 44.4L82.1 44.05ZM46.76 7.49L48.86 7.49L49.56 8.01L49.74 10.11L49.04 12.04L48.51 12.39L48.86 10.81L48.86 8.89L48.51 8.54L46.94 8.71L43.26 10.81L36.79 16.06L31.37 21.48L23.67 30.93L21.05 35.13L18.6 41.08L18.6 43.88L19.3 44.93L20.52 45.45L23.15 45.28L26.82 43.7L31.37 40.73L36.62 36.35L37.32 36.88L34.69 39.85L33.82 41.43L33.64 43L35.57 42.65L38.37 40.9L43.96 36.18L51.66 28.31L55.86 23.58L60.76 16.58L64.43 13.09L65.66 13.44L65.13 15.53L56.74 24.81L52.01 32.5L48.86 39.5L48.69 42.13L50.26 42.48L55.34 39.68L58.14 36.88L59.01 36.88L60.06 36.18L60.23 36.88L58.31 38.1L56.39 40.73L55.86 41.95L55.86 42.48L56.39 42.48L62.16 37.23L68.28 30.41L80.7 14.31L83.33 11.69L84.38 11.86L84.38 12.91L73.36 27.08L68.98 35.65L67.93 39.33L68.11 41.6L71.78 43.35L71.78 43.88L67.41 43.18L66.01 41.6L65.83 39.15L67.41 33.73L61.81 39.68L57.79 43L56.21 43.7L55.16 43.53L54.81 43L55.51 40.9L55.16 40.55L53.76 41.95L50.79 43.53L48.16 43.53L47.29 42.48L47.46 38.98L48.86 35.3L50.61 32.33L50.61 31.46L42.56 39.15L35.74 43.7L33.12 43.88L32.59 43L33.12 41.08L32.77 40.73L30.67 42.65L25.59 45.8L22.97 46.68L19.65 46.68L17.55 45.28L16.85 43.53L16.85 41.43L18.25 36.88L22.27 29.88L28.74 21.66L36.09 14.31L43.26 9.06L46.76 7.66ZM84.38 74.32L89.8 74.49L92.43 75.19L93.83 76.42L94 77.82L92.95 79.57L90.68 81.32L77.03 89.36L75.98 89.19L77.03 87.79L90.33 77.99L89.98 77.47L87.53 77.12L78.95 77.47L68.46 79.22L54.81 82.72L36.62 88.49L28.04 90.76L20.7 92.16L17.37 92.51L10.55 92.34L7.57 91.11L6.7 90.24L6 88.49L6.35 85.86L7.22 85.51L7.05 88.31L8.27 89.89L9.67 90.59L15.45 90.94L19.3 90.41L32.07 87.26L51.84 80.79L63.38 77.64L75.81 75.19L84.38 74.49ZM37.84 70.82L29.27 73.27L21.75 76.24L13.17 80.79L11.6 82.19L11.95 82.54L18.07 81.49L28.74 77.47L34.87 73.97L38.02 70.82ZM82.63 45.45L81.23 47.55L81.4 47.9L82.28 46.85L82.63 45.63Z" fill-rule="nonzero" mask="url(#co1dsand-logo-reveal)" />
  </svg>
</span>
```

### CSS 显隐切换（写在主题包 theme.css）

```css
/* 默认：显示原 wildtoken logo，隐藏 antfu logo */
.brand-mark svg { display: block; }
.brand-mark .antfu-logo { display: none; }

/* co1dsand 主题下：隐藏原 logo，显示 antfu logo */
html[data-theme="co1dsand-light"] .brand-mark svg:first-child,
html[data-theme="co1dsand-dark"] .brand-mark svg:first-child {
  display: none;
}

html[data-theme="co1dsand-light"] .brand-mark .antfu-logo,
html[data-theme="co1dsand-dark"] .brand-mark .antfu-logo {
  display: block;
}
```

### CSS 动画（写在主题包 theme.css）

```css
/* logo 墨色 */
html[data-theme="co1dsand-light"] .co1dsand-logo-ink {
  fill: #555555; /* 与 --text 同值 */
  fill-rule: nonzero;
}

html[data-theme="co1dsand-dark"] .co1dsand-logo-ink {
  fill: #bbbbbb;
  fill-rule: nonzero;
}

/* 扫过动画 */
html[data-theme="co1dsand-light"] .co1dsand-logo-sweep,
html[data-theme="co1dsand-dark"] .co1dsand-logo-sweep {
  transform: translateX(70.7px); /* 默认态是画完的 */
  animation: co1dsand-logo-draw 10s ease-in-out infinite both;
}

@keyframes co1dsand-logo-draw {
  0%, 4% {
    transform: translateX(-58.3px);
  }
  42%, 86% {
    transform: translateX(70.7px);
  }
  98%, to {
    transform: translateX(-58.3px);
  }
}

/* 尊重用户偏好：关闭动画 */
@media (prefers-reduced-motion: reduce) {
  html[data-theme="co1dsand-light"] .co1dsand-logo-sweep,
  html[data-theme="co1dsand-dark"] .co1dsand-logo-sweep {
    animation: none;
  }
}

/* 打印时关闭动画 */
@media print {
  html[data-theme="co1dsand-light"] .co1dsand-logo-sweep,
  html[data-theme="co1dsand-dark"] .co1dsand-logo-sweep {
    animation: none;
  }
}
```

### 技术要点

1. **ID 改名**：antfu 原版的 `id="logo-edge"` / `id="logo-reveal"` 改为 `co1dsand-logo-edge` / `co1dsand-logo-reveal`，避免与页面其他 SVG 的 ID 冲突
2. **class 改名**：`.ink` / `.sweep` 改为 `.co1dsand-logo-ink` / `.co1dsand-logo-sweep`，避免全局 class 污染
3. **颜色用 token**：`fill: #555555` / `fill: #bbbbbb` 与 `--text` 同值，但这里直接写死（因为 SVG 的 `fill` 无法用 CSS 变量，或者可以用 `fill: var(--text)` 但需要验证）
4. **尺寸匹配**：保持 `width="22" height="22"` 与原 wildtoken logo 一致
5. **降级方案**：默认态 `transform: translateX(70.7px)` 是画完的，动画关闭时仍能看到完整 logo

---

## 五、主题包文件结构与规模估算

### co1dsand-light/theme.css（约 450 行）

```
/* 第一部分：token 覆盖（约 120 行） */
html[data-theme="co1dsand-light"] {
  --bg: #ffffff;
  --text: #555555;
  /* ... 70+ 个 token ... */
}

/* 第二部分：链接样式（约 15 行） */
html[data-theme="co1dsand-light"] a:not(...) { ... }

/* 第三部分：logo 显隐与动画（约 50 行） */
html[data-theme="co1dsand-light"] .brand-mark svg:first-child { ... }
html[data-theme="co1dsand-light"] .co1dsand-logo-ink { ... }
@keyframes co1dsand-logo-draw { ... }
@media (prefers-reduced-motion) { ... }

/* 第四部分：细节覆盖（约 200-250 行，实现时补充） */
/* 例如：
   - ::selection 背景色
   - scrollbar 样式（如果需要）
   - 特定组件的微调（如果测试时发现对比度不足）
*/
```

### co1dsand-dark/theme.css（约 450 行）

结构同上，token 值不同。

### 总规模

- **两个主题包共约 900 行 CSS**
- **admin.html 新增 1 个 SVG（约 20 行）**
- **无 JS 改动**
- 与现有主题包规模对比：anthropic 23 KB / sakura-mist 21 KB / gojo 49 KB，co1dsand 预计 **25-30 KB × 2**

---

## 六、测试契约

参考现有主题包的测试（`tests/anthropic-theme.test.mjs` 等），新建：

### tests/co1dsand-light-theme.test.mjs

```javascript
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

describe('co1dsand-light theme', () => {
  const themeJson = JSON.parse(readFileSync('themes/co1dsand-light/theme.json', 'utf8'))
  const themeCss = readFileSync('themes/co1dsand-light/theme.css', 'utf8')

  it('theme.json 必须有 id/label/description/author/swatch', () => {
    assert.equal(themeJson.id, 'co1dsand-light')
    assert.equal(themeJson.label, '凉砂·日')
    assert.ok(themeJson.description)
    assert.ok(themeJson.author)
    assert.ok(Array.isArray(themeJson.swatch))
    assert.equal(themeJson.swatch.length, 2)
  })

  it('theme.css 必须声明 color-scheme', () => {
    assert.ok(/color-scheme:\s*light/.test(themeCss))
  })

  it('必须覆盖核心 token --bg/--text/--line', () => {
    assert.ok(/--bg:\s*#ffffff/.test(themeCss))
    assert.ok(/--text:\s*#555555/.test(themeCss))
    assert.ok(/--line:\s*rgba\(136,136,136,0\.27\)/.test(themeCss))
  })

  it('必须有 logo 显隐规则', () => {
    assert.ok(/\.brand-mark svg:first-child/.test(themeCss))
    assert.ok(/\.antfu-logo/.test(themeCss))
  })

  it('必须有 logo 动画', () => {
    assert.ok(/@keyframes co1dsand-logo-draw/.test(themeCss))
  })

  it('必须有链接底边框规则', () => {
    assert.ok(/border-bottom:\s*1px solid rgba\(125,125,125,0\.3\)/.test(themeCss))
  })
})
```

### tests/co1dsand-dark-theme.test.mjs

结构同上，检查 `--bg: #050505` / `--text: #bbbbbb` / `color-scheme: dark`。

### 运行

```bash
node --test "tests/co1dsand-*.test.mjs"
```

---

## 七、实现检查清单

实现时逐项验证：

- [ ] 创建 `themes/co1dsand-light/` 和 `themes/co1dsand-dark/` 目录
- [ ] 写 `theme.json`（两个）
- [ ] 写 `theme.css`（两个），覆盖 70+ token
- [ ] 写链接底边框规则，测试所有链接位置（导航/表格/设置页）
- [ ] 在 `admin.html:81-90` 加 `.antfu-logo` SVG
- [ ] 写 logo 显隐与动画 CSS
- [ ] 测试切换主题：logo 是否正确显示/隐藏，动画是否运行
- [ ] 测试 `prefers-reduced-motion: reduce`：动画是否停止
- [ ] 测试打印：动画是否停止
- [ ] 写契约测试（两个）
- [ ] 运行 `node --test "tests/*.test.mjs"`，确保全通过
- [ ] 检查对比度：用 Chrome DevTools 的 Accessibility 面板验证 `--text` / `--muted` 在 `--bg` 上的对比度 ≥ 4.5:1（WCAG AA）
- [ ] 在 6 个视图（dashboard/upstreams/logs/tokens/groups/settings）下切换主题，检查是否有遗漏的硬编码颜色
- [ ] 提交，commit message 参考现有主题包的提交风格

---

## 八、已知限制与未来改进

### 当前不做的内容

1. **不收 wildtoken core 层的硬编码**（`enhancements.css` 38 处 + `tables.css` 6 处等）—— 那是独立任务，与主题包解耦
2. **不做 slide-enter 动画**（antfu 的逐段落滑入）—— 控制台场景下会很吵
3. **不改 `--transition` 时长**（保持 wildtoken 的 180ms）—— 快节奏适合控制台
4. **不覆盖语义色**（`--ok/--danger/--warning`）—— antfu 几乎不用语义色，但 wildtoken 需要
5. **不做 View Transitions 圆形扩散**（antfu 的主题切换动画）—— 需要 JS，且 wildtoken 的主题切换在顶栏菜单，不是按钮点击，坐标来源不同

### 未来可以加的内容

1. **补一个"凉砂·雾"主题**（antfu-mist）：在 light/dark 之间的中间态，`--bg: #f5f5f5` / `--text: #333`，参考 sakura-mist 的策略
2. **做圆形扩散动画**：监听 `#theme-menu` 的点击事件，传递坐标到 `applyTheme`，用 View Transitions API
3. **补 slide-enter**：但只给顶层 `.view` 的直接子元素（`.panel` / `.wt-card`），且 `--enter-step: 30ms`（快 3 倍）
4. **补 antfu 的其他视觉元素**：比如 `ArtPlum.vue` 的分形枝条背景（但 wildtoken 已有 `.aurora`，可能不需要）

---

## 九、风险与缓解

| 风险 | 缓解策略 |
|---|---|
| 半透明灰边框 `#8884` 在某些背景上对比度不足 | 实现时用 Chrome DevTools Accessibility 面板逐视图检查，对比度 < 3:1 的位置改为 `--line-strong` |
| 链接底边框误伤按钮形态的链接 | 排除列表先写保守（多排除），测试时检查，有遗漏再补 `:not()` |
| 动态 logo 的 SVG path 太长，admin.html 膨胀 | 可接受（只增加 20 行，且只显示在 co1dsand 主题下） |
| 与现有主题包的 CSS 选择器冲突 | 所有规则前缀 `html[data-theme="co1dsand-light"]`，不会影响其他主题 |
| 用户切换主题时 logo 闪烁 | `display: none/block` 切换是同步的，不会闪烁；如果有问题改用 `opacity` + `position: absolute` 叠加 |

---

## 十、交付清单

实现完成后交付：

1. **两个主题包目录**：`themes/co1dsand-light/` 和 `themes/co1dsand-dark/`
2. **四个文件**：`theme.json` × 2 + `theme.css` × 2
3. **admin.html 改动**：`.brand-mark` 内新增 `.antfu-logo` SVG
4. **两个契约测试**：`tests/co1dsand-light-theme.test.mjs` 和 `tests/co1dsand-dark-theme.test.mjs`
5. **一次 git commit**：message 如 `feat(themes): 新增凉砂（co1dsand）主题包，移植 antfu.me 设计风格`
6. **README 更新**（如果 `themes/README.md` 有主题列表）：加两行说明

---

## 十一、参考资料

- **antfu.me 源码**：`F:\dev\antfu-co1dsand\`，特别是 `src/styles/main.css`、`src/styles/markdown.css`、`src/components/Logo.vue`
- **wildtoken 现有主题包**：`F:\dev\wildtoken-co1dsand\themes\anthropic\`、`themes\sakura-mist\`（纯 token 映射参考）、`themes\gojo\`（复杂覆盖参考）
- **wildtoken 主题契约**：`themes\README.md`
- **antfu.me 设计调研报告**：本项目的调研 agent 输出（已在设计过程中引用）

---

**设计完成。请审查此设计文档，批准后我将进入实现阶段。**
