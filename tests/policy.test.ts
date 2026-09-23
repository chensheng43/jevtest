/**
 * 动作空间、决策请求与决策解析的单元测试。
 *
 * 这一层是**安全边界**（见 policy.ts 文件头）：模型只能从候选集里选，
 * 只读模式靠构造生效，只有被选中操作的 target head 会被消费。
 * 因此这里的每条用例都在守一个具体的失灵方式，而不只是「跑得通」。
 *
 * 全部离线：手写 `Action` / `Observation` / `Answer` 字面量，
 * 不开浏览器、不发网络请求（tests/README.md 的硬性要求）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

import { CaseDefinitionSchema } from "../src/schema/case.ts";
import type { Case } from "../src/schema/case.ts";
import type { Action, Observation } from "../src/browser/session.ts";
import type { Answer, DecisionResult, Question } from "../src/engine/types.ts";
import type { StepRecord } from "../src/schema/report.ts";
import {
  MAX_ACTIONS,
  READONLY_BLOCKED_CLICK_ROLES,
  buildActionSpace,
  buildDecisionRequest,
  isTerminal,
  overrideWeakBlocked,
  resolveDecision,
  targetQuestionKey,
} from "../src/core/policy.ts";
import { InvalidDecision } from "../src/core/errors.ts";

// ---------------------------------------------------------------------------
// 构造辅助
// ---------------------------------------------------------------------------

/**
 * click 动作。node 是 snapshot.js 用 WeakMap 分配的 **code-owned 身份**
 * （`snapshot.js:42-45`），不是选择器——测试里手写一个整数就够，
 * 因为本层只把它当「同一个节点」的等价类用。
 */
function click(node: number, label: string, role = "button"): Action {
  return { id: `e${node}`, kind: "click", label, role, node };
}

/** 可编辑元素在 snapshot 里会同时产出 fill 与一条 `Open <field>` 的 click（`snapshot.js:116-117`）。 */
function editable(node: number, field: string, value: string, role = "textbox"): Action[] {
  return [
    { id: `e${node}`, kind: "fill", label: field, role, node, value },
    { id: `e${node}`, kind: "click", label: `Open ${field}`, role, node, value },
  ];
}

/** 原生下拉的一条 option 动作。label 是 `字段名 → 选项名`，value 是选项的内部值。 */
function selectOption(node: number, field: string, option: string, value: string): Action {
  return { id: `e${node}`, kind: "select", label: `${field} → ${option}`, role: "combobox", node, value };
}

const SCROLL_DOWN: Action = { id: "scroll_down", kind: "scroll", label: "Scroll down", delta: 560 };
const SCROLL_UP: Action = { id: "scroll_up", kind: "scroll", label: "Scroll up", delta: -560 };
const WAIT: Action = { id: "wait", kind: "wait", label: "Wait for the page to update" };

function observation(actions: Action[], overrides: Partial<Observation> = {}): Observation {
  return {
    url: "https://example.com/",
    title: "示例页",
    text: "页面可见文本",
    textTruncated: false,
    w: 1280,
    h: 800,
    scroll: { y: 0, height: 2000 },
    actions,
    omittedActions: 0,
    marker: null,
    pageKey: null,
    guards: {},
    fingerprint: "fp",
    ...overrides,
  };
}

/** 走一遍 schema，拿到默认值已填充的 `Case`（运行时只消费这个类型）。 */
function mkCase(overrides: Partial<Case> = {}): Case {
  return CaseDefinitionSchema.parse({
    title: "测试用例",
    goal: "把这件事做完",
    startUrl: "https://example.com/",
    ...overrides,
  });
}

function step(n: number): StepRecord {
  return {
    step: n,
    action: `动作${n}`,
    kind: "click",
    role: "button",
    operation: "CLICK",
    target: "1",
    probability: 0.9,
    operationProbability: 0.9,
    confidence: 0.9,
    distribution: "full",
    executed: true,
    blockReason: null,
    text: null,
    textEngine: null,
    urlBefore: "https://example.com/",
    urlAfter: "https://example.com/",
    pageChanged: false,
    engineLatencyMs: 5,
    textLatencyMs: 0,
    observedMs: 5,
    frame: null,
    engineUsage: { inputTokens: 10, outputTokens: 5, costUsd: null, requests: 1 },
  };
}

/** 问题候选集里的 id，按问题 key 取。 */
function optionIds(question: Question): string[] {
  return question.options.map((option) => option.id);
}

