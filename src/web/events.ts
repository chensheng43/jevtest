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

import type { EventSink, RunEvent, SeqEvent } from "../schema/events.ts";

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
  // runId 只用于校验调用方拿的是不是同一个运行的日志——事件本身已经带了 runId，
  // 所以这里只需要在日志对象上留个记号，不必再往每条事件里塞一遍。
  const log = createLog(capacity);
  return {
    ...log,
    emit: (event) => {
      if (event.runId !== runId) {
        throw new Error(`事件 runId (${event.runId}) 与日志 (${runId}) 不匹配：写错日志会让前端串台`);
      }
      log.emit(event);
    },
  };
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
  // 全局总线不校验 runId——它本来就是跨运行的，来源靠事件自带的 runId 区分。
  const log = createLog();
  return { emit: (event) => log.emit(event), subscribe: (since) => log.subscribe(since) };
}

/**
 * 保留多少个**已结束**运行的事件日志（未结束的运行一律保留，不计入这个上限）。
 *
 * 已结束的运行**不能立刻丢日志**：前端刷新页面时会从 `seq = 0` 重放，
 * 那时运行早就结束了。但也不能无限留——每个日志最多 500 条事件。
 * 100 个运行 × 500 条 ≈ 几万条小对象，对本项目的规模是安全的量级，
 * 同时保证了「翻回上一次运行」这条最常见的用法还能看到过程。
 */
export const MAX_RETAINED_LOGS = 100;

/**
 * 事件路由器：把 runner 发出的**单一事件流**分派到各运行自己的日志。
 *
 * 为什么要这一层：`RunnerDeps.events` 是一个 `EventSink`，而前端要按 runId
 * 增量拉取（`GET /api/runs/:id/events`）。若只给全局总线，列表页够用但结果页
 * 拿不到「该运行的历史」；若只给单运行日志，列表页就得订阅每个运行。
 *
 * 按 `runId` 分派同时解决了两件事，代价只是这里十几行。
 */
export interface EventRouter {
  /** 传给 `RunnerDeps.events` 的那个 sink */
  sink: EventSink;
  /** 取（或按需创建）某个运行的事件日志。只给写入方（sink）用 */
  log(runId: string): EventLog;
  /**
   * 只读查找，**不创建**。读端点必须用它：用 log() 的话，每个查询一个未知 runId
   * （服务重启前的历史运行、手输的 id）都会建出一个永远不会被 retire 的空日志。
   */
  peek(runId: string): EventLog | null;
  bus: GlobalBus;
  /** 运行结束、报告已落盘后调用，按 MAX_RETAINED_LOGS 淘汰最旧的日志 */
  retire(runId: string): void;
}

export function createEventRouter(): EventRouter {
  /**
   * 未结束的运行。**从不淘汰**：一次入队 150 个用例时，排在后面的还没跑、却已经
   * 有 run.queued 事件；把它们和已结束的放进同一个 LRU，第一批跑完时就会把它们挤掉，
   * 之后 seq 从 1 重来，前端拿着旧的 since 会一直看不到进度。
   */
  const live = new Map<string, EventLog>();
  /** 已结束（retire 过）的运行。插入顺序即完成先后，超过上限从头丢 */
  const retired = new Map<string, EventLog>();
  const bus = createGlobalBus();

  const peek = (runId: string): EventLog | null => live.get(runId) ?? retired.get(runId) ?? null;

  const log = (runId: string): EventLog => {
    const existing = peek(runId);
    if (existing !== null) return existing;
    const created = createEventLog(runId);
    live.set(runId, created);
    return created;
  };

  return {
    sink: {
      emit: (event) => {
        // 先入该运行的日志再上总线：总线是「顺便看一眼」的旁路，
        // 任何一边出问题都不该让另一边收不到事件。
        log(event.runId).emit(event);
        bus.emit(event);
      },
    },
    log,
    peek,
    bus,
    retire: (runId) => {
      const existing = live.get(runId);
      if (existing === undefined) return;
      live.delete(runId);
      retired.set(runId, existing);
      while (retired.size > MAX_RETAINED_LOGS) {
        const oldest = retired.keys().next().value;
        if (oldest === undefined || oldest === runId) break;
        retired.delete(oldest);
      }
    },
  };
}

/**
 * 两种日志的公共实现。
 *
 * 抽出来的唯一理由是**订阅语义必须完全一致**——两处各写一遍的话，
 * 「close 后挂起的 next 立即返回 null」这类细节迟早只在一边被改对。
 */
function createLog(capacity: number = DEFAULT_CAPACITY): EventLog {
  /** 环形缓冲。超出容量时从头部丢弃——前端已按 seq 增量消费，丢的只会是更早的历史。 */
  const buffer: SeqEvent[] = [];
  /**
   * 唤醒器集合。
   *
   * 每个挂起的 `next()` 往里放一个「叫醒我」的回调：新事件到达或日志关闭时全部触发，
   * 让它们各自回循环里重新判断（而不是在这里替它们决定返回什么）。
   * 这样 `next()` 的正确性只依赖循环本身，不依赖唤醒的时机与次数。
   */
  const waiters = new Set<() => void>();
  let seq = 0;
  let closed = false;

  const wakeAll = (): void => {
    for (const wake of [...waiters]) wake();
  };

  const emit = (event: RunEvent): void => {
    if (closed) return; // 关闭后的事件是迟到者（例如 cancel 后的收尾日志），丢弃比抛错合适
    seq += 1;
    // 展开联合类型再补字段，TS 无法自行推出这是 SeqEvent 的分支，故断言。
    const withSeq = { ...event, seq, ts: new Date().toISOString() } as SeqEvent;
    buffer.push(withSeq);
    while (buffer.length > capacity) buffer.shift();
    wakeAll();
  };

  const subscribe = (since: number): Subscription => {
    /**
     * 游标是**每个订阅自己的**，不共享。
     *
     * 共享游标看起来更省事，但两个前端标签页就会互相抢事件：A 拉走的事件 B 再也看不到。
     */
    let cursor = Number.isFinite(since) ? since : 0;
    let active = true;

    const replay = buffer.filter((event) => event.seq > cursor);
    if (replay.length > 0) {
      // 回放的事件在语义上「已经消费过」——所以游标直接推进到最新，
      // 否则下一次 next() 会把同一批事件再发一遍。
      cursor = replay[replay.length - 1]?.seq ?? cursor;
    }

    return {
      replay,
      async next(timeoutMs: number): Promise<SeqEvent | null> {
        const deadline = Date.now() + Math.max(0, timeoutMs);
        for (;;) {
          if (!active || closed) return null;
          const found = buffer.find((event) => event.seq > cursor);
          if (found) {
            cursor = found.seq;
            return found;
          }
          const remaining = deadline - Date.now();
          if (remaining <= 0) return null;
          await new Promise<void>((resolve) => {
            // 唤醒器把自己从集合里摘掉再 resolve：超时与「被唤醒」走同一条清理路径，
            // 避免回调在 waiters 里越积越多。
            const wake = (): void => {
              waiters.delete(wake);
              clearTimeout(timer);
              resolve();
            };
            const timer = setTimeout(wake, remaining);
            waiters.add(wake);
          });
        }
      },
      unsubscribe(): void {
        active = false;
        wakeAll();
      },
    };
  };

  const close = (): void => {
    closed = true;
    wakeAll();
  };

  return {
    emit,
    subscribe,
    lastSeq: () => seq,
    all: () => [...buffer],
    close,
  };
}
