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
  throw new Error("未实现：P0 待实现");
}

/**
 * 校验并解析模型输出。
 *
 * 拒绝：非字符串、空串、超长、含多余键、JSON 解析失败、返回了 `text: null`
 * 但字段实际必填的情形。任何一项不满足都抛错——**什么都不输入，好过输入错的东西**。
 */
export function parseTextHelperOutput(raw: string): TextHelperOutput {
  throw new Error("未实现：P0 待实现");
}

/**
 * 上下文指纹。
 *
 * 用于参考项目 `agent.py:110-114` 那条缓存规则：**陈旧决策重试时，
 * 只有整个 helper 输入完全相同时才复用已生成的文本**。
 * 页面上下文有任何变化，就必须重新生成——否则会把为旧页面生成的地址填进新页面。
 */
export function textContextKey(req: TextRequest): string {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现三个函数。parseTextHelperOutput 必须拒绝 "Thinking: {...}" 这类
//           带前言的输出（参考项目 tests/test_agent.py:305 有对应用例）。
