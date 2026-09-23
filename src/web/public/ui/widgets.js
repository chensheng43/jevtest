/** 通用展示组件。视图只拼这些，不自己发明第二种药丸或第二种标签页。 */

import { el, icon, rich } from "../lib/dom.js";
import { statusLabel } from "../lib/runs.js";

// ---------------------------------------------------------------------------
// 药丸
// ---------------------------------------------------------------------------

/**
 * 状态药丸。`tone` 决定配色档位，`mark` 是字形。
 *
 * D9：`skipped` 走虚框 + 小字号（见 style.css），刻意比 passed/failed 轻。
 * D8：`undecided`（passed === null）是**第三种**东西——既不是通过也不是失败，
 * 也不该被读成「跳过」，所以它有自己的中性灰，不借用任何一方的颜色。
 */
export function badge(tone, mark, label, { title = null } = {}) {
  const node = el("span", { class: `badge badge--${tone}`, title });
  if (mark !== "") node.append(el("span", { class: "glyph", "aria-hidden": "true", text: mark }));
  node.append(el("span", { text: label }));
  return node;
}

/** 只表达 passed 的药丸，不掺 status。 */
export function passedBadge(passed) {
  if (passed === true) return badge("passed", "✓", "通过");
  if (passed === false) return badge("failed", "✕", "失败");
  return badge("undecided", "?", "未判定");
}

/** 判决药丸。全站唯一决定「一次运行该怎么显示」的地方。 */
export function verdictBadge(status, passed) {
  if (status === "running" || status === "queued") return badge("running", "", statusLabel(status));
  return passedBadge(passed);
}

/** 一条检查项的三态。**skipped 必须先判**，否则「跳过」会掉进 passed 分支。 */
export function checkBadge(check) {
  if (check.skipped) return badge("skipped", "⊘", "跳过");
  return check.passed ? badge("passed", "✓", "通过") : badge("failed", "✕", "失败");
}

/** 登录态最近一次验证的结论。没验证过是「未验证」——不能画成有效，也不能画成失效 */
export function verifyBadge(lastVerified) {
  if (!lastVerified) return badge("undecided", "?", "未验证");
  return lastVerified.ok ? badge("passed", "✓", "有效") : badge("failed", "✕", "已失效");
}

/** 中性小标签（登录态名、模式等附加信息）。 */
export function tag(text, { mono = false, title = null } = {}) {
  return el("span", { class: `tag${mono ? " mono" : ""}`, text, title });
}

// ---------------------------------------------------------------------------
// 页面骨架
// ---------------------------------------------------------------------------

/** 面包屑。二级页第一行给出来路。 */
export function crumbs(trail) {
  const node = el("nav", { class: "crumbs", "aria-label": "面包屑" });
  trail.forEach((part, index) => {
    if (index > 0) node.append(el("span", { class: "crumb-sep", "aria-hidden": "true", text: "/" }));
    node.append(
      part.href === undefined
        ? el("span", { "aria-current": "page", text: part.text })
        : el("a", { href: part.href, text: part.text }),
    );
  });
  return node;
}

/**
 * 页头：标题 + 可选的副标题行 + 右侧操作。
 * `title` 可以是现成节点；`meta` 是副标题行里的若干节点（各自独立成块，不用分隔符拼字符串）。
 */
export function pageHead(title, { actions = [], meta = [], trail = null } = {}) {
  return el("header", { class: "page-head" }, [
    trail === null ? null : crumbs(trail),
    el("div", { class: "page-head-row" }, [
      el("div", { class: "page-head-main" }, [
        typeof title === "string" ? el("h1", { class: "page-title", text: title }) : title,
        meta.length === 0 ? null : el("div", { class: "page-meta" }, meta.filter(Boolean)),
      ]),
      actions.length === 0 ? null : el("div", { class: "page-actions" }, actions.filter(Boolean)),
    ]),
  ]);
}

