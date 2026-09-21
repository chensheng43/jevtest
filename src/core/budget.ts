/**
 * 用例级预算：成本控制的唯一落点。
 *
 * 为什么必须有：参考项目一次 Google Flights 任务消耗 17 次决策请求、
 * 90,558 input tokens（见其 docs/performance.md）。一个 30 个用例的套件
 * 如果不设上限，一次跑完就是百万级 token——而 agent 的失败模式往往是
 * **在一个它看不懂的页面上反复空转**，正是最烧钱的情形。
 *
 * 两条设计原则：
 *
 *   1. **多维硬刹车**：步数、模型调用数、input token、金额、墙钟时间，任一超限即终止。
 *      单看步数不够——一次决策可能重试三次，步数没涨成本涨了。
 *
 *   2. **超限不丢轨迹**。预算耗尽是**正常结束方式**之一（status 为 budget_exceeded），
 *      已产生的轨迹照样交给断言层求值。用户需要知道「跑到一半停了，
 *      但前半段是否满足断言」。这是参考项目「执行先记录再观测」在批量场景的延伸。
 */

import type { Budget, Case } from "../schema/case.ts";
import type { RunStats } from "../schema/events.ts";
import type { BudgetView } from "../engine/types.ts";
import type { Usage } from "../schema/report.ts";

/** 超限的维度。报告里要显示出来，用户才知道该调大哪个。 */
export type BudgetDimension = "steps" | "modelCalls" | "inputTokens" | "costUsd" | "elapsedMs";

export interface BudgetStatus {
  exceeded: boolean;
  dimension: BudgetDimension | null;
  /** 给人看的说明，含实际值与上限 */
  detail: string;
}

/**
 * 预算计量器，同时也是 **`RunStats` 的唯一持有者**。
 *
 * 为什么由它持有而不是调用方：`recordCall` 是唯一知道「这次调用花了多少」的地方。
 * 若调用方也维护一份计数，就出现了两个事实来源——而它们迟早会分叉，
 * 分叉的表现是**成本统计悄悄失真**，且不会报错。
 *
 * 因此 `check()` / `view()` / `summary()` 都不再收 `stats` 参数，
 * 报告组装改为调用 `stats()` 取值。`elapsedMs` 也归它算（它持有起始时刻）。
 */
export interface BudgetMeter {
  /** 每一步开始时检查。返回 exceeded 则应立即以 budget_exceeded 终止 */
  check(): BudgetStatus;
  /** 记一步。推进 `steps` 与 `elapsedMs` */
  recordStep(): void;

  /**
   * 记一次**逻辑决策**。
   *
   * 与 `recordCall` 分开是因为两者不等价：一次决策可能因 429 / 503 重试多次，
   * 每次都是一个真实的 HTTP 请求、都会计费。预算刹车按**请求数**算
   * （`RunStats.modelCalls`），否则重试就是一条免费通道，
   * 最坏情况实际花费是预算的 3 倍。`decisions` 只进报告用于展示。
   */
  recordDecision(): void;

  /**
   * 记一次决策调用的用量与耗时。
   *
   * **每次 `engine.decide()` / `engine.writeText()` 返回时调一次。**
   * 引擎内部的重试不在这里体现为多次调用——它被合并进返回值的
   * `Usage.requests`，而本方法把 `modelCalls` **按 `usage.requests` 累加**、
   * 把 `decisions` 加一。因此 `modelCalls - decisions` 就是重试带来的额外请求数。
   *
   * 这个区分是预算刹车能成立的前提：按请求数算，重试才不是免费通道。
   */
  recordCall(usage: Usage, latencyMs: number): void;
  /** 传给引擎的只读视图，让引擎自行裁剪上下文 */
  view(): BudgetView;
  /** 剩余额度的人话摘要，用于报告与界面 */
  summary(): string;
  /** 当前累计统计。**报告组装从这里读**，不要另开一份计数 */
  stats(): RunStats;
}

/**
 * 创建预算计量器。
 *
 * `maxCostUsd` 为 null 表示不设金额上限——引擎未报金额时无法校验，
 * 这时**不用 0 冒充**，而是明确显示「未设上限」。
 *
 * `now` 可注入，便于测试里控制墙钟而不必真的等待。
 */
export function createBudgetMeter(budget: Budget, now?: () => number): BudgetMeter {
  throw new Error("未实现：P0 待实现");
}

/** 从用例取预算。已由 schema 填充默认值，此处不做兜底。 */
export function budgetOf(caseDef: Case): Budget {
  return caseDef.budget;
}

// TODO(P0): 实现 createBudgetMeter。
//   注意 check() 的检查顺序：先比最可能先撞到的（步数），再比 token 与金额，
//   这样报告里的 dimension 更贴近用户的第一直觉。
// TODO(P0): recordCall 需要把每次调用的 usage 累加进 RunStats，
//   并在 latencyMs 上累计 engineLatencyMs（与浏览器耗时区分开）。
