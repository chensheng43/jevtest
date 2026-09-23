/**
 * 前端入口。原生 ES module，不打包。
 *
 * 五条贯穿全文件的约定：
 *
 * 1. **所有动态文本走 `textContent`，不用 `innerHTML`。**
 *    用例内容（goal、label、断言文案）是用户写的文件内容，可能有尖括号；
 *    trace、事件、报告里的字符串同理。这个服务只监听 127.0.0.1，但「本地」
 *    不等于「安全」——同一个浏览器里的别的页面够得着它。
 *
 *    构建子节点列表时用 `setChildren(node, [...])` 而不是 `replaceChildren(...)`：
 *    后者把数组参数转成字符串（页面上出现一行 `[object HTMLDivElement]`）、
 *    把 `null` 渲染成字面的 "null"，两种都不报错。单个节点直接 `replaceChildren`
 *    没问题——那两条路走不到。
 *
 * 2. **进度用轮询**：`GET /api/runs/:id/events?since=<lastSeq>`，间隔 500ms。
 *    不用 SSE（理由见 src/web/events.ts）。把 `lastSeq` 存在变量里，
 *    刷新页面时从 0 重新拉，即可回放出全部历史。
 *
 * 3. **界面按「此刻要判断什么」分层，不按 schema 分层。**
 *    编辑器用标签页把几十个字段收进四档，默认只露出常用路径；结果页把判决留在
 *    顶上常驻、下面按断言/轨迹/事件分档。字段一个都没少，只是不再一起堆在屏幕上。
 *
 * 4. **编辑器的草稿是唯一事实来源。** 所有控件在 input/change 时写回 `draft`，
 *    `formToDefinition(draft)` 是纯函数，不再从 DOM 读值。两处读值必然分叉，
 *    而分叉的表现是「填了但保存后没有」。
 *
 * 5. **表单与 YAML 键 1:1 对应**，刻意不做 schema 驱动的表单生成器——
 *    schema 小而固定，生成器只会多一层间接。不漂移靠的是
 *    `tests/schema.test.ts` 的往返测试，而不是这里的「聪明」。
 */

const TOKEN = document.querySelector('meta[name="jevtest-token"]')?.content ?? "";
const TOKEN_HEADER = "x-jevtest-token";
const POLL_MS = 500;
/** 结果页连续这么多次既无事件也无报告，就判定这个运行不会再有进展、停止轮询 */
const MAX_EMPTY_POLLS = 5;
/** 运行历史默认渲染多少条。`GET /api/runs` 不分页，index.jsonl 会一直涨。 */
const RUNS_PAGE = 50;
/** 事件流最多留多少条 DOM 节点，避免长时间运行把页面撑大。 */
const EVENT_NODES = 400;

// ---------------------------------------------------------------------------
// 基础设施
// ---------------------------------------------------------------------------

/** 创建元素。所有动态文本走 `text:`（textContent），绝不拼 HTML。 */
function el(tag, props = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = String(value);
    else if (key === "html") throw new Error("不用 innerHTML：动态文本一律走 textContent");
    else if (key.startsWith("on")) node.addEventListener(key.slice(2), value);
    else if (key === "value") node.value = String(value);
    else if (key === "checked") node.checked = Boolean(value);
    else node.setAttribute(key, String(value));
  }
  for (const child of [].concat(children)) if (child) node.append(child);
  return node;
}

/**
 * 换掉一个节点的全部子节点。**构建列表时一律用它，不要直接调 `replaceChildren`。**
 *
 * `replaceChildren` 对每个参数做 `(Node | DOMString)` 转换，于是：
 *
 *   - 传**数组**不会报错，会被转成字符串——页面上出现一行
 *     `[object HTMLDivElement],[object HTMLDivElement]...`；
 *   - 传 `null` 也不会报错，会渲染出字面的 "null"。
 *
 * 两种都是「看着没坏、内容却不对」。这里只收一个数组，滤掉空值，
 * 字符串直接抛错——拼错了要当场响，而不是等人在页面上认出那句
 * `[object HTMLDivElement]`。
 */
function setChildren(node, children) {
  const list = [];
  for (const child of [].concat(children)) {
    if (typeof child === "string") {
      throw new Error(`子节点不能是字符串（"${child}"）：文本请用 el("span", { text }) 或 createTextNode`);
    }
    if (child) list.push(child);
  }
  node.replaceChildren(...list);
  return node;
}

/** 统一的请求封装：自动带令牌、统一错误处理、把 zod 的 issue 路径带出来。 */
async function call(path, options = {}) {
  const init = { method: options.method ?? "GET", headers: {} };
  if (init.method !== "GET") {
    init.headers[TOKEN_HEADER] = TOKEN;
    init.headers["content-type"] = "application/json";
  }
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  const response = await fetch(path, init);
  const body = await response.text();
  const contentType = response.headers.get("content-type") ?? "";

  // **先看 body 空不空**，再看 content-type。`DELETE /api/cases/:id` 回的是
  // 204 + 空 body，而响应头仍写着 json；老代码对这个空串直接调 response.json()，
  // 于是每一次删除都弹一句「Unexpected end of JSON input」——用例其实已经删掉了，
  // 界面却报错、列表也不刷新。这是个「看着失败、其实成功」的假故障。
  if (body === "") {
    if (!response.ok) throw new Error(`请求失败（${response.status}），服务端没有返回内容`);
    return null;
  }

  if (!contentType.includes("json")) {
    if (!response.ok) throw new Error(`${response.status} ${body.slice(0, 300)}`);
    return body;
  }

  let payload;
  try {
    payload = JSON.parse(body);
  } catch {
    // 声称是 JSON 却解析不了：把原文带出来，比一个 TypeError 强。
    throw new Error(`${response.status} 响应不是合法的 JSON：${body.slice(0, 200)}`);
  }
  if (!response.ok) {
    const error = new Error(payload?.error ?? `请求失败（${response.status}）`);
    error.status = response.status;
    error.detail = payload?.detail;
    throw error;
  }
  return payload;
}

/**
 * 把错误渲染成一块红字，并把 zod 的 issue 路径列出来。
 *
 * 关闭按钮是手写的，**没有**用 Bootstrap 的 `alert-dismissible`：那要靠
 * `data-bs-dismiss` 属性，而它由 bootstrap.js 实现——D18 说引入那个脚本要重新
 * 权衡 `/vendor` 的信任边界（理由见 tabs()）。
 */
function errorBox(error) {
  const box = el("div", { class: "alert alert-danger", role: "alert" });
  box.append(
    el("div", { class: "alert-head" }, [
      el("span", {}, [el("strong", { text: "出错了：" }), document.createTextNode(error.message)]),
      el("button", {
        type: "button",
        class: "alert-close",
        "aria-label": "关闭",
        text: "×",
        onclick: () => box.remove(),
      }),
    ]),
  );
  if (Array.isArray(error.detail)) {
    const list = el("ul");
    for (const issue of error.detail) {
      list.append(el("li", { text: `${issue.path || "(顶层)"}: ${issue.message}` }));
    }
    box.append(list);
  }
  return box;
}

let engines = [];
let enginesLoaded = false;

async function loadEngines() {
  if (enginesLoaded) return engines;
  engines = await call("/api/engines");
  enginesLoaded = true;
  return engines;
}

/** 引擎能力决定概率类断言是否可求值：degenerate 引擎下那些检查会是「跳过」。 */
function engineCapability(name) {
  return engines.find((engine) => engine.name === name) ?? null;
}

// ---------------------------------------------------------------------------
// 展示组件
// ---------------------------------------------------------------------------

/**
 * 提示段落。把文案里的 `**强调**` 渲染成真的 <strong>。
 *
 * 这些文案全是本文件里的静态字符串，但拼装仍然走 createTextNode——
 * 「不用 innerHTML」这条底线不因为「内容是我写的」而放松。
 */
function hint(text, extraClass = "") {
  const node = el("p", { class: extraClass === "" ? "hint" : `hint ${extraClass}` });
  text.split("**").forEach((part, index) => {
    if (part === "") return;
    node.append(index % 2 === 1 ? el("strong", { text: part }) : document.createTextNode(part));
  });
  return node;
}

/**
 * 状态药丸。`tone` 决定配色档位，`mark` 是字形。
 *
 * D9：`skipped` 走虚框 + 小字号（见 style.css），刻意比 passed/failed 轻。
 * D8：`undecided`（passed === null）是**第三种**东西——既不是通过也不是失败，
 * 也不该被读成「跳过」，所以它有自己的中性灰，不借用任何一方的颜色。
 */
function badge(tone, mark, label) {
  const node = el("span", { class: `badge badge--${tone}` });
  if (mark !== "") node.append(el("span", { class: "glyph", text: mark }));
  node.append(el("span", { text: label }));
  return node;
}

/**
 * 只表达 passed 的药丸，不掺 status。
 *
 * `passed === null`（未判定）必须走自己的中性灰：借用琥珀色会被读成「跳过」，
 * 借用红色会被读成「失败」——两者都是把没发生的结论画在界面上。
 */
function passedBadge(passed) {
  if (passed === true) return badge("passed", "✓", "通过");
  if (passed === false) return badge("failed", "✕", "失败");
  return badge("undecided", "?", "未判定");
}

/** 判决药丸。全站唯一决定「一次运行该怎么显示」的地方。 */
function verdictBadge(status, passed) {
  if (status === "running" || status === "queued") return badge("running", "●", statusLabel(status));
  return passedBadge(passed);
}

/** 内联 SVG 图标。`d` 是本文件里的静态常量，不含用户数据，因此不碰 innerHTML。 */
function svg(d, size = 20, className = "") {
  const NS = "http://www.w3.org/2000/svg";
  const node = document.createElementNS(NS, "svg");
  node.setAttribute("viewBox", "0 0 24 24");
  node.setAttribute("width", String(size));
  node.setAttribute("height", String(size));
  node.setAttribute("fill", "none");
  node.setAttribute("stroke", "currentColor");
  node.setAttribute("stroke-width", "1.6");
  node.setAttribute("stroke-linecap", "round");
  node.setAttribute("stroke-linejoin", "round");
  node.setAttribute("aria-hidden", "true");
  if (className !== "") node.setAttribute("class", className);
  const shape = document.createElementNS(NS, "path");
  shape.setAttribute("d", d);
  node.append(shape);
  return node;
}

const ICON_CASES = "M4 5h16v14H4zM8 9h8M8 13h8M8 17h4";
const ICON_RUNS = "M4 6h16v14H4zM8 3v4M16 3v4M4 11h16";
const ICON_KEY = "M14 10a4 4 0 1 0-4 4M10 14l-6 6M6 18l2 2M8 16l2 2M14 10l6-6";

/** 空状态：图标 + 标题 + 说明（+ 可选动作）。空列表不该只是一行灰字。 */
function emptyState({ icon, title, children = [] }) {
  return el("div", { class: "empty" }, [
    svg(icon, 32, "empty-mark"),
    el("h2", { text: title }),
    ...[].concat(children).filter(Boolean),
  ]);
}

/** 页头：标题在左，操作在右。`title` 可以是一个现成的节点（标题里要混等宽 id 时）。 */
function pageHead(title, actions = []) {
  return el("div", { class: "page-head" }, [
    typeof title === "string" ? el("h1", { text: title }) : title,
    actions.length === 0 ? null : el("div", { class: "actions" }, actions),
  ]);
}

/** 统计条。数据已经在报告里了，之前只是没显示出来。 */
function statRow(items) {
  return el("div", { class: "stat-row" },
    items.map(([value, label]) =>
      el("div", { class: "stat" }, [
        el("div", { class: "stat-value", text: value }),
        el("div", { class: "stat-label", text: label }),
      ]),
    ),
  );
}

/** 面包屑。二级页第一行给出来路，比只有一个标题更容易回到上一层。 */
function crumbs(trail) {
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
 * 手写标签页。
 *
 * **不用 Bootstrap 的 tab**：那需要 `bootstrap.js` 的 `data-bs-toggle`，
 * 而 D18 写明引入它的 JS 组件要把 `/vendor` 从「读静态文件」变成「运行第三方脚本」，
 * 得重新权衡信任边界。这里四十行就够，且不必欠那笔账。
 *
 * 所有面板**一次渲染、只切显隐**：切标签不重建 DOM，因此输入框的焦点与
 * 还没落进草稿的输入都不会丢。`onSelect(key, source)` 用来做「切过去时刷新」——
 * `source` 是 `"user"` 还是 `"programmatic"`，调用方据此区分「用户点的」与
 * 「代码替他切的」（结果页要按运行状态自动落档，又不能覆盖用户的手动选择）。
 */
function tabs(items, onSelect) {
  const bar = el("div", { class: "tabs", role: "tablist" });
  const panels = new Map();
  const buttons = new Map();
  const badges = new Map();

  const select = (key, source = "programmatic") => {
    if (!panels.has(key)) return;
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
    const panel = el("section", { class: "tab-panel", role: "tabpanel" });
    panel.hidden = true;
    panel.id = `panel-${item.key}`;
    panel.setAttribute("aria-labelledby", `tab-${item.key}`);
    panel.dataset.tab = item.key;
    panel.append(item.panel);
    panels.set(item.key, panel);

    const badge = el("span", { class: "tab-badge" });
    badge.hidden = true;
    badges.set(item.key, badge);

    const button = el("button", {
      type: "button",
      class: "tab",
      role: "tab",
      id: `tab-${item.key}`,
      "aria-controls": panel.id,
      onclick: () => select(item.key, "user"),
    });
    button.append(el("span", { text: item.label }), badge);
    buttons.set(item.key, button);
    bar.append(button);
  }

  // 方向键在标签之间移动（WAI-ARIA 的 tabs 惯例）：焦点与选中一起走。
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
    /** 角标在标签上承载「这一档有多少内容」，空串或 null = 不显示。 */
    setBadge: (key, text) => {
      const target = badges.get(key);
      if (target === undefined) return;
      target.textContent = text ?? "";
      target.hidden = !text;
    },
  };
}

/** 原生折叠。同样是为了不引 bootstrap.js 的 collapse。 */
function disclosure(summaryText, children, { open = false, summaryExtra = null } = {}) {
  const node = el("details", { class: "disclosure" });
  node.open = open;
  const summary = el("summary");
  summary.append(el("span", { text: summaryText }));
  if (summaryExtra !== null) summary.append(summaryExtra);
  node.append(summary, el("div", { class: "disclosure-body" }, [].concat(children).filter(Boolean)));
  return node;
}

// #region 纯函数：路径读写
//
// 这一段与下面标了同一个哨兵的那两段**不碰 DOM**，`tests/frontend.test.ts`
// 会把它们整段抠出来在一个干净的作用域里求值，用来跑「读进来再写出去不变」的
// 往返测试。往这段里加东西时请守住两条：只用入参与返回值，不引用 el/hint 之类
// 的渲染函数。这是本项目里唯一能不引 jsdom 就测到前端逻辑的口子。
// ---------------------------------------------------------------------------
// 草稿的路径读写
// ---------------------------------------------------------------------------

/**
 * 按点分路径读草稿。
 *
 * 路径写法与 **zod 的 issue 路径是同一套**——`docs/api.md` 举的例子就是
 * `assertions.final.controls.2.valueEquals`。于是每个控件挂的 `data-path`
 * 可以直接拿服务端回的错误去定位，不必再维护第二张映射表。
 */
function readPath(root, path) {
  let node = root;
  for (const key of path.split(".")) {
    if (node === null || typeof node !== "object") return undefined;
    node = node[key];
  }
  return node;
}

/**
 * 按路径写草稿。空值 = **删掉这个键**（YAML 里只写用户真的设了的字段），
 * 但**绝不删数组元素**：删元素会让它后面每一行的下标一起前移，而挂在
 * `data-path` 上的输入框不会跟着变——下一次击键就写进了隔壁那一行。
 * 「填了但保存后没有」正是这个文件要避免的失败模式。
 */
function writePath(root, path, value) {
  const keys = path.split(".");
  let node = root;
  for (let index = 0; index < keys.length - 1; index++) {
    const key = keys[index];
    const next = keys[index + 1];
    if (node[key] === null || typeof node[key] !== "object") {
      node[key] = /^\d+$/.test(next) ? [] : {};
    }
    node = node[key];
  }
  const last = keys[keys.length - 1];
  if (value === undefined || value === null || value === "") delete node[last];
  else node[last] = value;
}

