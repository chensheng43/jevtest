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
 *
 * ---------------------------------------------------------------------------
 * 实现注记：几处由本文件拍板的判断
 * ---------------------------------------------------------------------------
 *
 * - **`runId` 这条管道字段由 runner 补，不为它改 `AgentDeps`。** `AgentDeps` 里没有
 *   runId，而每个 `RunEvent` 都要求它，因此这里给 agent 传一个**盖章 sink**
 *   （`stampedSink`）：agent 发什么，出去之前一律把 `runId` 覆盖成本次运行的真实值。
 *   agent 内部用占位 `""`，不编造一个看起来像真的 id。
 *
 * - **报告的身份三件套分工**：agent 只填它能填的（`engine` / `startedAt` / `steps` …），
 *   `runId` / `suiteRunId` / `artifacts` 由 runner 在 `completeReport()` 里补，
 *   `caseRevision` / `caseDigest` 由 `deps.persist` 用 `store.freeze()` 的返回值定稿
 *   （只有 persist 同时看得见用例仓库与报告目录）。
 *
 * - **异常终态的报告不走 `buildReport`。** `report.ts` 的 `buildReport` 是给正常路径
 *   用的组装器（agent 在 `finish()` 里调它）；而 error / cancelled 这两条路径发生在
 *   引擎或浏览器已经不可信之后，此时再去依赖另一个模块的组装逻辑，正是最不该多一个
 *   失败面的时候。`failureReport()` 是自包含的纯函数，自己拼骨架。
 *
 * - **`stop()` 超时后仍然写报告。** 与预算耗尽同一个理由：已产生的轨迹仍有解释价值。
 *   写完之后把该 run 从 `activeRuns` 摘掉并标记 `reported`，于是稍后那个仍在跑的
 *   agent 收尾时不会再落一次盘（`finishRun` 会直接返回）。
 *
 * - **cancel 的分类依据是「我们的信号有没有 abort」，不是异常类型。**
 *   真实引擎可能因为自己的请求超时抛出同名 `AbortError`，把那种情况也记成
 *   `cancelled` 会掩盖一次基建故障。因此只有 `runController` 或 `shutdownController`
 *   真的 abort 过，才判 `cancelled`。
 */

import type { Case } from "../schema/case.ts";
import type { EventSink, RunEvent, RunStatus } from "../schema/events.ts";
import type { CaseRunReport, StepRecord } from "../schema/report.ts";
import type { DecisionEngine } from "../engine/types.ts";
import type { BrowserPool } from "../browser/pool.ts";
import type { Settings } from "../config.ts";
import type { BudgetMeter } from "./budget.ts";

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AsyncQueue } from "../util/async.ts";
import { authStatePath } from "../store/auth-states.ts";
import { budgetOf, createBudgetMeter } from "./budget.ts";
import { CaseAgent } from "./agent.ts";

export interface RunOptions {
  /** 是否保存截图帧。不给则取 `settings.recordFrames`（默认开启） */
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
  persist: (report: CaseRunReport, ran: Case) => Promise<void>;
  events: EventSink;
}

/**
 * 冻结用例快照在运行目录里的相对路径。
 *
 * 值必须与 `store/cases.ts` 导出的 `FROZEN_CASE_FILE` 一致，但**不 import 它**：
 * `core/` 不认识 `store/`（见架构 §1 的依赖方向），runner 只承诺这个相对路径约定，
 * 真正把文件写进去的是 `deps.persist`（cli 侧，它同时看得见 store 与报告目录）。
 */
export const FROZEN_CASE_ARTIFACT = "case.yaml";

/** trace 在运行目录里的相对路径。由池按 `tracePath` 写入 */
export const TRACE_ARTIFACT = "trace.zip";

/** 截图帧在运行目录里的子目录，帧文件名为 `<序号>.jpg`。与 `core/report.ts` 的 `FRAMES_DIR` 一致 */
export const FRAMES_ARTIFACT = "frames";

/**
 * `stop()` 的默认超时。
 *
 * 取 30 秒：在途用例可能正卡在一次 30 秒的模型请求上（见接口说明），
 * 再长就是在等一个已经没救的运行，再短则会在正常收尾（落盘 + 关浏览器）时误判。
 */
