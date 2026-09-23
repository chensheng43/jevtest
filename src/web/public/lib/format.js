/** 数字与时间的显示格式。全站只有这一份，免得同一个量在两页上长得不一样。 */

/** 相对时间。列表里「3 分钟前」比一个完整时间戳更容易扫。 */
export function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return String(iso);
  const seconds = Math.round((Date.now() - then) / 1000);
  if (seconds < 45) return "刚刚";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(then).toLocaleDateString();
}

/** 完整时间，给 title 悬浮提示用。 */
export function absoluteTime(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleString() : String(iso);
}

/** 毫秒 -> 「850ms」「5.6s」「2m 05s」。两个浮点延迟相加会得到 1534.93169999ms，一律在这里取整。 */
export function duration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms)) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)}s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
}

/** 整数加千分位：33859 -> 33,859 */
export function count(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-US") : "—";
}

/** 列表里的大数：49948 -> 49.9k，1234567 -> 1.2M。精确值放 title，用 count()。 */
export function compactCount(value) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  if (value < 1000) return String(Math.round(value));
  if (value < 999_950) return `${(value / 1000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(1)}M`;
}

/** 金额。未知就是「未知」，不能写成 $0（报告的纪律：未知是 null，不是 0）。 */
export function money(usd) {
  return typeof usd === "number" && Number.isFinite(usd) ? `$${usd.toFixed(4)}` : "未知";
}

/** 概率保留两位。 */
export function probability(value) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "—";
}

/** 字符串的 UTF-8 字节数。请求体上限按字节算，`.length` 数的是 UTF-16 码元，中文会少算三分之二。 */
export function utf8Bytes(text) {
  return new TextEncoder().encode(text).length;
}
