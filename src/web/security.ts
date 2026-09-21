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

/** 令牌在 HTML 里的占位符。静态文件读取时被替换为真实令牌。 */
export const TOKEN_PLACEHOLDER = "__JEVTEST_TOKEN__";

/** 前端携带令牌的请求头名。 */
export const TOKEN_HEADER = "x-jevtest-token";

/** 控制类端点的请求体上限。 */
export const MAX_BODY_BYTES = 8192;

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
  throw new Error("未实现：P0 待实现");
}

/** GET 类请求：只校验 Host。 */
export function guardRead(ctx: SecurityContext, headers: Record<string, string | undefined>): GuardResult {
  throw new Error("未实现：P0 待实现");
}

/** POST 类请求：校验 Host + Token + Origin 三重。 */
export function guardWrite(
  ctx: SecurityContext,
  headers: Record<string, string | undefined>,
): GuardResult {
  throw new Error("未实现：P0 待实现");
}

/**
 * 把 `/vendor/` 路径解析为磁盘路径，越界返回 null。
 *
 * 这是全项目唯一的动态文件服务路径（用于把 zod 直接喂给浏览器做表单即时校验），
 * 因此也是唯一的目录穿越风险点。解析后必须断言前缀在允许目录内，
 * 且只放行 `.js` / `.map` / `.json`。
 */
export function resolveVendorPath(vendorRoot: string, urlPath: string): string | null {
  throw new Error("未实现：P0 待实现");
}

/** 读取静态文件并把令牌占位符替换掉。只有 HTML 需要替换。 */
export function injectToken(content: string, token: string): string {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现以上函数。guardWrite 的失败原因要写进响应的 JSON 里，
//   方便排查「为什么我的 curl 被 403 了」，但**不要回显收到的 token**。
