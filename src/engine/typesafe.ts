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
 *
 * 实现上有三条「为什么」值得记下来（都是刻意的，不是随手写的）：
 *
 *   1. **HTTP 只在这里发生。** 不 import browser/、不持有会话、不 import playwright，
 *      因此「浏览器变更从不重试」由结构保证而不是靠纪律：本文件里根本没有 act()。
 *   2. **在途请求限流是进程级共享的**（见 `withInflight` 的注释），
 *      因为厂商限流按进程算，不按用例算。
 *   3. **凡是不知道的就不编**：不合成概率、不补 confidence 以外的东西、
 *      代价未知时 `costUsd` 记 null。概率类断言一旦建立在编出来的分布上就是假通过。
 */

import type { BudgetView, DecisionEngine, DecisionRequest, DecisionResult, Option, Question, TextRequest, TextResult } from "./types.ts";
import type { Answer } from "./types.ts";
import type { Usage } from "../schema/report.ts";
import { TEXT_VALUE } from "../core/rules.ts";
import { Semaphore } from "../util/async.ts";
import { MAX_CONTEXT_CHARS, parseTextHelperOutput } from "./text.ts";

export const TYPESAFE_ENDPOINT = "https://api.typesafe.ai/v1/systemone";

/** 会被重试的 HTTP 状态码。4xx（除 429）立即失败，绝不重试。 */
export const RETRYABLE_STATUS = [429, 503, 529] as const;

export const MAX_ATTEMPTS = 3;

/** 引擎实例名。与 `registry` 注册的名字必须一致，报告里的 `engine` 字段取它。 */
export const TYPESAFE_ENGINE_NAME = "typesafe";

/** 单次 HTTP 请求的超时。取 30s：参考项目一次完整任务约 7s，单请求不该接近这个量级。 */
const DEFAULT_TIMEOUT_MS = 30_000;

/** 首次重试前的退避基数。指数退避为 0.5s / 1s（`MAX_ATTEMPTS` 为 3）。 */
const DEFAULT_RETRY_BASE_DELAY_MS = 500;

/** 未显式给出在途上限时的兜底。registry 总会传 `settings.maxEngineInflight`。 */
const DEFAULT_MAX_INFLIGHT = 4;

/** 错误信息里附带的响应体片段长度：够定位问题，又不至于把整段东西灌进日志。 */
const ERROR_BODY_SNIPPET = 500;

/** 信封嵌套的最大搜索深度（root -> child -> grandchild）。 */
const MAX_ENVELOPE_DEPTH = 2;

/**
 * token 预算吃紧到这两个比例后，进一步裁剪 `page.text`。
 *
 * `page.text` 已由上层截断到 6000 字符，此处只在**快没钱了**的时候再砍一刀：
 * 上下文过长本身会把预算烧完，而烧完预算的结局是 `budget_exceeded`——
 * 一个「因为带得太多所以什么都做不成」的荒谬终态。宁可让最后一次决策看得少一点。
 */
const TEXT_TRIM_TIGHT_RATIO = 0.8;
const TEXT_TRIM_HARD_RATIO = 0.95;

export interface TypeSafeOptions {
  apiKey: string;
  model: string;
  /** 覆盖端点，仅用于测试 */
  endpoint?: string;
  timeoutMs?: number;
  /**
   * 文本取值小模型（OpenAI 兼容）。**未配置时 `writeText` 抛错**，绝不猜一个值。
   *
   * registry 从 `Settings.textModelApiKey / textModelBaseUrl / textModel` 映射进来；
   * 三项都在 settings 里本来就有，这里只是把它们收成一个可选组，
   * 让「有没有配」与「配了什么」不会出现半配置的中间态。
   */
  text?: { apiKey: string; baseUrl: string; model: string };
  /**
   * 在途请求上限，来自 `Settings.maxEngineInflight`。
   *
   * 之所以需要一个字段而不是读全局配置：引擎是纯网络组件，不读环境变量，
   * 配置由构造方（registry）显式注入。
   */
  maxInflight?: number;
  /** 退避基数（毫秒）。测试里设成几毫秒以免真的等 1.5 秒。 */
  retryBaseDelayMs?: number;
}

/**
 * 引擎在**网络层**的失败。
 *
 * `noBrowserActionTaken` 恒为 true，是给上层用的机器可读信号：
 * 这类错误发生在任何浏览器动作之前（决策请求本身不碰页面），
 * 因此 runner 可以放心地以 `status: "error"` 结束，而不必怀疑页面上
 * 已经发生了半截动作。消息里也写了同样一句话，方便人读日志。
 */
