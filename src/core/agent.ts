/**
 * 执行循环：观测 -> 决策 -> 护栏 -> 执行 -> 再观测。
 *
 * 移植自 jev-ultrafast 的 jev_ultrafast/agent.py:52-158（详见 NOTICE）。
 * 循环本身很短，难点全在几条**顺序敏感**的不变量上。它们不是风格问题，
 * 每一条都对应一个具体的、已经发生过的错误：
 *
 *   1. **决策先消费，再变更。**（`agent.py:90-91`）
 *      决定执行哪个动作之后立刻清空 decision，然后才动浏览器。
 *      否则一次陈旧重试会变成双击——在「提交订单」这种按钮上后果不必多说。
 *
 *   2. **浏览器变更从不重试。**（AGENTS.md 明确写下的一条）
 *      网络层可以重试，浏览器动作不可以。动作可能已经生效，只是我们没看到结果；
 *      重试就是执行两次。所以传输恢复逻辑绝不能包住 act()。
 *
 *   3. **先记执行日志，再观测结果。**（`agent.py:120-121`）
 *      执行完立即把 StepRecord 写进 history，然后才 observe()。
 *      如果反过来，一次恰好发生在观测时的导航就会让「我们点过了」这件事消失，
 *      轨迹里留下一个空洞，报告开始说谎。
 *
 *   4. **废弃的决策不产生副作用。**（`agent.py:88-89`）
 *      fingerprint 对不上就不执行，只重新观测。
 *
 *   5. **无进展检测。**（`agent.py:153-158`）
 *      连续 3 步页面无变化且不是 wait，判为 blocked。
 *      这是防「模型在同一个看不懂的页面上无限空转」的最后一道闸——也是最省钱的一道。
 *
 * Playwright 与参考项目的差异在这一层只体现为 `Session` 接口的调用，
 * 循环结构本身不需要变。这正是把浏览器层抽象成接口换来的东西。
 *
 * ---------------------------------------------------------------------------
 * 实现注记：几处文档没写死、由实现拍板的判断
 * ---------------------------------------------------------------------------
 *
 * - **步边界 = 每一次「观测 -> 决策」迭代的开头。** `signal.aborted` 只在那里查
 *   （以及首个迭代之前）。已经开始的 `session.act()` 会做完——取消不制造
 *   「点了一半」的状态（与不变量 2 同一条原则的两面）。
 *
 * - **decision 用一个局部 `const` 承载，整个类里没有任何字段持有它。**
 *   这就是不变量 1 在 TS 里的落点：决策的生命周期止于本次迭代，
 *   作用域外不存在的东西不可能被「再执行一次」。唯一跨迭代存活的是文本缓存，
 *   它按「整个 helper 输入完全相同」做键，且在任何一次成功变更后立即清空。
 *
 * - **`step` 从 0 开始，等于这条记录在 `history` 里的下标。** 一条被丢弃的陈旧决策
 *   会以同一个 `step` 号重新观测、重新决策（它没产生 StepRecord），因此
 *   `step.decided` 可能对同一个 `step` 出现两次——这是 `step.skipped` 存在的意义。
 *
 * - **`step.skipped` 只在一处发出：陈旧决策被丢弃时**（终止决策的新鲜度复查、
 *   以及 TYPE_TEXT 输入前的新鲜度复查）。被护栏拦下的那一步另有 `guardrail.blocked`，
 *   它是一条 `StepRecord(executed: false)`，不是「跳过」。
 *
 * - **本文件不发 `run.started` / `run.finished`。** `run.started` 由 runner 发（它按
 *   用例构造引擎，知道实际用的是哪个）；`run.finished` 也只能由 runner 发——只有它
 *   知道最终报告有没有被异常改写成 `error`，agent 是无法知道的。
 *
 * - **`frame` 恒为 null。** 截图开关（`RunOptions.recordFrames`）在 runner 手里，
 *   `AgentDeps` 里没有它，落盘路径也不在这里。要开截图得先把这条通路补上，见报告「遗留项」。
 */