/**
 * 这一行到底填了东西没有。
 *
 * `exists: true` **不算内容**：它是 schema 的默认值，用户没主动表达任何意思。
 * 把它算成内容的话，一条被清空了的控件断言会以 `{exists: true}` 的形状活下来，
 * 然后在保存时报「labelContains 必填」——用户看着一个空行被骂。
 */
function rowHasContent(row) {
  return Object.entries(row ?? {}).some(
    ([key, value]) => value !== undefined && value !== null && value !== "" && !(key === "exists" && value === true),
  );
}

/** 去掉「一个值都没填」的行；填了任何一格就保留，让 schema 去报它缺什么。 */
function dropEmptyRows(rows) {
  return [].concat(rows ?? []).filter(rowHasContent);
}

/** 字符串列表：去掉空行并 trim。空行不是断言。 */
function cleanStrings(list) {
  return [].concat(list ?? [])
    .filter((value) => typeof value === "string" && value.trim() !== "")
    .map((value) => value.trim());
}

/** 相对时间。列表里「3 分钟前」比一个完整时间戳更容易扫。 */
function relativeTime(iso) {
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return String(iso);
  const minutes = Math.round((Date.now() - then) / 60000);
  if (minutes < 1) return "刚刚";
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} 天前`;
  return new Date(then).toLocaleDateString();
}

/** 取一个 URL 的 origin。schema 只收 http/https，但这里仍要容忍垃圾输入。 */
function originOf(url) {
  try {
    return new URL(String(url)).origin;
  } catch {
    return null;
  }
}
// #endregion 纯函数：路径读写

// ---------------------------------------------------------------------------
// 视图：用例列表
// ---------------------------------------------------------------------------

async function viewCases(app) {
  const cases = await call("/api/cases");
  const importButton = el("button", {
    class: "btn btn-primary",
    text: "导入用例",
    onclick: () => {
      location.hash = "#/new";
    },
  });

  if (cases.length === 0) {
    app.replaceChildren(
      pageHead("用例", [importButton]),
      emptyState({
        icon: ICON_CASES,
        title: "还没有用例",
        children: [
          hint("粘一份 case.yaml，或者只填三个必填项手写一个——两条路都在「导入」页里。"),
          el("p", {}, [el("code", { text: "npm run dev -- import cases/wikipedia-godel.yaml" })]),
        ],
      }),
    );
    return;
  }

  // 错误提示插在页头与表格之间——原来 prepend 到 #app 会跑到标题上面去。
  const notices = el("div");

  app.replaceChildren(
    pageHead("用例", [importButton]),
    notices,
    el("div", { class: "table-responsive" }, [
      el("table", { class: "table table-hover align-middle list-table" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "用例" }),
            el("th", { text: "最近一次运行" }),
            el("th", { class: "col-actions", text: "操作" }),
          ]),
        ]),
        el("tbody", {}, cases.map(caseRow)),
      ]),
    ]),
  );

  function caseRow(item) {
    // 标题是主行、id 与版本退到次行：扫列表时先认出「哪个用例」，而不是先读一串 id。
    const nameCell = el("td", {}, [
      el("a", { class: "row-title", href: `#/case/${item.id}`, text: item.title || item.id }),
      el("div", {
        class: "row-meta mono",
        text: `${item.id} · r${item.revision}${item.authState ? ` · 登录态 ${item.authState}` : ""}`,
      }),
    ]);

    const runCell = item.lastRun
      ? el("a", { href: `#/run/${item.lastRun.runId}`, class: "verdict" }, [
          verdictBadge(item.lastRun.status, item.lastRun.passed),
          el("span", { class: "hint", text: relativeTime(item.lastRun.startedAt) }),
        ])
      : el("span", { class: "hint", text: "从未运行" });

    return el("tr", {}, [
      nameCell,
      el("td", {}, [runCell]),
      el("td", { class: "col-actions" }, [
        el("button", {
          class: "btn btn-sm btn-outline-primary",
          text: "运行",
          onclick: async (event) => {
            const button = event.target;
            button.disabled = true;
            const run = async () => {
              try {
                await runCaseAndOpen(item.id);
              } catch (error) {
                notices.replaceChildren(errorBox(error));
                button.disabled = false;
              }
            };
            const preflight = await loginPreflight(item, { onRun: run });
            if (preflight === null) return run();
            notices.replaceChildren(preflight);
            preflight.scrollIntoView({ behavior: "smooth", block: "nearest" });
            button.disabled = false;
          },
        }),
        // 删除收进折叠里：它是破坏性的、又不可撤销，不该和「运行」并排抢点击。
        disclosure("更多", [
          el("button", {
            class: "btn btn-sm btn-outline-danger",
            text: "删除用例",
            onclick: async () => {
              if (!confirm(`删除用例 ${item.id}？该操作不做撤销。`)) return;
              try {
                await call(`/api/cases/${item.id}`, { method: "DELETE" });
                await viewCases(app);
              } catch (error) {
                notices.replaceChildren(errorBox(error));
              }
            },
          }),
        ]),
      ]),
    ]);
  }
}

// ---------------------------------------------------------------------------
// 视图：用例编辑
// ---------------------------------------------------------------------------

// #region 纯函数：草稿
//
// 与上面那段同样的规矩：不碰 DOM，可以被整段抠出来跑测试。
/**
 * 用例草稿。空字符串一律不落盘——YAML 里只写用户真的设了的字段。
 *
 * **数组字段必须在这里就存在**（哪怕是空的）：行编辑器把用户输入直接写回这些数组，
 * 若某处传的是 `?? []` 这种临时数组，新增的行会被写进一个随即被丢弃的对象里，
 * 表现是「填了但保存后没有」。
 */
function emptyDraft() {
  return {
    title: "",
    goal: "",
    startUrl: "",
    mode: "interactive",
    allowedOrigins: [],
    // "" = 不带登录态。与其他字段一样，空串不落盘
    authState: "",
    engine: "",
    budget: {},
    guardrails: [],
    allowDefaultOverride: false,
    assertions: {
      final: { controls: [] },
      trajectory: { mustUse: [], mustNotUse: [] },
      quality: {},
    },
  };
}

/**
 * 断言配方：**一句人话对应 schema 里的一处**。
 *
 * 这是这次简化里最要紧的一层。原先让用户先选「哪一层」（final / trajectory /
 * quality）、再从十几个字段里挑一格，等于把 schema 的结构摆在用户面前；
 * 现在直接说要什么。措辞取自 `docs/writing-cases.md §3`——那是这个平台本来
 * 就教给用户的话，界面与文档用同一套词汇。
 *
 * `path(index)` / `where` 给出的路径与 zod 的 issue 路径同一套写法，
 * 因此服务端回的校验错误能直接落回具体某一行。
 *
 * `single: true` 的配方最多存在一条（枚举或标量，没有「多条」这回事）；
 * 其余的按数组下标排列，**行序即报告里检查路径的顺序**。
 */
const RECIPES = [
  {
    kind: "text.contains",
    sentence: "最终页面包含文本",
    where: "assertions.final.text.contains",
    path: (index) => `assertions.final.text.contains.${index}`,
    value: "文本片段",
  },
  {
    kind: "text.notContains",
    sentence: "最终页面不包含文本",
    where: "assertions.final.text.notContains",
    path: (index) => `assertions.final.text.notContains.${index}`,
    value: "文本片段",
  },
  {
    kind: "url.contains",
    sentence: "最终地址包含",
    where: "assertions.final.url.contains",
    path: (index) => `assertions.final.url.contains.${index}`,
    value: "URL 里稳定的 ASCII 片段",
  },
  {
    kind: "controls.exists",
    sentence: "最终页面存在控件",
    where: "assertions.final.controls",
    path: (index) => `assertions.final.controls.${index}.labelContains`,
    value: "可访问名片段",
    item: () => ({ labelContains: "", exists: true }),
  },
  {
    kind: "controls.absent",
    sentence: "最终页面不存在控件",
    where: "assertions.final.controls",
    path: (index) => `assertions.final.controls.${index}.labelContains`,
    value: "可访问名片段",
    item: () => ({ labelContains: "", exists: false }),
  },
  {
    kind: "statusIn",
    sentence: "结束方式必须是",
    where: "assertions.trajectory.statusIn",
    path: () => "assertions.trajectory.statusIn",
    single: true,
    statuses: true,
  },
  {
    kind: "mustUse",
    sentence: "必须点到（按可访问名）",
    where: "assertions.trajectory.mustUse",
    path: (index) => `assertions.trajectory.mustUse.${index}.labelContains`,
    value: "可访问名片段",
    item: () => ({ labelContains: "" }),
  },
  {
    kind: "mustNotUse",
    sentence: "绝不能点到（按可访问名）",
    where: "assertions.trajectory.mustNotUse",
    path: (index) => `assertions.trajectory.mustNotUse.${index}.labelContains`,
    value: "可访问名片段",
    item: () => ({ labelContains: "" }),
  },
  {
    kind: "maxSteps",
    sentence: "最多走几步",
    where: "assertions.trajectory.maxSteps",
    path: () => "assertions.trajectory.maxSteps",
    single: true,
    numeric: true,
    value: "步数（是断言，不是刹车）",
  },
  {
    kind: "maxModelCalls",
    sentence: "最多几次模型请求",
    where: "assertions.quality.maxModelCalls",
    path: () => "assertions.quality.maxModelCalls",
    single: true,
    numeric: true,
    value: "次数",
  },
];

const RECIPE_BY_KIND = new Map(RECIPES.map((recipe) => [recipe.kind, recipe]));

const RUN_STATUSES = [
  "queued",
  "running",
  "done",
  "blocked",
  "budget_exceeded",
  "guardrail_blocked",
  "cancelled",
  "error",
];

const ACTION_KINDS = ["click", "fill", "select", "scroll", "wait"];

/**
 * 一行配方是不是「完全由配方表达」的。
 *
 * 判据是**结构**（键的集合），不是「有没有填值」。填没填由保存时的
 * `dropEmptyRows` 决定：清空一行 = 删掉这条断言，但**在编辑过程中它仍然显示**，
 * 否则用户刚删掉最后一个字符，那一行就从眼前消失（还带着他的输入焦点）。
 */
function recipeCovers(recipe, row) {
  const keys = Object.keys(row);
  if (recipe.kind === "controls.exists" || recipe.kind === "controls.absent") {
    return keys.every((key) => key === "labelContains" || key === "exists");
  }
  return keys.every((key) => key === "labelContains");
}

/** 把草稿里能被配方表达的东西摊成一行行（顺序固定，见 RECIPES 的注释）。 */
function assertionRows(draft) {
  const rows = [];
  const final = draft.assertions.final ?? {};
  const trajectory = draft.assertions.trajectory ?? {};
  const quality = draft.assertions.quality ?? {};

  for (const [kind, list] of [
    ["text.contains", final.text?.contains],
    ["text.notContains", final.text?.notContains],
    ["url.contains", final.url?.contains],
  ]) {
    const recipe = RECIPE_BY_KIND.get(kind);
    [].concat(list ?? []).forEach((value, index) => {
      rows.push({ recipe, index, path: recipe.path(index), value });
    });
  }

  [].concat(final.controls ?? []).forEach((row, index) => {
    const recipe = RECIPE_BY_KIND.get(row.exists === false ? "controls.absent" : "controls.exists");
    if (recipeCovers(recipe, row)) rows.push({ recipe, index, path: recipe.path(index), value: row.labelContains ?? "" });
  });

  for (const [kind, list] of [["mustUse", trajectory.mustUse], ["mustNotUse", trajectory.mustNotUse]]) {
    const recipe = RECIPE_BY_KIND.get(kind);
    [].concat(list ?? []).forEach((row, index) => {
      if (recipeCovers(recipe, row)) rows.push({ recipe, index, path: recipe.path(index), value: row.labelContains ?? "" });
    });
  }

  // 存在即占一行——**空的 `statusIn` 也要显示出来**（理由见 formToDefinition 里那段）。
  if (Array.isArray(trajectory.statusIn)) {
    const recipe = RECIPE_BY_KIND.get("statusIn");
    rows.push({ recipe, path: recipe.path(), value: trajectory.statusIn });
  }
  for (const [kind, value] of [["maxSteps", trajectory.maxSteps], ["maxModelCalls", quality.maxModelCalls]]) {
    if (typeof value === "number") {
      const recipe = RECIPE_BY_KIND.get(kind);
      rows.push({ recipe, path: recipe.path(), value });
    }
  }
  return rows;
}

/** 一行配方里填了东西没有——角标不该把空行也数进去。 */
function rowIsSet(row) {
  return Array.isArray(row.value) ? true : row.value !== "" && row.value !== undefined;
}

/**
 * 配方覆盖不到的构造在这里逐个列出——**原样保留**。
 *
 * 这是整层设计里最要紧的一条纪律：配方是**视图**，不是数据的所有者。
 * 载入的用例里有任何配方表达不了的写法（`final.title.matches`、`forbiddenKinds`、
 * `minTargetProbability`……），保存时必须还在。所以 `formToDefinition` 始终从
 * `draft` 整体出发，而不是从配方行重建一份。
 */
const RAW_FIELDS = [
  { path: "assertions.final.url.equals", label: "final.url.equals（与整个 URL 全等，很脆）", type: "text" },
  { path: "assertions.final.url.matches", label: "final.url.matches（每行一条正则）", type: "lines" },
  { path: "assertions.final.title.equals", label: "final.title.equals", type: "text" },
  { path: "assertions.final.title.contains", label: "final.title.contains（每行一条）", type: "lines" },
  { path: "assertions.final.title.notContains", label: "final.title.notContains（每行一条）", type: "lines" },
  { path: "assertions.final.title.matches", label: "final.title.matches（每行一条正则）", type: "lines" },
  { path: "assertions.final.text.equals", label: "final.text.equals", type: "text" },
  { path: "assertions.final.text.matches", label: "final.text.matches（每行一条正则）", type: "lines" },
  { path: "assertions.trajectory.forbiddenKinds", label: "trajectory.forbiddenKinds（禁止出现的动作种类）", type: "kinds" },
  { path: "assertions.trajectory.maxIdenticalConsecutive", label: "trajectory.maxIdenticalConsecutive（连续多少步无变化算卡住）", type: "number" },
  { path: "assertions.quality.minOperationProbability", label: "quality.minOperationProbability（0~1）", type: "number" },
  { path: "assertions.quality.minTargetProbability", label: "quality.minTargetProbability（0~1）", type: "number" },
  { path: "assertions.quality.maxElapsedMs", label: "quality.maxElapsedMs", type: "number" },
  { path: "assertions.quality.maxInputTokens", label: "quality.maxInputTokens", type: "number" },
  { path: "assertions.quality.maxCostUsd", label: "quality.maxCostUsd", type: "number" },
];

const BUDGET_FIELDS = [
  ["maxSteps", "maxSteps（最多执行几步）", "40"],
  ["maxModelCalls", "maxModelCalls（最多几次决策请求）", "40"],
  ["maxInputTokens", "maxInputTokens（累计输入 token 上限）", "200000"],
  ["maxCostUsd", "maxCostUsd（留空 = 不限）", ""],
  ["maxElapsedMs", "maxElapsedMs（墙钟上限，毫秒）", "300000"],
];

/**
 * 保存前的提示。**只做能证明的检查**，且一律是提示、不阻断保存。
 *
 * 这几条来自 `docs/writing-cases.md §4 常见陷阱`：那些坑是确定的（不是「可能」），
 * 让用户保存完跑一遍才发现，等于把成本推给他。
 *
 * 注意这些规则**目前只在前端提示**。若确认有价值，正确的做法是把它们提升为
 * schema 的跨字段校验、让 CLI 与 Web 同时受用——而不是让界面单方面发明规则。
 */