// ---------------------------------------------------------------------------
// buildActionSpace：只读模式
// ---------------------------------------------------------------------------

test("readonly 下 targets 里根本不存在 TYPE_TEXT / SELECT 键（interactive 下存在）", () => {
  const actions = [
    click(1, "搜索", "link"),
    ...editable(2, "关键词", ""),
    selectOption(3, "国家", "中国", "CN"),
    selectOption(3, "国家", "日本", "JP"),
  ];

  const interactive = buildActionSpace(actions, { mode: "interactive" });
  assert.ok(interactive.targets["TYPE_TEXT"] !== undefined, "交互模式必须提供 TYPE_TEXT 候选");
  assert.ok(interactive.targets["SELECT"] !== undefined, "交互模式必须提供 SELECT 候选");

  const readonly = buildActionSpace(actions, { mode: "readonly" });
  // 关键：不是「键存在但为空」，而是**键根本不存在**。模型无从选中一个不存在的东西，
  // 因此「拒绝逻辑写漏一个 case」这种失灵方式在这一层不存在（architecture.md §5.1）。
  assert.equal(readonly.targets["TYPE_TEXT"], undefined);
  assert.equal(readonly.targets["SELECT"], undefined);
  assert.deepEqual(Object.keys(readonly.targets), ["CLICK"]);
});

test("readonly 剔除每一个声明的 click 角色，link 不受影响", () => {
  // 遍历**常量本身**而不是在这里另抄一份清单：抄一份的话，清单加了角色而这里忘了加，
  // 测试照样全绿——这正是「两处事实来源必然漂移」的典型形态。
  for (const role of READONLY_BLOCKED_CLICK_ROLES) {
    const actions = [click(1, `控件-${role}`, role), click(2, "一个普通链接", "link")];
    const space = buildActionSpace(actions, { mode: "readonly" });
    // 被剔除的是「可能产生变更」的控件：按钮会提交、勾选框会改状态、下拉会改选择、
    // ARIA 的 option/gridcell 会改被提交的值。
    // 剩下那个 link 拿到索引 1——**被剔除的节点不占号**，索引在可用元素上连续
    // （模型的候选集是紧凑的；真实身份在 Action.node 上，与索引无关）。
    assert.deepEqual(Object.keys(space.targets["CLICK"] ?? {}), ["1"], `role=${role} 的 click 在只读模式下必须被剔除`);
    assert.deepEqual(space.elements.map((element) => element.label), ["一个普通链接"]);

    // interactive 下同样两个控件都在——反例证明上面那条不是因为别的原因才通过。
    const open = buildActionSpace(actions, { mode: "interactive" });
    assert.deepEqual(Object.keys(open.targets["CLICK"] ?? {}).sort(), ["1", "2"]);
  }

  // 导航与聚焦类角色必须留着，否则只读用例连页面都翻不动（收益是零）。
  for (const role of ["link", "tab", "textbox", "searchbox"]) {
    const space = buildActionSpace([click(1, `控件-${role}`, role)], { mode: "readonly" });
    assert.deepEqual(
      Object.keys(space.targets["CLICK"] ?? {}),
      ["1"],
      `role=${role} 的 click 在只读模式下应当保留`,
    );
  }
});

test("只读角色清单与文档一致（文档是人对「本运行不可能发生变更」的承诺）", async () => {
  // 只读的保证同时写在三处：代码常量、docs/case-format.md §mode、architecture.md §5.1。
  // 二者不一致时，说谎的是文档而代码不会——所以用测试把它钉住。
  const normalise = (value: string): string[] =>
    value.split(",").map((item) => item.trim()).filter(Boolean).sort();
  const expected = normalise(READONLY_BLOCKED_CLICK_ROLES.join(", "));

  for (const path of ["../docs/case-format.md", "../docs/architecture.md"]) {
    const doc = await readFile(new URL(path, import.meta.url), "utf8");
    // 取文档里最长的那个 `{role, role, ...}` 清单：两份文档都只在这里列角色，
    // 而花括号还出现在别处（YAML 例子、TypeScript 片段），所以按长度取最长的一个。
    const candidates = [...doc.matchAll(/\{([a-z]+(?:, [a-z]+){2,})\}/g)].map((match) => match[1] ?? "");
    const longest = candidates.sort((a, b) => b.length - a.length)[0] ?? "";
    assert.deepEqual(normalise(longest), expected, `${path} 里的只读角色清单与代码不一致`);
  }
});

