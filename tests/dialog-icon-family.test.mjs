import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import test from "node:test";

const root = new URL("../", import.meta.url);

function stylesheets() {
  const files = readdirSync(new URL("static/css/", root))
    .filter((name) => name.endsWith(".css"))
    .map((name) => `static/css/${name}`);
  for (const pack of readdirSync(new URL("themes/", root), { withFileTypes: true })) {
    if (pack.isDirectory()) files.push(`themes/${pack.name}/theme.css`);
  }
  return files.sort();
}

/** Selector lists of every rule in a stylesheet, whitespace collapsed. */
function selectorLists(css) {
  const lists = [];
  for (const match of css.matchAll(/([^{}]+)\{/g)) {
    lists.push(match[1].replace(/\s+/g, " ").trim());
  }
  return lists;
}

// The dialog head icons are one family: refresh, maximize/restore, close. A
// theme that treats two of them as a set and misses the third leaves that
// button with whatever the pack does to a plain button, which in several packs
// is an opaque fill the icon then disappears into. This holds for `:not()`
// lists too — there the omission is worse, since being left out of the
// exclusion is what applies the primary-button chrome in the first place.
// Rules naming a single icon are the deliberate exceptions: close owns its
// danger hue, maximize owns its own fill and its restore-glyph swap.
test("every rule styling the whole dialog icon family covers refresh too", () => {
  const offenders = [];

  for (const file of stylesheets()) {
    const css = readFileSync(new URL(file, root), "utf8");
    for (const selector of selectorLists(css)) {
      if (!selector.includes(".icon-close") || !selector.includes(".icon-maximize")) continue;
      if (selector.includes(".icon-refresh")) continue;
      offenders.push(`${file}: ${selector.slice(0, 120)}`);
    }
  }

  assert.deepEqual(
    offenders,
    [],
    `these rules style close and maximize but not refresh:\n${offenders.join("\n")}`,
  );
});

test("the refresh button reuses the shared dialog icon chrome", () => {
  const css = readFileSync(new URL("static/css/forms-dialogs.css", root), "utf8");

  assert.match(css, /\.icon-refresh \.dialog-icon/);
  assert.match(css, /\.icon-refresh\.is-busy \.dialog-icon \{[^}]*animation:/);
  // The base rule marks disabled buttons not-allowed; busy is progress.
  assert.match(css, /\.icon-refresh:disabled \{[^}]*cursor: default/);
});

test("compact density leaves the dialog head icons at their square size", () => {
  const css = readFileSync(new URL("static/css/enhancements.css", root), "utf8");
  const compactRule = selectorLists(css).find(
    (selector) => selector.startsWith('html[data-density="compact"] button:not('),
  );

  assert.ok(compactRule, "the compact button rule must exist");
  for (const icon of [".icon-close", ".icon-maximize", ".icon-refresh"]) {
    assert.ok(compactRule.includes(`:not(${icon})`), `compact rule must exempt ${icon}`);
  }
});
