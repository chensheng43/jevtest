#!/usr/bin/env node
/**
 * 命令行入口。
 *
 * 两个用途：
 *   1. `serve` 启动 Web 平台；
 *   2. `run` / `validate` 供 CI 使用——CI 不该依赖一个需要人点的界面。
 *
 * 脚手架阶段本文件刻意保持无导入，好让「依赖还没装」时 `--help` 也能跑。
 * 实现之后这条不再成立（装配链必然要 import 各层），但**顺序**保留了下来：
 * `--help` 与参数错误在任何重活之前返回，不会去碰磁盘、浏览器或网络。
 *
 * 装配顺序（脚手架末尾列过，这里逐一对应）：
 *     1. `process.loadEnvFile()`（若存在 .env）
 *     2. `settings = loadSettings()`
 *     3. doctor / validate 在此就能返回，**不必启动浏览器**
 *     4. `pool = createBrowserPool(...)`
 *     5. `runner = createRunnerService(...)`
 *     6. serve  -> `createServer(...).listen(port)`
 *        run    -> `runner.enqueueMany(...)`，等全部结束后输出报告
 *
 * ## CLI 走进程内调用，不绕 HTTP
 *
 * `docs/api.md` 开头写的是「`jevtest doctor` 打 `/api/health`，`jevtest run` 走
 * `/api/runs`」。实现上这两条都落在**同一个 handler**（`web/api.ts` 的 `handle()`）
 * 上，但**不经过真实 HTTP**：
 *
 *   - `run` 直接调 runner：为了跑一个用例去绑一个端口、生成一个令牌、再让
 *     浏览器都还没起的情况下的 HTTP 服务转发一次，只增加失败面。CI 里并行
 *     跑多个 jevtest 时还会撞端口。
 *   - `doctor` 调 `handle({path: "/api/health"})`：走的确实是那个端点，
 *     只是不经网络——它要检查的是配置与依赖，不是 TCP。
 *
 * 于是「前端与 CLI 共用同一套」这条**在语义上成立**（同一份路由与业务逻辑），
 * 在传输层不成立。这是一处与文档措辞的偏离，已记在交付报告里。
 */

