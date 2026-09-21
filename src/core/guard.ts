/**
 * 安全护栏：三道闸，全部在**浏览器输入之前**生效。
 *
 * 与断言层的本质区别：断言是**事后**判断「做对了吗」，护栏是**事前**阻止「根本不许做」。
 * 一个动作被护栏拦下时，浏览器没有收到任何输入，`StepRecord.executed` 为 false，
 * 运行以 `guardrail_blocked` 结束——这是**好结果**，说明安全网起作用了。
 *
 * 三道闸：
 *
 *   1. **域名白名单**。每次 goto 前与每次观测后比对 origin。越界即终止。
 *      防的是「agent 顺着一个外链跑出了被测系统」——那之后发生的一切都不该算数。
 *
 *   2. **只读模式**。注意它**不在这里实现**，而是在 `policy.ts` 的 buildActionSpace 里：
 *      变更型操作根本不会进入候选集。本文件只负责事后核对
 *      「轨迹里确实没出现过变更型动作」，作为第二道保险与断言依据。
 *
 *   3. **禁止动作清单**。内置默认集 + 用例追加。命中即在执行前拦截。
 *
 * **内置默认集只增不减。** 用例只能追加规则，不能移除默认规则；
 * 要移除必须显式设置 `allowDefaultOverride: true`，且报告顶部会打红色横幅。
 * 这个设计是为了让「悄悄关掉安全网」变得困难——默认安全，放弃安全需要明说。
 *
 * 本文件里所有判定都是**纯函数**：只读 `Case` 与 `Action`，不碰浏览器、不碰网络。
 * 因此三道闸全部可以离线回归（见 tests/guardrails.test.ts）。
 */

import type { Case, Guardrail } from "../schema/case.ts";
import type { Action } from "../browser/session.ts";
import type { ActionKind } from "../schema/events.ts";
import { GuardrailBlocked } from "./errors.ts";
import { MUTATING_OPERATIONS } from "./policy.ts";

/**
 * 内置禁止动作。覆盖三类：
 *   - 破坏性动作：一旦点下去会产生真实副作用，测试不该碰；
 *   - 敏感输入：密码与文件上传，本平台不处理（见 docs/limitations.md §4）；
 *   - 不可控的浏览器交互：文件选择器是**原生对话框**，Playwright 无法关掉它，
 *     点下去会让运行挂到超时——这是「拦下比放行更省事」的典型。
 *
 * 匹配的是**可访问名（label）的子串**，不区分大小写。
 *
 * 这份清单是**保守**的：宁可多拦（用例改一行就能通过），不可少拦（真副作用已经发生）。
 */
export const DEFAULT_DENY_LABELS: readonly string[] = [
  "delete",
  "remove account",
  "purchase",
  "buy now",
  "pay",
  "checkout",
  "place order",
  "transfer",
  "unsubscribe",
  "cancel subscription",
  // 文件上传：snapshot.js 已经不会把 input[type=file] 放进元素表，但**自定义上传控件**
  // （一个隐藏的 file input + 一个看起来像按钮的 <button>Upload</button>）会进。
  // 少了这两条，那种站点上就会点开原生文件对话框，运行卡死到超时。
  "upload",
  "删除",
  "支付",
  "付款",
  "下单",
  "购买",
  "上传",
];

/**
 * 内置禁止的角色/输入类型。
 *
 * `password`：凭据不进入自动化流程。注意这条在当前实现下**几乎不会触发**——
 * `snapshot.js` 的 `safe()` 与 playwright-session 的元素表都把 `type=password`
 * 直接过滤掉了（`snapshot.js:47`、`playwright-session.ts:448`）。
 * 留着它是为了不把安全押在另一层的实现细节上：换一个 Session 实现、
 * 或上游改了 safe 黑名单，这里仍然拦得住。
 *
 * `file` 同理：`input[type=file]` 现在进不了元素表，但 role 报成 `file` 的实现
 * （或将来支持上传时的中间态）会在这里被拦下。
 */
export const DEFAULT_DENY_ROLES: readonly string[] = ["password", "file"];

/**
 * 原生下拉的动作 label 形如 `"国家 → 中国"`（`snapshot.js:109` 用
 * `base.label + ' → ' + o.label` 拼出来）。分隔符是**带空格的 U+2192**。
 *
 * 这里另抄一份而不是从 `policy.ts` import：那会扩大一个**冻结契约**文件的导出面。
 * 判定本身不依赖这个常量——整串 label 本来就包含两个半边，切分只用来把
 * 「命中在哪一边」写进拦截原因；切不开时退化成整串匹配，不会漏判（见 labelParts）。
 */
