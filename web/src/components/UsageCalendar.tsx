import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, FocusEvent, KeyboardEvent, PointerEvent } from "react";

import { UnauthorizedError, fetchDailyUsage } from "../api";
import { compactCount, scaleDailyUsage } from "../dashboardScale";
import type { DailyUsagePage } from "../types";
import { CALENDAR_WEEKS, buildCalendar, metricOf } from "../usageCalendar";
import type { CalendarCell, CalendarMetric, LevelRange } from "../usageCalendar";

const METRIC_KEY = "wildtoken_dashboard_calendar_metric";
const WEEKDAYS = ["一", "二", "三", "四", "五", "六", "日"];
const METRICS: { key: CalendarMetric; label: string; unit: string }[] = [
  { key: "requests", label: "请求", unit: "次请求" },
  { key: "tokens", label: "Tokens", unit: "Tokens" },
];

function readMetric(): CalendarMetric {
  try {
    return localStorage.getItem(METRIC_KEY) === "tokens" ? "tokens" : "requests";
  } catch {
    return "requests";
  }
}

function writeMetric(metric: CalendarMetric): void {
  try {
    localStorage.setItem(METRIC_KEY, metric);
  } catch {
    // 存不进去不影响当前页面。
  }
}

/* 数据到之前先按浏览器的今天排一张空日历，卡片高度不跳。 */
function localToday(): string {
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

const exact = (value: number) => value.toLocaleString("zh-CN");

/** 浮层和读屏共用的三行：数值、日期、另一项度量。 */
function describe(cell: CalendarCell, metric: CalendarMetric) {
  const date = `${cell.day} 周${WEEKDAYS[cell.weekday]}`;
  if (cell.requests === 0) return { value: "无请求", date, detail: "" };

  const value =
    metric === "requests" ? `${exact(cell.requests)} 次请求` : `${exact(cell.tokens)} Tokens`;
  const other =
    metric === "requests" ? `Tokens ${compactCount(cell.tokens)}` : `请求 ${exact(cell.requests)}`;
  return { value, date, detail: `${other} · 失败 ${exact(cell.errors)}` };
}

function rangeText(range: LevelRange | null): string {
  if (!range) return "这一档没有日子";
  return range.min === range.max
    ? compactCount(range.min)
    : `${compactCount(range.min)}–${compactCount(range.max)}`;
}

interface Tip {
  index: number;
  x: number;
  y: number;
}

/**
 * 近一年用量日历：一格一天，颜色深浅是当天的请求数或 Tokens。
 *
 * 不跟随看板的时间档：数据来自按小时累计的用量表，日志清理不影响它。
 * refreshKey 变了就重新取数，取数期间保留上一次的画面。
 */
export function UsageCalendar({
  refreshKey,
  onUnauthorized,
}: {
  refreshKey: number;
  onUnauthorized: (message: string) => void;
}) {
  const [page, setPage] = useState<DailyUsagePage | null>(null);
  const [error, setError] = useState("");
  const [metric, setMetric] = useState(readMetric);
  const [focusIndex, setFocusIndex] = useState<number | null>(null);
  const [tip, setTip] = useState<Tip | null>(null);

  const bodyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const loadRequest = useRef(0);

  const load = useCallback(async () => {
    const request = ++loadRequest.current;
    try {
      const { page: next, multiplier } = await fetchDailyUsage();
      if (request !== loadRequest.current) return;
      setPage({ ...next, days: scaleDailyUsage(next.days, multiplier) });
      setError("");
    } catch (err) {
      if (request !== loadRequest.current) return;
      if (err instanceof UnauthorizedError) onUnauthorized(err.message);
      else setError(err instanceof Error ? err.message : String(err));
    }
  }, [onUnauthorized]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  const today = page?.today ?? localToday();
  const layout = useMemo(
    () => buildCalendar(today, page?.days ?? [], metric),
    [today, page, metric],
  );
  const { cells } = layout;
  const lastIndex = cells.length - 1;
  // 没碰过时，Tab 进来落在今天。
  const active = focusIndex !== null && focusIndex <= lastIndex ? focusIndex : lastIndex;

  /* 窄屏只放得下最近几个月，滚到最右边先看到今天。 */
  useLayoutEffect(() => {
    const scroller = scrollRef.current;
    if (scroller) scroller.scrollLeft = scroller.scrollWidth;
  }, [today]);

  /* 浮层水平居中在格子上方，量出宽度后夹回卡片里，免得贴边的格子把它推出去。 */
  useLayoutEffect(() => {
    const body = bodyRef.current;
    const element = tipRef.current;
    if (!tip || !body || !element) return;
    const half = element.offsetWidth / 2;
    const x = Math.min(Math.max(tip.x, half), body.clientWidth - half);
    element.style.left = `${x}px`;
  }, [tip]);

  function showTip(target: HTMLElement) {
    const body = bodyRef.current;
    const index = Number(target.dataset.index);
    if (!body || !Number.isInteger(index)) return;
    const cell = target.getBoundingClientRect();
    const box = body.getBoundingClientRect();
    setTip({ index, x: cell.left - box.left + cell.width / 2, y: cell.top - box.top });
  }

  function cellOf(target: EventTarget | null): HTMLElement | null {
    return target instanceof HTMLElement ? target.closest<HTMLElement>("[data-index]") : null;
  }

  function onPointerOver(event: PointerEvent<HTMLDivElement>) {
    const target = cellOf(event.target);
    if (target) showTip(target);
  }

  function onFocus(event: FocusEvent<HTMLDivElement>) {
    const target = cellOf(event.target);
    if (!target) return;
    setFocusIndex(Number(target.dataset.index));
    showTip(target);
  }

  function onBlur(event: FocusEvent<HTMLDivElement>) {
    if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setTip(null);
  }

  /* 方向键在格子间走：左右跨周，上下跨天，Home/End 到这一行的两头。
     列里没有的日子（今天之后）走不过去。 */
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const weekday = active % 7;
    let next = active;
    switch (event.key) {
      case "ArrowLeft":
        next = active - 7;
        break;
      case "ArrowRight":
        next = active + 7;
        break;
      case "ArrowUp":
        next = weekday === 0 ? active : active - 1;
        break;
      case "ArrowDown":
        next = weekday === 6 ? active : active + 1;
        break;
      case "Home":
        next = weekday;
        break;
      case "End":
        next = weekday + 7 * Math.floor((lastIndex - weekday) / 7);
        if (next < 0) next = lastIndex;
        break;
      default:
        return;
    }
    event.preventDefault();
    if (next < 0 || next > lastIndex || next === active) return;
    setFocusIndex(next);
    scrollRef.current?.querySelector<HTMLElement>(`[data-index="${next}"]`)?.focus();
  }

  const unit = METRICS.find((item) => item.key === metric)?.unit ?? "";
  const tipCell = tip ? cells[tip.index] : undefined;
  const tipText = tipCell ? describe(tipCell, metric) : null;
  // 列数只在 usageCalendar.ts 里定一次，CSS 从这里拿。
  const rootStyle = { "--calendar-weeks": CALENDAR_WEEKS } as CSSProperties;

  return (
    <article className="dashboard-card dashboard-card-wide wt-card usage-calendar" style={rootStyle}>
      <div className="panel-head dashboard-card-head wt-card-head">
        <div>
          <h3>近一年用量</h3>
          <p className="dashboard-card-sub wt-sub">每格一天；不跟随上方时间范围，日志清理后仍保留</p>
        </div>
        <div className="segmented-control segmented-control-auto" role="group" aria-label="日历颜色按">
          {METRICS.map((item) => (
            <button
              key={item.key}
              type="button"
              className={metric === item.key ? "is-selected" : ""}
              aria-pressed={metric === item.key}
              onClick={() => {
                setMetric(item.key);
                writeMetric(item.key);
              }}
            >
              {item.label}
            </button>
          ))}
        </div>
      </div>

      {error ? (
        <p className="settings-inline-status" role="alert">
          {error}
        </p>
      ) : null}

      <div className="usage-calendar-body" ref={bodyRef}>
        <div className="usage-calendar-scroll" ref={scrollRef} onScroll={() => setTip(null)}>
          <div
            className="usage-calendar-grid"
            role="grid"
            aria-label={`近一年每天的${METRICS.find((item) => item.key === metric)?.label}`}
            aria-readonly="true"
            onPointerOver={onPointerOver}
            onPointerLeave={() => setTip(null)}
            onFocus={onFocus}
            onBlur={onBlur}
            onKeyDown={onKeyDown}
          >
            <div className="usage-calendar-months" aria-hidden="true">
              {layout.months.map((month) => (
                // 只占一列，字溢出到右边几列。跨列写到网格外会生出隐式列，和格子错位。
                <span key={month.week} style={{ gridColumn: month.week + 2 }}>
                  {month.label}
                </span>
              ))}
            </div>
            {WEEKDAYS.map((name, weekday) => (
              <div key={name} className="usage-calendar-row" role="row">
                <span className="usage-calendar-weekday" role="rowheader" aria-label={`周${name}`}>
                  {weekday % 2 === 0 ? name : ""}
                </span>
                {Array.from({ length: CALENDAR_WEEKS }, (_, week) => {
                  const index = week * 7 + weekday;
                  const cell = cells[index];
                  if (!cell) return <span key={week} className="usage-calendar-cell is-future" aria-hidden="true" />;
                  const text = describe(cell, metric);
                  return (
                    <span
                      key={week}
                      className="usage-calendar-cell"
                      role="gridcell"
                      tabIndex={index === active ? 0 : -1}
                      data-index={index}
                      data-level={cell.level}
                      aria-label={`${text.date}：${text.value}${text.detail ? `，${text.detail}` : ""}`}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        </div>

        {tip && tipText ? (
          <div
            className="usage-calendar-tip"
            ref={tipRef}
            aria-hidden="true"
            style={{ left: tip.x, top: tip.y }}
          >
            <strong>{tipText.value}</strong>
            <span>{tipText.date}</span>
            {tipText.detail ? <span>{tipText.detail}</span> : null}
          </div>
        ) : null}
      </div>

      <div className="usage-calendar-foot">
        <span className="usage-calendar-summary wt-meta">
          {page === null && !error
            ? "加载中…"
            : layout.peak
              ? `共 ${compactCount(layout.total)} ${unit} · ${layout.activeDays} 天有用量 · 最多 ${layout.peak.day.slice(5)}（${compactCount(metricOf(layout.peak, metric))}）`
              : "近一年没有用量"}
        </span>
        <span className="usage-calendar-legend" role="img" aria-label="颜色越深，用量越多">
          <span className="wt-meta">少</span>
          {[0, 1, 2, 3, 4].map((level) => (
            <span
              key={level}
              className="usage-calendar-swatch"
              data-level={level}
              title={level === 0 ? "没有用量" : rangeText(layout.levels[level])}
            />
          ))}
          <span className="wt-meta">多</span>
        </span>
      </div>
    </article>
  );
}
