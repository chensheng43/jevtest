/**
 * 并发原语：Semaphore 与 AsyncQueue。
 *
 * Node 没有 Python 的 `asyncio.Queue` 与 `Semaphore`，这两个加起来约 40 行，
 * 比起引入一个依赖更划算。
 */

/**
 * 计数信号量。
 *
 * 本项目的用法是**两个解耦的信号量**，而不是一个总闸：
 *   - 一个限制浏览器 context 数（内存瓶颈）；
 *   - 一个限制在途引擎请求数（厂商限流瓶颈）。
 * 两者瓶颈无关，绑在一起会让其中一个白白闲置。
 */
export class Semaphore {
  constructor(permits: number) {
    throw new Error("未实现：P0 待实现");
  }

  /** 获取一个许可，无可用时挂起等待 */
  acquire(): Promise<void> {
    throw new Error("未实现：P0 待实现");
  }

  /** 归还许可 */
  release(): void {
    throw new Error("未实现：P0 待实现");
  }

  /** 立即尝试获取，失败返回 false 而不挂起 */
  tryAcquire(): boolean {
    throw new Error("未实现：P0 待实现");
  }

  get available(): number {
    throw new Error("未实现：P0 待实现");
  }

  /** 在许可保护下执行，异常路径也保证归还 */
  async with<T>(fn: () => Promise<T>): Promise<T> {
    throw new Error("未实现：P0 待实现");
  }
}

/**
 * 异步队列。worker 循环从中 `shift()`。
 *
 * `shift()` 在队列空时挂起而非返回 undefined——worker 因此不需要忙等。
 * `close()` 后所有挂起的 `shift()` 会 reject，让 worker 循环干净退出。
 */
export class AsyncQueue<T> {
  push(item: T): void {
    throw new Error("未实现：P0 待实现");
  }

  /** 取出一个元素；队列空则挂起。close() 后 reject */
  shift(): Promise<T> {
    throw new Error("未实现：P0 待实现");
  }

  get size(): number {
    throw new Error("未实现：P0 待实现");
  }

  close(): void {
    throw new Error("未实现：P0 待实现");
  }

  get closed(): boolean {
    throw new Error("未实现：P0 待实现");
  }
}

// TODO(P0): 实现两个类。Semaphore.with 的 finally 是关键——
//   pool.withSession 与 budget 都依赖它保证异常路径下不泄漏许可。
