/**
 * 轨迹查看器：左边一列步骤，右边是所选那一步的画面与细节。
 *
 * 两种数据来源，同一套渲染：
 *   - 运行中：按事件（step.observed / decided / executed / guardrail.blocked）边收边拼，
 *     画面随观测实时出现——看得见 agent 此刻停在哪一页、打算点什么；
 *   - 结束后：换成报告里的 `steps` + `finalFrame`，那才是权威数据。
 *
 * 帧是**操作前画面**（`StepRecord.frame`）：这一步决策时看到的那一页。
 * 终止决策不产生 StepRecord，运行结束时那一页单独作为最后一项「结束」。
 */

import { el, icon, setChildren } from "../lib/dom.js";
import { operationLabel, statusLabel, verdictClass } from "../lib/runs.js";
import { duration, probability } from "../lib/format.js";
import { badge, facts } from "../ui/widgets.js";

/**
 * 这一步的目标，给人看的名字。决策事件里的 `target` 是元素表里的**序号**（「2」），
 * 只在那一次观测内有意义，拿来当标题只会让人困惑；可读的名字（`action`）要到执行后才有。
 */
function targetText(item) {
  if (item.action) return item.action;
  if (item.target && !/^\d+$/.test(String(item.target))) return item.target;
  return item.pending && item.operation ? "正在执行…" : "";
}

