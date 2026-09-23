/**
 * 环境配置的默认值、越界拒绝与错误信息。
 *
 * 两类断言：
 *   - **默认值**：每项都要对得上 docs/development.md §1 的表。默认值是「只在 config.ts
 *     定义一次」的，所以它一旦漂移，别处（.env.example、文档）不会跟着响。
 *   - **错误信息里必须有修复方式**。配置错误的代价是把人卡在启动前，
 *     而「JEVTEST_WORKERS 不合法」这种话不告诉他该填什么——报错不说怎么修等于没报。
 *
 * 全部测试都显式传 env 对象，不读进程环境：否则开发机自己的 .env 会让断言飘。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { loadSettings, missingCredentials } from "../src/config.ts";
import type { Settings } from "../src/config.ts";

/** 捕获 loadSettings 抛出的错误。 */
function catchError(env: NodeJS.ProcessEnv): unknown {
  try {
    loadSettings(env);
  } catch (error) {
    return error;
  }
  return undefined;
}

/** 断言某项配置被拒绝，且错误信息里给了可复制的修复方式。 */
function assertRejected(env: NodeJS.ProcessEnv, expectedVar: string): string {
  const error = catchError(env);
  assert.ok(error instanceof Error, `${JSON.stringify(env)} 应该被拒绝`);
  assert.match(error.message, new RegExp(expectedVar), `错误信息里应点名 ${expectedVar}`);
  assert.match(error.message, /修复/, `错误信息里应给出修复方式：${error.message}`);
  return error.message;
}

// ---------------------------------------------------------------------------
// 默认值
// ---------------------------------------------------------------------------

test("空环境下每一项都取文档里的默认值", () => {
  const settings = loadSettings({});
  assert.deepEqual(settings, {
    // 凭证没有默认值：缺就是空串，是否致命交给 missingCredentials 判定
    typesafeApiKey: "",
    typesafeModel: "jev-latest",

    // null = 未配置，而不是空串——「没配」与「配了一个空值」在调用点要能区分
    textModelApiKey: null,
    textModelBaseUrl: "https://api.deepseek.com/v1",
    textModel: "deepseek-chat",

    port: 8770,
    // 默认串行：并发会成倍放大模型费用，要快得由用户显式要
    workers: 1,
    maxEngineInflight: 4,
    headless: true,
    // 默认开启：trace.zip 是排查失败最有用的东西，而失败不可预测
    tracing: true,
    recordFrames: true,
    casesDir: "./cases",
    runsDir: "./runs",
    // 登录态文件含会话 cookie，目录已在 .gitignore 里
    authDir: "./auth",
    defaultEngine: "typesafe",
  });
});

test("不传 env 时读 process.env", () => {
  const previous = process.env["JEVTEST_DEFAULT_ENGINE"];
  process.env["JEVTEST_DEFAULT_ENGINE"] = "scripted";
  try {
    assert.equal(loadSettings().defaultEngine, "scripted");
  } finally {
    if (previous === undefined) delete process.env["JEVTEST_DEFAULT_ENGINE"];
    else process.env["JEVTEST_DEFAULT_ENGINE"] = previous;
  }
});

test("显式给了值就用显式值", () => {
  const settings = loadSettings({
    TYPESAFE_MODEL: "jev-experimental",
    TEXT_MODEL_BASE_URL: "https://example.com/v1",
    TEXT_MODEL: "some-model",
    JEVTEST_PORT: "9000",
    JEVTEST_WORKERS: "4",
    JEVTEST_ENGINE_INFLIGHT: "8",
    JEVTEST_HEADLESS: "false",
    JEVTEST_TRACING: "off",
    JEVTEST_CASES_DIR: "/tmp/cases",
    JEVTEST_RUNS_DIR: "/tmp/runs",
    JEVTEST_DEFAULT_ENGINE: "scripted",
  });
  assert.equal(settings.typesafeModel, "jev-experimental");
  assert.equal(settings.textModelBaseUrl, "https://example.com/v1");
  assert.equal(settings.textModel, "some-model");
  assert.equal(settings.port, 9000);
  assert.equal(settings.workers, 4);
  assert.equal(settings.maxEngineInflight, 8);
  assert.equal(settings.headless, false);
  assert.equal(settings.tracing, false);
  assert.equal(settings.casesDir, "/tmp/cases");
  assert.equal(settings.runsDir, "/tmp/runs");
  assert.equal(settings.defaultEngine, "scripted");
});

test("未列出的环境变量（PATH 之类）不参与校验", () => {
  const settings = loadSettings({ PATH: "/usr/bin", HOME: "/root", RANDOM_THING: "x" });
  assert.equal(settings.port, 8770);
});

// ---------------------------------------------------------------------------
// 上限
// ---------------------------------------------------------------------------

