import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("themes/anthropic-dark/theme.json"));
const css = read("themes/anthropic-dark/theme.css");
const events = read("static/js/events.js");
const adminHtml = read("static/admin.html");

test("Anthropic Dark manifest exposes the dark brand palette", () => {
  assert.deepEqual(manifest, {
    id: "anthropic-dark",
    label: "A/ dark",
    css: "theme.css",
    swatch: ["#141413", "#d97757"],
    version: "1.0.0",
    description: "Warm slate surfaces with ivory ink, a single clay accent, and serif display type.",
  });
});

test("Anthropic Dark defines scoped slate surfaces and a clay accent", () => {
  assert.match(css, /html\[data-theme="anthropic-dark"\]\s*\{/);
  for (const token of [
    "color-scheme: dark;",
    "--bg: #141413;",
    "--panel-solid: #1d1d1b;",
    "--text: #faf9f5;",
    "--muted: #b0aea5;",
    "--accent: #d97757;",
    "--accent-strong: #c6613f;",
    "--focus-ring: 0 0 0 3px rgb(217 119 87 / 30%);",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
  assert.match(css, /html\[data-theme="anthropic-dark"\] \.aurora\s*\{\s*display: none;/);
  assert.match(css, /font-family: "Lora", Georgia/);
});

test("Anthropic Dark loads its OFL fonts from the shared static font directory", () => {
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

test("Anthropic Dark is available before and after theme registry initialization", () => {
  const cssHref = "/theme-packs/anthropic-dark/theme.css";
  assert.match(
    events,
    /\{ id: "anthropic-dark", label: "A\/ dark", swatch: \["#141413", "#d97757"\], css: "\/theme-packs\/anthropic-dark\/theme\.css", description: ".*" \}/,
  );
  assert.ok(adminHtml.includes(`"anthropic-dark": "${cssHref}"`));
});
