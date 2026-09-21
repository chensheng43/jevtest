/**
 * 断言求值：最终页面 / 动作轨迹 / 质量与成本。
 *
 * 泛化自参考项目 `examples/flights.py:18-38` 里那个硬编码的 verify()。
 * 那里的写法已经包含了正确的思想，本项目只是把它变成可声明的东西：
 *
 *     def verify(page):
 *         values = {a["label"].strip(): a.get("value") for a in page["actions"]}
 *         checks = {"origin": values.get("Where from?") == "Zürich", ...}
 *         return {"passed": all(checks.values()), "checks": checks}
 *
 * 三件必须保持的事：
 *
 *   1. **按语义标签定位，不按选择器。** 模型从头到尾看不到选择器，断言层依赖它
 *      就等于引入了一条模型看不见、而断言依赖的隐含契约。
 *
 *   2. **粒度为条目，不是整体。** `final.text.contains` 是一个数组，
 *      每一项产出独立的检查项（`final.text.contains[0]`）。报告要能指出
 *      「7 条里第 3 条没过」，而不是「text 没过」。
 *
 *   3. **`skipped` 既不是通过也不是失败。** 唯一已知场景是引擎的概率分布是
 *      degenerate（通用 LLM 只给一个选择）时，概率类检查失去意义。
 *      这时必须标 skipped 并在报告里显示「跳过」——**绝不能显示「通过」**，
 *      否则就是假通过，比失败更危险。
 *
 * 还有一条纪律：**断言绝不进入发给模型的请求**。让 agent 看见判分标准
 * 会诱导它对着答案演戏，也破坏策略的通用性（参考项目里 goal 与 verify 完全解耦）。
 */

import type { Assertions, ActionMatch, ControlAssertion, TextMatch } from "../schema/case.ts";
import type { RunStats, RunStatus } from "../schema/events.ts";
import type { AssertionResult, CheckResult, StepRecord } from "../schema/report.ts";
import type { Observation } from "../browser/session.ts";

export interface CheckContext {
  /** 最终页面。预算耗尽或崩溃时为 null，此时 final 族检查标为 skipped */
  final: Observation | null;
  history: StepRecord[];
  status: RunStatus;
  stats: RunStats;
  guardrailHits: { step: number; reason: string; action: string }[];
}

/**
 * 概率类断言的取样口径。
 *
 * 分布质量（`distribution`）**不在这里**，而是逐步从 `history` 读——
 * 它是**每次回答**的属性（`Answer.distribution` 已是必填），把它压成整轮一个值
 * 会造成二选一：过度 skip（丢掉真实的 full 覆盖），或漏 skip（假通过照旧发生）。
 * 而 §5.3 要防的假通过恰好只发生在 target 侧，正是被压平后最容易漏掉的那一半。
 */
export const PROBABILITY_SAMPLING = {
  /** 被护栏拦下的步（executed: false）没有执行，其概率不代表决策质量 */
  requiresExecuted: true,
  /**
   * 概率只在 `distribution === "full"` 的步上可求值。
   *
   * 虽然名字取自 operation 侧，但**两个 head 共用**这条要求；target 侧在此之上
   * 再加 `targetRequiresTarget`（见下条）。见 architecture.md §11.1 ① 的表。
   */
  operationRequiresFull: true,
  /** target 概率额外要求该步确实选了目标——DONE / BLOCKED / scroll / wait 都没有 target */
  targetRequiresTarget: true,
  /** 取 min 而非平均：要抓的是「某一步很犹豫」，平均会把它稀释掉 */
  aggregate: "min",
} as const;

/**
 * 检查项的聚合规则。
 *
 * `passed` 是**三态**的，因为检查项本身就是三态（见 CheckResult）：
 *
 * | 情况 | passed |
 * | --- | --- |
 * | 有任一 failed | `false` |
 * | 无 failed，但有 skipped | **`null`（未判定）** |
 * | 全部 passed | `true` |
 * | 没有任何检查项 | `null` |
 *
 * 中间那一行是关键：7 条通过、1 条因 degenerate 被跳过时，整体判 `null` 而非 `true`。
 * 判 `true` 就是 D9 要杜绝的谎报覆盖——我们确实没验证那一条。
 * 想要确定的结论，就不该用需要概率的断言。
 */
export function aggregateChecks(checks: Record<string, CheckResult>): boolean | null {
  const values = Object.values(checks);
  if (values.length === 0) return null;
  if (values.some((c) => !c.passed && !c.skipped)) return false;
  if (values.some((c) => c.skipped)) return null;
  return true;
}

// ---------------------------------------------------------------------------
// 内部构件
// ---------------------------------------------------------------------------

/**
 * 用例错误的统一前缀。
 *
 * 非法正则这类问题**不是「被测页面行为不符」，而是用例自己写错了**，
 * 必须显式说出来：静默当成「不匹配」会把用例 bug 伪装成被测站点 bug，
 * 排查的人会朝完全错误的方向查（去查页面、查正则的转义、查渲染）。
 *
 * 用 `failed` 而不是 `skipped` 收尾：`skipped` 在报告里表示「这次没验证」，
 * 会让 CI 看不出用例需要修；而一个跑不起来的断言确实不能算通过。
 */
const CASE_ERROR = "用例错误";

