/**
 * 策略层：动作空间构建、决策请求组装、模型输出校验与解析。
 *
 * 移植自 jev-ultrafast 的 jev_ultrafast/model.py:48-148（详见 NOTICE）。
 * 这是整个项目的安全边界所在，三条性质在此确立：
 *
 *   1. **模型只能从候选集里选。** `validateChoice` 逐条检查 choice 在候选集内、
 *      概率键集合完全匹配、概率有限且 ∈[0,1]、和与 1 的偏差 < 0.02、
 *      且 choice 确实是最大概率项。任何一条不满足就抛 InvalidDecision，
 *      **绝不执行任何动作**。模型输出永远不会变成选择器、坐标、shell 命令或可执行 JS。
 *
 *   2. **只有被选中操作的 target head 会被消费。** 其余 head 即使输出非法也不影响执行
 *      （参考项目 `model.py:127` 的注释就是这个意思）。校验顺序本身也是安全性质：
 *      先校验 operation head，再校验 `<op>_target` head，最后才映射回真实动作对象。
 *
 *   3. **只读模式在构造阶段生效。** 见 buildActionSpace——变更型操作根本不会进入候选集，
 *      模型物理上无法选中。这是「由构造提供安全」而非「事后过滤」，
 *      是参考项目「有限选择空间」这一核心机制最有价值的复用。
 */

import type { Case, CaseMode } from "../schema/case.ts";
import type { ActionKind, Operation } from "../schema/events.ts";
import type { Answer, BudgetView, DecisionRequest, DecisionResult, ElementIR, Question } from "../engine/types.ts";
import type { Action, Observation } from "../browser/session.ts";
import type { StepRecord } from "../schema/report.ts";
import { InvalidDecision } from "./errors.ts";
import { NEXT_ACTION, OPERATION_DESCRIPTIONS, TARGET } from "./rules.ts";

/** 单次观测最多保留多少候选。超出部分被丢弃且**不可被选中**。 */
export const MAX_ACTIONS = 250;

/** 发给模型的近期动作条数。参考项目取 10（`model.py:113`）。 */
export const RECENT_ACTIONS = 10;

/** 只读模式下被禁止的操作。它们不会出现在候选集里，而不是被事后拒绝。 */
export const MUTATING_OPERATIONS: readonly Operation[] = ["TYPE_TEXT", "SELECT"];

/**
 * action kind -> operation 的映射。scroll 与 wait 是页面级操作，无目标，因此不在这里。
 *
 * 它同时是 `isElementKind` 的判据（**有对应 operation 的 kind 才是元素动作**），
 * 也就是说「哪些 kind 带 node」这件事只在这一处声明。
 */
const KIND_TO_OPERATION: Record<string, Operation> = {
  click: "CLICK",
  fill: "TYPE_TEXT",
  select: "SELECT",
};

/**
 * snapshot.js 把原生下拉的 label 拼成 `元素名 + " → " + 选项名`（`snapshot.js:109`）。
 * 分隔符是**带空格的 U+2192**，抄错一个空格就再也切不开，因此单独提出来。
 */
const OPTION_SEPARATOR = " → ";

/**
 * 只读模式下被剔除的 click 角色。
 *
 * 为什么是这几个：它们是**可能产生变更**的控件——按钮会提交、勾选框/开关/单选项会改状态、
 * 下拉框会改选择、菜单项会触发命令，而 ARIA 的 `option` / `menuitemradio` /
 * `menuitemcheckbox` 与 `gridcell`（日历的日期格、表格的可选单元格）点击后**会改变
 * 被提交的值**，与勾选框同类。少列一个，只读用例就能悄悄改掉页面状态——
 * 而报告里那句「本运行不可能发生变更」就变成了假话。
 *
 * 刻意**不**剔除的：`link`（导航）、`tab`（切换可见面板，等同于导航）、
 * `textbox` / `searchbox` / `spinbutton`（点击只是聚焦，输入才是变更，而输入由
 * `fill` 那条路径管）。把它们也砍掉会让只读用例连页面都翻不动，收益是零。
 *
 * 注意这是**构造期**的剔除（docs/case-format.md §mode、D10）：被剔除的动作根本
 * 不会出现在候选集里，因此「拒绝逻辑写漏一个 case」这种失灵方式不存在。
 * 代价是只读用例点不到按钮——这是刻意的保守取舍。
 *
 * ⚠️ 改动这个清单必须同步改 `docs/case-format.md` §mode 与 `docs/architecture.md` §5.1：
 * 只读的保证写在文档里，而文档与代码不一致时，人说谎而代码不会。
 */
export const READONLY_BLOCKED_CLICK_ROLES: readonly string[] = [
  "button",
  "checkbox",
  "radio",
  "switch",
  "combobox",
  "menuitem",
  "menuitemradio",
  "menuitemcheckbox",
  "option",
  "gridcell",
];

