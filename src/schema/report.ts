/**
 * 运行报告 schema —— 落盘格式，也是 Web 结果页的数据源。
 *
 * 一份报告是**自包含**的：它内嵌产生它的那份用例（`frozenCase`）与版本标识
 * （`caseRevision` / `caseDigest`），因此事后翻出一份旧报告，能精确知道
 * 当时跑的是哪个版本的用例。这是参考项目 `measurement.json` 里 `source_hashes`
 * 的正规化版本。
 *
 * 依赖方向：本文件不 import engine 或 browser。`Usage` 是成本概念，
 * 定义在这里，由 `engine/types.ts` 反向引用。
 */

import { z } from "zod";
import type { ZodType } from "zod";

import { actionKindSchema, runStatsSchema, runStatusSchema } from "./events.ts";
import type { ActionKind, RunStats, RunStatus } from "./events.ts";

/** 一次模型调用的用量。引擎未报金额时为 null，不用 0 冒充「未知」。 */
export interface Usage {
  inputTokens: number;
  outputTokens: number;
  costUsd: number | null;
  /** 本次决策实际发出的 HTTP 请求数（重试会使其大于 1） */
  requests: number;
}

/**
 * 轨迹中的一条记录。**这是断言层的核心输入**，也是「模型的 DONE 不算证据」的物证：
 * 无论最终 status 是什么，走过的每一步都在这里。
 */
export interface StepRecord {
  step: number;
  /** 人类可读标签。轨迹断言按它匹配，而非内部的 `e7`（见 case.ts 的 ActionMatch） */
  action: string;
  kind: ActionKind;
  role: string;
  operation: string;
  target: string | null;
  /** 被选中目标的概率 */
  probability: number;
  operationProbability: number;
  confidence: number;
  /** `degenerate` 时，依赖概率的断言标为 skipped 而非 passed */
  distribution: "full" | "degenerate";

  /** false = 在执行前被护栏拦下，浏览器未收到任何输入 */
  executed: boolean;
  /** executed 为 false 时说明拦截原因 */
  blockReason: string | null;

  /** TYPE_TEXT 实际输入的文本 */
  text: string | null;
  /** 生成该文本的引擎名；未调用则为 null */
  textEngine: string | null;

  urlBefore: string;
  urlAfter: string | null;
  /** null = 执行后观测失败（例如导航打断），不代表动作没发生 */
  pageChanged: boolean | null;

  engineLatencyMs: number;
  textLatencyMs: number;
  /** 该步结束时的累计墙钟时间 */
  observedMs: number;
  /** 截图序号，对应 runs/<runId>/frames/<frame>.jpg */
  frame: number | null;
  engineUsage: Usage;
}

/** 单条检查项的结果。 */
export interface CheckResult {
  passed: boolean;
  /**
   * true = 无法求值，**既不算通过也不算失败**。
   * 唯一已知场景：引擎的分布是 degenerate 时，概率类检查无意义。
   * 报告里必须显示「跳过」，绝不能显示「通过」——否则就是假通过。
   */
  skipped: boolean;
  /** 给人看的一句话，包含实际值 */
  detail: string;
}

/**
 * 三层断言的求值结果。
 *
 * key 形如 `final.url` / `final.text.contains[0]` / `final.controls[2]` /
 * `trajectory.mustNotUse[1]` / `quality.maxInputTokens`，粒度到条目。
 */
export interface AssertionResult {
  /**
   * **三态**，与 `CheckResult` 对齐：
   *   - `false`  有任一检查失败
   *   - `true`   全部检查通过
   *   - `null`   未判定——有检查被跳过而无失败，或没有任何检查项
   *
   * 单独一个 `boolean` 在这里没有诚实取值：判 `false` 是谎报失败，
   * 判 `true` 正是 D9 要杜绝的谎报覆盖。聚合规则见 `core/checks.ts`
   * 的 `aggregateChecks`。
   */
  passed: boolean | null;
  checks: Record<string, CheckResult>;
}

// ---------------------------------------------------------------------------
// 报告
// ---------------------------------------------------------------------------

