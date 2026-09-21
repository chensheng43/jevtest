/**
 * 并发原语的行为锁定：Semaphore 与 AsyncQueue。
 *
 * 这里的等待全部靠微任务与 `setImmediate` 让出，**没有一处真的 sleep**：
 * 既是为了快，也是为了让「谁先被唤醒」这件事确定，不受机器负载影响。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AsyncQueue, Semaphore } from "../src/util/async.ts";

/** 让出一次事件循环，等所有已排队的微任务落定。 */
function flush(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

// ---------------------------------------------------------------------------
// Semaphore
// ---------------------------------------------------------------------------

test("Semaphore：并发数不超过初始许可数", async () => {
  const sem = new Semaphore(2);
  let active = 0;
  let peak = 0;

  const tasks = Array.from({ length: 5 }, () =>
    sem.with(async () => {
      active += 1;
      peak = Math.max(peak, active);
      await flush();
      active -= 1;
    }),
  );

  await Promise.all(tasks);
  assert.equal(peak, 2, "5 个任务抢 2 个许可，同时在跑的不能超过 2 个");
  assert.equal(sem.available, 2, "全部结束后许可必须回到初始值");
});

test("Semaphore：等待者按申请顺序唤醒（FIFO）", async () => {
  const sem = new Semaphore(1);
  await sem.acquire(); // 主流程先占住唯一的许可

  const order: number[] = [];
  const waiters = [1, 2, 3].map(async (n) => {
    await sem.acquire();
    order.push(n);
    sem.release();
  });

  await flush();
  assert.deepEqual(order, [], "没有许可时等待者不得被唤醒");

  sem.release(); // 转交给 1，1 归还后再转交给 2，如此递推
  await Promise.all(waiters);
  assert.deepEqual(order, [1, 2, 3], "先申请的必须先拿到许可，否则批量运行的排队时间无法解释");
  assert.equal(sem.available, 1);
});

test("Semaphore.with：fn 抛错时仍然归还许可", async () => {
  const sem = new Semaphore(1);

  await assert.rejects(
    sem.with(async () => {
      throw new Error("boom");
    }),
    /boom/,
  );

  assert.equal(sem.available, 1, "异常路径漏掉归还就会让并发上限逐步降到 0");
  // 归还的许可必须真的可用，而不是计数好看
  await sem.with(async () => {
    assert.equal(sem.available, 0, "with 执行期间许可应处于已借出状态");
  });
  assert.equal(sem.available, 1);
});

test("Semaphore.with：异常归还后，排队中的任务能拿到许可", async () => {
  const sem = new Semaphore(1);
  let resumed = false;

  const failing = sem.with(async () => {
    await flush();
    throw new Error("boom");
  });
  const waiter = sem.with(async () => {
    resumed = true;
  });

  await assert.rejects(failing, /boom/);
  await waiter;
  assert.equal(resumed, true, "异常释放的许可必须唤醒等待者，否则 worker 池会卡死");
});

test("Semaphore.release：超发必须报错，且不污染许可计数", async () => {
  const sem = new Semaphore(1);

  assert.throws(() => sem.release(), /初始许可数/, "没有 acquire 就 release 是调用方的配对 bug，必须炸出来");
  assert.equal(sem.available, 1, "超发被拒绝后计数不能被抬高");

  await sem.acquire();
  assert.equal(sem.available, 0);
  sem.release();
  assert.equal(sem.available, 1);

  assert.throws(() => sem.release(), /初始许可数/);
  assert.equal(sem.available, 1);
  // 报错之后信号量仍然可用
  await sem.acquire();
  assert.equal(sem.available, 0);
  sem.release();
});

test("Semaphore：构造时拒绝非正许可数", () => {
  assert.throws(() => new Semaphore(0), RangeError, "许可数为 0 是死锁而不是限流，应在构造时暴露");
  assert.throws(() => new Semaphore(-1), RangeError);
  assert.throws(() => new Semaphore(1.5), RangeError);
});

test("Semaphore.tryAcquire：不挂起，拿到返回 true，用尽返回 false", () => {
  const sem = new Semaphore(1);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.tryAcquire(), false, "没有许可时立即返回 false，而不是排队");
  assert.equal(sem.available, 0);

  sem.release();
  assert.equal(sem.available, 1);
  assert.equal(sem.tryAcquire(), true);
  assert.equal(sem.available, 0);
});

// ---------------------------------------------------------------------------
// AsyncQueue
// ---------------------------------------------------------------------------

test("AsyncQueue：空队列时 shift 挂起，push 将其唤醒", async () => {
  const q = new AsyncQueue<number>();
  assert.equal(q.size, 0);
  assert.equal(q.closed, false);

  const pending = q.shift();
  let settled = false;
  void pending.then(() => {
    settled = true;
  });

  await flush();
  assert.equal(settled, false, "队列空时 shift 必须挂起，否则 worker 只能忙等");

  q.push(7);
  assert.equal(await pending, 7);
  assert.equal(q.size, 0);
});

test("AsyncQueue：先入队先取出", async () => {
  const q = new AsyncQueue<string>();
  q.push("a");
  q.push("b");
  assert.equal(q.size, 2);
  assert.equal(await q.shift(), "a");
  assert.equal(await q.shift(), "b");
  assert.equal(q.size, 0);
});

test("AsyncQueue：push 直投给挂起的 shift，不落在队列里", async () => {
  const q = new AsyncQueue<number>();
  const pending = q.shift();
  await flush();

  q.push(1);
  assert.equal(await pending, 1);
  assert.equal(q.size, 0, "已被等待者取走的元素不应再出现在 size 里");
});

test("AsyncQueue.close：挂起的 shift 全部 reject，worker 循环得以退出", async () => {
  const q = new AsyncQueue<number>();
  const a = q.shift();
  const b = q.shift();

  q.close();
  assert.equal(q.closed, true);

  await assert.rejects(a, /已关闭/);
  await assert.rejects(b, /已关闭/);
  await assert.rejects(q.shift(), /已关闭/, "排空之后的新 shift 也必须立刻 reject，不能永久挂起");
});

test("AsyncQueue.close：已入队的元素仍可取出，排空后才 reject", async () => {
  const q = new AsyncQueue<number>();
  q.push(1);
  q.push(2);
  q.close();

  assert.equal(await q.shift(), 1, "close 表示不再有新的进来，不是丢掉手上的");
  assert.equal(await q.shift(), 2);
  await assert.rejects(q.shift(), /已关闭/);
});

test("AsyncQueue.push：close 之后再 push 抛错，不静默丢元素", () => {
  const q = new AsyncQueue<number>();
  q.close();

  assert.throws(() => q.push(1), /已关闭/);
  assert.equal(q.size, 0, "被拒绝的元素不得留在队列里假装还有人会消费它");
});
