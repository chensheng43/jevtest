/**
 * 运行列表：按判决筛选、按用例搜索；有运行中的条目时自动刷新，并能就地取消。
 */

import { el, button, setChildren } from "../lib/dom.js";
import { call } from "../lib/api.js";
import { isLive, statusLabel } from "../lib/runs.js";
import { absoluteTime, duration, money, relativeTime } from "../lib/format.js";
import { onLeave } from "../lib/router.js";
import { busy, toast } from "../ui/feedback.js";
import { emptyState, pageHead, verdictBadge } from "../ui/widgets.js";

/** 默认渲染多少条。`GET /api/runs` 不分页，index.jsonl 会一直涨。 */
const RUNS_PAGE = 50;
/** 有运行中的条目时多久刷新一次 */
const REFRESH_MS = 3000;

const FILTERS = [
  ["all", "全部"],
  ["failed", "失败"],
  ["passed", "通过"],
  ["undecided", "未判定"],
  ["live", "运行中"],
];

function matchesFilter(run, filter) {
  if (filter === "all") return true;
  if (filter === "live") return isLive(run.status);
  if (isLive(run.status)) return false;
  if (filter === "passed") return run.passed === true;
  if (filter === "failed") return run.passed === false;
  return run.passed === null;
}

export async function viewRuns(app, params = new URLSearchParams()) {
  let runs = await call("/api/runs");
  let filter = "all";
  // 从编辑器「这个用例的运行记录」过来时带着用例 id，预填进搜索框
  let query = (params.get("case") ?? "").toLowerCase();
  let limit = RUNS_PAGE;
  let timer = null;
  onLeave(() => clearTimeout(timer));

  if (runs.length === 0) {
    app.replaceChildren(
      pageHead("运行"),
      emptyState({
        iconName: "runs",
        title: "还没有运行记录",
        text: "在用例列表里点「运行」，结果会出现在这里。",
        actions: [el("a", { class: "btn btn-sm btn-primary", href: "#/cases", text: "去用例列表" })],
      }),
    );
    return;
  }

  const tbody = el("tbody");
  const footer = el("div", { class: "list-footer" });
  const filterBar = el("div", { class: "segmented", role: "group", "aria-label": "按判决筛选" });
  const search = el("input", { class: "form-control form-control-sm search-input", type: "search", placeholder: "按用例名或 id 搜索", "aria-label": "搜索运行" });
  search.value = query;
  search.addEventListener("input", () => {
    query = search.value.trim().toLowerCase();
    limit = RUNS_PAGE;
    render();
  });

  const renderFilters = () => {
    setChildren(filterBar, FILTERS.map(([key, label]) => {
      const total = runs.filter((run) => matchesFilter(run, key)).length;
      return el("button", {
        type: "button",
        class: `segmented-item${filter === key ? " is-active" : ""}`,
        "aria-pressed": filter === key ? "true" : "false",
        onclick: () => {
          filter = key;
          limit = RUNS_PAGE;
          render();
        },
      }, [el("span", { text: label }), el("span", { class: "segmented-count", text: String(total) })]);
    }));
  };

  app.replaceChildren(
    pageHead("运行", { meta: [el("span", { text: `共 ${runs.length} 次` })] }),
    el("div", { class: "toolbar" }, [filterBar, search]),
    el("div", { class: "table-wrap" }, [
      el("table", { class: "table list-table runs-table" }, [
        el("thead", {}, [el("tr", {}, [
          el("th", { class: "col-verdict", text: "判决" }),
          el("th", { text: "用例" }),
          el("th", { text: "结束方式" }),
          el("th", { class: "col-num", text: "步数" }),
          el("th", { class: "col-num", text: "耗时" }),
          el("th", { class: "col-num", text: "成本" }),
          el("th", { class: "col-time", text: "开始于" }),
          el("th", { class: "col-actions" }),
        ])]),
        tbody,
      ]),
    ]),
    footer,
  );
  render();

  function render() {
    renderFilters();
    const visible = runs.filter((run) => matchesFilter(run, filter)).filter((run) =>
      query === "" || (run.caseTitle ?? "").toLowerCase().includes(query) || run.caseId.toLowerCase().includes(query) || run.runId.includes(query));
    if (visible.length === 0) {
      setChildren(tbody, [el("tr", {}, [el("td", { colspan: "8", class: "table-empty", text: "没有符合条件的运行。" })])]);
    } else {
      setChildren(tbody, visible.slice(0, limit).map(runRow));
    }
    if (visible.length <= limit) {
      footer.replaceChildren();
    } else {
      footer.replaceChildren(button(`再显示 ${Math.min(RUNS_PAGE, visible.length - limit)} 条（还有 ${visible.length - limit} 条）`, {
        onclick: () => {
          limit += RUNS_PAGE;
          render();
        },
      }));
    }
    scheduleRefresh();
  }

  /** 有运行中的条目才刷新：判决会变，列表不能停在「运行中」 */
  function scheduleRefresh() {
    clearTimeout(timer);
    if (!runs.some((run) => isLive(run.status))) return;
    timer = setTimeout(async () => {
      if (!app.isConnected) return;
      try {
        runs = await call("/api/runs");
        if (app.isConnected) render();
      } catch {
        scheduleRefresh(); // 服务短暂不可达：全局横幅会说，这里下一轮再试
      }
    }, REFRESH_MS);
  }

  function runRow(run) {
    const open = () => {
      location.hash = `#/run/${run.runId}`;
    };
    const live = isLive(run.status);
    const actions = el("td", { class: "col-actions" });
    if (live) {
      const cancel = button("取消", { kind: "ghost", iconName: "stop", title: "取消这次运行" });
      cancel.addEventListener("click", (event) => {
        event.stopPropagation();
        void busy(cancel, async () => {
          await call(`/api/runs/${run.runId}/cancel`, { method: "POST" });
          toast("已请求取消：会在当前这一步做完后停下。", { tone: "info" });
        });
      });
      actions.append(cancel);
    }
    return el("tr", { class: "is-clickable", onclick: (event) => { if (!event.target.closest("a, button")) open(); } }, [
      el("td", { class: "col-verdict" }, [verdictBadge(run.status, run.passed)]),
      el("td", {}, [
        el("a", { class: "row-title", href: `#/run/${run.runId}`, text: run.caseTitle || run.caseId }),
        el("div", { class: "row-meta mono", text: run.runId }),
      ]),
      // done 是常态，单独写出来反而是噪音；其余每一种结束方式都要看得见
      el("td", { class: run.status === "done" ? "muted" : "", text: live ? "" : statusLabel(run.status) }),
      el("td", { class: "col-num mono", text: String(run.steps) }),
      el("td", { class: "col-num mono", text: duration(run.elapsedMs) }),
      el("td", { class: "col-num mono", text: money(run.costUsd) }),
      el("td", { class: "col-time", title: absoluteTime(run.startedAt), text: relativeTime(run.startedAt) }),
      actions,
    ]);
  }
}
