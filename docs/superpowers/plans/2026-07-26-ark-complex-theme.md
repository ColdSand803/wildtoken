# Ark Complex Theme Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an original, accessible Ark-family complex theme to the WildToken Admin static frontend.

**Architecture:** The existing root `data-theme` cascade remains the theme switch. A small Ark configuration map in `events.js` owns `data-ark-theme` and `data-ark-depth`; an inline equivalent prevents a flash of the wrong shell. A new final stylesheet supplies family tokens and depth-3 shell/component overrides without changing HTML semantics or backend behavior.

**Tech Stack:** Rust/Axum static file serving, HTML, CSS, browser JavaScript, Node built-in test runner.

## Global Constraints

- Family is exactly `ark`; depth is exactly `complex`.
- Use only original CSS/SVG geometry; add no game art, logos, protected fonts, copied screenshots, or fake telemetry.
- Keep the five existing views and all labels/actions semantically intact.
- Cyan is the sole dominant signal; danger, warning, and verified state remain semantic colors.
- Preserve keyboard focus, reduced-motion support, and portrait recomposition.

---

### Task 1: Add a failing runtime theme-contract test

**Files:**
- Create: `tests/ark-theme-contract.test.mjs`
- Modify: `.github/workflows/ci.yml`

**Interfaces:**
- Consumes: the existing pre-paint script and the real theme functions from `static/js/events.js`.
- Produces: a `node --test tests/ark-theme-contract.test.mjs` command that executes Ark selection behavior in a lightweight DOM fixture.

- [ ] **Step 1: Write the failing test**

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import vm from "node:vm";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function createThemeContext(storedTheme) {
  const attributes = new Map();
  const document = {
    documentElement: {
      getAttribute: (name) => attributes.get(name) ?? null,
      removeAttribute: (name) => attributes.delete(name),
      setAttribute: (name, value) => attributes.set(name, String(value)),
    },
    querySelector: () => null,
  };
  const localStorage = { getItem: () => storedTheme, setItem: () => {} };
  return { attributes, context: vm.createContext({ document, localStorage }) };
}

test("pre-paint boot preserves a stored Ark selection", () => {
  const { attributes, context } = createThemeContext("ark");
  const script = read("static/admin.html").match(/<script>([\s\S]*?)<\\/script>/)[1];
  vm.runInContext(script, context);
  assert.equal(attributes.get("data-theme"), "ark");
  assert.equal(attributes.get("data-ark-theme"), "ark");
  assert.equal(attributes.get("data-ark-depth"), "complex");
});

