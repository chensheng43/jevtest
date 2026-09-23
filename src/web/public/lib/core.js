/**
 * 编辑器的纯函数：草稿 <-> 用例定义、断言配方、字段的人话名字。
 *
 * **不碰 DOM、不发请求。** `tests/frontend.test.ts` 直接 import 本文件跑往返测试——
 * 「载入一个用例、界面重画一遍、再保存」这条路上最不能靠肉眼保证的是「有没有东西被丢掉」，
 * 丢了不报错，只是断言少了几条。这是本项目里唯一能不引 jsdom 就测到前端逻辑的口子，
 * 所以往这里加东西时守住两条：只用入参与返回值；不 import 任何碰 DOM 的模块。
 *
 * 设计约定：
 *
 * - **草稿是编辑器唯一的事实来源。** 所有控件在 input/change 时写回 `draft`，
 *   `formToDefinition(draft)` 从草稿整体出发，不从 DOM 读值——两处读值必然分叉，
 *   分叉的表现是「填了但保存后没有」。
 * - **表单与 YAML 键 1:1 对应**，刻意不做 schema 驱动的表单生成器——schema 小而固定，
 *   生成器只会多一层间接。不漂移靠往返测试。
 * - **路径写法与 zod 的 issue 路径是同一套**（如 `assertions.final.controls.2.valueEquals`），
 *   控件挂的 `data-path` 可以直接拿服务端回的错误去定位。
 */

import { RUN_STATUSES, STATUS_LABELS } from "./runs.js";

// ---------------------------------------------------------------------------
// 草稿的路径读写
// ---------------------------------------------------------------------------

/** 按点分路径读草稿。 */
export function readPath(root, path) {
  let node = root;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

/**
 * 按路径写草稿。空值 = **删掉这个键**（YAML 里只写用户真的设了的字段），
 * 但**绝不删数组元素**：删元素会让它后面每一行的下标一起前移，而挂在
 * `data-path` 上的输入框不会跟着变——下一次击键就写进了隔壁那一行。
 */
export function writePath(root, path, value) {
  const keys = path.split(".");
  let node = root;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index];
    const next = keys[index + 1];
    if (node[key] === null || typeof node[key] !== "object") {
      node[key] = /^\d+$/.test(next) ? [] : {};
    }
    node = node[key];
  }
  const last = keys[keys.length - 1];
  if (value === undefined || value === null || value === "") delete node[last];
  else node[last] = value;
}

/**
 * 这一行到底填了东西没有。
 *
 * `exists: true` **不算内容**：它是 schema 的默认值，用户没主动表达任何意思。
 * 把它算成内容的话，一条被清空了的控件断言会以 `{exists: true}` 的形状活下来，
 * 然后在保存时报「labelContains 必填」——用户看着一个空行被骂。
 */
export function rowHasContent(row) {
  return Object.entries(row ?? {}).some(
    ([key, value]) => value !== undefined && value !== null && value !== "" && !(key === "exists" && value === true),
  );
}

/** 去掉「一个值都没填」的行；填了任何一格就保留，让 schema 去报它缺什么。 */
export function dropEmptyRows(rows) {
  return [].concat(rows ?? []).filter(rowHasContent);
}

/** 字符串列表：去掉空行并 trim。空行不是断言。 */
export function cleanStrings(list) {
  return [].concat(list ?? [])
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim());
}

/** 取一个 URL 的 origin。schema 只收 http/https，但这里仍要容忍垃圾输入。 */
export function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// 草稿
// ---------------------------------------------------------------------------

/**
 * 用例草稿。空字符串一律不落盘——YAML 里只写用户真的设了的字段。
 *
 * **数组字段必须在这里就存在**（哪怕是空的）：行编辑器把用户输入直接写回这些数组，
 * 若某处传的是 `?? []` 这种临时数组，新增的行会被写进一个随即被丢弃的对象里。
 */
export function emptyDraft() {
  return {
    title: "",
    goal: "",
    startUrl: "",
    mode: "interactive",
    allowedOrigins: [],
    // "" = 不带登录态。与其他字段一样，空串不落盘
    authState: "",
    engine: "",
    budget: {},
    guardrails: [],
    allowDefaultOverride: false,
    assertions: {
      final: { controls: [] },
      trajectory: { mustUse: [], mustNotUse: [] },
      quality: {},
    },
  };
}