/**
 * 用例准入报告：告诉用户这个用例适不适合本平台。
 *
 * **是记录与警告，不是运行的闸。** 调用点在 `CaseAgent.run()` 第一次
 * `observe()` 之后，结果写进报告的 `admission` 字段；`blocking` 项会在报告顶部
 * 显著展示，但**不阻止运行**。
 *
 * 不把它做成闸的理由：那会给 `RunStatus` 加成员（schema 变更），
 * 而准入检查要打开页面——放在入队时做会让入队变慢。要不要真做成闸留到 P1。
 */
export interface AdmissionReport {
  /** 无 blocking 项即为 true。注意它**不影响本次运行是否继续** */
  ok: boolean;
  /** 阻断项。例如「目标包含文件上传，本平台不支持」 */
  blocking: string[];
  /** 警告项。例如「检测到 2 个跨域 iframe，其内部控件不可见」 */
  warnings: string[];
  stats: AdmissionStats;
}

/**
 * 页面探测的原始统计。
 *
 * 由 `Session.probe()` 采集，`admission.ts` 的纯函数据此算结论。
 * 这样切的理由：判定规则是**可以单元测试的**（喂不同的 stats 看结论），
 * 而采集是**不可测试的**（要真浏览器）。混在一起会让规则无法回归。
 */
export interface AdmissionStats {
  frames: number;
  crossOriginFrames: number;
  shadowRoots: number;
  canvases: number;
  passwordFields: number;
  fileInputs: number;
  nestedScrollContainers: number;
  /** 元素表里的可交互元素数。为 0 且 canvases > 0 说明可能是纯 canvas 应用 */
  interactiveElements: number;
}

export interface CaseRunReport {
  schemaVersion: 1;

  runId: string;
  caseId: string;
  caseRevision: number;
  caseDigest: string;
  /** 属于哪次批量运行；单跑为 null */
  suiteRunId: string | null;
  engine: string;

  startedAt: string;
  finishedAt: string;
  elapsedMs: number;

  /** 循环如何结束 */
  status: RunStatus;
  /** 断言判决。与 status 相互独立：done + false 是正常组合 */
  passed: boolean | null;
  failureReason: string | null;

  goal: string;
  startUrl: string;
  finalUrl: string | null;
  /**
   * 运行结束时那一页的截图序号（`frames/<n>.jpg`）。终止决策不产生 StepRecord，
   * 这是看到「最后停在哪一页」的唯一一帧。没截图为 null；早于这个字段的报告里没有它。
   */
  finalFrame?: number | null;

  steps: StepRecord[];
  guardrailHits: { step: number; reason: string; action: string }[];
  assertion: AssertionResult | null;
  stats: RunStats;
  admission: AdmissionReport | null;

  artifacts: {
    /** 相对报告目录；`npx playwright show-trace` 可直接打开 */
    traceZip: string | null;
    framesDir: string | null;
    /** 产生本次运行的用例快照（冻结），保证报告自包含 */
    frozenCase: string;
  };
}

/** `runs/index.jsonl` 的一行：不必读完整报告就能列出历史。 */
export interface RunIndexEntry {
  runId: string;
  caseId: string;
  caseTitle: string;
  suiteRunId: string | null;
  startedAt: string;
  status: RunStatus;
  passed: boolean | null;
  elapsedMs: number;
  steps: number;
  costUsd: number | null;
}

// ---------------------------------------------------------------------------
// zod 形态
// ---------------------------------------------------------------------------

