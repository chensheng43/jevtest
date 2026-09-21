/**
 * 引擎注册表：把「用例声明的引擎名」变成「可用的 DecisionEngine 实例」。
 *
 * 存在的意义是让引擎选择成为**用例级配置**而非全局常量：
 * `CaseDefinition.engine` 缺省走 settings.defaultEngine，
 * 因此可以在同一个套件里让两个用例跑不同引擎做 A/B 对比。
 */

import type { Settings } from "../config.ts";
import type { Case } from "../schema/case.ts";
import type { DecisionEngine } from "./types.ts";

export interface EngineContext {
  apiKey: string;
  model: string;
  settings: Settings;
}

export type EngineFactory = (ctx: EngineContext) => DecisionEngine;

/** 注册一个引擎。内置引擎在模块加载时自注册。 */
export function registerEngine(name: string, factory: EngineFactory): void {
  throw new Error("未实现：P0 待实现");
}

/** 列出已注册的引擎名与各自能力，供 `doctor` 与表单下拉框使用。 */
export function listEngines(): { name: string; text: boolean; probabilities: string }[] {
  throw new Error("未实现：P0 待实现");
}

/**
 * 按用例构造成引擎实例。
 *
 * 调用方负责在使用后 `close()`。runner 每跑一个用例构造一个实例，
 * 因此引擎的关闭时机与用例生命周期一致。
 */
export function createEngine(caseDef: Case, settings: Settings): DecisionEngine {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 注册 typesafe 与 scripted。createEngine 遇到未注册的名字须报错并列出可用引擎。
//
// ⚠️ scripted **不通过用例配置构造**。
//
// 曾经设计过一个 `engineOptions: Record<string, unknown>` 字段挂在 CaseDefinition 上，
// 用来把答案序列传进来。它是错的，原因有三：
//
//   1. scripted 是**测试专用**引擎。用例是给用户写的，用户不该在 YAML 里
//      看到「答案序列」这种测试脚手架。
//   2. 往「YAML 是唯一事实来源」这个契约里加一个自由形态字段，
//      要穿过 YAML 往返、冻结用例快照、caseDigest 三关，代价与收益不成比例。
//   3. 已经有更好的通路：`RunnerDeps.createEngine: (caseDef: Case) => DecisionEngine`
//      本身就是一个注入点。测试里直接传 `() => createScriptedEngine({steps})` 即可，
//      零 schema 变更。
//
// 生产用例永远不会声明 `engine: scripted`。
