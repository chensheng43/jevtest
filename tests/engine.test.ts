/**
 * TypeSafe 引擎的行为锁定。**全部走本地 `node:http` 假端点，绝不发外网请求。**
 *
 * `TypeSafeOptions.endpoint` 就是为这件事预留的。这个文件守的是几件「坏了不会报错、
 * 只会让报告失真或让钱悄悄花掉」的性质：
 *
 *   1. **重试边界**：只有 429 / 503 / 529 重试，退避 0.5s / 1s，至多 3 次尝试；
 *      400 立即失败。重试错一次的成本是重复计费 + 一个已经烧掉的时间预算。
 *   2. **`Usage.requests` 是实际请求数（含重试）**。按逻辑决策数算的话，
 *      重试就是一条免费通道——预算刹车在最需要它的场景下失效（§11.2 ⑤）。
 *   3. **取消能真的中断在途请求**，而不是等它超时。用户点「停止」之后
 *      还在为一次没人要的决策付费，是这类平台最容易招人骂的行为。
 *   4. **在途限流真的接上了**（`settings.maxEngineInflight`）。限流没接上时
 *      一切照常工作，只是并发越高越容易把厂商打爆——没有任何症状。
 *   5. **叶子严格**：响应缺概率时报错，而不是合成 one-hot。合成的分布会让
 *      概率类断言**假通过**（§5.3），比报错危险得多。
 */

import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";

import { NEXT_ACTION, TARGET, TEXT_VALUE } from "../src/core/rules.ts";
import { constantSteps, createScriptedEngine } from "../src/engine/scripted.ts";
import {
  EngineRequestError,
  MAX_ATTEMPTS,
  RETRYABLE_STATUS,
  TYPESAFE_ENDPOINT,
  createTypeSafeEngine,
} from "../src/engine/typesafe.ts";
import type { DecisionRequest, TextRequest } from "../src/engine/types.ts";
import { failedCallUsage } from "../src/engine/types.ts";
import type { TypeSafeOptions } from "../src/engine/typesafe.ts";

// ---------------------------------------------------------------------------
// 假端点
// ---------------------------------------------------------------------------

interface RecordedRequest {
  path: string;
  method: string;
  authorization: string | undefined;
  contentType: string | undefined;
  body: unknown;
}

interface Reply {
  status: number;
  json?: unknown;
  /** 直接给原始字符串体（用于「不是合法 JSON」的用例） */
  raw?: string;
  /** 收到请求后先等这么久再回，用来制造在途窗口 */
  delayMs?: number;
  /** 直接掐掉连接，模拟网络故障 */
  destroy?: boolean;
}

type Handler = (request: RecordedRequest, index: number) => Reply;

interface FakeEndpoint {
  endpoint: string;
  requests: RecordedRequest[];
  /** 服务端观测到的同时在处理的请求数峰值 */
  peakConcurrency: () => number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 起一个本地假端点。
 *
 * 记录**请求到达的顺序与原始体**，因为「重试了几次、重试时发了什么」只能从
 * 服务端这一侧看到——客户端说「我重试了」不算证据。
 */
async function startEndpoint(t: TestContext, handler: Handler): Promise<FakeEndpoint> {
  const requests: RecordedRequest[] = [];
  let inFlight = 0;
  let peak = 0;

  const server: Server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // 先登记再读体：`destroy` 那类回复不读体，但这次尝试必须被数到。
    const record: RecordedRequest = {
      path: req.url ?? "",
      method: req.method ?? "",
      authorization: req.headers.authorization,
      contentType: req.headers["content-type"] as string | undefined,
      body: null,
    };
    requests.push(record);
    const index = requests.length - 1;

    // 客户端中止后我们仍可能往一个已死的 socket 写；不接住这些错误，
    // 一个正常的「取消」用例就会以进程崩溃收场。
    req.on("error", () => {});
    res.on("error", () => {});

    void (async () => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      try {
        const reply = handler(record, index);
        if (reply.destroy) {
          req.socket.destroy();
          return;
        }
        const chunks: Buffer[] = [];
        for await (const chunk of req) chunks.push(chunk as Buffer);
        const raw = Buffer.concat(chunks).toString("utf8");
        try {
          record.body = raw === "" ? null : (JSON.parse(raw) as unknown);
        } catch {
          record.body = raw;
        }

        if (reply.delayMs !== undefined) await sleep(reply.delayMs);
        res.statusCode = reply.status;
        res.setHeader("content-type", "application/json");
        res.end(reply.raw ?? JSON.stringify(reply.json ?? {}));
      } catch {
        res.destroy();
      } finally {
        inFlight -= 1;
      }
    })();
  });

  // 不接住 clientError 时，一次被中止的请求会以 unhandled 'clientError' 冒出来。
  server.on("clientError", (_error, socket) => socket.destroy());

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("假端点没有拿到端口");

  t.after(async () => {
    // 必须主动掐掉 keep-alive 连接：fetch 会留着它们，`close()` 会一直等下去，
    // 整个测试进程就挂在这里了。
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    requests,
    peakConcurrency: () => peak,
  };
}

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function decisionRequest(): DecisionRequest {
  return {
    goal: "在 Wikipedia 上打开 Gödel 的条目",
    rules: [NEXT_ACTION],
    state: {
      url: "https://en.wikipedia.org/",
      title: "Wikipedia, the free encyclopedia",
      text: "The Free Encyclopedia",
      textTruncated: false,
      notices: [],
      elements: [{ index: "3", label: "Search", role: "combobox", value: "", operations: ["TYPE_TEXT"] }],
      recentActions: [{ action: "CLICK [12] link Wikipedia", kind: "click", text: null, pageChanged: true }],
      omittedActions: 0,
    },
    questions: [
      {
        key: "operation",
        prompt: NEXT_ACTION,
        options: [
          { id: "CLICK", label: "CLICK", detail: {} },
          { id: "TYPE_TEXT", label: "TYPE_TEXT", detail: {} },
          { id: "DONE", label: "DONE", detail: {} },
        ],
      },
      {
        key: "click_target",
        prompt: TARGET,
        options: [
          { id: "1", label: "[1] link Gödel", detail: { kind: "click" } },
          { id: "2", label: "[2] link Escher", detail: { kind: "click" } },
        ],
      },
      {
        key: "type_text_target",
        prompt: TARGET,
        options: [{ id: "3", label: "[3] combobox Search", detail: { kind: "fill" } }],
      },
    ],
    budget: {
      stepsUsed: 2,
      maxSteps: 40,
      modelCallsUsed: 3,
      maxModelCalls: 40,
      inputTokensUsed: 1000,
      maxInputTokens: 200_000,
      elapsedMs: 4000,
      maxElapsedMs: 300_000,
    },
  };
}

