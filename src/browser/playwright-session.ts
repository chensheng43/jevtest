/**
 * Playwright 实现的 Session。
 *
 * 参考项目用 Browser Harness 直连用户已有的 Chrome，每个动作都要手写 CDP 调用。
 * 换成 Playwright 后绝大部分映射是直译，**但有两处不能换，换了行为就变**：
 *
 *   1. 点击必须用 `page.mouse.click(x, y)`，**不能用 `locator.click()`**。
 *      参考项目刻意用真实坐标加命中测试（`browser.py:144-164`）：先在页面里
 *      解析元素当前几何、用 `elementFromPoint` 确认没被遮挡，再发真实鼠标事件。
 *      locator.click 会替我们滚动、等待、重试，看似省事，但会丢掉「元素在决策之后
 *      移动了/被盖住了」这个判断——而那正是不该继续点击的时刻。
 *
 *   2. 原生 `<select>` 保留 JS 直接设值 + 派发 input/change 的写法，
 *      **不要换成 `selectOption()`**。原因是守卫语义不同：我们要在同一次
 *      evaluate 里完成「确认 option 存在且未禁用 -> 设值 -> 派发事件」，
 *      中途被导航打断必须报错而非重试（`browser.py:152-164`）。
 *
 * CDP -> Playwright 映射表（完整对照见 docs/architecture.md）：
 *
 *   Runtime.evaluate {returnByValue}        -> page.evaluate()
 *   Runtime.evaluate {awaitPromise}         -> page.evaluate(async () => ...)
 *   Emulation.setDeviceMetricsOverride      -> newContext({ viewport, deviceScaleFactor })
 *   Emulation.setFocusEmulationEnabled      -> CDP 逃生舱，见下
 *   Page.navigate                           -> page.goto(url, { waitUntil })
 *   Page.captureScreenshot                  -> page.screenshot({ type: "jpeg", quality })
 *   Input.dispatchMouseEvent (mouseWheel)   -> page.mouse.wheel(0, delta)
 *   Input.dispatchMouseEvent (click)        -> page.mouse.click(x, y)
 *   Input.insertText                        -> page.keyboard.insertText(text)
 *   Input.dispatchKeyEvent selectAll        -> page.keyboard.press("ControlOrMeta+a")
 *   Target.createTarget / closeTarget       -> context.newPage() / context.close()
 *   （无）                                   -> context.tracing.start/stop  【新增：trace.zip】
 *   （无）                                   -> storageState              【新增：登录态复用】
 *
 * 两处简化：
 *   - `Emulation.setFocusEmulationEnabled` 在参考项目里用于让**用户浏览器中的后台标签页**
 *     保持 rAF 运行，避免动画节流。Playwright 里页面是我们自己的前台页，本不需要。
 *     但如果将来复用已有的可见浏览器（connectOverCDP），就需要它补回同等行为——
 *     所以保留走 CDP 逃生舱的实现，用常量控制。
 *   - `browser.py:174` 的 `sys.platform` 分支可以删掉：`ControlOrMeta+a` 自带跨平台修饰键。
 *
 * ## 本文件里的三个实现约定
 *
 *   - **页面侧的代码用真函数写，不用字符串拼。** `page.evaluate(fn, arg)` 会把函数
 *     序列化后送进页面执行。tsconfig 的 lib 里没有 DOM（只有 ES2023），所以页面侧
 *     一律通过 `globalThis` 上的窄接口（`PageGlobals`）取 document / window——
 *     代价是一层手写声明，收益是拼错的 API 在 tsc 阶段就暴露。
 *     **而序列化只带走函数体本身**：模块作用域的 helper 在页面里是未定义的标识符，
 *     所以每个页面侧函数都得把用到的工具重新定义在函数体内部，
 *     见下方「页面侧的函数必须自包含」——这是本文件唯一一个会静默失败的地方。
 *     唯一的例外是 snapshot.js：它按设计以**文本**读出后注入（见 docs/development.md §5.2）。
 *   - **每一个 Playwright 调用的 await 都过 `guarded()`。** 漏一处，那种失败就不会
 *     变成 StalePage，一次正常跳转会被记成运行失败（docs/development.md §5.3）。
 *   - **act() 里的输入后 settle 吞掉异常**，理由见该处注释——这是本项目里唯一
 *     一处「吞异常」，它有明确且必须的理由。
 */

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CDPSession, Frame, Page, Request } from "playwright";
import type { ActionKind } from "../schema/events.ts";
import type { AdmissionStats } from "../schema/report.ts";
import { InputInterrupted, JevtestError, OccludedTarget, StalePage, mapBrowserError } from "../core/errors.ts";
import type {
  Action,
  GotoOptions,
  Observation,
  ObserveOptions,
  Rect,
  Session,
} from "./session.ts";
import { SCROLL_OVERFLOW_THRESHOLD_PX } from "./admission.ts";

/** 视口尺寸。与参考项目保持一致，便于对照性能数据。 */
export const VIEWPORT = { width: 1120, height: 780 } as const;

/**
 * 是否需要补回「禁止后台标签页节流」。
 *
 * 自建 context（默认）时为 false，可省一次 CDP 往返。
 * 用 `connectOverCDP` 复用已有浏览器时置 true。
 */
export const REQUIRE_FOCUS_EMULATION = false;

/** 观测后等待页面稳定的时长：普通交互 50ms，可编辑 combobox 200ms。 */
export const SETTLE_MS = { default: 50, combobox: 200 } as const;

/**
 * 「新文档尚未就绪」时等它多久。
 *
 * 只用于导航在途的那个窗口：真实的 DOMContentLoaded 通常几十到几百毫秒就到，
 * 超过这个值说明这次导航本身有问题，那就该让观测如实失败（StalePage），
 * 而不是把每一步都拖长。
 */
export const DOCUMENT_READY_TIMEOUT_MS = 2_000;

/**
 * 打开起始页之后，最多再等多久「网络安静下来」（Playwright 的 `networkidle`：
 * 500ms 内没有进行中的请求）才做第一次观测。
 *
 * 为什么需要：`goto` 只等到 DOMContentLoaded，而后台管理类的单页应用在那一刻
 * 通常只有外壳——列表、按钮是随后一次 XHR 拉回来才渲染的。实测一次真跑：
 * 第一次观测只有导航栏，模型看不到「批量导入」「导入设置」，第一个决策就是 BLOCKED。
 *
 * 为什么有上限：带轮询、长连接的页面永远等不到 networkidle。等不到就按时继续——
 * 这只是给第一次观测一个更好的起点，不是运行的闸。只用在 goto 上：
 * networkidle 看的是整页的请求，每一步动作之后都这样等，会把带轮询的页面每一步都拖长到上限。
 * 动作之后另有一套只看「这次动作引出的请求」的等待，见 `POST_ACTION_QUIET`。
 */
export const LOAD_SETTLE_TIMEOUT_MS = 5_000;

/**
 * 动作之后，等页面「安静」多久再交给下一次观测：
 * 动作之后发出的请求（类型见 `QUIET_RESOURCE_TYPES`）全部返回，且主文档与每个同源 iframe
 * 的 DOM 都连续 `quietMs` 没有结构变化。
 *
 * 为什么需要：输入之后原本只等两帧（`SETTLE_MS`），而弹窗、下拉、分页这类交互通常是
 * 「外壳立刻出现，内容等接口回来再渲染」。一次真跑里点「导入eBay产品库」之后，
 * 观测落在弹窗只有标题与「关闭 / 确定」的那一刻——SKU 选项还没到，模型唯一能推进的
 * 就是「确定」，于是在选 SKU 方式之前就点了它，触发「请输入SKU」，随后还把这次失败的
 * 点击当成做过的一步，提前回了 DONE。
 *
 * 只算**动作之后才发出**的请求：页面上原本挂着的长轮询与这次动作无关，
 * 算进来会让每一步都等到上限。上限兜住的是动作本身引出的长连接与持续变动的页面——
 * 等不到就按时继续，这只是给下一次观测一个更好的起点，不是运行的闸（同 `LOAD_SETTLE_TIMEOUT_MS`）。
 */
export const POST_ACTION_QUIET = { quietMs: 300, timeoutMs: 3_000 } as const;