test("readonly 下可编辑元素仍可 CLICK（聚焦/点开字段属于「看」），但不可 TYPE_TEXT", () => {
  const space = buildActionSpace(editable(1, "出发地", "Zürich"), { mode: "readonly" });
  assert.deepEqual(Object.keys(space.targets["CLICK"] ?? {}), ["1"]);
  assert.equal(space.targets["TYPE_TEXT"], undefined);
  // 元素表里那一行的 operations 也必须如实反映，否则模型会去碰一个不存在的操作。
  assert.deepEqual(space.elements[0]?.operations, ["CLICK"]);
});

test("readonly 下整页只有变更型元素时，元素表为空而 targets 无键", () => {
  const space = buildActionSpace([selectOption(1, "国家", "中国", "CN")], { mode: "readonly" });
  assert.deepEqual(space.elements, []);
  assert.deepEqual(Object.keys(space.targets), []);
});

// ---------------------------------------------------------------------------
// buildActionSpace：索引与目标
// ---------------------------------------------------------------------------

test("一个节点只拿一个索引，即使它同时可点可输入", () => {
  const actions = [click(1, "首页", "link"), ...editable(2, "搜索", "")];
  const space = buildActionSpace(actions, { mode: "interactive" });

  // 同一个输入框不能以 [1] 和 [2] 两个身份出现（上游 model.py:60 的约束）。
  assert.deepEqual(
    space.elements.map((element) => element.index),
    ["1", "2"],
  );
  assert.equal(space.elements.length, 2);

  // 两个 head 里是**同一个索引**：模型不会把它当成两个元素。
  assert.deepEqual(Object.keys(space.targets["CLICK"] ?? {}), ["1", "2"]);
  assert.deepEqual(Object.keys(space.targets["TYPE_TEXT"] ?? {}), ["2"]);

  // 元素名取 fill 那条（「搜索」），而不是 companion click 的「Open 搜索」：
  // 后者描述的是「点开这个字段」，不是这个字段叫什么（snapshot.js:117）。
  assert.equal(space.elements[1]?.label, "搜索");
  assert.equal(space.targets["CLICK"]?.["2"]?.label, "Open 搜索");
});

test("原生下拉的每个 option 是独立 target，key 形如 3:1", () => {
  const actions = [
    click(1, "首页", "link"),
    click(2, "提交"),
    selectOption(3, "国家", "中国", "CN"),
    selectOption(3, "国家", "日本", "JP"),
  ];
  const space = buildActionSpace(actions, { mode: "interactive" });

  assert.deepEqual(Object.keys(space.targets["SELECT"] ?? {}), ["3:1", "3:2"]);
  for (const key of Object.keys(space.targets["SELECT"] ?? {})) {
    assert.match(key, /^\d+:\d+$/);
  }

  const combobox = space.elements.find((element) => element.role === "combobox");
  assert.ok(combobox !== undefined);
  assert.deepEqual(combobox.options, [
    { index: "3:1", label: "中国" },
    { index: "3:2", label: "日本" },
  ]);
});

test("模型看不到 option 的 value：元素行、选项表、target detail 三处都不含它", () => {
  const secret = "opt-value-9f3a";
  const actions = [selectOption(1, "国家", "中国", secret)];
  const space = buildActionSpace(actions, { mode: "interactive" });
  const observationPage = observation(actions);
  const request = buildDecisionRequest({
    caseDef: mkCase(),
    page: observationPage,
    space,
    history: [],
    budget: budgetView(),
  });

  // 「模型只知道选项标签、不知道它的值」是这条设计的一半——它回传索引，由本地映射回动作。
  const visible = JSON.stringify({ elements: space.elements, questions: request.questions });
  assert.equal(visible.includes(secret), false, "option 的 value 泄漏进了模型可见的内容");
  // 但本地映射表里必须留着它，否则映射回真实动作时拿不到该选哪个 option。
  assert.equal(space.targets["SELECT"]?.["1:1"]?.value, secret);
});

test("原生下拉的元素名是字段名而不是选项名（回归：曾取错分隔符的半边）", () => {
  const actions = [selectOption(1, "国家", "中国", "CN"), selectOption(1, "国家", "日本", "JP")];
  const space = buildActionSpace(actions, { mode: "interactive" });
  // snapshot 只把**未选中**的 option 放进候选集，所以选项一变这行字就会变。
  // 取成选项名的话，同一个下拉在两次观测里会显示成两个不同的元素。
  assert.equal(space.elements[0]?.label, "国家");
  assert.equal(space.elements[0]?.value, undefined, "下拉的当前值不在冻结契约里，只能不给");
});