import type { Case, CaseRevision } from "../schema/case.ts";
import type { EventSink, RunStatus } from "../schema/events.ts";
import type {
  AdmissionReport,
  AssertionResult,
  CaseRunReport,
  StepRecord,
} from "../schema/report.ts";
import type { DecisionEngine, DecisionResult, RecentActionIR, TextRequest } from "../engine/types.ts";
import type { Action, Observation, Session } from "../browser/session.ts";
import type { BudgetMeter } from "./budget.ts";
import type { Resolved } from "./policy.ts";

import { GuardrailBlocked, StalePage } from "./errors.ts";
import { admit } from "../browser/admission.ts";
import { assertAllowedOrigin, checkAction } from "./guard.ts";
import {
  RECENT_ACTIONS,
  buildActionSpace,
  buildDecisionRequest,
  isTerminal,
  resolveDecision,
} from "./policy.ts";
import { buildTextRequest, textContextKey } from "../engine/text.ts";
import { evaluateAssertions } from "./checks.ts";
import { buildReport } from "./report.ts";

/** 连续多少步无进展判为 blocked。用例可用 trajectory.maxIdenticalConsecutive 覆盖。 */
export const DEFAULT_NO_PROGRESS_LIMIT = 3;

export interface AgentDeps {
  session: Session;
  engine: DecisionEngine;
  /** 预算与墙钟。**不要在别处另开一份计时**——见 core/budget.ts 的说明 */
  budget: BudgetMeter;
  events: EventSink;
  /** 用例的断言**不在这里**——循环不知道判分标准，见 checks.ts */
  caseDef: Case;

  /**
   * 本次运行的 id。
   *
   * ⚠️ 这是对原冻结接口的一处**追加字段**（可选，既有构造点不受影响）。
   * 加它的原因：`RunEvent` 的每一个分支都要求 `runId`，报告的主键也是它，
   * 而原来的 `AgentDeps` 里没有任何地方能拿到它——不给这个字段，
   * agent 连一条合法事件都发不出来。由 runner 生成后传入。
   */
  runId?: string;
  /**
   * 用例版本标识，让报告自包含（D13）。生产由 `CaseStore.freeze()` 提供。
   * 缺省时回落到「来源未知」（revision 0 / 空 digest），报告里看得见。
   */
  caseRevision?: CaseRevision;
  /** 属于哪次批量运行；单跑为 null */
  suiteRunId?: string | null;
}

/** 一步的结局，`pushRecord` 用它填写 `StepRecord` 里执行侧的那几个字段。 */
interface StepOutcome {
  executed: boolean;
  blockReason: string | null;
  text: string | null;
  textEngine: string | null;
  textLatencyMs: number;
}

export class CaseAgent {
  private readonly deps: AgentDeps;
  private readonly runId: string;
  private readonly startedAt: string;
  private readonly revision: CaseRevision;
  private readonly suiteRunId: string | null;

  /** 走过的每一步。**这是断言层的核心输入**，任何终态下都要保留 */
  private readonly history: StepRecord[] = [];
  private readonly guardrailHits: { step: number; reason: string; action: string }[] = [];

  /**
   * 文本取值缓存，键是**整个 helper 输入的指纹**（`textContextKey`）。
   *
   * 只为一种情形存在：一次陈旧决策被丢弃后重走同一步，而页面上下文恰好一字未变——
   * 那时重新生成一遍纯属浪费。任何一次成功的浏览器变更之后立刻清空：
   * 页面变了，为旧页面生成的字段值不再可信（把上一步的地址填进这一步的输入框，
   * 是这条缓存唯一可能造成的伤害，所以宁可清得早一点）。
   */
  private readonly textCache = new Map<string, string>();

  private admission: AdmissionReport | null = null;
  /**
   * 准入探测**是否已经尝试过**。
   *
   * 与 `admission` 分开是必须的：探测失败时 `admission` 仍是 null，若拿它当归一
   * 标志，后面每一步都会再探一次（每一步都开一次页面级采集，还各发一条 warn）。
   * 「只采集一次」是硬要求——它是记录与警告，不是每步都要重算的东西。
   */
  private admissionProbed = false;
  private status: RunStatus = "running";
  private step = 0;
  /** 最近一次成功观测到的页面。断言层的 `final` 就是它 */
  private page: Observation | null = null;

