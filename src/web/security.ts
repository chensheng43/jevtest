/**
 * 本地服务的安全守卫。
 *
 * 沿用 jev-ultrafast `demo.py:17-19, 82-125` 的模式（详见 NOTICE）。
 * 这个服务只监听 127.0.0.1，但仍然需要这三道闸——**因为「本地」不等于「安全」**：
 * 浏览器里任何一个你访问过的网页都能向 localhost 发请求。
 *
 *   1. **Host 必须精确匹配 `127.0.0.1:<port>`**。
 *      防 DNS rebinding：攻击者把自己的域名解析到 127.0.0.1，让浏览器
 *      以为请求是发往同源的。校验 Host 头能挡住这一招。
 *
 *   2. **一次性请求令牌**。进程启动时生成，注入首页的 `<meta name="jevtest-token">`，
 *      前端每个请求都带 `X-Jevtest-Token`。外部页面拿不到这个 token
 *      （同源策略不让它读我们的 HTML），因此无法伪造请求。
 *
 *   3. **Origin 校验**。允许 null（同源导航与 curl）或本服务的 origin。
 *
 * 另外两条：
 *   - 请求体上限。控制类端点 8KB 足够，超了直接 413，避免被塞爆内存。
 *   - `/vendor/*` 静态映射是唯一的动态文件服务路径，**必须防目录穿越**。
 */

import { randomBytes, timingSafeEqual } from "node:crypto";
import { extname, isAbsolute, relative, resolve, sep } from "node:path";

/** 令牌在 HTML 里的占位符。静态文件读取时被替换为真实令牌。 */
export const TOKEN_PLACEHOLDER = "__JEVTEST_TOKEN__";

/** 前端携带令牌的请求头名。 */
export const TOKEN_HEADER = "x-jevtest-token";

/** 控制类端点的请求体上限。 */
export const MAX_BODY_BYTES = 8192;

/**
 * `/vendor/*` 允许的扩展名。
 *
 * 白名单而不是黑名单：动态文件服务是全项目唯一的目录穿越风险点，
 * 「只放行已知安全的三种」比「拦掉已知危险的若干种」少一个需要持续维护的判断。
 */
export const VENDOR_EXTENSIONS: readonly string[] = [".js", ".map", ".json"];

export interface SecurityContext {
  token: string;
  port: number;
  /** 允许的 Origin。通常是 `http://127.0.0.1:<port>` */
  origin: string;
}

export interface GuardResult {
  ok: boolean;
  status: number;
  reason: string;
}

/** 生成一次性令牌。 */
export function createToken(): string {
  // 32 字节 = 256 位。令牌不参与任何用户可见的推导，长度成本可以忽略。
  return randomBytes(32).toString("hex");
}

/**
 * 常量时间比较，避免用比较耗时反推令牌。
 *
 * 长度不等时直接返回 false：`timingSafeEqual` 要求两个 Buffer 等长，
 * 而长度本身就是公开信息，不构成泄漏。
 */
