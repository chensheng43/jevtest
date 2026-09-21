/**
 * 断言求值：最终页面 / 动作轨迹 / 质量与成本。
 *
 * 泛化自参考项目 `examples/flights.py:18-38` 里那个硬编码的 verify()。
 * 那里的写法已经包含了正确的思想，本项目只是把它变成可声明的东西：
 *
 *     def verify(page):
 *         values = {a["label"].strip(): a.get("value") for a in page["actions"]}
 *         checks = {"origin": values.get("Where from?") == "Zürich", ...}
 *         return {"passed": all(checks.values()), "checks": checks}
 *
 * 三件必须保持的事：
 *
 *   1. **按语义标签定位，不按选择器。** 模型从头到尾看不到选择器，断言层依赖它
 *      就等于引入了一条模型看不见、而断言依赖的隐含契约。
 *
 *   2. **粒度为条目，不是整体。** `final.text.contains` 是一个数组，
 *      每一项产出独立的检查项（`final.text.contains[0]`）。报告要能指出
 *      「7 条里第 3 条没过」，而不是「text 没过」。
 *
 *   3. **`skipped` 既不是通过也不是失败。** 唯一已知场景是引擎的概率分布是
 *      degenerate（通用 LLM 只给一个选择）时，概率类检查失去意义。
 *      这时必须标 skipped 并在报告里显示「跳过」——**绝不能显示「通过」**，
 *      否则就是假通过，比失败更危险。
 *
 * 还有一条纪律：**断言绝不进入发给模型的请求**。让 agent 看见判分标准
 * 会诱导它对着答案演戏，也破坏策略的通用性（参考项目里 goal 与 verify 完全解耦）。
 */

import type { Assertions, ActionMatch, ControlAssertion, TextMatch } from "../schema/case.ts";
import type { RunStats, RunStatus } from "../schema/events.ts";
import type { AssertionResult, CheckResult, StepRecord } from "../schema/report.ts";
import type { Observation } from "../browser/session.ts";

export interface CheckContext {
  /** 最终页面。预算耗尽或崩溃时为 null，此时 final 族检查标为 skipped */
  final: Observation | null;
  history: StepRecord[];
  status: RunStatus;
  stats: RunStats;
  guardrailHits: { step: number; reason: string; action: string }[];
}

/**
 * 概率类断言的取样口径。
 *
 * 分布质量（`distribution`）**不在这里**，而是逐步从 `history` 读——
 * 它是**每次回答**的属性（`Answer.distribution` 已是必填），把它压成整轮一个值
 * 会造成二选一：过度 skip（丢掉真实的 full 覆盖），或漏 skip（假通过照旧发生）。
 * 而 §5.3 要防的假通过恰好只发生在 target 侧，正是被压平后最容易漏掉的那一半。
 */
export const PROBABILITY_SAMPLING = {
  /** 被护栏拦下的步（executed: false）没有执行，其概率不代表决策质量 */
  requiresExecuted: true,
  /** operation 概率只在 operation head 给出真分布的步上可求值 */
  operationRequiresFull: true,
  /** target 概率额外要求该步确实选了目标——DONE / BLOCKED / scroll / wait 都没有 target */
  targetRequiresTarget: true,
  /** 取 min 而非平均：要抓的是「某一步很犹豫」，平均会把它稀释掉 */
  aggregate: "min",
} as const;

/**
 * 检查项的聚合规则。
 *
 * `passed` 是**三态**的，因为检查项本身就是三态（见 CheckResult）：
 *
 * | 情况 | passed |
 * | --- | --- |
 * | 有任一 failed | `false` |
 * | 无 failed，但有 skipped | **`null`（未判定）** |
 * | 全部 passed | `true` |
 * | 没有任何检查项 | `null` |
 *
 * 中间那一行是关键：7 条通过、1 条因 degenerate 被跳过时，整体判 `null` 而非 `true`。
 * 判 `true` 就是 D9 要杜绝的谎报覆盖——我们确实没验证那一条。
 * 想要确定的结论，就不该用需要概率的断言。
 */
export function aggregateChecks(checks: Record<string, CheckResult>): boolean | null {
  const values = Object.values(checks);
  if (values.length === 0) return null;
  if (values.some((c) => !c.passed && !c.skipped)) return false;
  if (values.some((c) => c.skipped)) return null;
  return true;
}

/**
 * 求值全部断言。
 *
 * 返回的 checks 的 key 是**稳定路径**，形如：
 *   final.url
 *   final.text.contains[0]
 *   final.controls[2].valueEquals
 *   trajectory.mustNotUse[1]
 *   quality.maxInputTokens
 * 报告与前端都按这个路径定位，因此生成规则不要随意改动。
 *
 * `passed` 由 `aggregateChecks` 聚合，取值是**三态**的——
 * 有 skipped 而无 failed 时判 `null`（未判定），不是 `true`。
 */
export function evaluateAssertions(assertions: Assertions, ctx: CheckContext): AssertionResult {
  throw new Error("未实现：P0 待实现");
}

/** 最终页面族。 */
export function checkFinal(page: Observation | null, a: NonNullable<Assertions["final"]>): Record<string, CheckResult> {
  throw new Error("未实现：P0 待实现");
}

/** 轨迹族。按 label 匹配，不按内部 id——见 schema/case.ts 的 ActionMatch 说明。 */
export function checkTrajectory(
  history: StepRecord[],
  status: RunStatus,
  a: NonNullable<Assertions["trajectory"]>,
): Record<string, CheckResult> {
  throw new Error("未实现：P0 待实现");
}

/**
 * 质量与成本族。
 *
 * 收 `history` 而不收一个整轮的 `distribution`——分布质量是**每次回答**的属性，
 * 逐步读取才不会在 operation head 与 target head 质量不同时做出错误取舍。
 * 取样口径见 PROBABILITY_SAMPLING。
 *
 * 没有任何一步可求值（例如全部是 degenerate，或 history 为空）时，
 * 概率类检查返回 **skipped**，而不是通过。
 */
export function checkQuality(
  history: StepRecord[],
  stats: RunStats,
  a: NonNullable<Assertions["quality"]>,
): Record<string, CheckResult> {
  throw new Error("未实现：P0 待实现");
}

/** 文本匹配求值。数组的每一项单独产出结果。 */
export function matchText(actual: string, match: TextMatch, path: string): Record<string, CheckResult> {
  throw new Error("未实现：P0 待实现");
}

/** 元素断言求值：按 labelContains（可选 role）定位，再比属性。 */
export function matchControl(actions: { label: string; role?: string; value?: string; checked?: string }[], assertion: ControlAssertion, path: string): Record<string, CheckResult> {
  throw new Error("未实现：P0 待实现");
}

/** 动作匹配器。用于 mustUse / mustNotUse。 */
export function matchAction(step: StepRecord, match: ActionMatch): boolean {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现以上函数。几点注意：
//   - `final` 为 null 时（预算在第一步之前就耗尽），final 族全部标 skipped 而非 failed。
//   - `matches` 用 new RegExp(pattern) 求值；非法正则应报为「用例本身有错」，
//     而不是静默当成不匹配。
//   - `exists: false` 的断言在元素不存在时才算通过；若是因页面根本没观测到
//     （final 为 null），同样标 skipped。
//   - quality 族在 `history` 为空时无法计算 minConfidence，标 skipped。