/** 详情一律压成一行并截断：它要进 Markdown 表格与报告列表，换行会把版式撑坏。 */
const DETAIL_CLIP = 200;

function clip(text: string, max = DETAIL_CLIP): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…（共 ${oneLine.length} 字符，已截断）`;
}

/** 命中位置附近的一段上下文。排查时「在哪儿出现/没出现」比整段文本更有用。 */
function contextOf(text: string, at: number, len: number, radius = 40): string {
  const from = Math.max(0, at - radius);
  const to = Math.min(text.length, at + len + radius);
  return `${from > 0 ? "…" : ""}${text.slice(from, to)}${to < text.length ? "…" : ""}`;
}

function pass(detail: string): CheckResult {
  return { passed: true, skipped: false, detail };
}

function fail(detail: string): CheckResult {
  return { passed: false, skipped: false, detail };
}

/**
 * 无法求值。
 *
 * 注意 `passed` 恒为 `false`：三态是 `(passed, skipped)` 两个字段合起来表达的，
 * `skipped: true` 才是「跳过」这一态的判据（见 `aggregateChecks`）。
 * 把 skipped 项写成 `passed: true` 就是 D9 要杜绝的假通过。
 */
function skip(detail: string): CheckResult {
  return { passed: false, skipped: true, detail };
}

type RegexOutcome = { re: RegExp } | { error: string };

function compileRegex(pattern: string): RegexOutcome {
  try {
    return { re: new RegExp(pattern) };
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
}

/** 正则非法时返回错误消息，合法返回 null。用于在调用 `matchAction` 之前先拦住用例错误。 */
function invalidRegexPattern(pattern: string | undefined): string | null {
  if (pattern === undefined) return null;
  const compiled = compileRegex(pattern);
  return "error" in compiled ? compiled.error : null;
}

/** 与 `Observation.actions` 结构兼容的最小子集：断言只关心这四样。 */
type ControlLike = { label: string; role?: string; value?: string; checked?: string };

/**
 * 从元素表里定位元素：先按 `labelContains`（子串，**区分大小写**），再用可选 `role` 消歧。
 *
 * 这里**刻意区分大小写**，与 `guard.ts` 里护栏标签的不区分大小写是相反的取舍，
 * 理由是不对称的：护栏是「宁可多拦」，多匹配是安全方向；而断言多匹配会变成
 * **假通过**（本没想断言的元素帮你把断言满足了），那是 D9 要杜绝的方向。
 * 需要宽容时用例可以把 labelContains 写短一点，那是作者显式做出的选择。
 *
 * `role` 不区分大小写：它是 ARIA 的固定词表（button / link / searchbox），
 * 大小写在这里从不携带语义。
 */
function locateControl(actions: ControlLike[], assertion: ControlAssertion): ControlLike | undefined {
  const wantedRole = assertion.role?.toLowerCase();
  return actions.find(
    (a) =>
      a.label.includes(assertion.labelContains) &&
      (wantedRole === undefined || (a.role ?? "").toLowerCase() === wantedRole),
  );
}

/** 定位条件的可读描述，出现在 report 的 detail 里。 */
function describeLocator(assertion: ControlAssertion): string {
  return assertion.role === undefined
    ? `label 含「${assertion.labelContains}」`
    : `label 含「${assertion.labelContains}」且 role=${assertion.role}`;
}

function describeMatch(m: ActionMatch): string {
  const parts: string[] = [];
  if (m.labelContains !== undefined) parts.push(`label 含「${m.labelContains}」`);
  if (m.labelMatches !== undefined) parts.push(`label 匹配 /${m.labelMatches}/`);
  if (m.role !== undefined) parts.push(`role=${m.role}`);
  if (m.kind !== undefined) parts.push(`kind=${m.kind}`);
  // 空匹配器匹配一切：这是安全的方向——`mustNotUse` 用空匹配器会立刻炸出来，
  // 而不是悄悄什么都不检查（用例格式要求「至少填一个」，校验在 schema 层）。
  return parts.length === 0 ? "任意动作（匹配器为空）" : parts.join("、");
}

/** 轨迹里前几个动作的标签，用于「什么都没匹配上」时的排查。 */
function labelPreview(history: StepRecord[], max = 5): string {
  const labels = history.slice(0, max).map((s) => `第 ${s.step} 步「${s.action}」`);
  const tail = history.length > max ? ` …共 ${history.length} 步` : "";
  return `${labels.join("、")}${tail}`;
}

/** 一步「有没有真的落到页面上」的可读描述。mustNotUse 靠它把「护栏拦住了」讲清楚。 */
function describeExecution(step: StepRecord): string {
  return step.executed
    ? `第 ${step.step} 步「${step.action}」executed: true——**护栏没有拦下**，浏览器收到了输入`
    : `第 ${step.step} 步「${step.action}」executed: false——已被护栏拦下（${step.blockReason ?? "原因未记录"}），浏览器没有收到任何输入`;
}

// ---------------------------------------------------------------------------
// final 族
// ---------------------------------------------------------------------------

/**
 * TextMatch 会产出哪些检查项 key。
 *
 * **稳定路径的生成规则**（`docs/report-format.md` §2.6）：key 就是断言文档里的
 * 结构路径，逐字对应 YAML——
 *   `final.url`、`final.text.contains[0]`、`final.controls[2].valueEquals`、
 *   `trajectory.mustNotUse[1]`、`quality.maxInputTokens`
 * 前缀 + 字段名 + 数组下标（下标紧跟在数组字段后面），标量匹配器用字段名本身
 * （`equals` / `valueEquals`）。
 *
 * 报告与前端都按这个路径定位，浏览器书签、前端高亮、Markdown 导出全靠它，
 * **生成规则不要随意改动**——改了会让旧报告里的路径在新界面里指不到东西。
 *
 * 求值与「final 为 null 时标 skipped」两条路径共用这个函数，
 * 保证同一份用例在两种情况下产出**完全相同的 key 集合**，界面才不会忽多忽少。
 */
function textMatchKeys(match: TextMatch, path: string): string[] {
  const keys: string[] = [];
  if (match.equals !== undefined) keys.push(`${path}.equals`);
  for (let i = 0; i < (match.contains?.length ?? 0); i++) keys.push(`${path}.contains[${i}]`);
  for (let i = 0; i < (match.notContains?.length ?? 0); i++) keys.push(`${path}.notContains[${i}]`);
  for (let i = 0; i < (match.matches?.length ?? 0); i++) keys.push(`${path}.matches[${i}]`);
  return keys;
}

/** `exists` 恒定产出（默认 true），其余属性各自一条。 */
function controlKeys(assertion: ControlAssertion, path: string): string[] {
  const keys = [`${path}.exists`];
  if (assertion.valueEquals !== undefined) keys.push(`${path}.valueEquals`);
  if (assertion.valueContains !== undefined) keys.push(`${path}.valueContains`);
  if (assertion.valueMatches !== undefined) keys.push(`${path}.valueMatches`);
  if (assertion.checked !== undefined) keys.push(`${path}.checked`);
  return keys;
}

function finalKeys(a: NonNullable<Assertions["final"]>): string[] {
  const keys: string[] = [];
  if (a.url !== undefined) keys.push(...textMatchKeys(a.url, "final.url"));
  if (a.title !== undefined) keys.push(...textMatchKeys(a.title, "final.title"));
  if (a.text !== undefined) keys.push(...textMatchKeys(a.text, "final.text"));
  (a.controls ?? []).forEach((c, i) => keys.push(...controlKeys(c, `final.controls[${i}]`)));
  return keys;
}

/** 文本匹配求值。数组的每一项单独产出结果。 */
export function matchText(actual: string, match: TextMatch, path: string): Record<string, CheckResult> {
  const checks: Record<string, CheckResult> = {};

  if (match.equals !== undefined) {
    const expected = match.equals;
    checks[`${path}.equals`] =
      actual === expected
        ? pass(`实际值与期望全等：${clip(actual)}`)
        : fail(`实际值「${clip(actual)}」与期望值「${clip(expected)}」不相等（全等比较）`);
  }

  (match.contains ?? []).forEach((needle, i) => {
    const at = actual.indexOf(needle);
    checks[`${path}.contains[${i}]`] =
      at >= 0
        ? pass(`已找到「${needle}」（第 ${at} 字符处）：${clip(contextOf(actual, at, needle.length))}`)
        : fail(`未找到「${needle}」。实际值：${clip(actual)}`);
  });

  (match.notContains ?? []).forEach((needle, i) => {
    const at = actual.indexOf(needle);
    checks[`${path}.notContains[${i}]`] =
      at < 0
        ? pass(`未出现「${needle}」（符合期望）`)
        : fail(`不应出现的「${needle}」出现在第 ${at} 字符处：${clip(contextOf(actual, at, needle.length))}`);
  });

  (match.matches ?? []).forEach((pattern, i) => {
    const key = `${path}.matches[${i}]`;
    const compiled = compileRegex(pattern);
    if ("error" in compiled) {
      checks[key] = fail(
        `${CASE_ERROR}：正则 /${pattern}/ 无法编译（${compiled.error}）。请修正用例里的 matches 模式后重跑——这不是被测页面的问题。`,
      );
      return;
    }
    checks[key] = compiled.re.test(actual)
      ? pass(`实际值匹配正则 /${pattern}/：${clip(actual)}`)
      : fail(`实际值不匹配正则 /${pattern}/。实际值：${clip(actual)}`);
  });

  return checks;
}

/** 元素断言求值：按 labelContains（可选 role）定位，再比属性。 */
export function matchControl(
  actions: { label: string; role?: string; value?: string; checked?: string }[],
  assertion: ControlAssertion,
  path: string,
): Record<string, CheckResult> {
  const checks: Record<string, CheckResult> = {};
  const where = describeLocator(assertion);
  const wantsExist = assertion.exists ?? true;
  const existsKey = `${path}.exists`;
  const el = locateControl(actions, assertion);

  /** 元素不在时把值类断言标 skipped：判 failed 会谎报「值不对」，而我们根本没有值可比。 */
  const skipValues = (reason: string): void => {
    for (const key of controlKeys(assertion, path)) {
      if (key !== existsKey) checks[key] = skip(`${reason}（${where}）`);
    }
  };

  if (el === undefined) {
    checks[existsKey] = wantsExist
      ? fail(`未定位到 ${where} 的元素（本次观测的元素表共 ${actions.length} 项）`)
      : pass(`未定位到 ${where} 的元素，符合 exists: false`);
    if (wantsExist) skipValues("元素不存在，该属性无从比较");
    else skipValues("用例要求此元素不存在；值类断言无从求值");
    return checks;
  }

  const actualValue = el.value;
  const rolePart = el.role === undefined ? "" : ` role=${el.role}`;
  const valuePart = actualValue === undefined ? "（无 value 属性）" : ` value=「${clip(actualValue, 80)}」`;
  checks[existsKey] = wantsExist
    ? pass(`已定位到元素：label「${el.label}」${rolePart}${valuePart}`)
    : fail(`元素确实存在（label「${el.label}」${rolePart}），但用例断言 exists: false`);

  if (assertion.valueEquals !== undefined) {
    checks[`${path}.valueEquals`] = compareValue(
      el,
      "valueEquals",
      `期望全等「${assertion.valueEquals}」`,
      (v) => (v === assertion.valueEquals ? null : `实际值「${clip(v)}」与期望全等的「${clip(assertion.valueEquals ?? "")}」不一致`),
    );
  }
  if (assertion.valueContains !== undefined) {
    checks[`${path}.valueContains`] = compareValue(el, "valueContains", `期望包含「${assertion.valueContains}」`, (v) =>
      v.includes(assertion.valueContains ?? "") ? null : `实际值「${clip(v)}」中不含「${assertion.valueContains}」`,
    );
  }
  if (assertion.valueMatches !== undefined) {
    const pattern = assertion.valueMatches;
    const compiled = compileRegex(pattern);
    checks[`${path}.valueMatches`] =
      "error" in compiled
        ? fail(`${CASE_ERROR}：valueMatches 的正则 /${pattern}/ 无法编译（${compiled.error}）。请修正用例后重跑。`)
        : compareValue(el, "valueMatches", `期望匹配正则 /${pattern}/`, (v) =>
            compiled.re.test(v) ? null : `实际值「${clip(v)}」不匹配正则 /${pattern}/`,
          );
  }
  if (assertion.checked !== undefined) {
    const wants = assertion.checked;
    const key = `${path}.checked`;
    if (el.checked === undefined) {
      checks[key] = fail(
        `元素 label「${el.label}」没有 checked 状态（不是复选框/单选框，或快照未采集），无法断言 checked: ${String(wants)}`,
      );
    } else {
      checks[key] =
        el.checked === String(wants)
          ? pass(`已定位到元素 label「${el.label}」，其 checked=${el.checked}，符合期望`)
          : fail(`元素 label「${el.label}」的 checked=${el.checked}，与期望的 ${String(wants)} 不符`);
    }
  }

  return checks;
}

/**
 * 值类属性的比较壳子。
 *
 * 抽出来的理由只有一个：**「元素没有这个属性」必须单独说明**。
 * 把它当成空字符串参与比较会得到「实际值 '' 不符」这种把人引向错误方向的结论——
 * 真相是快照里根本没有这个属性，问题多半出在断言把 labelContains 指到了别的元素。
 */
function compareValue(
  el: ControlLike,
  label: string,
  expectation: string,
  judge: (actual: string) => string | null,
): CheckResult {
  if (el.value === undefined) {
    return fail(
      `元素 label「${el.label}」在快照里没有 value 属性（该元素类型无可读值），无法比较 ${label}（${expectation}）。若这里本该有值，请检查用例的 labelContains 是否定位到了正确的元素。`,
    );
  }
  const reason = judge(el.value);
  return reason === null ? pass(`元素 label「${el.label}」的 value「${clip(el.value)}」，${expectation} —— 满足`) : fail(reason);
}

/** 最终页面族。 */
export function checkFinal(page: Observation | null, a: NonNullable<Assertions["final"]>): Record<string, CheckResult> {
  const checks: Record<string, CheckResult> = {};

  if (page === null) {
    // 预算在第一步之前就耗尽（或运行故障）时没有任何最终页面可看。
    // 这里是**未能求值**，不是失败：把「没看到页面」判成「页面不对」会让
    // 一份预算耗尽的报告看起来像业务失败，排查的人会一头雾水。
    const reason = "未能观测最终页面（没有可断言的页面快照），该断言无法求值";
    for (const key of finalKeys(a)) checks[key] = skip(reason);
    return checks;
  }

  if (a.url !== undefined) Object.assign(checks, matchText(page.url, a.url, "final.url"));
  if (a.title !== undefined) Object.assign(checks, matchText(page.title, a.title, "final.title"));

  if (a.text !== undefined) {
    const textChecks = matchText(page.text, a.text, "final.text");
    if (page.textTruncated) downgradeAbsenceFailures(textChecks, page.text.length);
    Object.assign(checks, textChecks);
  }

  (a.controls ?? []).forEach((assertion, i) => {
    const path = `final.controls[${i}]`;
    // 元素表被截断时，「找不到」不构成证据：快照为了控制模型上下文会丢掉一部分候选
    // （`Observation.omittedActions`）。
    //
    // **两个方向都要挡**，这条曾经只挡了 `exists: true`：
    //   - 断言存在却发现不了：判失败是**假失败**（元素可能正好在被丢掉的那部分里）；
    //   - 断言不存在却发现不了：判通过是**假通过**，而假通过正是 D9 要杜绝的方向
    //     ——我们并不知道那个元素是不是被省略了。
    // 只有「找到了」是正面证据，与表有没有被截断无关，因此那种情况照常往下走。
    if (page.omittedActions > 0 && locateControl(page.actions, assertion) === undefined) {
      const why = `元素表被截断（本次观测省略了 ${page.omittedActions} 个候选元素），无法据此断言 ${describeLocator(assertion)} 的元素不存在`;
      for (const key of controlKeys(assertion, path)) checks[key] = skip(why);
      return;
    }
    Object.assign(checks, matchControl(page.actions, assertion, path));
  });

  return checks;
}

/**
 * 文本被截断时，把「找不到」类的失败降级为 skipped。
 *
 * `Observation.text` 只装得下前若干字符（可见文本，见 `snapshot.js`）。
 * 截断的文本里找不到某个词，不能证明页面上没有这个词——判失败就是**假失败**，
 * 而假失败会引导人去改一个本来正确的用例。
 * `notContains` **不在此列**：在截断后的文本里命中了，说明它确实出现在可见文本里，
 * 那是真凭据。
 */
function downgradeAbsenceFailures(checks: Record<string, CheckResult>, textLength: number): void {
  for (const [key, result] of Object.entries(checks)) {
    if (result.passed || result.skipped) continue;
    if (key.endsWith(".notContains[") || key.includes(".notContains[")) continue;
    checks[key] = skip(
      `页面可见文本被截断（仅前 ${textLength} 字符参与比较），「未找到」不能作为证据：${result.detail}`,
    );
  }
}

// ---------------------------------------------------------------------------
// trajectory 族
// ---------------------------------------------------------------------------

/**
 * 动作匹配器。用于 mustUse / mustNotUse。
 *
 * 多个字段是**与**关系（全部满足才算命中）：每个字段都是作者写下的一个约束，
 * 「或」会让一个字段写错时匹配范围悄悄变大——而断言上的意外放大就是假通过。
 *
 * `labelMatches` 的**非法正则是用例错误，直接抛出**：这个函数只返回 boolean，
 * 没法把「用例写错了」和「没匹配上」区分开，静默返回 false 会把用例 bug
 * 伪装成「轨迹里没出现这个动作」。调用方（`checkTrajectory`）会先校验正则，
 * 正常路径下抛不出来。
 */
export function matchAction(step: StepRecord, match: ActionMatch): boolean {
  if (match.kind !== undefined && step.kind !== match.kind) return false;
  if (match.role !== undefined && (step.role ?? "").toLowerCase() !== match.role.toLowerCase()) return false;
  if (match.labelContains !== undefined && !step.action.includes(match.labelContains)) return false;
  if (match.labelMatches !== undefined) {
    const compiled = compileRegex(match.labelMatches);
    if ("error" in compiled) {
      throw new Error(`${CASE_ERROR}：labelMatches 的正则 /${match.labelMatches}/ 无法编译（${compiled.error}）`);
    }
    if (!compiled.re.test(step.action)) return false;
  }
  return true;
}

/**
 * 最长的一段「连续无进展」。
 *
 * 计入的步必须同时满足：
 *   - `executed: true`——被护栏拦下的步**按定义**没改变页面（浏览器没收到输入），
 *     把它算成「卡死」等于拿护栏生效去指责 agent；
 *   - `kind !== "wait"`——wait 本来就不该让页面变化；
 *   - `pageChanged === false`。
 *
 * `pageChanged === null` 是「没能观测」（例如导航打断了观测），**不是「没有变化」**，
 * 因此它既不计入，也打断连续段——把它当 false 会在正常导航时误判卡死
 * （见 `docs/report-format.md` §2.3）。
 */
function longestNoProgressRun(history: StepRecord[]): { length: number; from: number | null; to: number | null } {
  let best = 0;
  let bestFrom: number | null = null;
  let bestTo: number | null = null;
  let current = 0;
  let startedAt: number | null = null;

  for (const step of history) {
    const eligible = step.executed && step.kind !== "wait" && step.pageChanged === false;
    if (!eligible) {
      current = 0;
      startedAt = null;
      continue;
    }
    if (current === 0) startedAt = step.step;
    current += 1;
    if (current > best) {
      best = current;
      bestFrom = startedAt;
      bestTo = step.step;
    }
  }

  return { length: best, from: bestFrom, to: bestTo };
}

/** 轨迹族。按 label 匹配，不按内部 id——见 schema/case.ts 的 ActionMatch 说明。 */
export function checkTrajectory(
  history: StepRecord[],
  status: RunStatus,
  a: NonNullable<Assertions["trajectory"]>,
): Record<string, CheckResult> {
  const checks: Record<string, CheckResult> = {};

  // statusIn 判的是「循环怎么结束的」。
  const allowed = a.statusIn ?? ["done"];
  const allowedText = allowed.join(" / ");
  if (status === "queued" || status === "running") {
    // 循环还没结束，此刻比较毫无意义——标 skipped 而不是拿「还没 done」判失败。
    checks["trajectory.statusIn"] = skip(`运行尚未结束（status: ${status}），无法判断结束方式是否在 ${allowedText} 之内`);
  } else {
    checks["trajectory.statusIn"] = allowed.includes(status)
      ? pass(`运行以 ${status} 结束，在允许的 ${allowedText} 之内`)
      : fail(`运行以 ${status} 结束，不在允许的 ${allowedText} 之内`);
  }

  if (a.maxSteps !== undefined) {
    const limit = a.maxSteps;
    checks["trajectory.maxSteps"] =
      history.length <= limit
        ? pass(`实际走了 ${history.length} 步，未超过上限 ${limit} 步`)
        : fail(`实际走了 ${history.length} 步，超过上限 ${limit} 步`);
  }

  (a.mustUse ?? []).forEach((match, i) => {
    const key = `trajectory.mustUse[${i}]`;
    const patternError = invalidRegexPattern(match.labelMatches);
    if (patternError !== null) {
      checks[key] = fail(`${CASE_ERROR}：mustUse[${i}] 的 labelMatches 正则 /${match.labelMatches ?? ""}/ 无法编译（${patternError}）。请修正用例后重跑。`);
      return;
    }
    const hits = history.filter((step) => matchAction(step, match));
    // 只认**真的执行过**的步：`executed: false` 表示浏览器一个字节都没收到，
    // 「模型想做」不是「做过」。这与「模型的 DONE 不算证据」是同一条纪律。
    const executed = hits.filter((step) => step.executed);
    checks[key] =
      executed.length > 0
        ? pass(
            `轨迹第 ${executed.map((s) => s.step).join("、")} 步出现过匹配 ${describeMatch(match)} 的动作（如「${executed[0]?.action ?? ""}」）`,
          )
        : hits.length > 0
          ? fail(
              `匹配 ${describeMatch(match)} 的动作只出现在第 ${hits.map((s) => s.step).join("、")} 步，且都被护栏拦下（executed: false，浏览器未收到输入），不算真的用过`,
            )
          : fail(`轨迹中从未出现匹配 ${describeMatch(match)} 的动作。实际轨迹：${labelPreview(history)}`);
  });

  (a.mustNotUse ?? []).forEach((match, i) => {
    const key = `trajectory.mustNotUse[${i}]`;
    const patternError = invalidRegexPattern(match.labelMatches);
    if (patternError !== null) {
      checks[key] = fail(`${CASE_ERROR}：mustNotUse[${i}] 的 labelMatches 正则 /${match.labelMatches ?? ""}/ 无法编译（${patternError}）。请修正用例后重跑。`);
      return;
    }
    const hits = history.filter((step) => matchAction(step, match));
    // 这里**不**按 executed 过滤：mustNotUse 既是事后断言，也是运行时护栏，
    // 而「尝试去点删除」本身就是要报出来的事实。命中步的 executed 值写进 detail，
    // 报告里要能一眼看出护栏有没有生效。
    checks[key] =
      hits.length === 0
        ? pass(`轨迹中没有出现匹配 ${describeMatch(match)} 的动作（共 ${history.length} 步）`)
        : fail(`轨迹命中禁止动作 ${describeMatch(match)}：${hits.map(describeExecution).join("；")}`);
  });

  (a.forbiddenKinds ?? []).forEach((kind, i) => {
    const hits = history.filter((step) => step.kind === kind);
    checks[`trajectory.forbiddenKinds[${i}]`] =
      hits.length === 0
        ? pass(`轨迹中没有出现 ${kind} 类动作`)
        : fail(
            `轨迹出现了 ${hits.length} 个 ${kind} 类动作：${hits
              .slice(0, 3)
              .map((s) => `第 ${s.step} 步「${s.action}」${s.executed ? "" : "（已被护栏拦下）"}`)
              .join("、")}`,
          );
  });

  if (a.maxIdenticalConsecutive !== undefined) {
    const limit = a.maxIdenticalConsecutive;
    const key = "trajectory.maxIdenticalConsecutive";
    if (!Number.isInteger(limit) || limit < 1) {
      checks[key] = fail(`${CASE_ERROR}：maxIdenticalConsecutive 必须是 >= 1 的整数，收到 ${String(limit)}，该断言无法求值`);
    } else {
      const run = longestNoProgressRun(history);
      // 断言层只做**事后核对**：运行时的无进展检测在 agent 循环里
      // （连续 N 步无变化即终止为 blocked）。两者分工不同——
      // 循环负责止损，这里负责在报告里留下「确实卡过」的物证，
      // 二者用同一个阈值，用例改了阈值就同时改了刹车与断言。
      checks[key] =
        run.length >= limit
          ? fail(
              `最长连续 ${run.length} 步「页面无变化且非 wait」（第 ${String(run.from)}-${String(run.to)} 步），达到阈值 ${limit}，判为卡死`,
            )
          : pass(`最长连续无变化 ${run.length} 步，未达阈值 ${limit}（pageChanged 为 null 的步不计入：那是「没能观测」，不是「没有变化」）`);
    }
  }

  return checks;
}

// ---------------------------------------------------------------------------
// quality 族
// ---------------------------------------------------------------------------

interface ProbabilitySample {
  value: number;
  step: number;
}

/** 逐步取样的结果：可求值的样本 + 被过滤掉的原因计数（detail 里要讲清楚「为什么没有可求值的步」）。 */
interface ProbabilitySampling {
  samples: ProbabilitySample[];
  unexecuted: number;
  degenerate: number;
  noTarget: number;
}

/**
 * 概率取样。四条约束全部来自 `PROBABILITY_SAMPLING`，逐条都能单元测试：
 *   1. 只取 `executed: true` 的步；
 *   2. 只取 `distribution === "full"` 的步（degenerate 是合成的 one-hot 1.0，
 *      照它比较会假通过——这正是 §5.3 要防的，且**恰好发生在 target 侧**）；
 *   3. target 概率额外要求 `target != null`（DONE / BLOCKED / scroll / wait 都没有目标）；
 *   4. 聚合取 min（在调用方，`PROBABILITY_SAMPLING.aggregate`）。
 */
function sampleProbabilities(history: StepRecord[], head: "operation" | "target"): ProbabilitySampling {
  const out: ProbabilitySampling = { samples: [], unexecuted: 0, degenerate: 0, noTarget: 0 };

  for (const step of history) {
    if (PROBABILITY_SAMPLING.requiresExecuted && !step.executed) {
      out.unexecuted += 1;
      continue;
    }
    // degenerate 的分布是合成的，target 侧同样不能拿它比较——§5.3 的假通过
    // 就是从 target 侧溜进来的（「被选中项的概率」恒为 1.0）。
    //
    // 这条要求**两个 head 共用**，`operationRequiresFull` 就是它的开关
    // （常量不叫 requiresFull 是因为它随该约束的用例一起命名）。
    // 读常量而不是直接写死 `!== "full"`：否则那个开关拨到 false 也不会改变行为，
    // 而文件头声称「四条约束全部来自 PROBABILITY_SAMPLING」就成了空话。
    if (PROBABILITY_SAMPLING.operationRequiresFull && step.distribution !== "full") {
      out.degenerate += 1;
      continue;
    }
    if (head === "target" && PROBABILITY_SAMPLING.targetRequiresTarget && step.target === null) {
      out.noTarget += 1;
      continue;
    }
    out.samples.push({ value: head === "operation" ? step.operationProbability : step.probability, step: step.step });
  }

  return out;
}

/** 聚合（min / 平均由 `PROBABILITY_SAMPLING.aggregate` 决定）。取 min 才能抓住「某一步很犹豫」。 */
function aggregateSamples(samples: ProbabilitySample[]): ProbabilitySample | undefined {
  if (samples.length === 0) return undefined;
  if (PROBABILITY_SAMPLING.aggregate === "min") {
    return samples.reduce((worst, s) => (s.value < worst.value ? s : worst));
  }
  const mean = samples.reduce((sum, s) => sum + s.value, 0) / samples.length;
  return { value: mean, step: samples[0]?.step ?? 0 };
}

/** 把「为什么没有可求值的步」讲清楚——只说「跳过」而不说原因，等于什么都没说。 */
function describeSamplingFilters(s: ProbabilitySampling, head: string): string {
  const parts: string[] = [];
  if (s.unexecuted > 0) parts.push(`${s.unexecuted} 步被护栏拦下（executed: false）`);
  if (s.degenerate > 0) parts.push(`${s.degenerate} 步的分布是 degenerate（通用 LLM 只给一个选择，合成出的概率不代表决策质量）`);
  if (s.noTarget > 0) parts.push(`${s.noTarget} 步没有选中目标（DONE / BLOCKED / scroll / wait）`);
  return parts.length === 0 ? "本次运行没有任何步可供求值" : parts.join("；");
}

function checkProbabilityFloor(
  history: StepRecord[],
  head: "operation" | "target",
  limit: number,
  label: string,
): CheckResult {
  const sampling = sampleProbabilities(history, head);
  const worst = aggregateSamples(sampling.samples);

  if (worst === undefined) {
    // 无一步可求值时返回 skipped 而不是 passed：退化分布下概率恒为 1.0，
    // 判通过就是 D9 要杜绝的谎报覆盖。
    return skip(`无法求值：${describeSamplingFilters(sampling, label)}，${label}下限 ${limit} 没有可比较的对象`);
  }

  const evaluated = sampling.samples.length;
  const tail = `（在 ${evaluated} 步上求值，取最小值而非平均——平均会把「某一步很犹豫」稀释掉）`;
  return worst.value >= limit
    ? pass(`最低 ${label} ${worst.value.toFixed(3)} 出现在第 ${worst.step} 步，未低于下限 ${limit}${tail}`)
    : fail(`最低 ${label} ${worst.value.toFixed(3)} 出现在第 ${worst.step} 步，低于下限 ${limit}${tail}`);
}

/**
 * 质量与成本族。
 *
 * 收 `history` 而不收一个整轮的 `distribution`——分布质量是**每次回答**的属性，
 * 逐步读取才不会在 operation head 与 target head 质量不同时做出错误取舍。
 * 取样口径见 PROBABILITY_SAMPLING。
 *
 * 没有任何一步可求值（例如全部是 degenerate，或 history 为空）时，
 * 概率类检查返回 **skipped**，而不是通过。
 */
export function checkQuality(
  history: StepRecord[],
  stats: RunStats,
  a: NonNullable<Assertions["quality"]>,
): Record<string, CheckResult> {
  const checks: Record<string, CheckResult> = {};

  if (a.minOperationProbability !== undefined) {
    checks["quality.minOperationProbability"] = checkProbabilityFloor(
      history,
      "operation",
      a.minOperationProbability,
      "operation 概率",
    );
  }
  if (a.minTargetProbability !== undefined) {
    checks["quality.minTargetProbability"] = checkProbabilityFloor(
      history,
      "target",
      a.minTargetProbability,
      "target 概率",
    );
  }

  if (a.maxModelCalls !== undefined) {
    const retries = stats.modelCalls - stats.decisions;
    checks["quality.maxModelCalls"] =
      stats.modelCalls <= a.maxModelCalls
        ? pass(`实际 ${stats.modelCalls} 次模型调用（${stats.decisions} 次决策，含 ${retries} 次重试），未超过上限 ${a.maxModelCalls} 次`)
        : fail(`实际 ${stats.modelCalls} 次模型调用（${stats.decisions} 次决策，含 ${retries} 次重试），超过上限 ${a.maxModelCalls} 次`);
  }

  if (a.maxElapsedMs !== undefined) {
    const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)}s`;
    checks["quality.maxElapsedMs"] =
      stats.elapsedMs <= a.maxElapsedMs
        ? pass(`实际耗时 ${stats.elapsedMs}ms（${seconds(stats.elapsedMs)}），未超过上限 ${a.maxElapsedMs}ms`)
        : fail(`实际耗时 ${stats.elapsedMs}ms（${seconds(stats.elapsedMs)}），超过上限 ${a.maxElapsedMs}ms（${seconds(a.maxElapsedMs)}）`);
  }

  if (a.maxInputTokens !== undefined) {
    checks["quality.maxInputTokens"] =
      stats.inputTokens <= a.maxInputTokens
        ? pass(`实际 input ${stats.inputTokens} tokens，未超过上限 ${a.maxInputTokens}`)
        : fail(`实际 input ${stats.inputTokens} tokens，超过上限 ${a.maxInputTokens}`);
  }

  if (a.maxCostUsd !== undefined) {
    // 引擎未报金额时 costUsd 为 null（不用 0 冒充「未知」）。此时金额上限**无法求值**，
    // 标 skipped：判通过等于替一个我们根本不知道的数字背书。
    checks["quality.maxCostUsd"] =
      stats.costUsd === null
        ? skip(`无法求值：引擎未报金额（costUsd 为 null），无法与上限 $${a.maxCostUsd} 比较`)
        : stats.costUsd <= a.maxCostUsd
          ? pass(`实际金额 $${stats.costUsd.toFixed(4)}，未超过上限 $${a.maxCostUsd}`)
          : fail(`实际金额 $${stats.costUsd.toFixed(4)}，超过上限 $${a.maxCostUsd}`);
  }

  return checks;
}

