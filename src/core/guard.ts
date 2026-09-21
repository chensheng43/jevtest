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
 */

import type { Case } from "../schema/case.ts";
import type { Action } from "../browser/session.ts";
import type { Observation } from "../browser/session.ts";
import { GuardrailBlocked } from "./errors.ts";

/**
 * 内置禁止动作。覆盖两类：
 *   - 破坏性动作：一旦点下去会产生真实副作用，测试不该碰；
 *   - 敏感输入：密码与文件上传，本平台不处理。
 *
 * 匹配的是**可访问名（label）的子串**，不区分大小写。
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
  "删除",
  "支付",
  "付款",
  "下单",
  "购买",
];

/** 内置禁止的角色/输入类型。 */
export const DEFAULT_DENY_ROLES: readonly string[] = ["password"];

/**
 * 校验 URL 是否在白名单内。越界抛 GuardrailBlocked。
 *
 * 比较的是 **origin**（协议+主机+端口），不是完整 URL：
 * 站内的路径跳转是正常的，跳出站点才需要拦。
 */
export function assertAllowedOrigin(caseDef: Case, url: string): void {
  throw new Error("未实现：P0 待实现");
}

/**
 * 检查一个动作是否被禁止。返回拦截原因，允许则返回 null。
 *
 * 只返回原因而不直接抛错，是为了让调用方能在报告里记录完整上下文
 * （哪一步、什么动作、为什么），而不是只留一句异常消息。
 */
export function checkAction(caseDef: Case, action: Action): string | null {
  throw new Error("未实现：P0 待实现");
}

/** checkAction 的抛错版本。命中即抛 GuardrailBlocked。 */
export function assertActionAllowed(caseDef: Case, action: Action): void {
  throw new Error("未实现：P0 待实现");
}

/**
 * 事后核对：轨迹里有没有不该出现的动作种类。
 *
 * 只读模式本该在构造阶段就杜绝变更型动作，这里再查一遍是因为
 * 「物理上不可能」和「我们相信它不可能」是两回事——报告需要证据。
 */
export function auditTrajectory(caseDef: Case, kinds: string[]): string | null {
  throw new Error("未实现：P0 待实现");
}

/**
 * 计算生效的禁止清单。用例的 guardrails 追加在内置集之上。
 * `allowDefaultOverride: true` 时才允许移除内置项。
 */
export function effectiveDenyList(caseDef: Case): { labels: string[]; roles: string[]; overridden: boolean } {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现五个函数。注意 checkAction 需要处理 select 的目标值——
//   原生 <select> 的 label 形如 "国家 → 中国"，禁止词可能出现在 option 部分。
// TODO(P0): assertAllowedOrigin 要在 goto 之前和 observe 之后各调一次，
//   前者的意义是「不许导航过去」，后者是「页面自己跳过去了」。
