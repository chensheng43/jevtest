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
 *
 * ## 本文件里 `maxEngineInflight` 为什么只出现一次
 *
 * `PoolOptions.maxEngineInflight` **在这里被刻意不消费**——它由引擎层持有：
 * `engine/typesafe.ts` 的 `gateFor()` 维护一个**模块级**单例信号量，按许可数缓存。
 * 闸建在那里而不是这里，是因为被限流的对象是**厂商**而不是浏览器：限流是每进程的，
 * 若每个引擎实例各持一道闸，N 个并发用例就会同时发出 N × maxEngineInflight 个请求，
 * 限流形同虚设（见该文件上的注释）。池里再建一道，两道闸的**乘积**才是实际并发——
 * 改一个配置项得到两处相乘的效果，这种事没人推得出来。
 * 字段保留在 `PoolOptions` 里，只为让 `Settings` -> `PoolOptions` 的映射保持一一对应。
 */

import { access, chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { chromium } from "playwright";
import type { Browser, BrowserContext, BrowserContextOptions } from "playwright";
import { JevtestError } from "../core/errors.ts";
import { Semaphore } from "../util/async.ts";
import { VIEWPORT, createPlaywrightSession } from "./playwright-session.ts";
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

/**
 * `stop()` 等待在途用例走到步边界的上限。
 *
 * 60s 而不是 30s：一次决策请求自身的超时就是 30s（`engine/typesafe.ts` 的
 * `DEFAULT_TIMEOUT_MS`），用例卡住时正好顶在那个值上。窗口开得比单次请求略宽，
 * 是为了让「刚好卡在一次模型请求上」的用例有机会跑完这一步、把报告写完，
 * 而不是在它即将落盘的前一刻被掐断。
 * 再长也不合适：停机无限期挂着比丢一份报告更难处理，而且 `browser.close()`
 * 本来就能把残留 context 一并强制关掉，超时并不会漏掉清理。
 */
const STOP_DRAIN_TIMEOUT_MS = 60_000;

export function createBrowserPool(options: PoolOptions): BrowserPool {
  /**
   * 上下文闸门。只限 `maxContexts`（浏览器内存），**不掺引擎限流**，理由见文件头。
   */
  const contexts = makeContextGate(options.maxContexts);

  /**
   * `session` -> `context` 的映射。
   *
   * `saveStorageState(session, path)` 要拿到 context 才导得出登录态，而 `Session`
   * 接口是冻结契约，里面没有、也不该有 context 的出口（那样会把 Playwright
   * 漏进 `core/` 的类型面）。WeakMap 让这份映射不延长 session 的生命周期。
   */
  const contextOf = new WeakMap<Session, BrowserContext>();

  let browser: Browser | null = null;
  /** 启动中的那次调用。并发 `start()` 会 await 同一个 promise，不会起两个浏览器 */
  let launching: Promise<Browser> | null = null;
  /** 当前存活（已建、未关）的 context 数。`activeContexts()` 直接读它 */
  let active = 0;
  /** 等到 `active` 归零时被唤醒。只用于 `stop()` 的排空等待 */
  let drainWaiters: Array<() => void> = [];
  let stopped = false;
  let warnedNoTracePath = false;

  // -------------------------------------------------------------------------
  // 启动
  // -------------------------------------------------------------------------

  async function launch(): Promise<Browser> {
    try {
      // 不传任何自定义 args：加了会让本地与 CI 的浏览器行为分叉，而目前没有
      // 证据表明这里需要它。真需要时应该连同平台判断一起加，并写清理由。
      return await chromium.launch({ headless: options.headless });
    } catch (error) {
      throw new JevtestError(
        `启动 Chromium 失败：${describe(error)}。` +
          "若错误提到可执行文件不存在，先跑 `npx playwright install chromium`。",
        { cause: error },
      );
    }
  }

  function ensureBrowser(): Promise<Browser> {
    if (browser !== null) return Promise.resolve(browser);
    if (stopped) {
      // 停机之后再要浏览器，是这个 promise 链的最后一个陷阱：`browser` 已被置空，
      // 不拦住就会在进程退出途中悄悄再拉起一整个 Chromium，而它永远不会被关掉。
      return Promise.reject(new JevtestError("浏览器池已停止，不能再用它借出 context"));
    }
    launching ??= launch().then(
      (instance) => {
        browser = instance;
        launching = null;
        return instance;
      },
      (error: unknown) => {
        // 启动失败**不缓存**：否则一次瞬时故障（装到一半、句柄没释放）
        // 会让池在进程余下的整个生命周期里永远起不来，而重试本来是有效的。
        launching = null;
        throw error;
      },
    );
    return launching;
  }

  async function start(): Promise<void> {
    await ensureBrowser();
  }

  // -------------------------------------------------------------------------
  // context 生命周期
  // -------------------------------------------------------------------------

  async function createContext(ctxOptions: ContextOptions): Promise<BrowserContext> {
    const instance = await ensureBrowser();

    const launchOptions: BrowserContextOptions = {
      // **每个 context 自己配 viewport**：browser 实例跨 context 共享，视口却是
      // context 级属性。想省这一步的人会去找 launch({ viewport })，而 Playwright
      // 没有那个选项——写错了不会报错，只会让所有截图尺寸都不对。
      viewport: { ...VIEWPORT },
      // 固定 1：让元素几何（rect）与截图分辨率在本地和 CI 上一致。
      // 跟随系统 DPI 会让「同一个元素在别人机器上宽 2px」变成难查的偶发失败。
      deviceScaleFactor: 1,
    };
    if (ctxOptions.storageStatePath !== undefined) {
      await assertReadable(ctxOptions.storageStatePath);
      launchOptions.storageState = ctxOptions.storageStatePath;
    }

    try {
      return await instance.newContext(launchOptions);
    } catch (error) {
      throw new JevtestError(
        `创建 BrowserContext 失败：${describe(error)}`,
        { cause: error },
      );
    }
  }

  /**
   * 登录态文件必须先确认可读。
   *
   * Playwright 自己也会报错，但报的是一句 `ENOENT` 加它内部的调用栈；
   * 这里要说清的是「路径配错了」还是「文件还没导出来」——那是用户能直接动手修的两件事。
   */
  async function assertReadable(path: string): Promise<void> {
    try {
      await access(path);
    } catch (error) {
      throw new JevtestError(
        `读不到登录态文件 ${path}。先用 saveStorageState() 导出一份，或检查配置里的路径`,
        { cause: error },
      );
    }
  }

  /**
   * 开录。返回真实的落盘路径，`null` = 本次不录。
   *
   * **只有 `tracing` 与 `tracePath` 同时给出才录**：只给 `tracing` 而没给落点，
   * 录完 `stop()` 不带 path 会把缓冲区直接丢掉——白烧 CPU 和内存，而且
   * 「配置里 tracing=true，却永远没有 trace.zip」这种事不看代码根本看不出来。
   * 所以这里只警告一次，不录。
   *
   * 返回路径而不是布尔值，是为了让调用方的 finally 里没有「有 recording 却没有
   * tracePath」这种需要再判一次的分支。
   */
  async function startTracing(
    context: BrowserContext,
    ctxOptions: ContextOptions,
  ): Promise<string | null> {
    if (ctxOptions.tracing !== true) return null;
    const path = ctxOptions.tracePath;
    if (path === undefined || path === "") {
      if (!warnedNoTracePath) {
        warnedNoTracePath = true;
        console.warn(
          "[jevtest] 警告：tracing 已开启但没有 tracePath，本次不录制 trace。" +
            "调用方需要给 ContextOptions.tracePath（通常是 runs/<runId>/trace.zip）",
        );
      }
      return null;
    }
    try {
      // screenshots 与 snapshots 缺一不可：没有 snapshot 的 trace 只能看时间线，
      // 点不开任何一个动作发生时的 DOM——而那正是排查失败时要看的东西。
      await context.tracing.start({ screenshots: true, snapshots: true, sources: true });
      return path;
    } catch (error) {
      // trace 是排查手段，不是功能。录不起来不该让用例跑不成
      console.warn(`[jevtest] 警告：trace 录制启动失败（${describe(error)}），本次运行没有 trace.zip`);
      return null;
    }
  }

  /** 停止录制并落盘。**吞异常但留回响**，理由与 `closeContext` 相同。 */
  async function stopTracing(context: BrowserContext, tracePath: string): Promise<void> {
    try {
      await mkdir(dirname(tracePath), { recursive: true });
      await context.tracing.stop({ path: tracePath });
    } catch (error) {
      console.warn(
        `[jevtest] 警告：trace 写出失败（${describe(error)}），${tracePath} 可能不完整。` +
          "失败运行最需要的恰好是这份 trace，值得单独看一眼磁盘。",
      );
    }
  }

  /**
   * 关 context。**异常在这里被吞掉，但一定有回响。**
   *
   * 它在 `finally` 里跑：抛出去会盖住用例真正的失败原因，而那个才是要看的。
   * 静默吞掉又会让 renderer 泄漏不留痕迹——`contextsActive` 归零正是为了盯这件事
   * （architecture §9.3）。所以记一条警告，然后继续。
   */
  async function closeContext(context: BrowserContext): Promise<void> {
    try {
      await context.close();
    } catch (error) {
      // 停机时我们已经主动关掉了浏览器，这时的 context.close() 必然失败，
      // 它不是泄漏，是预期内的竞态。只有非停机路径上的失败才值得喊。
      if (!stopped) {
        console.warn(
          `[jevtest] 警告：关闭 BrowserContext 失败（${describe(error)}）。` +
            "一个 renderer 进程可能没有释放；stop() 关闭浏览器时会兜底清理",
        );
      }
    }
  }

  // -------------------------------------------------------------------------
  // 排空
  // -------------------------------------------------------------------------

  function notifyDrain(): void {
    if (active > 0) return;
    const waiters = drainWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  /** 等到没有存活 context。超时返回 false，由调用方决定怎么处理 */
  function waitForDrain(timeoutMs: number): Promise<boolean> {
    if (active === 0) return Promise.resolve(true);
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(false), timeoutMs);
      drainWaiters.push(() => {
        clearTimeout(timer);
        resolve(true);
      });
    });
  }

  // -------------------------------------------------------------------------
  // 对外接口
  // -------------------------------------------------------------------------

  async function withSession<T>(
    ctxOptions: ContextOptions,
    fn: (session: Session) => Promise<T>,
  ): Promise<T> {
    if (stopped) throw new JevtestError("浏览器池已停止，不能再用它借出 context");

    // 信号量在**最外层**：排队等许可的时间不该算进 context 的生命周期，
    // 否则 `activeContexts()` 会把还在排队的用例也算成「已占内存」，
    // 而它存在的意义正是反映真实的内存占用。
    return contexts.with(async () => {
      const context = await createContext(ctxOptions);
      active += 1;
      // 排空等待盯的是「已经建出来的 context」，所以计数必须在建完之后加
      const tracePath = await startTracing(context, ctxOptions);
      try {
        const page = await context.newPage();
        const session = createPlaywrightSession({
          page,
          tracing: ctxOptions.tracing,
          tracePath: ctxOptions.tracePath,
        });
        contextOf.set(session, context);
        // session.close() 不在这里显式调用：`context.close()` 会把它的 page 一起关掉，
        // 再单独关一次只是往 finally 里多加一条可能失败的路。释放责任全在池这一层。
        return await fn(session);
      } finally {
        // 顺序是硬要求：`tracing.stop()` 必须在 `context.close()` **之前**，
        // 两者又都必须在 finally 里（docs/development.md §5.4）。少一次 stop，
        // 丢掉的恰好是最需要看的那次失败运行的 trace.zip。
        if (tracePath !== null) await stopTracing(context, tracePath);
        await closeContext(context);
        // 两个清理函数都不抛，所以这一行一定会跑到：计数不归零，
        // stop() 会白等满 60s，然后报一个不存在的泄漏。
        active -= 1;
        notifyDrain();
      }
    });
  }

  async function saveStorageState(session: Session, path: string): Promise<void> {
    const context = contextOf.get(session);
    if (context === undefined) {
      throw new JevtestError(
        "saveStorageState 收到的 session 不是本池借出的（它没有对应的 BrowserContext）。" +
          "请在 withSession 的回调里调用它",
      );
    }
    const state = await context.storageState();
    await mkdir(dirname(path), { recursive: true });
    // 不用 `context.storageState({ path })`：它按进程 umask 建文件（通常 0644），
    // 而登录态里有会话 cookie——同一台机器上的其他用户不该读得到。
    // mode 只在**新建**时生效，所以文件已存在的情形另外 chmod 一次。
    // Windows 不认 POSIX 权限位（chmod 只影响只读属性），这里写的是 POSIX 上的正确行为。
    const serialized = JSON.stringify(state, null, 2);
    await writeFile(path, serialized, { encoding: "utf8", mode: 0o600 });
    await chmod(path, 0o600);
  }

  function activeContexts(): number {
    return active;
  }

  async function stop(): Promise<void> {
    if (stopped) return;
    stopped = true;

    const drained = await waitForDrain(STOP_DRAIN_TIMEOUT_MS);
    if (!drained) {
      console.warn(
        `[jevtest] 警告：停机等了 ${STOP_DRAIN_TIMEOUT_MS} ms，仍有 ${active} 个用例在途` +
          "（多半卡在一次引擎请求上）。现在关闭浏览器：这些用例的后续步骤会以" +
          " Target closed 失败，但已产生的轨迹仍会落盘。",
      );
    }

    const instance = browser;
    browser = null;
    launching = null;
    if (instance === null) return;
    try {
      // 超时路径上唯一的兜底清理：browser.close() 会把残留 context 一起关掉，
      // 所以「没排空」不等于「泄漏」。
      await instance.close();
    } catch (error) {
      // 停机路径上抛错没有意义：进程马上要退出，调用方也没有别的动作可做。
      // 但要留一条痕迹，不然「关不掉」这件事会完全消失。
      console.warn(`[jevtest] 警告：关闭 Chromium 失败（${describe(error)}）`);
    }
  }

  return { start, withSession, saveStorageState, activeContexts, stop };
}

/**
 * 建闸。许可数非法时**在构造那一刻就报错**：`Semaphore` 的构造器已经拒绝了
 * 非正整数（否则 `acquire()` 会永远挂起，表现为整个 worker 池静默卡死），
 * 这里只是把「哪个配置项错了、怎么改」补上去——`RangeError` 本身看不出它来自
 * `JEVTEST_WORKERS`。
 */
function makeContextGate(permits: number): Semaphore {
  try {
    return new Semaphore(permits);
  } catch (error) {
    throw new JevtestError(
      `maxContexts 非法（收到 ${String(permits)}）：它来自 Settings.workers` +
        "（环境变量 JEVTEST_WORKERS），必须是 >= 1 的整数",
      { cause: error },
    );
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
