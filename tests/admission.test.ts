/**
 * 准入判定的行为锁定。
 *
 * `admit()` 与 `describeAdmission()` 是**纯函数**——这正是它们存在的理由：
 * 判定规则是假阳性的第一道防线，必须能回归（见 `src/browser/admission.ts` 文件头）。
 * 采集侧的 `Session.probe()` 需要真浏览器，测不了；判定侧喂构造的统计就够，
 * 而这个文件就是那条分工的兑现。
 *
 * 全部用例都**不碰浏览器、不调用模型**。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ADMISSION_RULES,
  admit,
  describeAdmission,
} from "../src/browser/admission.ts";
import type { AdmissionReport, AdmissionStats } from "../src/schema/report.ts";
import type { Case } from "../src/schema/case.ts";

/**
 * 一份"干净"的用例。
 *
 * 手写而不是走 `CaseDefinitionSchema.parse()`：这个文件要验证的是规则的判定，
 * 不该因为用例 schema 的任何改动而变红。两者之间只有**类型**上的耦合
 * （tsc 会发现字段对不上），没有运行时的。
 */
const CASE: Case = {
  schemaVersion: 1,
  id: "admission-fixture",
  title: "准入判定的测试用例",
  goal: "只用来喂给 admit()，永远不执行",
  startUrl: "http://127.0.0.1:1/",
  mode: "interactive",
  allowedOrigins: ["http://127.0.0.1:1"],
  budget: {
    maxSteps: 10,
    maxModelCalls: 10,
    maxInputTokens: 10_000,
    maxCostUsd: null,
    maxElapsedMs: 60_000,
  },
  guardrails: [],
  allowDefaultOverride: false,
  engine: "scripted",
  assertions: {},
};

/**
 * 一份"什么都没命中"的统计。
 *
 * `frames: 1` 而不是 0：**`frames` 含主文档**（见 `AdmissionStats.frames` 与
 * `playwright-session.ts` 的 `probe()`），一个没有 iframe 的页面就是 1。
 * 判定侧因此必须减掉主文档那一个，下面的「没有 iframe 不该命中」专门守着这条。
 *
 * `interactiveElements` 给 5 而不是 0：0 会让 `canvas-only` 在有 canvas 时命中，
 * 于是每条规则都会连带测到别的规则，分不清是谁在说话。
 */
const CLEAN: AdmissionStats = {
  frames: 1,
  crossOriginFrames: 0,
  shadowRoots: 0,
  canvases: 0,
  passwordFields: 0,
  fileInputs: 0,
  nestedScrollContainers: 0,
  interactiveElements: 5,
};

function statsWith(over: Partial<AdmissionStats> = {}): AdmissionStats {
  return { ...CLEAN, ...over };
}

/** 报告里所有的文案，不区分严重程度。用于「这条规则有没有说话」这类断言。 */
function messages(report: AdmissionReport): string[] {
  return [...report.blocking, ...report.warnings];
}

function hits(report: AdmissionReport, keyword: string): boolean {
  return messages(report).some((message) => message.includes(keyword));
}

// ---------------------------------------------------------------------------
// 基线：干净页面不该产生任何条目
// ---------------------------------------------------------------------------

test("没有任何特征时：ok 为 true，两个桶都是空的", () => {
  const report = admit(statsWith(), CASE);
  assert.equal(report.ok, true);
  assert.deepEqual(report.blocking, []);
  assert.deepEqual(report.warnings, []);
});

test("stats 原样带进报告，不做拷贝或裁剪", () => {
  // 报告要能解释自己——它内嵌的就是被判定的那份统计。
  // 若这里做一次浅拷贝，字段一多就会出现「报告里的数字和判定用的不是同一份」。
  const stats = statsWith({ frames: 2, shadowRoots: 1 });
  assert.equal(admit(stats, CASE).stats, stats);
});

// ---------------------------------------------------------------------------
// 逐条规则：各一条命中、一条不命中
// ---------------------------------------------------------------------------

test("canvas-only：纯 canvas 页面判 blocking，有可交互元素时不判", () => {
  const blocked = admit(statsWith({ canvases: 2, interactiveElements: 0 }), CASE);
  assert.equal(blocked.ok, false);
  assert.equal(blocked.blocking.length, 1);
  assert.ok(hits(blocked, "canvas"));

  // 有 DOM 控件时 canvas 只是装饰，不该拦
  const fine = admit(statsWith({ canvases: 2, interactiveElements: 3 }), CASE);
  assert.equal(fine.ok, true);
  assert.equal(hits(fine, "canvas"), false);

  // 没有 canvas 时同样不判——规则判的是「画在 canvas 上」而不是「有 canvas」
  assert.equal(admit(statsWith({ interactiveElements: 0 }), CASE).ok, true);
});