const SELECT_LABEL_SEPARATOR = " → ";

/** 拦截原因里引用的片段。太长会把报告撑满，而人只需要认出是哪个元素。 */
const MAX_EVIDENCE_CHARS = 60;

/**
 * 校验 URL 是否在白名单内。越界抛 GuardrailBlocked。
 *
 * 比较的是 **origin**（协议+主机+端口），不是完整 URL：
 * 站内的路径跳转是正常的，跳出站点才需要拦。
 *
 * 调用点是两次（`agent.ts`）：goto 之前——意义是「不许导航过去」；
 * 每次观测之后——意义是「页面自己跳过去了」。
 */
export function assertAllowedOrigin(caseDef: Case, url: string): void {
  const actual = originOf(url);
  const allowed = allowedOriginsOf(caseDef);

  if (actual !== null && allowed.includes(actual)) return;

  // 消息里必须同时有**实际值**与**白名单**：只说「越界了」的报告没法排查
  // （是站点跳了、还是白名单少写了一条？），而这两件事的处置完全不同。
  throw new GuardrailBlocked(
    actual === null
      ? `域名白名单拦截：${JSON.stringify(url)} 解析不出 http/https 的 origin，` +
          `无法证明它在白名单内，按越界处理（白名单：${allowed.join(" / ")}）`
      : `域名白名单拦截：实际 origin 是 ${actual}，白名单是 ${allowed.join(" / ")}`,
  );
}

/**
 * 取一个 URL 的 origin。**不可解析、非 http(s) 一律返回 null，由调用方按越界处理。**
 *
 * 为什么是 fail-closed 而不是「解析不了就放行」：白名单的全部价值在于
 * 「能证明这次导航落在允许范围内」。证明不了就必须拦——否则一个畸形 URL
 * 就成了绕过白名单的通道。
 *
 * 具体防的是这两个失败模式：
 *   - `new URL("file:///etc/passwd").origin` 是**字符串** `"null"`，若把它当 origin
 *     参与比对，所有非 http 站点（file: / data: / about:）会互相匹配，
 *     白名单退化成「随便跳」。`schema/case.ts:251` 的 `isHttpUrl` 挡的是同一件事；
 *   - `new URL("about:blank")` 能解析成功但没有同源概念，同样不能放行。
 */
function originOf(value: string): string | null {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    return parsed.origin;
  } catch {
    // 空串、相对路径、`javascript:` 之类都会走到这里。
    return null;
  }
}

/**
 * 把白名单的每一项也归一化成 origin。
 *
 * `schema/case.ts` 的 `originSchema` 已经做过一次转换，这里再兜一次是因为
 * `Case` 也可以被手工构造（测试、回读冻结用例、别的入口直接拼对象），
 * 而那些路径不保证经过 zod。容忍整条 URL（`https://a.com/wiki/Main_Page`
 * → `https://a.com`）比让白名单因为一条多余路径而静默失配安全得多。
 *
 * 连 origin 都解析不出来的条目**原样保留**：它永远匹配不上一个合法的
 * http origin（那种情况上面已经按越界拦下了），保留它只会让错误消息
 * 显示出用户实际写的那一行，便于排查。
 */
function allowedOriginsOf(caseDef: Case): string[] {
  return caseDef.allowedOrigins.map((entry) => originOf(entry) ?? entry);
}

/**
 * 检查一个动作是否被禁止。返回拦截原因，允许则返回 null。
 *
 * 只返回原因而不直接抛错，是为了让调用方能在报告里记录完整上下文
 * （哪一步、什么动作、为什么），而不是只留一句异常消息。
 * 需要抛错的场合用 `assertActionAllowed`。
 *
 * 判据分三层，任一层命中即拦：
 *   ① 内置禁止角色（password / file）——**无条件**，它们的用途不是消歧，
 *      而是「这类控件一律不碰」；
 *   ② 内置禁止词——不区分大小写的子串匹配；
 *   ③ 用例声明的护栏——见 `matchGuardrail`（同一条护栏里的条件取 AND）。
 */
