/**
 * 报告层的落盘、回读与导出（`src/core/report.ts`）。
 *
 * 全部在**临时目录**里做真实 IO：这一层的价值恰恰是磁盘上的字节，
 * 用内存桩测它等于什么都没测。测完清理，不留痕。
 *
 * 并行开发期 `store/migrations.ts` 的 `migrateDocument` 与 `schema/report.ts` 的
 * `reportSchema` 可能还是 stub（由别的 agent 负责）。此时读路径跑不通，
 * 测试会**显式跳过**并说明原因（`skipIfPeerStub`），而不是伪造通过——
 * 那会让「读回校验」这件事看起来有覆盖而实际没有。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { TestContext } from "node:test";

import { appendFile, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

import { buildReport, persistReport, appendIndex, readIndex, readReport, toMarkdown } from "../src/core/report.ts";
import { CaseDefinitionSchema } from "../src/schema/case.ts";
import { reportSchema } from "../src/schema/report.ts";
import { caseDigest, stringifyCase } from "../src/schema/yaml.ts";
import type { Case, CaseRevision } from "../src/schema/case.ts";
import type { CaseRunReport, RunIndexEntry, StepRecord } from "../src/schema/report.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

async function tempDir(t: TestContext, name = "jevtest-report-"): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), name));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/**
 * 迁移层 / schema 还是 stub 时跳过，而不是让一个「依赖没落地」的失败
 * 混进「报告层坏了」的结论里。只有明确说出「未实现」的错才跳过，别的一律照抛。
 */
function skipIfPeerStub(t: TestContext, error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("未实现")) {
    t.skip(`依赖尚未落地，读路径无法验证：${message}`);
    return;
  }
  throw error;
}

function sampleCase(): Case {
  return CaseDefinitionSchema.parse({
    title: "维基百科：哥德尔不完备定理",
    goal: "在维基百科上确认第一条不完备定理的表述",
    startUrl: "https://example.test/wiki",
  });
}

