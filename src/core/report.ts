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
 *
 * 分工（谁写什么，改这里之前先读 `store/cases.ts` 的 `FROZEN_CASE_FILE`）：
 *   - `case.yaml` 由**调用方**（cli/web 注入的 persist 回调）写，因为只有它同时
 *     看得见 `CaseStore` 与报告；本模块只把相对路径写进 `artifacts.frozenCase`。
 *   - `trace.zip` / `frames/` 由浏览器池在 run 结束时产出，因此**落盘那一刻**
 *     才知道有没有——本模块在写 `run.json` 之前实地看一眼（见 `persistReport`）。
 */

import { appendFile, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { reportSchema, runIndexEntrySchema } from "../schema/report.ts";
import { parseCase } from "../schema/yaml.ts";
import { FROZEN_CASE_FILE } from "../store/cases.ts";
import { migrateReportDocument } from "../store/migrations.ts";
import { STATUS_LABELS } from "./runner.ts";
import type { Case, CaseRevision } from "../schema/case.ts";
import type { CaseRunReport, CheckResult, RunIndexEntry, StepRecord, TerminalDecision } from "../schema/report.ts";

export interface PersistOptions {
  runsDir: string;
  /** 是否写 index.jsonl。批量运行时由 runner 统一写，避免并发追加交错 */
  writeIndex?: boolean;
}

// ---------------------------------------------------------------------------
// 目录布局常量
// ---------------------------------------------------------------------------

/** 完整报告的文件名 */
const REPORT_FILE = "run.json";
/** 摘要索引的文件名 */
const INDEX_FILE = "index.jsonl";
/** trace 文件名（`npx playwright show-trace` 认这个名字，不认目录） */
const TRACE_ZIP_FILE = "trace.zip";
/** 截图帧目录名 */
const FRAMES_DIR = "frames";

/**
 * 目录名的白名单正则。与 `web/api.ts` 的 `RUN_ID_PATTERN` 同口径——
 * runId 会直接拼进磁盘路径，放行 `..` 或分隔符就等于把写操作放出运行目录。
 * 校验放这里而不是只靠 web 层：`readReport` 也会被别的调用方（将来还有 CLI）用。
 */
const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

// ---------------------------------------------------------------------------
// 组装
// ---------------------------------------------------------------------------

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
  finalFrame: number | null;
  steps: CaseRunReport["steps"];
  terminalDecision: TerminalDecision | null;
  guardrailHits: CaseRunReport["guardrailHits"];
  assertion: CaseRunReport["assertion"];
  stats: CaseRunReport["stats"];
  admission: CaseRunReport["admission"];
}): CaseRunReport {
  return {
    schemaVersion: 1,

    runId: input.runId,
    caseId: input.caseDef.id,
    // identity 三件套**如实照抄**调用方给的值。cli 的 persist 回调会在落盘前
    // 用 `store.freeze()` 的返回值覆写它们（冻结发生在运行结束后，只有那里
    // 同时看得见用例仓库与报告目录），因此这里看到的可能还是初始值——
    // 那是调用方的事，本函数负责的是「不擅自修正」。
    caseRevision: input.revision.revision,
    caseDigest: input.revision.digest,
    suiteRunId: input.suiteRunId,
    engine: input.engine,

    startedAt: input.startedAt,
    finishedAt: input.finishedAt,
    elapsedMs: elapsedMsOf(input.startedAt, input.finishedAt, input.stats.elapsedMs),

    status: input.status,
    passed: input.passed,
    failureReason: input.failureReason,

    goal: input.caseDef.goal,
    startUrl: input.caseDef.startUrl,
    finalUrl: input.finalUrl,
    finalFrame: input.finalFrame,

    steps: input.steps,
    terminalDecision: input.terminalDecision,
    guardrailHits: input.guardrailHits,
    assertion: input.assertion,
    stats: input.stats,
    admission: input.admission,

    // 组装阶段**不做 IO**，因此无从知道 trace 与截图是否真的产出。
    // 先写 null（= 未知），由 `persistReport` 在落盘前实地看一眼再回填。
    // 反过来「先乐观写上 trace.zip」会让一份关掉 tracing 的运行在报告里
    // 自称有 trace——物证不能自证不存在的东西。
    artifacts: {
      traceZip: null,
      framesDir: null,
      frozenCase: FROZEN_CASE_FILE,
    },
  };
}

