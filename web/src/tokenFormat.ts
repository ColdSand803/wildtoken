/**
 * 令牌列表里的纯展示规则。
 *
 * 抽出来是为了能被直接测到：写在组件里的话，测试只能对着源码字符串断言，
 * 那种断言改了实现就得跟着改，锁不住行为。
 */

/** 还剩多久算「快到期」。 */
export const EXPIRY_SOON_MS = 7 * 24 * 60 * 60 * 1000;

/** 用量比例超过这个值算「接近用尽」。 */
export const QUOTA_WARN_RATIO = 0.8;

/**
 * token 数缩写成 K/M/B/T。
 *
 * 列表里要的是量级，不是精确值——精确值在 title 里。三位以上或整数不留小数，
 * 否则 "1.0M" 这种尾巴只是噪音。
 */
export function formatCount(value: number): string {
  for (const [suffix, unit] of [
    ["T", 1e12],
    ["B", 1e9],
    ["M", 1e6],
    ["K", 1e3],
  ] as const) {
    if (value >= unit) {
      const scaled = value / unit;
      const text =
        scaled >= 100 || Number.isInteger(scaled) ? Math.round(scaled) : scaled.toFixed(1);
      return `${text}${suffix}`;
    }
  }
  return String(value);
}

/**
 * 配额色调：用尽标红、接近用尽标黄。
 *
 * exhausted 以服务端为准而不是自己比大小——两边算法漂了的话，界面会说还有余量
 * 而请求已经被拒。
 */
export function quotaTone(options: {
  exhausted: boolean;
  used: number;
  limit: number;
}): "danger" | "warn" | "" {
  if (options.exhausted) return "danger";
  if (options.limit > 0 && options.used / options.limit >= QUOTA_WARN_RATIO) return "warn";
  return "";
}

/** 距到期还有多久，粗到分钟/小时/天即可。 */
export function expiryDistance(deltaMs: number): string {
  if (deltaMs <= 0) return "已过期";

  const minutes = Math.floor(deltaMs / 60_000);
  if (minutes < 1) return "不到 1 分钟";
  if (minutes < 60) return `${minutes} 分钟后`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时后`;
  return `${Math.floor(hours / 24)} 天后`;
}

/** 有效期徽章的色调。 */
export function expiryTone(deltaMs: number): "danger" | "neutral" | "on" {
  if (deltaMs <= 0) return "danger";
  return deltaMs <= EXPIRY_SOON_MS ? "neutral" : "on";
}

/**
 * 令牌预览：前 4 后 4，总长 ≤ 8 直接全显。
 *
 * 中间固定四个星号，不随真实长度变——变了就把长度泄露出去。
 * 用 Array.from 而不是 slice：按码元切会把超出 BMP 的字符斩成半个。
 */
export function tokenPreview(plaintext: string, storedPreview: string): string {
  if (!plaintext) return storedPreview;

  const chars = Array.from(plaintext);
  if (chars.length <= 8) return plaintext;
  return `${chars.slice(0, 4).join("")}****${chars.slice(-4).join("")}`;
}
