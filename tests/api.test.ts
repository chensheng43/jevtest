/**
 * Web 层的集成测试：真 `node:http` 服务、真守卫、真路由。
 *
 * 用假的 store / runner / pool，因为这里要验的**不是**用例怎么存、用例怎么跑，
 * 而是**边界行为**：谁能发请求、请求体多大算大、坏 id 会不会变成目录穿越、
 * 失败的状态码是不是它该是的那一个。
 *
 * 这些行为出错的方式都是「静默」的——守卫漏一条是安全问题，状态码错一个是
 * CI 判断失误——所以每条都要有反向用例。
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { request as httpRequest } from "node:http";

import { createServer } from "../src/web/server.ts";
import { createEventRouter } from "../src/web/events.ts";
import { MAX_BODY_BYTES, TOKEN_HEADER } from "../src/web/security.ts";
import type { SecurityContext } from "../src/web/security.ts";
import type { Services } from "../src/web/api.ts";
import type { Settings } from "../src/config.ts";
import type { CaseStore, WriteOptions } from "../src/store/cases.ts";
import type { CaseRevision } from "../src/schema/case.ts";
import { CaseConflict, CaseNotFound } from "../src/store/cases.ts";
import type { RunnerService, QueueStatus } from "../src/core/runner.ts";
import type { BrowserPool, ContextOptions } from "../src/browser/pool.ts";
import type { LoginManager, LoginWindowStatus } from "../src/browser/login.ts";
import { LoginBusy } from "../src/browser/login.ts";
import { createAuthStateStore } from "../src/store/auth-states.ts";
import type { AuthStateSummary, StorageState } from "../src/store/auth-states.ts";

const TOKEN = "test-token-0123456789abcdef";

function testSettings(overrides: Partial<Settings>): Settings {
  return {
    typesafeApiKey: "k",
    typesafeModel: "m",
    textModelApiKey: null,
    textModelBaseUrl: "http://localhost",
    textModel: "t",
    port: 0,
    workers: 1,
    maxEngineInflight: 4,
    headless: true,
    tracing: false,
    recordFrames: false,
    casesDir: "./cases",
    runsDir: "./runs",
    authDir: "./auth",
    defaultEngine: "typesafe",
    ...overrides,
  };
}

/** 最近一次 `store.write` 收到的选项：路由怎么传乐观锁参数，只能从这里取证。 */
const writeOptionsSeen: Array<WriteOptions | undefined> = [];

/** 只实现路由会用到的那部分用例仓库。 */
function makeFakeStore(options: { conflict?: boolean; missing?: boolean } = {}): CaseStore {
  const revision = (caseId: string): CaseRevision => ({
    caseId,
    revision: 3,
    digest: "d".repeat(64),
    savedAt: new Date().toISOString(),
  });
  const guardWrite = (): void => {
    if (options.conflict === true) throw new CaseConflict("用例已被改动，请重新加载后再保存");
    if (options.missing === true) throw new CaseNotFound("用例不存在");
  };
  return {
    list: async () => [],
    read: async (caseId) => {
      // 只有 `missing` 会让读也失败。`conflict` 专指**写入**时乐观锁不过——
      // 路由在回 409 时需要重新读一次拿当前 revision，所以这两件事不能混。
      if (options.missing === true) throw new CaseNotFound("用例不存在");
      return {
        def: { id: caseId, title: "t", goal: "g", startUrl: "https://example.com" },
        revision: revision(caseId),
        yaml: "id: x\n",
      };
    },
    write: async (def, writeOptions) => {
      writeOptionsSeen.push(writeOptions);
      guardWrite();
      return revision(def.id ?? "allocated");
    },
    remove: async () => {
      guardWrite();
    },
    import: async () => {
      guardWrite();
      return revision("imported");
    },
    export: async () => "schemaVersion: 1\n",
    freeze: async (caseId) => revision(caseId),
    allocateId: async () => "allocated",
    readRevision: async () => "schemaVersion: 1\n",
  };
}

