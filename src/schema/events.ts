/**
 * 共享词汇表 + 运行事件。
 *
 * 这个文件是整个项目的最底层：`ActionKind` / `Operation` / `RunStatus` 三个枚举
 * 被 schema、engine、browser、core、web 各层共同引用，其余模块只从这里 import，
 * 不从彼此 import，因此不存在循环依赖。
 *
 * 事件采用判别联合（discriminated union）。它不是内部日志——它就是 Web 界面的数据源：
 * runner 每走一步 emit 一个事件，前端轮询 /api/runs/:id 拿到事件序列后按 `seq` 增量渲染。
 * 前端的 switch 分支与本文件的 case 一一对应。
 */

// ---------------------------------------------------------------------------
// 词汇表
// ---------------------------------------------------------------------------

/**
 * 可执行动作的种类。
 *
 * `scroll` 与 `wait` 没有目标元素；`select` 的目标带一个 code-owned 的选项索引
 * （形如 `"3:1"` = 第 3 个元素的第 1 个选项），模型只能从这个索引里挑，看不到 option 的值。
 */
export type ActionKind = "click" | "fill" | "select" | "scroll" | "wait";

/**
 * 决策引擎可以选择的操作。
 *
 * `CLICK` / `TYPE_TEXT` / `SELECT` 需要再选一个目标；`SCROLL_UP` / `SCROLL_DOWN` / `WAIT`
 * 是页面级操作；`DONE` / `BLOCKED` 终止本次运行。
 *
 * 只读模式下 `TYPE_TEXT` 与 `SELECT` 不会被构造进候选集，因此模型物理上无法选中它们。
 */
export type Operation =
  | "CLICK"
  | "TYPE_TEXT"
  | "SELECT"
  | "SCROLL_UP"
  | "SCROLL_DOWN"
  | "WAIT"
  | "DONE"
  | "BLOCKED";

/**
 * 运行如何结束。**描述的是循环的退出方式，不是断言判决。**
 *
 * 与 `passed` 彻底分离：`status: "done"` 且 `passed: false` 是完全正常的组合——
 * 模型认为任务完成了，但独立断言发现它没完成。这是本项目最重要的一条设计约束。
 */
export type RunStatus =
  /** 已入队，尚未开始 */
  | "queued"
  /** 正在执行 */
  | "running"
  /** 模型选择了 DONE，且页面在决策后未变化 */
  | "done"
  /** 模型选择了 BLOCKED，或连续多步页面无变化 */
  | "blocked"
  /** 撞到用例预算上限（步数 / 模型调用 / token / 金额 / 墙钟时间） */
  | "budget_exceeded"
  /** 被安全护栏拦截：域名越界，或动作命中禁止清单 */
  | "guardrail_blocked"
  /** 用户取消 */
  | "cancelled"
  /** 意料之外的异常（网络、浏览器崩溃、schema 不符等） */
  | "error";

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

/** 事件类型名。前端监听同名事件。 */
export type RunEventType =
  | "run.queued"
  | "run.started"
  | "step.observed"
  | "step.decided"
  | "step.executed"
  | "step.skipped"
  | "guardrail.blocked"
  | "assertion.evaluated"
  | "run.finished"
  | "run.log";

/**
 * 运行过程中产生的单条事件（尚未编号）。
 *
 * 约定：**事件里绝不携带截图 base64**。需要画面时只带 `frame` 序号，
 * 前端另外请求 `GET /api/runs/:id/frames/:n.jpg`。这条约定把单条事件从
 * 约 200KB 压到约 400B——参考项目导出 trace 时显式剔除 screenshot 是同一个直觉。
 */
export type RunEvent =
  | { type: "run.queued"; runId: string; caseId: string }
  | { type: "run.started"; runId: string; caseId: string; engine: string }
  | {
      type: "step.observed";
      runId: string;
      step: number;
      url: string;
      elementCount: number;
      omittedActions: number;
      frame: number | null;
      elapsedMs: number;
    }
  | {
      type: "step.decided";
      runId: string;
      step: number;
      operation: Operation;
      operationProbabilities: Record<string, number>;
      target: string | null;
      targetProbabilities: Record<string, number>;
      confidence: number;
      /** `degenerate` 表示该引擎给出的不是真分布（见 assert 层：此时概率类检查标为 skipped） */
      distribution: "full" | "degenerate";
      engineLatencyMs: number;
      modelCallsUsed: number;
    }
  | {
      type: "step.executed";
      runId: string;
      step: number;
      action: string;
      kind: ActionKind;
      operation: Operation;
      probability: number;
      /** false = 在执行前被护栏拦下，浏览器未收到任何输入 */
      executed: boolean;
      text: string | null;
      url: string;
      pageChanged: boolean | null;
      elapsedMs: number;
    }
  | { type: "step.skipped"; runId: string; step: number; reason: string }
  | { type: "guardrail.blocked"; runId: string; step: number; reason: string; action: string }
  | {
      type: "assertion.evaluated";
      runId: string;
      passed: boolean;
      total: number;
      failed: string[];
      skipped: string[];
    }
  | {
      type: "run.finished";
      runId: string;
      status: RunStatus;
      /** null = 未能求值（例如预算耗尽于第一步之前） */
      passed: boolean | null;
      elapsedMs: number;
      stats: RunStats;
    }
  | { type: "run.log"; runId: string; level: "info" | "warn" | "error"; message: string };

/** 已编号的事件：`seq` 单调递增，前端据此做增量拉取与断线重放。 */
export type SeqEvent = RunEvent & { seq: number; ts: string };

/**
 * 事件接收端。
 *
 * core 层只依赖这个接口，**不知道事件最终去了哪里**：
 * 生产环境是 Web 事件日志（`web/events.ts` 的 EventLog，带环形缓冲与订阅者），
 * 测试里是一个收集数组。因此 runner 的行为在两种场景下完全一致。
 */
export interface EventSink {
  emit(event: RunEvent): void;
}

/** 一次运行的成本与规模统计。 */
export interface RunStats {
  steps: number;

  /**
   * **实际发出的 HTTP 请求数，含重试。**
   *
   * 这是刻意的口径——`budget.maxModelCalls` 与 `quality.maxModelCalls` 都按它算。
   * 若改成数「逻辑决策」，重试就成了一条**免费通道**：一次决策最多重试
   * `MAX_ATTEMPTS`（3）次，最坏情况实际花费是预算的 3 倍，而刹车不会响。
   * 成本控制按请求数算才成立。
   */
  modelCalls: number;

  /**
   * 逻辑决策数（不含重试）。等于执行步数加上终止决策。
   *
   * **只用于展示，不参与预算与断言。** 「这个用例为什么跑了 24 次调用？」
   * 看一眼 `modelCalls - decisions` 就知道是重试造成的。
   * 「最多走几步」这件事由 `trajectory.maxSteps` 表达，不在这里重复。
   */
  decisions: number;

  inputTokens: number;
  outputTokens: number;
  /** 引擎未报金额时为 null，避免把「未知」伪装成 0 */
  costUsd: number | null;
  elapsedMs: number;
  /** 花在决策引擎网络往返上的总时间，与浏览器耗时区分开 */
  engineLatencyMs: number;
}

// TODO(P0): 实现 eventSchema（zod）以校验外部传入的 /api 请求体与磁盘回读的报告。
//           注意 zod v4 的 .default() 不解析默认值，此处如需默认值必须用 .prefault()。
