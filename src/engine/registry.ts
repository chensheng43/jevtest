/**
 * 引擎注册表：把「用例声明的引擎名」变成「可用的 DecisionEngine 实例」。
 *
 * 存在的意义是让引擎选择成为**用例级配置**而非全局常量：
 * `CaseDefinition.engine` 缺省走 settings.defaultEngine，
 * 因此可以在同一个套件里让两个用例跑不同引擎做 A/B 对比。
 */

import type { Settings } from "../config.ts";
import type { Case } from "../schema/case.ts";
import type { DecisionEngine, EngineCapabilities } from "./types.ts";
import { createTypeSafeEngine, TYPESAFE_ENGINE_NAME } from "./typesafe.ts";

export interface EngineContext {
  apiKey: string;
  model: string;
  settings: Settings;
}

export type EngineFactory = (ctx: EngineContext) => DecisionEngine;

/**
 * scripted 引擎的默认名。
 *
 * 只为在错误信息里给出针对性提示而留（见 `unknownEngine`）。**不 import
 * `engine/scripted.ts`**：注册表不注册它，import 进来会让人以为注册表认识它。
 * 取值必须与 `createScriptedEngine` 的默认 name 一致。
 */
const SCRIPTED_ENGINE_NAME = "scripted";

/** 注册表内部条目。能力在注册那一刻读一次并缓存，见 `probeCapabilities`。 */
interface EngineEntry {
  factory: EngineFactory;
  capabilities: EngineCapabilities;
}

/**
 * 已注册的引擎。用 Map 而不是普通对象：引擎名来自用例（不可信输入），
 * 而对象字面量会把 `constructor` / `__proto__` 这类名字变成原型上的成员——
 * 查表时命中一个「看起来存在」的东西，比查不到危险得多。
 */
const REGISTRY = new Map<string, EngineEntry>();

/** 注册一个引擎。内置引擎在模块加载时自注册。 */
export function registerEngine(name: string, factory: EngineFactory): void {
  const key = name.trim();
  if (key === "") {
    throw new Error("引擎名不能为空：注册表用它查表，空名字会让用例无法指定这个引擎。");
  }
  // 同名**覆盖而不是报错**：内置引擎是自注册的，测试与将来的插件需要能替换它
  // （例如注入一个假 typesafe）。这里没有日志通道可警告，而「启动即崩」的代价
  // 明显高于「后注册者胜出」——后者至少是可预期的。
  REGISTRY.set(key, { factory, capabilities: probeCapabilities(factory) });
}