export class EngineRequestError extends Error {
  override readonly name: string = "EngineRequestError";
  /** 恒为 true：浏览器从未收到任何输入。 */
  readonly noBrowserActionTaken: boolean = true;

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/** 构造 TypeSafe 引擎。`close()` 关闭底层 HTTP 连接池。 */
export function createTypeSafeEngine(options: TypeSafeOptions): DecisionEngine {
  const endpoint = options.endpoint ?? TYPESAFE_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxInflight = options.maxInflight ?? DEFAULT_MAX_INFLIGHT;
  const retryBaseDelayMs = options.retryBaseDelayMs ?? DEFAULT_RETRY_BASE_DELAY_MS;
  const textModel = options.text ?? null;

  let closed = false;

  return {
    name: TYPESAFE_ENGINE_NAME,
    /**
     * `probabilities: "full"` 是本引擎的**承诺**：TypeSafe 返回的是真分布。
     * 断言层据此才敢求值概率检查（见 architecture.md §5.3）。
     * 因此响应里若没有概率，本引擎选择报错而不是合成 one-hot——见 `toAnswer`。
     *
     * `text` 反映的是**本进程配没配文本模型**：没配时 runner 遇到 TYPE_TEXT
     * 应当直接报错，绝不硬编码字段值（见 types.ts 的 EngineCapabilities）。
     */
    capabilities: { text: textModel !== null, probabilities: "full" },

    async decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResult> {
      signal.throwIfAborted();
      if (closed) throw new EngineRequestError(`${TYPESAFE_ENGINE_NAME}: 引擎已关闭，不能再发起决策。`);

      const started = performance.now();
      const body = buildDecisionBody(options.model, req);
      const { json, requests } = await postJson({
        endpoint,
        apiKey: options.apiKey,
        body,
        signal,
        timeoutMs,
        maxInflight,
        retryBaseDelayMs,
        what: "决策",
      });

      return {
        answers: mapAnswers(json, req.questions),
        usage: extractUsage(json, requests),
        latencyMs: performance.now() - started,
        engine: TYPESAFE_ENGINE_NAME,
        // 原始响应只进 trace。**绝不参与执行**：执行用的是校验过的 Answer。
        raw: json,
      };
    },

    async writeText(req: TextRequest, signal: AbortSignal): Promise<TextResult> {
      signal.throwIfAborted();
      if (closed) throw new EngineRequestError(`${TYPESAFE_ENGINE_NAME}: 引擎已关闭，不能再生成文本。`);
      if (textModel === null) {
        throw new EngineRequestError(
          `未配置文本模型，需要 TYPE_TEXT 的用例无法运行：这一步要在字段「${req.field.label}」` +
            `（role: ${req.field.role}）里输入取值，而没有文本模型就无法生成它。` +
            `请配置 TYPE_TEXT 所需的三项（见 .env.example）：textModelApiKey / textModelBaseUrl / textModel` +
            `（环境变量 JEVTEST_TEXT_MODEL_API_KEY / JEVTEST_TEXT_MODEL_BASE_URL / JEVTEST_TEXT_MODEL），` +
            `并用 \`jevtest doctor\` 复查。**绝不猜一个值。**`,
        );
      }

      const started = performance.now();
      const { json, requests } = await postJson({
        endpoint: chatCompletionsUrl(textModel.baseUrl),
        apiKey: textModel.apiKey,
        body: buildTextBody(textModel.model, req),
        signal,
        timeoutMs,
        maxInflight,
        retryBaseDelayMs,
        what: "文本取值",
      });

      const parsed = parseTextHelperOutput(readChatContent(json));
      return {
        text: parsed.text,
        usage: extractUsage(json, requests),
        latencyMs: performance.now() - started,
        engine: TYPESAFE_ENGINE_NAME,
      };
    },

    async close(): Promise<void> {
      // 这里**没有**要关的东西：HTTP 走内置 fetch，undici 的 keep-alive 连接池是
      // 进程级的，不属于某个引擎实例。保留这个方法是为了让 registry 的生命周期代码
      // 不必区分引擎类型（接口要求的空实现），而不是忘了写。
      closed = true;
    },
  };
}

// ---------------------------------------------------------------------------
// 请求构造
// ---------------------------------------------------------------------------

/**
 * 组装 SystemOne 请求体。
 *
 * 三处判断写在这里，因为它们是「IR → 线上格式」的一部分：
 *   - `questions` 的键直接用 `Question.key`（就是 `<operation>_target` 小写），
 *     因此 IR 与线上格式在键上完全一致，中间不做第二次命名映射。
 *   - 共享规则放在每个 question 的 `instructions` 里，而不是提成顶层字段——
 *     参考项目 `model.py:92,105` 给两类问题传的就是同一份规则，
 *     各问题独立求解（见 types.ts 的不变量 1）。
 *   - `budget` 如实下发（含 `state.page.text` 的裁剪决定），
 *     因为引擎是**唯一的上下文消费点**，成本控制必须发生在能看见额度的地方。
 */
function buildDecisionBody(model: string, req: DecisionRequest): Record<string, unknown> {
  return {
    model,
    state: {
      page: {
        url: req.state.url,
        title: req.state.title,
        text: trimPageText(req.state.text, req.budget),
      },
      // 元素表原样透传：它的字段名（index/label/role/operations/options）
      // 已经就是「给模型看的形状」，多一层改名只会多一处漂移的地方。
      elements: req.state.elements,
      recent_actions: req.state.recentActions.map((entry) => ({
        action: entry.action,
        kind: entry.kind,
        text: entry.text,
        page_changed: entry.pageChanged,
      })),
    },
    questions: Object.fromEntries(req.questions.map((q) => [q.key, toQuestionPayload(q, req)])),
    // 只发这三个顶层键。`BudgetView` **不进请求体**——它只用于本地裁剪上下文
    // （见 trimPageText）：上游的 body 恰好是 model / state / questions 三个键，
    // 多一个就是给一个严格校验的服务端多一个拒绝的理由，而它有且只有一个
    // 模糊的报错（Invalid request.），排查代价全在我们这一侧。
  };
}

/**
 * 一个问题的载荷。**形状照搬 `model.py:96-115`，一处不改。**
 *
 * 两个容易想当然的地方：
 *   - `criteria` 是**以候选 id 为键的对象**，不是候选数组。operation 问题的值是一句
 *     操作说明（字符串），target 问题的值是一个对象（`element` + `current_value` + 属性）。
 *   - `instructions.rules` 在 operation 问题上是**字符串**，在 target 问题上是**数组**
 *     （`[NEXT_ACTION, TARGET]`）。这不是笔误，上游就是这样。
 *
 * 这两条差别曾让我们付出一次真跑的代价：请求体形状不对时服务端只回
 * `400 api_usage_error: Invalid request.`，既不说是哪个字段，也不像认证错误那样
 * 好定位——而假 key 会回 401，所以「认证过了」并不代表「请求对」。
 */
function toQuestionPayload(question: Question, req: DecisionRequest): Record<string, unknown> {
  const isOperation = question.key === "operation";
  return {
    type: "choice",
    criteria: Object.fromEntries(
      question.options.map((option) => [
        option.id,
        isOperation ? option.label : targetCriteriaValue(option),
      ]),
    ),
    instructions: {
      goal: req.goal,
      ...(isOperation ? {} : { operation: operationOfQuestion(question.key) }),
      // operation 问题：上游只给共享规则（字符串）；target 问题：共享规则 + TARGET。
      rules: isOperation ? question.prompt : [...req.rules, question.prompt],
    },
  };
}

/** `<operation>_target` -> `CLICK` / `TYPE_TEXT` / `SELECT`。 */
function operationOfQuestion(key: string): string {
  return key.replace(/_target$/, "").toUpperCase();
}

/** target 候选的值：上游是 `{element, current_value, role/checked/selected/expanded?}`。 */
function targetCriteriaValue(option: Option): Record<string, unknown> {
  const detail = option.detail;
  const value = detail["value"];
  const criteria: Record<string, unknown> = {
    element: option.label,
    current_value: typeof value === "string" ? value : "",
  };
  // 只带上确实存在的属性：`null` 与 `""` 会被当成「这个字段有值」，
  // 而模型的判断依据是「有没有这个属性」。
  for (const key of ["role", "checked", "selected", "expanded"] as const) {
    const attribute = detail[key];
    if (attribute !== undefined && attribute !== null && attribute !== "") criteria[key] = attribute;
  }
  return criteria;
}

function trimPageText(text: string, budget: BudgetView): string {
  if (budget.maxInputTokens <= 0) return text;
  const used = budget.inputTokensUsed / budget.maxInputTokens;
  const limit =
    used >= TEXT_TRIM_HARD_RATIO
      ? Math.floor(MAX_CONTEXT_CHARS / 6)
      : used >= TEXT_TRIM_TIGHT_RATIO
        ? Math.floor(MAX_CONTEXT_CHARS / 2)
        : Number.POSITIVE_INFINITY;
  return text.length <= limit ? text : text.slice(0, limit);
}

// ---------------------------------------------------------------------------
// HTTP：重试与限流
// ---------------------------------------------------------------------------

interface PostOptions {
  endpoint: string;
  apiKey: string;
  body: unknown;
  signal: AbortSignal;
  timeoutMs: number;
  maxInflight: number;
  retryBaseDelayMs: number;
  /** 出错信息里的人话名字：「决策」/「文本取值」 */
  what: string;
}

/**
 * 一次 HTTP 尝试的结果。
 *
 * 刻意做成两个分支而不是一个带可选字段的宽对象：只有成功分支才带响应体，
 * 也只有它才需要解析 JSON。合成一个 `{status?, raw?}` 会让「成功但没体」
 * 变成一种需要判断的状态——而它根本不存在。
 */
type AttemptOutcome =
  | { kind: "ok"; raw: string }
  | { kind: "status"; status: number; statusText: string; responseSnippet: string };

/**
 * 发一次 JSON POST，必要时重试。返回**实际发出的请求数**（含重试）。
 *
 * 重试规则严格照 docs 与 types.ts 的定案：**只有 429 / 503 / 529 会重试**，
 * 退避 0.5s / 1s，至多 `MAX_ATTEMPTS` 次。两点刻意的选择：
 *
 *   - **网络故障（DNS 失败、连接重置）不重试。** 契约枚举了可重试的条件，
 *     「请求有没有到达服务端」在客户端无法判定；把不确定的情形当成可重试，
 *     等于把「一次决策」变成最多三次计费。这条不确定性交给 runner 以 error 结束。
 *   - **超时不重试。** 超时的请求很可能仍在服务端执行，重试就是重复计费；
 *     而且从预算角度看，一次已经花掉 30 秒的重试会把 `maxElapsedMs` 直接吃光。
 *
 * `Retry-After` 目前不解析（P1）：厂商给的头需要与退避策略合并取大者，
 * 而现有契约只写了指数退避，先照契约做，不自行发挥。
 */
async function postJson(o: PostOptions): Promise<{ json: unknown; requests: number }> {
  if (o.apiKey.trim().length === 0) {
    throw new EngineRequestError(
      `${o.what}请求无法发出：未配置 API key，没有任何浏览器动作被执行。` +
        `请设置 TYPESAFE_API_KEY（文本模型则是 JEVTEST_TEXT_MODEL_API_KEY），并用 \`jevtest doctor\` 复查。`,
    );
  }

  let requests = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    requests += 1; // **在 fetch 之前计数**：预算刹车必须数到那些没回来的请求。

    // 许可只覆盖「一次真实的 HTTP 往返」（含读体），不覆盖退避等待——
    // 否则重试等待会白占一个名额，把限流变成对并发度的无谓压制。
    const outcome = await withInflight(o.maxInflight, async (): Promise<AttemptOutcome> => {
      // 超时信号必须**在拿到许可之后**才创建，且每次尝试各用一个：
      //   - 在许可之前创建，排队等待就会消耗请求自己的超时预算。一个在闸门前
      //     排了 200ms 的请求会带着只剩 100ms 的信号发出去，然后报「请求超时」——
      //     而它可能刚刚才离开本进程。错误信息与事实不符，排查方向会被带偏。
      //   - 跨尝试复用同一个，则第一次尝试花掉的时间会算进第二次的预算，
      //     重试永远没有机会成功。
      const timeoutSignal = AbortSignal.timeout(o.timeoutMs);
      const composed = AbortSignal.any([o.signal, timeoutSignal]);

      let response: Response;
      try {
        response = await fetch(o.endpoint, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${o.apiKey}`,
          },
          body: JSON.stringify(o.body),
          signal: composed,
        });
      } catch (error) {
        throw transportError(o, error, timeoutSignal);
      }

      if (response.ok) {
        try {
          return { kind: "ok", raw: await response.text() };
        } catch (error) {
          // 读体阶段被中止（超时/取消）与发送阶段同性质，因此走同一映射。
          throw transportError(o, error, timeoutSignal);
        }
      }
      return {
        kind: "status",
        status: response.status,
        statusText: response.statusText,
        responseSnippet: await safeText(response),
      };
    });

    if (outcome.kind === "ok") return { json: parseBodyOrThrow(outcome.raw, o), requests };

    if (isRetryable(outcome.status) && attempt < MAX_ATTEMPTS) {
      await backoff(attempt, o);
      continue;
    }

    throw new EngineRequestError(
      `${o.what}请求被拒绝：HTTP ${outcome.status}${outcome.statusText ? ` ${outcome.statusText}` : ""}` +
        `（${o.endpoint}）。**没有任何浏览器动作被执行。**` +
        (isRetryable(outcome.status)
          ? `已重试 ${requests - 1} 次仍失败（上限 ${MAX_ATTEMPTS} 次尝试）。`
          : `该状态码不在可重试集合 [${RETRYABLE_STATUS.join(", ")}] 内，因此立即失败、不重试。`) +
        (outcome.responseSnippet ? `响应片段：${outcome.responseSnippet}` : ""),
    );
  }

  // 循环只可能通过 return 或 throw 退出；这行只为让类型与「到达上限」这条语义显式。
  throw new EngineRequestError(`${o.what}请求失败：已尝试 ${requests} 次仍无结果。**没有任何浏览器动作被执行。**`);
}

async function backoff(attempt: number, o: PostOptions): Promise<void> {
  const delay = o.retryBaseDelayMs * 2 ** (attempt - 1);
  if (delay <= 0) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      o.signal.removeEventListener("abort", onAbort);
      resolve();
    }, delay);
    function onAbort(): void {
      clearTimeout(timer);
      reject(
        new EngineRequestError(
          `${o.what}请求的退避等待被取消，后续尝试不再发出。**没有任何浏览器动作被执行。**`,
          { cause: o.signal.reason },
        ),
      );
    }
    o.signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * 把「发不出去 / 收不回来」翻译成一条能让人断定「页面没被碰过」的错误。
 *
 * 区分取消与超时不是为了措辞好看：取消是用户意图（runner 以 cancelled 收尾），
 * 超时是环境问题（runner 以 error 收尾），两者的排查方向完全不同。
 */
function transportError(o: PostOptions, error: unknown, timeoutSignal: AbortSignal): EngineRequestError {
  const detail = error instanceof Error ? error.message : String(error);
  if (o.signal.aborted) {
    return new EngineRequestError(
      `${o.what}请求已被取消（用户停止或进程停机），**没有任何浏览器动作被执行**：${detail}`,
      { cause: error },
    );
  }
  if (timeoutSignal.aborted) {
    return new EngineRequestError(
      `${o.what}请求超时（超过 ${o.timeoutMs} ms，${o.endpoint}），**没有任何浏览器动作被执行**：${detail}`,
      { cause: error },
    );
  }
  return new EngineRequestError(
    `${o.what}请求未能送达 ${o.endpoint}（网络故障，按既定策略不重试），**没有任何浏览器动作被执行**：${detail}`,
    { cause: error },
  );
}

/**
 * 在途请求限流。**信号量是模块级共享的**，这一点很关键：
 *
 * 厂商侧的限流是**每进程**的，不是每个用例一份。若每个引擎实例各持一个信号量，
 * 那么 N 个并发用例就会同时发出 N × maxEngineInflight 个请求——
 * 限流形同虚设，反而在并发越高的时候（也正是最需要保护厂商的时候）越发失效。
 * 因此这里按「许可数」缓存一个进程内单例：`settings.maxEngineInflight` 是全局配置，
 * 值相同就复用同一个闸门。
 *
 * 关于降级：限流原语不可用时**放行而不是让请求失败**。信号量只影响我们对厂商
 * 有多礼貌，不影响单次请求的正确性；而它的失败会让**每一个**决策请求都失败，
 * 把整条链路拖垮的代价远大于暂时超发。`held` 标记保证获取失败时绝不归还，
 * 否则会凭空增加许可数。
 */
let inflightGate: Semaphore | null = null;
let inflightGatePermits = -1;

function gateFor(permits: number): Semaphore {
  if (inflightGate === null || inflightGatePermits !== permits) {
    inflightGate = new Semaphore(permits);
    inflightGatePermits = permits;
  }
  return inflightGate;
}

async function withInflight<T>(permits: number, task: () => Promise<T>): Promise<T> {
  let gate: Semaphore | null = null;
  try {
    gate = gateFor(permits);
  } catch {
    gate = null;
  }

  let held = false;
  if (gate !== null) {
    try {
      await gate.acquire();
      held = true;
    } catch {
      held = false;
    }
  }

  try {
    return await task();
  } finally {
    if (held && gate !== null) gate.release();
  }
}

// ---------------------------------------------------------------------------
// 响应解析
// ---------------------------------------------------------------------------

/**
 * 把响应映射回 `answers: Record<string, Answer>`。
 *
 * **信封容错，叶子严格。** 这条边界是刻意的：
 *
 *   - 信封（答案表挂在 `questions` / `answers` 还是 `result.questions` 下）
 *     属于传输约定，猜错一次就整轮失败，因此做有限度的搜索：先找「同时含全部
 *     问题键」的对象（它一定是答案表），退而求其次找「含任一问题键」的。
 *   - 叶子（每个问题的 `{choice, probabilities, confidence}`）**不做兼容**：
 *     `distribution: "full"` 是引擎对断言层的承诺，缺概率时合成 one-hot
 *     会直接导致概率类断言**假通过**（architecture.md §5.3 要防的正是这个）。
 *     所以宁可报错，也不补一个编出来的分布。
 *
 * 请求过的问题必须**全部**有答案：`DecisionResult.answers` 的键集合与请求一致
 * 是 types.ts 写死的不变量，缺项时填第一项会让「谁在替模型做决定」变得含糊。
 */
function mapAnswers(body: unknown, questions: Question[]): Record<string, Answer> {
  const keys = questions.map((q) => q.key);
  const container = findAnswersContainer(body, keys);
  if (container === null) {
    throw new EngineRequestError(
      `TypeSafe 响应里找不到任何问题答案（期望的键：${keys.join(" / ")}），收到的是 ${describe(body)}。` +
        `**没有任何浏览器动作被执行。**`,
    );
  }

  const answers: Record<string, Answer> = {};
  const missing: string[] = [];
  for (const question of questions) {
    const raw = container[question.key];
    if (raw === undefined) {
      missing.push(question.key);
      continue;
    }
    answers[question.key] = toAnswer(question.key, raw);
  }

  if (missing.length > 0) {
    throw new EngineRequestError(
      `TypeSafe 响应缺少 ${missing.length} 个问题的答案：${missing.join(", ")}。` +
        `每个问题都必须被回答（answers 的键集合必须与请求一致），因此这次响应整体不可用。` +
        `**没有任何浏览器动作被执行。**`,
    );
  }
  return answers;
}

function toAnswer(key: string, raw: unknown): Answer {
  if (!isPlainObject(raw)) {
    throw new EngineRequestError(
      `问题 "${key}" 的答案形状不对：期望 {choice, probabilities, confidence} 对象，收到 ${describe(raw)}。` +
        `缺概率时合成分布会让概率类断言假通过，因此这里报错而不是补一个值。**没有任何浏览器动作被执行。**`,
    );
  }

  const choice = readChoice(raw, key);
  const probabilities = readProbabilities(raw, key);
  return {
    key,
    choice,
    probabilities,
    // TypeSafe 给的是真分布，这正是本引擎声明 capabilities.probabilities = "full" 的依据。
    distribution: "full",
    confidence: readConfidence(raw, choice, probabilities),
  };
}

function readChoice(raw: Record<string, unknown>, key: string): string {
  const value = raw["choice"] ?? raw["answer"];
  if (typeof value === "string") return value;
  // 数字也要接受：`3` 与 `"3"` 是同一个候选 id，而各厂商对「索引是数字还是字符串」
  // 并不统一。转换**不改变语义**，只是把表示法归一。
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  throw new EngineRequestError(
    `问题 "${key}" 的 choice 不是字符串或数字（收到 ${describe(value)}）。**没有任何浏览器动作被执行。**`,
  );
}

function readProbabilities(raw: Record<string, unknown>, key: string): Record<string, number> {
  const value = raw["probabilities"] ?? raw["probs"];
  if (value === undefined) {
    throw new EngineRequestError(
      `问题 "${key}" 的答案里没有 probabilities。TypeSafe 承诺返回真分布（distribution: "full"），` +
        `缺了它就只能合成 one-hot，而合成的分布会让概率类断言假通过——因此这次响应判为不可用。` +
        `**没有任何浏览器动作被执行。**`,
    );
  }
  if (!isPlainObject(value)) {
    throw new EngineRequestError(
      `问题 "${key}" 的 probabilities 不是对象（收到 ${describe(value)}）。**没有任何浏览器动作被执行。**`,
    );
  }

  const probabilities: Record<string, number> = {};
  for (const [optionId, entry] of Object.entries(value)) {
    if (typeof entry !== "number" || !Number.isFinite(entry)) {
      // 类型层面的问题：`Answer.probabilities` 是 Record<string, number>，字符串概率无法表达。
      throw new EngineRequestError(
        `问题 "${key}" 的概率里 "${optionId}" 不是有限数（收到 ${describe(entry)}）。**没有任何浏览器动作被执行。**`,
      );
    }
    // 注意：**不做归一化、不校验取值范围与和**。那是 core/policy.ts 的 validateChoice 的职责
    // （键集合匹配、0≤p≤1、和为 1、choice 是最大值）。引擎在这里"顺手修正"，
    // 等于把校验绕过去——而校验正是本项目安全边界所在。
    probabilities[optionId] = entry;
  }
  return probabilities;
}

/**
 * 置信度。缺失时退化为「所选候选的概率」。
 *
 * 这是与概率相反的处理，理由也相反：概率缺失无法在不撒谎的前提下补，
 * 而置信度只用于展示与质量参考，没有安全语义；此时「所选候选的概率」
 * 是唯一有依据的估计。真的什么都没有时给 0——0 在这里是诚实的：
 * 我们对这次回答一无所知。
 */
function readConfidence(raw: Record<string, unknown>, choice: string, probabilities: Record<string, number>): number {
  const value = raw["confidence"];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const fallback = probabilities[choice];
  return typeof fallback === "number" && Number.isFinite(fallback) ? fallback : 0;
}

/**
 * 找出答案表。
 *
 * 先找含**全部**问题键的对象：那必然是答案表，而不是碰巧内嵌了同名键的元数据。
 * 找不到再退一步找含任一问题键的（部分响应时给出的错误信息更准确）。
 */
function findAnswersContainer(body: unknown, keys: string[]): Record<string, unknown> | null {
  const candidates = collectPlainObjects(body, MAX_ENVELOPE_DEPTH);
  const complete = candidates.filter((candidate) => keys.every((key) => key in candidate));

  // 「含全部问题键」还不够：我们自己发出去的请求体里也有一个这样的对象
  // （`questions` 的每个键下是 `{type, criteria, instructions}`）。服务端只要把请求
  // 回显在响应里，而它又排在真正的答案表之前，就会被选中，然后在叶子形状上报错——
  // 一次本可成功的决策毁在信封选择上。所以先按「叶子像不像答案」筛一遍。
  const answerShaped = complete.find((candidate) => keys.every((key) => looksLikeAnswerLeaf(candidate[key])));
  if (answerShaped !== undefined) return answerShaped;

  // 没有像答案的，就按原规则取第一个（后续的叶子校验会给出更准确的错误信息）。
  const first = complete[0];
  if (first !== undefined) return first;
  return candidates.find((candidate) => keys.some((key) => key in candidate)) ?? null;
}

/**
 * 这个值看起来是不是一个答案叶子。
 *
 * 判据与 `readChoice` 完全一致（`choice` 或 `answer`，字符串或数字）——不一致的话，
 * 这里选中、那里报错，信封容错就成了自相矛盾的两套标准。
 */
function looksLikeAnswerLeaf(value: unknown): boolean {
  if (!isPlainObject(value)) return false;
  const choice = value["choice"] ?? value["answer"];
  return typeof choice === "string" || (typeof choice === "number" && Number.isFinite(choice));
}

function collectPlainObjects(root: unknown, maxDepth: number): Record<string, unknown>[] {
  const found: Record<string, unknown>[] = [];
  const queue: { value: unknown; depth: number }[] = [{ value: root, depth: 0 }];
  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    if (!isPlainObject(item.value)) continue;
    found.push(item.value);
    if (item.depth >= maxDepth) continue;
    for (const child of Object.values(item.value)) {
      queue.push({ value: child, depth: item.depth + 1 });
    }
  }
  return found;
}

/**
 * 用量。**未报的项记 0，未报的金额记 null**——后者是 report.ts 定下的口径：
 * 不用 0 冒充「未知」，否则 `budget.maxCostUsd` 看起来被验过了。
 *
 * `requests` 一律用**实际发出的请求数**（含重试）。这是预算刹车成立的前提：
 * 按逻辑决策数算的话，重试就是一条免费通道（architecture.md §11.2 ⑤）。
 */
function extractUsage(body: unknown, requests: number): Usage {
  const usage = findUsageObject(body);
  return {
    inputTokens: readCount(usage, ["input_tokens", "inputTokens", "prompt_tokens", "promptTokens"]),
    outputTokens: readCount(usage, ["output_tokens", "outputTokens", "completion_tokens", "completionTokens"]),
    costUsd: readCost(usage, ["cost_usd", "costUsd", "total_cost_usd", "totalCostUsd", "cost"]),
    requests,
  };
}

function findUsageObject(body: unknown): Record<string, unknown> | null {
  if (!isPlainObject(body)) return null;
  for (const key of ["usage", "usage_metadata", "usageMetadata"]) {
    const direct = body[key];
    if (isPlainObject(direct)) return direct;
  }
  for (const envelope of ["result", "data", "meta"]) {
    const nested = body[envelope];
    if (!isPlainObject(nested)) continue;
    for (const key of ["usage", "usage_metadata", "usageMetadata"]) {
      const value = nested[key];
      if (isPlainObject(value)) return value;
    }
  }
  return null;
}

function readCount(usage: Record<string, unknown> | null, aliases: string[]): number {
  if (usage === null) return 0;
  for (const alias of aliases) {
    const value = usage[alias];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return Math.floor(value);
  }
  return 0;
}

function readCost(usage: Record<string, unknown> | null, aliases: string[]): number | null {
  if (usage === null) return null;
  for (const alias of aliases) {
    const value = usage[alias];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
  }
  return null;
}

// ---------------------------------------------------------------------------
// 文本小模型（OpenAI 兼容）
// ---------------------------------------------------------------------------

/**
 * 归一成 chat completions 的 URL。
 *
 * `Settings.textModelBaseUrl` 在两种写法之间都可能：`https://host/v1`
 * （照 OpenAI 的习惯）或已经带全路径的 `https://host/v1/chat/completions`（照自建网关的习惯）。
 * 两种都接受，而不是要求用户改成其中一种——这个字段是给用户填的，
 * 猜错格式的表现是 404，而 404 的排查成本远高于这里多写一行。
 */
function chatCompletionsUrl(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, "");
  return trimmed.endsWith("/chat/completions") ? trimmed : `${trimmed}/chat/completions`;
}

function buildTextBody(model: string, req: TextRequest): Record<string, unknown> {
  return {
    model,
    // 取值是「把语义翻译成一个字符串」的确定性任务，不需要采样。
    // temperature 固定为 0 也让同一上下文的重放更可预期（缓存命中时更不容易出现差异）。
    temperature: 0,
    // 刻意**不加** `response_format: {type: "json_object"}`：部分 OpenAI 兼容端点
    // 见到不认识的参数会直接 400，而这个字段带来的收益（格式约束）已经由
    // TEXT_VALUE 提示词 + parseTextHelperOutput 的严校验承担了。
    messages: [
      { role: "system", content: TEXT_VALUE },
      { role: "user", content: buildTextUserMessage(req) },
    ],
  };
}

/** 把 helper 输入排成一段人类可读的上下文。字段顺序固定，便于排查与回归对比。 */
function buildTextUserMessage(req: TextRequest): string {
  const lines: string[] = [
    `Goal: ${req.goal}`,
    "",
    `Field to fill: ${req.field.label} (role: ${req.field.role})`,
    `Current value: ${req.field.value === "" ? "(empty)" : JSON.stringify(req.field.value)}`,
  ];

  if (req.recentActions.length > 0) {
    lines.push("", "Recent actions (oldest first):");
    req.recentActions.forEach((entry, i) => {
      const changed = entry.pageChanged === null ? "unknown" : entry.pageChanged ? "yes" : "no";
      lines.push(`${i + 1}. ${entry.kind} ${entry.action}${entry.text === null ? "" : ` → ${JSON.stringify(entry.text)}`} (page changed: ${changed})`);
    });
  }

  lines.push("", `Page: ${req.page.title}`, req.page.text);
  return lines.join("\n");
}

/** 取 chat completions 的正文。`choices[0].message.content` 与 `choices[0].text` 都接受。 */
function readChatContent(body: unknown): string {
  if (!isPlainObject(body)) {
    throw new EngineRequestError(`文本模型返回的不是 JSON 对象（收到 ${describe(body)}）：无法取出 text。`);
  }
  const choices = body["choices"];
  if (!Array.isArray(choices) || choices.length === 0) {
    throw new EngineRequestError(
      `文本模型响应里没有 choices（收到 ${describe(choices)}）。**没有任何浏览器动作被执行。**`,
    );
  }
  const first = choices[0];
  if (!isPlainObject(first)) {
    throw new EngineRequestError(`文本模型响应的 choices[0] 不是对象（收到 ${describe(first)}）。`);
  }
  const message = first["message"];
  if (isPlainObject(message)) {
    const content = message["content"];
    if (typeof content === "string") return content;
    throw new EngineRequestError(
      `文本模型的 message.content 不是字符串（收到 ${describe(content)}）。` +
        `若该端点只返回 tool_calls 或分段内容，需要在本引擎里显式支持，而不是从里面猜一段文本出来。`,
    );
  }
  const text = first["text"];
  if (typeof text === "string") return text;
  throw new EngineRequestError(`文本模型的响应里既没有 message.content 也没有 text（choices[0] 的键：${Object.keys(first).join(", ") || "(无)"}）。`);
}

// ---------------------------------------------------------------------------
// 杂项
// ---------------------------------------------------------------------------

/** 解析响应体。解析失败说明响应不是这次请求的答案，宁可报错也不猜。 */
function parseBodyOrThrow(raw: string, o: PostOptions): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new EngineRequestError(
      `${o.what}请求的响应不是合法 JSON（前 200 字符：${snippet(raw)}）。**没有任何浏览器动作被执行。**`,
    );
  }
}

async function safeText(response: Response): Promise<string> {
  try {
    return snippet(await response.text());
  } catch {
    return "";
  }
}

function isRetryable(status: number): boolean {
  // `RETRYABLE_STATUS` 是 `as const` 的元组，直接 includes(number) 会被 TS 拒绝，
  // 而它的类型是要保留的（对外是精确的枚举）。这里只放宽读取端的类型。
  return (RETRYABLE_STATUS as readonly number[]).includes(status);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function snippet(raw: string): string {
  const oneLine = raw.replace(/\s+/g, " ").trim();
  return oneLine.length > ERROR_BODY_SNIPPET ? `${oneLine.slice(0, ERROR_BODY_SNIPPET)}…` : oneLine;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `数组(长度 ${value.length})`;
  if (typeof value === "object") return `对象(键：${Object.keys(value as Record<string, unknown>).join(", ") || "(无)"})`;
  return `${typeof value} ${JSON.stringify(value)}`;
}
