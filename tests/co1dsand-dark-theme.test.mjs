import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("themes/co1dsand-dark/theme.json"));
const css = read("themes/co1dsand-dark/theme.css");
const events = read("static/js/events.js");
const adminHtml = read("static/admin.html");
const lightCss = read("themes/co1dsand-light/theme.css");

test("凉砂·夜 的清单字段完整且与目录名一致", () => {
  assert.deepEqual(manifest, {
    id: "co1dsand-dark",
    label: "凉砂·夜",
    css: "theme.css",
    swatch: ["#050505", "#f0f0f0"],
    version: "1.0.0",
    description: "近黑纸面、灰阶墨梯与半透明分隔线，改编自 antfu.me。",
  });
});

test("凉砂·夜 铺开近黑底色与反向墨梯", () => {
  assert.match(css, /html\[data-theme="co1dsand-dark"\]\s*\{/);
  for (const token of [
    "color-scheme: dark;",
    "--bg: #050505;",
    "--bg-elevated: #0e0e0e;",
    "--text: #dddddd;",
    "--text-secondary: #bbbbbb;",
    "--muted-strong: #a0a0a0;",
    "--muted: #888888;",
    "--accent: #f0f0f0;",
    "--accent-strong: #ffffff;",
    "--accent-on: #050505;",
    "--brand-ink: #050505;",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
});

test("两套凉砂共用同一组半透明灰分隔线", () => {
  for (const token of [
    "--line: rgb(136 136 136 / 27%);",
    "--line-strong: rgb(136 136 136 / 47%);",
    "--line-soft: rgb(136 136 136 / 15%);",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
    assert.ok(lightCss.includes(token), `凉砂·日 也必须有 ${token}`);
  }
});

test("凉砂·夜 收掉了渐变光晕：aurora 关闭、accent-glow 透明", () => {
  assert.ok(css.includes("--accent-glow: transparent;"));
  assert.ok(css.includes("--aurora-a: transparent;"));
  assert.match(css, /html\[data-theme="co1dsand-dark"\] \.aurora\s*\{\s*display: none;/);
});

test("凉砂·夜 在主题注册表初始化前后都可选", () => {
  const cssHref = "/theme-packs/co1dsand-dark/theme.css";
  assert.match(
    events,
    /\{ id: "co1dsand-dark", label: "凉砂·夜", swatch: \["#050505", "#f0f0f0"\], css: "\/theme-packs\/co1dsand-dark\/theme\.css", description: ".*" \}/,
  );
  assert.ok(adminHtml.includes(`"co1dsand-dark": "${cssHref}"`));
});
