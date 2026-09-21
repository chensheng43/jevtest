/**
 * 前端入口。原生 ES module，不打包。
 *
 * 三条贯穿全文件的约定：
 *
 * 1. **所有动态文本走 `textContent`，不用 `innerHTML`。**
 *    用例内容（goal、label、断言文案）是用户写的文件内容，可能有尖括号；
 *    trace、事件、报告里的字符串同理。这个服务只监听 127.0.0.1，但「本地」
 *    不等于「安全」——同一个浏览器里的别的页面够得着它。
 *
 * 2. **进度用轮询**：`GET /api/runs/:id/events?since=<lastSeq>`，间隔 500ms。
 *    不用 SSE（理由见 src/web/events.ts）。把 `lastSeq` 存在变量里，
 *    刷新页面时从 0 重新拉，即可回放出全部历史。
 *
 * 3. **表单与 YAML 键 1:1 对应**，刻意不做 schema 驱动的表单生成器——
 *    schema 小而固定，生成器只会多一层间接。不漂移靠的是
 *    `tests/schema.test.ts` 的往返测试，而不是这里的「聪明」。
 */

const TOKEN = document.querySelector('meta[name="jevtest-token"]')?.content ?? "";
const TOKEN_HEADER = "x-jevtest-token";
const POLL_MS = 500;

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

/** 统一的请求封装：自动带令牌、统一错误处理、把 zod 的 issue 路径带出来。 */
async function call(path, options = {}) {
  const init = { method: options.method ?? "GET", headers: {} };
  if (init.method !== "GET") {
    init.headers[TOKEN_HEADER] = TOKEN;
    init.headers["content-type"] = "application/json";
  }
  if (options.body !== undefined) init.body = JSON.stringify(options.body);

  const response = await fetch(path, init);
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    const text = await response.text();
    if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`);
    return text;
  }
  const payload = await response.json();
  if (!response.ok) {
    const error = new Error(payload?.error ?? `请求失败（${response.status}）`);
    error.detail = payload?.detail;
    throw error;
  }
  return payload;
}

/** 把错误渲染成一块红字，并把 zod 的 issue 路径列出来（方便定位到字段）。 */
function errorBox(error) {
  const box = el("div", { class: "alert alert-danger" }, [el("strong", { text: "出错了：" }), error.message]);
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
          hint("可以用「导入用例」粘贴一个 case.yaml，或从命令行导入："),
          el("p", {}, [el("code", { text: "npm run dev -- import examples/wikipedia-search.yaml" })]),
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
      el("table", { class: "table table-sm table-hover align-middle" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "id" }),
            el("th", { text: "标题" }),
            el("th", { text: "版本" }),
            el("th", { text: "最近一次运行" }),
            el("th", { text: "操作" }),
          ]),
        ]),
        el("tbody", {}, cases.map(caseRow)),
      ]),
    ]),
  );

  function caseRow(item) {
    const runCell = item.lastRun
      ? el("a", { href: `#/run/${item.lastRun.runId}`, class: "verdict" }, [
          verdictBadge(item.lastRun.status, item.lastRun.passed),
          el("span", { class: "hint", text: statusLabel(item.lastRun.status) }),
        ])
      : el("span", { class: "hint", text: "从未运行" });

    return el("tr", {}, [
      el("td", { class: "mono" }, [el("a", { href: `#/case/${item.id}`, text: item.id })]),
      el("td", { text: item.title }),
      el("td", { class: "mono", text: `r${item.revision}` }),
      el("td", {}, [runCell]),
      el("td", {}, [
        el("button", {
          class: "btn btn-sm btn-outline-primary",
          text: "运行",
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              const { runIds } = await call("/api/runs", { method: "POST", body: { caseIds: [item.id] } });
              location.hash = `#/run/${runIds[0]}`;
            } catch (error) {
              notices.replaceChildren(errorBox(error));
              event.target.disabled = false;
            }
          },
        }),
        el("button", {
          class: "btn btn-sm btn-outline-danger",
          text: "删除",
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
    ]);
  }
}

// ---------------------------------------------------------------------------
// 视图：用例编辑
// ---------------------------------------------------------------------------

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

