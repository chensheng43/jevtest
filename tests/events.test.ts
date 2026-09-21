/**
 * 事件日志的单元测试。
 *
 * 这里守的是**前端增量渲染的前提**：`seq` 单调、回放不重复、
 * 刷新页面能拿到历史、运行结束后挂起的读取会立即返回而不是挂死。
 * 任何一条破了都不会报错，只会让界面显示得莫名其妙。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import type { RunEvent } from "../src/schema/events.ts";
import { createEventLog, createGlobalBus } from "../src/web/events.ts";

const RUN = "run-1";

function log(type: "info" | "warn" | "error" = "info", message = "m"): RunEvent {
  return { type: "run.log", runId: RUN, level: type, message };
}

test("emit 补上单调递增的 seq 与时间戳", () => {
  const events = createEventLog(RUN);
  events.emit(log("info", "a"));
  events.emit(log("info", "b"));
  const all = events.all();
  assert.equal(all.length, 2);
  assert.deepEqual(
    all.map((e) => e.seq),
    [1, 2],
  );
  assert.equal(events.lastSeq(), 2);
  assert.equal(Number.isNaN(Date.parse(all[0]!.ts)), false);
});

test("订阅回放 since 之后的历史，且不重复发送", async () => {
  const events = createEventLog(RUN);
  events.emit(log("info", "a"));
  events.emit(log("info", "b"));
  events.emit(log("info", "c"));

  // 刷新页面时前端就是这样拿回历史的。
  const sub = events.subscribe(1);
  assert.deepEqual(
    sub.replay.map((e) => e.seq),
    [2, 3],
  );
  // 回放过的不能再来一遍——否则界面会把同一步渲染两次。
  events.emit(log("info", "d"));
  const next = await sub.next(10);
  assert.equal(next?.seq, 4);
});

test("next 在没有新事件时超时返回 null", async () => {
  const events = createEventLog(RUN);
  const sub = events.subscribe(0);
  const started = Date.now();
  const result = await sub.next(30);
  assert.equal(result, null);
  // 必须是「等满超时」而不是立即返回：轮询端点靠它做长轮询。
  assert.equal(Date.now() - started >= 25, true);
});

test("挂起的 next 会被新事件唤醒", async () => {
  const events = createEventLog(RUN);
  const sub = events.subscribe(0);
  const pending = sub.next(5_000);
  events.emit(log("warn", "wake"));
  const event = await pending;
  assert.equal(event?.seq, 1);
  assert.equal(event?.type, "run.log");
});

test("close 后挂起的 next 立即返回 null", async () => {
  const events = createEventLog(RUN);
  const sub = events.subscribe(0);
  const pending = sub.next(5_000);
  events.close();
  // 不返回意味着 worker 或 HTTP 处理器永远挂着，进程关不掉。
  assert.equal(await pending, null);
  // 关闭之后的新事件同样读不到。
  assert.equal(await sub.next(10), null);
});

test("unsubscribe 让该订阅的 next 立即返回", async () => {
  const events = createEventLog(RUN);
  const sub = events.subscribe(0);
  const pending = sub.next(5_000);
  sub.unsubscribe();
  assert.equal(await pending, null);
});

test("两个订阅互不抢事件（游标是各自的）", async () => {
  const events = createEventLog(RUN);
  events.emit(log("info", "a"));
  const one = events.subscribe(0);
  const two = events.subscribe(0);

  // 已存在的事件走 replay：两个标签页都能看到完整历史。
  assert.deepEqual(
    one.replay.map((e) => e.seq),
    [1],
  );
  assert.deepEqual(
    two.replay.map((e) => e.seq),
    [1],
  );

  // 新事件也各自都能拿到。共享游标的话后拉的那个会拿到 null，
  // 表现就是「开着两个标签页时，进度只出现在其中一个上」。
  events.emit(log("info", "b"));
  assert.equal((await one.next(50))?.seq, 2);
  assert.equal((await two.next(50))?.seq, 2);
});

test("环形缓冲超出容量时丢弃最旧的事件", () => {
  const events = createEventLog(RUN, 3);
  for (let i = 0; i < 5; i += 1) events.emit(log("info", `m${i}`));
  assert.deepEqual(
    events.all().map((e) => e.seq),
    [3, 4, 5],
  );
  // lastSeq 仍是全局序号，前端据此继续增量拉取不会回退。
  assert.equal(events.lastSeq(), 5);
  const sub = events.subscribe(1);
  assert.deepEqual(
    sub.replay.map((e) => e.seq),
    [3, 4, 5],
  );
});

test("写错日志的事件会被拒绝", () => {
  const events = createEventLog(RUN);
  const foreign: RunEvent = { type: "run.log", runId: "other-run", level: "info", message: "x" };
  // 串台会让前端把别人的进度渲染成这个运行的，必须早失败。
  assert.throws(() => events.emit(foreign), /runId/);
});

test("全局总线跨运行，不校验 runId", () => {
  const bus = createGlobalBus();
  bus.emit({ type: "run.queued", runId: "a", caseId: "c1" });
  bus.emit({ type: "run.queued", runId: "b", caseId: "c2" });
  const sub = bus.subscribe(0);
  assert.equal(sub.replay.length, 2);
  assert.deepEqual(
    sub.replay.map((e) => e.runId),
    ["a", "b"],
  );
});
