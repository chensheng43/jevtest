/**
 * 决策引擎的中间表示（IR）与接口。
 *
 * 这一层决定了项目能否干净地接入第二家厂商。核心思路：**供应商无关的 IR**，
 * 加上把「校验」关在引擎之外——引擎只能产出候选集里的 id，越界的选择由
 * `core/policy.ts` 的 validateChoice 拒绝（移植自 jev-ultrafast `model.py:30-45`）。
 *
 * 三条不变量：
 *
 * 1. **一次请求表达多个问题**。`questions[]` 天然表达「一问多题」：
 *    `questions[0]` 恒为 operation，其余为各操作的 target head。
 *    TypeSafe 引擎把它们原样映射成 `{operation, click_target, type_text_target}`；
 *    通用 tool-use 引擎则展平成 enum 约束字段。两者都装得下。
 *
 * 2. **概率可能缺失，必须显式建模**。TypeSafe 给真分布；多数通用 LLM 只给一个选择，
 *    合成出来是 one-hot 1.0。若不区分，`quality.minTargetProbability: 0.3` 会在新引擎上
 *    **假通过**。所以 `Answer.distribution` 是必填字段，断言层据此把概率检查标为 skipped。
 *
 * 3. **引擎是纯网络组件**，不碰浏览器、不持有会话。因此「重试」只可能发生在网络层
 *    （429/529/503 指数退避），而「浏览器变更从不重试」这条不变量由结构而非纪律保证。
 *
 * 依赖方向：engine → schema，不反向。
 */

import type { ActionKind, Operation } from "../schema/events.ts";
import type { Usage } from "../schema/report.ts";

// ---------------------------------------------------------------------------
// 问题与选项
// ---------------------------------------------------------------------------

/** 一个问题里的一个候选。`id` 是 code-owned 的，模型只能回传它，看不到选择器。 */
export interface Option {
  id: string;
  /** 给模型看的短标签，例如 `[3] button 搜索` */
  label: string;
  /** 附加属性（role / 当前值 / checked / disabled 等），供模型判断 */
  detail: Record<string, unknown>;
}

/** 一次决策请求中的一个问题。`questions[0].key` 恒为 `"operation"`。 */
export interface Question {
  /** TypeSafe 用 `operation` / `click_target` / `type_text_target` / `select_target` */
  key: string;
  prompt: string;
  options: Option[];
}

// ---------------------------------------------------------------------------
// 页面状态（模型能看到的全部内容）
// ---------------------------------------------------------------------------

/** 元素表的一行。**模型看到的就是这个，没有选择器、没有坐标。** */
export interface ElementIR {
  index: string;
  label: string;
  role: string;
  value?: string;
  checked?: string;
  selected?: boolean;
  expanded?: string;
  /** 该元素支持的操作。只读模式下变更型操作不会出现在这里 */
  operations: Operation[];
  /** 原生下拉的选项。target 形如 `"3:1"`，模型看不到 option 的值 */
  options?: { index: string; label: string }[];
}

export interface RecentActionIR {
  action: string;
  kind: ActionKind;
  text: string | null;
  pageChanged: boolean | null;
}

export interface PageStateIR {
  url: string;
  title: string;
  /** 可见文本，已截断。参考项目取 6000 字符（`snapshot.js:92`） */
  text: string;
  textTruncated: boolean;
  elements: ElementIR[];
  /** 最近若干步，让模型知道哪些已经做过 */
  recentActions: RecentActionIR[];
  /** 被截断丢弃的候选数，让模型知道「还有东西没看到」 */
  omittedActions: number;
}

// ---------------------------------------------------------------------------
// 预算视图
// ---------------------------------------------------------------------------

/**
 * 预算的只读视图，随请求一起下发，让引擎自行裁剪上下文。
 *
 * 把成本控制下沉到**唯一的上下文消费点**：引擎知道还剩多少额度，
 * 就能决定要不要截断 page.text、是否跳过某轮重试。runner 不必猜。
 */
export interface BudgetView {
  stepsUsed: number;
  maxSteps: number;
  modelCallsUsed: number;
  maxModelCalls: number;
  inputTokensUsed: number;
  maxInputTokens: number;
  elapsedMs: number;
  maxElapsedMs: number;
}

// ---------------------------------------------------------------------------
// 请求与结果
// ---------------------------------------------------------------------------

export interface DecisionRequest {
  goal: string;
  /** 共享的下一步规则。移植自 jev-ultrafast `questions.py` 的 NEXT_ACTION */
  rules: string[];
  state: PageStateIR;
  /** `questions[0].key === "operation"` */
  questions: Question[];
  budget: BudgetView;
}