/** 空状态：一句话说清这里为什么空，再给一个能直接点的下一步。 */
export function emptyState({ iconName, title, text = "", actions = [] }) {
  return el("div", { class: "empty" }, [
    icon(iconName, 28, "empty-mark"),
    el("h2", { class: "empty-title", text: title }),
    text === "" ? null : rich(text, "p", { class: "empty-text" }),
    actions.length === 0 ? null : el("div", { class: "empty-actions" }, actions),
  ]);
}

/** 加载骨架。 */
export function skeleton() {
  return el("div", { class: "skeleton", "aria-busy": "true", "aria-label": "加载中" }, [el("span"), el("span"), el("span")]);
}

/** 一组统计数字。数字用等宽，标签在下。 */
export function stats(items) {
  return el("dl", { class: "stats" }, items.filter(Boolean).map(([value, label, title = null]) =>
    el("div", { class: "stat", title }, [
      el("dt", { class: "stat-label", text: label }),
      el("dd", { class: "stat-value", text: value }),
    ]),
  ));
}

/** 键值清单（详情面板用）。值可以是字符串或节点。 */
export function facts(rows) {
  return el("dl", { class: "facts" }, rows.filter(Boolean).flatMap(([key, value]) => [
    el("dt", { text: key }),
    typeof value === "string" || typeof value === "number" ? el("dd", { text: String(value) }) : el("dd", {}, [value]),
  ]));
}

// ---------------------------------------------------------------------------
// 标签页、折叠、菜单
// ---------------------------------------------------------------------------

/**
 * 手写标签页（不用 bootstrap.js，D18）。
 *
 * 所有面板**一次渲染、只切显隐**：切标签不重建 DOM，输入焦点与未落进草稿的输入都不会丢。
 * `onSelect(key, source)` 的 `source` 区分「用户点的」与「代码替他切的」——
 * 结果页要按运行状态自动落档，又不能覆盖用户的手动选择。
 */
export function tabs(items, onSelect = null) {
  const bar = el("div", { class: "tabs", role: "tablist" });
  const panels = new Map();
  const buttons = new Map();
  const counters = new Map();
  let current = null;

  const select = (key, source = "programmatic") => {
    if (!panels.has(key)) return;
    current = key;
    for (const [name, button] of buttons) {
      const active = name === key;
      button.setAttribute("aria-selected", active ? "true" : "false");
      button.tabIndex = active ? 0 : -1;
      button.classList.toggle("is-active", active);
      panels.get(name).hidden = !active;
    }
    onSelect?.(key, source);
  };

  for (const item of items) {
    const panel = el("section", { class: "tab-panel", role: "tabpanel", id: `panel-${item.key}`, "aria-labelledby": `tab-${item.key}` }, [item.panel]);
    panel.hidden = true;
    panels.set(item.key, panel);

    const counter = el("span", { class: "tab-badge", hidden: true });
    counters.set(item.key, counter);

    const button = el("button", {
      type: "button",
      class: "tab",
      role: "tab",
      id: `tab-${item.key}`,
      "aria-controls": panel.id,
      onclick: () => select(item.key, "user"),
    }, [el("span", { text: item.label }), counter]);
    buttons.set(item.key, button);
    bar.append(button);
  }

  // 方向键在标签之间移动（WAI-ARIA 的 tabs 惯例）
  bar.addEventListener("keydown", (event) => {
    const step = event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : 0;
    if (step === 0) return;
    const keys = [...buttons.keys()];
    const active = keys.findIndex((key) => buttons.get(key) === document.activeElement);
    const next = keys[((active < 0 ? 0 : active) + step + keys.length) % keys.length];
    event.preventDefault();
    select(next, "user");
    buttons.get(next).focus();
  });

  return {
    node: el("div", { class: "tabs-wrap" }, [bar, ...panels.values()]),
    select,
    current: () => current,
    /** 标签上的计数/记号，空串或 null = 不显示。`tone` 可取 danger 用于错误计数 */
    setBadge: (key, text, tone = "") => {
      const target = counters.get(key);
      if (target === undefined) return;
      target.textContent = text ?? "";
      target.hidden = !text;
      target.className = tone === "" ? "tab-badge" : `tab-badge tab-badge--${tone}`;
    },
  };
}