/** 断言分三层（D6）。界面按层分组，报告里检查项的前缀也是它们。 */
export const ASSERTION_GROUPS = [
  { key: "final", label: "最终页面", note: "运行结束时停在的那一页" },
  { key: "trajectory", label: "过程", note: "走过的每一步与结束方式" },
  { key: "quality", label: "质量与成本", note: "模型有多犹豫、花了多少" },
];

/**
 * 断言配方：**一句人话对应 schema 里的一处**。
 *
 * 措辞取自 `docs/writing-cases.md §3`——界面与文档用同一套词汇。
 * `path(index)` / `where` 与 zod 的 issue 路径同一套写法，校验错误能落回具体某一行。
 * `single: true` 的配方最多存在一条（枚举或标量）；其余按数组下标排列，
 * **行序即报告里检查路径的顺序**。
 */
export const RECIPES = [
  {
    kind: "text.contains",
    group: "final",
    sentence: "页面包含文本",
    where: "assertions.final.text.contains",
    path: (index) => `assertions.final.text.contains.${index}`,
    value: "文本片段",
  },
  {
    kind: "text.notContains",
    group: "final",
    sentence: "页面不包含文本",
    where: "assertions.final.text.notContains",
    path: (index) => `assertions.final.text.notContains.${index}`,
    value: "文本片段",
  },
  {
    kind: "url.contains",
    group: "final",
    sentence: "地址包含",
    where: "assertions.final.url.contains",
    path: (index) => `assertions.final.url.contains.${index}`,
    value: "URL 里稳定的 ASCII 片段",
  },
  {
    kind: "controls.exists",
    group: "final",
    sentence: "存在控件",
    where: "assertions.final.controls",
    path: (index) => `assertions.final.controls.${index}.labelContains`,
    value: "可访问名片段",
    item: () => ({ labelContains: "", exists: true }),
  },
  {
    kind: "controls.absent",
    group: "final",
    sentence: "不存在控件",
    where: "assertions.final.controls",
    path: (index) => `assertions.final.controls.${index}.labelContains`,
    value: "可访问名片段",
    item: () => ({ labelContains: "", exists: false }),
  },
  {
    kind: "statusIn",
    group: "trajectory",
    sentence: "结束方式必须是",
    where: "assertions.trajectory.statusIn",
    path: () => "assertions.trajectory.statusIn",
    single: true,
    statuses: true,
  },
  {
    kind: "mustUse",
    group: "trajectory",
    sentence: "必须操作过",
    where: "assertions.trajectory.mustUse",
    path: (index) => `assertions.trajectory.mustUse.${index}.labelContains`,
    value: "控件的可访问名片段",
    item: () => ({ labelContains: "" }),
  },
  {
    kind: "mustNotUse",
    group: "trajectory",
    sentence: "绝不能操作",
    where: "assertions.trajectory.mustNotUse",
    path: (index) => `assertions.trajectory.mustNotUse.${index}.labelContains`,
    value: "控件的可访问名片段",
    item: () => ({ labelContains: "" }),
  },
  {
    kind: "maxSteps",
    group: "trajectory",
    sentence: "最多走几步",
    where: "assertions.trajectory.maxSteps",
    path: () => "assertions.trajectory.maxSteps",
    single: true,
    numeric: true,
    value: "步数（是断言，不是刹车）",
  },
  {
    kind: "maxModelCalls",
    group: "quality",
    sentence: "最多几次模型请求",
    where: "assertions.quality.maxModelCalls",
    path: () => "assertions.quality.maxModelCalls",
    single: true,
    numeric: true,
    value: "次数",
  },
];

export const RECIPE_BY_KIND = new Map(RECIPES.map((recipe) => [recipe.kind, recipe]));

export const ACTION_KINDS = ["click", "fill", "select", "scroll", "wait"];

export const ACTION_KIND_LABELS = {
  click: "点击",
  fill: "输入",
  select: "下拉选择",
  scroll: "滚动",
  wait: "等待",
};

/**
 * 一行配方是不是「完全由配方表达」的。
 *
 * 判据是**结构**（键的集合），不是「有没有填值」。填没填由保存时的
 * `dropEmptyRows` 决定：清空一行 = 删掉这条断言，但**在编辑过程中它仍然显示**，
 * 否则用户刚删掉最后一个字符，那一行就从眼前消失（还带着他的输入焦点）。
 */
