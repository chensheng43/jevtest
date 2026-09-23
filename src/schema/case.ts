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

import { z } from "zod";
import type { ZodType } from "zod";

import { slugify } from "./yaml.ts";
import { actionKindSchema, runStatusSchema } from "./events.ts";
import type { ActionKind, Operation, RunStatus } from "./events.ts";

// zod 内置的校验文案改成中文。它是进程级的全局配置，放在这里是因为用例 schema 是
// 一切校验的入口（Web 的保存/导入、CLI 的 validate/import 都经过它）；
// 以前界面上直接出现「Too small: expected string to have >=1 characters」。
z.config(z.locales.zhCN());

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
 * 且报告应打红色横幅（尚未落地，见 docs/limitations.md §9）。
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
  /**
   * 登录态的**名字**（不是路径）。运行时从 `<JEVTEST_AUTH_DIR>/<名字>.json` 载入
   * cookie 与 localStorage。缺省 = 以未登录的全新浏览器打开 startUrl
   */
  authState?: string;
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
  /** 没有默认值：缺省就是「不带登录态」，也因此不影响旧用例的 digest */
  authState?: string;
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

// ---------------------------------------------------------------------------
// 校验辅助
// ---------------------------------------------------------------------------

/** `docs/case-format.md` 的 id 规则：小写字母数字开头，其后可含连字符，总长 2~64。 */
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/**
 * 登录态名称与用例 id 同一套规则。它会拼进磁盘路径（`<authDir>/<名字>.json`），
 * 因此只收名字、不收路径：用例可以从 Web 端创建，收路径就等于让用例指向本机任意文件。
 */
export const AUTH_STATE_NAME_PATTERN = ID_PATTERN;

/**
 * 只接受 http/https。
 *
 * 不能直接放宽到「能被 `new URL()` 解析」：`new URL("file:///x").origin` 是字符串
 * `"null"`，白名单比对会退化成「所有非 http 协议的站点互相匹配」。
 */
function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** 调用前必须已确认 `value` 是合法 http(s) URL（见上面的 refine）。 */
function originOf(value: string): string {
  return new URL(value).origin;
}

/**
 * 正则类字段在**保存时**就校验可编译性。
 *
 * 否则一个写错的模式要到跑完浏览器、进断言层才炸，而且报的是
 * `new RegExp()` 的 SyntaxError——没人能从中看出是 YAML 里哪一行写错了。
 */
function isCompilableRegex(pattern: string): boolean {
  try {
    new RegExp(pattern);
    return true;
  } catch {
    return false;
  }
}

const regexPattern = z.string().refine(isCompilableRegex, {
  message: "不是合法正则（断言层会执行 new RegExp(pattern)）",
});

// actionKindSchema / runStatusSchema 来自 events.ts：合法取值表只该有一份。

// ---------------------------------------------------------------------------
// 各层 schema
// ---------------------------------------------------------------------------

const textMatchSchema = z.object({
  equals: z.string().optional(),
  contains: z.array(z.string()).optional(),
  notContains: z.array(z.string()).optional(),
  matches: z.array(regexPattern).optional(),
});

const controlAssertionSchema = z.object({
  labelContains: z.string().min(1),
  role: z.string().optional(),
  exists: z.boolean().default(true),
  valueEquals: z.string().optional(),
  valueContains: z.string().optional(),
  valueMatches: regexPattern.optional(),
  checked: z.boolean().optional(),
});

/**
 * 至少要有一个匹配条件。
 *
 * 空的 `ActionMatch` 不是「什么都不匹配」而是「匹配一切」：写进 `mustNotUse`
 * 会让每一步都被拦下，而用户以为自己只是漏填了一个字段。
 */
const actionMatchSchema = z
  .object({
    labelContains: z.string().optional(),
    labelMatches: regexPattern.optional(),
    role: z.string().optional(),
    kind: actionKindSchema.optional(),
  })
  .refine(
    (match) =>
      match.labelContains !== undefined ||
      match.labelMatches !== undefined ||
      match.role !== undefined ||
      match.kind !== undefined,
    { message: "至少要填 labelContains / labelMatches / role / kind 之一" },
  );

const finalAssertionsSchema = z.object({
  url: textMatchSchema.optional(),
  title: textMatchSchema.optional(),
  text: textMatchSchema.optional(),
  controls: z.array(controlAssertionSchema).optional(),
});

const trajectoryAssertionsSchema = z.object({
  // 默认值用函数形式：`.default(["done"])` 会把同一个数组实例发给每次解析，
  // 调用方一旦原地改它（断言层有可能会 push），后面的解析就跟着变。
  statusIn: z.array(runStatusSchema).default((): RunStatus[] => ["done"]),
  maxSteps: z.number().int().positive().optional(),
  mustUse: z.array(actionMatchSchema).default(() => []),
  mustNotUse: z.array(actionMatchSchema).default(() => []),
  forbiddenKinds: z.array(actionKindSchema).default(() => []),
  maxIdenticalConsecutive: z.number().int().positive().default(3),
});

const qualityAssertionsSchema = z.object({
  minOperationProbability: z.number().min(0).max(1).optional(),
  minTargetProbability: z.number().min(0).max(1).optional(),
  maxModelCalls: z.number().int().positive().optional(),
  maxElapsedMs: z.number().int().positive().optional(),
  maxInputTokens: z.number().int().positive().optional(),
  maxCostUsd: z.number().nonnegative().optional(),
});

