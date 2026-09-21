/**
 * 执行循环的行为锁定：**五条不变量逐条守住**。
 *
 * 这些不变量每一条都对应一个已经发生过的具体错误（见 architecture.md §6），
 * 而且破坏它们不会报错、只会让报告悄悄失真——所以只能靠测试钉住：
 *
 *   1. 决策先消费，再变更（一次陈旧重试不能变成双击）
 *   2. 浏览器变更从不重试（一次动作只对应一次 `act`）
 *   3. 先记执行日志，再观测结果（观测时发生的导航不能抹掉这一步）
 *   4. 废弃的决策不产生副作用（陈旧就只重新观测）
 *   5. 无进展检测（连续 N 步 `pageChanged === false` 且非 wait -> blocked，
 *      而 `pageChanged === null` **不计入**）
 *
 * 全部零成本、零网络、零浏览器：页面由 `FakeSession` 脚本化给出，决策由
 * `createScriptedEngine` 按预设数组给出（见 development.md §4）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CaseAgent, DEFAULT_NO_PROGRESS_LIMIT } from "../src/core/agent.ts";
import { createBudgetMeter } from "../src/core/budget.ts";
import { StalePage } from "../src/core/errors.ts";
import { createScriptedEngine, constantSteps } from "../src/engine/scripted.ts";
import type { ScriptedStep } from "../src/engine/scripted.ts";
import type { DecisionEngine } from "../src/engine/types.ts";
import { CaseDefinitionSchema } from "../src/schema/case.ts";
import type { Case, CaseDefinition } from "../src/schema/case.ts";
import type { RunEvent } from "../src/schema/events.ts";
import type { CaseRunReport, StepRecord } from "../src/schema/report.ts";
import type { BudgetMeter } from "../src/core/budget.ts";
import type { Observation } from "../src/browser/session.ts";
import { FakeSession, interactiveActions, makeAction, makeObservation } from "./fakes/session.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

/** 造一个默认值已填充的 `Case`（走真实的 schema，而不是手写对象）。 */
function makeCase(overrides: Partial<CaseDefinition> = {}): Case {
  return CaseDefinitionSchema.parse({
    id: "agent-case",
    title: "执行循环用例",
    goal: "在示例页面上找到答案",
    startUrl: "https://example.test/start",
    ...overrides,
  });
}

interface RunResult {
  report: CaseRunReport;
  events: RunEvent[];
  session: FakeSession;
  budget: BudgetMeter;
}

/** 跑一遍 agent。**不传 runId**——agent 只用占位（真实值由 runner 的盖章 sink 补）。 */
async function runCase(input: {
  caseDef: Case;
  session: FakeSession;
  engine: DecisionEngine;
  signal?: AbortSignal;
}): Promise<RunResult> {
  const events: RunEvent[] = [];
  const budget = createBudgetMeter(input.caseDef.budget);
  const agent = new CaseAgent({
    session: input.session,
    engine: input.engine,
    budget,
    events: {
      emit: (event) => {
        events.push(event);
      },
    },
    caseDef: input.caseDef,
  });

  const report = await agent.run(input.signal ?? new AbortController().signal);
  return { report, events, session: input.session, budget };
}

/** 取第 n 步。缺了就直接失败，而不是让后面的断言读到 undefined。 */
function stepAt(report: CaseRunReport, index: number): StepRecord {
  const step = report.steps[index];
  assert.ok(step !== undefined, `轨迹里应当有第 ${index} 步（实际 ${report.steps.length} 步）`);
  return step;
}

function eventsOf(events: RunEvent[], type: RunEvent["type"]): RunEvent[] {
  return events.filter((event) => event.type === type);
}

/**
 * 把引擎报的请求数放大，模拟「一次决策重试了 n 次才成功」。
 *
 * `Usage.requests` 是**实际 HTTP 请求数**，预算与断言都按它算（§11.2 ⑤）。
 * scripted 永远报 1，所以这个包装是验证「重试不是免费通道」的唯一办法。
 */
function withRequests(inner: DecisionEngine, requests: number): DecisionEngine {
  return {
    name: inner.name,
    capabilities: inner.capabilities,
    async decide(req, signal) {
      const result = await inner.decide(req, signal);
      return { ...result, usage: { ...result.usage, requests } };
    },
    async writeText(req, signal) {
      const result = await inner.writeText(req, signal);
      return { ...result, usage: { ...result.usage, requests } };
    },
    close: () => inner.close(),
  };
}

