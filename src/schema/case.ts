/**
 * 用例 schema —— 整个项目的唯一事实来源。
 *
 * YAML 文件、Web 表单、CLI 参数三条入口最终都归一到这里的 `CaseDefinition`。
 * `docs/case-format.md` 是它的自然语言版本，两者必须一一对应；
 * `tests/schema.test.ts` 会用「YAML → 解析 → 渲染表单 → 反解 → 深比较」锁死这一点。
 *
 * 分两个类型：
 *   - `CaseDefinition`：用户书写的形态，大量字段可省略。
 *   - `Case`：`CaseDefinitionSchema.parse()` 的输出，所有默认值已填充。
 * 运行时只消费 `Case`，因此代码里不必到处写 `?? 默认值`。
 *
 * 移植来源：本文件的 budget / guardrails / assertions 三层划分，
 * 是把 jev-ultrafast 里 `examples/flights.py:18-38` 那个硬编码的 verify()
 * 泛化成可声明、可配置的东西。
 */

import type { ActionKind, Operation, RunStatus } from "./events.ts";

// ---------------------------------------------------------------------------
// 断言：最终页面
// ---------------------------------------------------------------------------

/**
 * 文本匹配。**数组的每一项生成一个独立的检查项**，报告粒度到条目
 * （`final.text.contains[0]`），而不是「text 整体通过/失败」。
 */
export interface TextMatch {
  equals?: string;
  contains?: string[];
  notContains?: string[];
  /** 正则字面量，使用 `new RegExp(pattern)` 求值 */
  matches?: string[];
}

/**
 * 元素断言。按 `labelContains`（可选 `role`）从元素表里定位元素，再断言其属性。
 *
 * 这是 jev-ultrafast `examples/flights.py:29` 那行
 * `values.get("Where from?") == "Zürich"` 的泛化：
 * 只能按语义标签与角色定位，**没有选择器**——因为模型从头到尾看不到选择器，
 * 断言层也就不该依赖它。
 */
export interface ControlAssertion {
  /** 元素 accessible name 的子串，必填：这是唯一的定位手段 */
  labelContains: string;
  /** 可选，用于消歧（同名标签的 button 与 link） */
  role?: string;
  /** 默认 true。设为 false 表示断言「这个元素不存在」 */
  exists?: boolean;
  valueEquals?: string;
  valueContains?: string;
  valueMatches?: string;
  checked?: boolean;
}

export interface FinalAssertions {
  /** 推荐用 contains 而非 equals：带 query 的 URL 做全等很脆 */
  url?: TextMatch;
  title?: TextMatch;
  /** 页面可见文本。参考项目 `snapshot.js:82-92` 采集的就是可见文本，不含离屏内容 */
  text?: TextMatch;
  controls?: ControlAssertion[];
}

// ---------------------------------------------------------------------------
// 断言：动作轨迹
// ---------------------------------------------------------------------------

/**
 * 动作匹配器。**按标签匹配，不按内部 id 匹配。**
 *
 * 参考项目里 `choice` 是 `e7` 这种 code-owned id，只在单次观测内有效、
 * 跨运行完全不可比；而 `history[i].action` 存的是人类可读的 label
 * （见 `jev_ultrafast/agent.py:121-141`）。所以轨迹断言只能建立在 label 上。
 */
export interface ActionMatch {
  labelContains?: string;
  labelMatches?: string;
  role?: string;
  kind?: ActionKind;
}

export interface TrajectoryAssertions {
  /** 默认 `["done"]`。若关心「预算耗尽也算通过」可自行放宽 */
  statusIn?: RunStatus[];
  maxSteps?: number;
  /** 轨迹中必须出现过匹配的动作 */
  mustUse?: ActionMatch[];
  /** 轨迹中绝不能出现匹配的动作。同时也是护栏：命中即在执行前拦截 */
  mustNotUse?: ActionMatch[];
  /** 绝不允许发生的动作种类，例如只读用例写 `["fill", "select"]` */
  forbiddenKinds?: ActionKind[];
  /**
   * 连续多少次「页面无变化且非 wait」判定为卡死。默认 3。
   * 参考项目 `jev_ultrafast/agent.py:153-158` 把 3 写死在代码里，这里泛化成可配断言。
   */
  maxIdenticalConsecutive?: number;
}

// ---------------------------------------------------------------------------
// 断言：质量与成本
// ---------------------------------------------------------------------------

export interface QualityAssertions {
  /** 决策置信度下限。低于此值说明模型在犹豫，用例不稳 */
  minOperationProbability?: number;
  /**
   * 目标置信度下限。
   * **引擎的 `distribution` 为 `degenerate` 时，此项标为 `skipped` 而非 `passed`**——
   * 通用 LLM 引擎往往只给一个选择，合成为 one-hot 1.0，直接比较会假通过。
   */
  minTargetProbability?: number;
  maxModelCalls?: number;
  maxElapsedMs?: number;
  maxInputTokens?: number;
  maxCostUsd?: number;
}

