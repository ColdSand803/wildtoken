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
