/**
 * 断言层的行为锁定（`src/core/checks.ts`）。
 *
 * 全部用**字面量构造** `Observation` / `StepRecord`：不启浏览器、不调引擎、不碰网络。
 * 断言层的输入本来就只是两个普通对象，因此这些测试既快又完全确定。
 *
 * 这里盯得最紧的两件事：
 *   1. **`skipped` 不是 `passed`。** degenerate 分布下概率检查必须跳过，
 *      聚合必须得 `null` 而不是 `true`——判 `true` 就是 D9 要杜绝的谎报覆盖。
 *   2. **稳定路径的字符串形状。** `final.text.contains[0]` 这种 key 是报告与前端
 *      之间的接口（docs/report-format.md §2.6），改一个字就会让旧报告的路径指不到东西。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { aggregateChecks, checkFinal, checkQuality, checkTrajectory, evaluateAssertions } from "../src/core/checks.ts";
import type { CheckContext } from "../src/core/checks.ts";
import type { Action, Observation } from "../src/browser/session.ts";
import type { Assertions } from "../src/schema/case.ts";
import type { RunStats } from "../src/schema/events.ts";
import type { CheckResult, StepRecord } from "../src/schema/report.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function checkAt(checks: Record<string, CheckResult>, key: string): CheckResult {
  const found = checks[key];
  assert.ok(found !== undefined, `缺少检查项 ${key}（实际有：${Object.keys(checks).join(", ")}）`);
  return found;
}

function actionWith(over: Partial<Action> = {}): Action {
  return { id: "e1", kind: "click", label: "Search", role: "searchbox", value: "Gödel", ...over };
}

function pageWith(over: Partial<Observation> = {}): Observation {
  return {
    url: "https://example.test/wiki",
    title: "Incompleteness theorems",
    text: "The first incompleteness theorem",
    textTruncated: false,
    w: 1280,
    h: 720,
    scroll: { y: 0, height: 2400 },
    actions: [actionWith()],
    omittedActions: 0,
    marker: null,
    pageKey: null,
    guards: {},
    fingerprint: "fp",
    ...over,
  };
}

function stepWith(over: Partial<StepRecord> = {}): StepRecord {
  return {
    step: 1,
    action: "点击「Search」",
    kind: "click",
    role: "button",
    operation: "CLICK",
    target: "e1",
    probability: 0.9,
    operationProbability: 0.9,
    confidence: 0.8,
    distribution: "full",
    executed: true,
    blockReason: null,
    text: null,
    textEngine: null,
    urlBefore: "https://example.test/",
    urlAfter: "https://example.test/wiki",
    pageChanged: true,
    engineLatencyMs: 120,
    textLatencyMs: 0,
    observedMs: 1000,
    frame: null,
    engineUsage: { inputTokens: 100, outputTokens: 20, costUsd: 0.001, requests: 1 },
    ...over,
  };
}

function statsWith(over: Partial<RunStats> = {}): RunStats {
  return {
    steps: 0,
    modelCalls: 0,
    decisions: 0,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: null,
    elapsedMs: 0,
    engineLatencyMs: 0,
    ...over,
  };
}

function ctxWith(over: Partial<CheckContext> = {}): CheckContext {
  return { final: pageWith(), history: [], status: "done", stats: statsWith(), guardrailHits: [], ...over };
}

// ---------------------------------------------------------------------------
// 三态的聚合：skipped 不是 passed
// ---------------------------------------------------------------------------

test("聚合：有失败时判 false，即使同时有跳过", () => {
  const passed: CheckResult = { passed: true, skipped: false, detail: "ok" };
  const failed: CheckResult = { passed: false, skipped: false, detail: "no" };
  const skipped: CheckResult = { passed: false, skipped: true, detail: "无法求值" };

  assert.equal(aggregateChecks({ a: passed, b: skipped }), null, "7 条通过 + 1 条跳过 = 未判定，不是通过");
  assert.equal(aggregateChecks({ a: passed, b: passed }), true);
  assert.equal(aggregateChecks({ a: passed, b: skipped, c: failed }), false, "失败优先于跳过");
  assert.equal(aggregateChecks({}), null, "没有任何检查项不构成通过");
});

test("聚合：degenerate 分布下概率检查 skipped，整体判 null 而非 true", () => {
  // 通用 LLM 只给一个选择，合成出的分布是 one-hot 1.0：概率恒为 1，
  // 拿它比下限必然「通过」——这正是 docs/architecture.md §5.3 要防的假通过。
  const history = [stepWith({ distribution: "degenerate", probability: 1, operationProbability: 1 })];
  const assertions: Assertions = { quality: { minTargetProbability: 0.3, minOperationProbability: 0.4 } };

  const result = evaluateAssertions(assertions, ctxWith({ history }));

  for (const key of ["quality.minTargetProbability", "quality.minOperationProbability"]) {
    const check = checkAt(result.checks, key);
    assert.equal(check.skipped, true, `${key} 必须标 skipped`);
    assert.equal(check.passed, false, "skipped 的 passed 恒为 false——三态由两个字段合起来表达");
    assert.match(check.detail, /无法求值/);
  }

  assert.equal(result.passed, null, "有跳过而无失败时整体是「未判定」，判 true 就是谎报覆盖");
});

test("质量：无步可求值时概率检查 skipped 而非 passed", () => {
  const checks = checkQuality([], statsWith(), { minTargetProbability: 0.3, minOperationProbability: 0.4 });

  assert.equal(checkAt(checks, "quality.minTargetProbability").skipped, true);
  assert.equal(checkAt(checks, "quality.minOperationProbability").skipped, true);
  assert.equal(aggregateChecks(checks), null);
});

// ---------------------------------------------------------------------------
// PROBABILITY_SAMPLING 的四条约束，逐条一个测试
// ---------------------------------------------------------------------------

test("取样约束 1：只取 executed: true 的步——被护栏拦下的步的概率不算决策质量", () => {
  // 被拦下的那步「概率很低」，但浏览器一个字节都没收到：它不是模型犹豫的证据。
  const guarded = stepWith({ step: 1, executed: false, blockReason: "命中禁止动作", probability: 0.01, operationProbability: 0.01 });

  const only = checkQuality([guarded], statsWith(), { minTargetProbability: 0.5, minOperationProbability: 0.5 });
  assert.equal(checkAt(only, "quality.minTargetProbability").skipped, true, "只被拦下的步可求值时必须跳过，不能拿它判失败");
  assert.match(checkAt(only, "quality.minTargetProbability").detail, /executed: false/);

  // 有一步真的执行过（0.9）时，取样只看它：仍应通过，而不是被那步 0.01 拖成失败。
  const mixed = checkQuality([guarded, stepWith({ step: 2, probability: 0.9, operationProbability: 0.9 })], statsWith(), {
    minTargetProbability: 0.5,
  });
  assert.equal(checkAt(mixed, "quality.minTargetProbability").passed, true);
});

test("取样约束 2：operation 概率只在 distribution === full 的步上求值", () => {
  // degenerate 那步的 operation 概率是合成的低值：若被计入就会判失败。
  const history = [
    stepWith({ step: 1, distribution: "degenerate", probability: 1, operationProbability: 0.05 }),
    stepWith({ step: 2, distribution: "full", probability: 1, operationProbability: 0.9 }),
  ];

  const checks = checkQuality(history, statsWith(), { minOperationProbability: 0.5 });
  const check = checkAt(checks, "quality.minOperationProbability");

  assert.equal(check.passed, true, "degenerate 的步必须被排除，否则会拿合成分布判失败");
  assert.match(check.detail, /在 1 步上求值/, "只有 full 的那一步参与求值");
});

test("取样约束 3：target 概率额外要求该步确实选了目标", () => {
  // DONE / BLOCKED / scroll / wait 没有 target，其 probability 没有「被选中目标」的含义。
  const done = stepWith({ step: 1, operation: "DONE", kind: "click", target: null, probability: 0.05, operationProbability: 0.9 });

  const targetOnly = checkQuality([done], statsWith(), { minTargetProbability: 0.5 });
  assert.equal(checkAt(targetOnly, "quality.minTargetProbability").skipped, true, "无目标可言的步不能拿来判 target 下限");
  assert.match(checkAt(targetOnly, "quality.minTargetProbability").detail, /没有选中目标/);

  // 同一个步的 operation 概率照常求值：没有目标是 target 侧特有的限制。
  const operationSide = checkQuality([done], statsWith(), { minOperationProbability: 0.5 });
  assert.equal(checkAt(operationSide, "quality.minOperationProbability").passed, true);
});

test("取样约束 4：聚合取 min——某一步很犹豫不能被平均稀释", () => {
  const history = [
    stepWith({ step: 1, probability: 0.9 }),
    stepWith({ step: 2, probability: 0.9 }),
    stepWith({ step: 3, probability: 0.2 }),
  ];

  const check = checkAt(checkQuality(history, statsWith(), { minTargetProbability: 0.5 }), "quality.minTargetProbability");

  // 平均是 0.667（会通过），min 是 0.2（必须失败）。
  assert.equal(check.passed, false, "取 min 才能抓住「某一步很犹豫」");
  assert.match(check.detail, /0\.200/);
  assert.match(check.detail, /第 3 步/);
  assert.match(check.detail, /取最小值而非平均/);
});

// ---------------------------------------------------------------------------
// final 族
// ---------------------------------------------------------------------------

const FINAL_ASSERTIONS: Assertions["final"] = {
  url: { equals: "https://example.test/wiki", matches: ["wiki$"] },
  title: { contains: ["Incompleteness"] },
  text: { contains: ["first incompleteness"], notContains: ["Search results"] },
  controls: [
    { labelContains: "Search", role: "searchbox", valueContains: "Gödel" },
    { labelContains: "Create account", exists: false },
  ],
};

test("final：最终页面为 null 时全族 skipped，没有一条判失败", () => {
  const checks = checkFinal(null, FINAL_ASSERTIONS);

  assert.ok(Object.keys(checks).length > 0, "跳过也要产出检查项，否则界面上的条目会忽多忽少");
  for (const [key, check] of Object.entries(checks)) {
    assert.equal(check.skipped, true, `${key} 应为 skipped`);
    assert.equal(check.passed, false, `${key} 的 passed 恒为 false`);
  }
  assert.equal(aggregateChecks(checks), null, "「没看到页面」是未判定，不是失败");
});

test("final：两种情况下产出的 key 集合完全相同", () => {
  // 同一份用例，一次有页面一次没有：key 集合必须一致，否则界面会忽多忽少。
  const withPage = Object.keys(checkFinal(pageWith(), FINAL_ASSERTIONS)).sort();
  const withoutPage = Object.keys(checkFinal(null, FINAL_ASSERTIONS)).sort();

  assert.deepEqual(withoutPage, withPage);
  assert.deepEqual(withPage, [
    "final.controls[0].exists",
    "final.controls[0].valueContains",
    "final.controls[1].exists",
    "final.text.contains[0]",
    "final.text.notContains[0]",
    "final.title.contains[0]",
    "final.url.equals",
    "final.url.matches[0]",
  ]);
});

test("final：非法正则报成「用例错误」而不是页面不符", () => {
  const checks = checkFinal(pageWith(), { url: { matches: ["(unclosed"] } });
  const check = checkAt(checks, "final.url.matches[0]");

  assert.equal(check.passed, false);
  assert.equal(check.skipped, false, "用例自己写错了，不能标 skipped——那会让 CI 看不出要用例修");
  assert.match(check.detail, /用例错误/);
  assert.match(check.detail, /无法编译/);
});

test("final：exists: false 时元素存在即失败，不存在即通过且值类断言跳过", () => {
  const absent = checkFinal(pageWith({ actions: [actionWith({ label: "Search" })] }), {
    controls: [{ labelContains: "Create account", exists: false, valueEquals: "x" }],
  });

  assert.equal(checkAt(absent, "final.controls[0].exists").passed, true);
  assert.equal(checkAt(absent, "final.controls[0].valueEquals").skipped, true, "元素不存在时值无从比较，判失败是谎报");

  const present = checkFinal(pageWith(), { controls: [{ labelContains: "Search", exists: false }] });
  assert.equal(checkAt(present, "final.controls[0].exists").passed, false);
});

test("final：元素表被截断时，「找不到」两个方向都不构成证据", () => {
  // 断言存在：找不到可能只是被丢掉了 -> skipped（不是失败）
  const wanted = checkFinal(pageWith({ actions: [], omittedActions: 7 }), {
    controls: [{ labelContains: "Create account", exists: true }],
  });
  assert.equal(checkAt(wanted, "final.controls[0].exists").skipped, true);

  // 断言不存在：找不到同样可能只是被丢掉了 -> skipped（**不是通过**）。
  // 判通过就是假通过：我们并不知道那个元素是不是在被省略的那部分里。
  const unwanted = checkFinal(pageWith({ actions: [], omittedActions: 7 }), {
    controls: [{ labelContains: "Create account", exists: false }],
  });
  assert.equal(checkAt(unwanted, "final.controls[0].exists").skipped, true, "截断的元素表上「没找到」不能证明不存在");

  // 元素确实在表里时照常判定：截断不影响「找到」这种正面证据。
  const found = checkFinal(pageWith({ omittedActions: 7 }), { controls: [{ labelContains: "Search", exists: false }] });
  assert.equal(checkAt(found, "final.controls[0].exists").passed, false);
});

test("final：可见文本被截断时「未找到」降级为 skipped，命中类失败保持失败", () => {
  const page = pageWith({ text: "The first incompleteness theorem", textTruncated: true });
  const checks = checkFinal(page, { text: { contains: ["Gödel"], notContains: ["theorem"] } });

  assert.equal(checkAt(checks, "final.text.contains[0]").skipped, true, "截断的文本里找不到，不能证明页面上没有");
  // notContains 相反：在截断后的可见文本里命中了，那是真凭据。
  assert.equal(checkAt(checks, "final.text.notContains[0]").passed, false);
});

// ---------------------------------------------------------------------------
// trajectory 族
// ---------------------------------------------------------------------------

test("trajectory：mustUse 只认真的执行过的步", () => {
  const blocked = stepWith({ step: 1, action: "点击「Search」", executed: false, blockReason: "命中禁止动作" });

  const only = checkTrajectory([blocked], "done", { mustUse: [{ labelContains: "Search" }] });
  assert.equal(checkAt(only, "trajectory.mustUse[0]").passed, false, "「模型想做」不是「做过」");
  assert.match(checkAt(only, "trajectory.mustUse[0]").detail, /executed: false/);

  const executed = checkTrajectory([blocked, stepWith({ step: 2, action: "点击「Search」" })], "done", {
    mustUse: [{ labelContains: "Search" }],
  });
  assert.equal(checkAt(executed, "trajectory.mustUse[0]").passed, true);
});

test("trajectory：mustNotUse 命中即失败，并把护栏有没有生效写进详情", () => {
  const hits = checkTrajectory([stepWith({ step: 3, action: "点击「Delete account」", executed: false, blockReason: "命中禁止动作" })], "done", {
    mustNotUse: [{ labelContains: "Delete" }],
  });
  const check = checkAt(hits, "trajectory.mustNotUse[0]");

  assert.equal(check.passed, false, "「尝试去点删除」本身就是要报出来的事实，与它有没有被拦下无关");
  assert.match(check.detail, /executed: false/);
  assert.match(check.detail, /已被护栏拦下/);

  const clean = checkTrajectory([stepWith()], "done", { mustNotUse: [{ labelContains: "Delete" }] });
  assert.equal(checkAt(clean, "trajectory.mustNotUse[0]").passed, true);
});

test("trajectory：statusIn 在运行未结束时不判失败，而是跳过", () => {
  const pending = checkTrajectory([], "running", { statusIn: ["done"] });
  assert.equal(checkAt(pending, "trajectory.statusIn").skipped, true, "循环还没退出，此刻比较毫无意义");

  const finished = checkTrajectory([], "budget_exceeded", { statusIn: ["done"] });
  assert.equal(checkAt(finished, "trajectory.statusIn").passed, false);
});

test("trajectory：无进展计数只认 executed 且非 wait 的「确实没变化」", () => {
  const stuck = [
    stepWith({ step: 1, pageChanged: false }),
    stepWith({ step: 2, pageChanged: false }),
    stepWith({ step: 3, pageChanged: false }),
  ];

  const failed = checkAt(checkTrajectory(stuck, "done", { maxIdenticalConsecutive: 3 }), "trajectory.maxIdenticalConsecutive");
  assert.equal(failed.passed, false);

  // wait 本来就不该让页面变化；被拦下的步更是浏览器没收到输入——都不算卡死。
  const excused = [
    stepWith({ step: 1, kind: "wait", pageChanged: false }),
    stepWith({ step: 2, executed: false, pageChanged: false, blockReason: "命中禁止动作" }),
    stepWith({ step: 3, pageChanged: false }),
  ];
  assert.equal(
    checkAt(checkTrajectory(excused, "done", { maxIdenticalConsecutive: 2 }), "trajectory.maxIdenticalConsecutive").passed,
    true,
  );

  // pageChanged 为 null 是「没能观测」（例如导航打断），不是「没有变化」——
  // 把它算成 false 会在页面正常导航时误判卡死。
  const unobserved = [
    stepWith({ step: 1, pageChanged: null }),
    stepWith({ step: 2, pageChanged: null }),
    stepWith({ step: 3, pageChanged: null }),
  ];
  assert.equal(
    checkAt(checkTrajectory(unobserved, "done", { maxIdenticalConsecutive: 2 }), "trajectory.maxIdenticalConsecutive").passed,
    true,
  );
});

// ---------------------------------------------------------------------------
// quality 族的成本项
// ---------------------------------------------------------------------------

test("quality：costUsd 为 null 时金额检查跳过，不是通过也不是失败", () => {
  const unknown = checkQuality([], statsWith({ costUsd: null }), { maxCostUsd: 0.25 });
  const check = checkAt(unknown, "quality.maxCostUsd");

  assert.equal(check.skipped, true, "引擎没报金额，不为一个我们根本不知道的数字背书");
  assert.equal(check.passed, false);
  assert.match(check.detail, /costUsd 为 null/);

  assert.equal(checkAt(checkQuality([], statsWith({ costUsd: 0.5 }), { maxCostUsd: 0.25 }), "quality.maxCostUsd").passed, false);
  assert.equal(checkAt(checkQuality([], statsWith({ costUsd: 0.1 }), { maxCostUsd: 0.25 }), "quality.maxCostUsd").passed, true);
});

test("quality：modelCalls 按含重试的实际请求数算，且详情说清重试多少次", () => {
  const check = checkAt(
    checkQuality([], statsWith({ modelCalls: 24, decisions: 8 }), { maxModelCalls: 40 }),
    "quality.maxModelCalls",
  );

  assert.equal(check.passed, true);
  assert.match(check.detail, /24 次模型调用（8 次决策，含 16 次重试）/, "modelCalls - decisions 就是重试造成的额外请求");
});

// ---------------------------------------------------------------------------
// 稳定路径的形状（报告与前端之间的接口）
// ---------------------------------------------------------------------------

test("稳定路径：全部 key 逐条与 docs/report-format.md §2.6 的形状一致", () => {
  const history = [
    stepWith({ step: 1, target: null, probability: 0.9, pageChanged: false }),
    stepWith({ step: 2, probability: 0.8 }),
  ];
  const assertions: Assertions = {
    final: {
      url: { equals: "https://example.test/wiki" },
      title: { contains: ["Incompleteness"] },
      text: { contains: ["first"], notContains: ["Search results"], matches: ["theorem"] },
      controls: [{ labelContains: "Search", role: "searchbox", valueEquals: "Gödel", checked: true }],
    },
    trajectory: {
      statusIn: ["done"],
      maxSteps: 12,
      mustUse: [{ labelContains: "Search" }],
      mustNotUse: [{ labelContains: "Log in" }, { kind: "select" }],
      forbiddenKinds: ["fill"],
      maxIdenticalConsecutive: 3,
    },
    quality: {
      minOperationProbability: 0.4,
      minTargetProbability: 0.3,
      maxModelCalls: 24,
      maxElapsedMs: 30_000,
      maxInputTokens: 150_000,
      maxCostUsd: 0.25,
    },
  };

  const keys = Object.keys(evaluateAssertions(assertions, ctxWith({ history })).checks).sort();

  assert.deepEqual(keys, [
    "final.controls[0].checked",
    "final.controls[0].exists",
    "final.controls[0].valueEquals",
    "final.text.contains[0]",
    "final.text.matches[0]",
    "final.text.notContains[0]",
    "final.title.contains[0]",
    "final.url.equals",
    "quality.maxCostUsd",
    "quality.maxElapsedMs",
    "quality.maxInputTokens",
    "quality.maxModelCalls",
    "quality.minOperationProbability",
    "quality.minTargetProbability",
    "trajectory.forbiddenKinds[0]",
    "trajectory.maxIdenticalConsecutive",
    "trajectory.maxSteps",
    "trajectory.mustNotUse[0]",
    "trajectory.mustNotUse[1]",
    "trajectory.mustUse[0]",
    "trajectory.statusIn",
  ]);
});

test("稳定路径：下标紧跟在数组字段后面，标量匹配器用字段名本身", () => {
  const checks = checkFinal(pageWith(), {
    text: { contains: ["first", "second"], notContains: ["x", "y"], matches: ["a", "b"] },
    controls: [{ labelContains: "Search", valueEquals: "Gödel" }, { labelContains: "Search", valueContains: "öd" }],
  });

  assert.deepEqual(Object.keys(checks).sort(), [
    "final.controls[0].exists",
    "final.controls[0].valueEquals",
    "final.controls[1].exists",
    "final.controls[1].valueContains",
    "final.text.contains[0]",
    "final.text.contains[1]",
    "final.text.matches[0]",
    "final.text.matches[1]",
    "final.text.notContains[0]",
    "final.text.notContains[1]",
  ]);
});

test("三层合并进一个平面命名空间，且无断言时判未判定", () => {
  const result = evaluateAssertions({}, ctxWith());
  assert.deepEqual(result.checks, {});
  assert.equal(result.passed, null, "一份没有断言的用例跑完不构成「通过」的证据");
});