  constructor(deps: AgentDeps) {
    this.deps = deps;
    // 没有 runId 时用占位空串，**不编造一个看起来像真的 id**。
    // 编造会让「事件里的 runId」与「真实的 runId」静默错位（报告与前端按它归并事件），
    // 而空串一眼就能看出「这条是占位」。真实值由 runner 两处补上：
    // 事件走盖章 sink（`runner.ts` 的 stampedSink），报告走 `completeReport()`。
    this.runId = deps.runId ?? "";
    this.startedAt = new Date().toISOString();
    this.suiteRunId = deps.suiteRunId ?? null;
    // revision/digest 缺失时不编造一个看起来正常的数字，而是留成「来源未知」：
    // revision 0 不是任何一次真实保存，digest 为空串也不匹配任何文件。
    this.revision = deps.caseRevision ?? {
      caseId: deps.caseDef.id,
      revision: 0,
      digest: "",
      savedAt: this.startedAt,
    };
  }

  /**
   * 跑完一个用例，返回完整报告。
   *
   * **不抛异常表示运行成功**，即使断言失败——`passed: false` 是正常返回值。
   * 只有意料之外的故障（引擎不可达、浏览器崩溃、模型输出不合法）才会让这里 throw，
   * 那种情况由 runner 捕获并写成 `status: "error"` 的报告。
   *
   * 预算耗尽、护栏拦截、用户取消都**不是异常**：它们以对应的 status 正常返回，
   * 且已产生的轨迹完整保留供断言求值。
   */
  async run(signal: AbortSignal): Promise<CaseRunReport> {
    const { session, engine, budget, events, caseDef } = this.deps;
    let failureReason: string | null = null;
    let noProgress = 0;
    // 用例可以用 trajectory.maxIdenticalConsecutive 覆盖这条闸的门槛。
    // 上游把 3 写死在代码里（agent.py:153-158），这里泛化成可配。
    const noProgressLimit =
      caseDef.assertions.trajectory?.maxIdenticalConsecutive ?? DEFAULT_NO_PROGRESS_LIMIT;

    loop: for (;;) {
      // ---- 步边界：取消只在这里生效 ----------------------------------------
      // 不能中断一次已经开始的浏览器变更，否则会留下「点了一半」的状态。
      // 这与「变更不重试」是同一条原则的两面。
      if (signal.aborted) {
        this.status = "cancelled";
        failureReason = "用户取消：在步边界停止（已经开始的浏览器变更会做完，不会留下做了一半的状态）";
        break loop;
      }

      // ---- 1. 观测 --------------------------------------------------------
      if (this.page === null) {
        // 首次：goto 之前先查白名单，意义是「不许导航过去」。
        // 越界抛 GuardrailBlocked——此时浏览器还没收到任何输入。
        assertAllowedOrigin(caseDef, caseDef.startUrl);
        this.page = await session.goto(caseDef.startUrl, { waitUntil: "domcontentloaded" });
      }
      const page = this.page;
      events.emit({
        type: "step.observed",
        runId: this.runId,
        step: this.step,
        url: page.url,
        elementCount: page.actions.length,
        omittedActions: page.omittedActions,
        // 截图通路未接（见文件头「实现注记」），如实报 null 而不是编一个序号
        frame: null,
        elapsedMs: budget.stats().elapsedMs,
      });

      // ---- 2. 仅第一次：准入探测 ------------------------------------------
      // 是记录与警告，**不是运行的闸**（§11.1 ⑥）。放在这里而不是入队时，
      // 因为入队时做要开页面，会让入队变慢。
      // 用独立的 `admissionProbed` 而不是 `admission === null` 做判据：探测失败时
      // 后者会让每一步都重探一次（见该字段的说明）。
      if (!this.admissionProbed) {
        this.admissionProbed = true;
        const stats = await this.probeAdmission();
        if (stats !== null) this.admission = admit(stats, caseDef);
      }

      // ---- 3. 域名白名单（观测之后） ---------------------------------------
      // 每次 goto 前查一次，每次观测后也查一次：后者防的是「页面自己跳走了」。
      // 放在决策之前，顺带省下一次模型调用。
      if (!this.originAllowed(page.url)) {
        failureReason =
          `页面已跳出白名单（当前 ${page.url}，允许 ${caseDef.allowedOrigins.join(" / ")}）；` +
          `越界之后发生的一切都不该算数，因此在此终止`;
        break loop;
      }

      // ---- 4. 预算 --------------------------------------------------------
      const budgetStatus = budget.check();
      if (budgetStatus.exceeded) {
        this.status = "budget_exceeded";
        // detail 里带上实际值与上限，用户才知道该调大哪一个维度
        failureReason = budgetStatus.detail;
        break loop;
      }

      // ---- 5. 决策 --------------------------------------------------------
      const space = buildActionSpace(page.actions, { mode: caseDef.mode });
      const request = buildDecisionRequest({
        caseDef,
        page,
        space,
        // 传副本：这次调用之后 history 还会继续增长，副本让「请求里看到的历史」
        // 与「当时的真实历史」严格一致。
        history: [...this.history],
        budget: budget.view(),
      });
      const decision = await engine.decide(request, signal);
      // RunStats 的唯一持有者是 BudgetMeter——这里绝不另开计数器。
      // 两个方法的分工见 budget.ts：decisions 记逻辑决策，modelCalls 按
      // `usage.requests` 累加（重试会使其大于 1，重试因此不是免费通道）。
      budget.recordDecision();
      budget.recordCall(decision.usage, decision.latencyMs);

      // ---- 6. 校验与解析 ---------------------------------------------------
      // 校验失败抛 InvalidDecision，**不执行任何动作**（这里不 catch：引擎输出
      // 不合法属于「意料之外的故障」，由 runner 写成 status: "error"，
      // 轨迹经 snapshot() 保留下来）。
      const resolved = resolveDecision(space, decision);

      // `resolved` 是本迭代的局部 const，作用域外不存在——这就是不变量 1
      // 「决策先消费，再变更」在本实现里的落点：没有任何字段能把它带回下一轮，
      // 所以一次陈旧重试不可能变成第二次点击。
      //
      // 事件在这一步之后才发（§2 把它画在 resolveDecision 之前）：`operation` 字段的
      // 类型是 `Operation`，在 resolveDecision 之前它只是模型回的一个字符串，
      // 要么断言成某个成员、要么编一个操作名——两种都是让事件说谎。
      // 正常路径下两种顺序产出完全相同的事件。
      events.emit({
        type: "step.decided",
        runId: this.runId,
        step: this.step,
        operation: resolved.operation,
        operationProbabilities: probabilitiesOf(decision, "operation"),
        target: resolved.target,
        targetProbabilities: probabilitiesOf(decision, `${resolved.operation.toLowerCase()}_target`),
        confidence: resolved.confidence,
        distribution: resolved.distribution,
        engineLatencyMs: decision.latencyMs,
        modelCallsUsed: budget.stats().modelCalls,
      });

      // ---- 7. 终止决策 -----------------------------------------------------
      if (isTerminal(resolved.operation)) {
        // 决策作出与结束之间页面可能已经变了：变了就不作数，重新观测。
        // DONE 建立在「它看到的那一页」上，页面换了则这个判断无意义。
        if (!(await session.isFresh(page))) {
          events.emit({
            type: "step.skipped",
            runId: this.runId,
            step: this.step,
            reason: "终止决策作出后页面已变化，丢弃该决策并重新观测（废弃的决策不产生副作用）",
          });
          this.page = await this.observeOnce();
          continue loop;
        }
        this.status = resolved.operation === "DONE" ? "done" : "blocked";
        failureReason =
          resolved.operation === "BLOCKED"
            ? "模型选择 BLOCKED：它认为当前页面上没有任何受支持的操作能继续推进"
            : null;
        break loop;
      }

      // ---- 8. 禁止动作护栏 -------------------------------------------------
      // 命中即**在执行前拦截**：浏览器收不到任何输入，StepRecord.executed 为 false，
      // 运行以 guardrail_blocked 结束。这是**好结果**——说明安全网起作用了。
      const blockReason = checkAction(caseDef, resolved.action);
      if (blockReason !== null) {
        this.pushRecord(resolved, page, decision, {
          executed: false,
          blockReason,
          text: null,
          textEngine: null,
          textLatencyMs: 0,
        });
        this.guardrailHits.push({
          step: this.step,
          reason: blockReason,
          action: resolved.action.label,
        });
        events.emit({
          type: "guardrail.blocked",
          runId: this.runId,
          step: this.step,
          reason: blockReason,
          action: resolved.action.label,
        });
        this.status = "guardrail_blocked";
        failureReason = `动作「${resolved.action.label}」命中安全护栏：${blockReason}（浏览器未收到任何输入）`;
        break loop;
      }

      // ---- 9. TYPE_TEXT：先取值 -------------------------------------------
      let text: string | null = null;
      let textEngine: string | null = null;
      let textLatencyMs = 0;
      if (resolved.operation === "TYPE_TEXT") {
        // 引擎不支持取值就**报错**，绝不用硬编码值兜底：
        // 一个填错的字段比一个填不上的字段难查得多，而且错值会流进断言。
        if (!engine.capabilities.text) {
          throw new Error(
            `引擎 ${engine.name} 不支持文本取值（capabilities.text 为 false），` +
              `无法为字段「${resolved.action.label}」生成输入值。` +
              `请改用支持取值的引擎，或把这一步改成不依赖 TYPE_TEXT 的用例。`,
          );
        }
        // 输入前的第二次新鲜度复查：这里是「决策 -> 变更」之间最后一道门。
        if (!(await session.isFresh(page, resolved.action))) {
          events.emit({
            type: "step.skipped",
            runId: this.runId,
            step: this.step,
            reason: "输入前复查发现页面已变化，丢弃这个陈旧的输入决策（不执行、不重试）",
          });
          this.page = await this.observeOnce();
          continue loop;
        }
        const generated = await this.writeText(resolved.action, page, signal);
        text = generated.text;
        textEngine = generated.textEngine;
        textLatencyMs = generated.textLatencyMs;
      }

      // ---- 10. 执行：**绝不重试** -----------------------------------------
      // 动作可能已经生效，只是我们没看到结果；重试就是执行两次。
      // 因此这里没有 try/catch、没有退避、没有重放。
      await session.act(resolved.action, page, text);
      // 变更成功 -> 页面已不同 -> 为旧页面生成的文本不再可信
      this.textCache.clear();

      // ---- 11. 先记执行日志，再观测结果 -----------------------------------
      // 顺序关键：一次恰好发生在观测时的导航，不能让「我们点过了」从轨迹里消失。
      budget.recordStep();
      const record = this.pushRecord(resolved, page, decision, {
        executed: true,
        blockReason: null,
        text,
        textEngine,
        textLatencyMs,
      });

      const next = await this.observeAfterAction();
      if (next === null) {
        // 观测失败 ≠ 没变化，也不代表动作没发生（report-format §2.3）。
        // 记 null 而不是 false：把观测失败当「无变化」会让正常导航被判成卡死。
        record.urlAfter = null;
        record.pageChanged = null;
        // 读操作可以重试（与「变更不重试」相对）：这里只是再读一次，没有副作用。
        this.page = await this.observeOnce();
      } else {
        record.urlAfter = next.url;
        record.pageChanged = next.fingerprint !== page.fingerprint;
        this.page = next;
      }
      record.observedMs = budget.stats().elapsedMs;

      // ---- 12. 无进展检测 --------------------------------------------------
      // **只有 `false` 计入连续计数。** null（观测失败）既不算无变化也不延续计数：
      // 把它当 false 会在页面正常导航时误判卡死，而那正是最容易发生 null 的时刻。
      if (record.pageChanged === false && resolved.operation !== "WAIT") {
        noProgress += 1;
      } else {
        noProgress = 0;
      }
      if (noProgress >= noProgressLimit) {
        this.status = "blocked";
        failureReason =
          `连续 ${noProgressLimit} 步页面无变化且都不是 wait：` +
          `模型在同一个页面上空转，判定为无法继续（这条闸也是最省钱的一条）`;
        break loop;
      }

      this.step += 1;
    }

    return this.finish(failureReason);
  }

