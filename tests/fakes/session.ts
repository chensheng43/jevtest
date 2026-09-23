/**
 * `FakeSession` —— `Session` 接口的确定性替身。
 *
 * 存在的理由就是 `core/` 只依赖 `browser/session.ts` 的接口、从不 import playwright
 * （见 architecture.md §1）。于是 agent 与 runner 的**全部控制流**都能在零成本、
 * 无浏览器、无网络的条件下被测试，而且完全确定：同样的脚本必然得到同样的轨迹。
 *
 * 三个设计要点：
 *
 *   1. **页面序列而不是「一个页面」。** `goto` 消费第一项，之后每次 `observe()`
 *      消费下一项，序列用尽则**重复最后一项**。重复是刻意的默认：多数测试想表达的
 *      是「页面不动了」，让它自己写 N 份相同观测只会掩盖意图；要表达「页面变了」
 *      就再给一项不同 `fingerprint` 的观测。
 *
 *   2. **`act` 只记账，不改页面。** 执行后的新页面来自序列里的下一项 `observe()`。
 *      这一点与真实实现一致（动作的后果由下一次观测体现），也让「动作发生了但
 *      观测失败」这种情形可以精确地写出来（下一项给一个 `{ error: new StalePage() }`）。
 *
 *   3. **调用次数与参数全部留痕。** 护栏类断言的核心就是「`act` 调用次数为 0」，
 *      而「变更不重试」的核心是「同一个动作只对应一次 `act`」——两者都必须能直接读出来。
 *
 * 它**不**模拟的东西（有意）：几何、遮挡、真实 DOM。那些属于 `playwright-session.ts`
 * 的职责，只能在 e2e 里验（见 `tests/e2e/`）。
 */

import type { Action, GotoOptions, Observation, ObserveOptions, Session } from "../../src/browser/session.ts";
import type { AdmissionStats } from "../../src/schema/report.ts";
import type { ActionKind } from "../../src/schema/events.ts";

/**
 * 一次脚本化的观测。三种形态：
 *   - `Observation` —— 观测成功；
 *   - `{ error }`   —— 观测抛错（例如 `StalePage`：导航打断了这次读取）；
 *   - `{ hang }`    —— **永不返回**。用来把运行卡在「在途」状态上，好测停机超时
 *                     与「等它收尾」这类只能在半路上观察的行为。
 */
export type ObservationStep = Observation | { error: Error } | { hang: true };

export interface FakeSessionOptions {
  /**
   * `goto()` 与各次 `observe()` 依次消费的观测序列。
   *
   * 用尽后**重复最后一项**（空序列则返回一个空白默认页）。因此：
   *   - `[a]`                 = 起始页 a，之后每次观测都还是 a（页面无变化）
   *   - `[a, b]`              = 起始页 a，第一个动作之后变成 b，往后一直是 b
   *   - `[a, { error: ... }]` = 起始页 a，动作之后的观测失败（`pageChanged` 记 null）
   */
  observations?: ObservationStep[];
  /** 每次 `act()` 成功前调一次。用于「在动作中间触发取消」这类场景 */
  onAct?: (action: Action, text: string | null) => void;
  /** `act()` 是否抛错（例如执行前最后一刻变成不可点） */
  actError?: Error;
  /** `goto()` 是否抛错（起始地址打不开） */
  gotoError?: Error;
  /** `probe()` 的返回值。默认全零（任何规则都不命中） */
  admission?: Partial<AdmissionStats>;
  /** `probe()` 是否抛错。准入探测失败不该让运行失败，因此这条路径必须能被测到 */
  probeError?: Error;
  /**
   * `isFresh()` 的判定。默认：与「当前页面」的 `fingerprint` 相同即新鲜。
   * 需要模拟「页面语义未变但决策已陈旧」时传一个自定义函数。
   */
  freshness?: (page: Observation, action?: Action) => boolean;
}

/** 一次 `act` 的调用记录。`text` 是 TYPE_TEXT 实际输入的文本。 */
export interface ActCall {
  action: Action;
  page: Observation;
  text: string | null;
}

const EMPTY_ADMISSION: AdmissionStats = {
  frames: 0,
  crossOriginFrames: 0,
  shadowRoots: 0,
  canvases: 0,
  passwordFields: 0,
  fileInputs: 0,
  nestedScrollContainers: 0,
  interactiveElements: 0,
};

export class FakeSession implements Session {
  /** 每一次 `act` 的完整参数。**护栏与不重试语义的断言就靠它** */
  readonly actCalls: ActCall[] = [];
  /** 每一次 `goto` 的地址 */
  readonly gotoUrls: string[] = [];
  observeCalls = 0;
  probeCalls = 0;
  closeCalls = 0;
  frameCalls = 0;

  readonly #steps: ObservationStep[];
  readonly #options: FakeSessionOptions;
  #cursor = 0;
  #current: Observation | null = null;
  #closed = false;

  constructor(options: FakeSessionOptions = {}) {
    this.#options = options;
    this.#steps = options.observations ?? [];
  }

  /** 当前页面（最近一次成功观测）。还没观测过时为 null */
  get current(): Observation | null {
    return this.#current;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get actCount(): number {
    return this.actCalls.length;
  }

