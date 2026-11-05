import type { DailyUsage } from "./types";

/** 日历的列数：53 周，今天落在最后一列。 */
export const CALENDAR_WEEKS = 53;

export type CalendarMetric = "requests" | "tokens";

/** 一格一天。week 是列（0 最早），weekday 是行（周一 0 … 周日 6）。 */
export interface CalendarCell {
  day: string;
  week: number;
  weekday: number;
  requests: number;
  errors: number;
  tokens: number;
  /** 0 是没有用量；1–4 由浅到深。 */
  level: number;
}

/** 一档颜色覆盖的取值范围；数据里没有落在这档的日子时为 null。 */
export interface LevelRange {
  min: number;
  max: number;
}

export interface CalendarLayout {
  cells: CalendarCell[];
  /** 月份标签放在该月 1 号所在的列。 */
  months: { week: number; label: string }[];
  /** 下标 1–4 对应四档颜色，下标 0 不用。 */
  levels: (LevelRange | null)[];
  total: number;
  activeDays: number;
  peak: CalendarCell | null;
}

const DAY_MS = 86_400_000;

/* 日期全按 UTC 零点算。用本地时区的话，夏令时那天只有 23 小时，
   逐天累加会错一天。 */
function parseDay(day: string): number {
  const [year, month, date] = day.split("-").map(Number);
  return Date.UTC(year, month - 1, date);
}

function formatDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function metricOf(cell: CalendarCell, metric: CalendarMetric): number {
  return metric === "requests" ? cell.requests : cell.tokens;
}

/** 有序数组里不大于 value 的个数。 */
function countAtMost(sorted: number[], value: number): number {
  let low = 0;
  let high = sorted.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (sorted[mid] <= value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * 排出 53 周的格子，并按分位数给每天定档。
 *
 * 分档按有用量那些天的排名，不按数值线性切：一天突发的量会把线性刻度
 * 撑开，其余日子全挤进最浅一档。档位是 ceil(4 × 排名占比)，并列取最高
 * 的排名，所以最大值总在第 4 档。例：[1, 1, 1, 5] → 1 是第 3 档，5 是第 4 档。
 */
export function buildCalendar(
  today: string,
  days: DailyUsage[],
  metric: CalendarMetric,
): CalendarLayout {
  const end = parseDay(today);
  const todayWeekday = (new Date(end).getUTCDay() + 6) % 7;
  const start = end - (todayWeekday + (CALENDAR_WEEKS - 1) * 7) * DAY_MS;
  const byDay = new Map(days.map((day) => [day.day, day]));

  const cells: CalendarCell[] = [];
  for (let at = start, index = 0; at <= end; at += DAY_MS, index += 1) {
    const day = formatDay(at);
    const usage = byDay.get(day);
    cells.push({
      day,
      week: Math.floor(index / 7),
      weekday: index % 7,
      requests: usage?.requests ?? 0,
      errors: usage?.errors ?? 0,
      tokens: usage?.total_tokens ?? 0,
      level: 0,
    });
  }

  const values = cells
    .map((cell) => metricOf(cell, metric))
    .filter((value) => value > 0)
    .sort((a, b) => a - b);
  const levels: (LevelRange | null)[] = [null, null, null, null, null];
  let total = 0;
  let peak: CalendarCell | null = null;
  for (const cell of cells) {
    const value = metricOf(cell, metric);
    if (value <= 0) continue;

    cell.level = Math.max(1, Math.ceil((4 * countAtMost(values, value)) / values.length));
    const range = levels[cell.level];
    levels[cell.level] = range
      ? { min: Math.min(range.min, value), max: Math.max(range.max, value) }
      : { min: value, max: value };

    total += value;
    // 并列取较近的一天。
    if (!peak || value >= metricOf(peak, metric)) peak = cell;
  }

  return { cells, months: monthLabels(cells), levels, total, activeDays: values.length, peak };
}

/* 每月 1 号所在的列放标签。第一列不含 1 号时，它属于一个不完整的月：
   离下一个标签不足 3 列就放不下字，不标。 */
function monthLabels(cells: CalendarCell[]): { week: number; label: string }[] {
  const label = (day: string) => `${Number(day.slice(5, 7))}月`;
  const marks = cells
    .filter((cell) => cell.day.endsWith("-01"))
    .map((cell) => ({ week: cell.week, label: label(cell.day) }));

  const first = cells[0];
  if (first && (marks.length === 0 || marks[0].week >= 3)) {
    marks.unshift({ week: 0, label: label(first.day) });
  }
  return marks;
}