/** 需要选目标的操作，顺序固定——问题顺序与候选顺序都按它来，报告才可比。 */
const TARGETED_OPERATIONS: readonly Operation[] = ["CLICK", "TYPE_TEXT", "SELECT"];

/** 页面级操作，无目标。 */
const PAGE_OPERATIONS: readonly Operation[] = ["SCROLL_UP", "SCROLL_DOWN", "WAIT"];

/** 终止操作，无目标，永不缺候选。 */
const TERMINAL_OPERATIONS: readonly Operation[] = ["DONE", "BLOCKED"];

/** 概率和与 1 的允许偏差。上游：`abs(sum - 1) < 0.02`。 */
const SUM_TOLERANCE = 0.02;

/** 「是最大值」的允许误差。上游：`>= max - 1e-6`。 */
const MAX_TOLERANCE = 1e-6;

export interface ActionSpace {
  elements: ElementIR[];
  /** operation -> targetIndex -> Action。targetIndex 对 select 形如 "3:1" */
  targets: Record<string, Record<string, Action>>;
  /** 页面级控件与 DONE/BLOCKED 之外的独立动作 */
  controls: Record<string, Action>;
}

export interface Resolved {
  operation: Operation;
  target: string | null;
  /** 映射回的真实动作对象。执行层只用它，不再看模型输出 */
  action: Action;
  probability: number;
  operationProbability: number;
  confidence: number;
  distribution: "full" | "degenerate";
}

/**
 * 把观测到的动作表变成带索引的元素表 + 每个操作的候选目标。
 *
 * 两点要注意：
 *   - **一个节点只拿一个索引**，即使它同时支持点击与输入（参考项目 `model.py:60`）。
 *     否则同一个输入框会以 [3] 和 [4] 两个身份出现，模型会分不清。
 *   - **原生下拉的每个 option 是独立 target**，形如 `"3:1"`。模型看到的是
 *     选项标签，回传的是索引——它从不知道 option 的 value 是什么。
 *
 * `mode: "readonly"` 时，`fill`/`select` 动作与变更型 click 在此被剔除，
 * 因此 `targets` 里**根本不会有 TYPE_TEXT / SELECT 键**。
 */
export function buildActionSpace(actions: Action[], opts: { mode: CaseMode }): ActionSpace {
  const readonly = opts.mode === "readonly";
  const drafts = new Map<number, Action[]>();
  const controls: Record<string, Action> = {};

  // snapshot.js 已经把候选裁到 250（`actions.splice(250)`），这里再裁一次是保险：
  // 候选数是**模型上下文的成本**，一个未经裁剪的 actions 数组（别的 Session 实现，
  // 或测试里手写的表）会把它悄悄撑大，而本地报告看不出来。
  // 上限只数元素动作——scroll / wait 由 snapshot 在裁剪之后追加，本就不占额度。
  let consumed = 0;
  for (const action of actions) {
    if (!isElementKind(action.kind)) {
      const key = controlKey(action);
      if (key !== null) controls[key] = action;
      continue;
    }
    if (consumed >= MAX_ACTIONS) continue;
    consumed += 1;

    const node = action.node;
    // 契约说 click / fill / select 必定带 node。缺了就无法建立 **code-owned 身份**，
    // 也就无法被安全引用：宁可让这个动作不可选中，也不要用「第几个动作」这种
    // 一改顺序就漂移的序号去冒充身份——那正是「有限选择空间」要防的东西。
    if (node === undefined) continue;

    const bucket = drafts.get(node);
    if (bucket === undefined) drafts.set(node, [action]);
    else bucket.push(action);
  }

  const elements: ElementIR[] = [];
  const targets: Record<string, Record<string, Action>> = {};
  const targetHead = (operation: Operation): Record<string, Action> => {
    const existing = targets[operation];
    if (existing !== undefined) return existing;
    const fresh: Record<string, Action> = {};
    targets[operation] = fresh;
    return fresh;
  };

  let nextIndex = 0;
  for (const bucket of drafts.values()) {
    const element = buildIndexedElement(bucket, String(nextIndex + 1), readonly, targetHead);
    // 一个什么操作都做不了的节点不进元素表：它只会占模型注意力与上下文，
    // 而模型对它的任何选择都会被 validateChoice 拒掉（它不在候选集里）。
    if (element === null) continue;
    nextIndex += 1;
    elements.push(element);
  }

  return { elements, targets, controls };
}

