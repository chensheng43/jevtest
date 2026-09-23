/**
 * API 路由。前端与 CLI 共用。
 *
 * 全部返回 JSON。错误响应统一为 `{ error: string, detail?: unknown }`，
 * 且 **HTTP 状态码必须正确**——CLI 与 CI 都靠状态码判断成败。
 *
 * 端点一览（P0）：
 *
 *   GET  /api/health                     健康检查，CLI doctor 也会用
 *   GET  /api/engines                    已注册引擎与各自能力（决定概率断言是否可求值）
 *
 *   GET  /api/cases                      用例列表（含最近一次运行结论）
 *   GET  /api/cases/:id                  读一个用例（返回 YAML 文本 + 解析后的对象）
 *   POST /api/cases                      新建或更新（body 就是 CaseDefinition JSON）
 *   POST /api/cases/import               从 YAML 文本导入
 *   DELETE /api/cases/:id
 *   GET  /api/cases/:id/export           导出规范化 YAML
 *   POST /api/cases/:id/admit            对目标页面做一次准入检查（只读，不调用模型）
 *
 *   POST /api/runs                       入队运行（body: { caseIds, options }）
 *   GET  /api/runs                       历史列表（读 index.jsonl）
 *   GET  /api/runs/:id                   完整报告
 *   GET  /api/runs/:id/events?since=N    增量拉取事件（前端 500ms 轮询这个）
 *   GET  /api/runs/:id/frames/:n.jpg     截图帧
 *   GET  /api/runs/:id/trace.zip         Playwright trace
 *   POST /api/runs/:id/cancel
 *   GET  /api/runs/:id/export?format=md|junit
 *
 *   GET  /api/queue                      队列状态（含 contextsActive，用于查泄漏）
 *
 *   GET  /api/auth-states                登录态列表（只有摘要，绝不含 cookie 值）+ 各自被哪些用例引用
 *   POST /api/auth-states                上传一份 storageState（没有图形界面时的兜底）
 *   GET  /api/auth-states/:name
 *   POST /api/auth-states/:name/verify   用这份登录态无头打开一个地址，看是否仍是登录状态
 *   DELETE /api/auth-states/:name        被用例引用时需带 ?force=1
 *
 *   GET  /api/auth-window                登录窗口状态（null = 没开）
 *   POST /api/auth-window                在本机桌面弹出有界面的浏览器（body: { name, url, overwrite? }）
 *   POST /api/auth-window/save           导出登录态、落盘、关窗
 *   POST /api/auth-window/cancel         关窗、不保存
 *
 * 登录窗口不挂在 `/api/auth-states/` 下：`login`、`import` 这类词本身就是合法的登录态名字，
 * 挂在同一层会和 `:name` 撞路由。
 *
 * 一条约定：**事件响应里绝不带截图 base64**，只带 `frame` 序号，
 * 前端另外请求 frames/:n.jpg。这条把单条事件从约 200KB 压到约 400B。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CaseDefinitionSchema } from "../schema/case.ts";
import { CASE_ID_PATTERN, CaseConflict, CaseNotFound } from "../store/cases.ts";
import type { CaseStore, LoadedCase } from "../store/cases.ts";
import type { Case, CaseDefinition } from "../schema/case.ts";
import type { AdmissionReport, CaseRunReport, RunIndexEntry } from "../schema/report.ts";
import type { SeqEvent } from "../schema/events.ts";
import type { Settings } from "../config.ts";
import { missingCredentials } from "../config.ts";
import { admit } from "../browser/admission.ts";
import type { BrowserPool } from "../browser/pool.ts";
import { LoginBusy } from "../browser/login.ts";
import type { LoginManager } from "../browser/login.ts";
import { AuthStateNotFound, isValidAuthStateName, judgeLoggedIn, parseStorageState } from "../store/auth-states.ts";
import type { AuthStateStore, AuthStateSummary, AuthVerifyResult } from "../store/auth-states.ts";
import { GuardrailBlocked } from "../core/errors.ts";
import { assertAllowedOrigin, loginRedirectHint } from "../core/guard.ts";
import { listEngines } from "../engine/registry.ts";
import type { RunnerService } from "../core/runner.ts";
import { readIndex, readReport, toJUnit, toMarkdown } from "../core/report.ts";
import type { EventRouter } from "./events.ts";
import type { SecurityContext } from "./security.ts";

/**
 * cli 组装好的依赖集合。
 *
 * 脚手架里这两处写的是 `unknown`（「由 cli 组装好的依赖」）。这里收紧成具体类型：
 * `unknown` 让实现端只能靠断言访问，而依赖的形状是这里定死的，不是外部输入。
 */
