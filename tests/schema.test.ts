/**
 * 用例 schema 与报告 schema 的默认值、校验与报错。
 *
 * 两类断言在这里各有侧重：
 *   - **用例侧**盯的是「默认值到底有没有被解析」——见下面那条 `maxModelCalls` 的说明，
 *     它守着 zod v4 的 `.prefault` 陷阱，是能真金白银出事的那种。
 *   - **报告侧**盯的是「三态有没有被压成两态」——`passed` / `costUsd` / `pageChanged`
 *     / `assertion` 的 `null` 都是**有效取值**而不是缺失，报告是长期留存的物证，
 *     把这些压成 `false` / `0` / 「没这个字段」就是伪造证据。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { ZodError } from "zod";

import { CaseDefinitionSchema } from "../src/schema/case.ts";
import type { Case, CaseDefinition } from "../src/schema/case.ts";
import { parseCase } from "../src/schema/yaml.ts";
import { reportSchema, runIndexEntrySchema } from "../src/schema/report.ts";
import type { CaseRunReport, RunIndexEntry } from "../src/schema/report.ts";

/** 最小输入：只有三个必填项，其余全靠默认值。 */
const MINIMAL: CaseDefinition = {
  title: "最小用例",
  goal: "打开首页并确认标题出现",
  startUrl: "https://example.com/",
};

const CASE_FILE = join(import.meta.dirname, "..", "cases", "wikipedia-godel.yaml");

/**
 * `parseCase` 的返回类型是用户书写形态（`CaseDefinition`，字段大量可选）；
 * 断言具体取值时想要的是默认值已填充的 `Case`，所以再过一次 schema。
 * 再解析一次是幂等的，不会掩盖 `parseCase` 的问题——它抛错的话这里根本走不到。
 */
function parseFilled(text: string, source?: string): Case {
  return CaseDefinitionSchema.parse(parseCase(text, source));
}

/** 断言 `fn` 抛出的 ZodError 里有一条 issue 的路径等于 `path`。 */
function assertIssuePath(fn: () => unknown, path: readonly (string | number)[]): ZodError {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ZodError, `期望抛出 ZodError，实际是 ${String(thrown)}`);
  const found = thrown.issues.some(
    (issue) => JSON.stringify(issue.path) === JSON.stringify([...path]),
  );
  assert.ok(
    found,
    `期望有一条 issue 的路径是 ${JSON.stringify(path)}，实际是 ` +
      JSON.stringify(thrown.issues.map((issue) => issue.path)),
  );
  return thrown;
}

// ---------------------------------------------------------------------------
// 默认值：守 .prefault 陷阱
// ---------------------------------------------------------------------------

test("最小输入解析出的 budget.maxModelCalls 必须是 40（守 zod v4 的 .default({}) 陷阱）", () => {
  // 这条断言存在的唯一理由是它会在某种写法下**静默失败**：
  //   budget: budgetSchema.default({})   // 错：{} 被原样返回，不走 schema 解析
  //   budget: budgetSchema.prefault({})  // 对：input-side 默认，会走解析
  // 写成 default 时 budget 会是 {}、maxModelCalls 是 undefined——
  // 于是预算静默失效、成本无上限，而且不报任何错。
  // 它不只是「一个默认值对不对」，是「预算这道刹车还在不在」。
  // zod 的 minor 版本是承重的（package.json 写的是 ^4.0.0），升级 zod 后必须重跑本条。
  assert.equal(CaseDefinitionSchema.parse(MINIMAL).budget.maxModelCalls, 40);
});

test("最小输入的其余默认值逐条对齐 docs/case-format.md", () => {
  const parsed = CaseDefinitionSchema.parse(MINIMAL);

  assert.equal(parsed.schemaVersion, 1);
  // id 由 title 生成 slug。中文标题 slug 化后为空，slugify 会用哈希兜底成 `case-<hash>`；
  // 关键是**同一个标题必须总是得到同一个 id**，否则每次保存都会分配新 id、revision 历史断掉。
  assert.match(parsed.id, /^[a-z0-9][a-z0-9-]{1,63}$/);
  assert.equal(parsed.id, CaseDefinitionSchema.parse(MINIMAL).id);
  assert.equal(parsed.mode, "interactive");
  // allowedOrigins 缺省时由 startUrl 推导，且必须包含 startUrl 自己的 origin
  assert.deepEqual(parsed.allowedOrigins, ["https://example.com"]);
  assert.deepEqual(parsed.guardrails, []);
  assert.equal(parsed.allowDefaultOverride, false);
  assert.equal(parsed.engine, "typesafe");

  assert.deepEqual(parsed.budget, {
    maxSteps: 40,
    maxModelCalls: 40,
    maxInputTokens: 200000,
    // null = 不设金额上限，不是「0 美元」
    maxCostUsd: null,
    maxElapsedMs: 300000,
  });

  // trajectory 的默认值挂在 assertions 下面，靠 assertionsSchema.prefault({}) 才会被解析；
  // 写成 .default({}) 的话这两条默认值等于不存在（同一个陷阱的另一处）。
  assert.deepEqual(parsed.assertions.trajectory?.statusIn, ["done"]);
  assert.equal(parsed.assertions.trajectory?.maxIdenticalConsecutive, 3);
  assert.deepEqual(parsed.assertions.trajectory?.mustUse, []);
  assert.deepEqual(parsed.assertions.trajectory?.mustNotUse, []);
  assert.deepEqual(parsed.assertions.trajectory?.forbiddenKinds, []);
  assert.equal(parsed.assertions.final, undefined);
  assert.equal(parsed.assertions.quality, undefined);
});