test("页面级动作进 controls，不占元素候选额度", () => {
  const actions: Action[] = [];
  for (let node = 1; node <= MAX_ACTIONS; node++) actions.push(click(node, `按钮${node}`));
  const space = buildActionSpace([...actions, SCROLL_DOWN, SCROLL_UP, WAIT], { mode: "interactive" });

  assert.equal(space.elements.length, MAX_ACTIONS);
  assert.deepEqual(Object.keys(space.controls).sort(), ["SCROLL_DOWN", "SCROLL_UP", "WAIT"]);
  assert.equal(space.controls["SCROLL_UP"]?.delta, -560);
  assert.equal(space.controls["WAIT"]?.kind, "wait");
});

test("超出 MAX_ACTIONS 的候选被丢弃且不可被选中", () => {
  const actions: Action[] = [];
  for (let node = 1; node <= MAX_ACTIONS + 60; node++) actions.push(click(node, `按钮${node}`));
  const space = buildActionSpace(actions, { mode: "interactive" });

  assert.equal(space.elements.length, MAX_ACTIONS);
  assert.equal(Object.keys(space.targets["CLICK"] ?? {}).length, MAX_ACTIONS);
  // 被丢掉的索引不在候选集里——「不可被选中」是构造性的，不依赖校验兜底。
  assert.equal(space.targets["CLICK"]?.[String(MAX_ACTIONS + 60)], undefined);
});

test("没有 node 的元素动作不进候选集：身份不明的动作无法被安全引用", () => {
  const orphan: Action = { id: "e9", kind: "click", label: "无身份的按钮", role: "button" };
  const space = buildActionSpace([orphan, click(1, "正常按钮")], { mode: "interactive" });
  assert.deepEqual(Object.keys(space.targets["CLICK"] ?? {}), ["1"]);
  assert.equal(space.elements.length, 1);
});

// ---------------------------------------------------------------------------
// buildDecisionRequest
// ---------------------------------------------------------------------------

test("questions[0].key 恒为 operation，顺序固定，页面级动作与终止操作都在里面", () => {
  const actions = [...editable(1, "搜索", ""), click(2, "提交"), SCROLL_DOWN, WAIT];
  const space = buildActionSpace(actions, { mode: "interactive" });
  const request = buildDecisionRequest({
    caseDef: mkCase(),
    page: observation(actions),
    space,
    history: [],
    budget: budgetView(),
  });

  assert.equal(request.questions[0]?.key, "operation");
  // 顺序固定：报告与提示词才可比（CLICK / TYPE_TEXT / SELECT → 页面级 → 终止）。
  assert.deepEqual(optionIds(request.questions[0] as Question), [
    "CLICK",
    "TYPE_TEXT",
    "SCROLL_DOWN",
    "WAIT",
    "DONE",
    "BLOCKED",
  ]);
  assert.deepEqual(
    request.questions.map((question) => question.key),
    ["operation", targetQuestionKey("CLICK"), targetQuestionKey("TYPE_TEXT")],
  );
  assert.equal(targetQuestionKey("TYPE_TEXT"), "type_text_target");
  assert.equal(targetQuestionKey("SELECT"), "select_target");
});

test("每个 target head 只含兼容元素", () => {
  const actions = [
    click(1, "首页", "link"),
    ...editable(2, "搜索", ""),
    selectOption(3, "国家", "中国", "CN"),
    SCROLL_DOWN,
    WAIT,
  ];
  const space = buildActionSpace(actions, { mode: "interactive" });
  const request = buildDecisionRequest({
    caseDef: mkCase(),
    page: observation(actions),
    space,
    history: [],
    budget: budgetView(),
  });

  const byKey = new Map(request.questions.map((question) => [question.key, question]));
  // 键集合与动作空间的候选集完全同源：校验与提问共用 buildQuestions，
  // 两份候选集一旦分叉，模型会选出「我们刚发给它、却被判非法」的选项。
  assert.deepEqual(optionIds(byKey.get("click_target") as Question), ["1", "2"]);
  assert.deepEqual(optionIds(byKey.get("type_text_target") as Question), ["2"]);
  assert.deepEqual(optionIds(byKey.get("select_target") as Question), ["3:1"]);

  // 每个 head 里每一项的 action.kind 必须与 head 匹配——这是「从源头杜绝
  // 模型选了个输入框去点击」那条（architecture.md §3.1）。
  for (const [key, kind] of [
    ["click_target", "click"],
    ["type_text_target", "fill"],
    ["select_target", "select"],
  ] as const) {
    const head = space.targets[key.replace("_target", "").toUpperCase()] ?? {};
    for (const id of optionIds(byKey.get(key) as Question)) {
      assert.equal(head[id]?.kind, kind, `${key} 的候选 ${id} 不是 ${kind} 动作`);
    }
  }
  // 反例：可编辑元素的 companion click（「Open 搜索」）**可以**出现在 click_target 里
  // （上游靠它点开日期选择器），但下拉绝不出现在 click_target 里。
  assert.equal(optionIds(byKey.get("click_target") as Question).includes("3"), false);
  assert.equal(optionIds(byKey.get("type_text_target") as Question).includes("1"), false);
});

