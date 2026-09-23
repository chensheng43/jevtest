/**
 * 运行结果页（含实时进度）。
 *
 * 从上到下按「此刻要判断什么」排：
 *   1. 判决带：过没过（三态）、怎么结束的（status）——两件事分开写（D8）；
 *   2. 失败摘要：为什么没过——失败原因、失败的断言、护栏、登录跳转、准入警告；
 *   3. 轨迹：每一步看到了什么、做了什么（截图 + 细节）；
 *   4. 断言明细，按层分组；
 *   5. 原始事件，默认收起。
 *
 * 进度用轮询：`GET /api/runs/:id/events?since=<lastSeq>`，间隔 500ms。刷新页面从 0 重拉，
 * 即可回放出全部历史（事件是进程内的环形缓冲，服务重启后清空——那时只有报告）。
 */

import { el, button, hint, icon, setChildren, download } from "../lib/dom.js";
import { call, runCaseAndOpen } from "../lib/api.js";
import { checkGroup, checkLabel, ASSERTION_GROUPS } from "../lib/core.js";
import { isLive, looksLikeLoginRedirect, passedLabel, statusLabel, verdictClass, operationLabel } from "../lib/runs.js";
import { absoluteTime, count, duration, money, relativeTime } from "../lib/format.js";
import { onLeave } from "../lib/router.js";
import { busy, callout, errorSlot, toast } from "../ui/feedback.js";
import { checkBadge, disclosure, emptyState, menu, pageHead, section, skeleton, stats, verdictBadge } from "../ui/widgets.js";
import { createTrace } from "../components/trace.js";
import { loginGuide } from "../components/login.js";

const POLL_MS = 500;
/** 连续这么多次既无事件也无报告，就判定这个运行不会再有进展、停止轮询 */
const MAX_EMPTY_POLLS = 5;
/** 事件流最多留多少条 DOM 节点，避免长时间运行把页面撑大 */
const EVENT_NODES = 400;