/**
 * 把一个节点的全部动作归并成一行元素表 + 若干候选目标。
 *
 * 索引在这里被使用（1-based）：**一个节点一个索引**，
 * 所以一个可点又可输入的输入框在 `click_target` 与 `type_text_target` 里是同一个编号，
 * 模型不会把它当成两个元素。
 *
 * 注意索引与 snapshot 的 `e1` / `e2` **只是同基、不同号**：没有可用操作的节点不占号
 * （只读模式下被剔除的节点、缺 node 的动作都不占），所以索引在可用元素上是连续的，
 * 会比 snapshot 的编号小。这是安全的——索引只在**本次候选集**内有意义，
 * 真实身份在 `Action.node` 上，模型也从不看 snapshot 的编号。
 *
 * 返回 null 表示该节点在当前模式下没有任何可用操作。
 */
function buildIndexedElement(
  bucket: Action[],
  index: string,
  readonly: boolean,
  targetHead: (operation: Operation) => Record<string, Action>,
): ElementIR | null {
  const click = bucket.find((action) => action.kind === "click");
  const fill = bucket.find((action) => action.kind === "fill");
  const selects = bucket.filter((action) => action.kind === "select");

  const clickAllowed = click !== undefined && !(readonly && blocksClickInReadonly(click));
  const fillAllowed = fill !== undefined && !readonly;
  // 原生下拉的每个未被选中的 option 都是一条 select 动作；全都被选中或禁用时为空，
  // 此时这个元素没有任何 SELECT 目标，只读模式下也就什么都不剩。
  const selectAllowed = selects.length > 0 && !readonly;

  const operations: Operation[] = [];
  if (clickAllowed) operations.push("CLICK");
  if (fillAllowed) operations.push("TYPE_TEXT");
  if (selectAllowed) operations.push("SELECT");
  if (operations.length === 0) return null;

  const role = click?.role ?? fill?.role ?? selects[0]?.role ?? "";
  const element: ElementIR = {
    index,
    label: elementLabel(bucket, fill, click),
    role,
    operations,
  };

  // 元素的当前值。**原生下拉刻意不给 value**：那是 option 的 value（`snapshot.js:108`），
  // 而「模型只知道选项标签、不知道它的值」正是这条设计的一半——它回传索引，
  // 由本地映射回真实动作。把 value 发出去等于让模型有机会按站点内部的值做推断。
  // snapshot 采集的下拉当前值（`current_value`）不在冻结的 Action 契约里，因此只能不给。
  const value = fill?.value ?? click?.value;
  if (selects.length === 0 && value !== undefined && value !== "") element.value = value;

  const checked = click?.checked ?? fill?.checked;
  if (checked !== undefined) element.checked = checked;
  const expanded = click?.expanded ?? fill?.expanded;
  if (expanded !== undefined) element.expanded = expanded;
  // aria-selected 是字符串（"true"/"false"），ElementIR.selected 是布尔——统一在这里收口。
  if (selects.some((action) => action.selected === "true") || click?.selected === "true") {
    element.selected = true;
  }

  if (clickAllowed && click !== undefined) {
    targetHead("CLICK")[index] = click;
  }
  if (fillAllowed && fill !== undefined) {
    targetHead("TYPE_TEXT")[index] = fill;
  }
  if (selectAllowed) {
    const head = targetHead("SELECT");
    // 选项编号从 1 开始，与元素索引同基：两处不同基的话，读日志的人会被数字误导。
    // 它只在**本次候选集**里有意义（snapshot 只把未选中的 option 放进来），
    // 所以它对应不到 DOM 里的 option 序号——这正是它 code-owned 的原因。
    const options: { index: string; label: string }[] = [];
    selects.forEach((action, position) => {
      const optionIndex = `${index}:${position + 1}`;
      options.push({ index: optionIndex, label: optionLabel(action.label) });
      head[optionIndex] = action;
    });
    element.options = options;
  }

  return element;
}

/**
 * 元素的可访问名。
 *
 * 两个来源要看清，否则元素表里会出现模型看不懂的名字：
 *   - 可编辑元素会额外产出一条 `label: "Open <field>"` 的 click（`snapshot.js:117`），
 *     那条描述的是「点开这个字段」，元素名在 fill 那条上——所以 fill 优先。
 *   - 原生下拉的每条动作 label 都是 `"国家 → 中国"`，元素名是分隔符**之前**的部分。
 */
function elementLabel(bucket: Action[], fill: Action | undefined, click: Action | undefined): string {
  if (fill !== undefined) return fill.label;
  const select = bucket.find((action) => action.kind === "select");
  if (select !== undefined) return fieldLabel(select.label);
  return click?.label ?? bucket[0]?.label ?? "";
}

/** 从 `"国家 → 中国"` 里取出选项名 `"中国"`。没有分隔符时原样返回。 */
function optionLabel(label: string): string {
  const position = label.indexOf(OPTION_SEPARATOR);
  return position < 0 ? label : label.slice(position + OPTION_SEPARATOR.length);
}