export interface Services {
  settings: Settings;
  store: CaseStore;
  runner: RunnerService;
  pool: BrowserPool;
  events: EventRouter;
  authStates: AuthStateStore;
  login: LoginManager;
}

export interface ApiDeps {
  settings: Settings;
  services: Services;
  security: SecurityContext;
}

export interface ApiRequest {
  method: string;
  /** 已解析的路径，如 `/api/runs/abc/events` */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** 已限长读取的请求体 */
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  /** 二进制响应（截图、trace.zip）用它，body 则为空 */
  raw?: Buffer;
  contentType?: string;
}

/**
 * 事件端点的最长挂起时间。
 *
 * 前端是「拿到响应 → 等 500ms → 再请求」的串行轮询，因此服务端挂 1s 不会
 * 造成请求堆积，又足以让进度事件几乎立刻可见。把两个数字绑在一起的理由：
 * 服务端挂得比客户端轮询间隔还短，长轮询就退化成普通轮询了。
 */
export const EVENTS_LONG_POLL_MS = 1000;

/**
 * 路由处理函数。
 *
 * `handle(req)` 的签名里没有依赖，因此依赖由 server.ts 在 `createServer` 时注入一次。
 * 这是脚手架定下的形状（`ApiDeps` 存在而 `handle` 不收它），照此实现。
 */
let deps: ApiDeps | null = null;

export function configureApi(next: ApiDeps): void {
  deps = next;
}

function requireDeps(): ApiDeps {
  if (deps === null) {
    // 早失败：没装配就调用只会得到一堆误导性的 404，而真正的原因在装配处。
    throw new Error("api.handle 被调用前必须先 configureApi(deps)（由 createServer 负责）");
  }
  return deps;
}

/** 统一的错误响应。给人看的原因 + 可选的结构化细节（前端据此高亮字段）。 */
function fail(status: number, error: string, detail?: unknown): ApiResponse {
  return { status, body: detail === undefined ? { error } : { error, detail } };
}

function ok(body: unknown): ApiResponse {
  return { status: 200, body };
}