export function checkAction(caseDef: Case, action: Action): string | null {
  const parts = labelParts(action);
  const role = normalizedRole(action.role);
  const builtin = builtinDeny(caseDef);

  // ① 内置禁止角色。
  if (role !== null) {
    const hit = builtin.roles.find((denied) => denied.toLowerCase() === role);
    if (hit !== undefined) {
      // 原因里写清「这类控件为什么不能碰」，读报告的人才知道该改用例还是改站点。
      return (
        `该动作的角色是「${action.role}」，命中内置禁止角色（${DEFAULT_DENY_ROLES.join(" / ")}）：` +
        `密码框不进自动化流程；文件选择器会打开原生对话框，Playwright 关不掉它，运行会挂到超时`
      );
    }
  }

  // ② 内置禁止词。**每个片段都要查**，而不是只查整串 label——见 labelParts。
  for (const part of parts) {
    const word = builtin.labels.find((denied) => containsIgnoreCase(part.text, denied));
    if (word !== undefined) {
      // 说清三点：命中的是哪个词、出现在动作的哪一部分、以及「这条规则删不掉」的正当路径。
      // 缺了最后一点，读完报告的人只会得出「平台在乱拦」的结论。
      return (
        `该动作的${part.where}「${brief(part.text)}」命中内置禁止词「${word}」（内置清单只增不减，` +
        `要用例移除需显式 allowDefaultOverride，见 decisions.md D14）`
      );
    }
  }

  // ③ 用例护栏。内置集之上追加，且**内置集关不关都不影响这里的判定**——
  //    关掉默认护栏不等于关掉用户自己写的那几条。
  for (const guardrail of caseDef.guardrails) {
    const evidence = matchGuardrail(guardrail, parts, role);
    if (evidence !== null) {
      return `命中用例护栏：${guardrail.reason}（${evidence}）`;
    }
  }

  return null;
}

/** checkAction 的抛错版本。命中即抛 GuardrailBlocked。 */
export function assertActionAllowed(caseDef: Case, action: Action): void {
  const reason = checkAction(caseDef, action);
  if (reason === null) return;
  // 复述动作 label：异常可能被上层单独捕获，那时上下文只剩这条消息。
  throw new GuardrailBlocked(
    `动作「${action.label}」被安全护栏拦下：${reason}（浏览器未收到任何输入）`,
  );
}

/**
 * 事后核对：轨迹里有没有不该出现的动作种类。
 *
 * 只读模式本该在构造阶段就杜绝变更型动作，这里再查一遍是因为
 * 「物理上不可能」和「我们相信它不可能」是两回事——报告需要证据。
 *
 * 返回 null 表示没有发现问题（或**这个用例不适用这项核对**）。
 * 非只读用例直接返回 null：变更型动作在交互模式下本来就合法，
 * 「轨迹里出现了 fill」不是问题；那种「不许出现某类动作」的诉求由用例的
 * `assertions.trajectory.forbiddenKinds` 表达，归 `checks.ts` 求值，
 * 不在这里重复一遍（重复会让同一个问题在报告里出现两条结论）。
 *
 * 已知边界：判据只有**动作种类**，看不到 click 的 role。因此只读模式下
 * 「点了一个按钮」这一类比 `kinds` 更细的越界查不出来——那一层由
 * `buildActionSpace` 的构造期剔除负责，本函数只是补一道事后证据。
 */
export function auditTrajectory(caseDef: Case, kinds: string[]): string | null {
  if (caseDef.mode !== "readonly") return null;

  const offending = [...new Set(kinds.filter((kind) => MUTATING_KINDS.includes(kind)))];
  if (offending.length === 0) return null;

  return (
    `只读用例的轨迹里出现了变更型动作：${offending.join(" / ")}。` +
    `这类动作在构造阶段就该被剔除出候选集，模型物理上无法选中——` +
    `出现即说明动作空间构造被绕过（或 Session 直接执行了不在候选集里的动作），必须查明`
  );
}

/**
 * 计算生效的禁止清单。用例的 guardrails 追加在内置集之上。
 * `allowDefaultOverride: true` 时才允许移除内置项。
 *
 * **这是一份给人看的扁平视图**（报告、Web 界面展示「本用例生效的护栏是什么」），
 * 不是判据本身：`labelMatches` 是正则、`role` 可能与 label 条件是 AND 关系，
 * 两者都装不进 `string[]`。判据的权威在 `checkAction` / `matchGuardrail`，
 * 本函数只保证「清单里有什么」说得准（尤其是 `overridden` 这条横幅信号）。
 *
 * `overridden` 为 true 意味着**内置护栏没有生效**，调用方必须打红色横幅（D14）：
 * 平台不阻止人关掉安全网，但要求留痕。它取的是标志位本身而不是「是否真的少拦了什么」——
 * 「这个用例关掉了内置护栏」这件事本身就该被看见，哪怕它同时把内置项又抄了一遍。
 */
