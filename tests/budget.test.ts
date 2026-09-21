/**
 * 预算计量器的行为锁定。
 *
 * 全部用**注入的 now()** 控制墙钟，没有一处真的等待：墙钟上限要能被确定性地测到，
 * 否则要么测得慢，要么测得飘。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { budgetOf, createBudgetMeter } from "../src/core/budget.ts";
import type { Budget, Case } from "../src/schema/case.ts";
import type { Usage } from "../src/schema/report.ts";

/** 可控时钟：now() 只读，advance() 推进。 */
function fakeClock(start = 0): { now: () => number; advance: (ms: number) => void } {
  let current = start;
  return {
    now: () => current,
    advance: (ms) => {
      current += ms;
    },
  };
}

const BASE_BUDGET: Budget = {
  maxSteps: 40,
  maxModelCalls: 40,
  maxInputTokens: 200_000,
  maxCostUsd: null,
  maxElapsedMs: 300_000,
};

function budgetWith(over: Partial<Budget> = {}): Budget {
  return { ...BASE_BUDGET, ...over };
}

function usageWith(over: Partial<Usage> = {}): Usage {
  return { inputTokens: 0, outputTokens: 0, costUsd: null, requests: 1, ...over };
}

// ---------------------------------------------------------------------------
// 各维度刹车
// ---------------------------------------------------------------------------

test("预算：未超限时不刹车", () => {
  const meter = createBudgetMeter(budgetWith({ maxSteps: 2 }), fakeClock().now);
  meter.recordStep();

  const status = meter.check();
  assert.equal(status.exceeded, false);
  assert.equal(status.dimension, null);
  assert.equal(status.detail, "", "未超限时 detail 留空，免得报告里显示一句无意义的话");
});

test("预算：步数超限（maxSteps 是「最多执行多少步」本身）", () => {
  const meter = createBudgetMeter(budgetWith({ maxSteps: 2 }), fakeClock().now);

  meter.recordStep();
  assert.equal(meter.check().exceeded, false, "还有额度");

  meter.recordStep();
  assert.equal(meter.check().exceeded, true, "用满 2 步即刹车，不会再去走第 3 步");

  meter.recordStep(); // 走到这里现实中不会发生，只是为了让实际值与上限取到不同的数字
  const status = meter.check();
  assert.equal(status.dimension, "steps");
  assert.match(status.detail, /实际 3 步/);
  assert.match(status.detail, /上限 2 步/);
});

test("预算：模型请求数超限", () => {
  const meter = createBudgetMeter(budgetWith({ maxModelCalls: 4 }), fakeClock().now);

  meter.recordDecision();
  meter.recordCall(usageWith({ requests: 3 }), 10);
  assert.equal(meter.check().exceeded, false);

  meter.recordCall(usageWith({ requests: 2 }), 10); // 重试把总数推到 5
  const status = meter.check();
  assert.equal(status.exceeded, true);
  assert.equal(status.dimension, "modelCalls");
  assert.match(status.detail, /实际 5 次/);
  assert.match(status.detail, /上限 4 次/);
});

test("预算：input token 超限", () => {
  const meter = createBudgetMeter(budgetWith({ maxInputTokens: 100 }), fakeClock().now);

  meter.recordCall(usageWith({ inputTokens: 60 }), 5);
  assert.equal(meter.check().exceeded, false);

  meter.recordCall(usageWith({ inputTokens: 55 }), 5);
  const status = meter.check();
  assert.equal(status.exceeded, true);
  assert.equal(status.dimension, "inputTokens");
  assert.match(status.detail, /实际 115/);
  assert.match(status.detail, /上限 100/);
});

test("预算：金额超限", () => {
  const meter = createBudgetMeter(budgetWith({ maxCostUsd: 0.25 }), fakeClock().now);

  meter.recordCall(usageWith({ costUsd: 0.1 }), 5);
  assert.equal(meter.check().exceeded, false);

  meter.recordCall(usageWith({ costUsd: 0.2 }), 5);
  const status = meter.check();
  assert.equal(status.exceeded, true);
  assert.equal(status.dimension, "costUsd");
  assert.match(status.detail, /实际 \$0\.3/);
  assert.match(status.detail, /上限 \$0\.25/);
});