function presaveWarnings(draft) {
  const out = [];
  const trajectory = draft.assertions.trajectory ?? {};
  const mustUse = dropEmptyRows(trajectory.mustUse);
  const mustNotUse = dropEmptyRows(trajectory.mustNotUse);
  const forbidden = [].concat(trajectory.forbiddenKinds ?? []);
  const readonly = (draft.mode ?? "interactive") === "readonly";

  if (readonly) {
    const mutating = mustUse.filter((row) => row.kind === "fill" || row.kind === "select");
    if (mutating.length > 0) {
      out.push("readonly 用例里声明了「必须点到」的变更型动作：它们在动作空间**构造阶段**就被剔除（D10），这条断言不可能通过。");
    }
  }

  const forbiddenHit = mustUse.filter((row) => row.kind !== undefined && forbidden.includes(row.kind));
  if (forbiddenHit.length > 0) {
    out.push("同一个动作既在 mustUse 里又在 forbiddenKinds 里，这两条断言互相矛盾，必然有一条失败。");
  }

  const bothSides = mustNotUse
    .map((row) => row.labelContains)
    .filter((label) => label !== undefined && mustUse.some((row) => row.labelContains === label));
  if (bothSides.length > 0) {
    out.push(`同一条可访问名同时出现在 mustUse 与 mustNotUse 里：${bothSides.join("、")}——两条断言必然有一条失败。`);
  }

  // 这是 schema 已有的跨字段校验（case.ts 的 refine），不提前说就只能靠一次保存失败才知道。
  const origins = cleanStrings(draft.allowedOrigins);
  const startOrigin = originOf(draft.startUrl);
  if (origins.length > 0 && startOrigin !== null && !origins.includes(startOrigin)) {
    out.push(`域名白名单里没有起始地址的 origin（${startOrigin}）：schema 要求白名单必须包含它，否则保存会被拒。`);
  }

  const assertionCount = assertionRows(draft).filter(rowIsSet).length;
  if (assertionCount === 0) {
    out.push("没有声明任何断言：这次运行的 `passed` 会是**未判定**（不是通过）。");
  }
  return out;
}

/** 「哪些标签页有内容」——角标与默认落档都靠它。 */
function draftSummary(draft) {
  const assertions = assertionRows(draft).filter(rowIsSet).length;
  const budget = Object.keys(draft.budget ?? {}).length;
  const guardrails = dropEmptyRows(draft.guardrails).length;
  return { assertions, limits: budget + guardrails + (draft.allowDefaultOverride ? 1 : 0) };
}

/**
 * 草稿 -> 服务端认识的 `CaseDefinition`。
 *
 * **纯函数，不碰 DOM**（D19 之前这里从 form.elements 读值，与直接写 draft 的
 * 行编辑器构成双源，一行填了却不在另一处就静默丢失）。空的行与空的字符串在这里
 * 掉掉，其余一律照原样交给 schema——**不替服务端做判断**，判错了要报得出的错它自己报。
 */
function formToDefinition(draft) {
  const definition = {
    title: (draft.title ?? "").trim(),
    goal: (draft.goal ?? "").trim(),
    startUrl: (draft.startUrl ?? "").trim(),
  };
  if (draft.id) definition.id = draft.id;
  if (draft.mode && draft.mode !== "interactive") definition.mode = draft.mode;
  if (draft.engine) definition.engine = draft.engine;

  const origins = cleanStrings(draft.allowedOrigins);
  if (origins.length > 0) definition.allowedOrigins = origins;
  if (draft.authState) definition.authState = draft.authState;

  const budget = {};
  for (const [key] of BUDGET_FIELDS) {
    const value = draft.budget?.[key];
    if (typeof value === "number" && Number.isFinite(value)) budget[key] = value;
  }
  if (Object.keys(budget).length > 0) definition.budget = budget;

  const guardrails = dropEmptyRows(draft.guardrails).map((row) => {
    const out = {};
    for (const key of ["labelContains", "labelMatches", "role", "reason"]) {
      if (row[key] !== undefined && row[key] !== "") out[key] = row[key];
    }
    return out;
  });
  if (guardrails.length > 0) definition.guardrails = guardrails;
  if (draft.allowDefaultOverride) definition.allowDefaultOverride = true;

  const assertions = {};
  const final = {};
  const finalIn = draft.assertions.final ?? {};
  for (const key of ["url", "title", "text"]) {
    const match = textMatchOf(finalIn[key]);
    if (match !== undefined) final[key] = match;
  }
  const controls = dropEmptyRows(finalIn.controls).map(coerceControl);
  if (controls.length > 0) final.controls = controls;
  if (Object.keys(final).length > 0) assertions.final = final;

  const trajectory = {};
  const trajectoryIn = draft.assertions.trajectory ?? {};
  const statusIn = [].concat(trajectoryIn.statusIn ?? []).filter((value) => RUN_STATUSES.includes(value));
  // **空数组也要写回去**：`statusIn: []` 不是「没设」，而是「任何结束方式都不接受」，
  // 那份断言对每一次运行都失败（checks 里按集合成员判）。旧表单用「每行一个」，
  // 空 textarea 会让这一项消失、退化回默认的 `["done"]`——把一条必然失败的断言
  // 悄悄变成了通过的条件。
  if (Array.isArray(trajectoryIn.statusIn)) trajectory.statusIn = statusIn;
  if (typeof trajectoryIn.maxSteps === "number") trajectory.maxSteps = trajectoryIn.maxSteps;
  if (typeof trajectoryIn.maxIdenticalConsecutive === "number") {
    trajectory.maxIdenticalConsecutive = trajectoryIn.maxIdenticalConsecutive;
  }
  const forbiddenKinds = [].concat(trajectoryIn.forbiddenKinds ?? []).filter((value) => ACTION_KINDS.includes(value));
  if (forbiddenKinds.length > 0) trajectory.forbiddenKinds = forbiddenKinds;
  const mustUse = dropEmptyRows(trajectoryIn.mustUse).map(coerceActionMatch);
  if (mustUse.length > 0) trajectory.mustUse = mustUse;
  const mustNotUse = dropEmptyRows(trajectoryIn.mustNotUse).map(coerceActionMatch);
  if (mustNotUse.length > 0) trajectory.mustNotUse = mustNotUse;
  if (Object.keys(trajectory).length > 0) assertions.trajectory = trajectory;

  const quality = {};
  for (const [key, value] of Object.entries(draft.assertions.quality ?? {})) {
    if (typeof value === "number" && Number.isFinite(value)) quality[key] = value;
  }
  if (Object.keys(quality).length > 0) assertions.quality = quality;

  if (Object.keys(assertions).length > 0) definition.assertions = assertions;
  return definition;
}

/** TextMatch：只留下真的设了的键。四个键彼此独立，可以共存。 */
function textMatchOf(match) {
  if (match === null || typeof match !== "object") return undefined;
  const out = {};
  if (typeof match.equals === "string" && match.equals.trim() !== "") out.equals = match.equals.trim();
  for (const key of ["contains", "notContains", "matches"]) {
    const items = cleanStrings(match[key]);
    if (items.length > 0) out[key] = items;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * 表单里一切都是字符串，落盘前要还原成 schema 的类型。
 *
 * `exists` / `checked` 是布尔：旧表单让用户手打 true/false，而 `value !== "true"`
 * 会被当成 `false`——打「是」「TRUE」「1」都会**静默地把断言反过来**
 * （exists:true 变成 exists:false，主张完全相反）。现在这两格是三态下拉
 * （未设 / true / false），所以这里的映射是**穷尽**的，不存在第三种输入。
 */
function coerceControl(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || value === "") continue;
    if (key === "exists" || key === "checked") {
      if (value === "true" || value === true) out[key] = true;
      else if (value === "false" || value === false) out[key] = false;
      else continue;
    } else {
      out[key] = value;
    }
  }
  return out;
}

function coerceActionMatch(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) if (value !== undefined && value !== "") out[key] = value;
  return out;
}

/** 读回来的用例补成草稿的形状，好让表单各处都不必写 `?? {}`。 */
function normalizeDraft(def) {
  return {
    ...emptyDraft(),
    ...def,
    allowedOrigins: def.allowedOrigins ?? [],
    budget: def.budget ?? {},
    guardrails: (def.guardrails ?? []).map((row) => ({ ...row })),
    assertions: {
      final: {
        ...(def.assertions?.final ?? {}),
        controls: (def.assertions?.final?.controls ?? []).map((row) => ({ ...row })),
      },
      trajectory: {
        ...(def.assertions?.trajectory ?? {}),
        mustUse: (def.assertions?.trajectory?.mustUse ?? []).map((row) => ({ ...row })),
        mustNotUse: (def.assertions?.trajectory?.mustNotUse ?? []).map((row) => ({ ...row })),
      },
      quality: { ...(def.assertions?.quality ?? {}) },
    },
  };
}

/**
 * 从地址推一个登录态名字：取主机名的第一段，规整成 `[a-z0-9-]`。
 * `https://shop_test9.example.com/x` -> `shop-test9`。只是建议值，用户可改。
 */
function suggestAuthName(url) {
  let host = "";
  try {
    host = new URL(String(url)).hostname;
  } catch {
    return "";
  }
  // IP 地址推不出有意义的名字，留空让人自己填
  if (/^[\d.]+$/.test(host) || host.includes(":")) return "";
  const first = host.split(".")[0] === "www" ? host.split(".")[1] ?? "" : host.split(".")[0] ?? "";
  const slug = first.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 64);
  return slug.length >= 2 ? slug : "";
}

/** 草稿的指纹，用来判断「改了没有」。比字段级 diff 便宜，也够用。 */
function signature(value) {
  return JSON.stringify(value);
}
// #endregion 纯函数：草稿