/** 一份「一切正常」的 SystemOne 响应。 */
function okBody(): Record<string, unknown> {
  return {
    questions: {
      operation: { choice: "CLICK", probabilities: { CLICK: 0.7, TYPE_TEXT: 0.2, DONE: 0.1 }, confidence: 0.7 },
      click_target: { choice: "1", probabilities: { "1": 0.9, "2": 0.1 }, confidence: 0.9 },
      type_text_target: { choice: "3", probabilities: { "3": 1 }, confidence: 1 },
    },
    usage: { input_tokens: 1200, output_tokens: 30, cost_usd: 0.00042 },
  };
}

function textRequest(): TextRequest {
  return {
    goal: "在 Wikipedia 上搜索 Gödel",
    field: { label: "Search", role: "combobox", value: "" },
    page: { title: "Wikipedia", text: "The Free Encyclopedia" },
    recentActions: [{ action: "CLICK [12] link Wikipedia", kind: "click", text: null, pageChanged: true }],
  };
}

function chatBody(content: string): Record<string, unknown> {
  return {
    choices: [{ index: 0, message: { role: "assistant", content } }],
    usage: { prompt_tokens: 500, completion_tokens: 8 },
  };
}

/** 引擎配置：除被覆盖的项外，其余都取「不等待」的测试值（退避 1ms）。 */
function engineOptions(endpoint: string, over: Partial<TypeSafeOptions> = {}): TypeSafeOptions {
  const base: TypeSafeOptions = { apiKey: "test-key", model: "jev-latest", endpoint, retryBaseDelayMs: 1 };
  return Object.assign(base, over);
}

// ---------------------------------------------------------------------------
// 成功路径与请求形状
// ---------------------------------------------------------------------------

test("200：答案、用量、（含重试的）请求数都被正确映射", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody() }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const result = await engine.decide(decisionRequest(), new AbortController().signal);

  assert.equal(engine.name, "typesafe");
  assert.equal(result.engine, "typesafe");
  assert.equal(result.usage.requests, 1);
  assert.equal(result.usage.inputTokens, 1200);
  assert.equal(result.usage.outputTokens, 30);
  assert.equal(result.usage.costUsd, 0.00042);
  assert.ok(result.latencyMs >= 0);

  // 每个问题都必须被回答，键集合与请求一致。
  assert.deepEqual(Object.keys(result.answers).sort(), ["click_target", "operation", "type_text_target"]);
  assert.equal(result.answers["operation"]?.choice, "CLICK");
  assert.equal(result.answers["operation"]?.distribution, "full");
  assert.deepEqual(result.answers["operation"]?.probabilities, { CLICK: 0.7, TYPE_TEXT: 0.2, DONE: 0.1 });
  assert.equal(result.answers["operation"]?.confidence, 0.7);
  assert.equal(result.answers["click_target"]?.choice, "1");

  // 原始响应只进 trace，因此必须是完整的、可深比较的一份。
  assert.deepEqual(result.raw, okBody());
  await engine.close();
});

test("请求形状：一次带全部问题、rules 与元素表原样下发、budget 如实透传", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody() }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { apiKey: "secret" }));
  const request = decisionRequest();

  await engine.decide(request, new AbortController().signal);

  const sent = endpoint.requests[0];
  assert.equal(sent?.method, "POST");
  assert.equal(sent?.authorization, "Bearer secret");
  assert.equal(sent?.contentType, "application/json");

  const body = sent?.body as Record<string, any>;
  assert.equal(body["model"], "jev-latest");
  assert.deepEqual(
    Object.keys(body["questions"] as object),
    ["operation", "click_target", "type_text_target"],
    "questions 的键就是 Question.key（<operation>_target 小写），中间不做第二次改名",
  );
  // criteria 是**以候选 id 为键的对象**，不是候选数组（上游 model.py:96-115 的形状）。
  // operation 问题的值是一句操作说明；target 问题的值是 {element, current_value, ...}。
  assert.deepEqual(body["questions"]["operation"].criteria, {
    CLICK: "CLICK",
    TYPE_TEXT: "TYPE_TEXT",
    DONE: "DONE",
  });
  assert.deepEqual(body["questions"]["click_target"].criteria, {
    "1": { element: "[1] link Gödel", current_value: "" },
    "2": { element: "[2] link Escher", current_value: "" },
  });
  // instructions：operation 问题的 rules 是**字符串**，target 问题是**数组**。
  // 这个不对称不是笔误，上游就是这样——照抄比「统一一下」安全。
  assert.deepEqual(body["questions"]["operation"].instructions, {
    goal: "在 Wikipedia 上打开 Gödel 的条目",
    rules: NEXT_ACTION,
  });
  assert.deepEqual(body["questions"]["click_target"].instructions, {
    goal: "在 Wikipedia 上打开 Gödel 的条目",
    operation: "CLICK",
    rules: [NEXT_ACTION, TARGET],
  });
  assert.deepEqual(body["state"]["elements"], request.state.elements);
  assert.deepEqual(body["state"]["recent_actions"], [
    { action: "CLICK [12] link Wikipedia", kind: "click", text: null, page_changed: true },
  ]);
  // 顶层只有这三个键。BudgetView 不进请求体——多一个键就是给一个严格校验的
  // 服务端多一个拒绝的理由，而它只回一句 Invalid request.，排查代价全在我们这侧。
  assert.deepEqual(Object.keys(body).sort(), ["model", "questions", "state"]);
  await engine.close();
});

