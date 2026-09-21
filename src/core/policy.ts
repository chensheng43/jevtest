/**
 * 策略层：动作空间构建、决策请求组装、模型输出校验与解析。
 *
 * 移植自 jev-ultrafast 的 jev_ultrafast/model.py:48-148（详见 NOTICE）。
 * 这是整个项目的安全边界所在，三条性质在此确立：
 *
 *   1. **模型只能从候选集里选。** `validateChoice` 逐条检查 choice 在候选集内、
 *      概率键集合完全匹配、概率有限且 ∈[0,1]、和与 1 的偏差 < 0.02、
 *      且 choice 确实是最大概率项。任何一条不满足就抛 InvalidDecision，
 *      **绝不执行任何动作**。模型输出永远不会变成选择器、坐标、shell 命令或可执行 JS。
 *
 *   2. **只有被选中操作的 target head 会被消费。** 其余 head 即使输出非法也不影响执行
 *      （参考项目 `model.py:127` 的注释就是这个意思）。校验顺序本身也是安全性质：
 *      先校验 operation head，再校验 `<op>_target` head，最后才映射回真实动作对象。
 *
 *   3. **只读模式在构造阶段生效。** 见 buildActionSpace——变更型操作根本不会进入候选集，
 *      模型物理上无法选中。这是「由构造提供安全」而非「事后过滤」，
 *      是参考项目「有限选择空间」这一核心机制最有价值的复用。
 */

import type { Case, CaseMode } from "../schema/case.ts";
import type { ActionKind, Operation } from "../schema/events.ts";
import type { Answer, BudgetView, DecisionRequest, DecisionResult, ElementIR, Question } from "../engine/types.ts";
import type { Action, Observation } from "../browser/session.ts";
import type { StepRecord } from "../schema/report.ts";
import { InvalidDecision } from "./errors.ts";
import { NEXT_ACTION, TARGET } from "./rules.ts";

/** 单次观测最多保留多少候选。超出部分被丢弃且**不可被选中**。 */
export const MAX_ACTIONS = 250;

/** 发给模型的近期动作条数。参考项目取 10（`model.py:113`）。 */
export const RECENT_ACTIONS = 10;

/** 只读模式下被禁止的操作。它们不会出现在候选集里，而不是被事后拒绝。 */
export const MUTATING_OPERATIONS: readonly Operation[] = ["TYPE_TEXT", "SELECT"];

/** action kind -> operation 的映射。scroll 与 wait 是页面级操作，无目标。 */
const KIND_TO_OPERATION: Record<string, Operation> = {
  click: "CLICK",
  fill: "TYPE_TEXT",
  select: "SELECT",
};

export interface ActionSpace {
  elements: ElementIR[];
  /** operation -> targetIndex -> Action。targetIndex 对 select 形如 "3:1" */
  targets: Record<string, Record<string, Action>>;
  /** 页面级控件与 DONE/BLOCKED 之外的独立动作 */
  controls: Record<string, Action>;
}

export interface Resolved {
  operation: Operation;
  target: string | null;
  /** 映射回的真实动作对象。执行层只用它，不再看模型输出 */
  action: Action;
  probability: number;
  operationProbability: number;
  confidence: number;
  distribution: "full" | "degenerate";
}

/**
 * 把观测到的动作表变成带索引的元素表 + 每个操作的候选目标。
 *
 * 两点要注意：
 *   - **一个节点只拿一个索引**，即使它同时支持点击与输入（参考项目 `model.py:60`）。
 *     否则同一个输入框会以 [3] 和 [4] 两个身份出现，模型会分不清。
 *   - **原生下拉的每个 option 是独立 target**，形如 `"3:1"`。模型看到的是
 *     选项标签，回传的是索引——它从不知道 option 的 value 是什么。
 *
 * `mode: "readonly"` 时，`fill`/`select` 动作与变更型 click 在此被剔除，
 * 因此 `targets` 里**根本不会有 TYPE_TEXT / SELECT 键**。
 */
export function buildActionSpace(actions: Action[], opts: { mode: CaseMode }): ActionSpace {
  throw new Error("未实现：P0 待实现");
}

/** 组装一次决策请求。断言不参与其中（见 rules.ts 的说明）。 */
export function buildDecisionRequest(input: {
  caseDef: Case;
  page: Observation;
  space: ActionSpace;
  history: StepRecord[];
  budget: BudgetView;
}): DecisionRequest {
  throw new Error("未实现：P0 待实现");
}

/** 问题的 key。operation 恒为 `"operation"`，其余为 `<operation>_target` 小写。 */
export function targetQuestionKey(operation: Operation): string {
  return `${operation.toLowerCase()}_target`;
}

/**
 * 校验一个回答。
 *
 * 逐条保留参考项目 `model.py:30-45` 的判据，**顺序也不要改**——
 * 先在最小代价处失败，能在错误信息里给出更准确的原因。
 */
export function validateChoice(answer: unknown, options: Question): Answer {
  throw new Error("未实现：P0 待实现");
}

/**
 * 把引擎的回答变成可执行的动作。
 *
 * 三步，顺序即安全性质：校验 operation head -> 只校验被选中操作的 target head
 * -> 映射回真实 Action。最后一步之后模型输出就不再有影响力了。
 */
export function resolveDecision(space: ActionSpace, decision: DecisionResult): Resolved {
  throw new Error("未实现：P0 待实现");
}

/** DONE / BLOCKED 不需要目标，单独处理。 */
export function isTerminal(operation: Operation): boolean {
  return operation === "DONE" || operation === "BLOCKED";
}

// TODO(P0): 实现 buildActionSpace —— 照搬 model.py:48-78 的结构。
//   readonly 分支：剔除 kind 为 fill/select 的动作，以及 role 属于
//   {button,checkbox,radio,switch,combobox,menuitem} 的 click。
//
// TODO(P0): 实现 validateChoice —— 注意 distribution 的判定：
//   概率键集合与候选集完全一致且和≈1 时标 "full"，否则若只有一个候选被给出
//   则标 "degenerate"（通用 LLM 引擎的情形）而不是直接判非法。
//
// TODO(P0): 实现 resolveDecision —— 校验失败抛 InvalidDecision，绝不返回半个结果。