/**
 * 从 `"国家 → 中国"` 里取出**字段名** `"国家"`。没有分隔符时原样返回。
 *
 * 元素表那一行要的是**元素**的名字（这个下拉框叫什么），选项名属于
 * `element.options`。取错的后果很具体：一个国家下拉在元素表里会显示成
 * 「中国」，模型于是认不出这是哪个字段；更糟的是 snapshot 只把**未选中**的
 * option 放进候选集（`snapshot.js:107`），选项一改这条 label 就跟着变——
 * 「同一个元素的名字在两次观测间不变」这条直觉随之失效，模型会把它当成
 * 两个不同的元素。（`optionLabel` 取的是后半边，与这里正好互补，别抄错。）
 */
function fieldLabel(label: string): string {
  const position = label.indexOf(OPTION_SEPARATOR);
  return position < 0 ? label : label.slice(0, position);
}

/**
 * 元素动作（带 node）；scroll / wait 是页面级动作，进 `controls`。
 *
 * 判据取自 `KIND_TO_OPERATION`：**带目标的动作种类恰好就是有对应 operation 的那些**。
 * 写成一串字面量比较的话，将来加一种元素动作（例如上传）要改两处，
 * 漏改的那一处会把新动作静默丢出候选集。
 */
function isElementKind(kind: ActionKind): boolean {
  return KIND_TO_OPERATION[kind] !== undefined;
}

/** 页面级动作 -> controls 的键。id 是 snapshot 固定的 `scroll_down` / `scroll_up` / `wait`。 */
function controlKey(action: Action): string | null {
  if (action.kind === "wait") return "WAIT";
  if (action.kind !== "scroll") return null;
  if (action.id === "scroll_up") return "SCROLL_UP";
  if (action.id === "scroll_down") return "SCROLL_DOWN";
  // id 是契约（snapshot.js:140-142 写死），delta 只作兜底：将来若有人换了 id 命名，
  // 靠方向仍能认出上滚 / 下滚，而不是把两个滚动动作都丢掉。
  if (action.delta !== undefined) return action.delta < 0 ? "SCROLL_UP" : "SCROLL_DOWN";
  return null;
}

/** 只读模式下这个 click 是否属于「可能产生变更」的那一类。 */
function blocksClickInReadonly(action: Action): boolean {
  return READONLY_BLOCKED_CLICK_ROLES.includes((action.role ?? "").toLowerCase());
}

/** 组装一次决策请求。断言不参与其中（见 rules.ts 的说明）。 */
export function buildDecisionRequest(input: {
  caseDef: Case;
  page: Observation;
  space: ActionSpace;
  history: StepRecord[];
  budget: BudgetView;
}): DecisionRequest {
  const { caseDef, page, space, history, budget } = input;
  return {
    // goal 是唯一的行为指令。这里**刻意不读 caseDef.assertions**：
    // 断言进 prompt 会诱导模型对着答案演戏（development.md §5.7），
    // 而且判分标准一旦泄漏，策略就不再通用——上游的 goal 与 verify() 是解耦的两件事。
    goal: caseDef.goal,
    rules: [NEXT_ACTION],
    state: {
      url: page.url,
      title: page.title,
      text: page.text,
      textTruncated: page.textTruncated,
      elements: space.elements,
      recentActions: history.slice(-RECENT_ACTIONS).map((step) => ({
        action: step.action,
        kind: step.kind,
        text: step.text,
        pageChanged: step.pageChanged,
      })),
      omittedActions: page.omittedActions,
    },
    // budget 原样带上：引擎据此自行裁剪上下文，runner 不必猜它还剩多少额度。
    questions: buildQuestions(space),
    budget,
  };
}

/** 问题的 key。operation 恒为 `"operation"`，其余为 `<operation>_target` 小写。 */
export function targetQuestionKey(operation: Operation): string {
  return `${operation.toLowerCase()}_target`;
}

/**
 * 组装这一次要问的全部问题。
 *
 * **提问与校验共用这一个函数**，不是巧合：候选集必须只有一个事实来源。
 * 若校验时另算一份，两份候选集迟早分叉——分叉的表现是「模型选了一个我们刚刚才发给它的
 * 选项，却被判非法」，或者更糟：模型选中了本地校验认为合法、而它从没见过的目标。
 */
