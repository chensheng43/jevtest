/**
 * 用例编辑器。
 *
 * 一页三节（基本 / 断言 / 预算与护栏），左边是吸顶的节目录，底部是吸顶的操作栏。
 * 不再用标签页：标签页会把出错的字段藏在另一档里，而用户只看到一句「保存失败」。
 *
 * 草稿（`draft`）是唯一事实来源：控件在 input/change 时写回草稿、刷新摘要，**绝不重渲染**
 * ——否则每敲一个字符都会丢焦点。只有增删行这类离散动作才重画那一小块。
 */

import { el, button, hint, icon, rich, setChildren } from "../lib/dom.js";
import { call, listEngines, loadEngines, runCaseAndOpen } from "../lib/api.js";
import {
  ACTION_COLUMNS, ACTION_KINDS, ACTION_KIND_LABELS, ASSERTION_GROUPS, BUDGET_FIELDS, CONTROL_COLUMNS, GUARDRAIL_COLUMNS,
  RAW_FIELDS, RECIPES, RECIPE_BY_KIND, assertionRows, cleanStrings, draftSummary, emptyDraft, formToDefinition,
  issueMessage, normalizeDraft, originOf, presaveWarnings, readPath, recipeCovers, rowHasContent, sectionForPath, signature, writePath,
} from "../lib/core.js";
import { RUN_STATUSES, STATUS_LABELS, sitesText } from "../lib/runs.js";
import { relativeTime } from "../lib/format.js";
import { onLeave, reload, setLeaveGuard } from "../lib/router.js";
import { busy, callout, confirmDialog, errorSlot, toast } from "../ui/feedback.js";
import { disclosure, field, pageHead, section, verifyBadge } from "../ui/widgets.js";
import { loginFlow } from "../components/login.js";

const SECTIONS = [
  { key: "basic", label: "基本" },
  { key: "assertions", label: "断言" },
  { key: "limits", label: "预算与护栏" },
];