/**
 * 报告自己的墙钟耗时：两个 ISO 时间戳之差。
 *
 * 时间戳不可解析时退到计量器的读数（`stats.elapsedMs`），因为写进报告的
 * 只能是有限数——`NaN` 会让 `reportSchema` 校验失败，一份好报告就这么没了。
 * 上限取 0：时钟回拨（NTP 校时）时得到负数比得到 0 更难看，也会让 `nonnegative()` 拒绝。
 */
function elapsedMsOf(startedAt: string, finishedAt: string, fallbackMs: number): number {
  const from = Date.parse(startedAt);
  const to = Date.parse(finishedAt);
  if (Number.isNaN(from) || Number.isNaN(to)) return Math.max(0, Math.round(fallbackMs));
  return Math.max(0, to - from);
}

// ---------------------------------------------------------------------------
// 落盘
// ---------------------------------------------------------------------------

/** 落盘一份报告，返回报告目录的绝对路径。 */
export async function persistReport(report: CaseRunReport, options: PersistOptions): Promise<string> {
  const runsDir = resolve(options.runsDir);
  const reportDir = join(runsDir, requireRunId(report.runId));
  // cli 的回调通常已经建过一层（它要先冻结 case.yaml），这里再建一次是幂等的；
  // 独立调用（测试、将来的 CLI 单跑）时这一行是必需的。
  await mkdir(reportDir, { recursive: true });

  // 产物探测：报告目录里**实际**有什么就写什么。
  // trace 由池在 run 结束时写出，落在 persist 之前——但若将来改成在 persist 之后
  // 才 stop tracing（例如把 persist 挪进 `withSession` 回调里），这里会诚实地写 null，
  // 表现是「界面不显示 trace 入口」而不是「链接点开 404」。
  const doc: CaseRunReport = {
    ...report,
    artifacts: {
      ...report.artifacts,
      traceZip: (await isFile(join(reportDir, TRACE_ZIP_FILE))) ? TRACE_ZIP_FILE : null,
      framesDir: (await isDir(join(reportDir, FRAMES_DIR))) ? FRAMES_DIR : null,
    },
  };

  // 缩进 2 空格：报告是给人翻的物证，不是只在程序之间传的载荷。
  await writeFileAtomic(join(reportDir, REPORT_FILE), `${JSON.stringify(doc, null, 2)}\n`);

  // index 只在要求时写：批量运行时由 runner 统一调一次，各 worker 各写各的
  // 会让这一行与另一行交错成半截 JSON。
  if (options.writeIndex === true) {
    await appendIndex(runsDir, await indexEntryOf(doc, reportDir));
  }

  return reportDir;
}

/** 追加一行到 runs/index.jsonl。 */
export async function appendIndex(runsDir: string, entry: RunIndexEntry): Promise<void> {
  // 校验放在写入口而不是读出口：写进去一行没人读得懂的数据是**静默丢失**，
  // 而 readIndex 的「坏行跳过」会让它看起来只是「那条记录莫名不见了」。
  // 宁可在写的时候就大声抛错——那说明调用方与 `RunIndexEntry` 漂移了。
  const validated = runIndexEntrySchema.parse(entry);
  const indexPath = join(resolve(runsDir), INDEX_FILE);
  await mkdir(dirname(indexPath), { recursive: true });
  // 单次 appendFile 追加一行（远小于 PIPE_BUF），并发下也不会互相切开；
  // 万一真被切开，readIndex 会跳过那半行而不是让整个列表打不开。
  await appendFile(indexPath, `${JSON.stringify(validated)}\n`, "utf8");
}

/**
 * 读取 index.jsonl，按时间倒序。坏行跳过而不是让整个列表打不开。
 *
 * 「坏行」有两种：**不是合法 JSON**（写到一半被中断、或并发追加交错），
 * 以及 **JSON 合法但不满足 `RunIndexEntry`**（旧格式、或手工塞进去的杂物）。
 * 后者用 schema 判而不是只看两个字段：一份缺 `startedAt` 的条目排在列表里
 * 会显示成空白行，比不显示更让人困惑。
 */