/** 只点一下链接的一步（`click_target` 的候选 id 就是元素索引 `"1"`）。 */
function clickLink(): ScriptedStep {
  return { operation: { choice: "CLICK" }, targets: { click_target: { choice: "1" } } };
}

function done(): ScriptedStep {
  return { operation: { choice: "DONE" } };
}

const ACCEPTED: ScriptedStep = {
  operation: { choice: "TYPE_TEXT" },
  targets: { type_text_target: { choice: "2" } },
  text: "Ada Lovelace",
};

/** 一个可点、可填、可滚、可等的页面。 */
function richPage(overrides: Partial<Observation> = {}): Observation {
  return makeObservation({ actions: interactiveActions(), ...overrides });
}

// ---------------------------------------------------------------------------
// 不变量 4：废弃的决策不产生副作用
// ---------------------------------------------------------------------------

test("不变量 4：终止决策在页面变化后作废，不产生任何副作用，重新观测后重判", async () => {
  const pageA = richPage({ fingerprint: "fp-a", url: "https://example.test/a" });
  const pageB = richPage({ fingerprint: "fp-b", url: "https://example.test/b" });
  let freshChecks = 0;

  const session = new FakeSession({
    observations: [pageA, pageB],
    // 第一次新鲜度复查判「陈旧」，之后判新鲜：正好把「丢弃一次、重走一步」写出来
    freshness: () => {
      freshChecks += 1;
      return freshChecks > 1;
    },
  });
  const engine = createScriptedEngine({ steps: [done(), done()] });

  const { report, events } = await runCase({ caseDef: makeCase(), session, engine });

  assert.equal(report.status, "done", "第二次（新鲜的）DONE 才作数");
  assert.equal(session.actCount, 0, "被丢弃的决策绝不能产生浏览器动作");
  assert.equal(report.steps.length, 0, "被丢弃的决策不产生 StepRecord");
  assert.equal(eventsOf(events, "step.skipped").length, 1, "丢弃要留下 step.skipped 的痕迹");
  assert.equal(session.observeCalls, 1, "丢弃之后必须重新观测一次（goto 那次不算在内）");
});

test("不变量 4（输入前复查）：陈旧的输入决策既不生成文本也不执行", async () => {
  const pageA = richPage({ fingerprint: "fp-a" });
  const pageB = richPage({ fingerprint: "fp-b" });
  let freshChecks = 0;

  const session = new FakeSession({
    observations: [pageA, pageB],
    freshness: () => {
      freshChecks += 1;
      return freshChecks > 1;
    },
  });
  let writeTextCalls = 0;
  const inner = createScriptedEngine({ steps: [ACCEPTED, ACCEPTED, done()] });
  const engine: DecisionEngine = {
    ...inner,
    decide: (req, signal) => inner.decide(req, signal),
    async writeText(req, signal) {
      writeTextCalls += 1;
      return inner.writeText(req, signal);
    },
  };

  const { report } = await runCase({ caseDef: makeCase(), session, engine });

  assert.equal(writeTextCalls, 1, "第一次决策是陈旧的：连文本都不该生成（省一次模型调用）");
  assert.equal(session.actCount, 1, "只有复查通过的那一次才执行");
  assert.equal(stepAt(report, 0).text, "Ada Lovelace");
  assert.equal(stepAt(report, 0).executed, true);
});