  /**
   * 供界面显示当前进度，不改变状态。
   *
   * `guardrailHits` 一并给出，是为了让 runner 的异常终态也能**保留已有轨迹**：
   * 一次在护栏命中之后才崩掉的运行，报告里少了护栏那一条就没法解释它为什么停下。
   * （`admission` / `assertion` 不在这里——它们由 runner 在终止态报告里如实留 null：
   * 那两条路径上断言层根本没跑。）
   */
  snapshot(): {
    step: number;
    status: string;
    history: StepRecord[];
    guardrailHits: { step: number; reason: string; action: string }[];
  } {
    // 两张表都传副本：调用方（界面、runner 的失败兜底）不该能改动这条轨迹
    return {
      step: this.step,
      status: this.status,
      history: [...this.history],
      guardrailHits: this.guardrailHits.map((hit) => ({ ...hit })),
    };
  }

  // -------------------------------------------------------------------------
  // 循环内部的小动作
  // -------------------------------------------------------------------------

  /**
   * 求值断言并组装报告。
   *
   * 断言层只在**观测到过页面**时运行。一次连起始页都没打开就结束的运行
   * （被取消、起始 URL 越界、goto 就失败了）没有最终页面可供断言，
   * 这时 `assertion` 为 null——它是「断言层根本没跑」，
   * 与 `assertion.passed === null`（跑了但有检查无法求值）是两件事。
   */
  private finish(failureReason: string | null): CaseRunReport {
    const { caseDef, engine, events, budget } = this.deps;
    const stats = budget.stats();
    const assertion: AssertionResult | null =
      this.page === null
        ? null
        : evaluateAssertions(caseDef.assertions, {
            final: this.page,
            history: this.history,
            status: this.status,
            stats,
            guardrailHits: this.guardrailHits,
          });

    if (assertion !== null) {
      const entries = Object.entries(assertion.checks);
      events.emit({
        type: "assertion.evaluated",
        runId: this.runId,
        // ⚠️ 事件里的 passed 是 `boolean`，表达不了第三态（未判定）。
        // 三态只能从 `skipped` 与 `failed` 两个列表还原：
        // 「passed=false 且 failed=[] 而 skipped 非空」= 未判定。
        // 报告里的 `assertion.passed` 才是权威的 `boolean | null`。
        passed: assertion.passed === true,
        total: entries.length,
        failed: entries.filter(([, c]) => !c.passed && !c.skipped).map(([k]) => k),
        skipped: entries.filter(([, c]) => c.skipped).map(([k]) => k),
      });
    }

    return buildReport({
      runId: this.runId,
      caseDef,
      revision: this.revision,
      suiteRunId: this.suiteRunId,
      engine: engine.name,
      startedAt: this.startedAt,
      finishedAt: new Date().toISOString(),
      status: this.status,
      passed: assertion?.passed ?? null,
      failureReason,
      finalUrl: this.resolveFinalUrl(),
      steps: this.history,
      guardrailHits: this.guardrailHits,
      assertion,
      stats,
      admission: this.admission,
    });
  }