export async function viewCaseEditor(app, caseId) {
  await loadEngines();
  const engines = listEngines();

  let loaded = caseId === null ? null : await call(`/api/cases/${caseId}`);
  const draft = loaded === null ? emptyDraft() : normalizeDraft(loaded.def);
  // 登录态列表只是下拉框的选项。读不到不该让编辑器打不开——退化成空列表，用例里写的值照样保留
  let authStates = await call("/api/auth-states").catch(() => []);
  /** 磁盘上这个用例现在用的登录态。与草稿不同 = 选了但还没保存，运行不会带上它 */
  let savedAuthState = loaded?.def.authState ?? "";
  let revision = loaded === null ? null : loaded.revision.revision;
  let baseline = signature(formToDefinition(draft));
  /** 用户点「添加」加进来、但还没填值的原始字段：没有值就不会被 isRawSet 认出来，得另外记着 */
  const revealedRaw = new Set();
  let refreshAuthStatus = () => {};
  let openLoginFlow = () => {};
  let saving = false;

  const notices = errorSlot();
  const warnings = el("div", { class: "form-warnings" });

  // ---- 骨架 ---------------------------------------------------------------
  const sections = {
    basic: el("div"),
    assertions: el("div"),
    limits: el("div"),
  };
  const navCounts = new Map();
  const nav = el("nav", { class: "editor-nav", "aria-label": "用例的几个部分" }, SECTIONS.map((item) => {
    const counter = el("span", { class: "nav-count", hidden: true });
    navCounts.set(item.key, counter);
    return el("button", {
      type: "button",
      class: "editor-nav-link",
      "data-section": item.key,
      onclick: () => document.getElementById(`sec-${item.key}`)?.scrollIntoView({ behavior: "smooth", block: "start" }),
    }, [el("span", { text: item.label }), counter]);
  }));

  const form = el("form", { class: "editor-form", novalidate: true, onsubmit: (event) => event.preventDefault() }, [
    section({ id: "sec-basic", title: "基本", note: "测什么、从哪开始。带 * 的是必填项。", children: [sections.basic] }),
    section({ id: "sec-assertions", title: "断言", note: "怎样才算通过。一条断言就是一句话；列出的顺序就是报告里检查项的顺序。", children: [sections.assertions] }),
    section({ id: "sec-limits", title: "预算与护栏", note: "什么时候必须停下，什么绝对不能点。", children: [sections.limits] }),
  ]);

  const drawer = el("aside", { class: "drawer", hidden: true, "aria-label": "保存内容" });
  const saveButton = button(caseId === null ? "创建" : "保存", { kind: "primary", size: "", title: "⌘S / Ctrl+S" });
  const saveRunButton = button(caseId === null ? "创建并运行" : "保存并运行", { kind: "outline-primary", size: "", iconName: "play" });
  const admitButton = button("检测页面", { kind: "outline-secondary", size: "", title: "只读地打开一次已保存的用例所指的页面，检查本平台能不能测它。不调用模型。" });
  admitButton.disabled = caseId === null;
  const dirtyBadge = el("span", { class: "dirty-badge", hidden: true, text: "有未保存的修改" });
  const drawerButton = button("查看 YAML", { kind: "ghost", size: "", iconName: "file" });

  saveButton.addEventListener("click", () => void save(saveButton, false));
  saveRunButton.addEventListener("click", () => void save(saveRunButton, true));
  admitButton.addEventListener("click", () => void admit());
  drawerButton.addEventListener("click", () => toggleDrawer());

  const actionBar = el("div", { class: "action-bar" }, [
    el("div", { class: "action-bar-main" }, [saveButton, saveRunButton, dirtyBadge]),
    el("div", { class: "action-bar-aside" }, [
      caseId === null ? el("span", { class: "hint-inline", text: "保存后才能检测页面" }) : null,
      admitButton,
      drawerButton,
    ]),
  ]);

  const title = caseId === null ? "新建用例" : draft.title || caseId;
  app.replaceChildren(
    pageHead(title, {
      trail: [{ text: "用例", href: "#/cases" }, { text: caseId === null ? "新建" : caseId }],
      meta: caseId === null
        ? [el("span", { text: "保存后会得到一个由标题推导的 id" })]
        : [el("span", { class: "mono", text: caseId }), versionNote()],
      actions: caseId === null
        ? []
        : [el("a", { class: "btn btn-sm btn-ghost", href: `#/runs?case=${encodeURIComponent(caseId)}` }, [el("span", { class: "btn-label", text: "这个用例的运行记录" })])],
    }),
    notices.node,
    el("div", { class: "editor" }, [nav, el("div", { class: "editor-main" }, [warnings, form]), drawer]),
    actionBar,
  );

  function versionNote() {
    return el("span", { class: "mono version-note", title: "每次保存生成一个新版本", text: `r${revision}` });
  }

  // ---- 离开保护：路由内跳转 + 刷新/关标签页 ---------------------------------
  const beforeUnload = (event) => {
    if (!isDirty()) return;
    event.preventDefault();
    event.returnValue = "";
  };
  window.addEventListener("beforeunload", beforeUnload);
  const onKey = (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
      event.preventDefault();
      void save(saveButton, false);
    }
  };
  document.addEventListener("keydown", onKey);
  onLeave(() => {
    window.removeEventListener("beforeunload", beforeUnload);
    document.removeEventListener("keydown", onKey);
  });

  // -------------------------------------------------------------------------
  // 绑定到草稿的控件
  // -------------------------------------------------------------------------

  /**
   * 一个绑定到草稿路径的控件。`input` 时只做三件事：写回草稿、刷新摘要与脏标记、
   * 重画保存前提示——绝不重渲染。
   *
   * `multiline` = 用 textarea；`list` = 值是**字符串数组**（每行一条）。两者必须分开：
   * goal 是「多行的**一个**字符串」，allowedOrigins 是「多个字符串」。
   */
  function draftField(path, label, options = {}) {
    const { note = null, required = false, keyName = null } = options;
    return field({ label, control: draftInput(path, options), keyName, note, required });
  }

  /** draftField 的控件本体：绑定到草稿路径的输入框（不带标签外壳）。 */
  function draftInput(path, options = {}) {
    const { multiline = false, list = false, placeholder = "", numeric = false, type = "text", rows = 3, mono = false } = options;
    const current = readPath(draft, path);
    const input = multiline
      ? el("textarea", { class: `form-control${mono || list ? " mono" : ""}`, rows, placeholder })
      : el("input", { class: `form-control${mono ? " mono" : ""}`, type: numeric ? "number" : type, placeholder, step: numeric ? "any" : null });
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
      clearFieldError(input);
      refreshSummary();
    });
    return input;
  }

  /** 下拉框版本。取值是封闭枚举，让用户手打只会打错。 */
  function draftSelect(path, label, options, { note = null, keyName = null, onChange = null } = {}) {
    const current = readPath(draft, path) ?? "";
    const select = el("select", { class: "form-select" }, options.map(([value, text]) => el("option", { value, text })));
    select.value = current;
    select.dataset.path = path;
    select.addEventListener("change", () => {
      writePath(draft, path, select.value);
      clearFieldError(select);
      refreshSummary();
      onChange?.();
    });
    return field({ label, control: select, keyName, note });
  }

  /** 多选的枚举控件（结束方式、禁止的动作种类）。取消最后一个勾**不删断言**——空集合是有意义的值。 */
  function enumPicker(path, values, labels) {
    const wrap = el("div", { class: "chip-picker", role: "group" });
    const current = () => [].concat(readPath(draft, path) ?? []);
    values.forEach((value, index) => {
      const box = el("input", { class: "chip-input", type: "checkbox", checked: current().includes(value), id: `${path}-${value}` });
      box.dataset.path = `${path}.${index}`;
      box.addEventListener("change", () => {
        const next = current().filter((item) => item !== value);
        if (box.checked) next.push(value);
        // 顺序按 values 归位，免得「勾选顺序」变成落盘顺序
        writePath(draft, path, values.filter((item) => next.includes(item)));
        refreshSummary();
      });
      wrap.append(el("label", { class: "chip", for: box.id }, [box, el("span", { text: labels[value] ?? value })]));
    });
    return wrap;
  }

  // -------------------------------------------------------------------------
  // 基本
  // -------------------------------------------------------------------------

  function renderBasic() {
    const originsNote = el("p", { class: "field-note" });
    const refreshOriginsNote = () => {
      const startOrigin = originOf(draft.startUrl);
      const origins = cleanStrings(draft.allowedOrigins);
      if (startOrigin === null) {
        originsNote.textContent = "越界即终止运行。留空时由起始地址推导。";
        return;
      }
      setChildren(originsNote, [rich(origins.length === 0
        ? `留空即只允许起始地址的 origin \`${startOrigin}\`。越界即终止运行。`
        : origins.includes(startOrigin)
          ? `已包含起始地址的 origin \`${startOrigin}\`。`
          : `**缺少起始地址的 origin** \`${startOrigin}\`，保存会被拒。`)]);
    };

    const engineNotice = el("div");
    const refreshEngineNotice = () => setChildren(engineNotice, [hint(engineNoticeText(draft.engine ?? "", engines))]);
    const engineField = engines.length > 1
      ? draftSelect("engine", "决策引擎", [["", "服务端默认"]].concat(engines.map((engine) => [engine.name, engine.name])), { keyName: "engine", onChange: refreshEngineNotice })
      : null;
    refreshEngineNotice();

    setChildren(sections.basic, [
      draftField("title", "标题", { required: true, placeholder: "维基百科：打开哥德尔不完备定理条目" }),
      draftField("goal", "目标", {
        required: true,
        multiline: true,
        rows: 4,
        keyName: "goal",
        placeholder: "On Wikipedia, find and open the article about Gödel's incompleteness theorems.",
        note: "唯一的行为指令，用自然语言写清要做成什么、做到哪一步停。**断言不要写进这里**：让 agent 看见判分标准会诱导它对着答案演戏。",
      }),
      draftField("startUrl", "起始地址", { required: true, type: "url", keyName: "startUrl", placeholder: "https://en.wikipedia.org/wiki/Main_Page", mono: true }),
      authStateField(),
      draftSelect("mode", "模式", [
        ["interactive", "可以操作页面（默认）"],
        ["readonly", "只读：不改变任何页面状态"],
      ], { keyName: "mode", note: "只读模式下，输入与选择这类变更型操作在构造候选集时就被剔除，模型物理上选不到。" }),
      disclosure("引擎与域名白名单", [
        engineField,
        engineNotice,
        draftField("allowedOrigins", "域名白名单", { multiline: true, list: true, rows: 3, keyName: "allowedOrigins", placeholder: "https://en.wikipedia.org", note: originsNote }),
      ], { open: cleanStrings(draft.allowedOrigins).length > 0 || Boolean(draft.engine) }),
    ]);
    refreshOriginsNote();
    sections.basic.addEventListener("input", refreshOriginsNote);
  }

  /**
   * 登录态：下拉选一份，或者就地新建。**就地**是刻意的：跳去「登录态」页会丢掉这里还没保存的草稿。
   * 新建完自动选上，并把那一次验证的结论显示在下拉框下面。
   */
  function authStateField() {
    const select = el("select", { class: "form-select" });
    select.dataset.path = "authState";
    const status = el("div", { class: "auth-state-status" });
    const flowSlot = el("div");

    const fill = () => {
      const current = draft.authState ?? "";
      const options = [["", "不使用：以未登录的全新浏览器打开"]].concat(
        authStates.map((item) => [item.name, `${item.name}（${sitesText(item.sites)}）`]),
      );
      // 用例引用了一份已经不存在的登录态：保留这一项并标出来。静默落回「不使用」等于替用户改了用例
      if (current !== "" && !authStates.some((item) => item.name === current)) {
        options.push([current, `${current}（不存在，运行会失败）`]);
      }
      setChildren(select, options.map(([value, text]) => el("option", { value, text })));
      select.value = current;
      refreshStatus();
    };

    const refreshStatus = () => {
      const name = draft.authState ?? "";
      const chosen = authStates.find((item) => item.name === name);
      // 选了但没保存：运行用的是磁盘上的版本，不会带上它。「登录态已保存」与「用例已保存」是两件事
      const pending = caseId !== null && name !== savedAuthState
        ? el("div", { class: "auth-pending" }, [
            icon("info", 15),
            el("span", { text: name === "" ? "已改为不使用登录态，保存用例后生效。" : `已选上 ${name}，但用例还没保存：现在运行不会带上它。` }),
          ])
        : null;
      if (name === "") {
        setChildren(status, [pending, hint("目标页要求登录时选一份；没有合适的就点「新建」，在弹出的浏览器里登录一次即可。**密码不经过模型。**", "field-note")]);
        return;
      }
      if (chosen === undefined) {
        setChildren(status, [pending, el("p", { class: "field-note text-danger", text: `登录态 ${name} 不存在：点「新建」建一份同名的，或换一个。` })]);
        return;
      }
      const verified = chosen.lastVerified;
      setChildren(status, [
        pending,
        el("div", { class: "verify-line" }, [
          verifyBadge(verified),
          el("span", { class: "hint-inline", text: verified ? verified.detail : `保存于 ${relativeTime(chosen.savedAt)}，还没验证过` }),
          verified && !verified.ok
            ? button("重新登录", { kind: "outline-primary", onclick: () => openFlow({ name: chosen.name, url: chosen.loginUrl ?? draft.startUrl ?? "", overwrite: true }) })
            : null,
        ]),
      ]);
    };

    const openFlow = (options) => {
      setChildren(flowSlot, [loginFlow({
        ...options,
        onSaved: async (summary) => {
          authStates = await call("/api/auth-states").catch(() => authStates);
          writePath(draft, "authState", summary.name);
          fill();
          refreshSummary();
        },
        onClose: () => flowSlot.replaceChildren(),
        savedNext: (summary) => caseId === null
          ? hint(`已在上面选上 **${summary.name}**。填完用例点「创建」后生效。`)
          : el("div", { class: "auth-pending" }, [
              el("span", { text: `已在上面选上 ${summary.name}。保存用例后，运行才会带上它。` }),
              button("保存用例", { kind: "primary", onclick: (event) => void save(event.currentTarget, false) }),
            ]),
      })]);
    };
    openLoginFlow = (overwrite) => {
      const name = draft.authState ?? "";
      const known = authStates.find((item) => item.name === name);
      openFlow(overwrite && known !== undefined ? { name, url: known.loginUrl ?? draft.startUrl ?? "", overwrite: true } : { url: draft.startUrl ?? "" });
      flowSlot.scrollIntoView({ behavior: "smooth", block: "center" });
    };

    select.addEventListener("change", () => {
      writePath(draft, "authState", select.value);
      refreshStatus();
      refreshSummary();
    });
    refreshAuthStatus = refreshStatus;
    fill();
    return el("div", { class: "field" }, [
      el("label", { class: "field-main" }, [
        el("span", { class: "field-label" }, [el("span", { text: "登录态" }), el("code", { class: "field-key", text: "authState" })]),
        el("div", { class: "input-group" }, [select, button("新建", { kind: "outline-secondary", size: "", iconName: "plus", onclick: () => openFlow({ url: draft.startUrl ?? "" }) })]),
      ]),
      status,
      flowSlot,
    ]);
  }

  // -------------------------------------------------------------------------
  // 断言
  // -------------------------------------------------------------------------

  function renderAssertions() {
    const picker = el("select", { class: "form-select form-select-sm", "aria-label": "要添加的断言" });
    const addButton = button("添加断言", { kind: "outline-primary", iconName: "plus" });
    addButton.addEventListener("click", () => {
      const value = picker.value;
      if (value.startsWith("raw:")) {
        revealedRaw.add(value.slice(4));
      } else {
        const recipe = RECIPE_BY_KIND.get(value);
        if (recipe === undefined) return;
        if (recipe.single) {
          writePath(draft, recipe.where, recipe.statuses ? ["done"] : 0);
        } else {
          const list = readPath(draft, recipe.where) ?? [];
          list.push(recipe.item ? recipe.item() : "");
          writePath(draft, recipe.where, list);
        }
      }
      renderAssertions();
      refreshSummary();
      // 焦点落到新加的那一行，省一次点击
      const rows = sections.assertions.querySelectorAll("[data-path]");
      const target = value.startsWith("raw:")
        ? sections.assertions.querySelector(`[data-path^="${value.slice(4)}"]`)
        : [...rows].filter((node) => node.closest(`.recipe-row--${CSS.escape(value)}`)).pop();
      target?.focus();
    });

    const rows = assertionRows(draft);
    const leftovers = rawLeftovers();
    const groups = ASSERTION_GROUPS.map((group) => {
      const recipeRows = rows.filter((row) => row.recipe.group === group.key).map(recipeRow);
      const rawFields = RAW_FIELDS.filter((item) => item.group === group.key && (isRawSet(item) || revealedRaw.has(item.path))).map(rawField);
      const rawRows = leftovers.filter((row) => row.group === group.key).map(rawRowEditor);
      const children = [...recipeRows, ...rawFields, ...rawRows];
      return el("div", { class: "assert-group", "data-group": group.key }, [
        el("div", { class: "assert-group-head" }, [
          el("h3", { class: "assert-group-title", text: group.label }),
          el("span", { class: "assert-group-note", text: group.note }),
        ]),
        children.length === 0 ? el("p", { class: "assert-empty", text: "暂无" }) : el("div", { class: "assert-rows" }, children),
      ]);
    });

    // 选项：配方（单条的只在未用时出现）+ 未启用的原始字段，按层分组
    const used = new Set(rows.filter((row) => row.recipe.single).map((row) => row.recipe.kind));
    setChildren(picker, ASSERTION_GROUPS.map((group) => el("optgroup", { label: group.label }, [
      ...RECIPES.filter((recipe) => recipe.group === group.key && (!recipe.single || !used.has(recipe.kind))).map((recipe) => el("option", { value: recipe.kind, text: recipe.sentence })),
      ...RAW_FIELDS.filter((item) => item.group === group.key && !isRawSet(item) && !revealedRaw.has(item.path)).map((item) => el("option", { value: `raw:${item.path}`, text: item.label })),
    ])));

    setChildren(sections.assertions, [
      rows.length === 0 && leftovers.length === 0 && !RAW_FIELDS.some((item) => isRawSet(item) || revealedRaw.has(item.path))
        ? callout("info", "还没有断言", ["没有断言的运行只能得到**未判定**，不会是通过。最常用的是「页面包含文本」和「地址包含」。"])
        : null,
      ...groups,
      el("div", { class: "recipe-add" }, [picker, addButton]),
    ]);
  }

  function removeButton(label, onclick) {
    return button("", { kind: "ghost", iconName: "close", title: label, onclick, extra: "row-remove" });
  }

  function recipeRow(row) {
    const node = el("div", { class: `recipe-row recipe-row--${row.recipe.kind}` }, [
      el("span", { class: "recipe-sentence", text: row.recipe.sentence }),
    ]);
    if (row.recipe.statuses) {
      node.append(enumPicker(row.recipe.where, RUN_STATUSES.filter((status) => status !== "queued" && status !== "running"), STATUS_LABELS));
    } else {
      const input = el("input", {
        class: "form-control form-control-sm",
        type: row.recipe.numeric ? "number" : "text",
        placeholder: row.recipe.value,
      });
      input.value = row.value ?? "";
      input.dataset.path = row.path;
      input.addEventListener("input", () => {
        if (row.recipe.numeric) {
          const parsed = Number(input.value.trim());
          writePath(draft, row.path, input.value.trim() !== "" && Number.isFinite(parsed) ? parsed : "");
        } else {
          writePath(draft, row.path, input.value.trim());
        }
        clearFieldError(input);
        refreshSummary();
      });
      node.append(input);
    }
    node.append(removeButton(`删除这条断言：${row.recipe.sentence}`, () => {
      // 删的是**整个数组元素**：下标前移之后下面每一行的 data-path 就旧了，所以必须重画
      if (row.recipe.single) {
        const keys = row.recipe.where.split(".");
        const parent = readPath(draft, keys.slice(0, -1).join("."));
        if (parent !== undefined) delete parent[keys[keys.length - 1]];
      } else {
        readPath(draft, row.recipe.where)?.splice(row.index, 1);
      }
      renderAssertions();
      refreshSummary();
    }));
    return node;
  }

  function isRawSet(item) {
    const value = readPath(draft, item.path);
    if (value === undefined || value === null || value === "") return false;
    if (Array.isArray(value)) return value.length > 0;
    return true;
  }

  /** 配方之外的单个字段：和配方行同一种排法（一句话 + 控件 + 删除），schema 键放在悬浮提示里。 */
  function rawField(item) {
    const keyName = item.path.replace(/^assertions\./, "");
    const control = item.type === "kinds"
      ? enumPicker(item.path, ACTION_KINDS, ACTION_KIND_LABELS)
      : draftInput(item.path, {
          multiline: item.type === "lines",
          list: item.type === "lines",
          numeric: item.type === "number",
          rows: 2,
          placeholder: item.type === "lines" ? "每行一条" : "",
        });
    if (control.classList?.contains("form-control")) control.classList.add("form-control-sm");
    return el("div", { class: "recipe-row raw-field" }, [
      el("span", { class: "recipe-sentence", title: keyName, text: item.label }),
      control,
      removeButton(`删除这条断言：${item.label}`, () => {
        writePath(draft, item.path, "");
        revealedRaw.delete(item.path);
        renderAssertions();
        refreshSummary();
      }),
      item.note ? el("p", { class: "recipe-note", text: item.note }) : null,
    ]);
  }

  /** 含配方表达不了的字段的数组行：控件断言、必须/绝不能操作。整行按原始字段编辑。 */
  function rawLeftovers() {
    const final = draft.assertions.final ?? {};
    const trajectory = draft.assertions.trajectory ?? {};
    const rows = [];
    [].concat(final.controls ?? []).forEach((row, index) => {
      const recipe = RECIPE_BY_KIND.get(row.exists === false ? "controls.absent" : "controls.exists");
      if (!recipeCovers(recipe, row) && rowHasContent(row)) {
        rows.push({ group: "final", title: `控件断言 #${index + 1}`, where: "assertions.final.controls", index, columns: CONTROL_COLUMNS, row });
      }
    });
    for (const [key, where, title] of [
      ["mustUse", "assertions.trajectory.mustUse", "必须操作过"],
      ["mustNotUse", "assertions.trajectory.mustNotUse", "绝不能操作"],
    ]) {
      [].concat(trajectory[key] ?? []).forEach((row, index) => {
        if (!recipeCovers(RECIPE_BY_KIND.get(key), row) && rowHasContent(row)) {
          rows.push({ group: "trajectory", title: `${title} #${index + 1}`, where, index, columns: ACTION_COLUMNS, row });
        }
      });
    }
    return rows;
  }

  /**
   * 原始行编辑器：一张小卡，每一格都有自己的标签（以前是 7 列只有 placeholder 的小输入框，
   * 敲下第一个字符之后就再也看不出哪一列是什么）。改动会标脏——以前不会，保存按钮一直灰着。
   */
  function rawRowEditor({ title, where, index, columns, row }) {
    const path = `${where}.${index}`;
    const grid = el("div", { class: "raw-grid" });
    for (const column of columns) {
      const value = row[column.key];
      const input = column.options
        ? el("select", { class: "form-select form-select-sm" }, [
            el("option", { value: "", text: "不限" }),
            ...column.options.map((option) => el("option", { value: option, text: column.key === "kind" ? ACTION_KIND_LABELS[option] ?? option : option === "true" ? "是" : "否" })),
          ])
        : el("input", { class: "form-control form-control-sm" });
      input.value = value === undefined || value === null ? "" : String(value);
      input.dataset.path = `${path}.${column.key}`;
      input.addEventListener(column.options ? "change" : "input", () => {
        row[column.key] = input.value === "" ? undefined : input.value;
        clearFieldError(input);
        refreshSummary();
      });
      grid.append(el("label", { class: "field-main" }, [
        el("span", { class: "field-label" }, [el("span", { text: column.label }), column.required ? el("span", { class: "req", text: "*" }) : null]),
        input,
      ]));
    }
    return el("div", { class: "raw-row" }, [
      el("div", { class: "raw-row-head" }, [
        el("span", { class: "raw-row-label", text: title }),
        el("code", { class: "field-key", text: path.replace(/^assertions\./, "") }),
        removeButton(`删除 ${title}`, () => {
          readPath(draft, where)?.splice(index, 1);
          renderAssertions();
          refreshSummary();
        }),
      ]),
      grid,
    ]);
  }

  // -------------------------------------------------------------------------
  // 预算与护栏
  // -------------------------------------------------------------------------

  function renderLimits() {
    const budgetGrid = el("div", { class: "form-grid form-grid--budget" }, BUDGET_FIELDS.map((item) =>
      draftField(`budget.${item.key}`, item.label, { numeric: true, placeholder: item.placeholder, keyName: item.key }),
    ));

    const guardrailsBox = el("div", { class: "guardrail-rows" });
    const renderGuardrails = () => {
      const rows = draft.guardrails;
      setChildren(guardrailsBox, [
        ...rows.map((row, index) => {
          const cells = GUARDRAIL_COLUMNS.map((column) => {
            const input = el("input", { class: "form-control form-control-sm", value: row[column.key] ?? "", placeholder: column.key === "role" ? "button" : "" });
            input.dataset.path = `guardrails.${index}.${column.key}`;
            input.addEventListener("input", () => {
              row[column.key] = input.value.trim();
              clearFieldError(input);
              refreshSummary();
            });
            return el("label", { class: "field-main" }, [
              el("span", { class: "field-label" }, [el("span", { text: column.label }), column.required ? el("span", { class: "req", text: "*" }) : null]),
              input,
            ]);
          });
          return el("div", { class: "guardrail-row" }, [
            el("span", { class: "guardrail-index mono", text: String(index + 1) }),
            el("div", { class: "guardrail-cells" }, cells),
            removeButton(`删除第 ${index + 1} 条护栏`, () => {
              rows.splice(index, 1);
              renderGuardrails();
              refreshSummary();
            }),
          ]);
        }),
        button("添加护栏", {
          kind: "outline-secondary",
          iconName: "plus",
          onclick: () => {
            rows.push({});
            renderGuardrails();
            refreshSummary();
            guardrailsBox.querySelectorAll(".guardrail-row input")[(rows.length - 1) * GUARDRAIL_COLUMNS.length]?.focus();
          },
        }),
      ]);
    };
    renderGuardrails();

    const override = el("input", { class: "form-check-input", type: "checkbox", checked: draft.allowDefaultOverride, id: "allow-default-override" });
    override.dataset.path = "allowDefaultOverride";
    override.addEventListener("change", () => {
      draft.allowDefaultOverride = override.checked;
      refreshSummary();
    });

    setChildren(sections.limits, [
      el("h3", { class: "sub-title", text: "预算" }),
      hint("任一项超限，运行立即终止为「超出预算」，**已走过的轨迹照样保留**供断言求值。留空用默认值。"),
      budgetGrid,
      el("h3", { class: "sub-title", text: "护栏" }),
      hint("追加在内置护栏（删除、支付、下单、密码框等）之上。命中时浏览器**收不到任何输入**，运行终止为「被安全护栏拦下」。可访问名包含与正则填一个即可。"),
      guardrailsBox,
      disclosure("危险：停用内置护栏", [
        el("div", { class: "form-check" }, [
          override,
          el("label", { class: "form-check-label", for: "allow-default-override", text: "停用整套内置护栏" }),
        ]),
        hint("是**整套停用**，不是删掉其中几条：删除、支付、下单、密码框那批规则一起退出。要让某一条仍然生效，得把它抄进上面的列表。注意：报告里目前**看不出**这次运行停用过内置护栏。"),
      ], { open: draft.allowDefaultOverride, className: "danger-zone" }),
    ]);
  }

  // -------------------------------------------------------------------------
  // 保存内容（抽屉）
  // -------------------------------------------------------------------------

  function toggleDrawer(force = null) {
    const open = force ?? drawer.hidden;
    drawer.hidden = !open;
    drawerButton.classList.toggle("is-active", open);
    if (open) renderDrawer();
  }

  function renderDrawer() {
    const payload = formToDefinition(draft);
    const body = revision === null ? payload : { ...payload, expectedRevision: revision };
    setChildren(drawer, [
      el("div", { class: "drawer-head" }, [
        el("h2", { class: "drawer-title", text: "保存内容" }),
        button("", { kind: "ghost", iconName: "close", title: "关闭", onclick: () => toggleDrawer(false) }),
      ]),
      loaded === null ? null : el("div", { class: "drawer-block" }, [
        el("h3", { class: "sub-title", text: `磁盘上的 case.yaml（r${revision}）` }),
        el("pre", { class: "code-block mono", text: loaded.yaml }),
      ]),
      el("div", { class: "drawer-block" }, [
        el("h3", { class: "sub-title", text: isDirty() ? "点保存时会提交的内容" : "当前内容（与磁盘一致）" }),
        hint("服务端会把它规范化后写成 YAML：**YAML 是唯一事实来源**，前端不自己拼一份。"),
        el("pre", { class: "payload code-block mono", text: JSON.stringify(body, null, 2) }),
      ]),
    ]);
  }

  // -------------------------------------------------------------------------
  // 摘要、脏标记、错误定位
  // -------------------------------------------------------------------------

  function isDirty() {
    return signature(formToDefinition(draft)) !== baseline;
  }

  function refreshSummary() {
    const summary = draftSummary(draft);
    setNavCount("assertions", summary.assertions > 0 ? String(summary.assertions) : null);
    setNavCount("limits", summary.limits > 0 ? String(summary.limits) : null);

    const dirty = isDirty();
    dirtyBadge.hidden = !dirty;
    // 新建用例时「有没有改」没有意义——本来就该点「创建」
    saveButton.disabled = caseId !== null && !dirty;
    setLeaveGuard(dirty
      ? () => confirmDialog({ title: "放弃未保存的修改？", message: "这个用例有未保存的修改，离开后就没了。", confirmLabel: "放弃修改并离开", cancelLabel: "留下继续编辑", danger: true })
      : null);

    setChildren(warnings, presaveWarnings(draft).map((text) => callout("warning", null, [text])));
    if (!drawer.hidden) renderDrawer();
  }

  function setNavCount(key, text, tone = "") {
    const counter = navCounts.get(key);
    if (counter === undefined) return;
    counter.textContent = text ?? "";
    counter.hidden = !text;
    counter.className = tone === "" ? "nav-count" : `nav-count nav-count--${tone}`;
  }

  function clearFieldError(control) {
    if (!control.classList.contains("is-invalid")) return;
    control.classList.remove("is-invalid");
    control.closest(".field, .field-main, .recipe-row")?.querySelector(".field-error")?.remove();
  }

  function clearAllFieldErrors() {
    form.querySelectorAll(".is-invalid").forEach((node) => node.classList.remove("is-invalid"));
    form.querySelectorAll(".field-error").forEach((node) => node.remove());
  }

  /** 最长前缀匹配：`assertions.final.text.contains.0` 会命中挂这一条的输入框。 */
  function bestFieldFor(path) {
    if (path === "") return null;
    let best = null;
    let bestLength = -1;
    for (const node of form.querySelectorAll("[data-path]")) {
      const candidate = node.dataset.path;
      if ((path === candidate || path.startsWith(`${candidate}.`)) && candidate.length > bestLength) {
        best = node;
        bestLength = candidate.length;
      }
    }
    return best;
  }

  /**
   * 把服务端回的 issue 落回具体控件：标红、在控件下方写出原因、给节目录计数。
   * zod 有时会报一个不对应任何控件的路径（跨字段 refine），那时只在顶部汇总里出现。
   */
  function applyIssues(issues) {
    clearAllFieldErrors();
    const perSection = new Map();
    for (const issue of issues) {
      const path = String(issue.path ?? "");
      const key = sectionForPath(path);
      perSection.set(key, (perSection.get(key) ?? 0) + 1);
      const target = bestFieldFor(path);
      if (target === null) continue;
      target.classList.add("is-invalid");
      const holder = target.closest(".recipe-row") ?? target.closest(".field-main")?.parentElement ?? target.parentElement;
      if (holder.querySelector(":scope > .field-error") === null) {
        holder.append(el("div", { class: "field-error", text: issueMessage(issue.message) }));
      }
      target.closest("details")?.setAttribute("open", "");
    }
    for (const item of SECTIONS) {
      const errorCount = perSection.get(item.key);
      if (errorCount) setNavCount(item.key, `${errorCount} 处错误`, "danger");
    }
  }

  function focusIssue(issue) {
    const target = bestFieldFor(String(issue.path ?? ""));
    const fallback = document.getElementById(`sec-${sectionForPath(String(issue.path ?? ""))}`);
    (target ?? fallback)?.scrollIntoView({ behavior: "smooth", block: "center" });
    target?.focus({ preventScroll: true });
  }

  // -------------------------------------------------------------------------
  // 保存与检测
  // -------------------------------------------------------------------------

  async function save(trigger, andRun) {
    if (saving) return;
    saving = true;
    try {
      await busy(trigger, async () => {
        const definition = formToDefinition(draft);
        const body = revision === null ? definition : { ...definition, expectedRevision: revision };
        notices.clear();
        let result;
        try {
          result = await call("/api/cases", { method: "POST", body });
        } catch (error) {
          handleSaveError(error);
          return;
        }
        clearAllFieldErrors();
        setLeaveGuard(null);
        if (caseId === null) {
          baseline = signature(definition);
          if (andRun) await runCaseAndOpen(result.caseId);
          else location.hash = `#/case/${result.caseId}`;
          return;
        }
        revision = result.revision;
        baseline = signature(definition);
        savedAuthState = draft.authState ?? "";
        loaded = await call(`/api/cases/${caseId}`).catch(() => loaded);
        app.querySelector(".version-note")?.replaceWith(versionNote());
        refreshAuthStatus();
        refreshSummary();
        if (andRun) {
          await runCaseAndOpen(caseId);
          return;
        }
        toast(`已保存为 r${revision}。`);
      }, { pending: andRun ? "正在保存并运行…" : "正在保存…", onError: (error) => notices.show(error) });
    } finally {
      saving = false;
    }
  }

  function handleSaveError(error) {
    if (error.kind === "validation") {
      applyIssues(error.issues);
      notices.show(error, { onIssue: focusIssue, title: `保存没有成功：有 ${error.issues.length} 处需要修改` });
      return;
    }
    if (error.kind === "conflict" && caseId !== null) {
      // 乐观锁冲突：说清「别人改过」，并给一条出路。不做静默覆盖
      notices.show(error, {
        title: "这个用例在别处被改过了",
        actions: [
          el("span", { class: "hint-inline", text: "重新加载会丢掉这里未保存的修改。" }),
          button("重新加载最新版本", { kind: "outline-danger", onclick: () => reload() }),
        ],
      });
      return;
    }
    if (error.kind === "conflict") {
      // 新建时撞上已有 id：id 由标题推导，改标题即可
      notices.show(error, { title: "已经有同名的用例", actions: [el("span", { class: "hint-inline", text: "用例 id 由标题推导：改一下标题再创建。" })] });
      return;
    }
    notices.show(error, { title: "保存没有成功" });
  }

  async function admit() {
    await busy(admitButton, async () => {
      if (isDirty()) toast("检测用的是**已保存**的版本，不含这里未保存的修改。", { tone: "info" });
      const result = await call(`/api/cases/${caseId}/admit`, { method: "POST" });
      notices.set(admissionPanel(result, () => openLoginFlow(Boolean(draft.authState)), draft.authState));
    }, { pending: "正在检测…", onError: (error) => notices.show(error, { title: "检测没有完成" }) });
  }

  renderBasic();
  renderAssertions();
  renderLimits();
  refreshSummary();
}