test("没有候选目标的 head 不提供该操作", () => {
  const actions = [click(1, "首页", "link")];
  const space = buildActionSpace(actions, { mode: "interactive" });
  const request = buildDecisionRequest({
    caseDef: mkCase(),
    page: observation(actions),
    space,
    history: [],
    budget: budgetView(),
  });
  const keys = request.questions.map((question) => question.key);
  // 发一张空头支票会让模型选中一个必然解析失败的操作，把运行判成 error。
  assert.equal(keys.includes("type_text_target"), false);
  assert.equal(keys.includes("select_target"), false);
  assert.equal(keys.includes("click_target"), true);
});

test("recentActions 取最后 10 条且保持时间顺序", () => {
  const actions = [click(1, "首页", "link")];
  const history = Array.from({ length: 25 }, (_, index) => step(index + 1));
  const request = buildDecisionRequest({
    caseDef: mkCase(),
    page: observation(actions),
    space: buildActionSpace(actions, { mode: "interactive" }),
    history,
    budget: budgetView(),
  });

  assert.equal(request.state.recentActions.length, 10);
  assert.deepEqual(
    request.state.recentActions.map((recent) => recent.action),
    ["动作16", "动作17", "动作18", "动作19", "动作20", "动作21", "动作22", "动作23", "动作24", "动作25"],
  );
});

test("goal、rules、omittedActions、budget 原样带上；omittedActions 口径来自观测", () => {
  const actions = [click(1, "首页", "link")];
  const request = buildDecisionRequest({
    caseDef: mkCase({ goal: "查到那本书的出版年份" }),
    page: observation(actions, { omittedActions: 12 }),
    space: buildActionSpace(actions, { mode: "interactive" }),
    history: [],
    budget: budgetView(),
  });

  assert.equal(request.goal, "查到那本书的出版年份");
  // budget 原样带上：引擎据此自行裁剪上下文，runner 不必猜它还剩多少额度。
  assert.deepEqual(request.budget, budgetView());
  // snapshot.js 在裁剪到 250 之后算出这个数（`snapshot.js:137`），policy 只透传。
  assert.equal(request.state.omittedActions, 12);
  assert.equal(request.rules.length, 1);
  assert.equal(request.state.elements.length, 1);
});

test("断言绝不进请求：goal / rules / state / questions / budget 五个字段都不含断言内容", () => {
  const marker = "ASSERTION-SECRET-9f3a";
  const caseDef = mkCase({
    goal: "把这件事做完",
    assertions: {
      final: { url: { contains: [marker] }, text: { contains: [marker] } },
      trajectory: { mustUse: [{ labelContains: marker }], mustNotUse: [{ labelContains: marker }] },
      quality: { minTargetProbability: 0.3 },
    },
  });
  // 先证明标记确实在用例里——否则下面的断言会「因为压根没有标记」而空洞地通过。
  assert.ok(JSON.stringify(caseDef).includes(marker));

  const actions = [click(1, "首页", "link")];
  const request = buildDecisionRequest({
    caseDef,
    page: observation(actions),
    space: buildActionSpace(actions, { mode: "interactive" }),
    history: [],
    budget: budgetView(),
  });

  // 让 agent 看见判分标准会诱导它对着答案演戏（development.md §5.7），
  // 也会破坏策略的通用性——上游的 goal 与 verify() 是完全解耦的两件事。
  assert.equal(JSON.stringify(request.goal).includes(marker), false);
  assert.equal(JSON.stringify(request.rules).includes(marker), false);
  assert.equal(JSON.stringify(request.state).includes(marker), false);
  assert.equal(JSON.stringify(request.questions).includes(marker), false);
  assert.equal(JSON.stringify(request.budget).includes(marker), false);
  assert.equal(JSON.stringify(request).includes(marker), false);
});

