/**
 * `validateChoice` 的单元测试。
 *
 * 判据移植自参考项目 `model.py:30-45`，**一条不改、顺序不改**（architecture.md §3.3）。
 * 这是整个项目的安全边界：校验不过就抛 `InvalidDecision`，**绝不执行任何动作**。
 * 所以每条判据都要有一条「喂非法输入，看它是否被拒、理由是否说清」的用例。
 *
 * 上游测试里的六个拒绝参数（unknown / nan / missing / negative / non_max / confidence）
 * 逐一移植，各占一条用例——它们对应六个不同的失灵方式，合并成一条就分不清是哪条判据漏了。
 *
 * 全部离线：手写 `Question` 与回答字面量，不调用任何引擎。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { Question } from "../src/engine/types.ts";
import { validateChoice } from "../src/core/policy.ts";
import { InvalidDecision } from "../src/core/errors.ts";

const QUESTION: Question = {
  key: "operation",
  prompt: "下一步做什么？",
  options: [
    { id: "CLICK", label: "[CLICK] button 提交", detail: { kind: "click" } },
    { id: "DONE", label: "[DONE] Done", detail: {} },
    { id: "BLOCKED", label: "[BLOCKED] Blocked", detail: {} },
  ],
};

/** 一个合法的真分布，供各条用例按需破坏其中一处。 */
function valid(): Record<string, unknown> {
  return {
    choice: "CLICK",
    probabilities: { CLICK: 0.6, DONE: 0.3, BLOCKED: 0.1 },
    confidence: 0.6,
  };
}

/** 断言抛 InvalidDecision，且消息里能看出是哪条判据不过、实际值是什么。 */
function rejects(answer: unknown, expect: RegExp, mentions: string[] = []): void {
  assert.throws(
    () => validateChoice(answer, QUESTION),
    (error: unknown) => {
      assert.ok(error instanceof InvalidDecision, `应抛 InvalidDecision，实际是 ${String(error)}`);
      assert.match(error.message, expect);
      for (const text of mentions) {
        assert.ok(error.message.includes(text), `消息里应带上实际值「${text}」：${error.message}`);
      }
      return true;
    },
  );
}

// ---------------------------------------------------------------------------
// 上游六个拒绝参数
// ---------------------------------------------------------------------------

const UPSTREAM_REJECTIONS: { name: string; why: string; answer: unknown; expect: RegExp; mentions: string[] }[] = [
  {
    name: "unknown",
    why: "choice 不在候选集内（幻觉，或把索引抄错）",
    answer: { ...valid(), choice: "SELECT" },
    expect: /choice 不在候选集内/,
    // 报告要能直接指出它选了谁，以及当时的候选集有哪些。
    mentions: ["SELECT", "CLICK"],
  },
  {
    name: "nan",
    why: "概率是 NaN——与任何数比较都是 false，会让后面两条判据静默通过",
    answer: { ...valid(), probabilities: { CLICK: Number.NaN, DONE: 0.5, BLOCKED: 0.5 } },
    expect: /不是有限数/,
    mentions: ["NaN"],
  },
  {
    name: "missing",
    why: "概率键集合与候选集不一致（缺键会让消费方取到 undefined）",
    answer: { ...valid(), probabilities: { CLICK: 0.6, DONE: 0.4 } },
    expect: /概率键集合与候选集不一致/,
    mentions: ["BLOCKED"],
  },
  {
    name: "negative",
    why: "概率不在 [0,1] 内",
    answer: { ...valid(), probabilities: { CLICK: -0.1, DONE: 0.6, BLOCKED: 0.5 } },
    expect: /不在 \[0,1\] 内/,
    mentions: ["-0.1"],
  },
  {
    name: "non_max",
    why: "choice 不是最大概率项——分布自相矛盾，说明引擎在乱答",
    answer: {
      ...valid(),
      choice: "CLICK",
      probabilities: { CLICK: 0.2, DONE: 0.5, BLOCKED: 0.3 },
    },
    expect: /不是最大概率项/,
    mentions: ["CLICK", "DONE", "0.5"],
  },
  {
    name: "confidence",
    why: "confidence 存在但不是 [0,1] 内的有限数（报告直接展示它，不能猜一个数顶上）",
    answer: { ...valid(), confidence: "0.9" },
    expect: /confidence 必须是 \[0,1\] 内的有限数/,
    mentions: ["0.9"],
  },
];

for (const rejection of UPSTREAM_REJECTIONS) {
  test(`上游参数 ${rejection.name}：拒绝，并说清是哪条判据不过（${rejection.why}）`, () => {
    rejects(rejection.answer, rejection.expect, rejection.mentions);
  });
}

test("confidence 的其它非法形态同样被拒（NaN / 越界 / 布尔）", () => {
  rejects({ ...valid(), confidence: Number.NaN }, /confidence 必须是/, ["NaN"]);
  rejects({ ...valid(), confidence: 1.5 }, /confidence 必须是/, ["1.5"]);
  rejects({ ...valid(), confidence: true }, /confidence 必须是/);
});

// ---------------------------------------------------------------------------
// 补充判据
// ---------------------------------------------------------------------------

test("多出候选集以外的概率键也被拒：引擎不能自说自话", () => {
  rejects(
    { ...valid(), probabilities: { CLICK: 0.5, DONE: 0.3, BLOCKED: 0.1, SELECT: 0.1 } },
    /概率键集合与候选集不一致/,
    ["SELECT"],
  );
});