test("默认值不会被解析成同一个数组实例（函数形式 default）", () => {
  // statusIn 用 .default(() => ["done"]) 而不是 .default(["done"])：
  // 后者的默认值是同一个数组实例，调用方原地 push 会污染后续所有解析。
  const first = CaseDefinitionSchema.parse(MINIMAL);
  const second = CaseDefinitionSchema.parse(MINIMAL);
  assert.notEqual(first.assertions.trajectory?.statusIn, second.assertions.trajectory?.statusIn);
  assert.notEqual(first.guardrails, second.guardrails);

  first.assertions.trajectory?.statusIn?.push("error");
  assert.deepEqual(second.assertions.trajectory?.statusIn, ["done"]);
});

test("显式给了值就不该被默认值覆盖", () => {
  const parsed = CaseDefinitionSchema.parse({
    ...MINIMAL,
    mode: "readonly",
    engine: "scripted",
    budget: { maxSteps: 3 },
  });
  assert.equal(parsed.mode, "readonly");
  assert.equal(parsed.engine, "scripted");
  assert.equal(parsed.budget.maxSteps, 3);
  // 只写了一个字段，其余仍是默认值（部分对象也要走解析）
  assert.equal(parsed.budget.maxModelCalls, 40);
});

// ---------------------------------------------------------------------------
// 真实用例：cases/wikipedia-godel.yaml
// ---------------------------------------------------------------------------

test("cases/wikipedia-godel.yaml 能被解析，且字段与 YAML 逐条一致", () => {
  const text = readFileSync(CASE_FILE, "utf8");
  const parsed = parseFilled(text, "cases/wikipedia-godel.yaml");

  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.id, "wikipedia-godel");
  assert.equal(parsed.mode, "interactive");
  assert.equal(parsed.startUrl, "https://en.wikipedia.org/wiki/Main_Page");
  assert.deepEqual(parsed.allowedOrigins, ["https://en.wikipedia.org"]);
  // goal 用了 YAML 的 >- 折叠标量，换行会被折成空格
  assert.match(parsed.goal, /incompleteness theorems/);
  assert.ok(!parsed.goal.includes("\n"), ">- 折叠标量不该残留换行");

  assert.deepEqual(parsed.budget, {
    maxSteps: 12,
    maxModelCalls: 24,
    maxInputTokens: 150000,
    maxCostUsd: null,
    maxElapsedMs: 45000,
  });

  assert.equal(parsed.guardrails.length, 2);
  assert.deepEqual(parsed.guardrails[0], { labelContains: "Create account", reason: "测试不允许创建账号" });
  assert.equal(parsed.guardrails[1]?.labelContains, "Donate");

  // URL 用 ASCII 片段断言：浏览器会把路径里的非 ASCII 百分号编码，
  // 拿 `Gödel` 去匹配 URL **永远不匹配**（真跑踩出来的，见 docs/writing-cases.md 陷阱一）。
  assert.deepEqual(parsed.assertions.final?.url?.contains, ["incompleteness_theorems"]);
  assert.deepEqual(parsed.assertions.final?.text?.contains, ["incompleteness"]);
  assert.deepEqual(parsed.assertions.final?.text?.notContains, ["Search results"]);
  assert.deepEqual(parsed.assertions.trajectory?.statusIn, ["done"]);
  assert.equal(parsed.assertions.trajectory?.maxSteps, 12);
  assert.deepEqual(parsed.assertions.trajectory?.mustUse, [{ role: "searchbox" }]);
  assert.deepEqual(parsed.assertions.trajectory?.mustNotUse, [{ labelContains: "Log in" }]);
  assert.equal(parsed.assertions.quality?.minOperationProbability, 0.4);
  assert.equal(parsed.assertions.quality?.maxModelCalls, 24);

  // 这个文件是 docs/case-format.md 的活样例。上面逐条断言而不是只断言「能解析」，
  // 是为了让规范与实现的漂移在这里暴露出来，而不是等到跑用例时才怪模型的输出。
  // 其中 maxSteps 在 budget 与 trajectory 两处都写了 12，是有意的重复：
  // budget 是硬刹车，trajectory.maxSteps 是断言，两者可以不同。
  assert.equal(parsed.budget.maxSteps, parsed.assertions.trajectory?.maxSteps);
});