/**
 * 校验器与上面手写 interface 的对应关系是**单向锁死**的：`reportSchema` /
 * `runIndexEntrySchema` 都标了 `ZodType<X, X>`，tsc 因此检查「schema 产出的是 X」——
 * 字段漏写、类型放得比契约宽、枚举值不对，都会当场编译失败，而不是等到
 * 磁盘上读回一份坏报告才发现。`report.ts` 的类型是契约，schema 只是它的执行者。
 * （类型参数顺序按 zod v4 的 `ZodType<Output, Input>`，与 `case.ts` 同。）
 *
 * ⚠️ 它**不检查反方向**。zod v4 的 `Input` 是协变的，所以把某个字段收得比契约更紧
 * （例如把契约里的 `string` 写成枚举）照样能编译通过，而运行时会拒收契约允许的取值——
 * 这是一条只会在读旧报告时才炸的路径。本文件因此立一条纪律：
 * **只有契约本身就是枚举的字段（`status` / `kind` / `distribution`）才用枚举校验，
 * 其余一律按契约的宽度校验。**
 *
 * 校验松紧按「物证」二字定：
 *   - **除类型里显式写了 `| null` 的字段外，一律必填。** 报告是回读的物证，
 *     少一个字段说明落盘那一刻就已经坏了，静默补默认值等于伪造证据。
 *   - 计数与序号用 `int().nonnegative()`、时间用 `nonnegative()`，与 `events.ts`
 *     的 `runStatsSchema` 同口径——两处口径不一致会让「同一份数据两种判法」。
 *   - **`null` 一律用 `.nullable()`，绝不用 `.optional()`。** 这是本文件最重要的区分：
 *     `costUsd: null` 是「引擎没报金额」这个有效取值，`pageChanged: null` 是「没能观测」，
 *     而 `assertion: null` 是「断言层根本没跑」。把三者改成 optional 会让
 *     「没这个字段」（旧版本写的、或落盘损坏）与这三件不同的事混成一个。
 *
 * **不用 `.strictObject()`，用默认的「剥离未知键」。** 这条决定 `events.ts` 已经做过并写了理由，
 * 报告与事件同属长期留存物：多一个字段就让整份报告读不出来，代价远大于放行一个多余字段
 * （向前兼容优先于防多余字段）。这里的用途是校验磁盘回读与 /api 响应，
 * 不是信任边界——信任边界在 `web/security.ts` 的守卫上。
 */
const usageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  // nullable 而不是 optional：未报金额写 null，不能省略也不能用 0 冒充（§2.5）。
  costUsd: z.number().nonnegative().nullable(),
  /** 含重试的实际请求数，因此可能大于 1 */
  requests: z.number().int().nonnegative(),
});

const stepRecordSchema = z.object({
  step: z.number().int().nonnegative(),
  action: z.string(),
  kind: actionKindSchema,
  role: z.string(),
  // ⚠️ 这里是 `z.string()` 而不是 events.ts 的 `operationSchema`：
  // `StepRecord.operation` 在 TS 里声明为 `string`（不是 `Operation`），而类型是契约。
  // 收紧成枚举会拒收契约允许的取值，因此宁可少一层校验。
  // 但请注意同组的 `kind` 用的是 `actionKindSchema`——那是 TS 类型 `ActionKind` 的精确镜像。
  // 也就是说 `operation` 是本文件里唯一「类型比词汇表松」的字段，这是**契约的松**，不是实现偷懒：
  // 建议契约方把 `StepRecord.operation` 收紧成 `Operation`，届时这里可以同步换成 `operationSchema`。
  operation: z.string(),
  target: z.string().nullable(),
  probability: z.number(),
  operationProbability: z.number(),
  // 概率不校验 0~1 也不校验归一化：与 events.ts 一致地只校验类型——
  // 引擎是否可能合法地给出未归一化的分布尚未定论（events.ts 的 TODO(P1)）。
  confidence: z.number(),
  distribution: z.enum(["full", "degenerate"]),
  executed: z.boolean(),
  blockReason: z.string().nullable(),
  text: z.string().nullable(),
  textEngine: z.string().nullable(),
  urlBefore: z.string(),
  urlAfter: z.string().nullable(),
  // 三态：null 是「没能观测」，不是「没变化」。缺了 nullable 会让正常导航的报告读不出来。
  pageChanged: z.boolean().nullable(),
  engineLatencyMs: z.number().nonnegative(),
  textLatencyMs: z.number().nonnegative(),
  observedMs: z.number().nonnegative(),
  frame: z.number().int().nonnegative().nullable(),
  engineUsage: usageSchema,
});

