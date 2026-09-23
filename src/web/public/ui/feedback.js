/**
 * 反馈：全站只有这四种方式告诉用户「发生了什么」，各管各的场合。
 *
 *   1. 字段错误     —— 编辑器自己挂在字段下方（`views/editor.js`），并在表单顶部汇总。
 *   2. 页面错误槽   —— `errorSlot()`：一个视图一个槽，**新的替换旧的**，绝不越堆越多。
 *                      用于「这个页面上的主要操作失败了」：保存、检测、导入、加载。
 *   3. Toast        —— `toast()`：行内快捷操作的结果（删了、入队了、验证完了、复制了），
 *                      以及这些操作的失败——它们不值得占住页面，但必须被看见。
 *   4. 全局横幅     —— 令牌失效（服务重启过）与服务不可达。与哪个页面无关，所以不进页面。
 *
 * 所有异步点击都走 `busy()`：执行期间按钮禁用并显示转圈，异常一律有去处——
 * 以前有几处点击失败什么都不显示（导出、重新运行），还有保存可以双击出假冲突。
 */

import { el, icon, rich, setChildren } from "../lib/dom.js";
import { fieldLabel, issueMessage } from "../lib/core.js";
import { onConnection } from "../lib/api.js";

// ---------------------------------------------------------------------------
// 错误的标题：按 kind 说「发生了哪一类事」，正文是服务端给的具体原因
// ---------------------------------------------------------------------------

function titleOf(error) {
  switch (error?.kind) {
    case "validation": {
      const count = error.issues.length;
      return count > 0 ? `有 ${count} 处需要修改` : "内容没有通过校验";
    }
    case "conflict": return "和已有内容冲突";
    case "notFound": return "找不到要操作的对象";
    case "auth": return "页面凭证已失效";
    case "network": return "连不上服务";
    default: return "没有完成";
  }
}

/**
 * 一块错误说明。`onIssue(issue)` 给了就把每条校验问题做成可点的，点了跳到对应字段。
 * `title` 可覆盖默认标题；`actions` 是附在末尾的按钮（重试、重新加载……）。
 */
export function errorPanel(error, { title = null, onIssue = null, actions = [], onClose = null } = {}) {
  const issues = Array.isArray(error?.issues) ? error.issues : [];
  const body = el("div", { class: "callout-body" }, [
    el("div", { class: "callout-title", text: title ?? titleOf(error) }),
    // 校验错误的总述（「用例校验失败」）不如下面的清单有用，有清单时就不再重复
    issues.length > 0 && error.kind === "validation" ? null : rich(error?.message ?? String(error), "p", { class: "callout-text" }),
  ]);
  if (issues.length > 0) {
    const list = el("ul", { class: "issue-list" });
    for (const issue of issues) {
      const path = String(issue.path ?? "");
      const label = el("span", { class: "issue-field", text: fieldLabel(path) });
      const item = el("li", {}, [
        onIssue === null
          ? label
          : el("button", { type: "button", class: "issue-link", onclick: () => onIssue(issue) }, [label]),
        el("span", { class: "issue-message", text: issueMessage(issue.message) }),
        path === "" ? null : el("code", { class: "issue-path", text: path }),
      ]);
      list.append(item);
    }
    body.append(list);
  }
  if (actions.length > 0) body.append(el("div", { class: "callout-actions" }, actions));

  const panel = el("div", { class: "callout callout--danger", role: "alert" }, [icon("alert", 18, "callout-icon"), body]);
  if (onClose !== null) {
    panel.append(el("button", { type: "button", class: "callout-close", "aria-label": "关闭", onclick: onClose }, [icon("close", 14)]));
  }
  return panel;
}

/** 非错误的说明块：提示、警告、成功。`tone` 取 info / warning / success。 */
export function callout(tone, title, children = [], { iconName = null } = {}) {
  const glyph = iconName ?? (tone === "success" ? "check" : tone === "warning" ? "alert" : "info");
  return el("div", { class: `callout callout--${tone}`, role: tone === "warning" ? "status" : null }, [
    icon(glyph, 18, "callout-icon"),
    el("div", { class: "callout-body" }, [
      title === null ? null : el("div", { class: "callout-title", text: title }),
      ...[].concat(children).filter(Boolean).map((child) => (typeof child === "string" ? rich(child, "p", { class: "callout-text" }) : child)),
    ]),
  ]);
}

/**
 * 页面错误槽：一个视图一个。`show()` 总是**替换**上一条，`clear()` 清空。
 * 出现时滚到可见——错误出现在屏幕外等于没出现。
 */
export function errorSlot() {
  const node = el("div", { class: "error-slot" });
  const reveal = () => node.firstElementChild?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  return {
    node,
    show(error, options = {}) {
      setChildren(node, [errorPanel(error, { ...options, onClose: () => node.replaceChildren() })]);
      reveal();
    },
    /** 放一块自定义内容（例如准入检查的结论、冲突说明） */
    set(child) {
      setChildren(node, [child]);
      reveal();
    },
    clear() {
      node.replaceChildren();
    },
  };
}

// ---------------------------------------------------------------------------
// Toast
// ---------------------------------------------------------------------------

const TOAST_MS = { success: 3500, info: 4500, danger: 8000 };

/**
 * 右下角的短消息。`tone`：success / info / danger。
 * 错误停得更久，且带关闭按钮；`action` 给一个就地的下一步（例如「查看」）。
 */
