/**
 * 运行器的行为锁定：队列、worker 池、信号所有权、停机三步。
 *
 * 全部零成本：页面由 `FakeSession` 脚本化给出，决策由 `createScriptedEngine`
 * 按预设数组给出，浏览器池是一个只计数的 `FakePool`。
 * **没有任何一处真的开浏览器、发请求或等待网络。**
 *
 * 这一层要守住的东西与 agent 不同：agent 守的是**顺序**（决策/执行/观测的先后），
 * runner 守的是**所有权与收尾**——
 *   - 信号：两级 AbortController，任一 abort 都要能中断；运行结束后 controller 必须从
 *     Map 里删掉（否则长跑进程会积累废弃 controller，是另一种泄漏）；
 *   - context：借出的 session 由池关，运行结束后 `contextsActive` 必须回到 0；
 *   - 报告：无论什么终态都要落盘，且**保留已有轨迹**（error / cancelled 也不例外）；
 *   - 停机：cancelAll -> 等在途写完报告 -> pool.stop，且必须带超时。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mkdtemp, rm } from "node:fs/promises";

import { composeRunSignal, createRunnerService, DEFAULT_STOP_TIMEOUT_MS, failureReport } from "../src/core/runner.ts";
import type { QueueStatus, RunnerService } from "../src/core/runner.ts";
import { StalePage } from "../src/core/errors.ts";
import { createScriptedEngine } from "../src/engine/scripted.ts";
import type { ScriptedStep } from "../src/engine/scripted.ts";
import type { DecisionEngine } from "../src/engine/types.ts";
import { CaseDefinitionSchema } from "../src/schema/case.ts";
import type { Case, CaseDefinition } from "../src/schema/case.ts";
import type { RunEvent } from "../src/schema/events.ts";
import type { CaseRunReport } from "../src/schema/report.ts";
import type { ContextOptions, BrowserPool } from "../src/browser/pool.ts";
import type { Session } from "../src/browser/session.ts";
import type { Settings } from "../src/config.ts";
import { FakeSession, interactiveActions, makeAction, makeObservation } from "./fakes/session.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function testSettings(overrides: Partial<Settings> = {}): Settings {
  return {
    typesafeApiKey: "k",
    typesafeModel: "m",
    textModelApiKey: null,
    textModelBaseUrl: "http://localhost",
    textModel: "t",
    port: 0,
    workers: 1,
    maxEngineInflight: 4,
    headless: true,
    // 默认关掉 tracing：开了会去建 runs/<runId>/ 目录，而绝大多数测试不关心产物
    tracing: false,
    casesDir: "./cases",
    runsDir: "./runs",
    defaultEngine: "scripted",
    ...overrides,
  };
}

function makeCase(overrides: Partial<CaseDefinition> = {}): Case {
  return CaseDefinitionSchema.parse({
    id: "runner-case",
    title: "运行器用例",
    goal: "在示例页面上找到答案",
    startUrl: "https://example.test/start",
    engine: "scripted",
    ...overrides,
  });
}

/**
 * 只计数的浏览器池。
 *
 * 关键点是 `withSession` 里的 try/finally——真实池把「关 context」封在里面，
 * 调用方不可能写错（browser/pool.ts 的设计意图）。这里照做，于是
 * `contextsActive` 归零这件事在这个假池上也有意义。
 */
class FakePool implements BrowserPool {
  /** 借出过的 session，按借出顺序 */
  readonly sessions: FakeSession[] = [];
  readonly contextOptions: ContextOptions[] = [];
  startCalls = 0;
  stopCalls = 0;
  /** 同时存活的 context 数峰值——用来验证 workers 真的限制了并发 */
  peakActive = 0;
  /** `stop()` 强制关闭的 context 数。正常收尾时必须是 0 */
  forcedClosures = 0;
  #active = 0;
  readonly #sessionFactory: () => FakeSession;

  constructor(sessionFactory: () => FakeSession) {
    this.#sessionFactory = sessionFactory;
  }

  start(): Promise<void> {
    this.startCalls += 1;
    return Promise.resolve();
  }