/** 列出已注册的引擎名与各自能力，供 `doctor` 与表单下拉框使用。 */
export function listEngines(): { name: string; text: boolean; probabilities: string }[] {
  return [...REGISTRY.entries()]
    .map(([name, entry]) => ({
      name,
      text: entry.capabilities.text,
      // 复制而不是把引擎的 capabilities 对象直接暴露出去：它是实例上的对象，
      // 拿到的调用方（HTTP 处理器）若改了它，会顺着引用改掉注册表本身。
      probabilities: entry.capabilities.probabilities,
    }))
    // 按名字排序，而不是按注册顺序：下拉框的顺序不该因 import 顺序调整而变化。
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/**
 * 按用例构造成引擎实例。
 *
 * 调用方负责在使用后 `close()`。runner 每跑一个用例构造一个实例，
 * 因此引擎的关闭时机与用例生命周期一致。
 */
export function createEngine(caseDef: Case, settings: Settings): DecisionEngine {
  const requested = resolveEngineName(caseDef, settings);
  const entry = REGISTRY.get(requested);
  if (entry === undefined) throw unknownEngine(requested);

  return entry.factory(engineContext(requested, settings));
}

// ---------------------------------------------------------------------------
// 内部实现
// ---------------------------------------------------------------------------

/**
 * 用例声明的引擎名，缺省退到 `settings.defaultEngine`。
 *
 * `CaseDefinitionSchema` 已经给了 `engine` 默认值 `"typesafe"`，所以主路径上
 * 这里拿到的总是非空串。仍然判一次空是因为本函数也接受**未经 schema 解析**的对象
 * （测试夹具、将来从别处拼出来的 Case）——让「没写 engine」走默认值，
 * 而不是在查表时空名字失败。
 */
function resolveEngineName(caseDef: Case, settings: Settings): string {
  const declared = caseDef.engine;
  return typeof declared === "string" && declared.trim() !== "" ? declared.trim() : settings.defaultEngine;
}

/**
 * 引擎名 -> 该引擎的凭证来源。
 *
 * 写成表而不是 if：新增引擎只加一行，且「哪家引擎用哪份 key」集中在一处可读。
 *
 * ⚠️ **未登记的引擎拿到的是空凭证**，而不是顺手借用 typesafe 的 key。
 * `EngineContext` 是单引擎时代的形状（只有一对 apiKey/model），第二个真实引擎
 * 接入时它会不够用——那时要改的是契约本身，而不是在这里悄悄把别家的 key 递过去。
 * 详见 §11.1 的同类记录与验收报告里的契约矛盾一节。
 */
const CREDENTIALS: Record<string, (settings: Settings) => { apiKey: string; model: string }> = {
  [TYPESAFE_ENGINE_NAME]: (settings) => ({ apiKey: settings.typesafeApiKey, model: settings.typesafeModel }),
};

function engineContext(name: string, settings: Settings): EngineContext {
  const credentials = CREDENTIALS[name];
  const { apiKey, model } = credentials === undefined ? { apiKey: "", model: "" } : credentials(settings);
  // settings 整个传下去：文本模型那类「只有某个引擎用得上」的配置不该挤进
  // EngineContext 的顶层字段，否则每加一家厂商就要改一次契约。
  return { apiKey, model, settings };
}

function unknownEngine(name: string): Error {
  const available = [...REGISTRY.keys()].sort();
  const hint =
    name === SCRIPTED_ENGINE_NAME
      ? `注意：scripted 是**测试专用**引擎，不通过用例配置构造（architecture.md §11.1 ④）——` +
        `用例里写 \`engine: scripted\` 是配置错误。测试请用 RunnerDeps.createEngine 注入：` +
        `\`createEngine: () => createScriptedEngine({ steps })\`。`
      : "";
  return new Error(
    `未知的决策引擎 "${name}"：注册表里没有它。` +
      `可用引擎：${available.length > 0 ? available.join("、") : "（一个都没有，注册表被清空了？）"}。` +
      hint,
  );
}

/**
 * 读出一个引擎的**静态能力**。
 *
 * `listEngines()` 拿不到也不该拿 `Settings`（`doctor` 必须在凭证缺失时也能跑），
 * 所以能力只能来自工厂本身：用一个「什么都不会发出去」的探测上下文构造一次实例，
 * 读出 capabilities 后丢弃。因此工厂必须满足两条约定：
 *
 *   1. **纯构造**：不发网络请求、不读环境变量、不建目录、不启动浏览器；
 *   2. **不因缺少凭证而抛错**——探测上下文的 key 是空的。缺凭证该在**发请求那一刻**
 *      报错（见 `typesafe.ts` 的 `postJson`），那才是能给出「没有任何浏览器动作被执行」
 *      这句保证的地方。
 *
 * 代价说清楚：**每个工厂在注册时都会多被调用一次**，而那个探测实例不会被 `close()`。
 * 所以工厂绝不能持有需要显式释放的资源（连接池、子进程、临时目录）。这与
 * 「引擎是纯网络组件」是一致的——真需要释放东西的引擎，先该改这个接口。
 *
 * 探测放在注册时（而不是第一次 `listEngines()` 时）：错的工厂应当在调用
 * `registerEngine` 那一刻就炸，栈里直接指到出问题的那一行；推迟到 doctor 才炸，
 * 排查时看到的只是一个「引擎列表拉不出来」。
 *
 * 违反这两条会让 `listEngines()` 失败，而它是 `doctor` 与前端下拉框的数据源——
 * 一个引擎的构造问题会连累整个平台起不来。
 */
function probeCapabilities(factory: EngineFactory): EngineCapabilities {
  const probe = factory({ apiKey: "", model: "", settings: PROBE_SETTINGS });
  const { text, probabilities } = probe.capabilities;
  return { text, probabilities };
}

/**
 * 探测用设置。**每个值都是占位，不会被拿去看文件或发请求**——工厂只允许读
 * 「决定 capabilities 的那几项」（约定见 `probeCapabilities`）。
 *
 * 文本模型三项按**配齐**写，这是刻意的：`listEngines()` 回答的是引擎**支持**什么，
 * 而不是本进程此刻配没配。后者由 `config.ts` 的 `missingCredentials` 与
 * `jevtest doctor` 回答。反过来的话，「没填 key」会被报成「引擎不支持文本取值」，
 * 前端据此把输入框永久禁掉，而用户补上 key 之后界面也不会变——
 * 一个不会自愈的假故障，比没有这个字段更糟。
 */
const PROBE_SETTINGS: Settings = {
  typesafeApiKey: "",
  typesafeModel: "",
  textModelApiKey: "<probe>",
  textModelBaseUrl: "http://127.0.0.1/",
  textModel: "<probe>",
  port: 0,
  workers: 1,
  // 与 config.ts 的默认值一致（这里再写一遍是不可避免的：探测用不到它，
  // 但类型要求它存在，写一个容易辨别的数字比写 0 更不容易误导）。
  maxEngineInflight: 4,
  headless: true,
  tracing: false,
  casesDir: "",
  runsDir: "",
  authDir: "",
  defaultEngine: TYPESAFE_ENGINE_NAME,
};

/**
 * 文本模型三项收成一个可选组。
 *
 * **三项缺一不可**：半配置（有 key、没有 baseUrl）只会把故障推迟到第一次 TYPE_TEXT，
 * 而且那时的报错看起来像网络问题。返回 undefined = 没配，此时 typesafe 的
 * `writeText` 会直接抛错并列出要补的三项——**绝不猜一个值**。
 *
 * 逐项 `typeof` 判一遍是因为这个函数也接受未经 `loadSettings` 校验的对象
 * （测试夹具会直接写字面量），而 `undefined.trim()` 会抛出与本意无关的 TypeError。
 */
function textModelConfig(settings: Settings): { apiKey: string; baseUrl: string; model: string } | undefined {
  const apiKey = usable(settings.textModelApiKey);
  const baseUrl = usable(settings.textModelBaseUrl);
  const model = usable(settings.textModel);
  if (apiKey === "" || baseUrl === "" || model === "") return undefined;
  return { apiKey, baseUrl, model };
}

function usable(value: string | null | undefined): string {
  return typeof value === "string" ? value.trim() : "";
}

// ---------------------------------------------------------------------------
// 内置引擎（自注册）
// ---------------------------------------------------------------------------

/**
 * 注册 typesafe —— P0 唯一的真实引擎。
 *
 * **scripted 刻意不在这里注册。** 本文件旧 TODO 写的是「注册 typesafe 与 scripted」，
 * 那条与 architecture.md §11.1 ④ 的定案冲突，**以 §11.1 ④ 为准**：
 *
 *   1. scripted 是测试专用引擎，生产用例永不声明 `engine: scripted`。
 *      把它注册进来等于给「在 YAML 里写答案序列」开了一扇门——那正是
 *      「砍掉 engineOptions、不补进 schema」要关上的门。
 *   2. 测试有更好的通路：`RunnerDeps.createEngine: (caseDef: Case) => DecisionEngine`
 *      是现成的注入点，测试里直接 `() => createScriptedEngine({ steps })` 即可，
 *      零 schema 变更，且 runner 完全不知道自己在跟谁说话。
 *
 * 于是 `createEngine(caseDef, settings)` 遇到 `engine: scripted` 会**报错并列出可用引擎**
 * （见 `unknownEngine` 里那条针对性提示），而不是悄悄跑起来。
 */
registerEngine(TYPESAFE_ENGINE_NAME, (ctx) => {
  const text = textModelConfig(ctx.settings);
  const base = {
    apiKey: ctx.apiKey,
    model: ctx.model,
    // 在途上限由构造方显式注入，引擎不读环境变量（见 TypeSafeOptions.maxInflight）。
    maxInflight: ctx.settings.maxEngineInflight,
  };
  // 分开写两支而不是 `...(text ? {text} : {})`：后者在 strict 下要额外的类型体操，
  // 而这里两支各自完整可读，多这几行换来的是「哪些字段被显式传了」一目了然。
  return text === undefined ? createTypeSafeEngine(base) : createTypeSafeEngine({ ...base, text });
});
