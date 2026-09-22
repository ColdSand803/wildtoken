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

/**
 * 解析后端时间戳。
 *
 * 后端给的是 UTC 且不带时区标记，补上 Z 才不会被当成本地时间。
 */
export function parseLogTime(raw: string): Date | null {
  const normalized = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withZone = /[Z+]|-\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`;
  const date = new Date(withZone);
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * 日志时间：年月日时分秒，浏览器本地时区。
 *
 * 只给时分秒的话，跨天的两条日志看上去一样；翻历史日志时根本不知道是哪天。
 * 补位才能对齐成列，toLocaleString 的 zh-CN 不补月份和日的十位。
 */
export function formatTimestamp(raw: string): string {
  const date = parseLogTime(raw);
  if (!date) return raw;

  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ` +
    `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 「3 分钟前」。绝对时间答不了「这是刚才那条吗」，相对时间答不了「哪天」，两个都要。 */
export function formatRelativeTime(raw: string, now: number = Date.now()): string {
  const date = parseLogTime(raw);
  if (!date) return "";

  const deltaMs = now - date.getTime();
  if (deltaMs < 0) return "刚刚";

  const seconds = Math.floor(deltaMs / 1000);
  if (seconds < 60) return `${seconds} 秒前`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;

  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

/**
 * 人话时长。
 *
 * 列表里统一用秒是为了对齐扫读，详情窗不需要对齐，反而要一眼看懂量级：
 * 亚秒级给毫秒原值，分钟级拆成分和秒，别让人去数 0。
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return `${Math.round(ms)} 毫秒`;

  const totalSeconds = ms / 1000;
  if (totalSeconds < 60) return `${totalSeconds.toFixed(1)} 秒`;

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = Math.round(totalSeconds - minutes * 60);
  return seconds === 0 ? `${minutes} 分` : `${minutes} 分 ${seconds} 秒`;
}

/** 精确计数带千分位。详情窗是核对数字的地方，不缩写。 */
export function formatExactCount(value: number | null): string {
  return value === null || value === undefined ? "-" : value.toLocaleString("zh-CN");
}

/** 常见状态码的原因短语，让 502 这种不用查表就知道是什么。 */
const REASON_PHRASES: Record<number, string> = {
  200: "OK",
  201: "Created",
  202: "Accepted",
  204: "No Content",
  400: "Bad Request",
  401: "Unauthorized",
  403: "Forbidden",
  404: "Not Found",
  408: "Request Timeout",
  429: "Too Many Requests",
  500: "Internal Server Error",
  502: "Bad Gateway",
  503: "Service Unavailable",
  504: "Gateway Timeout",
};

/** 原因短语，报文首行也用它。 */
export function reasonPhrase(code: number): string | undefined {
  return REASON_PHRASES[code];
}

/** 状态码配上原因短语；没有响应和状态码为 0 是两回事，前者要说清楚。 */
export function formatStatus(code: number | null): string {
  if (code === null || code === undefined) return "无响应";
  const phrase = REASON_PHRASES[code];
  return phrase ? `${code} ${phrase}` : String(code);
}

/** 占比，给缓存命中这类「分子对分母」的数用。分母为 0 或缺失时不显示。 */
export function formatShare(part: number | null, whole: number | null): string | null {
  if (part === null || whole === null || !whole) return null;
  return `${Math.round((part / whole) * 100)}%`;
}

/**
 * 输出速度 tok/s。
 *
 * 分母用「首字之后的时间」而不是总时长：排队和首字延迟不该算进生成速度里，
 * 否则一个等了 10 秒才开口的流式请求会显示得比实际慢一个量级。
 */
export function outputSpeed(
  completionTokens: number | null,
  durationMs: number | null,
  firstTokenMs: number | null,
): string | null {
  if (!completionTokens || durationMs === null) return null;

  const generatingMs = firstTokenMs === null ? durationMs : durationMs - firstTokenMs;
  if (generatingMs <= 0) return null;

  const speed = completionTokens / (generatingMs / 1000);
  return `${speed >= 10 ? Math.round(speed) : speed.toFixed(1)} tok/s`;
}