function buildQuestions(space: ActionSpace): Question[] {
  const operations = usableOperations(space);
  const questions: Question[] = [
    {
      key: "operation",
      // 上游把同一份 NEXT_ACTION 规则同时传给操作问题与目标问题（`model.py:92,105`）。
      prompt: NEXT_ACTION,
      options: operations.map((operation) => ({
        id: operation,
        // 候选的 label 就是**发给模型的操作说明**：上游把 `criteria` 做成
        // 「操作 id → 一句英文说明」。只给一个 `CLICK` 而让模型自己去猜它包含什么，
        // 是这个形状最容易退化的一处（见 rules.ts 的 OPERATION_DESCRIPTIONS）。
        // 页面级操作用控件自己的标签——snapshot.js 给的本来就是英文。
        label: OPERATION_DESCRIPTIONS[operation] ?? space.controls[operation]?.label ?? operation,
        detail: {},
      })),
    },
  ];

  for (const operation of operations) {
    const candidates = space.targets[operation];
    if (candidates === undefined) continue;
    const ids = Object.keys(candidates);
    if (ids.length === 0) continue;
    questions.push({
      key: targetQuestionKey(operation),
      // target 问题读不到 operation 的答案（各问题独立求解，换来一次往返），
      // 所以前提必须显式写明「假如下一步是这个操作」——TARGET 的最后一句就是为它写的。
      prompt: TARGET,
      options: ids.map((id) => {
        const action = candidates[id];
        // 键就来自 ids，取不到只可能是并发改动；跳过而不是编一个假目标。
        if (action === undefined) return { id, label: `[${id}]`, detail: {} };
        const label = `[${id}] ${action.role ?? ""} ${action.label}`.replace(/\s+/g, " ").trim();
        return { id, label, detail: targetDetail(action) };
      }),
    });
  }

  return questions;
}

/**
 * 供模型判断的附加属性。
 *
 * **select 动作的 `value` 绝不外泄**：那是 option 的 value（`snapshot.js:108`），
 * 而「模型只知道选项标签、不知道它的值」正是这条设计的一半——它回传索引，
 * 由本地映射回真实动作。把 value 写进 detail 等于让模型有机会按站点内部的值做推断，
 * 也让「按索引选」这条约束形同虚设。
 */
function targetDetail(action: Action): Record<string, unknown> {
  const detail: Record<string, unknown> = { kind: action.kind };
  if (action.role !== undefined) detail["role"] = action.role;
  if (action.kind !== "select" && action.value !== undefined && action.value !== "") {
    detail["value"] = action.value;
  }
  if (action.checked !== undefined) detail["checked"] = action.checked;
  if (action.selected !== undefined) detail["selected"] = action.selected;
  if (action.expanded !== undefined) detail["expanded"] = action.expanded;
  return detail;
}

/** 当前动作空间里可用的操作。顺序固定，报告与提示词才稳定。 */
function usableOperations(space: ActionSpace): Operation[] {
  const operations: Operation[] = [];
  for (const operation of TARGETED_OPERATIONS) {
    const candidates = space.targets[operation];
    // 没有候选目标的头不提供。否则模型可以选中一个**必然解析失败**的操作，
    // 一次本可避免的 InvalidDecision 会把整次运行判成 error——
    // 那既不是用例的问题，也不是模型的问题，纯粹是我们发了张空头支票。
    if (candidates !== undefined && Object.keys(candidates).length > 0) operations.push(operation);
  }
  for (const operation of PAGE_OPERATIONS) {
    if (space.controls[operation] !== undefined) operations.push(operation);
  }
  operations.push(...TERMINAL_OPERATIONS);
  return operations;
}

/**
 * 校验一个回答。
 *
 * 逐条保留参考项目 `model.py:30-45` 的判据，**顺序也不要改**——
 * 先在最小代价处失败，能在错误信息里给出更准确的原因。
 *
 * `distribution` 的判定（上游没有，本项目新增）：
 *   - 概率键集合与候选集完全一致且和 ≈1 → `"full"`，这是真实分布；
 *   - 只给出一个候选（或压根没给 probabilities）→ 合成覆盖**完整候选集**的 one-hot，
 *     标为 `"degenerate"` 而**不是直接判非法**。通用 LLM 引擎只回一个选择，
 *     若判非法它们就完全不可用；标 degenerate 则让概率类断言变成 skipped，
 *     既不假通过也不冤枉引擎（见 architecture.md §5.3）；
 *   - 引擎自报 `degenerate` 时保持 `degenerate`：降级是安全的，升级不是——
 *     把合成的 one-hot 当真实分布，`minTargetProbability: 0.3` 会**假通过**。
 */