export const DEFAULT_STOP_TIMEOUT_MS = 30_000;

/** `RunStatus` 里与「停机/取消」相关的中文说明见 `STATUS_LABELS`。 */

/** 一个已入队、可能已在跑的运行。入队时就建好，因为信号必须**从入队那一刻就可用**。 */
interface ActiveRun {
  runId: string;
  caseDef: Case;
  options: RunOptions;
  enqueuedAt: string;
  /** worker 真正开始跑它的时刻；还在排队时为 null */
  startedAt: string | null;
  /** per-run 信号。入队即创建：排队期间就被取消是正常路径 */
  controller: AbortController;
  /**
   * 预算计量器。**RunStats 的唯一持有者**，runner 只把它交给 agent 再收回来。
   * 在 worker 开跑时才重建：墙钟预算从入队算起的话，排队时间会被记到用例头上，
   * 批量跑时排在后面的用例一打开页面就判 budget_exceeded。
   */
  budget: BudgetMeter;
  /** 借出 session 之后才有；失败路径靠它取回已完成的那段轨迹 */
  agent: CaseAgent | null;
  engine: DecisionEngine | null;
  /** 已经写过报告。**超时分支写完之后置位，防止 agent 收尾时重复落盘** */
  reported: boolean;
  /** 已经从 activeRuns / runControllers 摘除。幂等清理的开关 */
  released: boolean;
}