// ---------------------------------------------------------------------------
// 报错必须带字段路径
// ---------------------------------------------------------------------------

test("非法用例的报错带字段路径", () => {
  assertIssuePath(() => CaseDefinitionSchema.parse({ ...MINIMAL, title: "" }), ["title"]);
  assertIssuePath(() => CaseDefinitionSchema.parse({ ...MINIMAL, startUrl: "not-a-url" }), ["startUrl"]);
  // 只接受 http/https：file:// 的 origin 是字符串 "null"，白名单比对会退化成互相匹配
  assertIssuePath(() => CaseDefinitionSchema.parse({ ...MINIMAL, startUrl: "file:///etc/passwd" }), ["startUrl"]);
  assertIssuePath(() => CaseDefinitionSchema.parse({ ...MINIMAL, budget: { maxSteps: 0 } }), ["budget", "maxSteps"]);
  assertIssuePath(
    () => CaseDefinitionSchema.parse({ ...MINIMAL, budget: { maxElapsedMs: 1.5 } }),
    ["budget", "maxElapsedMs"],
  );
  assertIssuePath(() => CaseDefinitionSchema.parse({ ...MINIMAL, mode: "headless" }), ["mode"]);
  // 少了 reason：路径精确到缺的那个字段
  assertIssuePath(
    () => CaseDefinitionSchema.parse({ ...MINIMAL, guardrails: [{ labelContains: "删除" }] }),
    ["guardrails", 0, "reason"],
  );
  // 有 reason 但没有任何匹配条件：护栏会匹配一切，等于把每一步都拦下
  assertIssuePath(
    () => CaseDefinitionSchema.parse({ ...MINIMAL, guardrails: [{ reason: "只是解释，没说拦什么" }] }),
    ["guardrails", 0],
  );
  // 空 ActionMatch 不是「什么都不匹配」而是「匹配一切」，必须被挡住
  assertIssuePath(
    () => CaseDefinitionSchema.parse({ ...MINIMAL, assertions: { trajectory: { mustNotUse: [{}] } } }),
    ["assertions", "trajectory", "mustNotUse", 0],
  );
});

test("白名单不含 startUrl 的 origin 时，报错指向 allowedOrigins", () => {
  assertIssuePath(
    () => CaseDefinitionSchema.parse({ ...MINIMAL, allowedOrigins: ["https://other.example.com"] }),
    ["allowedOrigins"],
  );
  // 容忍粘贴整条 URL：只取 origin，路径会被丢掉
  const parsed = CaseDefinitionSchema.parse({
    ...MINIMAL,
    allowedOrigins: ["https://example.com/some/path?q=1"],
  });
  assert.deepEqual(parsed.allowedOrigins, ["https://example.com"]);
});

test("写错的正则在保存时就报错，路径指到具体那一条", () => {
  assertIssuePath(
    () =>
      CaseDefinitionSchema.parse({
        ...MINIMAL,
        assertions: { final: { text: { matches: ["[unclosed"] } } },
      }),
    ["assertions", "final", "text", "matches", 0],
  );
});

test("parseCase 把字段路径写进错误信息（人看 YAML 报错时需要知道是哪一行）", () => {
  const yaml = ["title: 坏用例", "goal: 目标", "startUrl: https://example.com/", "budget:", "  maxSteps: 0"].join("\n");
  let thrown: unknown;
  try {
    parseCase(yaml, "bad.yaml");
  } catch (error) {
    thrown = error;
  }
  assert.ok(thrown instanceof ZodError);
  assert.match(thrown.message, /bad\.yaml/);
  assert.match(thrown.message, /budget\.maxSteps/);
});

test("顶层不是映射时给一句人话，而不是 zod 的 expected object", () => {
  assert.throws(() => parseCase("- 1\n- 2\n"), /顶层必须是一个映射/);
});

// ---------------------------------------------------------------------------
// reportSchema：完整报告字面量
// ---------------------------------------------------------------------------

