/**
 * 文本取值：构造请求 + 校验响应。
 *
 * 只在决策结果是 TYPE_TEXT 时用到。它存在的意义是把「从 goal 里读出要输入的字符串」
 * 这件事限制在一个极小的模型调用里——决策本身由 TypeSafe 做，文本生成交给便宜的小模型。
 *
 * 移植自 jev-ultrafast `model.py:151-198`，包括那条最重要的约束：
 * **绝不从 goal 里提取引号内的字面量**。参考项目早期版本靠复制引号内容蒙混过关，
 * 后来专门移除了这个捷径（见其 docs/design.md「What changed after the first demo」）。
 * 字段值必须由模型从语义推导，且必须通过校验。
 */

import { createHash } from "node:crypto";

import type { RecentActionIR, TextRequest } from "./types.ts";

/** 模型返回的 JSON 必须恰好包含一个 `text` 键。 */
export interface TextHelperOutput {
  text: string | null;
}

/** 值的长度上限。超过即视为模型跑题。 */
export const MAX_TEXT_LENGTH = 2000;

/** `page.text` 截断长度。参考项目取 6000（`model.py:155`）。 */
export const MAX_CONTEXT_CHARS = 6000;

/**
 * 上下文指纹的格式版本。
 *
 * 混进哈希输入是为了让**改口径这件事本身**失效：若哪天往请求里加了字段，
 * 旧指纹会自动全部对不上，而不是与新一轮生成的指纹碰巧相等——
 * 后者会让「陈旧决策重试时复用旧文本」这条缓存规则悄悄复用错东西。
 */
const CONTEXT_KEY_VERSION = "jevtest:text-context:v1";

/**
 * 由 goal、被选中的字段、页面上下文与最近动作构造请求。
 *
 * 刻意只接收 `{title, text}` 而非完整的 `Observation`：engine 层不应该知道
 * 浏览器层的数据结构，否则「引擎是纯网络组件」这条不变量就名存实亡了。
 */
export function buildTextRequest(input: {
  goal: string;
  action: { label: string; role: string; value?: string };
  page: { title: string; text: string };
  history: RecentActionIR[];
}): TextRequest {
  return {
    goal: input.goal,
    field: {
      label: input.action.label,
      role: input.action.role,
      // 用 "" 而不是保留 undefined：`TextRequest.field.value` 是必填 string，
      // 让「字段当前为空」只有一种表示，调用方不必区分两种「没有值」。
      value: input.action.value ?? "",
    },
    page: {
      title: input.page.title,
      text: truncate(input.page.text, MAX_CONTEXT_CHARS),
    },
    // 复制一份：调用方随后 mutate 自己的 history 不应该改变这次请求的身份，
    // 否则 textContextKey 会在两次计算之间漂移，缓存判定随之失真。
    recentActions: input.history.slice(),
  };
}

/**
 * 校验并解析模型输出。
 *
 * 拒绝：非 JSON、非对象、含多余键、缺 `text` 键、值不是 string/null、空串、超长。
 * 任何一项不满足都抛错——**什么都不输入，好过输入错的东西**。
 *
 * `{"text": null}` 是**合法**返回值，表示 goal 里缺少必要信息。本函数无法判断
 * 「这个字段是否必填」，因此不在此处报错：调用方拿到 `text: null` 后必须终止该步，
 * 而不是猜一个值（见 TextResult 的说明）。
 */
export function parseTextHelperOutput(raw: string): TextHelperOutput {
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new Error("文本模型返回了空响应：期望形如 {\"text\": \"...\"} 的 JSON 对象。");
  }

  // **整串解析，绝不抠片段。** 上游有对应用例：`Thinking: {...}` 这类带前言的输出
  // 必须被拒绝，而不是「取第一个 { 到最后一个 }」把它救回来——
  // 那种容错会让模型学会用前言夹带解释，最终把解析器变成一个宽松的正则。
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    throw new Error(
      `文本模型返回的不是合法 JSON（期望恰好一个 text 键，不允许任何前言、解释或代码围栏）：${snippet(raw)}`,
    );
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`文本模型必须返回一个 JSON 对象，收到的是 ${describe(parsed)}：${snippet(raw)}`);
  }

  const record = parsed as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "text") {
    throw new Error(
      `文本模型的响应必须**恰好**含一个 "text" 键，实际键为 [${keys.join(", ") || "(无)"}]：${snippet(raw)}`,
    );
  }

  const value = record["text"];
  if (value === null) return { text: null };
  if (typeof value !== "string") {
    throw new Error(`"text" 的值必须是字符串或 null，收到的是 ${describe(value)}：${snippet(raw)}`);
  }
  if (value.trim().length === 0) {
    // 纯空白与空串等价：填进去和不填没有区别，但会让「这一步执行过了」看起来成立。
    throw new Error("文本模型返回了空字符串：什么都不能输入时应当返回 {\"text\": null}，而不是空串。");
  }
  if (value.length > MAX_TEXT_LENGTH) {
    throw new Error(
      `文本模型返回的文本过长（${value.length} 字符，上限 ${MAX_TEXT_LENGTH}）：这通常意味着模型把解释或整段页面内容当成了字段值。`,
    );
  }

  return { text: value };
}

/**
 * 上下文指纹。
 *
 * 用于参考项目 `agent.py:110-114` 那条缓存规则：**陈旧决策重试时，
 * 只有整个 helper 输入完全相同时才复用已生成的文本**。
 * 页面上下文有任何变化，就必须重新生成——否则会把为旧页面生成的地址填进新页面。
 *
 * 实现上对整个 `TextRequest` 做**规范化序列化**（对象键排序）再取 sha256：
 * 显式列出字段虽然更「白盒」，但新增字段时指纹不会变，缓存会误命中；
 * 直接 `JSON.stringify(req)` 又对属性顺序敏感，等价输入会算出不同指纹。
 * 键排序一次解决两者。
 */
export function textContextKey(req: TextRequest): string {
  return createHash("sha256").update(`${CONTEXT_KEY_VERSION}\n${canonicalJson(req)}`, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

/**
 * 截断到 `max` 字符。
 *
 * 不要把代理对（emoji 等）切成两半：半个字符会变成 U+FFFD，
 * 既白占 token 又给模型一个明显的噪声信号。
 */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = last >= 0xd800 && last <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}

/** 规范化 JSON：对象键排序、数组保序，因此「等价的输入」得到同一个字符串。 */
function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/** 错误信息里的片段。截断是为了不让一整页文本灌进报告与日志。 */
function snippet(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 200)}…` : oneLine;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "数组";
  return typeof value;
}