  async withSession<T>(options: ContextOptions, fn: (session: Session) => Promise<T>): Promise<T> {
    this.contextOptions.push(options);
    this.#active += 1;
    this.peakActive = Math.max(this.peakActive, this.#active);
    const session = this.#sessionFactory();
    this.sessions.push(session);
    try {
      return await fn(session);
    } finally {
      // 借出的 session 由**池**关，agent 不关（见 runner.ts 的调用处注释）
      await session.close();
      this.#active -= 1;
    }
  }

  saveStorageState(_session: Session, _path: string): Promise<void> {
    return Promise.resolve();
  }

  activeContexts(): number {
    return this.#active;
  }

  stop(): Promise<void> {
    this.stopCalls += 1;
    // 真实池在这里强制关闭所有 context。计数保留下来，好让「运行结束后归零」
    // 这条断言不至于被这行代码自己掩盖过去（正常收尾时 forcedClosures 必须是 0）。
    if (this.#active > 0) {
      this.forcedClosures += this.#active;
      this.#active = 0;
    }
    return Promise.resolve();
  }
}

interface EngineRecord {
  engine: string;
  steps: ScriptedStep[];
  closed: boolean;
}

interface Harness {
  runner: RunnerService;
  pool: FakePool;
  events: RunEvent[];
  /** `persist` 收到的报告，按落盘顺序 */
  reports: CaseRunReport[];
  engines: EngineRecord[];
  settings: Settings;
}

function makeHarness(input: {
  workers?: number;
  tracing?: boolean;
  runsDir?: string;
  steps?: ScriptedStep[] | ((caseDef: Case) => ScriptedStep[]);
  /** 每次借 context 时造一个 session。不给就造一个「两页、可点可填」的默认页 */
  session?: () => FakeSession;
  /** 让 createEngine 抛错（凭证缺失 / 引擎名无法识别） */
  engineError?: Error;
  /** 让 persist 抛错（磁盘满 / 权限），用来验「落盘失败也要宣告结束」 */
  persistError?: Error;
}): Harness {
  const settings = testSettings({
    ...(input.workers === undefined ? {} : { workers: input.workers }),
    ...(input.tracing === undefined ? {} : { tracing: input.tracing }),
    ...(input.runsDir === undefined ? {} : { runsDir: input.runsDir }),
  });
  const events: RunEvent[] = [];
  const reports: CaseRunReport[] = [];
  const engines: EngineRecord[] = [];
  const pool = new FakePool(
    input.session ??
      (() =>
        new FakeSession({
          observations: [
            makeObservation({ fingerprint: "fp-0", actions: interactiveActions() }),
            makeObservation({ fingerprint: "fp-1", actions: interactiveActions() }),
            makeObservation({ fingerprint: "fp-2", actions: interactiveActions() }),
          ],
        })),
  );

  const runner = createRunnerService({
    pool,
    settings,
    createEngine: (caseDef): DecisionEngine => {
      if (input.engineError !== undefined) throw input.engineError;
      const steps = typeof input.steps === "function" ? input.steps(caseDef) : (input.steps ?? [clickLink(), done()]);
      const record: EngineRecord = { engine: caseDef.engine, steps, closed: false };
      engines.push(record);
      const inner = createScriptedEngine({ steps });
      return {
        name: inner.name,
        capabilities: inner.capabilities,
        decide: (req, signal) => inner.decide(req, signal),
        writeText: (req, signal) => inner.writeText(req, signal),
        close: async () => {
          record.closed = true;
          await inner.close();
        },
      };
    },
    persist: async (report) => {
      reports.push(report);
      if (input.persistError !== undefined) throw input.persistError;
    },
    events: {
      emit: (event) => {
        events.push(event);
      },
    },
  });

  return { runner, pool, events, reports, engines, settings };
}

function clickLink(): ScriptedStep {
  return { operation: { choice: "CLICK" }, targets: { click_target: { choice: "1" } } };
}

function done(): ScriptedStep {
  return { operation: { choice: "DONE" } };
}

/** 轮询等待一个条件成立。用真实时钟：只有几毫秒，且失败时给出可读的原因。 */
async function waitFor(predicate: () => boolean, message: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) assert.fail(`等待超时：${message}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 入队若干用例并等全部报告落盘。 */
async function runAll(harness: Harness, cases: Case[]): Promise<CaseRunReport[]> {
  const before = harness.reports.length;
  const { runIds } = harness.runner.enqueueMany(cases);
  await waitFor(
    () => harness.reports.length === before + runIds.length,
    `${runIds.length} 份报告落盘（当前 ${harness.reports.length - before} 份）`,
  );
  return harness.reports.slice(before);
}

function indexOfType(events: RunEvent[], type: RunEvent["type"]): number {
  return events.findIndex((event) => event.type === type);
}

// ---------------------------------------------------------------------------
// 数据流：一次运行从入队到报告落盘（architecture.md §2）
// ---------------------------------------------------------------------------

test("一次运行的数据流：queued -> started -> observed/decided/executed -> assertion -> finished", async () => {
  const harness = makeHarness({});
  harness.runner.start();

  const caseDef = makeCase();
  const { runId } = harness.runner.enqueue(caseDef);
  await waitFor(() => harness.reports.length === 1, "报告落盘");

  // ---- 身份：runId 由 runner 分配，报告与事件里的值必须一致 -----------------
  const report = harness.reports[0];
  assert.ok(report !== undefined);
  assert.equal(report.runId, runId);
  assert.equal(report.caseId, caseDef.id);
  assert.equal(report.suiteRunId, null, "单跑没有套件 id");
  assert.equal(report.status, "done");
  assert.equal(report.passed, true, "断言判决与 status 相互独立");
  assert.equal(report.assertion !== null, true);

  // ---- 事件：全部由 runner 打的章，runId 一致，且顺序正确 ------------------
  const types = harness.events.map((event) => event.type);
  assert.deepEqual(types.slice(0, 2), ["run.queued", "run.started"]);
  const order = [
    "run.queued",
    "run.started",
    "step.observed",
    "step.decided",
    "step.executed",
    "assertion.evaluated",
    "run.finished",
  ] as const;
  const positions = order.map((type) => indexOfType(harness.events, type));
  for (let index = 0; index < positions.length; index += 1) {
    assert.notEqual(positions[index], -1, `事件里应当有 ${order[index]}`);
    if (index > 0) assert.ok(positions[index]! > positions[index - 1]!, `${order[index]} 应当在 ${order[index - 1]} 之后`);
  }
  // agent 不知道 runId（AgentDeps 里没有这条管道字段），是 runner 的盖章 sink 补的
  assert.ok(
    harness.events.every((event) => event.runId === runId),
    "每一条事件都必须带本次运行的真实 runId",
  );
  const finished = harness.events.find((event) => event.type === "run.finished");
  assert.ok(finished !== undefined && finished.type === "run.finished");
  assert.equal(finished.status, "done");
  assert.deepEqual(finished.stats, report.stats, "事件里的统计与报告必须是同一份");

  // ---- 持久化与产物路径 ----------------------------------------------------
  assert.equal(harness.reports.length, 1, "persist 只被调用一次");
  assert.equal(report.artifacts.frozenCase, "case.yaml", "冻结用例的相对路径约定由 runner 保证");
  assert.equal(report.artifacts.traceZip, null, "未开 tracing 就没有 trace");
  assert.equal(report.artifacts.framesDir, null, "截图通路未接，指向一个空目录等于让报告说谎");
  assert.equal(report.caseRevision, 0, "revision/digest 由 persist 用 store.freeze() 定稿，runner 不编造");
  assert.equal(report.caseDigest, "");

  // ---- 引擎与 context 的生命周期 -------------------------------------------
  assert.equal(harness.engines.length, 1, "每个用例一个引擎实例");
  assert.equal(harness.engines[0]?.closed, true, "跑完必须 close");
  assert.equal(harness.pool.sessions.length, 1);
  assert.equal(harness.pool.sessions[0]?.closed, true, "借出的 session 由池关");

  // ---- §9.3：运行结束后 contextsActive 必须归零 -----------------------------
  const status = harness.runner.status();
  assert.equal(status.contextsActive, 0);
  assert.equal(harness.pool.forcedClosures, 0, "归零必须是正常收尾，不是 stop() 兜底出来的");
  assert.equal(status.queued, 0);
  assert.equal(status.active, 0);
  assert.equal(status.workers, 1);

  // ---- 信号所有权：结束之后 controller 必须从 Map 里删掉 --------------------
  // （长跑进程积累废弃 controller 是另一种形式的泄漏，而且是静默的）
  assert.equal(harness.runner.cancel(runId), false, "已结束的运行不该还能被取消");
});

test("status()：入队后排队数立刻可见，跑完归零；workers 来自 settings", async () => {
  const harness = makeHarness({ workers: 3 });
  // 还没 start：worker 一个都没起来，任务只能排队
  const cases = [makeCase({ id: "c-one" }), makeCase({ id: "c-two" }), makeCase({ id: "c-three" })];
  const { runIds } = harness.runner.enqueueMany(cases);

  const queued: QueueStatus = harness.runner.status();
  assert.equal(queued.queued, 3);
  assert.equal(queued.active, 0);
  assert.equal(queued.workers, 3);
  assert.equal(queued.contextsActive, 0);

  harness.runner.start();
  await waitFor(() => harness.reports.length === runIds.length, "三份报告落盘");

  const after = harness.runner.status();
  assert.equal(after.queued, 0);
  assert.equal(after.active, 0);
  assert.equal(after.contextsActive, 0);
  assert.equal(harness.pool.peakActive, 3, "3 个 worker 应当同时借出 3 个 context");
  harness.runner.cancelAll();
  await harness.runner.stop();
});

test("批量入队：共用 suiteRunId，每个用例一个引擎实例，并发受 workers 限制", async () => {
  const harness = makeHarness({ workers: 1 });
  harness.runner.start();

  const cases = [makeCase({ id: "b-one" }), makeCase({ id: "b-two" }), makeCase({ id: "b-three" })];
  const { suiteRunId, runIds } = harness.runner.enqueueMany(cases);
  assert.equal(runIds.length, 3);
  assert.match(suiteRunId, /^suite-[0-9]{8}-[0-9]{6}-[0-9a-f]{6}$/, "套件 id 只含 runId 允许的字符");

  await waitFor(() => harness.reports.length === 3, "三份报告落盘");

  assert.ok(harness.reports.every((report) => report.suiteRunId === suiteRunId), "同一个套件 id 出现在每一份报告里");
  assert.equal(new Set(harness.reports.map((report) => report.runId)).size, 3, "runId 必须互不相同");
  assert.equal(harness.engines.length, 3, "每个用例一个引擎实例");
  assert.ok(harness.engines.every((record) => record.closed));
  assert.equal(harness.pool.peakActive, 1, "workers=1 时不能并发");
  assert.equal(harness.runner.status().contextsActive, 0);

  harness.runner.cancelAll();
  await harness.runner.stop();
});

test("engineOverride：覆盖用例声明的引擎（A/B 对比），不改动用例本身", async () => {
  const harness = makeHarness({});
  harness.runner.start();

  const caseDef = makeCase({ engine: "scripted" });
  harness.runner.enqueue(caseDef, { engineOverride: "typesafe" });
  await waitFor(() => harness.reports.length === 1, "报告落盘");

  assert.equal(harness.engines[0]?.engine, "typesafe", "createEngine 收到的应是覆盖后的引擎");
  assert.equal(caseDef.engine, "scripted", "原用例对象不能被就地改掉");
  harness.runner.cancelAll();
  await harness.runner.stop();
});

// ---------------------------------------------------------------------------
// 护栏与失败路径
// ---------------------------------------------------------------------------

test("护栏命中：act 调用 0 次、status 为 guardrail_blocked、报告照常落盘", async () => {
  const deleteButton = makeAction({ id: "e9", kind: "click", label: "Delete account", role: "button", node: 9 });
  const harness = makeHarness({
    session: () =>
      new FakeSession({
        observations: [
          makeObservation({ fingerprint: "fp-0", actions: [deleteButton] }),
          makeObservation({ fingerprint: "fp-1", actions: [deleteButton] }),
        ],
      }),
    steps: [{ operation: { choice: "CLICK" }, targets: { click_target: { choice: "1" } } }],
  });
  harness.runner.start();

  const report = (await runAll(harness, [makeCase()]))[0];
  assert.ok(report !== undefined);

  assert.equal(report.status, "guardrail_blocked");
  assert.equal(harness.pool.sessions[0]?.actCount, 0, "护栏命中时浏览器不能收到任何输入");
  assert.equal(report.steps.length, 1);
  assert.equal(report.steps[0]?.executed, false);
  assert.equal(report.guardrailHits.length, 1);
  assert.equal(harness.engines[0]?.closed, true, "异常终态也要关引擎");

  const finished = harness.events.find((event) => event.type === "run.finished");
  assert.ok(finished !== undefined && finished.type === "run.finished");
  assert.equal(finished.status, "guardrail_blocked");
  harness.runner.cancelAll();
  await harness.runner.stop();
});

test("引擎故障：状态记 error，但已产生的轨迹必须保留、报告必须落盘", async () => {
  // 预设只够第一次决策：第二次 decide 抛错，模拟引擎不可达 / 响应不可解析
  const harness = makeHarness({ steps: [clickLink()] });
  harness.runner.start();

  const report = (await runAll(harness, [makeCase()]))[0];
  assert.ok(report !== undefined);

  assert.equal(report.status, "error");
  assert.match(report.failureReason ?? "", /运行故障/);
  assert.equal(report.steps.length, 1, "「尽量保留 partial」：前半段的轨迹仍然能说明问题");
  assert.equal(report.steps[0]?.executed, true);
  assert.equal(report.assertion, null, "运行故障下断言层根本没跑（与 passed:null 是两件事）");
  assert.equal(report.passed, null, "error 不是「断言失败」，绝不能写成 false");
  assert.equal(report.artifacts.frozenCase, "case.yaml", "失败的报告同样是自包含的");
  assert.equal(harness.pool.forcedClosures, 0);
  assert.equal(harness.runner.status().contextsActive, 0);
  assert.equal(harness.engines[0]?.closed, true);
  harness.runner.cancelAll();
  await harness.runner.stop();
});

test("引擎构造失败：记 error 却不打开浏览器，报告照写", async () => {
  const harness = makeHarness({ engineError: new Error("缺少 TYPESAFE_API_KEY") });
  harness.runner.start();

  const report = (await runAll(harness, [makeCase()]))[0];
  assert.ok(report !== undefined);

  assert.equal(report.status, "error");
  assert.match(report.failureReason ?? "", /TYPESAFE_API_KEY/);
  assert.equal(report.engine, "", "没有引擎真的跑过，不留一个看起来像真的引擎名");
  assert.equal(harness.pool.sessions.length, 0, "引擎都没建起来，不该白开一个浏览器");
  assert.equal(harness.runner.status().contextsActive, 0);
  assert.deepEqual(report.steps, []);
  assert.equal(
    indexOfType(harness.events, "run.started"),
    -1,
    "引擎名要进 run.started，所以构造失败时这条事件不该发出去",
  );
  assert.notEqual(indexOfType(harness.events, "run.finished"), -1, "但结束必须宣告");
  harness.runner.cancelAll();
  await harness.runner.stop();
});

test("落盘失败：run.finished 照发（否则界面永远停在运行中），并补一条 error 级日志", async () => {
  const harness = makeHarness({ persistError: new Error("磁盘已满") });
  harness.runner.start();

  await runAll(harness, [makeCase()]);

  const finished = harness.events.filter((event) => event.type === "run.finished");
  assert.equal(finished.length, 1, "运行结束了就必须宣告结束");
  const errors = harness.events.filter((event) => event.type === "run.log" && event.level === "error");
  assert.equal(errors.length, 1, "报告读不到是必须显式暴露的故障");
  assert.match(errors[0]?.type === "run.log" ? errors[0].message : "", /磁盘已满/);
  assert.equal(harness.runner.status().active, 0);
  assert.equal(harness.runner.status().contextsActive, 0);
  harness.runner.cancelAll();
  await harness.runner.stop();
});

test("failureReport：保留 partial 的轨迹，并把故障原因写成人话", async () => {
  const caseDef = makeCase();
  const harness = makeHarness({});
  harness.runner.start();
  const partial = (await runAll(harness, [caseDef]))[0];
  assert.ok(partial !== undefined);
  harness.runner.cancelAll();
  await harness.runner.stop();

  const failed = failureReport("run-1", caseDef, new Error("连接被重置：ECONNRESET"), partial);

  assert.equal(failed.status, "error");
  assert.match(failed.failureReason ?? "", /ECONNRESET/);
  assert.equal(failed.steps.length, partial.steps.length, "partial 的轨迹原样保留");
  assert.equal(failed.runId, partial.runId, "partial 已经有 runId 时以它为准");

  // 没有 partial 时（例如还没借到 session 就失败了）也要给出一份结构完整的报告
  const bare = failureReport("run-2", caseDef, new StalePage("页面已变化"), null);
  assert.equal(bare.runId, "run-2");
  assert.equal(bare.caseId, caseDef.id);
  assert.equal(bare.status, "error");
  assert.deepEqual(bare.steps, []);
  assert.equal(bare.artifacts.frozenCase, "case.yaml");
  assert.equal(bare.passed, null, "运行故障 = 未判定，不是失败");
  assert.match(bare.failureReason ?? "", /页面已变化/);
});

// ---------------------------------------------------------------------------
// 取消与停机
// ---------------------------------------------------------------------------

test("cancel：在步边界生效，已完成的那一步会保留", async () => {
  let runId = "";
  // 在第一次动作中间请求取消：这正是「跑到一半被叫停」的真实时序
  const stuck = new FakeSession({
    observations: [
      makeObservation({ fingerprint: "fp-0", actions: interactiveActions() }),
      makeObservation({ fingerprint: "fp-1", actions: interactiveActions() }),
    ],
    onAct: () => {
      assert.equal(harness.runner.cancel(runId), true, "取消请求应当被接受");
      // 幂等：同一个运行不重复算「成功请求取消」
      assert.equal(harness.runner.cancel(runId), false);
    },
  });
  const harness = makeHarness({ session: () => stuck });
  harness.runner.start();
  runId = harness.runner.enqueue(makeCase()).runId;

  await waitFor(() => harness.reports.length === 1, "取消后的报告落盘");
  const report = harness.reports[0];
  assert.ok(report !== undefined);

  assert.equal(report.status, "cancelled");
  assert.equal(stuck.actCount, 1, "已经开始的浏览器变更会做完");
  assert.equal(report.steps.length, 1, "轨迹保留");
  assert.match(report.failureReason ?? "", /取消/);
  assert.equal(
    report.passed,
    false,
    "取消发生在观测到页面之后，断言层照常求值；而默认 statusIn 是 [\"done\"]，于是判 false。" +
      "status: cancelled 不在 case-format §常见组合表里，这条口径待定案（见交付报告）",
  );
  assert.equal(harness.runner.cancel(runId), false, "结束之后 controller 已从 Map 删除");
  assert.equal(harness.runner.status().contextsActive, 0);

  await harness.runner.stop();
});

test("cancel：排队中的运行被取消时不打开浏览器，但报告照写", async () => {
  // 刻意**先入队、后 start()**：这样「第二个运行确实还排在队列里」是确定的，
  // 不依赖「第一个跑到哪一步了」这种时序巧合。
  const harness = makeHarness({ workers: 1 });
  const first = harness.runner.enqueue(makeCase({ id: "q-one" }));
  const second = harness.runner.enqueue(makeCase({ id: "q-two" }));

  assert.equal(harness.runner.status().queued, 2, "worker 还没起来，两个都在排队");
  assert.equal(harness.runner.cancel(second.runId), true, "排队中的运行也必须能被取消");

  harness.runner.start();
  await waitFor(() => harness.reports.length === 2, "两份报告都落盘");

  const firstReport = harness.reports.find((report) => report.runId === first.runId);
  const secondReport = harness.reports.find((report) => report.runId === second.runId);
  assert.ok(firstReport !== undefined && secondReport !== undefined);

  assert.equal(firstReport.status, "done", "没被取消的那个照常跑完");
  assert.equal(secondReport.status, "cancelled");
  assert.deepEqual(secondReport.steps, [], "没跑过就没有轨迹");
  assert.match(secondReport.failureReason ?? "", /启动前被取消/);
  assert.equal(
    harness.pool.sessions.length,
    1,
    "被取消的排队运行不该借 context——连浏览器都不该为它打开",
  );
  assert.equal(harness.runner.status().contextsActive, 0);

  await harness.runner.stop();
});

test("composeRunSignal：两级信号任一 abort 即 abort，且互不牵连", () => {
  // 「两级信号都能中断」这条性质很容易被后续重构破坏（例如有人图省事只传 runSignal），
  // 而破坏了不会有任何报错，只会让停机悄悄失效。所以单独抽出来测（§11.2 ②）。
  const run = new AbortController();
  const shutdown = new AbortController();
  const combined = composeRunSignal(run.signal, shutdown.signal);
  assert.equal(combined.aborted, false);

  run.abort();
  assert.equal(combined.aborted, true, "取消单个运行要能中断它");
  assert.equal(shutdown.signal.aborted, false, "单个运行的取消不该污染全局停机信号");

  const run2 = new AbortController();
  const shutdown2 = new AbortController();
  const combined2 = composeRunSignal(run2.signal, shutdown2.signal);
  shutdown2.abort();
  assert.equal(combined2.aborted, true, "停机要能中断所有在途运行");
  assert.equal(run2.signal.aborted, false);

  // 已经是 aborted 的信号参与合成时，合成结果必须立刻是 aborted
  const dead = new AbortController();
  dead.abort();
  assert.equal(composeRunSignal(dead.signal, new AbortController().signal).aborted, true);
  assert.equal(composeRunSignal(new AbortController().signal, dead.signal).aborted, true);
});

test("stop：三步顺序（cancelAll -> 等在途写完报告 -> pool.stop），停机后不再接受入队", async () => {
  const harness = makeHarness({ workers: 2 });
  harness.runner.start();

  const cases = [makeCase({ id: "s-one" }), makeCase({ id: "s-two" })];
  const { runIds } = harness.runner.enqueueMany(cases);
  await waitFor(() => indexOfType(harness.events, "run.started") !== -1, "至少一个运行已启动");

  await harness.runner.stop();

  assert.equal(harness.pool.stopCalls, 1, "停机要关浏览器");
  assert.equal(harness.reports.length, runIds.length, "停机时所有在途用例都要写完报告");
  for (const runId of runIds) {
    assert.ok(
      harness.reports.some((report) => report.runId === runId),
      `每个入队的运行都要有报告（缺 ${runId} 意味着有用例静默消失了）`,
    );
  }
  assert.equal(harness.pool.forcedClosures, 0, "正常停机走的是「等在途收尾」这条路，不是强制关闭");
  assert.equal(harness.runner.status().contextsActive, 0, "§9.3：运行结束后必须归零");

  // stop() 幂等：cli 的 serve 路径会调两次
  await harness.runner.stop();
  assert.equal(harness.pool.stopCalls, 1, "第二次 stop() 应当是空操作");

  assert.throws(() => harness.runner.enqueue(makeCase()), /已停机/, "停机后静默接受入队会丢掉用例");
});

test("停机信号：在途运行在下一个步边界以 cancelled 结束，并等它写完报告", async () => {
  let stopTask: Promise<void> | null = null;
  const session = new FakeSession({
    observations: [
      makeObservation({ fingerprint: "fp-0", actions: interactiveActions() }),
      makeObservation({ fingerprint: "fp-1", actions: interactiveActions() }),
    ],
    // 停机正是在「一次动作进行到一半」时被请求的。刻意不 await：真正的停机路径
    // 也是并发发生的，这里要验的正是「已经开始的那一步会做完，然后停在步边界」。
    onAct: () => {
      stopTask = harness.runner.stop();
    },
  });
  const harness = makeHarness({ session: () => session });
  harness.runner.start();

  const { runId } = harness.runner.enqueue(makeCase());
  await waitFor(() => harness.reports.length === 1, "停机之后在途用例仍要写出报告");
  assert.ok(stopTask !== null, "动作进行中请求的停机应当真的发出去了");
  await stopTask;

  const report = harness.reports.find((item) => item.runId === runId);
  assert.ok(report !== undefined, "停机也必须让在途用例写完报告");
  assert.equal(report.status, "cancelled", "停机信号必须真的传到 agent（否则停机悄悄失效）");
  assert.equal(session.actCount, 1, "已经开始的那次浏览器变更会做完");
  assert.equal(report.steps.length, 1, "轨迹保留");
  assert.match(report.failureReason ?? "", /停机/);
  assert.equal(harness.pool.forcedClosures, 0);
  assert.equal(harness.runner.status().contextsActive, 0);
});

test("stop 超时：给未完成的那条写 cancelled 报告，并保留已有轨迹", async () => {
  // 第二个观测永不返回：模拟卡在一次不返回的模型请求/页面上
  const stuck = new FakeSession({
    observations: [
      makeObservation({ fingerprint: "fp-0", actions: interactiveActions() }),
      { hang: true },
    ],
  });
  const harness = makeHarness({ session: () => stuck });
  harness.runner.start();

  const { runId } = harness.runner.enqueue(makeCase());
  // 等它真的走进那一步：轨迹里已有 1 条 StepRecord
  await waitFor(() => stuck.actCount === 1, "第一次动作已执行");

  const startedAt = Date.now();
  await harness.runner.stop({ timeoutMs: 30 });
  assert.ok(Date.now() - startedAt < 3000, "超时保护必须比默认值 30s 生效得快");

  const report = harness.reports.find((item) => item.runId === runId);
  assert.ok(report !== undefined, "超时也必须写一份报告，而不是丢弃这个运行");
  assert.equal(report.status, "cancelled");
  assert.equal(report.steps.length, 1, "取消/超时都要保留已有轨迹");
  assert.match(report.failureReason ?? "", /停机超时/);
  assert.equal(harness.pool.stopCalls, 1);
  assert.equal(harness.pool.forcedClosures, 1, "超时路径下 context 是强制关闭的");
  assert.equal(harness.runner.status().contextsActive, 0);
  assert.equal(harness.runner.status().active, 0, "已收尾的运行不能一直占着 active 计数");
});

// ---------------------------------------------------------------------------
// 产物路径
// ---------------------------------------------------------------------------

test("tracing 开启时：trace 落在运行目录下，artifacts.traceZip 指向它", async () => {
  const runsDir = await mkdtemp(join(tmpdir(), "jevtest-runner-"));
  try {
    const harness = makeHarness({ tracing: true, runsDir });
    harness.runner.start();
    const report = (await runAll(harness, [makeCase()]))[0];
    assert.ok(report !== undefined);

    assert.equal(report.artifacts.traceZip, "trace.zip");
    const options = harness.pool.contextOptions[0];
    assert.ok(options !== undefined);
    assert.equal(options.tracing, true);
    assert.equal(
      options.tracePath,
      join(runsDir, report.runId, "trace.zip"),
      "trace 必须写在 runs/<runId>/ 下：报告是自包含的，产物也要在同一个目录里",
    );
    harness.runner.cancelAll();
    await harness.runner.stop();
  } finally {
    await rm(runsDir, { recursive: true, force: true });
  }
});

test("DEFAULT_STOP_TIMEOUT_MS：默认超时必须存在且大到一个正常的收尾不会误判", () => {
  assert.ok(Number.isInteger(DEFAULT_STOP_TIMEOUT_MS) && DEFAULT_STOP_TIMEOUT_MS > 0);
  assert.ok(DEFAULT_STOP_TIMEOUT_MS >= 1000, "正常收尾（落盘 + 关浏览器）不该被误判成超时");
});