// ---------------------------------------------------------------------------
// resolveDecision
// ---------------------------------------------------------------------------

/** 只含一个 click 目标的动作空间：operation 候选恰好是 CLICK / DONE / BLOCKED。 */
function clickSpace(): ReturnType<typeof buildActionSpace> {
  return buildActionSpace([click(1, "提交")], { mode: "interactive" });
}

const FULL_OPERATION = { CLICK: 0.8, DONE: 0.1, BLOCKED: 0.1 };

function answer(key: string, choice: string, probabilities?: Record<string, number>, confidence = 0.9): Answer {
  return {
    key,
    choice,
    probabilities: probabilities ?? { [choice]: 1 },
    distribution: probabilities === undefined ? "degenerate" : "full",
    confidence,
  };
}

function decision(answers: Record<string, unknown>): DecisionResult {
  return {
    // 引擎的回答只保证「形状像个对象」：scripted 引擎会把脚本里的东西原样送出
    // （`scripted.ts:220`），所以类型上必须放宽——这里要测的正是**非法**输入。
    answers: answers as unknown as Record<string, Answer>,
    usage: { inputTokens: 1, outputTokens: 1, costUsd: null, requests: 1 },
    latencyMs: 1,
    engine: "test",
    raw: null,
  };
}

test("正常路径：映射回真实 Action，且是动作空间里那一个对象", () => {
  const space = clickSpace();
  const resolved = resolveDecision(
    space,
    decision({
      operation: answer("operation", "CLICK", FULL_OPERATION, 0.9),
      click_target: answer("click_target", "1", { "1": 1 }, 0.7),
    }),
  );

  // 执行层只认这个对象，模型输出到此为止不再有影响力。
  assert.equal(resolved.action, space.targets["CLICK"]?.["1"]);
  assert.equal(resolved.action.label, "提交");
  assert.equal(resolved.operation, "CLICK");
  assert.equal(resolved.target, "1");
  assert.equal(resolved.probability, 1);
  assert.equal(resolved.operationProbability, 0.8);
  // 保守取小：任一处犹豫都该被看见。
  assert.equal(resolved.confidence, 0.7);
});

test("未被选中的 target head 非法不影响执行（这是安全性质，不是容错）", () => {
  const space = clickSpace();
  const resolved = resolveDecision(
    space,
    decision({
      operation: answer("operation", "CLICK", FULL_OPERATION),
      click_target: answer("click_target", "1", { "1": 1 }),
      // 下面这些 head 与本次操作无关，上游 `model.py:127` 的注释就是这个意思：
      // 一次无关 head 的乱答不该让整步失败（否则一个引擎的坏习惯会让所有运行报错），
      // 更不该被拿来推断任何东西。
      type_text_target: { choice: "不存在的目标", probabilities: { 乱: Number.NaN } },
      select_target: 42,
      scroll_up_target: null,
    }),
  );
  assert.equal(resolved.target, "1");
  assert.equal(resolved.action, space.targets["CLICK"]?.["1"]);
});

test("被选中操作的 target head 非法则抛 InvalidDecision，绝不返回半个结果", () => {
  const space = clickSpace();
  assert.throws(
    () =>
      resolveDecision(
        space,
        decision({
          operation: answer("operation", "CLICK", FULL_OPERATION),
          click_target: { choice: "99" },
        }),
      ),
    InvalidDecision,
  );
});

test("决策结果里没有 operation 回答时抛 InvalidDecision 并列出实际键", () => {
  const space = clickSpace();
  assert.throws(
    () => resolveDecision(space, decision({ click_target: answer("click_target", "1", { "1": 1 }) })),
    (error: unknown) => {
      assert.ok(error instanceof InvalidDecision);
      assert.match(error.message, /没有 "operation" 的回答/);
      assert.match(error.message, /click_target/, "错误信息要带上实际收到了哪些键");
      return true;
    },
  );
});

test("operation 的 choice 不在候选集内时抛 InvalidDecision", () => {
  const space = clickSpace();
  assert.throws(
    () =>
      resolveDecision(
        space,
        decision({
          operation: answer("operation", "SELECT", { SELECT: 1 }),
          select_target: answer("select_target", "1:1", { "1:1": 1 }),
        }),
      ),
    InvalidDecision,
  );
});

