/* 给 vm 沙箱用的最小 DOM。
 *
 * 控制台的渲染函数改成返回节点之后，测试要验证的仍是同一件事：结构、class、
 * 文本。这里只实现 el()/frag() 会碰到的那几个接口，并给节点一个 outerHTML，
 * 让断言可以继续按标记写，而不必逐层走 childNodes。
 *
 * 不是 jsdom 的替代品，只够跑纯构建、不碰布局和事件的函数。 */

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

const root = path.resolve(import.meta.dirname, "..");
const read = (relative) => fs.readFileSync(path.join(root, relative), "utf8");

/**
 * 读源文件并剥掉 import / export 语句，给 vm 的 script 模式用。
 *
 * 模块化之后源文件带了 import，vm.runInContext 按脚本解析会直接
 * SyntaxError。这里只是把模块语法拿掉；被剥掉的依赖由调用方在 context
 * 里直接注入，跟模块化之前的做法一致。
 */
export function readScript(relative) {
  return read(relative)
    .replace(/^import\s*\{[^}]*\}\s*from\s*"[^"]+";/gm, "")
    .replace(/^import\s+\w+\s+from\s*"[^"]+";/gm, "")
    .replace(/^import\s*"[^"]+";/gm, "")
    .replace(/\n*export\s*\{[^}]*\};\s*$/, "\n")
    .replace(/^export\s+(?=(?:async\s+)?function|class|const|let|var)/gm, "");
}

/** 取出单个顶层函数体，好在不加载整个模块的情况下单独跑它。 */
export function extractFunction(source, name) {
  const start = source.search(new RegExp(`(?:async\\s+)?function ${name}\\(`));
  assert.notEqual(start, -1, `${name} 不在源码里`);
  let depth = 0;
  for (let i = source.indexOf("{", start); i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name} 的函数体没有闭合`);
}

const kebab = (key) => key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
const escapeAttr = (value) => String(value).replace(/"/g, "&quot;");
const escapeText = (value) => String(value)
  .replace(/&/g, "&amp;")
  .replace(/</g, "&lt;")
  .replace(/>/g, "&gt;");

function domClasses() {
  class Node {}

  class TextNode extends Node {
    constructor(text) { super(); this.data = String(text); }
    get outerHTML() { return escapeText(this.data); }
    get textContent() { return this.data; }
  }

  class ParentNode extends Node {
    constructor() { super(); this.childNodes = []; }
    append(...kids) { this.childNodes.push(...kids); }
    replaceChildren(...kids) { this.childNodes = [...kids]; }
    get innerHTML() { return this.childNodes.map((child) => child.outerHTML).join(""); }
    get textContent() { return this.childNodes.map((child) => child.textContent).join(""); }
    /** 按标签名找后代，够断言用。 */
    querySelectorAll(tag) {
      const found = [];
      for (const child of this.childNodes) {
        if (child.tagName === tag) found.push(child);
        if (child.querySelectorAll) found.push(...child.querySelectorAll(tag));
      }
      return found;
    }
  }

  class Fragment extends ParentNode {
    get outerHTML() { return this.innerHTML; }
  }

  class Element extends ParentNode {
    constructor(tag) {
      super();
      this.tagName = tag;
      this.attributes = {};
      this.dataset = {};
      this.style = {};
    }
    // class 走 attributes，和 el() 一致：真实的 SVG 元素也只能这么设。
    setAttribute(key, value) { this.attributes[key] = String(value); }
    getAttribute(key) { return this.attributes[key] ?? null; }
    get className() { return this.attributes.class ?? ""; }
    addEventListener() { /* 构建期不触发，忽略 */ }
    get outerHTML() {
      const parts = [];
      for (const [key, value] of Object.entries(this.attributes)) {
        parts.push(`${key}="${escapeAttr(value)}"`);
      }
      for (const [key, value] of Object.entries(this.dataset)) {
        parts.push(`data-${kebab(key)}="${escapeAttr(value)}"`);
      }
      const open = `<${this.tagName}${parts.length ? ` ${parts.join(" ")}` : ""}>`;
      return `${open}${this.innerHTML}</${this.tagName}>`;
    }
  }

  return { Node, TextNode, Fragment, Element };
}

/**
 * 造一个带 DOM 和 el()/frag()/replaceChildren() 的沙箱。
 *
 * 那三个辅助直接从 bootstrap.js 取，所以测试跑的是真实现，不是副本。
 */
export function createDomContext(extra = {}) {
  const { Node, TextNode, Fragment, Element } = domClasses();
  const document = {
    createElement: (tag) => new Element(tag),
    // 命名空间在这里不影响序列化，只要 svg() 能跑通。
    createElementNS: (_ns, tag) => new Element(tag),
    createTextNode: (text) => new TextNode(text),
    createDocumentFragment: () => new Fragment(),
  };

  const context = vm.createContext({
    document, Node, Object, Number, Math, String, Array, Boolean, JSON, isNaN, Date,
    ...extra,
  });

  const bootstrap = read("static/js/bootstrap.js");
  for (const name of ["appendChildren", "applyProps", "el", "svg", "frag", "replaceChildren"]) {
    vm.runInContext(extractFunction(bootstrap, name), context);
  }
  // svg() 要用到的命名空间常量。
  vm.runInContext('const SVG_NS = "http://www.w3.org/2000/svg";', context);
  return context;
}

export { read, vm };
