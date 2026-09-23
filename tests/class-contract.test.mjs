import { createRequire } from "node:module";
const ts = createRequire(new URL("../web/package.json", import.meta.url))("typescript");
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

  /* 结构类：只用于定位、列显隐或语义标记，CSS 里没有规则——旧控制台
     同样没有。显式列出而不是“凡找不到就放行”：再添一个得是有意识的动作，
     名字打错仍然会被拦下。 */
  for (const name of [
    // 列定位 / 列显隐
    "col-priority",
    "col-quota",
    "actions-col",
    "numeric",
    "token-cell",
    // 靠 hidden 属性控显隐
    "archived-body",
    // 测试与脚本的定位钩子
    "dialog-icon--close",
    "dialog-icon--refresh",
    "log-sensitive-eye",
    "kpi-number",
    "upstream-row-check",
    // 语义分组，样式在父容器上
    "model-single",
    "model-request",
    "model-route-target",
    "token-io-in",
    "token-io-out",
    "pager-size-label",
    "token-toolbar",
    "settings-view",
    "settings-server-form",
    "settings-security",
    "wt-page-head",
    "dashboard-custom-chip",
    // Literal values used by dashboard range state, not CSS class names.
    "custom",
  ]) {
    names.add(name);
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
    const source = ts.createSourceFile(file, readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
    const literal = (text) => { for (const name of text.split(/\s+/)) if (/^-?[A-Za-z_][\w-]*$/.test(name) && !name.endsWith("-")) record(name, file); };
    const collect = (node) => {
      if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) literal(node.text);
      else if (ts.isTemplateExpression(node)) {
        literal(node.head.text);
        for (const span of node.templateSpans) literal(span.literal.text);
      } else if (ts.isConditionalExpression(node)) {
        collect(node.whenTrue); collect(node.whenFalse);
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.BarBarToken) {
        collect(node.left); collect(node.right);
      } else if (ts.isParenthesizedExpression(node)) collect(node.expression);
    };
    const visit = (node) => {
      if (ts.isJsxAttribute(node) && node.name.text === "className" && node.initializer) collect(node.initializer);
      else ts.forEachChild(node, visit);
    };
    visit(source);
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
     次要信号。从 400 抬到 520：日志行对齐旧版时补回了 channel-stack、
     model-route 一系、status-active 一系，都是旧版真实在用的类。 */
  assert.ok(used.size < 520, `用到的 class 涨到 ${used.size} 个，检查是否在自造样式`);
});
