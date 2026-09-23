import { useEffect, useState } from "react";

/** 和旧控制台一致：耗时要看得出在动，100ms 才够。 */
const TICK_MS = 100;

/**
 * 每 100ms 给一个时间戳，用于在途请求的耗时跳动。
 *
 * 没有在途请求时不装定时器——一个空列表还每秒醒 10 次没有意义，
 * 页面挂后台时尤其浪费。
 */
export function useTicker(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setNow(Date.now()), TICK_MS);
    return () => window.clearInterval(timer);
  }, [active]);

  return now;
}

/**
 * 在途请求已经跑了多久。
 *
 * elapsed_ms 是服务端发快照那一刻的值，之后要靠本地时钟往前推。
 * receivedAt 记下收快照的本地时刻，差值加上去就是当前耗时——直接拿
 * started_at 去减会把两端的时钟偏差算进来。
 */
export function elapsedMs(baseElapsedMs: number, receivedAt: number, now: number): number {
  return Math.max(0, baseElapsedMs + (now - receivedAt));
}

/**
 * 一开始就用秒，带一位小数让数字看得出在动。
 *
 * 不在一秒内显示毫秒：那样这一格会在 312ms 和 1.3s 之间突然换单位，数值
 * 跟着跳一个量级，逐秒刷新的计时器看上去像倒退了。
 */
export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, ms) / 1000;
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const minutes = Math.floor(seconds / 60);
  // 秒数补零：1m5s 比 1m50s 窄一位，不补的话整列每秒抽一下。
  return `${minutes}m${String(Math.floor(seconds % 60)).padStart(2, "0")}s`;
}
