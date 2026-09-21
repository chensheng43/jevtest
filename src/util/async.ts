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
 *
 * 公平性是硬要求：等待者按申请顺序唤醒（FIFO）。若允许插队，
 * 先到的用例可能被反复推迟，表现为「有些用例排了很久才开跑」——
 * 这类不公平不会报错，只会让批量运行的时间分布变得无法解释。
 */
export class Semaphore {
  /** 初始许可数。release() 需要它才能判断「归还」是否越界 */
  readonly #limit: number;
  #available: number;
  /**
   * 等待者队列。**用数组而不是 Set**：公平性要求严格按申请顺序唤醒，
   * 而 Set 的迭代顺序只是「碰巧也是插入顺序」，读代码的人得不出这个结论。
   */
  readonly #waiters: Array<() => void> = [];

  constructor(permits: number) {
    // 许可数 <= 0 时 acquire() 会永远挂起，那是死锁而不是限流，
    // 而且表现为整个 worker 池静默卡死、没有任何报错。
    // 在构造时报错，让配置错误在启动那一刻暴露。
    if (!Number.isInteger(permits) || permits < 1) {
      throw new RangeError(`Semaphore 的许可数必须是 >= 1 的整数，收到 ${String(permits)}`);
    }
    this.#limit = permits;
    this.#available = permits;
  }

  /** 获取一个许可，无可用时挂起等待 */
  acquire(): Promise<void> {
    if (this.#available > 0) {
      this.#available -= 1;
      // 非 async 函数里返回已 resolve 的 promise：调用方 await 之后才继续，
      // 但许可的扣减是**同步**发生的。这一点保证了并发上限与调用顺序无关。
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.#waiters.push(resolve);
    });
  }

  /** 归还许可 */
  release(): void {
    // 有人等着就直接转交，不经过 #available：这样 #available 恒等于
    // 「仍在别人手里的许可数」，等待者也不会被随后到来的 tryAcquire() 插队。
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter();
      return;
    }
    if (this.#available >= this.#limit) {
      // 超发说明 release 的次数多于 acquire。**必须报错，不能静默容忍**：
      // 容忍会让许可数虚增，随后并发上限被悄悄突破——那正是信号量存在的唯一理由。
      // 这里宁可让调用方在越界那一刻炸掉，也不要去掩盖它的泄漏 bug。
      throw new Error(
        `Semaphore 超发：已归还的许可数超过初始许可数 ${this.#limit}，调用方的 acquire/release 没有配对`,
      );
    }
    this.#available += 1;
  }

  /** 立即尝试获取，失败返回 false 而不挂起 */
  tryAcquire(): boolean {
    if (this.#available > 0) {
      this.#available -= 1;
      return true;
    }
    return false;
  }

  get available(): number {
    return this.#available;
  }

  /** 在许可保护下执行，异常路径也保证归还 */
  async with<T>(fn: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await fn();
    } finally {
      // 用 finally 而不是 catch：正常返回、抛错、被取消（AbortError）三条路径
      // 都必须归还。pool.withSession 与 runner 的收尾都挂在这上面，
      // 漏掉任何一条，`contextsActive` 就不会归零（architecture §9.3）——
      // 泄漏的 renderer 进程会一直吃内存，且不会自己消失。
      this.release();
    }
  }
}

/**
 * 异步队列。worker 循环从中 `shift()`。
 *
 * `shift()` 在队列空时挂起而非返回 undefined——worker 因此不需要忙等。
 * `close()` 后所有挂起的 `shift()` 会 reject，让 worker 循环干净退出。
 *
 * **close() 的两条语义（刻意如此）：**
 *   1. **已入队的元素仍然可以被取出**（先排空，再 reject）。close 表示
 *      「不再有新的进来」，而不是「丢掉手上的」。丢掉会让已排队的任务
 *      既不执行也不出现在报告里——对测试平台来说这是最坏的失败模式
 *      （看起来全绿，实际上有用例根本没跑）。runner 的 worker 循环是
 *      `shift() -> 已取消? -> pool.withSession()`，正是靠排空才能把
 *      停机时残留的任务逐个标记为 cancelled。
 *   2. **close 之后再 push 直接抛错**，不是静默忽略。静默忽略同样会
 *      静默丢任务，而且丢在生产者一侧、更难定位。
 */
export class AsyncQueue<T> {
  readonly #items: T[] = [];
  readonly #waiters: Array<{ resolve: (value: T) => void; reject: (reason: unknown) => void }> = [];
  #closed = false;

  push(item: T): void {
    if (this.#closed) {
      throw new Error("AsyncQueue 已关闭，不能再 push：该元素永远不会被消费，属于上游的生命周期 bug");
    }
    // 有人等着就直投，不落队列：省一次出队，也让 size 始终等于「真正积压的量」。
    const waiter = this.#waiters.shift();
    if (waiter !== undefined) {
      waiter.resolve(item);
      return;
    }
    this.#items.push(item);
  }

  /** 取出一个元素；队列空则挂起。close() 后 reject */
  shift(): Promise<T> {
    if (this.#items.length > 0) {
      // 长度已判，此处 shift() 必然返回元素；noUncheckedIndexedAccess 看不到这层关系。
      return Promise.resolve(this.#items.shift() as T);
    }
    if (this.#closed) {
      // 排空之后的 shift 必须立刻 reject，否则 worker 循环会永久停在 await 上，
      // 「close 后干净退出」就落空了。
      return Promise.reject(new Error("AsyncQueue 已关闭，队列已排空"));
    }
    return new Promise<T>((resolve, reject) => {
      this.#waiters.push({ resolve, reject });
    });
  }

  get size(): number {
    return this.#items.length;
  }

  close(): void {
    this.#closed = true;
    // 挂起的 shift 只可能在队列为空时存在（有元素时不入等待队列），
    // 因此这里 reject 掉它们不会连带丢元素。
    const waiters = this.#waiters.splice(0);
    for (const waiter of waiters) {
      waiter.reject(new Error("AsyncQueue 已关闭"));
    }
  }

  get closed(): boolean {
    return this.#closed;
  }
}