export function recipeCovers(recipe, row) {
  const keys = Object.keys(row);
  if (recipe.kind === "controls.exists" || recipe.kind === "controls.absent") {
    return keys.every((key) => key === "labelContains" || key === "exists");
  }
  return keys.every((key) => key === "labelContains");
}

/** 把草稿里能被配方表达的东西摊成一行行（顺序固定，见 RECIPES 的注释）。 */
export function assertionRows(draft) {
  const rows = [];
  const final = draft.assertions.final ?? {};
  const trajectory = draft.assertions.trajectory ?? {};
  const quality = draft.assertions.quality ?? {};

  for (const [kind, list] of [
    ["text.contains", final.text?.contains],
    ["text.notContains", final.text?.notContains],
    ["url.contains", final.url?.contains],
  ]) {
    const recipe = RECIPE_BY_KIND.get(kind);
    [].concat(list ?? []).forEach((value, index) => {
      rows.push({ recipe, index, path: recipe.path(index), value });
    });
  }

  [].concat(final.controls ?? []).forEach((row, index) => {
    const recipe = RECIPE_BY_KIND.get(row.exists === false ? "controls.absent" : "controls.exists");
    if (recipeCovers(recipe, row)) rows.push({ recipe, index, path: recipe.path(index), value: row.labelContains ?? "" });
  });

  for (const [kind, list] of [["mustUse", trajectory.mustUse], ["mustNotUse", trajectory.mustNotUse]]) {
    const recipe = RECIPE_BY_KIND.get(kind);
    [].concat(list ?? []).forEach((row, index) => {
      if (recipeCovers(recipe, row)) rows.push({ recipe, index, path: recipe.path(index), value: row.labelContains ?? "" });
    });
  }

  // 存在即占一行——**空的 `statusIn` 也要显示出来**（理由见 formToDefinition 里那段）。
  if (Array.isArray(trajectory.statusIn)) {
    const recipe = RECIPE_BY_KIND.get("statusIn");
    rows.push({ recipe, path: recipe.path(), value: trajectory.statusIn });
  }
  for (const [kind, value] of [["maxSteps", trajectory.maxSteps], ["maxModelCalls", quality.maxModelCalls]]) {
    if (typeof value === "number") {
      const recipe = RECIPE_BY_KIND.get(kind);
      rows.push({ recipe, path: recipe.path(), value });
    }
  }
  return rows;
}

/** 一行配方里填了东西没有——计数不该把空行也数进去。 */
export function rowIsSet(row) {
  return Array.isArray(row.value) ? true : row.value !== "" && row.value !== undefined;
}

/**
 * 配方覆盖不到的字段逐个列出——**原样保留**。
 *
 * 配方是**视图**，不是数据的所有者。载入的用例里有任何配方表达不了的写法
 * （`final.title.matches`、`forbiddenKinds`、`minTargetProbability`……），保存时必须还在。
 * 所以 `formToDefinition` 始终从 `draft` 整体出发，而不是从配方行重建一份。
 */
export const RAW_FIELDS = [
  { path: "assertions.final.url.equals", group: "final", label: "地址完全等于", note: "与整个 URL 全等，很脆：query 一变就失败", type: "text" },
  { path: "assertions.final.url.matches", group: "final", label: "地址匹配正则", note: "每行一条", type: "lines" },
  { path: "assertions.final.title.equals", group: "final", label: "标题完全等于", type: "text" },
  { path: "assertions.final.title.contains", group: "final", label: "标题包含", note: "每行一条", type: "lines" },
  { path: "assertions.final.title.notContains", group: "final", label: "标题不包含", note: "每行一条", type: "lines" },
  { path: "assertions.final.title.matches", group: "final", label: "标题匹配正则", note: "每行一条", type: "lines" },
  { path: "assertions.final.text.equals", group: "final", label: "页面文本完全等于", type: "text" },
  { path: "assertions.final.text.matches", group: "final", label: "页面文本匹配正则", note: "每行一条", type: "lines" },
  { path: "assertions.trajectory.forbiddenKinds", group: "trajectory", label: "禁止出现的动作种类", type: "kinds" },
  { path: "assertions.trajectory.maxIdenticalConsecutive", group: "trajectory", label: "连续几步页面无变化算卡住", note: "默认 3", type: "number" },
  { path: "assertions.quality.minOperationProbability", group: "quality", label: "操作选择的最低概率", note: "0~1；引擎给不出真实分布时这条会被跳过", type: "number" },
  { path: "assertions.quality.minTargetProbability", group: "quality", label: "目标选择的最低概率", note: "0~1；引擎给不出真实分布时这条会被跳过", type: "number" },
  { path: "assertions.quality.maxElapsedMs", group: "quality", label: "最长耗时（毫秒）", type: "number" },
  { path: "assertions.quality.maxInputTokens", group: "quality", label: "最多输入 token", type: "number" },
  { path: "assertions.quality.maxCostUsd", group: "quality", label: "最高成本（美元）", note: "引擎不报金额时这条会被跳过", type: "number" },
];