function text(contentType: string, content: string): ApiResponse {
  return {
    status: 200,
    body: null,
    raw: Buffer.from(content, "utf8"),
    contentType: `${contentType}; charset=utf-8`,
  };
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/**
 * zod 的 issue 路径转成点分字符串。
 *
 * `docs/api.md` §1.2 要求把 issue 路径（如 `assertions.final.controls.2.valueEquals`）
 * 原样回传，前端据此高亮对应表单字段——所以这里不能只给一句「校验失败」。
 */
function zodIssues(error: unknown): { path: string; message: string }[] | null {
  if (typeof error !== "object" || error === null) return null;
  const issues = (error as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  return issues.map((issue) => {
    const rec = asRecord(issue) ?? {};
    const path = Array.isArray(rec.path) ? rec.path.join(".") : "";
    return { path, message: typeof rec.message === "string" ? rec.message : "校验失败" };
  });
}

/** 把 store 抛出的错误映射成状态码。两个错误类的语义在 `store/cases.ts` 里已定。 */
async function storeFail(error: unknown, store: CaseStore, caseId: string): Promise<ApiResponse> {
  if (error instanceof CaseConflict) {
    // 冲突必须带上当前 revision，前端的提示才会是「重新加载后再改」
    // 而不是一句没用的「保存失败」。
    let currentRevision: number | null = null;
    try {
      currentRevision = (await store.read(caseId)).revision.revision;
    } catch {
      currentRevision = null;
    }
    return fail(409, error.message, { currentRevision });
  }
  if (error instanceof CaseNotFound) return fail(404, error.message);
  return fail(400, error instanceof Error ? error.message : String(error));
}

/**
 * 路径段的安全校验。
 *
 * 用例 id 与 runId 会成为磁盘路径的一部分（`frames/:n.jpg`、`trace.zip`、
 * `cases/<id>/`），因此必须与 `..`、分隔符、URL 编码过的变体彻底绝缘。
 * 用白名单正则而不是「过滤掉 ..」——黑名单永远漏得掉一种编码方式。
 */
const RUN_ID_PATTERN = /^[a-zA-Z0-9_-]{1,128}$/;

function isValidRunId(value: string): boolean {
  return RUN_ID_PATTERN.test(value);
}

function isValidCaseId(value: string): boolean {
  return CASE_ID_PATTERN.test(value);
}

/** 唯一的请求入口。server.ts 收到请求后调用它 */
export async function handle(req: ApiRequest): Promise<ApiResponse> {
  const { services, settings } = requireDeps();
  const path = req.path.split("?")[0] ?? "";
  const segments = path.split("/").filter((part) => part !== "");
  const method = req.method.toUpperCase();

  try {
    // ---- /api/... ---------------------------------------------------------
    if (segments[0] !== "api") return fail(404, `未知路径 ${path}`);

    // 环境。这三个端点只读，因此路径先匹配、再判方法——这样用错动词得到的是
    // 405（「路径存在但方法不对」）而不是 404（「路径不存在」），
    // 前者才说得清调用方错在哪。
    if (segments.length === 2 && segments[1] === "health") {
      if (method !== "GET") return fail(405, `health 只支持 GET（收到 ${method}）`);
      return ok({
        ok: true,
        node: process.version,
        uptimeMs: Math.round(process.uptime() * 1000),
        workers: settings.workers,
        maxEngineInflight: settings.maxEngineInflight,
        headless: settings.headless,
        tracing: settings.tracing,
        casesDir: settings.casesDir,
        runsDir: settings.runsDir,
        defaultEngine: settings.defaultEngine,
        missingCredentials: missingCredentials(settings),
      });
    }
    if (segments.length === 2 && segments[1] === "engines") {
      if (method !== "GET") return fail(405, `engines 只支持 GET（收到 ${method}）`);
      return ok(listEngines());
    }
    if (segments.length === 2 && segments[1] === "queue") {
      if (method !== "GET") return fail(405, `queue 只支持 GET（收到 ${method}）`);
      return ok(services.runner.status());
    }

    // ---- 用例 -------------------------------------------------------------
    if (segments[1] === "cases") {
      return await handleCases(req, segments, method);
    }

    // ---- 运行 -------------------------------------------------------------
    if (segments[1] === "runs") {
      return await handleRuns(req, segments, method);
    }

    // ---- 登录态 -----------------------------------------------------------
    if (segments[1] === "auth-states") {
      return await handleAuthStates(req, segments, method);
    }
    if (segments[1] === "auth-window") {
      return await handleAuthWindow(req, segments, method);
    }

    return fail(404, `未知路径 ${path}`);
  } catch (error) {
    // 任何未预期的异常都变成结构化响应：一个坏请求不该让服务进程倒下，
    // 而服务进程里还挂着在途用例与浏览器。
    const message = error instanceof Error ? error.message : String(error);
    const detail = zodIssues(error);
    return detail === null ? fail(500, message) : fail(400, message, detail);
  }
}

async function handleCases(
  req: ApiRequest,
  segments: string[],
  method: string,
): Promise<ApiResponse> {
  const { services } = requireDeps();
  const store = services.store;

  // GET /api/cases
  if (segments.length === 2) {
    if (method !== "GET" && method !== "POST") return fail(405, `${method} 不支持`);
    if (method === "GET") return ok(await store.list());

    const body = asRecord(req.body);
    if (body === null) return fail(400, "请求体必须是 CaseDefinition JSON 对象");
    const expectedRevision = body["expectedRevision"];
    if (expectedRevision !== undefined && typeof expectedRevision !== "number") {
      return fail(400, "expectedRevision 必须是数字");
    }
    const { expectedRevision: _ignored, ...definition } = body;
    void _ignored;
    try {
      // 服务端永远重新校验（`docs/api.md` §1.2）：前端那份只是即时反馈，
      // 不是信任边界。校验失败时把 issue 路径回传。
      // 这里的断言是**安全的**：`store.write` 内部第一步就是
      // `CaseDefinitionSchema.parse()`，任何不合规的字段都会在那里被拦下并抛出。
      // 不带 expectedRevision 一律按「新建」处理（期望 revision 0）：否则带一个已存在的 id
      // 就能绕过乐观锁静默覆盖原用例——新建用例时填了个重名 id 也会这样。
      const revision = await store.write(definition as unknown as CaseDefinition, {
        expectedRevision: typeof expectedRevision === "number" ? expectedRevision : 0,
      });
      return ok(revision);
    } catch (error) {
      if (error instanceof CaseConflict || error instanceof CaseNotFound) {
        const caseId = typeof definition["id"] === "string" ? definition["id"] : "";
        return await storeFail(error, store, caseId);
      }
      const detail = zodIssues(error);
      return detail === null
        ? fail(400, error instanceof Error ? error.message : String(error))
        : fail(400, "用例校验失败", detail);
    }
  }

  // POST /api/cases/import
  if (segments.length === 3 && segments[2] === "import" && method === "POST") {
    // 两种形态都接受：`{ yaml: "..." }` 与直接发原始 YAML 文本。
    // 前者是 JSON 端点的一致性写法，后者是 `curl --data-binary @case.yaml` 的用法。
    const yaml =
      typeof req.body === "string"
        ? req.body
        : typeof asRecord(req.body)?.["yaml"] === "string"
          ? (asRecord(req.body)?.["yaml"] as string)
          : null;
    if (yaml === null) return fail(400, "请求体必须是 { yaml: \"...\" } 或原始 YAML 文本");
    try {
      return ok(await store.import(yaml));
    } catch (error) {
      const detail = zodIssues(error);
      return detail === null
        ? fail(400, error instanceof Error ? error.message : String(error))
        : fail(400, "导入的 YAML 校验失败", detail);
    }
  }

  const caseId = segments[2];
  if (caseId === undefined || !isValidCaseId(caseId)) {
    return fail(400, `非法的用例 id：${caseId ?? ""}（应为 ^[a-z0-9][a-z0-9-]{1,63}$）`);
  }

  // GET /api/cases/:id
  if (segments.length === 3 && method === "GET") {
    try {
      const loaded: LoadedCase = await store.read(caseId);
      return ok(loaded);
    } catch (error) {
      return await storeFail(error, store, caseId);
    }
  }

  // DELETE /api/cases/:id
  if (segments.length === 3 && method === "DELETE") {
    try {
      await store.remove(caseId);
      return { status: 204, body: null };
    } catch (error) {
      return await storeFail(error, store, caseId);
    }
  }

  // GET /api/cases/:id/export
  if (segments.length === 4 && segments[3] === "export" && method === "GET") {
    try {
      return text("text/yaml", await store.export(caseId));
    } catch (error) {
      return await storeFail(error, store, caseId);
    }
  }

  // POST /api/cases/:id/admit
  if (segments.length === 4 && segments[3] === "admit" && method === "POST") {
    return await admitCase(caseId);
  }

  return fail(404, `未知路径 ${req.path}`);
}

/**
 * 对目标页面做一次准入检查。
 *
 * 只读、不调用模型，因此可以在表单里做一个「检测页面」按钮随手点。
 * 页面打不开返回 **502**：准入探测失败 ≠ 用例不可测，把两者混成同一个响应
 * 会让前端显示误导性的结论（`docs/api.md` §3.2）。
 */
async function admitCase(caseId: string): Promise<ApiResponse> {
  const { services } = requireDeps();
  let caseDef: Case;
  try {
    const loaded = await services.store.read(caseId);
    caseDef = CaseDefinitionSchema.parse(loaded.def);
  } catch (error) {
    if (error instanceof CaseNotFound) return fail(404, error.message);
    const detail = zodIssues(error);
    return detail === null
      ? fail(400, error instanceof Error ? error.message : String(error))
      : fail(400, "用例校验失败", detail);
  }

  if (caseDef.authState !== undefined && !(await services.authStates.exists(caseDef.authState))) {
    return fail(
      400,
      `用例引用的登录态 ${caseDef.authState} 不存在：到「登录态」页登录一次，或在用例里换一个`,
      { authState: caseDef.authState },
    );
  }

  try {
    const result = await services.pool.withSession(
      {
        // 准入探测不需要 trace：它是随手点一下的动作，落一份 trace.zip 只是垃圾。
        tracing: false,
        // 必须与真实运行带同一份登录态：否则探测的是登录页，报出来的「密码框」之类的
        // 警告全是登录页的，和用例真正要测的页面无关。
        ...(caseDef.authState === undefined
          ? {}
          : { storageStatePath: services.authStates.pathOf(caseDef.authState) }),
      },
      async (session) => {
        await session.goto(caseDef.startUrl, { waitUntil: "domcontentloaded" });
        const report: AdmissionReport = admit(await session.probe(), caseDef);
        return { report, finalUrl: session.currentUrl() };
      },
    );
    const { report, finalUrl } = result;
    // 一打开就被跳出白名单：真实运行会在第 0 步以 guardrail_blocked 结束。
    // 这比任何页面特征都更致命，所以列为 blocking，并说清下一步该做什么。
    const redirectedTo = outsideWhitelist(caseDef, finalUrl) ? finalUrl : null;
    if (redirectedTo !== null) {
      report.blocking.unshift(
        `打开 startUrl 后被跳到了白名单之外（${redirectedTo}），运行会在第 0 步被拦下。` +
          loginRedirectHint(caseDef.authState),
      );
      report.ok = false;
    }
    return ok({ ...report, redirectedTo });
  } catch (error) {
    return fail(
      502,
      `目标页面探测失败：${error instanceof Error ? error.message : String(error)}`,
      { startUrl: caseDef.startUrl },
    );
  }
}

async function handleRuns(
  req: ApiRequest,
  segments: string[],
  method: string,
): Promise<ApiResponse> {
  const { services, settings } = requireDeps();
  const runsDir = settings.runsDir;

  // GET /api/runs | POST /api/runs
  if (segments.length === 2) {
    if (method === "GET") {
      return ok(await readIndex(runsDir));
    }
    if (method !== "POST") return fail(405, `${method} 不支持`);

    const body = asRecord(req.body);
    const caseIds = body?.["caseIds"];
    if (!Array.isArray(caseIds) || caseIds.some((id) => typeof id !== "string")) {
      return fail(400, "请求体必须形如 { caseIds: string[], options? }");
    }
    if (caseIds.length === 0) return fail(400, "caseIds 不能为空");

    const cases: Case[] = [];
    for (const caseId of caseIds as string[]) {
      if (!isValidCaseId(caseId)) return fail(400, `非法的用例 id：${caseId}`);
      try {
        const loaded = await services.store.read(caseId);
        cases.push(CaseDefinitionSchema.parse(loaded.def));
      } catch (error) {
        if (error instanceof CaseNotFound) return fail(404, error.message);
        return fail(400, `用例 ${caseId} 无法解析：${error instanceof Error ? error.message : String(error)}`);
      }
    }

    const options = asRecord(body?.["options"]) ?? {};
    const { suiteRunId, runIds } = services.runner.enqueueMany(cases, {
      ...(typeof options["recordFrames"] === "boolean" ? { recordFrames: options["recordFrames"] } : {}),
      ...(typeof options["engineOverride"] === "string" ? { engineOverride: options["engineOverride"] } : {}),
    });
    // 200 而不是 202：`docs/api.md` 未规定状态码，而 202 会让调用方多一个
    // 「2xx 分支」要处理。响应体里的 runIds 已经把「这是排队结果」说清楚了。
    return ok({ suiteRunId, runIds });
  }

  const runId = segments[2];
  if (runId === undefined || !isValidRunId(runId)) {
    return fail(400, `非法的 runId：${runId ?? ""}`);
  }

  // GET /api/runs/:id
  if (segments.length === 3 && method === "GET") {
    try {
      const report: CaseRunReport = await readReport(runsDir, runId);
      return ok(report);
    } catch (error) {
      return fail(404, `读不到报告 ${runId}：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  // POST /api/runs/:id/cancel
  if (segments.length === 4 && segments[3] === "cancel" && method === "POST") {
    // 返回 boolean 而不是 404：取消是「请求」不是「保证」，
    // 运行可能已经自己结束了，那不是错误。
    return ok(services.runner.cancel(runId));
  }

  // GET /api/runs/:id/events?since=N
  if (segments.length === 4 && segments[3] === "events" && method === "GET") {
    const rawSince = req.query.get("since") ?? "0";
    const since = Number(rawSince);
    if (!Number.isFinite(since) || since < 0) {
      return fail(400, `since 必须是非负数字（收到 ${rawSince}）`);
    }
    // peek 而不是 log：查询一个不存在的运行不该在内存里留下一个永远不会淘汰的空日志
    const log = services.events.peek(runId);
    if (log === null) return ok([]);
    const sub = log.subscribe(Math.floor(since));
    const events: SeqEvent[] = [...sub.replay];
    if (events.length === 0) {
      // 没有历史就挂一小会儿。前端因此不必为了「下一步什么时候来」而高频轮询。
      const next = await sub.next(EVENTS_LONG_POLL_MS);
      if (next !== null) events.push(next);
    }
    sub.unsubscribe();
    return ok(events);
  }

  // GET /api/runs/:id/frames/:n.jpg
  if (segments.length === 5 && segments[3] === "frames" && method === "GET") {
    const frame = segments[4] ?? "";
    const matched = /^(\d+)\.jpg$/.exec(frame);
    if (matched === null) return fail(400, `帧路径必须形如 <n>.jpg（收到 ${frame}）`);
    return await serveArtifact(join(runsDir, runId, "frames", `${matched[1]}.jpg`), "image/jpeg", "截图帧");
  }

  // GET /api/runs/:id/trace.zip
  if (segments.length === 4 && segments[3] === "trace.zip" && method === "GET") {
    return await serveArtifact(join(runsDir, runId, "trace.zip"), "application/zip", "trace");
  }

  // GET /api/runs/:id/export?format=md|junit
  if (segments.length === 4 && segments[3] === "export" && method === "GET") {
    const format = req.query.get("format") ?? "md";
    let report: CaseRunReport;
    try {
      report = await readReport(runsDir, runId);
    } catch (error) {
      return fail(404, `读不到报告 ${runId}：${error instanceof Error ? error.message : String(error)}`);
    }
    if (format === "md") return text("text/markdown", toMarkdown(report));
    if (format === "junit") {
      // toJUnit 是 P1（见 `core/report.ts`）。这里明确回 501 而不是 500：
      // 它表示「这个能力还没实现」，不是「这次调用出错了」。
      return fail(501, "JUnit 导出尚未实现（P1）。暂时用 format=md。");
    }
    return fail(400, `未知的 format：${format}（可选 md / junit）`);
  }

  return fail(404, `未知路径 ${req.path}`);
}

/** 白名单判定复用护栏本身的实现，免得两处对「越界」的理解不一致 */
function outsideWhitelist(caseDef: Case, url: string): boolean {
  try {
    assertAllowedOrigin(caseDef, url);
    return false;
  } catch (error) {
    if (error instanceof GuardrailBlocked) return true;
    throw error;
  }
}

// ---------------------------------------------------------------------------
// 登录态
// ---------------------------------------------------------------------------

/**
 * 上传 storageState 的请求体上限。控制类端点的 8KB 装不下一份登录态
 * （几十个 cookie 加 localStorage 就过了），所以这一个端点单独放宽。
 * 由 server.ts 的 `bodyLimitFor` 使用。
 */
export const AUTH_UPLOAD_MAX_BYTES = 1024 * 1024;

/** 每份登录态被哪些用例引用。删除前的确认与列表页的「引用用例」列都靠它 */
async function authStateUsage(): Promise<Map<string, { id: string; title: string }[]>> {
  const { services } = requireDeps();
  const usage = new Map<string, { id: string; title: string }[]>();
  for (const summary of await services.store.list()) {
    try {
      const loaded = await services.store.read(summary.id);
      const name = loaded.def.authState;
      if (name === undefined) continue;
      const list = usage.get(name) ?? [];
      list.push({ id: summary.id, title: summary.title });
      usage.set(name, list);
    } catch {
      // 读不了的用例在用例列表里自会暴露，这里不因为它让登录态页打不开
    }
  }
  return usage;
}

function authFail(error: unknown): ApiResponse {
  if (error instanceof AuthStateNotFound) return fail(404, error.message);
  if (error instanceof LoginBusy) return fail(409, error.message);
  return fail(400, error instanceof Error ? error.message : String(error));
}

function withUsage(
  summary: AuthStateSummary,
  usage: Map<string, { id: string; title: string }[]>,
): AuthStateSummary & { usedBy: { id: string; title: string }[] } {
  return { ...summary, usedBy: usage.get(summary.name) ?? [] };
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

async function handleAuthStates(
  req: ApiRequest,
  segments: string[],
  method: string,
): Promise<ApiResponse> {
  const { services } = requireDeps();
  const authStates = services.authStates;

  // GET /api/auth-states | POST /api/auth-states（上传）
  if (segments.length === 2) {
    if (method === "GET") {
      const usage = await authStateUsage();
      return ok((await authStates.list()).map((summary) => withUsage(summary, usage)));
    }
    if (method !== "POST") return fail(405, `${method} 不支持`);

    const body = asRecord(req.body);
    const name = body?.["name"];
    if (typeof name !== "string" || !isValidAuthStateName(name)) {
      return fail(400, "name 必须是小写字母、数字与连字符，需以字母或数字开头，长度 2~64");
    }
    const loginUrl = body?.["loginUrl"];
    if (loginUrl !== undefined && loginUrl !== null && loginUrl !== "" && !isHttpUrl(loginUrl)) {
      return fail(400, "loginUrl 必须是 http/https 的绝对地址");
    }
    if (body?.["overwrite"] !== true && (await authStates.exists(name))) {
      return fail(409, `登录态 ${name} 已存在。要覆盖它，确认后再提交一次`, { exists: true });
    }
    try {
      // 前端既可能传对象，也可能把用户粘进来的原文当字符串传
      const raw = typeof body?.["state"] === "string" ? (JSON.parse(body["state"]) as unknown) : body?.["state"];
      const summary = await authStates.save(name, parseStorageState(raw), {
        loginUrl: isHttpUrl(loginUrl) ? loginUrl : null,
        source: "import",
      });
      return ok(withUsage(summary, await authStateUsage()));
    } catch (error) {
      return fail(400, `上传的登录态无法使用：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  const name = segments[2] ?? "";
  if (!isValidAuthStateName(name)) return fail(400, `非法的登录态名称：${name}`);

  // GET /api/auth-states/:name
  if (segments.length === 3 && method === "GET") {
    try {
      return ok(withUsage(await authStates.get(name), await authStateUsage()));
    } catch (error) {
      return authFail(error);
    }
  }

  // DELETE /api/auth-states/:name
  if (segments.length === 3 && method === "DELETE") {
    const usedBy = (await authStateUsage()).get(name) ?? [];
    if (usedBy.length > 0 && req.query.get("force") !== "1") {
      // 删掉仍被引用的登录态，那些用例下次运行会直接报「读不到登录态文件」。
      // 不是禁止，而是要调用方明确知道后果再来一次。
      return fail(409, `登录态 ${name} 仍被 ${usedBy.length} 个用例引用，删除后它们会运行失败`, { usedBy });
    }
    try {
      await authStates.remove(name);
      return { status: 204, body: null };
    } catch (error) {
      return authFail(error);
    }
  }

  // POST /api/auth-states/:name/verify
  if (segments.length === 4 && segments[3] === "verify" && method === "POST") {
    let summary: AuthStateSummary;
    try {
      summary = await authStates.get(name);
    } catch (error) {
      return authFail(error);
    }
    const requested = asRecord(req.body)?.["url"];
    const url = isHttpUrl(requested) ? requested : summary.loginUrl;
    if (url === null) return fail(400, "这份登录态没有记录登录地址，验证时需要给出 url");
    const result = await verifyAuthState(name, url);
    await authStates.recordVerify(name, result);
    return ok(result);
  }

  return fail(404, `未知路径 ${req.path}`);
}

/**
 * 验证：带着登录态无头打开 `url`，看页面是否「还是登录状态」。不调用模型、不花钱。
 * 判据见 `judgeLoggedIn`。
 */
async function verifyAuthState(name: string, url: string): Promise<AuthVerifyResult> {
  const { services } = requireDeps();
  const at = new Date().toISOString();
  try {
    const { finalUrl, passwordFields } = await services.pool.withSession(
      { tracing: false, storageStatePath: services.authStates.pathOf(name) },
      async (session) => {
        await session.goto(url, { waitUntil: "domcontentloaded" });
        const stats = await session.probe();
        return { finalUrl: session.currentUrl(), passwordFields: stats.passwordFields };
      },
    );
    return { at, url, finalUrl, ...judgeLoggedIn(url, finalUrl, passwordFields) };
  } catch (error) {
    return {
      at,
      ok: false,
      url,
      finalUrl: null,
      detail: `打不开 ${url}：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function handleAuthWindow(
  req: ApiRequest,
  segments: string[],
  method: string,
): Promise<ApiResponse> {
  const { services } = requireDeps();
  const { login, authStates } = services;

  // GET /api/auth-window | POST /api/auth-window
  if (segments.length === 2) {
    if (method === "GET") return ok(login.status());
    if (method !== "POST") return fail(405, `${method} 不支持`);

    const body = asRecord(req.body);
    const name = body?.["name"];
    const url = body?.["url"];
    if (typeof name !== "string" || !isValidAuthStateName(name)) {
      return fail(400, "name 必须是小写字母、数字与连字符，需以字母或数字开头，长度 2~64");
    }
    if (!isHttpUrl(url)) return fail(400, "url 必须是 http/https 的绝对地址");
    // 「新建」撞上已有名字要先确认；「重新登录」由前端带 overwrite: true。
    // 在开窗之前查：让人登录完才告诉他名字冲突，白登录一次。
    if (body?.["overwrite"] !== true && (await authStates.exists(name))) {
      return fail(409, `登录态 ${name} 已存在。要重新登录覆盖它，请用列表里的「重新登录」`, { exists: true });
    }
    try {
      return ok(await login.open(name, url));
    } catch (error) {
      if (error instanceof LoginBusy) return fail(409, error.message, { window: login.status() });
      return fail(502, error instanceof Error ? error.message : String(error));
    }
  }

  // POST /api/auth-window/save
  if (segments.length === 3 && segments[2] === "save" && method === "POST") {
    try {
      const captured = await login.capture();
      const summary = await authStates.save(captured.name, captured.state, {
        loginUrl: captured.url,
        source: "login",
      });
      return ok(withUsage(summary, await authStateUsage()));
    } catch (error) {
      return fail(409, error instanceof Error ? error.message : String(error), { window: login.status() });
    }
  }

  // POST /api/auth-window/cancel
  if (segments.length === 3 && segments[2] === "cancel" && method === "POST") {
    await login.cancel();
    return ok(null);
  }

  return fail(404, `未知路径 ${req.path}`);
}

/** 二进制产物（截图、trace）。路径由调用方用白名单 id 拼出，不接受任何外部片段。 */
async function serveArtifact(path: string, contentType: string, label: string): Promise<ApiResponse> {
  try {
    const data = await readFile(path);
    return { status: 200, body: null, raw: data, contentType };
  } catch {
    return fail(404, `${label}不存在：${path}`);
  }
}

// 供测试与 CLI 复用的辅助（`configureApi` 之后 handle 才可用）
export { isValidCaseId, isValidRunId };