/**
 * 一个问题的回答。
 *
 * `probabilities` 的键集合必须与问题候选集完全一致（validateChoice 会校验），
 * 因此消费方可以直接按 id 取概率。
 */
export interface Answer {
  key: string;
  choice: string;
  probabilities: Record<string, number>;
  /**
   * `full` = 引擎给出的真实分布（TypeSafe）。
   * `degenerate` = 单点分布，由「模型只回了一个选择」合成而来。
   * 后者会让概率类断言失去意义，必须标为 skipped 而不是 passed。
   */
  distribution: "full" | "degenerate";
  confidence: number;
}

export interface DecisionResult {
  /** key -> Answer，键集合与 request.questions 一致 */
  answers: Record<string, Answer>;
  usage: Usage;
  latencyMs: number;
  engine: string;
  /** 原始响应。**只进 trace，绝不参与执行。** */
  raw: unknown;
}

export interface TextRequest {
  goal: string;
  field: { label: string; role: string; value: string };
  page: { title: string; text: string };
  recentActions: RecentActionIR[];
}

export interface TextResult {
  /** null = 目标里缺少必要信息。此时必须报错，而不是猜一个值 */
  text: string | null;
  usage: Usage;
  latencyMs: number;
  engine: string;
}

// ---------------------------------------------------------------------------
// 引擎接口
// ---------------------------------------------------------------------------

export interface EngineCapabilities {
  /** 是否支持 TYPE_TEXT 取值。false 时遇到 fill 直接报错，绝不硬编码字段值 */
  text: boolean;
  /** 该引擎能给出什么质量的概率分布，决定概率类断言是否可求值 */
  probabilities: "full" | "degenerate";
}

/**
 * 决策引擎。唯一的实现契约。
 *
 * `signal` 用于取消：用户点「停止」时，在途的 fetch 应被中止而不是等它超时。
 */
export interface DecisionEngine {
  readonly name: string;
  readonly capabilities: EngineCapabilities;

  /**
   * 一次请求同时决定操作与各操作的候选目标。
   *
   * 注意：**断言绝不进入这个请求**。让 agent 看见判分标准会诱导它对着答案演戏，
   * 也破坏策略的通用性——参考项目里 goal 与 verify() 是完全解耦的两件事。
   */
  decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;

  /** 仅当操作是 TYPE_TEXT 时调用。 */
  writeText(req: TextRequest, signal: AbortSignal): Promise<TextResult>;

  close(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 失败调用的用量
// ---------------------------------------------------------------------------

/**
 * 失败的调用也可能已经计费：429 重试三次仍失败、HTTP 200 但响应形状不对……
 * 这些请求都真实发出去了。只在成功时记账的话，预算刹车与报告里的 modelCalls /
 * token 都会偏低，重试失败又成了一条免费通道（architecture.md §11.2 ⑤）。
 *
 * 引擎在抛出的错误上用 `attachFailedCallUsage` 挂上已发生的用量，调用方用
 * `failedCallUsage` 取出来记账。用 Symbol 键而不是约定一个错误类：
 * core 不必认识每个引擎各自的错误类型。
 */
const FAILED_CALL_USAGE = Symbol.for("jevtest.failedCallUsage");

export interface FailedCallUsage {
  usage: Usage;
  latencyMs: number;
}

export function attachFailedCallUsage<E>(error: E, value: FailedCallUsage): E {
  if (typeof error === "object" && error !== null && !(FAILED_CALL_USAGE in error)) {
    Object.defineProperty(error, FAILED_CALL_USAGE, { value, enumerable: false });
  }
  return error;
}

/** 取出失败调用已发生的用量。没挂（例如一个请求都没发出）时返回 null */
export function failedCallUsage(error: unknown): FailedCallUsage | null {
  if (typeof error !== "object" || error === null) return null;
  const value = (error as { [FAILED_CALL_USAGE]?: FailedCallUsage })[FAILED_CALL_USAGE];
  return value ?? null;
}

// TODO(P0): 实现 typesafe.ts —— 唯一真实引擎。
//   POST https://api.typesafe.ai/v1/systemone
//   body: {model, state: {page, elements, recent_actions}, questions: {...}}
//   重试策略：仅 429 / 529 / 503，指数退避，至多 3 次；
//   4xx（除 429）立即失败且**不执行任何浏览器动作**。
//
// TODO(P0): 实现 scripted.ts —— 零成本回放引擎，按预设数组返回答案。
//   这是把参考项目 `tests/test_agent.py:77-95` 的 monkeypatch 手法提升到注册表层，
//   让 server + queue + pool + runner + checks 全链路在零成本、确定性的条件下被测试。
//
// TODO(P1): 实现 openai-compat.ts —— 通用 tool-use 引擎，capabilities.probabilities
//   应声明为 "degenerate"。