// ---------------------------------------------------------------------------
// 入口
// ---------------------------------------------------------------------------

/**
 * 求值全部断言。
 *
 * 返回的 checks 的 key 是**稳定路径**，形如：
 *   final.url
 *   final.text.contains[0]
 *   final.controls[2].valueEquals
 *   trajectory.mustNotUse[1]
 *   quality.maxInputTokens
 * 报告与前端都按这个路径定位，因此生成规则不要随意改动。
 *
 * `passed` 由 `aggregateChecks` 聚合，取值是**三态**的——
 * 有 skipped 而无 failed 时判 `null`（未判定），不是 `true`。
 */
export function evaluateAssertions(assertions: Assertions, ctx: CheckContext): AssertionResult {
  const checks: Record<string, CheckResult> = {};

  // 三层合并成**一个** checks 对象：报告与界面只认一个平面命名空间，
  // 界面的定位、Markdown 的渲染、未来的 JUnit 映射都不必再知道「层」的概念。
  if (assertions.final !== undefined) {
    Object.assign(checks, checkFinal(ctx.final, assertions.final));
  }
  if (assertions.trajectory !== undefined) {
    Object.assign(checks, checkTrajectory(ctx.history, ctx.status, assertions.trajectory));
  }
  if (assertions.quality !== undefined) {
    Object.assign(checks, checkQuality(ctx.history, ctx.stats, assertions.quality));
  }

  // 没有任何检查项时 `passed` 为 null（未判定）：一份没有断言的用例跑完了，
  // 不构成「通过」的证据。这与 `aggregateChecks` 的规则一致。
  return { passed: aggregateChecks(checks), checks };
}

// 未在此处实现、也刻意不做的两件事：
//
//   1. **不因为 `status: "error"` 就跳过求值。** 断言层只看得到轨迹与最终页面，
//      它没有办法区分「页面真的不对」与「基建坏了」。而 case-format 的常见组合表
//      里 `error → passed: null` 是**调用方**的决定：runner 知道这次是运行故障，
//      可以选择不调用本函数、把报告的 `assertion` 留成 null。
//      断言层替它特判会引入一条看不见的耦合。
//   2. **不把 `guardrailHits` 当作断言输入。** 命中护栏的步已经以
//      `executed: false` + `blockReason` 落在 `StepRecord` 里，断言层从轨迹本身
//      就能看到它（`mustNotUse` 的 detail 会写明「已被护栏拦下」）。
//      再把 guardrailHits 接进来就是同一事实的第二份来源，两份迟早分叉。