const assertionsSchema = z.object({
  final: finalAssertionsSchema.optional(),
  // trajectory 也用 prefault：默认值表里的 statusIn / maxIdenticalConsecutive
  // 挂在它下面，不解析的话这两条默认值等于不存在。
  trajectory: trajectoryAssertionsSchema.prefault({}),
  quality: qualityAssertionsSchema.optional(),
});

const budgetSchema = z.object({
  maxSteps: z.number().int().positive().default(40),
  maxModelCalls: z.number().int().positive().default(40),
  maxInputTokens: z.number().int().positive().default(200000),
  // null = 不设金额上限。引擎未报金额时无法校验，用 null 表示「未知」而不是 0。
  maxCostUsd: z.number().nonnegative().nullable().default(null),
  maxElapsedMs: z.number().int().positive().default(300000),
});

const guardrailSchema = z
  .object({
    labelContains: z.string().optional(),
    labelMatches: regexPattern.optional(),
    role: z.string().optional(),
    reason: z.string().min(1),
  })
  .refine(
    (guardrail) =>
      guardrail.labelContains !== undefined ||
      guardrail.labelMatches !== undefined ||
      guardrail.role !== undefined,
    { message: "护栏至少要有一个匹配条件（labelContains / labelMatches / role），reason 只是拦截时的解释" },
  );

/**
 * `allowedOrigins` 的每一项归一化成 origin。
 *
 * 比对的是 origin 而非完整 URL：站内路径跳转正常，跳出站点才该拦。
 * 直接容忍用户把整条 URL 粘进来（`https://a.com/wiki/Main_Page` -> `https://a.com`），
 * 比让他先自己删掉 path 更省事，也避免白名单因为一条多余路径而静默失配。
 */
const originSchema = z
  .string()
  .refine(isHttpUrl, { message: "必须是 http/https 的绝对 URL（只会取它的 origin 参与比对）" })
  .transform(originOf);

/**
 * `engine` 的缺省值。
 *
 * schema 拿不到 `Settings`，所以这里落的是 `settings.defaultEngine` 自己的默认值
 * （`config.ts` 的 `JEVTEST_DEFAULT_ENGINE`）。两处必须一起改。
 */
const DEFAULT_ENGINE = "typesafe";

const caseObjectSchema = z.object({
  schemaVersion: z.literal(1).default(1),
  id: z
    .string()
    .regex(ID_PATTERN, "id 只能用小写字母、数字与连字符，需以字母或数字开头，长度 2~64")
    .optional(),
  title: z.string().min(1),
  goal: z.string().min(1),
  startUrl: z.string().refine(isHttpUrl, { message: "startUrl 必须是 http/https 的绝对地址" }),
  mode: z.enum(["interactive", "readonly"]).default("interactive"),
  allowedOrigins: z.array(originSchema).optional(),
  authState: z
    .string()
    .regex(ID_PATTERN, "authState 是登录态的名字：小写字母、数字与连字符，需以字母或数字开头，长度 2~64")
    .optional(),
  // ⚠️ 必须是 prefault 而不是 default：`.default({})` 会把 {} 原样返回、不走 schema 解析，
  // budget.maxModelCalls 随之变成 undefined——预算静默失效、成本无上限，且不报错。
  budget: budgetSchema.prefault({}),
  guardrails: z.array(guardrailSchema).default(() => []),
  allowDefaultOverride: z.boolean().default(false),
  engine: z.string().min(1).default(DEFAULT_ENGINE),
  assertions: assertionsSchema.prefault({}),
});

/**
 * 用例校验器。输出是**默认值已填充的 `Case`**，运行时只消费它。
 *
 * 类型参数顺序按 zod v4 的声明（`ZodType<Output, Input>`）：输出是 `Case`、
 * 接受的是 `CaseDefinition`。（`src/schema/case.ts` 原 TODO 写的
 * `ZodType<CaseDefinition, Case>` 在 v4 语义下正好反了。）
 *
 * 收尾的 transform 做两件必须看到「其他字段」才能做的事：
 *   1. `id` 缺省时由 `title` 生成 slug。冲突追加 `-2`/`-3` 是 `CaseStore.allocateId`
 *      的职责——schema 看不到已有用例，只能保证同一 title 得到同一个 slug。
 *   2. `allowedOrigins` 缺省时由 `startUrl` 推导，并断言推导结果/显式白名单
 *      一定包含 `startUrl` 的 origin（否则第一次 goto 就会被自己的白名单拦下）。
 */
export const CaseDefinitionSchema: ZodType<Case, CaseDefinition> = caseObjectSchema.transform(
  (definition, ctx) => {
    const startOrigin = originOf(definition.startUrl);
    const allowedOrigins = definition.allowedOrigins ?? [startOrigin];

    if (!allowedOrigins.includes(startOrigin)) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedOrigins"],
        message:
          `白名单里没有 startUrl 的 origin（${startOrigin}）——` +
          `第一次导航就会被自己的白名单判为越界；补上它，或删掉 allowedOrigins 让它自动推导`,
      });
      return z.NEVER;
    }

    return { ...definition, id: definition.id ?? slugify(definition.title), allowedOrigins };
  },
);