test("终止操作：target 为 null，哨兵动作不产生任何变更", () => {
  const space = clickSpace();
  const resolved = resolveDecision(
    space,
    decision({
      operation: answer("operation", "DONE", { CLICK: 0.1, DONE: 0.8, BLOCKED: 0.1 }, 0.95),
      // 终止路径根本不读 target head：给它一堆垃圾也不该被消费。
      click_target: "完全不是对象",
    }),
  );

  assert.equal(isTerminal(resolved.operation), true);
  assert.equal(resolved.target, null);
  // DONE/BLOCKED 没有真实动作对象，而 Resolved.action 是必填字段（冻结契约）。
  // 哨兵取 wait——所有动作种类里唯一不产生变更的，万一被误交给 act() 最坏只是白等。
  assert.equal(resolved.action.kind, "wait");
  assert.equal(resolved.action.id, "done");
  // 概率回填 operation 的概率而不是 0：0 会被读成「极其不确定」。
  assert.equal(resolved.probability, 0.8);
  assert.equal(isTerminal("BLOCKED"), true);
  assert.equal(isTerminal("CLICK"), false);
});

test("页面级操作：动作取自 controls，无目标", () => {
  const space = buildActionSpace([click(1, "提交"), SCROLL_DOWN, WAIT], { mode: "interactive" });
  const resolved = resolveDecision(
    space,
    decision({ operation: answer("operation", "SCROLL_DOWN", { CLICK: 0.2, SCROLL_DOWN: 0.5, WAIT: 0.1, DONE: 0.1, BLOCKED: 0.1 }) }),
  );
  assert.equal(resolved.action, space.controls["SCROLL_DOWN"]);
  assert.equal(resolved.target, null);
  assert.equal(resolved.action.delta, 560);
});

test("整步 distribution 只有两个 head 都是真分布时才算 full", () => {
  // target 侧要有两个候选，「真分布」才有意义：只有一个候选时，唯一的合法概率表
  // 就是 {唯一选项: 1}，与合成的 one-hot 无法区分，按「降级安全、升级不安全」标 degenerate。
  const space = buildActionSpace([click(1, "提交"), click(2, "取消")], { mode: "interactive" });

  const full = resolveDecision(
    space,
    decision({
      operation: answer("operation", "CLICK", FULL_OPERATION, 0.9),
      click_target: answer("click_target", "1", { "1": 0.9, "2": 0.1 }, 0.8),
    }),
  );
  assert.equal(full.distribution, "full");
  assert.equal(full.probability, 0.9);
  assert.equal(full.confidence, 0.8);

  // 假通过最常发生在 **target 侧**（architecture.md §11.1②）：某个 head 是合成的
  // one-hot 时，概率类断言必须变成 skipped，而不是拿 1.0 去比 minTargetProbability。
  const half = resolveDecision(
    space,
    decision({
      operation: answer("operation", "CLICK", FULL_OPERATION, 0.9),
      click_target: answer("click_target", "1"),
    }),
  );
  assert.equal(half.distribution, "degenerate");
  assert.equal(half.probability, 1, "degenerate 的 one-hot 仍是 1，但标签必须说清它是合成的");
});

test("target 的 choice 必须落在该操作的候选集里", () => {
  const space = buildActionSpace([click(1, "提交"), click(2, "取消")], { mode: "interactive" });
  const resolved = resolveDecision(
    space,
    decision({
      operation: answer("operation", "CLICK", FULL_OPERATION),
      click_target: answer("click_target", "2", { "1": 0, "2": 1 }),
    }),
  );
  assert.equal(resolved.target, "2");
  assert.equal(resolved.action, space.targets["CLICK"]?.["2"]);
});

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

function budgetView(): DecisionRequestBudget {
  return {
    stepsUsed: 3,
    maxSteps: 40,
    modelCallsUsed: 3,
    maxModelCalls: 40,
    inputTokensUsed: 1234,
    maxInputTokens: 200000,
    elapsedMs: 1500,
    maxElapsedMs: 300000,
  };
}

type DecisionRequestBudget = Parameters<typeof buildDecisionRequest>[0]["budget"];

/**
 * 从动作空间反推出某个问题（提问与校验共用 buildQuestions，所以只能这样拿问题对象）。
 *
 * 直接构造 `Question` 字面量在这里不够——本文件要验证的恰恰是
 * 「提问与校验用的是同一份候选集」，自己拼一份就成了自证。
 */
