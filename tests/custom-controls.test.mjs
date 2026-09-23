import assert from "node:assert/strict";
import test, { after, afterEach } from "node:test";
import { h, loadTS, read, setupDOM } from "./react-harness.mjs";

const ui = setupDOM();
after(() => ui.close());

test("custom select initializes and intercepts native select open and choice", () => {
  const { initCustomSelect, closeCustomSelect } = loadTS("web/src/customSelect.ts");
  const cleanup = initCustomSelect();

  const container = document.createElement("div");
  document.body.appendChild(container);

  const select = document.createElement("select");
  const optA = document.createElement("option");
  optA.value = "val-a";
  optA.textContent = "Label A";
  const optB = document.createElement("option");
  optB.value = "val-b";
  optB.textContent = "Label B";
  select.appendChild(optA);
  select.appendChild(optB);
  container.appendChild(select);

  let changedValue = "";
  select.addEventListener("change", (e) => {
    changedValue = e.target.value;
  });

  // Mousedown on native select should open custom select-panel
  const mousedownEvent = new MouseEvent("mousedown", { bubbles: true, cancelable: true });
  select.dispatchEvent(mousedownEvent);

  const panel = document.getElementById("select-panel");
  assert.ok(panel, "select-panel exists");
  assert.equal(panel.hidden, false, "select-panel is opened");

  const optionButtons = panel.querySelectorAll("button[role='option']");
  assert.equal(optionButtons.length, 2, "renders 2 option buttons");
  assert.equal(optionButtons[0].textContent, "Label A");
  assert.equal(optionButtons[1].textContent, "Label B");

  // Clicking second option chooses it and dispatches change
  optionButtons[1].dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
  assert.equal(select.value, "val-b", "select value updated to val-b");
  assert.equal(changedValue, "val-b", "change event fired with val-b");
  assert.equal(panel.hidden, true, "select-panel closed after choice");

  closeCustomSelect();
  cleanup();
  container.remove();
});

test("log-advanced-filters aligns buttons and inputs flush to bottom baseline", () => {
  const css = read("static/css/react-integration.css");
  assert.match(
    css,
    /\.log-advanced-filters\s*\{[^}]*align-items:\s*flex-end/,
    ".log-advanced-filters should align-items: flex-end to keep buttons flush with inputs",
  );
  assert.match(
    css,
    /\.log-advanced-filters\s+button\s*\{[^}]*height:\s*var\(--control-h\)/,
    ".log-advanced-filters buttons should match control height",
  );
});

test("unified custom checkbox styling is defined in base.css and excludes sr-only channel card checks", () => {
  const base = read("static/css/base.css");
  assert.match(
    base,
    /input\[type="checkbox"\]:not\(\.channel-card-check\)\s*\{[^}]*appearance:\s*none/,
    "custom checkbox uses appearance: none",
  );
  assert.match(
    base,
    /input\[type="checkbox"\]:not\(\.channel-card-check\):checked\s*\{[^}]*background-color:\s*var\(--accent\)/,
    "checked checkbox uses theme accent color",
  );
  assert.match(
    base,
    /input\[type="checkbox"\]:not\(\.channel-card-check\):checked::before/,
    "checked checkbox has custom checkmark pseudoelement",
  );
});