export function createRunnerService(deps: RunnerDeps): RunnerService {
  const queue = new AsyncQueue<ActiveRun>();
  /**
   * 每 run 一个 controller。
   *
   * **无论什么终态都要删除**（见 `releaseRun`）：长跑进程里积累废弃的 controller
   * 是另一种形式的泄漏——它不只是内存，还有挂在 signal 上的监听器。
   */
  const runControllers = new Map<string, AbortController>();
  /** 正在被 worker 处理的运行。`status().active` 就是它的规模 */
  const activeRuns = new Map<string, ActiveRun>();
  const shutdownController = new AbortController();
  const workers: Promise<void>[] = [];
  /** 等待「在途用例全部收尾」的挂起者。用事件而不是轮询：收尾往往就在下一个微任务 */
  const idleWaiters: Array<() => void> = [];
  let started = false;
  let stopping = false;
  let stopTask: Promise<void> | null = null;

  // -------------------------------------------------------------------------
  // 记账
  // -------------------------------------------------------------------------

  function notifyIdle(): void {
    if (activeRuns.size > 0) return;
    const waiters = idleWaiters.splice(0);
    for (const resolve of waiters) resolve();
  }

  function waitIdle(): Promise<void> {
    if (activeRuns.size === 0) return Promise.resolve();
    return new Promise<void>((resolve) => {
      idleWaiters.push(resolve);
    });
  }

  /**
   * 等在途用例收尾，超时返回 false。
   *
   * 用「事件 + 超时赛跑」而不是轮询：收尾通常就在下一个微任务里完成，
   * 轮询会让每一次正常停机都白等一个间隔；而超时那段本来就是要等的那段。
   */
  async function waitIdleWithTimeout(timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | null = null;
    const timedOut = new Promise<false>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    });
    const settled = await Promise.race([waitIdle().then(() => true as const), timedOut]);
    if (timer !== null) clearTimeout(timer);
    return settled;
  }

  function releaseRun(active: ActiveRun): void {
    if (active.released) return;
    active.released = true;
    if (activeRuns.get(active.runId) === active) activeRuns.delete(active.runId);
    // 只有当映射里还是本次运行的 controller 时才删——runId 唯一，这层判断是保险
    if (runControllers.get(active.runId) === active.controller) runControllers.delete(active.runId);
    notifyIdle();
  }

  const runDirOf = (runId: string): string => join(deps.settings.runsDir, runId);

  /**
   * 落盘 + 发 `run.finished`。
   *
   * 顺序不能反：先让报告可读，再宣告结束——监听 `run.finished` 就去拉报告的
   * 前端不会扑空。落盘失败也照发事件（否则界面上的运行会永远停在「运行中」），
   * 同时补一条 `run.log` 的 error，因为「报告读不到」是必须显式暴露的故障。
   */
  async function finishRun(active: ActiveRun, report: CaseRunReport): Promise<void> {
    // 超时分支已经替它写过一份（并保留了当时的轨迹），这里不再覆盖
    if (active.reported) return;
    active.reported = true;

    try {
      // 交出去的是**入队时的那份** caseDef：快照要冻结实际跑的版本，不是仓库此刻的版本
      await deps.persist(report, active.caseDef);
    } catch (error) {
      deps.events.emit({
        type: "run.log",
        runId: report.runId,
        level: "error",
        message: `报告落盘失败：${messageOf(error)}（运行本身已结束，事件照发）`,
      });
    }

    deps.events.emit({
      type: "run.finished",
      runId: report.runId,
      status: report.status,
      passed: report.passed,
      elapsedMs: report.elapsedMs,
      stats: report.stats,
    });
  }

  /** agent 已经走到的轨迹。异常路径靠它做「尽量保留 partial」。 */
  function partialOf(active: ActiveRun): { history: StepRecord[]; guardrailHits: GuardrailHit[] } {
    const snapshot = active.agent?.snapshot();
    return {
      // 还没借出 session（或 agent 构造失败）时没有轨迹可言，此时是空表而不是 null：
      // 「走过 0 步」与「不知道走了几步」是两件事，前者才是事实。
      history: snapshot?.history ?? [],
      guardrailHits: snapshot?.guardrailHits ?? [],
    };
  }

  /** 用当前轨迹拼一份终止态报告（cancelled / error 的骨架）。 */
  function reportFromTrace(
    active: ActiveRun,
    status: RunStatus,
    failureReason: string | null,
    trace: { history: StepRecord[]; guardrailHits: GuardrailHit[] } | null,
    traceZip: string | null,
  ): CaseRunReport {
    const engine = active.engine?.name ?? "";
    return skeletonReport({
      runId: active.runId,
      caseDef: active.caseDef,
      engine,
      suiteRunId: active.options.suiteRunId ?? null,
      startedAt: active.startedAt ?? active.enqueuedAt,
      finishedAt: new Date().toISOString(),
      status,
      failureReason,
      steps: trace?.history ?? [],
      guardrailHits: trace?.guardrailHits ?? [],
      stats: active.budget.stats(),
      traceZip,
    });
  }

  /** 正常结束：把 agent 填不了的身份与产物路径补上（见文件头「实现注记」）。 */
  function completeReport(
    report: CaseRunReport,
    active: ActiveRun,
    traceZip: string | null,
  ): CaseRunReport {
    report.runId = active.runId;
    report.suiteRunId = active.options.suiteRunId ?? null;
    // `caseRevision` / `caseDigest` 刻意留成 agent 填的占位：只有 deps.persist
    // 同时看得见用例仓库与报告目录，它用 store.freeze() 的返回值定稿。
    report.artifacts = {
      ...report.artifacts,
      traceZip,
      // 不在这里写 "frames"：开了截图也可能一帧都没截成。是否真有帧由 persist 实地看目录决定
      // （`core/report.ts` 的 persistReport），而不是由开关推断。
      framesDir: null,
      frozenCase: FROZEN_CASE_ARTIFACT,
    };
    return report;
  }

  // -------------------------------------------------------------------------
  // 单个运行
  // -------------------------------------------------------------------------

  function activeRunOf(caseDef: Case, options: RunOptions, runId: string): ActiveRun {
    return {
      runId,
      caseDef,
      options,
      enqueuedAt: new Date().toISOString(),
      startedAt: null,
      controller: new AbortController(),
      budget: createBudgetMeter(budgetOf(caseDef)),
      agent: null,
      engine: null,
      reported: false,
      released: false,
    };
  }

  async function runOne(active: ActiveRun): Promise<void> {
    activeRuns.set(active.runId, active);
    // 计时从这里开始，不从入队开始（见 ActiveRun.budget）
    active.startedAt = new Date().toISOString();
    active.budget = createBudgetMeter(budgetOf(active.caseDef));
    const { caseDef } = active;
    // 用例声明的引擎可被 options 覆盖（同一用例的 A/B 对比）。
    // createEngine 只收 caseDef，所以覆盖通过复制一份 caseDef 完成。
    const effectiveCase =
      active.options.engineOverride === undefined || active.options.engineOverride === caseDef.engine
        ? caseDef
        : { ...caseDef, engine: active.options.engineOverride };
    const traceZip = deps.settings.tracing ? TRACE_ARTIFACT : null;
    const recordFrames = active.options.recordFrames ?? deps.settings.recordFrames;

    try {
      if (active.controller.signal.aborted) {
        // 排队期间就被取消（cancel(runId) / cancelAll()）：**不为它开浏览器**，
        // 但报告照写。静默丢弃会让 CLI 读不到任何东西——「有用例根本没跑」
        // 是测试平台最坏的失败模式，因为它看起来像什么都没发生。
        await finishRun(
          active,
          reportFromTrace(active, "cancelled", QUEUED_CANCEL_REASON, null, traceZip),
        );
        return;
      }

      active.engine = deps.createEngine(effectiveCase);
      const engine = active.engine;
      deps.events.emit({
        type: "run.started",
        runId: active.runId,
        caseId: caseDef.id,
        engine: engine.name,
      });

      if (traceZip !== null) {
        // trace 由池写在 runs/<runId>/ 下，而报告目录要到 persist 时才由 cli 创建。
        // 先建一层，否则 tracing.stop() 会因目录不存在而失败——丢掉的恰好是最该看的 trace。
        await mkdir(runDirOf(active.runId), { recursive: true });
      }

      const produced = await deps.pool.withSession(
        {
          ...(traceZip === null
            ? {}
            : { tracing: true, tracePath: join(runDirOf(active.runId), TRACE_ARTIFACT) }),
          // 登录态只读载入、不回写：同一份文件被多个用例共用，一次运行里的登出或会话轮换
          // 不该影响下一次运行。文件不存在时池会报一个能直接照做的错误。
          ...(caseDef.authState === undefined
            ? {}
            : { storageStatePath: authStatePath(deps.settings.authDir, caseDef.authState) }),
        },
        async (session) => {
          const agent = new CaseAgent({
            session,
            engine,
            budget: active.budget,
            // 盖章 sink：agent 不知道 runId（AgentDeps 里没有这条管道字段），
            // 出去之前一律覆盖成本次运行的真实值。
            events: stampedSink(deps.events, active.runId),
            caseDef: effectiveCase,
            suiteRunId: active.options.suiteRunId ?? null,
            ...(recordFrames ? { captureFrame: frameRecorder(session, runDirOf(active.runId)) } : {}),
          });
          active.agent = agent;
          // 两级信号都要传：只传 runSignal 会让停机悄悄失效（见 composeRunSignal 的说明）。
          // session 由 pool 关，agent 不关——它连 close 都不调。
          return await agent.run(composeRunSignal(active.controller.signal, shutdownController.signal));
        },
      );

      const report = completeReport(produced, active, traceZip);
      if (report.status === "cancelled") {
        // 「谁把这次运行叫停的」由 runner 区分，不由 agent 区分（§11.2 ②）：
        // agent 只知道信号 abort 了，它连自己是被用户取消还是进程要关了都无从得知。
        // 在步边界停下是**正常返回**（不是异常），所以原因在这一条路径上才要改写——
        // 否则报告里会出现「用户取消」，而实际是停机。
        report.failureReason = shutdownController.signal.aborted ? SHUTDOWN_REASON : CANCEL_REASON;
      }
      await finishRun(active, report);
    } catch (error) {
      // 终态由 runner 判定，不由 agent 判定：agent 只知道「信号 abort 了」，
      // 不知道那是用户取消还是进程要关。判据是**我们的信号有没有 abort 过**，
      // 而不是异常类型——真实引擎自己的请求超时也可能抛同名 AbortError。
      const cancelled = active.controller.signal.aborted || shutdownController.signal.aborted;
      const trace = partialOf(active);

      if (cancelled) {
        await finishRun(
          active,
          reportFromTrace(
            active,
            "cancelled",
            shutdownController.signal.aborted ? SHUTDOWN_REASON : CANCEL_REASON,
            trace,
            traceZip,
          ),
        );
      } else {
        // 轨迹经 snapshot() 保留下来：一次因引擎超时而中断的运行，前半段仍然能说明很多问题。
        const partial = reportFromTrace(active, "error", null, trace, traceZip);
        await finishRun(active, failureReport(active.runId, caseDef, error, partial));
      }
    } finally {
      if (active.engine !== null) {
        try {
          await active.engine.close();
        } catch (error) {
          deps.events.emit({
            type: "run.log",
            runId: active.runId,
            level: "warn",
            message: `关闭引擎失败：${messageOf(error)}`,
          });
        }
      }
      releaseRun(active);
    }
  }

  // -------------------------------------------------------------------------
  // worker 循环
  // -------------------------------------------------------------------------

  /** worker 循环体：取任务 -> 借 context -> 跑 -> 落盘 -> 发事件。 */
  async function workerLoop(): Promise<void> {
    for (;;) {
      let active: ActiveRun;
      try {
        active = await queue.shift();
      } catch {
        // 队列已关闭**且已排空**——停机路径，干净退出。
        // 注意 close() 的语义是「不再有新的进来」而不是「丢掉手上的」，
        // 因此停机时残留的任务会先被逐个取出、逐个写成 cancelled 报告，再走到这里。
        return;
      }

      try {
        await runOne(active);
      } catch (error) {
        // runOne 自己吞掉一切：能走到这里说明它自身写崩了（收尾逻辑的 bug）。
        // 仍然不能让这个 worker 死掉——一个用例的异常不该让并发度永久下降。
        deps.events.emit({
          type: "run.log",
          runId: active.runId,
          level: "error",
          message: `worker 处理 ${active.runId} 时内部错误：${messageOf(error)}`,
        });
        releaseRun(active);
      }
    }
  }

  // -------------------------------------------------------------------------
  // RunnerService
  // -------------------------------------------------------------------------

  /** 入队的唯一落点。`enqueue` 与 `enqueueMany` 都走它，避免两处各写一遍信号登记。 */
  function enqueueOne(caseDef: Case, options: RunOptions): { runId: string } {
    if (stopping) {
      // 静默接受会让这个用例既不执行也不出现在任何报告里
      throw new Error("运行器已停机，不能再入队（stop() 之后不再接收新的运行）");
    }
    const runId = makeRunId(caseDef);
    const active = activeRunOf(caseDef, options, runId);
    // 先登记 controller 再入队：排队期间 cancel(runId) 必须能生效
    runControllers.set(runId, active.controller);
    queue.push(active);
    deps.events.emit({ type: "run.queued", runId, caseId: caseDef.id });
    return { runId };
  }

  return {
    enqueue(caseDef: Case, options: RunOptions = {}): { runId: string } {
      return enqueueOne(caseDef, options);
    },

    enqueueMany(cases: Case[], options: RunOptions = {}): { suiteRunId: string; runIds: string[] } {
      // suiteRunId 由批量入队分配一次，同一个套件下的用例共用它（报告的 suiteRunId 字段）
      const suiteRunId = options.suiteRunId ?? makeSuiteRunId();
      const runIds = cases.map((caseDef) => enqueueOne(caseDef, { ...options, suiteRunId }).runId);
      return { suiteRunId, runIds };
    },

    cancel(runId: string): boolean {
      const controller = runControllers.get(runId);
      // 找不到 = 已经结束（或压根不存在）。已 abort 过的不再重复算「成功请求」。
      if (controller === undefined || controller.signal.aborted) return false;
      controller.abort();
      return true;
    },

    cancelAll(): void {
      // 全局信号：停机。它与 per-run 信号是「或」的关系，因此新入队的用例
      // 也会在第一个步边界就停下（不会出现停机之后还在开新浏览器的情况）。
      shutdownController.abort();
      for (const controller of runControllers.values()) controller.abort();
    },

    status(): QueueStatus {
      return {
        queued: queue.size,
        active: activeRuns.size,
        workers: deps.settings.workers,
        // 转发池的计数，**不在这里自己记一份**：两个事实来源迟早分叉，
        // 而分叉的表现就是「明明泄漏了却看着是 0」（见架构 §9.3）。
        contextsActive: deps.pool.activeContexts(),
      };
    },

    start(): void {
      if (started) return;
      if (deps.settings.workers < 1) {
        // 0 个 worker 会让每个入队的用例永远排在那里、任何报错都没有。
        // 宁可启动那一刻就炸掉。
        throw new Error(`workers 必须 >= 1，收到 ${String(deps.settings.workers)}：0 个 worker 会让队列永久挂住`);
      }
      started = true;
      for (let index = 0; index < deps.settings.workers; index += 1) {
        const worker = workerLoop();
        workers.push(worker);
        // 立刻挂一个 catch：workerLoop 抛出的未处理 rejection 会掀掉整个进程，
        // 而它的职责恰恰是「永远活着」。
        void worker.catch((error: unknown) => {
          deps.events.emit({
            type: "run.log",
            runId: "runner",
            level: "error",
            message: `worker 循环意外退出：${messageOf(error)}`,
          });
        });
      }
    },

    async stop(options?: { timeoutMs?: number }): Promise<void> {
      // 幂等：cli 的 serve 路径会 stop 两次（server.close() 里一次、兜底一次）
      if (stopTask !== null) return stopTask;
      stopTask = (async (): Promise<void> => {
        stopping = true;

        // ---- 第 1 步：让所有在途与排队中的运行在步边界停下 ----------------------
        // 先关队列再等：close() 之后不再收新任务，但已入队的仍会被取出——
        // 正是靠这个「排空」语义，停机时残留的任务才会被逐个写成 cancelled 报告，
        // worker 也才有机会在排空之后干净退出（shift() reject）。
        this.cancelAll();
        queue.close();

        // ---- 第 2 步：等在途用例写完报告（等停稳，不是等跑完） ------------------
        const timeoutMs = options?.timeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
        const idle = await waitIdleWithTimeout(timeoutMs);

        if (!idle) {
          // 超时：卡住的用例不会再自己收尾了（可能正卡在一次不返回的模型请求上）。
          // 给它写一份 cancelled 报告——**保留已有轨迹**，而不是当作什么都没发生。
          // 这正是与预算耗尽一致的纪律：跑到一半的运行，前半段仍然有解释价值。
          for (const active of [...activeRuns.values()]) {
            const trace = partialOf(active);
            await finishRun(
              active,
              reportFromTrace(
                active,
                "cancelled",
                STOP_TIMEOUT_REASON.replace("{timeout}", String(timeoutMs)),
                trace,
                deps.settings.tracing ? TRACE_ARTIFACT : null,
              ),
            );
            // 报告已写完 = 已经收尾。摘掉它，否则 status().active 会永远停在非零，
            // 而那个数字是判断「还有没有活着的运行」的唯一依据。
            releaseRun(active);
          }
        }

        // ---- 第 3 步：关浏览器 ----------------------------------------------
        await deps.pool.stop();

        if (idle) {
          // 队列已关闭且排空，worker 会自己退出。只有正常收尾时才等它们：
          // 超时路径下 worker 可能正卡在 runOne 的某个 await 上，等它就是白等。
          await Promise.allSettled(workers);
        }
      })();
      return stopTask;
    },
  };
}

