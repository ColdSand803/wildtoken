# WildToken 主题包

管理界面的深色/浅色两套默认主题在 `static/css/` 里；其余主题都是这个目录下的
CSS-only 主题包。主题包随发布压缩包和 Docker 镜像一起分发，Docker Compose 会把
宿主机 `./themes` 只读挂载到 `/app/themes` 覆盖镜像内的同名目录。

主题目录可用 `APP__THEMES__DIR` 或 `WILDTOKEN_THEME_DIR` 改到别处。

## 目录结构

一个主题包是一个子目录，至少包含清单和样式表两个文件：

```text
themes/
  soul-society/
    theme.json
    theme.css
```

## theme.json

```json
{
  "id": "soul-society",
  "label": "尸魂界",
  "css": "theme.css",
  "swatch": ["#111827", "#f97316"],
  "version": "1.0.0",
  "description": "一句话说明，可省略"
}
```

| 字段 | 必填 | 说明 |
| --- | --- | --- |
| `id` | 是 | 必须和目录名完全一致；小写字母开头，只能含小写字母、数字和连字符，最长 48 字符 |
| `label` | 否 | 主题菜单里显示的名字，最长 64 字符；留空则回退到 `name` 字段，再空则用 `id` |
| `css` | 是 | 指向包内样式表的相对路径，必须以 `.css` 结尾，可以带子目录（如 `css/theme.css`），不能含 `..` 或绝对路径 |
| `swatch` | 否 | 菜单色块的 `[背景色, 强调色]`，接受 `#RGB`、`#RGBA`、`#RRGGBB`、`#RRGGBBAA`；缺失或非法时回退到 `#f8fafc` 和 `#f97316` |
| `version` | 否 | 自由文本，最长 32 字符 |
| `description` | 否 | 自由文本，最长 160 字符 |

清单不合法的主题包会被跳过，其他主题包不受影响；跳过原因会以 `warn` 级别写进服务日志。
最常见的原因是 `id` 和目录名不一致，或 `css` 指向的文件不存在。

## theme.css

规则统一写在 `html[data-theme="<id>"]` 作用域下 —— 切换主题时前端只会改
`<html>` 的 `data-theme` 属性，并把这个包的样式表插到 `/static/styles.css`
之后，所以覆盖基础样式不需要 `!important`。

主题包只能是 CSS：WildToken 只读取清单、并以同源静态文件的方式加载 `css` 指向的
样式表，不会执行包里的 JavaScript，清单里的其他字段也不会进入页面脚本。

主题的主体工作是重新定义 CSS 变量。完整清单见 `static/css/base.css` 的 `:root`
块，按用途分为这么几组：

- 表面：`--bg`、`--bg-elevated`、`--panel`、`--panel-solid`、`--panel-subtle`、`--panel-muted`、`--panel-elevated`、`--glass`、`--glass-strong`
- 文字：`--text`、`--text-secondary`、`--muted`、`--muted-strong`
- 描边：`--line`、`--line-strong`、`--line-soft`
- 强调色：`--accent`、`--accent-strong`、`--accent-soft`、`--accent-border`、`--accent-glow`、`--accent-on`、`--brand-ink`
- 语义色：`--danger*`、`--ok*`、`--warning*`
- 焦点与阴影：`--focus`、`--focus-ring`、`--shadow-xs|sm|md|lg`、`--glow-accent`
- 代码块：`--code-frame-bg`、`--code-bg`、`--code-text`、`--code-muted`、`--code-border`
- 交互面：`--row-hover`、`--row-disabled`、`--topbar-bg`、`--backdrop`、`--neutral-chip`、`--toast-neutral`
- 背景光晕：`--aurora-a`、`--aurora-b`、`--aurora-c`
- 排版与骨架：`--radius*`、`--space-*`、`--font-sans|mono`、`--text-xs…2xl`、`--topbar-height`、`--control-h`、`--transition`、`--blur`

只覆盖需要改的变量即可，其余会继承深色默认值。别忘了同时声明 `color-scheme`，
它决定滚动条和原生表单控件跟随明还是暗：

```css
/* themes/soul-society/theme.css */
html[data-theme="soul-society"] {
  color-scheme: dark;

  --bg: #0b0f19;
  --panel: rgb(17 24 39 / 88%);
  --panel-solid: #111827;
  --text: #f8fafc;
  --muted: #94a3b8;
  --line: rgb(148 163 184 / 28%);

  --accent: #f97316;
  --accent-strong: #ea580c;
  --accent-soft: rgb(249 115 22 / 14%);
  --accent-border: rgb(249 115 22 / 45%);
  --accent-on: #0b0f19;
}

/* 变量不够用时再写结构性规则，同样带上作用域前缀 */
html[data-theme="soul-society"] .topbar {
  border-bottom: 2px solid var(--accent);
}
```

想改得更彻底可以参考仓库里现成的包：`win95/` 是硬边框拟物，`bleach/` 是漫画分镜
质感，`demon-slayer/` 是纯 CSS 画的和风纹样（市松格纹、青海波、和纸颗粒），三者都
在变量之外写了大量结构规则。

## 调试

`/api/themes` 每次请求都会重新扫描主题目录，主题包的 CSS 也带了禁用缓存的响应头，
所以新增主题包或修改样式后刷新浏览器即可生效，不需要重启服务。

主题菜单里的顺序是：深色、浅色，然后是随仓库分发的自带包，最后是你新增的包。
如果新包的 `id` 和某个自带包重名，磁盘上的版本会顶掉自带的那个。