/** 一份字段全满的报告，用来同时验证「能通过」与「不会被剥掉字段」。 */
const FULL_REPORT: CaseRunReport = {
  schemaVersion: 1,
  runId: "20260921-120000-abcd",
  caseId: "wikipedia-godel",
  caseRevision: 3,
  caseDigest: "a".repeat(64),
  suiteRunId: "suite-20260921",
  engine: "typesafe",

  startedAt: "2026-09-21T12:00:00.000Z",
  finishedAt: "2026-09-21T12:00:04.000Z",
  elapsedMs: 4000,

  status: "done",
  passed: true,
  failureReason: null,

  goal: "在 Wikipedia 上找到并打开哥德尔不完备定理条目",
  startUrl: "https://en.wikipedia.org/wiki/Main_Page",
  finalUrl: "https://en.wikipedia.org/wiki/G%C3%B6del%27s_incompleteness_theorems",

  steps: [
    {
      step: 1,
      action: "填搜索框",
      kind: "fill",
      role: "searchbox",
      operation: "TYPE_TEXT",
      target: "1:1",
      probability: 0.82,
      operationProbability: 0.91,
      confidence: 0.77,
      distribution: "full",
      executed: true,
      blockReason: null,
      text: "Gödel incompleteness theorems",
      textEngine: "text-model",
      urlBefore: "https://en.wikipedia.org/wiki/Main_Page",
      urlAfter: "https://en.wikipedia.org/wiki/Main_Page",
      pageChanged: false,
      engineLatencyMs: 612,
      textLatencyMs: 233,
      observedMs: 1104,
      frame: 3,
      engineUsage: { inputTokens: 4210, outputTokens: 88, costUsd: 0.0012, requests: 2 },
    },
    {
      step: 2,
      action: "点击搜索",
      kind: "click",
      role: "button",
      operation: "CLICK",
      target: "2:1",
      probability: 0.66,
      operationProbability: 0.66,
      confidence: 0.66,
      distribution: "degenerate",
      executed: false,
      blockReason: "命中护栏：Donate",
      text: null,
      textEngine: null,
      urlBefore: "https://en.wikipedia.org/wiki/Main_Page",
      urlAfter: null,
      pageChanged: null,
      engineLatencyMs: 540,
      textLatencyMs: 0,
      observedMs: 1320,
      frame: null,
      engineUsage: { inputTokens: 3980, outputTokens: 41, costUsd: null, requests: 1 },
    },
  ],
  guardrailHits: [{ step: 2, reason: "命中护栏：Donate", action: "click(Donate)" }],
  assertion: {
    passed: true,
    checks: {
      "final.url": { passed: true, skipped: false, detail: "URL 命中 /Incompleteness/" },
      "trajectory.mustUse[0]": { passed: true, skipped: false, detail: "轨迹里有 role=searchbox 的动作" },
      "quality.minOperationProbability": { passed: false, skipped: true, detail: "分布为 degenerate，未求值" },
    },
  },
  stats: {
    steps: 2,
    modelCalls: 3,
    decisions: 2,
    inputTokens: 8190,
    outputTokens: 129,
    costUsd: 0.0012,
    elapsedMs: 4000,
    engineLatencyMs: 1152,
  },
  admission: {
    ok: false,
    blocking: [],
    warnings: ["检测到 2 个跨域 iframe，其内部控件不可见"],
    stats: {
      frames: 3,
      crossOriginFrames: 2,
      shadowRoots: 0,
      canvases: 0,
      passwordFields: 0,
      fileInputs: 0,
      nestedScrollContainers: 1,
      interactiveElements: 42,
    },
  },
  artifacts: { traceZip: "trace.zip", framesDir: "frames", frozenCase: "schemaVersion: 1\n" },
};

test("完整报告字面量能通过校验，且字段一个不少", () => {
  // deepEqual 而不只是「不抛错」：schema 若把某个字段当成未知键剥掉，
  // 报告回读后就会少一块，而「不抛错」不会发现这件事。
  assert.deepEqual(reportSchema.parse(FULL_REPORT), FULL_REPORT);
});