test("预算：墙钟超限（注入 now，不真的等待）", () => {
  const clock = fakeClock();
  const meter = createBudgetMeter(budgetWith({ maxElapsedMs: 1000 }), clock.now);

  clock.advance(999);
  assert.equal(meter.check().exceeded, false);

  clock.advance(201);
  const status = meter.check();
  assert.equal(status.exceeded, true);
  assert.equal(status.dimension, "elapsedMs");
  assert.match(status.detail, /实际 1200ms/);
  assert.match(status.detail, /上限 1000ms/);
});

test("预算：多个维度同时超限时，dimension 取最可能的那个（步数优先）", () => {
  const clock = fakeClock();
  const meter = createBudgetMeter(
    budgetWith({ maxSteps: 1, maxModelCalls: 1, maxInputTokens: 1, maxCostUsd: 0.01, maxElapsedMs: 1 }),
    clock.now,
  );

  meter.recordStep();
  meter.recordCall(usageWith({ requests: 2, inputTokens: 500, costUsd: 5 }), 100);
  clock.advance(5000);

  assert.equal(meter.check().dimension, "steps", "检查顺序决定报告里的 dimension，步数排最前");
});

// ---------------------------------------------------------------------------
// modelCalls 的口径：重试不是免费通道
// ---------------------------------------------------------------------------

test("预算：modelCalls 按实际请求数算，decisions 只记逻辑决策", () => {
  const meter = createBudgetMeter(budgetWith({ maxModelCalls: 3 }), fakeClock().now);

  meter.recordDecision();
  meter.recordCall(usageWith({ requests: 3, inputTokens: 100 }), 250);

  const stats = meter.stats();
  assert.equal(stats.modelCalls, 3, "一次决策重试 3 次 = 3 个请求，都计费");
  assert.equal(stats.decisions, 1, "逻辑决策只有一次，recordCall 不得顺手加它");

  const status = meter.check();
  assert.equal(status.exceeded, true, "按请求数算才会刹车：这正是重试不是免费通道的含义");
  assert.equal(status.dimension, "modelCalls");
});

test("预算：recordDecision 不占请求额度，刹车只认请求数", () => {
  const meter = createBudgetMeter(budgetWith({ maxModelCalls: 1 }), fakeClock().now);

  meter.recordDecision();
  const stats = meter.stats();
  assert.equal(stats.decisions, 1);
  assert.equal(stats.modelCalls, 0);
  assert.equal(meter.check().exceeded, false);
});

// ---------------------------------------------------------------------------
// 金额：null 是「未知」，不是 0
// ---------------------------------------------------------------------------

test("预算：maxCostUsd 为 null 时不设金额上限，也不做金额检查", () => {
  const meter = createBudgetMeter(budgetWith({ maxCostUsd: null }), fakeClock().now);

  meter.recordCall(usageWith({ costUsd: 999 }), 5);

  assert.equal(meter.check().exceeded, false, "用例没设金额上限，金额再高也不该刹车");
  assert.equal(meter.stats().costUsd, 999, "金额照常统计，只是不拿来刹车");
  assert.match(meter.summary(), /未设上限/, "summary 要明说未设上限，而不是显示 0 或某个上限");
});

test("预算：金额来源为 null 时统计保持 null，绝不用 0 冒充", () => {
  const fresh = createBudgetMeter(budgetWith(), fakeClock().now);
  assert.equal(fresh.stats().costUsd, null, "一次调用都还没有 = 尚无金额信息，不是 0");

  const meter = createBudgetMeter(budgetWith(), fakeClock().now);
  meter.recordCall(usageWith({ costUsd: null }), 5);
  assert.equal(meter.stats().costUsd, null);
});

test("预算：部分未知 = 总额永久未知，不可被后续的已知金额救回", () => {
  const meter = createBudgetMeter(budgetWith(), fakeClock().now);

  meter.recordCall(usageWith({ costUsd: 0.02 }), 5);
  assert.equal(meter.stats().costUsd, 0.02);

  meter.recordCall(usageWith({ costUsd: null }), 5);
  assert.equal(meter.stats().costUsd, null, "已知部分 + 未知 ≠ 总和");

  meter.recordCall(usageWith({ costUsd: 1 }), 5);
  assert.equal(meter.stats().costUsd, null, "未知一旦出现不可撤销，否则给出的是一份看起来可用的错数");
});

