/**
 * TypeSafe 引擎 —— P0 唯一的真实决策引擎。
 *
 * 一次 HTTP 请求同时回答「执行哪个操作」和「每个操作的候选目标是什么」，
 * 把参考项目里两次串行调用压成一次往返（`jev_ultrafast/model.py:81-148`）。
 *
 * 请求形状：
 *   POST https://api.typesafe.ai/v1/systemone
 *   {
 *     model: "jev-latest",
 *     state:   { page: {url, title, text}, elements: [...], recent_actions: [...] },
 *     questions: {
 *       operation:        { type: "choice", criteria: {...}, instructions: {...} },
 *       click_target:     { type: "choice", criteria: {...}, instructions: {...} },
 *       type_text_target: { ... },
 *       select_target:    { ... }
 *     }
 *   }
 *
 * 响应里每个 question 返回 `{choice, probabilities, confidence}`；**只有被选中操作
 * 对应的那个 head 会被消费**——未命中的 head 即使输出非法也不影响执行
 * （`model.py:127` 的注释就是这个意思）。
 *
 * 本文件只负责「把 IR 翻译成 HTTP、把响应翻译回 IR」。
 * 校验、动作空间构建、护栏都在 core/ 层，引擎无权绕过。
 */

import type { DecisionEngine, DecisionRequest, DecisionResult, TextRequest, TextResult } from "./types.ts";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** 会被重试的 HTTP 状态码。4xx（除 429）立即失败，绝不重试。 */
export const RETRYABLE_STATUS = [429, 503, 529] as const;

export const MAX_ATTEMPTS = 3;

export interface TypeSafeOptions {
  apiKey: string;
  model: string;
  /** 覆盖端点，仅用于测试 */
  endpoint?: string;
  timeoutMs?: number;
}

/** 构造 TypeSafe 引擎。`close()` 关闭底层 HTTP 连接池。 */
export function createTypeSafeEngine(options: TypeSafeOptions): DecisionEngine {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现 decide()
//   - 把 DecisionRequest.questions 映射成 {operation: {...}, <op>_target: {...}}
//     的 questions 对象；key 由 policy.ts 计算（`<operation>_target` 小写）。
//   - 把响应映射回 answers: Record<string, Answer>，distribution 标记为 "full"。
//   - 重试仅限 RETRYABLE_STATUS，指数退避 0.5s / 1s；用 signal 支持取消。
//   - 网络失败时抛出的错误必须能让上层断定「没有任何浏览器动作被执行」。
//
// TODO(P0): 实现 writeText() —— 调用小模型（OpenAI 兼容），
//   要求返回恰好一个 `text` 键的 JSON 对象，输出须通过 core/rules.ts 的校验。
