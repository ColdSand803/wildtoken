/**
 * 令牌有效期的输入解析与回填。
 *
 * 抽成独立模块是为了能被直接测到。这里没有 DOM 依赖，时间一律通过参数传入，
 * 测试不必冻结系统时钟。
 */

/** 绝对时刻：日期必填，时分秒可选。 */
const EXPIRY_ABSOLUTE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?$/;

const UNIT_SECONDS: Record<string, number> = { s: 1, m: 60, h: 3600, d: 86400, w: 604800 };

export const EXPIRY_HINT =
  "留空则永不过期。可填 30d、1d3h、90m 这类时长，或 2026-09-01 12:00 这样的时刻。";

export type ExpiryParse =
  | { ok: true; expiresAtMs: number | null }
  | { ok: false; error: string };

/**
 * 解析有效期输入。
 *
 * 两种写法：绝对时刻，或多段时长的累加（1d3h）。expiresAtMs 为 null 表示
 * 永不过期。只给预设下拉的话设不了任意时刻。
 */
export function parseExpiry(raw: string, nowMs: number): ExpiryParse {
  const value = raw.trim();
  if (!value) return { ok: true, expiresAtMs: null };

  const absolute = EXPIRY_ABSOLUTE.exec(value);
  if (absolute) {
    const [, y, mo, d, h = "0", mi = "0", s = "0"] = absolute;
    if (Number(h) > 23 || Number(mi) > 59 || Number(s) > 59) {
      return { ok: false, error: "这个时刻不存在。" };
    }

    /* new Date(2026, 1, 31) 会顺延到三月。回读一次，不合法就报错而不是猜。 */
    const at = new Date(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
    if (
      at.getFullYear() !== Number(y) ||
      at.getMonth() !== Number(mo) - 1 ||
      at.getDate() !== Number(d)
    ) {
      return { ok: false, error: "这个日期不存在。" };
    }
    return { ok: true, expiresAtMs: at.getTime() };
  }

  // 粘性正则逐段吃，没吃完就是有看不懂的字符。
  const segment = /(\d+)\s*([smhdw])\s*/y;
  const expression = value.toLowerCase();
  const seen = new Set<string>();
  let seconds = 0;

  while (segment.lastIndex < expression.length) {
    const match = segment.exec(expression);
    if (!match) return { ok: false, error: `看不懂这个有效期。${EXPIRY_HINT}` };
    if (seen.has(match[2])) return { ok: false, error: `单位 ${match[2]} 出现了两次。` };
    seen.add(match[2]);
    seconds += Number(match[1]) * UNIT_SECONDS[match[2]];
  }

  if (seconds <= 0) return { ok: false, error: "有效期要大于 0。" };
  return { ok: true, expiresAtMs: nowMs + seconds * 1000 };
}

/** 把存着的 UTC 变回输入框里可编辑的本地读数，与 parseExpiry 互为逆。 */
export function expiryInputValue(expiresAt: string | null): string {
  if (!expiresAt) return "";

  const normalized = expiresAt.includes("T") ? expiresAt : expiresAt.replace(" ", "T");
  const withZone = /[Z+]|-\d\d:\d\d$/.test(normalized) ? normalized : `${normalized}Z`;
  const at = new Date(withZone);
  if (Number.isNaN(at.getTime())) return "";

  const pad = (value: number) => String(value).padStart(2, "0");
  return (
    `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ` +
    `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`
  );
}

/** 后端要的是 'YYYY-MM-DD HH:MM:SS' 的 UTC，和 created_at 同形。 */
export function toUtcStamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}
