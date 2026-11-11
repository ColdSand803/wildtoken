import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { loadTS, setupDOM } from "./react-harness.mjs";

const requireWeb = createRequire(new URL("../web/package.json", import.meta.url));
// PostCSS already ships with Vite; no additional test or runtime dependency.
const { parse } = requireWeb("postcss");
const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8").replaceAll("\r\n", "\n");
const variants = [
  { id: "liquid-glass-light", label: "冰晶", mode: "light" },
  { id: "liquid-glass-dark", label: "烟晶", mode: "dark" },
].map((variant) => {
  const manifest = JSON.parse(read(`themes/${variant.id}/theme.json`));
  const css = read(`themes/${variant.id}/${manifest.css}`);
  const ast = parse(css);
  const scope = `html[data-theme="${variant.id}"]`;
  const tokens = Object.fromEntries(ast.nodes.filter((node) => node.type === "rule" && node.selector === scope)
    .flatMap((rule) => rule.nodes.filter((node) => node.type === "decl" && node.prop.startsWith("--")).map((node) => [node.prop, node.value])));
  return { ...variant, manifest, css, ast, scope, tokens };
});
const module = loadTS("web/src/theme.ts");
const startupScript = read("web/index.html").match(/<script>([\s\S]*?)<\/script>/)[1];
const hasDecl = (rule, prop, value) => rule.nodes.some((node) => node.type === "decl" && node.prop === prop && node.value === value);
const rules = (ast, predicate) => {
  const found = [];
  ast.walkRules((rule) => { if (predicate(rule)) found.push(rule); });
  return found;
};
const within = (node, name, pattern) => {
  for (let parent = node.parent; parent; parent = parent.parent) {
    if (parent.type === "atrule" && parent.name === name && pattern.test(parent.params)) return true;
  }
  return false;
};

