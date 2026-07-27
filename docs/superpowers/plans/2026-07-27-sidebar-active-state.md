# Sidebar Active-State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the active desktop left-navigation item visibly wider in the Ark and Endfield themes without changing shell layout or navigation behaviour.

**Architecture:** Each theme owns an active-tab overhang token. The desktop active rule uses it to extend only the selected surface into the work stage; the existing mobile rules reset that extension so the bottom navigation stays within its dock. A Node CSS contract test covers both themes.

**Tech Stack:** Static CSS and Node.js built-in test runner (`node:test`); no new dependencies.

## Global Constraints

- Preserve the existing `ark / complex` and `endfield / complex` root contracts.
- Preserve the current palette, signal edge, navigation behaviour, ARIA semantics, and focus handling.
- Use a 16px CSS custom-property overhang on desktop only; reset it at the existing narrow-screen breakpoint.
- Do not change rail width, content-grid columns, or mobile dock geometry.

---

### Task 1: Lock the active-tab responsive contract

**Files:**

- Create: `tests/sidebar-active-state.test.mjs`

**Interfaces:**

- Consumes: raw CSS loaded through the existing `read()` helper.
- Produces: a test requiring the desktop extension and mobile reset in both themes.

- [ ] **Step 1: Write the failing test**

Create `tests/sidebar-active-state.test.mjs` with this test:

```js
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

function activeRule(css, theme, startAt = 0) {
  const selector = `html[data-theme="${theme}"] .nav-link.active,`;
  const start = css.indexOf(selector, startAt);
  assert.notEqual(start, -1, `${theme} must define an active navigation rule`);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end + 2);
}

test("Ark and Endfield active desktop tabs extend but reset in the mobile dock", () => {
  for (const [theme, token] of [["ark", "--ark-nav-active-overhang"], ["endfield", "--ef-nav-active-overhang"]]) {
    const css = read(`static/css/${theme}.css`);
    const desktop = activeRule(css, theme);
    assert.match(css, new RegExp(`${token}:\\s*16px`));
    assert.match(desktop, new RegExp(`margin-inline-end:\\s*calc\\(var\\(${token}\\) \\* -1\\)`));
    assert.match(desktop, new RegExp(`width:\\s*calc\\(100% \\+ var\\(${token}\\)\\)`));

    const mobileStart = css.indexOf("@media (max-width: 760px)");
    assert.notEqual(mobileStart, -1, `${theme} must retain its mobile breakpoint`);
    const mobile = activeRule(css, theme, mobileStart);
    assert.match(mobile, /margin-inline-end:\s*0/);
    assert.match(mobile, /width:\s*100%/);
  }
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run `node --test tests/sidebar-active-state.test.mjs`.

Expected: the new active-tab contract fails because neither theme declares its 16px overhang token or active-rule width extension.

### Task 2: Implement the desktop tab extension and mobile reset

**Files:**

- Modify: `static/css/ark.css`
- Modify: `static/css/endfield.css`
- Test: `tests/sidebar-active-state.test.mjs`

**Interfaces:**

- Consumes: `--ark-nav-active-overhang` and `--ef-nav-active-overhang`.
- Produces: a selected navigation surface that extends 16px on desktop and stays flush within the mobile dock.

- [ ] **Step 1: Add each theme's token**

Add `--ark-nav-active-overhang: 16px;` to Ark's complex-theme variable block and `--ef-nav-active-overhang: 16px;` to Endfield's equivalent block.

- [ ] **Step 2: Extend the desktop active surface**

Add these declarations to each theme's existing desktop `.nav-link.active, .nav-link.active:hover` rule, replacing the token name per theme:

```css
margin-inline-end: calc(var(--theme-nav-active-overhang) * -1);
width: calc(100% + var(--theme-nav-active-overhang));
z-index: 1;
```

Keep every existing background, border, signal-edge `box-shadow`, and text-colour declaration intact.

- [ ] **Step 3: Reset it in the mobile active rules**

In each existing mobile active rule, add:

```css
margin-inline-end: 0;
width: 100%;
```

- [ ] **Step 4: Run the focused contract test**

Run `node --test tests/sidebar-active-state.test.mjs`.

Expected: all theme-contract tests pass.

### Task 3: Validate visual and accessibility safety

**Files:**

- Verify: `static/css/ark.css`
- Verify: `static/css/endfield.css`
- Verify: `tests/sidebar-active-state.test.mjs`

**Interfaces:**

- Consumes: the CSS contract test and rendered `/admin` page.
- Produces: evidence that the active tab is wider at desktop and contained at narrow widths.

- [ ] **Step 1: Run the Ark UI audit**

Run `node "C:/Users/HYMOD/.codex/skills/ark-ui/scripts/audit-ark-ui.mjs" static/admin.html`.

- [ ] **Step 2: Inspect desktop and narrow layouts**

At desktop width, verify the active tab in both themes extends 16px toward the work stage without moving content. At 760px or narrower, verify the active item remains within the five-column bottom dock and retains the bottom signal edge.

- [ ] **Step 3: Check keyboard focus**

Tab to an active navigation item in both themes. Confirm the existing visible focus outline is not hidden by the active-tab extension.

- [ ] **Step 4: Preserve the pre-existing dirty worktree**

Do not stage or commit any file: `static/css/ark.css` and the existing `tests/` directory were already untracked before this task. Review only the targeted before/after diff, and leave all changes available in the current worktree for the user.
