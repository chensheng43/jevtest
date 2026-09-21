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
 */

import type { Session } from "./session.ts";

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

export interface PlaywrightSessionOptions {
  /** 由 BrowserPool 提供的已就绪 page。Session 不负责创建或销毁上下文 */
  page: unknown;
  /** 是否录制 trace。开启后 stop() 写出 trace.zip */
  tracing?: boolean;
  tracePath?: string;
}

export function createPlaywrightSession(options: PlaywrightSessionOptions): Session {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现 observe()
//   - 一次 page.evaluate(READ_STATE) 取完所有内容；snapshot.js 以文本读出后注入。
//   - 返回结构是 snake_case（page_key / omitted_actions），在此映射成 TS 的 Observation；
//     保持原版字段名是为了让上游更新可以直接 diff，不要为了好看在 JS 里改名。
//   - fingerprint = sha256(json({url, text, actions, scroll}))，与参考项目
//     browser.py:115-117 一致：追踪值与节点身份，**不含截图**。
//
// TODO(P0): 实现 settle —— 参考项目 browser.py:44-86 在 observe 前等待页面稳定。
//   普通交互等两个 rAF 或 50ms；可编辑 combobox 等可见 option 出现，上限 200ms。
//   不等待的代价是：为一个还没渲染出候选的自动补全框付一次决策请求。
//
// TODO(P0): 实现 act()
//   - 输入前 isFresh 复查；然后**在同一次 evaluate 里**重新解析几何 +
//     elementFromPoint 遮挡测试 + 执行 select 的设值派发；
//   - click 用 page.mouse.click(x, y)；fill 用 ControlOrMeta+a 后 keyboard.insertText。
//
// TODO(P0): 错误映射 —— 用 core/errors.ts 的 mapBrowserError 把
//   "Execution context was destroyed" / "Target closed" 映射成 StalePage。
//   漏了这一步，每次正常导航都会被记成运行失败。
//
// TODO(P0): trace —— tracing 开启时 context.tracing.start({screenshots:true,
//   snapshots:true, sources:true})，**stop() 必须放在 finally**，
//   否则异常路径下 trace.zip 不落盘，丢掉的恰好是最需要看的那次运行。
