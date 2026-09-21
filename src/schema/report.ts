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

// TODO(P0): 实现 reportSchema（zod），用于磁盘回读校验与 /api 响应校验。