async function viewCaseEditor(app, caseId) {
  await loadEngines();

  const loaded = caseId === null ? null : await call(`/api/cases/${caseId}`);
  const draft = loaded === null ? emptyDraft() : normalizeDraft(loaded.def);
  // 登录态列表只是下拉框的选项。读不到不该让编辑器打不开——退化成空列表，用例里写的值照样保留
  let authStates = await call("/api/auth-states").catch(() => []);
  /** 磁盘上这个用例现在用的登录态。与草稿不同 = 选了但还没保存，运行不会带上它 */
  let savedAuthState = loaded?.def.authState ?? "";
  let refreshAuthStatus = null;
  /** 「检测页面」发现被跳到登录页时，用它把登录流程直接开在登录态字段下面 */
  let openLoginFlow = null;
  let revision = loaded === null ? null : loaded.revision.revision;
  const baseline = signature(formToDefinition(draft));

  const notices = el("div");
  const warnings = el("div", { class: "form-warnings" });
  const versionNote = hint(
    caseId === null ? "填完保存后会得到一个 id（由标题推导）。" : `当前版本 r${revision}`,
  );
  const dirtyBadge = el("span", { class: "dirty-badge", hidden: true, text: "有未保存的修改" });

  const basicPanel = el("div");
  const assertionPanel = el("div");
  const limitsPanel = el("div");
  const previewPanel = el("div");

  const tabbar = tabs(
    [
      { key: "basic", label: "基本", panel: basicPanel },
      { key: "assertions", label: "断言", panel: assertionPanel },
      { key: "limits", label: "预算与护栏", panel: limitsPanel },
      { key: "preview", label: "保存内容", panel: previewPanel },
    ],
    (key) => {
      // 「保存内容」要按**此刻**的草稿现算，所以切过去时重画一次。
      if (key === "preview") renderPreview();
    },
  );

  // 两个按钮都显式声明 `type="button"`：`<button>` 在 <form> 里默认是 submit，
  // 那样在任意文本框里按一次回车就等于点了第一个提交按钮——在填护栏那一行的
  // 半途按回车就把用例存了，而这件事从代码上看不出来。
  const saveButton = el("button", { type: "button", class: "btn btn-primary", text: caseId === null ? "创建" : "保存" });
  saveButton.addEventListener("click", save);
  const admitButton = el("button", {
    type: "button",
    class: "btn btn-outline-secondary",
    text: "检测页面",
    title: "只读地打开一次**已保存**的用例所指的页面，检查本平台能不能测它。不调用模型。",
  });
  admitButton.addEventListener("click", admit);

  // 未保存的用例没有 id，「检测页面」无从下手（它按用例里存的 startUrl 打开页面）。
  // 置灰并把原因写在旁边，比点一下再报错少一次困惑。
  admitButton.disabled = caseId === null;
  const actions = el("div", { class: "form-actions" }, [
    el("div", { class: "form-actions-main" }, [saveButton, dirtyBadge]),
    el("div", { class: "form-actions-aside" }, [
      caseId === null ? hint("保存后才能「检测页面」") : null,
      admitButton,
    ]),
  ]);

  const form = el("form", { class: "case-form", onsubmit: (event) => event.preventDefault() });
  form.append(tabbar.node, warnings, actions);

  app.replaceChildren(
    crumbs([{ text: "用例", href: "#/cases" }, { text: caseId === null ? "新建" : draft.title || caseId }]),
    pageHead(caseId === null ? "新建用例" : `编辑 ${caseId}`),
    versionNote,
    notices,
    form,
  );

  // -------------------------------------------------------------------------
  // 绑定到草稿的控件
  // -------------------------------------------------------------------------

  /**
   * 一个绑定到草稿路径的控件。`oninput` 只做三件事：写回草稿、刷新角标与脏标记、
   * 重画保存前提示——**绝不重渲染**，否则每敲一个字符都会丢焦点。
   */
  function draftField(path, labelText, options = {}) {
    const {
      hintText = "",
      required = false,
      // `multiline` = 用 textarea 画；`list` = 值是**字符串数组**（每行一条）。
      // 两者必须分开：goal 是「多行的**一个**字符串」，allowedOrigins 是「多个字符串」。
      // 混成一个开关的后果是把 goal 存成数组，而 formToDefinition 会对着它调 .trim()。
      multiline = false,
      list = false,
      placeholder = "",
      numeric = false,
      type = "text",
      rows = 3,
    } = options;

    const current = readPath(draft, path);
    const input = multiline
      ? el("textarea", { class: "form-control font-monospace", rows })
      : el("input", { class: "form-control", type: numeric ? "number" : type, placeholder });
    input.value = Array.isArray(current) ? current.join("\n") : (current ?? "");
    input.dataset.path = path;

    input.addEventListener("input", () => {
      if (numeric) {
        const parsed = Number(input.value.trim());
        writePath(draft, path, input.value.trim() !== "" && Number.isFinite(parsed) ? parsed : "");
      } else if (list) {
        writePath(draft, path, cleanStrings(input.value.split("\n")));
      } else {
        writePath(draft, path, input.value.trim());
      }
      refreshSummary();
    });

    const label = el("span", { class: "form-label" });
    label.append(document.createTextNode(labelText));
    if (required) label.append(el("span", { class: "req", title: "必填", text: "*" }));

    return el("div", { class: "mb-3" }, [
      el("label", { class: "d-block" }, [label, input]),
      hintText ? hint(hintText) : null,
    ]);
  }

  /** 下拉框版本的 draftField。取值是封闭枚举，让用户手打只会打错。 */
  function draftSelect(path, labelText, options, hintText = "") {
    const current = readPath(draft, path) ?? "";
    const select = el("select", { class: "form-select" });
    select.dataset.path = path;
    for (const [value, text] of options) {
      const item = el("option", { value, text });
      if (value === current) item.selected = true;
      select.append(item);
    }
    select.addEventListener("change", () => {
      writePath(draft, path, select.value);
      refreshSummary();
    });
    return el("div", { class: "mb-3" }, [
      el("label", { class: "d-block" }, [el("span", { class: "form-label", text: labelText }), select]),
      hintText ? hint(hintText) : null,
    ]);
  }

  /** 多选（复选）版的枚举控件。`forbiddenKinds` 与 `statusIn` 都是封闭集合。 */
  function enumPicker(path, options, { labels = {}, onChange = null } = {}) {
    const wrap = el("div", { class: "enum-picker" });
    const current = () => [].concat(readPath(draft, path) ?? []);
    for (const value of options) {
      const box = el("input", { class: "form-check-input", type: "checkbox", checked: current().includes(value) });
      box.dataset.path = `${path}.${options.indexOf(value)}`;
      box.addEventListener("change", () => {
        const chosen = current();
        const next = chosen.filter((item) => item !== value);
        if (box.checked) next.push(value);
        // 顺序按 options 归位，免得「勾选顺序」变成落盘顺序。
        const ordered = options.filter((item) => next.includes(item));
        if (ordered.length === 0) {
          // 一个都不选 = 删掉这条断言（而不是留下一句「什么都不接受」）。
          writePath(draft, path, "");
          refreshSummary();
          onChange?.();
          return;
        }
        writePath(draft, path, ordered);
        refreshSummary();
      });
      wrap.append(
        el("label", { class: "form-check form-check-inline" }, [
          box,
          el("span", { class: "form-check-label mono", text: labels[value] ?? value }),
        ]),
      );
    }
    return wrap;
  }

  // -------------------------------------------------------------------------
  // 一档一档地画
  // -------------------------------------------------------------------------

  function renderBasic() {
    const originsNotice = el("p", { class: "hint" });
    const refreshOriginsNotice = () => {
      const startOrigin = originOf(draft.startUrl);
      const origins = cleanStrings(draft.allowedOrigins);
      if (startOrigin === null) {
        originsNotice.textContent = "起始地址填好后，这里会显示出必须包含在白名单里的 origin。";
        return;
      }
      originsNotice.textContent = origins.length === 0
        ? `留空即由起始地址推导：${startOrigin}。`
        : origins.includes(startOrigin)
          ? `白名单已包含 ${startOrigin}。`
          : `白名单里没有起始地址的 origin（${startOrigin}）——保存会被拒。`;
    };

    const engineField = engines.length > 1
      ? draftSelect("engine", "决策引擎 engine", [["", "(默认)"]].concat(engines.map((engine) => [engine.name, engine.name])),
          "留空则用服务端默认引擎。")
      : hint(
          engines.length === 0
            ? "服务端没有注册任何引擎。"
            : `当前只注册了一个引擎：**${engines[0].name}**（留空即用它），因此这里不放下拉框。`,
        );

    // 引擎的能力决定概率类断言是求值还是**跳过**（D9）。这句话原先挂在表单最底下，
    // 离「引擎」和「概率断言」都很远；现在它跟着引擎走——选完就能看见后果。
    // 用 replaceChildren 重画而不是改 textContent：hint() 会把 `**粗体**` 渲染成
    // <strong>，直接覆写 textContent 会让用户看见字面的星号。
    const engineNotice = el("div");
    const refreshEngineNotice = () => engineNotice.replaceChildren(hint(engineNoticeText(draft.engine ?? "")));
    refreshEngineNotice();
    engineField.querySelector?.("select")?.addEventListener("change", refreshEngineNotice);

    basicPanel.replaceChildren(
      draftField("title", "标题", { required: true, placeholder: "维基百科：哥德尔不完备定理" }),
      draftField("goal", "目标 goal", {
        required: true,
        multiline: true,
        rows: 4,
        hintText: "唯一的行为指令。**断言不参与其中**——让 agent 看见判分标准会诱导它对着答案演戏。",
      }),
      draftField("startUrl", "起始地址 startUrl", { required: true, type: "url", placeholder: "https://en.wikipedia.org" }),
      authStateField(),
      draftSelect("mode", "模式 mode", [
        ["interactive", "interactive（默认：允许变更型操作）"],
        ["readonly", "readonly（不改变任何页面状态）"],
      ], "readonly 下变更型操作在动作空间**构造阶段**就被剔除，模型物理上无法选中。"),
      disclosure("更多（引擎与域名白名单）", [
        engineField,
        engineNotice,
        draftField("allowedOrigins", "域名白名单 allowedOrigins（每行一个 origin）", {
          multiline: true,
          list: true,
          rows: 3,
          hintText: "缺省由 startUrl 推导；越界即终止为 guardrail_blocked。",
        }),
        originsNotice,
      ]),
    );
    refreshOriginsNotice();
    // startUrl 改了要跟着更新那句「必须包含的 origin」，所以这里多挂一个监听。
    basicPanel.addEventListener("input", refreshOriginsNotice);
  }

  /**
   * 登录态：下拉选一份，或者就地新建。
   *
   * **就地**是刻意的：跳去「登录态」页会丢掉这里还没保存的草稿。
   * 新建完自动选上，并把那一次验证的结论显示在下拉框下面。
   */
  function authStateField() {
    const select = el("select", { class: "form-select" });
    select.dataset.path = "authState";
    const status = el("div", { class: "auth-state-status" });
    const flowSlot = el("div");

    const fill = () => {
      const current = draft.authState ?? "";
      const options = [["", "不使用（以未登录的全新浏览器打开）"]].concat(
        authStates.map((item) => [item.name, `${item.name}（${sitesText(item.sites)}）`]),
      );
      // 用例引用了一份已经不存在的登录态：保留这一项并标出来。
      // 静默落回「不使用」等于替用户改了用例，而他根本不知道。
      if (current !== "" && !authStates.some((item) => item.name === current)) {
        options.push([current, `${current}（不存在，运行会失败）`]);
      }
      select.replaceChildren(
        ...options.map(([value, text]) => {
          const option = el("option", { value, text });
          if (value === current) option.selected = true;
          return option;
        }),
      );
      refreshStatus();
    };

    const refreshStatus = () => {
      const name = draft.authState ?? "";
      const chosen = authStates.find((item) => item.name === name);
      // 选了但没保存：运行用的是磁盘上的版本，不会带上它。这一句必须显眼——
      // 「登录态已保存」与「用例已保存」是两件事，界面上最容易混。
      const pending = name !== savedAuthState
        ? el("div", { class: "auth-pending" }, [
            el("span", {
              text: name === ""
                ? "已改为不使用登录态，但用例还没保存。"
                : `已选上 ${name}，但用例还没保存——现在运行不会带上它。`,
            }),
            el("button", { type: "button", class: "btn btn-sm btn-primary", text: "保存用例", onclick: () => void save() }),
          ])
        : null;
      if (name === "") {
        setChildren(status, [
          pending,
          hint("目标页要求登录时选一份；没有合适的就点「新建」，在弹出的浏览器里登录一次即可。**密码不经过模型。**"),
        ]);
        return;
      }
      if (chosen === undefined) {
        setChildren(status, [
          pending,
          el("p", { class: "blocking", text: `登录态 ${name} 不存在：点「新建」建一份同名的，或换一个。` }),
        ]);
        return;
      }
      const verified = chosen.lastVerified;
      setChildren(status, [
        pending,
        el("div", { class: "verify-line" }, [
          verifyBadge(verified),
          el("span", { class: "hint", text: verified ? verified.detail : `保存于 ${relativeTime(chosen.savedAt)}，还没验证过` }),
          verified && !verified.ok
            ? el("button", {
                type: "button",
                class: "btn btn-sm btn-outline-primary",
                text: "重新登录",
                onclick: () => openFlow({ name: chosen.name, url: chosen.loginUrl ?? draft.startUrl ?? "", overwrite: true }),
              })
            : null,
        ]),
      ]);
    };

    const openFlow = (options) => {
      flowSlot.replaceChildren(
        loginFlow({
          ...options,
          onSaved: async (summary) => {
            authStates = await call("/api/auth-states").catch(() => authStates);
            writePath(draft, "authState", summary.name);
            fill();
            refreshSummary();
          },
          onClose: () => flowSlot.replaceChildren(),
          savedNext: (summary) =>
            caseId === null
              ? hint(`已在上面选上 **${summary.name}**。填完用例点「创建」后生效。`)
              : el("div", { class: "auth-pending" }, [
                  el("span", { text: `已在上面选上 ${summary.name}。还要保存用例，运行时才会带上它。` }),
                  el("button", { type: "button", class: "btn btn-sm btn-primary", text: "保存用例", onclick: () => void save() }),
                ]),
        }),
      );
    };
    openLoginFlow = (overwrite) => {
      const name = draft.authState ?? "";
      const known = authStates.find((item) => item.name === name);
      openFlow(
        overwrite && known !== undefined
          ? { name, url: known.loginUrl ?? draft.startUrl ?? "", overwrite: true }
          : { url: draft.startUrl ?? "" },
      );
      flowSlot.scrollIntoView({ behavior: "smooth", block: "center" });
    };

    select.addEventListener("change", () => {
      writePath(draft, "authState", select.value);
      refreshStatus();
      refreshSummary();
    });
    refreshAuthStatus = refreshStatus;
    const newButton = el("button", {
      type: "button",
      class: "btn btn-outline-secondary",
      text: "+ 新建",
      onclick: () => openFlow({ url: draft.startUrl ?? "" }),
    });

    fill();
    return el("div", { class: "mb-3" }, [
      el("label", { class: "d-block" }, [
        el("span", { class: "form-label", text: "登录态 authState" }),
        el("div", { class: "input-group" }, [select, newButton]),
      ]),
      status,
      flowSlot,
    ]);
  }

  function renderAssertions() {
    const rowsBox = el("div", { class: "recipe-rows" });
    const leftoverBox = el("div");
    const picker = el("select", { class: "form-select form-select-sm" });
    picker.dataset.picker = "recipe";

    const fillPicker = () => {
      const used = new Set(assertionRows(draft).filter((row) => row.recipe.single).map((row) => row.recipe.kind));
      picker.replaceChildren(
        ...RECIPES.filter((recipe) => !recipe.single || !used.has(recipe.kind)).map((recipe) =>
          el("option", { value: recipe.kind, text: recipe.sentence }),
        ),
      );
      picker.disabled = picker.children.length === 0;
    };

    const addButton = el("button", { type: "button", class: "btn btn-sm btn-outline-primary", text: "+ 添加断言" });
    addButton.addEventListener("click", () => {
      const recipe = RECIPE_BY_KIND.get(picker.value);
      if (recipe === undefined) return;
      if (recipe.single) {
        writePath(draft, recipe.where, recipe.statuses ? ["done"] : 0);
      } else {
        const list = readPath(draft, recipe.where) ?? [];
        list.push(recipe.item ? recipe.item() : "");
        writePath(draft, recipe.where, list);
      }
      renderRows();
      refreshSummary();
    });

    rowsBox.addEventListener("focusin", (event) => {
      rowsBox.querySelectorAll(".recipe-row").forEach((row) => row.classList.remove("is-focused"));
      event.target.closest(".recipe-row")?.classList.add("is-focused");
    });

    renderRows();

    assertionPanel.replaceChildren(
      hint("一条断言就是一句话。这里列出的顺序**就是报告里检查路径的顺序**——界面第一行对应报告里的 `[0]`。"),
      rowsBox,
      el("div", { class: "recipe-add" }, [picker, addButton]),
      leftoverBox,
    );

    function renderRows() {
      const rows = assertionRows(draft);
      setChildren(
        rowsBox,
        rows.length === 0
          ? hint("还没有断言。这次运行的 `passed` 会是**未判定**——既不是通过也不是失败。")
          : rows.map(recipeRow),
      );
      fillPicker();
      renderLeftovers();
    }

    function recipeRow(row) {
      const node = el("div", { class: `recipe-row recipe-row--${row.recipe.kind}` });
      node.append(el("span", { class: "recipe-sentence", text: row.recipe.sentence }));

      if (row.recipe.statuses) {
        node.append(enumPicker(row.recipe.where, RUN_STATUSES, { labels: STATUS_LABELS, onChange: renderRows }));
      } else if (row.recipe.numeric) {
        const input = el("input", { class: "form-control form-control-sm", type: "number", placeholder: row.recipe.value });
        input.value = row.value ?? "";
        input.dataset.path = row.path;
        input.addEventListener("input", () => {
          const parsed = Number(input.value.trim());
          writePath(draft, row.path, input.value.trim() !== "" && Number.isFinite(parsed) ? parsed : "");
          refreshSummary();
        });
        node.append(input);
      } else {
        const input = el("input", { class: "form-control form-control-sm", placeholder: row.recipe.value });
        input.value = row.value ?? "";
        input.dataset.path = row.path;
        input.addEventListener("input", () => {
          writePath(draft, row.path, input.value.trim());
          refreshSummary();
        });
        node.append(input);
      }

      node.append(
        el("button", {
          type: "button",
          class: "btn btn-sm btn-outline-danger",
          text: "×",
          "aria-label": `删除这条断言：${row.recipe.sentence}`,
          onclick: () => {
            // 删的是**整个数组元素**。下标前移之后下面每一行的 data-path 就旧了，
            // 所以这里必须重画（与「输入时不重画」并不矛盾：删除是离散动作，
            // 而重画之后所有输入框的值都会从草稿重新读出来）。
            if (row.recipe.single) {
              const keys = row.recipe.where.split(".");
              const parent = readPath(draft, keys.slice(0, -1).join("."));
              if (parent !== undefined) delete parent[keys[keys.length - 1]];
            } else {
              readPath(draft, row.recipe.where)?.splice(row.index, 1);
            }
            renderRows();
            refreshSummary();
          },
        }),
      );
      return node;
    }

    /** 配方之外的东西：有就列出来（默认展开），没有就一句话。 */
    function renderLeftovers() {
      const leftovers = rawLeftovers();
      const setFields = RAW_FIELDS.filter((field) => isRawSet(field, leftovers));
      const unsetFields = RAW_FIELDS.filter((field) => !isRawSet(field, leftovers));

      const body = setFields.map(rawField);
      // 概率类断言只在引擎给出真实分布时才能求值，否则会被标成「跳过」（D9）。
      // 这句话必须出现在**填它的地方**，而不是页尾的通用提示里。
      if (setFields.some((field) => field.path.includes("minTargetProbability"))) {
        body.push(hint(engineNoticeText(draft.engine ?? "")));
      }
      if (leftovers.rows.length > 0) {
        body.push(
          el("p", { class: "hint", text: "下面这些断言含配方表达不了的字段，因此整行按原始字段编辑：" }),
          ...leftovers.rows.map(rawRowEditor),
        );
      }
      if (unsetFields.length > 0) {
        const reveal = el("button", { type: "button", class: "btn btn-sm btn-outline-secondary", text: "+ 添加配方之外的断言字段" });
        const hidden = el("div", { class: "raw-hidden" });
        hidden.hidden = true;
        reveal.addEventListener("click", () => {
          hidden.replaceChildren(...unsetFields.map(rawField));
          hidden.hidden = false;
          reveal.remove();
        });
        body.push(reveal, hidden);
      }

      const open = setFields.length > 0 || leftovers.rows.length > 0;
      setChildren(leftoverBox, [
        el("h4", { text: "其他（配方之外的断言字段）" }),
        open || unsetFields.length > 0
          ? disclosure(
              open ? `这里还有 ${setFields.length + leftovers.rows.length} 处原始字段` : "配方之外的字段（未使用）",
              body,
              { open },
            )
          : null,
      ]);
    }

    function rawLeftovers() {
      const final = draft.assertions.final ?? {};
      const trajectory = draft.assertions.trajectory ?? {};
      const rows = [];
      [].concat(final.controls ?? []).forEach((row, index) => {
        const recipe = RECIPE_BY_KIND.get(row.exists === false ? "controls.absent" : "controls.exists");
        if (!recipeCovers(recipe, row) && rowHasContent(row)) {
          rows.push({ label: `final.controls[${index}]（原始）`, path: `assertions.final.controls.${index}`, columns: CONTROL_COLUMNS, row });
        }
      });
      for (const [key, where, columns] of [
        ["mustUse", "assertions.trajectory.mustUse", ACTION_COLUMNS],
        ["mustNotUse", "assertions.trajectory.mustNotUse", ACTION_COLUMNS],
      ]) {
        [].concat(trajectory[key] ?? []).forEach((row, index) => {
          if (!recipeCovers(RECIPE_BY_KIND.get(key), row) && rowHasContent(row)) {
            rows.push({ label: `${where}[${index}]（原始）`, path: `${where}.${index}`, columns, row });
          }
        });
      }
      return { rows };
    }

    function isRawSet(field) {
      const value = readPath(draft, field.path);
      if (value === undefined || value === null || value === "") return false;
      if (Array.isArray(value)) return value.length > 0;
      return true;
    }

    function rawField(field) {
      if (field.type === "kinds") {
        return el("div", { class: "mb-3" }, [
          el("span", { class: "form-label", text: field.label }),
          enumPicker(field.path, ACTION_KINDS),
        ]);
      }
      return draftField(field.path, field.label, {
        multiline: field.type === "lines",
        list: field.type === "lines",
        numeric: field.type === "number",
        rows: 2,
      });
    }
  }

  const BUDGET_KEYS = new Set(BUDGET_FIELDS.map(([key]) => key));

  function renderLimits() {
    const maxSteps = draftField("budget.maxSteps", "最多执行几步 maxSteps", {
      numeric: true,
      placeholder: "40",
      hintText: "任一维度超限即终止，status 为 budget_exceeded，且**已产生的轨迹会保留**供断言求值。",
    });
    const moreLimits = disclosure("更多限制", BUDGET_FIELDS.filter(([key]) => key !== "maxSteps").map(([key, label, placeholder]) =>
      draftField(`budget.${key}`, label, { numeric: true, placeholder }),
    ));

    const guardrailsBox = el("div", { class: "rows", "data-rows": "guardrails" });
    const renderGuardrails = () => {
      const rows = draft.guardrails;
      guardrailsBox.replaceChildren(
        ...[
          el("div", { class: "field-row field-head" }, [
            el("span", { text: "labelContains" }),
            el("span", { text: "labelMatches（正则）" }),
            el("span", { text: "role" }),
            el("span", { text: "reason（必填）" }),
            el("span", { class: "field-head-gap" }),
          ]),
          ...rows.map((row, index) => {
            const line = el("div", { class: "field-row" });
            for (const key of ["labelContains", "labelMatches", "role", "reason"]) {
              const input = el("input", { class: "form-control form-control-sm", placeholder: key, value: row[key] ?? "" });
              input.dataset.path = `guardrails.${index}.${key}`;
              input.addEventListener("input", () => {
                row[key] = input.value.trim();
                refreshSummary();
              });
              line.append(input);
            }
            line.append(
              el("button", {
                type: "button",
                class: "btn btn-sm btn-outline-danger",
                text: "×",
                "aria-label": `删除第 ${index + 1} 条护栏`,
                onclick: () => {
                  rows.splice(index, 1);
                  renderGuardrails();
                  refreshSummary();
                },
              }),
            );
            return line;
          }),
          el("button", {
            type: "button",
            class: "btn btn-sm btn-outline-secondary",
            text: "+ 添加护栏",
            onclick: () => {
              rows.push({});
              renderGuardrails();
              refreshSummary();
            },
          }),
          hint("内置集覆盖删除/支付/下单/密码框等，**只增不减**。命中时浏览器不会收到任何输入。"),
        ].filter(Boolean),
      );
    };
    renderGuardrails();

    const override = el("input", { class: "form-check-input", type: "checkbox", checked: draft.allowDefaultOverride });
    override.addEventListener("change", () => {
      draft.allowDefaultOverride = override.checked;
      refreshSummary();
    });

    limitsPanel.replaceChildren(
      maxSteps,
      moreLimits,
      el("h4", { text: "护栏 guardrails（追加在内置默认集之上）" }),
      guardrailsBox,
      disclosure("高级：停用内置护栏（危险）", [
        el("div", { class: "form-check" }, [
          override,
          el("label", { class: "form-check-label", text: "allowDefaultOverride（停用整套内置护栏）" }),
        ]),
        hint(
          "它是**整套停用**，不是「删掉其中几条」——内置的删除/支付/下单/密码框那批规则一起退出。"
          + "要让某一条仍然生效，得把它抄进上面的列表。"
          + "另外：按设计报告顶部应打红色横幅，但目前**没有落地**——"
          + "报告里没有任何字段记录这次运行停用过内置护栏。",
        ),
      ]),
    );
  }

  function renderPreview() {
    const payload = formToDefinition(draft);
    const body = revision === null ? payload : { ...payload, expectedRevision: revision };
    setChildren(previewPanel, [
      hint("这是**即将提交给服务端**的内容。磁盘上的 `case.yaml` 由服务端规范化后写入——**YAML 是唯一事实来源**，前端不自己拼一份出来，免得两边漂移。"),
      el("pre", { class: "payload mono", text: JSON.stringify(body, null, 2) }),
      caseId === null ? null : el("p", {}, [
        el("button", {
          type: "button",
          class: "btn btn-sm btn-outline-secondary",
          text: "导出已保存的 YAML",
          onclick: async () => {
            const yaml = await call(`/api/cases/${caseId}/export`);
            download(`${caseId}.yaml`, yaml);
          },
        }),
        el("span", { class: "hint", text: "导出的是**已保存**的版本，不含上面这些未保存的修改。" }),
      ]),
    ]);
  }

  // -------------------------------------------------------------------------
  // 保存、检测、脏标记
  // -------------------------------------------------------------------------

  function isDirty() {
    return signature(formToDefinition(draft)) !== baseline;
  }

  function refreshSummary() {
    const summary = draftSummary(draft);
    tabbar.setBadge("assertions", summary.assertions > 0 ? String(summary.assertions) : null);
    tabbar.setBadge("limits", summary.limits > 0 ? "•" : null);

    const dirty = isDirty();
    dirtyBadge.hidden = !dirty;
    // 新建用例时「有没有改」没有意义——本来就该点「创建」。
    saveButton.disabled = caseId !== null && !dirty;
    leaveGuard = dirty ? () => confirm("这个用例有未保存的修改，确定离开？") : null;

    const lines = presaveWarnings(draft);
    warnings.replaceChildren(
      ...lines.map((text) => el("div", { class: "alert alert-warning", role: "status", text })),
    );
  }

  /**
   * 把服务端回的 issue 路径落回具体控件上。
   *
   * 这是 `docs/api.md` 那句「前端据此高亮表单字段」的实现——路径写法两边同一套，
   * 所以不必维护第二张映射表。zod 有时会报一个不对应任何控件的路径
   * （跨字段 refine、联合类型），那时退回按前缀找最近的档，至少把用户带到对的地方。
   */
  function applyIssues(issues, box) {
    form.querySelectorAll(".is-invalid").forEach((node) => node.classList.remove("is-invalid"));
    form.querySelectorAll(".field-error").forEach((node) => node.remove());

    let firstTarget = null;
    for (const issue of issues) {
      const path = String(issue.path ?? "");
      const target = bestFieldFor(path);
      if (target === null) continue;
      target.classList.add("is-invalid");
      // 自己写 `.field-error` 而不用 Bootstrap 的 `.invalid-feedback`：后者靠
      // `.is-invalid ~ .invalid-feedback` 这个兄弟选择器显示，而我们的提示挂在
      // 包住输入框的 <label> 外面，兄弟关系不成立，会一直 display:none。
      const feedback = el("div", { class: "field-error", text: issue.message });
      (target.closest(".mb-3") ?? target.parentElement ?? target).append(feedback);
      firstTarget ??= target;
    }

    const key = tabForPath(String(issues.find((issue) => bestFieldFor(String(issue.path ?? "")) !== null)?.path ?? ""));
    tabbar.select(key);
    if (firstTarget !== null) {
      firstTarget.closest("details")?.setAttribute("open", "open");
      firstTarget.scrollIntoView({ block: "center" });
    }
    box?.scrollIntoView({ block: "nearest" });
  }

  /** 最长前缀匹配：`assertions.final.text.contains.0` 会命中挂这一条的输入框。 */
  function bestFieldFor(path) {
    let best = null;
    let bestLength = -1;
    if (path === "") return null;
    for (const node of form.querySelectorAll("[data-path]")) {
      const candidate = node.dataset.path;
      if (candidate === undefined) continue;
      if ((path === candidate || path.startsWith(`${candidate}.`)) && candidate.length > bestLength) {
        best = node;
        bestLength = candidate.length;
      }
    }
    return best;
  }

  /** 一个 issue 路径属于哪一档。找不准就退回「基本」——那里是必填项所在。 */
  function tabForPath(path) {
    if (path.startsWith("assertions")) return "assertions";
    if (path.startsWith("budget") || path.startsWith("guardrails") || path === "allowDefaultOverride") return "limits";
    return "basic";
  }

  async function save() {
    const definition = formToDefinition(draft);
    const body = revision === null ? definition : { ...definition, expectedRevision: revision };
    try {
      const result = await call("/api/cases", { method: "POST", body });
      leaveGuard = null;
      if (caseId === null) {
        location.hash = `#/case/${result.caseId}`;
        return;
      }
      revision = result.revision;
      versionNote.textContent = `当前版本 r${revision}`;
      savedAuthState = draft.authState ?? "";
      refreshAuthStatus?.();
      notices.replaceChildren();
      refreshSummary();
      notices.append(el("div", { class: "alert alert-success", role: "status", text: `已保存为 r${revision}。` }));
    } catch (error) {
      if (error.status === 409) {
        if (caseId === null) {
          // 新建时撞上已有 id：没有「别人改过的版本」可重新加载，换个 id 即可
          const box = errorBox(error);
          box.append(el("p", { class: "hint", text: "换一个 id，或清空 id 让服务端按标题生成。" }));
          notices.replaceChildren(box);
          return;
        }
        showConflict(error);
        return;
      }
      const box = errorBox(error);
      notices.replaceChildren(box);
      if (Array.isArray(error.detail)) applyIssues(error.detail, box);
    }
  }

  /** 乐观锁冲突：说清「别人改过」，并给一条出路。不做静默覆盖。 */
  function showConflict(error) {
    const box = errorBox(error);
    box.append(
      el("p", { class: "hint", text: "磁盘上的这个用例已经不是你打开时的版本了。重新加载会**丢弃当前未保存的修改**。" }),
      el("button", {
        class: "btn btn-sm btn-outline-danger",
        text: "重新加载最新版本",
        onclick: () => {
          leaveGuard = null;
          route();
        },
      }),
    );
    notices.replaceChildren(box);
    box.scrollIntoView({ block: "nearest" });
  }

  async function admit() {
    // 未保存的用例没有 id——原来这里会去请求 /api/cases/null/admit，
    // "null" 恰好是合法 id 的形状，于是报回来一句「用例不存在」，看不懂也无从修改。
    if (caseId === null) {
      notices.replaceChildren(errorBox(new Error("先保存这个用例，再用「检测页面」。检测要按用例里存的地址打开一次页面。")));
      return;
    }
    admitButton.disabled = true;
    try {
      const result = await call(`/api/cases/${caseId}/admit`, { method: "POST" });
      const box = admissionBox(result);
      if (result.redirectedTo) {
        // 被跳到登录页：给出能直接点的下一步，而不是只列一条阻断项
        box.append(
          el("button", {
            type: "button",
            class: "btn btn-sm btn-primary",
            text: draft.authState ? `重新登录 ${draft.authState}` : "配置登录态",
            onclick: () => {
              tabbar.select("basic");
              openLoginFlow?.(Boolean(draft.authState));
            },
          }),
        );
      }
      notices.replaceChildren(box);
    } catch (error) {
      notices.replaceChildren(errorBox(error));
    } finally {
      admitButton.disabled = false;
    }
  }

  renderBasic();
  renderAssertions();
  renderLimits();
  refreshSummary();
  tabbar.select("basic");
}

