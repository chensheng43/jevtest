/**
 * 报告：组装、落盘、导出。
 *
 * 目录布局（`runs/<runId>/`）：
 *   run.json      完整报告
 *   case.yaml     产生本次运行的用例**快照**——这是报告自包含的关键
 *   frames/*.jpg  按需截图（默认关闭）
 *   trace.zip     Playwright trace，`npx playwright show-trace` 可直接打开
 *
 * 另外维护 `runs/index.jsonl`：一行一条摘要，让列表页不必读完整报告。
 *
 * 两条必须坚持的事：
 *
 *   1. **报告自包含。** 内嵌用例快照与 revision/digest，因此事后翻出一份旧报告，
 *      能精确知道当时跑的是哪个版本的用例。用例改了之后旧报告的结论依然可解释。
 *      对应参考项目 measurement.json 里的 source_hashes，只是更正规。
 *
 *   2. **costUsd 为 null 时不写 0。** 引擎未报金额就用 null 表示「未知」。
 *      用 0 冒充会让成本统计悄悄失真，而成本正是这个平台最需要盯住的指标。
 */

import type { Case, CaseRevision } from "../schema/case.ts";
import type { CaseRunReport, RunIndexEntry } from "../schema/report.ts";

export interface PersistOptions {
  runsDir: string;
  /** 是否写 index.jsonl。批量运行时由 runner 统一写，避免并发追加交错 */
  writeIndex?: boolean;
}

/** 组装报告对象。不做 IO，便于在测试里断言结构。 */
export function buildReport(input: {
  runId: string;
  caseDef: Case;
  revision: CaseRevision;
  suiteRunId: string | null;
  engine: string;
  startedAt: string;
  finishedAt: string;
  status: CaseRunReport["status"];
  passed: boolean | null;
  failureReason: string | null;
  finalUrl: string | null;
  steps: CaseRunReport["steps"];
  guardrailHits: CaseRunReport["guardrailHits"];
  assertion: CaseRunReport["assertion"];
  stats: CaseRunReport["stats"];
  admission: CaseRunReport["admission"];
}): CaseRunReport {
  throw new Error("未实现：P0 待实现");
}

/** 落盘一份报告，返回报告目录的绝对路径。 */
export async function persistReport(report: CaseRunReport, options: PersistOptions): Promise<string> {
  throw new Error("未实现：P0 待实现");
}

/** 追加一行到 runs/index.jsonl。 */
export async function appendIndex(runsDir: string, entry: RunIndexEntry): Promise<void> {
  throw new Error("未实现：P0 待实现");
}

/** 读取 index.jsonl，按时间倒序。坏行跳过而不是让整个列表打不开。 */
export async function readIndex(runsDir: string): Promise<RunIndexEntry[]> {
  throw new Error("未实现：P0 待实现");
}

/** 读一份完整报告。 */
export async function readReport(runsDir: string, runId: string): Promise<CaseRunReport> {
  throw new Error("未实现：P0 待实现");
}

/**
 * 导出 Markdown 摘要，适合贴进 PR 或 issue。
 *
 * 必须包含：结论、每条断言的实际值与期望、步数与成本、trace 的打开方式。
 * 失败时还要带上最终页面的 URL 与关键元素的可见值——没有这些，一份失败报告
 * 对排查毫无帮助。
 */
export function toMarkdown(report: CaseRunReport): string {
  throw new Error("未实现：P0 待实现");
}

/**
 * 导出 JUnit XML，供 CI 消费。
 *
 * 映射要点：一个用例一个 `<testcase>`；断言失败映射为 `<failure>`，
 * 而**运行故障**（引擎不可达、浏览器崩溃）映射为 `<error>`——
 * 这个区分让 CI 上「测试失败」和「测试基建坏了」不会被混为一谈。
 * 被 skipped 的检查不产生 `<failure>`。
 */
export function toJUnit(reports: CaseRunReport[]): string {
  throw new Error("未实现：P1 待实现");
}

// TODO(P0): 实现 buildReport / persistReport / readReport / readIndex / toMarkdown。
//   persistReport 需要保证原子性：先写临时文件再 rename，
//   否则进程被中断会留下一个半截的 run.json，列表页读到就崩。