  /**
   * 最后一步的 `urlAfter`；它为空时问一次会话当前地址。
   *
   * 为什么不用「最后观测到的页面」当主源：`urlAfter` 是**动作之后**的地址，
   * 才是这次运行真正的落点；而观测失败时它是 null，此时才退到 currentUrl()。
   */
  private resolveFinalUrl(): string | null {
    const last = this.history[this.history.length - 1];
    if (last !== undefined && last.urlAfter !== null) return last.urlAfter;
    try {
      return this.deps.session.currentUrl();
    } catch {
      // 会话已经不可用（浏览器崩了）：退到最近一次观测到的地址，有总比没有强
      return this.page?.url ?? null;
    }
  }

  /**
   * 准入探测。**只吞 `probe()` 的失败**，不吞 `admit()` 的。
   *
   * 这条分界是有意的：`probe()` 要真浏览器，可能因为页面还没来得及稳定而失败，
   * 而准入结论只是记录与警告（不是闸），不该让一次运行因为一条附注而失败。
   * `admit()` 是纯函数，它抛错说明代码有问题——那种错必须浮出来。
   */
  private async probeAdmission(): Promise<import("../schema/report.ts").AdmissionStats | null> {
    try {
      return await this.deps.session.probe();
    } catch (error) {
      this.deps.events.emit({
        type: "run.log",
        runId: this.runId,
        level: "warn",
        message: `准入探测失败，本次运行不写入准入结论：${messageOf(error)}`,
      });
      return null;
    }
  }

