/**
 * 执行循环：观测 -> 决策 -> 护栏 -> 执行 -> 再观测。
 *
 * 移植自 jev-ultrafast 的 jev_ultrafast/agent.py:52-158（详见 NOTICE）。
 * 循环本身很短，难点全在几条**顺序敏感**的不变量上。它们不是风格问题，
 * 每一条都对应一个具体的、已经发生过的错误：
 *
 *   1. **决策先消费，再变更。**（`agent.py:90-91`）
 *      决定执行哪个动作之后立刻清空 decision，然后才动浏览器。
 *      否则一次陈旧重试会变成双击——在「提交订单」这种按钮上后果不必多说。
 *
 *   2. **浏览器变更从不重试。**（AGENTS.md 明确写下的一条）
 *      网络层可以重试，浏览器动作不可以。动作可能已经生效，只是我们没看到结果；
 *      重试就是执行两次。所以传输恢复逻辑绝不能包住 act()。
 *
 *   3. **先记执行日志，再观测结果。**（`agent.py:120-121`）
 *      执行完立即把 StepRecord 写进 history，然后才 observe()。
 *      如果反过来，一次恰好发生在观测时的导航就会让「我们点过了」这件事消失，
 *      轨迹里留下一个空洞，报告开始说谎。
 *
 *   4. **废弃的决策不产生副作用。**（`agent.py:88-89`）
 *      fingerprint 对不上就不执行，只重新观测。
 *
 *   5. **无进展检测。**（`agent.py:153-158`）
 *      连续 3 步页面无变化且不是 wait，判为 blocked。
 *      这是防「模型在同一个看不懂的页面上无限空转」的最后一道闸——也是最省钱的一道。
 *
 * Playwright 与参考项目的差异在这一层只体现为 `Session` 接口的调用，
 * 循环结构本身不需要变。这正是把浏览器层抽象成接口换来的东西。
 */

import type { Case } from "../schema/case.ts";
import type { EventSink } from "../schema/events.ts";
import type { CaseRunReport, StepRecord } from "../schema/report.ts";
import type { DecisionEngine } from "../engine/types.ts";
import type { Action, Observation, Session } from "../browser/session.ts";
import type { BudgetMeter } from "./budget.ts";

/** 连续多少步无进展判为 blocked。用例可用 trajectory.maxIdenticalConsecutive 覆盖。 */
export const DEFAULT_NO_PROGRESS_LIMIT = 3;

export interface AgentDeps {
  session: Session;
  engine: DecisionEngine;
  /** 预算与墙钟。**不要在别处另开一份计时**——见 core/budget.ts 的说明 */
  budget: BudgetMeter;
  events: EventSink;
  /** 用例的断言**不在这里**——循环不知道判分标准，见 checks.ts */
  caseDef: Case;
}

export class CaseAgent {
  constructor(deps: AgentDeps) {
    throw new Error("未实现：P0 待实现");
  }

  /**
   * 跑完一个用例，返回完整报告。
   *
   * **不抛异常表示运行成功**，即使断言失败——`passed: false` 是正常返回值。
   * 只有意料之外的故障（引擎不可达、浏览器崩溃）才会让这里 throw，
   * 那种情况由 runner 捕获并写成 `status: "error"` 的报告。
   *
   * 预算耗尽、护栏拦截、用户取消都**不是异常**：它们以对应的 status 正常返回，
   * 且已产生的轨迹完整保留供断言求值。
   */
  async run(signal: AbortSignal): Promise<CaseRunReport> {
    throw new Error("未实现：P0 待实现");
  }

  /** 供界面显示当前进度，不改变状态。 */
  snapshot(): { step: number; status: string; history: StepRecord[] } {
    throw new Error("未实现：P0 待实现");
  }
}

// TODO(P0): 实现 run()。逐步照搬 agent.py 的顺序，特别注意：
//
//   1. observe() -> 发 step.observed
//   2. **仅第一次**：session.probe() -> admission.admit()，结果存进报告的
//      admission 字段。blocking 项显著展示但**不阻止运行**（见 browser/admission.ts）。
//      放在这里而不是入队时的原因：入队时做要开页面，会让入队变慢。
//   3. 域名白名单检查（guard.assertAllowedOrigin）——在决策之前，省一次模型调用
//   4. 预算检查（budget.check）——超限则以 budget_exceeded 结束，保留轨迹
//   5. buildDecisionRequest -> engine.decide -> budget.recordCall(usage, latencyMs)
//   6. resolveDecision（校验 operation head + 仅被选中操作的 target head）
//   7. 禁止动作护栏（guard.checkAction）——命中则 StepRecord.executed=false
//      并终止为 guardrail_blocked，**不调用 session.act**
//   8. TYPE_TEXT：isFresh 复查 -> engine.writeText -> 按 textContextKey 缓存
//      （仅当整个 helper 输入完全相同时复用，成功变更后立即丢弃，对应 agent.py:110-118）
//   9. session.act —— 绝不重试
//  10. budget.recordStep()，先写 StepRecord(executed: true) 并 emit step.executed，
//      **再** observe()
//  11. 无进展检测
//  12. 每步边界 signal.throwIfAborted()，命中则以 cancelled 结束
//
// 关于第 5 步：`usage` 与 `latencyMs` 只在 engine.decide 的返回值里，
// 而 `RunStats` 的唯一持有者是 BudgetMeter——不要在这里另开计数器。
// 报告组装时调 `budget.stats()` 取，见 core/budget.ts。
//
// 取消检查必须放在**步边界**：不能中断一次已经开始的浏览器变更，
// 否则会留下「点了一半」的状态。这与「变更不重试」是同一条原则的两面。