export interface Assertions {
  final?: FinalAssertions;
  trajectory?: TrajectoryAssertions;
  quality?: QualityAssertions;
}

// ---------------------------------------------------------------------------
// 安全护栏
// ---------------------------------------------------------------------------

/**
 * 禁止动作。命中时**在任何浏览器输入之前**终止，`status` 变为 `guardrail_blocked`。
 *
 * 内置默认集（破坏性动词、密码框、文件上传）**只增不减**：用例只能追加，
 * 不能移除。要移除必须显式设置 `allowDefaultOverride: true`，
 * 且报告顶部会打红色横幅。
 */
export interface Guardrail {
  labelContains?: string;
  labelMatches?: string;
  role?: string;
  /** 必填：报告里要向人解释为什么被拦 */
  reason: string;
}

/** 只读模式：变更型操作不会进入动作空间候选集，模型物理上无法选中。 */
export type CaseMode = "interactive" | "readonly";

// ---------------------------------------------------------------------------
// 预算
// ---------------------------------------------------------------------------

/**
 * 用例级预算。**这是成本控制的唯一落点**，且是硬刹车：
 * 任一维度超限即终止运行，但**已产生的轨迹会保留**供断言求值。
 *
 * 量级参考：jev-ultrafast 一次 Google Flights 任务消耗 17 次决策请求、
 * 90,558 input tokens（见其 `docs/performance.md`）。默认值据此设定。
 */
export interface Budget {
  maxSteps: number;
  maxModelCalls: number;
  maxInputTokens: number;
  /** null = 不设金额上限（引擎未报金额时无法校验） */
  maxCostUsd: number | null;
  maxElapsedMs: number;
}

// ---------------------------------------------------------------------------
// 用例
// ---------------------------------------------------------------------------

/** 用户书写的形态：除 id / title / goal / startUrl 外全部可省略。 */
export interface CaseDefinition {
  /** schema 版本，用于未来迁移。当前恒为 1 */
  schemaVersion?: 1;
  /** 缺省时由文件名生成 slug */
  id?: string;
  title: string;
  /** 自然语言目标。**断言不参与其中**——见 docs/writing-cases.md */
  goal: string;
  startUrl: string;
  mode?: CaseMode;
  /** 域名白名单。缺省由 startUrl 的 origin 推导 */
  allowedOrigins?: string[];
  budget?: Partial<Budget>;
  guardrails?: Guardrail[];
  allowDefaultOverride?: boolean;
  /** 决策引擎名。缺省用 settings 里的默认引擎 */
  engine?: string;
  assertions?: Assertions;
}

/**
 * `CaseDefinitionSchema.parse()` 的输出：默认值已填充，运行时只消费这个类型。
 *
 * 默认值一览（`docs/case-format.md` 有同样的表）：
 *   mode                 "interactive"
 *   allowedOrigins       [startUrl 的 origin]
 *   budget.maxSteps      40
 *   budget.maxModelCalls 40
 *   budget.maxInputTokens 200000
 *   budget.maxCostUsd    null
 *   budget.maxElapsedMs  300000
 *   assertions.trajectory.statusIn ["done"]
 *   assertions.trajectory.maxIdenticalConsecutive 3
 *   allowDefaultOverride false
 */
export interface Case {
  schemaVersion: 1;
  id: string;
  title: string;
  goal: string;
  startUrl: string;
  mode: CaseMode;
  allowedOrigins: string[];
  budget: Budget;
  guardrails: Guardrail[];
  allowDefaultOverride: boolean;
  engine: string;
  assertions: Assertions;
}

/** 用例的版本标识，让任何一份报告都能精确回到产生它的用例版本。 */
export interface CaseRevision {
  caseId: string;
  /** 每次保存 +1 */
  revision: number;
  /** sha256(规范化 YAML 字节)。对应参考项目 measurement.json 里的 source_hashes */
  digest: string;
  savedAt: string;
}

// TODO(P0): 实现 `CaseDefinitionSchema: ZodType<CaseDefinition, Case>`。
//
//   ⚠️ zod v4 的坑：`.default({})` 不会解析默认值，会把 {} 原样返回，
//   **嵌套默认值全部丢失**。直接后果是 `budget.maxModelCalls` 变成 undefined，
//   用例预算静默失效、成本无上限。必须使用 `.prefault({})`（v4 的 input-side 默认，
//   会走 schema 解析），或写成 `.default(() => Budget.parse({}))`。
//   必须配套一条测试：
//     CaseDefinitionSchema.parse({ 最小输入 }).budget.maxModelCalls === 40
//
// TODO(P0): id 校验 `^[a-z0-9][a-z0-9-]{1,63}$`；从 title 生成 slug，冲突加 `-2`。
// TODO(P0): allowedOrigins 缺省推导，以及断言「startUrl 的 origin 必须在白名单内」。
