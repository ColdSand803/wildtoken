import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("themes/sakura-mist/theme.json"));
const css = read("themes/sakura-mist/theme.css");
const events = read("static/js/events.js");
const adminHtml = read("static/admin.html");

test("Sakura Mist manifest exposes the reference palette", () => {
  assert.deepEqual(manifest, {
    id: "sakura-mist",
    label: "樱雾灰紫",
    css: "theme.css",
    swatch: ["#ffe3ee", "#535369"],
    version: "1.0.0",
    description: "Soft pink surfaces with restrained gray-violet accents.",
  });
});

test("Sakura Mist defines scoped, accessible gray-violet tokens", () => {
  assert.match(css, /html\[data-theme="sakura-mist"\]\s*\{/);
  for (const token of [
    "--bg: #ffe3ee;",
    "--panel-solid: #fffafd;",
    "--text: #272333;",
    "--muted: #6f6474;",
    "--accent: #535369;",
    "--accent-strong: #3d3d52;",
    "--focus-ring: 0 0 0 3px rgb(83 83 105 / 24%);",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
  assert.match(css, /html\[data-theme="sakura-mist"\] \.aurora\s*\{\s*display: none;/);
});

test("Sakura Mist is available before and after theme registry initialization", () => {
  const cssHref = "/theme-packs/sakura-mist/theme.css";
  assert.match(
    events,
    /\{ id: "sakura-mist", label: "樱雾灰紫", swatch: \["#ffe3ee", "#535369"\], css: "\/theme-packs\/sakura-mist\/theme\.css", description: "Soft pink surfaces with restrained gray-violet accents\." \}/,
  );
  assert.ok(adminHtml.includes(`"sakura-mist": "${cssHref}"`));
});
