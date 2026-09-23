/**
 * 错误类型。**这是叶模块**，browser 与 core 都从这里 import，它不 import 任何东西。
 *
 * 这些类不是装饰——每一种都对应一条**必须区别对待**的失败路径。
 * 混淆它们的代价在处理导航时最明显：把 `StalePage` 当成 `error` 会让
 * 每一次正常的页面跳转都被记为运行失败，报告直接失去意义。
 */

/** 基类。便于在最外层一次捕获所有「预期内的失败」。 */
export class JevtestError extends Error {
  override readonly name: string = "JevtestError";
}

/**
 * 决策所指的页面已经不是当前页面。
 *
 * **在观测路径上这是正常控制流，不是故障。** 页面在观测与执行之间发生了变化，
 * 正确反应是丢弃这次决策、重新观测，而不是报错或重试动作。
 * 参考项目 `jev_ultrafast/browser.py:16` 的 StalePage 是同一个东西。
 *
 * ⚠️ **但 `act()` 抛出的 StalePage 不能一律当作「什么都没发生」**：
 * 输入前的新鲜度复查抛它时确实如此，可 `page.mouse.click` 之后的 settle 阶段
 * 也可能因导航而抛——那时动作**已经生效了**。因此调用方不能给 `act` 加「捕获后重试」
 * 或「捕获后丢弃并重发」的包装，否则就是 §6.2 说的双执行。
 */
export class StalePage extends JevtestError {
  override readonly name = "StalePage";
}

/**
 * 目标在执行前的最后一刻变得不可点：被移除、被遮挡、移出视口或被禁用。
 *
 * 与 StalePage 的区别：这里页面整体没变，只是这个元素不可用了。
 * 同样不重试动作——参考项目的原则是「浏览器变更从不重试」。
 */
export class OccludedTarget extends JevtestError {
  override readonly name = "OccludedTarget";
}

/**
 * 输入**已经开始发出**之后失败了：鼠标/键盘事件可能已经部分或全部生效。
 *
 * 与 StalePage / OccludedTarget 的根本区别：那两个保证「浏览器一个字节都没收到」，
 * 调用方可以丢掉决策重来；这个**不能重来**——重来就可能是双击、重复输入（§6.2）。
 * 调用方应当把这一步当作已执行，照常记录并重新观测，由观测结果说明发生了什么。
 */
export class InputInterrupted extends JevtestError {
  override readonly name = "InputInterrupted";
}

/**
 * 模型输出不合法：choice 不在候选集内、概率键不匹配、概率和不为 1、
 * choice 不是最大值。**此时绝不能执行任何动作。**
 */
export class InvalidDecision extends JevtestError {
  override readonly name = "InvalidDecision";
}

/**
 * 安全护栏拦截。**这是好结果**——说明护栏起作用了，
 * 浏览器没有收到任何输入。报告里应显著展示，而不是当成普通错误。
 */
export class GuardrailBlocked extends JevtestError {
  override readonly name = "GuardrailBlocked";
}

/** 撞到用例预算上限。已产生的轨迹必须保留，供断言层对部分轨迹求值。 */
export class BudgetExceeded extends JevtestError {
  override readonly name = "BudgetExceeded";
}

/** 用户取消。与预算耗尽一样，保留已有轨迹。 */
export class Cancelled extends JevtestError {
  override readonly name = "Cancelled";
}

/**
 * 把 Playwright 抛出的错误映射成本项目的错误类型。
 *
 * **这条映射是必需的，不是优化。** 页面导航时 Playwright 会抛
 * `Execution context was destroyed` 或 `Target closed`；若不映射成 StalePage，
 * 每一次正常跳转都会被判为运行失败。
 * 对应参考项目 `jev_ultrafast/browser.py:40-41` 对 `exceptionDetails` 的处理。
 */
export function mapBrowserError(error: unknown): JevtestError {
  // 已经是我们自己的错误就不再包一层。**这条不能少**：act() 里主动抛的
  // OccludedTarget 会穿过同一批 catch，被二次包装会丢掉它的类型，
  // 而调用方正是靠类型区分「元素不可点」与「页面换了」。
  if (error instanceof JevtestError) return error;

  const message = error instanceof Error ? error.message : String(error);

  // 顺序有意：先判导航类。一次导航会同时产生
  // "Execution context was destroyed" 与后续的 "Target closed"，
  // 两者都归 StalePage，但先匹配到的更贴近真实原因。
  if (STALE_MESSAGES.some((pattern) => pattern.test(message))) {
    return new StalePage(message, { cause: error });
  }
  if (OCCLUDED_MESSAGES.some((pattern) => pattern.test(message))) {
    return new OccludedTarget(message, { cause: error });
  }
  // 认不出来的失败原样保留消息与 cause——报告里要能看到 Playwright 的原话，
  // 否则排查崩溃时只剩一句「运行失败」。
  return new JevtestError(message, { cause: error });
}

/**
 * 导航打断：**正常控制流**，不是故障。
 *
 * 每一条都对应一次「页面在观测与执行之间换了文档」。漏掉任何一条，
 * 那种跳转就会被记成运行失败（见 docs/development.md §5.3）。
 */
const STALE_MESSAGES: readonly RegExp[] = [
  /execution context was destroyed/i,
  /cannot find context with specified id/i,
  /target closed/i,
  /target page, context or browser has been closed/i,
  /browser has been closed/i,
  /page has been closed/i,
  /navigating frame was detached/i,
  /frame was detached/i,
  /frame got detached/i,
];

/**
 * 目标在最后一刻变得不可用：被移除、被遮挡、移出视口、被禁用。
 *
 * 这些消息只在**我们不该继续操作这个元素**时出现。注意 `element is not stable`：
 * Playwright 在元素还在动时给这条，而「还在动」正是应该重新决策而不是硬点下去的时刻。
 */
const OCCLUDED_MESSAGES: readonly RegExp[] = [
  /element is not visible/i,
  /element is outside of the viewport/i,
  /intercepts pointer events/i,
  /element is not stable/i,
  /element is not enabled/i,
  /element is disabled/i,
  /element is not attached to the dom/i,
  /element was detached from the dom/i,
  /element does not have a bounding box/i,
];
