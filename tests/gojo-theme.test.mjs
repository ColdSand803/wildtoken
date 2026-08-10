import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("themes/gojo/theme.json"));
const css = read("themes/gojo/theme.css");
const events = read("static/js/events.js");
const adminHtml = read("static/admin.html");

test("Gojo manifest exposes the Limitless palette", () => {
  assert.deepEqual(manifest, {
    id: "gojo",
    label: "五条悟",
    css: "theme.css",
    swatch: ["#070910", "#63dcff"],
    version: "1.0.0",
    description: "Satoru Gojo character theme with a blindfold rail, Six Eyes focus states, and blue-red-violet Limitless fields.",
  });
});

test("Gojo defines a scoped Six Eyes theme without external assets", () => {
  assert.match(css, /html\[data-theme="gojo"\]\s*\{/);
  for (const token of [
    "--bg: #070910;",
    "--panel-solid: #0d101a;",
    "--text: #f7f9ff;",
    "--accent: #63dcff;",
    "--gojo-red: #ff6178;",
    "--gojo-purple: #a983ff;",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
  assert.match(css, /\.brand-mark::before[\s\S]*radial-gradient/);
  assert.match(css, /body::before[\s\S]*repeating-radial-gradient/);
  assert.doesNotMatch(css, /url\(["']?https?:/);
});

test("Gojo covers every console view with a distinct domain mark", () => {
  const views = ["dashboard", "upstreams", "logs", "tokens", "groups", "settings"];
  for (const view of views) {
    assert.match(css, new RegExp(`\\[data-view="${view}"\\]`), `missing ${view}`);
  }
  const marks = [...css.matchAll(/--gojo-view-mark:\s*"([^"]+)"/g)].map((match) => match[1]);
  assert.equal(marks.length, views.length);
  assert.equal(new Set(marks).size, views.length);
});

test("Gojo is available during boot and runtime theme initialization", () => {
  const cssHref = "/theme-packs/gojo/theme.css";
  assert.match(
    events,
    /\{ id: "gojo", label: "五条悟", swatch: \["#070910", "#63dcff"\], css: "\/theme-packs\/gojo\/theme\.css", description: ".*" \}/,
  );
  assert.ok(adminHtml.includes(`gojo: "${cssHref}"`));
});

test("Gojo keeps the mobile dock stable and honors reduced motion", () => {
  assert.match(css, /grid-template-columns:\s*repeat\(6, minmax\(0, 1fr\)\)/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)/);
  assert.match(css, /animation:\s*none !important/);
});

/* The neighbouring packs all set `outline: none` on .status-switch:focus-visible
   without putting anything back, which leaves the toggle invisible to a keyboard
   user. This pack moves the ring onto the track instead, and that is easy to
   undo by copying a block from another theme — so it is pinned here. */
test("Gojo gives the status switch a keyboard focus indicator", () => {
  const rule = css.match(
    /\.status-switch:focus-visible \.status-switch-track \{[^}]+\}/,
  );
  assert.ok(rule, "the switch track has no :focus-visible rule");
  assert.match(rule[0], /border-color: var\(--focus\)/);
  assert.match(rule[0], /box-shadow:/);

  // The switch itself may drop its outline only because the track carries it.
  const stripped = css.match(/\.status-switch:focus-visible \{[^}]+\}/);
  assert.ok(stripped, "expected an explicit :focus-visible rule on the switch");
});