test("file-upload：文件上传控件判 blocking", () => {
  const report = admit(statsWith({ fileInputs: 1 }), CASE);
  assert.equal(report.ok, false);
  assert.equal(report.blocking.length, 1);
  assert.ok(hits(report, "文件上传"));

  assert.equal(hits(admit(statsWith(), CASE), "文件上传"), false);
});

test("没有 iframe 的页面不该命中「同源 iframe」", () => {
  // `frames` 含主文档，所以「只有主文档」是 frames === 1。
  // 规则若忘了减掉这一个，每一个页面都会被报一次「检测到 1 个同源 iframe」——
  // 准入检查就成了对谁都说一句废话的噪声源，而假阳性正是它要防的东西。
  const report = admit(statsWith({ frames: 1 }), CASE);
  assert.equal(report.ok, true);
  assert.deepEqual(report.warnings, [], "只有主文档时不该有任何 warning");
});

test("cross-origin-frames：跨域 iframe 只给 warning，不拦", () => {
  // 主文档 + 2 个跨域子 frame，没有同源子 frame，因此同源那条不该说话
  const report = admit(statsWith({ frames: 3, crossOriginFrames: 2 }), CASE);
  assert.equal(report.ok, true, "跨域 iframe 是能力打折，不是不该跑");
  assert.equal(report.blocking.length, 0);
  assert.equal(report.warnings.length, 1);
  assert.ok(hits(report, "跨域 iframe"));

  assert.equal(hits(admit(statsWith(), CASE), "跨域"), false);
});

test("same-origin-frames：同源 iframe 要减掉主文档再算", () => {
  // 主文档 + 1 个跨域 + 2 个同源 = 4 个 frame
  const report = admit(statsWith({ frames: 4, crossOriginFrames: 1 }), CASE);
  assert.equal(report.ok, true);
  // 同源 2 个、跨域 1 个 → 两条 warning 各说各的
  assert.equal(report.warnings.length, 2);
  assert.ok(report.warnings.some((message) => message.includes("2 个同源 iframe")));
  assert.ok(report.warnings.some((message) => message.includes("1 个跨域 iframe")));

  // 全是跨域时不该重复报「同源 iframe」
  const allCrossOrigin = admit(statsWith({ frames: 3, crossOriginFrames: 2 }), CASE);
  assert.equal(hits(allCrossOrigin, "同源 iframe"), false);
});

test("shadow-roots：shadow root 给 warning 并点明 P1 计划", () => {
  const report = admit(statsWith({ shadowRoots: 2 }), CASE);
  assert.equal(report.ok, true);
  assert.equal(report.blocking.length, 0);
  assert.ok(hits(report, "2 个 shadow root"));
  // 文案要说明「内部控件不可见」，否则读报告的人不知道失败原因在哪
  assert.ok(hits(report, "不可见"));

  assert.equal(hits(admit(statsWith(), CASE), "shadow root"), false);
});

test("nested-scroll：嵌套滚动容器给 warning", () => {
  const report = admit(statsWith({ nestedScrollContainers: 1 }), CASE);
  assert.equal(report.ok, true);
  assert.equal(report.blocking.length, 0);
  assert.ok(hits(report, "嵌套滚动容器"));

  assert.equal(hits(admit(statsWith(), CASE), "嵌套滚动"), false);
});

test("password-fields：密码框给 warning，并点明护栏会拦", () => {
  const report = admit(statsWith({ passwordFields: 1 }), CASE);
  assert.equal(report.ok, true);
  assert.equal(report.blocking.length, 0);
  assert.ok(hits(report, "密码框"));
  assert.ok(hits(report, "护栏"));

  assert.equal(hits(admit(statsWith(), CASE), "密码框"), false);
});

// ---------------------------------------------------------------------------
// 分拣逻辑
// ---------------------------------------------------------------------------

test("ok 严格等于「blocking 为空」，warning 再多也不影响", () => {
  const warningsOnly = admit(
    statsWith({ shadowRoots: 1, passwordFields: 1, nestedScrollContainers: 1, frames: 2 }),
    CASE,
  );
  assert.equal(warningsOnly.blocking.length, 0);
  assert.equal(warningsOnly.warnings.length, 4);
  assert.equal(warningsOnly.ok, true);

  const mixed = admit(statsWith({ fileInputs: 1, shadowRoots: 1 }), CASE);
  assert.equal(mixed.blocking.length, 1);
  assert.equal(mixed.warnings.length, 1);
  assert.equal(mixed.ok, false, "有 blocking 就必须 ok = false");
});