/** 预算：任一维度超限即终止运行。这是刹车，与断言里的「最多几步」不是一回事。 */
export const BUDGET_FIELDS = [
  { key: "maxSteps", label: "最多执行几步", placeholder: "40" },
  { key: "maxModelCalls", label: "最多几次模型请求", placeholder: "40" },
  { key: "maxInputTokens", label: "累计输入 token 上限", placeholder: "200000" },
  { key: "maxCostUsd", label: "成本上限（美元）", placeholder: "不限" },
  { key: "maxElapsedMs", label: "墙钟上限（毫秒）", placeholder: "300000" },
];

/** 护栏行的列。 */
export const GUARDRAIL_COLUMNS = [
  { key: "labelContains", label: "可访问名包含" },
  { key: "labelMatches", label: "或匹配正则" },
  { key: "role", label: "角色" },
  { key: "reason", label: "拦下的理由", required: true },
];

/** 配方表达不了的 mustUse / mustNotUse 行用这些列编辑。 */
export const ACTION_COLUMNS = [
  { key: "labelContains", label: "可访问名包含" },
  { key: "labelMatches", label: "可访问名匹配正则" },
  { key: "role", label: "角色" },
  { key: "kind", label: "动作种类", options: ACTION_KINDS },
];

/** 配方表达不了的控件断言行用这些列编辑。`exists` / `checked` 是三态下拉，不让手打布尔值。 */
export const CONTROL_COLUMNS = [
  { key: "labelContains", label: "可访问名包含", required: true },
  { key: "role", label: "角色" },
  { key: "exists", label: "存在", options: ["true", "false"] },
  { key: "valueEquals", label: "值等于" },
  { key: "valueContains", label: "值包含" },
  { key: "valueMatches", label: "值匹配正则" },
  { key: "checked", label: "勾选状态", options: ["true", "false"] },
];

// ---------------------------------------------------------------------------
// 字段的人话名字：错误提示与表单共用这一份
// ---------------------------------------------------------------------------

const TOP_LABELS = {
  title: "标题",
  goal: "目标",
  startUrl: "起始地址",
  authState: "登录态",
  mode: "模式",
  engine: "决策引擎",
  allowedOrigins: "域名白名单",
  allowDefaultOverride: "停用内置护栏",
  id: "用例 id",
};

const GROUP_LABEL = Object.fromEntries(ASSERTION_GROUPS.map((group) => [group.key, group.label]));

/**
 * zod issue 路径 -> 给人看的字段名。
 *
 * 以前错误框里直接列 `assertions.final.controls.2.valueEquals: …`，用户得自己去对 schema。
 * 这里把它译成「断言 · 最终页面 · 第 3 条控件断言的「值等于」」这样的话；
 * 译不出来就原样返回路径，**不编一个看起来像的名字**。
 */