export function validateChoice(answer: unknown, options: Question): Answer {
  const key = options.key;
  const ids = options.options.map((option) => option.id);
  const idSet = new Set(ids);

  if (!isPlainObject(answer)) {
    throw new InvalidDecision(`回答 "${key}" 不是对象：${preview(answer)}`);
  }
  const raw = answer;

  // 判据 ①：choice 必须在候选集内。这是最先失败、也最该先说清的一条——
  // 模型回了一个不存在的 id（幻觉，或把索引抄错）时，报告要能直接指出它选了谁。
  const choice = raw["choice"];
  if (typeof choice !== "string" || !idSet.has(choice)) {
    throw new InvalidDecision(
      `回答 "${key}" 的 choice 不在候选集内：${preview(choice)}（候选：${ids.join(", ") || "（空）"}）`,
    );
  }

  const probabilities = raw["probabilities"];
  const probabilityKeys = isPlainObject(probabilities) ? Object.keys(probabilities) : [];
  const singleCandidate =
    probabilities === undefined ||
    probabilities === null ||
    (isPlainObject(probabilities) && probabilityKeys.length === 1 && probabilityKeys[0] === choice);
  const degenerate = singleCandidate || raw["distribution"] === "degenerate";

  const table: Record<string, number> = {};
  let distribution: Answer["distribution"];
  let confidence: number | null;

  if (degenerate) {
    // 单点回答：one-hot 覆盖**完整候选集**，而不是只留那一个键。
    // 消费方（checks.ts 按 id 取概率）因此永远不必处理 undefined——
    // 稀疏的概率表会把「没给概率」和「概率是 0」混成同一件事。
    for (const id of ids) table[id] = id === choice ? 1 : 0;
    distribution = "degenerate";
    // one-hot 的置信度就是 1：这是「合成分布」的定义，不是模型真的那么确定。
    confidence = readConfidence(raw["confidence"], key) ?? 1;
  } else {
    if (!isPlainObject(probabilities)) {
      throw new InvalidDecision(`回答 "${key}" 的 probabilities 必须是对象：${preview(probabilities)}`);
    }

    // 判据 ②：键集合完全匹配。缺键会让消费方取到 undefined，多键说明引擎在自说自话。
    const missing = ids.filter((id) => !Object.prototype.hasOwnProperty.call(probabilities, id));
    const extra = probabilityKeys.filter((id) => !idSet.has(id));
    if (missing.length > 0 || extra.length > 0) {
      throw new InvalidDecision(
        `回答 "${key}" 的概率键集合与候选集不一致：缺 [${missing.join(", ")}]，多 [${extra.join(", ")}]` +
          `（候选：${ids.join(", ")}）`,
      );
    }

    // 判据 ③：每项有限且 ∈[0,1]。NaN 必须在这里被拦下——它与任何数比较都是 false，
    // 会让下面两条判据「静默通过」，是典型的看起来像数字却不是数字的输入。
    let sum = 0;
    let maxValue = Number.NEGATIVE_INFINITY;
    let maxId = "";
    let choiceValue = 0;
    for (const id of ids) {
      const value = probabilities[id];
      if (typeof value !== "number" || !Number.isFinite(value)) {
        throw new InvalidDecision(`回答 "${key}" 的概率 "${id}" 不是有限数：${preview(value)}`);
      }
      if (value < 0 || value > 1) {
        throw new InvalidDecision(`回答 "${key}" 的概率 "${id}" 不在 [0,1] 内：${value}`);
      }
      table[id] = value;
      sum += value;
      if (value > maxValue) {
        maxValue = value;
        maxId = id;
      }
      if (id === choice) choiceValue = value;
    }

    // 判据 ④：和为 1（容差 0.02）。
    if (Math.abs(sum - 1) >= SUM_TOLERANCE) {
      throw new InvalidDecision(`回答 "${key}" 的概率和为 ${round(sum)}，与 1 的偏差超过 ${SUM_TOLERANCE}`);
    }

    // 判据 ⑤：choice 必须是最大概率项。上游用的是 `>= max - 1e-6`（允许并列）。
    if (choiceValue < maxValue - MAX_TOLERANCE) {
      throw new InvalidDecision(
        `回答 "${key}" 的 choice "${choice}" 不是最大概率项：它 ${round(choiceValue)}，` +
          `最大是 "${maxId}" 的 ${round(maxValue)}`,
      );
    }

    distribution = "full";
    confidence = readConfidence(raw["confidence"], key) ?? choiceValue;
  }

  return { key, choice, probabilities: table, distribution, confidence };
}

/**
 * 读取 confidence。缺失时返回 null 由调用处取概率兜底，**存在但非法则报错**。
 *
 * 为什么不静默兜底：`Answer.confidence` 是必填的 number 字段，报告直接展示它。
 * 把一个 `"0.9"` 或 `NaN` 悄悄换成一个数，等于让报告写上一个模型没说过的数字。
 */
function readConfidence(value: unknown, key: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new InvalidDecision(`回答 "${key}" 的 confidence 必须是 [0,1] 内的有限数：${preview(value)}`);
  }
  return value;
}

/**
 * 把引擎的回答变成可执行的动作。
 *
 * 三步，顺序即安全性质：校验 operation head -> 只校验被选中操作的 target head
 * -> 映射回真实 Action。最后一步之后模型输出就不再有影响力了。
 */
