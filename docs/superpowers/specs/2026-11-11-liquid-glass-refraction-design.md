# 液态玻璃主题：真实折射与连续曲率圆角 设计文档

## 概述

`6b8c7e2` 加入的冰晶（`liquid-glass-light`）与烟晶（`liquid-glass-dark`）是纯 CSS 的模糊玻璃，
明确不做光学折射。本设计在此基础上补上两件事：

1. **真实折射**：参照 [archisvaze/liquid-glass](https://github.com/archisvaze/liquid-glass)（MIT）
   的 SVG 版本，用 `feDisplacementMap` 挂在 `backdrop-filter` 上，让玻璃边缘把背后的内容弯折。
2. **连续曲率圆角**：玻璃与卡片表面改用 `corner-shape: squircle`。

### 设计目标

- 主题包仍然只有 `theme.css` 和 `theme.json`，不执行包内脚本。
- 折射是增强，不是依赖：任何一环不满足都退回现有的模糊玻璃，观感与现在一致。
- 其他主题零开销：引擎只在主题声明需要折射时才挂观察器。
- 正文可读性不降：玻璃中心保持现有的不透明度，只有边缘弯折带变清。

### 不做的内容

- WebGL 引擎。它需要把页面当纹理渲染，真实 DOM 做不到。
- 把 SVG 滤镜以 data URL 内嵌进 `theme.css`。贴图必须和元素尺寸一一对应，静态 CSS 给不出来。
- 侧栏与抽屉的折射。两者圆角为 0，没有弯折带可言，保持模糊玻璃。

## 一、已验证的前提

以下结论来自在 Chromium 150 里跑的两个探针页，不是推测。

| 问题 | 结论 |
| --- | --- |
| `backdrop-filter` 的裁剪区是否跟随 `corner-shape` | 跟随。`invert()` 与 `url(#…)` 两种写法都贴着超椭圆边缘，四角不溢出 |
| 外部样式表里的 `var(--x, blur(…))` 能否解析成文档内的 `url(#id)` | 能。片段引用按文档解析，与样式表所在目录无关 |
| 嵌套玻璃是否会继承父级滤镜 | 用 `CSS.registerProperty` 注册为 `inherits: false` 后不继承，子元素落回回退值 |
| 重复注册同名属性 | 抛 `InvalidModificationError`，需要捕获 |
| `getComputedStyle` 能否读到圆角形状 | 能。`corner-top-left-shape` 返回 `round`、`squircle` 或 `superellipse(k)` |
| CSP 是否拦 `data:` 贴图 | 不拦。策略只锁 `script-src`，图片与内联样式不受限 |

另外确认：两份 `theme.css` 除第一条变量规则外逐字相同（已有测试强制），所以结构性改动只写一遍。

## 二、架构

```text
themes/liquid-glass-*/theme.css          web/src/liquidGlass.ts
  声明：哪些表面要折射、参数是多少   ──▶   读取声明 → 量尺寸 → 算贴图 → 注入 <svg><filter>
  消费：var(--lg-refraction, 模糊)   ◀──   在元素上写 --lg-refraction: url(#…)
```

主题包与引擎之间只有 CSS 自定义属性这一条接口，互不知道对方的实现。

### 主题 → 引擎（声明在 `html[data-theme="…"]` 上）

| 变量 | 含义 |
| --- | --- |
| `--lg-refraction-surfaces` | 带引号的选择器列表；`none` 或缺省表示不要折射 |
| `--lg-refraction-tint` | 玻璃底色，取代被引擎清空的 `background-color` |
| `--lg-refraction-bezel` | 弯折带最大宽度（px），实际值不超过圆角 |
| `--lg-refraction-thickness` | 玻璃厚度（px），决定位移幅度 |
| `--lg-refraction-ior` | 折射率 |
| `--lg-refraction-blur` | 中央磨砂的模糊半径（px）；弯折带本身保持清晰 |
| `--lg-refraction-specular` | 边缘高光不透明度，0–1 |
| `--lg-refraction-frost-edge` | 最外沿底色不透明度占中心的比例，0–1 |

### 引擎 → 主题（写在每个受管元素的内联样式上）

| 变量 | 值 | 主题里的用法 |
| --- | --- | --- |
| `--lg-refraction` | `url(#lg-refraction-N)` | `backdrop-filter: var(--lg-refraction, blur(…) saturate(…))` |
| `--lg-refraction-fill` | `transparent` | `background-color: var(--lg-refraction-fill, var(--lg-material-bg))` |

两个变量都注册为不继承。引擎不写，就等于现在的模糊玻璃。

## 三、引擎 `web/src/liquidGlass.ts`

单文件，分纯函数与控制器两层。

### 纯函数（不碰 DOM，直接单测）

- `cornerExponent(value)`：`round` 或空串 → 2，`squircle` → 4，`superellipse(k)` → `2^k`（`k ≥ 1`）。
  其余形状（`bevel`、`scoop`、`notch`、`square`）返回 `null`，该元素不做折射。
- `refractionProfile({ thickness, bezel, ior, samples })`：沿弯折带由外到内采样，按凸超椭圆表面
  `y = (1 − (1 − x)^4)^(1/4)` 求法线，用斯涅尔定律算出每个采样点的横向位移（px）。
  移植自参考项目的 `calculateRefractionProfile`。
- `edgeField(x, y, width, height, radius, exponent)`：返回该像素到边缘的深度与外法线。
  角部按超椭圆 `(u/r)^n + (v/r)^n = 1` 处理：令 `F = ((u/r)^n + (v/r)^n)^(1/n)`，
  深度取一阶近似 `(1 − F) / |∇F|`，法线取 `∇F` 的方向。`n = 2` 时退化为精确的圆弧距离，
  直边上 `u = 0`，同一公式给出精确值，因此角与边的交界处连续。
- `buildMaps(options)`：生成两张 RGBA 贴图和滤镜的 `scale`。
  - 位移贴图：R、G 是 x、y 方向位移，128 为中性；**B 通道存磨砂量**（中心 255，向外沿按
    smoothstep 降到 `frostEdge × 255`，在弯折带 80% 处回满）。位移只用 R、G，B 通道本来闲置，
    省掉第三张图。内部整块是中性值，只计算四周一圈，大表面的开销随周长而不是面积增长。
  - 高光贴图：最外约 2px 的细边，强度取法线与光照方向（60°）夹角的余弦。

### 控制器 `createLiquidGlass(env)`

依赖全部注入，便于在 jsdom（没有布局、没有 canvas）里测试：

- `supported`：是否 Chromium。按 `navigator.userAgentData.brands` 判断，没有该接口时回退到 UA 里的
  `Chrome/`。`CSS.supports('backdrop-filter', 'url(#x)')` 在不渲染该滤镜的浏览器里也可能为真，
  不能用来判断。
- `measure(element)`：返回 `{ width, height, radius, cornerShape }`；四个角不一致、圆角是百分比
  或椭圆、尺寸为 0 时返回 `null`。
- `encode(rgba, width, height)`：用 canvas 转成 PNG data URL，失败返回 `null`。

`refresh()` 是唯一的工作入口，幂等：

1. 读根元素上的声明。没有表面列表或环境不支持 → 清掉所有内联变量与滤镜，断开观察器，结束。
2. `querySelectorAll` 取出表面。选择器非法时按"不要折射"处理。
3. 对每个元素量尺寸。圆角小于 6px、面积超过 150 万像素（约 1500×1000）或量不出来的跳过并清掉其内联变量。
4. 以"宽×高×圆角×指数×参数×底色"为键查缓存；没有就算贴图、建 `<filter>`。同尺寸的 KPI 卡片共用一个滤镜。
5. 在元素上写两个内联变量。
6. 回收不再被任何元素引用的滤镜。data URL 可能有几百 KB，不能只增不减。

触发 `refresh()` 的来源都经 `requestAnimationFrame` 合并成一帧一次：

- `console:appearance` 事件（主题或密度切换）。
- `#theme-pack-css` 的 `load`（换主题后新样式表是异步到的；`load` 不冒泡，在 `document` 上用捕获监听）。
- 窗口 `resize`（移动端断点会换表面列表）。
- `prefers-reduced-transparency` 变化。
- 激活期间：`MutationObserver`（`childList`、`subtree`，属性只看 `class`、`hidden`、`open`，
  不看 `style`，避免自己写内联变量触发自己）与 `ResizeObserver`。

### 滤镜结构

```text
SourceGraphic ─ 极轻模糊(0.4) ─┐
位移贴图 ──────────────────────┴ feDisplacementMap ─▶ bent（清晰的折射，垫底）
bent ─ 主题给的模糊 ─ 以"磨砂量"为蒙版 ─▶ 只罩住中央的雾
bent ─ 饱和度增强 ─ 以高光贴图为蒙版 ─▶ 边缘更艳的一圈
位移贴图 B 通道 ─▶ alpha ─ 蒙住 feFlood(底色) ─▶ 中央实、边缘清的底色层
feMerge：bent → 雾 → 艳边 → 底色层 → 高光
```

雾比底色晚起步：底色爬过 40% 之前完全不雾。实测如果两者同时起步，清晰的弯折带只剩一条细线。

节点用 `createElementNS` 与 `setAttribute` 构造，不拼 HTML 字符串。底色通过 `flood-color` 交给浏览器解析，
引擎不解析颜色，`color-mix()` 之类的写法也能用。`<filter>` 上设 `color-interpolation-filters="sRGB"`，
否则 128 在线性空间里不是中性值，整块玻璃会偏移。

### 接入

`web/src/main.tsx` 在 `initCustomSelect()` 之后调用 `initLiquidGlass()`。`theme.ts` 不改。

## 四、主题包改动

两份 `theme.css` 同步修改，结构部分保持逐字相同。

### 折射

- 第一条变量规则里加上第二节列出的声明。表面列表：
  `.kpi-card, .dashboard-kpi, .theme-menu, .col-menu, .upstream-action-menu, .select-panel, .command-palette-panel, .toast, dialog:not(.command-palette-dialog):not(.dialog--drawer)`。
- 玻璃材质规则的 `background-color` 改为 `var(--lg-refraction-fill, var(--lg-material-bg))`。
- `@supports (backdrop-filter…)` 里的模糊改为 `var(--lg-refraction, blur(…) saturate(…))`。
- 移动端块：表面列表收窄为 `.topbar-nav`，底栏按同样方式消费两个变量；弯折带收到 8px，
  因为底栏只有 54px 高，标签离下沿 9px，沿用桌面的 18px 会让文字落在透明玻璃上。
- `@supports not (backdrop-filter…)` 与 `prefers-reduced-transparency` 两个降级块里加
  `--lg-refraction-surfaces: none`。

### 连续曲率圆角

- 新变量 `--lg-radius: 20px`，用于菜单、下拉面板、命令面板、Toast、KPI 卡片和移动端底栏。
- `@supports (corner-shape: squircle)` 内：`--lg-radius` 提到 26px（同半径下超椭圆看起来更小），
  并给上述表面以及表格容器、看板卡片、设置卡片、渠道卡片加 `corner-shape: squircle`；
  卡片类同步把半径放大约 1.3 倍。
- 居中对话框只加 `corner-shape`，不改半径。抽屉在 `drawer.css` 里是 0 圆角，不受影响。
- 按钮、输入框、胶囊与圆点不动：8–10px 下看不出差别，全圆角套超椭圆会变形。

## 五、降级矩阵

| 条件 | 折射 | 圆角 | 玻璃 |
| --- | --- | --- | --- |
| Chromium 139+ | 有 | 连续曲率 | 折射 + 磨砂中心 |
| Chromium < 139 | 有（贴图按圆弧算） | 圆弧 | 折射 + 磨砂中心 |
| Firefox / Safari | 无 | 圆弧（Firefox 162+ 为连续曲率） | 现有模糊玻璃 |
| 不支持 `backdrop-filter` | 无 | 同上 | 实色 |
| 减少透明度 | 无 | 同上 | 实色 |
| 脚本未加载或 canvas 失败 | 无 | 同上 | 现有模糊玻璃 |

## 六、测试契约

### 新增 `tests/liquid-glass-engine.test.mjs`

纯函数：

- `cornerExponent` 对 `round`、`squircle`、`superellipse(1.5)` 与不支持的形状的返回值。
- 折射率为 1 时位移恒为 0；大于 1 时最外沿位移最大、内沿趋近 0。
- `edgeField`：直边与圆弧角给出精确深度和单位外法线；超椭圆曲线上的点深度约为 0；
  圆弧上的点在超椭圆内部（深度为正）；形状外返回 `null`。
- `buildMaps`：中心像素中性且磨砂通道为 255；左右边缘位移镜像；
  圆弧与超椭圆的贴图只在角部不同；高光只出现在边沿。

控制器（jsdom，注入 `measure` 与 `encode`）：

- 主题没有声明表面时不注入任何东西。
- 声明后，匹配的元素拿到两个内联变量，文档里出现对应的 `<filter>`。
- 同尺寸的两个元素共用一个滤镜；尺寸不同则各一个。
- 非 Chromium 环境什么都不做。
- 圆角太小或尺寸为 0 的元素被跳过。
- 声明撤掉或元素移除后，内联变量与滤镜都被清理。
- 连续调用 `refresh()` 不产生重复滤镜。

### 修改 `tests/liquid-glass-theme.test.mjs`

- 表面列表、消费方式、移动端收窄、两个降级块里的 `none`。
- `corner-shape` 只出现在 `@supports (corner-shape: squircle)` 内，且该块不改对话框的几何。
- 保留"`theme.css` 里不出现 `feDisplacementMap`"的断言：滤镜在引擎里，不在主题包里。

## 七、实现步骤

1. 写 `tests/liquid-glass-engine.test.mjs` 的纯函数部分，确认因模块不存在而失败。
2. 实现纯函数到测试通过。
3. 写控制器测试，确认失败；实现控制器到通过。
4. 在 `tests/liquid-glass-theme.test.mjs` 里加主题契约，确认失败；改两份 `theme.css` 到通过。
5. 接入 `main.tsx`，更新 `themes/README.md` 与两份 `theme.css` 的文件头注释。
6. `npm run typecheck`、`npm run build`、`node --test tests/*.test.mjs`、`node scripts/payload-contract.mjs`。
7. 起后端，在浏览器里按桌面与手机宽度实测两套主题，调参数；再验证降级路径。

## 八、已知限制

- 折射只在玻璃背后有内容时可见。菜单、下拉、Toast、居中对话框和移动端底栏明显；
  KPI 卡片背后只有底色渐变，能看到边缘高光，看不到弯折。
- 弯折带宽度受圆角限制，观感比参考项目 60px 圆角的演示细。
- 滤镜按整数像素尺寸生成。元素尺寸连续变化时（例如拖动窗口）每帧会重算，结束后回收。
- 超椭圆角部的深度是一阶近似，离边缘越远误差越大；弯折带不超过圆角，误差在可接受范围内。
- 弯折带内的底色是渐薄的。对比度测试覆盖的是中央的 `--glass-strong`；文字不落在弯折带上靠的是
  各表面的内边距（控件离边缘约 14px，底色在弯折带 80% 处已回满），不是测试。

## 九、实测记录

在 Chromium 150（PI-Desktop 内置浏览器）里对隔离的预览实例做了以下检查：

- 冰晶、烟晶两套：KPI 卡片、主题菜单、下拉面板、命令面板、居中对话框都拿到滤镜，边缘可见弯折与高光。
- 六张同尺寸 KPI 共用一个滤镜；贴图 6–9KB。表面关闭或移除后滤镜被回收。
- 运行时在冰晶、烟晶、内置深色、五条悟之间切换：非液态玻璃主题下没有滤镜、没有内联变量、没有 SVG 宿主。
- 手机宽度（改写媒体查询模拟）：只有底栏折射，KPI 回到实色。
- 减少透明度（改写媒体查询模拟）：折射撤掉、表面变实色；恢复后重新接管。

没有验证的：Firefox 与 Safari 的回退（只有单测覆盖 `supported: false` 的分支）、真机触屏设备、
Toast（看板上没有触发入口，它与菜单走同一条代码路径）。

## 十、致谢与许可

折射曲线与高光贴图的算法移植自 archisvaze/liquid-glass，MIT 许可，© 2026 Archis Vaze。
版权与许可声明保留在 `web/src/liquidGlass.ts` 的文件头。超椭圆角部几何与磨砂通道为本项目新增。