/** 原生折叠（不引 bootstrap.js 的 collapse）。 */
export function disclosure(summaryText, children, { open = false, summaryExtra = null, className = "" } = {}) {
  const node = el("details", { class: className === "" ? "disclosure" : `disclosure ${className}` });
  node.open = open;
  const summary = el("summary", {}, [el("span", { text: summaryText }), summaryExtra]);
  node.append(summary, el("div", { class: "disclosure-body" }, [].concat(children).filter(Boolean)));
  return node;
}

/**
 * 「更多」菜单：原生 <details> 做开合，点菜单项或点外面都会收起。
 * `items` 是 `[label, onclick, { danger, iconName }]`。
 */
export function menu(items, { label = "更多操作" } = {}) {
  const node = el("details", { class: "menu" });
  const summary = el("summary", { class: "btn btn-sm btn-ghost menu-trigger", "aria-label": label, title: label }, [icon("more", 16)]);
  const list = el("div", { class: "menu-list", role: "menu" });
  for (const [text, onclick, options = {}] of items.filter(Boolean)) {
    list.append(el("button", {
      type: "button",
      role: "menuitem",
      class: `menu-item${options.danger ? " menu-item--danger" : ""}`,
      onclick: (event) => {
        node.open = false;
        onclick(event);
      },
    }, [options.iconName ? icon(options.iconName, 15) : null, el("span", { text })]));
  }
  node.append(summary, list);
  // 菜单是 position: fixed，按触发按钮定位——放在 overflow 容器（如 .table-wrap）里也不会被裁、不会撑出滚动条。
  // 下方放不下就翻到上方。
  const place = () => {
    const rect = summary.getBoundingClientRect();
    list.style.right = `${document.documentElement.clientWidth - rect.right}px`;
    list.style.top = `${rect.bottom + 4}px`;
    const height = list.offsetHeight;
    if (height > 0 && rect.bottom + 4 + height > window.innerHeight && rect.top - 4 - height >= 0) {
      list.style.top = `${rect.top - 4 - height}px`;
    }
  };
  // 点外面收起；滚动或窗口变化时位置会失效，直接收起
  const outside = (event) => {
    if (!node.contains(event.target)) node.open = false;
  };
  const close = (event) => {
    if (!list.contains(event.target)) node.open = false;
  };
  summary.addEventListener("click", place);
  node.addEventListener("toggle", () => {
    if (node.open) {
      place();
      document.addEventListener("click", outside);
      window.addEventListener("scroll", close, true);
      window.addEventListener("resize", close);
    } else {
      document.removeEventListener("click", outside);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("resize", close);
    }
  });
  return node;
}

/** 表单字段外壳：标签（+ 必填标记 + 等宽的 schema 键）+ 控件 + 说明。 */
export function field({ label, control, keyName = null, note = null, required = false, className = "" }) {
  const head = el("span", { class: "field-label" }, [
    el("span", { text: label }),
    required ? el("span", { class: "req", title: "必填", text: "*" }) : null,
    keyName === null ? null : el("code", { class: "field-key", text: keyName }),
  ]);
  const wrap = el("div", { class: className === "" ? "field" : `field ${className}` }, [
    el("label", { class: "field-main" }, [head, control]),
    note === null ? null : (typeof note === "string" ? rich(note, "p", { class: "field-note" }) : note),
  ]);
  return wrap;
}

/** 分节：标题 + 说明 + 内容。编辑器与结果页的大块都用它。 */
export function section({ id = null, title, note = null, actions = [], children = [], className = "" }) {
  return el("section", { id, class: className === "" ? "panel" : `panel ${className}` }, [
    el("header", { class: "panel-head" }, [
      el("div", {}, [
        el("h2", { class: "panel-title", text: title }),
        note === null ? null : rich(note, "p", { class: "panel-note" }),
      ]),
      actions.length === 0 ? null : el("div", { class: "panel-actions" }, actions),
    ]),
    el("div", { class: "panel-body" }, [].concat(children).filter(Boolean)),
  ]);
}