/**
 * 动作引出一个同源 iframe 的加载时，等它文档回来并触发 `load` 的上限（从动作算起）。
 *
 * 为什么不沿用 `POST_ACTION_QUIET` 的 3s：一次真跑里「添加产品」弹窗的 iframe 文档就用了 2.2s，
 * 回来之后还要拉样式与脚本；3s 到点时 iframe 里还是白屏，模型对着空壳回了 BLOCKED。
 * 这个上限只在「动作之后确实有一个看得见的同源 iframe 开始加载」时才用得上，普通动作不受影响。
 */
export const FRAME_LOAD_TIMEOUT_MS = 15_000;

/**
 * 动作之后要等它返回的请求类型。图片、字体、样式不影响可交互的内容，不等。
 *
 * `document` 是为 iframe：弹窗里嵌一个 iframe 时，点击引出的是那个 iframe 的文档请求，
 * 不等它，观测就落在 iframe 还是 about:blank 的时候。一次真跑里「添加产品」的 iframe
 * 文档用了 1.7s 才回来。主文档的导航同样是 document 请求，但它会先让页面侧的
 * settleQuiet 因为执行上下文被销毁而抛错，act 吞掉它之后由 observe 等文档就绪，不受影响。
 */
const QUIET_RESOURCE_TYPES: ReadonlySet<string> = new Set(["xhr", "fetch", "script", "document"]);

/**
 * 滚轮事件发送的位置。参考项目固定在 (550, 650)（见 docs/limitations.md §6），
 * 这里保持一致，便于对照行为。视口比它小时 Playwright 仍会照发，不会报错。
 */
const WHEEL_AT = { x: 550, y: 650 } as const;

/**
 * snapshot.js 里文本的截断长度。**必须与 snapshot.js 里的 6000 保持一致**——
 * 那边是硬编码的，这边只能跟着它，用于判断 `textTruncated`。
 */
const TEXT_LIMIT = 6000;

/**
 * 同源子 frame 里的节点身份编码：`frame 序号 * STRIDE + frame 内的节点号`。
 *
 * `Action.node` 在 core 里是**全页唯一**的数字（policy 按它归并元素、agent 按它记「点了没反应」），
 * 而 snapshot.js 在每个 frame 里各自从 1 编号，直接拼起来就会撞号。编码成一个数而不是给 Action
 * 加一个 frame 字段，是为了让 core 完全不知道 frame 的存在：身份依旧是 code-owned 的整数，
 * 模型照样看不到它。主文档的节点号原样保留（序号 0），不含 iframe 的页面与改动前逐字相同。
 * 一个文档里分出去的身份数到 STRIDE 之前早就换过文档了；真到了就丢掉那个候选，不让它撞号。
 */
const FRAME_NODE_STRIDE = 1_000_000;

/**
 * 跨域 iframe 至少这么大（宽和高都算）才算「页面上有一块读不到的内容」。
 * 广告、统计、登录态同步这类 iframe 常常是 0x0 或 1x1，每步都报它们只是噪音。
 */
const UNREADABLE_FRAME_MIN_PX = 50;

/**
 * 同源 iframe 至少占视口这么大的比例，一个可操作元素都没有时才算「白屏」（`Observation.blankFrames`）。
 * 弹窗里的表单 iframe 动辄占满视口；小块的空 iframe（图表、统计）多半不是目标，不值得为它等。
 */
const BLANK_FRAME_MIN_VIEWPORT_SHARE = 0.25;

export interface PlaywrightSessionOptions {
  /** 由 BrowserPool 提供的已就绪 page。Session 不负责创建或销毁上下文 */
  page: unknown;
  /**
   * 是否录制 trace。开启后 stop() 写出 trace.zip
   *
   * **实际录制由 pool 负责**：trace 是 context 级能力，而 `tracing.stop()` 必须
   * 落在覆盖整个 session 生命周期的 finally 里——那个 finally 在 pool.withSession()
   * 里（docs/development.md §5.4）。Session 里再 start 一次会与之冲突。
   */
  tracing?: boolean;
  tracePath?: string;
}

// ---------------------------------------------------------------------------
// snapshot.js：以文本读出后注入
// ---------------------------------------------------------------------------

/**
 * snapshot.js 的文本。
 *
 * 懒读 + 缓存：dev 下它在 `src/browser/`，构建后由 scripts/copy-assets.mjs
 * 复制到 `dist/browser/`——两种情况它都与本文件同目录，因此
 * `new URL("./snapshot.js", import.meta.url)` 两边都对。
 */
let snapshotSource: string | null = null;

function loadSnapshotSource(): string {
  if (snapshotSource === null) {
    const url = new URL("./snapshot.js", import.meta.url);
    try {
      snapshotSource = readFileSync(url, "utf8");
    } catch (error) {
      throw new JevtestError(
        `读不到 ${url.href}。开发期它应在 src/browser/ 下，构建产物里由 scripts/copy-assets.mjs 复制到 dist/browser/`,
        { cause: error },
      );
    }
  }
  return snapshotSource;
}

/**
 * snapshot.js 的返回结构。**保持原版的 snake_case**，不在这层改名：
 * 上游更新时才能直接 diff（docs/development.md §6）。到 TS `Observation` 的
 * 字段映射是这一层的职责。
 */
interface RawAction {
  id?: string;
  kind?: string;
  label?: string;
  role?: string;
  value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  node?: number;
  delta?: number;
  rect?: Rect;
}

interface RawSnapshot {
  url: string;
  title: string;
  w: number;
  h: number;
  text: string;
  scroll: { y: number; height: number };
  actions: RawAction[];
  marker: unknown;
  page_key: unknown;
  guards: Record<string, unknown>;
  omitted_actions: number;
  notices?: string[];
  /** 子 frame 的视口在顶层里的位置；主文档为 null（snapshot.js 第 7 处改动） */
  frame?: Rect | null;
}

/** `page_key` 的元组结构，见 snapshot.js 的 `cache.pageKey`。 */
type RawPageKey = readonly [number, string, number, number, number, number, unknown[]];

/** 一个同源子 frame 的快照。`seq` 见 `FRAME_NODE_STRIDE`。 */
interface FramePart {
  seq: number;
  raw: RawSnapshot;
}

/** 一次观测读到的全部原始状态：主文档、各同源子 frame，以及看得见却读不了的跨域 frame 数。 */
interface PageState {
  main: RawSnapshot;
  parts: FramePart[];
  unreadableFrames: number;
}

/**
 * 子 frame 里节点的守卫：连同那个 frame 的文档身份（timeOrigin / href）一起存，
 * 主文档的 pageKey 管不到 iframe 里换没换过文档。主文档节点的守卫仍是 snapshot 给的原样。
 */
type FrameGuard = readonly [number | undefined, string | undefined, unknown];

// ---------------------------------------------------------------------------
// 页面侧的窄接口
// ---------------------------------------------------------------------------

/**
 * 页面里用得着的全局对象。lib 里没有 DOM，因此只能自己声明。
 *
 * `querySelectorAll` 声明成数组：页面里它返回 NodeList，可迭代、有 length，
 * 这两样本文件都用到，声明成数组最省事（也最不容易写错）。
 */
interface PageGlobals {
  document: {
    body: PageElement | null;
    querySelectorAll(selector: string): PageElement[];
    elementFromPoint(x: number, y: number): PageElement | null;
  };
  location: { href: string };
  /** 顶层里 `parent` 就是自己，见 resolveTargetInPage 的逐层命中测试 */
  parent: PageGlobals;
  /** 父文档跨域时为 null */
  frameElement: PageElement | null;
  performance: { now(): number; timeOrigin: number };
  innerWidth: number;
  innerHeight: number;
  requestAnimationFrame(cb: () => void): unknown;
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(id: unknown): void;
  MutationObserver: new (callback: () => void) => {
    observe(target: unknown, options: Record<string, unknown>): void;
    disconnect(): void;
  };
  getComputedStyle(el: PageElement): {
    overflowX: string;
    overflowY: string;
    cursor: string;
    paddingLeft: string;
    paddingTop: string;
  };
}