// ---------------------------------------------------------------------------
// 由异常构造报告
// ---------------------------------------------------------------------------

/**
 * 从异常构造一份「失败的」报告。
 *
 * 关键点：**已产生的轨迹要尽量保留**。一次因引擎超时而中断的运行，
 * 前半段的轨迹仍然能说明很多问题；把它整个丢掉是最偷懒也最没用的做法。
 *
 * `partial` 是 runner 用 `agent.snapshot()` 拼出来的半成品报告（没有就传 null）。
 * 这里不复用 `report.ts` 的 `buildReport`：它服务的是正常路径，而 error 路径
 * 恰恰发生在引擎或浏览器已经不可信之后——那时候多一个依赖就多一个失败面。
 */
export function failureReport(runId: string, caseDef: Case, error: unknown, partial: CaseRunReport | null): CaseRunReport {
  const reason = `运行故障：${describeError(error)}`;

  if (partial !== null) {
    return {
      ...partial,
      // agent 不知道 runId（占位 ""），这里补上；正常路径由 runner 在
      // completeReport() 里补的是同一个值。
      runId: partial.runId === "" ? runId : partial.runId,
      status: "error",
      // 原先的中止原因（如果有）不丢：它解释了「为什么只跑到这里」
      failureReason: partial.failureReason === null ? reason : `${reason}（此前的中止原因：${partial.failureReason}）`,
      finishedAt: new Date().toISOString(),
      // elapsedMs 与 stats.elapsedMs 是同一次快照的两个面，一起保留
      elapsedMs: partial.stats.elapsedMs,
    };
  }

  const now = new Date().toISOString();
  return skeletonReport({
    runId,
    caseDef,
    engine: "",
    suiteRunId: null,
    startedAt: now,
    finishedAt: now,
    status: "error",
    failureReason: reason,
    steps: [],
    guardrailHits: [],
    stats: ZERO_STATS,
    traceZip: null,
  });
}

