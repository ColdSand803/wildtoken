import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";

import { createDomContext, read } from "./dom-stub.mjs";

/** 把 tokenPreviewCell 跑起来：真实的 el()/svg()，配最小 DOM。 */
function previewCell(token) {
  const source = read("static/js/tokens.js");
  // createDomContext 已带 el()/svg()/SVG_NS，不要灌整个 bootstrap——
  // 那会二次声明 SVG_NS 直接抛错。
  const context = createDomContext();
  // tokenPreviewCell 引用它判断是否高亮“已复制”，声明在切片之外，补上。
  vm.runInContext("let tokenCopyConfirmedId = null;", context);
  vm.runInContext("const token = " + JSON.stringify(token) + ";", context);
  vm.runInContext(
    source.slice(
      source.indexOf("const tokenCopyGlyph"),
      source.indexOf("function renderTokenRows"),
    ),
    context,
  );
  return vm.runInContext("tokenPreviewCell(token).outerHTML", context);
}

/* 图标曾经是 SVG 字符串。字符串子节点按 DOM 重构的安全设计降级成纯文本，
   结果页面上只剩一坨看不见的字。这条钉住：图标必须是真正的 <svg> 元素，
   里面是 rect 和 path——单文件里出现 "<svg" 字面量就是回退。 */
test("令牌预览图标是真 SVG 节点，不是字符串", () => {
  const source = read("static/js/tokens.js");
  assert.doesNotMatch(source, /`<svg/, "图标不许再写成 SVG 字符串");

  const copy = previewCell({ id: 1, name: "a", token_preview: "sk-1", token: "sk-1" });
  assert.match(copy, /<span class="token-preview-icon"[^>]*><svg /, "复制图标该是 svg 元素");
  assert.match(copy, /<rect /);
  assert.match(copy, /<path /);

  const sealed = previewCell({ id: 2, name: "b", token_preview: "sk-2", token: null });
  assert.match(sealed, /<svg /, "封存图标该是 svg 元素");
});

/* 每次调用必须产新节点。如果改回共享常量，第二行的图标会被第一行偷走。 */
test("两个令牌的图标是独立节点", () => {
  const first = previewCell({ id: 1, name: "a", token_preview: "sk-1", token: "sk-1" });
  const second = previewCell({ id: 2, name: "b", token_preview: "sk-2", token: "sk-2" });
  assert.notEqual(first, second, "两次渲染不该共享同一棵节点树");
  // 都各自带完整的图标结构。
  assert.match(first, /<svg /);
  assert.match(second, /<svg /);
});

/* 封存令牌（token 为空）和普通令牌显示不同图标，别弄混。 */
test("封存令牌用封存图标", () => {
  const source = read("static/js/tokens.js");
  // 封存的 path 画的是锁梁（M8 11V8a4 4 0 0 1 8 0v3），复制的是叠层。
  assert.match(source, /M8 11V8a4 4 0 0 1 8 0v3/);
  assert.match(source, /M5 15V7a2 2 0 0 1 2-2h8/);
});
