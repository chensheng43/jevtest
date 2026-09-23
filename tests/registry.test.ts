/**
 * 引擎注册表的行为锁定。
 *
 * 注册表是「用例声明的引擎名 → 可用的 DecisionEngine」这唯一一条通路的守门人，
 * 因此这里守的是三类**不会报错、只会悄悄走偏**的性质：
 *
 *   1. **未注册的名字必须报错并列出可用引擎**。静默回落到默认引擎的话，
 *      一个写错名字的用例会跑出「看起来正常」的结果，而它跑的其实不是声明的那个引擎——
 *      A/B 对比就此失去意义。
 *   2. **scripted 不在注册表里**（architecture.md §11.1 ④，与注册表旧 TODO 相反）。
 *      它一旦被注册，用例里写 `engine: scripted` 就会真的跑起来。
 *   3. **文本模型三项真的被映射下去了**。映射断掉的表现是第一次 TYPE_TEXT 才报错，
 *      而那时已经烧掉了前面若干步的模型调用。
 *
 * ⚠️ 本文件**绝不调用 `decide()`**：注册表构造的 typesafe 引擎没有 `endpoint` 覆盖，
 * 真的调下去就是打线上付费接口。要验证决策请求的行为，看 `tests/engine.test.ts`
 * （那里用本地假端点）。这里只验证「接线」，且文本端点指向本地。
 */

import { createServer } from "node:http";
import { test } from "node:test";
import type { TestContext } from "node:test";
import assert from "node:assert/strict";

import type { Settings } from "../src/config.ts";
import type { Case } from "../src/schema/case.ts";
import type { DecisionEngine, EngineCapabilities } from "../src/engine/types.ts";
import { createEngine, listEngines, registerEngine } from "../src/engine/registry.ts";
import type { EngineContext } from "../src/engine/registry.ts";
import { createScriptedEngine } from "../src/engine/scripted.ts";
import { TYPESAFE_ENGINE_NAME } from "../src/engine/typesafe.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

function settingsWith(over: Partial<Settings> = {}): Settings {
  const base: Settings = {
    typesafeApiKey: "typesafe-key",
    typesafeModel: "jev-latest",
    textModelApiKey: null,
    textModelBaseUrl: "",
    textModel: "",
    port: 8770,
    workers: 1,
    maxEngineInflight: 4,
    headless: true,
    tracing: false,
    recordFrames: false,
    casesDir: "./cases",
    runsDir: "./runs",
    authDir: "./auth",
    defaultEngine: TYPESAFE_ENGINE_NAME,
  };
  return Object.assign(base, over);
}

function caseWith(over: Partial<Case> = {}): Case {
  const base: Case = {
    schemaVersion: 1,
    id: "wikipedia-godel",
    title: "维基百科：Gödel",
    goal: "在 Wikipedia 上打开 Gödel 的条目",
    startUrl: "https://en.wikipedia.org/wiki/G%C3%B6del",
    mode: "interactive",
    allowedOrigins: ["https://en.wikipedia.org"],
    budget: { maxSteps: 40, maxModelCalls: 40, maxInputTokens: 200_000, maxCostUsd: null, maxElapsedMs: 300_000 },
    guardrails: [],
    allowDefaultOverride: false,
    engine: TYPESAFE_ENGINE_NAME,
    assertions: {},
  };
  return Object.assign(base, over);
}