export function fieldLabel(path) {
  const keys = String(path ?? "").split(".").filter((key) => key !== "");
  if (keys.length === 0) return "整个用例";
  const [head, ...rest] = keys;
  const nth = (value) => `第 ${Number(value) + 1} `;

  if (TOP_LABELS[head] !== undefined) {
    if (head === "allowedOrigins" && rest.length > 0) return `域名白名单${nth(rest[0])}行`;
    return TOP_LABELS[head];
  }
  if (head === "budget") {
    const field = BUDGET_FIELDS.find((item) => item.key === rest[0]);
    return field === undefined ? "预算" : `预算：${field.label}`;
  }
  if (head === "guardrails") {
    if (rest.length === 0) return "护栏";
    const column = GUARDRAIL_COLUMNS.find((item) => item.key === rest[1]);
    return `${nth(rest[0])}条护栏${column === undefined ? "" : `的「${column.label}」`}`;
  }
  if (head === "assertions") {
    const joined = keys.join(".");
    const raw = RAW_FIELDS.find((field) => joined === field.path || joined.startsWith(`${field.path}.`));
    if (raw !== undefined) return `断言：${raw.label}`;
    for (const recipe of RECIPES) {
      if (recipe.single) {
        if (joined === recipe.where || joined.startsWith(`${recipe.where}.`)) return `断言：${recipe.sentence}`;
        continue;
      }
      if (joined.startsWith(`${recipe.where}.`)) {
        const index = joined.slice(recipe.where.length + 1).split(".")[0];
        const column = [...CONTROL_COLUMNS, ...ACTION_COLUMNS].find((item) => joined.endsWith(`.${item.key}`));
        const noun = recipe.kind.startsWith("controls") ? "控件断言" : recipe.kind === "mustUse" ? "「必须操作过」" : recipe.kind === "mustNotUse" ? "「绝不能操作」" : `「${recipe.sentence}」`;
        return `断言：${nth(index)}条${noun}${column !== undefined && column.key !== "labelContains" ? `的「${column.label}」` : ""}`;
      }
    }
    const group = GROUP_LABEL[rest[0]];
    return group === undefined ? "断言" : `断言：${group}`;
  }
  return keys.join(".");
}

/**
 * zod 的中文内置文案仍然带着类型名（「数值过小：期望 string >=1 字符」），
 * 最常见的几种换成人话；认不出的原样返回——宁可生硬，也不改掉它的意思。
 */
export function issueMessage(message) {
  const text = String(message ?? "");
  if (/期望 string >=1 字符|expected string to have >=1 characters/.test(text)) return "不能为空";
  if (/实际接收 undefined|received undefined/.test(text)) return "必填";
  const tooSmall = /数值过小：期望 number >=?(\S+)/.exec(text);
  if (tooSmall) return text.includes(">=") ? `不能小于 ${tooSmall[1]}` : `必须大于 ${tooSmall[1]}`;
  const tooBig = /数值过大：期望 number <=?(\S+)/.exec(text);
  if (tooBig) return text.includes("<=") ? `不能大于 ${tooBig[1]}` : `必须小于 ${tooBig[1]}`;
  if (/期望 int|expected int/.test(text)) return "必须是整数";
  return text;
}

/** issue 路径属于编辑器的哪一节。 */
export function sectionForPath(path) {
  const text = String(path ?? "");
  if (text.startsWith("assertions")) return "assertions";
  if (text.startsWith("budget") || text.startsWith("guardrails") || text === "allowDefaultOverride") return "limits";
  return "basic";
}

// ---------------------------------------------------------------------------
// 保存前提示与摘要
// ---------------------------------------------------------------------------

/**
 * 保存前的提示。**只做能证明的检查**，且一律是提示、不阻断保存。
 *
 * 这几条来自 `docs/writing-cases.md §4 常见陷阱`：那些坑是确定的（不是「可能」），
 * 让用户保存完跑一遍才发现，等于把成本推给他。文案可带 `**` 与反引号记号，渲染时走 rich()。
 */
export function presaveWarnings(draft) {
  const out = [];
  const trajectory = draft.assertions.trajectory ?? {};
  const mustUse = dropEmptyRows(trajectory.mustUse);
  const mustNotUse = dropEmptyRows(trajectory.mustNotUse);
  const forbidden = [].concat(trajectory.forbiddenKinds ?? []);
  const readonly = (draft.mode ?? "interactive") === "readonly";

  if (readonly) {
    const mutating = mustUse.filter((row) => row.kind === "fill" || row.kind === "select");
    if (mutating.length > 0) {
      out.push("只读模式下声明了「必须操作过」的输入或选择：变更型动作在**构造候选集时**就被剔除，这条断言不可能通过。");
    }
  }

  const forbiddenHit = mustUse.filter((row) => row.kind !== undefined && forbidden.includes(row.kind));
  if (forbiddenHit.length > 0) {
    out.push("同一种动作既要求「必须操作过」又被列为「禁止出现」，两条断言互相矛盾，必然有一条失败。");
  }

  const bothSides = mustNotUse
    .map((row) => row.labelContains)
    .filter((label) => label !== undefined && mustUse.some((row) => row.labelContains === label));
  if (bothSides.length > 0) {
    out.push(`同一个可访问名同时出现在「必须操作过」和「绝不能操作」里（${bothSides.join("、")}），两条断言必然有一条失败。`);
  }

  // 这是 schema 已有的跨字段校验（case.ts 的 refine），不提前说就只能靠一次保存失败才知道。
  const origins = cleanStrings(draft.allowedOrigins);
  const startOrigin = originOf(draft.startUrl);
  if (origins.length > 0 && startOrigin !== null && !origins.includes(startOrigin)) {
    out.push(`域名白名单里没有起始地址的 origin \`${startOrigin}\`，保存会被拒：把它加进白名单，或清空白名单让它自动推导。`);
  }

  const assertionCount = assertionRows(draft).filter(rowIsSet).length + RAW_FIELDS.filter((field) => isSet(readPath(draft, field.path))).length;
  if (assertionCount === 0) {
    out.push("还没有任何断言：运行结果会是**未判定**，不是通过。");
  }
  return out;
}