/**
 * 截图落盘器：每调一次截当前页面一帧，写成 `<runDir>/frames/<n>.jpg`，返回 n。
 *
 * 序号从 0 单调递增、与步号无关（一步可能因陈旧决策被重新观测、截多帧）；
 * 报告里 `StepRecord.frame` 与 `finalFrame` 记的就是这个序号。
 * 序号在写盘之前就占用：写失败时这个号作废，不会让两帧争同一个文件名。
 */
function frameRecorder(session: { frameJpeg(): Promise<Buffer> }, runDir: string): () => Promise<number> {
  const dir = join(runDir, FRAMES_ARTIFACT);
  let next = 0;
  let dirReady = false;
  return async () => {
    const jpeg = await session.frameJpeg();
    const frame = next;
    next += 1;
    if (!dirReady) {
      await mkdir(dir, { recursive: true });
      dirReady = true;
    }
    await writeFile(join(dir, `${frame}.jpg`), jpeg);
    return frame;
  };
}

/** 轨迹里的一次护栏命中（与 `CaseRunReport.guardrailHits` 同一形状）。 */
interface GuardrailHit {
  step: number;
  reason: string;
  action: string;
}

/**
 * 报告骨架：给 runner 生成的终止态报告（cancelled / error）用。
 *
 * 刻意自包含（不依赖 `buildReport`）的理由见 `failureReport` 的说明。
 * 身份字段里 `caseRevision` 为 0、`caseDigest` 为空串是**占位**，不是编造：
 * 真正的值由 `deps.persist` 用 `store.freeze()` 定稿（与正常路径一致）。
 */