export async function viewRun(app, runId) {
  let lastSeq = 0;
  let report = null;
  let finished = false;
  let firstPoll = true;
  let emptyPolls = 0;
  let caseId = null;
  let caseTitle = null;
  let timer = null;
  /** 收到 run.finished 之后还读不到报告的次数。落盘失败时报告永远不会出现，不能一直轮询下去 */
  let reportMisses = 0;
  /** 运行中从事件里数出来的进度 */
  const live = { step: -1, operation: null, elapsedMs: 0, modelCalls: 0 };

  onLeave(() => clearTimeout(timer));
  // 视图已被换掉：在途的请求回来之后必须就此停下，否则会继续往脱离的 DOM 里写
  const gone = () => !app.isConnected;

  const errors = errorSlot();
  const head = el("div");
  const band = el("div");
  const summary = el("div", { class: "run-summary" });
  const trace = createTrace(runId);
  const assertionsBox = el("div");
  const eventList = el("ol", { class: "events" });
  const eventCount = el("span", { class: "tab-badge" });
  const connection = el("p", { class: "poll-status", role: "status", hidden: true });

  app.replaceChildren(
    head,
    errors.node,
    band,
    connection,
    summary,
    section({ id: "run-trace", title: "轨迹", note: "左边选一步，右边看它**操作之前**的画面。键盘 ↑ ↓ 也能切换。", children: [trace.node], className: "panel--flush" }),
    section({ id: "run-assertions", title: "断言", children: [assertionsBox] }),
    disclosure("原始事件", [eventList], { summaryExtra: eventCount, className: "events-disclosure" }),
  );
  renderHead();
  renderBand();

  // -------------------------------------------------------------------------
  // 头部与操作
  // -------------------------------------------------------------------------

  function renderHead() {
    // 第一次轮询回来之前不知道它是不是还在跑：一次早已结束的运行不该闪一下「取消运行」
    const running = firstPoll ? false : report === null ? !finished : isLive(report.status);
    const actions = [];
    if (running) {
      const cancel = button("取消运行", { kind: "outline-danger", iconName: "stop" });
      cancel.addEventListener("click", () => busy(cancel, async () => {
        await call(`/api/runs/${runId}/cancel`, { method: "POST" });
        toast("已请求取消：会在当前这一步做完后停下，已经开始的浏览器操作不会做一半。", { tone: "info" });
      }));
      actions.push(cancel);
    }
    if (caseId !== null) {
      const rerun = button("重新运行", { kind: running ? "outline-secondary" : "primary", iconName: "play" });
      rerun.addEventListener("click", () => busy(rerun, () => runCaseAndOpen(caseId), { pending: "正在入队…" }));
      actions.push(rerun, el("a", { class: "btn btn-sm btn-outline-secondary", href: `#/case/${caseId}` }, [icon("edit", 15), el("span", { class: "btn-label", text: "编辑用例" })]));
    }
    if (report !== null) {
      actions.push(menu([
        ["导出 Markdown 报告", exportMarkdown, { iconName: "download" }],
        report.artifacts.traceZip ? ["下载 trace.zip", () => { location.href = `/api/runs/${runId}/trace.zip`; }, { iconName: "download" }] : null,
        ["查看原始报告 JSON", () => window.open(`/api/runs/${runId}`, "_blank", "noopener"), { iconName: "external" }],
      ]));
    }

    const meta = [el("span", { class: "mono", title: "运行 id", text: runId })];
    if (report !== null) {
      meta.push(
        el("span", { title: absoluteTime(report.startedAt), text: relativeTime(report.startedAt) }),
        el("span", { text: `引擎 ${report.engine || "未知"}` }),
        el("span", { class: "mono", title: "用例版本", text: `${report.caseId} r${report.caseRevision}` }),
      );
    }
    setChildren(head, [pageHead(caseTitle ?? caseId ?? "运行", {
      trail: [{ text: "运行", href: "#/runs" }, { text: runId }],
      meta,
      actions,
    })]);
  }

  async function exportMarkdown() {
    try {
      const text = await call(`/api/runs/${runId}/export?format=md`);
      download(`${runId}.md`, text, "text/markdown");
    } catch (error) {
      toast(`导出没有完成：${error.message}`, { tone: "danger" });
    }
  }

  // -------------------------------------------------------------------------
  // 判决带
  // -------------------------------------------------------------------------

  function renderBand() {
    if (firstPoll) {
      setChildren(band, [el("section", { class: "verdict-card" }, [skeleton()])]);
      return;
    }
    if (report === null || isLive(report.status)) {
      const where = live.step < 0 ? "正在打开起始页" : `第 ${live.step} 步${live.operation ? `：${operationLabel(live.operation)}` : ""}`;
      setChildren(band, [el("section", { class: "verdict-card running" }, [
        el("div", { class: "verdict-main" }, [
          verdictBadge("running", null),
          el("div", {}, [
            el("div", { class: "verdict-title", text: finished ? "运行已结束，正在读取报告…" : where }),
            el("div", { class: "verdict-sub", text: "断言在运行结束后求值。" }),
          ]),
        ]),
        stats([
          [String(Math.max(0, live.step + 1)), "步数"],
          [String(live.modelCalls), "模型请求"],
          [duration(live.elapsedMs), "已用时"],
        ]),
      ])]);
      return;
    }

    const s = report.stats;
    setChildren(band, [el("section", { class: `verdict-card ${verdictClass(report.status, report.passed)}` }, [
      el("div", { class: "verdict-main" }, [
        verdictBadge(report.status, report.passed),
        el("div", {}, [
          el("div", { class: "verdict-title", text: verdictSentence(report) }),
          el("div", { class: "verdict-sub" }, [
            el("span", { text: "结束方式：" }),
            el("strong", { text: statusLabel(report.status) }),
            report.status === "done" && report.passed !== true
              ? el("span", { class: "hint-inline", text: "「模型认为已完成」不是证据，判决只看断言。" })
              : null,
          ]),
        ]),
      ]),
      stats([
        [String(report.steps.length), "步数"],
        [String(s.modelCalls), "模型请求", `其中逻辑决策 ${s.decisions} 次，其余是重试与文本取值`],
        [`${count(s.inputTokens)} / ${count(s.outputTokens)}`, "token 入 / 出"],
        [duration(report.elapsedMs), "耗时", `决策引擎往返合计 ${duration(s.engineLatencyMs)}`],
        [money(s.costUsd), "成本", s.costUsd === null ? "引擎没有报金额" : null],
      ]),
    ])]);
  }

  function verdictSentence(r) {
    if (r.assertion === null) return "断言没有运行：运行在观测到页面之前就结束了";
    const checks = Object.values(r.assertion.checks);
    const failed = checks.filter((check) => !check.skipped && !check.passed).length;
    const skipped = checks.filter((check) => check.skipped).length;
    if (checks.length === 0) return "用例没有声明断言，因此无法判定";
    if (failed > 0) return `${failed} 条断言失败，共 ${checks.length} 条`;
    if (r.passed === true) return `全部 ${checks.length - skipped} 条断言通过${skipped > 0 ? `，另有 ${skipped} 条跳过` : ""}`;
    return `没有失败，但 ${skipped} 条检查无法求值（跳过），因此不算通过`;
  }

  // -------------------------------------------------------------------------
  // 失败摘要
  // -------------------------------------------------------------------------

  function renderSummary() {
    if (report === null || isLive(report.status)) {
      summary.replaceChildren();
      return;
    }
    const blocks = [];
    const failedChecks = report.assertion === null
      ? []
      : Object.entries(report.assertion.checks).filter(([, check]) => !check.skipped && !check.passed);

    if (report.failureReason) {
      blocks.push(callout(report.status === "error" ? "danger" : "warning", report.status === "error" ? "运行故障" : "为什么停下", [
        el("p", { class: "callout-text pre-wrap", text: report.failureReason }),
      ]));
    }
    if (failedChecks.length > 0) {
      blocks.push(callout("danger", "没通过的断言", [
        el("ul", { class: "check-list" }, failedChecks.map(([key, check]) => el("li", {}, [
          el("span", { class: "check-name", text: checkLabel(key) }),
          el("span", { class: "check-detail", text: check.detail }),
          el("code", { class: "issue-path", text: key }),
        ]))),
      ]));
    }
    for (const hit of report.guardrailHits) {
      blocks.push(callout("warning", `第 ${hit.step} 步被安全护栏拦下`, [
        el("p", { class: "callout-text" }, [el("span", { class: "mono", text: hit.action }), document.createTextNode(`：${hit.reason}。浏览器没有收到任何输入。`)]),
      ]));
    }
    if (report.admission && (!report.admission.ok || report.admission.warnings.length > 0)) {
      const lines = [
        ...report.admission.blocking.map((line) => el("li", { class: "is-blocking", text: line })),
        ...report.admission.warnings.map((line) => el("li", { text: line })),
      ];
      const list = el("ul", { class: "plain-list" }, lines);
      blocks.push(report.admission.ok
        ? disclosure(`准入检查有 ${report.admission.warnings.length} 条警告：结果可能打折扣`, [list, hint("准入是记录与警告，不阻止运行。")], { className: "admission-disclosure" })
        : callout("warning", "准入检查认为这个页面测不了", [list, "准入只是记录，不阻止运行；但这类失败多半是平台能力的边界，不是被测系统的缺陷。"]));
    }
    setChildren(summary, blocks);
    if (looksLikeLoginRedirect(report)) {
      const slot = el("div");
      summary.prepend(slot);
      void loginGuide(report).then((node) => {
        if (!gone()) slot.replaceChildren(node);
      });
    }
  }

  // -------------------------------------------------------------------------
  // 断言明细
  // -------------------------------------------------------------------------

  function renderAssertions() {
    if (report === null || isLive(report.status)) {
      setChildren(assertionsBox, [hint("运行结束后在这里逐条列出断言结果。")]);
      return;
    }
    if (report.assertion === null) {
      setChildren(assertionsBox, [hint("断言层没有运行（例如起始页还没打开就结束了）。这与「失败」是两回事。")]);
      return;
    }
    const entries = Object.entries(report.assertion.checks);
    if (entries.length === 0) {
      setChildren(assertionsBox, [hint("用例没有声明任何断言，因此判决是**未判定**。去编辑器里加几条，下次运行就能判定。")]);
      return;
    }
    // 失败的排前面，跳过的排最后：先看要处理的
    const rank = (check) => (check.skipped ? 2 : check.passed ? 1 : 0);
    const groups = ASSERTION_GROUPS.map((group) => ({
      ...group,
      rows: entries.filter(([key]) => checkGroup(key) === group.key).sort(([, a], [, b]) => rank(a) - rank(b)),
    })).filter((group) => group.rows.length > 0);
    const others = entries.filter(([key]) => !ASSERTION_GROUPS.some((group) => group.key === checkGroup(key)));
    if (others.length > 0) groups.push({ key: "other", label: "其他", rows: others });

    setChildren(assertionsBox, groups.map((group) => el("div", { class: "check-group" }, [
      el("h3", { class: "check-group-title", text: group.label }),
      el("table", { class: "table check-table" }, [
        el("tbody", {}, group.rows.map(([key, check]) => el("tr", { class: check.skipped ? "is-skipped" : check.passed ? "" : "is-failed" }, [
          el("td", { class: "check-verdict" }, [checkBadge(check)]),
          el("td", { class: "check-name" }, [
            el("div", { text: checkLabel(key) }),
            el("code", { class: "issue-path", text: key }),
          ]),
          el("td", { class: "check-detail", text: check.detail }),
        ]))),
      ]),
    ])));
  }

  // -------------------------------------------------------------------------
  // 事件
  // -------------------------------------------------------------------------

  function appendEvent(event) {
    eventList.querySelector(".events-placeholder")?.remove();
    const line = el("li", { class: `ev ev-${event.type.replace(".", "-")}` }, [
      el("time", { class: "ev-time mono", text: new Date(event.ts).toLocaleTimeString() }),
      el("span", { class: "ev-text", text: eventText(event) }),
    ]);
    eventList.append(line);
    while (eventList.children.length > EVENT_NODES) eventList.firstElementChild.remove();
    eventCount.textContent = String(lastSeq);
  }

  function refreshEventPlaceholder() {
    if (eventList.children.length > 0) return;
    const running = report !== null && isLive(report.status);
    eventList.append(el("li", {
      class: "ev events-placeholder",
      text: running || report === null
        ? "等待事件…"
        : "这次运行的事件已不在缓冲区（事件日志是进程内的，服务重启后清空）。轨迹与断言以报告为准。",
    }));
  }

  // -------------------------------------------------------------------------
  // 轮询
  // -------------------------------------------------------------------------

  const poll = async () => {
    try {
      const events = await call(`/api/runs/${runId}/events?since=${lastSeq}`);
      if (gone()) return;
      connection.hidden = true;
      for (const event of events) {
        lastSeq = Math.max(lastSeq, event.seq);
        appendEvent(event);
        trace.applyEvent(event);
        if (event.type === "run.queued" && caseId === null) caseId = event.caseId;
        if (event.type === "step.observed") {
          live.step = event.step;
          live.operation = null;
          live.elapsedMs = event.elapsedMs;
        }
        if (event.type === "step.decided") {
          live.operation = event.operation;
          live.modelCalls = event.modelCallsUsed;
        }
        if (event.type === "run.finished") finished = true;
      }
      // 报告要到运行结束、落盘之后才有：运行中去拉只会得到 404（浏览器还会为它打一行 console.error）。
      // 只在两种时候拉：收到了 run.finished；或者首次轮询一条事件都没有——那是一次
      // 早已结束、事件已不在缓冲区里的运行（服务重启过），只剩报告。
      if ((firstPoll && lastSeq === 0) || finished) {
        const fetched = await call(`/api/runs/${runId}`).catch(() => null);
        if (gone()) return;
        if (fetched !== null) report = fetched;
      }
      const needTitle = caseTitle === null && (caseId !== null || report !== null);
      if (report !== null) caseId = report.caseId;
      if (needTitle) {
        caseTitle = await call(`/api/cases/${caseId}`).then((loaded) => loaded.def.title).catch(() => null);
        if (gone()) return;
      }
      const wasFirst = firstPoll;
      firstPoll = false;

      if (report !== null) {
        trace.setReport(report);
        renderSummary();
        renderAssertions();
      } else if (wasFirst) {
        renderAssertions();
      }
      renderHead();
      renderBand();
      refreshEventPlaceholder();

      emptyPolls = report === null && lastSeq === 0 ? emptyPolls + 1 : 0;
      if (emptyPolls >= MAX_EMPTY_POLLS) {
        // 没有报告、也从没收到过任何事件：id 不存在，或服务重启前还在排队的运行
        app.replaceChildren(
          pageHead("找不到这次运行", { trail: [{ text: "运行", href: "#/runs" }, { text: runId }] }),
          emptyState({
            iconName: "runs",
            title: "没有这次运行的报告，也没有进度",
            text: "运行 id 可能不存在，或者它在服务重启前还没跑完（排队中的运行不会留下报告）。",
            actions: [el("a", { class: "btn btn-sm btn-primary", href: "#/runs", text: "回到运行列表" })],
          }),
        );
        return;
      }
      const running = !finished && (report === null || isLive(report.status));
      if (finished && report === null) {
        reportMisses += 1;
        if (reportMisses > 10) {
          errors.show(new Error("运行已经结束，但读不到它的报告：落盘可能失败了。展开下面的「原始事件」看 run.log 里的错误。"), { title: "报告缺失" });
          return;
        }
      }
      if (running || (finished && report === null)) timer = setTimeout(poll, POLL_MS);
    } catch (error) {
      if (gone()) return;
      // 只更新一行状态，不往事件里堆报错：以前每 2 秒多一条「拉取失败」
      connection.hidden = false;
      connection.textContent = `和服务的连接中断，正在重试…（${error.message}）`;
      timer = setTimeout(poll, POLL_MS * 4);
    }
  };
  await poll();
}