async function viewCaseEditor(app, caseId) {
  await loadEngines();
  let draft = emptyDraft();
  let revision = null;

  if (caseId !== null) {
    const loaded = await call(`/api/cases/${caseId}`);
    revision = loaded.revision.revision;
    draft = normalizeDraft(loaded.def);
  }

  const container = el("div");
  // 注意 replaceChildren 会把 null 变成字符串 "null"，所以先过滤。
  app.replaceChildren(
    ...[
      pageHead(caseId === null ? "新建用例" : `编辑 ${caseId}`),
      caseId === null ? null : hint(`当前版本 r${revision}`),
      container,
    ].filter(Boolean),
  );

  /** 引擎下拉与它的能力提示。两者在表单重建后要重新绑定，所以放在这一层持有。 */
  let engineInput = null;
  let engineNotice = null;

  renderForm();

  function renderForm() {
    const form = buildForm(draft);
    engineInput = form.querySelector('select[name="engine"]');
    engineNotice = form.querySelector(".engine-notice");
    engineInput?.addEventListener("change", updateEngineNotice);
    const actions = el("div", { class: "actions" }, [
      el("button", {
        class: "btn btn-primary",
        text: caseId === null ? "创建" : "保存",
        onclick: async () => {
          try {
            const definition = formToDefinition(form, draft);
            const body = revision === null ? definition : { ...definition, expectedRevision: revision };
            const result = await call("/api/cases", { method: "POST", body });
            location.hash = `#/case/${result.caseId}`;
          } catch (error) {
            form.prepend(errorBox(error));
          }
        },
      }),
      el("button", {
        class: "btn btn-outline-secondary",
        text: "检测页面",
        title: "只读地打开一次目标页面，检查本平台能不能测它。不调用模型。",
        onclick: async (event) => {
          event.target.disabled = true;
          try {
            const result = await call(`/api/cases/${caseId}/admit`, { method: "POST" });
            form.prepend(admissionBox(result));
          } catch (error) {
            form.prepend(errorBox(error));
          } finally {
            event.target.disabled = false;
          }
        },
      }),
    ]);
    if (caseId !== null) {
      actions.append(
        el("button", {
          class: "btn btn-outline-secondary",
          text: "导出 YAML",
          onclick: async () => {
            const yaml = await call(`/api/cases/${caseId}/export`);
            download(`${caseId}.yaml`, yaml);
          },
        }),
      );
    }
    form.append(actions);
    container.replaceChildren(form);
  }

  function buildForm(value) {
    const form = el("form", { class: "case-form", onsubmit: (event) => event.preventDefault() });

    // ---- 基本信息 ----
    form.append(
      section("基本信息", [
        field("title", "标题", textInput("title", value.title)),
        field("goal", "目标 goal", textarea("goal", value.goal), "唯一的行为指令。**断言不参与其中**——让 agent 看见判分标准会诱导它对着答案演戏。"),
        field("startUrl", "起始地址 startUrl", textInput("startUrl", value.startUrl)),
        field("mode", "模式 mode", select("mode", ["interactive", "readonly"], value.mode),
          "readonly 下变更型操作在动作空间**构造阶段**就被剔除，模型物理上无法选中。"),
        field("engine", "决策引擎 engine", select("engine", [""].concat(engines.map((e) => e.name)), value.engine),
          "留空则用服务端默认引擎。"),
        field("allowedOrigins", "域名白名单 allowedOrigins", textarea("allowedOrigins", value.allowedOrigins.join("\n")),
          "每行一个 origin。缺省由 startUrl 推导；越界即终止为 guardrail_blocked。"),
      ]),
    );

    // ---- 预算 ----
    form.append(
      section("预算 budget", [
        rowFields("budget", [
          ["maxSteps", "maxSteps", value.budget.maxSteps],
          ["maxModelCalls", "maxModelCalls", value.budget.maxModelCalls],
          ["maxInputTokens", "maxInputTokens", value.budget.maxInputTokens],
          ["maxCostUsd", "maxCostUsd（空=不限）", value.budget.maxCostUsd],
          ["maxElapsedMs", "maxElapsedMs", value.budget.maxElapsedMs],
        ]),
        hint("任一维度超限即终止，status 为 budget_exceeded，且**已产生的轨迹会保留**供断言求值。"),
      ]),
    );

    // ---- 护栏 ----
    form.append(
      section("护栏 guardrails（追加在内置默认集之上）", [
        rowsEditor("guardrails", value.guardrails, [
          ["labelContains", "labelContains"],
          ["labelMatches", "labelMatches"],
          ["role", "role"],
          ["reason", "reason（必填）"],
        ]),
        el("div", { class: "form-check" }, [
          el("input", {
            class: "form-check-input",
            type: "checkbox",
            name: "allowDefaultOverride",
            checked: value.allowDefaultOverride,
          }),
          el("label", {
            class: "form-check-label",
            text: "allowDefaultOverride（允许移除内置护栏，报告会打红色横幅）",
          }),
        ]),
        hint("内置集覆盖删除/支付/下单/密码框等，**只增不减**。命中时浏览器不会收到任何输入。"),
      ]),
    );

    // ---- 断言：final ----
    const final = value.assertions.final ?? {};
    form.append(
      section("断言 final（最终页面）", [
        textMatchEditor("finalUrl", "url", final.url),
        textMatchEditor("finalTitle", "title", final.title),
        textMatchEditor("finalText", "text", final.text),
        el("h4", { text: "controls" }),
        rowsEditor("controls", draft.assertions.final.controls, [
          ["labelContains", "labelContains（必填）"],
          ["role", "role"],
          ["exists", "exists（true/false）"],
          ["valueEquals", "valueEquals"],
          ["valueContains", "valueContains"],
          ["valueMatches", "valueMatches"],
          ["checked", "checked（true/false）"],
        ], "只能按可访问名定位，**没有选择器**——模型从头到尾看不到选择器。"),
      ]),
    );

    // ---- 断言：trajectory ----
    const trajectory = value.assertions.trajectory ?? {};
    form.append(
      section("断言 trajectory（动作轨迹）", [
        field("statusIn", "statusIn（每行一个）", textarea("statusIn", (trajectory.statusIn ?? []).join("\n")),
          "允许的结束方式，默认 done。"),
        field("maxSteps", "maxSteps", textInput("maxSteps", trajectory.maxSteps)),
        field("maxIdenticalConsecutive", "maxIdenticalConsecutive", textInput("maxIdenticalConsecutive", trajectory.maxIdenticalConsecutive)),
        field("forbiddenKinds", "forbiddenKinds（每行一个：click/fill/select/scroll/wait）", textarea("forbiddenKinds", (trajectory.forbiddenKinds ?? []).join("\n"))),
        el("h4", { text: "mustUse（必须出现过）" }),
        rowsEditor("mustUse", draft.assertions.trajectory.mustUse, actionMatchColumns),
        el("h4", { text: "mustNotUse（绝不能出现；同时也是运行时护栏）" }),
        rowsEditor("mustNotUse", draft.assertions.trajectory.mustNotUse, actionMatchColumns),
      ]),
    );

    // ---- 断言：quality ----
    const quality = value.assertions.quality ?? {};
    form.append(
      section("断言 quality（质量与成本）", [
        rowFields("quality", [
          ["minOperationProbability", "minOperationProbability", quality.minOperationProbability],
          ["minTargetProbability", "minTargetProbability", quality.minTargetProbability],
          ["maxModelCalls", "maxModelCalls", quality.maxModelCalls],
          ["maxElapsedMs", "maxElapsedMs", quality.maxElapsedMs],
          ["maxInputTokens", "maxInputTokens", quality.maxInputTokens],
          ["maxCostUsd", "maxCostUsd", quality.maxCostUsd],
        ]),
        probabilityNotice(),
      ]),
    );

    return form;
  }

  /**
   * 概率类断言在 degenerate 引擎下会变成「跳过」——表单里就说清楚，别让用户白等。
   *
   * 引擎下拉框在 `buildForm` 里创建、在本函数之后才被赋给 `engineInput`，
   * 因此这里**只生成提示元素**，事件绑定放在 `renderForm` 里统一做。
   */
  function probabilityNotice() {
    return hint(engineNoticeText(draft.engine), "engine-notice");
  }

  function updateEngineNotice() {
    if (engineNotice !== null) engineNotice.textContent = engineNoticeText(engineInput?.value ?? "");
  }
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

const actionMatchColumns = [
  ["labelContains", "labelContains"],
  ["labelMatches", "labelMatches"],
  ["role", "role"],
  ["kind", "kind"],
];

/** 一个可增删的行编辑器。行的增删改都直接写回草稿，避免重渲染时丢用户输入。 */
function rowsEditor(name, rows, columns, hintText) {
  const wrap = el("div", { class: "rows", "data-rows": name });
  const render = () => {
    // replaceChildren 会把 null 变成字符串 "null"——没有 hint 的行编辑器
    // 因此会凭空多出一个 "null" 文本节点。先过滤再展开。
    wrap.replaceChildren(
      ...[...rows.map((row, index) => {
        const line = el("div", { class: "field-row" });
        for (const [key, label] of columns) {
          const input = el("input", {
            class: "form-control form-control-sm",
            placeholder: label,
            value: row[key] ?? "",
            oninput: (event) => {
              rows[index][key] = event.target.value;
            },
          });
          line.append(input);
        }
        line.append(
          el("button", {
            type: "button",
            class: "btn btn-sm btn-outline-danger",
            text: "×",
            onclick: () => {
              rows.splice(index, 1);
              render();
            },
          }),
        );
        return line;
      }),
      el("button", {
        type: "button",
        class: "btn btn-sm btn-outline-secondary",
        text: `+ 增一行 ${name}`,
        onclick: () => {
          rows.push({});
          render();
        },
      }),
      hintText ? hint(hintText) : null,
      ].filter(Boolean),
    );
  };
  render();
  return wrap;
}

function textMatchEditor(name, label, match) {
  const value = match ?? {};
  return el("div", { class: "text-match" }, [
    el("h4", { text: label }),
    el("div", { class: "field-row" }, [
      el("input", { class: "form-control form-control-sm", name: `${name}.equals`, placeholder: "equals", value: value.equals ?? "" }),
      el("input", { class: "form-control form-control-sm", name: `${name}.contains`, placeholder: "contains（每行一条）", value: (value.contains ?? []).join("\n") }),
      el("input", { class: "form-control form-control-sm", name: `${name}.notContains`, placeholder: "notContains（每行一条）", value: (value.notContains ?? []).join("\n") }),
      el("input", { class: "form-control form-control-sm", name: `${name}.matches`, placeholder: "matches 正则（每行一条）", value: (value.matches ?? []).join("\n") }),
    ]),
  ]);
}

function rowFields(name, fields) {
  return el("div", { class: "field-grid" },
    fields.map(([key, label, value]) =>
      el("input", { class: "form-control form-control-sm", name: `${name}.${key}`, placeholder: label, value: value ?? "" }),
    ),
  );
}

function section(title, children) {
  return el("section", { class: "card mb-3" }, [
    el("div", { class: "card-header fw-semibold", text: title }),
    // el() 只有三个参数，children 必须是**一个数组**——不能 spread 进去。
    el("div", { class: "card-body" }, [].concat(children).filter(Boolean)),
  ]);
}

// 参数名用 hintText 而不是 hint：后者是本文件里的展示组件函数，会被参数遮蔽。
function field(name, label, input, hintText) {
  input.setAttribute("name", name);
  return el("div", { class: "mb-3" }, [
    labelWrap(input, label),
    hintText ? hint(hintText) : null,
  ]);
}

/**
 * 标签与控件。控件**嵌在 label 里**（点标签即聚焦，也是更好的可访问性），
 * 所以 label 必须显式 d-block：Bootstrap 的 reboot 把 label 设成了
 * `display: inline-block`，那样它会缩到内容宽度，里面 `width: 100%` 的
 * 输入框就只能拿到两百来像素。
 */
function labelWrap(input, text) {
  return el("label", { class: "d-block" }, [
    el("span", { class: "form-label", text }),
    input,
  ]);
}

function textInput(name, value) {
  return el("input", { type: "text", class: "form-control", name, value: value ?? "" });
}

function textarea(name, value) {
  const node = el("textarea", { class: "form-control font-monospace", name, rows: 3 });
  node.value = value ?? "";
  return node;
}

function select(name, options, value) {
  const node = el("select", { class: "form-select", name });
  for (const option of options) {
    const item = el("option", { value: option, text: option || "(默认)" });
    if (option === (value ?? "")) item.selected = true;
    node.append(item);
  }
  return node;
}

/** 服务端只认识 `Case`/`CaseDefinition`；这里把表单读成「只含用户设了的字段」的对象。 */
function formToDefinition(form, draft) {
  const value = (name) => form.elements[name]?.value?.trim() ?? "";
  const number = (name) => {
    const raw = value(name);
    if (raw === "") return undefined;
    const parsed = Number(raw);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  const list = (name) =>
    value(name).split("\n").map((line) => line.trim()).filter((line) => line !== "");

  const definition = {
    title: value("title"),
    goal: value("goal"),
    startUrl: value("startUrl"),
  };
  if (draft.id) definition.id = draft.id;
  if (value("mode") && value("mode") !== "interactive") definition.mode = value("mode");
  if (value("engine")) definition.engine = value("engine");
  const origins = list("allowedOrigins");
  if (origins.length > 0) definition.allowedOrigins = origins;

  const budget = {};
  for (const key of ["maxSteps", "maxModelCalls", "maxInputTokens", "maxCostUsd", "maxElapsedMs"]) {
    const parsed = number(`budget.${key}`);
    if (parsed !== undefined) budget[key] = parsed;
  }
  if (Object.keys(budget).length > 0) definition.budget = budget;

  const guardrails = draft.guardrails
    .map((row) => ({
      ...(row.labelContains ? { labelContains: row.labelContains } : {}),
      ...(row.labelMatches ? { labelMatches: row.labelMatches } : {}),
      ...(row.role ? { role: row.role } : {}),
      reason: row.reason ?? "",
    }))
    .filter((row) => row.reason !== "");
  if (guardrails.length > 0) definition.guardrails = guardrails;
  if (form.elements["allowDefaultOverride"]?.checked) definition.allowDefaultOverride = true;

  const assertions = {};
  const final = {
    ...textMatchFrom(form, "finalUrl", "url"),
    ...textMatchFrom(form, "finalTitle", "title"),
    ...textMatchFrom(form, "finalText", "text"),
  };
  const controls = draft.assertions.final?.controls ?? [];
  if (controls.length > 0) final.controls = controls.map(coerceControl);
  if (Object.keys(final).length > 0) assertions.final = final;

  const trajectory = {};
  const statusIn = list("statusIn");
  if (statusIn.length > 0) trajectory.statusIn = statusIn;
  for (const key of ["maxSteps", "maxIdenticalConsecutive"]) {
    const parsed = number(key);
    if (parsed !== undefined) trajectory[key] = parsed;
  }
  const forbidden = list("forbiddenKinds");
  if (forbidden.length > 0) trajectory.forbiddenKinds = forbidden;
  const mustUse = (draft.assertions.trajectory?.mustUse ?? []).map(coerceActionMatch).filter(hasField);
  if (mustUse.length > 0) trajectory.mustUse = mustUse;
  const mustNotUse = (draft.assertions.trajectory?.mustNotUse ?? []).map(coerceActionMatch).filter(hasField);
  if (mustNotUse.length > 0) trajectory.mustNotUse = mustNotUse;
  if (Object.keys(trajectory).length > 0) assertions.trajectory = trajectory;

  const quality = {};
  for (const key of [
    "minOperationProbability",
    "minTargetProbability",
    "maxModelCalls",
    "maxElapsedMs",
    "maxInputTokens",
    "maxCostUsd",
  ]) {
    const parsed = number(`quality.${key}`);
    if (parsed !== undefined) quality[key] = parsed;
  }
  if (Object.keys(quality).length > 0) assertions.quality = quality;

  if (Object.keys(assertions).length > 0) definition.assertions = assertions;
  return definition;
}

function textMatchFrom(form, name, key) {
  const value = (suffix) => form.elements[`${name}.${suffix}`]?.value?.trim() ?? "";
  const match = {};
  if (value("equals") !== "") match.equals = value("equals");
  for (const suffix of ["contains", "notContains", "matches"]) {
    const items = value(suffix).split("\n").map((line) => line.trim()).filter((line) => line !== "");
    if (items.length > 0) match[suffix] = items;
  }
  return Object.keys(match).length === 0 ? {} : { [key]: match };
}

/** 表单里一切都是字符串，落盘前要还原成 schema 的类型（布尔、数字）。 */
function coerceControl(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) {
    if (value === undefined || value === "") continue;
    if (key === "exists" || key === "checked") out[key] = value === "true" || value === true;
    else out[key] = value;
  }
  return out;
}

function coerceActionMatch(row) {
  const out = {};
  for (const [key, value] of Object.entries(row)) if (value !== undefined && value !== "") out[key] = value;
  return out;
}

function hasField(row) {
  return Object.keys(row).length > 0;
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
// 视图：运行历史
// ---------------------------------------------------------------------------

async function viewRuns(app) {
  const runs = await call("/api/runs");

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
      el("table", { class: "table table-sm table-hover align-middle" }, [
        el("thead", {}, [
          el("tr", {}, [
            el("th", { text: "开始时间" }),
            el("th", { text: "用例" }),
            el("th", { text: "status" }),
            el("th", { text: "passed" }),
            el("th", { text: "步数" }),
            el("th", { text: "耗时" }),
            el("th", { text: "成本" }),
          ]),
        ]),
        el("tbody", {},
          runs.map((run) =>
            el("tr", {}, [
              el("td", { class: "mono" }, [
                el("a", { href: `#/run/${run.runId}`, text: new Date(run.startedAt).toLocaleString() }),
              ]),
              el("td", { text: run.caseTitle || run.caseId }),
              el("td", {}, [badge("status", "", statusLabel(run.status))]),
              el("td", {}, [verdictBadge(run.status, run.passed)]),
              el("td", { class: "mono", text: String(run.steps) }),
              el("td", { class: "mono", text: `${Math.round(run.elapsedMs / 1000)}s` }),
              el("td", { class: "mono", text: run.costUsd === null ? "未知" : `$${run.costUsd.toFixed(4)}` }),
            ]),
          ),
        ),
      ]),
    ]),
  );
}