export function createTrace(runId) {
  /** 当前显示的条目（步骤 + 可选的「结束」项） */
  let items = [];
  let selected = -1;
  /** 用户自己点过某一步之后，就不再自动跟到最新一步 */
  let pinned = false;
  /** 运行中按步号拼出来的条目 */
  const liveSteps = new Map();
  let liveFinal = null;
  let fromReport = false;

  const list = el("ol", { class: "trace-steps", role: "listbox", tabindex: "0", "aria-label": "步骤" });
  const viewer = el("div", { class: "trace-viewer" });
  const node = el("div", { class: "trace" }, [
    el("div", { class: "trace-rail" }, [list]),
    viewer,
  ]);

  list.addEventListener("keydown", (event) => {
    const delta = event.key === "ArrowDown" || event.key === "j" ? 1 : event.key === "ArrowUp" || event.key === "k" ? -1 : 0;
    if (delta === 0 || items.length === 0) return;
    event.preventDefault();
    select(Math.min(items.length - 1, Math.max(0, selected + delta)), true);
  });

  function frameUrl(frame) {
    return `/api/runs/${runId}/frames/${frame}.jpg`;
  }

  function select(index, byUser = false) {
    if (index < 0 || index >= items.length) return;
    if (byUser) pinned = index !== items.length - 1;
    selected = index;
    for (const [position, child] of [...list.children].entries()) {
      const active = position === index;
      child.classList.toggle("is-selected", active);
      child.setAttribute("aria-selected", active ? "true" : "false");
      if (active && byUser) child.scrollIntoView({ block: "nearest" });
    }
    renderViewer(items[index]);
  }

  /** 第一次拿到数据之前（事件或报告）不说「等待观测」：对一次早已结束的运行那是错话 */
  let started = false;

  function render() {
    setChildren(list, items.map((item, index) => stepNode(item, index)));
    if (items.length === 0) {
      if (!started) {
        setChildren(viewer, []);
        selected = -1;
        return;
      }
      setChildren(viewer, [el("div", { class: "viewer-empty" }, [
        icon("image", 28),
        el("p", { text: fromReport ? "这次运行一步都没走：起始页还没观测到就结束了。原因见上方。" : "等待第一次观测…" }),
      ])]);
      selected = -1;
      return;
    }
    // 没点过就跟着最新一步走；点过就留在那一步（条目只会增加，下标仍然有效）
    const target = pinned && selected >= 0 && selected < items.length ? selected : items.length - 1;
    select(target);
  }

  function stepNode(item, index) {
    const state = item.final
      ? `final-${item.verdict}`
      : item.pending ? "pending" : item.executed === false ? "blocked" : "executed";
    const title = item.final
      ? el("div", { class: "step-title" }, [el("span", { text: item.pending ? "进行中" : "结束" }), el("span", { class: "step-target", text: item.pending ? "" : statusLabel(item.status) })])
      : el("div", { class: "step-title" }, [
          el("span", { class: "step-op", text: item.operation ? operationLabel(item.operation) : "观测中" }),
          el("span", { class: "step-target", text: targetText(item) }),
        ]);
    const meta = el("div", { class: "step-meta" });
    if (!item.final) {
      meta.append(el("span", { class: "mono", text: `#${item.step}` }));
      if (typeof item.probability === "number") meta.append(el("span", { class: "mono", title: "选中这个目标的概率", text: `p ${probability(item.probability)}` }));
      if (item.executed === false) meta.append(el("span", { class: "step-flag step-flag--blocked", text: "被护栏拦下" }));
      else if (item.pageChanged === false) meta.append(el("span", { class: "step-flag", text: "页面没变化" }));
      else if (item.pageChanged === null && !item.pending) meta.append(el("span", { class: "step-flag", text: "结果未观测到" }));
      if (item.text) meta.append(el("span", { class: "step-text", text: `“${item.text}”` }));
      if (item.notices?.length) meta.append(el("span", { class: "step-flag step-flag--notice", title: "这一步之后页面上的提示", text: `提示：${item.notices.join(" / ")}` }));
    } else if (item.url) {
      meta.append(el("span", { class: "mono step-url", text: item.url }));
    }
    const li = el("li", {
      class: "trace-step",
      role: "option",
      "data-state": state,
      onclick: () => select(index, true),
    }, [
      el("span", { class: "step-node", "aria-hidden": "true" }),
      el("div", { class: "step-body" }, [title, meta]),
      item.frame === null || item.frame === undefined ? null : icon("image", 14, "step-has-frame"),
    ]);
    return li;
  }

  function renderViewer(item) {
    const url = item.final ? item.url : item.urlBefore;
    const caption = item.final ? "运行结束时的画面" : "这一步操作之前的画面";
    const chrome = el("div", { class: "viewer-chrome" }, [
      el("span", { class: "viewer-dots", "aria-hidden": "true" }, [el("i"), el("i"), el("i")]),
      el("span", { class: "viewer-url mono", title: url ?? "", text: url ?? "（地址未知）" }),
      item.frame === null || item.frame === undefined
        ? null
        : el("a", { class: "viewer-open", href: frameUrl(item.frame), target: "_blank", rel: "noopener", title: "新标签页打开原图" }, [icon("external", 14)]),
    ]);

    let frame;
    if (item.frame === null || item.frame === undefined) {
      frame = el("div", { class: "viewer-empty" }, [
        icon("image", 28),
        el("p", {
          text: item.pending
            ? "画面还没到…"
            : "这一步没有截图：这次运行没开截图（JEVTEST_RECORD_FRAMES=off），或者截图失败了。",
        }),
      ]);
    } else {
      const img = el("img", { src: frameUrl(item.frame), alt: `${caption}（第 ${item.frame} 帧）`, decoding: "async" });
      img.addEventListener("error", () => {
        frame.replaceChildren(el("div", { class: "viewer-empty" }, [icon("image", 28), el("p", { text: `第 ${item.frame} 帧读不到：运行目录里的截图可能已被清理。` })]));
      });
      frame = el("a", { class: "viewer-image", href: frameUrl(item.frame), target: "_blank", rel: "noopener" }, [img]);
    }

    setChildren(viewer, [
      el("div", { class: "viewer-screen" }, [chrome, el("div", { class: "viewer-frame" }, [frame])]),
      el("p", { class: "viewer-caption", text: item.frame === null || item.frame === undefined ? caption : `${caption}，第 ${item.frame} 帧` }),
      details(item),
    ]);
  }

  function details(item) {
    if (item.final) {
      return facts([
        ["结束方式", statusLabel(item.status ?? "running")],
        item.failureReason ? ["原因", item.failureReason] : null,
        ["最终地址", el("span", { class: "mono break", text: item.url ?? "未观测到" })],
      ]);
    }
    const rows = [
      ["操作", el("span", {}, [
        el("strong", { text: item.operation ? operationLabel(item.operation) : "尚未决定" }),
        targetText(item) ? el("span", { text: ` ${targetText(item)}` }) : null,
      ])],
      item.role || item.kind ? ["控件", el("span", { class: "mono", text: [item.role, item.kind].filter(Boolean).join(" / ") })] : null,
      item.text ? ["输入的文本", el("span", {}, [el("span", { class: "mono", text: item.text }), item.textEngine ? el("span", { class: "hint-inline", text: `由 ${item.textEngine} 生成` }) : null])] : null,
      typeof item.probability === "number"
        ? ["概率", el("span", { class: "mono" }, [
            document.createTextNode(`目标 ${probability(item.probability)}`),
            typeof item.operationProbability === "number" ? document.createTextNode(`，操作 ${probability(item.operationProbability)}`) : null,
            typeof item.confidence === "number" ? document.createTextNode(`，置信 ${probability(item.confidence)}`) : null,
          ].filter(Boolean))]
        : null,
      item.distribution === "degenerate"
        ? ["", el("span", { class: "hint-inline", text: "这个引擎给不出真实分布，上面的概率是合成的单点值，依赖它的断言会被跳过。" })]
        : null,
      item.executed === false
        ? ["执行", el("span", {}, [badge("failed", "⊘", "被拦下"), el("span", { text: ` ${item.blockReason ?? ""}` })])]
        : item.pending ? null : ["执行", el("span", { text: "已执行" })],
      ["之前地址", el("span", { class: "mono break", text: item.urlBefore ?? "—" })],
      item.pending ? null : ["之后地址", el("span", { class: "mono break", text: item.urlAfter ?? "未观测到" })],
      item.pending
        ? null
        : ["页面变化", el("span", { text: item.pageChanged === null ? "未观测到（例如导航打断了观测），不代表动作没发生" : item.pageChanged ? "有" : "没有" })],
      item.notices?.length
        ? ["页面提示", el("span", {}, item.notices.map((notice) => el("div", { class: "break", text: notice })))]
        : null,
      typeof item.engineLatencyMs === "number"
        ? ["耗时", el("span", { class: "mono", text: `决策 ${duration(item.engineLatencyMs)}${item.textLatencyMs ? `，取值 ${duration(item.textLatencyMs)}` : ""}` })]
        : null,
      typeof item.observedMs === "number" ? ["时间点", el("span", { class: "mono", text: `开始后 ${duration(item.observedMs)}` })] : null,
    ];
    return facts(rows);
  }

  // -------------------------------------------------------------------------
  // 数据入口
  // -------------------------------------------------------------------------

  /** 报告到了：以报告为准，丢掉按事件拼出来的东西。 */
  function setReport(report) {
    started = true;
    fromReport = true;
    items = report.steps.map((step) => ({ ...step }));
    items.push({
      final: true,
      frame: report.finalFrame ?? null,
      url: report.finalUrl,
      status: report.status,
      verdict: verdictClass(report.status, report.passed),
      failureReason: report.failureReason,
    });
    // 一步都没走且没有最终帧：只留「结束」一项也没有信息量，交给空状态说明
    if (report.steps.length === 0 && (report.finalFrame ?? null) === null && report.finalUrl === null) items = [];
    render();
  }

  /** 运行中的事件。报告一旦到了就不再理会事件。 */
  function applyEvent(event) {
    if (fromReport) return;
    started = true;
    const entry = (step) => {
      if (!liveSteps.has(step)) liveSteps.set(step, { step, pending: true, frame: null, urlBefore: null });
      return liveSteps.get(step);
    };
    switch (event.type) {
      case "step.observed": {
        // 被丢弃的决策会以同一个步号重新观测：新的观测覆盖旧的
        liveSteps.set(event.step, { step: event.step, pending: true, frame: event.frame, urlBefore: event.url, observedMs: event.elapsedMs });
        break;
      }
      case "step.decided": {
        const item = entry(event.step);
        item.operation = event.operation;
        item.target = event.target;
        item.confidence = event.confidence;
        item.distribution = event.distribution;
        item.engineLatencyMs = event.engineLatencyMs;
        break;
      }
      case "step.executed": {
        const item = entry(event.step);
        Object.assign(item, {
          pending: false,
          action: event.action,
          kind: event.kind,
          operation: event.operation,
          probability: event.probability,
          executed: event.executed,
          text: event.text,
          urlAfter: event.url,
          pageChanged: event.pageChanged,
        });
        break;
      }
      case "guardrail.blocked": {
        Object.assign(entry(event.step), { pending: false, executed: false, blockReason: event.reason, action: event.action });
        break;
      }
      case "run.finished":
        liveFinal = { final: true, frame: null, url: null, status: event.status, verdict: verdictClass(event.status, event.passed) };
        break;
      default:
        return;
    }
    items = [...liveSteps.values()].sort((a, b) => a.step - b.step);
    // 最后一步若是终止决策（DONE / BLOCKED），它不会有 step.executed，按「进行中」画会误导
    const last = items[items.length - 1];
    if (last !== undefined && (last.operation === "DONE" || last.operation === "BLOCKED")) last.pending = false;
    if (liveFinal !== null) items.push(liveFinal);
    render();
  }

  render();
  return { node, setReport, applyEvent };
}
