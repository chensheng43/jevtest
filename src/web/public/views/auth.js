/**
 * 登录态：目标页面需要登录时，在这里登录一次，把登录后的 cookie 存成一份「登录态」，
 * 再在用例里选上它。每份一张卡：覆盖哪些站点、还有没有效、哪些用例在用。
 */

import { el, button, hint, setChildren } from "../lib/dom.js";
import { call } from "../lib/api.js";
import { authCovers, sitesText } from "../lib/runs.js";
import { absoluteTime, relativeTime } from "../lib/format.js";
import { onLeave } from "../lib/router.js";
import { busy, confirmDialog, toast } from "../ui/feedback.js";
import { emptyState, pageHead, tag, verifyBadge } from "../ui/widgets.js";
import { applyToCaseButton, loginFlow } from "../components/login.js";

export async function viewAuthStates(app, params) {
  const [states, openWindow, cases] = await Promise.all([
    call("/api/auth-states"),
    call("/api/auth-window"),
    call("/api/cases").catch(() => []),
  ]);
  const flowSlot = el("div", { class: "flow-slot" });
  const listSlot = el("div");
  let flowOpen = false;
  onLeave(() => flowSlot.replaceChildren());

  const refresh = async () => {
    try {
      renderList(await call("/api/auth-states"));
    } catch (error) {
      toast(`刷新列表没有完成：${error.message}`, { tone: "danger" });
    }
  };

  // 从某个用例的结果页跳过来的：存完之后直接给「用到这个用例」
  const forCase = params.get("case");
  const forCaseTitle = forCase ? await call(`/api/cases/${forCase}`).then((loaded) => loaded.def.title).catch(() => forCase) : null;

  const openFlow = (options) => {
    flowOpen = true;
    setChildren(flowSlot, [loginFlow({
      ...options,
      onSaved: () => void refresh(),
      onClose: () => {
        flowOpen = false;
        flowSlot.replaceChildren();
      },
      savedNext: forCase
        ? (summary) => applyToCaseButton(forCase, forCaseTitle, summary.name)
        : () => hint("接下来：打开要用它的用例，在「登录态」里选上它并**保存用例**。也可以直接点下面卡片里的「用到…」。"),
    })]);
    flowSlot.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const newButton = button("新建登录态", {
    kind: "primary",
    iconName: "plus",
    onclick: () => {
      if (flowOpen) {
        flowSlot.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      openFlow({ url: "" });
    },
  });

  app.replaceChildren(
    pageHead("登录态", { actions: [newButton] }),
    hint("目标页面需要登录时，在这里登录一次，把登录后的 cookie 存成一份登录态，再在用例里选上它。**密码不经过模型，也不写进用例**；运行时只读载入，不会被改写。过期了就点「重新登录」。", "page-intro"),
    flowSlot,
    listSlot,
  );
  renderList(states);

  // 从别处带着意图跳过来（结果页的「配置登录态」、编辑器的链接），或者有个窗口还开着
  if (openWindow !== null) openFlow({ resume: openWindow });
  else if (params.get("relogin")) {
    const target = states.find((item) => item.name === params.get("relogin"));
    openFlow({ name: params.get("relogin"), url: target?.loginUrl ?? params.get("url") ?? "", overwrite: target !== undefined });
  } else if (params.get("new")) openFlow({ url: params.get("url") ?? "", name: params.get("name") ?? "" });

  function renderList(items) {
    if (items.length === 0) {
      setChildren(listSlot, [emptyState({
        iconName: "key",
        title: "还没有登录态",
        text: "被测页面不需要登录的话，用不到这一页。",
        actions: flowOpen ? [] : [button("新建登录态", { kind: "primary", onclick: () => openFlow({ url: "" }) })],
      })]);
      return;
    }
    setChildren(listSlot, [el("div", { class: "auth-grid" }, items.map(card))]);
  }

  /**
   * 站点对得上、却还没选任何登录态的用例：在这里就能用上。
   * 建好登录态的人下一步几乎总是「给那个用例用上」，不该让他再去编辑器里找下拉框。
   */
  function usableBy(item) {
    const targets = cases.filter((entry) => entry.authState === null && authCovers(item, entry.startUrl));
    if (targets.length === 0) return null;
    return el("div", { class: "auth-usable" }, [
      el("div", { class: "auth-section-label", text: "可以用在这些还没选登录态的用例上" }),
      ...targets.map((entry) => applyToCaseButton(entry.id, entry.title, item.name, `用到「${entry.title || entry.id}」`)),
    ]);
  }

  function card(item) {
    const status = el("div", { class: "auth-status" });
    const renderStatus = (verified) => {
      setChildren(status, [
        verifyBadge(verified),
        el("span", { class: "hint-inline", title: verified ? absoluteTime(verified.at) : "", text: verified ? `${verified.detail}（${relativeTime(verified.at)}）` : "还没验证过" }),
      ]);
    };
    renderStatus(item.lastVerified);

    const verifyButton = button("验证", { title: "用这份登录态无头打开登录地址，看是否还是登录状态。不调用模型。" });
    verifyButton.disabled = item.loginUrl === null;
    verifyButton.addEventListener("click", () => busy(verifyButton, async () => {
      const result = await call(`/api/auth-states/${item.name}/verify`, { method: "POST", body: {} });
      renderStatus(result);
      toast(result.ok ? `登录态 ${item.name} 仍然有效。` : `登录态 ${item.name} 已失效：${result.detail}`, { tone: result.ok ? "success" : "danger" });
    }, { pending: "验证中…" }));

    const deleteButton = button("删除", { kind: "ghost-danger", iconName: "trash" });
    deleteButton.addEventListener("click", async () => {
      const users = item.usedBy.map((use) => use.title || use.id).join("、");
      const ok = await confirmDialog({
        title: `删除登录态 ${item.name}？`,
        message: item.usedBy.length > 0
          ? `它仍被 ${item.usedBy.length} 个用例引用（${users}），删除后这些用例会运行失败。`
          : "登录态文件会被删除，不能撤销。",
        confirmLabel: "删除登录态",
        danger: true,
      });
      if (!ok) return;
      await busy(deleteButton, async () => {
        await call(`/api/auth-states/${item.name}${item.usedBy.length > 0 ? "?force=1" : ""}`, { method: "DELETE" });
        toast(`已删除登录态 ${item.name}。`);
        await refresh();
      });
    });

    return el("article", { class: "auth-card" }, [
      el("header", { class: "auth-card-head" }, [
        el("h2", { class: "auth-name mono", text: item.name }),
        item.source === "import" ? tag("上传") : null,
      ]),
      status,
      el("dl", { class: "facts facts--compact" }, [
        el("dt", { text: "覆盖站点" }), el("dd", { text: sitesText(item.sites) }),
        el("dt", { text: "登录地址" }), el("dd", { class: "mono break", text: item.loginUrl ?? "（上传的，没有）" }),
        el("dt", { text: "保存于" }), el("dd", { title: absoluteTime(item.savedAt), text: `${relativeTime(item.savedAt)}，${item.cookieCount} 个 cookie` }),
        item.earliestExpiry ? el("dt", { text: "最早过期" }) : null,
        item.earliestExpiry ? el("dd", { title: "只是参考：站点未必靠这一个 cookie 判断登录。是否有效以「验证」为准。", text: absoluteTime(item.earliestExpiry) }) : null,
        el("dt", { text: "被这些用例使用" }),
        el("dd", {}, item.usedBy.length === 0
          ? [el("span", { class: "muted", text: "没有" })]
          : item.usedBy.map((use) => el("a", { class: "used-by", href: `#/case/${use.id}`, text: use.title || use.id }))),
      ]),
      usableBy(item),
      el("footer", { class: "auth-card-actions" }, [
        verifyButton,
        button("重新登录", { kind: "outline-primary", onclick: () => openFlow({ name: item.name, url: item.loginUrl ?? "", overwrite: true }) }),
        el("span", { class: "spacer" }),
        deleteButton,
      ]),
    ]);
  }
}