  /** 观测一次。**读可以重试，变更不行**：导航恰好打断一次读取是正常现象。 */
  private async observeOnce(): Promise<Observation> {
    try {
      return await this.deps.session.observe();
    } catch (error) {
      if (error instanceof StalePage) return await this.deps.session.observe();
      throw error;
    }
  }

  /** 执行之后的观测：导航打断（StalePage）时返回 null，由调用方记成 `pageChanged: null`。 */
  private async observeAfterAction(): Promise<Observation | null> {
    try {
      return await this.deps.session.observe();
    } catch (error) {
      if (error instanceof StalePage) return null;
      throw error;
    }
  }

  /**
   * 域名白名单检查（观测之后那一次）。越界即终止，且已有轨迹保留。
   *
   * 只把 `GuardrailBlocked` 当成护栏命中；其它错误照常抛出去——
   * 把「护栏模块自己坏了」也算成「安全网起作用了」会让报告说谎。
   */
  private originAllowed(url: string): boolean {
    try {
      assertAllowedOrigin(this.deps.caseDef, url);
      return true;
    } catch (error) {
      if (error instanceof GuardrailBlocked) {
        this.status = "guardrail_blocked";
        this.guardrailHits.push({
          step: this.step,
          reason: messageOf(error),
          // 越界拦的不是某个动作，而是「页面停在了不该在的地方」，
          // 因此 action 位置记成当时的 URL。
          action: url,
        });
        this.deps.events.emit({
          type: "guardrail.blocked",
          runId: this.runId,
          step: this.step,
          reason: messageOf(error),
          action: url,
        });
        return false;
      }
      throw error;
    }
  }

