/**
 * 运行器：任务队列 + worker 池 + 生命周期。
 *
 * 并发模型：**单进程、单事件循环、N 个 worker 协程**。
 *
 * 为什么不是线程或子进程：Playwright 在 Node 里是原生异步的，模型调用是 fetch，
 * 每个 await 都是挂起点，因此一个长任务不会阻塞 HTTP 服务。用 worker_threads
 * 反而会把这份异步优势抹掉，还让进度转发要过 postMessage；用独立进程只买到
 * 崩溃隔离，而崩溃隔离靠 try/catch 加池重启已能覆盖大半。
 *
 * 为什么每个用例一个 context：隔离。这是换到 Playwright 换来的最大收益——
 * 参考项目所有标签页共享同一个用户 Chrome profile，用例之间会通过 cookie 与
 * localStorage 互相污染，且无法并行。`newContext()` 把两个问题一起解决了。
 *
 * 为什么删掉了参考项目那把全局 LOCK（`demo.py:111-112`）：它存在只是因为当时
 * 只有一个共享的后台标签页。隔离是天然的之后，锁反而会杀掉批量并发。
 *
 * 取消语义：**取消只在步边界生效**，不中断一次已经开始的浏览器变更。
 * 这与「浏览器变更从不重试」是同一条原则的两面——都不能留下「做了一半」的状态。
 *
 * ## 停机信号：两级 AbortController 的合成
 *
 * 「等在途用例走到步边界」这句话此前没有通路——`cancel(runId)` 是 per-run 的，
 * 而 `stop()` 需要影响**所有**在途运行。解法是两层信号相加：
 *
 * ```text
 *   shutdownController  —— 一个，RunnerService 持有，stop() 时 abort
 *   runControllers      —— 每个 run 一个，cancel(runId) 时 abort
 *
 *   传给 CaseAgent.run() 的信号 = AbortSignal.any([runSignal, shutdownSignal])
 * ```
 *
 * `AbortSignal.any` 是 Node 内置的，语义正是我们要的：任一来源 abort 即 abort，
 * 且**不区分是谁触发的**——`CaseAgent` 只需在步边界检查一次，
 * 不必知道自己是「被用户取消」还是「进程要关了」。
 *
 * 两种情形的终态由 runner 区分（`cancelled` vs 停机），而不是由 agent 区分：
 * agent 的职责只是「干净地停在步边界」。
 */

import type { Case } from "../schema/case.ts";
import type { EventSink, RunStatus } from "../schema/events.ts";
import type { CaseRunReport } from "../schema/report.ts";
import type { DecisionEngine } from "../engine/types.ts";
import type { BrowserPool } from "../browser/pool.ts";
import type { Settings } from "../config.ts";

export interface RunOptions {
  /** 是否保存截图帧。默认关闭——开启会让运行目录膨胀而且拖慢每一步 */
  recordFrames?: boolean;
  /** 覆盖用例声明的引擎，用于同一用例的 A/B 对比 */
  engineOverride?: string;
  /** 属于哪次批量运行 */
  suiteRunId?: string;
}

export interface QueueStatus {
  queued: number;
  active: number;
  workers: number;
  /** 存活的浏览器 context 数。**运行结束后应回到 0**，否则说明泄漏了 */
  contextsActive: number;
}

export interface RunnerService {
  /** 入队一个用例，立即返回 runId。前端据此订阅进度 */
  enqueue(caseDef: Case, options?: RunOptions): { runId: string };

  /** 批量入队。同一个 suiteRunId 下并发受 workers 限制 */
  enqueueMany(cases: Case[], options?: RunOptions): { suiteRunId: string; runIds: string[] };

  /** 请求取消**单个**运行。在下一个步边界生效，不中断进行中的浏览器动作 */
  cancel(runId: string): boolean;

  /** 请求取消**全部**在途运行与队列中等待的运行。这是 `stop()` 的第一步 */
  cancelAll(): void;

  status(): QueueStatus;

  /** 启动 N 个 worker 循环 */
  start(): void;