function questionOf(space: ReturnType<typeof buildActionSpace>, key: string): Question {
  const { questions } = buildDecisionRequest({
    caseDef: mkCase(),
    page: observation([]),
    space,
    history: [],
    budget: budgetView(),
  });
  const found = questions.find((question) => question.key === key);
  assert.ok(found !== undefined, `动作空间里没有 "${key}" 问题`);
  return found;
}

// ---------------------------------------------------------------------------
// overrideWeakBlocked：BLOCKED 要过半才结束运行
// ---------------------------------------------------------------------------

/** click + 滚动 + 等待都在：operation 候选是 CLICK / SCROLL_UP / SCROLL_DOWN / WAIT / DONE / BLOCKED */
function richSpace(): ReturnType<typeof buildActionSpace> {
  return buildActionSpace([click(1, "批量导入产品库"), click(2, "导入设置"), SCROLL_UP, SCROLL_DOWN, WAIT], {
    mode: "interactive",
  });
}

function weakBlocked(blocked: number, rest: Record<string, number>, extra: Record<string, unknown> = {}): DecisionResult {
  return decision({
    operation: answer("operation", "BLOCKED", { BLOCKED: blocked, ...rest }, blocked),
    click_target: answer("click_target", "2", { "1": 0.3, "2": 0.7 }, 0.7),
    ...extra,
  });
}

test("BLOCKED 没过半：改走概率最大的非终止操作，目标用该 head 自己的选择（实测那次：0.46 / 0.35）", () => {
  const space = richSpace();
  const result = weakBlocked(0.46, { CLICK: 0.35, SCROLL_UP: 0.02, SCROLL_DOWN: 0.15, WAIT: 0.01, DONE: 0.01 });
  const decided = resolveDecision(space, result);
  assert.equal(decided.operation, "BLOCKED");

  const override = overrideWeakBlocked(space, result, decided);
  assert.ok(override !== null);
  assert.equal(override.operation, "CLICK");
  assert.equal(override.target, "2");
  assert.equal(override.action, space.targets["CLICK"]?.["2"], "动作必须是动作空间里那一个对象");
  // 如实记录：这一步是在 0.35 的把握下走的，不是模型说的 0.46
  assert.equal(override.operationProbability, 0.35);
  assert.equal(override.confidence, 0.35);
});

test("BLOCKED 过半：照常结束，不替换", () => {
  const space = richSpace();
  const result = weakBlocked(0.58, { CLICK: 0.3, SCROLL_UP: 0.02, SCROLL_DOWN: 0.08, WAIT: 0.01, DONE: 0.01 });
  assert.equal(overrideWeakBlocked(space, result, resolveDecision(space, result)), null);
});

test("非终止操作里最大的是页面级操作：改走它（没有目标）", () => {
  const space = richSpace();
  const result = weakBlocked(0.4, { CLICK: 0.1, SCROLL_UP: 0.05, SCROLL_DOWN: 0.3, WAIT: 0.14, DONE: 0.01 });
  const override = overrideWeakBlocked(space, result, resolveDecision(space, result));
  assert.equal(override?.operation, "SCROLL_DOWN");
  assert.equal(override?.target, null);
  assert.equal(override?.action, space.controls["SCROLL_DOWN"]);
});

test("DONE 不受影响：它的对错由断言判，不需要这道闸", () => {
  const space = richSpace();
  const result = decision({
    operation: answer("operation", "DONE", { DONE: 0.4, CLICK: 0.35, SCROLL_UP: 0.05, SCROLL_DOWN: 0.1, WAIT: 0.05, BLOCKED: 0.05 }),
  });
  assert.equal(overrideWeakBlocked(space, result, resolveDecision(space, result)), null);
});

test("合成分布（degenerate）没有真概率可比：不替换", () => {
  const space = richSpace();
  const result = decision({ operation: answer("operation", "BLOCKED") });
  const decided = resolveDecision(space, result);
  assert.equal(decided.distribution, "degenerate");
  assert.equal(overrideWeakBlocked(space, result, decided), null);
});

test("替换目标的 head 答坏了：不替换、也不让整步失败，照常接受 BLOCKED", () => {
  const space = richSpace();
  const result = weakBlocked(
    0.46,
    { CLICK: 0.35, SCROLL_UP: 0.02, SCROLL_DOWN: 0.15, WAIT: 0.01, DONE: 0.01 },
    { click_target: { choice: "99" } },
  );
  assert.equal(overrideWeakBlocked(space, result, resolveDecision(space, result)), null);
});
