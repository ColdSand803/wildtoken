import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8").replace(/\r\n/g, "\n");

/* 竖排轨道把状态行拉成整行，于是每套轨道主题都重写了 .live-indicator 的几何。
   shell.js:409 靠 hidden 属性收起这一行，而它的默认隐藏只有
   enhancements.css:77 的 `.live-indicator[hidden] { display: none }` —— 权重
   (0,2,0)。轨道那条选择器是 `html[data-theme=…] .topbar-actions .live-indicator`，
   权重 (0,3,1)，一旦它自己声明 display，[hidden] 就被压掉，自动刷新停下后
   「实时」那行不会消失。

   而这条 display 本来就是多余的：.live-indicator 是 .topbar-actions 的 flex
   子项，base 给的 inline-flex 会自动块化成 flex。删掉它，几何不变，[hidden]
   回来。这条测试扫全部轨道主题，防止照抄时又把它带回去。 */

/** 顶层（非媒体查询内）声明了 .topbar-actions .live-indicator 几何的文件。 */
function railFiles() {
  const files = ["static/css/console-rail.css"];
  const themesDir = path.join(root, "themes");
  for (const name of fs.readdirSync(themesDir)) {
    const relative = `themes/${name}/theme.css`;
    if (fs.existsSync(path.join(root, relative))) files.push(relative);
  }
  return files
    .map((file) => ({ file, css: read(file) }))
    .filter(({ css }) => /\n(?:html\[data-theme="[a-z0-9-]+"\] \.topbar-actions \.live-indicator,?\n)*html\[data-theme="[a-z0-9-]+"\] \.topbar-actions \.live-indicator \{/.test(css));
}

test("轨道主题的状态行不覆盖 [hidden] 的隐藏", () => {
  const files = railFiles();
  assert.notEqual(files.length, 0, "至少应有一个主题重写状态行的几何");

  for (const { file, css } of files) {
    const rule = /\n((?:html\[data-theme="[a-z0-9-]+"\] \.topbar-actions \.live-indicator,?\n)*html\[data-theme="[a-z0-9-]+"\] \.topbar-actions \.live-indicator \{)([^}]*)\}/.exec(css);
    assert.ok(rule, `${file} 的状态行规则解析失败`);
    assert.doesNotMatch(
      rule[2],
      /(?:^|[^-])display:/,
      `${file} 的状态行不应声明 display——它会压过 .live-indicator[hidden]，自动刷新停下后那行收不回去`,
    );
  }
});

/* 上面那条只有在默认隐藏确实是靠 [hidden] 时才成立。 */
test("状态行的默认隐藏仍由 [hidden] 承担", () => {
  assert.match(
    read("static/css/enhancements.css"),
    /\.live-indicator\[hidden\] \{\n\s*display: none;/,
    "enhancements.css 必须保留 .live-indicator[hidden] 的隐藏",
  );
  assert.match(
    read("static/js/shell.js"),
    /liveIndicator\.hidden = /,
    "shell.js 必须仍用 hidden 属性切换状态行",
  );
});