export function resolveDecision(space: ActionSpace, decision: DecisionResult): Resolved {
  const questions = buildQuestions(space);
  const operationQuestion = questions.find((question) => question.key === "operation");
  if (operationQuestion === undefined) {
    // 不可达：usableOperations 永远会给出 DONE / BLOCKED。
    throw new InvalidDecision("动作空间里没有 operation 问题：候选集为空");
  }

  // 第 ① 步：校验 operation head。
  const rawOperationAnswer = decision.answers["operation"];
  if (rawOperationAnswer === undefined) {
    const keys = Object.keys(decision.answers).join(", ") || "（空）";
    throw new InvalidDecision(`决策结果里没有 "operation" 的回答（实际只有：${keys}）`);
  }
  const operationAnswer = validateChoice(rawOperationAnswer, operationQuestion);
  // 候选集只由 Operation 字面量构成（usableOperations），因此这个收窄是可靠的。
  const operation = operationAnswer.choice as Operation;
  return resolveOperation(space, questions, decision, operationAnswer, operation, operationAnswer.confidence);
}

/**
 * 「BLOCKED（放弃）」至少要有这么大的概率，才结束运行。
 *
 * BLOCKED 是不可逆的：它直接结束运行，而别的操作走错了一步，下一步还能纠正。
 * 所以对它不能只看「是不是最大项」，还要看是不是**过半**。
 * 实测一次真跑：页面加载完之后，模型给 BLOCKED 0.46、CLICK 0.35、TYPE_TEXT 0.15——
 * 超过一半的概率认为「还能动」，却因为 BLOCKED 单项最大而结束了整个运行。
 */
export const BLOCKED_MIN_PROBABILITY = 0.5;

/**
 * 一次运行里最多替换几次「没过半的 BLOCKED」。
 * 真卡死的页面上模型会一直这样犹豫；次数用完之后照常接受 BLOCKED，
 * 不让它靠替换出来的动作一直耗到预算上限。
 */
export const MAX_WEAK_BLOCKED_OVERRIDES = 3;

/**
 * BLOCKED 没过半时，改走概率最大的**非终止**操作（及其目标 head 的选择）。
 * 返回 `null` = 不替换，照常接受这个 BLOCKED：
 *   - 不是 BLOCKED，或它已过半；
 *   - 分布是合成的（degenerate）：没有真概率可比；
 *   - 替换目标的回答不可用（该 head 缺失或不合法）。只校验被选中的 head 是
 *     resolveDecision 的纪律，一个没被选中的 head 答坏了，不该让整步失败。
 *
 * 替换后的 `operationProbability` / `confidence` 如实是那个操作自己的概率（比如 0.35），
 * 报告里看得出这一步是在低把握下走的。
 */
export function overrideWeakBlocked(
  space: ActionSpace,
  decision: DecisionResult,
  resolved: Resolved,
): Resolved | null {
  if (resolved.operation !== "BLOCKED" || resolved.distribution !== "full") return null;
  if (resolved.operationProbability >= BLOCKED_MIN_PROBABILITY) return null;

  const questions = buildQuestions(space);
  const operationQuestion = questions.find((question) => question.key === "operation");
  const rawOperationAnswer = decision.answers["operation"];
  if (operationQuestion === undefined || rawOperationAnswer === undefined) return null;
  const operationAnswer = validateChoice(rawOperationAnswer, operationQuestion);

  let best: Operation | null = null;
  for (const option of operationQuestion.options) {
    const candidate = option.id as Operation;
    if (isTerminal(candidate)) continue;
    if (best === null || probabilityOf(operationAnswer, candidate) > probabilityOf(operationAnswer, best)) {
      best = candidate;
    }
  }
  if (best === null || probabilityOf(operationAnswer, best) <= 0) return null;

  try {
    return resolveOperation(space, questions, decision, operationAnswer, best, probabilityOf(operationAnswer, best));
  } catch (error) {
    if (error instanceof InvalidDecision) return null;
    throw error;
  }
}

