/**
 * 登录态：新建/重新登录的流程组件，以及「把登录态用到用例上」的几种入口。
 * 登录态页、用例编辑器、用例列表、结果页共用。
 */

import { el, button, hint, setChildren } from "../lib/dom.js";
import { call, applyAuthStateToCase, runCaseAndOpen } from "../lib/api.js";
import { suggestAuthName } from "../lib/core.js";
import { rankCandidates, sitesText, looksLikeLoginRedirect, authStateOfRun } from "../lib/runs.js";
import { relativeTime } from "../lib/format.js";
import { busy, callout, confirmDialog, errorSlot } from "../ui/feedback.js";
import { verifyBadge } from "../ui/widgets.js";

/** 登录窗口状态的轮询间隔。人在另一个窗口里登录，1.5s 刷一次「当前停在哪」足够 */
const LOGIN_POLL_MS = 1500;

/**
 * 「新建 / 重新登录」的整个流程。
 *
 * 几个阶段画在同一块里，不跳页：
 *   填表 -> 弹窗等人登录（轮询窗口状态） -> 已保存（自动验证一次）
 * 在编辑器里不跳页尤其要紧：跳去别的页面会丢掉还没保存的用例草稿。
 *
 * 另有一条「上传 storageState」的兜底路径，给弹不出窗口的环境（Docker、远程 Linux）。
 * `overwrite: true` 用于「重新登录」：名字锁定、覆盖已有文件。
 * `resume` 传入一个已经开着的窗口状态时，直接从「等人登录」开始——
 * 人开了窗口又切走了页面，回来时不该看到一个空表单。
 */