test("act 抛 StalePage（输入前的新鲜度复查）时：决策作废、重新观测，而不是判成运行故障", async () => {
  // 这条来自一次真跑：往 Wikipedia 的搜索框输入之后，页面自己开始渲染候选列表，
  // 于是「决策作出」与「输入」之间那几十毫秒里页面就变了，act 的新鲜度复查立刻
  // 抛 StalePage。而它此前会把整轮运行判成 error——一次**没有产生任何副作用**的
  // 决策作废，被记成了基建故障。
  //
  // 前提是 act 抛出的 StalePage / OccludedTarget 都发生在输入之前
  // （输入后的 settle 刻意吞异常，见 playwright-session.ts）。这条测试同时
  // 锁住那个前提的**使用方式**：只重新观测、绝不重放这次动作。
  const pageA = richPage({ fingerprint: "fp-a" });
  const pageB = richPage({ fingerprint: "fp-b" });
  let actThrows = true;

  const session = new FakeSession({
    observations: [pageA, pageB],
    onAct: () => {
      if (actThrows) {
        actThrows = false;
        throw new StalePage("动作 e4（Search）所依据的页面状态已经变化，已放弃执行");
      }
    },
  });
  const engine = createScriptedEngine({
    steps: [{ operation: { choice: "CLICK" }, targets: { click_target: { choice: "1" } } }, done()],
  });

  const { report, events } = await runCase({ caseDef: makeCase(), session, engine });

  assert.equal(report.status, "done", "作废一次之后应当继续跑完，而不是以 error 收场");
  assert.equal(session.actCount, 1, "act 只被调用一次：作废不等于重试（§6.2）");
  assert.equal(report.steps.length, 0, "没有执行过的动作不能进轨迹——那会让报告说谎");
  assert.equal(eventsOf(events, "step.skipped").length, 1, "作废要留下 step.skipped 的痕迹");
  // 用 find 而不是 eventsOf：它是判别联合，TS 会按 `type` 收窄，`.reason` 才可访问。
  const skipped = events.find((event) => event.type === "step.skipped");
  assert.ok(skipped !== undefined);
  assert.match(skipped.reason, /未执行|未收到任何输入/);
  // 起始页由 goto 给出（不计入 observeCalls），所以「重新观测一次」就是 1。
  assert.equal(session.observeCalls, 1, "作废之后必须重新观测一次");
});

// ---------------------------------------------------------------------------
// 不变量 2 + 3：变更不重试 / 先记日志再观测
// ---------------------------------------------------------------------------

test("不变量 2+3：动作只执行一次，且执行后的观测失败不会抹掉这一步", async () => {
  const pageA = richPage({ fingerprint: "fp-a", url: "https://example.test/a" });
  const pageB = richPage({ fingerprint: "fp-b", url: "https://example.test/b" });

  const session = new FakeSession({
    // 动作之后的第一次观测被导航打断（StalePage），随后的重读成功
    observations: [pageA, { error: new StalePage("执行上下文已销毁") }, pageB],
  });
  const engine = createScriptedEngine({ steps: [clickLink(), done()] });

  const { report } = await runCase({ caseDef: makeCase(), session, engine });

  assert.equal(session.actCount, 1, "浏览器变更从不重试：一次动作 = 一次 act");
  assert.equal(report.steps.length, 1, "观测失败也不许把「我们点过了」从轨迹里抹掉");
  const step = stepAt(report, 0);
  assert.equal(step.executed, true);
  assert.equal(step.pageChanged, null, "观测失败记 null，绝不当成「没变化」");
  assert.equal(step.urlAfter, null);
  assert.equal(step.urlBefore, pageA.url, "urlBefore 是动作之前那一页");
  assert.equal(report.status, "done");
});

test("不变量 2：一次成功变更之后，文本缓存清空（不复用为旧页面生成的值）", async () => {
  const session = new FakeSession({
    observations: [
      richPage({ fingerprint: "fp-0" }),
      richPage({ fingerprint: "fp-1" }),
      richPage({ fingerprint: "fp-2" }),
    ],
  });
  let writeTextCalls = 0;
  const inner = createScriptedEngine({ steps: [ACCEPTED, clickLink(), ACCEPTED, done()] });
  const engine: DecisionEngine = {
    ...inner,
    decide: (req, signal) => inner.decide(req, signal),
    async writeText(req, signal) {
      writeTextCalls += 1;
      return inner.writeText(req, signal);
    },
  };

  const { report } = await runCase({ caseDef: makeCase(), session, engine });

  assert.equal(report.steps.length, 3, "两次输入 + 一次点击");
  assert.equal(writeTextCalls, 2, "中间那次成功点击必须清掉缓存：第二次输入要重新生成");
  assert.equal(stepAt(report, 0).textEngine, "scripted", "生成过就记引擎名");
  assert.equal(stepAt(report, 2).textEngine, "scripted");
});

// ---------------------------------------------------------------------------
// 不变量 5：无进展检测
// ---------------------------------------------------------------------------

