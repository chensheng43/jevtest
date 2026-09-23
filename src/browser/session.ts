/**
 * 浏览器会话接口 —— 可测试性的枢纽。
 *
 * `core/` 只依赖这个接口，**从不 import playwright**。因此：
 *   - 单元测试用 FakeSession 就能覆盖 runner 的全部控制流，不需要浏览器；
 *   - 将来换掉 Playwright（或加一层远程浏览器）只改一个实现文件。
 *
 * `Observation` 是「模型能看到的一切」的载体。注意它**不含选择器、不含 HTML**——
 * 只有索引化的元素表和可见文本。这是整个项目安全模型的地基：
 * 模型输出永远不会变成选择器、坐标、shell 命令或可执行 JS。
 */

import type { ActionKind } from "../schema/events.ts";
import type { AdmissionStats } from "../schema/report.ts";

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * 一个可执行动作。
 *
 * `node` 是 **code-owned 的节点身份**，由 snapshot.js 用 WeakMap 分配
 * （参考项目 `snapshot.js:4-8`）。它只在单次文档生命周期内有效——
 * 节点被替换会拿到新身份，导航会重置整个缓存。
 * **它不是 CDP 的 backendNodeId，也不是 CSS 选择器，模型无法伪造。**
 *
 * 同源 iframe 里的元素也在同一张表里：`id` 形如 `f1:e7`，`node` 由 Session 实现编码成
 * 全页唯一的数（见 playwright-session.ts 的 `FRAME_NODE_STRIDE`）。core 不需要知道 frame 的存在。
 */
export interface Action {
  id: string;
  kind: ActionKind;
  label: string;
  role?: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  /** 仅 click / fill / select 有 */
  node?: number;
  /** 仅 scroll 有 */
  delta?: number;
  rect?: Rect;
}

/** 一次原子观测的产物。整个 agent 循环的输入。 */
export interface Observation {
  url: string;
  title: string;
  /** 可见文本。离屏内容与 footer 不计入，避免无谓撑大模型上下文 */
  text: string;
  textTruncated: boolean;
  w: number;
  h: number;
  scroll: { y: number; height: number };
  actions: Action[];
  /** 因超出上限被丢弃的候选数。模型据此知道「还有东西没看到」 */
  omittedActions: number;
  /**
   * 当前可见的页面提示（toast / alert / 表单校验），每条已压成一行。
   * 文字同样在 `text` 里，单独给出是为了让模型与报告不必在几千字里找它——
   * 一条「请输入SKU」埋在正文中间时，模型分不清它和同名的输入框占位符。
   */
  notices: string[];
  /**
   * 视口里看得见、内容却读不到的跨域 iframe 数。缺省即 0。
   * 同源 iframe 的元素与文本已经并进 `actions` / `text`；跨域的读不到也点不了，
   * 单独计数是为了让模型与报告知道「这里有一块看不见的内容」，而不是只剩一句 BLOCKED。
   */
  unreadableFrames?: number;
  /**
   * 看得见（至少占视口 1/4）、却一个可操作元素都没有的同源 iframe，每项形如 `f1@<timeOrigin>`：
   * frame 序号加它当前文档的身份，iframe 换了文档就是另一项。缺省即没有。
   * 这几乎总是「iframe 还在加载、画面是白的」——agent 据此先等它渲染，而不是拿空壳去问模型。
   */
  blankFrames?: string[];

  /** 整页语义标记。用于 wait / scroll / fill 等动作的新鲜度比较 */
  marker: unknown;
  /** 文档级语义状态：timeOrigin / href / 滚动 / 视口 / 表单值 */
  pageKey: unknown;
  /** node id -> 该元素的局部守卫状态，供动作级新鲜度比较 */
  guards: Record<string, unknown>;

  /** `sha256(url + text + actions + scroll)`，用于快速判断页面是否变化 */
  fingerprint: string;
}

export type WaitUntil = "commit" | "domcontentloaded" | "load" | "networkidle";

export interface GotoOptions {
  waitUntil: WaitUntil;
  timeoutMs?: number;
}

export interface ObserveOptions {
  /** 是否附带截图。库调用默认 false；Web 界面按需开启 */
  screenshot?: boolean;
}

/**
 * 浏览器会话。一个实例 = 一个 BrowserContext = 一个用例的隔离边界。
 *
 * 生命周期由 `BrowserPool.withContext()` 管理，**调用方不要自己 new**。
 */
export interface Session {
  goto(url: string, options: GotoOptions): Promise<Observation>;

  /**
   * 原子读取一次页面状态。
   *
   * 「原子」是硬要求：元素表、文本、守卫状态必须在**同一次** page.evaluate 里取完。
   * 分多次读会读到互相矛盾的快照——参考项目 `tests/test_agent.py` 里
   * `test_observation_is_one_atomic_browser_read` 专门守着这条。
   */
  observe(options?: ObserveOptions): Promise<Observation>;

  /**
   * 判断页面相对某次观测是否仍然新鲜。
   *
   * 传入 `action` 时做**动作级**比较（只比该节点及其附近上下文），
   * 否则做整页比较。区分两者的原因是：无关区域的动画不应该作废一个仍然有效的决策。
   */
  isFresh(page: Observation, action?: Action): Promise<boolean>;

  /**
   * 执行动作。**从不重试。**
   *
   * 实现必须做到：
   *   1. 输入前重新检查新鲜度；
   *   2. 输入前**重新解析几何**并做遮挡命中测试（元素可能已移动）；
   *   3. 变更类动作在输入前不得有任何其他副作用。
   */
  act(action: Action, page: Observation, text?: string | null): Promise<void>;

  /** 当前 URL，用于域名白名单校验 */
  currentUrl(): string;

  /**
   * 探测一次页面，采集准入判定所需的原始统计。
   *
   * **只负责采集，不做判断。** 判定是 `browser/admission.ts` 里的纯函数，
   * 因为规则需要能单元测试（喂不同的统计看结论），而采集必须真浏览器。
   * 混在一起会让规则无法回归——而准入规则正是「假阳性」的第一道防线。
   *
   * 只读操作，不调用模型，因此可以在表单里做一个「检测页面」按钮随手点。
   */
  probe(): Promise<AdmissionStats>;

  /** 取一帧 JPEG，写入 runs/<runId>/frames/ */
  frameJpeg(): Promise<Buffer>;

  /** 释放上下文。必须在 finally 中调用，否则会泄漏 renderer 进程 */
  close(): Promise<void>;
}

// TODO(P0): 为 <op>_target 的候选集构造提供辅助——见 core/policy.ts 的 buildActionSpace。
