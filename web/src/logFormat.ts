/**
 * 日志列表各列的格式化规则。
 *
 * 抽成独立模块是为了能被直接测到——「0 和没有记录是两回事」这类规则靠源码
 * 字符串断言锁不住。
 */

/**
 * token 数缩写成 K/M/B/T，null 显示破折号。
 *
 * 0 和「没有记录」是两回事：一个失败的请求不该看起来像用了 0 个 token。
 */
export function formatCount(value: number | null): string {
  if (value === null || value === undefined) return "-";

  for (const [suffix, unit] of [
    ["T", 1e12],
    ["B", 1e9],
    ["M", 1e6],
    ["K", 1e3],
  ] as const) {
    if (value >= unit) {
      const scaled = value / unit;
      const text =
        scaled >= 100 || Number.isInteger(scaled) ? String(Math.round(scaled)) : scaled.toFixed(1);
      return `${text}${suffix}`;
    }
  }
  return String(value);
}

/**
 * 精确 token 数，给 title 和 aria-label 用。
 *
 * 列里显示的是缩写，缩写不能把数字弄丢——2.5M 可能是 245 万也可能是 254 万。
 */
export function exactTokens(name: string, value: number | null): string {
  const shown = value === null || value === undefined ? "-" : value.toLocaleString("zh-CN");
  return `${name} ${shown} tokens`;
}

/** 耗时一律用秒，保留一位小数。毫秒原值在这一列里位数不齐，扫不出快慢。 */
export function formatSeconds(ms: number | null): string {
  return ms === null || ms === undefined ? "-" : `${(ms / 1000).toFixed(1)}s`;
}

/** 首字只看绝对值：5 秒内好，10 秒以上差。 */
export function firstTokenTone(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms)) return "neutral";
  if (ms < 5000) return "ok";
  if (ms >= 10000) return "danger";
  return "warn";
}

/** 高于 good 算好，低于 fair 算差，中间是警。三处阈值不同但形状一样。 */
export function toneByThreshold(value: number, good: number, fair: number): string {
  if (value >= good) return "ok";
  if (value >= fair) return "warn";
  return "danger";
}