test("不变量 5：连续 N 步页面无变化且非 wait -> blocked", async () => {
  const page = richPage({ fingerprint: "fp-stuck" });
  const session = new FakeSession({ observations: [page] });
  const engine = createScriptedEngine({ steps: constantSteps(clickLink(), 5) });

  const { report } = await runCase({ caseDef: makeCase(), session, engine });

  assert.equal(report.status, "blocked");
  assert.equal(report.steps.length, DEFAULT_NO_PROGRESS_LIMIT, "第 3 次无变化即判定卡死");
  assert.equal(session.actCount, DEFAULT_NO_PROGRESS_LIMIT);
  assert.ok(report.steps.every((step) => step.pageChanged === false));
  assert.match(report.failureReason ?? "", /连续 3 步/);
});

test("不变量 5：pageChanged 为 null 不计入连续计数（否则正常导航会被误判卡死）", async () => {
  const page = richPage({ fingerprint: "fp-same" });
  const session = new FakeSession({
    // 第一个动作之后观测失败（null），之后都是同一个页面（false）
    observations: [page, { error: new StalePage("导航打断了观测") }, page],
  });
  const caseDef = makeCase({
    // 用例可覆盖门槛：上游把 3 写死在代码里，这里泛化成 maxIdenticalConsecutive
    assertions: { trajectory: { maxIdenticalConsecutive: 2, statusIn: ["blocked"] } },
  });
  const engine = createScriptedEngine({ steps: constantSteps(clickLink(), 5) });

  const { report } = await runCase({ caseDef, session, engine });

  assert.equal(report.status, "blocked");
  assert.equal(
    report.steps.length,
    3,
    "第 0 步是 null（不计入），第 1、2 步才是 false——若 null 被当成 false，这里只会有 2 步",
  );
  assert.equal(stepAt(report, 0).pageChanged, null);
  assert.equal(stepAt(report, 1).pageChanged, false);
  assert.equal(stepAt(report, 2).pageChanged, false);
  assert.match(report.failureReason ?? "", /连续 2 步/);
});

test("不变量 5：WAIT 不参与无进展计数（否则空转的等待会被判成卡死）", async () => {
  const page = richPage({ fingerprint: "fp-wait" });
  const session = new FakeSession({ observations: [page] });
  const waiting: ScriptedStep = { operation: { choice: "WAIT" } };
  const caseDef = makeCase({ budget: { maxSteps: 4 } });
  const engine = createScriptedEngine({
    steps: [
      waiting,
      { operation: { choice: "SCROLL_DOWN" } },
      waiting,
      { operation: { choice: "SCROLL_DOWN" } },
    ],
  });

  const { report } = await runCase({ caseDef, session, engine });

  // 4 步都无变化，但其中两步是 wait：没有卡死判定，一路走到预算上限
  assert.equal(report.status, "budget_exceeded");
  assert.equal(report.steps.length, 4);
});

// ---------------------------------------------------------------------------
// 护栏：命中即在执行前拦截
// ---------------------------------------------------------------------------

test("护栏命中：act 调用 0 次、executed=false、status=guardrail_blocked", async () => {
  const deleteButton = makeAction({ id: "e9", kind: "click", label: "Delete account", role: "button", node: 9 });
  const page = makeObservation({ fingerprint: "fp-guard", actions: [deleteButton] });
  const session = new FakeSession({ observations: [page] });
  const engine = createScriptedEngine({
    steps: [{ operation: { choice: "CLICK" }, targets: { click_target: { choice: "1" } } }],
  });

  const { report, events } = await runCase({ caseDef: makeCase(), session, engine });

  assert.equal(report.status, "guardrail_blocked");
  assert.equal(session.actCount, 0, "护栏命中时浏览器不能收到任何输入");
  const step = stepAt(report, 0);
  assert.equal(step.executed, false);
  assert.notEqual(step.blockReason, null, "拦截原因要写进轨迹，供报告解释");
  assert.equal(report.guardrailHits.length, 1);
  assert.equal(report.guardrailHits[0]?.action, "Delete account");
  assert.equal(eventsOf(events, "guardrail.blocked").length, 1);
  assert.equal(stepAt(report, 0).step, 0);
});

// ---------------------------------------------------------------------------
// 预算
// ---------------------------------------------------------------------------

