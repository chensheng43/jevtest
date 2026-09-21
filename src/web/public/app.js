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
  const box = el("div", { class: "error" }, [el("strong", { text: "出错了：" }), error.message]);
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
// 视图：用例列表
// ---------------------------------------------------------------------------

async function viewCases(app) {
  const cases = await call("/api/cases");
  app.replaceChildren(
    el("h1", { text: "用例" }),
    cases.length === 0
      ? el("p", { class: "hint", text: "还没有用例。可以用「新建用例」，或从文件导入：" },
          [el("code", { text: "npm run dev -- import examples/wikipedia-search.yaml" })])
      : el("table", { class: "grid" }, [
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
  );

  function caseRow(item) {
    const runCell = item.lastRun
      ? el("a", {
          href: `#/run/${item.lastRun.runId}`,
          text: `${statusLabel(item.lastRun.status)}・${passedLabel(item.lastRun.passed)}`,
          class: `verdict ${verdictClass(item.lastRun.status, item.lastRun.passed)}`,
        })
      : el("span", { class: "hint", text: "从未运行" });

    return el("tr", {}, [
      el("td", {}, [el("a", { href: `#/case/${item.id}`, text: item.id })]),
      el("td", { text: item.title }),
      el("td", { text: `r${item.revision}` }),
      el("td", {}, [runCell]),
      el("td", {}, [
        el("button", {
          text: "运行",
          onclick: async (event) => {
            event.target.disabled = true;
            try {
              const { runIds } = await call("/api/runs", { method: "POST", body: { caseIds: [item.id] } });
              location.hash = `#/run/${runIds[0]}`;
            } catch (error) {
              app.prepend(errorBox(error));
              event.target.disabled = false;
            }
          },
        }),
        el("button", {
          class: "danger",
          text: "删除",
          onclick: async () => {
            if (!confirm(`删除用例 ${item.id}？该操作不做撤销。`)) return;
            try {
              await call(`/api/cases/${item.id}`, { method: "DELETE" });
              await viewCases(app);
            } catch (error) {
              app.prepend(errorBox(error));
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
  app.replaceChildren(
    el("h1", { text: caseId === null ? "新建用例" : `编辑 ${caseId}` }),
    caseId === null ? el("p") : el("p", { class: "hint", text: `当前版本 r${revision}` }),
    container,
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
        class: "primary",
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
        el("p", { class: "hint", text: "任一维度超限即终止，status 为 budget_exceeded，且**已产生的轨迹会保留**供断言求值。" }),
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
        labelWrap(
          el("input", { type: "checkbox", name: "allowDefaultOverride", checked: value.allowDefaultOverride }),
          "allowDefaultOverride（允许移除内置护栏，报告会打红色横幅）",
        ),
        el("p", { class: "hint", text: "内置集覆盖删除/支付/下单/密码框等，**只增不减**。命中时浏览器不会收到任何输入。" }),
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
    return el("p", { class: "hint engine-notice", text: engineNoticeText(draft.engine) });
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
function rowsEditor(name, rows, columns, hint) {
  const wrap = el("div", { class: "rows", "data-rows": name });
  const render = () => {
    wrap.replaceChildren(
      ...rows.map((row, index) => {
        const line = el("div", { class: "row" });
        for (const [key, label] of columns) {
          const input = el("input", {
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
            class: "danger small",
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
        class: "small",
        text: `+ 增一行 ${name}`,
        onclick: () => {
          rows.push({});
          render();
        },
      }),
      hint ? el("p", { class: "hint", text: hint }) : null,
    );
  };
  render();
  return wrap;
}

function textMatchEditor(name, label, match) {
  const value = match ?? {};
  return el("div", { class: "text-match" }, [
    el("h4", { text: label }),
    el("div", { class: "row" }, [
      el("input", { name: `${name}.equals`, placeholder: "equals", value: value.equals ?? "" }),
      el("input", { name: `${name}.contains`, placeholder: "contains（每行一条）", value: (value.contains ?? []).join("\n") }),
      el("input", { name: `${name}.notContains`, placeholder: "notContains（每行一条）", value: (value.notContains ?? []).join("\n") }),
      el("input", { name: `${name}.matches`, placeholder: "matches 正则（每行一条）", value: (value.matches ?? []).join("\n") }),
    ]),
  ]);
}

function rowFields(name, fields) {
  return el("div", { class: "row" },
    fields.map(([key, label, value]) =>
      el("input", { name: `${name}.${key}`, placeholder: label, value: value ?? "" }),
    ),
  );
}

function section(title, children) {
  return el("section", { class: "card" }, [el("h2", { text: title }), ...[].concat(children).filter(Boolean)]);
}

function field(name, label, input, hint) {
  input.setAttribute("name", name);
  return el("div", { class: "field" }, [
    labelWrap(input, label),
    hint ? el("p", { class: "hint", text: hint }) : null,
  ]);
}

function labelWrap(input, text) {
  return el("label", {}, [el("span", { text }), input]);
}

function textInput(name, value) {
  return el("input", { type: "text", name, value: value ?? "" });
}

function textarea(name, value) {
  const node = el("textarea", { name, rows: 3 });
  node.value = value ?? "";
  return node;
}

function select(name, options, value) {
  const node = el("select", { name });
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
  const box = el("div", { class: report.ok ? "note" : "error" }, [
    el("strong", { text: report.ok ? "准入检查：可以测（有警告）" : "准入检查：不建议跑" }),
    el("p", { class: "hint", text: "准入是记录与警告，不是运行的闸——blocking 项不阻止运行。" }),
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
  app.replaceChildren(
    el("h1", { text: "运行历史" }),
    runs.length === 0
      ? el("p", { class: "hint", text: "还没有运行记录。" })
      : el("table", { class: "grid" }, [
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
                el("td", {}, [el("a", { href: `#/run/${run.runId}`, text: new Date(run.startedAt).toLocaleString() })]),
                el("td", { text: run.caseTitle || run.caseId }),
                el("td", { text: statusLabel(run.status) }),
                el("td", { class: verdictClass(run.status, run.passed), text: passedLabel(run.passed) }),
                el("td", { text: String(run.steps) }),
                el("td", { text: `${Math.round(run.elapsedMs / 1000)}s` }),
                el("td", { text: run.costUsd === null ? "未知" : `$${run.costUsd.toFixed(4)}` }),
              ]),
            ),
          ),
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
      el("p", { class: "hint", text: "每 500ms 按 seq 增量拉取；刷新页面会从 0 重新回放，因此不会丢历史。" }),
      eventList,
      el("h2", { text: "轨迹" }),
      el("table", { class: "grid" }, [
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
  ]);
  app.replaceChildren(el("h1", { text: `运行 ${runId}` }), container);

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
      if (report === null || report.status === "queued" || report.status === "running") {
        pollTimer = setTimeout(poll, POLL_MS);
      }
    } catch (error) {
      pollTimer = setTimeout(poll, POLL_MS * 4);
      eventList.append(el("li", { class: "error", text: `拉取失败：${error.message}` }));
    }
  };
  await poll();
}

function reportHeader(report) {
  const wrap = el("div", { class: `card verdict-card ${verdictClass(report.status, report.passed)}` });
  wrap.append(
    el("h2", { text: `${statusLabel(report.status)}｜断言：${passedLabel(report.passed)}` }),
    el("p", { class: "hint", text: "status 描述循环如何结束，passed 是断言判决。两者相互独立——done + failed 是正常组合。" }),
    el("p", {
      text: `引擎 ${report.engine}・用例 ${report.caseId}@r${report.caseRevision}・${report.steps.length} 步・`
        + `${report.stats.modelCalls} 次请求 / ${report.stats.decisions} 次决策・`
        + `${Math.round(report.elapsedMs / 1000)}s・`
        + `成本 ${report.stats.costUsd === null ? "未知（引擎未报金额）" : `$${report.stats.costUsd.toFixed(4)}`}`,
    }),
  );
  if (report.failureReason) wrap.append(el("p", { class: "blocking", text: report.failureReason }));
  if (report.artifacts.traceZip) {
    wrap.append(
      el("p", {}, [
        el("a", { href: `/api/runs/${report.runId}/trace.zip`, text: "下载 trace.zip" }),
        el("span", { class: "hint", text: "（npx playwright show-trace 打开：时间轴 + 每步 DOM 快照）" }),
      ]),
    );
  }
  for (const hit of report.guardrailHits) {
    wrap.append(el("p", { class: "blocking", text: `护栏命中（第 ${hit.step} 步，${hit.action}）：${hit.reason}` }));
  }
  if (report.admission && !report.admission.ok) {
    const box = el("div", { class: "note" }, [el("strong", { text: "准入检查有阻断项（不阻止运行）" })]);
    for (const line of report.admission.blocking) box.append(el("p", { text: line }));
    wrap.append(box);
  }
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
    container.append(el("p", { class: "hint", text: "断言层未运行（例如预算在第一步之前就耗尽）——这与「失败」是两回事。" }));
    return;
  }
  const checks = Object.entries(report.assertion.checks);
  if (checks.length === 0) {
    container.append(el("p", { class: "hint", text: "用例没有声明任何断言，因此 passed 为未判定。" }));
    return;
  }
  const table = el("table", { class: "grid" }, [
    el("thead", {}, [el("tr", {}, [el("th", { text: "检查项" }), el("th", { text: "结果" }), el("th", { text: "实际值" })])]),
    el("tbody", {},
      checks.map(([path, check]) =>
        el("tr", {}, [
          el("td", { class: "path", text: path }),
          el("td", {
            class: check.skipped ? "skipped" : check.passed ? "passed" : "failed",
            text: check.skipped ? "跳过" : check.passed ? "通过" : "失败",
          }),
          el("td", { text: check.detail }),
        ]),
      ),
    ),
  ]);
  container.append(el("h2", { text: `断言（${report.assertion.passed === null ? "未判定" : report.assertion.passed ? "通过" : "失败"}）` }), table);
}

function stepRow(step, runId) {
  return el("tr", {}, [
    el("td", { text: String(step.step) }),
    el("td", { text: step.action + (step.text ? ` → "${step.text}"` : "") }),
    el("td", { text: step.operation }),
    el("td", {
      text: `${step.probability.toFixed(2)}${step.distribution === "degenerate" ? "（合成）" : ""}`,
    }),
    el("td", {
      class: step.executed ? "" : "failed",
      // executed=false 是**好结果**：护栏在浏览器收到任何输入之前拦下了它。
      text: step.executed ? "已执行" : `被拦下：${step.blockReason ?? "未知原因"}`,
    }),
    el("td", {
      // pageChanged 为 null 不是「没变化」，而是「没能观测」（例如导航打断）。
      text: step.pageChanged === null ? "未观测" : step.pageChanged ? "有" : "无",
    }),
    el("td", { text: `${step.engineLatencyMs + step.textLatencyMs}ms` }),
    // 事件里刻意不带截图 base64，画面按 `frame` 序号另外请求（见 web/api.ts §8.4）。
    el("td", {}, [
      step.frame === null
        ? el("span", { class: "hint", text: "—" })
        : el("a", { href: `/api/runs/${runId}/frames/${step.frame}.jpg`, target: "_blank", text: `帧 ${step.frame}` }),
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
  const textareaNode = el("textarea", { rows: 14, placeholder: "把 case.yaml 的内容粘在这里" });
  const nameInput = el("input", { type: "text", placeholder: "选择文件…", readonly: true });
  const fileInput = el("input", {
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
    el("h1", { text: "导入用例" }),
    el("p", { class: "hint", text: "id 冲突时**追加 -2 而不是覆盖**既有用例——导入是「加一个」，静默覆盖属于数据丢失。" }),
    fileInput,
    nameInput,
    textareaNode,
    el("div", { class: "actions" }, [
      el("button", {
        class: "primary",
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
        text: "改为手工填写",
        onclick: () => {
          location.hash = "#/case-new-form";
        },
      }),
    ]),
  ]);
  app.replaceChildren(form);
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

function verdictClass(status, passed) {
  if (status === "running" || status === "queued") return "running";
  if (passed === true) return "passed";
  if (passed === false) return "failed";
  return "skipped";
}

function download(filename, content) {
  const url = URL.createObjectURL(new Blob([content], { type: "text/yaml" }));
  const link = el("a", { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

async function route() {
  const app = document.getElementById("app");
  app.replaceChildren(el("p", { class: "hint", text: "加载中……" }));
  clearTimeout(pollTimer);
  const hash = location.hash.replace(/^#\/?/, "");
  const [head, id] = hash.split("/");

  try {
    await loadEngines();
    if (head === "" || head === "cases") await viewCases(app);
    else if (head === "case" && id) await viewCaseEditor(app, id);
    else if (head === "case-new-form") await viewCaseEditor(app, null);
    else if (head === "new") viewNew(app);
    else if (head === "runs") await viewRuns(app);
    else if (head === "run" && id) await viewRun(app, id);
    else app.replaceChildren(el("p", { text: `未知路由 #/${hash}` }));
  } catch (error) {
    app.replaceChildren(el("h1", { text: "出错了" }), errorBox(error));
  }
}

/** 队列状态放在顶栏：`contextsActive` 运行结束后必须回到 0，否则说明 context 泄漏了。 */
async function refreshQueue() {
  try {
    const status = await call("/api/queue");
    document.getElementById("queue").textContent =
      `队列 ${status.queued}・在跑 ${status.active}・context ${status.contextsActive}`;
  } catch {
    document.getElementById("queue").textContent = "服务不可达";
  }
}

window.addEventListener("hashchange", route);
await route();
await refreshQueue();
setInterval(refreshQueue, 2000);
