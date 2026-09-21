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

import type { Usage } from "../schema/report.ts";
import type { Answer, DecisionEngine, DecisionRequest, DecisionResult, TextRequest, TextResult } from "./types.ts";

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
  /**
   * 合成分布的质量，默认 `"full"`。
   *
   * 设成 `"degenerate"` 是为了**测试 skipped 语义**：`Answer.distribution` 为
   * `degenerate` 时，概率类断言必须标为 skipped 而不是 passed
   * （见 architecture.md §5.3 与 core/checks.ts）。若 scripted 只能产出 "full"，
   * 这条「不能假通过」的规则就无法在零成本链路里被验证。
   */
  probabilities?: "full" | "degenerate";
  /** 是否声明支持文本取值。默认 true，由 `steps[].text` 提供值。 */
  text?: boolean;
}

/**
 * 未显式给出 `confidence` 时的默认值。
 *
 * 取 1：scripted 的答案是**给定的**，不存在模型那种「我有多确定」的不确定性。
 * 用一个居中的值（如 0.5）反而是编造——它会让质量类断言在一个纯夹具上失败，
 * 而失败原因与用例无关。1 是唯一诚实的取值：这一步没有不确定性可言。
 */
const DEFAULT_CONFIDENCE = 1;

/**
 * 合成的用量。**这些数字不是真实测量，只是为了让计数器真的会动。**
 *
 * 固定小值而非随机值：scripted 的全部价值在于确定性，用量抖动会让
 * 「预算刹车是否生效」的测试变成偶发失败。
 * `costUsd: null` 而不是 0——没有计费就是「未知」，用 0 冒充未知会让
 * `budget.maxCostUsd` 看起来验过了。
 */
const SYNTHETIC_INPUT_TOKENS = 100;
const SYNTHETIC_OUTPUT_TOKENS = 10;

/**
 * 连续给出同样的答案 `count` 次，用于测试无进展检测。
 *
 * 每次都深拷贝：重复引用同一个对象时，任何一处（包括引擎写进 `raw` 的那份）
 * 的改动都会同时改变「所有步」，而连续重复恰恰是卡死检测的触发条件——
 * 让这些步共享可变状态会把一条确定性测试变成随机的。
 */
export function constantSteps(step: ScriptedStep, count: number): ScriptedStep[] {
  if (!Number.isInteger(count) || count < 0) {
    throw new Error(`constantSteps 的 count 必须是非负整数，收到 ${String(count)}。`);
  }
  return Array.from({ length: count }, () => structuredClone(step));
}

export function createScriptedEngine(options: ScriptedOptions): DecisionEngine {
  const name = options.name ?? "scripted";
  const distribution = options.probabilities ?? "full";
  const supportsText = options.text ?? true;

  /** 下一个待消费的步号。consumed 之后 writeText 从 `index - 1` 读取文本。 */
  let index = 0;
  let closed = false;

  return {
    name,
    capabilities: { text: supportsText, probabilities: distribution },

    async decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      // 与真实引擎一致：取消在请求入口就生效，而不是先假装答完再抛。
      signal.throwIfAborted();
      if (closed) throw new Error(`${name}: 引擎已关闭，不能再发起决策。`);

      const started = performance.now();
      const step = options.steps[index];
      if (step === undefined) {
        throw new Error(
          `${name}: 预设步数已用尽（共 ${options.steps.length} 步），第 ${index + 1} 次决策没有答案可用。` +
            `这说明用例实际走的步数超出预期——检查 steps 是否覆盖了到达 DONE/BLOCKED 之前的每一步` +
            `（含被护栏拦下、被无进展检测判定的那些步）。`,
        );
      }
      index += 1;

      const answers: Record<string, Answer> = {};
      for (const question of req.questions) {
        if (question.key === "operation") {
          answers[question.key] = toAnswer(
            question.key,
            step.operation.choice,
            step.operation.probabilities,
            step.operation.confidence,
            distribution,
          );
          continue;
        }
        // **每个 head 都必须被回答**，真实模型也一样（一次请求回答全部问题）。
        // 未预设的 head 补成该 head 的第一个候选：它是「合法但无信息量」的选择，
        // 而不是缺席——缺席会让 DecisionResult.answers 的键集合与请求不一致。
        const preset = step.targets?.[question.key];
        const fallback = question.options[0]?.id ?? "";
        answers[question.key] = toAnswer(
          question.key,
          preset?.choice ?? fallback,
          undefined,
          preset?.confidence,
          distribution,
        );
      }

      return {
        answers,
        usage: syntheticUsage(),
        latencyMs: performance.now() - started,
        engine: name,
        // 深拷贝：`raw` 只进 trace，但消费方若把它当只读数据随手改，
        // 不该反过来篡改预设序列（后续步还要用同一份 options）。
        raw: structuredClone(step),
      };
    },

    async writeText(req: TextRequest, signal: AbortSignal): Promise<TextResult> {
      signal.throwIfAborted();
      if (closed) throw new Error(`${name}: 引擎已关闭，不能再生成文本。`);
      if (!supportsText) {
        throw new Error(
          `${name}: capabilities.text 为 false，但 runner 仍调用了 writeText。` +
            `runner 应当在 capabilities.text 为 false 时直接报错，而不是走到这里。`,
        );
      }

      // 文本属于**刚刚消费掉的那一步**：决策与取值是同一步的两半，
      // 因此不推进 index——否则一次 TYPE_TEXT 会吃掉两格预设。
      const step = index > 0 ? options.steps[index - 1] : undefined;
      if (step === undefined) {
        throw new Error(
          `${name}: writeText 在 decide 之前被调用。writeText 读取「最近一次已消费步骤」的 text，` +
            `因此必须紧跟一次 decide（且该步的 operation 应为 TYPE_TEXT）。`,
        );
      }

      const started = performance.now();
      return {
        // `undefined` 与 `null` 同义：这一步的目标里缺少必要信息。
        // 承认「不知道」比猜一个值好——猜错会把错误的值填进真实表单。
        text: step.text ?? null,
        usage: syntheticUsage(),
        latencyMs: performance.now() - started,
        engine: name,
      };
    },

    async close(): Promise<void> {
      closed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// 内部工具
// ---------------------------------------------------------------------------

function toAnswer(
  key: string,
  choice: string,
  probabilities: Record<string, number> | undefined,
  confidence: number | undefined,
  distribution: "full" | "degenerate",
): Answer {
  return {
    key,
    // 原样送出：即使是候选集里没有的 id，也由 core/policy.ts 的 validateChoice 拒绝。
    choice,
    // 省略时合成 one-hot。这是**测试夹具的合成值**，不代表真实分布——
    // 需要区分真假分布时用 options.probabilities = "degenerate"（见其注释）。
    probabilities: probabilities ?? { [choice]: 1 },
    distribution,
    confidence: confidence ?? DEFAULT_CONFIDENCE,
  };
}

/**
 * 一次决策 = 一个请求。
 *
 * scripted 根本不发 HTTP，这里报 `requests: 1` 是一条**约定**而不是测量：
 * 报告与预算按「逻辑调用数」推进，从而 `budget.maxModelCalls` 这类刹车
 * 在零成本链路里也会真的被触发和验证。真实引擎的 requests 则是实际请求数
 * （含重试），见 architecture.md §11.2 ⑤。
 */
function syntheticUsage(): Usage {
  return {
    inputTokens: SYNTHETIC_INPUT_TOKENS,
    outputTokens: SYNTHETIC_OUTPUT_TOKENS,
    costUsd: null,
    requests: 1,
  };
}
