/**
 * 浏览器池：一个 Chromium，多个 BrowserContext。
 *
 * **一个 context 就是一个用例的隔离边界**，这是换到 Playwright 换来的最大收益。
 * 参考项目所有标签页共享用户已有的 Chrome profile，测试之间会通过 cookie 与
 * localStorage 互相污染，也无法并行；`newContext()` 把这两个问题一起解决了
 * （成本约 50ms、内存 80~150MB）。
 *
 * 参考项目那把「序列化所有浏览器步进」的全局 LOCK（`demo.py:111-112`）在这里被**删除**：
 * 它存在只是因为当时只有一个共享的后台标签页。隔离是天然的之后，锁反而会杀掉批量并发。
 *
 * 两道独立信号量，刻意解耦：
 *   - `maxContexts` 限制浏览器内存占用；
 *   - `maxEngineInflight` 限制厂商侧并发。
 * 两者的瓶颈无关：模型 API 的吞吐与浏览器内存没有关系，绑在一起会让其中一个白白闲置。
 */

import type { Session } from "./session.ts";

/**
 * 池的配置。
 *
 * 三项都来自 `Settings`，没有自己的默认值兜底——**配置只有一个来源**，
 * 在池里再写一遍默认值就会出现「改了环境变量却没生效」这种最难查的问题。
 * 字段名与 `Settings` 一一对应，映射在 `createBrowserPool` 的调用处完成。
 */
export interface PoolOptions {
  /** 同时存在的 context 数上限。来自 `settings.workers` */
  maxContexts: number;
  /** 同时在途的引擎请求数上限。来自 `settings.maxEngineInflight` */
  maxEngineInflight: number;
  /** 来自 `settings.headless` */
  headless: boolean;
}

export interface ContextOptions {
  /** 复用登录态：从 storageState 文件加载 cookie 与 localStorage */
  storageStatePath?: string;
  /** 是否录制 trace.zip */
  tracing?: boolean;
  tracePath?: string;
}

export interface BrowserPool {
  /** 启动 Chromium。整个进程只调一次 */
  start(): Promise<void>;

  /**
   * 借出一个 context，跑完自动归还。
   *
   * **必须在 finally 里 close context**，否则 Chromium 会泄漏 renderer 进程。
   * 这个方法把 try/finally 封在里面，调用方不可能写错。
   */
  withSession<T>(options: ContextOptions, fn: (session: Session) => Promise<T>): Promise<T>;

  /** 导出登录态，供后续用例复用。写入权限应为 0600 */
  saveStorageState(session: Session, path: string): Promise<void>;

  /** 当前存活的 context 数。doctor 与队列页用它做泄漏检查（正常应回到 0） */
  activeContexts(): number;

  /** 优雅停机：等待在途用例走到步边界，再关闭 */
  stop(): Promise<void>;
}

export function createBrowserPool(options: PoolOptions): BrowserPool {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现。注意 `playwright` 的 browser 实例是跨 context 共享的，
//           但**每个 context 必须自己配 viewport**（newContext 时传入）。
// TODO(P0): stop() 要有超时保护——在途用例可能正卡在一次 30s 的模型请求上。
