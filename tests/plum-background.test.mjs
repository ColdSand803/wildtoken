import assert from "node:assert/strict";
import test, { after } from "node:test";
import { loadTS, setupDOM, read } from "./react-harness.mjs";
const ui = setupDOM(); after(() => ui.close());
const { mountPlum } = loadTS("web/src/plum.ts");
test("plum keeps the original growth parameters and hard work bound", () => { const source = read("web/src/plum.ts"); for (const value of ["PLUM_MIN_BRANCH = 30", "PLUM_STEP_LEN = 6", "Math.PI / 12", "1000 / 40", "PLUM_MAX_SEGMENTS = 500000"]) assert.ok(source.includes(value)); });
test("mount grows only for the two co1dsand themes and cleanup removes its listeners", () => {
  const layer = document.createElement("div"), canvas = document.createElement("canvas"); layer.append(canvas); document.body.append(layer);
  let strokes = 0; canvas.getContext = () => ({ setTransform() {}, clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() { strokes++; } });
  const random = Math.random; Math.random = () => .9;
  try { document.documentElement.setAttribute("data-theme", "co1dsand-light"); const stop = mountPlum(canvas); assert.equal(layer.hidden, false); assert.ok(strokes > 0); document.documentElement.setAttribute("data-theme", "dark"); window.dispatchEvent(new CustomEvent("console:appearance")); assert.equal(layer.hidden, true); stop(); document.documentElement.setAttribute("data-theme", "co1dsand-dark"); window.dispatchEvent(new CustomEvent("console:appearance")); assert.equal(layer.hidden, true); } finally { Math.random = random; layer.remove(); }
});
test("background is decorative, and React owns its lifecycle", () => { const source = read("web/src/components/PlumBackground.tsx"); assert.match(source, /aria-hidden="true"/); assert.match(source, /useEffect/); assert.match(source, /mountPlum/); });