import { access, mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { existsSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { CaseDefinitionSchema } from "./schema/case.ts";
import type { Case, CaseDefinition } from "./schema/case.ts";
import type { CaseRunReport } from "./schema/report.ts";
import { caseDigest, parseCase, stringifyCase } from "./schema/yaml.ts";
import { loadSettings, missingCredentials } from "./config.ts";
import type { Settings } from "./config.ts";
import { createBrowserPool } from "./browser/pool.ts";
import type { BrowserPool } from "./browser/pool.ts";
import { createEngine, listEngines } from "./engine/registry.ts";
import type { DecisionEngine } from "./engine/types.ts";
import { CASE_ID_PATTERN, CaseNotFound, FROZEN_CASE_FILE, createCaseStore } from "./store/cases.ts";
import type { CaseStore } from "./store/cases.ts";
import { STATUS_LABELS, createRunnerService } from "./core/runner.ts";
import type { RunnerService } from "./core/runner.ts";
import { persistReport, readReport, toJUnit, toMarkdown } from "./core/report.ts";
import { configureApi, handle } from "./web/api.ts";
import type { Services } from "./web/api.ts";
import { createEventRouter } from "./web/events.ts";
import { createServer } from "./web/server.ts";
import { createToken } from "./web/security.ts";

const USAGE = `jevtest —— 基于快速自主决策的 Web 测试套件平台

用法:
  jevtest serve                     启动 Web 平台（默认 http://127.0.0.1:8770）
  jevtest run <用例...>             在命令行跑用例，输出 JSON 报告
  jevtest validate <用例...>        只校验用例文件，不运行、不调用模型
  jevtest import <文件...>          把 YAML 导入用例库
  jevtest doctor                    检查环境：Node、Chromium、凭证、目录可写

选项:
  --port <n>                        serve 的端口
  --workers <n>                     worker 并发度（默认 1，即串行）
  --out <目录>                      报告输出目录
  --format <json|md|junit>          run 的输出格式
  -h, --help                        显示本帮助

示例:
  jevtest serve
  jevtest run cases/wikipedia-godel.yaml
  jevtest validate cases/*.yaml

环境变量见 .env.example。凭证只从环境读取，绝不写入报告。`;

/** 已识别的子命令。 */
const COMMANDS = ["serve", "run", "validate", "import", "doctor"] as const;
type Command = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: Command | null;
  operands: string[];
  flags: Record<string, string | boolean>;
}

/**
 * 退出码。CI 靠它判断成败，因此必须与「测试失败」和「基建故障」的区分一致
 * （见 `docs/report-format.md` §3 与 `toJUnit` 的 `<failure>` / `<error>` 映射）。
 */
export const EXIT = {
  /** 全部用例 passed === true */
  ok: 0,
  /** 有失败，或**有未能判定的检查**（`passed: null` 不算通过，见 D9） */
  failed: 1,
  /** 用法错误：未知子命令、参数非法、用例文件不存在或校验失败 */
  usage: 3,
  /** 运行故障：引擎不可达、浏览器崩溃这类**基建问题**，不是用例问题 */
  error: 4,
} as const;

export function parseArgs(argv: string[]): ParsedArgs {
  const [head, ...tail] = argv;
  if (head === "-h" || head === "--help" || head === undefined) {
    return { command: null, operands: [], flags: { help: true } };
  }
  if (!(COMMANDS as readonly string[]).includes(head)) {
    throw new Error(`未知子命令: ${head}\n\n${USAGE}`);
  }

  const operands: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tail.length; i += 1) {
    const arg = tail[i];
    if (arg?.startsWith("--")) {
      const name = arg.slice(2);
      const next = tail[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else if (arg !== undefined) {
      operands.push(arg);
    }
  }
  return { command: head as Command, operands, flags };
}

// ---------------------------------------------------------------------------
// 装配
// ---------------------------------------------------------------------------

/**
 * 一次 `run` 用到的全部依赖。
 *
 * 单独抽出来是因为 `run` 与 `serve` 需要同一套东西，而 `doctor` / `validate`
 * 只需要其中一部分——它们的装配路径刻意更短（不开浏览器、不建 runner）。
 */
export interface Wiring {
  settings: Settings;
  store: CaseStore;
  pool: BrowserPool;
  runner: RunnerService;
  services: Services;
}

/**
 * 装配时的可注入项。
 *
 * 唯一的使用者是测试：e2e 用**同一个装配入口**跑一遍真浏览器 + scripted 引擎，
 * 因此「测试里的接线」与「生产里的接线」是同一份代码。各写一套的话，
 * 漂移只会发生在测试覆盖不到的那一侧——而那一侧才是线上跑的那套。
 */
export interface WiringOverrides {
  /** 注入点就是 `RunnerDeps.createEngine`，见 architecture §11.1 ④ */
  createEngine?: (caseDef: Case) => DecisionEngine;
}

/**
 * 文件形态的一次性运行（`jevtest run path/to.yaml`）的快照。
 *
 * 用例仓库里的用例由 `store.freeze()` 冻结；而**文件形态的用例根本不在仓库里**
 * （仓库的布局是 `cases/<id>/case.yaml`，用户手上的可能就是一个独立 YAML）。
 * 这两种情形都要让报告自包含（D13），所以文件形态的规范化 YAML 在这里留一份，
 * 由 persist 回调写进 `runs/<runId>/case.yaml`。
 */
export type FileSnapshot = { yaml: string; digest: string };

export function createWiring(
  settings: Settings,
  fileSnapshots: Map<string, FileSnapshot> = new Map(),
  overrides: WiringOverrides = {},
): Wiring {
  const store = createCaseStore({ root: settings.casesDir, runsDir: settings.runsDir });
  const events = createEventRouter();
  const pool = createBrowserPool({
    // 字段名与 Settings 一一对应，映射只在这一处完成——池里不再写一遍默认值，
    // 否则会出现「改了环境变量却没生效」这种最难查的问题。
    maxContexts: settings.workers,
    maxEngineInflight: settings.maxEngineInflight,
    headless: settings.headless,
  });

  /**
   * 报告落盘 + 用例快照。
   *
   * **identity 三件套在这里定稿**：runner 拿到报告时只有它自己拥有的
   * `runId` / `suiteRunId`，而 `caseRevision` / `caseDigest` 只有同时看得见
   * 用例仓库与报告目录的这里才算得出来（`RunnerDeps.persist` 正是为此留的注入点）。
   */
  const persist = async (report: CaseRunReport, ran: Case): Promise<void> => {
    const reportDir = join(settings.runsDir, report.runId);
    await mkdir(reportDir, { recursive: true });
    const snapshotPath = join(reportDir, FROZEN_CASE_FILE);

    try {
      // 仓库里的用例：冻结**实际跑的那份**（入队时的 Case），revision 按 digest 反查。
      // 冻结仓库的当前版本是错的：运行期间用例被改过的话，报告会指向一个没跑过的版本。
      const revision = await store.freeze(report.caseId, snapshotPath, ran);
      report.caseRevision = revision.revision;
      report.caseDigest = revision.digest;
    } catch (error) {
      // 仓库里读不到：文件形态的一次性运行，或用例在运行期间被删掉/改坏了。
      // 手里都有实际跑的那份 Case，快照照写；revision 记 0（「未入库 / 对不上库里的版本」）。
      // 这里不能往外抛：报告本身比快照重要，快照出问题也要让下面的报告落盘。
      const snapshot = fileSnapshots.get(report.caseId);
      await writeFile(snapshotPath, snapshot?.yaml ?? stringifyCase(ran), "utf8");
      report.caseRevision = 0;
      report.caseDigest = snapshot?.digest ?? caseDigest(ran);
      if (snapshot === undefined) {
        console.warn(
          `[jevtest] 警告：用例 ${report.caseId} 在仓库里不可读（${error instanceof Error ? error.message : String(error)}），` +
            `快照取自运行时的那份定义。`,
        );
      }
    }

    // writeIndex 由这里统一写：各 worker 各写各的会让 index.jsonl 交错出坏行。
    await persistReport(report, { runsDir: settings.runsDir, writeIndex: true });
    // 报告已落盘，事件日志可以按保留上限淘汰了。
    events.retire(report.runId);
  };

  const runner = createRunnerService({
    pool,
    settings,
    // 每个用例一个引擎实例，跑完 close——关闭时机与用例生命周期一致。
    createEngine: overrides.createEngine ?? ((caseDef: Case) => createEngine(caseDef, settings)),
    persist,
    events: events.sink,
  });

  const services: Services = { settings, store, runner, pool, events };
  return { settings, store, pool, runner, services };
}

/** 加载 .env（存在才加载）。凭证只从环境读，绝不进前端、报告或日志。 */
function loadDotEnv(): void {
  const path = resolve(process.cwd(), ".env");
  if (!existsSync(path)) return;
  try {
    process.loadEnvFile(path);
  } catch (error) {
    console.warn(
      `[jevtest] 警告：读 .env 失败（${error instanceof Error ? error.message : String(error)}），继续用现有环境变量。`,
    );
  }
}

/** 应用 CLI 覆写项到 Settings。**只有这一处**做覆写，避免「两个事实来源」。 */
function applyFlags(settings: Settings, flags: Record<string, string | boolean>): Settings {
  const next = { ...settings };

  const positiveInt = (name: string, value: string | boolean | undefined): number | null => {
    if (value === undefined) return null;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < 1) {
      throw new Error(`--${name} 必须是正整数（收到 ${String(value)}）`);
    }
    return parsed;
  };

  const port = positiveInt("port", flags["port"]);
  if (port !== null) next.port = port;
  const workers = positiveInt("workers", flags["workers"]);
  if (workers !== null) next.workers = workers;
  if (typeof flags["out"] === "string") next.runsDir = resolve(flags["out"]);

  return next;
}

// ---------------------------------------------------------------------------
// 子命令
// ---------------------------------------------------------------------------

/**
 * `serve`：启动 Web 平台。
 *
 * 停机顺序：`server.close()` 里先 `runner.stop()` 再关 HTTP（见 `web/server.ts`）。
 * 反过来的话，用例跑完了却没法把报告响应给任何人。
 */
async function commandServe(argv: ParsedArgs): Promise<number> {
  const settings = applyFlags(loadSettings(), argv.flags);
  // serve 不跑文件形态用例，快照表留空——仓库里的用例走 store.freeze。
  // 浏览器池只用 createWiring 里那一个：runner 与 /admit 借的都是它，
  // 在这里另建一个的话，预热的是一个没人用的 Chromium。
  const { runner, pool, services } = createWiring(settings, new Map());

  const security = {
    token: createToken(),
    port: settings.port,
    origin: `http://127.0.0.1:${settings.port}`,
  };

  await pool.start();
  runner.start();

  const server = createServer({ settings, security, services });
  const port = await server.listen(settings.port);
  console.log(`jevtest 平台已启动：http://127.0.0.1:${port}`);
  console.log(`用例库 ${settings.casesDir}；运行产物 ${settings.runsDir}`);
  console.log(`worker ${settings.workers} 个；引擎 ${settings.defaultEngine}`);
  console.log("按 Ctrl+C 停机（会等在途用例走到步边界）。");

  await new Promise<void>((resolvePromise) => {
    const shutdown = (): void => {
      console.log("\n正在停机……");
      resolvePromise();
    };
    process.once("SIGINT", shutdown);
    process.once("SIGTERM", shutdown);
  });

  await server.close();
  // server.close() 里已经 runner.stop()，但 pool 可能在启动失败时仍持有进程句柄，
  // 这里再兜一次；stop() 幂等。
  await pool.stop();
  return EXIT.ok;
}

/** `run`：跑用例并输出报告。 */
async function commandRun(argv: ParsedArgs): Promise<number> {
  if (argv.operands.length === 0) {
    console.error(`run 需要一个或多个用例（文件路径或用例 id）。\n\n${USAGE}`);
    return EXIT.usage;
  }

  const settings = applyFlags(loadSettings(), argv.flags);
  const missing = missingCredentials(settings);
  if (missing.length > 0) {
    console.error(`缺少必需凭证：${missing.join("、")}\n请编辑 .env 后重试（见 .env.example）。`);
    return EXIT.usage;
  }

  const format = typeof argv.flags["format"] === "string" ? argv.flags["format"] : "json";
  if (!["json", "md", "junit"].includes(format)) {
    console.error(`未知 --format：${format}（可选 json / md / junit）`);
    return EXIT.usage;
  }
  if (format === "junit") {
    console.error("JUnit 导出尚未实现（P1，见 core/report.ts 的 toJUnit）。暂时用 --format md。");
    return EXIT.usage;
  }

  const fileSnapshots = new Map<string, FileSnapshot>();
  const { runner, pool, store } = createWiring(settings, fileSnapshots);

  let cases: Case[];
  try {
    cases = await loadCases(argv.operands, store, fileSnapshots);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT.usage;
  }

  await pool.start();
  runner.start();

  const { runIds } = runner.enqueueMany(cases);
  process.once("SIGINT", () => {
    console.error("\n收到中断，请求取消（在下一个步边界生效）……");
    runner.cancelAll();
  });

  const unfinished = await waitForRuns(runner, runIds.length, cases, settings);
  if (unfinished) {
    console.error("等待超时，已请求取消。候选原因是引擎长时间无响应——已产生的轨迹仍会落盘。");
  }

  await runner.stop();

  const reports: CaseRunReport[] = [];
  const unreadable: string[] = [];
  for (const runId of runIds) {
    try {
      reports.push(await readWithRetry(settings.runsDir, runId));
    } catch (error) {
      unreadable.push(`${runId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (format === "md") {
    console.log(reports.map((report) => toMarkdown(report)).join("\n\n---\n\n"));
  } else {
    console.log(JSON.stringify(reports.length === 1 ? reports[0] : reports, null, 2));
  }
  for (const line of unreadable) console.error(`读不到报告 ${line}`);

  // 退出码：`passed: null`（有检查无法求值）不算通过——判 0 就是 D9 要杜绝的谎报覆盖。
  const engineErrors = reports.filter((report) => report.status === "error").length;
  const notPassed = reports.filter((report) => report.passed !== true).length;
  if (reports.length === 0) return EXIT.error;
  if (engineErrors > 0 && notPassed === engineErrors) {
    // 全部失败都是基建故障：CI 上要区别于「测试失败」，否则会去查根本不存在的问题。
    return EXIT.error;
  }
  return notPassed === 0 && unreadable.length === 0 ? EXIT.ok : EXIT.failed;
}

/**
 * 从操作数加载用例。
 *
 * 两种形态：
 *   - **文件路径**（存在且以 .yaml/.yml 结尾）：直接读盘解析，不碰用例仓库。
 *     快照另存一份，好让报告自包含（见 `FileSnapshot`）。
 *   - **用例 id**（形如 `wikipedia-godel`）：从用例仓库读，revision/digest 由仓库给出。
 */
async function loadCases(
  operands: string[],
  store: CaseStore,
  fileSnapshots: Map<string, FileSnapshot>,
): Promise<Case[]> {
  const cases: Case[] = [];
  for (const operand of operands) {
    const path = resolve(operand);
    const looksLikeFile = /\.ya?ml$/i.test(operand) || existsSync(path);

    if (looksLikeFile) {
      if (!existsSync(path)) {
        throw new Error(`用例文件不存在：${path}`);
      }
      const text = await readFile(path, "utf8");
      const definition = parseCase(text, path);
      const parsed = CaseDefinitionSchema.parse(definition);
      if (parsed.id === undefined || parsed.id === "") {
        throw new Error(`用例文件缺少 id，无法生成运行身份：${path}`);
      }
      // 规范化后再存快照：报告里的字节与「表单保存」走同一套序列化，digest 才可比。
      fileSnapshots.set(parsed.id, { yaml: stringifyCase(parsed), digest: caseDigest(parsed) });
      cases.push(parsed);
      continue;
    }

    if (!CASE_ID_PATTERN.test(operand)) {
      throw new Error(
        `既不是存在的文件，也不是合法的用例 id：${operand}\n` +
          `（用例 id 形如 wikipedia-godel；文件请写全路径或相对路径）`,
      );
    }
    try {
      const loaded = await store.read(operand);
      cases.push(CaseDefinitionSchema.parse(loaded.def));
    } catch (error) {
      if (error instanceof CaseNotFound) throw new Error(`用例仓库里没有 ${operand}`);
      throw error;
    }
  }
  return cases;
}

/**
 * 等队列排空。
 *
 * `RunnerService` 没有「等全部结束」的接口（它只是队列 + worker），因此这里轮询
 * `status()`。超时上限按**用例自己声明的预算之和**推算，而不是拍一个常数：
 * 一个 `maxElapsedMs: 300000` 的用例本来就可能跑 5 分钟，用固定的 60 秒去等它
 * 只会误判成「卡住」。
 */
async function waitForRuns(
  runner: RunnerService,
  expected: number,
  cases: Case[],
  settings: Settings,
): Promise<boolean> {
  const budgetMs = cases.reduce((sum, item) => sum + item.budget.maxElapsedMs, 0);
  // 加一分钟余量：报告落盘、浏览器启停、以及引擎重试的退避都在这段里。
  const deadline = Date.now() + budgetMs + 60_000;
  let sawWork = false;

  for (;;) {
    const status = runner.status();
    if (status.queued > 0 || status.active > 0) sawWork = true;
    if (sawWork && status.queued === 0 && status.active === 0) return false;
    if (Date.now() > deadline) {
      runner.cancelAll();
      return true;
    }
    if (!sawWork && expected > 0 && Date.now() > deadline - budgetMs - 60_000 + 5_000) {
      // 队列迟迟不动：worker 没起来，或者入队的用例数为 0。
      runner.cancelAll();
      return true;
    }
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 200));
  }
}

/** 报告是 worker 在 `status().active` 归零前写下的；这里再兜几次，避免抢占式读取扑空。 */
async function readWithRetry(runsDir: string, runId: string): Promise<CaseRunReport> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < 10; attempt += 1) {
    try {
      return await readReport(runsDir, runId);
    } catch (error) {
      lastError = error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 100));
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

/** `validate`：只校验用例文件，不运行、不调用模型。 */
async function commandValidate(argv: ParsedArgs): Promise<number> {
  if (argv.operands.length === 0) {
    console.error(`validate 需要一个或多个用例文件。\n\n${USAGE}`);
    return EXIT.usage;
  }

  let failures = 0;
  for (const operand of argv.operands) {
    const path = resolve(operand);
    if (!existsSync(path)) {
      console.error(`✗ ${operand}：文件不存在`);
      failures += 1;
      continue;
    }
    try {
      const text = await readFile(path, "utf8");
      const definition: CaseDefinition = parseCase(text, path);
      // 再走一次 schema：`parseCase` 校验的是输入形态，这里要确认默认值也能正常填充
      // （zod v4 的 `.default({})` 陷阱就是在这个环节静默失效的）。
      const parsed = CaseDefinitionSchema.parse(definition);
      const issues = sanityIssues(parsed);
      if (issues.length > 0) {
        console.error(`✗ ${operand}：`);
        for (const issue of issues) console.error(`    ${issue}`);
        failures += 1;
        continue;
      }
      const budget = parsed.budget;
      console.log(
        `✓ ${operand}：id=${parsed.id}，mode=${parsed.mode}，` +
          `budget(steps=${budget.maxSteps}, calls=${budget.maxModelCalls}, ` +
          `tokens=${budget.maxInputTokens}, cost=${budget.maxCostUsd ?? "不限"}, ` +
          `wall=${budget.maxElapsedMs}ms)`,
      );
    } catch (error) {
      console.error(`✗ ${operand}：${error instanceof Error ? error.message : String(error)}`);
      failures += 1;
    }
  }

  if (failures > 0) {
    console.error(`\n${failures} 个用例未通过校验。`);
    return EXIT.failed;
  }
  console.log(`\n全部通过（${argv.operands.length} 个）。`);
  return EXIT.ok;
}

/**
 * 只校验 schema 管不到的语义约束。
 *
 * schema 保证「字段合法」，这里保证「配置内部自洽」——两类问题都会让运行
 * 悄悄失真（例如预算比断言宽，报告会显示通过但其实早就超了），因此都要在
 * 跑之前拦下。
 */
function sanityIssues(parsed: Case): string[] {
  const issues: string[] = [];

  const startUrl = URL.canParse(parsed.startUrl) ? new URL(parsed.startUrl) : null;
  if (startUrl === null) {
    issues.push(`startUrl 不是合法 URL：${parsed.startUrl}`);
  } else if (!parsed.allowedOrigins.includes(startUrl.origin)) {
    // 否则第一步就会被自己的域名白名单拦下，报成 guardrail_blocked，
    // 而真正的原因是用例写错了。
    issues.push(
      `startUrl 的 origin (${startUrl.origin}) 不在 allowedOrigins 里，运行第一步就会被护栏拦下`,
    );
  }

  const { budget, assertions } = parsed;
  if (budget.maxSteps < 1) issues.push("budget.maxSteps 必须 ≥ 1");
  if (budget.maxModelCalls < 1) issues.push("budget.maxModelCalls 必须 ≥ 1");

  const trajectory = assertions.trajectory;
  if (trajectory?.maxSteps !== undefined && trajectory.maxSteps > budget.maxSteps) {
    // trajectory 是事后断言，budget 是硬刹车：断言比刹车还宽，这条断言永远不会失败，
    // 看起来是「通过」，实际是没测到。
    issues.push(
      `assertions.trajectory.maxSteps (${trajectory.maxSteps}) 大于 budget.maxSteps (${budget.maxSteps})：这条断言永远不会失败`,
    );
  }
  const quality = assertions.quality;
  if (quality?.maxModelCalls !== undefined && quality.maxModelCalls > budget.maxModelCalls) {
    issues.push(
      `assertions.quality.maxModelCalls (${quality.maxModelCalls}) 大于 budget.maxModelCalls (${budget.maxModelCalls})：运行会先被预算刹住，这条断言测不到东西`,
    );
  }
  if (quality?.maxElapsedMs !== undefined && quality.maxElapsedMs > budget.maxElapsedMs) {
    issues.push(
      `assertions.quality.maxElapsedMs (${quality.maxElapsedMs}) 大于 budget.maxElapsedMs (${budget.maxElapsedMs})：同上`,
    );
  }
  if (quality?.maxCostUsd !== undefined && budget.maxCostUsd === null) {
    // 不是错误：引擎可能不报金额。但用户多半以为自己设了上限。
    issues.push(
      `assertions.quality.maxCostUsd 已设，而 budget.maxCostUsd 为 null（引擎未报金额时该断言会是 skipped）`,
    );
  }
  if (parsed.mode === "readonly" && quality?.minTargetProbability !== undefined) {
    // 只读模式下没有 TYPE_TEXT / SELECT，但仍可能有 CLICK 目标，概率断言照样可求值。
    // 这里只提示，不判错。
    issues.push("提示：readonly 模式下概率类断言仍会求值（点击目标仍有概率）");
  }
  return issues;
}

/** `import`：把 YAML 文件导入用例库。 */
async function commandImport(argv: ParsedArgs): Promise<number> {
  if (argv.operands.length === 0) {
    console.error(`import 需要一个或多个 YAML 文件。\n\n${USAGE}`);
    return EXIT.usage;
  }

  const settings = applyFlags(loadSettings(), argv.flags);
  const store = createCaseStore({ root: settings.casesDir, runsDir: settings.runsDir });

  let failures = 0;
  for (const operand of argv.operands) {
    const path = resolve(operand);
    if (!existsSync(path)) {
      console.error(`✗ ${operand}：文件不存在`);
      failures += 1;
      continue;
    }
    try {
      const yaml = await readFile(path, "utf8");
      // 冲突时追加 -2 而不是覆盖既有用例（store 的职责），因此这里不提示「已存在」。
      const revision = await store.import(yaml);
      console.log(
        `✓ ${operand} -> ${revision.caseId}（revision ${revision.revision}，digest ${revision.digest.slice(0, 12)}…）`,
      );
    } catch (error) {
      console.error(`✗ ${operand}：${error instanceof Error ? error.message : String(error)}`);
      failures += 1;
    }
  }
  if (failures > 0) return EXIT.failed;
  return EXIT.ok;
}

/** 单条检查的结果。`failure` 影响退出码，`warning` 不影响。 */
interface DoctorCheck {
  name: string;
  status: "ok" | "warning" | "failure";
  detail: string;
  /** 怎么修。failure 时必须有——不说怎么修的报错等于没报。 */
  fix?: string;
}

/** `doctor`：把「跑起来才发现没配好」提前到一条命令里。 */
async function commandDoctor(argv: ParsedArgs): Promise<number> {
  const settings = applyFlags(loadSettings(), argv.flags);
  const checks: DoctorCheck[] = [];

  // 1. Node 版本。engines 要求 >= 22.6（需要 --experimental-strip-types）。
  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  checks.push(
    major > 22 || (major === 22 && minor >= 6)
      ? { name: "Node 版本", status: "ok", detail: `v${process.versions.node}` }
      : {
          name: "Node 版本",
          status: "failure",
          detail: `v${process.versions.node} 低于要求（>= 22.6）`,
          fix: "升级 Node 到 22.6 以上；开发期依赖 --experimental-strip-types",
        },
  );

  // 2. Chromium。动态 import：validate 之类不需要浏览器的子命令不必付这份开销。
  try {
    const { chromium } = await import("playwright");
    const executable = chromium.executablePath();
    await access(executable);
    checks.push({ name: "Chromium", status: "ok", detail: executable });
  } catch (error) {
    checks.push({
      name: "Chromium",
      status: "failure",
      detail: `不可用：${error instanceof Error ? error.message : String(error)}`,
      fix: "运行 npx playwright install chromium（约 150MB）",
    });
  }

  // 3. 凭证。
  const missing = missingCredentials(settings);
  checks.push(
    missing.length === 0
      ? {
          name: "凭证",
          status: settings.textModelApiKey === null ? "warning" : "ok",
          detail:
            settings.textModelApiKey === null
              ? "TypeSafe 已配置；文本模型未配置（需要 TYPE_TEXT 的用例会直接报错，不会猜值）"
              : "TypeSafe 与文本模型均已配置",
          ...(settings.textModelApiKey === null
            ? { fix: "要跑需要输入的用例，请在 .env 里填 TEXT_MODEL_API_KEY" }
            : {}),
        }
      : {
          name: "凭证",
          status: "failure",
          detail: `缺少：${missing.join("、")}`,
          fix: "cp .env.example .env 后填入 TYPESAFE_API_KEY",
        },
  );

  // 4. 目录可写。写一个探针文件再删掉——只检查「存在」会漏掉只读挂载。
  for (const [label, dir] of [
    ["用例库目录", settings.casesDir],
    ["运行产物目录", settings.runsDir],
  ] as const) {
    const target = resolve(dir);
    try {
      await mkdir(target, { recursive: true });
      const probe = join(target, `.jevtest-write-probe-${process.pid}`);
      await writeFile(probe, "ok", "utf8");
      await unlink(probe);
      checks.push({ name: label, status: "ok", detail: target });
    } catch (error) {
      checks.push({
        name: label,
        status: "failure",
        detail: `${target} 不可写：${error instanceof Error ? error.message : String(error)}`,
        fix: "检查目录权限，或用 JEVTEST_CASES_DIR / JEVTEST_RUNS_DIR 指到可写目录",
      });
    }
  }

  // 5. dist 资产完整性。**漏了本地察觉不到，部署时才炸**（docs/development.md §5.2）。
  const distDir = fileURLToPath(new URL("../dist/", import.meta.url));
  const requiredAssets = ["dist/browser/snapshot.js", "dist/web/public/index.html"];
  if (!existsSync(distDir)) {
    checks.push({
      name: "dist 资产",
      status: "warning",
      detail: "dist/ 尚未构建（开发期正常，用 node --experimental-strip-types 直跑源码）",
      fix: "需要部署或跑构建产物时执行 npm run build",
    });
  } else {
    const absent: string[] = [];
    for (const asset of requiredAssets) {
      const assetPath = join(distDir, "..", asset);
      if (!existsSync(assetPath)) absent.push(asset);
    }
    checks.push(
      absent.length === 0
        ? { name: "dist 资产", status: "ok", detail: requiredAssets.join("、") }
        : {
            name: "dist 资产",
            status: "failure",
            detail: `缺少：${absent.join("、")}`,
            fix: "npm run build（tsc 不复制非 TS 资产，靠 scripts/copy-assets.mjs 补上）",
          },
    );
  }

  // 6. 引擎注册表。
  const engines = listEngines();
  checks.push(
    engines.length > 0
      ? {
          name: "决策引擎",
          status: "ok",
          detail: engines.map((e) => `${e.name}(text=${e.text}, probabilities=${e.probabilities})`).join("、"),
        }
      : {
          name: "决策引擎",
          status: "failure",
          detail: "没有已注册的引擎",
          fix: "检查 engine/registry.ts 的自注册是否被破坏",
        },
  );

  // 7. 用例库现状。
  const store = createCaseStore({ root: settings.casesDir, runsDir: settings.runsDir });
  try {
    const list = await store.list();
    const runs = existsSync(join(resolve(settings.runsDir), "index.jsonl"));
    checks.push({
      name: "用例库",
      status: "ok",
      detail: `${list.length} 个用例；运行历史${runs ? "存在" : "为空（尚未跑过）"}`,
    });
  } catch (error) {
    checks.push({
      name: "用例库",
      status: "warning",
      detail: `读不到用例列表：${error instanceof Error ? error.message : String(error)}`,
      fix: "确认 JEVTEST_CASES_DIR 指向的目录结构是 cases/<id>/case.yaml",
    });
  }

  // 8. 同一个 handler 的 /api/health——CLI 与前端共用同一套路由，只是不经网络。
  try {
    const services: Services = createCaseStoreServices(settings, store);
    const security = {
      token: createToken(),
      port: settings.port,
      origin: `http://127.0.0.1:${settings.port}`,
    };
    configureApi({ settings, security, services });
    const response = await handle({
      method: "GET",
      path: "/api/health",
      query: new URLSearchParams(),
      headers: { host: `127.0.0.1:${settings.port}` },
      body: undefined,
    });
    if (response.status === 200) {
      checks.push({ name: "/api/health", status: "ok", detail: "路由可用" });
    } else {
      checks.push({
        name: "/api/health",
        status: "failure",
        detail: `返回 ${response.status}：${JSON.stringify(response.body)}`,
        fix: "这是实现问题，不是配置问题——见 web/api.ts 的 handle()",
      });
    }
  } catch (error) {
    checks.push({
      name: "/api/health",
      status: "failure",
      detail: `调用失败：${error instanceof Error ? error.message : String(error)}`,
      fix: "这是实现问题，不是配置问题——见 web/api.ts 与 web/server.ts 的装配",
    });
  }

  for (const check of checks) {
    const mark = check.status === "ok" ? "✓" : check.status === "warning" ? "!" : "✗";
    console.log(`${mark} ${check.name}：${check.detail}`);
    if (check.fix !== undefined && check.status !== "ok") console.log(`    → ${check.fix}`);
  }

  const failures = checks.filter((check) => check.status === "failure").length;
  const warnings = checks.filter((check) => check.status === "warning").length;
  console.log(
    `\n${checks.length} 项检查：${checks.length - failures - warnings} 通过，${warnings} 警告，${failures} 失败。`,
  );
  return failures > 0 ? EXIT.failed : EXIT.ok;
}

/**
 * doctor 用的最小 services。
 *
 * doctor 不跑用例，因此 runner 与 pool 只需要是可用的桩——**但绝不能再造一份
 * 带副作用的真实对象**（那会启浏览器）。这里用一个明显未启动的 runner 替身，
 * 它的方法只有被调用才会说话。
 */
function createCaseStoreServices(settings: Settings, store: CaseStore): Services {
  const notStarted = (what: string) => (): never => {
    throw new Error(`doctor 不启动 ${what}；这个调用不该发生`);
  };
  return {
    settings,
    store,
    runner: {
      enqueue: notStarted("runner"),
      enqueueMany: notStarted("runner"),
      cancel: () => false,
      cancelAll: () => {},
      status: () => ({ queued: 0, active: 0, workers: settings.workers, contextsActive: 0 }),
      start: () => {},
      stop: async () => {},
    },
    pool: {
      start: async () => {},
      withSession: notStarted("浏览器"),
      saveStorageState: notStarted("浏览器"),
      activeContexts: () => 0,
      stop: async () => {},
    },
    events: {
      sink: { emit: () => {} },
      log: notStarted("事件日志"),
      bus: { emit: () => {}, subscribe: notStarted("事件日志") },
      retire: () => {},
    },
  };
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

async function main(argv: string[]): Promise<number> {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return EXIT.usage;
  }

  if (parsed.flags.help || parsed.command === null) {
    console.log(USAGE);
    return EXIT.ok;
  }

  // 所有子命令都从同一个环境读取配置；.env 只在存在时加载。
  loadDotEnv();

  try {
    switch (parsed.command) {
      case "serve":
        return await commandServe(parsed);
      case "run":
        return await commandRun(parsed);
      case "validate":
        return await commandValidate(parsed);
      case "import":
        return await commandImport(parsed);
      case "doctor":
        return await commandDoctor(parsed);
    }
  } catch (error) {
    // 顶层兜底：配置缺失、目录不可写这类问题要给一句人话 + 怎么修，
    // 而不是一段 stack trace。
    const message = error instanceof Error ? error.message : String(error);
    console.error(`jevtest ${parsed.command} 失败：${message}`);
    if (error instanceof Error && error.stack !== undefined && process.env["JEVTEST_DEBUG"] === "1") {
      console.error(error.stack);
    }
    return EXIT.error;
  }
}

/**
 * 经 npm 的 bin 软链启动时，argv[1] 是软链路径（如 node_modules/.bin/jevtest），
 * 而 import.meta.url 是解析后的真实路径——不先 realpath 的话两者永远不相等，
 * 进程什么都不做就以退出码 0 结束。
 */
function realpathOr(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * 只在**被直接执行**时进入 main。
 *
 * 本文件同时是「装配入口」：e2e 测试要复用 `createWiring`，跑同一套接线。
 * 没有这道判断的话，测试一 import 就会启动一个真的 CLI（跑 serve、绑端口、
 * 甚至 `process.exitCode` 被写坏），而且失败现象是「测试里莫名其妙多了一个服务」。
 *
 * 判断方式是比较 `import.meta.url` 与 `process.argv[1]`：ESM 下没有
 * CommonJS 那种 `require.main === module`，这是等价写法。
 */
const invokedDirectly =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(realpathOr(resolve(process.argv[1]))).href;

if (invokedDirectly) {
  process.exitCode = await main(process.argv.slice(2));
}