  /**
   * TYPE_TEXT 的取值：先查缓存（键是整个 helper 输入的指纹），未命中才调引擎。
   *
   * 缓存只在「整个输入完全一致」时命中——目标字段、页面标题与文本、近期动作、
   * goal 有一项不同就是另一个键。这是 agent.py:110-114 那条规则的直译。
   */
  private async writeText(
    action: Action,
    page: Observation,
    signal: AbortSignal,
  ): Promise<{ text: string; textEngine: string | null; textLatencyMs: number }> {
    const { engine, budget, caseDef } = this.deps;
    const request: TextRequest = buildTextRequest({
      goal: caseDef.goal,
      action: { label: action.label, role: action.role ?? "", value: action.value ?? "" },
      page: { title: page.title, text: page.text },
      history: recentActions(this.history),
    });

    const key = textContextKey(request);
    const cached = this.textCache.get(key);
    if (cached !== undefined) {
      // 这一步没有调用引擎，「未调用则为 null」——如实报 null 而不是把上一次的
      // 引擎名借过来。文本本身是复用来的，`text` 字段仍然有值。
      return { text: cached, textEngine: null, textLatencyMs: 0 };
    }

    const result = await engine.writeText(request, signal);
    budget.recordCall(result.usage, result.latencyMs);
    if (result.text === null) {
      // 模型明说「目标里缺少必要信息」。绝不猜一个值填进去——
      // 宁可什么都不输入，也不要输入一个编造的护照号（rules.ts 的 TEXT_VALUE）。
      throw new Error(
        `文本引擎未能为字段「${action.label}」生成取值（返回 text: null，表示目标里缺少这个信息）。` +
          `请把该字段需要的内容写进用例的 goal，或改用不需要输入该字段的用例。`,
      );
    }
    this.textCache.set(key, result.text);
    return { text: result.text, textEngine: result.engine, textLatencyMs: result.latencyMs };
  }