/** 「当前引擎的概率分布是不是真的」——它决定概率类检查是求值还是跳过。 */
function engineNoticeText(engineName) {
  const selected = engineCapability(engineName);
  if (engineName === "") {
    const fallback = engines[0];
    return fallback === undefined
      ? "未选择引擎，将用服务端默认引擎。minTargetProbability 依赖引擎给出真实概率分布。"
      : `未选择引擎，将用服务端默认引擎（首个已注册：${fallback.name}，概率分布 ${fallback.probabilities}）。`;
  }
  if (selected === null) return `引擎 ${engineName} 未注册。`;
  return selected.probabilities === "degenerate"
    ? `引擎 ${engineName} 的概率分布是 degenerate（单点分布）：概率类检查会被标为「跳过」而不是「通过」——单点分布下的比较会假通过。`
    : `引擎 ${engineName} 给出完整概率分布，概率类检查可求值。`;
}

const ACTION_COLUMNS = [
  ["labelContains", "labelContains"],
  ["labelMatches", "labelMatches"],
  ["role", "role"],
  ["kind", "kind"],
];

const CONTROL_COLUMNS = [
  ["labelContains", "labelContains（必填）"],
  ["role", "role"],
  ["exists", "exists（true/false）"],
  ["valueEquals", "valueEquals"],
  ["valueContains", "valueContains"],
  ["valueMatches", "valueMatches"],
  ["checked", "checked（true/false）"],
];

/**
 * 原始行编辑器：配方覆盖不到的数组行用这个。
 *
 * 与旧版的区别是**有了列头**：只有 placeholder 的输入框在敲下第一个字符之后
 * 就再也看不出哪一列是什么了。删除按钮也带上了 aria-label。
 */
function rawRowEditor({ label, path, columns, row }) {
  const head = el("div", { class: "field-row field-head" }, [
    ...columns.map(([, text]) => el("span", { text })),
    el("span", { class: "field-head-gap" }),
  ]);
  const line = el("div", { class: "field-row" });
  for (const [key, text] of columns) {
    const value = row[key];
    const input = ["exists", "checked"].includes(key)
      ? el("select", { class: "form-select form-select-sm" }, [
          el("option", { value: "", text: "（未设）" }),
          el("option", { value: "true", text: "true" }),
          el("option", { value: "false", text: "false" }),
        ])
      : el("input", { class: "form-control form-control-sm", placeholder: text.split("（")[0] });
    input.value = value === undefined || value === null ? "" : String(value);
    input.dataset.path = `${path}.${key}`;
    input.addEventListener("input", () => {
      row[key] = input.value === "" ? undefined : input.value;
    });
    line.append(input);
  }
  return el("div", { class: "raw-row" }, [
    el("div", { class: "raw-row-label mono", text: label }),
    head,
    line,
  ]);
}

function admissionBox(report) {
  const box = el("div", { class: report.ok ? "alert alert-warning" : "alert alert-danger" }, [
    el("strong", { text: report.ok ? "准入检查：可以测（有警告）" : "准入检查：不建议跑" }),
    hint("准入是记录与警告，不是运行的闸——blocking 项不阻止运行。"),
  ]);
  for (const line of report.blocking) box.append(el("p", { class: "blocking", text: `阻断：${line}` }));
  for (const line of report.warnings) box.append(el("p", { text: `警告：${line}` }));
  const stats = report.stats;
  box.append(
    el("p", {
      class: "hint",
      text: `frames=${stats.frames}（跨域 ${stats.crossOriginFrames}）・shadowRoot=${stats.shadowRoots}・canvas=${stats.canvases}・可交互元素=${stats.interactiveElements}`,
    }),
  );
  return box;
}

// ---------------------------------------------------------------------------
// 登录态：共用组件
// ---------------------------------------------------------------------------

/** 登录窗口状态的轮询间隔。人在另一个窗口里登录，1.5s 刷一次「当前停在哪」足够 */
const LOGIN_POLL_MS = 1500;

/** 最近一次验证的结论。没验证过是「未验证」——不能画成有效，也不能画成失效 */
function verifyBadge(lastVerified) {
  if (!lastVerified) return badge("undecided", "?", "未验证");
  return lastVerified.ok ? badge("passed", "✓", "看起来有效") : badge("failed", "✕", "已失效");
}

/** 覆盖站点：最多列三个，其余折成「等 N 个」 */
function sitesText(sites) {
  if (sites.length === 0) return "（无 cookie）";
  return sites.length <= 3 ? sites.join("、") : `${sites.slice(0, 3).join("、")} 等 ${sites.length} 个`;
}