function sampleRevision(caseDef: Case): CaseRevision {
  return { caseId: caseDef.id, revision: 3, digest: caseDigest(caseDef), savedAt: "2026-09-21T09:59:00.000Z" };
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

/** 一份「模型认为完成，但断言发现没完成」的报告——最重要的那种失败。 */
function sampleReport(over: Partial<CaseRunReport> = {}): CaseRunReport {
  const caseDef = sampleCase();
  return {
    ...buildReport({
      runId: "run-20260921-0001",
      caseDef,
      revision: sampleRevision(caseDef),
      suiteRunId: null,
      engine: "typesafe",
      startedAt: "2026-09-21T10:00:00.000Z",
      finishedAt: "2026-09-21T10:00:12.345Z",
      status: "done",
      passed: false,
      failureReason: null,
      finalUrl: "https://example.test/wiki",
      steps: [stepWith(), stepWith({ step: 2, action: "输入「Gödel」", kind: "fill", text: "Gödel", textEngine: "typesafe" })],
      guardrailHits: [],
      assertion: {
        passed: false,
        checks: {
          "final.url.matches[0]": { passed: true, skipped: false, detail: "实际值匹配正则 /wiki$/：https://example.test/wiki" },
          "final.text.contains[0]": { passed: true, skipped: false, detail: "已找到「first incompleteness theorem」" },
          // matchControl 恒定产出 `.exists`（元素表里的定位结果），
          // 失败报告里「关键元素的可见值」正是从它这句里取的。
          "final.controls[0].exists": {
            passed: true,
            skipped: false,
            detail: "已定位到元素：label「Search」 role=searchbox value=「Gödel」",
          },
          "final.controls[0].valueContains": {
            passed: false,
            skipped: false,
            detail: "实际值「Gödel」中不含「Escher」",
          },
          "quality.minTargetProbability": {
            passed: false,
            skipped: true,
            detail: "无法求值：1 步的分布是 degenerate，target 概率下限 0.3 没有可比较的对象",
          },
        },
      },
      stats: {
        steps: 2,
        modelCalls: 5,
        decisions: 3,
        inputTokens: 1234,
        outputTokens: 56,
        costUsd: null,
        elapsedMs: 12_345,
        engineLatencyMs: 800,
      },
      admission: null,
    }),
    ...over,
  };
}

function indexEntryWith(over: Partial<RunIndexEntry> = {}): RunIndexEntry {
  return {
    runId: "run-1",
    caseId: "wiki-godel",
    caseTitle: "维基百科：哥德尔不完备定理",
    suiteRunId: null,
    startedAt: "2026-09-21T10:00:00.000Z",
    status: "done",
    passed: true,
    elapsedMs: 1234,
    steps: 3,
    costUsd: null,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// buildReport：纯组装，不做 IO
// ---------------------------------------------------------------------------

test("buildReport：字段如实组装，identity 三件套照抄调用方给的值", () => {
  const caseDef = sampleCase();
  const revision = sampleRevision(caseDef);

  const report = sampleReport();

  assert.equal(report.schemaVersion, 1);
  assert.equal(report.runId, "run-20260921-0001");
  assert.equal(report.caseId, caseDef.id);
  // 刻意**不修正**：cli 的 persist 回调会在落盘前用 store.freeze() 的返回值覆写这两个字段
  // （冻结发生在运行结束后），组装阶段看到的可能还是初始值。
  assert.equal(report.caseRevision, revision.revision);
  assert.equal(report.caseDigest, revision.digest);
  assert.equal(report.goal, caseDef.goal);
  assert.equal(report.startUrl, caseDef.startUrl);
  assert.equal(report.elapsedMs, 12_345, "墙钟耗时取两个时间戳之差");
  assert.equal(report.artifacts.frozenCase, "case.yaml", "快照文件名与 store/cases.ts 的 FROZEN_CASE_FILE 同一个");
  assert.equal(report.artifacts.traceZip, null, "组装阶段不做 IO，产物有无要到落盘时才知道");
  assert.equal(report.artifacts.framesDir, null);
});

test("buildReport：产出的对象能满足 reportSchema（与 schema 层双向锁死）", () => {
  const parsed = reportSchema.parse(sampleReport());

  assert.equal(parsed.passed, false);
  assert.equal(parsed.stats.costUsd, null, "未知金额就是 null，不能是 0");
});

test("buildReport：时间戳不可解析时退到计量器读数，绝不写 NaN", () => {
  const report = buildReport({
    runId: "run-x",
    caseDef: sampleCase(),
    revision: { caseId: "x", revision: 0, digest: "d", savedAt: "2026-09-21T09:00:00.000Z" },
    suiteRunId: null,
    engine: "scripted",
    startedAt: "不是时间",
    finishedAt: "也不是",
    status: "error",
    passed: null,
    failureReason: "引擎不可达",
    finalUrl: null,
    steps: [],
    guardrailHits: [],
    assertion: null,
    stats: {
      steps: 0,
      modelCalls: 0,
      decisions: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: null,
      elapsedMs: 4321,
      engineLatencyMs: 0,
    },
    admission: null,
  });

  assert.equal(report.elapsedMs, 4321);
  assert.equal(reportSchema.safeParse(report).success, true, "NaN 会让一份好报告在回读时被判损坏");
});

// ---------------------------------------------------------------------------
// persistReport / readReport
// ---------------------------------------------------------------------------

test("persistReport：原子落盘，目录布局与返回值符合 docs/report-format.md §1", async (t) => {
  const runsDir = await tempDir(t);
  const report = sampleReport();

  const dir = await persistReport(report, { runsDir });

  assert.equal(dir, join(resolve(runsDir), report.runId), "返回报告目录的绝对路径");
  assert.ok(isAbsolute(dir));

  const raw = await readFile(join(dir, "run.json"), "utf8");
  assert.equal(raw.endsWith("\n"), true, "文本文件以换行收尾，git diff 才好看");
  const parsed = JSON.parse(raw) as CaseRunReport;
  assert.equal(parsed.schemaVersion, 1);
  assert.equal(parsed.runId, report.runId);
  assert.equal(parsed.caseRevision, 3);

  // 临时文件不留残骸（writeFileAtomic 的清理路径）。
  const names = await readdir(dir);
  assert.deepEqual(names, ["run.json"], "落盘后不应留下临时文件");
});

test("persistReport：产物探测——trace.zip / frames 存在才写进报告", async (t) => {
  const runsDir = await tempDir(t);

  const bare = await persistReport(sampleReport({ runId: "run-bare" }), { runsDir });
  const bareDoc = JSON.parse(await readFile(join(bare, "run.json"), "utf8")) as CaseRunReport;
  assert.equal(bareDoc.artifacts.traceZip, null, "没录 trace 就写 null，不能让报告自称有 trace");
  assert.equal(bareDoc.artifacts.framesDir, null);

  const withArtifacts = await persistReport(sampleReport({ runId: "run-full" }), { runsDir });
  await writeFile(join(withArtifacts, "trace.zip"), "fake-zip", "utf8");
  await mkdir(join(withArtifacts, "frames"), { recursive: true });
  // 再落一次盘：这次的探测应当看到刚放进去的产物。
  await persistReport(sampleReport({ runId: "run-full" }), { runsDir });
  const fullDoc = JSON.parse(await readFile(join(withArtifacts, "run.json"), "utf8")) as CaseRunReport;
  assert.equal(fullDoc.artifacts.traceZip, "trace.zip", "路径相对报告目录");
  assert.equal(fullDoc.artifacts.framesDir, "frames");
});

test("persistReport → readReport：写出的报告能被原样读回", async (t) => {
  const runsDir = await tempDir(t);
  const report = sampleReport();
  const dir = await persistReport(report, { runsDir });
  // 落盘时探测过产物，读回来的 artifacts 以磁盘上的那份为准。
  const onDisk = JSON.parse(await readFile(join(dir, "run.json"), "utf8")) as CaseRunReport;

  let back: CaseRunReport;
  try {
    back = await readReport(runsDir, report.runId);
  } catch (error) {
    skipIfPeerStub(t, error);
    return;
  }

  assert.deepEqual(back, onDisk);
  assert.equal(back.assertion?.passed, false);
  assert.equal(back.assertion?.checks["quality.minTargetProbability"]?.skipped, true);
});

test("readReport：报告不存在时报出可读的错误而不是 ENOENT", async (t) => {
  const runsDir = await tempDir(t);

  await assert.rejects(
    () => readReport(runsDir, "run-never-existed"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /报告不存在/);
      assert.match(error.message, /run-never-existed/);
      return true;
    },
  );
});

test("readReport：runId 会拼进磁盘路径，因此必须挡住路径穿越", async (t) => {
  const runsDir = await tempDir(t);

  await assert.rejects(() => readReport(runsDir, "../secrets"), /非法的 runId/);
  await assert.rejects(
    () => persistReport(sampleReport({ runId: "a/b" }), { runsDir }),
    /非法的 runId/,
    "写路径同样要挡：否则能写到运行目录之外",
  );
});

// ---------------------------------------------------------------------------
// index.jsonl
// ---------------------------------------------------------------------------

test("writeIndex: true 时才写索引，且一行一条摘要", async (t) => {
  const runsDir = await tempDir(t);

  const report = sampleReport();
  await persistReport(report, { runsDir });
  await assert.rejects(
    () => readFile(join(resolve(runsDir), "index.jsonl"), "utf8"),
    "没要求写索引时不该产生这个文件",
  );

  await persistReport(sampleReport({ runId: "run-2" }), { runsDir, writeIndex: true });
  const lines = (await readFile(join(resolve(runsDir), "index.jsonl"), "utf8")).trim().split("\n");
  assert.equal(lines.length, 1);
  const entry = JSON.parse(lines[0] ?? "{}") as RunIndexEntry;
  assert.equal(entry.runId, "run-2");
  assert.equal(entry.caseId, report.caseId);
  assert.equal(entry.caseTitle, report.caseId, "读不到快照时退到 caseId，标题不该让落盘失败");
  assert.equal(entry.steps, 2);
  assert.equal(entry.costUsd, null, "未知金额就是 null");
});

test("索引：能读到用例快照里的 title", async (t) => {
  const runsDir = await tempDir(t);
  const reportDir = join(resolve(runsDir), report0().runId);
  await mkdir(reportDir, { recursive: true });
  // 快照由调用方（cli 的 persist 回调）写，报告层只读它取标题。
  await writeFile(join(reportDir, "case.yaml"), stringifyCase(sampleCase()), "utf8");

  await persistReport(report0(), { runsDir, writeIndex: true });
  const entry = (await readIndex(runsDir))[0];

  assert.equal(entry?.caseTitle, "维基百科：哥德尔不完备定理");
});

function report0(): CaseRunReport {
  return sampleReport({ runId: "run-titled" });
}

test("readIndex：文件不存在返回空数组；坏行跳过；按时间倒序", async (t) => {
  const runsDir = await tempDir(t);
  assert.deepEqual(await readIndex(runsDir), [], "一次都没跑过是空表，不是错误");

  await appendIndex(runsDir, indexEntryWith({ runId: "old", startedAt: "2026-09-01T00:00:00.000Z" }));
  await appendIndex(runsDir, indexEntryWith({ runId: "new", startedAt: "2026-09-21T00:00:00.000Z" }));
  await appendIndex(runsDir, indexEntryWith({ runId: "mid", startedAt: "2026-09-10T00:00:00.000Z" }));

  // 半截 JSON（写到一半被中断）与「JSON 合法但不是一条索引」（手工塞进来的杂物）。
  const indexPath = join(resolve(runsDir), "index.jsonl");
  await appendFile(indexPath, '{"runId":"truncated","caseId"\n', "utf8");
  await appendFile(indexPath, '{"whatever":true}\n', "utf8");

  const entries = await readIndex(runsDir);

  assert.deepEqual(
    entries.map((e) => e.runId),
    ["new", "mid", "old"],
    "倒序：最新的在最前；坏行被跳过而不是让整个列表打不开",
  );
});

test("appendIndex：写入口校验——漂移的条目当场抛错，而不是静默写进去没人读得懂", async (t) => {
  const runsDir = await tempDir(t);

  await assert.rejects(
    () => appendIndex(runsDir, { runId: "r" } as unknown as RunIndexEntry),
    "缺字段的索引条目必须被拦下（readIndex 会跳过它，那就成了静默丢失）",
  );
});

test("readIndex：时间戳不可解析的条目仍然可见，只是沉到末尾", async (t) => {
  const runsDir = await tempDir(t);
  await appendIndex(runsDir, indexEntryWith({ runId: "broken-time", startedAt: "不是时间" }));
  await appendIndex(runsDir, indexEntryWith({ runId: "normal", startedAt: "2026-09-21T00:00:00.000Z" }));

  const entries = await readIndex(runsDir);
  assert.deepEqual(entries.map((e) => e.runId), ["normal", "broken-time"]);
});

// ---------------------------------------------------------------------------
// toMarkdown
// ---------------------------------------------------------------------------

test("toMarkdown：失败报告必须带上实际值、期望值、最终页面 URL 与 trace 打开方式", () => {
  // 导出发生在**读回来**的报告上（cli 与 /api 都是先 readReport 再导出），
  // 因此这里的 artifacts 是落盘时探测过的真实值。
  const report = sampleReport({ artifacts: { traceZip: "trace.zip", framesDir: "frames", frozenCase: "case.yaml" } });
  const doc = toMarkdown(report);

  assert.match(doc, /^# 运行报告：/);
  assert.match(doc, /\*\*结论：模型认为已完成（`done`）｜断言 \*\*失败\*\*\*\*/, "结论区要同时说清「循环怎么结束」与「断言怎么判」");
  assert.match(doc, /实际值「Gödel」中不含「Escher」/, "每条失败断言的实际值与期望都要在");
  assert.match(doc, /`final\.controls\[0\]\.valueContains` \| 失败 \|/, "断言明细按稳定路径逐条列出");
  assert.match(doc, /最终页面 URL：`https:\/\/example\.test\/wiki`/, "失败时必须带最终页面 URL");
  assert.match(doc, /定位结果：/, "关键元素的可见值来自断言详情");

  assert.match(doc, /2 步/, "步数是结论的一部分");
  assert.match(doc, /模型调用 5 次（3 次决策，含 2 次重试）/, "modelCalls 与 decisions 的口径要一起说清");
  assert.match(doc, /成本 未知（引擎未报金额）/, "costUsd 为 null 时写「未知」，绝不写 0");
  assert.match(doc, /npx playwright show-trace runs\/run-20260921-0001\/trace\.zip/, "trace 的打开方式");
  assert.match(doc, /用例快照：`runs\/run-20260921-0001\/case\.yaml`/, "报告自包含的证据");
});

test("toMarkdown：skipped 显示为「跳过」，绝不显示为「通过」", () => {
  const doc = toMarkdown(sampleReport());

  assert.match(doc, /`quality\.minTargetProbability` \| 跳过 \|/, "跳过就是跳过");
  assert.doesNotMatch(doc, /`quality\.minTargetProbability` \| 通过 \|/, "把它读成通过就是 D9 要杜绝的谎报覆盖");
  assert.match(doc, /未判定/, "有跳过而无失败时整体判决是「未判定」，不是「通过」");
});

test("toMarkdown：assertion 为 null 与 passed 为 null 是两件事", () => {
  // 断言层根本没跑（例如预算在第一步之前就耗尽）。
  const notRun = toMarkdown(sampleReport({ assertion: null, passed: null, failureReason: "预算在第一步之前就耗尽", steps: [], finalUrl: null }));

  assert.match(notRun, /未求值/, "「没跑」要说成未求值，不能与「跑了但无法求值」混为一谈");
  assert.match(notRun, /断言层未运行/);
  assert.match(notRun, /预算在第一步之前就耗尽/);
  assert.match(notRun, /最终页面 URL：\*\*未观测到\*\*/);
  assert.match(notRun, /本次未录制/, "没有 trace 时要说清，而不是给一条会 404 的命令");

  // 断言跑了，但有检查无法求值 -> 未判定（与上面是两种不同的情况）。
  const undecided = toMarkdown(sampleReport({ assertion: { passed: null, checks: { "final.url.equals": { passed: false, skipped: true, detail: "未能观测最终页面" } } }, passed: null }));
  assert.match(undecided, /未判定/);
  assert.doesNotMatch(undecided, /断言层未运行/);
});

test("toMarkdown：通过了就不铺开失败排查，但结论与断言表照旧", () => {
  const doc = toMarkdown(
    sampleReport({
      passed: true,
      assertion: { passed: true, checks: { "final.url.equals": { passed: true, skipped: false, detail: "实际值与期望全等：https://example.test/wiki" } } },
    }),
  );

  assert.match(doc, /断言 \*\*通过\*\*/);
  assert.match(doc, /实际值与期望全等/);
  assert.doesNotMatch(doc, /## 失败排查/);
});

test("toMarkdown：detail 里的竖线不会把 Markdown 表格切碎", () => {
  const doc = toMarkdown(
    sampleReport({
      assertion: {
        passed: false,
        checks: { "final.text.contains[0]": { passed: false, skipped: false, detail: "未找到「a|b」。实际值：x" } },
      },
    }),
  );

  assert.ok(doc.includes("a\\|b"), "单元格里的竖线要转义，否则表格会被切碎");
  assert.ok(doc.includes("| `final.text.contains[0]` | 失败 |"), "行首的路径仍然按稳定路径渲染");
});

// ---------------------------------------------------------------------------
// 索引与报告的一致性
// ---------------------------------------------------------------------------

test("index 与 run.json 对同一次运行的结论必须一致", async (t) => {
  const runsDir = await tempDir(t);
  const report = sampleReport({ runId: "run-consistency" });

  await persistReport(report, { runsDir, writeIndex: true });
  const entry = (await readIndex(runsDir))[0];

  assert.equal(entry?.status, report.status);
  assert.equal(entry?.passed, report.passed);
  assert.equal(entry?.elapsedMs, report.elapsedMs);
  assert.equal(entry?.steps, report.steps.length);
  assert.equal(entry?.suiteRunId, report.suiteRunId);
});
