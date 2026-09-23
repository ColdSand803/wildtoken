import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { h, loadTS, setupDOM, renderStatic } from "./react-harness.mjs";
const ui = setupDOM(); after(() => ui.close()); afterEach(() => ui.cleanup());
const { AnimatedNumber, formatChineseUnit } = loadTS("web/src/components/AnimatedNumber.tsx");
for (const [value, expected] of [[9999, ""], [10000, "1万"], [202200000, "2.02亿"], [1e12, "1万亿"], [NaN, ""]]) test(`Chinese token scale ${value}`, () => assert.equal(formatChineseUnit(value), expected));
test("numeric updates keep the final accessible value; reduced motion skips interpolation", () => { const view = ui.render(h(AnimatedNumber, { value: "100" })); view.rerender(h(AnimatedNumber, { value: "200" })); assert.equal(view.container.textContent, "200"); assert.equal(view.container.querySelector("[aria-label]").getAttribute("aria-label"), "200"); view.rerender(h(AnimatedNumber, { value: "—" })); assert.equal(view.container.textContent, "—"); });
test("KPI token values keep a Chinese magnitude hint and exact source in the tooltip", () => { const { Kpi } = loadTS("web/src/pages/DashboardPage.tsx", { expose: ["Kpi"] }); const html = renderStatic(h(Kpi, { label: "Tokens", value: "202.2M", rawValue: 202200000, hint: "202200000 tokens" })); assert.match(html, /2.02亿/); assert.match(html, /202200000 tokens/); });