test("页面提示只能拼进已有字段：置顶在 page.text，近期动作写进 action 串，不新增键", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody() }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));
  const request = decisionRequest();
  request.state.notices = ["请输入SKU"];
  request.state.recentActions = [
    { action: "确定", kind: "click", text: null, pageChanged: false, notices: ["请输入SKU", "导入失败"] },
  ];

  await engine.decide(request, new AbortController().signal);

  const state = (endpoint.requests[0]?.body as Record<string, any>)["state"];
  assert.deepEqual(Object.keys(state.page).sort(), ["text", "title", "url"]);
  assert.equal(
    state.page.text,
    "Notices currently shown on the page (toasts / alerts / validation):\n- 请输入SKU\n\nPage text:\nThe Free Encyclopedia",
  );
  assert.deepEqual(state.recent_actions, [
    { action: "确定 (afterwards the page showed: 请输入SKU | 导入失败)", kind: "click", text: null, page_changed: false },
  ]);
  await engine.close();
});

test("detail 不能盖掉 code-owned 的 id / label", async (t) => {
  // 选择权必须只来自我们发出去的 id：页面里的文本若能覆盖 label（或 id），
  // 模型就有机会按站点内容而不是按索引做选择。
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody() }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));
  const request = decisionRequest();
  request.questions[1]!.options[0]!.detail = { id: "evil", label: "evil", element: "evil", current_value: "evil" };

  await engine.decide(request, new AbortController().signal);

  const body = endpoint.requests[0]?.body as Record<string, any>;
  // 键是 option.id、element 是 option.label——detail 里同名或相似名的键都盖不掉它们。
  assert.deepEqual(body["questions"]["click_target"].criteria, {
    "1": { element: "[1] link Gödel", current_value: "" },
    "2": { element: "[2] link Escher", current_value: "" },
  });
  await engine.close();
});

test("页面文本在 token 预算吃紧时被进一步裁剪", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody() }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));
  const request = decisionRequest();
  request.state.text = "x".repeat(6000);

  await engine.decide(request, new AbortController().signal);
  const normal = (endpoint.requests[0]?.body as Record<string, any>)["state"].page.text as string;
  assert.equal(normal.length, 6000);

  request.budget.inputTokensUsed = Math.floor(request.budget.maxInputTokens * 0.85);
  await engine.decide(request, new AbortController().signal);
  const tight = (endpoint.requests[1]?.body as Record<string, any>)["state"].page.text as string;
  assert.equal(tight.length, 3000);

  request.budget.inputTokensUsed = Math.floor(request.budget.maxInputTokens * 0.99);
  await engine.decide(request, new AbortController().signal);
  const hard = (endpoint.requests[2]?.body as Record<string, any>)["state"].page.text as string;
  assert.equal(hard.length, 1000);
  await engine.close();
});

test("capabilities：概率是承诺的 full，text 反映本进程配没配文本模型", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody() }));
  const withoutText = createTypeSafeEngine(engineOptions(endpoint.endpoint));
  assert.deepEqual(withoutText.capabilities, { text: false, probabilities: "full" });

  const withText = createTypeSafeEngine(
    engineOptions(endpoint.endpoint, { text: { apiKey: "k", baseUrl: endpoint.endpoint, model: "m" } }),
  );
  assert.deepEqual(withText.capabilities, { text: true, probabilities: "full" });
  await withoutText.close();
  await withText.close();
});

// ---------------------------------------------------------------------------
// 重试
// ---------------------------------------------------------------------------

test("503 重试一次后成功：requests 记 2（含重试），而不是 1", async (t) => {
  const endpoint = await startEndpoint(t, (_request, index) =>
    index === 0 ? { status: 503, json: { error: "overloaded" } } : { status: 200, json: okBody() },
  );
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { retryBaseDelayMs: 20 }));

  const result = await engine.decide(decisionRequest(), new AbortController().signal);

  assert.equal(endpoint.requests.length, 2, "服务端应当看到两次尝试");
  assert.equal(result.usage.requests, 2, "requests 必须是实际请求数：按 1 算就是给了重试一条免费通道");
  assert.ok(result.latencyMs >= 15, "第一次重试前应有退避等待");
  assert.equal(result.answers["operation"]?.choice, "CLICK");
  await engine.close();
});

test("429 与 529 同样在可重试集合里", async (t) => {
  for (const status of [429, 529]) {
    const endpoint = await startEndpoint(t, (_request, index) =>
      index === 0 ? { status, json: { error: "slow down" } } : { status: 200, json: okBody() },
    );
    const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { retryBaseDelayMs: 1 }));

    const result = await engine.decide(decisionRequest(), new AbortController().signal);
    assert.equal(endpoint.requests.length, 2, `HTTP ${status} 应当被重试`);
    assert.equal(result.usage.requests, 2);
    await engine.close();
  }
  assert.deepEqual([...RETRYABLE_STATUS], [429, 503, 529]);
  assert.equal(MAX_ATTEMPTS, 3);
});

test("400 立即失败、不重试，且错误信息声明没有任何浏览器动作", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 400, json: { error: "bad request" } }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { retryBaseDelayMs: 1 }));

  const error = await engine.decide(decisionRequest(), new AbortController().signal).then(
    () => null,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof EngineRequestError, `期望 EngineRequestError，收到 ${String(error)}`);
  assert.equal(error.noBrowserActionTaken, true);
  assert.equal(endpoint.requests.length, 1, "4xx 不在可重试集合里，不该有第二次尝试");
  assert.match(error.message, /HTTP 400/);
  assert.match(error.message, /没有任何浏览器动作被执行/);
  assert.match(error.message, /不重试/);
  assert.match(error.message, /bad request/, "错误信息里要带上响应片段，否则排查只剩一个状态码");
  await engine.close();
});