  goto(url: string, _options: GotoOptions): Promise<Observation> {
    this.gotoUrls.push(url);
    if (this.#options.gotoError !== undefined) return Promise.reject(this.#options.gotoError);
    const step = this.#take();
    return step === null ? neverSettles() : Promise.resolve(step);
  }

  observe(_options?: ObserveOptions): Promise<Observation> {
    this.observeCalls += 1;
    try {
      const step = this.#take();
      return step === null ? neverSettles() : Promise.resolve(step);
    } catch (error) {
      return Promise.reject(error);
    }
  }

  isFresh(page: Observation, action?: Action): Promise<boolean> {
    const custom = this.#options.freshness;
    if (custom !== undefined) return Promise.resolve(custom(page, action));
    // 默认按整页指纹比较：与「当前页面」同一个 fingerprint 即新鲜。
    // 这正是真实实现里最粗的那一层比较，足以驱动循环的每条分支。
    return Promise.resolve(this.#current !== null && this.#current.fingerprint === page.fingerprint);
  }

  async act(action: Action, page: Observation, text?: string | null): Promise<void> {
    // 先记账再抛：调用本身发生了，即使它在输入前失败——「调用了几次」这件事
    // 不能因为成败而看不见（护栏断言要的正是这个数）。
    this.actCalls.push({ action, page, text: text ?? null });
    if (this.#options.actError !== undefined) throw this.#options.actError;
    this.#options.onAct?.(action, text ?? null);
  }

  currentUrl(): string {
    if (this.#closed) throw new Error("FakeSession：会话已关闭，读不到当前地址");
    return this.#current?.url ?? "";
  }

  probe(): Promise<AdmissionStats> {
    this.probeCalls += 1;
    if (this.#options.probeError !== undefined) return Promise.reject(this.#options.probeError);
    return Promise.resolve({ ...EMPTY_ADMISSION, ...this.#options.admission });
  }

  frameJpeg(): Promise<Buffer> {
    this.frameCalls += 1;
    // 只有 JPEG 的 SOI/EOI 标记，够让落盘与文件服务的测试验到「写的就是这几个字节」
    return Promise.resolve(Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  }

  close(): Promise<void> {
    this.closeCalls += 1;
    this.#closed = true;
    return Promise.resolve();
  }

  /**
   * 取下一项观测。用尽则重复最后一项。
   *
   * 返回 `null` 表示这一项是 `{ hang: true }`：调用方要把它变成一个**永不 settle**
   * 的 promise，而不是返回值或抛错——「卡住」正是它要模拟的东西。
   */
  #take(): Observation | null {
    const step = this.#steps[this.#cursor];
    if (step === undefined) {
      const last = this.#steps[this.#steps.length - 1];
      if (last === undefined) return makeObservation();
      return this.#materialize(last);
    }
    this.#cursor += 1;
    return this.#materialize(step);
  }

  #materialize(step: ObservationStep): Observation | null {
    if (isHanging(step)) return null;
    if ("error" in step) throw step.error;
    this.#current = step;
    return step;
  }
}

/** 永不 settle 的读取。**不持有任何句柄**，因此不会阻止进程退出。 */
function neverSettles(): Promise<Observation> {
  return new Promise<Observation>(() => {
    /* 刻意不 resolve：模拟一次卡住的读取 */
  });
}

function isHanging(step: ObservationStep): step is { hang: true } {
  return typeof step === "object" && step !== null && "hang" in step && step.hang === true;
}

// ---------------------------------------------------------------------------
// 构造观测与动作
// ---------------------------------------------------------------------------

/**
 * 造一份观测。`fingerprint` 是唯一需要测试自己操心的字段——
 * 「页面变了吗」这个问题在实现里就是比它，所以默认值给一个固定的串，
 * 想表达变化就显式传一个新的。
 */
export function makeObservation(overrides: Partial<Observation> = {}): Observation {
  return {
    url: "https://example.test/start",
    title: "示例页面",
    text: "hello world",
    textTruncated: false,
    w: 1280,
    h: 720,
    scroll: { y: 0, height: 720 },
    actions: [],
    omittedActions: 0,
    notices: [],
    marker: { kind: "page" },
    pageKey: { href: "https://example.test/start" },
    guards: {},
    fingerprint: "fp-0",
    ...overrides,
  };
}

/** 造一个动作。`node` 是 code-owned 身份，元素动作必须有它才会进候选集 */
export function makeAction(input: {
  id: string;
  kind: ActionKind;
  label: string;
  role?: string;
  node?: number;
  value?: string;
  delta?: number;
}): Action {
  const action: Action = { id: input.id, kind: input.kind, label: input.label };
  if (input.role !== undefined) action.role = input.role;
  if (input.node !== undefined) action.node = input.node;
  if (input.value !== undefined) action.value = input.value;
  if (input.delta !== undefined) action.delta = input.delta;
  return action;
}

/**
 * 一个「有链接可点、有输入框可填」的页面。
 *
 * 两个元素都在，因此 `click_target` 与 `type_text_target` 两个 head 都非空——
 * scripted 引擎必须给出每个 head 的答案，head 为空会让问题根本不被提出。
 */
export function interactiveActions(): Action[] {
  return [
    makeAction({ id: "e1", kind: "click", label: "More information", role: "link", node: 1 }),
    makeAction({ id: "e2", kind: "fill", label: "Search", role: "textbox", node: 2 }),
    makeAction({ id: "scroll_down", kind: "scroll", label: "向下滚动", delta: 600 }),
    makeAction({ id: "wait", kind: "wait", label: "等待" }),
  ];
}

/** 造一个「只有文本、没有可交互元素」的页面：动作空间里只剩 DONE / BLOCKED。 */
export function textOnlyPage(overrides: Partial<Observation> = {}): Observation {
  return makeObservation({ actions: [], ...overrides });
}