test("workers 上限 8：8 通过、9 拒绝", () => {
  assert.equal(loadSettings({ JEVTEST_WORKERS: "8" }).workers, 8);
  assert.equal(loadSettings({ JEVTEST_WORKERS: "1" }).workers, 1);
  const message = assertRejected({ JEVTEST_WORKERS: "9" }, "JEVTEST_WORKERS");
  // 上限的理由要写出来，否则下一个人只会把上限改大
  assert.match(message, /超过上限 8/);
  // 修复建议必须是一个**真能用的值**，而且不能把上限说成默认值
  assert.match(message, /JEVTEST_WORKERS=8/);
  assert.match(message, /默认值 1/);
});

test("maxEngineInflight 默认 4、上限 16：16 通过、17 拒绝", () => {
  assert.equal(loadSettings({}).maxEngineInflight, 4);
  assert.equal(loadSettings({ JEVTEST_ENGINE_INFLIGHT: "16" }).maxEngineInflight, 16);
  const message = assertRejected({ JEVTEST_ENGINE_INFLIGHT: "17" }, "JEVTEST_ENGINE_INFLIGHT");
  assert.match(message, /超过上限 16/);
  assert.match(message, /默认值 4/);
});

test("workers 与 maxEngineInflight 是两个独立的闸", () => {
  // 刻意解耦的理由：前者限浏览器内存，后者限厂商侧限流。
  // 绑成一个总闸会让其中一个白白闲置（见 browser/pool.ts）。
  const settings = loadSettings({ JEVTEST_WORKERS: "2", JEVTEST_ENGINE_INFLIGHT: "12" });
  assert.equal(settings.workers, 2);
  assert.equal(settings.maxEngineInflight, 12);
});

// ---------------------------------------------------------------------------
// 正整数校验
// ---------------------------------------------------------------------------

test("port 的边界：1 与 65535 通过，0 与 65536 拒绝", () => {
  assert.equal(loadSettings({ JEVTEST_PORT: "1" }).port, 1);
  assert.equal(loadSettings({ JEVTEST_PORT: "65535" }).port, 65535);
  assertRejected({ JEVTEST_PORT: "0" }, "JEVTEST_PORT");
  assertRejected({ JEVTEST_PORT: "65536" }, "JEVTEST_PORT");
});

test("不像正整数的写法都拒绝：小数、夹字母、空串以外的空白", () => {
  assertRejected({ JEVTEST_PORT: "abc" }, "JEVTEST_PORT");
  assertRejected({ JEVTEST_PORT: "12abc" }, "JEVTEST_PORT");
  assertRejected({ JEVTEST_PORT: "1.5" }, "JEVTEST_PORT");
  assertRejected({ JEVTEST_PORT: "-1" }, "JEVTEST_PORT");
  // "1e3" 用 Number() 会算成 1000。这里只校验「是个正整数」，不做这种惊喜解释，
  // 但也不该被当成 1——用 Number 而不是 parseInt 就是为了不让 "12abc" 变成 12。
  assertRejected({ JEVTEST_WORKERS: "2abc" }, "JEVTEST_WORKERS");
});

test("空白视同未设置，走默认值", () => {
  // .env 里常见的 `JEVTEST_PORT=` 空着一行，不该被当成「port 是 0」
  assert.equal(loadSettings({ JEVTEST_PORT: "   " }).port, 8770);
  assert.equal(loadSettings({ JEVTEST_WORKERS: "" }).workers, 1);
});

test("数字两侧的空白会被容忍（从 .env 复制常带空格）", () => {
  assert.equal(loadSettings({ JEVTEST_WORKERS: " 3 " }).workers, 3);
});

// ---------------------------------------------------------------------------
// 布尔
// ---------------------------------------------------------------------------

test("布尔接受 true/false/1/0/on/off，不分大小写", () => {
  for (const raw of ["true", "TRUE", "True", "1", "on", "ON", "On"]) {
    assert.equal(loadSettings({ JEVTEST_TRACING: raw }).tracing, true, `${raw} 应为 true`);
    assert.equal(loadSettings({ JEVTEST_HEADLESS: raw }).headless, true, `${raw} 应为 true`);
  }
  for (const raw of ["false", "FALSE", "0", "off", "OFF"]) {
    assert.equal(loadSettings({ JEVTEST_TRACING: raw }).tracing, false, `${raw} 应为 false`);
    assert.equal(loadSettings({ JEVTEST_HEADLESS: raw }).headless, false, `${raw} 应为 false`);
  }
});

test("留空不等于 false，而是「没设置」——走默认值", () => {
  // 这条是刻意的：`.env.example` 里 `JEVTEST_TRACING=` 这种「留了个空」
  // 极容易被当成「关掉」，而它真正的意思是「没设」。两义会让 trace 静默消失，
  // 而 trace 恰恰是失败时最需要的东西。
  assert.equal(loadSettings({ JEVTEST_TRACING: "" }).tracing, true);
  assert.equal(loadSettings({ JEVTEST_TRACING: "   " }).tracing, true);
  // 要关掉必须显式写
  assert.equal(loadSettings({ JEVTEST_TRACING: "off" }).tracing, false);
});