test("默认退避是 0.5s / 1s（指数），不是固定间隔", async (t) => {
  // 走**默认**配置：证明生产路径上的第一次退避真的是 0.5 秒。
  const endpoint = await startEndpoint(t, (_request, index) =>
    index < 2 ? { status: 503, json: { error: "overloaded" } } : { status: 200, json: okBody() },
  );
  const engine = createTypeSafeEngine({ apiKey: "test-key", model: "jev-latest", endpoint: endpoint.endpoint });

  const started = performance.now();
  const result = await engine.decide(decisionRequest(), new AbortController().signal);
  const elapsed = performance.now() - started;

  assert.equal(result.usage.requests, 3);
  // 0.5s + 1s = 1.5s。断言下界留出计时器与网络抖动的余量，但足以排除
  // 「退避没生效」（那样只要几毫秒）与「固定 0.5s」（那样只有 1s）。
  assert.ok(elapsed >= 1400, `两次退避合计应约 1500ms，实际 ${Math.round(elapsed)}ms`);
  await engine.close();
});

test("503 连续三次后失败：恰好尝试 MAX_ATTEMPTS 次，退避逐次翻倍", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 503, json: { error: "overloaded" } }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { retryBaseDelayMs: 40 }));

  const started = performance.now();
  const error = await engine.decide(decisionRequest(), new AbortController().signal).then(
    () => null,
    (reason: unknown) => reason,
  );
  const elapsed = performance.now() - started;

  assert.ok(error instanceof EngineRequestError);
  assert.equal(endpoint.requests.length, MAX_ATTEMPTS);
  assert.match(error.message, /已重试 2 次/);
  // 三次请求都真实发出、都可能计费：失败也要把用量交给调用方记账，否则重试失败是免费通道
  assert.equal(failedCallUsage(error)?.usage.requests, MAX_ATTEMPTS);
  // 40 + 80 = 120ms：固定间隔会给出 80ms，退避没生效会给出 ~0ms。
  assert.ok(elapsed >= 110, `退避应逐次翻倍（40+80ms），实际 ${Math.round(elapsed)}ms`);
  await engine.close();
});

test("网络故障不重试：不确定「请求有没有到达」时不做最多三次计费", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, destroy: true }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { retryBaseDelayMs: 1 }));

  const error = await engine.decide(decisionRequest(), new AbortController().signal).then(
    () => null,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof EngineRequestError);
  assert.equal(endpoint.requests.length, 1, "网络故障不在契约枚举的可重试条件里");
  assert.match(error.message, /网络故障/);
  assert.match(error.message, /没有任何浏览器动作被执行/);
  await engine.close();
});

test("超时不重试：超时的请求很可能仍在服务端执行，重试就是重复计费", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody(), delayMs: 400 }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { timeoutMs: 60, retryBaseDelayMs: 1 }));

  const error = await engine.decide(decisionRequest(), new AbortController().signal).then(
    () => null,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof EngineRequestError);
  assert.equal(endpoint.requests.length, 1);
  assert.match(error.message, /超时/);
  await engine.close();
});

// ---------------------------------------------------------------------------
// 取消
// ---------------------------------------------------------------------------

test("取消能中断在途请求：立刻结束，不等超时，也不重试", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody(), delayMs: 800 }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { timeoutMs: 30_000 }));
  const controller = new AbortController();

  const started = performance.now();
  const pending = engine.decide(decisionRequest(), controller.signal).then(
    () => null,
    (reason: unknown) => reason,
  );
  await sleep(30);
  controller.abort();

  const error = await pending;
  const elapsed = performance.now() - started;

  assert.ok(error instanceof EngineRequestError, `期望 EngineRequestError，收到 ${String(error)}`);
  assert.match(error.message, /取消/);
  assert.ok(elapsed < 1000, `取消应当在途请求立刻结束（实际 ${Math.round(elapsed)} ms）`);
  assert.equal(endpoint.requests.length, 1, "取消之后不该再有重试");
  await engine.close();
});

test("取消在退避等待中同样生效，不会先白等 0.5 秒", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 503, json: { error: "overloaded" } }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { retryBaseDelayMs: 5000 }));
  const controller = new AbortController();

  const started = performance.now();
  const pending = engine.decide(decisionRequest(), controller.signal).then(
    () => null,
    (reason: unknown) => reason,
  );
  await sleep(30);
  controller.abort();

  const error = await pending;
  assert.ok(error instanceof EngineRequestError);
  assert.match(error.message, /取消/);
  assert.ok(performance.now() - started < 1000);
  assert.equal(endpoint.requests.length, 1);
  await engine.close();
});

test("已经取消的信号在入口就被拒绝，连请求都不发", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody() }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => engine.decide(decisionRequest(), controller.signal));
  assert.equal(endpoint.requests.length, 0);
  await engine.close();
});

// ---------------------------------------------------------------------------
// 在途限流
// ---------------------------------------------------------------------------

test("在途请求真的走 settings.maxEngineInflight 的闸门（并发峰值不超过上限）", async (t) => {
  // 这条是「限流有没有接上」的**唯一**实证：没接上时一切照常工作，只是并发越高
  // 越容易把厂商打爆——没有任何症状，因此必须由测试来锁。
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody(), delayMs: 40 }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { maxInflight: 2 }));

  await Promise.all(
    Array.from({ length: 6 }, () => engine.decide(decisionRequest(), new AbortController().signal)),
  );

  assert.equal(endpoint.requests.length, 6);
  assert.equal(endpoint.peakConcurrency(), 2, "6 个并发决策在限流 2 之下，峰值必须正好是 2");
  await engine.close();
});