// ---------------------------------------------------------------------------
// 视图：运行结果（含实时进度）
// ---------------------------------------------------------------------------

let pollTimer = null;

async function viewRun(app, runId) {
  clearTimeout(pollTimer);
  let lastSeq = 0;
  const stepTable = el("tbody");
  const eventList = el("ul", { class: "events" });
  const banner = el("div");

  const container = el("div", {}, [
    banner,
    el("div", { class: "live" }, [
      el("h2", { text: "实时进度" }),
      hint("每 500ms 按 seq 增量拉取；刷新页面会从 0 重新回放，因此不会丢历史。"),
      eventList,
      el("h2", { text: "轨迹" }),
      el("div", { class: "table-responsive" }, [
        el("table", { class: "table table-sm table-hover align-middle" }, [
          el("thead", {}, [
            el("tr", {}, [
              el("th", { text: "#" }),
              el("th", { text: "动作" }),
              el("th", { text: "operation" }),
              el("th", { text: "概率" }),
              el("th", { text: "执行" }),
              el("th", { text: "页面变化" }),
              el("th", { text: "耗时" }),
              el("th", { text: "画面" }),
            ]),
          ]),
          stepTable,
        ]),
      ]),
    ]),
  ]);
  app.replaceChildren(
    pageHead(el("h1", {}, [document.createTextNode("运行 "), el("span", { class: "mono", text: runId })])),
    container,
  );

  const poll = async () => {
    try {
      const events = await call(`/api/runs/${runId}/events?since=${lastSeq}`);
      for (const event of events) {
        lastSeq = Math.max(lastSeq, event.seq);
        appendEvent(eventList, event);
      }
      const report = await call(`/api/runs/${runId}`).catch(() => null);
      if (report !== null) {
        banner.replaceChildren(reportHeader(report));
        stepTable.replaceChildren(...report.steps.map((step) => stepRow(step, report.runId)));
        renderAssertions(banner, report);
      }
      refreshEventPlaceholder(eventList, report);
      if (report === null || report.status === "queued" || report.status === "running") {
        pollTimer = setTimeout(poll, POLL_MS);
      }
    } catch (error) {
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
        : "这次运行的事件已不在缓冲区（事件日志是进程内的，服务重启后清空）。轨迹与断言见下方。",
    }),
  );
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
  if (report.admission && !report.admission.ok) {
    const box = el("div", { class: "alert alert-warning" }, [
      el("strong", { text: "准入检查有阻断项（不阻止运行）" }),
    ]);
    for (const line of report.admission.blocking) box.append(el("p", { class: "mb-0", text: line }));
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
  container.append(
    // 断言是判决的**证据**，所以它自成一张卡，而不是挂在判决卡末尾——
    // 那样标题会正好压在卡的下边框上。
    el("section", { class: "card mb-3" }, [
      el("div", { class: "card-header d-flex justify-content-between align-items-center" }, [
        el("span", { class: "fw-semibold", text: "断言" }),
        passedBadge(report.assertion.passed),
      ]),
      el("div", { class: "card-body" }, [
        el("div", { class: "table-responsive" }, [
          el("table", { class: "table table-sm table-hover align-middle" }, [
            el("thead", {}, [el("tr", {}, [el("th", { text: "检查项" }), el("th", { text: "结果" }), el("th", { text: "实际值" })])]),
            el("tbody", {},
              checks.map(([path, check]) =>
                el("tr", {}, [
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
      ]),
    ]),
  );
}

function stepRow(step, runId) {
  const frameUrl = `/api/runs/${runId}/frames/${step.frame}.jpg`;
  return el("tr", {}, [
    el("td", { class: "mono", text: String(step.step) }),
    el("td", { text: step.action + (step.text ? ` → "${step.text}"` : "") }),
    el("td", { class: "mono", text: step.operation }),
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
  // 只保留最近 400 条，避免长时间运行把 DOM 撑大。
  while (list.children.length > 400) list.firstElementChild.remove();
}

// ---------------------------------------------------------------------------
// 视图：导入 / 新建
// ---------------------------------------------------------------------------

function viewNew(app) {
  const textareaNode = el("textarea", {
    class: "form-control font-monospace",
    rows: 14,
    placeholder: "把 case.yaml 的内容粘在这里",
  });
  const nameInput = el("input", {
    class: "form-control",
    type: "text",
    placeholder: "选择文件…",
    readonly: true,
  });
  const fileInput = el("input", {
    class: "form-control",
    type: "file",
    accept: ".yaml,.yml",
    onchange: async (event) => {
      const file = event.target.files?.[0];
      if (!file) return;
      textareaNode.value = await file.text();
      nameInput.value = file.name;
    },
  });
  const form = el("div", { class: "card" }, [
    el("div", { class: "card-header fw-semibold", text: "导入 case.yaml" }),
    el("div", { class: "card-body" }, [
      hint("id 冲突时**追加 -2 而不是覆盖**既有用例——导入是「加一个」，静默覆盖属于数据丢失。"),
      el("div", { class: "mb-3" }, [labelWrap(fileInput, "选择文件")]),
      el("div", { class: "mb-3" }, [labelWrap(nameInput, "文件名")]),
      el("div", { class: "mb-3" }, [labelWrap(textareaNode, "内容")]),
      el("div", { class: "actions" }, [
        el("button", {
          class: "btn btn-primary",
          text: "导入",
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              const revision = await call("/api/cases/import", { method: "POST", body: { yaml: textareaNode.value } });
              location.hash = `#/case/${revision.caseId}`;
            } catch (error) {
              form.prepend(errorBox(error));
            } finally {
              event.target.disabled = false;
            }
          },
        }),
        el("button", {
          class: "btn btn-outline-secondary",
          text: "改为手工填写",
          onclick: () => {
            location.hash = "#/case-new-form";
          },
        }),
      ]),
    ]),
  ]);
  app.replaceChildren(pageHead("导入用例"), form);
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
          : null;
  for (const link of document.querySelectorAll("#nav a")) {
    if (link.dataset.nav === key) link.setAttribute("aria-current", "page");
    else link.removeAttribute("aria-current");
  }
}

async function route() {
  const app = document.getElementById("app");
  app.replaceChildren(skeleton());
  clearTimeout(pollTimer);
  const hash = location.hash.replace(/^#\/?/, "");
  const [head, id] = hash.split("/");
  setActiveNav(head);

  try {
    await loadEngines();
    if (head === "" || head === "cases") await viewCases(app);
    else if (head === "case" && id) await viewCaseEditor(app, id);
    else if (head === "case-new-form") await viewCaseEditor(app, null);
    else if (head === "new") viewNew(app);
    else if (head === "runs") await viewRuns(app);
    else if (head === "run" && id) await viewRun(app, id);
    else app.replaceChildren(pageHead("未知路由"), el("p", { text: `#/${hash}` }));
  } catch (error) {
    app.replaceChildren(pageHead("出错了"), errorBox(error));
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