function color(value) {
  if (value.startsWith("#")) {
    assert.match(value, /^#[0-9a-f]{6}$/i);
    return [1, 3, 5].map((offset) => Number.parseInt(value.slice(offset, offset + 2), 16)).concat(1);
  }
  assert.match(value, /^rgb\(/);
  const [channels, alpha] = value.slice(4, -1).split("/");
  return channels.trim().split(/\s+/).map(Number).concat(alpha ? Number.parseFloat(alpha) / 100 : 1);
}
function composite(foreground, background) {
  return foreground.slice(0, 3).map((value, index) => value * foreground[3] + background[index] * (1 - foreground[3])).concat(1);
}
function luminance(rgb) {
  return rgb.slice(0, 3).map((value) => value / 255)
    .map((value) => value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4)
    .reduce((sum, value, index) => sum + value * [0.2126, 0.7152, 0.0722][index], 0);
}
function contrast(foreground, background) {
  const [lighter, darker] = [luminance(foreground), luminance(background)].sort((a, b) => b - a);
  return (lighter + 0.05) / (darker + 0.05);
}
function expectContrast(theme, foreground, backgrounds, minimum = 4.5) {
  for (const [name, background] of backgrounds) {
    const ratio = contrast(color(theme.tokens[foreground]), background);
    assert.ok(ratio >= minimum, `${theme.id}: ${foreground} on ${name} is ${ratio.toFixed(2)}:1 (needs ${minimum}:1)`);
  }
}
function surfaces(theme) {
  const solid = ["--bg", "--bg-elevated", "--panel-solid", "--panel-subtle", "--panel-muted", "--panel-elevated"]
    .map((token) => [token, color(theme.tokens[token])]);
  // Floating glass may overlap dark code or light content. Test both extremes
  // and the two reflection endpoints, not just the nominal body background.
  const reflections = [...theme.tokens["--lg-sheet"].matchAll(/rgb\([^)]*\)/g)].map((match) => color(match[0]));
  const glass = [[0, 0, 0, 1], [255, 255, 255, 1]].flatMap((underlay, index) => {
    const base = composite(color(theme.tokens["--glass-strong"]), underlay);
    return [[`glass-${index}`, base], ...reflections.map((reflection, i) => [`glass-${index}/reflection-${i}`, composite(reflection, base)])];
  });
  return [...solid, ...glass];
}

for (const theme of variants) {
  test(`${theme.label}: valid standalone, CSS-only theme pack`, () => {
    const { manifest, tokens } = theme;
    assert.equal(manifest.id, theme.id);
    assert.match(manifest.id, /^[a-z][a-z0-9-]{0,47}$/);
    assert.equal(manifest.label, theme.label);
    assert.equal(manifest.css, "theme.css");
    assert.equal(manifest.version, "1.0.0");
    assert.deepEqual(manifest.swatch, [tokens["--bg"], tokens["--accent"]]);
    assert.ok(manifest.description.length <= 160);
    assert.deepEqual(readdirSync(new URL(`../themes/${theme.id}/`, import.meta.url)).sort(), ["theme.css", "theme.json"]);
    theme.ast.walkAtRules((rule) => assert.ok(["media", "supports"].includes(rule.name), `unexpected @${rule.name}`));
    assert.doesNotMatch(theme.css, /@import|@font-face|three\.js|WebGL|feDisplacementMap/i);
    const urls = [...theme.css.matchAll(/url\("([^"]+)"\)/g)].map((match) => match[1]);
    assert.equal(urls.length, 10);
    assert.ok(urls.every((url) => url.startsWith("data:image/svg+xml,")), "only the existing inline navigation masks are permitted");
  });

  test(`${theme.label}: all selectors are scoped and visual tokens are complete`, () => {
    theme.ast.walkRules((rule) => {
      assert.ok(rule.selectors.every((selector) => selector.startsWith(theme.scope)), `unscoped rule: ${rule.selector}`);
      assert.doesNotMatch(rule.selector, /:is\([^)]*::/, "pseudo-elements must not be arguments of :is()");
    });
    assert.ok(rules(theme.ast, (rule) => rule.selector === theme.scope && hasDecl(rule, "color-scheme", theme.mode)).length);
    for (const token of [
      "bg", "bg-elevated", "panel", "panel-solid", "panel-subtle", "panel-muted", "panel-elevated", "glass", "glass-strong",
      "text", "text-secondary", "muted", "muted-strong", "line", "line-strong", "line-soft",
      "accent", "accent-strong", "accent-soft", "accent-border", "accent-glow", "accent-on", "brand-ink",
      "danger", "danger-soft", "danger-border", "danger-strong", "ok", "ok-soft", "ok-border", "ok-strong",
      "warning", "warning-soft", "warning-border", "warning-strong", "warning-text",
      "focus", "focus-ring", "shadow-xs", "shadow-sm", "shadow-md", "shadow-lg", "shadow", "glow-accent",
      "code-frame-bg", "code-bg", "code-text", "code-muted", "code-border", "row-hover", "row-disabled", "topbar-bg",
      "backdrop", "neutral-chip", "toast-neutral", "aurora-a", "aurora-b", "aurora-c",
    ]) assert.ok(theme.tokens[`--${token}`], `missing --${token}`);
    for (const token of ["--font-sans", "--font-mono", "--font-secret", "--text-base", "--control-h", "--control-h-sm"])
      assert.equal(theme.tokens[token], undefined, `${token} must preserve existing typography/density`);
  });

  test(`${theme.label}: small text, semantic washes and code meet AA contrast`, () => {
    const backgrounds = surfaces(theme);
    for (const foreground of ["--text", "--text-secondary", "--muted", "--muted-strong", "--accent"])
      expectContrast(theme, foreground, backgrounds);
    for (const tone of ["accent", "danger", "ok", "warning"]) {
      const washes = backgrounds.map(([name, background]) => [`${tone}-wash/${name}`, composite(color(theme.tokens[`--${tone}-soft`]), background)]);
      expectContrast(theme, `--${tone}`, washes);
      expectContrast(theme, `--${tone}-strong`, washes);
    }
    // Error panels use a warning wash in the existing console.
    expectContrast(theme, "--danger", backgrounds.map(([name, background]) => [`warning-wash/${name}`, composite(color(theme.tokens["--warning-soft"]), background)]));
    for (const token of ["--accent", "--accent-strong"])
      expectContrast(theme, "--accent-on", [[token, color(theme.tokens[token])]]);
    for (const foreground of ["--code-text", "--code-muted"])
      expectContrast(theme, foreground, ["--code-bg", "--code-frame-bg"].map((token) => [token, color(theme.tokens[token])]));
    expectContrast(theme, "--lg-control-border", [["input", color(theme.tokens["--panel-solid"])]], 3);
    expectContrast(theme, "--focus", [["canvas", color(theme.tokens["--bg"])], ["input", color(theme.tokens["--panel-solid"])]], 3);
  });

  test(`${theme.label}: glass filters never capture the mobile dock or dense rows`, () => {
    const topbars = rules(theme.ast, (rule) => rule.selector === `${theme.scope} .topbar`);
    assert.ok(topbars.length >= 2);
    assert.ok(topbars.some((rule) => hasDecl(rule, "backdrop-filter", "none") && !within(rule, "media", /./)));
    assert.ok(topbars.some((rule) => hasDecl(rule, "backdrop-filter", "none") && within(rule, "media", /max-width: 760px/)));
    for (const rule of topbars) {
      for (const prop of ["backdrop-filter", "-webkit-backdrop-filter"])
        assert.ok(!rule.nodes.some((decl) => decl.prop === prop && decl.value !== "none"));
      assert.ok(!rule.nodes.some((decl) => ["transform", "filter", "contain"].includes(decl.prop)), "do not introduce another fixed containing block");
    }
    assert.ok(rules(theme.ast, (rule) => rule.selector.includes(`${theme.scope} .topbar::before`) &&
      rule.nodes.some((decl) => decl.prop === "backdrop-filter" && decl.value.includes("blur"))).length);
    theme.ast.walkDecls((decl) => {
      if (!["backdrop-filter", "-webkit-backdrop-filter"].includes(decl.prop) || decl.value === "none") return;
      assert.ok(within(decl, "supports", /^\(backdrop-filter/), "filters belong behind feature detection");
      assert.doesNotMatch(decl.parent.selector, /\.(?:app-shell|content|view|mc-row|ue-mapping-row|table-wrap)\b|\b(?:td|tr)\b/);
    });
    const dense = rules(theme.ast, (rule) => rule.selector.includes(".table-wrap") && hasDecl(rule, "background-color", "var(--panel-solid)"));
    assert.equal(dense.length, 1);
    for (const component of [".dashboard-card", ".settings-card", ".log-detail-tabpanel", ".ue-manual", ".ue-change-panel", ".mc-list", ".qi-source", ".qi-candidates"])
      assert.ok(dense[0].selector.includes(component), `shared ${component} must remain readable`);
    assert.ok(hasDecl(dense[0], "backdrop-filter", "none"));
  });

  test(`${theme.label}: desktop geometry and every mobile destination are retained`, () => {
    assert.equal(theme.tokens["--lg-rail-width"], "118px");
    assert.ok(rules(theme.ast, (rule) => rule.selector === `${theme.scope} .app-shell` && hasDecl(rule, "display", "grid") &&
      hasDecl(rule, "grid-template-columns", "var(--lg-rail-width) minmax(0, 1fr)")).length);
    const mobileDock = rules(theme.ast, (rule) => rule.selector === `${theme.scope} .topbar-nav` && within(rule, "media", /max-width: 760px/) &&
      hasDecl(rule, "position", "fixed") && hasDecl(rule, "grid-template-columns", "repeat(8, minmax(0, 1fr))"));
    assert.equal(mobileDock.length, 1);
    assert.ok(hasDecl(mobileDock[0], "bottom", "max(8px, env(safe-area-inset-bottom))"));
    assert.ok(rules(theme.ast, (rule) => rule.selector === `${theme.scope} .nav-link` && within(rule, "media", /max-width: 760px/) && hasDecl(rule, "min-height", "44px")).length);
    assert.ok(rules(theme.ast, (rule) => rule.selector.includes(`${theme.scope} body`) && within(rule, "media", /orientation: portrait/) && hasDecl(rule, "overflow", "visible")).length);
    const views = [...read("web/src/App.tsx").match(/const VIEWS: ViewId\[\] = \[([^\]]+)\]/)[1].matchAll(/"([a-z-]+)"/g)].map((match) => match[1]);
    for (const view of views) {
      assert.ok(theme.tokens[`--rail-icon-${view}`], `missing ${view} icon`);
      assert.ok(rules(theme.ast, (rule) => rule.selector === `${theme.scope} .nav-link[data-view="${view}"]::before` && hasDecl(rule, "mask-image", `var(--rail-icon-${view})`)).length);
    }
    // Theme rules must not undo drawer geometry maintained in drawer.css.
    assert.ok(!rules(theme.ast, (rule) => rule.selector.includes("dialog") && rule.nodes.some((decl) =>
      ["height", "width", "inset", "margin", "border-radius"].includes(decl.prop))).length);
  });

  test(`${theme.label}: unsupported filters, reduced transparency and motion have fallbacks`, () => {
    for (const [name, condition] of [["supports", /^not /], ["media", /prefers-reduced-transparency: reduce/]]) {
      const fallback = rules(theme.ast, (rule) => rule.selector === theme.scope && within(rule, name, condition));
      assert.equal(fallback.length, 1);
      for (const token of ["--panel", "--glass", "--glass-strong", "--topbar-bg"])
        assert.ok(hasDecl(fallback[0], token, "var(--panel-solid)"));
    }
    assert.ok(rules(theme.ast, (rule) => within(rule, "media", /prefers-reduced-transparency/) && hasDecl(rule, "backdrop-filter", "none")).length);
    assert.ok(rules(theme.ast, (rule) => within(rule, "media", /prefers-reduced-motion/) && hasDecl(rule, "animation-duration", "0.01ms") &&
      hasDecl(rule, "transition-duration", "0.01ms") && hasDecl(rule, "scroll-behavior", "auto")).length);
    const mobile = rules(theme.ast, (rule) => within(rule, "media", /max-width: 760px/) && rule.selector.includes(".kpi-card") && hasDecl(rule, "backdrop-filter", "none"));
    assert.equal(mobile.length, 1);
    assert.ok(rules(theme.ast, (rule) => rule.selector.includes(":focus-visible") && hasDecl(rule, "outline", "2px solid var(--focus)")).length);
    assert.ok(rules(theme.ast, (rule) => rule.selector === `${theme.scope} .aurora` && hasDecl(rule, "display", "none")).length);
  });

  test(`${theme.label}: runtime and first-paint selection use matching manifests`, () => {
    const href = `/theme-packs/${theme.id}/theme.css`;
    assert.equal(module.THEME_PACKS[theme.id], href);
    assert.equal(module.THEME_LABELS[theme.id], theme.label);
    assert.deepEqual(module.THEME_SWATCHES[theme.id], theme.manifest.swatch);
    assert.equal(module.resolveTheme(theme.id), theme.id);
    // Execute the actual startup script, including a stale persisted CSS URL.
    const attributes = new Map();
    const storage = new Map([[module.THEME_KEY, theme.id], [module.THEME_CSS_ID_KEY, "old-theme"], [module.THEME_CSS_KEY, "https://example.invalid/old.css"]]);
    runInNewContext(startupScript, {
      document: { documentElement: { setAttribute: (key, value) => attributes.set(key, value) } },
      localStorage: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) },
    });
    assert.equal(attributes.get("data-theme"), theme.id);
    assert.equal(attributes.get("data-theme-pack-css"), href);
    assert.equal(storage.get(module.THEME_CSS_KEY), href);
    const env = setupDOM();
    try {
      document.head.innerHTML = '<link rel="stylesheet" href="/static/styles.css">';
      module.applyTheme(theme.id);
      assert.equal(document.documentElement.dataset.theme, theme.id);
      assert.equal(document.querySelector("#theme-pack-css").getAttribute("href"), href);
      assert.equal(document.head.lastElementChild.id, "theme-pack-css");
      assert.equal(localStorage.getItem(module.THEME_KEY), theme.id);
      assert.equal(localStorage.getItem(module.THEME_CSS_ID_KEY), theme.id);
      module.applyDensity("compact");
      assert.equal(document.documentElement.dataset.theme, theme.id);
      module.applyTheme("dark");
      assert.equal(document.querySelector("#theme-pack-css"), null);
    } finally { env.close(); }
  });
}