test("限流排队的时间不算进请求超时：超时只覆盖真正的 HTTP 往返", async (t) => {
  // 超时信号若在拿到许可**之前**创建，排队等待就会消耗掉请求自己的超时预算：
  // 一个在闸门前排了 270ms 的请求，会带着一个早已过期的信号发出去，然后报
  // 「请求超时」——而它刚刚才离开本进程。错误信息与事实不符，排查方向会被带偏。
  //
  // 两个引擎共用同一个进程级闸门（许可数相同 → 同一实例，见 typesafe.ts 的
  // withInflight），于是可以用「耐心」的那个占住唯一一个许可，把「性急」的
  // 那个压在队列里超过它自己的超时预算。
  // 只有第一个请求慢：它占着许可 300ms，而它自己的往返时间远在 5s 预算之内。
  const endpoint = await startEndpoint(t, (_request, index) => ({
    status: 200,
    json: okBody(),
    delayMs: index === 0 ? 300 : 0,
  }));
  const patient = createTypeSafeEngine(engineOptions(endpoint.endpoint, { maxInflight: 1, timeoutMs: 5000 }));
  const impatient = createTypeSafeEngine(engineOptions(endpoint.endpoint, { maxInflight: 1, timeoutMs: 100 }));

  const holder = patient.decide(decisionRequest(), new AbortController().signal);
  await sleep(30); // 让 holder 先拿到许可
  const queued = impatient.decide(decisionRequest(), new AbortController().signal);

  const [, second] = await Promise.all([holder, queued]);
  assert.equal(second.answers["operation"]?.choice, "CLICK", "排在闸门前的 270ms 不该算进它自己的 100ms 超时预算");
  assert.ok(endpoint.requests.length <= 2);
  await patient.close();
  await impatient.close();
});

// ---------------------------------------------------------------------------
// 响应解析：信封容错、叶子严格
// ---------------------------------------------------------------------------

test("缺 probabilities 时报错，而不是合成 one-hot 让概率断言假通过", async (t) => {
  const endpoint = await startEndpoint(t, () => ({
    status: 200,
    json: {
      questions: {
        operation: { choice: "CLICK" },
        click_target: { choice: "1" },
        type_text_target: { choice: "3" },
      },
    },
  }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const error = await engine.decide(decisionRequest(), new AbortController().signal).then(
    () => null,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof EngineRequestError);
  assert.match(error.message, /probabilities/);
  assert.match(error.message, /假通过/);
  assert.equal(endpoint.requests.length, 1, "响应不可用不该触发重试");
  assert.equal(failedCallUsage(error)?.usage.requests, 1, "响应已计费：映射失败也要记账");
  await engine.close();
});

test("缺少任一问题的答案就整体判为不可用", async (t) => {
  const endpoint = await startEndpoint(t, () => ({
    status: 200,
    json: { questions: { operation: { choice: "CLICK", probabilities: { CLICK: 1 } } } },
  }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const error = await engine.decide(decisionRequest(), new AbortController().signal).then(
    () => null,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof EngineRequestError);
  assert.match(error.message, /缺少 2 个问题的答案/);
  assert.match(error.message, /click_target/);
  await engine.close();
});

test("找不到答案表时给出期望的键，而不是静默返回空答案", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: { ok: true } }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const error = await engine.decide(decisionRequest(), new AbortController().signal).then(
    () => null,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof EngineRequestError);
  assert.match(error.message, /找不到任何问题答案/);
  await engine.close();
});

test("答案叶子形状不对时逐条报出来", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: { questions: { operation: "CLICK" } } }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  await assert.rejects(
    () => engine.decide(decisionRequest(), new AbortController().signal),
    /问题 "operation" 的答案形状不对/,
  );
  await engine.close();
});

test("信封容错：答案挂在 result.questions 下也能识别", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: { result: { questions: okBody()["questions"] } } }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const result = await engine.decide(decisionRequest(), new AbortController().signal);
  assert.equal(result.answers["operation"]?.choice, "CLICK");
  await engine.close();
});

test("信封容错：被回显的请求体不会被当成答案表", async (t) => {
  // 请求体里也有一个含全部问题键的对象（叶子是 {type, criteria, instructions}）。
  // 若服务端把请求回显在响应里，且它排在真正的答案表之前，按「含全部键」就会选中它，
  // 然后一次本可成功的决策毁在叶子形状校验上。
  const echoed = {
    model: "jev-latest",
    questions: {
      operation: { type: "choice", criteria: { options: [] }, instructions: { rules: [] } },
      click_target: { type: "choice", criteria: { options: [] }, instructions: { rules: [] } },
      type_text_target: { type: "choice", criteria: { options: [] }, instructions: { rules: [] } },
    },
  };
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: { ...echoed, answers: okBody()["questions"] } }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const result = await engine.decide(decisionRequest(), new AbortController().signal);

  assert.equal(result.answers["operation"]?.choice, "CLICK");
  assert.equal(result.answers["click_target"]?.choice, "1");
  await engine.close();
});

