// 令牌有效期的解析与回填。直接 import 真实模块——测的就是控制台加载的那份。
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { expiryInputValue, parseExpiry, toUtcStamp } from "../web/src/expiry.ts";
import { EXPIRY_SOON_MS, expiryDistance, expiryTone } from "../web/src/tokenFormat.ts";

const read = (file) => readFileSync(new URL(`../${file}`, import.meta.url), "utf8");

/** 固定的参考时刻，免得断言依赖运行时的当下。 */
const NOW = Date.UTC(2026, 7, 8, 0, 0, 0);

test("a duration expression adds up its segments", () => {
  const hour = 3600 * 1000;

  for (const [input, expected] of [
    ["30s", 30 * 1000],
    ["90m", 90 * 60 * 1000],
    ["3h", 3 * hour],
    ["30d", 30 * 24 * hour],
    ["2w", 14 * 24 * hour],
    ["1d3h", 27 * hour],
    ["1d 3h 30m", 27 * hour + 30 * 60 * 1000],
    ["1D3H", 27 * hour],
  ]) {
    const parsed = parseExpiry(input, NOW);
    assert.equal(parsed.ok, true, `${input} must parse`);
    assert.equal(parsed.expiresAtMs - NOW, expected, `${input} must span ${expected}ms`);
  }
});

test("a blank expiry means never expires, not zero", () => {
  for (const input of ["", "   "]) {
    const parsed = parseExpiry(input, NOW);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.expiresAtMs, null);
  }
});

test("ambiguous or malformed durations are refused rather than guessed", () => {
  for (const input of [
    "30", // no unit — 30 days or 30 minutes has no unambiguous answer
    "1d2d", // the same unit twice
    "1d3x", // unknown unit
    "d3", // unit before its number
    "1d3h junk",
    "0d", // a zero-length validity is never what anyone means
    "tomorrow",
    "-1d",
  ]) {
    assert.equal(parseExpiry(input, NOW).ok, false, `${input} must be refused`);
  }
});

/* 绝对时刻按浏览器本地时区读，回填也按本地渲染，两者必须互为逆。这个往返
   就是全部契约——读进来和显示出去用了不同的时区，编辑一次就会把到期日挪走。 */
test("an absolute time round-trips through the input field unchanged", () => {
  for (const [input, expected] of [
    ["2026-09-01 12:00:00", "2026-09-01 12:00:00"],
    ["2026-09-01 12:00", "2026-09-01 12:00:00"],
    ["2026-09-01", "2026-09-01 00:00:00"],
  ]) {
    const parsed = parseExpiry(input, NOW);
    assert.equal(parsed.ok, true, `${input} must parse`);
    assert.equal(expiryInputValue(toUtcStamp(new Date(parsed.expiresAtMs))), expected);
  }
});

test("impossible calendar readings do not roll forward silently", () => {
  for (const input of ["2026-02-31", "2026-13-01", "2026-09-01 24:00", "2026-09-01 12:60"]) {
    assert.equal(parseExpiry(input, NOW).ok, false, `${input} must be refused`);
  }
});

test("what the server stores round-trips back to the same instant", () => {
  const parsed = parseExpiry("1d3h", NOW);
  const stored = toUtcStamp(new Date(parsed.expiresAtMs));

  assert.match(stored, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
  assert.equal(Date.parse(`${stored.replace(" ", "T")}Z`), parsed.expiresAtMs);
});

test("remaining time reads down to the unit that still matters", () => {
  const minute = 60 * 1000;

  for (const [deltaMs, expected] of [
    [-1, "已过期"],
    [0, "已过期"],
    [30 * 1000, "不到 1 分钟"],
    [5 * minute, "5 分钟后"],
    [90 * minute, "1 小时后"],
    [23 * 60 * minute, "23 小时后"],
    [3 * 24 * 60 * minute, "3 天后"],
  ]) {
    assert.equal(expiryDistance(deltaMs), expected);
  }
});

test("the expiry badge warns before the token lapses, not after", () => {
  const day = 24 * 60 * 60 * 1000;

  assert.equal(expiryTone(-day), "danger");
  assert.equal(expiryTone(0), "danger");
  // 阈值之内算「快到期」，之外才是正常。
  assert.equal(expiryTone(EXPIRY_SOON_MS - day), "neutral");
  assert.equal(expiryTone(EXPIRY_SOON_MS + day), "on");
});

/* `.field { display: grid }` 压过 UA 样式表的 [hidden] 规则，没有这条显式
   覆盖的话，脚本把字段设成 hidden 它照样留在屏上。 */
test("a form field toggled hidden from script actually disappears", () => {
  assert.match(read("static/css/forms-dialogs.css"), /\.field\[hidden\]\s*\{\s*display:\s*none;/);
});

test("the token table header and its body cells agree on the column count", () => {
  const source = read("web/src/pages/TokensPage.tsx");
  const header = source.slice(source.indexOf("<thead>"), source.indexOf("</thead>"));
  // 名称、描述、令牌预览、分组、限额、有效期、状态、操作
  assert.equal([...header.matchAll(/<th[\s>]/g)].length, 8);

  /* DescriptionCell 自己吐 <td>，所以行里只能数到 7 个字面量。数组件而不是
     数标签，否则少一格和组件化一格分不开。 */
  const row = source.slice(source.indexOf("function TokenRow"), source.indexOf("</tr>", source.indexOf("function TokenRow")));
  const cells =
    [...row.matchAll(/<td[\s>]/g)].length + [...row.matchAll(/<DescriptionCell[\s>]/g)].length;
  assert.equal(cells, 8, "表体格数要和表头列数一致");
});
