import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("..", import.meta.url));

function walk(dir, match, found = []) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) walk(path, match, found);
    else if (match.test(entry)) found.push(path);
  }
  return found;
}

/** CSS 里定义过的类名。主题包也算——它们给的是同一套契约。 */
function definedClasses() {
  const files = [
    ...walk(join(root, "static/css"), /\.css$/),
    ...walk(join(root, "themes"), /\.css$/),
  ];
  const names = new Set();
  for (const file of files) {
    const css = readFileSync(file, "utf8");
    // 选择器里的 .foo；属性值和 URL 里的点号不会长成这样。
    for (const match of css.matchAll(/\.(-?[a-zA-Z_][a-zA-Z0-9_-]*)/g)) {
      names.add(match[1]);
    }
  }

  /* 旧 HTML 里出现过的类也算数。有些是纯结构类（archived-body 靠
     hidden 属性控显隐、col-priority 只用于列显隐脚本），CSS 里没有规则
     但它们是旧版真在用的名字，照抄不算错。 */
  const markup = readFileSync(join(root, "static/admin.html"), "utf8");
  for (const match of markup.matchAll(/class="([^"]*)"/g)) {
    for (const name of match[1].split(/\s+/)) if (name) names.add(name);
  }

  /* 旧 JS 动态拼出来的类。token-io-${tone} 这种 HTML 里根本不存在，
     但它确实是旧版在发的名字。把前缀展开成已知后缀，比“凡含插值就
     放行”精确得多。 */
  const legacyJs = walk(join(root, "static/js"), /\.js$/)
    .map((file) => readFileSync(file, "utf8"))
    .join("\n");
  /* 前缀后面紧跟插值的片段，例如 `token-io-line token-io-${tone}` 里的
     token-io-。不要求整串只有一个类——旧版多数是“固定类 + 动态类”混写。 */
  for (const match of legacyJs.matchAll(/([a-z][a-z0-9]*(?:-[a-z0-9]+)*-)\$\{/g)) {
    for (const suffix of ["in", "out", "on", "off", "ok", "warn", "danger", "neutral"]) {
      names.add(`${match[1]}${suffix}`);
    }
  }
  // 模板串里的普通类名片段，例如 `token-io-line token-io-${tone}`。
  for (const match of legacyJs.matchAll(/class: ["`]([^"`]*)["`]/g)) {
    for (const name of match[1].replace(/\S*\$\{[^}]*\}\S*/g, " ").split(/\s+/)) {
      if (name) names.add(name);
    }
  }

  return names;
}

/**
 * React 组件里写死的 class 名。
 *
 * 两种写法都要收：
 *   className="a b"          静态
 *   className={`a ${x}`}     模板串里的静态片段
 *
 * 模板串的 ${...} 部分跳过——那是运行时算出来的，静态查不了。
 */
function usedClasses() {
  const files = walk(join(root, "web/src"), /\.tsx$/);
  const used = new Map();

  const record = (name, file) => {
    if (!name) return;
    if (!used.has(name)) used.set(name, new Set());
    used.get(name).add(file.slice(root.length));
  };

  for (const file of files) {
    const source = readFileSync(file, "utf8");

    for (const match of source.matchAll(/className="([^"]*)"/g)) {
      for (const name of match[1].split(/\s+/)) record(name, file);
    }

    for (const match of source.matchAll(/className=\{`([^`]*)`\}/g)) {
      /* 插值会把一个类名切成两截：`status-${bucket}xx` 里的 status- 和 xx
         都不是真类名。把插值连同两侧的非空白字符一起丢掉，剩下的才是
         完整的静态类名。 */
      const staticParts = match[1].replace(/\S*\$\{[^}]*\}\S*/g, " ");
      for (const name of staticParts.split(/\s+/)) record(name, file);
    }
  }
  return used;
}

/* 新控制台不写自己的 CSS，完全复用 static/css 和主题包。这条约束让
   6215 行主题样式一行不用改，前提是组件发出去的 class 名和旧版一致。

   靠肉眼照抄已经漏过三次：.archived-toggle 写成了不可点的 div、
   菜单真名 .upstream-action-menu 被写成 .action-menu、菜单少了
   popover="manual"。前两类这条测试能挡住。 */
test("React 组件用的 class 名都在共享 CSS 里定义过", () => {
  const defined = definedClasses();
  const used = usedClasses();

  const unknown = [];
  for (const [name, files] of used) {
    if (!defined.has(name)) unknown.push(`${name}  ←  ${[...files].join(", ")}`);
  }

  assert.deepEqual(
    unknown,
    [],
    `这些 class 在 static/css 和 themes 里都找不到，多半是名字打错了：\n  ${unknown.join("\n  ")}`,
  );
});

/* 组件里出现的类名不该凭空发明。这条从另一个方向卡：数量突然暴涨
   说明有人开始自造样式，那会绕开主题体系。 */
test("没有自造的 class", () => {
  const used = usedClasses();
  assert.ok(used.size > 0, "应该能扫到 class 名");
  /* 只是一个宽松的上界，防止无意识膨胀，不是精确值。

     上面那条测试已经保证每一个名字都能在共享 CSS 里找到，所以这里只是个
     次要信号。从 400 抬到 450：日志行对齐旧版时补回了 channel-stack、
     model-route 一系、status-active 一系，都是旧版真实在用的类。 */
  assert.ok(used.size < 450, `用到的 class 涨到 ${used.size} 个，检查是否在自造样式`);
});