function makeFakeRunner(counters: { cancelled: string[] }): RunnerService {
  const status: QueueStatus = { queued: 0, active: 0, workers: 1, contextsActive: 0 };
  return {
    enqueue: () => ({ runId: "r1" }),
    enqueueMany: (_cases, options) => ({
      suiteRunId: options?.suiteRunId ?? "suite-1",
      runIds: ["r1", "r2"],
    }),
    cancel: (runId) => {
      counters.cancelled.push(runId);
      return true;
    },
    cancelAll: () => {},
    status: () => status,
    start: () => {},
    stop: async () => {},
  };
}

/** 每次借 context 时传的选项。登录态是否被带上，只能从这里看出来 */
const poolOptionsSeen: ContextOptions[] = [];

function makeFakePool(): BrowserPool {
  return {
    start: async () => {},
    withSession: async (options, fn) => {
      poolOptionsSeen.push(options);
      return fn({
        goto: async () => ({}),
        observe: async () => ({}),
        isFresh: async () => true,
        act: async () => {},
        currentUrl: () => "https://example.com/",
        // 刻意的混合统计：唯一一个 iframe 是跨域的（正好各命中一条规则，
        // 免得同时触发「同源 iframe」那条而使断言数不清）+ 一个密码框。
        // 这条测试验的是**接线**（probe 的统计真的流进了 admit 并变成响应里的文案），
        // 规则本身由 tests/admission.test.ts 逐条覆盖。
        probe: async () => ({
          frames: 1,
          crossOriginFrames: 1,
          shadowRoots: 0,
          canvases: 0,
          passwordFields: 1,
          fileInputs: 0,
          nestedScrollContainers: 0,
          interactiveElements: 5,
        }),
        frameJpeg: async () => Buffer.from([0xff, 0xd8]),
        close: async () => {},
      } as never);
    },
    saveStorageState: async () => {},
    activeContexts: () => 0,
    stop: async () => {},
  };
}

/** 一份最小的 storageState。cookie 值用一个醒目的串，便于断言它**没有**出现在响应里 */
const SECRET_COOKIE_VALUE = "super-secret-session-value";
const SAMPLE_STATE: StorageState = {
  cookies: [
    {
      name: "sid",
      value: SECRET_COOKIE_VALUE,
      domain: ".example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
  ],
  origins: [{ origin: "https://example.com", localStorage: [{ name: "token", value: "t" }] }],
};

/**
 * 登录窗口的替身：不弹浏览器，只记录状态。
 * `busy` 打开时 open 抛 LoginBusy，用来验 409 的映射。
 */
const loginControl = { busy: false, opened: [] as { name: string; url: string }[] };

function makeFakeLogin(): LoginManager {
  let current: LoginWindowStatus | null = null;
  return {
    open: async (name, url) => {
      if (loginControl.busy) throw new LoginBusy("someone-else");
      loginControl.opened.push({ name, url });
      current = { name, url, startedAt: new Date().toISOString(), state: "open", currentUrl: url, closedReason: null };
      return current;
    },
    status: () => current,
    capture: async () => {
      if (current === null) throw new Error("没有开着的登录窗口");
      const captured = { name: current.name, url: current.url, state: SAMPLE_STATE };
      current = null;
      return captured;
    },
    cancel: async () => {
      current = null;
    },
    stop: async () => {
      current = null;
    },
  };
}

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

function raw(
  port: number,
  options: { method: string; path: string; headers?: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolvePromise, rejectPromise) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method,
        path: options.path,
        headers: options.headers ?? {},
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () =>
          resolvePromise({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          }),
        );
      },
    );
    req.on("error", rejectPromise);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

let root = "";
let port = 0;
let server: ReturnType<typeof createServer>;
let settings: Settings;
let events: ReturnType<typeof createEventRouter>;
const counters = { cancelled: [] as string[] };
const conflictOptions = { conflict: false, missing: false };
let store: CaseStore;

