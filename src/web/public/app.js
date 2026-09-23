/**
 * 前端入口：路由、侧栏状态、队列指示器、主题切换。原生 ES module，不打包。
 *
 * 目录：
 *   lib/        不碰 DOM 或只做底层 DOM 的工具（api、纯函数、格式化、路由状态）
 *   ui/         反馈（错误槽 / toast / 确认框 / 横幅）与通用组件
 *   components/ 跨视图复用的业务组件（登录态流程、轨迹查看器）
 *   views/      每个路由一张视图
 *
 * 约定见各模块文件头；最要紧的两条：动态文本一律走 textContent（lib/dom.js），
 * 失败一律走 ui/feedback.js 的四种反馈之一。
 */

import { el, icon, setChildren } from "./lib/dom.js";
import { call } from "./lib/api.js";
import { getLeaveGuard, runCleanups, setLeaveGuard, setReloadHandler } from "./lib/router.js";
import { errorPanel, installConnectionBanners } from "./ui/feedback.js";
import { pageHead, skeleton } from "./ui/widgets.js";
import { viewCases } from "./views/cases.js";
import { viewCaseEditor } from "./views/editor.js";
import { viewNew } from "./views/new.js";
import { viewRuns } from "./views/runs.js";
import { viewRun } from "./views/run.js";
import { viewAuthStates } from "./views/auth.js";

/** 侧栏当前页高亮。`#/case/<id>` 算「用例」，`#/run/<id>` 算「运行」，两种新建都算「新建用例」。 */
function setActiveNav(head) {
  const key =
    head === "" || head === "cases" || head === "case" ? "cases"
      : head === "runs" || head === "run" ? "runs"
        : head === "new" || head === "case-new-form" ? "new"
          : head === "auth" ? "auth"
            : null;
  for (const link of document.querySelectorAll("#nav [data-nav]")) {
    if (link.dataset.nav === key) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

let lastHash = location.hash;
/** 路由序号：快速连点两个链接时，只有最后一次导航的结果能落到页面上 */
let routeSeq = 0;

async function route() {
  const root = document.getElementById("app");
  const target = location.hash;

  // 编辑器有未保存修改时先问。先把地址退回去（replaceState 不触发 hashchange），
  // 问完再决定走不走——问的过程中地址栏不该已经显示成新页面。
  const guard = getLeaveGuard();
  if (guard !== null && target !== lastHash) {
    history.replaceState(null, "", lastHash);
    if (!(await guard())) return;
    history.replaceState(null, "", target);
  }
  setLeaveGuard(null);
  runCleanups();
  lastHash = target;
  const seq = ++routeSeq;

  // 每个视图渲染进**自己的**容器：上一张视图还在途的异步代码回来时写的是它自己那个
  // 已经脱离文档的容器，不会盖掉这一张。
  const slot = el("div", { class: "view" }, [skeleton()]);
  root.replaceChildren(slot);
  window.scrollTo(0, 0);

  // 查询串只给「带着意图跳转」用（如结果页 -> 登录态页并预填地址）。先切掉它，
  // 否则地址里的斜杠会被当成路径段。
  const hash = target.replace(/^#\/?/, "");
  const [pathPart, query = ""] = hash.split("?");
  const [head, id] = pathPart.split("/");
  setActiveNav(head);

  try {
    if (head === "" || head === "cases") await viewCases(slot);
    else if (head === "case" && id) await viewCaseEditor(slot, decodeURIComponent(id));
    else if (head === "case-new-form") await viewCaseEditor(slot, null);
    else if (head === "new") viewNew(slot);
    else if (head === "runs") await viewRuns(slot, new URLSearchParams(query));
    else if (head === "run" && id) await viewRun(slot, decodeURIComponent(id));
    else if (head === "auth") await viewAuthStates(slot, new URLSearchParams(query));
    else {
      slot.replaceChildren(
        pageHead("没有这个页面"),
        el("p", {}, [el("span", { text: "地址 " }), el("code", { text: `#/${hash}` }), el("span", { text: " 不对应任何页面。" })]),
        el("a", { class: "btn btn-sm btn-primary", href: "#/cases", text: "回到用例列表" }),
      );
    }
  } catch (error) {
    if (seq !== routeSeq || !slot.isConnected) return;
    const retry = el("button", { type: "button", class: "btn btn-sm btn-outline-secondary", text: "重试", onclick: () => void route() });
    slot.replaceChildren(
      pageHead("页面没能打开"),
      errorPanel(error, { title: error.kind === "notFound" ? "找不到要打开的内容" : "加载失败", actions: [retry, el("a", { class: "btn btn-sm btn-ghost", href: "#/cases", text: "回到用例列表" })] }),
    );
  }
}

setReloadHandler(() => {
  lastHash = "";
  void route();
});

// ---------------------------------------------------------------------------
// 侧栏：队列指示器与主题
// ---------------------------------------------------------------------------

/**
 * 队列状态：`contextsActive` 运行结束后必须回到 0，否则说明浏览器 context 泄漏了。
 * 这个轮询同时充当「服务还在不在」的心跳：失败时 api.js 会让全局横幅显示「连不上」，
 * 恢复后下一次成功把它撤掉。
 */
async function refreshQueue() {
  const node = document.getElementById("queue");
  try {
    const status = await call("/api/queue");
    node.dataset.state = status.active > 0 || status.queued > 0 ? "busy" : "idle";
    node.title = `排队 ${status.queued}，运行中 ${status.active}，浏览器 context ${status.contextsActive}（空闲时应为 0）`;
    setChildren(node, [
      el("span", { class: "queue-dot", "aria-hidden": "true" }),
      el("span", { text: status.active > 0 ? `${status.active} 个运行中` : "空闲" }),
      status.queued > 0 ? el("span", { class: "queue-extra", text: `排队 ${status.queued}` }) : null,
    ]);
  } catch {
    node.dataset.state = "down";
    node.title = "连不上服务";
    setChildren(node, [el("span", { class: "queue-dot", "aria-hidden": "true" }), el("span", { text: "服务不可达" })]);
  }
}

const THEMES = ["auto", "light", "dark"];
const THEME_LABELS = { auto: "跟随系统", light: "浅色", dark: "深色" };

function installThemeToggle() {
  const toggle = document.getElementById("theme-toggle");
  const render = () => {
    const current = localStorage.getItem("jevtest-theme") ?? "auto";
    const dark = document.documentElement.dataset.bsTheme === "dark";
    setChildren(toggle, [icon(dark ? "moon" : "sun", 15), el("span", { text: THEME_LABELS[current] ?? current })]);
    toggle.title = `主题：${THEME_LABELS[current]}（点击切换）`;
  };
  toggle.addEventListener("click", () => {
    const current = localStorage.getItem("jevtest-theme") ?? "auto";
    const next = THEMES[(THEMES.indexOf(current) + 1) % THEMES.length];
    localStorage.setItem("jevtest-theme", next);
    window.applyTheme?.();
    render();
  });
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", render);
  render();
}

installConnectionBanners();
installThemeToggle();
window.addEventListener("hashchange", () => void route());
await route();
await refreshQueue();
setInterval(refreshQueue, 2000);