function skeletonReport(input: {
  runId: string;
  caseDef: Case;
  engine: string;
  suiteRunId: string | null;
  startedAt: string;
  finishedAt: string;
  status: RunStatus;
  failureReason: string | null;
  steps: StepRecord[];
  guardrailHits: GuardrailHit[];
  stats: CaseRunReport["stats"];
  traceZip: string | null;
}): CaseRunReport {
  return {
    schemaVersion: 1,
    runId: input.runId,
    caseId: input.caseDef.id,
    caseRevision: 0,
    caseDigest: "",
    suiteRunId: input.suiteRunId,
    engine: input.engine,
    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    elapsedMs: elapsedBetween(input.startedAt, input.finishedAt),
    status: input.status,
    // 运行故障下断言层根本没跑（`assertion: null`），因此判决是「未判定」——
    // 这不是「失败」。见 checks.ts 末尾关于 error → passed: null 的说明。
    passed: null,
    failureReason: input.failureReason,
    goal: input.caseDef.goal,
    startUrl: input.caseDef.startUrl,
    finalUrl: null,
    finalFrame: null,
    steps: input.steps,
    guardrailHits: input.guardrailHits,
    assertion: null,
    stats: input.stats,
    // 准入结论在第一次 observe() 之后才采集；异常终止的运行可能还没有它
    admission: null,
    artifacts: {
      traceZip: input.traceZip,
      framesDir: null,
      frozenCase: FROZEN_CASE_ARTIFACT,
    },
  };
}