export function effectiveDenyList(caseDef: Case): { labels: string[]; roles: string[]; overridden: boolean } {
  const builtin = builtinDeny(caseDef);
  const labels = [...builtin.labels];
  const roles = [...builtin.roles];

  for (const guardrail of caseDef.guardrails) {
    if (guardrail.labelContains !== undefined) labels.push(guardrail.labelContains);
    if (guardrail.role !== undefined) roles.push(guardrail.role);
  }

  return { labels, roles, overridden: caseDef.allowDefaultOverride };
}

// ---------------------------------------------------------------------------
// 内部
// ---------------------------------------------------------------------------

/**
 * 当前生效的**内置**护栏。`allowDefaultOverride` 为真时清空——
 * 这就是「移除内置项」的唯一入口，也是 D14 里那句「放弃安全需要明说」的落点。
 *
 * 置空而不是逐条删除：`Guardrail` schema 里**没有**「删除某一条内置规则」的语法
 * （只有 labelContains / labelMatches / role / reason 四个字段，且 reason 必填、
 * 语义是「命中时怎么向人解释」）。所以合法用例无法表达「我要删掉 delete 这一条」，
 * 能表达的只有「这个用例自己声明整套护栏」——于是 override 的语义只能是
 * **替换**：内置集整体退出，用例声明什么就是什么（想让某条内置规则继续生效，
 * 就把它抄进用例的 guardrails 里，这是刻意留的显式动作）。
 */
function builtinDeny(caseDef: Case): { labels: readonly string[]; roles: readonly string[] } {
  if (caseDef.allowDefaultOverride === true) return { labels: [], roles: [] };
  return { labels: DEFAULT_DENY_LABELS, roles: DEFAULT_DENY_ROLES };
}

/** 一个动作里需要拿禁止词去查的文本片段。 */
interface LabelPart {
  /** 命中时写进拦截原因的说明，例如「选项名」。 */
  where: string;
  text: string;
}

/**
 * 一个动作的所有可查文本。
 *
 * 为什么不能只查整串 label：原生 `<select>` 的 label 是
 * `"字段名 → 选项名"` 拼出来的（`snapshot.js:109`），禁止词可能落在**任一半边**上，
 * 而报告需要说清是哪一边命中的——「国家 → 删除账号」与「删除 → 中国」
 * 是两种不同的站点，处置也不同。
 *
 * 顺序有意：先精确的两边，最后才是整串兜底。这样命中的片段越具体越好读。
 * 整串兜底防的是「label 不是 `X → Y` 形状」的实现（自定义 Session 只给选项名）。
 *
 * 选项的 `value` 也查：它是站点内部的标识（`snapshot.js:108`），
 * 而 label 可能是本地化文案——`<option value="purchase">Kaufen</option>` 的
 * label 不含任何内置英文词，只查 label 会让整个非英文站点的破坏性动作漏过去。
 * 这个 value 只在本函数里被读，**绝不进请求**（模型看不到它，见 policy.ts 的 targetDetail）。
 */
function labelParts(action: Action): LabelPart[] {
  const parts: LabelPart[] = [];

  if (action.kind === "select") {
    const at = action.label.indexOf(SELECT_LABEL_SEPARATOR);
    if (at >= 0) {
      parts.push({ where: "字段名", text: action.label.slice(0, at) });
      parts.push({ where: "选项名", text: action.label.slice(at + SELECT_LABEL_SEPARATOR.length) });
    }
    if (action.value !== undefined && action.value !== "") {
      parts.push({ where: "选项值", text: action.value });
    }
  }

  parts.push({ where: "可访问名", text: action.label });
  return parts;
}

/**
 * 一条用例护栏是否命中。返回 null 表示不命中，否则返回「命中了什么」。
 *
 * **同一条护栏里的所有条件取 AND**（role + label 都写了就都要成立）。
 * 依据是 `schema/case.ts` 里 `role` 的注释——「用于消歧」：role 的作用是把
 * 一条过宽的 label 收窄，若取 OR，`labelContains: Delete, role: button`
 * 会连一个叫 Delete 的链接一起拦掉，与作者写这两个条件时的意图相反。
 * 这个语义与 `checks.ts` 的动作匹配器（`stepMatches` 逐个条件 return false）
 * 保持一致，同一份 YAML 在两个地方不会得出相反结论。
 */