export function toast(message, { tone = "success", action = null } = {}) {
  const host = document.getElementById("toasts");
  if (host === null) return;
  const node = el("div", { class: `toast-item toast-item--${tone}`, role: tone === "danger" ? "alert" : "status" }, [
    icon(tone === "success" ? "check" : tone === "danger" ? "alert" : "info", 16, "toast-icon"),
    rich(message, "div", { class: "toast-text" }),
  ]);
  if (action !== null) {
    node.append(el("button", { type: "button", class: "toast-action", text: action.label, onclick: () => { action.onclick(); dismiss(); } }));
  }
  node.append(el("button", { type: "button", class: "toast-close", "aria-label": "关闭", onclick: () => dismiss() }, [icon("close", 13)]));
  host.append(node);
  // 最多留四条，老的先走
  while (host.children.length > 4) host.firstElementChild.remove();
  const timer = setTimeout(dismiss, TOAST_MS[tone] ?? 4000);
  function dismiss() {
    clearTimeout(timer);
    node.remove();
  }
}

/** 把一个异常作为 toast 报出来（行内操作失败时用）。 */
export function toastError(error, prefix = "") {
  toast(`${prefix}${error?.message ?? String(error)}`, { tone: "danger" });
}

// ---------------------------------------------------------------------------
// busy：异步按钮的唯一写法
// ---------------------------------------------------------------------------

/**
 * 在 `button` 上跑一个异步操作：执行期间禁用、转圈；出错交给 `onError`，没给就 toast。
 * 已经在跑的按钮再点无效——这一条消灭了「双击保存 -> 第二次必然 409 假冲突」。
 * 返回操作的结果；出错时返回 undefined。
 */
export async function busy(button, fn, { pending = null, onError = null } = {}) {
  if (button.dataset.busy === "1") return undefined;
  button.dataset.busy = "1";
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  const labelNode = button.querySelector(".btn-label");
  const original = labelNode?.textContent ?? null;
  if (pending !== null && labelNode !== null) labelNode.textContent = pending;
  try {
    return await fn();
  } catch (error) {
    if (onError !== null) onError(error);
    else toastError(error);
    return undefined;
  } finally {
    delete button.dataset.busy;
    button.removeAttribute("aria-busy");
    if (labelNode !== null && original !== null) labelNode.textContent = original;
    // 按钮可能已经随视图被换掉；还在的话才恢复
    if (button.isConnected) button.disabled = false;
  }
}

// ---------------------------------------------------------------------------
// 确认对话框：原生 <dialog>，不引 bootstrap.js（D18）
// ---------------------------------------------------------------------------

/**
 * 需要确认的操作（删除、覆盖、丢弃修改）。返回 Promise<boolean>。
 * 用 <dialog> 而不是浏览器原生的确认框：能写清楚后果、按钮能说出动作本身（「删除」而不是「确定」），
 * 危险操作的按钮是红的，且默认焦点落在「取消」上。
 */
export function confirmDialog({ title, message = "", confirmLabel = "确定", cancelLabel = "取消", danger = false }) {
  return new Promise((resolve) => {
    const cancel = el("button", { type: "button", class: "btn btn-outline-secondary btn-sm", text: cancelLabel, value: "cancel" });
    const confirm = el("button", {
      type: "button",
      class: `btn btn-sm ${danger ? "btn-danger" : "btn-primary"}`,
      text: confirmLabel,
      "data-confirm": "1",
    });
    const dialog = el("dialog", { class: "confirm-dialog", "aria-labelledby": "confirm-title" }, [
      el("h2", { id: "confirm-title", class: "dialog-title", text: title }),
      message === "" ? null : rich(message, "p", { class: "dialog-text" }),
      el("div", { class: "dialog-actions" }, [cancel, confirm]),
    ]);
    const finish = (answer) => {
      dialog.close();
      dialog.remove();
      resolve(answer);
    };
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    dialog.addEventListener("cancel", (event) => {
      event.preventDefault();
      finish(false);
    });
    dialog.addEventListener("click", (event) => {
      if (event.target === dialog) finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    (danger ? cancel : confirm).focus();
  });
}

// ---------------------------------------------------------------------------
// 全局横幅
// ---------------------------------------------------------------------------

const banners = new Map();

function renderBanners() {
  const host = document.getElementById("banner");
  if (host === null) return;
  setChildren(host, [...banners.values()]);
}

function setBanner(key, node) {
  if (node === null) banners.delete(key);
  else banners.set(key, node);
  renderBanners();
}

/**
 * 连接状态横幅，由 api.js 的 `onConnection` 驱动：任何一次请求撞上都会显示，
 * 下一次成功的请求（队列轮询每 2 秒一次）会把「连不上」自动撤掉。
 * 「凭证失效」不会自愈——令牌每进程一个，只有刷新页面才能拿到新的。
 */
export function installConnectionBanners() {
  onConnection((state) => {
    if (state === "up") {
      setBanner("network", null);
      return;
    }
    if (state === "down") {
      if (banners.has("network")) return;
      setBanner("network", el("div", { class: "banner banner--warning", role: "status" }, [
        icon("alert", 16),
        rich("连不上 jevtest 服务。它可能已经停了：重新运行 `jevtest serve`，恢复后这条会自动消失。", "span"),
      ]));
      return;
    }
    if (state === "auth" && !banners.has("auth")) {
      setBanner("auth", el("div", { class: "banner banner--danger", role: "alert" }, [
        icon("alert", 16),
        el("span", { text: "服务重启过，这个页面的凭证已失效，保存、运行等操作都会被拒绝。刷新页面即可恢复（未保存的修改会丢失）。" }),
        el("button", { type: "button", class: "btn btn-sm btn-light", text: "刷新页面", onclick: () => location.reload() }),
      ]));
    }
  });
}