function isSet(value) {
  if (value === undefined || value === null || value === "") return false;
  if (Array.isArray(value)) return value.length > 0;
  return true;
}

/** 各节有多少内容——节目录上的计数靠它。 */
export function draftSummary(draft) {
  const assertions = assertionRows(draft).filter(rowIsSet).length;
  const budget = Object.keys(draft.budget ?? {}).length;
  const guardrails = dropEmptyRows(draft.guardrails).length;
  return { assertions, limits: budget + guardrails + (draft.allowDefaultOverride ? 1 : 0) };
}

// ---------------------------------------------------------------------------
// 草稿 <-> 定义
// ---------------------------------------------------------------------------

/**
 * 草稿 -> 服务端认识的 `CaseDefinition`。
 *
 * 空的行与空的字符串在这里去掉，其余一律照原样交给 schema——**不替服务端做判断**，
 * 判错了要报得出的错它自己报。
 */
export function formToDefinition(draft) {
  const definition = {
    title: (draft.title ?? "").trim(),
    goal: (draft.goal ?? "").trim(),
    startUrl: (draft.startUrl ?? "").trim(),
  };
  if (draft.id) definition.id = draft.id;
  if (draft.mode && draft.mode !== "interactive") definition.mode = draft.mode;
  if (draft.engine) definition.engine = draft.engine;

  const origins = cleanStrings(draft.allowedOrigins);
  if (origins.length > 0) definition.allowedOrigins = origins;
  if (draft.authState) definition.authState = draft.authState;

  const budget = {};
  for (const { key } of BUDGET_FIELDS) {
    const value = draft.budget?.[key];
    if (typeof value === "number" && Number.isFinite(value)) budget[key] = value;
  }
  if (Object.keys(budget).length > 0) definition.budget = budget;

  const guardrails = dropEmptyRows(draft.guardrails).map((row) => {
    const out = {};
    for (const { key } of GUARDRAIL_COLUMNS) {
      if (row[key] !== undefined && row[key] !== "") out[key] = row[key];
    }
    return out;
  });
  if (guardrails.length > 0) definition.guardrails = guardrails;
  if (draft.allowDefaultOverride) definition.allowDefaultOverride = true;

  const assertions = {};
  const final = {};
  const finalIn = draft.assertions.final ?? {};
  for (const key of ["url", "title", "text"]) {
    const match = textMatchOf(finalIn[key]);
    if (match !== undefined) final[key] = match;
  }
  const controls = dropEmptyRows(finalIn.controls).map(coerceControl);
  if (controls.length > 0) final.controls = controls;
  if (Object.keys(final).length > 0) assertions.final = final;

  const trajectory = {};
  const trajectoryIn = draft.assertions.trajectory ?? {};
  const statusIn = [].concat(trajectoryIn.statusIn ?? []).filter((value) => RUN_STATUSES.includes(value));
  // **空数组也要写回去**：`statusIn: []` 不是「没设」，而是「任何结束方式都不接受」，
  // 那份断言对每一次运行都失败。丢掉它会退化回默认的 `["done"]`——
  // 把一条必然失败的断言悄悄变成了通过的条件。
  if (Array.isArray(trajectoryIn.statusIn)) trajectory.statusIn = statusIn;
  if (typeof trajectoryIn.maxSteps === "number") trajectory.maxSteps = trajectoryIn.maxSteps;
  if (typeof trajectoryIn.maxIdenticalConsecutive === "number") {
    trajectory.maxIdenticalConsecutive = trajectoryIn.maxIdenticalConsecutive;
  }
  const forbiddenKinds = [].concat(trajectoryIn.forbiddenKinds ?? []).filter((value) => ACTION_KINDS.includes(value));
  if (forbiddenKinds.length > 0) trajectory.forbiddenKinds = forbiddenKinds;
  const mustUse = dropEmptyRows(trajectoryIn.mustUse).map(coerceActionMatch);
  if (mustUse.length > 0) trajectory.mustUse = mustUse;
  const mustNotUse = dropEmptyRows(trajectoryIn.mustNotUse).map(coerceActionMatch);
  if (mustNotUse.length > 0) trajectory.mustNotUse = mustNotUse;
  if (Object.keys(trajectory).length > 0) assertions.trajectory = trajectory;

  const quality = {};
  for (const [key, value] of Object.entries(draft.assertions.quality ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) quality[key] = value;
  }
  if (Object.keys(quality).length > 0) assertions.quality = quality;

  if (Object.keys(assertions).length > 0) definition.assertions = assertions;
  return definition;
}