export async function readIndex(runsDir: string): Promise<RunIndexEntry[]> {
  const indexPath = join(resolve(runsDir), INDEX_FILE);

  let text: string;
  try {
    text = await readFile(indexPath, "utf8");
  } catch (error) {
    // 一次都没跑过时文件不存在：空表是正确答案，不是错误。
    if (isErrno(error, "ENOENT")) return [];
    throw error;
  }

  const entries: RunIndexEntry[] = [];
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;

    let raw: unknown;
    try {
      raw = JSON.parse(trimmed) as unknown;
    } catch {
      continue; // 坏行：跳过，让列表仍然打得开（docs/report-format.md §1）
    }

    const parsed = runIndexEntrySchema.safeParse(withLegacyTokens(raw));
    if (!parsed.success) continue;
    entries.push(parsed.data);
  }

  // 倒序：最新的在最前。时间戳不可解析的条目按 0 处理，于是沉到列表末尾
  // ——它们仍然可见（不丢数据），但不干扰正常排序。`Array.sort` 稳定，
  // 时间相同的两条保持文件里的先后。
  return entries.sort((a, b) => timestampOf(b.startedAt) - timestampOf(a.startedAt));
}

/**
 * 加 `inputTokens` / `outputTokens` 之前写下的行没有这两个键。
 * 它们只是当时没记，不是坏行——补成 null（未知）让它们照常列出来，
 * 而不是被 schema 当坏行跳过、让历史凭空少一截。只补**缺失**的键，已有的值原样交给 schema 判。
 */
function withLegacyTokens(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const row = raw as Record<string, unknown>;
  if ("inputTokens" in row && "outputTokens" in row) return raw;
  return { inputTokens: null, outputTokens: null, ...row };
}

function timestampOf(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? 0 : value;
}

/** 读一份完整报告。 */
export async function readReport(runsDir: string, runId: string): Promise<CaseRunReport> {
  const reportPath = join(resolve(runsDir), requireRunId(runId), REPORT_FILE);

  let text: string;
  try {
    text = await readFile(reportPath, "utf8");
  } catch (error) {
    if (isErrno(error, "ENOENT")) {
      // 说得具体一点：列表页点进一份已被清理的报告时，这条消息是唯一线索。
      throw new Error(`报告不存在：${reportPath}（runId "${runId}" 没有落盘过，或运行目录已被清理）`);
    }
    throw error;
  }

  let document: unknown;
  try {
    document = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`${reportPath} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isPlainObject(document)) {
    throw new Error(`${reportPath} 的顶层必须是 JSON 对象，实际是 ${Array.isArray(document) ? "数组" : typeof document}`);
  }

  // **迁移必须在 zod 之前。** 旧版本的字段语义只有迁移链认识，而 `reportSchema`
  // 只认当前版本；顺序反了会把一份能读的旧报告判成损坏的报告。
  // 版本高于当前版本时由迁移层抛 `MigrationError`——**不做降级猜测**：
  // 静默按当前版本解析会得到一份「看起来正常但实际错误」的报告，比读不出来危险得多。
  const migrated = migrateReportDocument(document);

  const parsed = reportSchema.safeParse(migrated);
  if (!parsed.success) {
    // 逐条列出问题字段：`ZodError.message` 是一大坨 JSON，直接抛出去没人看得懂。
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.length === 0 ? "<根>" : issue.path.join(".")}: ${issue.message}`)
      .join("；");
    throw new Error(`${reportPath} 校验失败（${issues}）`);
  }

  return parsed.data;
}

/**
 * 从报告组装 `index.jsonl` 的一行。
 *
 * `caseTitle` 是唯一一个报告里没有的字段（`CaseRunReport` 只存 `caseId` 与 `goal`），
 * 而列表页需要给人看的标题。它就在旁边：`artifacts.frozenCase` 指向的那份冻结快照
 * 是完整的 `Case`（`store.freeze()` 写的就是它）。读不到时退到 `caseId`——
 * 标题只是展示，**绝不能让读标题失败毁掉一次已经成功的落盘**。
 */
