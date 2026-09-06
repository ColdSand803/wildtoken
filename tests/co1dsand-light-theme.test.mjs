import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");
const manifest = JSON.parse(read("themes/co1dsand-light/theme.json"));
const css = read("themes/co1dsand-light/theme.css");
const events = read("static/js/events.js");
const adminHtml = read("static/admin.html");

test("素宣 的清单字段完整且与目录名一致", () => {
  assert.deepEqual(manifest, {
    id: "co1dsand-light",
    label: "素宣",
    css: "theme.css",
    swatch: ["#ffffff", "#111111"],
    version: "1.0.0",
    description: "纸面留白、灰阶墨梯与半透明分隔线，改编自 antfu.me。",
  });
});

test("素宣 铺开纸面底色与四级墨梯", () => {
  assert.match(css, /html\[data-theme="co1dsand-light"\]\s*\{/);
  for (const token of [
    "color-scheme: light;",
    "--bg: #ffffff;",
    "--bg-elevated: #fafafa;",
    "--text: #222222;",
    "--text-secondary: #555555;",
    "--muted-strong: #6b6b6b;",
    "--muted: #888888;",
    "--accent: #111111;",
    "--accent-strong: #000000;",
    "--accent-on: #ffffff;",
    "--brand-ink: #ffffff;",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
});

test("素宣 的分隔线是同值适配明暗的半透明灰", () => {
  for (const token of [
    "--line: rgb(136 136 136 / 27%);",
    "--line-strong: rgb(136 136 136 / 47%);",
    "--line-soft: rgb(136 136 136 / 15%);",
  ]) {
    assert.ok(css.includes(token), `missing ${token}`);
  }
});

test("素宣 收掉了渐变光晕：aurora 关闭、accent-glow 透明", () => {
  assert.ok(css.includes("--accent-glow: transparent;"));
  assert.ok(css.includes("--aurora-a: transparent;"));
  assert.match(css, /html\[data-theme="co1dsand-light"\] \.aurora\s*\{\s*display: none;/);
});

test("素宣 的圆角比默认更克制，字体栈补了中文", () => {
  assert.ok(css.includes("--radius-sm: 4px;"));
  assert.ok(css.includes("--radius: 6px;"));
  assert.ok(css.includes("--radius-md: 8px;"));
  assert.match(css, /--font-sans: "Inter", "PingFang SC", "Microsoft YaHei"/);
});

test("素宣 在主题注册表初始化前后都可选", () => {
  const cssHref = "/theme-packs/co1dsand-light/theme.css";
  assert.match(
    events,
    /\{ id: "co1dsand-light", label: "素宣", swatch: \["#ffffff", "#111111"\], css: "\/theme-packs\/co1dsand-light\/theme\.css", description: ".*" \}/,
  );
  assert.ok(adminHtml.includes(`"co1dsand-light": "${cssHref}"`));
});
