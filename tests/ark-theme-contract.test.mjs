import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function createThemeContext(storedTheme) {
  const attributes = new Map();
  const storedValues = new Map([["wildtoken_theme", storedTheme]]);
  const document = {
    documentElement: {
      getAttribute: (name) => attributes.get(name) ?? null,
      removeAttribute: (name) => attributes.delete(name),
      setAttribute: (name, value) => attributes.set(name, String(value)),
    },
    querySelector: () => null,
  };
  const localStorage = {
    getItem: (name) => storedValues.get(name) ?? null,
    setItem: (name, value) => storedValues.set(name, String(value)),
  };

  return {
    attributes,
    storedValues,
    context: vm.createContext({ document, localStorage }),
  };
}

test("pre-paint boot preserves a stored Ark selection", () => {
  const { attributes, context } = createThemeContext("ark");
  const html = read("static/admin.html");
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

  assert.ok(script, "admin.html must include its pre-paint theme script");
  vm.runInContext(script, context, { filename: "admin-prepaint.js" });

  assert.equal(attributes.get("data-theme"), "ark");
  assert.equal(attributes.get("data-ark-theme"), "ark");
  assert.equal(attributes.get("data-ark-depth"), "complex");
});

test("runtime selection persists Ark's complex root contract", () => {
  const { attributes, storedValues, context } = createThemeContext("dark");
  const source = read("static/js/events.js");
  const definitionsEnd = source.indexOf("renderThemeChoices();");

  assert.notEqual(definitionsEnd, -1, "events.js must retain its theme initialization marker");
  vm.runInContext(source.slice(0, definitionsEnd), context, { filename: "events-theme-definitions.js" });
  vm.runInContext('applyTheme("ark");', context, { filename: "events-theme-apply.js" });

  assert.equal(attributes.get("data-theme"), "ark");
  assert.equal(attributes.get("data-ark-theme"), "ark");
  assert.equal(attributes.get("data-ark-depth"), "complex");
  assert.equal(storedValues.get("wildtoken_theme"), "ark");
});

test("Endfield selection retains its existing complex family contract", () => {
  const { attributes, context } = createThemeContext("dark");
  const source = read("static/js/events.js");
  const definitionsEnd = source.indexOf("renderThemeChoices();");

  vm.runInContext(source.slice(0, definitionsEnd), context, { filename: "events-theme-definitions.js" });
  vm.runInContext('applyTheme("endfield");', context, { filename: "events-theme-endfield.js" });

  assert.equal(attributes.get("data-theme"), "endfield");
  assert.equal(attributes.get("data-ark-theme"), "endfield");
  assert.equal(attributes.get("data-ark-depth"), "complex");
});

test("selecting a non-Ark theme clears the Ark root contract", () => {
  const { attributes, context } = createThemeContext("dark");
  const source = read("static/js/events.js");
  const definitionsEnd = source.indexOf("renderThemeChoices();");

  vm.runInContext(source.slice(0, definitionsEnd), context, { filename: "events-theme-definitions.js" });
  vm.runInContext('applyTheme("ark"); applyTheme("light");', context, { filename: "events-theme-cleanup.js" });

  assert.equal(attributes.get("data-theme"), "light");
  assert.equal(attributes.get("data-ark-theme"), undefined);
  assert.equal(attributes.get("data-ark-depth"), undefined);
});

test("Ark primary action rules leave navigation and utility controls to their own states", () => {
  const css = read("static/css/ark.css");
  const selectors = [...css.matchAll(/(html\[data-theme="ark"\] button:not\(:where\([\s\S]*?\)\))(?::hover)?\s*\{/g)].map(
    ([, selector]) => selector,
  );
  const utilityControls = [
    ".table-sort-button",
    ".priority-value",
    ".token-preview-button",
    ".model-selection-remove",
    ".toast-close",
  ];

  assert.equal(selectors.length, 2, "Ark must keep paired default and hover primary-action selectors");
  for (const selector of selectors) {
    assert.match(selector, /\.nav-link/, "navigation buttons must not inherit primary-action styling");
    for (const utilityControl of utilityControls) {
      assert.ok(selector.includes(utilityControl), `${utilityControl} must retain its utility-control styling`);
    }
    assert.match(selector, /\.segmented-control\s*>\s*button/, "segmented choices must retain selected and unselected states");
  }
});

test("Ark's shared button geometry does not override inline utility-control sizing or type", () => {
  const css = read("static/css/ark.css");
  const sharedButtonRule = css.match(/html\[data-theme="ark"\] button\s*\{([\s\S]*?)\n\}/);

  assert.ok(sharedButtonRule, "Ark must define a shared button geometry rule");
  assert.doesNotMatch(sharedButtonRule[1], /(?:font-weight|letter-spacing|min-height)\s*:/, "inline controls retain their component-owned type and dimensions");
});

test("Ark keyboard focus remains visible when a control also owns an active-state shadow", () => {
  const css = read("static/css/ark.css");
  const focusRule = css.match(/html\[data-theme="ark"\] button:focus-visible,[\s\S]*?html\[data-theme="ark"\] summary:focus-visible\s*\{([\s\S]*?)\n\}/);

  assert.ok(focusRule, "Ark must define a shared keyboard-focus rule");
  assert.match(focusRule[1], /outline:\s*2px solid var\(--ark-signal\)/, "focus cannot rely only on a box shadow that selected controls replace");
  assert.match(focusRule[1], /outline-offset:\s*2px/, "the focus outline needs separation from the active-state edge");
});

test("Ark desktop theme menu opens into the visible content stage from the bottom rail", () => {
  const css = read("static/css/ark.css");
  const menuRule = css.match(/html\[data-theme="ark"\] \.theme-menu\s*\{([\s\S]*?)\n\}/);

  assert.ok(menuRule, "Ark must define the desktop theme-menu position");
  assert.match(menuRule[1], /left:\s*calc\(var\(--ark-rail-width\) \+ 12px\)/, "the menu should clear the navigation rail");
  assert.match(menuRule[1], /bottom:\s*0/, "the bottom-rail trigger must anchor the menu upward inside the clipped shell");
  assert.match(menuRule[1], /top:\s*auto/, "the base downward-opening position must be disabled");
});