export function loginFlow({
  name = "",
  url = "",
  overwrite = false,
  resume = null,
  onSaved = null,
  onClose = null,
  // 保存完之后「下一步」的内容。**登录态存好了不等于用例用上了它**——
  // 这一步不画出来，人会以为已经配好，直接去跑（实际踩过：用例没保存，跑出来还是被跳走）。
  savedNext = null,
} = {}) {
  const box = el("div", { class: "login-flow" });
  const errors = errorSlot();
  const body = el("div", { class: "login-flow-body" });
  box.append(body);
  let pollTimer = null;

  const stopPolling = () => {
    clearTimeout(pollTimer);
    pollTimer = null;
  };
  const close = () => {
    stopPolling();
    box.remove();
    onClose?.();
  };
  const head = (title, { live = false, closeLabel = "关闭" } = {}) =>
    el("div", { class: "login-flow-head" }, [
      el("h3", { class: "login-flow-title", text: title }),
      live ? el("span", { class: "live-dot", text: "等待你完成登录" }) : null,
      closeLabel === null ? null : button(closeLabel, { kind: "ghost", onclick: close }),
    ]);

  // ---- 阶段 1：填表 ------------------------------------------------------
  function renderForm() {
    stopPolling();
    const nameInput = el("input", {
      class: "form-control mono",
      value: name || suggestAuthName(url),
      placeholder: "shop-test9-admin",
      readonly: overwrite,
      "aria-label": "登录态名称",
    });
    const urlInput = el("input", { class: "form-control", type: "url", value: url, placeholder: "https://…", "aria-label": "登录地址" });
    const openButton = button(overwrite ? "打开浏览器重新登录" : "打开浏览器登录", { kind: "primary", size: "" });

    const submit = (force) => busy(openButton, async () => {
      name = nameInput.value.trim();
      url = urlInput.value.trim();
      errors.clear();
      try {
        renderWaiting(await call("/api/auth-window", { method: "POST", body: { name, url, overwrite: overwrite || force } }));
      } catch (err) {
        if (err.status === 409 && err.detail?.exists) {
          // 名字撞了：问一句要不要覆盖，而不是让人自己想办法改名
          const replace = await confirmDialog({
            title: `登录态 ${name} 已存在`,
            message: "要重新登录并用新的登录结果覆盖它吗？用到它的用例会从下一次运行起用新的。",
            confirmLabel: "重新登录并覆盖",
          });
          if (replace) {
            delete openButton.dataset.busy;
            await submit(true);
          }
          return;
        }
        if (err.status === 409 && err.detail?.window) {
          renderBusy(err.detail.window);
          return;
        }
        throw err;
      }
    }, { pending: "正在打开…", onError: (err) => errors.show(err) });
    openButton.addEventListener("click", () => void submit(false));

    setChildren(body, [
      head(overwrite ? `重新登录 ${name}` : "新建登录态"),
      errors.node,
      el("div", { class: "form-grid form-grid--2" }, [
        el("label", { class: "field-main" }, [el("span", { class: "field-label", text: "名称" }), nameInput]),
        el("label", { class: "field-main" }, [el("span", { class: "field-label", text: "登录地址" }), urlInput]),
      ]),
      hint(
        overwrite
          ? "会在你的桌面上弹出一个浏览器窗口。在里面重新登录，回到这里点保存，旧的登录态会被替换。"
          : "名称用小写字母、数字和连字符，用例里按名称引用它。同一站点的不同账号各建一份，如 `shop-admin`、`shop-viewer`。登录地址通常就是用例的起始地址。",
      ),
      el("div", { class: "login-flow-actions" }, [
        openButton,
        overwrite ? null : button("弹不出窗口？上传 storageState", { kind: "link", onclick: () => renderUpload(nameInput.value.trim(), urlInput.value.trim()) }),
      ]),
    ]);
    // 名字是推出来的建议值时，改地址要跟着改建议——但人手动改过名字之后就不再动它
    let nameTouched = name !== "";
    nameInput.addEventListener("input", () => {
      nameTouched = true;
    });
    urlInput.addEventListener("input", () => {
      if (!nameTouched && !overwrite) nameInput.value = suggestAuthName(urlInput.value.trim());
    });
  }

  // ---- 已有别的窗口开着 --------------------------------------------------
  function renderBusy(status) {
    const takeOver = button("关掉它，开我这个", { kind: "outline-secondary", size: "" });
    takeOver.addEventListener("click", () => busy(takeOver, async () => {
      await call("/api/auth-window/cancel", { method: "POST" });
      renderForm();
    }, { onError: (err) => errors.show(err) }));
    setChildren(body, [
      head("已有一个登录窗口开着"),
      errors.node,
      hint(`登录态 **${status.name}** 的窗口还开着。同一时刻只开一个窗口，免得分不清哪个窗口对应哪一份。`),
      el("div", { class: "login-flow-actions" }, [
        button(`继续那一个（${status.name}）`, {
          kind: "primary",
          size: "",
          onclick: () => {
            name = status.name;
            url = status.url;
            renderWaiting(status);
          },
        }),
        takeOver,
      ]),
    ]);
  }

  // ---- 阶段 2：等人登录 --------------------------------------------------
  function renderWaiting(status) {
    const where = el("p", { class: "login-flow-where mono" });
    const saveButton = button("已登录，保存登录态", { kind: "primary", size: "", iconName: "check" });
    const cancelButton = button("取消", { kind: "outline-secondary", size: "" });

    const showWhere = (current) => {
      where.textContent = current.currentUrl ? `窗口当前页面：${current.currentUrl}` : "";
    };
    showWhere(status);

    saveButton.addEventListener("click", () => busy(saveButton, async () => {
      errors.clear();
      renderSaved(await call("/api/auth-window/save", { method: "POST" }));
    }, { pending: "正在保存…", onError: (err) => errors.show(err) }));
    cancelButton.addEventListener("click", () => busy(cancelButton, async () => {
      stopPolling();
      await call("/api/auth-window/cancel", { method: "POST" }).catch(() => null);
      close();
    }));

    setChildren(body, [
      head(`正在登录 ${status.name}`, { live: true, closeLabel: null }),
      el("ol", { class: "login-flow-steps" }, [
        el("li", { text: "已在你的桌面上弹出一个浏览器窗口（没看到的话，看看是不是在别的窗口后面）。" }),
        el("li", { text: "在那个窗口里正常登录：账号密码、扫码、验证码都可以，登录几步都行。" }),
        el("li", { text: "看到登录后的页面了，回到这里点「已登录，保存登录态」。窗口会自动关闭。" }),
      ]),
      where,
      errors.node,
      el("div", { class: "login-flow-actions" }, [saveButton, cancelButton]),
    ]);

    // 轮询窗口状态：人直接关掉窗口（或超时）时及时告诉他，而不是让「保存」按钮一直亮着
    const poll = async () => {
      if (!box.isConnected) return stopPolling();
      try {
        const current = await call("/api/auth-window");
        if (current === null) return; // 已保存或已取消（可能是另一个标签页里点的）
        if (current.state === "closed") return renderClosed(current);
        showWhere(current);
      } catch {
        // 一次轮询失败不打断流程：服务可能只是短暂不可达（全局横幅会说）
      }
      pollTimer = setTimeout(poll, LOGIN_POLL_MS);
    };
    stopPolling();
    pollTimer = setTimeout(poll, LOGIN_POLL_MS);
  }

  function renderClosed(status) {
    stopPolling();
    const reopen = button("重新打开窗口", { kind: "primary", size: "" });
    reopen.addEventListener("click", () => busy(reopen, async () => {
      renderWaiting(await call("/api/auth-window", { method: "POST", body: { name: status.name, url: status.url, overwrite: true } }));
    }, { onError: (err) => errors.show(err) }));
    setChildren(body, [
      head(`登录 ${status.name} 没有完成`),
      callout("warning", null, [status.closedReason ?? "登录窗口已关闭，登录态没有保存。"]),
      errors.node,
      el("div", { class: "login-flow-actions" }, [reopen]),
    ]);
  }

  // ---- 阶段 3：已保存 ----------------------------------------------------
  function renderSaved(summary) {
    stopPolling();
    const verifySlot = el("div", { class: "login-flow-verify" }, [el("span", { class: "hint", text: "正在验证这份登录态…" })]);
    setChildren(body, [
      head(`已保存登录态 ${summary.name}`, { closeLabel: "完成" }),
      el("p", { text: `${summary.cookieCount} 个 cookie，覆盖 ${sitesText(summary.sites)}。` }),
      verifySlot,
      savedNext === null ? null : el("div", { class: "login-flow-next" }, [savedNext(summary)]),
    ]);
    onSaved?.(summary);
    if (summary.loginUrl === null) {
      verifySlot.replaceChildren(hint("没有登录地址，跳过自动验证。可以在登录态列表里手动验证。"));
      return;
    }
    // 自动验证一次：用这份登录态无头打开登录地址，看是不是还会被踢回登录页
    void call(`/api/auth-states/${summary.name}/verify`, { method: "POST", body: {} })
      .then((result) => {
        setChildren(verifySlot, [
          el("div", { class: "verify-line" }, [verifyBadge(result), el("span", { text: result.detail })]),
          result.ok ? null : hint("如果你确认刚才已经登录成功，可能是站点把登录态绑在了别的东西上（如 IP、设备指纹）。可以先跑一次用例看结果。"),
        ]);
      })
      .catch((err) => setChildren(verifySlot, [el("p", { class: "text-danger", text: `验证没有完成：${err.message}` })]));
  }

  // ---- 兜底：上传 storageState -------------------------------------------
  function renderUpload(presetName, presetUrl) {
    stopPolling();
    const nameInput = el("input", { class: "form-control mono", value: presetName, placeholder: "shop-test9-admin" });
    const urlInput = el("input", { class: "form-control", type: "url", value: presetUrl, placeholder: "可选：用于验证" });
    const fileInput = el("input", { class: "form-control", type: "file", accept: ".json,application/json" });
    const textInput = el("textarea", { class: "form-control mono", rows: 6, placeholder: '{ "cookies": [...], "origins": [...] }' });
    const submitButton = button("上传", { kind: "primary", size: "", iconName: "upload" });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (file) textInput.value = await file.text();
    });

    const submit = (force) => busy(submitButton, async () => {
      errors.clear();
      try {
        renderSaved(await call("/api/auth-states", {
          method: "POST",
          body: { name: nameInput.value.trim(), state: textInput.value, loginUrl: urlInput.value.trim(), overwrite: force },
        }));
      } catch (err) {
        if (err.status === 409 && err.detail?.exists) {
          const replace = await confirmDialog({
            title: `登录态 ${nameInput.value.trim()} 已存在`,
            message: "要用上传的内容覆盖它吗？",
            confirmLabel: "覆盖",
          });
          if (replace) {
            delete submitButton.dataset.busy;
            await submit(true);
          }
          return;
        }
        throw err;
      }
    }, { pending: "正在上传…", onError: (err) => errors.show(err) });
    submitButton.addEventListener("click", () => void submit(false));

    setChildren(body, [
      head("上传登录态"),
      hint(
        "给弹不出浏览器窗口的环境用。在一台有界面的机器上登录并导出 Playwright 的 storageState，" +
          "例如 `npx playwright codegen --save-storage=state.json <登录地址>`，登录后关掉窗口，再把 state.json 传上来。",
      ),
      errors.node,
      el("div", { class: "form-grid form-grid--2" }, [
        el("label", { class: "field-main" }, [el("span", { class: "field-label", text: "名称" }), nameInput]),
        el("label", { class: "field-main" }, [el("span", { class: "field-label", text: "登录地址" }), urlInput]),
      ]),
      el("label", { class: "field-main" }, [el("span", { class: "field-label", text: "选文件，或直接粘贴 JSON" }), fileInput]),
      textInput,
      el("div", { class: "login-flow-actions" }, [
        submitButton,
        button("返回弹窗登录", { kind: "link", onclick: () => renderForm() }),
      ]),
    ]);
  }

  if (resume !== null) {
    name = resume.name;
    url = resume.url;
    if (resume.state === "closed") renderClosed(resume);
    else renderWaiting(resume);
  } else {
    renderForm();
  }
  return box;
}

