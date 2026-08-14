import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("themes/anthropic/theme.json"));
const css = read("themes/anthropic/theme.css");
const events = read("static/js/events.js");
const adminHtml = read("static/admin.html");

test("Anthropic manifest exposes the brand palette", () => {
  assert.deepEqual(manifest, {
    id: "anthropic",
    label: "Anthropic Light",
    css: "theme.css",
    swatch: ["#faf9f5", "#d97757"],
    version: "1.0.0",
    description: "Warm ivory paper surfaces with slate ink, a single clay accent, and serif display type.",
  });
});

test("Anthropic defines scoped ivory surfaces and a clay accent", () => {
  assert.match(css, /html\[data-theme="anthropic"\]\s*\{/);
  for (const token of [
    "--bg: #faf9f5;",
    "--panel-solid: #faf9f5;",
    "--text: #141413;",
    "--muted: #87867f;",
    "--accent: #d97757;",
    "--accent-strong: #c6613f;",
    "--focus-ring: 0 0 0 3px rgb(217 119 87 / 26%);",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
  assert.match(css, /html\[data-theme="anthropic"\] \.aurora\s*\{\s*display: none;/);
  assert.match(css, /font-family: "Lora", Georgia/);
});

test("Anthropic self-hosts its OFL fonts from the shared static font directory", () => {
  for (const face of [
    "/static/fonts/anthropic/lora-latin-400-normal.woff2",
    "/static/fonts/anthropic/lora-latin-600-normal.woff2",
    "/static/fonts/anthropic/poppins-latin-400-normal.woff2",
    "/static/fonts/anthropic/jetbrains-mono-latin-400-normal.woff2",
  ]) {
    assert.ok(css.includes(`url("${face}") format("woff2")`), `missing @font-face for ${face}`);
  }
  assert.match(css, /--font-sans: "Poppins",/);
  assert.match(css, /--font-mono: "JetBrains Mono",/);
});

test("Anthropic is available before and after theme registry initialization", () => {
  const cssHref = "/theme-packs/anthropic/theme.css";
  assert.match(
    events,
    /\{ id: "anthropic", label: "Anthropic Light", swatch: \["#faf9f5", "#d97757"\], css: "\/theme-packs\/anthropic\/theme\.css", description: ".*" \}/,
  );
  assert.ok(adminHtml.includes(`anthropic: "${cssHref}"`));
});