/** TextMatch：只留下真的设了的键。四个键彼此独立，可以共存。 */
function textMatchOf(match) {
  if (match === null || typeof match !== "object") return undefined;
  const out = {};
  if (typeof match.equals === "string" && match.equals.trim() !== "") out.equals = match.equals.trim();
  for (const key of ["contains", "notContains", "matches"]) {
    const items = cleanStrings(match[key]);
    if (items.length > 0) out[key] = items;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * 表单里一切都是字符串，落盘前要还原成 schema 的类型。
 *
 * `exists` / `checked` 是三态下拉（未设 / true / false），这里的映射是**穷尽**的——
 * 以前让用户手打 true/false 时，打「是」「TRUE」会静默地把断言反过来。
 */
function coerceControl(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || value === "") continue;
    if (key === "exists" || key === "checked") {
      if (value === "true" || value === true) out[key] = true;
      else if (value === "false" || value === false) out[key] = false;
      else continue;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function coerceActionMatch(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) if (value !== undefined && value !== "") out[key] = value;
  return out;
}

/** 读回来的用例补成草稿的形状，好让表单各处都不必写 `?? {}`。 */
export function normalizeDraft(def) {
  return {
    ...emptyDraft(),
    ...def,
    allowedOrigins: def.allowedOrigins ?? [],
    budget: def.budget ?? {},
    guardrails: (def.guardrails ?? []).map((row) => ({ ...row })),
    assertions: {
      final: {
        ...(def.assertions?.final ?? {}),
        controls: (def.assertions?.final?.controls ?? []).map((row) => ({ ...row })),
      },
      trajectory: {
        ...(def.assertions?.trajectory ?? {}),
        mustUse: (def.assertions?.trajectory?.mustUse ?? []).map((row) => ({ ...row })),
        mustNotUse: (def.assertions?.trajectory?.mustNotUse ?? []).map((row) => ({ ...row })),
      },
      quality: { ...(def.assertions?.quality ?? {}) },
    },
  };
}

/**
 * 从地址推一个登录态名字：取主机名的第一段，规整成 `[a-z0-9-]`。
 * `https://shop_test9.example.com/x` -> `shop-test9`。只是建议值，用户可改。
 */
export function suggestAuthName(url) {
  let host = "";
  try {
    host = new URL(String(url)).hostname;
  } catch {
    return "";
  }
  // IP 地址推不出有意义的名字，留空让人自己填
  if (/^[\d.]+$/.test(host) || host.includes(":")) return "";
  const first = host.split(".")[0] === "www" ? host.split(".")[1] ?? "" : host.split(".")[0] ?? "";
  const slug = first.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug.length >= 2 ? slug : "";
}

/** 草稿的指纹，用来判断「改了没有」。比字段级 diff 便宜，也够用。 */
export function signature(value) {
  return JSON.stringify(value);
}

export { STATUS_LABELS };

/**
 * 报告里的检查项键（`final.text.contains[0]`、`trajectory.mustUse[1]`）-> 人话。
 * 与编辑器共用同一张名字表：界面上写断言时叫什么，结果页就叫什么。
 */
export function checkLabel(key) {
  const path = `assertions.${String(key).replace(/\[(\d+)\]/g, ".$1")}`;
  return fieldLabel(path).replace(/^断言：/, "");
}

/** 检查项属于哪一层（final / trajectory / quality）。 */
export function checkGroup(key) {
  return String(key).split(/[.[]/)[0];
}
