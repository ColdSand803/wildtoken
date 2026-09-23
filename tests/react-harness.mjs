import { readFileSync, existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = fileURLToPath(new URL("../", import.meta.url));
const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
export const React = requireWeb("react");
export const h = React.createElement;
export const read = (file) => readFileSync(path.join(root, file), "utf8");
export const renderStatic = (node) => requireWeb("react-dom/server").renderToStaticMarkup(node);
/** Compile the production TS/TSX (including its real relative imports), never a copied test implementation. */
export function loadTS(file, { overrides = {}, expose = [] } = {}) {
  const ts = requireWeb("typescript");
  const cache = new Map();
  function load(absolute, extra = []) {
    const relative = path.relative(root, absolute).replaceAll("\\", "/");
    if (Object.hasOwn(overrides, relative)) return overrides[relative];
    if (cache.has(absolute)) return cache.get(absolute).exports;
    const module = { exports: {} }; cache.set(absolute, module);
    const source = readFileSync(absolute, "utf8") + extra.map((name) => `\nexports.${name} = ${name};`).join("");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.ReactJSX, esModuleInterop: true } });
    const localRequire = (specifier) => {
      if (!specifier.startsWith(".")) return requireWeb(specifier);
      const base = path.resolve(path.dirname(absolute), specifier);
      const resolved = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, path.join(base, "index.ts")].find((candidate) => existsSync(candidate));
      if (!resolved) throw new Error(`Cannot resolve ${specifier} from ${relative}`);
      return load(resolved);
    };
    new Function("require", "module", "exports", `${outputText}\n//# sourceURL=${absolute.replaceAll("\\", "/")}`)(localRequire, module, module.exports);
    return module.exports;
  }
  return load(path.join(root, file), expose);
}
export const feedbackStub = { useConfirm: () => async () => true, useToast: () => () => {} };
export function setupDOM() {
  const { JSDOM } = requireWeb("jsdom");
  const dom = new JSDOM("<!doctype html><html><head></head><body></body></html>", { url: "http://localhost/console", pretendToBeVisual: true });
  for (const key of ["window", "document", "HTMLElement", "HTMLDialogElement", "HTMLInputElement", "Node", "Element", "Event", "CustomEvent", "MouseEvent", "MutationObserver", "localStorage", "sessionStorage", "getComputedStyle"]) Object.defineProperty(globalThis, key, { value: dom.window[key], writable: true, configurable: true });
  const media = () => ({ matches: true, addEventListener() {}, removeEventListener() {} });
  globalThis.matchMedia = dom.window.matchMedia = media;
  globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
  globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  dom.window.HTMLDialogElement.prototype.showModal = function () { this.setAttribute("open", ""); };
  dom.window.HTMLDialogElement.prototype.close = function () { this.removeAttribute("open"); };
  dom.window.HTMLElement.prototype.showPopover = function () { this.dataset.open = "true"; };
  dom.window.HTMLElement.prototype.hidePopover = function () { delete this.dataset.open; };
  dom.window.HTMLCanvasElement.prototype.getContext = () => null;
  const ui = requireWeb("@testing-library/react");
  return { ...ui, dom, close: () => { ui.cleanup(); dom.window.close(); } };
}
export const jsonResponse = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