const ZERO_STATS: CaseRunReport["stats"] = {
  steps: 0,
  modelCalls: 0,
  decisions: 0,
  inputTokens: 0,
  outputTokens: 0,
  costUsd: null,
  elapsedMs: 0,
  engineLatencyMs: 0,
};

// ---------------------------------------------------------------------------
// 事件与身份
// ---------------------------------------------------------------------------

/**
 * 盖章 sink：把 agent 发出的每一条事件盖上本次运行的真实 `runId`。
 *
 * `AgentDeps` 里没有 runId（也不打算为它加——那是管道字段，不是 agent 的输入），
 * 而 `RunEvent` 的每个分支都要求它。于是改在**出口**补：agent 用占位 `""`，
 * 出去之前一律被这里覆盖。这样既不动冻结的接口，也不会出现「事件里的 runId
 * 和报告对不上」这种最难查的错位。
 */
function stampedSink(sink: EventSink, runId: string): EventSink {
  return {
    emit(event: RunEvent): void {
      // 运行时是「同一对象 + 覆盖 runId」，类型上则需要这一步断言：
      // RunEvent 是判别联合，展开后的对象类型无法自动收敛回某个分支。
      sink.emit({ ...event, runId } as RunEvent);
    },
  };
}

/** 运行 id 的允许字符（与 `web/api.ts` 的 `RUN_ID_PATTERN` 一致——它会进 URL 与磁盘路径）。 */
const RUN_ID_SAFE = /[^a-zA-Z0-9_-]/g;