before(async () => {
  root = await mkdtemp(join(tmpdir(), "jevtest-api-"));
  settings = testSettings({
    casesDir: join(root, "cases"),
    runsDir: join(root, "runs"),
    authDir: join(root, "auth"),
  });
  await mkdir(settings.runsDir, { recursive: true });

  events = createEventRouter();
  store = makeFakeStore(conflictOptions);
  const security: SecurityContext = { token: TOKEN, port: 0, origin: "http://127.0.0.1:0" };
  const services: Services = {
    settings,
    store,
    runner: makeFakeRunner(counters),
    pool: makeFakePool(),
    events,
    authStates: createAuthStateStore({ root: settings.authDir }),
    login: makeFakeLogin(),
  };
  server = createServer({ settings, security, services });
  // 传 0：端口由系统分配，createServer 会把 security.port 校正成真实端口
  // （否则 Host 守卫会把所有请求判 403，包括下面这些正向用例）。
  port = await server.listen(0);
});

after(async () => {
  await server.close();
  await rm(root, { recursive: true, force: true });
});

const host = (): Record<string, string> => ({ host: `127.0.0.1:${port}` });
const authed = (): Record<string, string> => ({
  ...host(),
  [TOKEN_HEADER]: TOKEN,
  origin: `http://127.0.0.1:${port}`,
  "content-type": "application/json",
});

test("GET 类端点只校验 Host", async () => {
  const res = await raw(port, { method: "GET", path: "/api/health", headers: host() });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { ok: boolean; workers: number };
  assert.equal(body.ok, true);
  assert.equal(body.workers, 1);
});

test("Host 不是 127.0.0.1:<port> 时一律 403（防 DNS rebinding）", async () => {
  const res = await raw(port, {
    method: "GET",
    path: "/api/health",
    headers: { host: "evil.example.com" },
  });
  assert.equal(res.status, 403);
});