test("数字型的 choice 归一成字符串（3 与 \"3\" 是同一个候选 id）", async (t) => {
  const endpoint = await startEndpoint(t, () => ({
    status: 200,
    json: {
      questions: {
        operation: { choice: "CLICK", probabilities: { CLICK: 0.6, DONE: 0.4 } },
        click_target: { choice: 1, probabilities: { "1": 0.9, "2": 0.1 } },
        type_text_target: { choice: "3", probabilities: { "3": 1 } },
      },
    },
  }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const result = await engine.decide(decisionRequest(), new AbortController().signal);
  assert.equal(result.answers["click_target"]?.choice, "1");
  await engine.close();
});

test("概率原样透传：不在引擎里归一化、不修正取值", async (t) => {
  // 归一化/修正属于「绕过校验」：validateChoice 正是靠**原始**分布判断
  // distribution 是 full 还是 degenerate。引擎顺手修正会让那条判据永远通过。
  const endpoint = await startEndpoint(t, () => ({
    status: 200,
    json: {
      questions: {
        operation: { choice: "CLICK", probabilities: { CLICK: 0.9, TYPE_TEXT: 0.6, DONE: 0.4 } },
        click_target: { choice: "1", probabilities: { "1": 0.5, "2": 0.5 } },
        type_text_target: { choice: "3", probabilities: { "3": 1 } },
      },
    },
  }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const result = await engine.decide(decisionRequest(), new AbortController().signal);
  assert.deepEqual(result.answers["operation"]?.probabilities, { CLICK: 0.9, TYPE_TEXT: 0.6, DONE: 0.4 });
  await engine.close();
});

test("confidence 缺失时退化为所选候选的概率；实在没有就给 0", async (t) => {
  const endpoint = await startEndpoint(t, () => ({
    status: 200,
    json: {
      questions: {
        operation: { choice: "CLICK", probabilities: { CLICK: 0.42, DONE: 0.58 } },
        click_target: { choice: "1", probabilities: { "1": 0.5, "2": 0.5 }, confidence: 0.31 },
        type_text_target: { choice: "3", probabilities: { "3": 1 } },
      },
    },
  }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const result = await engine.decide(decisionRequest(), new AbortController().signal);
  assert.equal(result.answers["operation"]?.confidence, 0.42, "缺 confidence 时用所选候选的概率兜底");
  assert.equal(result.answers["click_target"]?.confidence, 0.31, "给了就用给的");
  await engine.close();
});

test("用量缺项记 0、金额缺项记 null（不用 0 冒充未知）", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody()["questions"] }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const result = await engine.decide(decisionRequest(), new AbortController().signal);
  assert.deepEqual(result.usage, { inputTokens: 0, outputTokens: 0, costUsd: null, requests: 1 });
  await engine.close();
});

test("用量优先取 camelCase 与嵌套信封", async (t) => {
  const endpoint = await startEndpoint(t, () => ({
    status: 200,
    json: {
      ...okBody(),
      usage: undefined,
      result: { usageMetadata: { promptTokens: 11, completionTokens: 2, totalCostUsd: 0.5 } },
    },
  }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const result = await engine.decide(decisionRequest(), new AbortController().signal);
  assert.deepEqual(result.usage, { inputTokens: 11, outputTokens: 2, costUsd: 0.5, requests: 1 });
  await engine.close();
});

test("响应不是合法 JSON 时报错，而不是猜一个结果", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, raw: "<html>502 Bad Gateway</html>" }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  await assert.rejects(
    () => engine.decide(decisionRequest(), new AbortController().signal),
    /不是合法 JSON/,
  );
  await engine.close();
});

// ---------------------------------------------------------------------------
// 构造与生命周期
// ---------------------------------------------------------------------------

test("未配置 API key 时不发请求，错误信息给出修复方向", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody() }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint, { apiKey: "   " }));

  const error = await engine.decide(decisionRequest(), new AbortController().signal).then(
    () => null,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof EngineRequestError);
  assert.equal(endpoint.requests.length, 0);
  assert.match(error.message, /未配置 API key/);
  assert.match(error.message, /TYPESAFE_API_KEY/);
  await engine.close();
});

test("close() 之后拒绝对话，且不再发请求", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: okBody() }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));
  await engine.close();

  await assert.rejects(() => engine.decide(decisionRequest(), new AbortController().signal), /引擎已关闭/);
  await assert.rejects(() => engine.writeText(textRequest(), new AbortController().signal), /引擎已关闭/);
  assert.equal(endpoint.requests.length, 0);
});

test("默认端点是线上地址（只在没有 endpoint 覆盖时才会用到）", () => {
  assert.equal(TYPESAFE_ENDPOINT, "https://api.typesafe.ai/v1/systemone");
});

// ---------------------------------------------------------------------------
// writeText：OpenAI 兼容端点
// ---------------------------------------------------------------------------

test("未配置文本模型时 writeText 直接报错，绝不猜一个值", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: chatBody('{"text": "Gödel"}') }));
  const engine = createTypeSafeEngine(engineOptions(endpoint.endpoint));

  const error = await engine.writeText(textRequest(), new AbortController().signal).then(
    () => null,
    (reason: unknown) => reason,
  );

  assert.ok(error instanceof EngineRequestError);
  assert.equal(endpoint.requests.length, 0, "没有文本模型就不该有任何请求");
  assert.match(error.message, /未配置文本模型/);
  assert.match(error.message, /textModelApiKey/);
  // 提示里的环境变量名必须是 config.ts 真正读的那个——照着一个不存在的名字去设，配置不会生效
  assert.match(error.message, /\bTEXT_MODEL_API_KEY\b/);
  assert.doesNotMatch(error.message, /JEVTEST_TEXT_MODEL/);
  await engine.close();
});

test("writeText 走 OpenAI 兼容端点：路径、提示词与解析都对", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: chatBody('{"text": "Gödel"}') }));
  const engine = createTypeSafeEngine(
    engineOptions(endpoint.endpoint, {
      text: { apiKey: "text-key", baseUrl: `${endpoint.endpoint}/v1`, model: "deepseek-chat" },
    }),
  );

  const result = await engine.writeText(textRequest(), new AbortController().signal);

  assert.equal(endpoint.requests[0]?.path, "/v1/chat/completions");
  assert.equal(endpoint.requests[0]?.authorization, "Bearer text-key");
  const body = endpoint.requests[0]?.body as Record<string, any>;
  assert.equal(body["model"], "deepseek-chat");
  assert.equal(body["temperature"], 0);
  assert.equal(body["messages"][0].role, "system");
  assert.equal(body["messages"][0].content, TEXT_VALUE, "系统提示词必须是 rules.ts 的那一份");
  assert.match(body["messages"][1].content, /Gödel/);
  assert.match(body["messages"][1].content, /combobox/);

  assert.equal(result.text, "Gödel");
  assert.equal(result.engine, "typesafe");
  assert.equal(result.usage.requests, 1);
  assert.equal(result.usage.inputTokens, 500);
  assert.equal(result.usage.outputTokens, 8);
  assert.equal(result.usage.costUsd, null, "chat 响应没报金额，记 null 而不是 0");
  await engine.close();
});