/**
 * 「把登录态用到某个用例」的按钮。点完原地变成结果 +「重新运行」。
 */
export function applyToCaseButton(caseId, caseTitle, name, label = `用到用例「${caseTitle || caseId}」并保存`) {
  const slot = el("span", { class: "apply-to-case" });
  const trigger = button(label, { kind: "primary" });
  trigger.addEventListener("click", () => busy(trigger, async () => {
    const revision = await applyAuthStateToCase(caseId, name);
    const rerun = button("重新运行", { kind: "outline-primary", iconName: "play" });
    rerun.addEventListener("click", () => busy(rerun, () => runCaseAndOpen(caseId)));
    setChildren(slot, [
      el("span", { class: "hint", text: `用例已保存为 r${revision}，运行时会带上登录态 ${name}。` }),
      rerun,
    ]);
  }));
  slot.append(trigger);
  return slot;
}

/**
 * 「运行」之前的检查：用例没选登录态、而**上一次运行**一打开就被跳去登录——
 * 照原样再跑一次只会以同样的方式失败，所以先问一句，并把能用的登录态摆出来。
 *
 * 只在这一种情况下拦：不需要登录的、已经选了登录态的、上次不是这样失败的，都直接跑。
 * 返回 `null` 表示放行。
 * （实测：人在登录态页建好、验证好登录态，回到用例列表点「运行」，以为这就会带上——
 * 连续两次都是这样失败的。）
 */
