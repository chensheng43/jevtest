/**
 * HTTP 服务：node:http + 约 40 行路由。
 *
 * 为什么不用 Hono：它确实能让 SSE 从 15 行降到 3 行，但代价是引入两个依赖，
 * 且其 `streamSSE` 有在连接静默断开时挂起、`onAbort` 不触发的已知问题
 * （honojs/hono#1902、#3540）。本项目用轮询，本来就不需要 SSE，
 * 因此不值得为省几十行代码换来一个长期存在的失败面。
 *
 * 这个决定是可低成本反悔的：路由都集中在 api.ts，换框架只改那两个文件。
 *
 * 服务只绑定 127.0.0.1，并强制走 security.ts 的三道闸。
 * **不要把它暴露到 0.0.0.0**——它能读写磁盘上的用例、能驱动浏览器、
 * 且持有 TypeSafe 的凭证。
 */

import type { Settings } from "../config.ts";
import type { SecurityContext } from "./security.ts";

export interface ServerDeps {
  settings: Settings;
  security: SecurityContext;
  /** 由 cli 组装好的依赖（pool / runner / storage / events） */
  services: unknown;
}

export interface Server {
  /** 开始监听。返回实际端口（传 0 时由系统分配，测试用） */
  listen(port: number): Promise<number>;
  /** 优雅停机：先停 runner 再关 server */
  close(): Promise<void>;
}

export function createServer(deps: ServerDeps): Server {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现 createServer。
//   - 路由集中在 api.ts 的 handle()，这里只做：解析 URL -> 安全守卫 ->
//     调用 handle -> 写响应。静态文件走 web/public/，读取时替换令牌占位符。
//   - 请求体读取要**流式限长**，不能先收完再判断大小。
//   - 所有异常都要变成结构化 JSON 响应，绝不让进程因为一个坏请求崩掉。
//
// TODO(P0): 与 runner 的停机顺序：先 runner.stop()（等在途用例走到步边界），
//   再关 server。反过来的话，用例跑完了却没法把报告响应给任何人。