test("glass materials preserve toast tones and selected/error control states", () => {
  for (const theme of variants) {
    for (const [tone, token] of [["ok", "--ok-border"], ["error", "--danger-border"]])
      assert.ok(rules(theme.ast, (rule) => rule.selector === theme.scope + ' .toast[data-tone="' + tone + '"]' && hasDecl(rule, "border-color", "var(" + token + ")")).length);
    const neutral = rules(theme.ast, (rule) => rule.selector.startsWith(theme.scope + " :where(") && rule.selector.includes("button.secondary"));
    assert.equal(neutral.length, 1);
    for (const state of [".danger", ":disabled", '[aria-pressed="true"]', '[aria-selected="true"]', ".is-active", ".is-selected"])
      assert.ok(neutral[0].selector.includes(":not(" + state + ")"), "neutral material must not erase " + state);
    const fields = rules(theme.ast, (rule) => rule.selector.startsWith(theme.scope + " :where(") && rule.selector.includes("input:not("));
    assert.equal(fields.length, 1);
    assert.ok(fields[0].selector.includes(':not([aria-invalid="true"])'));
  }
});

test("liquid-glass variants keep identical layout/material rules and existing icons", () => {
  const shared = variants.map((theme) => {
    const ast = theme.ast.clone();
    ast.nodes.find((node) => node.type === "rule" && node.selector === theme.scope).remove();
    ast.walkComments((comment) => comment.remove());
    return ast.toString().replaceAll(theme.id, "THEME").replace(/\s+/g, " ").trim();
  });
  assert.equal(shared[0], shared[1]);
  const rail = parse(read("static/css/console-rail.css"));
  const icons = new Map();
  rail.walkDecls((decl) => { if (decl.prop.startsWith("--rail-icon-") && decl.value.startsWith("url(")) icons.set(decl.prop, decl.value); });
  for (const theme of variants) for (const [token, value] of icons)
    assert.equal(theme.tokens[token] ?? rules(theme.ast, (rule) => hasDecl(rule, token, value))[0]?.nodes.find((decl) => decl.prop === token)?.value, value);
});
