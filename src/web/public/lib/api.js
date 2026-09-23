/**
 * 与服务端说话的唯一出口。
 *
 * 所有失败都变成同一种 `ApiError`，带一个 `kind`，界面按 kind 决定**在哪里、怎么**说：
 *
 *   validation  400 且带 zod issue 列表 -> 字段下方 + 表单顶部汇总
 *   conflict    409                     -> 调用方按 detail 分情况处理（版本冲突、重名、窗口占用）
 *   notFound    404
 *   auth        403                     -> 全局横幅：令牌失效（服务重启过），刷新页面
 *   network     fetch 本身失败           -> 全局横幅：连不上服务
 *   server      5xx / 其他
 *
 * 服务端错误体是 `{ error, detail? }`（web/api.ts 的 fail()），`error` 已经是给人看的中文。
 */

const TOKEN = document.querySelector('meta[name="jevtest-token"]')?.content ?? "";
const TOKEN_HEADER = "x-jevtest-token";

export class ApiError extends Error {
  constructor(message, { status = 0, detail = undefined, kind = "server" } = {}) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.detail = detail;
    this.kind = kind;
  }

  /** zod issue 列表（`[{path, message}]`）；不是校验错误时为空数组 */
  get issues() {
    return Array.isArray(this.detail) ? this.detail : [];
  }
}

function kindOf(status, detail) {
  if (status === 403) return "auth";
  if (status === 404) return "notFound";
  if (status === 409) return "conflict";
  if (status === 400 && Array.isArray(detail)) return "validation";
  if (status >= 400 && status < 500) return "request";
  return "server";
}

/** 连接层面的问题（令牌失效、服务不可达）要让全局横幅知道，不管是哪个视图撞上的 */
const connectionListeners = new Set();
export function onConnection(listener) {
  connectionListeners.add(listener);
}
function reportConnection(state) {
  for (const listener of connectionListeners) listener(state);
}

/** 统一的请求封装：写操作自动带令牌，失败一律抛 `ApiError`。 */
export async function call(path, options = {}) {
  const init = { method: options.method ?? "GET", headers: {} };
  if (init.method !== "GET") {
    init.headers[TOKEN_HEADER] = TOKEN;
    init.headers["content-type"] = "application/json";
  }
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  let response;
  try {
    response = await fetch(path, init);
  } catch {
    reportConnection("down");
    throw new ApiError("连不上 jevtest 服务。它可能已经停了：重新运行 `jevtest serve` 后刷新页面。", { kind: "network" });
  }
  reportConnection("up");

  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  // **先看 body 空不空**，再看 content-type：DELETE 回 204 + 空 body，响应头却仍写着 json。
  // 对空串调 JSON.parse 会让每一次删除都报「Unexpected end of JSON input」——其实已经删了。
  if (body === "") {
    if (!response.ok) throw new ApiError(`请求失败（HTTP ${response.status}），服务端没有返回说明。`, { status: response.status, kind: kindOf(response.status) });
    return null;
  }

  if (!contentType.includes("json")) {
    if (!response.ok) throw new ApiError(`请求失败（HTTP ${response.status}）：${body.slice(0, 300)}`, { status: response.status, kind: kindOf(response.status) });
    return body;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    throw new ApiError(`服务端的响应不是合法的 JSON（HTTP ${response.status}）：${body.slice(0, 200)}`, { status: response.status });
  }
  if (!response.ok) {
    const kind = kindOf(response.status, payload?.detail);
    if (kind === "auth") reportConnection("auth");
    throw new ApiError(payload?.error ?? `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      detail: payload?.detail,
      kind,
    });
  }
  return payload;
}

// ---------------------------------------------------------------------------
// 引擎列表：编辑器的下拉框与「概率类断言会不会被跳过」的提示都靠它
// ---------------------------------------------------------------------------

let engines = [];
let enginesLoaded = false;

export async function loadEngines() {
  if (enginesLoaded) return engines;
  try {
    engines = await call("/api/engines");
    enginesLoaded = true;
  } catch {
    // 读不到引擎列表不该让整站打不开：编辑器退化成「用服务端默认引擎」
    engines = [];
  }
  return engines;
}

export function listEngines() {
  return engines;
}

// ---------------------------------------------------------------------------
// 常用动作
// ---------------------------------------------------------------------------

/** 入队运行，返回 runIds */
export async function startRuns(caseIds) {
  const { runIds } = await call("/api/runs", { method: "POST", body: { caseIds } });
  return runIds;
}

/** 跑一个用例并跳到它的结果页 */
export async function runCaseAndOpen(caseId) {
  const [runId] = await startRuns([caseId]);
  location.hash = `#/run/${runId}`;
}

/**
 * 把登录态写进一个**已保存**的用例并保存。带 expectedRevision：用例在别处被改过时照常 409，
 * 不静默覆盖。返回新的 revision。
 */
export async function applyAuthStateToCase(caseId, name) {
  const loaded = await call(`/api/cases/${caseId}`);
  const result = await call("/api/cases", {
    method: "POST",
    body: { ...loaded.def, authState: name, expectedRevision: loaded.revision.revision },
  });
  return result.revision;
}