test("不认识的布尔写法被拒绝，且说明留空的含义", () => {
  const message = assertRejected({ JEVTEST_HEADLESS: "yes" }, "JEVTEST_HEADLESS");
  // 清单按文档里的顺序列出，而不是按对象键的枚举顺序（那会变成 0 / 1 / true / ...）
  assert.match(message, /true \/ false \/ 1 \/ 0 \/ on \/ off/);
  assert.match(message, /留空不等于 false/);
  assert.match(message, /JEVTEST_HEADLESS=off/);
});

// ---------------------------------------------------------------------------
// 错误信息：一次列全 + 可复制
// ---------------------------------------------------------------------------

test("多项出错时一次全部列出，不用改一个跑一次", () => {
  const error = catchError({ JEVTEST_WORKERS: "9", JEVTEST_PORT: "0", JEVTEST_HEADLESS: "maybe" });
  assert.ok(error instanceof Error);
  assert.match(error.message, /JEVTEST_WORKERS/);
  assert.match(error.message, /JEVTEST_PORT/);
  assert.match(error.message, /JEVTEST_HEADLESS/);
  // 顺带指一下完整的清单在哪
  assert.match(error.message, /\.env\.example/);
});

test("错误信息里的默认值就是文档里的默认值（不会指错方向）", () => {
  const message = assertRejected({ JEVTEST_PORT: "99999" }, "JEVTEST_PORT");
  // 越界时给的建议是「照抄上限」，同时把真正的默认值也说出来
  assert.match(message, /JEVTEST_PORT=65535/);
  assert.match(message, /默认值 8770/);
});

// ---------------------------------------------------------------------------
// 凭证
// ---------------------------------------------------------------------------

test("缺 TYPESAFE_API_KEY 时 loadSettings 不抛错，由 missingCredentials 报告", () => {
  // 这是刻意的分工。doctor 与 run 的调用顺序都是
  //   settings = loadSettings(); missing = missingCredentials(settings)
  // 如果 loadSettings 在这里抛错，doctor 就永远没机会说清缺的是哪一项——
  // 而 doctor 存在的全部意义就是提前把这件事说出来（cli.ts 的检查 3）。
  const settings = loadSettings({});
  assert.doesNotThrow(() => loadSettings({}));
  assert.deepEqual(missingCredentials(settings), ["TYPESAFE_API_KEY"]);
});

test("配了 TYPESAFE_API_KEY 就不算缺", () => {
  const settings = loadSettings({ TYPESAFE_API_KEY: "sk-test-123" });
  assert.equal(settings.typesafeApiKey, "sk-test-123");
  assert.deepEqual(missingCredentials(settings), []);
});

test("只填空白等于没填（`.env.example` 里就是 `TYPESAFE_API_KEY=`）", () => {
  assert.deepEqual(missingCredentials(loadSettings({ TYPESAFE_API_KEY: "" })), ["TYPESAFE_API_KEY"]);
  assert.deepEqual(missingCredentials(loadSettings({ TYPESAFE_API_KEY: "   " })), ["TYPESAFE_API_KEY"]);
});

test("文本模型 key 缺失不算缺（只有 TYPE_TEXT 用例会失败）", () => {
  const settings = loadSettings({ TYPESAFE_API_KEY: "sk-test-123" });
  assert.equal(settings.textModelApiKey, null);
  // 决策引擎是必须的（没有它任何用例都跑不了）；文本取值小模型只在决策结果是
  // TYPE_TEXT 时被调用，缺了它不涉及输入的用例照样跑完。算作致命等于让整个平台
  // 为一个可选特性停摆——需要输入的用例受影响这件事由 doctor 单独作为 warning 报。
  assert.deepEqual(missingCredentials(settings), []);
});

test("文本模型 key 配了就原样带出来", () => {
  const settings = loadSettings({ TEXT_MODEL_API_KEY: "tp-abc" });
  assert.equal(settings.textModelApiKey, "tp-abc");
});

test("凭证两侧的空白被去掉（粘进 .env 常带尾随空格）", () => {
  // 带空格的 key 会让服务端报 401，而从错误信息里看不出是空格造成的
  const settings = loadSettings({ TYPESAFE_API_KEY: "  sk-test-123  ", TEXT_MODEL_API_KEY: "\ttp-abc\n" });
  assert.equal(settings.typesafeApiKey, "sk-test-123");
  assert.equal(settings.textModelApiKey, "tp-abc");
  assert.deepEqual(missingCredentials(settings), []);
});

test("missingCredentials 只返回变量名（CLI 直接拼给人看）", () => {
  const settings: Settings = loadSettings({});
  for (const name of missingCredentials(settings)) {
    assert.match(name, /^[A-Z_]+$/, `应该是环境变量名，实际是 ${name}`);
  }
});