/** 这份登录态有没有覆盖 `url` 的主机（cookie 域按后缀匹配：`.example.com` 覆盖 `a.example.com`） */
function authCovers(state, url) {
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
function rankCandidates(states, url) {
  const origin = originOf(url);
  const verdict = (state) => (state.lastVerified === null ? 1 : state.lastVerified.ok ? 0 : 2);
  return states
    .filter((state) => authCovers(state, url))
    .sort((a, b) =>
      verdict(a) - verdict(b)
      || Number(originOf(b.loginUrl ?? "") === origin) - Number(originOf(a.loginUrl ?? "") === origin)
      || String(b.savedAt).localeCompare(String(a.savedAt)));
}

/**
 * 把登录态写进一个**已保存**的用例并保存。带 expectedRevision：用例在别处被改过时照常 409，
 * 不静默覆盖。返回新的 revision。
 */
async function applyAuthStateToCase(caseId, name) {
  const loaded = await call(`/api/cases/${caseId}`);
  const result = await call("/api/cases", {
    method: "POST",
    body: { ...loaded.def, authState: name, expectedRevision: loaded.revision.revision },
  });
  return result.revision;
}

/**
 * 「把登录态用到某个用例」的按钮。点完原地变成结果 + 「重新运行」。
 * 登录态页（带着用例跳过来时）与结果页共用。
 */
function applyToCaseButton(caseId, caseTitle, name, label = `用到用例「${caseTitle || caseId}」并保存`) {
  const slot = el("span", { class: "apply-to-case" });
  const button = el("button", { type: "button", class: "btn btn-sm btn-primary", text: label });
  button.addEventListener("click", async () => {
    button.disabled = true;
    try {
      const revision = await applyAuthStateToCase(caseId, name);
      setChildren(slot, [
        el("span", { class: "hint", text: `用例已保存为 r${revision}，运行时会带上登录态 ${name}。` }),
        el("button", {
          type: "button",
          class: "btn btn-sm btn-outline-primary",
          text: "重新运行",
          onclick: () => runCaseAndOpen(caseId),
        }),
      ]);
    } catch (err) {
      button.disabled = false;
      slot.append(errorBox(err));
    }
  });
  slot.append(button);
  return slot;
}

/** 跑一个用例并跳到它的结果页 */
async function runCaseAndOpen(caseId) {
  const { runIds } = await call("/api/runs", { method: "POST", body: { caseIds: [caseId] } });
  location.hash = `#/run/${runIds[0]}`;
}

/**
 * 「运行」之前的检查：用例没选登录态、而**上一次运行**一打开就被跳去登录——
 * 照原样再跑一次只会以同样的方式失败，所以先问一句，并把能用的登录态摆出来。
 *
 * 只在这一种情况下拦：不需要登录的用例、已经选了登录态的用例、上次不是这样失败的，
 * 都直接跑，不多一次点击。返回 `null` 表示放行。
 * （实测：人在登录态页建好、验证好登录态，回到用例列表点「运行」，以为这就会带上——
 * 连续两次都是这样失败的。）
 */
async function loginPreflight(item, { onRun }) {
  if (item.authState !== null || item.lastRun?.status !== "guardrail_blocked") return null;
  const report = await call(`/api/runs/${item.lastRun.runId}`).catch(() => null);
  if (report === null || !looksLikeLoginRedirect(report)) return null;

  const states = await call("/api/auth-states").catch(() => []);
  const candidates = rankCandidates(states, item.startUrl);
  const title = item.title || item.id;
  const box = el("div", { class: "alert alert-warning login-preflight" }, [
    el("strong", { text: `「${title}」上次一打开就被跳去了登录页，而用例没有选登录态。` }),
    el("span", {
      text: candidates.length > 0
        ? " 登录态要在用例里选上并保存，运行才会带上——选一份再跑："
        : " 照原样再跑还会被拦下。先登录一次存成登录态，再用到这个用例上。",
    }),
  ]);
  const actions = el("div", { class: "login-flow-actions" });
  for (const state of candidates) {
    const button = el("button", { type: "button", class: "btn btn-sm btn-primary", text: `用 ${state.name} 并运行` });
    button.addEventListener("click", async () => {
      button.disabled = true;
      try {
        await applyAuthStateToCase(item.id, state.name);
        await runCaseAndOpen(item.id);
      } catch (err) {
        button.disabled = false;
        box.append(errorBox(err));
      }
    });
    actions.append(el("span", { class: "verify-line" }, [button, verifyBadge(state.lastVerified)]));
  }
  actions.append(
    el("a", {
      class: `btn btn-sm ${candidates.length > 0 ? "btn-outline-primary" : "btn-primary"}`,
      href: `#/auth?new=1&url=${encodeURIComponent(item.startUrl)}&case=${encodeURIComponent(item.id)}`,
      text: "新建登录态",
    }),
    el("button", { type: "button", class: "btn btn-sm btn-link", text: "仍然直接运行", onclick: onRun }),
  );
  box.append(actions);
  return box;
}

/**
 * 「新建 / 重新登录」的整个流程，登录态页与用例编辑器共用。
 *
 * 三个阶段画在同一块里，不跳页：
 *   填表  -> 弹窗等人登录（轮询窗口状态） -> 已保存（自动验证一次）
 * 在编辑器里不跳页尤其要紧：跳去别的页面会丢掉还没保存的用例草稿。
 *
 * 另有一条「上传 storageState」的兜底路径，给弹不出窗口的环境（Docker、远程 Linux）。
 *
 * `overwrite: true` 用于「重新登录」：名字锁定、覆盖已有文件。
 * `resume` 传入一个已经开着的窗口状态时，直接从「等人登录」阶段开始——
 * 人开了窗口又切走了页面，回来时不该看到一个空表单。
 */
function loginFlow({
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
  const box = el("div", { class: "card login-flow" });
  const body = el("div", { class: "card-body" });
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
  const closeButton = (text = "关闭") =>
    el("button", { type: "button", class: "btn btn-sm btn-link", text, onclick: close });

  // ---- 阶段 1：填表 ------------------------------------------------------
  function renderForm(error = null) {
    stopPolling();
    const nameInput = el("input", {
      class: "form-control mono",
      value: name || suggestAuthName(url),
      placeholder: "shop-test9-admin",
      readonly: overwrite,
    });
    const urlInput = el("input", { class: "form-control", type: "url", value: url, placeholder: "https://…" });
    const openButton = el("button", {
      type: "button",
      class: "btn btn-primary",
      text: overwrite ? "打开浏览器重新登录" : "打开浏览器登录",
    });
    const uploadLink = el("button", {
      type: "button",
      class: "btn btn-sm btn-link",
      text: "弹不出窗口？改为上传 storageState",
      onclick: () => renderUpload(nameInput.value.trim(), urlInput.value.trim()),
    });

    const submit = async (force) => {
      name = nameInput.value.trim();
      url = urlInput.value.trim();
      openButton.disabled = true;
      try {
        const status = await call("/api/auth-window", { method: "POST", body: { name, url, overwrite: overwrite || force } });
        renderWaiting(status);
      } catch (err) {
        openButton.disabled = false;
        if (err.status === 409 && err.detail?.exists) {
          // 名字撞了：问一句要不要覆盖，而不是让人自己想办法改名
          if (confirm(`登录态 ${name} 已存在。要重新登录并覆盖它吗？`)) await submit(true);
          return;
        }
        if (err.status === 409 && err.detail?.window) {
          renderBusy(err.detail.window);
          return;
        }
        renderForm(err);
      }
    };
    openButton.addEventListener("click", () => void submit(false));

    setChildren(body, [
      el("div", { class: "login-flow-head" }, [
        el("h3", { class: "h6 mb-0", text: overwrite ? `重新登录 ${name}` : "新建登录态" }),
        closeButton(),
      ]),
      error === null ? null : errorBox(error),
      el("div", { class: "row g-2" }, [
        el("label", { class: "col-md-4" }, [
          el("span", { class: "form-label", text: "名称" }),
          nameInput,
        ]),
        el("label", { class: "col-md-8" }, [
          el("span", { class: "form-label", text: "登录地址（打开后就是要登录的页面，通常填用例的起始地址）" }),
          urlInput,
        ]),
      ]),
      hint(
        overwrite
          ? "会在你的桌面上弹出一个浏览器窗口。在里面重新登录，回到这里点保存，旧的登录态会被替换。"
          : "名称用小写字母、数字和连字符，用例里按名称引用它；同一站点的不同账号请各建一份（如 **shop-admin**、**shop-viewer**）。",
      ),
      el("div", { class: "login-flow-actions" }, [openButton, overwrite ? null : uploadLink]),
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
    setChildren(body, [
      el("div", { class: "login-flow-head" }, [el("h3", { class: "h6 mb-0", text: "已有一个登录窗口开着" }), closeButton()]),
      hint(`登录态 **${status.name}** 的窗口还开着。同一时刻只开一个窗口，免得分不清哪个窗口对应哪一份。`),
      el("div", { class: "login-flow-actions" }, [
        el("button", {
          type: "button",
          class: "btn btn-outline-primary",
          text: `继续那一个（${status.name}）`,
          onclick: () => {
            name = status.name;
            url = status.url;
            renderWaiting(status);
          },
        }),
        el("button", {
          type: "button",
          class: "btn btn-outline-secondary",
          text: "关掉它，开我这个",
          onclick: async () => {
            await call("/api/auth-window/cancel", { method: "POST" });
            renderForm();
          },
        }),
      ]),
    ]);
  }

  // ---- 阶段 2：等人登录 --------------------------------------------------
  function renderWaiting(status) {
    const where = el("p", { class: "login-flow-where mono" });
    const saveButton = el("button", { type: "button", class: "btn btn-primary", text: "✓ 已登录，保存登录态" });
    const cancelButton = el("button", { type: "button", class: "btn btn-outline-secondary", text: "取消" });
    const errorSlot = el("div");

    const showWhere = (current) => {
      where.textContent = current.currentUrl ? `窗口当前页面：${current.currentUrl}` : "";
    };
    showWhere(status);

    saveButton.addEventListener("click", async () => {
      saveButton.disabled = true;
      cancelButton.disabled = true;
      try {
        const summary = await call("/api/auth-window/save", { method: "POST" });
        renderSaved(summary);
      } catch (err) {
        saveButton.disabled = false;
        cancelButton.disabled = false;
        errorSlot.replaceChildren(errorBox(err));
      }
    });
    cancelButton.addEventListener("click", async () => {
      stopPolling();
      await call("/api/auth-window/cancel", { method: "POST" }).catch(() => null);
      close();
    });

    setChildren(body, [
      el("div", { class: "login-flow-head" }, [
        el("h3", { class: "h6 mb-0", text: `正在登录 ${status.name}` }),
        el("span", { class: "login-flow-live", text: "等待你完成登录" }),
      ]),
      el("ol", { class: "login-flow-steps" }, [
        el("li", { text: "已在你的桌面上弹出一个浏览器窗口（没看到的话，看看是不是在别的窗口后面）。" }),
        el("li", { text: "在那个窗口里正常登录：账号密码、扫码、验证码都可以，登录几步都行。" }),
        el("li", { text: "看到登录后的页面了，回到这里点「保存」。窗口会自动关闭。" }),
      ]),
      where,
      errorSlot,
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
        // 一次轮询失败不打断流程：服务可能只是短暂不可达
      }
      pollTimer = setTimeout(poll, LOGIN_POLL_MS);
    };
    stopPolling();
    pollTimer = setTimeout(poll, LOGIN_POLL_MS);
  }

  function renderClosed(status) {
    stopPolling();
    setChildren(body, [
      el("div", { class: "login-flow-head" }, [el("h3", { class: "h6 mb-0", text: `登录 ${status.name} 没有完成` }), closeButton()]),
      el("p", { class: "blocking", text: status.closedReason ?? "登录窗口已关闭，登录态没有保存" }),
      el("div", { class: "login-flow-actions" }, [
        el("button", {
          type: "button",
          class: "btn btn-primary",
          text: "重新打开窗口",
          onclick: async () => {
            try {
              renderWaiting(await call("/api/auth-window", { method: "POST", body: { name: status.name, url: status.url, overwrite: true } }));
            } catch (err) {
              renderForm(err);
            }
          },
        }),
      ]),
    ]);
  }

  // ---- 阶段 3：已保存 ----------------------------------------------------
  function renderSaved(summary) {
    stopPolling();
    const verifySlot = el("div", { class: "login-flow-verify" }, [el("span", { class: "hint", text: "正在验证这份登录态……" })]);
    setChildren(body, [
      el("div", { class: "login-flow-head" }, [
        el("h3", { class: "h6 mb-0", text: `已保存登录态 ${summary.name}` }),
        closeButton("完成"),
      ]),
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
      .catch((err) => verifySlot.replaceChildren(errorBox(err)));
  }

  // ---- 兜底：上传 storageState -------------------------------------------
  function renderUpload(presetName, presetUrl) {
    stopPolling();
    const nameInput = el("input", { class: "form-control mono", value: presetName, placeholder: "shop-test9-admin" });
    const urlInput = el("input", { class: "form-control", type: "url", value: presetUrl, placeholder: "可选：用于验证" });
    const fileInput = el("input", { class: "form-control", type: "file", accept: ".json,application/json" });
    const textInput = el("textarea", { class: "form-control font-monospace", rows: 6, placeholder: '{ "cookies": [...], "origins": [...] }' });
    const errorSlot = el("div");
    const submitButton = el("button", { type: "button", class: "btn btn-primary", text: "上传" });

    fileInput.addEventListener("change", async () => {
      const file = fileInput.files?.[0];
      if (file) textInput.value = await file.text();
    });

    const submit = async (force) => {
      submitButton.disabled = true;
      try {
        const summary = await call("/api/auth-states", {
          method: "POST",
          body: { name: nameInput.value.trim(), state: textInput.value, loginUrl: urlInput.value.trim(), overwrite: force },
        });
        renderSaved(summary);
      } catch (err) {
        submitButton.disabled = false;
        if (err.status === 409 && err.detail?.exists) {
          if (confirm(`登录态 ${nameInput.value.trim()} 已存在。要用上传的内容覆盖它吗？`)) await submit(true);
          return;
        }
        errorSlot.replaceChildren(errorBox(err));
      }
    };
    submitButton.addEventListener("click", () => void submit(false));

    setChildren(body, [
      el("div", { class: "login-flow-head" }, [el("h3", { class: "h6 mb-0", text: "上传登录态" }), closeButton()]),
      hint(
        "给弹不出浏览器窗口的环境用。在一台有界面的机器上登录并导出 Playwright 的 storageState，" +
          "例如 **npx playwright codegen --save-storage=state.json <登录地址>**，登录后关掉窗口，再把 state.json 传上来。",
      ),
      errorSlot,
      el("div", { class: "row g-2" }, [
        el("label", { class: "col-md-4" }, [el("span", { class: "form-label", text: "名称" }), nameInput]),
        el("label", { class: "col-md-8" }, [el("span", { class: "form-label", text: "登录地址" }), urlInput]),
      ]),
      el("label", { class: "d-block mt-2" }, [el("span", { class: "form-label", text: "选文件，或直接粘贴 JSON" }), fileInput]),
      textInput,
      el("div", { class: "login-flow-actions" }, [
        submitButton,
        el("button", { type: "button", class: "btn btn-sm btn-link", text: "返回弹窗登录", onclick: () => renderForm() }),
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

// ---------------------------------------------------------------------------
// 视图：登录态
// ---------------------------------------------------------------------------

async function viewAuthStates(app, params) {
  const [states, openWindow, cases] = await Promise.all([
    call("/api/auth-states"),
    call("/api/auth-window"),
    call("/api/cases").catch(() => []),
  ]);
  const flowSlot = el("div");
  const listSlot = el("div");

  const refresh = async () => {
    renderList(await call("/api/auth-states"));
  };

  // 从某个用例的结果页跳过来的：存完之后直接给「用到这个用例」
  const forCase = params.get("case");
  const forCaseTitle = forCase ? await call(`/api/cases/${forCase}`).then((c) => c.def.title).catch(() => forCase) : null;

  const openFlow = (options) => {
    flowSlot.replaceChildren(
      loginFlow({
        ...options,
        onSaved: () => void refresh(),
        onClose: () => flowSlot.replaceChildren(),
        savedNext: forCase
          ? (summary) => applyToCaseButton(forCase, forCaseTitle, summary.name)
          : () => hint("接下来：打开要用它的用例，在「登录态」里选上它并**保存用例**。"),
      }),
    );
    flowSlot.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const newButton = el("button", {
    type: "button",
    class: "btn btn-primary",
    text: "+ 新建登录态",
    onclick: () => openFlow({ url: "" }),
  });

  app.replaceChildren(
    pageHead("登录态", [newButton]),
    hint(
      "目标页面需要登录时，在这里登录一次，把登录后的 cookie 存成一份「登录态」，再在用例里选上它。" +
        "**密码不经过模型，也不写进用例**；运行时只读载入，不会被改写。登录过期了就点「重新登录」。",
    ),
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
      listSlot.replaceChildren(
        emptyState({
          icon: ICON_KEY,
          title: "还没有登录态",
          children: [hint("被测页面不需要登录的话，用不到这一页。需要的话点右上角「新建登录态」。")],
        }),
      );
      return;
    }
    listSlot.replaceChildren(
      el("div", { class: "table-responsive" }, [
        el("table", { class: "table align-middle list-table auth-table" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "名称" }),
              el("th", { text: "覆盖站点" }),
              el("th", { text: "保存于" }),
              el("th", { text: "状态" }),
              el("th", { text: "引用用例" }),
              el("th", { text: "" }),
            ]),
          ]),
          el("tbody", {}, items.map(row)),
        ]),
      ]),
    );
  }

  /**
   * 站点对得上、却还没选任何登录态的用例：在这里就能用上。
   * 建好登录态的人下一步几乎总是「给那个用例用上」，不该让他再去编辑器里找下拉框。
   */
  function usableBy(item) {
    const targets = cases.filter((c) => c.authState === null && authCovers(item, c.startUrl));
    if (targets.length === 0) return null;
    return el("div", { class: "auth-usable" }, [
      el("div", { class: "hint", text: "可用于（还没选登录态的）：" }),
      ...targets.map((c) => el("div", {}, [applyToCaseButton(c.id, c.title, item.name, `用到「${c.title || c.id}」`)])),
    ]);
  }

  function row(item) {
    const statusCell = el("td");
    const renderStatus = (verified) => {
      setChildren(statusCell, [
        verifyBadge(verified),
        verified ? el("div", { class: "hint", text: `${verified.detail}（${relativeTime(verified.at)}）` }) : null,
      ]);
    };
    renderStatus(item.lastVerified);

    const verifyButton = el("button", { type: "button", class: "btn btn-sm btn-outline-secondary", text: "验证" });
    verifyButton.title = "用这份登录态无头打开登录地址，看是否还是登录状态。不调用模型。";
    verifyButton.disabled = item.loginUrl === null;
    verifyButton.addEventListener("click", async () => {
      verifyButton.disabled = true;
      verifyButton.textContent = "验证中…";
      try {
        renderStatus(await call(`/api/auth-states/${item.name}/verify`, { method: "POST", body: {} }));
      } catch (err) {
        statusCell.replaceChildren(errorBox(err));
      } finally {
        verifyButton.disabled = false;
        verifyButton.textContent = "验证";
      }
    });

    const deleteButton = el("button", { type: "button", class: "btn btn-sm btn-outline-danger", text: "删除" });
    deleteButton.addEventListener("click", async () => {
      const users = item.usedBy.map((use) => use.title || use.id).join("、");
      const question = item.usedBy.length > 0
        ? `登录态 ${item.name} 仍被 ${item.usedBy.length} 个用例引用（${users}），删除后它们会运行失败。仍要删除吗？`
        : `删除登录态 ${item.name}？`;
      if (!confirm(question)) return;
      try {
        await call(`/api/auth-states/${item.name}${item.usedBy.length > 0 ? "?force=1" : ""}`, { method: "DELETE" });
        await refresh();
      } catch (err) {
        flowSlot.replaceChildren(errorBox(err));
      }
    });

    return el("tr", {}, [
      el("td", {}, [
        el("div", { class: "mono", text: item.name }),
        el("div", { class: "hint", text: item.source === "import" ? "上传" : item.loginUrl ?? "" }),
      ]),
      el("td", { text: sitesText(item.sites) }),
      el("td", {}, [
        el("div", { text: relativeTime(item.savedAt) }),
        item.earliestExpiry
          ? el("div", {
              class: "hint",
              text: `最早的 cookie ${new Date(item.earliestExpiry).toLocaleString()} 过期`,
              title: "只是参考：站点未必靠这一个 cookie 判断登录。是否有效以「验证」为准。",
            })
          : null,
      ]),
      statusCell,
      el("td", {}, [
        ...(item.usedBy.length === 0
          ? [el("span", { class: "hint", text: "无" })]
          : item.usedBy.map((use) => el("div", {}, [el("a", { href: `#/case/${use.id}`, text: use.title || use.id })]))),
        usableBy(item),
      ]),
      el("td", {}, [
        el("div", { class: "auth-actions" }, [
          verifyButton,
          el("button", {
            type: "button",
            class: "btn btn-sm btn-outline-primary",
            text: "重新登录",
            onclick: () => openFlow({ name: item.name, url: item.loginUrl ?? "", overwrite: true }),
          }),
          deleteButton,
        ]),
      ]),
    ]);
  }
}

// ---------------------------------------------------------------------------
// 视图：运行历史
// ---------------------------------------------------------------------------

async function viewRuns(app) {
  const runs = await call("/api/runs");
  const shown = el("tbody");
  const footer = el("div", { class: "list-footer" });
  let limit = RUNS_PAGE;

  const renderRows = () => {
    shown.replaceChildren(...runs.slice(0, limit).map(runRow));
    if (runs.length <= limit) {
      footer.replaceChildren(el("span", { class: "hint", text: `共 ${runs.length} 次运行。` }));
      return;
    }
    footer.replaceChildren(
      el("button", {
        class: "btn btn-sm btn-outline-secondary",
        text: `显示更多（还有 ${runs.length - limit} 次）`,
        onclick: () => {
          limit += RUNS_PAGE;
          renderRows();
        },
      }),
    );
  };

  if (runs.length === 0) {
    app.replaceChildren(
      pageHead("运行历史"),
      emptyState({
        icon: ICON_RUNS,
        title: "还没有运行记录",
        children: [hint("去「用例」页点一次「运行」，结果就会出现在这里。")],
      }),
    );
    return;
  }

  app.replaceChildren(
    pageHead("运行历史"),
    el("div", { class: "table-responsive" }, [
      el("table", { class: "table table-hover align-middle list-table" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "判决" }),
            el("th", { text: "用例" }),
            el("th", { text: "这一次" }),
          ]),
        ]),
        shown,
      ]),
    ]),
    footer,
  );
  renderRows();

  function runRow(run) {
    const live = run.status === "running" || run.status === "queued";
    // status 与 passed 是两件事（D8），两个都留着；但正常结束是常态，
    // 所以 `done` 不在列表里重复一遍——**其余每一种结束方式都照写**，
    // 于是「次行没有 status」本身就等于「正常跑完了」。结果页顶部永远写着
    // status 的全称，真要看细节去那里。
    const meta = [
      relativeTime(run.startedAt),
      live || run.status === "done" ? null : statusLabel(run.status),
      `${run.steps} 步`,
      `${Math.round(run.elapsedMs / 1000)}s`,
      run.costUsd === null ? "成本未知" : `$${run.costUsd.toFixed(4)}`,
    ].filter(Boolean).join("・");

    return el("tr", {}, [
      el("td", {}, [
        el("a", { href: `#/run/${run.runId}`, class: "verdict" }, [verdictBadge(run.status, run.passed)]),
      ]),
      el("td", {}, [
        el("a", { class: "row-title", href: `#/run/${run.runId}`, text: run.caseTitle || run.caseId }),
        el("div", { class: "row-meta mono", text: run.runId }),
      ]),
      el("td", { class: "row-meta", text: meta }),
    ]);
  }
}