test("报告的每一种 null 都是有效取值，不是缺失", () => {
  const nullable: CaseRunReport = {
    ...FULL_REPORT,
    suiteRunId: null,
    passed: null,
    failureReason: null,
    finalUrl: null,
    assertion: null,
    admission: null,
    guardrailHits: [],
    steps: [
      {
        ...FULL_REPORT.steps[0]!,
        target: null,
        blockReason: null,
        text: null,
        textEngine: null,
        urlAfter: null,
        pageChanged: null,
        frame: null,
        engineUsage: { ...FULL_REPORT.steps[0]!.engineUsage, costUsd: null },
      },
    ],
    stats: { ...FULL_REPORT.stats, costUsd: null },
    artifacts: { traceZip: null, framesDir: null, frozenCase: "" },
  };

  const parsed = reportSchema.parse(nullable);
  assert.equal(parsed.passed, null);
  assert.equal(parsed.assertion, null);
  assert.equal(parsed.admission, null);
  // 「没能观测」必须原样是 null，不能变成 false——无进展检测若把 null 当 false，
  // 会把页面正常导航的那些步误判成卡死（report-format.md §2.3）。
  assert.equal(parsed.steps[0]?.pageChanged, null);
  assert.equal(parsed.steps[0]?.frame, null);
  assert.equal(parsed.stats.costUsd, null);
});

test("assertion.passed 是三态：有检查被跳过时整体是 null", () => {
  const undecided: CaseRunReport = {
    ...FULL_REPORT,
    passed: null,
    assertion: {
      // 7 条通过、1 条被跳过 -> 未判定。判 true 就是 D9 要杜绝的谎报覆盖。
      passed: null,
      checks: {
        "final.url": { passed: true, skipped: false, detail: "命中" },
        "quality.minTargetProbability": { passed: false, skipped: true, detail: "degenerate，未求值" },
      },
    },
  };
  assert.equal(reportSchema.parse(undecided).assertion?.passed, null);
});

test("报告缺字段或取值非法时被挡住", () => {
  const { stats: _stats, ...missingStats } = FULL_REPORT;
  assert.throws(() => reportSchema.parse(missingStats), ZodError);

  assert.throws(() => reportSchema.parse({ ...FULL_REPORT, status: "finished" }), ZodError);
  assert.throws(() => reportSchema.parse({ ...FULL_REPORT, passed: "yes" }), ZodError);
  // schemaVersion 恒为 1：别的值说明这是别的版本的报告，必须走迁移而不是硬读
  assert.throws(() => reportSchema.parse({ ...FULL_REPORT, schemaVersion: 2 }), ZodError);
  assert.throws(
    () => reportSchema.parse({ ...FULL_REPORT, steps: [{ ...FULL_REPORT.steps[0], pageChanged: "no" }] }),
    ZodError,
  );
  // 负数与小数不该出现在计数里
  assert.throws(() => reportSchema.parse({ ...FULL_REPORT, stats: { ...FULL_REPORT.stats, steps: -1 } }), ZodError);
});

test("未知键被剥掉而不是让整份报告读不出来", () => {
  // 这是刻意的：报告要长期留存，一个未来版本写入的新字段不该让旧版本整个读不出来
  // （同 events.ts 的取舍）。这里的用途是回读校验，信任边界在 web/security.ts。
  const withExtra = { ...FULL_REPORT, futureField: "新版本写的", steps: [{ ...FULL_REPORT.steps[0], futureStep: 1 }] };
  const parsed = reportSchema.parse(withExtra);
  assert.ok(!("futureField" in parsed));
  assert.ok(!("futureStep" in parsed.steps[0]!));
});

// ---------------------------------------------------------------------------
// runIndexEntrySchema
// ---------------------------------------------------------------------------

const INDEX_ENTRY: RunIndexEntry = {
  runId: "20260921-120000-abcd",
  caseId: "wikipedia-godel",
  caseTitle: "Wikipedia 打开哥德尔不完备定理条目",
  suiteRunId: null,
  startedAt: "2026-09-21T12:00:00.000Z",
  status: "done",
  passed: true,
  elapsedMs: 4000,
  steps: 2,
  costUsd: 0.0012,
};

test("RunIndexEntry 能校验，且 costUsd/passed 的 null 合法", () => {
  assert.deepEqual(runIndexEntrySchema.parse(INDEX_ENTRY), INDEX_ENTRY);

  const unknownCost = { ...INDEX_ENTRY, costUsd: null, passed: null, status: "budget_exceeded" as const };
  const parsed = runIndexEntrySchema.parse(unknownCost);
  // 未知就是 null。用 0 冒充会让成本统计悄悄失真（report-format.md §5）。
  assert.equal(parsed.costUsd, null);
  assert.equal(parsed.passed, null);
});

test("RunIndexEntry 拒收非法 status 与缺字段", () => {
  assert.throws(() => runIndexEntrySchema.parse({ ...INDEX_ENTRY, status: "finished" }), ZodError);
  const { caseTitle: _caseTitle, ...missingTitle } = INDEX_ENTRY;
  assert.throws(() => runIndexEntrySchema.parse(missingTitle), ZodError);
});