test("回答不是对象时被拒", () => {
  rejects(null, /不是对象/);
  rejects("CLICK", /不是对象/);
  rejects([0.6, 0.3, 0.1], /不是对象/);
});

test("probabilities 不是对象时被拒", () => {
  rejects({ ...valid(), probabilities: [0.6, 0.3, 0.1] }, /probabilities 必须是对象/);
  rejects({ ...valid(), probabilities: 0.6 }, /probabilities 必须是对象/);
});

test("和为 1 的容差是 |sum-1| < 0.02，边界内外各一条", () => {
  // 偏差 0.019：通过（choice 同时是最大值，避免撞上第 5 条判据）。
  const near = validateChoice(
    { choice: "DONE", probabilities: { CLICK: 0.5, DONE: 0.519, BLOCKED: 0 }, confidence: 0.5 },
    QUESTION,
  );
  assert.equal(near.choice, "DONE");

  // 偏差恰好 0.02：拒绝（上游是 `< 0.02`，不是 `<=`）。错误信息里要有实际的和。
  rejects(
    { choice: "DONE", probabilities: { CLICK: 0.5, DONE: 0.52, BLOCKED: 0 }, confidence: 0.5 },
    /与 1 的偏差超过/,
    ["1.02"],
  );
});

test("并列最大是允许的：上游用 >= max - 1e-6", () => {
  const answer = validateChoice(
    { choice: "DONE", probabilities: { CLICK: 0.5, DONE: 0.5, BLOCKED: 0 }, confidence: 0.5 },
    QUESTION,
  );
  assert.equal(answer.choice, "DONE");
  assert.equal(answer.probabilities["DONE"], 0.5);
});

test("真分布标 full，概率表覆盖完整候选集且原样保留", () => {
  const answer = validateChoice(valid(), QUESTION);

  assert.equal(answer.key, "operation");
  assert.equal(answer.choice, "CLICK");
  assert.equal(answer.distribution, "full");
  assert.equal(answer.confidence, 0.6);
  // 键集合与候选集**完全一致**（多一个少一个都算不一致）：
  // 消费方（checks.ts 按 id 取概率）因此永远不必处理 undefined。
  // 注意用 Object.keys 而不是逐个 option.id 索引——`assert.deepEqual` 带断言签名，
  // 会把 answer.probabilities 收窄成字面量对象类型，再用 string 索引就过不了类型检查。
  assert.deepEqual(Object.keys(answer.probabilities).sort(), ["BLOCKED", "CLICK", "DONE"]);
  assert.deepEqual(answer.probabilities, { CLICK: 0.6, DONE: 0.3, BLOCKED: 0.1 });
});

test("confidence 缺省时回落到被选中项的概率，而不是编一个数", () => {
  const { confidence: _dropped, ...withoutConfidence } = valid();
  const answer = validateChoice(withoutConfidence, QUESTION);
  assert.equal(answer.confidence, 0.6);
});

test("只给一个选择（无概率）：合成覆盖完整候选集的 one-hot，标 degenerate 而不是判非法", () => {
  // 通用 LLM 引擎只回一个选择。若判非法，那类引擎将完全不可用；
  // 标 degenerate 则让概率类断言变成 skipped——既不假通过也不冤枉引擎。
  const answer = validateChoice({ choice: "DONE", confidence: 0.8 }, QUESTION);

  assert.equal(answer.distribution, "degenerate");
  // one-hot 覆盖**完整候选集**：稀疏表会把「没给概率」和「概率是 0」混成同一件事。
  assert.deepEqual(answer.probabilities, { CLICK: 0, DONE: 1, BLOCKED: 0 });
  assert.equal(answer.confidence, 0.8);
});

test("只给一个概率键且就是 choice：同样是 degenerate", () => {
  const answer = validateChoice({ choice: "DONE", probabilities: { DONE: 1 }, confidence: 0.7 }, QUESTION);
  assert.equal(answer.distribution, "degenerate");
  assert.deepEqual(answer.probabilities, { CLICK: 0, DONE: 1, BLOCKED: 0 });
});

test("只有一个候选的问题：标 degenerate 而不是判非法", () => {
  const single: Question = { key: "click_target", prompt: "p", options: [{ id: "1", label: "[1] button 提交", detail: {} }] };
  const answer = validateChoice({ choice: "1", probabilities: { "1": 1 }, confidence: 0.9 }, single);
  assert.equal(answer.distribution, "degenerate");
  assert.equal(answer.choice, "1");
  // 唯一合法概率表就是这个 one-hot，与合成分布无法区分——按「降级安全」处理。
  assert.deepEqual(answer.probabilities, { "1": 1 });
});

test("引擎自报 degenerate 时保持 degenerate：降级安全，升级不安全", () => {
  // 把合成的 one-hot 当真实分布，`minTargetProbability: 0.3` 会**假通过**。
  const answer = validateChoice({ ...valid(), distribution: "degenerate" }, QUESTION);
  assert.equal(answer.distribution, "degenerate");
});

test("只在候选集外的键上给概率，仍然算键集合不一致（不能靠它躲过判据）", () => {
  rejects({ choice: "CLICK", probabilities: { ONLY_ONE: 1 } }, /概率键集合与候选集不一致/);
});