test("runtime theme selection persists Ark's complex root contract", () => {
  const { attributes, context } = createThemeContext("dark");
  const source = read("static/js/events.js");
  const definitions = source.slice(0, source.indexOf("renderThemeChoices();"));
  vm.runInContext(`${definitions}\nglobalThis.applyArkTheme = applyTheme;`, context);
  context.applyArkTheme("ark");
  assert.equal(attributes.get("data-theme"), "ark");
  assert.equal(attributes.get("data-ark-theme"), "ark");
  assert.equal(attributes.get("data-ark-depth"), "complex");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test tests/ark-theme-contract.test.mjs`

Expected: `ENOENT` for `static/css/ark.css` or an assertion failure because Ark is not registered.

- [ ] **Step 3: Add the CI command**

Add `node --test tests/ark-theme-contract.test.mjs` immediately after the existing `node --check static/js/*.js` CI command so the static contract runs on pull requests.

- [ ] **Step 4: Re-run the test after the implementation tasks**

Run: `node --test tests/ark-theme-contract.test.mjs`

Expected: one passing subtest.

### Task 2: Register Ark safely before paint and at runtime

**Files:**
- Modify: `static/admin.html:8-31`
- Modify: `static/js/events.js:1-84`
- Modify: `static/styles.css:1-16`

**Interfaces:**
- Consumes: the existing `THEMES` menu registry and `wildtoken_theme` local-storage key.
- Produces: the `ark` theme ID and `data-ark-theme="ark" data-ark-depth="complex"` root attributes.

- [ ] **Step 1: Extend the early boot map**

Use a local configuration object rather than a second ad-hoc `if` branch:

```js
var arkThemeDepths = { ark: "ark", endfield: "endfield" };
if (arkThemeDepths[t]) {
  document.documentElement.setAttribute("data-ark-theme", arkThemeDepths[t]);
  document.documentElement.setAttribute("data-ark-depth", "complex");
}
```

- [ ] **Step 2: Add Ark to the registry and runtime map**

Add the following registry entry ahead of Endfield:

```js
{ id: "ark", label: "Ark", swatch: ["#080a0b", "#18d1ff"] },
```

Use the same `ARK_THEME_CONFIG` mapping in `applyTheme()` so selecting either Ark-family theme writes both attributes; selecting another theme removes both.

- [ ] **Step 3: Import the stylesheet**

Append this after the existing Endfield import:

```css
@import url("./css/ark.css");
```

- [ ] **Step 4: Run JavaScript syntax checks**

Run: `node --check static/js/events.js`

Expected: exit code 0.

### Task 3: Implement the Ark depth-3 CSS system

**Files:**
- Create: `static/css/ark.css`

**Interfaces:**
- Consumes: existing semantic CSS variables and the stable HTML classes in `static/admin.html`.
- Produces: `html[data-theme="ark"]` root variables and family/depth-specific shell, component, responsive, and motion rules.

- [ ] **Step 1: Define Ark semantic tokens**

Set near-black ink, off-white paper, cyan signal, readable semantic state colors, square geometry, technical font stacks, and a cyan focus ring. Disable the default aurora when Ark is active.

- [ ] **Step 2: Build the desktop shell and meaningful stages**

Implement an 88px left rail, a wide scrolling content stage, sparse blueprint rules, a directional sector, large per-view indices, and page-specific existing-view labels. The panel header, nav selection, and primary actions use cyan only for real active/action state.

- [ ] **Step 3: Cover shared operational surfaces**

Style buttons, form fields, select panels, tables, status switches, chips, dialogs, code frames, and live state. Keep the existing values/actions and class names intact.

- [ ] **Step 4: Recompose portrait and reduced-motion states**

At `max-width: 760px`, replace the rail with a compact header and a five-item fixed bottom dock. Add a `prefers-reduced-motion` rule that removes stage animation and attention loops.

- [ ] **Step 5: Run the heuristic audit**

Run: `node "$CODEX_HOME/skills/ark-ui/scripts/audit-ark-ui.mjs" static/css/ark.css`

Expected: no high-severity Ark imitation or accessibility findings.

### Task 4: Verify the integrated theme

**Files:**
- Verify: `tests/ark-theme-contract.test.mjs`
- Verify: `static/admin.html`, `static/js/events.js`, `static/css/ark.css`

**Interfaces:**
- Consumes: completed static theme implementation.
- Produces: evidence that the theme loads, its contract is complete, and the repository remains healthy.

- [ ] **Step 1: Run frontend checks**

Run:

```bash
node --check static/js/*.js
node --test tests/ark-theme-contract.test.mjs
node "$CODEX_HOME/skills/ark-ui/scripts/audit-ark-ui.mjs" static/css/ark.css
```

Expected: all commands exit 0.

- [ ] **Step 2: Run Rust checks**

Run:

```bash
cargo fmt --all -- --check
cargo clippy --locked --all-targets -- -D warnings
cargo test --locked --all-targets
```

Expected: all commands exit 0.

- [ ] **Step 3: Manually inspect both layouts**

Serve the app locally, select Ark from the accessible menu, and inspect Dashboard, Channels, Logs, Tokens, Settings, one dialog, active nav, focus, and reduced-motion behavior at desktop and 390px portrait widths.

- [ ] **Step 4: Review changed files**

Run: `git diff --check && git diff -- static/admin.html static/js/events.js static/styles.css static/css/ark.css tests/ark-theme-contract.test.mjs .github/workflows/ci.yml`

Expected: no whitespace errors and only theme-contract changes.