/** runId 里带一段用例 id 是为了让人扫一眼 runs/ 就知道哪个目录是哪个用例。 */
const RUN_ID_CASE_PART_MAX = 24;

/**
 * 生成运行 id：`<时间戳>-<用例 id>-<随机后缀>`。
 *
 * - 时间戳在前，`runs/` 目录与 `index.jsonl` 天然近似按时间排序，人肉排查友好；
 * - 随机后缀不可省：同一用例在同一毫秒内被连续触发两次（前端双击、脚本循环）
 *   会撞出同一个 runId，而两个运行写同一个目录 = 报告互相覆盖；
 * - 用例 id 截断而不是省略随机后缀：截断只影响可读性，丢后缀会引入碰撞。
 */
function makeRunId(caseDef: Case): string {
  const stamp = compactStamp(new Date());
  const casePart = caseDef.id.replace(RUN_ID_SAFE, "-").slice(0, RUN_ID_CASE_PART_MAX);
  const head = casePart === "" ? stamp : `${stamp}-${casePart}`;
  return `${head}-${randomSuffix()}`;
}

/** 批量运行 id。加 `suite-` 前缀是为了在目录列表里一眼区分单跑与批量。 */
function makeSuiteRunId(): string {
  return `suite-${compactStamp(new Date())}-${randomSuffix()}`;
}

/** `2026-09-21T23:30:45.123Z` -> `20260921-233045`。只保留到秒：可读性比精度重要，唯一性靠随机后缀。 */
function compactStamp(at: Date): string {
  return at.toISOString().replace(/\.\d+Z$/, "").replace(/[-:]/g, "").replace("T", "-");
}

function randomSuffix(): string {
  // 6 个十六进制字符（24 bit）：同秒内碰撞的概率低到不值得再引入计数器状态
  return randomBytes(3).toString("hex");
}

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

/** 把 ISO 时刻算成毫秒差。两个时刻都来自我们自己，解析失败时退到 0 而不是 NaN。 */
function elapsedBetween(startedAt: string, finishedAt: string): number {
  const started = Date.parse(startedAt);
  const finished = Date.parse(finishedAt);
  if (!Number.isFinite(started) || !Number.isFinite(finished)) return 0;
  return Math.max(0, finished - started);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 给人看的故障描述。带上 name 是为了让 `InvalidDecision` / `StalePage` 这类区分露出来。 */
function describeError(error: unknown): string {
  if (error instanceof Error) {
    return error.name === "Error" || error.name === "" ? error.message : `${error.name}：${error.message}`;
  }
  return String(error);
}

const QUEUED_CANCEL_REASON =
  "入队后、启动前被取消：没有为它打开浏览器，因此这次运行没有产生任何轨迹";

const CANCEL_REASON =
  "用户取消：在步边界停止（已经开始的浏览器变更会做完，不会留下做了一半的状态）";

const SHUTDOWN_REASON =
  "进程停机：在步边界停止（已经开始的浏览器变更会做完）；已产生的轨迹完整保留";

const STOP_TIMEOUT_REASON =
  "停机超时（{timeout}ms）：运行未在超时内走到收尾，已强制中止并保留当时的轨迹";

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
