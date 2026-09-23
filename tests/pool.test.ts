/**
 * 浏览器池的生命周期：Chromium 崩溃之后要能自己重新启动。
 *
 * 真浏览器不好确定性地「弄死」，这里用 `launchBrowser` 注入一个可控的假 Browser，
 * 只验池对 `disconnected` 的反应——不借 context、不开页面。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { Browser } from "playwright";

import { createBrowserPool } from "../src/browser/pool.ts";

/** 只实现池在 start/stop 路径上会碰到的那几个成员。 */
class FakeBrowser extends EventEmitter {
  connected = true;
  isConnected(): boolean {
    return this.connected;
  }
  crash(): void {
    this.connected = false;
    this.emit("disconnected");
  }
  close(): Promise<void> {
    this.connected = false;
    return Promise.resolve();
  }
}

function poolWithFakes(): { pool: ReturnType<typeof createBrowserPool>; launched: FakeBrowser[] } {
  const launched: FakeBrowser[] = [];
  const pool = createBrowserPool({
    maxContexts: 1,
    maxEngineInflight: 1,
    headless: true,
    launchBrowser: () => {
      const instance = new FakeBrowser();
      launched.push(instance);
      return Promise.resolve(instance as unknown as Browser);
    },
  });
  return { pool, launched };
}

test("浏览器存活时 start 不会重复启动", async () => {
  const { pool, launched } = poolWithFakes();
  await pool.start();
  await pool.start();
  assert.equal(launched.length, 1);
  await pool.stop();
});

test("Chromium 崩溃（disconnected）后，下一次使用会重新启动一个，而不是一直交出死实例", async () => {
  const { pool, launched } = poolWithFakes();
  await pool.start();
  launched[0]?.crash();

  await pool.start();
  assert.equal(launched.length, 2, "崩溃之后应当重新启动");
  assert.equal(launched[1]?.isConnected(), true);
  await pool.stop();
});

test("没收到 disconnected 事件、但实例已断开时，同样重新启动", async () => {
  const { pool, launched } = poolWithFakes();
  await pool.start();
  const first = launched[0];
  assert.ok(first !== undefined);
  first.connected = false; // 事件丢了或还没派发

  await pool.start();
  assert.equal(launched.length, 2);
  await pool.stop();
});