  /**
   * 写一条 `StepRecord` 进 history 并发 `step.executed`。
   *
   * 调用它的两条路径：
   *   - 正常执行（executed: true）；
   *   - 被护栏拦下（executed: false，浏览器没收到任何输入）。
   *
   * `pageChanged` / `urlAfter` 留 null，由「先记日志再观测」之后的代码回填。
   * 事件也带着 null 发出去——这是刻意的：事件必须在观测之前发，
   * 否则一次在观测中崩掉的浏览器会让一条**确实发生过**的步骤从实时视图里消失，
   * 而那正是不变量 3 要防的那个空洞。权威的 pageChanged 在报告里。
   */
  private pushRecord(
    resolved: Resolved,
    page: Observation,
    decision: DecisionResult,
    outcome: StepOutcome,
  ): StepRecord {
    const record: StepRecord = {
      step: this.step,
      // 人类可读标签：轨迹断言按它匹配，而不是内部那个只在单次观测内有效的 id
      action: resolved.action.label,
      kind: resolved.action.kind,
      role: resolved.action.role ?? "",
      operation: resolved.operation,
      target: resolved.target,
      probability: resolved.probability,
      operationProbability: resolved.operationProbability,
      confidence: resolved.confidence,
      distribution: resolved.distribution,
      executed: outcome.executed,
      blockReason: outcome.blockReason,
      text: outcome.text,
      textEngine: outcome.textEngine,
      urlBefore: page.url,
      urlAfter: null,
      pageChanged: null,
      engineLatencyMs: decision.latencyMs,
      textLatencyMs: outcome.textLatencyMs,
      observedMs: this.deps.budget.stats().elapsedMs,
      frame: null,
      engineUsage: decision.usage,
    };
    this.history.push(record);
    this.deps.events.emit({
      type: "step.executed",
      runId: this.runId,
      step: record.step,
      action: record.action,
      kind: record.kind,
      // 用 `resolved.operation` 而不是 `record.operation`：后者的静态类型是 `string`
      // （`StepRecord.operation` 刻意留宽，见 report-format §2.3），而事件要求
      // `Operation`。这里的值本来就来自 `resolveDecision`，是货真价实的 `Operation`——
      // 直接用它，不必 cast 一个更宽的类型。
      operation: resolved.operation,
      probability: record.probability,
      executed: record.executed,
      text: record.text,
      // 动作**之前**的地址。之后那一个在报告里（`urlAfter`），实时视图由下一步的
      // `step.observed` 补上。
      url: page.url,
      pageChanged: record.pageChanged,
      elapsedMs: record.observedMs,
    });
    return record;
  }
}

/** 取某个 head 的概率分布。缺这个 head 时给空表而不是抛错——它只用于展示。 */
function probabilitiesOf(decision: DecisionResult, key: string): Record<string, number> {
  return decision.answers[key]?.probabilities ?? {};
}

/** 最近的若干步，供文本取值与决策请求参考（参考项目 model.py:113 取 10 条）。 */
function recentActions(history: StepRecord[]): RecentActionIR[] {
  return history.slice(-RECENT_ACTIONS).map((step) => ({
    action: step.action,
    kind: step.kind,
    text: step.text,
    pageChanged: step.pageChanged,
  }));
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