test("预算超限：以 budget_exceeded 结束，且已有轨迹完整保留供断言求值", async () => {
  const session = new FakeSession({
    observations: [
      richPage({ fingerprint: "fp-0" }),
      richPage({ fingerprint: "fp-1" }),
      richPage({ fingerprint: "fp-2" }),
    ],
  });
  const caseDef = makeCase({
    budget: { maxSteps: 2 },
    assertions: { trajectory: { statusIn: ["budget_exceeded"] } },
  });
  const engine = createScriptedEngine({ steps: constantSteps(clickLink(), 4) });

  const { report } = await runCase({ caseDef, session, engine });

  assert.equal(report.status, "budget_exceeded");
  assert.equal(report.steps.length, 2, "轨迹保留：跑到一半仍然有解释价值");
  assert.equal(session.actCount, 2);
  assert.match(report.failureReason ?? "", /步数上限/);
  assert.notEqual(report.assertion, null, "预算耗尽不是异常：断言层照样对已有轨迹求值");
});

// ---------------------------------------------------------------------------
// 取消只在步边界生效
// ---------------------------------------------------------------------------

test("取消：在步边界生效，已经开始的那次浏览器变更会做完", async () => {
  const controller = new AbortController();
  const session = new FakeSession({
    observations: [richPage({ fingerprint: "fp-0" }), richPage({ fingerprint: "fp-1" })],
    // 在第一次动作中间请求取消：这正是「跑到一半被叫停」的真实时序
    onAct: () => controller.abort(),
  });
  const engine = createScriptedEngine({ steps: constantSteps(clickLink(), 3) });

  const { report } = await runCase({ caseDef: makeCase(), session, engine, signal: controller.signal });

  assert.equal(report.status, "cancelled");
  assert.equal(session.actCount, 1, "已经开始的变更会做完，不会留下「点了一半」的状态");
  assert.equal(report.steps.length, 1, "轨迹保留");
  assert.match(report.failureReason ?? "", /取消/);
});

test("取消：首个步边界之前就中止时不打开页面，也不产生断言结论", async () => {
  const controller = new AbortController();
  controller.abort();
  const session = new FakeSession({ observations: [richPage()] });
  const engine = createScriptedEngine({ steps: constantSteps(clickLink(), 1) });

  const { report } = await runCase({ caseDef: makeCase(), session, engine, signal: controller.signal });

  assert.equal(report.status, "cancelled");
  assert.equal(session.gotoUrls.length, 0, "取消后不该再打开页面");
  assert.equal(session.observeCalls, 0);
  assert.equal(report.steps.length, 0);
  assert.equal(report.assertion, null, "没观测到页面 => 断言层根本没跑（与 passed:null 是两件事）");
  assert.equal(report.passed, null);
});

// ---------------------------------------------------------------------------
// 准入：只采集一次
// ---------------------------------------------------------------------------

test("准入：只在第一次观测之后采集一次", async () => {
  const session = new FakeSession({
    observations: [
      richPage({ fingerprint: "fp-0" }),
      richPage({ fingerprint: "fp-1" }),
      richPage({ fingerprint: "fp-2" }),
    ],
    // 文件上传是 blocking 规则（admission.ts 的 file-upload），用来验「准入不是运行的闸」
    admission: { fileInputs: 1 },
  });
  const engine = createScriptedEngine({ steps: [clickLink(), clickLink(), done()] });

  const { report } = await runCase({ caseDef: makeCase(), session, engine });

  assert.equal(session.probeCalls, 1, "准入是记录与警告，不是每步都要重算的东西");
  assert.notEqual(report.admission, null);
  assert.equal(report.admission?.ok, false, "命中文件上传（平台不支持）");
  assert.ok((report.admission?.blocking.length ?? 0) > 0);
  assert.equal(report.status, "done", "准入不是运行的闸：blocking 项不阻止运行");
});

test("准入：探测失败只探一次，写一条 warn，然后照常跑完", async () => {
  const session = new FakeSession({
    observations: [richPage({ fingerprint: "fp-0" }), richPage({ fingerprint: "fp-1" }), richPage({ fingerprint: "fp-2" })],
    probeError: new Error("页面还没稳定"),
  });
  const engine = createScriptedEngine({ steps: [clickLink(), clickLink(), done()] });

  const { report, events } = await runCase({ caseDef: makeCase(), session, engine });

  // 探测失败时不能拿 `admission === null` 当「还没探过」的判据，否则每一步都会重探
  assert.equal(session.probeCalls, 1);
  assert.equal(report.admission, null);
  const warns = eventsOf(events, "run.log").filter((event) => event.type === "run.log" && event.level === "warn");
  assert.equal(warns.length, 1, "探测失败要说清楚，但只是 warn");
  assert.equal(report.status, "done", "一条附注不该让整个运行失败");
});

