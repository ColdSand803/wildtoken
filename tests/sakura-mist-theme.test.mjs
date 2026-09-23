import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("themes/sakura-mist/theme.json"));
const css = read("themes/sakura-mist/theme.css");
const themeModule = read("web/src/theme.ts");
const consoleHtml = read("web/index.html");

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

/* Registered in two places: the pre-paint script in index.html, which runs
   before React so the first frame is not the default theme, and the runtime
   registry behind the theme menu. */
test("Sakura Mist is registered for both pre-paint and runtime selection", () => {
  const cssHref = "/theme-packs/sakura-mist/theme.css";
  assert.ok(
    themeModule.includes(`"sakura-mist": "${cssHref}"`),
    "missing runtime pack entry",
  );
  assert.ok(
    themeModule.includes('"sakura-mist": ["#ffe3ee", "#535369"]'),
    "missing swatch",
  );
  assert.ok(consoleHtml.includes(`"sakura-mist": "${cssHref}"`), "missing pre-paint entry");
});