interface PageElement {
  isConnected: boolean;
  tagName: string;
  type?: string;
  value: string;
  disabled?: boolean;
  shadowRoot: unknown;
  parentElement: PageElement | null;
  options?: { length: number; [index: number]: PageOption | undefined };
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
  clientLeft: number;
  clientTop: number;
  getAttribute(name: string): string | null;
  /** 原生 <select> 设值后要派发 input/change，见 resolveTargetInPage */
  dispatchEvent(event: unknown): boolean;
  matches(selector: string): boolean;
  closest(selector: string): PageElement | null;
  querySelectorAll(selector: string): PageElement[];
  contains(other: unknown): boolean;
  checkVisibility(options?: { checkOpacity?: boolean; checkVisibilityCSS?: boolean }): boolean;
  getBoundingClientRect(): { x: number; y: number; width: number; height: number };
  focus(): void;
}

interface PageOption {
  value: string;
  disabled: boolean;
  closest(selector: string): PageElement | null;
}

/** snapshot.js 挂在页面上的节点身份缓存（`window.__jev`）。 */
interface PageNodeCache {
  nodes: { get(node: number): PageElement | undefined };
  guard(el: PageElement | undefined): unknown;
  pageKey(): unknown;
}

/**
 * ## 页面侧的函数必须是**自包含**的——这是本文件唯一一个会静默失败的坑
 *
 * `page.evaluate(fn, arg)` 送进页面的**只有 `fn.toString()`**。Playwright 的
 * `normalizeEvaluationExpression` 做的事是：把函数源码文本包一层括号，
 * 在页面里 `new Function` 求值后调用。**函数体之外的一切都不会跟着过去**。
 *
 * 后果很具体：如果 `settleDocument` 里写的是 `globals()`，页面里就会抛
 * `ReferenceError: globals is not defined`——因为 `globals` 是**模块作用域**的标识符，
 * 页面里根本没有这个名字。而 `tsc` 对此一声不响（类型上完全成立），
 * 失败要等到真浏览器里第一次 `observe()` 才出现。
 *
 * 所以下面每一个要 evaluate 的函数，都把需要的小工具**重新定义在函数体内部**：
 *
 *   - `const g = globalThis as unknown as PageGlobals;`   （原 `globals()`）
 *   - `const cache = (...).window?.__jev;`                （原 `nodeCache()`）
 *   - `const visible = (el) => ...`                       （原 `visibleInPage()`）
 *
 * 看起来是重复，但这三个 helper 抽到函数外面就等于把它们删掉了。
 *
 * **给后续维护者的纪律：任何要在页面里跑的代码，不许引用模块作用域的值。**
 * 类型不算——`type` / `interface` 会被擦除，序列化出去的文本里没有它们，
 * 所以 `PageGlobals` / `PageElement` 这些声明留在外面是安全的，而且必须留在外面。
 */

/**
 * 页面侧：settle 的普通模式——等两个 rAF，或 ms 到点，谁先来算谁。
 *
 * 两个 rAF 而不是一个：样式与布局在第二个 rAF 之前才落定，只等一个会读到
 * 「元素已经在 DOM 里但还没有几何」的中间态。
 */
function settleDocument(ms: number): Promise<void> {
  // 自包含，见上方「页面侧的函数必须自包含」
  const g = globalThis as unknown as PageGlobals;
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    g.requestAnimationFrame(() => g.requestAnimationFrame(finish));
    // 后台/隐藏标签页里 rAF 可能永远不来，必须有定时器兜底，否则 observe 会挂死
    g.setTimeout(finish, ms);
  });
}

/**
 * 页面侧：settle 的 combobox 模式——等一个可见 option 出现，上限 ms。
 *
 * 自动补全的候选是**异步**渲染的。不等它的代价不是慢一点，而是
 * 为一个还没渲染出候选的框付一次决策请求：模型看到空的候选集，
 * 只能猜或者选 WAIT。
 */
function settleCombobox(ms: number): Promise<void> {
  // 自包含，见上方「页面侧的函数必须自包含」
  const g = globalThis as unknown as PageGlobals;
  const visible = (el: PageElement): boolean =>
    el.closest('[aria-hidden="true"],[inert]') === null &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  return new Promise<void>((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      resolve();
    };
    const deadline = g.performance.now() + ms;
    const hasVisibleOption = () => {
      for (const option of g.document.querySelectorAll('[role="option"], option')) {
        const r = option.getBoundingClientRect();
        // 原生 <select> 的 option 不参与渲染（矩形为 0），因此不会误判成「候选已出现」
        if (r.width > 0 && r.height > 0 && visible(option)) return true;
      }
      return false;
    };
    const tick = () => {
      if (done) return;
      if (hasVisibleOption() || g.performance.now() >= deadline) return finish();
      g.requestAnimationFrame(tick);
    };
    g.setTimeout(finish, ms + 20);
    g.requestAnimationFrame(tick);
  });
}

/**
 * 页面侧：等 DOM 连续 `quietMs` 没有变化，上限 `timeoutMs`。
 *
 * 不听 `style` 属性：逐帧改 style 的 JS 动画（轮播、进度条）会让这里永远等到上限，
 * 而内容到达几乎总是表现为节点增删、文本变化或 class / hidden 切换。
 */
function settleQuiet(arg: { quietMs: number; timeoutMs: number }): Promise<void> {
  // 自包含，见上方「页面侧的函数必须自包含」
  const g = globalThis as unknown as PageGlobals;
  return new Promise<void>((resolve) => {
    let done = false;
    let quiet: unknown = null;
    let cap: unknown = null;
    const observer = new g.MutationObserver(() => {
      g.clearTimeout(quiet);
      quiet = g.setTimeout(finish, arg.quietMs);
    });
    const finish = () => {
      if (done) return;
      done = true;
      observer.disconnect();
      g.clearTimeout(quiet);
      g.clearTimeout(cap);
      resolve();
    };
    observer.observe(g.document, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["class", "hidden", "open", "disabled", "aria-hidden", "aria-busy", "aria-expanded"],
    });
    quiet = g.setTimeout(finish, arg.quietMs);
    cap = g.setTimeout(finish, arg.timeoutMs);
  });
}

/** 页面侧：一次 evaluate 里完成的几何重解析 + 遮挡命中测试 + select 设值。 */
type TargetResolution = { ok: true; x: number; y: number } | { ok: false; reason: string };