test("baseUrl 已经带全路径时不重复拼接", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: chatBody('{"text": "x"}') }));
  const engine = createTypeSafeEngine(
    engineOptions(endpoint.endpoint, {
      text: { apiKey: "k", baseUrl: `${endpoint.endpoint}/v1/chat/completions`, model: "m" },
    }),
  );

  await engine.writeText(textRequest(), new AbortController().signal);
  assert.equal(endpoint.requests[0]?.path, "/v1/chat/completions");
  await engine.close();
});

test("writeText 的 {\"text\": null} 表示缺少必要信息，原样传给上层", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: chatBody('{"text": null}') }));
  const engine = createTypeSafeEngine(
    engineOptions(endpoint.endpoint, { text: { apiKey: "k", baseUrl: endpoint.endpoint, model: "m" } }),
  );

  const result = await engine.writeText(textRequest(), new AbortController().signal);
  assert.equal(result.text, null);
  await engine.close();
});

test("writeText 拒绝带前言的输出：模型输出直接进真实表单，解析不能宽松", async (t) => {
  const endpoint = await startEndpoint(t, () => ({
    status: 200,
    json: chatBody('Thinking: 用户想找 Gödel，所以应该是 {"text": "Gödel"}'),
  }));
  const engine = createTypeSafeEngine(
    engineOptions(endpoint.endpoint, { text: { apiKey: "k", baseUrl: endpoint.endpoint, model: "m" } }),
  );

  const error = await engine.writeText(textRequest(), new AbortController().signal).then(
    () => null,
    (reason: unknown) => reason,
  );
  assert.ok(error instanceof EngineRequestError, "解析失败也保留「没有浏览器动作」这条信号");
  assert.match(error.message, /不是合法 JSON/);
  assert.equal(failedCallUsage(error)?.usage.requests, 1);
  await engine.close();
});

test("writeText 缺 choices 时报错，不从响应里猜一段文本", async (t) => {
  const endpoint = await startEndpoint(t, () => ({ status: 200, json: { error: "quota" } }));
  const engine = createTypeSafeEngine(
    engineOptions(endpoint.endpoint, { text: { apiKey: "k", baseUrl: endpoint.endpoint, model: "m" } }),
  );

  await assert.rejects(
    () => engine.writeText(textRequest(), new AbortController().signal),
    /没有 choices/,
  );
  await engine.close();
});

test("writeText 同样只重试 429/503/529，并计入 requests", async (t) => {
  const endpoint = await startEndpoint(t, (_request, index) =>
    index === 0 ? { status: 503, json: { error: "overloaded" } } : { status: 200, json: chatBody('{"text": "Gödel"}') },
  );
  const engine = createTypeSafeEngine(
    engineOptions(endpoint.endpoint, {
      retryBaseDelayMs: 1,
      text: { apiKey: "k", baseUrl: endpoint.endpoint, model: "m" },
    }),
  );

  const result = await engine.writeText(textRequest(), new AbortController().signal);
  assert.equal(endpoint.requests.length, 2);
  assert.equal(result.usage.requests, 2);
  await engine.close();
});

test("writeText 也受限流闸门约束（与决策共用同一个进程级闸门）", async (t) => {
  const endpoint = await startEndpoint(t, () => ({
    status: 200,
    json: chatBody('{"text": "Gödel"}'),
    delayMs: 40,
  }));
  const engine = createTypeSafeEngine(
    engineOptions(endpoint.endpoint, {
      maxInflight: 1,
      text: { apiKey: "k", baseUrl: endpoint.endpoint, model: "m" },
    }),
  );

  await Promise.all([
    engine.writeText(textRequest(), new AbortController().signal),
    engine.writeText(textRequest(), new AbortController().signal),
    engine.writeText(textRequest(), new AbortController().signal),
  ]);

  assert.equal(endpoint.peakConcurrency(), 1);
  await engine.close();
});

// ---------------------------------------------------------------------------
// scripted：零成本回放引擎（同样是 DecisionEngine，因此也在这个文件里被验）
// ---------------------------------------------------------------------------

const SIGNAL = new AbortController().signal;

test("scripted 按序回放预设：operation 与各 head 都映射到位", async () => {
  const engine = createScriptedEngine({
    steps: [
      { operation: { choice: "CLICK" }, targets: { click_target: { choice: "1" } } },
      { operation: { choice: "CLICK" }, targets: { click_target: { choice: "2" } } },
    ],
  });

  const first = await engine.decide(decisionRequest(), SIGNAL);
  const second = await engine.decide(decisionRequest(), SIGNAL);

  assert.equal(engine.name, "scripted");
  assert.equal(first.engine, "scripted");
  assert.equal(first.answers["operation"]?.choice, "CLICK");
  assert.equal(first.answers["click_target"]?.choice, "1");
  assert.equal(second.answers["click_target"]?.choice, "2", "每一步按顺序取，不会重放第一步");
  assert.equal(first.usage.requests, 1, "scripted 的 requests 是约定值：让预算刹车在零成本链路里也能被触发");
  assert.equal(first.usage.costUsd, null, "没有计费就是未知，不能用 0 冒充");
  await engine.close();
});

test("scripted 不校验 choice：非法值原样送出，交给 core/policy.ts 的 validateChoice 拒绝", async () => {
  // 这条是刻意的：引擎若「顺手修正」，校验与护栏路径就永远不会被测试覆盖到。
  const engine = createScriptedEngine({
    steps: [{ operation: { choice: "FLY_TO_MARS" }, targets: { click_target: { choice: "999" } } }],
  });

  const result = await engine.decide(decisionRequest(), SIGNAL);
  assert.equal(result.answers["operation"]?.choice, "FLY_TO_MARS");
  assert.equal(result.answers["click_target"]?.choice, "999");
  await engine.close();
});