  /**
   * 优雅停机，分三步：
   *
   * 1. `cancelAll()` —— abort 全局信号，所有在途用例在**下一个步边界**退出。
   *    正在进行的那一次浏览器变更会做完，不会留下「点了一半」的状态。
   * 2. 等待在途用例写完各自的报告（这是等它们停稳，不是等它们跑完）。
   * 3. `pool.stop()` —— 关闭 Chromium。
   *
   * **必须带超时**：在途用例可能正卡在一次 30 秒的模型请求上，
   * 无限等待会让进程关不掉。超时后强制关闭 context，并给未完成的那条
   * 写一份 `status: "cancelled"` 的报告——**保留已有轨迹**，
   * 而不是当作什么都没发生。
   */
  stop(options?: { timeoutMs?: number }): Promise<void>;
}

/**
 * 合成运行信号：任一来源 abort 即 abort。
 *
 * 单独抽出来是为了让它**可被单元测试**——「两级信号都能中断、且互不干扰」
 * 这条性质很容易被后续重构破坏（例如有人图省事只传 runSignal），
 * 而破坏了不会有任何报错，只会让停机悄悄失效。
 */
export function composeRunSignal(runSignal: AbortSignal, shutdownSignal: AbortSignal): AbortSignal {
  return AbortSignal.any([runSignal, shutdownSignal]);
}

export interface RunnerDeps {
  pool: BrowserPool;
  settings: Settings;
  /** 由 registry.createEngine 按用例构造引擎。每个用例一个实例，跑完 close */
  createEngine: (caseDef: Case) => DecisionEngine;
  /** 报告落盘 */
  persist: (report: CaseRunReport) => Promise<void>;
  events: EventSink;
}

export function createRunnerService(deps: RunnerDeps): RunnerService {
  throw new Error("未实现：P0 待实现");
}

/** worker 循环体：取任务 -> 借 context -> 跑 -> 落盘 -> 发事件。 */
async function workerLoop(): Promise<void> {
  throw new Error("未实现：P0 待实现");
}

/**
 * 从异常构造一份「失败的」报告。
 *
 * 关键点：**已产生的轨迹要尽量保留**。一次因引擎超时而中断的运行，
 * 前半段的轨迹仍然能说明很多问题；把它整个丢掉是最偷懒也最没用的做法。
 */
export function failureReport(runId: string, caseDef: Case, error: unknown, partial: CaseRunReport | null): CaseRunReport {
  throw new Error("未实现：P0 待实现");
}

/** 状态名 -> 中文说明。报告与界面共用。 */
export const STATUS_LABELS: Record<RunStatus, string> = {
  queued: "已入队",
  running: "运行中",
  done: "模型认为已完成",
  blocked: "模型认为无法继续，或连续多步无进展",
  budget_exceeded: "超出用例预算，已中止",
  guardrail_blocked: "被安全护栏拦截",
  cancelled: "已取消",
  error: "运行故障",
};

// TODO(P0): 实现 createRunnerService。worker 循环骨架：
//   shift() -> 已取消? -> pool.withSession() -> new CaseAgent().run(composeRunSignal(...))
//   -> checks.evaluateAssertions -> persist -> emit(run.finished)
//
// TODO(P0): status().contextsActive 要真实反映池内计数——
//   它是判断 context 泄漏的唯一手段，验收时会盯着它归零。
//
// TODO(P0): 信号的所有权必须清晰：
//   - `shutdownController` 由 RunnerService 持有，进程内只有一个
//   - `runControllers: Map<runId, AbortController>` 每 run 一个，
//     在 run 结束（无论什么终态）时**必须从 Map 里删除**，
//     否则长跑进程会积累废弃的 controller——这是另一种形式的泄漏
//   - 传给 agent 的信号一律走 `composeRunSignal()`，不要只传 runSignal
//
// TODO(P0): `stop()` 的超时分支要写一份 `status: "cancelled"` 的报告，
//   而不是直接丢弃。理由与预算耗尽一致：已产生的轨迹仍有解释价值。