// ---------------------------------------------------------------------------
// 视图：运行结果（含实时进度）
// ---------------------------------------------------------------------------

let pollTimer = null;

async function viewRun(app, runId) {
  clearTimeout(pollTimer);
  let lastSeq = 0;
  let userChoseTab = false;

  const banner = el("div");
  const assertionBox = el("div");
  const stepTable = el("tbody");
  const eventList = el("ul", { class: "events" });

  const trajectoryPanel = el("div", { class: "table-responsive" }, [
    el("table", { class: "table table-sm table-hover align-middle" }, [
      el("thead", {}, [
        el("tr", {}, [
          el("th", { text: "#" }),
          el("th", { text: "动作" }),
          el("th", { text: "概率" }),
          el("th", { text: "执行" }),
          el("th", { text: "页面变化" }),
          el("th", { text: "耗时" }),
          el("th", { text: "画面" }),
        ]),
      ]),
      stepTable,
    ]),
  ]);

  const eventPanel = el("div", {}, [
    hint("每 500ms 按 seq 增量拉取；刷新页面会从 0 重新回放，因此不会丢历史。"),
    eventList,
  ]);

  const tabbar = tabs(
    [
      { key: "assertions", label: "断言", panel: assertionBox },
      { key: "trajectory", label: "轨迹", panel: trajectoryPanel },
      { key: "events", label: "事件日志", panel: eventPanel },
    ],
    (key, source) => {
      if (source === "user") userChoseTab = true;
      if (key === "events") eventList.scrollTop = eventList.scrollHeight;
    },
  );

  app.replaceChildren(
    crumbs([{ text: "运行历史", href: "#/runs" }, { text: runId }]),
    pageHead(el("h1", {}, [document.createTextNode("运行 "), el("span", { class: "mono", text: runId })])),
    banner,
    tabbar.node,
  );

  let report = null;
  let finished = false;
  let firstPoll = true;
  /** 连续多少次「没事件、没报告、从没见过任何事件」——那是一个不会再有进展的运行 */
  let emptyPolls = 0;

  // 视图已被 route() 换掉：`app` 是这张视图自己的容器，换掉后就脱离了文档。
  // 在途的请求回来之后必须就此停下——否则它会继续往脱离的 DOM 里写，
  // 还会把新视图的 pollTimer 覆盖掉，让旧运行在后台一直轮询下去。
  const gone = () => !app.isConnected;

  const poll = async () => {
    try {
      const events = await call(`/api/runs/${runId}/events?since=${lastSeq}`);
      if (gone()) return;
      for (const event of events) {
        lastSeq = Math.max(lastSeq, event.seq);
        appendEvent(eventList, event);
        if (event.type === "run.finished") finished = true;
      }
      // 报告要到运行结束、落盘之后才有：运行中每次都去拉只会得到 404。
      // 只在首次（可能是一次早已结束的运行）与收到 run.finished 时拉。
      if (firstPoll || finished) {
        report = await call(`/api/runs/${runId}`).catch(() => null);
        if (gone()) return;
      }
      firstPoll = false;
      if (report !== null) {
        banner.replaceChildren(reportHeader(report));
        stepTable.replaceChildren(...report.steps.map((step) => stepRow(step, report.runId)));
        assertionBox.replaceChildren();
        renderAssertions(assertionBox, report);
      }
      refreshEventPlaceholder(eventList, report);

      const live = !finished && (report === null || report.status === "queued" || report.status === "running");
      // 运行中默认看事件（此刻用户关心的是「在干什么」），结束后默认看断言
      // （此刻关心的是「结果是什么」）。用户自己点过之后就不再替他切换。
      if (!userChoseTab) tabbar.select(live ? "events" : "assertions");
      tabbar.setBadge("events", live ? "●" : null);

      emptyPolls = report === null && lastSeq === 0 ? emptyPolls + 1 : 0;
      if (emptyPolls >= MAX_EMPTY_POLLS) {
        // 没有报告、也从没收到过任何事件：id 不存在，或服务重启前还在排队的运行。
        // 它不会再有进展，继续轮询只是白白发请求。
        tabbar.setBadge("events", null);
        banner.replaceChildren(el("div", {
          class: "alert alert-warning",
          text: "找不到这个运行的报告或进度：id 可能不存在，或它在服务重启前还没跑完。已停止刷新。",
        }));
        return;
      }
      if (live) pollTimer = setTimeout(poll, POLL_MS);
    } catch (error) {
      if (gone()) return;
      pollTimer = setTimeout(poll, POLL_MS * 4);
      eventList.append(el("li", { class: "alert alert-danger", text: `拉取失败：${error.message}` }));
    }
  };
  await poll();
}

/**
 * 空事件框的说明。
 *
 * 事件日志是**进程内**的环形缓冲（见 web/events.ts），服务一重启，
 * 旧运行的事件就没了——翻一条历史记录时就会看到一个空框。
 * 说清楚为什么是空的，比让人以为界面坏了强。
 */
function refreshEventPlaceholder(list, report) {
  list.querySelector("li.events-placeholder")?.remove();
  if (list.children.length > 0) return;
  const live = report !== null && (report.status === "queued" || report.status === "running");
  list.append(
    el("li", {
      class: "ev events-placeholder",
      text: live
        ? "等待事件……"
        : "这次运行的事件已不在缓冲区（事件日志是进程内的，服务重启后清空）。轨迹与断言见上方。",
    }),
  );
}

/**
 * 第 0 步就因为域名白名单结束，且拦下的是一个 URL（不是某个动作）。
 * 白名单越界时护栏把当时的 URL 记在 `action` 里（见 core/agent.ts 的 originAllowed）。
 */
function looksLikeLoginRedirect(report) {
  if (report.status !== "guardrail_blocked" || report.steps.length !== 0) return false;
  const hit = report.guardrailHits[0];
  return hit !== undefined && hit.step === 0 && /^https?:\/\//.test(hit.action);
}

/**
 * 被跳到登录页之后，按**实际情况**给下一步，而不是一段泛泛的说明：
 *   - 这次运行用的用例版本带了登录态 -> 它多半过期了，重新登录；
 *   - 没带，但已经有登录态覆盖这个站点 -> 八成是建好了却没用到用例上，一键用上；
 *   - 一份都没有 -> 去新建（带着用例 id，建完直接用上）。
 * 第一条要看的是**这一次运行**带没带登录态，不是现在的用例（运行之后用例可能改过）。
 * 报告里没有单独的字段，但失败原因是 agent 按那次运行的用例写的
 * （core/guard.ts 的 loginRedirectHint：「用例已带登录态 X」），从那里读。
 */
async function loginGuide(report) {
  const [states, loaded] = await Promise.all([
    call("/api/auth-states").catch(() => []),
    call(`/api/cases/${report.caseId}`).catch(() => null),
  ]);
  const ran = /用例已带登录态 ([a-z0-9][a-z0-9-]*)/.exec(report.failureReason ?? "")?.[1];
  const current = loaded?.def.authState;
  const newLink = el("a", {
    class: "btn btn-sm btn-outline-primary",
    href: `#/auth?new=1&url=${encodeURIComponent(report.startUrl)}&case=${encodeURIComponent(report.caseId)}`,
    text: "新建登录态",
  });

  if (ran) {
    return [
      el("span", { text: ` 这次运行带着登录态 ${ran}，打开仍被跳走，多半是它过期了。` }),
      el("div", { class: "login-flow-actions" }, [
        el("a", { class: "btn btn-sm btn-primary", href: `#/auth?relogin=${encodeURIComponent(ran)}`, text: `重新登录 ${ran}` }),
      ]),
    ];
  }
  if (current && loaded !== null) {
    // 用例在这次运行之后已经配上了登录态：再跑一次就行
    return [
      el("span", { text: ` 这次运行时用例还没有登录态；它现在已经选上了 ${current}。` }),
      el("div", { class: "login-flow-actions" }, [
        el("button", {
          type: "button",
          class: "btn btn-sm btn-primary",
          text: "重新运行",
          onclick: () => runCaseAndOpen(report.caseId),
        }),
      ]),
    ];
  }
  const candidates = rankCandidates(states, report.startUrl);
  if (candidates.length > 0 && loaded !== null) {
    return [
      el("span", {
        text: ` 已经有覆盖这个站点的登录态，但用例没有选它——登录态要在用例里选上并保存，运行才会带上。`,
      }),
      el("div", { class: "auth-candidates" }, candidates.map((state) =>
        el("div", { class: "verify-line" }, [
          applyToCaseButton(report.caseId, loaded.def.title, state.name, `用 ${state.name} 并保存用例`),
          verifyBadge(state.lastVerified),
          el("span", { class: "hint", text: `登录于 ${state.loginUrl ?? "（上传）"}・${relativeTime(state.savedAt)}` }),
        ]),
      )),
      el("div", { class: "login-flow-actions" }, [newLink]),
    ];
  }
  return [
    el("span", { text: " 在弹出的浏览器里登录一次，存成登录态，再用到这个用例上。" }),
    el("div", { class: "login-flow-actions" }, [newLink]),
  ];
}

function reportHeader(report) {
  const stats = report.stats;
  const wrap = el("div", { class: `card verdict-card ${verdictClass(report.status, report.passed)}` });
  const body = el("div", { class: "card-body" }, [
    el("div", { class: "verdict-head" }, [
      verdictBadge(report.status, report.passed),
      el("h2", { class: "h5 mb-0", text: statusLabel(report.status) }),
    ]),
    hint("status 描述循环如何结束，passed 是断言判决。两者相互独立——done + failed 是正常组合。"),
  ]);
  body.append(
    statRow([
      [String(report.steps.length), "步数"],
      [String(stats.decisions), "决策"],
      [String(stats.modelCalls), "模型请求"],
      [`${stats.inputTokens} / ${stats.outputTokens}`, "tokens 入/出"],
      [`${Math.round(report.elapsedMs / 1000)}s`, "耗时"],
      [stats.costUsd === null ? "未知" : `$${stats.costUsd.toFixed(4)}`, "成本"],
    ]),
    el("p", {
      class: "verdict-meta",
      text: `引擎 ${report.engine}・用例 ${report.caseId}@r${report.caseRevision}`
        + `・决策引擎往返 ${Math.round(stats.engineLatencyMs / 1000)}s`
        + (stats.costUsd === null ? "・引擎未报金额" : ""),
    }),
  );
  if (report.failureReason) body.append(el("p", { class: "blocking", text: report.failureReason }));
  if (looksLikeLoginRedirect(report)) {
    // 一打开就被跳出白名单：多半要登录。把下一步做成按钮，而不是让人自己读懂那段原因
    const guide = el("div", { class: "alert alert-info login-redirect" }, [
      el("strong", { text: "看起来目标页要求登录。" }),
    ]);
    body.append(guide);
    void loginGuide(report).then((children) => guide.append(...children));
  }
  if (report.artifacts.traceZip) {
    body.append(
      el("p", {}, [
        el("a", { href: `/api/runs/${report.runId}/trace.zip`, text: "下载 trace.zip" }),
        el("span", { class: "hint", text: "（npx playwright show-trace 打开：时间轴 + 每步 DOM 快照）" }),
      ]),
    );
  }
  for (const hit of report.guardrailHits) {
    body.append(el("p", { class: "blocking", text: `护栏命中（第 ${hit.step} 步，${hit.action}）：${hit.reason}` }));
  }
  if (report.admission && (!report.admission.ok || report.admission.warnings.length > 0)) {
    const box = el("div", { class: "alert alert-warning" }, [
      el("strong", { text: report.admission.ok ? "准入检查有警告（不阻止运行）" : "准入检查有阻断项（不阻止运行）" }),
    ]);
    for (const line of report.admission.blocking) box.append(el("p", { class: "mb-0", text: `阻断：${line}` }));
    for (const line of report.admission.warnings) box.append(el("p", { class: "mb-0", text: `警告：${line}` }));
    body.append(box);
  }
  wrap.append(body);
  return wrap;
}