/** 一条事件的人话。 */
function eventText(event) {
  switch (event.type) {
    case "run.queued": return `已入队（用例 ${event.caseId}）`;
    case "run.started": return `开始运行（引擎 ${event.engine}）`;
    case "step.observed": return `第 ${event.step} 步：观测到 ${event.elementCount} 个可操作元素${event.omittedActions > 0 ? `（另有 ${event.omittedActions} 个被截断）` : ""}`;
    case "step.decided": return `第 ${event.step} 步：决定${operationLabel(event.operation)}${event.target ? ` ${event.target}` : ""}（引擎 ${duration(event.engineLatencyMs)}，累计第 ${event.modelCallsUsed} 次请求）`;
    case "step.executed": return `第 ${event.step} 步：${event.executed ? "已执行" : "被拦下"} ${event.action}`;
    case "step.skipped": return `第 ${event.step} 步：决策作废，重新观测（${event.reason}）`;
    case "guardrail.blocked": return `第 ${event.step} 步：护栏拦下 ${event.action}：${event.reason}`;
    case "assertion.evaluated": return `断言求值：共 ${event.total} 条，失败 ${event.failed.length}，跳过 ${event.skipped.length}`;
    case "run.finished": return `运行结束：${statusLabel(event.status)}，判决${passedLabel(event.passed)}`;
    case "run.log": return `[${event.level}] ${event.message}`;
    default: return event.type;
  }
}