test("预算：金额未知时无法校验，不刹车", () => {
  const meter = createBudgetMeter(budgetWith({ maxCostUsd: 0.01 }), fakeClock().now);

  meter.recordCall(usageWith({ costUsd: null }), 5);
  assert.equal(meter.check().exceeded, false, "没有金额就无从判断是否超限，此处不刹车是诚实的");
  assert.match(meter.summary(), /未知/, "但要在摘要里说清「未知」，不能让人以为花了 0");
});

// ---------------------------------------------------------------------------
// 墙钟口径与视图
// ---------------------------------------------------------------------------

test("预算：elapsedMs 现算，不由 recordStep 累加", () => {
  const clock = fakeClock();
  const meter = createBudgetMeter(budgetWith(), clock.now);

  meter.recordStep();
  clock.advance(5000);

  assert.equal(meter.stats().elapsedMs, 5000);
  assert.equal(meter.view().elapsedMs, 5000);

  meter.recordStep();
  assert.equal(meter.stats().steps, 2);
  assert.equal(meter.stats().elapsedMs, 5000, "步数涨了而墙钟由 now() 现算，所以还是 5000");
});

test("预算：engineLatencyMs 与浏览器耗时分账", () => {
  const clock = fakeClock();
  const meter = createBudgetMeter(budgetWith(), clock.now);

  meter.recordCall(usageWith({ inputTokens: 10, outputTokens: 30 }), 120);
  clock.advance(5000); // 这段时间花在浏览器上
  meter.recordCall(usageWith({ inputTokens: 5, outputTokens: 20 }), 80);

  const stats = meter.stats();
  assert.equal(stats.engineLatencyMs, 200);
  assert.equal(stats.inputTokens, 15);
  assert.equal(stats.outputTokens, 50);
  assert.equal(stats.elapsedMs, 5000, "墙钟含浏览器时间，引擎耗时只算网络往返，两者不可混用");
});

test("预算：view() 给出引擎能据以裁剪上下文的那几项", () => {
  const meter = createBudgetMeter(
    budgetWith({ maxSteps: 5, maxModelCalls: 6, maxInputTokens: 7, maxElapsedMs: 8 }),
    fakeClock().now,
  );

  meter.recordStep();
  meter.recordCall(usageWith({ requests: 2, inputTokens: 30 }), 40);

  assert.deepEqual(meter.view(), {
    stepsUsed: 1,
    maxSteps: 5,
    modelCallsUsed: 2,
    maxModelCalls: 6,
    inputTokensUsed: 30,
    maxInputTokens: 7,
    elapsedMs: 0,
    maxElapsedMs: 8,
  });
});

test("预算：stats() 返回快照，调用方改不动计量器", () => {
  const meter = createBudgetMeter(budgetWith(), fakeClock().now);
  meter.recordStep();

  const snapshot = meter.stats();
  snapshot.steps = 999;

  assert.equal(meter.stats().steps, 1, "这是唯一的成本事实来源，交出去的引用不能反向改它");
});

test("预算：summary() 同时给出已用量与上限", () => {
  const meter = createBudgetMeter(budgetWith({ maxSteps: 10, maxCostUsd: 1 }), fakeClock().now);
  meter.recordStep();
  meter.recordCall(usageWith({ costUsd: 0.5 }), 30);

  const summary = meter.summary();
  assert.match(summary, /步数 1\/10/);
  assert.match(summary, /\$0\.5/);
});

// ---------------------------------------------------------------------------
// budgetOf
// ---------------------------------------------------------------------------

test("budgetOf：直接取用例的预算，不做兜底", () => {
  const budget = budgetWith({ maxSteps: 7 });
  const caseDef: Case = {
    schemaVersion: 1,
    id: "demo-case",
    title: "示例",
    goal: "示例目标",
    startUrl: "https://example.com/",
    mode: "readonly",
    allowedOrigins: ["https://example.com"],
    budget,
    guardrails: [],
    allowDefaultOverride: false,
    engine: "scripted",
    assertions: {},
  };

  assert.equal(budgetOf(caseDef), budget, "默认值由 schema 填充，这里只做取值，不重复写兜底");
});