export async function loginPreflight(item, { onRun }) {
  if (item.authState !== null || item.lastRun?.status !== "guardrail_blocked") return null;
  const report = await call(`/api/runs/${item.lastRun.runId}`).catch(() => null);
  if (report === null || !looksLikeLoginRedirect(report)) return null;

  const states = await call("/api/auth-states").catch(() => []);
  const candidates = rankCandidates(states, item.startUrl);
  const title = item.title || item.id;
  const actions = el("div", { class: "callout-actions" });
  for (const state of candidates) {
    const use = button(`用 ${state.name} 并运行`, { kind: "primary" });
    use.addEventListener("click", () => busy(use, async () => {
      await applyAuthStateToCase(item.id, state.name);
      await runCaseAndOpen(item.id);
    }));
    actions.append(el("span", { class: "verify-line" }, [use, verifyBadge(state.lastVerified)]));
  }
  actions.append(
    el("a", {
      class: `btn btn-sm ${candidates.length > 0 ? "btn-outline-primary" : "btn-primary"}`,
      href: `#/auth?new=1&url=${encodeURIComponent(item.startUrl)}&case=${encodeURIComponent(item.id)}`,
      text: "新建登录态",
    }),
    button("仍然直接运行", { kind: "link", onclick: onRun }),
  );
  return callout("warning", `「${title}」上次一打开就被跳去了登录页，而用例没有选登录态`, [
    candidates.length > 0
      ? "登录态要在用例里选上并保存，运行才会带上。选一份再跑："
      : "照原样再跑还会被拦下。先登录一次存成登录态，再用到这个用例上。",
    actions,
  ]);
}

