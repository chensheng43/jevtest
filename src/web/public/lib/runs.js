/**
 * 运行与登录态的领域小工具：状态文案、判决档位、登录跳转识别、登录态匹配。
 *
 * 不碰 DOM——`lib/core.js` 从这里取状态表，而 core.js 要能在 Node 里被测试直接 import。
 */

export const RUN_STATUSES = [
  "queued",
  "running",
  "done",
  "blocked",
  "budget_exceeded",
  "guardrail_blocked",
  "cancelled",
  "error",
];

/**
 * 结束方式的文案。`status` 只描述**循环如何结束**，与判决（passed）是两件事（D8）：
 * `done` 只是「模型说做完了」，不是证据——所以它的文案里就带着这层意思。
 */
export const STATUS_LABELS = {
  queued: "排队中",
  running: "运行中",
  done: "模型认为已完成",
  blocked: "无法继续",
  budget_exceeded: "超出预算",
  guardrail_blocked: "被安全护栏拦下",
  cancelled: "已取消",
  error: "运行故障",
};

export function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

export function passedLabel(passed) {
  return passed === null ? "未判定" : passed ? "通过" : "失败";
}

export function isLive(status) {
  return status === "queued" || status === "running";
}

/**
 * 判决档位：卡片色条、药丸、时间线的节点都按它上色。
 *
 * `passed === null` 走 `undecided`，**不能**落回 `skipped`——否则会出现
 * 「药丸写着未判定（中性灰）、色条却是跳过的琥珀色」这种自相矛盾的卡片，
 * 而 D8 的整个要点就是这两者不能混。
 */
export function verdictClass(status, passed) {
  if (status === "running" || status === "queued") return "running";
  if (passed === true) return "passed";
  if (passed === false) return "failed";
  return "undecided";
}

/** 操作名 -> 人话。时间线上每一步的标题用它。 */
export const OPERATION_LABELS = {
  CLICK: "点击",
  TYPE_TEXT: "输入",
  SELECT: "选择",
  SCROLL: "滚动",
  WAIT: "等待",
  DONE: "完成",
  BLOCKED: "放弃",
};

export function operationLabel(operation) {
  return OPERATION_LABELS[operation] ?? operation;
}

/**
 * 第 0 步就因为域名白名单结束，且拦下的是一个 URL（不是某个动作）——多半是被跳去了登录页。
 * 白名单越界时护栏把当时的 URL 记在 `action` 里（见 core/agent.ts 的 originAllowed）。
 */
export function looksLikeLoginRedirect(report) {
  if (report.status !== "guardrail_blocked" || report.steps.length !== 0) return false;
  const hit = report.guardrailHits[0];
  return hit !== undefined && hit.step === 0 && /^https?:\/\//.test(hit.action);
}

/**
 * 这次运行带的登录态名字。报告里没有单独的字段，但失败原因是 agent 按那次运行的用例写的
 * （core/guard.ts 的 loginRedirectHint：「用例已带登录态 X」），从那里读。
 */
export function authStateOfRun(report) {
  return /用例已带登录态 ([a-z0-9][a-z0-9-]*)/.exec(report.failureReason ?? "")?.[1] ?? null;
}

/** 覆盖站点：最多列三个，其余折成「等 N 个」 */
export function sitesText(sites) {
  if (sites.length === 0) return "没有 cookie";
  return sites.length <= 3 ? sites.join("、") : `${sites.slice(0, 3).join("、")} 等 ${sites.length} 个`;
}

function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}

/** 这份登录态有没有覆盖 `url` 的主机（cookie 域按后缀匹配：`.example.com` 覆盖 `a.example.com`） */
export function authCovers(state, url) {
  let host = "";
  try {
    host = new URL(String(url)).hostname;
  } catch {
    return false;
  }
  return state.sites.some((site) => host === site || host.endsWith(`.${site}`));
}

/**
 * 覆盖 `url` 的登录态，最可能是对的排前面：验证有效的 > 没验证过的 > 已失效的；
 * 同档里，登录地址与目标同 origin 的优先（在这个站点上登录的那份），再按保存时间新的优先。
 */
export function rankCandidates(states, url) {
  const origin = originOf(url);
  const verdict = (state) => (state.lastVerified === null ? 1 : state.lastVerified.ok ? 0 : 2);
  return states
    .filter((state) => authCovers(state, url))
    .sort((a, b) =>
      verdict(a) - verdict(b)
      || Number(originOf(b.loginUrl ?? "") === origin) - Number(originOf(a.loginUrl ?? "") === origin)
      || String(b.savedAt).localeCompare(String(a.savedAt)));
}
