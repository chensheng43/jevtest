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
   * `Usage.requests`，而本方法把 `modelCalls` **按 `usage.requests` 累加**。
   *
   * `decisions` 由 `recordDecision()` 单独记（一次 decide 对应一次），
   * 本方法**不碰它**。两者分开正是为了让 `modelCalls - decisions`
   * 能直接读出重试造成的额外请求数——若本方法顺手也加一，
   * 这个读数就永远是 0，重试重新变成看不见的。
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
  // 起始时刻只取一次，之后 elapsedMs 一律由 now() 现算（见下方 elapsed()）。
  const clock = now ?? Date.now;
  const startedAt = clock();

  let steps = 0;
  let modelCalls = 0;
  let decisions = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let engineLatencyMs = 0;

  /**
   * 累计金额。`null` 表示**目前还没有可信的金额**——既包含「一次调用都还没有」，
   * 也包含「调用报了但没有金额」。绝不用 0 冒充（case-format §budget、
   * report-format §2.5）：用 0 冒充会让成本统计悄悄失真，而成本正是本平台最该盯住的指标。
   */
  let costTotal: number | null = null;
  /**
   * 是否出现过「未报金额」的调用。**一旦置位就不可撤销**：
   * 一次未知会让总额永久不可知，后面再报多少都不能把总和算回来
   * （已知部分 + 未知 ≠ 总和）。置位后也不再累加，避免给出一个「看起来可用」的错数。
   */
  let costUnknown = false;

  const usd = (value: number): string => `$${value.toFixed(4)}`;

  /**
   * 墙钟用时。**每次现算，不逐步累加。**
   *
   * 理由：逐步累加只能覆盖到「最后一次 recordStep 为止」，而墙钟上限要抓的
   * 恰恰是最后一步之后那段——比如一次卡住的 wait、一次迟迟不返回的 observe。
   * 现算还让 check() / view() / stats() 三处天然同一个口径，不存在谁忘了加。
   */
  const elapsed = (): number => clock() - startedAt;

  const snapshot = (): RunStats => ({
    steps,
    modelCalls,
    decisions,
    inputTokens,
    outputTokens,
    costUsd: costUnknown ? null : costTotal,
    elapsedMs: elapsed(),
    engineLatencyMs,
  });

  return {
    check(): BudgetStatus {
      const s = snapshot();
      // 顺序 = 撞到的概率顺序，也是用户排查时的直觉顺序：先看「是不是走太多步了」，
      // 再看请求数与 token，最后才怀疑金额与墙钟。多个维度同时越界时，
      // 报告里的 dimension 因此是最贴近第一直觉的那个（步数优先）。
      if (s.steps >= budget.maxSteps) {
        return {
          exceeded: true,
          dimension: "steps",
          detail: `已达步数上限：实际 ${s.steps} 步，上限 ${budget.maxSteps} 步`,
        };
      }
      if (s.modelCalls >= budget.maxModelCalls) {
        return {
          exceeded: true,
          dimension: "modelCalls",
          detail: `已达模型请求上限：实际 ${s.modelCalls} 次（含重试，其中决策 ${s.decisions} 次），上限 ${budget.maxModelCalls} 次`,
        };
      }
      if (s.inputTokens >= budget.maxInputTokens) {
        return {
          exceeded: true,
          dimension: "inputTokens",
          detail: `已达 input token 上限：实际 ${s.inputTokens}，上限 ${budget.maxInputTokens}`,
        };
      }
      // 两道门槛都必须过才检查金额：
      //   - maxCostUsd 为 null = 用例没设金额上限，不做金额检查；
      //   - costUsd 为 null = 引擎没报金额，**无法校验**。此时不刹车是正确的，
      //     只是这条预算形同虚设，summary() 会把它显示成「未知」而不是 0。
      if (budget.maxCostUsd !== null && s.costUsd !== null && s.costUsd >= budget.maxCostUsd) {
        return {
          exceeded: true,
          dimension: "costUsd",
          detail: `已达金额上限：实际 ${usd(s.costUsd)}，上限 ${usd(budget.maxCostUsd)}`,
        };
      }
      if (s.elapsedMs >= budget.maxElapsedMs) {
        return {
          exceeded: true,
          dimension: "elapsedMs",
          detail: `已达墙钟时间上限：实际 ${s.elapsedMs}ms，上限 ${budget.maxElapsedMs}ms`,
        };
      }
      // 未超限时没有「维度」可言，detail 留空，避免调用方在报告里显示一句无意义的话。
      return { exceeded: false, dimension: null, detail: "" };
    },

    recordStep(): void {
      steps += 1;
      // elapsedMs 不在这里 += 增量：它由 now() 现算，口径见 elapsed() 的说明。
    },

    recordDecision(): void {
      decisions += 1;
    },

    recordCall(usage: Usage, latencyMs: number): void {
      // 按实际请求数累加，不是 +1：一次决策重试 3 次 = 3 个请求、都计费。
      // 若按 1 算，重试就是一条免费通道，最坏情况实际花费是预算的 3 倍而刹车不会响。
      // 下限取 1：recordCall 被调用本身就意味着至少发出了一次请求，
      // 引擎若报了 0（或负数），按 0 累加等于亲手开出那条免费通道。
      modelCalls += Math.max(1, Math.trunc(usage.requests));
      inputTokens += usage.inputTokens;
      outputTokens += usage.outputTokens;
      engineLatencyMs += latencyMs;
      if (usage.costUsd === null) {
        costUnknown = true;
      } else if (!costUnknown) {
        costTotal = (costTotal ?? 0) + usage.costUsd;
      }
    },

    view(): BudgetView {
      const s = snapshot();
      // 只给引擎它能据以行动的量：token 与步数它可以自己裁剪上下文，
      // 金额与墙钟它左右不了（BudgetView 里也没有这两个字段）。
      return {
        stepsUsed: s.steps,
        maxSteps: budget.maxSteps,
        modelCallsUsed: s.modelCalls,
        maxModelCalls: budget.maxModelCalls,
        inputTokensUsed: s.inputTokens,
        maxInputTokens: budget.maxInputTokens,
        elapsedMs: s.elapsedMs,
        maxElapsedMs: budget.maxElapsedMs,
      };
    },

    summary(): string {
      const s = snapshot();
      const cost =
        budget.maxCostUsd === null
          ? "金额 未设上限"
          : s.costUsd === null
            ? `金额 未知（上限 ${usd(budget.maxCostUsd)}，引擎未报金额）`
            : `金额 ${usd(s.costUsd)}/${usd(budget.maxCostUsd)}`;
      return [
        `步数 ${s.steps}/${budget.maxSteps}`,
        `模型请求 ${s.modelCalls}/${budget.maxModelCalls}`,
        `input token ${s.inputTokens}/${budget.maxInputTokens}`,
        cost,
        `墙钟 ${s.elapsedMs}ms/${budget.maxElapsedMs}ms`,
      ].join("，");
    },

    stats(): RunStats {
      // 返回快照而不是内部对象：这是唯一的成本事实来源，
      // 让调用方拿到的引用能反过来改它，等于把这条不变量作废。
      return snapshot();
    },
  };
}

/** 从用例取预算。已由 schema 填充默认值，此处不做兜底。 */
export function budgetOf(caseDef: Case): Budget {
  return caseDef.budget;
}

// 调用点约定（供 core/agent.ts 接线时对照）：
//   每步开始 -> check()；决定调用引擎前 -> recordDecision()；
//   decide()/writeText() 返回后 -> recordCall(usage, latencyMs)；
//   浏览器动作执行完 -> recordStep()；报告组装 -> stats()。
//   `decisions` 只有 recordDecision() 会加，漏调它会让报告里的
//   `modelCalls - decisions` 全部被误读成重试（见 RunStats.decisions 的说明）。
