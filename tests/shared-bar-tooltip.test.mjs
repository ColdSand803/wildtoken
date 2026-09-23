import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { h, loadTS, setupDOM, read } from "./react-harness.mjs";
const ui = setupDOM(); after(() => ui.close()); afterEach(() => ui.cleanup());
const { SegmentBar, hoverCardPosition } = loadTS("web/src/components/SegmentBar.tsx");
for (const [x, width, card, expected] of [[5, 300, 100, 17], [290, 300, 100, 178], [20, 80, 100, 0]]) test(`tooltip stays inside ${width}px host at ${x}px`, () => assert.equal(hoverCardPosition(x, width, card), expected));
test("shared segments expose keyboard activation and a single escaped tooltip", () => { let clicks = 0; const view = ui.render(h(SegmentBar, { label: "timing", segments: [{ label: "<unsafe>", width: 100, lines: ["detail"], onSelect() { clicks++; } }] })); const button = view.getByRole("button"); ui.fireEvent.focus(button); assert.equal(view.getByRole("tooltip").textContent, "<unsafe>detail"); assert.equal(button.hasAttribute("title"), false); assert.equal(view.container.querySelector("unsafe"), null); ui.fireEvent.keyDown(button, { key: "Enter" }); assert.equal(clicks, 1); ui.fireEvent.keyDown(button, { key: "Escape" }); assert.equal(view.queryByRole("tooltip"), null); });
test("dashboard and log timing use the same shared segment renderer", () => { assert.match(read("web/src/pages/DashboardPage.tsx"), /<SegmentBar/); assert.match(read("web/src/components/LogTiming.tsx"), /<SegmentBar/); });