const checkResultSchema = z.object({
  passed: z.boolean(),
  /** true = 无法求值，既不算通过也不算失败。报告里必须显示「跳过」 */
  skipped: z.boolean(),
  detail: z.string(),
});

const assertionResultSchema = z.object({
  /**
   * 三态。**不能写成 `z.boolean()`**：7 条通过、1 条被跳过时整体是 `null`（未判定），
   * 判 true 就是 D9 要杜绝的谎报覆盖。
   */
  passed: z.boolean().nullable(),
  // key 是稳定路径（`final.text.contains[0]`），前端靠它定位，因此是自由字符串而不是枚举。
  checks: z.record(z.string(), checkResultSchema),
});

const admissionStatsSchema = z.object({
  frames: z.number().int().nonnegative(),
  crossOriginFrames: z.number().int().nonnegative(),
  shadowRoots: z.number().int().nonnegative(),
  canvases: z.number().int().nonnegative(),
  passwordFields: z.number().int().nonnegative(),
  fileInputs: z.number().int().nonnegative(),
  nestedScrollContainers: z.number().int().nonnegative(),
  interactiveElements: z.number().int().nonnegative(),
});

const admissionReportSchema = z.object({
  ok: z.boolean(),
  blocking: z.array(z.string()),
  warnings: z.array(z.string()),
  stats: admissionStatsSchema,
});

/**
 * `CaseRunReport` 的校验器。
 *
 * 两个调用点：`core/report.ts` 的 `readReport()`（磁盘回读）与 `web/api.ts`
 * 的 `/api/runs/:id` 响应。**校验失败必须报错而不是降级**——读不出来的报告
 * 总比一份「看起来正常但实际错误」的报告好（同 `store/migrations.ts` 的第 2 条规则）。
 */
export const reportSchema: ZodType<CaseRunReport, CaseRunReport> = z.object({
  schemaVersion: z.literal(1),

  runId: z.string(),
  caseId: z.string(),
  caseRevision: z.number().int().nonnegative(),
  caseDigest: z.string(),
  suiteRunId: z.string().nullable(),
  engine: z.string(),

  startedAt: z.string(),
  finishedAt: z.string(),
  elapsedMs: z.number().nonnegative(),

  status: runStatusSchema,
  passed: z.boolean().nullable(),
  failureReason: z.string().nullable(),

  goal: z.string(),
  startUrl: z.string(),
  finalUrl: z.string().nullable(),
  finalFrame: z.number().int().nonnegative().nullable().optional(),

  steps: z.array(stepRecordSchema),
  guardrailHits: z.array(
    z.object({
      step: z.number().int().nonnegative(),
      reason: z.string(),
      action: z.string(),
    }),
  ),
  assertion: assertionResultSchema.nullable(),
  // 复用 events.ts 的 runStatsSchema：modelCalls 与 decisions 的口径
  // （含/不含重试）必须与事件侧完全一致，各写一份迟早分叉。
  stats: runStatsSchema,
  admission: admissionReportSchema.nullable(),

  artifacts: z.object({
    traceZip: z.string().nullable(),
    framesDir: z.string().nullable(),
    frozenCase: z.string(),
  }),
});

/**
 * `RunIndexEntry` 的校验器。
 *
 * 与 `reportSchema` 分开而不是合成一个联合：`index.jsonl` 的一行与 `run.json`
 * 是两份不同的文档，消费方也不同（列表页 vs 结果页）。
 * 合成联合会让「列表页拿到了完整报告」这种错误结构通过校验。
 */
export const runIndexEntrySchema: ZodType<RunIndexEntry, RunIndexEntry> = z.object({
  runId: z.string(),
  caseId: z.string(),
  caseTitle: z.string(),
  suiteRunId: z.string().nullable(),
  startedAt: z.string(),
  status: runStatusSchema,
  passed: z.boolean().nullable(),
  elapsedMs: z.number().nonnegative(),
  steps: z.number().int().nonnegative(),
  // 与报告同一纪律：未知就是 null，不能用 0 冒充（§5）。
  costUsd: z.number().nonnegative().nullable(),
});