function matchGuardrail(guardrail: Guardrail, parts: LabelPart[], role: string | null): string | null {
  const evidence: string[] = [];

  if (guardrail.role !== undefined) {
    const wanted = guardrail.role.trim().toLowerCase();
    if (role === null || role !== wanted) return null;
    evidence.push(`role=${guardrail.role}`);
  }

  // 先落成局部量：闭包里 `guardrail.labelContains` 的收窄会丢失，
  // 用 `as string` 绕过等于把这个条件的存在性交给断言而不是类型。
  const contains = guardrail.labelContains;
  if (contains !== undefined) {
    const part = parts.find((candidate) => containsIgnoreCase(candidate.text, contains));
    if (part === undefined) return null;
    evidence.push(`${part.where}含「${contains}」`);
  }

  if (guardrail.labelMatches !== undefined) {
    const hit = matchRegex(guardrail.labelMatches, parts);
    if (hit === null) return null;
    evidence.push(`${hit.where}匹配 /${guardrail.labelMatches}/（${brief(hit.text)}）`);
  }

  // schema 要求护栏至少有一个条件，所以走到这里一定有 evidence。
  // 万一没有（手工构造的 Case），返回 null 而不是「命中」：
  // 一条没有任何条件的护栏按「什么都不匹配」处理，与 ActionMatch 的口径一致。
  if (evidence.length === 0) return null;
  return evidence.join(" 且 ");
}

/**
 * 在若干片段上试一个正则，返回第一个命中的片段。
 *
 * 正则编译失败时按**命中**处理（fail-closed）：`schema/case.ts` 的 `regexPattern`
 * 在保存时就校验可编译性，所以走到这里的只可能是手工构造或回读出来的坏用例。
 * 那种情况下这条护栏已经**不可能拦住任何东西**了——静默失效正是 D14 说的
 * 「安全网被悄悄关掉」，所以宁可拦下并报「正则写坏了」，让人去修用例。
 *
 * 不用 `g` 标志（`new RegExp(pattern)` 不带 flags）：带 `g` 的 `test()` 会靠
 * `lastIndex` 记住上次位置，同一个正则连续查多个片段会漏掉命中。
 */
function matchRegex(pattern: string, parts: LabelPart[]): { where: string; text: string } | null {
  let compiled: RegExp;
  try {
    compiled = new RegExp(pattern);
  } catch {
    return { where: "正则无法编译", text: pattern };
  }
  for (const part of parts) {
    if (compiled.test(part.text)) return { where: part.where, text: part.text };
  }
  return null;
}

/** 角色归一化。空串与 undefined 都算「没有角色」，不参与角色判据。 */
function normalizedRole(role: string | undefined): string | null {
  if (role === undefined) return null;
  const value = role.trim().toLowerCase();
  return value === "" ? null : value;
}

/** 子串匹配，不区分大小写。`needle` 为空白时不算命中——空字符串是「匹配一切」。 */
function containsIgnoreCase(haystack: string, needle: string): boolean {
  const value = needle.trim().toLowerCase();
  if (value === "") return false;
  return haystack.toLowerCase().includes(value);
}

/** 错误信息里引用的片段，截断以保住报告的可读性。 */
function brief(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= MAX_EVIDENCE_CHARS ? flat : `${flat.slice(0, MAX_EVIDENCE_CHARS)}…`;
}

/**
 * 只读模式禁止的**动作种类**，由 `policy.ts` 的 `MUTATING_OPERATIONS` 反推而来。
 *
 * 不另抄一份清单：只读模式的候选集怎么裁、事后核对查什么，必须是**同一份事实**。
 * 两处各写一份的话，将来加了变更型操作（比如上传），漏改的那一处会静默放行。
 */
const OPERATION_TO_KIND: Record<string, ActionKind> = { TYPE_TEXT: "fill", SELECT: "select" };

const MUTATING_KINDS: readonly string[] = MUTATING_OPERATIONS.flatMap((operation) => {
  const kind = OPERATION_TO_KIND[operation];
  return kind === undefined ? [] : [kind];
});
