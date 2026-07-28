import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const themeCssPath = {
  ark: "themes/ark/theme.css",
  endfield: "themes/endfield/theme.css",
};

function activeRule(css, theme, startAt = 0) {
  const selector = `html[data-theme="${theme}"] .nav-link.active,`;
  const start = css.indexOf(selector, startAt);
  assert.notEqual(start, -1, `${theme} must define an active navigation rule`);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end + 2);
}

function navRule(css, theme, selector, startAt = 0) {
  const start = css.indexOf(`html[data-theme="${theme}"] ${selector} {`, startAt);
  assert.notEqual(start, -1, `${theme} must define a ${selector} rule`);
  const end = css.indexOf("\n}", start);
  return css.slice(start, end + 2);
}

test("Ark hover targets fill the desktop rail without widening the mobile dock", () => {
  const css = read(themeCssPath.ark);
  const desktopNav = navRule(css, "ark", ".nav-link");
  const desktopHover = navRule(css, "ark", ".nav-link:hover");

  assert.match(desktopNav, /max-width:\s*none/);
  assert.match(desktopNav, /width:\s*100%/);
  assert.match(desktopHover, /margin-inline-end:\s*calc\(var\(--ark-nav-active-overhang\) \* -1\)/);
  assert.match(desktopHover, /width:\s*calc\(100% \+ var\(--ark-nav-active-overhang\)\)/);

  const mobileStart = css.indexOf("@media (max-width: 760px)");
  assert.notEqual(mobileStart, -1, "Ark must retain its mobile breakpoint");
  const mobileHover = navRule(css, "ark", ".nav-link:hover", mobileStart);
  assert.match(mobileHover, /margin-inline-end:\s*0/);
  assert.match(mobileHover, /width:\s*100%/);
});

test("Ark and Endfield active desktop tabs extend but reset in the mobile dock", () => {
  for (const [theme, token, overhang] of [
    ["ark", "--ark-nav-active-overhang", "4px"],
    ["endfield", "--ef-nav-active-overhang", "16px"],
  ]) {
    const css = read(themeCssPath[theme]);
    const desktop = activeRule(css, theme);
    assert.match(css, new RegExp(`${token}:\\s*${overhang}`));
    assert.match(desktop, new RegExp(`margin-inline-end:\\s*calc\\(var\\(${token}\\) \\* -1\\)`));
    assert.match(desktop, new RegExp(`width:\\s*calc\\(100% \\+ var\\(${token}\\)\\)`));

    const mobileStart = css.indexOf("@media (max-width: 760px)");
    assert.notEqual(mobileStart, -1, `${theme} must retain its mobile breakpoint`);
    const mobile = activeRule(css, theme, mobileStart);
    assert.match(mobile, /margin-inline-end:\s*0/);
    assert.match(mobile, /width:\s*100%/);
  }

  const ark = read(themeCssPath.ark);
  assert.match(
    ark,
    /html\[data-theme="ark"\] \.topbar-nav \{[^}]*overflow-x:\s*visible/s,
    "Ark navigation must keep the active item's right-side signal visible without scrolling",
  );
});