test("写端点缺令牌 403，且不回显收到的令牌", async () => {
  const res = await raw(port, {
    method: "POST",
    path: "/api/cases",
    headers: { ...host(), "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(res.status, 403);
  assert.equal(res.body.includes(TOKEN), false);

  const wrong = await raw(port, {
    method: "POST",
    path: "/api/cases",
    headers: { ...host(), [TOKEN_HEADER]: "guessed-token", "content-type": "application/json" },
    body: "{}",
  });
  assert.equal(wrong.status, 403);
  assert.equal(wrong.body.includes("guessed-token"), false);
});

test("跨站 Origin 被拒（防跨站表单提交）", async () => {
  const res = await raw(port, {
    method: "POST",
    path: "/api/cases",
    headers: {
      ...host(),
      [TOKEN_HEADER]: TOKEN,
      origin: "http://evil.example.com",
      "content-type": "application/json",
    },
    body: "{}",
  });
  assert.equal(res.status, 403);
});

test("请求体超过上限返回 413", async () => {
  const res = await raw(port, {
    method: "POST",
    path: "/api/cases",
    headers: authed(),
    body: JSON.stringify({ padding: "x".repeat(MAX_BODY_BYTES + 100) }),
  });
  assert.equal(res.status, 413);
});

test("请求体不是合法 JSON 返回 400", async () => {
  const res = await raw(port, {
    method: "POST",
    path: "/api/cases",
    headers: authed(),
    body: "{ not json",
  });
  assert.equal(res.status, 400);
});

test("POST /api/cases 成功返回 CaseRevision", async () => {
  const res = await raw(port, {
    method: "POST",
    path: "/api/cases",
    headers: authed(),
    body: JSON.stringify({ id: "abc", title: "t", goal: "g", startUrl: "https://example.com" }),
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as CaseRevision;
  assert.equal(body.revision, 3);
});

test("POST /api/cases 不带 expectedRevision 时按「新建」处理（期望 revision 0），不能绕过乐观锁", async () => {
  writeOptionsSeen.length = 0;
  const res = await raw(port, {
    method: "POST",
    path: "/api/cases",
    headers: authed(),
    body: JSON.stringify({ id: "abc", title: "t", goal: "g", startUrl: "https://e.com" }),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(writeOptionsSeen, [{ expectedRevision: 0 }]);
});

test("乐观锁冲突返回 409 且带上当前 revision", async () => {
  conflictOptions.conflict = true;
  try {
    const res = await raw(port, {
      method: "POST",
      path: "/api/cases",
      headers: authed(),
      body: JSON.stringify({ id: "abc", title: "t", goal: "g", startUrl: "https://e.com", expectedRevision: 1 }),
    });
    assert.equal(res.status, 409);
    const body = JSON.parse(res.body) as { error: string; detail: { currentRevision: number } };
    // 前端要靠这个数字提示「已被改动，重新加载后再保存」。
    assert.equal(body.detail.currentRevision, 3);
  } finally {
    conflictOptions.conflict = false;
  }
});

test("用例不存在返回 404", async () => {
  conflictOptions.missing = true;
  try {
    const res = await raw(port, { method: "GET", path: "/api/cases/abc", headers: host() });
    assert.equal(res.status, 404);
  } finally {
    conflictOptions.missing = false;
  }
});

test("非法用例 id 返回 400（白名单正则，不是过滤掉 ..）", async () => {
  for (const bad of ["ABC", "a", "%2e%2e", "x/y", "a".repeat(70)]) {
    const res = await raw(port, { method: "GET", path: `/api/cases/${bad}`, headers: host() });
    assert.equal(res.status === 400 || res.status === 404, true, `${bad} -> ${res.status}`);
  }
});

test("DELETE 成功返回 204 且无响应体", async () => {
  const res = await raw(port, { method: "DELETE", path: "/api/cases/abc", headers: authed() });
  assert.equal(res.status, 204);
  assert.equal(res.body, "");
});

test("GET /api/cases/:id/export 返回 text/yaml", async () => {
  const res = await raw(port, { method: "GET", path: "/api/cases/abc/export", headers: host() });
  assert.equal(res.status, 200);
  assert.equal(String(res.headers["content-type"]).startsWith("text/yaml"), true);
  assert.equal(res.body, "schemaVersion: 1\n");
});

test("POST /api/cases/:id/admit 返回准入报告", async () => {
  const res = await raw(port, { method: "POST", path: "/api/cases/abc/admit", headers: authed() });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as {
    ok: boolean;
    blocking: string[];
    warnings: string[];
    stats: { crossOriginFrames: number };
  };
  // 跨域 iframe 与密码框都只是警告，不是阻断项——**准入是记录与警告，不是运行的闸**
  // （architecture §11.1 ⑥）。因此 ok 仍为 true，运行照跑。
  assert.equal(body.ok, true);
  assert.deepEqual(body.blocking, []);
  assert.equal(body.warnings.length, 2);
  assert.equal(body.stats.crossOriginFrames, 1);
  assert.equal(
    body.warnings.some((line) => line.includes("跨域")),
    true,
    `警告里应说明跨域 iframe：${body.warnings.join(" / ")}`,
  );
});

test("POST /api/runs 用 runner 入队并返回 runIds", async () => {
  const res = await raw(port, {
    method: "POST",
    path: "/api/runs",
    headers: authed(),
    body: JSON.stringify({ caseIds: ["abc"] }),
  });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { suiteRunId: string; runIds: string[] };
  assert.deepEqual(body.runIds, ["r1", "r2"]);
});

test("POST /api/runs 的 caseIds 形状不对返回 400", async () => {
  for (const payload of [{}, { caseIds: [] }, { caseIds: [1] }]) {
    const res = await raw(port, {
      method: "POST",
      path: "/api/runs",
      headers: authed(),
      body: JSON.stringify(payload),
    });
    assert.equal(res.status, 400);
  }
});

test("非法 runId 被挡在文件读取之前", async () => {
  for (const bad of ["..%2F..%2Fetc", "a%2Fb", "x".repeat(200)]) {
    const res = await raw(port, { method: "GET", path: `/api/runs/${bad}`, headers: host() });
    assert.equal(res.status, 400, `${bad} -> ${res.status}`);
    // 拒绝的理由不该把解析后的磁盘路径回显出来——那本身就是信息泄漏。
    assert.equal(res.body.includes("etc/passwd") || res.body.includes("\\etc\\"), false);
  }
});

test("帧路径必须形如 <n>.jpg", async () => {
  const bad = await raw(port, { method: "GET", path: "/api/runs/r1/frames/x.png", headers: host() });
  assert.equal(bad.status, 400);
  const missing = await raw(port, { method: "GET", path: "/api/runs/r1/frames/1.jpg", headers: host() });
  assert.equal(missing.status, 404);
});

test("取消转发给 runner", async () => {
  const res = await raw(port, { method: "POST", path: "/api/runs/r1/cancel", headers: authed() });
  assert.equal(res.status, 200);
  assert.deepEqual(counters.cancelled, ["r1"]);
});

test("events 端点回放该运行的事件（前端增量拉取的数据源）", async () => {
  events.sink.emit({ type: "run.queued", runId: "r9", caseId: "abc" });
  events.sink.emit({ type: "run.started", runId: "r9", caseId: "abc", engine: "typesafe" });
  const res = await raw(port, { method: "GET", path: "/api/runs/r9/events?since=0", headers: host() });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { seq: number; type: string }[];
  assert.deepEqual(
    body.map((e) => e.type),
    ["run.queued", "run.started"],
  );
  assert.deepEqual(
    body.map((e) => e.seq),
    [1, 2],
  );

  // 增量：带上上次的 seq 只拿新的
  events.sink.emit({
    type: "run.finished",
    runId: "r9",
    status: "done",
    passed: true,
    elapsedMs: 5,
    stats: {} as never,
  });
  const delta = await raw(port, { method: "GET", path: "/api/runs/r9/events?since=2", headers: host() });
  const deltaBody = JSON.parse(delta.body) as { seq: number }[];
  assert.deepEqual(deltaBody.map((e) => e.seq), [3]);
});

test("events 的 since 非法返回 400", async () => {
  const res = await raw(port, { method: "GET", path: "/api/runs/r9/events?since=abc", headers: host() });
  assert.equal(res.status, 400);
});

test("未知路径返回 404，不支持的方法返回 405", async () => {
  const unknown = await raw(port, { method: "GET", path: "/api/nope", headers: host() });
  assert.equal(unknown.status, 404);
  const notApi = await raw(port, { method: "GET", path: "/nope/nope", headers: host() });
  assert.equal(notApi.status, 404);
  const method = await raw(port, { method: "POST", path: "/api/health", headers: authed() });
  assert.equal(method.status, 405);
});

test("index.html 里的令牌占位符被替换", async () => {
  const res = await raw(port, { method: "GET", path: "/", headers: host() });
  assert.equal(res.status, 200);
  assert.equal(res.body.includes("__JEVTEST_TOKEN__"), false);
  assert.equal(res.body.includes(TOKEN), true);
  // 令牌页面绝不能被缓存：否则刷新后前端会带着过期令牌，所有写操作 403。
  assert.equal(res.headers["cache-control"], "no-store");
});

test("/vendor/* 拒绝目录穿越与非白名单扩展名", async () => {
  const traversal = await raw(port, {
    method: "GET",
    path: "/vendor/%2e%2e/%2e%2e/package.json",
    headers: host(),
  });
  assert.notEqual(traversal.status, 200);

  const notAllowed = await raw(port, { method: "GET", path: "/vendor/zod/package.json.bak", headers: host() });
  assert.notEqual(notAllowed.status, 200);
});

test("队列状态能反映 contextsActive（判断 context 泄漏的唯一手段）", async () => {
  const res = await raw(port, { method: "GET", path: "/api/queue", headers: host() });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as QueueStatus;
  assert.equal(body.contextsActive, 0);
});

test("引擎列表按 docs/api.md §3.1 的形状返回", async () => {
  const res = await raw(port, { method: "GET", path: "/api/engines", headers: host() });
  assert.equal(res.status, 200);
  const body = JSON.parse(res.body) as { name: string; text: boolean; probabilities: string }[];
  assert.equal(Array.isArray(body), true);
  for (const engine of body) {
    assert.equal(typeof engine.name, "string");
    assert.equal(typeof engine.text, "boolean");
    assert.equal(typeof engine.probabilities, "string");
  }
});

// 供未来扩展：确认临时目录确实被创建（这条也顺带记录 settings 的形状要求）
test("测试用的 runsDir 是真的目录", async () => {
  await writeFile(join(resolve(settings.runsDir), "index.jsonl"), "", "utf8");
});

// ---------------------------------------------------------------------------
// 登录态
// ---------------------------------------------------------------------------

test("上传登录态：落盘成功，响应里只有摘要、绝不含 cookie 值", async () => {
  const res = await raw(port, {
    method: "POST",
    path: "/api/auth-states",
    headers: authed(),
    body: JSON.stringify({ name: "upload-ok", state: SAMPLE_STATE, loginUrl: "https://example.com/" }),
  });
  assert.equal(res.status, 200, res.body);
  assert.equal(res.body.includes(SECRET_COOKIE_VALUE), false, "响应里不该出现 cookie 值");
  const body = JSON.parse(res.body) as AuthStateSummary & { usedBy: unknown[] };
  assert.equal(body.name, "upload-ok");
  assert.equal(body.cookieCount, 1);
  assert.deepEqual(body.sites, ["example.com"]);
  assert.equal(body.source, "import");
  assert.deepEqual(body.usedBy, []);

  const list = await raw(port, { method: "GET", path: "/api/auth-states", headers: host() });
  assert.equal(list.status, 200);
  assert.equal(list.body.includes(SECRET_COOKIE_VALUE), false);
  assert.equal((JSON.parse(list.body) as { name: string }[]).some((item) => item.name === "upload-ok"), true);
});

test("上传登录态：同名已存在时 409，带 overwrite 才覆盖", async () => {
  const payload = { name: "upload-dup", state: SAMPLE_STATE };
  const first = await raw(port, { method: "POST", path: "/api/auth-states", headers: authed(), body: JSON.stringify(payload) });
  assert.equal(first.status, 200);
  const again = await raw(port, { method: "POST", path: "/api/auth-states", headers: authed(), body: JSON.stringify(payload) });
  assert.equal(again.status, 409);
  const forced = await raw(port, {
    method: "POST",
    path: "/api/auth-states",
    headers: authed(),
    body: JSON.stringify({ ...payload, overwrite: true }),
  });
  assert.equal(forced.status, 200);
});

test("上传登录态：形状不对 / 名字非法 返回 400", async () => {
  const bad = await raw(port, {
    method: "POST",
    path: "/api/auth-states",
    headers: authed(),
    body: JSON.stringify({ name: "bad-shape", state: { cookies: "nope" } }),
  });
  assert.equal(bad.status, 400);
  assert.match(bad.body, /storageState/);

  for (const name of ["../etc", "A", "x", "has.dot"]) {
    const res = await raw(port, {
      method: "POST",
      path: "/api/auth-states",
      headers: authed(),
      body: JSON.stringify({ name, state: SAMPLE_STATE }),
    });
    assert.equal(res.status, 400, `名字 ${name} 应被拒绝`);
  }
});

test("上传登录态的请求体上限单独放宽，其他端点仍是 8KB", async () => {
  // 造一份超过 8KB 的登录态：真实站点几十个 cookie 就是这个量级
  const big: StorageState = {
    cookies: Array.from({ length: 80 }, (_, i) => ({ ...SAMPLE_STATE.cookies[0]!, name: `c${i}`, value: "v".repeat(100) })),
    origins: [],
  };
  const body = JSON.stringify({ name: "upload-big", state: big });
  assert.equal(body.length > MAX_BODY_BYTES, true);
  const res = await raw(port, { method: "POST", path: "/api/auth-states", headers: authed(), body });
  assert.equal(res.status, 200, res.body);

  const other = await raw(port, { method: "POST", path: "/api/runs", headers: authed(), body });
  assert.equal(other.status, 413);
});

test("登录窗口：打开 -> 保存，登录态以 source=login 落盘", async () => {
  const open = await raw(port, {
    method: "POST",
    path: "/api/auth-window",
    headers: authed(),
    body: JSON.stringify({ name: "win-ok", url: "https://example.com/app" }),
  });
  assert.equal(open.status, 200, open.body);
  assert.equal((JSON.parse(open.body) as LoginWindowStatus).state, "open");

  const status = await raw(port, { method: "GET", path: "/api/auth-window", headers: host() });
  assert.equal((JSON.parse(status.body) as LoginWindowStatus).name, "win-ok");

  const save = await raw(port, { method: "POST", path: "/api/auth-window/save", headers: authed() });
  assert.equal(save.status, 200, save.body);
  const saved = JSON.parse(save.body) as AuthStateSummary;
  assert.equal(saved.source, "login");
  assert.equal(saved.loginUrl, "https://example.com/app");
  assert.equal(save.body.includes(SECRET_COOKIE_VALUE), false);

  const after = await raw(port, { method: "GET", path: "/api/auth-window", headers: host() });
  assert.equal(after.body, "null");
});

test("登录窗口：名字已存在且没说要覆盖时，开窗之前就 409（不让人白登录一次）", async () => {
  const before = loginControl.opened.length;
  const res = await raw(port, {
    method: "POST",
    path: "/api/auth-window",
    headers: authed(),
    body: JSON.stringify({ name: "win-ok", url: "https://example.com/app" }),
  });
  assert.equal(res.status, 409);
  assert.equal(loginControl.opened.length, before, "冲突时不该弹窗");
});

test("登录窗口：已有窗口开着时 409", async () => {
  loginControl.busy = true;
  try {
    const res = await raw(port, {
      method: "POST",
      path: "/api/auth-window",
      headers: authed(),
      body: JSON.stringify({ name: "win-busy", url: "https://example.com/" }),
    });
    assert.equal(res.status, 409);
  } finally {
    loginControl.busy = false;
  }
});

test("登录窗口：没有窗口时保存返回 409 而不是 500", async () => {
  const res = await raw(port, { method: "POST", path: "/api/auth-window/save", headers: authed() });
  assert.equal(res.status, 409);
});

test("验证登录态：带着它的文件借 context；停在登录框上判为失效", async () => {
  await raw(port, {
    method: "POST",
    path: "/api/auth-states",
    headers: authed(),
    body: JSON.stringify({ name: "verify-me", state: SAMPLE_STATE, loginUrl: "https://example.com/" }),
  });
  poolOptionsSeen.length = 0;
  const res = await raw(port, { method: "POST", path: "/api/auth-states/verify-me/verify", headers: authed() });
  assert.equal(res.status, 200, res.body);
  assert.equal(poolOptionsSeen[0]?.storageStatePath, join(settings.authDir, "verify-me.json"));
  // 替身页面停在同源、但有 1 个密码框：按「停在了登录页」处理
  const result = JSON.parse(res.body) as { ok: boolean; detail: string };
  assert.equal(result.ok, false);
  assert.match(result.detail, /密码框/);

  const summary = await raw(port, { method: "GET", path: "/api/auth-states/verify-me", headers: host() });
  assert.equal((JSON.parse(summary.body) as AuthStateSummary).lastVerified?.ok, false);
});

test("删除登录态：不存在 404，存在 204", async () => {
  const missing = await raw(port, { method: "DELETE", path: "/api/auth-states/nope-nope", headers: authed() });
  assert.equal(missing.status, 404);
  await raw(port, {
    method: "POST",
    path: "/api/auth-states",
    headers: authed(),
    body: JSON.stringify({ name: "delete-me", state: SAMPLE_STATE }),
  });
  const res = await raw(port, { method: "DELETE", path: "/api/auth-states/delete-me", headers: authed() });
  assert.equal(res.status, 204);
});