/** 「当前引擎的概率分布是不是真的」——它决定概率类检查是求值还是跳过。 */
function engineNoticeText(engineName, engines) {
  if (engineName === "") {
    const fallback = engines[0];
    if (fallback === undefined) return "用服务端默认引擎。";
    return fallback.probabilities === "degenerate"
      ? `用服务端默认引擎（${fallback.name}）。它给不出真实概率分布，概率类断言会被**跳过**而不是通过。`
      : `用服务端默认引擎（${fallback.name}），概率类断言可以正常求值。`;
  }
  const selected = engines.find((engine) => engine.name === engineName);
  if (selected === undefined) return `引擎 \`${engineName}\` 没有注册，运行会失败。`;
  return selected.probabilities === "degenerate"
    ? `引擎 \`${engineName}\` 给不出真实概率分布：概率类断言会被**跳过**而不是通过，单点分布下的比较会假通过。`
    : `引擎 \`${engineName}\` 给出完整概率分布，概率类断言可以求值。`;
}

/** 准入检查的结论。准入是记录与警告，不是运行的闸——不阻止运行。 */
function admissionPanel(report, openLogin, authState) {
  const lines = [
    ...report.blocking.map((line) => el("li", { class: "is-blocking", text: line })),
    ...report.warnings.map((line) => el("li", { text: line })),
  ];
  const statsLine = el("p", { class: "hint mono", text: `可交互元素 ${report.stats.interactiveElements}，frame ${report.stats.frames}（跨域 ${report.stats.crossOriginFrames}），shadow root ${report.stats.shadowRoots}，canvas ${report.stats.canvases}` });
  const extra = [];
  if (report.redirectedTo) {
    extra.push(el("div", { class: "callout-actions" }, [
      button(authState ? `重新登录 ${authState}` : "配置登录态", { kind: "primary", onclick: openLogin }),
    ]));
  }
  if (!report.ok) {
    return callout("warning", "检测结果：不建议跑", [el("ul", { class: "plain-list" }, lines), ...extra, statsLine]);
  }
  if (report.warnings.length === 0) {
    return callout("success", "检测结果：可以测，没发现本平台测不了的东西", [statsLine]);
  }
  return callout("warning", `检测结果：可以测，但有 ${report.warnings.length} 条警告`, [el("ul", { class: "plain-list" }, lines), hint("警告不阻止运行，但结果可能打折扣。"), statsLine]);
}