function resolveTargetInPage(arg: {
  node: number;
  kind: string;
  value: string | null;
  focus: boolean;
}): TargetResolution {
  // 自包含，见上方「页面侧的函数必须自包含」
  const g = globalThis as unknown as PageGlobals;
  const cache = (globalThis as unknown as { window?: { __jev?: PageNodeCache } }).window?.__jev;
  const visible = (el: PageElement): boolean =>
    el.closest('[aria-hidden="true"],[inert]') === null &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  // 缓存没了 = 文档换过了。这里不能算「元素不可点」，它是页面被替换，由调用方判 StalePage
  if (!cache) return { ok: false, reason: "document-changed" };
  const el = cache.nodes.get(arg.node);
  if (!el || !el.isConnected) return { ok: false, reason: "detached" };
  if (!visible(el)) return { ok: false, reason: "hidden" };
  if (el.matches(":disabled") || el.closest('[aria-disabled="true"]')) {
    return { ok: false, reason: "disabled" };
  }

  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return { ok: false, reason: "zero-size" };
  const x = rect.x + rect.width / 2;
  const y = rect.y + rect.height / 2;
  if (x < 0 || y < 0 || x >= g.innerWidth || y >= g.innerHeight) {
    return { ok: false, reason: "offscreen" };
  }

  // 命中测试：中心点上最顶层的元素必须还是它（或它的后代）。
  // 这是 locator.click() 替我们做掉、而我们**必须自己做**的那一步（见文件头第 1 条）。
  const hit = g.document.elementFromPoint(x, y);
  if (!hit || (hit !== el && !el.contains(hit))) return { ok: false, reason: "occluded" };

  // 同源 iframe 里的目标：鼠标事件发在顶层页面上，坐标要换算到顶层，
  // 并且每一层的父文档在该点命中的都必须正是这个 <iframe>。与 snapshot.js 第 7 处改动同一条标准。
  // 主文档里 parent 就是自己，循环一次都不跑。
  let topX = x;
  let topY = y;
  for (let w = g; w !== w.parent; w = w.parent) {
    const frameEl = w.frameElement;
    if (!frameEl) return { ok: false, reason: "frame-unreachable" };
    const r = frameEl.getBoundingClientRect();
    const style = w.parent.getComputedStyle(frameEl);
    topX += r.x + frameEl.clientLeft + parseFloat(style.paddingLeft);
    topY += r.y + frameEl.clientTop + parseFloat(style.paddingTop);
    if (topX < 0 || topY < 0 || topX >= w.parent.innerWidth || topY >= w.parent.innerHeight) {
      return { ok: false, reason: "offscreen" };
    }
    if (w.parent.document.elementFromPoint(topX, topY) !== frameEl) return { ok: false, reason: "occluded" };
  }

  if (arg.kind === "select") {
    const wanted = arg.value ?? "";
    let option: PageOption | undefined;
    const options = el.options;
    for (let i = 0; i < (options?.length ?? 0); i++) {
      const candidate = options?.[i];
      if (candidate && candidate.value === wanted) {
        option = candidate;
        break;
      }
    }
    if (!option) return { ok: false, reason: "option-missing" };
    if (option.disabled || option.closest("optgroup[disabled]")) {
      return { ok: false, reason: "option-disabled" };
    }
    // 同一次 evaluate 内完成「确认 -> 设值 -> 派发」。中途被导航打断时
    // evaluate 直接抛错（由 mapBrowserError 归类），**绝不会重试**（见文件头第 2 条）
    el.value = wanted;
    if (el.value !== wanted) return { ok: false, reason: "option-not-set" };
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  // fill 之前把焦点交给目标本身。用页面里的 focus() 而不是再发一次真实点击：
  // 一个只想输入内容的控件，不该因为「为了聚焦」而被点一次（可能触发它的 click 处理器）
  if (arg.focus) el.focus();

  return { ok: true, x: topX, y: topY };
}

/** 页面侧：取某节点的当前守卫状态，用于动作级新鲜度比较。 */
function readGuardInPage(arg: { node: number }): {
  timeOrigin: number;
  href: string;
  guard: unknown;
} | null {
  // 自包含，见上方「页面侧的函数必须自包含」
  const g = globalThis as unknown as PageGlobals;
  const cache = (globalThis as unknown as { window?: { __jev?: PageNodeCache } }).window?.__jev;
  if (!cache) return null;
  return {
    timeOrigin: g.performance.timeOrigin,
    href: g.location.href,
    guard: cache.guard(cache.nodes.get(arg.node)),
  };
}

/** 一个 frame 内的原始统计。probe 把各 frame 的它加起来。 */
interface FrameStats {
  shadowRoots: number;
  canvases: number;
  passwordFields: number;
  fileInputs: number;
  nestedScrollContainers: number;
  interactiveElements: number;
}

/**
 * 页面侧：一个 frame 的统计。
 *
 * **shadow root 必须逐 frame 数**：它在 frame 内部看不见，主文档的 evaluate
 * 读不到 iframe 里的东西。跨域 frame 连这个函数都跑不起来，调用方据此判定。
 */
function probeFrameInPage(arg: { thresholdPx: number }): FrameStats {
  // 自包含，见上方「页面侧的函数必须自包含」
  const g = globalThis as unknown as PageGlobals;
  const visible = (el: PageElement): boolean =>
    el.closest('[aria-hidden="true"],[inert]') === null &&
    el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const doc = g.document;

  // 只数开放式的 shadow root：closed 模式拿不到，这是规范的硬限制（limitations.md §1）
  let shadowRoots = 0;
  for (const el of doc.querySelectorAll("*")) {
    if (el.shadowRoot) shadowRoots++;
  }

  let nestedScrollContainers = 0;
  for (const el of doc.querySelectorAll("*")) {
    // documentElement / body 的滚动是**文档级**滚动，平台支持它，不算嵌套容器
    if (el === doc.body || el.tagName === "HTML") continue;
    const style = g.getComputedStyle(el);
    const scrollableY =
      (style.overflowY === "auto" || style.overflowY === "scroll") &&
      el.scrollHeight - el.clientHeight > arg.thresholdPx;
    const scrollableX =
      (style.overflowX === "auto" || style.overflowX === "scroll") &&
      el.scrollWidth - el.clientWidth > arg.thresholdPx;
    if (scrollableY || scrollableX) nestedScrollContainers++;
  }

  // 与 snapshot.js 的 selector / safe / visible 三处判定保持一致：
  // 这里要回答的是「元素表里有没有可交互的东西」。与 snapshot 的唯一差别是
  // **不要求元素在视口内**——离开视口只是需要先滚动，不代表页面没有控件。
  const roles = [
    "button",
    "link",
    "checkbox",
    "radio",
    "switch",
    "tab",
    "menuitem",
    "menuitemradio",
    "option",
    "gridcell",
    "combobox",
    "textbox",
    "searchbox",
    "spinbutton",
  ];
  const selector =
    'a[href],button,input,textarea,select,summary,[contenteditable="true"],' +
    roles.map((role) => `[role="${role}"]`).join(",");
  let interactiveElements = 0;
  const taken = new Set<PageElement>();
  for (const el of doc.querySelectorAll(selector)) {
    const type = el.type ?? "";
    if (type === "password" || type === "file" || type === "hidden") continue;
    if (!visible(el)) continue;
    if (el.matches(":disabled") || el.closest('[aria-disabled="true"]')) continue;
    taken.add(el);
    interactiveElements++;
  }
  // 与 snapshot.js 的 cursor:pointer 候选同一条标准（最外层、不与语义候选重叠），同样不看视口
  const covering = new Set<PageElement>();
  for (const el of taken) {
    for (let p = el.parentElement; p && !covering.has(p); p = p.parentElement) covering.add(p);
  }
  const pointer = (el: PageElement | null): boolean => el !== null && g.getComputedStyle(el).cursor === "pointer";
  for (const el of doc.body?.querySelectorAll("*") ?? []) {
    if (taken.has(el) || covering.has(el)) continue;
    if (!pointer(el) || pointer(el.parentElement)) continue;
    let inside = false;
    for (let p = el.parentElement; p && !inside; p = p.parentElement) inside = taken.has(p);
    if (inside || !visible(el) || el.closest('[aria-disabled="true"]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) interactiveElements++;
  }

  return {
    shadowRoots,
    canvases: doc.querySelectorAll("canvas").length,
    passwordFields: doc.querySelectorAll('input[type="password"]').length,
    fileInputs: doc.querySelectorAll('input[type="file"]').length,
    nestedScrollContainers,
    interactiveElements,
  };
}

// ---------------------------------------------------------------------------
// 会话
// ---------------------------------------------------------------------------

export function createPlaywrightSession(options: PlaywrightSessionOptions): Session {
  const page = options.page as Page;
  if (typeof (page as { goto?: unknown } | null | undefined)?.goto !== "function") {
    throw new JevtestError(
      "createPlaywrightSession 需要一个 Playwright 的 Page；收到的是别的东西（大概率是忘记 await context.newPage()）",
    );
  }

  /**
   * 所有 Playwright 调用都从这里过。
   *
   * 这一层的存在就是 docs/development.md §5.3 那条：不映射的话，
   * 页面自己跳转一下就会被记成运行失败，报告直接失去意义。
   */
  async function guarded<T>(call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw mapBrowserError(error);
    }
  }

  /** 输入分发阶段的失败一律归为 InputInterrupted（见 act 里的说明），不做 Stale 映射。 */
  async function dispatchingInput(action: Action, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new InputInterrupted(
        `动作 ${action.id}（${action.label}）的输入发出途中失败，可能已部分生效：${message}`,
        { cause: error },
      );
    }
  }

  /**
   * 在途请求 → 发出时的序号。序号而不是时间戳：「动作之后才发出」只需要先后，
   * 不必担心时钟精度（同一毫秒里发出的请求照样分得清）。
   * page 与 session 同生共死（池为每个会话新开 context），监听器不必摘。
   */
  const inflight = new Map<Request, number>();
  let requestSeq = 0;
  /** 同源子 frame 最近一次开始加载文档时的请求序号，见 waitForFrameLoads */
  const frameLoadSeq = new Map<Frame, number>();
  page.on("request", (request) => {
    requestSeq += 1;
    if (QUIET_RESOURCE_TYPES.has(request.resourceType())) inflight.set(request, requestSeq);
    if (request.resourceType() === "document") {
      const frame = frameOf(request);
      const origin = originOf(request.url());
      if (frame !== null && frame !== page.mainFrame() && (origin === null || origin === originOf(page.url()))) {
        frameLoadSeq.set(frame, requestSeq);
      }
    }
  });
  page.on("requestfinished", (request) => inflight.delete(request));
  page.on("requestfailed", (request) => inflight.delete(request));

  /** 序号大于 `since` 的请求（即动作之后才发出的）是否还有没返回的 */
  function pendingSince(since: number): boolean {
    for (const seq of inflight.values()) if (seq > since) return true;
    return false;
  }

  /**
   * 动作之后等页面安静下来，见 `POST_ACTION_QUIET`。
   *
   * 两件事交替做到都满足为止：DOM 静止一段时间；动作之后发出的请求全部返回。
   * 先等 DOM 再看网络，是因为请求常常在点击处理器的下一拍才发出——
   * 刚点完就看网络会看到「没有在途请求」，而那只是还没来得及发。
   * 请求返回之后再等一轮 DOM：接口回来到内容渲染完之间还隔着一次渲染。
   *
   * 动作引出了同源 iframe 的加载时，先按 `FRAME_LOAD_TIMEOUT_MS` 等它 `load`，
   * 然后从那一刻起再给一整个 `POST_ACTION_QUIET` 窗口，等 iframe 里的初始化请求与渲染。
   */
  async function waitForQuiet(since: number): Promise<void> {
    const started = Date.now();
    let deadline = started + POST_ACTION_QUIET.timeoutMs;
    const loaded = new Set<Frame>();
    for (;;) {
      if (await waitForFrameLoads(since, started + FRAME_LOAD_TIMEOUT_MS, loaded)) {
        deadline = Math.max(deadline, Date.now() + POST_ACTION_QUIET.timeoutMs);
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) return;
      const arg = { quietMs: POST_ACTION_QUIET.quietMs, timeoutMs: remaining };
      // 同源 iframe 各等各的：弹窗里的表单渲染发生在 iframe 的文档里，主文档的 MutationObserver 看不到。
      // 子 frame 的失败不往上抛：它可能正从 about:blank 导航到真正的文档，没等上就算了，
      // 那次导航的 document 请求还在 pendingSince 里，下一轮会再等它的新文档一次。
      await Promise.all([
        guarded(() => page.evaluate(settleQuiet, arg)),
        ...splitChildFrames().sameOrigin.map((frame) => frame.evaluate(settleQuiet, arg).catch(() => undefined)),
      ]);
      if (!pendingSince(since) && framesToLoad(since, loaded).length === 0) return;
      // 有 iframe 开始加载就跳出去交给 waitForFrameLoads：它的上限比这里长
      while (pendingSince(since) && framesToLoad(since, loaded).length === 0 && Date.now() < deadline) {
        await sleep(50);
      }
    }
  }

  /** 动作之后开始加载、还没等过的同源 iframe */
  function framesToLoad(since: number, loaded: Set<Frame>): Frame[] {
    const frames: Frame[] = [];
    for (const [frame, seq] of frameLoadSeq) {
      if (frame.isDetached()) frameLoadSeq.delete(frame);
      else if (seq > since && !loaded.has(frame)) frames.push(frame);
    }
    return frames;
  }

  /**
   * 等动作引出的同源 iframe 加载完：文档请求返回，然后 `load`（样式、脚本都到了）。
   * 每个 frame 只等一次。看不见的 iframe 不等：下载、上报用的隐藏 iframe 可能永远不触发 load。
   * 返回是否真的等过。
   */
  async function waitForFrameLoads(since: number, deadline: number, loaded: Set<Frame>): Promise<boolean> {
    let waited = false;
    for (const frame of framesToLoad(since, loaded)) {
      loaded.add(frame);
      if (!(await shownOnPage(frame))) continue;
      waited = true;
      // 文档请求回来之前，waitForLoadState 看到的还是旧文档（about:blank 早就 load 过了）
      while (documentPending(frame, since) && Date.now() < deadline) await sleep(50);
      const remaining = deadline - Date.now();
      if (remaining > 0) await frame.waitForLoadState("load", { timeout: remaining }).catch(() => undefined);
    }
    return waited;
  }

  function documentPending(frame: Frame, since: number): boolean {
    for (const [request, seq] of inflight) {
      if (seq > since && request.resourceType() === "document" && frameOf(request) === frame) return true;
    }
    return false;
  }

  /** 预热：只在 REQUIRE_FOCUS_EMULATION 为真时做一次 CDP 往返，见文件头。 */
  let warmedUp: Promise<void> | null = null;
  function ensureReady(): Promise<void> {
    warmedUp ??= REQUIRE_FOCUS_EMULATION ? enableFocusEmulation(page) : Promise.resolve();
    return warmedUp;
  }

  /**
   * 同源子 frame 的序号（从 1 起；主文档是 0），见 `FRAME_NODE_STRIDE`。
   *
   * WeakMap 让同一个 Frame 在多次观测之间保持同一个序号：节点身份要在「观测 → 决策 → 执行」
   * 之间对得上，agent 的「点了没反应」记录也要在观测之间对得上。iframe 自己导航时 Frame 对象不变、
   * 序号不变，但 snapshot.js 的节点缓存随文档重置——与主文档导航时一样，陈旧由守卫里的
   * timeOrigin / href 判出来。
   */
  const frameSeqs = new WeakMap<Frame, number>();
  const framesBySeq = new Map<number, Frame>();
  let nextFrameSeq = 1;

  function seqOf(frame: Frame): number {
    let seq = frameSeqs.get(frame);
    if (seq === undefined) {
      seq = nextFrameSeq++;
      frameSeqs.set(frame, seq);
      framesBySeq.set(seq, frame);
    }
    return seq;
  }

  /** 编码过的节点身份 → 所在 frame 与 frame 内的节点号。frame 已经不在页面上时返回 null */
  function locateNode(node: number): { frame: Frame; local: number } | null {
    const seq = Math.floor(node / FRAME_NODE_STRIDE);
    if (seq === 0) return { frame: page.mainFrame(), local: node };
    const frame = framesBySeq.get(seq);
    if (frame === undefined || frame.isDetached()) return null;
    return { frame, local: node % FRAME_NODE_STRIDE };
  }

  /**
   * 主文档之外的 frame，按源分成两类。
   *
   * 父 frame 已经跨域的跨域 frame 不单列：外层那个已经算作一块读不到的内容，
   * 里层再算一次只会把「1 块读不到」报成 2 块。
   */
  function splitChildFrames(): { sameOrigin: Frame[]; crossOrigin: Frame[] } {
    const main = page.mainFrame();
    const mainOrigin = originOf(main.url());
    const sameOrigin: Frame[] = [];
    const crossOrigin: Frame[] = [];
    const isCross = (frame: Frame): boolean => {
      const origin = originOf(frame.url());
      return origin !== null && origin !== mainOrigin;
    };
    for (const frame of page.frames()) {
      if (frame === main) continue;
      if (!isCross(frame)) sameOrigin.push(frame);
      else if (!isCross(frame.parentFrame() ?? main)) crossOrigin.push(frame);
    }
    for (const [seq, frame] of framesBySeq) if (frame.isDetached()) framesBySeq.delete(seq);
    return { sameOrigin, crossOrigin };
  }

  function toAction(raw: RawAction): Action {
    const action: Action = {
      id: raw.id ?? "",
      kind: (raw.kind ?? "click") as ActionKind,
      label: raw.label ?? "",
    };
    if (raw.role !== undefined) action.role = raw.role;
    if (raw.value !== undefined) action.value = raw.value;
    if (raw.checked !== undefined) action.checked = raw.checked;
    if (raw.selected !== undefined) action.selected = raw.selected;
    if (raw.expanded !== undefined) action.expanded = raw.expanded;
    if (raw.node !== undefined) action.node = raw.node;
    if (raw.delta !== undefined) action.delta = raw.delta;
    if (raw.rect !== undefined) action.rect = raw.rect;
    return action;
  }

  /**
   * 把各 frame 的快照拼成一次观测。
   *
   * - 元素：主文档的在前，子 frame 的在后；子 frame 的 id 限定成 `f1:e7`、node 按 `FRAME_NODE_STRIDE` 编码。
   *   几何在 snapshot.js 里已经换算到顶层视口。
   * - 滚动：滚轮固定发在 `WHEEL_AT`，落在哪个 frame 上滚的就是哪个（弹窗里的 iframe 盖住那一点时，
   *   滚的是 iframe 而不是底下的主文档）。所以 scroll_down / scroll_up 与 `scroll` 取自那个 frame，
   *   否则模型会被告知「下面还有内容」而滚不动它。
   * - 文本：主文档之后逐个接上 iframe 的文本，各带一行标题，好让模型知道哪段在弹窗里。
   *
   * 不含 iframe 时逐字等于改动前的结果（marker、文本、元素表都不变）。
   */
  function toObservation(state: PageState): Observation {
    const { main, parts } = state;
    let wheel: RawSnapshot = main;
    for (const part of parts) {
      const box = part.raw.frame;
      if (
        box &&
        WHEEL_AT.x >= box.x &&
        WHEEL_AT.y >= box.y &&
        WHEEL_AT.x < box.x + box.w &&
        WHEEL_AT.y < box.y + box.h
      ) {
        wheel = part.raw; // page.frames() 父在子前，最后命中的是最里层
      }
    }

    const guards: Record<string, unknown> = { ...(main.guards ?? {}) };
    const elements: Action[] = [];
    for (const raw of main.actions ?? []) {
      if (raw.node === undefined) continue;
      if (raw.node >= FRAME_NODE_STRIDE) continue; // 会被当成子 frame 的编码，见 FRAME_NODE_STRIDE
      elements.push(toAction(raw));
    }
    let omittedActions = main.omitted_actions ?? 0;
    const mainText = typeof main.text === "string" ? main.text : "";
    const texts = mainText === "" ? [] : [mainText];
    let textTruncated = mainText.length >= TEXT_LIMIT;
    const notices = new Set(noticesOf(main));
    const blankFrames: string[] = [];
    for (const { seq, raw } of parts) {
      const key = raw.page_key as RawPageKey | undefined;
      const box = raw.frame;
      // 不看文字：还没渲染完的页面常常是一层白色遮罩压着已经解析好的 DOM，文字读得到、元素一个都点不到
      if (
        box &&
        box.w * box.h >= BLANK_FRAME_MIN_VIEWPORT_SHARE * main.w * main.h &&
        !(raw.actions ?? []).some((rawAction) => rawAction.node !== undefined)
      ) {
        blankFrames.push(`f${seq}@${String(key?.[0])}`);
      }
      for (const rawAction of raw.actions ?? []) {
        if (rawAction.node === undefined || rawAction.node >= FRAME_NODE_STRIDE) continue;
        const node = seq * FRAME_NODE_STRIDE + rawAction.node;
        elements.push(toAction({ ...rawAction, id: `f${seq}:${rawAction.id ?? ""}`, node }));
        // 子 frame 的守卫连同它的文档身份一起存：主文档的 pageKey 管不到 iframe 里换没换过文档
        const guard: FrameGuard = [key?.[0], key?.[1], raw.guards?.[String(rawAction.node)]];
        guards[String(node)] = guard;
      }
      omittedActions += raw.omitted_actions ?? 0;
      const text = typeof raw.text === "string" ? raw.text : "";
      if (text !== "") texts.push(`[iframe f${seq}: ${raw.title || raw.url}]\n${text}`);
      textTruncated ||= text.length >= TEXT_LIMIT;
      for (const notice of noticesOf(raw)) notices.add(notice);
    }

    const actions = [
      ...elements,
      ...(wheel.actions ?? []).filter((raw) => raw.kind === "scroll").map(toAction),
      ...(main.actions ?? []).filter((raw) => raw.kind === "wait").map(toAction),
    ];
    const text = texts.join("\n\n");
    const scroll = { y: wheel.scroll?.y ?? 0, height: wheel.scroll?.height ?? 0 };
    const observation: Observation = {
      url: main.url,
      title: main.title,
      text,
      // snapshot.js 把每个 frame 的文本切到 6000 字符，任何一段到顶就认为被截断了
      textTruncated,
      w: main.w,
      h: main.h,
      scroll,
      actions,
      omittedActions,
      notices: [...notices],
      marker: markerOf(state),
      pageKey: main.page_key,
      guards,
      fingerprint: fingerprintOf(main.url, text, actions, scroll),
    };
    if (state.unreadableFrames > 0) observation.unreadableFrames = state.unreadableFrames;
    if (blankFrames.length > 0) observation.blankFrames = blankFrames;
    return observation;
  }

  /**
   * 读一次页面状态：主文档 + 每个同源 iframe，各自**一次 evaluate 取完**（见 Session.observe 的「原子性」注释）。
   *
   * 跨 frame 做不到原子，也不需要：动作只依据它所在的那个 frame 的守卫判新鲜，
   * 输入前还会在该 frame 里重解析几何、逐层命中测试到顶层（resolveTargetInPage），
   * 两次读之间 iframe 被关掉或挪走，都会在那里被拦下。
   *
   * 返回 null 只表示**主文档**现在读不了。子 frame 读不了（正在导航、刚被移除、不可见）就当它不在：
   * 弹窗里的 iframe 还没加载完，不该让整页的观测失败。
   */
  async function readState(): Promise<PageState | null> {
    // 以文本注入：snapshot.js 是 IIFE 表达式，求值即得整个状态对象
    const main = (await guarded(() => page.evaluate(loadSnapshotSource()))) as RawSnapshot | null;
    if (main === null || typeof main !== "object") return null;
    const { sameOrigin, crossOrigin } = splitChildFrames();
    const parts: FramePart[] = [];
    for (const frame of sameOrigin) {
      const raw = await readFrameSnapshot(frame);
      if (raw !== null) parts.push({ seq: seqOf(frame), raw });
    }
    let unreadableFrames = 0;
    for (const frame of crossOrigin) if (await shownOnPage(frame)) unreadableFrames++;
    return { main, parts, unreadableFrames };
  }

  /**
   * 跨域 iframe 是否在视口里占了一块看得见的地方。读不到它的内容，但要能告诉模型与报告
   * 「这里有一块读不到的东西」——否则目标恰好在里面时，失败原因只剩一句「模型选择 BLOCKED」。
   */
  async function shownOnPage(frame: Frame): Promise<boolean> {
    let handle: Awaited<ReturnType<Frame["frameElement"]>> | null = null;
    try {
      handle = await frame.frameElement();
      if (!(await handle.isVisible())) return false;
      const box = await handle.boundingBox();
      const viewport = page.viewportSize() ?? VIEWPORT;
      return (
        box !== null &&
        box.width >= UNREADABLE_FRAME_MIN_PX &&
        box.height >= UNREADABLE_FRAME_MIN_PX &&
        box.x < viewport.width &&
        box.y < viewport.height &&
        box.x + box.width > 0 &&
        box.y + box.height > 0
      );
    } catch {
      return false; // frame 在检查途中被移除：它已经不在页面上了
    } finally {
      await handle?.dispose().catch(() => undefined);
    }
  }

  async function observe(_options?: ObserveOptions): Promise<Observation> {
    // ObserveOptions.screenshot 在本实现里没有落点：Observation（冻结契约）没有
    // 承载画面的字段，需要画面时调用方另外调 frameJpeg()。见报告「契约矛盾」一节。
    await settle(SETTLE_MS.default, "document");
    let state = await readState();
    if (state === null) {
      // `snapshot.js` 只认 `document.body` 已存在的文档，因此 null 的含义是
      // **「这个页面现在读不了」**，不是「这个页面坏了」：典型场景是导航在途
      // ——旧文档已卸载、新文档还没解析出 body。
      //
      // 真跑实测会命中这里：点搜索/提交这类动作之后紧接的那次观测，常常正好落在
      // 那个窗口里，而它此前被当成运行故障（整轮运行判 error）。
      // 观测是**纯读**，所以等待与重试在这个位置是安全的——「浏览器变更从不重试」
      // 约束的是 act（动作可能已经生效，重试就是执行两次），不是读。
      await waitForDocumentReady();
      state = await readState();
    }
    if (state === null) {
      // 等过文档就绪仍然读不到：归成 StalePage，而不是致命错误。
      // 「读不到这个页面」在语义上就是「这次观测所依据的页面已经不在了」，
      // 而调用方对 StalePage 的既有处理正是正确的反应
      // （动作之后 → 记 `pageChanged: null`；决策之前 → 下一轮重新观测）。
      throw new StalePage("页面当前不可读：document.body 尚未就绪，或文档正在被替换");
    }
    return toObservation(state);
  }

  /**
   * 等当前文档进入可读状态（DOMContentLoaded）。
   *
   * 超时与失败**都吞掉**：它只是给随后那次重读一个更好的机会，不该由它来决定
   * 这次观测的成败——重读仍然读不到时，由 `observe` 判成 StalePage。
   * 超时值取得很短是刻意的：调用方要的是「现在能不能读」，而不是「等到能读为止」。
   */
  async function waitForDocumentReady(): Promise<void> {
    try {
      await page.waitForLoadState("domcontentloaded", { timeout: DOCUMENT_READY_TIMEOUT_MS });
    } catch {
      // 导航失败、被取消、或超出短超时：交给下面的重读去判。
      return;
    }
    // 刚就绪的文档常常还在解析首个脚本，再给两帧让 body 里的元素落地。
    await settle(SETTLE_MS.default, "document");
  }

  async function settle(ms: number, mode: "document" | "combobox"): Promise<void> {
    if (mode === "combobox") await guarded(() => page.evaluate(settleCombobox, ms));
    else await guarded(() => page.evaluate(settleDocument, ms));
  }

  /**
   * 整页新鲜度：重算一次 marker 再比。
   *
   * marker 是「整页语义」的载体（timeOrigin/href/滚动/视口/标题/文本/动作语义/表单值），
   * 比它才叫整页比较。重算的代价与一次 observe 相当，但调用点是终止决策
   * （DONE / BLOCKED）之后的复查——相对于一次决策往返可以忽略，而判错的代价是
   * 「模型说完了其实页面早变了」。
   */
  async function wholePageUnchanged(observed: Observation): Promise<boolean> {
    const state = await readState();
    if (!state) return false;
    return JSON.stringify(markerOf(state)) === JSON.stringify(observed.marker);
  }

  /**
   * 动作级新鲜度：只比该节点与文档身份。
   *
   * 比整页便宜，也比整页准：无关区域的一段动画不该作废一个仍然有效的决策，
   * 而节点自己的守卫（身份 / 可访问名 / 值 / 禁用 / 附近上下文文本）才决定
   * 「这一步还能不能照着原来的判断走」。
   */
  async function actionStillFresh(observed: Observation, action: Action): Promise<boolean> {
    const node = action.node;
    if (node === undefined) return wholePageUnchanged(observed);

    const located = locateNode(node);
    if (located === null) return false; // 所在的 iframe 已经不在页面上了
    const stored = observed.guards[String(node)];
    if (stored === undefined) return false;

    // 主文档节点：文档身份取自 pageKey；子 frame 节点：守卫里自带那个 frame 的文档身份（FrameGuard）
    let key: readonly unknown[] | undefined;
    let storedGuard: unknown;
    if (located.frame === page.mainFrame()) {
      key = observed.pageKey as RawPageKey | undefined;
      storedGuard = stored;
    } else {
      key = stored as FrameGuard;
      storedGuard = (stored as FrameGuard)[2];
    }
    if (!Array.isArray(key) || typeof key[0] !== "number" || typeof key[1] !== "string") {
      return false; // 拿不到文档身份就不敢说「还新鲜」，宁可贵一次重新观测
    }

    const current = (await guarded(() =>
      located.frame.evaluate(readGuardInPage, { node: located.local }),
    )) as ReturnType<typeof readGuardInPage>;
    // 缓存没了 = 文档换过了（导航会重置 window.__jev）
    if (!current) return false;
    if (current.timeOrigin !== key[0] || current.href !== key[1]) return false;
    return JSON.stringify(current.guard) === JSON.stringify(storedGuard);
  }

  async function isFresh(observed: Observation, action?: Action): Promise<boolean> {
    await ensureReady();
    if (!action) return wholePageUnchanged(observed);
    return actionStillFresh(observed, action);
  }

  async function act(action: Action, observed: Observation, text?: string | null): Promise<void> {
    await ensureReady();

    // 输入前复查（invariant §6.4）：对不上就只重新观测，不执行、不重试。
    // 此处抛错是安全的——还没有任何输入发出去。
    if (!(await isFresh(observed, action))) {
      throw new StalePage(
        `动作 ${action.id}（${action.label}）所依据的页面状态已经变化，已放弃执行`,
      );
    }

    let settleMode: "document" | "combobox" = "document";
    // 此后发出的请求才算「这次动作引出的」，见 waitForQuiet
    const requestsBefore = requestSeq;

    if (action.kind === "scroll") {
      await guarded(async () => {
        // 先把指针放到位再滚：wheel 事件发在指针当前位置，而参考项目固定发在 (550, 650)
        await page.mouse.move(WHEEL_AT.x, WHEEL_AT.y);
        await page.mouse.wheel(0, action.delta ?? 0);
      });
    } else if (action.kind === "wait") {
      // wait 没有输入，只等 settle
    } else {
      const node = action.node;
      if (node === undefined) {
        throw new JevtestError(`动作 ${action.id}（${action.label}）没有节点身份，无法执行`);
      }
      if (action.kind === "fill" && text == null) {
        // 空字符串是合法的（清空输入框），只有 null / undefined 说明调用方没拿到文本
        throw new JevtestError(
          `fill 动作 ${action.id}（${action.label}）需要一个文本值，收到的是 ${String(text)}`,
        );
      }

      const located = locateNode(node);
      if (located === null) {
        throw new StalePage(`动作 ${action.id}（${action.label}）所在的 iframe 已经不在页面上了，已放弃执行`);
      }
      // 几何重解析 + 遮挡命中测试 + select 设值，全在同一次 evaluate 里（见文件头）。
      // 在目标所在的 frame 里跑；返回的坐标已经换算到顶层，鼠标事件照常发在 page 上
      const resolution = (await guarded(() =>
        located.frame.evaluate(resolveTargetInPage, {
          node: located.local,
          kind: action.kind,
          value: action.value ?? null,
          focus: action.kind === "fill",
        }),
      )) as TargetResolution;

      if (!resolution.ok) {
        if (resolution.reason === "document-changed") {
          throw new StalePage(`动作 ${action.id} 执行时页面已经换了文档，已放弃执行`);
        }
        throw new OccludedTarget(
          `动作 ${action.id}（${action.label}）在执行前变得不可用：${describeBlocked(resolution.reason)}`,
        );
      }

      // 从这里起输入开始发出。此后的失败**不能**再走 guarded() 映射成 StalePage：
      // agent 把 StalePage 当成「浏览器没收到任何输入、可以重新决策」，而这里输入
      // 可能已经部分生效（全选成功、插入文本时页面被关），重来就是双执行（§6.2）。
      if (action.kind === "click") {
        // **真实坐标的鼠标事件，不是 locator.click()**（文件头第 1 条）
        await dispatchingInput(action, () => page.mouse.click(resolution.x, resolution.y));
      } else if (action.kind === "fill") {
        // 原生 <select> 已经在上面那次 evaluate 里设好值了，这里没有后续输入
        await dispatchingInput(action, async () => {
          await page.keyboard.press("ControlOrMeta+a");
          await page.keyboard.insertText(text as string);
        });
      }

      // 原生 <select> 的 kind 是 select：option 不参与渲染，等候选只会白等 200ms。
      // 只有**可编辑**的 combobox（自动补全）才值得等候选出现。
      if (action.role === "combobox" && action.kind !== "select") settleMode = "combobox";
    }

    // 输入之后的 settle。**这里吞掉异常是刻意的、也是必须的**：
    // 输入已经发出去了，这一等只是给页面时间渲染。点击触发的导航会让这次 evaluate
    // 撞上 "Execution context was destroyed"，若把它当失败往上抛，轨迹里就会丢掉
    // 这次真实发生的点击（invariant §6.3 的反面）。真有问题会在紧接着的
    // observe() 里暴露出来，不必在这里报。
    try {
      await settle(settleMode === "combobox" ? SETTLE_MS.combobox : SETTLE_MS.default, settleMode);
      await waitForQuiet(requestsBefore);
    } catch {
      /* 见上 */
    }
  }

  async function goto(url: string, options: GotoOptions): Promise<Observation> {
    await ensureReady();
    await guarded(() =>
      page.goto(url, { waitUntil: options.waitUntil, timeout: options.timeoutMs }),
    );
    await waitForNetworkQuiet();
    return observe();
  }

  /** 见 `LOAD_SETTLE_TIMEOUT_MS`。超时与失败都吞掉：等不到就按时继续 */
  async function waitForNetworkQuiet(): Promise<void> {
    await page.waitForLoadState("networkidle", { timeout: LOAD_SETTLE_TIMEOUT_MS }).catch(() => undefined);
  }

  function currentUrl(): string {
    return page.url();
  }

  /**
   * 采集准入统计。**只读、不调用模型**，因此可以在表单里随手点一次「检测页面」。
   *
   * 判定不在这里做：规则需要能单元测试，采集需要真浏览器（见 browser/admission.ts 文件头）。
   */
  async function probe(): Promise<AdmissionStats> {
    await ensureReady();
    const mainFrame = page.mainFrame();
    const mainOrigin = originOf(mainFrame.url());
    const totals: FrameStats = {
      shadowRoots: 0,
      canvases: 0,
      passwordFields: 0,
      fileInputs: 0,
      nestedScrollContainers: 0,
      interactiveElements: 0,
    };

    const allFrames = page.frames();
    // `frames` **含主文档在内**：主文档永远是 1，所以「有 iframe」等价于 `frames > 1`。
    // 两个能自圆其说的口径里选了这个，是因为它与文档、与 e2e 用例一致。
    // 注意 allFrames 本身就含主文档：循环里不要再给 frames 计数，否则每个子 frame 被数两次。
    const frames = allFrames.length;
    let crossOriginFrames = 0;
    for (const frame of allFrames) {
      if (frame === mainFrame) continue;
      const origin = originOf(frame.url());
      if (origin !== null && origin !== mainOrigin) {
        crossOriginFrames++; // page.frames() 能准确枚举跨域 frame，纯 JS 探测做不到
        continue;
      }
      const stats = await readFrameStats(frame);
      if (stats === null) {
        // URL 看着同源却读不到：opaque origin（data: 等）或 frame 已经消失。都按跨域算
        crossOriginFrames++;
        continue;
      }
      accumulate(totals, stats);
    }
    const main = await readFrameStats(mainFrame);
    if (main) accumulate(totals, main);

    return { frames, crossOriginFrames, ...totals };
  }

  async function frameJpeg(): Promise<Buffer> {
    await ensureReady();
    return await guarded(() => page.screenshot({ type: "jpeg", quality: 72 }));
  }

  async function close(): Promise<void> {
    // close() 在 finally 里被调用：这里抛错会掩盖真正的失败原因；
    // 而且 context 可能已经被 pool 关掉（那时 page.close() 抛 Target closed）。
    // 清理动作失败没有可做的事，唯一的正确反应是别让它污染调用方。
    try {
      await page.close();
    } catch {
      /* 见上 */
    }
  }

  return { goto, observe, isFresh, act, currentUrl, probe, frameJpeg, close };
}

// ---------------------------------------------------------------------------
// 辅助
// ---------------------------------------------------------------------------

/**
 * 指纹 = sha256(json({url, text, actions, scroll}))，与参考项目一致：追踪值与节点身份，
 * **不含截图**。
 *
 * 几何（rect）不进指纹：它在输入前总会被重新解析并命中测试（见文件头第 1 条），
 * 把它算进来会让无关区域的一次位移或动画把页面判成「变了」。snapshot.js 自己的
 * marker 同样剔除了 rect（`actions.map(({rect, ...action}) => action)`）。
 * 滚动位置进指纹：它是「页面确实变了」的正当信号。
 */
function fingerprintOf(
  url: string,
  text: string,
  actions: Action[],
  scroll: { y: number; height: number },
): string {
  const semantics = actions.map((action) => ({
    id: action.id,
    kind: action.kind,
    label: action.label,
    role: action.role,
    value: action.value,
    checked: action.checked,
    selected: action.selected,
    expanded: action.expanded,
    node: action.node,
    delta: action.delta,
  }));
  const payload = JSON.stringify({ url, text, actions: semantics, scroll });
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * 整页 marker。不含 iframe 时就是主文档的 marker 本身；含 iframe 时把每个 frame 的 marker
 * 按序号接在后面——iframe 里填了一个值、弹窗里的内容到了，整页都算变过。
 */
function markerOf(state: PageState): unknown {
  if (state.parts.length === 0) return state.main.marker;
  return [state.main.marker, ...state.parts.map((part) => [part.seq, part.raw.marker])];
}

function noticesOf(raw: RawSnapshot): string[] {
  return Array.isArray(raw.notices) ? raw.notices.filter((notice) => typeof notice === "string") : [];
}

/**
 * 在一个同源子 frame 里跑 snapshot.js。读不了就返回 null：frame 正在导航、刚被移除，
 * 或 snapshot.js 判定它在顶层看不见（自身不可见、祖先跨域）。**不过 guarded()**：
 * 子 frame 的导航是常态，映射成 StalePage 会让整页观测跟着失败。
 */
async function readFrameSnapshot(frame: Frame): Promise<RawSnapshot | null> {
  try {
    const raw = (await frame.evaluate(loadSnapshotSource())) as RawSnapshot | null;
    return raw !== null && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/** 把页面侧给的失败原因翻成给人看的一句话。 */
function describeBlocked(reason: string): string {
  switch (reason) {
    case "detached":
      return "元素已从文档里移除";
    case "hidden":
      return "元素已不可见";
    case "disabled":
      return "元素已被禁用";
    case "zero-size":
      return "元素没有可点击的尺寸";
    case "offscreen":
      return "元素已移出视口";
    case "occluded":
      return "元素中心点被别的元素盖住（elementFromPoint 命中到了它人）";
    case "option-missing":
      return "要找的 option 已经不在这个下拉里了";
    case "option-disabled":
      return "该 option 已被禁用";
    case "option-not-set":
      return "设值没有生效（页面在设值后立刻改回了原值）";
    case "frame-unreachable":
      return "元素所在的 iframe 已经换不到顶层坐标（它或它的某层父文档变成了跨域）";
    default:
      return reason;
  }
}

/** 请求所在的 frame。Service Worker 发出的请求没有 frame，Playwright 此时会抛错 */
function frameOf(request: Request): Frame | null {
  try {
    return request.frame();
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * frame URL 的源。`null` = 它继承了父文档的源（about:blank / about:srcdoc），
 * 因此与主文档同源，不算跨域。
 *
 * `data:` 之类 opaque origin 在 URL API 里 origin 就是字符串 `"null"`，
 * 它永远不等于主文档的源，因此会被算作跨域——这正是浏览器里的实际行为。
 */
function originOf(rawUrl: string): string | null {
  if (!rawUrl || rawUrl.startsWith("about:")) return null;
  try {
    return new URL(rawUrl).origin;
  } catch {
    return null;
  }
}

async function readFrameStats(frame: Frame): Promise<FrameStats | null> {
  try {
    return (await frame.evaluate(probeFrameInPage, {
      thresholdPx: SCROLL_OVERFLOW_THRESHOLD_PX,
    })) as FrameStats;
  } catch {
    // 跨域 frame 的同源策略拦截，或 frame 在探测途中消失。
    // 「检测页面」这个按钮不该因为页面有 iframe 就报错
    return null;
  }
}

function accumulate(totals: FrameStats, stats: FrameStats): void {
  totals.shadowRoots += stats.shadowRoots;
  totals.canvases += stats.canvases;
  totals.passwordFields += stats.passwordFields;
  totals.fileInputs += stats.fileInputs;
  totals.nestedScrollContainers += stats.nestedScrollContainers;
  totals.interactiveElements += stats.interactiveElements;
}

/**
 * CDP 逃生舱：让页面在后台时也保持动画帧。
 *
 * 默认关（REQUIRE_FOCUS_EMULATION 为 false）：页面是我们自己的前台页，不需要它。
 * 唯一需要它的场景是 connectOverCDP 复用已有的可见浏览器——那时页面可能不在前台，
 * 动画会被节流，rAF 等待会莫名变慢。
 */
async function enableFocusEmulation(page: Page): Promise<void> {
  let cdp: CDPSession | null = null;
  try {
    cdp = await page.context().newCDPSession(page);
    await cdp.send("Emulation.setFocusEmulationEnabled", { enabled: true });
  } catch (error) {
    // 逃生舱失败不该让整次运行起不来：它是优化，不是功能
    throw new JevtestError(
      "REQUIRE_FOCUS_EMULATION 已开启，但 CDP 会话建不起来（只有 Chromium 支持这条命令）",
      { cause: error },
    );
  } finally {
    if (cdp) await cdp.detach().catch(() => undefined);
  }
}
