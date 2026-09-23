/**
 * 用例列表：搜索、单跑、多选批量跑、删除。点整行进编辑器。
 */

import { el, button, download, setChildren } from "../lib/dom.js";
import { call, startRuns, runCaseAndOpen } from "../lib/api.js";
import { absoluteTime, relativeTime } from "../lib/format.js";
import { busy, confirmDialog, errorSlot, toast } from "../ui/feedback.js";
import { emptyState, menu, pageHead, tag, verdictBadge } from "../ui/widgets.js";
import { loginPreflight } from "../components/login.js";

export async function viewCases(app) {
  let cases = await call("/api/cases");
  const selected = new Set();
  let query = "";

  const newButton = el("a", { class: "btn btn-sm btn-primary", href: "#/new" }, [el("span", { class: "btn-label", text: "新建用例" })]);

  if (cases.length === 0) {
    app.replaceChildren(
      pageHead("用例"),
      emptyState({
        iconName: "cases",
        title: "还没有用例",
        text: "一个用例就是一句目标加一个起始地址。手填三项就能建一个，也可以导入现成的 `case.yaml`。",
        actions: [
          el("a", { class: "btn btn-sm btn-primary", href: "#/case-new-form", text: "手填一个" }),
          el("a", { class: "btn btn-sm btn-outline-secondary", href: "#/new", text: "导入 YAML" }),
        ],
      }),
    );
    return;
  }

  // 登录前置检查的提示落在这里：它是针对某一行的，但需要比一行宽的地方来摆候选登录态
  const notices = errorSlot();
  const tbody = el("tbody");
  const selectAll = el("input", { class: "form-check-input", type: "checkbox", "aria-label": "全选" });
  const batchButton = button("运行所选", { kind: "primary", iconName: "play" });
  const batchBar = el("div", { class: "batch-bar", hidden: true }, [
    el("span", { class: "batch-count" }),
    batchButton,
    button("取消选择", { kind: "ghost", onclick: () => { selected.clear(); render(); } }),
  ]);
  const search = el("input", { class: "form-control form-control-sm search-input", type: "search", placeholder: "按标题、id 或地址搜索", "aria-label": "搜索用例" });
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    render();
  });

  selectAll.addEventListener("change", () => {
    for (const item of visibleCases()) {
      if (selectAll.checked) selected.add(item.id);
      else selected.delete(item.id);
    }
    render();
  });

  batchButton.addEventListener("click", () => busy(batchButton, async () => {
    const ids = [...selected];
    const runIds = await startRuns(ids);
    selected.clear();
    if (runIds.length === 1) {
      location.hash = `#/run/${runIds[0]}`;
      return;
    }
    toast(`已把 ${runIds.length} 个用例加入队列。`, { action: { label: "去看运行", onclick: () => { location.hash = "#/runs"; } } });
    render();
  }, { pending: "正在入队…" }));

  app.replaceChildren(
    pageHead("用例", { meta: [el("span", { text: `共 ${cases.length} 个` })], actions: [newButton] }),
    notices.node,
    el("div", { class: "toolbar" }, [search, batchBar]),
    el("div", { class: "table-wrap" }, [
      el("table", { class: "table list-table cases-table" }, [
        el("thead", {}, [el("tr", {}, [
          el("th", { class: "col-check" }, [selectAll]),
          el("th", { text: "用例" }),
          el("th", { text: "最近一次运行" }),
          el("th", { class: "col-actions" }),
        ])]),
        tbody,
      ]),
    ]),
  );
  render();

  function visibleCases() {
    if (query === "") return cases;
    return cases.filter((item) =>
      (item.title ?? "").toLowerCase().includes(query) || item.id.toLowerCase().includes(query) || (item.startUrl ?? "").toLowerCase().includes(query));
  }

  function render() {
    const visible = visibleCases();
    setChildren(tbody, visible.length === 0
      ? [el("tr", {}, [el("td", { colspan: "4", class: "table-empty", text: "没有符合条件的用例。" })])]
      : visible.map(caseRow));
    batchBar.hidden = selected.size === 0;
    batchBar.querySelector(".batch-count").textContent = `已选 ${selected.size} 个`;
    selectAll.checked = visible.length > 0 && visible.every((item) => selected.has(item.id));
    selectAll.indeterminate = !selectAll.checked && visible.some((item) => selected.has(item.id));
  }

  function caseRow(item) {
    const check = el("input", { class: "form-check-input", type: "checkbox", checked: selected.has(item.id), "aria-label": `选择 ${item.title || item.id}` });
    check.addEventListener("change", () => {
      if (check.checked) selected.add(item.id);
      else selected.delete(item.id);
      render();
    });

    const runButton = button("运行", { kind: "outline-primary", iconName: "play" });
    runButton.addEventListener("click", () => busy(runButton, async () => {
      notices.clear();
      const run = () => busy(runButton, () => runCaseAndOpen(item.id), { pending: "正在入队…" });
      const preflight = await loginPreflight(item, { onRun: () => { notices.clear(); void run(); } });
      if (preflight === null) {
        delete runButton.dataset.busy;
        await run();
        return;
      }
      notices.set(preflight);
    }));

    const lastRun = item.lastRun
      ? el("a", { href: `#/run/${item.lastRun.runId}`, class: "last-run", title: absoluteTime(item.lastRun.startedAt) }, [
          verdictBadge(item.lastRun.status, item.lastRun.passed),
          el("span", { class: "muted", text: relativeTime(item.lastRun.startedAt) }),
        ])
      : el("span", { class: "muted", text: "还没跑过" });

    const open = () => {
      location.hash = `#/case/${item.id}`;
    };
    return el("tr", {
      class: `is-clickable${selected.has(item.id) ? " is-selected" : ""}`,
      "data-case": item.id,
      onclick: (event) => {
        if (!event.target.closest("a, button, input, details")) open();
      },
    }, [
      el("td", { class: "col-check" }, [check]),
      el("td", {}, [
        el("a", { class: "row-title", href: `#/case/${item.id}`, text: item.title || item.id }),
        el("div", { class: "row-meta" }, [
          el("span", { class: "mono", text: item.id }),
          el("span", { class: "mono", title: "当前版本", text: `r${item.revision}` }),
          item.authState ? tag(`登录态 ${item.authState}`, { title: "运行时会带上这份登录态" }) : null,
        ]),
      ]),
      el("td", {}, [lastRun]),
      el("td", { class: "col-actions" }, [
        el("div", { class: "row-actions" }, [
          runButton,
          menu([
            ["导出 YAML", () => void exportYaml(item.id), { iconName: "download" }],
            ["删除用例", () => void remove(item), { danger: true, iconName: "trash" }],
          ]),
        ]),
      ]),
    ]);
  }

  async function exportYaml(id) {
    try {
      download(`${id}.yaml`, await call(`/api/cases/${id}/export`));
    } catch (error) {
      toast(`导出没有完成：${error.message}`, { tone: "danger" });
    }
  }

  async function remove(item) {
    const ok = await confirmDialog({
      title: `删除用例「${item.title || item.id}」？`,
      message: "用例文件和它的全部历史版本都会删掉，不能撤销。已有的运行记录会保留。",
      confirmLabel: "删除用例",
      danger: true,
    });
    if (!ok) return;
    try {
      await call(`/api/cases/${item.id}`, { method: "DELETE" });
      cases = cases.filter((other) => other.id !== item.id);
      selected.delete(item.id);
      toast(`已删除用例「${item.title || item.id}」。`);
      if (cases.length === 0) await viewCases(app);
      else render();
    } catch (error) {
      toast(`删除没有完成：${error.message}`, { tone: "danger" });
    }
  }
}