function tokenEquals(expected: string, received: string): boolean {
  const a = Buffer.from(expected, "utf8");
  const b = Buffer.from(received, "utf8");
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/**
 * Host 头的期望值。
 *
 * 刻意**不接受 `localhost:<port>`**：`localhost` 在部分系统上会先解析到 `::1`，
 * 而我们只绑定了 IPv4 回环。允许它意味着「同一个服务有两个可用的 Host 名字」，
 * 而 DNS rebinding 正是靠「多个名字指向同一处」生效的——少一个别名就少一个入口。
 */
function expectedHost(ctx: SecurityContext): string {
  return `127.0.0.1:${ctx.port}`;
}

function guardHost(ctx: SecurityContext, headers: Record<string, string | undefined>): GuardResult | null {
  const host = headers.host;
  if (host === undefined) {
    return { ok: false, status: 403, reason: "缺少 Host 头，拒绝请求" };
  }
  if (host.toLowerCase() !== expectedHost(ctx)) {
    return {
      ok: false,
      status: 403,
      reason: `Host 必须精确等于 ${expectedHost(ctx)}（收到 ${host}）。这条守卫防的是 DNS rebinding。`,
    };
  }
  return null;
}

/** GET 类请求：只校验 Host。 */
export function guardRead(ctx: SecurityContext, headers: Record<string, string | undefined>): GuardResult {
  // 读操作不改状态、不驱动浏览器，因此只挡 DNS rebinding 这一层。
  // 但注意：能读到用例与报告本身也是信息泄漏，所以将来若加了敏感端点，
  // 应该把它变成写守卫而不是放宽写守卫。
  return guardHost(ctx, headers) ?? { ok: true, status: 200, reason: "" };
}

/** POST 类请求：校验 Host + Token + Origin 三重。 */
export function guardWrite(
  ctx: SecurityContext,
  headers: Record<string, string | undefined>,
): GuardResult {
  const hostFailure = guardHost(ctx, headers);
  if (hostFailure) return hostFailure;

  const origin = headers.origin;
  // Origin 为 null/缺失是合法的：同源导航、curl、以及部分浏览器在
  // 同源请求上不发 Origin。存在时则必须精确等于本服务 origin。
  if (origin !== undefined && origin !== null && origin !== "null" && origin !== ctx.origin) {
    return {
      ok: false,
      status: 403,
      reason: `Origin 必须是 ${ctx.origin} 或空（收到 ${origin}）。这条守卫防的是跨站表单提交。`,
    };
  }

  const token = headers[TOKEN_HEADER];
  if (token === undefined || token === "") {
    return {
      ok: false,
      status: 403,
      reason: `缺少 ${TOKEN_HEADER} 请求头。令牌在首页的 <meta name="jevtest-token"> 里，前端会自动带上。`,
    };
  }
  if (!tokenEquals(ctx.token, token)) {
    // 刻意不回显收到的值——失败原因写清楚就够了，回显只会给爆破提供反馈。
    return {
      ok: false,
      status: 403,
      reason: `${TOKEN_HEADER} 不正确。若服务重启过，刷新页面即可拿到新令牌。`,
    };
  }
  return { ok: true, status: 200, reason: "" };
}

/**
 * 把 `/vendor/` 路径解析为磁盘路径，越界返回 null。
 *
 * 这是全项目唯一的动态文件服务路径（用于把 zod 直接喂给浏览器做表单即时校验），
 * 因此也是唯一的目录穿越风险点。解析后必须断言前缀在允许目录内，
 * 且只放行 `.js` / `.map` / `.json`。
 */
export function resolveVendorPath(vendorRoot: string, urlPath: string): string | null {
  // 先剥掉 URL 里的查询串与片段：它们不参与路径解析，但会让 extname 判错。
  const pathOnly = urlPath.split("?")[0]?.split("#")[0] ?? "";

  // 允许调用方传 `/vendor/zod/index.js` 或 `/zod/index.js`，统一成相对路径。
  const relativePath = pathOnly.replace(/^\/+/, "").replace(/^vendor\//, "");
  if (relativePath === "") return null;

  // 显式拒绝 NUL 字节：某些文件系统 API 会把它当成字符串终止符，
  // 于是 `foo.js\0../../etc/passwd` 的扩展名检查与真实路径解析会看到两个不同的名字。
  if (relativePath.includes("\0")) return null;

  const extension = extname(relativePath).toLowerCase();
  if (!VENDOR_EXTENSIONS.includes(extension)) return null;

  const root = resolve(vendorRoot);
  const target = resolve(root, relativePath);

  // 前缀断言用 path.relative 而不是 startsWith：后者会把
  // `/root-evil` 误判成在 `/root` 之内。relative 不含 `..` 且不是绝对路径才算在界内。
  const rel = relative(root, target);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.split(sep).includes("..")) {
    return null;
  }
  return target;
}

/** 读取静态文件并把令牌占位符替换掉。只有 HTML 需要替换。 */
export function injectToken(content: string, token: string): string {
  // split/join 而非 replace：replace 只在字符串形式下替换第一次出现，
  // 而首页可能有多个引用点（meta 与内联脚本）。这里要的是全部替换。
  return content.split(TOKEN_PLACEHOLDER).join(token);
}