async function indexEntryOf(report: CaseRunReport, reportDir: string): Promise<RunIndexEntry> {
  return {
    runId: report.runId,
    caseId: report.caseId,
    caseTitle: (await readFrozenTitle(reportDir, report.artifacts.frozenCase)) ?? report.caseId,
    suiteRunId: report.suiteRunId,
    startedAt: report.startedAt,
    status: report.status,
    passed: report.passed,
    elapsedMs: report.elapsedMs,
    steps: report.steps.length,
    inputTokens: report.stats.inputTokens,
    outputTokens: report.stats.outputTokens,
    // 与报告里同一纪律：未知就是 null，不能用 0 冒充。
    costUsd: report.stats.costUsd,
  };
}

async function readFrozenTitle(reportDir: string, frozenCase: string): Promise<string | null> {
  // 快照路径来自报告对象，理论上可能被塞进 `../../etc/passwd` 之类的东西。
  // 只认「报告目录下的一个文件名」这一种形态，不给拼接留余地。
  if (!/^[a-zA-Z0-9_.-]{1,64}$/.test(frozenCase) || frozenCase.startsWith(".")) return null;
  try {
    const parsed = parseCase(await readFile(join(reportDir, frozenCase), "utf8"), "用例快照");
    return parsed.title;
  } catch {
    return null;
  }
}

/**
 * 临时文件 + rename 的原子写。
 *
 * 直接 `writeFile(run.json)` 时进程被中断会留下一份**半截 JSON**，而它要等到
 * 下次有人打开界面才炸——那时离真正的故障点已经很远了。
 *
 * 退化路径是给 Windows 准备的：目标文件已存在且被杀毒软件/索引器/编辑器占用时，
 * `rename` 会因为 `EPERM` / `EACCES` / `EEXIST` 失败（POSIX 的 rename 则是原子覆盖）。
 * 此时先删目标再 rename——多了一个微小的窗口期，但好过整份报告写不出去。
 * 与 `store/cases.ts` 的 `writeFileAtomic` 同一套做法（那边不能 import 过来，没有导出）。
 */
async function writeFileAtomic(destination: string, data: string): Promise<void> {
  // 临时文件与目标同目录（保证同分区），名字带 pid 与序号（同一进程内不撞车）
  const temp = `${destination}.tmp-${process.pid}-${(tempCounter++).toString(36)}`;
  try {
    await writeFile(temp, data, "utf8");
    try {
      await rename(temp, destination);
      return;
    } catch (error) {
      if (!isReplaceBlocked(error)) throw error;
      await rm(destination, { force: true });
      await rename(temp, destination);
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined); // 失败的残骸不留在报告目录里
    throw error;
  }
}

let tempCounter = 0;

