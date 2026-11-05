// 看板日历：53 周的格子怎么排、每天落哪一档、月份标签放哪。
import assert from "node:assert/strict";
import test from "node:test";

import { scaleDailyUsage } from "../web/src/dashboardScale.ts";
import { CALENDAR_WEEKS, buildCalendar } from "../web/src/usageCalendar.ts";

const usage = (day, requests, total_tokens = 0, errors = 0) => ({ day, requests, errors, total_tokens });

test("今天在最后一列，第一列从 52 周前的周一开始", () => {
  // 2026-11-04 是周三。
  const { cells } = buildCalendar("2026-11-04", [], "requests");
  assert.equal(cells.length, (CALENDAR_WEEKS - 1) * 7 + 3);
  assert.deepEqual(
    { day: cells[0].day, week: cells[0].week, weekday: cells[0].weekday },
    { day: "2025-11-03", week: 0, weekday: 0 },
  );
  const last = cells.at(-1);
  assert.deepEqual(
    { day: last.day, week: last.week, weekday: last.weekday },
    { day: "2026-11-04", week: CALENDAR_WEEKS - 1, weekday: 2 },
  );
});

test("按排名分档：最大值总在第 4 档，并列取最高排名", () => {
  const spread = buildCalendar(
    "2026-11-04",
    [usage("2026-11-01", 10), usage("2026-11-02", 20), usage("2026-11-03", 30), usage("2026-11-04", 40)],
    "requests",
  );
  assert.deepEqual(spread.cells.slice(-4).map((cell) => cell.level), [1, 2, 3, 4]);

  const ties = buildCalendar(
    "2026-11-04",
    [usage("2026-11-01", 1), usage("2026-11-02", 1), usage("2026-11-03", 1), usage("2026-11-04", 5)],
    "requests",
  );
  assert.deepEqual(ties.cells.slice(-4).map((cell) => cell.level), [3, 3, 3, 4]);
  assert.deepEqual(ties.levels, [null, null, null, { min: 1, max: 1 }, { min: 5, max: 5 }]);

  const single = buildCalendar("2026-11-04", [usage("2026-10-01", 7)], "requests");
  assert.equal(single.cells.find((cell) => cell.day === "2026-10-01").level, 4);
  assert.equal(single.cells.filter((cell) => cell.level === 0).length, single.cells.length - 1);
});

test("Tokens 视图按 Tokens 分档：有请求没 Tokens 的那天是空格", () => {
  const layout = buildCalendar(
    "2026-11-04",
    [usage("2026-11-03", 9, 0), usage("2026-11-04", 1, 500)],
    "tokens",
  );
  const [before, today] = layout.cells.slice(-2);
  assert.equal(before.level, 0);
  assert.equal(before.requests, 9);
  assert.equal(today.level, 4);
  assert.deepEqual(
    { total: layout.total, activeDays: layout.activeDays, peak: layout.peak.day },
    { total: 500, activeDays: 1, peak: "2026-11-04" },
  );
});

test("汇总只算日历里的日子，最多的一天并列时取较近的", () => {
  const layout = buildCalendar(
    "2026-11-04",
    [usage("2025-11-02", 999), usage("2026-01-05", 8), usage("2026-03-09", 8), usage("2026-11-04", 2)],
    "requests",
  );
  assert.equal(layout.total, 18);
  assert.equal(layout.activeDays, 3);
  assert.equal(layout.peak.day, "2026-03-09");
});

test("月份标签在 1 号那一列；第一列的残月离下一个标签够远才标", () => {
  // 第一列是 2025-11-03 那周，12-01 在第 4 列。
  const { months } = buildCalendar("2026-11-04", [], "requests");
  assert.deepEqual(months.slice(0, 3), [
    { week: 0, label: "11月" },
    { week: 4, label: "12月" },
    { week: 8, label: "1月" },
  ]);
  // 2026-11-01 是周日，落在倒数第二列。
  assert.deepEqual(months.at(-1), { week: CALENDAR_WEEKS - 2, label: "11月" });

  // 第一列从 2025-11-24 开始，下个月 1 号在第 1 列：残月不标。
  const crowded = buildCalendar("2026-11-25", [], "requests").months;
  assert.deepEqual(crowded[0], { week: 1, label: "12月" });
});

test("日历计数乘看板倍率取整，非法倍率原样返回", () => {
  const days = [usage("2026-11-04", 3, 7, 1)];
  assert.deepEqual(scaleDailyUsage(days, 1.5), [usage("2026-11-04", 5, 11, 2)]);
  assert.equal(scaleDailyUsage(days, 0), days);
  assert.equal(scaleDailyUsage(days, Number.NaN), days);
});