/**
 * 被跳到登录页之后，按**实际情况**给下一步：
 *   - 这次运行用的用例版本带了登录态 -> 它多半过期了，重新登录；
 *   - 用例在这次运行之后已经配上登录态 -> 重新运行；
 *   - 没带，但已经有登录态覆盖这个站点 -> 八成是建好了却没用到用例上，一键用上；
 *   - 一份都没有 -> 去新建（带着用例 id，建完直接用上）。
 * 第一条看的是**这一次运行**带没带登录态，不是现在的用例（运行之后用例可能改过）。
 */
export async function loginGuide(report) {
  const [states, loaded] = await Promise.all([
    call("/api/auth-states").catch(() => []),
    call(`/api/cases/${report.caseId}`).catch(() => null),
  ]);
  const ran = authStateOfRun(report);
  const current = loaded?.def.authState;
  const newLink = el("a", {
    class: "btn btn-sm btn-outline-primary",
    href: `#/auth?new=1&url=${encodeURIComponent(report.startUrl)}&case=${encodeURIComponent(report.caseId)}`,
    text: "新建登录态",
  });
  const title = "看起来目标页要求登录";

  if (ran) {
    return callout("info", title, [
      `这次运行带着登录态 **${ran}**，打开仍被跳走，多半是它过期了。`,
      el("div", { class: "callout-actions" }, [
        el("a", { class: "btn btn-sm btn-primary", href: `#/auth?relogin=${encodeURIComponent(ran)}`, text: `重新登录 ${ran}` }),
      ]),
    ]);
  }
  if (current && loaded !== null) {
    const rerun = button("重新运行", { kind: "primary", iconName: "play" });
    rerun.addEventListener("click", () => busy(rerun, () => runCaseAndOpen(report.caseId)));
    return callout("info", title, [
      `这次运行时用例还没有登录态；它现在已经选上了 **${current}**。`,
      el("div", { class: "callout-actions" }, [rerun]),
    ]);
  }
  const candidates = rankCandidates(states, report.startUrl);
  if (candidates.length > 0 && loaded !== null) {
    return callout("info", title, [
      "已经有覆盖这个站点的登录态，但用例没有选它。登录态要在用例里选上并保存，运行才会带上。",
      el("div", { class: "auth-candidates" }, candidates.map((state) =>
        el("div", { class: "verify-line" }, [
          applyToCaseButton(report.caseId, loaded.def.title, state.name, `用 ${state.name} 并保存用例`),
          verifyBadge(state.lastVerified),
          el("span", { class: "hint", text: `登录于 ${state.loginUrl ?? "（上传）"}，${relativeTime(state.savedAt)}` }),
        ]),
      )),
      el("div", { class: "callout-actions" }, [newLink]),
    ]);
  }
  return callout("info", title, [
    "在弹出的浏览器里登录一次，存成登录态，再用到这个用例上。",
    el("div", { class: "callout-actions" }, [newLink]),
  ]);
}

