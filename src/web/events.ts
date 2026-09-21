/**
 * 事件日志：环形缓冲 + 订阅者 + 序号。
 *
 * 每个运行一个 EventLog。前端按 `seq` 增量拉取：请求带上
 * `?since=<上次拿到的 seq>`，服务端回放该序号之后的事件。
 * 因此**刷新页面不会丢历史**——用户能看到自己刷新前发生的一切。
 *
 * 这里刻意用**轮询**而不是 SSE。理由：进度事件是服务端单向推送，
 * 500ms 轮询在这个规模下完全够用（一次运行约 10~20 步，几步/秒），
 * 而 SSE 会引入连接生命周期、心跳、断线重连、以及 Hono 那类框架里
 * `writeSSE` 在连接静默断开时挂起的已知问题。少一个长期存在的失败面。
 *
 * 如果将来确实需要 SSE，改动集中在本文件与 api.ts 的一个端点，
 * 事件模型本身不用动——`seq` 语义天然兼容 `Last-Event-ID`。
 */

import type { RunEvent, SeqEvent } from "../schema/events.ts";

/** 环形缓冲容量。一次运行的事件数远小于此，留足余量 */
export const DEFAULT_CAPACITY = 500;

export interface Subscription {
  /** 回放：订阅时刻已存在、且 seq 大于 since 的事件 */
  replay: SeqEvent[];
  /** 等待下一条事件，超时返回 null（便于轮询端点直接返回） */
  next(timeoutMs: number): Promise<SeqEvent | null>;
  unsubscribe(): void;
}

export interface EventLog {
  /** 补上 seq 与时间戳后入缓冲并广播 */
  emit(event: RunEvent): void;
  /** 订阅。`since` 为上次拿到的序号，0 表示要全部历史 */
  subscribe(since: number): Subscription;
  /** 自增序号，供前端做增量拉取 */
  lastSeq(): number;
  /** 已缓冲的全部事件，用于运行结束后一次性回读 */
  all(): SeqEvent[];
  /** 结束订阅：所有挂起的 next() 立即返回 null */
  close(): void;
}

export function createEventLog(runId: string, capacity?: number): EventLog {
  throw new Error("未实现：P0 待实现");
}

/**
 * 跨运行的全局事件总线。
 *
 * 用途是列表页：用户不必盯着某一个运行，也能看到「刚跑完一个，通过了」。
 * 与单运行的 EventLog 分开，避免一个长跑的缓冲把别人的挤掉。
 */
export interface GlobalBus {
  emit(event: RunEvent): void;
  subscribe(since: number): Subscription;
}

export function createGlobalBus(): GlobalBus {
  throw new Error("未实现：P0 待实现");
}
