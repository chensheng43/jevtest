/**
 * Scripted 引擎 —— 零成本、确定性的回放引擎。
 *
 * 存在的理由是**可测试性**：参考项目用 `monkeypatch.setattr(model, "post_json", fake)`
 * 在单元测试里绕开付费 API（`tests/test_agent.py:77-95`），本项目把这个手法提升到
 * 注册表层，于是 server + queue + pool + runner + checks 的**全链路**都能在
 * 零成本、完全确定的条件下被测试，而不只是孤立的单元。
 *
 * **构造方式是编程式的，不走用例配置。** 测试把引擎实例直接传给
 * `RunnerDeps.createEngine`（那本来就是一个注入点）：
 *
 *   const runner = createRunnerService({
 *     ...deps,
 *     createEngine: () => createScriptedEngine({ steps: [
 *       { operation: { choice: "TYPE_TEXT" }, targets: { type_text_target: { choice: "1" } }, text: "Ada Lovelace" },
 *       { operation: { choice: "CLICK" },     targets: { click_target:     { choice: "3" } } },
 *       { operation: { choice: "DONE" } },
 *     ]}),
 *   });
 *
 * 每一步从数组里取一项；取完后再被调用即报错（说明用例步数超出预期）。
 *
 * 它和真实引擎实现同一个 `DecisionEngine` 接口，因此 runner 完全不知道
 * 自己在跟谁说话——这正是「可插拔」要换来的东西。
 */

import type { DecisionEngine, DecisionRequest, DecisionResult, TextRequest, TextResult } from "./types.ts";

/**
 * 单步预设答案。
 *
 * 刻意**不校验** choice 是否在候选集内——非法值应该照原样送出去，
 * 由 `core/policy.ts` 的 `validateChoice` 拒绝。这样校验与护栏路径也能被测试覆盖，
 * 而不是被引擎悄悄修正。
 */
export interface ScriptedStep {
  operation: {
    choice: string;
    confidence?: number;
    /** 省略时合成 one-hot 分布 */
    probabilities?: Record<string, number>;
  };
  /**
   * 各 target head 的答案，key 为 `<operation>_target` 小写（如 `click_target`）。
   * 未给出的 head 会自动补成该 head 候选项中的第一项——真实的模型也必须回答
   * 每个 head，所以这里不能让它们缺席。
   */
  targets?: Record<string, { choice: string; confidence?: number }>;
  /** TYPE_TEXT 时要返回的文本；null 表示「目标里缺少必要信息」 */
  text?: string | null;
}

export interface ScriptedOptions {
  steps: ScriptedStep[];
  name?: string;
}

/** 连续两次给出同样的答案，用于测试卡死检测。 */
export function constantSteps(step: ScriptedStep, count: number): ScriptedStep[] {
  throw new Error("未实现：P0 待实现");
}

export function createScriptedEngine(options: ScriptedOptions): DecisionEngine {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现 createScriptedEngine。
//   - decide() 按序消费 steps；operation 未命中候选集或 target 越界时，
//     应模拟真实引擎的「非法输出」，交由 core/policy.ts 的 validateChoice 拒绝——
//     这样护栏与校验路径也能被测试，而不是被引擎悄悄修正。
//   - capabilities.probabilities 默认 "full"（可配 "degenerate" 以测试 skipped 语义）。
//   - capabilities.text 为 true 时由 steps[].text 提供值。