/** 已选定 `operation` 之后的解析：终止 / 页面级 / 带目标三种，见 resolveDecision */
function resolveOperation(
  space: ActionSpace,
  questions: Question[],
  decision: DecisionResult,
  operationAnswer: Answer,
  operation: Operation,
  operationConfidence: number,
): Resolved {
  const operationProbability = probabilityOf(operationAnswer, operation);

  if (isTerminal(operation)) {
    return {
      operation,
      target: null,
      action: terminalAction(operation),
      // DONE / BLOCKED 没有目标概率，这里回填 operation 的概率而不是 0：
      // 0 会被读成「极其不确定」，而实际发生的是「模型很确定要结束」。
      // 概率断言不会误用它——checks 要求 `target != null` 才算目标概率。
      probability: operationProbability,
      operationProbability,
      confidence: operationConfidence,
      distribution: operationAnswer.distribution,
    };
  }

  if (!TARGETED_OPERATIONS.includes(operation)) {
    // 页面级操作：SCROLL_UP / SCROLL_DOWN / WAIT。它们没有目标，动作就在 controls 里。
    const action = space.controls[operation];
    if (action === undefined) {
      throw new InvalidDecision(`操作 ${operation} 在当前动作空间里没有对应的控件`);
    }
    return {
      operation,
      target: null,
      action,
      probability: operationProbability,
      operationProbability,
      confidence: operationConfidence,
      distribution: operationAnswer.distribution,
    };
  }

  // 第 ② 步：**只**校验被选中操作的 target head。
  // 别的 head（例如 operation 选了 CLICK 而 `select_target` 输出了一堆垃圾）根本不读，
  // 这正是上游 `model.py:127` 那条注释的意思：一次无关 head 的乱答不该让整步失败，
  // 也不该被拿来推断任何东西。
  const targetKey = targetQuestionKey(operation);
  const targetQuestion = questions.find((question) => question.key === targetKey);
  if (targetQuestion === undefined) {
    throw new InvalidDecision(`操作是 ${operation}，但动作空间里没有 "${targetKey}" 问题`);
  }
  const rawTargetAnswer = decision.answers[targetKey];
  if (rawTargetAnswer === undefined) {
    throw new InvalidDecision(`操作是 ${operation}，但决策结果里没有 "${targetKey}" 的回答`);
  }
  const targetAnswer = validateChoice(rawTargetAnswer, targetQuestion);
  const chosenTarget = targetAnswer.choice;

  // 第 ③ 步：映射回真实 Action。此后执行层只认这个对象。
  const action = space.targets[operation]?.[chosenTarget];
  if (action === undefined) {
    // 不可达：validateChoice 刚保证过 choice 在候选集的键里，而候选集就是 targets 的键。
    throw new InvalidDecision(`操作 ${operation} 的目标 "${chosenTarget}" 不在动作空间里`);
  }

  return {
    operation,
    target: chosenTarget,
    action,
    probability: probabilityOf(targetAnswer, chosenTarget),
    operationProbability,
    // 保守取小：整步的置信度本该反映「这步有多稳」，任一处犹豫都该被看见。
    confidence: Math.min(operationConfidence, targetAnswer.confidence),
    // 两个 head 都给出真实分布时整步才算 full。取「与」而不是只看 operation：
    // 假通过最常发生在 **target 侧**（§11.1② 明确指出被压平后最容易漏掉的就是这半边），
    // 一旦某个 head 是合成的 one-hot，概率类断言就必须变成 skipped。
    distribution:
      operationAnswer.distribution === "full" && targetAnswer.distribution === "full" ? "full" : "degenerate",
  };
}

/** DONE / BLOCKED 不需要目标，单独处理。 */
export function isTerminal(operation: Operation): boolean {
  return operation === "DONE" || operation === "BLOCKED";
}

/**
 * DONE / BLOCKED 没有真实动作对象，而 `Resolved.action` 是必填字段（冻结契约，不能改）。
 * 这里合成一个哨兵：kind 取 `"wait"`——它是所有动作种类里唯一**不产生任何变更**的，
 * 万一有人漏掉 isTerminal 判断直接把它交给 `session.act`，最坏也只是白等一次；
 * 换成 `"click"` 则可能是落在某个默认焦点元素上的一次真实点击。
 */
function terminalAction(operation: Operation): Action {
  return { id: operation.toLowerCase(), kind: "wait", label: operation === "DONE" ? "Done" : "Blocked" };
}

/**
 * 取概率。键集合已由 validateChoice 保证与候选集一致，这里取不到只可能是校验被绕过——
 * 与其猜一个数（0 会被读成「极不确定」，1 会被读成「非常确定」），不如显式失败：
 * 概率会原样进报告，编造它等于让报告说谎。
 */
function probabilityOf(answer: Answer, id: string): number {
  const value = answer.probabilities[id];
  if (value === undefined) {
    throw new InvalidDecision(`回答 "${answer.key}" 缺少 "${id}" 的概率：validateChoice 本应拦住这种输入`);
  }
  return value;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 错误信息里的实际值。数字走 String，好让 NaN / Infinity 显示成本来的样子（JSON 会把它们变成 null）。 */
function preview(value: unknown): string {
  if (value === undefined) return "undefined";
  if (typeof value === "number") return String(value);
  if (typeof value === "string") return JSON.stringify(value);
  try {
    const text = JSON.stringify(value);
    return text === undefined ? String(value) : text;
  } catch {
    return String(value);
  }
}

/** 概率求和会引入浮点尾巴（0.30000000000000004），错误信息里给人看要收一下。 */
function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