/**
 * 三层断言逐条渲染。
 *
 * **`skipped` 的呈现必须与 `passed` 明显不同**（D9）：把跳过画成通过就是谎报覆盖，
 * 比失败更危险——它让人以为测过了。
 */
function renderAssertions(container, report) {
  if (report.assertion === null) {
    container.append(hint("断言层未运行（例如预算在第一步之前就耗尽）——这与「失败」是两回事。"));
    return;
  }
  const checks = Object.entries(report.assertion.checks);
  if (checks.length === 0) {
    container.append(hint("用例没有声明任何断言，因此 passed 为未判定。"));
    return;
  }
  const failed = checks.filter(([, check]) => !check.skipped && !check.passed).length;

  const body = el("div", { class: "card-body" });
  if (failed > 0) {
    body.append(el("div", { class: "alert alert-danger", role: "status", text: `${failed} 条断言失败——失败的行走下面标出来了。` }));
  }
  body.append(
    el("div", { class: "table-responsive" }, [
      el("table", { class: "table table-sm table-hover align-middle" }, [
        el("thead", {}, [el("tr", {}, [el("th", { text: "检查项" }), el("th", { text: "结果" }), el("th", { text: "实际值" })])]),
        el("tbody", {},
          checks.map(([path, check]) =>
            el("tr", { class: check.skipped ? "" : check.passed ? "" : "row-failed" }, [
              el("td", { class: "path", text: path }),
              // 这里的三态顺序不能改：skipped 必须先判，否则「跳过」会掉进 passed 分支。
              el("td", {}, [
                check.skipped
                  ? badge("skipped", "⊘", "跳过")
                  : check.passed
                    ? badge("passed", "✓", "通过")
                    : badge("failed", "✕", "失败"),
              ]),
              el("td", { text: check.detail }),
            ]),
          ),
        ),
      ]),
    ]),
  );

  container.append(
    // 断言是判决的**证据**，所以它自成一张卡，而不是挂在判决卡末尾——
    // 那样标题会正好压在卡的下边框上。
    el("section", { class: "card mb-3" }, [
      el("div", { class: "card-header d-flex justify-content-between align-items-center" }, [
        el("span", { class: "fw-semibold", text: "断言" }),
        passedBadge(report.assertion.passed),
      ]),
      body,
    ]),
  );
}

function stepRow(step, runId) {
  const frameUrl = `/api/runs/${runId}/frames/${step.frame}.jpg`;
  return el("tr", {}, [
    el("td", { class: "mono", text: String(step.step) }),
    // 动作与 operation 合成一格：它们回答的是同一个问题（「这一步干了什么」），
    // 分成两列只会让表格更宽、更像一张数据搬运转储单。
    el("td", {}, [
      el("div", { text: step.action + (step.text ? ` → "${step.text}"` : "") }),
      el("div", { class: "row-meta mono", text: step.operation + (step.target ? ` · ${step.target}` : "") }),
    ]),
    el("td", {
      class: "mono",
      text: `${step.probability.toFixed(2)}${step.distribution === "degenerate" ? "（合成）" : ""}`,
    }),
    el("td", {}, [
      // executed=false 是**好结果**：护栏在浏览器收到任何输入之前拦下了它。
      // 但仍然用醒目色——对 CI 来说它是必须被看见的信号，不是可以忽略的噪音。
      el("div", { class: "stack" }, step.executed
        ? [badge("status", "", "已执行")]
        : [
            badge("failed", "⊘", "被拦下"),
            el("span", { class: "hint", text: step.blockReason ?? "未知原因" }),
          ]),
    ]),
    el("td", {}, [
      // pageChanged 为 null 不是「没变化」，而是「没能观测」（例如导航打断）。
      // 用中性药丸而不是普通文字，免得被读成「无」。
      step.pageChanged === null
        ? badge("undecided", "", "未观测")
        : el("span", { text: step.pageChanged ? "有" : "无" }),
    ]),
    // 两个延迟都是浮点毫秒，直接相加会渲染出 1534.9316999999999ms 这种东西。
    el("td", { class: "mono", text: `${Math.round(step.engineLatencyMs + step.textLatencyMs)}ms` }),
    // 事件里刻意不带截图 base64，画面按 `frame` 序号另外请求（见 web/api.ts §8.4）。
    // frames/ 默认关闭，所以 frame 为 null 是常态，不是异常。
    el("td", {}, [
      step.frame === null
        ? el("span", { class: "hint", text: "—" })
        : el("a", {
            class: "frame-link",
            href: frameUrl,
            target: "_blank",
            title: `帧 ${step.frame}（点击看原图）`,
          }, [
            el("img", { src: frameUrl, alt: `第 ${step.step} 步截图`, loading: "lazy" }),
          ]),
    ]),
  ]);
}

function appendEvent(list, event) {
  const line = el("li", { class: `ev ev-${event.type.replace(".", "-")}` });
  const time = new Date(event.ts).toLocaleTimeString();
  let text = `${time} `;
  switch (event.type) {
    case "run.queued": text += `已入队（用例 ${event.caseId}）`; break;
    case "run.started": text += `开始运行（引擎 ${event.engine}）`; break;
    case "step.observed": text += `第 ${event.step} 步：观测 ${event.elementCount} 个元素${event.omittedActions > 0 ? `（另有 ${event.omittedActions} 个被截断）` : ""}`; break;
    case "step.decided": text += `第 ${event.step} 步：决定 ${event.operation}${event.target ? ` → ${event.target}` : ""}（引擎 ${event.engineLatencyMs}ms，本次运行第 ${event.modelCallsUsed} 次请求）`; break;
    case "step.executed": text += `第 ${event.step} 步：${event.executed ? "执行" : "被拦下"} ${event.action}`; break;
    case "step.skipped": text += `第 ${event.step} 步：跳过（${event.reason}）`; break;
    case "guardrail.blocked": text += `第 ${event.step} 步：护栏拦截 ${event.action}——${event.reason}`; break;
    case "assertion.evaluated": text += `断言求值：${event.total} 条，失败 ${event.failed.length}，跳过 ${event.skipped.length}`; break;
    case "run.finished": text += `运行结束：${statusLabel(event.status)}／${passedLabel(event.passed)}`; break;
    case "run.log": text += `[${event.level}] ${event.message}`; break;
    default: text += event.type;
  }
  line.textContent = text;
  list.append(line);
  // 只保留最近若干条，避免长时间运行把 DOM 撑大。
  while (list.children.length > EVENT_NODES) list.firstElementChild.remove();
}

// ---------------------------------------------------------------------------
// 视图：导入 / 新建
// ---------------------------------------------------------------------------

function viewNew(app) {
  const textareaNode = el("textarea", {
    class: "form-control font-monospace",
    rows: 12,
    placeholder: "把 case.yaml 的内容粘在这里",
  });
  const fileNote = el("p", { class: "hint", text: "还没有选择文件。" });
  const fileInput = el("input", {
    type: "file",
    accept: ".yaml,.yml",
    class: "d-none",
    onchange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      textareaNode.value = await file.text();
      fileNote.textContent = `已读入 ${file.name}（${textareaNode.value.length} 字节）。`;
      refreshSizeNote();
    },
  });
  const sizeNote = el("p", { class: "hint" });
  const refreshSizeNote = () => {
    const bytes = textareaNode.value.length;
    // 服务端的请求体上限是 8192 字节（security.ts 的 MAX_BODY_BYTES）。
    // 现在这个限制只在超限时以 413 的形式暴露，提前说一句省一次困惑。
    sizeNote.textContent = bytes === 0
      ? "请求体上限 8192 字节；超了会被服务端以 413 拒绝。"
      : `当前 ${bytes} 字节${bytes > 8192 ? "——**超过 8192 字节上限**，会被服务端拒绝" : "（上限 8192 字节）"}。`;
  };
  textareaNode.addEventListener("input", refreshSizeNote);

  const card = el("div", { class: "card" });
  const dropZone = el("div", { class: "drop-zone" }, [
    el("p", { class: "mb-2", text: "把 .yaml 文件拖到这里" }),
    el("button", { type: "button", class: "btn btn-sm btn-outline-secondary", text: "选择文件…", onclick: () => fileInput.click() }),
    fileNote,
  ]);
  // 拖放：整张卡都是落点。dragover 必须 preventDefault，否则浏览器不会派发 drop。
  card.addEventListener("dragover", (event) => {
    event.preventDefault();
    dropZone.classList.add("is-dragging");
  });
  card.addEventListener("dragleave", () => dropZone.classList.remove("is-dragging"));
  card.addEventListener("drop", async (event) => {
    event.preventDefault();
    dropZone.classList.remove("is-dragging");
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    textareaNode.value = await file.text();
    fileNote.textContent = `已读入 ${file.name}（${textareaNode.value.length} 字节）。`;
    refreshSizeNote();
  });

  const importButton = el("button", { class: "btn btn-primary", text: "导入" });
  importButton.addEventListener("click", async () => {
    importButton.disabled = true;
    try {
      const revision = await call("/api/cases/import", { method: "POST", body: { yaml: textareaNode.value } });
      location.hash = `#/case/${revision.caseId}`;
    } catch (error) {
      card.prepend(errorBox(error));
    } finally {
      importButton.disabled = false;
    }
  });

  card.append(
    el("div", { class: "card-header fw-semibold", text: "粘贴或拖入 case.yaml" }),
    el("div", { class: "card-body" }, [
      hint("id 冲突时**追加 -2 而不是覆盖**既有用例——导入是「加一个」，静默覆盖属于数据丢失。"),
      dropZone,
      fileInput,
      el("div", { class: "mb-3" }, [textareaNode]),
      sizeNote,
      el("div", { class: "actions" }, [importButton]),
    ]),
  );

  // 两条路并列摆在最上面，而不是把「手工填写」塞在右下角当备选项。
  const choice = el("div", { class: "entry-choice" }, [
    el("div", { class: "entry-choice-item is-active" }, [
      el("div", { class: "fw-semibold", text: "粘贴 / 拖入 YAML" }),
      hint("已经有一份 case.yaml，或从别处导出的用例。"),
    ]),
    el("div", { class: "entry-choice-item" }, [
      el("div", { class: "fw-semibold", text: "手工填写" }),
      hint("只要标题、目标、起始地址三项就能建一个用例。"),
      el("button", {
        class: "btn btn-sm btn-outline-primary",
        text: "打开表单",
        onclick: () => {
          location.hash = "#/case-new-form";
        },
      }),
    ]),
  ]);

  app.replaceChildren(pageHead("导入用例"), choice, card);
  refreshSizeNote();
}

// ---------------------------------------------------------------------------
// 路由与状态
// ---------------------------------------------------------------------------

const STATUS_LABELS = {
  queued: "已入队",
  running: "运行中",
  done: "模型认为已完成",
  blocked: "无法继续 / 连续多步无进展",
  budget_exceeded: "超出预算已中止",
  guardrail_blocked: "被安全护栏拦截",
  cancelled: "已取消",
  error: "运行故障",
};

function statusLabel(status) {
  return STATUS_LABELS[status] ?? status;
}

function passedLabel(passed) {
  return passed === null ? "未判定" : passed ? "通过" : "失败";
}

/**
 * 结果卡的左侧色条档位。
 *
 * 这里**与 `passedBadge` 保持同一套档位**：`passed === null` 走 `undecided`，
 * 不能落回 `skipped`——否则会出现「药丸写着未判定（中性灰）、左侧色条却是
 * 跳过的琥珀色」这种自相矛盾的卡片，而 D8 的整个要点就是这两者不能混。
 */
function verdictClass(status, passed) {
  if (status === "running" || status === "queued") return "running";
  if (passed === true) return "passed";
  if (passed === false) return "failed";
  return "undecided";
}

function download(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/yaml" }));
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/** 加载骨架。比一行「加载中……」更像一个正在成形的页面。 */
function skeleton() {
  return el("div", { class: "skeleton", "aria-busy": "true" }, [el("span"), el("span"), el("span")]);
}

/** 顶栏当前页高亮。`#/case/<id>` 算「用例」那一档，`#/case-new-form` 算「导入」。 */
function setActiveNav(head) {
  const key =
    head === "" || head === "cases" || head === "case" ? "cases"
      : head === "runs" || head === "run" ? "runs"
        : head === "new" || head === "case-new-form" ? "new"
          : head === "auth" ? "auth"
            : null;
  for (const link of document.querySelectorAll("#nav a")) {
    if (link.dataset.nav === key) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

/**
 * 编辑器在「有未保存修改」时挂上的离开确认。route() 是唯一的离开通路。
 *
 * 用 `history.replaceState` 回退而不是 `location.hash =`：后者会**再触发一次
 * hashchange**，route() 重跑、视图重建，草稿与焦点全都冲掉——
 * 用户点了「留下」，结果东西没了，那比不问还糟。replaceState 不派发事件，
 * 当前这张视图原样留着。
 */
let leaveGuard = null;
let lastHash = location.hash;

async function route() {
  const root = document.getElementById("app");
  const target = location.hash;
  if (leaveGuard !== null && target !== lastHash && !leaveGuard()) {
    history.replaceState(null, "", lastHash);
    return;
  }
  // 守卫只对「当前挂着的那个视图」有效，换了视图就作废。
  leaveGuard = null;
  lastHash = target;

  // 每个视图渲染进**自己的**容器。上一张视图还在途的异步代码（轮询、慢请求）
  // 回来时写的是它自己那个已经脱离文档的容器，不会盖掉这一张——
  // 快速连点两个链接时，后返回的旧视图不再覆盖新视图。
  const slot = el("div", {}, [skeleton()]);
  root.replaceChildren(slot);
  const app = slot;
  clearTimeout(pollTimer);
  const hash = target.replace(/^#\/?/, "");
  // 查询串只给「带着意图跳转」用（如结果页 -> 登录态页并预填地址）。先切掉它，
  // 否则地址里的斜杠会被当成路径段。
  const [pathPart, query = ""] = hash.split("?");
  const [head, id] = pathPart.split("/");
  setActiveNav(head);

  try {
    await loadEngines();
    if (head === "" || head === "cases") await viewCases(app);
    else if (head === "case" && id) await viewCaseEditor(app, id);
    else if (head === "case-new-form") await viewCaseEditor(app, null);
    else if (head === "new") viewNew(app);
    else if (head === "runs") await viewRuns(app);
    else if (head === "run" && id) await viewRun(app, id);
    else if (head === "auth") await viewAuthStates(app, new URLSearchParams(query));
    else app.replaceChildren(pageHead("未知路由"), el("p", { text: `#/${hash}` }));
  } catch (error) {
    if (slot.isConnected) app.replaceChildren(pageHead("出错了"), errorBox(error));
  }
}

/** 队列状态放在顶栏：`contextsActive` 运行结束后必须回到 0，否则说明 context 泄漏了。 */
async function refreshQueue() {
  const node = document.getElementById("queue");
  try {
    const status = await call("/api/queue");
    node.textContent = `队列 ${status.queued}・在跑 ${status.active}・context ${status.contextsActive}`;
    // 状态点由 CSS 伪元素画，所以这里只挂 data-state。
    // 不能加子节点：textContent 每次轮询整体覆写，子节点留不住。
    node.dataset.state = status.contextsActive > 0 ? "busy" : "ok";
  } catch {
    node.textContent = "服务不可达";
    node.dataset.state = "down";
  }
}

window.addEventListener("hashchange", route);
await route();
await refreshQueue();
setInterval(refreshQueue, 2000);