/** 假装成一个引擎：注册表只关心它是 DecisionEngine，不关心它到底会不会干活。 */
function stubEngine(name: string, capabilities: EngineCapabilities, onClose?: () => void): DecisionEngine {
  return {
    name,
    capabilities,
    decide: () => Promise.reject(new Error(`${name}: 测试桩不应当被真的调用 decide`)),
    writeText: () => Promise.reject(new Error(`${name}: 测试桩不应当被真的调用 writeText`)),
    close: () => {
      onClose?.();
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// listEngines
// ---------------------------------------------------------------------------

test("listEngines 报告 typesafe 的能力，且形状恰好是 api.md §3.1 的三个键", () => {
  const engines = listEngines();
  const typesafe = engines.find((engine) => engine.name === TYPESAFE_ENGINE_NAME);

  assert.ok(typesafe !== undefined, "内置 typesafe 必须自注册");
  // probabilities 是「承诺」：前端据此决定要不要禁用 minTargetProbability 输入框。
  assert.equal(typesafe.probabilities, "full");
  assert.equal(typesafe.text, true, "listEngines 回答「引擎支持什么」，不是「本进程配没配」");
  assert.deepEqual(Object.keys(typesafe).sort(), ["name", "probabilities", "text"], "多出的键会顺着 /api/engines 漏给前端");
});

test("listEngines 不注册 scripted：它是测试专用引擎，用例配置里不存在这个名字", () => {
  // 注册表的旧 TODO 写的是「注册 typesafe 与 scripted」，architecture.md §11.1 ④
  // 定案为**不注册**。这条断言就是那次偏离的看门人。
  assert.equal(listEngines().some((engine) => engine.name === "scripted"), false);
});

test("listEngines 无需任何配置即可调用，且多次调用结果一致", () => {
  // doctor 要在凭证缺失时也能跑；前端下拉框也不该因为环境变量没设而空掉。
  const first = listEngines();
  assert.ok(first.length > 0);
  assert.deepEqual(listEngines(), first, "结果必须稳定：下拉框的顺序不该随机漂移");
});

test("listEngines 按名字排序，而不是按注册顺序", () => {
  const names = listEngines().map((engine) => engine.name);
  assert.deepEqual(names, [...names].sort());
});

// ---------------------------------------------------------------------------
// createEngine
// ---------------------------------------------------------------------------

test("createEngine 按用例构造 typesafe，并把 settings 的凭证传进 EngineContext", () => {
  const settings = settingsWith({ typesafeApiKey: "k-123", typesafeModel: "jev-1" });
  const engine = createEngine(caseWith(), settings);

  assert.equal(engine.name, TYPESAFE_ENGINE_NAME);
  assert.deepEqual(engine.capabilities, { text: false, probabilities: "full" }, "没配文本模型时 text 为 false");
});

test("createEngine 每次调用返回新实例（每个用例一个，跑完 close）", () => {
  const settings = settingsWith();
  assert.notEqual(createEngine(caseWith(), settings), createEngine(caseWith(), settings));
});

test("用例没声明 engine 时退到 settings.defaultEngine", () => {
  // 已过 schema 解析的 Case 里 engine 恒非空，所以这条兜的是「未经 schema 的 Case」
  // （测试夹具、手工拼出来的对象）——没写就按默认值走，而不是在查表时空名字失败。
  const settings = settingsWith({ defaultEngine: TYPESAFE_ENGINE_NAME });
  assert.equal(createEngine(caseWith({ engine: "" }), settings).name, TYPESAFE_ENGINE_NAME);
});

test("engine 名两边的空白被容忍", () => {
  assert.equal(createEngine(caseWith({ engine: "  typesafe  " }), settingsWith()).name, TYPESAFE_ENGINE_NAME);
});

test("未知引擎名报错，并列出可用引擎", () => {
  const error = (() => {
    try {
      createEngine(caseWith({ engine: "gpt-5" }), settingsWith());
      return null;
    } catch (reason: unknown) {
      return reason;
    }
  })();

  assert.ok(error instanceof Error);
  assert.match(error.message, /未知的决策引擎 "gpt-5"/);
  assert.match(error.message, /可用引擎/);
  assert.match(error.message, /typesafe/, "错误信息必须给出可用的名字，否则用户只能去读源码");
});

test("engine: scripted 报错，并指出正确的注入点", () => {
  // 生产用例永不声明 scripted。这里要的不是「恰好失败了」，而是**说清该怎么做**：
  // 否则一个照着 examples 抄了 scripted 的人只会看到一个「未知引擎」。
  const error = (() => {
    try {
      createEngine(caseWith({ engine: "scripted" }), settingsWith());
      return null;
    } catch (reason: unknown) {
      return reason;
    }
  })();

  assert.ok(error instanceof Error);
  assert.match(error.message, /未知的决策引擎 "scripted"/);
  assert.match(error.message, /测试专用/);
  assert.match(error.message, /RunnerDeps\.createEngine/);
  assert.match(error.message, /可用引擎/);
});

test("测试注入 scripted 的通路仍然成立：实例直接传给 RunnerDeps.createEngine", async () => {
  // 这是 §11.1 ④ 里「更好的通路」那一半：不经过注册表，也就不需要 schema 变更。
  const engine = createScriptedEngine({
    steps: [{ operation: { choice: "DONE" } }],
  });
  assert.equal(engine.name, "scripted");
  assert.equal(engine.capabilities.probabilities, "full");
  await engine.close();
});

// ---------------------------------------------------------------------------
// registerEngine
// ---------------------------------------------------------------------------

test("注册的引擎能被 createEngine 按名构造，并出现在 listEngines 里", () => {
  const seen: EngineContext[] = [];
  registerEngine("recorder", (ctx) => {
    seen.push(ctx);
    return stubEngine("recorder", { text: false, probabilities: "degenerate" });
  });

  const listed = listEngines().find((engine) => engine.name === "recorder");
  assert.deepEqual(listed, { name: "recorder", text: false, probabilities: "degenerate" });

  const settings = settingsWith();
  const engine = createEngine(caseWith({ engine: "recorder" }), settings);
  assert.equal(engine.name, "recorder");

  // 工厂会被调用两次：注册时的能力探测 + 真正的构造。这不是意外，而是
  // 「registerEngine 只有 (name, factory)，listEngines 又拿不到 Settings」的必然结果——
  // 能力只能从实例上读。因此工厂必须是纯构造（不发请求、不持有需要 close 的资源）。
  assert.equal(seen.length, 2, "注册时探测一次，构造时再一次");
  assert.notEqual(seen[0]?.settings, settings, "第一次是探测：用的是占位设置，不是真实配置");
  assert.equal(seen[1]?.settings, settings, "settings 整个传下去：只有某家引擎用得上的配置不该挤进 EngineContext 顶层字段");
});

test("未登记凭证来源的引擎拿到空凭证，而不是顺手借用 typesafe 的 key", () => {
  const seen: EngineContext[] = [];
  registerEngine("nobody", (ctx) => {
    seen.push(ctx);
    return stubEngine("nobody", { text: false, probabilities: "degenerate" });
  });

  createEngine(caseWith({ engine: "nobody" }), settingsWith({ typesafeApiKey: "secret-key" }));

  assert.equal(seen[0]?.apiKey, "", "把别家的 key 递给一个陌生引擎，比让它拿到空凭证危险得多");
  assert.equal(seen[0]?.model, "");
});

test("注册表用 Map 查表：constructor / __proto__ 这类名字不会被当成「已注册」", () => {
  // 引擎名来自用例（不可信输入）。用对象字面量存表时，`engine: constructor` 会命中
  // Object.prototype 上的成员——查得到，但拿到的不是引擎。
  for (const name of ["constructor", "__proto__", "toString"]) {
    assert.throws(() => createEngine(caseWith({ engine: name }), settingsWith()), /未知的决策引擎/);
  }
});

test("空引擎名被拒绝", () => {
  assert.throws(() => registerEngine("   ", () => stubEngine("x", { text: false, probabilities: "full" })), /不能为空/);
});

test("同名重复注册：后者胜出（测试与插件需要能替换内置引擎）", () => {
  registerEngine("shadow", () => stubEngine("shadow", { text: false, probabilities: "full" }));
  registerEngine("shadow", () => stubEngine("shadow", { text: true, probabilities: "degenerate" }));

  assert.equal(createEngine(caseWith({ engine: "shadow" }), settingsWith()).capabilities.text, true);
  assert.equal(listEngines().find((engine) => engine.name === "shadow")?.probabilities, "degenerate");
});

// ---------------------------------------------------------------------------
// 文本模型三项的映射（端点指向本地，绝不发外网）
// ---------------------------------------------------------------------------

/** 最小的 OpenAI 兼容端点：只记路径与请求体，固定回一个可解析的 text。 */
async function startChatServer(
  t: TestContext,
): Promise<{ baseUrl: string; requests: { path: string; body: unknown }[] }> {
  const requests: { path: string; body: unknown }[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString("utf8");
      requests.push({ path: req.url ?? "", body: raw === "" ? null : (JSON.parse(raw) as unknown) });
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"text": "Gödel"}' } }] }));
    })();
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("假端点没有拿到端口");

  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  return { baseUrl: `http://127.0.0.1:${address.port}/v1`, requests };
}

test("文本模型三项配齐时映射到位：capabilities.text 为 true，且请求发到 textModelBaseUrl", async (t) => {
  const chat = await startChatServer(t);
  const settings = settingsWith({
    textModelApiKey: "text-key",
    textModelBaseUrl: chat.baseUrl,
    textModel: "deepseek-chat",
  });
  const engine = createEngine(caseWith(), settings);

  assert.equal(engine.capabilities.text, true, "配齐了文本模型，能力就必须是 true，否则 runner 会提前报错");

  const result = await engine.writeText(
    {
      goal: "在 Wikipedia 上搜索 Gödel",
      field: { label: "Search", role: "combobox", value: "" },
      page: { title: "Wikipedia", text: "The Free Encyclopedia" },
      recentActions: [],
    },
    new AbortController().signal,
  );

  assert.equal(result.text, "Gödel");
  assert.equal(chat.requests[0]?.path, "/v1/chat/completions", "baseUrl 是 /v1，端点要补成 chat completions");
  assert.equal((chat.requests[0]?.body as Record<string, unknown>)["model"], "deepseek-chat");
  await engine.close();
});

test("半配置（有 key 没 baseUrl）视为未配置：宁可在构造时就说「没配」，也不要拖到第一次 TYPE_TEXT", async () => {
  const settings = settingsWith({ textModelApiKey: "text-key", textModelBaseUrl: "", textModel: "deepseek-chat" });
  const engine = createEngine(caseWith(), settings);

  assert.equal(engine.capabilities.text, false);
  await assert.rejects(
    () =>
      engine.writeText(
        {
          goal: "g",
          field: { label: "l", role: "r", value: "" },
          page: { title: "t", text: "x" },
          recentActions: [],
        },
        new AbortController().signal,
      ),
    /未配置文本模型/,
  );
  await engine.close();
});
