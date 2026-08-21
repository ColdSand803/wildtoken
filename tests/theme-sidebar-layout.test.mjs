import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../", import.meta.url));
const read = (file) => readFileSync(path.join(repoRoot, file), "utf8");
const themeFiles = {
  anthropic: "themes/anthropic/theme.css",
  "anthropic-dark": "themes/anthropic-dark/theme.css",
  "sakura-mist": "themes/sakura-mist/theme.css",
};

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function blockEnd(source, openingBrace) {
  let depth = 0;
  for (let index = openingBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error("unterminated CSS block");
}

function loadCss(file, seen = new Set()) {
  const normalized = path.normalize(file);
  if (seen.has(normalized)) return "";
  seen.add(normalized);

  const css = read(normalized);
  const imports = [...css.matchAll(/@import\s+url\(["']([^"']+)["']\)\s*;/g)];
  const imported = imports
    .map(([, href]) => {
      if (/^(?:https?:)?\/\//.test(href)) return "";
      return loadCss(path.join(path.dirname(normalized), href), seen);
    })
    .join("\n");

  return `${imported}\n${css}`;
}

const staticCss = loadCss("static/styles.css");
const allCss = `${staticCss}\n${Object.values(themeFiles)
  .map(read)
  .join("\n")}`;

function themedRules(source, theme, target) {
  const condition = `\\[data-theme=["']${escapeRegExp(theme)}["']\\]`;
  const selector = escapeRegExp(target);
  const rule = new RegExp(`${condition}[^{}]*?${selector}\\s*\\{([^{}]*)\\}`, "gs");
  return [...source.matchAll(rule)].map(([, declarations]) => declarations);
}

function mobileCssBlocks(source) {
  const blocks = [];
  const media = /@media\s*([^{}]+)\{/g;
  for (const match of source.matchAll(media)) {
    if (!/max-width\s*:\s*760px/.test(match[1])) continue;
    const openingBrace = match.index + match[0].length - 1;
    blocks.push(source.slice(openingBrace + 1, blockEnd(source, openingBrace)));
  }
  return blocks;
}

function assertSomeRule(rules, pattern, message) {
  assert.ok(rules.some((rule) => pattern.test(rule)), message);
}

test("A/ and Sakura Mist use the desktop left navigation rail", () => {
  for (const theme of Object.keys(themeFiles)) {
    const shellRules = themedRules(allCss, theme, ".app-shell");
    assertSomeRule(shellRules, /display:\s*grid\s*;/, `${theme} shell must become a desktop grid`);
    assertSomeRule(
      shellRules,
      /grid-template-columns:\s*[^;]*minmax\(0,\s*1fr\)\s*;/,
      `${theme} shell must reserve a left rail beside the content stage`,
    );

    const topbarRules = themedRules(allCss, theme, ".topbar");
    assertSomeRule(topbarRules, /flex-direction:\s*column\s*;/, `${theme} topbar must run vertically`);
    assertSomeRule(topbarRules, /grid-column:\s*1\s*;/, `${theme} topbar must occupy the left grid column`);

    const navRules = themedRules(allCss, theme, ".topbar-nav");
    assertSomeRule(navRules, /flex-direction:\s*column\s*;/, `${theme} navigation must stack in the rail`);
    assertSomeRule(navRules, /width:\s*100%\s*;/, `${theme} navigation must fill the rail width`);

    const linkRules = themedRules(allCss, theme, ".nav-link");
    assertSomeRule(linkRules, /width:\s*100%\s*;/, `${theme} navigation links must fill the rail width`);
  }
});

test("A/ and Sakura Mist retain the mobile bottom navigation dock", () => {
  const blocks = mobileCssBlocks(allCss);
  assert.ok(blocks.length > 0, "the shared mobile breakpoint must remain available");

  for (const theme of Object.keys(themeFiles)) {
    const shellRules = blocks.flatMap((block) => themedRules(block, theme, ".app-shell"));
    assertSomeRule(shellRules, /display:\s*flex\s*;/, `${theme} mobile shell must leave the desktop grid`);

    const navRules = blocks.flatMap((block) => themedRules(block, theme, ".topbar-nav"));
    assertSomeRule(navRules, /display:\s*grid\s*;/, `${theme} mobile navigation must become a dock`);
    assertSomeRule(
      navRules,
      /grid-template-columns:\s*repeat\(6,\s*minmax\(0,\s*1fr\)\)\s*;/,
      `${theme} mobile dock must retain all six destinations`,
    );
    assertSomeRule(navRules, /position:\s*fixed\s*;/, `${theme} mobile dock must stay reachable while content scrolls`);
  }
});