test("规则表逐条可达，且每一条都有对应的触发统计", () => {
  // 这条守着「加了规则却忘了加测试」：新增一条规则而没在这里登记，
  // 下面的 id 集合比对会直接失败，而不是让新规则悄悄没有被覆盖过。
  const TRIGGERS: Record<string, AdmissionStats> = {
    "canvas-only": statsWith({ canvases: 1, interactiveElements: 0 }),
    "file-upload": statsWith({ fileInputs: 1 }),
    "cross-origin-frames": statsWith({ frames: 2, crossOriginFrames: 1 }),
    "same-origin-frames": statsWith({ frames: 2, crossOriginFrames: 0 }),
    "shadow-roots": statsWith({ shadowRoots: 1 }),
    "nested-scroll": statsWith({ nestedScrollContainers: 1 }),
    "password-fields": statsWith({ passwordFields: 1 }),
  };

  assert.deepEqual(
    Object.keys(TRIGGERS).sort(),
    ADMISSION_RULES.map((rule) => rule.id).sort(),
    "规则表与测试里的触发表对不上：要么规则改了 id，要么新规则没被覆盖",
  );

  for (const rule of ADMISSION_RULES) {
    const trigger = TRIGGERS[rule.id];
    assert.ok(trigger !== undefined, `规则 ${rule.id} 没有触发统计`);
    assert.notEqual(rule.hit(trigger, CASE), null, `规则 ${rule.id} 在触发统计下没有命中`);
    assert.equal(rule.hit(statsWith(), CASE), null, `规则 ${rule.id} 在干净统计下不该命中`);
    // rationale 要指向 limitations.md 的具体小节，否则规则表与文档会各说各的
    assert.match(rule.rationale, /limitations\.md §\d/, `规则 ${rule.id} 的依据没有指向文档小节`);
  }
});

// ---------------------------------------------------------------------------
// 文案
// ---------------------------------------------------------------------------

test("describeAdmission：可以测时给出明确肯定，且不出现任何条目", () => {
  const lines = describeAdmission(admit(statsWith(), CASE));
  assert.match(lines[0] ?? "", /可以测/);
  assert.equal(lines.some((line) => line.includes("不该跑")), false);
  assert.equal(lines.some((line) => line.includes("阻断 · ")), false);
  assert.equal(lines.some((line) => line.includes("警告 · ")), false);
});

test("describeAdmission：blocking 的语气是「这个用例不该跑」", () => {
  const lines = describeAdmission(admit(statsWith({ fileInputs: 1 }), CASE));

  assert.match(lines[0] ?? "", /不该跑/);
  // 关键的一句：命中 blocking 的失败**不是**被测系统的缺陷。
  // 少了这句，读报告的人会把它当成本次运行发现的卡点（假阳性）。
  assert.ok(lines[0]?.includes("平台能力不足"));
  assert.ok(lines.some((line) => line.startsWith("  阻断 · ")));
  // 没有 warning 时不该出现警告段落
  assert.equal(lines.some((line) => line.startsWith("  警告 · ")), false);
  assert.equal(lines.some((line) => line.includes("打折扣")), false);
});

test("describeAdmission：warning 的语气是「跑得动但结果要打折扣」", () => {
  const lines = describeAdmission(admit(statsWith({ shadowRoots: 1 }), CASE));

  assert.match(lines[0] ?? "", /可以测/, "只有 warning 时不应说「不该跑」");
  assert.equal(lines[0]?.includes("不该跑"), false);
  assert.ok(lines.some((line) => line.startsWith("  警告 · ")));
  assert.equal(lines.some((line) => line.startsWith("  阻断 · ")), false);
  assert.ok(lines.some((line) => line.includes("打折扣")));
});

test("describeAdmission：两类条目用不同的前缀，读的人第一眼就能分开", () => {
  const lines = describeAdmission(admit(statsWith({ fileInputs: 1, shadowRoots: 1 }), CASE));
  const blockingLines = lines.filter((line) => line.startsWith("  阻断 · "));
  const warningLines = lines.filter((line) => line.startsWith("  警告 · "));

  assert.equal(blockingLines.length, 1);
  assert.equal(warningLines.length, 1);
  // 两者必须落在不同的行、带不同的前缀：混在一起就等于把假阳性重新混进真实缺陷里
  assert.notEqual(blockingLines[0], warningLines[0]);
});

test("describeAdmission：原始统计始终附在最后，便于人工核对", () => {
  const lines = describeAdmission(admit(statsWith({ frames: 7, crossOriginFrames: 3 }), CASE));
  const statsLine = lines.find((line) => line.includes("探测统计"));
  assert.ok(statsLine !== undefined);
  // 口径要写出来：不点明「含主文档」的话，「7 个 frame」会被读成「7 个 iframe」
  assert.ok(statsLine.includes("frame 7（含主文档，其中跨域 3）"));
  assert.ok(statsLine.includes("可交互元素 5"));
});
