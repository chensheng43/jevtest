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
 * **这是正常控制流，不是故障。** 页面在观测与执行之间发生了变化，
 * 正确反应是丢弃这次决策、重新观测，而不是报错或重试动作。
 * 参考项目 `jev_ultrafast/browser.py:16` 的 StalePage 是同一个东西。
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
  throw new Error("未实现：P0 待实现");
}