test("scripted 每个 head 都被回答：未预设的补成该 head 候选集的第一项", async () => {
  // 缺席会让 DecisionResult.answers 的键集合与请求不一致，而真实模型也必须回答每个 head。
  const engine = createScriptedEngine({ steps: [{ operation: { choice: "CLICK" } }] });

  const result = await engine.decide(decisionRequest(), SIGNAL);
  assert.deepEqual(Object.keys(result.answers).sort(), ["click_target", "operation", "type_text_target"]);
  assert.equal(result.answers["click_target"]?.choice, "1", "补的是候选集第一项（合法但无信息量），不是缺席");
  assert.deepEqual(result.answers["click_target"]?.probabilities, { "1": 1 });
  await engine.close();
});

test("scripted 用尽预设步数后再被调用即报错：说明用例实际步数超出预期", async () => {
  const engine = createScriptedEngine({ steps: [{ operation: { choice: "DONE" } }] });
  await engine.decide(decisionRequest(), SIGNAL);

  await assert.rejects(() => engine.decide(decisionRequest(), SIGNAL), /预设步数已用尽/);
  await engine.close();
});

test("scripted 的 writeText 读「刚刚消费掉的那一步」：决策与取值是同一步的两半", async () => {
  const engine = createScriptedEngine({
    steps: [
      { operation: { choice: "TYPE_TEXT" }, targets: { type_text_target: { choice: "3" } }, text: "Gödel" },
      { operation: { choice: "CLICK" }, targets: { click_target: { choice: "1" } } },
    ],
  });

  await engine.decide(decisionRequest(), SIGNAL);
  const result = await engine.writeText(textRequest(), SIGNAL);

  assert.equal(result.text, "Gödel");
  assert.equal(result.engine, "scripted");
  // 第二步没有被 writeText 吃掉：CLICK 那一步还在。
  const second = await engine.decide(decisionRequest(), SIGNAL);
  assert.equal(second.answers["operation"]?.choice, "CLICK");
  await engine.close();
});

test("scripted 的 text 未预设时为 null：承认「缺少信息」好过猜一个值", async () => {
  const engine = createScriptedEngine({ steps: [{ operation: { choice: "TYPE_TEXT" }, text: null }] });
  await engine.decide(decisionRequest(), SIGNAL);

  assert.equal((await engine.writeText(textRequest(), SIGNAL)).text, null);
  await engine.close();
});

test("scripted 在 decide 之前调用 writeText 报错（否则会读到上一步甚至不存在的文本）", async () => {
  const engine = createScriptedEngine({ steps: [{ operation: { choice: "DONE" } }] });
  await assert.rejects(() => engine.writeText(textRequest(), SIGNAL), /writeText 在 decide 之前被调用/);
  await engine.close();
});

test("constantSteps：连续给出同样的答案若干次，且各步互相独立", async () => {
  const step = { operation: { choice: "WAIT" }, targets: { click_target: { choice: "1" } } };
  const steps = constantSteps(step, 3);

  assert.equal(steps.length, 3);
  const engine = createScriptedEngine({ steps });
  const first = await engine.decide(decisionRequest(), SIGNAL);
  const raw = first.raw as { operation: { choice: string } };
  raw.operation.choice = "TAMPERED";

  // 深拷贝：改一份不该改掉「所有步」——连续重复恰恰是卡死检测的触发条件，
  // 让这些步共享可变状态会把一条确定性测试变成随机的。
  const second = await engine.decide(decisionRequest(), SIGNAL);
  assert.equal(second.answers["operation"]?.choice, "WAIT");
  assert.equal(step.operation.choice, "WAIT", "预设本身也不该被 raw 的消费方改掉");
  await engine.close();
});

test("constantSteps 拒绝非法次数", () => {
  assert.throws(() => constantSteps({ operation: { choice: "WAIT" } }, -1), /非负整数/);
  assert.throws(() => constantSteps({ operation: { choice: "WAIT" } }, 1.5), /非负整数/);
  assert.deepEqual(constantSteps({ operation: { choice: "WAIT" } }, 0), []);
});

test("scripted 可以声明成 degenerate 分布：用来测「概率断言必须标 skipped」", async () => {
  const engine = createScriptedEngine({
    probabilities: "degenerate",
    steps: [{ operation: { choice: "CLICK", probabilities: { CLICK: 0.5, DONE: 0.5 } } }],
  });

  assert.deepEqual(engine.capabilities, { text: true, probabilities: "degenerate" });
  const result = await engine.decide(decisionRequest(), SIGNAL);
  assert.equal(result.answers["operation"]?.distribution, "degenerate");
  assert.deepEqual(result.answers["operation"]?.probabilities, { CLICK: 0.5, DONE: 0.5 });
  await engine.close();
});

test("scripted 声明 text: false 时拒绝 writeText，而不是被 runner 绕过去", async () => {
  const engine = createScriptedEngine({ text: false, steps: [{ operation: { choice: "TYPE_TEXT" } }] });
  assert.equal(engine.capabilities.text, false);
  await engine.decide(decisionRequest(), SIGNAL);

  await assert.rejects(() => engine.writeText(textRequest(), SIGNAL), /capabilities\.text 为 false/);
  await engine.close();
});

test("scripted 的 close() 之后拒绝一切", async () => {
  const engine = createScriptedEngine({ steps: [{ operation: { choice: "DONE" } }] });
  await engine.close();

  await assert.rejects(() => engine.decide(decisionRequest(), SIGNAL), /引擎已关闭/);
  await assert.rejects(() => engine.writeText(textRequest(), SIGNAL), /引擎已关闭/);
});

test("scripted 尊重取消信号（不需要真的发请求也要能被打断）", async () => {
  const engine = createScriptedEngine({ steps: [{ operation: { choice: "DONE" } }] });
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(() => engine.decide(decisionRequest(), controller.signal));
  await assert.rejects(() => engine.writeText(textRequest(), controller.signal));
  await engine.close();
});

test("scripted 自定义名字：报告里的 engine 字段跟着变", async () => {
  const engine = createScriptedEngine({ name: "scripted-final", steps: [{ operation: { choice: "DONE" } }] });
  assert.equal(engine.name, "scripted-final");
  assert.equal((await engine.decide(decisionRequest(), SIGNAL)).engine, "scripted-final");
  await engine.close();
});