// ---------------------------------------------------------------------------
// 成本口径：两个计数必须分开记
// ---------------------------------------------------------------------------

test("成本口径：modelCalls 含重试，decisions 不含——两者分开记才能读出重试量", async () => {
  const session = new FakeSession({ observations: [richPage({ fingerprint: "fp-0" }), richPage({ fingerprint: "fp-1" })] });
  const engine = withRequests(createScriptedEngine({ steps: [clickLink(), done()] }), 3);

  const { report } = await runCase({ caseDef: makeCase(), session, engine });

  assert.equal(report.stats.decisions, 2, "两步决策：一次点击 + 一次终止");
  assert.equal(report.stats.modelCalls, 6, "每次决策重试 3 次 => 3 个真实请求，都计费");
  assert.equal(
    report.stats.modelCalls - report.stats.decisions,
    4,
    "这个差值就是「重试造成的额外请求数」——decisions 恒为 0 会让这个读数失效",
  );
});

test("成本口径：writeText 只加 modelCalls，不加 decisions", async () => {
  const session = new FakeSession({ observations: [richPage({ fingerprint: "fp-0" }), richPage({ fingerprint: "fp-1" })] });
  const engine = createScriptedEngine({ steps: [ACCEPTED, done()] });

  const { report } = await runCase({ caseDef: makeCase(), session, engine });

  assert.equal(report.stats.decisions, 2, "两次决策：输入 + 终止（取值不是决策）");
  assert.equal(report.stats.modelCalls, 3, "取值也是一次真实请求，必须计入成本");
  assert.ok(report.stats.inputTokens > 0);
  assert.equal(report.stats.costUsd, null, "引擎未报金额时是「未知」，不能用 0 冒充");
});

// ---------------------------------------------------------------------------
// 事件与身份
// ---------------------------------------------------------------------------

test("身份：agent 只用占位 runId，不编造一个看起来像真的 id", async () => {
  const session = new FakeSession({ observations: [richPage({ fingerprint: "fp-0" }), richPage({ fingerprint: "fp-1" })] });
  const engine = createScriptedEngine({ steps: [clickLink(), done()] });

  const { report, events } = await runCase({ caseDef: makeCase(), session, engine });

  assert.ok(events.length > 0);
  assert.ok(
    events.every((event) => event.runId === ""),
    "管道字段 runId 由 runner 的盖章 sink 补，agent 不猜",
  );
  assert.equal(report.runId, "", "报告里的 runId 同样是占位，由 runner 的 completeReport 补");
  assert.equal(report.caseRevision, 0, "revision 0 = 来源未知（真实值由 store.freeze 定稿）");
  assert.equal(report.caseDigest, "");
  assert.equal(report.suiteRunId, null);
});

test("正常路径：断言求值结果进报告，三态判决不被压成两态", async () => {
  const session = new FakeSession({ observations: [richPage({ fingerprint: "fp-0" }), richPage({ fingerprint: "fp-1" })] });
  const caseDef = makeCase({
    assertions: {
      trajectory: { statusIn: ["done"] },
      final: { url: { contains: ["example.test"] }, text: { contains: ["hello"] } },
    },
  });
  const engine = createScriptedEngine({ steps: [clickLink(), done()] });

  const { report, events } = await runCase({ caseDef, session, engine });

  assert.equal(report.status, "done");
  const assertion = report.assertion;
  assert.ok(assertion !== null);
  assert.equal(assertion.passed, true, "全通过");
  assert.equal(report.passed, true);
  assert.equal(eventsOf(events, "assertion.evaluated").length, 1);
});

test("正常路径：degenerate 分布下概率类检查标 skipped -> 整体判 null（未判定）", async () => {
  const session = new FakeSession({ observations: [richPage({ fingerprint: "fp-0" }), richPage({ fingerprint: "fp-1" })] });
  const caseDef = makeCase({
    assertions: {
      trajectory: { statusIn: ["done"] },
      quality: { minTargetProbability: 0.3 },
    },
  });
  const engine = createScriptedEngine({ steps: [clickLink(), done()], probabilities: "degenerate" });

  const { report } = await runCase({ caseDef, session, engine });

  const assertion = report.assertion;
  assert.ok(assertion !== null);
  assert.equal(
    assertion.passed,
    null,
    "有检查被跳过而无失败 => 未判定。判 true 就是 D9 要杜绝的谎报覆盖",
  );
  assert.equal(report.passed, null);
});