/** Windows 上「目标已存在且被占用」时 rename 的失败码 */
function isReplaceBlocked(error: unknown): boolean {
  return isErrno(error, "EPERM") || isErrno(error, "EEXIST") || isErrno(error, "EACCES");
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 存在且是普通文件 */
async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** 存在且是目录 */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

function requireRunId(runId: string): string {
  if (!RUN_ID_PATTERN.test(runId)) {
    throw new Error(`非法的 runId：${JSON.stringify(runId)}（只允许字母、数字、下划线与短横，长度 1-128）`);
  }
  return runId;
}

// ---------------------------------------------------------------------------
// 导出：Markdown
// ---------------------------------------------------------------------------

/**
 * 检查项的三态文案。
 *
 * **`skipped` 必须先判**：被跳过的检查在数据上是 `passed: false`（三态由两个字段
 * 合起来表达），先看 `passed` 就会把它印成「失败」，而先看 `passed: true`
 * 的写法（或把 skipped 当 passed）会把它印成「通过」——后者正是 D9 要杜绝的谎报覆盖。
 */
function checkLabel(check: CheckResult): string {
  if (check.skipped) return "跳过";
  return check.passed ? "通过" : "失败";
}

/** 断言整体判决的三态文案。`assertion` 自身为 null 与 `passed` 为 null 是两件事。 */
function verdictLabel(report: CaseRunReport): string {
  if (report.assertion === null) {
    return "**未求值**——断言层根本没有运行（例如预算在第一步之前就耗尽，没有最终页面可断言）";
  }
  if (report.assertion.passed === false) return "**失败**";
  if (report.assertion.passed === true) return "**通过**";
  return "**未判定**——没有失败的检查，但有检查无法求值（被跳过的项没有被验证，因此不构成通过）";
}

function passedSummary(checks: [string, CheckResult][]): string {
  const count = (fn: (c: CheckResult) => boolean): number => checks.filter(([, c]) => fn(c)).length;
  return `通过 ${count((c) => c.passed && !c.skipped)} · 失败 ${count((c) => !c.passed && !c.skipped)} · 跳过 ${count((c) => c.skipped)}`;
}

function statusLabel(report: CaseRunReport): string {
  // 状态名到中文的映射与界面共用 `runner.ts` 的 STATUS_LABELS：两处各写一份，
  // 加一个状态时必然漏掉一处，而漏掉的那处会显示成空白。
  return `${STATUS_LABELS[report.status]}（\`${report.status}\`）`;
}

function duration(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`;
}

function money(costUsd: number | null): string {
  // 未知就是未知，绝不写成 $0——成本统计里「0」与「不知道」是两种结论。
  return costUsd === null ? "未知（引擎未报金额）" : `$${costUsd.toFixed(4)}`;
}

/** 表格单元格：换行会把版式撑坏，竖线会把表格切碎。detail 已是单行，这里只管竖线。 */
function cell(text: string): string {
  return text.replace(/\|/g, "\\|");
}

/** 内联代码：反引号在 detail 里出现时会截断代码段，因此换成长度足够的围栏。 */
function code(text: string): string {
  const fence = text.includes("`") ? "``" : "`";
  return `${fence}${text}${fence}`;
}

/**
 * 导出 Markdown 摘要，适合贴进 PR 或 issue。
 *
 * 必须包含：结论、每条断言的实际值与期望、步数与成本、trace 的打开方式。
 * 失败时还要带上最终页面的 URL 与关键元素的可见值——没有这些，一份失败报告
 * 对排查毫无帮助。
 *
 * 「实际值与期望」不在这里另算一遍：`CheckResult.detail` 就是为这件事写的
 * （`core/checks.ts` 每条 pass / fail 都把两个值写进了句子）。在这里重新拼一遍
 * 相当于把求值逻辑复制到导出层，两边迟早不一致。
 */
export function toMarkdown(report: CaseRunReport): string {
  const lines: string[] = [];
  const checks = report.assertion === null ? [] : Object.entries(report.assertion.checks);
  const stats = report.stats;

  lines.push(`# 运行报告：${report.caseId}`);
  lines.push("");
  lines.push(`**结论：${statusLabel(report)}｜断言 ${verdictLabel(report)}**`);
  lines.push("");
  lines.push(
    `- 用例：${code(report.caseId)} revision ${report.caseRevision}（digest ${code(shortDigest(report.caseDigest))}）` +
      `｜批量运行：${report.suiteRunId === null ? "单跑" : code(report.suiteRunId)}`,
  );
  lines.push(`- 引擎：${code(report.engine)}｜目标：${code(report.startUrl)}`);
  lines.push(`- 时间：${report.startedAt} → ${report.finishedAt}（${duration(report.elapsedMs)}）`);
  lines.push(
    `- 步数与成本：${report.steps.length} 步 · 模型调用 ${stats.modelCalls} 次（${stats.decisions} 次决策，含 ${retries(stats)} 次重试）` +
      ` · input ${stats.inputTokens} / output ${stats.outputTokens} tokens · 成本 ${money(stats.costUsd)}`,
  );
  if (checks.length > 0) lines.push(`- 检查项：${passedSummary(checks)}`);
  if (report.failureReason !== null) lines.push(`- 失败原因：${report.failureReason}`);

  // 准入的阻断项放在顶部显著位置：它是「这个用例适不适合本平台」的警告，
  // 虽然**不阻止运行**（docs/report-format.md §2.4），但被埋到文末就没人看见。
  if (report.admission !== null && (report.admission.blocking.length > 0 || report.admission.warnings.length > 0)) {
    lines.push("", "## 准入警告（不影响本次运行）", "");
    for (const item of report.admission.blocking) lines.push(`- **阻断**：${item}`);
    for (const item of report.admission.warnings) lines.push(`- 警告：${item}`);
  }

  // -------------------------------------------------------------------------
  // 断言明细
  // -------------------------------------------------------------------------
  lines.push("", "## 断言明细", "");
  if (report.assertion === null) {
    lines.push(
      "断言层未运行（`assertion` 为 null）——这**不是失败**，而是「这次没能验证」。",
      "常见原因是预算在第一步之前就耗尽，或运行故障导致没有可断言的最终页面。",
    );
  } else if (checks.length === 0) {
    lines.push("这份用例没有声明任何断言：跑完了，但没有任何证据说明结果对不对（判决为未判定）。");
  } else {
    lines.push("| 路径 | 结果 | 实际值与期望 |", "| --- | --- | --- |");
    for (const [key, check] of checks) {
      lines.push(`| ${code(key)} | ${checkLabel(check)} | ${cell(check.detail)} |`);
    }
    if (checks.some(([, c]) => c.skipped)) {
      lines.push(
        "",
        "> 「跳过」= 无法求值，**既不算通过也不算失败**；有跳过项时整体判决为「未判定」。",
        "> 把它读成「通过」就是谎报覆盖——我们确实没有验证那一条。",
      );
    }
  }

  // -------------------------------------------------------------------------
  // 失败排查
  // -------------------------------------------------------------------------
  if (report.passed !== true) {
    lines.push("", "## 失败排查", "");
    lines.push(
      `- 最终页面 URL：${report.finalUrl === null ? "**未观测到**（运行在观测到页面之前就结束，或浏览器已不可用）" : code(report.finalUrl)}`,
    );

    const controls = controlDetails(checks);
    if (controls.length === 0) {
      lines.push("- 关键元素的可见值：本次断言没有涉及 `final.controls[...]`（或元素表里没有可用的值）。");
    } else {
      lines.push("- 关键元素的可见值（取自断言详情，元素没有该属性时会在句子里说明）：");
      for (const group of controls) {
        lines.push(`  - ${code(group.path)} —— ${group.verdict}`);
        for (const detail of group.details) lines.push(`    - ${detail}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 轨迹
  // -------------------------------------------------------------------------
  if (report.steps.length > 0) {
    lines.push("", `## 轨迹（${report.steps.length} 步）`, "");
    lines.push("| 步 | 动作 | 类型 | 目标 | 执行 | 页面变化 | 耗时 |", "| --- | --- | --- | --- | --- | --- | --- |");
    for (const step of report.steps) {
      lines.push(
        `| ${step.step} | ${cell(step.action)} | ${step.kind} | ${step.target === null ? "—" : cell(step.target)}` +
          ` | ${executionLabel(step)} | ${pageChangedLabel(step)} | ${step.engineLatencyMs + step.textLatencyMs}ms |`,
      );
      // 实际输入的文本是排查 TYPE_TEXT 时的第一现场，摘要里带上它。
      if (step.text !== null) {
        const engine = step.textEngine === null ? "" : `（由 ${step.textEngine} 生成）`;
        lines.push(`| | ↳ 输入 ${cell(step.text)}${cell(engine)} | | | | | |`);
      }
    }
  }
  // 终止决策不在轨迹表里（它没执行动作），但「模型凭多大把握说完成了」是排查提前结束的第一现场
  const terminal = report.terminalDecision ?? null;
  if (terminal !== null) {
    lines.push("", terminalDecisionLine(terminal));
  }

  if (report.guardrailHits.length > 0) {
    lines.push("", `## 护栏命中（${report.guardrailHits.length} 次）`, "");
    lines.push("命中即**浏览器没有收到输入**，是安全网起作用的结果，不一定是坏事（见 docs/report-format.md §2.4）：");
    for (const hit of report.guardrailHits) {
      lines.push(`- 第 ${hit.step} 步「${hit.action}」：${hit.reason}`);
    }
  }

  // -------------------------------------------------------------------------
  // 产物
  // -------------------------------------------------------------------------
  // 路径是**相对报告目录**的（`runs/<runId>/`），因此这里拼出来的路径在默认
  // 运行目录下可以直接照抄执行；换了 `--out` 就把前缀换掉。
  const reportDir = `runs/${report.runId}`;
  lines.push("", "## 产物", "");
  if (report.artifacts.traceZip === null) {
    lines.push("- trace：本次未录制（`artifacts.traceZip` 为 null）。排查时只能靠上面的轨迹与断言详情。");
  } else {
    lines.push(`- trace：\`npx playwright show-trace ${reportDir}/${report.artifacts.traceZip}\``);
    lines.push(`  - 也可以直接在浏览器里打开 <https://trace.playwright.dev/> 后拖入该文件`);
  }
  if (report.artifacts.framesDir !== null) {
    lines.push(`- 截图帧：${code(`${reportDir}/${report.artifacts.framesDir}/`)}（序号对应轨迹表的「步」）`);
  }
  lines.push(`- 用例快照：${code(`${reportDir}/${report.artifacts.frozenCase}`)}（产生本次运行的用例版本，报告因此自包含）`);

  return `${lines.join("\n")}\n`;
}

function retries(stats: CaseRunReport["stats"]): number {
  // modelCalls 数的是含重试的实际请求数，decisions 是逻辑决策数，
  // 两者之差就是重试造成的额外请求——这是判断「问题在网络」的读数。
  return Math.max(0, stats.modelCalls - stats.decisions);
}

function shortDigest(digest: string): string {
  return digest.length <= 12 ? digest : `${digest.slice(0, 12)}…`;
}

function executionLabel(step: StepRecord): string {
  if (step.executed) return "已执行";
  return `被护栏拦下（${step.blockReason ?? "原因未记录"}）`;
}

/** 例：`第 5 步模型回 DONE 结束了运行：操作概率 0.62（CLICK 0.30 / WAIT 0.08），置信 0.55` */
function terminalDecisionLine(terminal: TerminalDecision): string {
  const head = `第 ${terminal.step} 步模型回 **${terminal.operation}** 结束了运行`;
  if (terminal.distribution === "degenerate") {
    return `${head}（引擎只给了单一选择，没有真实概率可看）`;
  }
  const others = Object.entries(terminal.operationProbabilities)
    .filter(([operation]) => operation !== terminal.operation)
    .sort(([, a], [, b]) => b - a)
    .map(([operation, probability]) => `${operation} ${probability.toFixed(2)}`);
  return (
    `${head}：操作概率 ${terminal.operationProbability.toFixed(2)}` +
    (others.length > 0 ? `（${others.join(" / ")}）` : "") +
    `，置信 ${terminal.confidence.toFixed(2)}`
  );
}

function pageChangedLabel(step: StepRecord): string {
  // 三态：null 是「没能观测」（例如导航打断了观测），不是「没有变化」。
  if (step.pageChanged === null) return "未观测";
  return step.pageChanged ? "有变化" : "无变化";
}

interface ControlGroup {
  path: string;
  verdict: string;
  details: string[];
}

/**
 * 从检查项里挑出 `final.controls[i]` 那一族，供失败报告展示「关键元素的可见值」。
 *
 * 只列**没有全过**的元素：一份失败报告里，把十来个通过的控件也铺开只会淹没线索。
 * 元素的实际可见值就在 `.exists` 那条的 detail 里（`已定位到元素：label「...」 value=「...」`），
 * 因此这里优先取它，再补上真正失败的属性条目。
 */
function controlDetails(checks: [string, CheckResult][]): ControlGroup[] {
  const groups = new Map<string, { verdicts: string[]; details: string[]; exists: string | null }>();

  for (const [key, check] of checks) {
    const matched = /^(final\.controls\[\d+\])(\.|$)/.exec(key);
    if (matched === null) continue;
    const path = matched[1] ?? key;
    const group = groups.get(path) ?? { verdicts: [], details: [], exists: null };

    if (key === `${path}.exists`) {
      group.exists = check.detail;
    } else {
      group.details.push(`\`${key.slice(path.length + 1)}\`（${checkLabel(check)}）：${check.detail}`);
    }
    if (!check.passed || check.skipped) {
      group.verdicts.push(check.skipped ? "跳过" : "失败");
    } else {
      group.verdicts.push("通过");
    }
    groups.set(path, group);
  }

  const out: ControlGroup[] = [];
  for (const [path, group] of groups) {
    const failed = group.verdicts.some((v) => v !== "通过");
    if (!failed) continue;
    const verdict = group.verdicts.includes("失败") ? "失败" : "跳过（未验证）";
    // `<exists>` 那条永远排在前面：它带着定位到的元素 label / role / value。
    const details = group.exists === null ? group.details : [`定位结果：${group.exists}`, ...group.details];
    out.push({ path, verdict, details });
  }
  return out;
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
