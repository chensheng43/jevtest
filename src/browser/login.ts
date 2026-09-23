/**
 * 登录窗口：在用户桌面上弹出一个**有界面的** Chromium，让人手动登录，再把登录态导出来。
 *
 * ## 为什么是「人来登录」而不是「程序填账号密码」
 *
 * 通用性。SSO 跳转、扫码、短信验证码、图形验证码、二次验证——自动填表只能覆盖其中
 * 最简单的一种，而且每个站点要单独配选择器。人登录一次、程序只负责把结果
 * （cookie + localStorage）存下来，对所有登录方式都成立。副作用也是好的：
 * 密码从头到尾不经过模型、不写进用例、不进报告。
 *
 * ## 为什么能弹窗
 *
 * Web 服务只监听 127.0.0.1（`web/security.ts`），所以服务端与操作 Web 页面的人
 * 一定在同一台机器上，服务端弹出的窗口就在他眼前。没有图形界面的环境
 * （Docker、远程 Linux）启动会失败——错误信息里指向「上传 storageState」这条兜底路径。
 *
 * ## 与浏览器池的关系
 *
 * **不借池里的浏览器**：池按 `settings.headless` 启动（通常无头），而这里必须有界面；
 * 登录也不该占用例的 context 名额。这里单独起一个浏览器，用完即关。
 * 同一时刻只允许一个登录窗口：两个窗口同时开着，人分不清哪个对应 Web 上的哪一行。
 */

import { chromium } from "playwright";
import type { Browser, BrowserContext, Page } from "playwright";

import { JevtestError } from "../core/errors.ts";
import type { StorageState } from "../store/auth-states.ts";

/**
 * 窗口开着没人管时自动关闭的时限。
 * 忘了点保存的窗口会一直挂着一个 Chromium 进程；30 分钟足够走完任何一种人工登录。
 */
export const LOGIN_IDLE_TIMEOUT_MS = 30 * 60_000;

export interface LoginWindowStatus {
  name: string;
  /** 打开窗口时导航到的地址 */
  url: string;
  startedAt: string;
  /**
   * `open`：窗口开着，等人登录。
   * `closed`：窗口被人直接关掉了（或超时），**没有保存**。前端据此提示，而不是一直转圈。
   */
  state: "open" | "closed";
  /** 窗口当前停在哪（最后一个标签页）。帮人确认「登录完成了没有」 */
  currentUrl: string | null;
  /** state 为 closed 时的原因 */
  closedReason: string | null;
}

export interface LoginManager {
  /** 弹出窗口并打开 `url`。已有一个开着的窗口时抛 `LoginBusy` */
  open(name: string, url: string): Promise<LoginWindowStatus>;
  status(): LoginWindowStatus | null;
  /** 导出当前登录态并关闭窗口。窗口已关时抛错：那时 cookie 已随浏览器一起没了 */
  capture(): Promise<{ name: string; url: string; state: StorageState }>;
  /** 关闭窗口、不保存。没有窗口时是空操作 */
  cancel(): Promise<void>;
  /** 进程停机时调用 */
  stop(): Promise<void>;
}

export class LoginBusy extends JevtestError {
  override readonly name = "LoginBusy";

  constructor(stateName: string) {
    super(`已经有一个登录窗口开着（登录态 ${stateName}）。先在那边保存或取消，再开新的`);
  }
}

export interface LoginManagerOptions {
  /** 测试注入点：替换真正的 `chromium.launch({ headless: false })` */
  launchBrowser?: () => Promise<Browser>;
  idleTimeoutMs?: number;
}

interface Active {
  status: LoginWindowStatus;
  browser: Browser;
  context: BrowserContext;
  timer: NodeJS.Timeout;
}

export function createLoginManager(options: LoginManagerOptions = {}): LoginManager {
  const idleTimeoutMs = options.idleTimeoutMs ?? LOGIN_IDLE_TIMEOUT_MS;
  let active: Active | null = null;
  /** 打开中的那次调用：两个并发的 open 不能各起一个浏览器 */
  let opening = false;

  async function launch(): Promise<Browser> {
    try {
      return options.launchBrowser !== undefined
        ? await options.launchBrowser()
        : await chromium.launch({ headless: false });
    } catch (error) {
      throw new JevtestError(
        `弹不出登录窗口：${describe(error)}。` +
          "若本机没有图形界面（Docker、远程 Linux），改用「上传 storageState」：" +
          "在有界面的机器上登录后导出 JSON，再到「登录态」页上传。" +
          "若错误提到可执行文件不存在，先跑 `npx playwright install chromium`。",
        { cause: error },
      );
    }
  }

  async function open(name: string, url: string): Promise<LoginWindowStatus> {
    if (opening || (active !== null && active.status.state === "open")) {
      throw new LoginBusy(active?.status.name ?? name);
    }
    opening = true;
    try {
      // 上一次的窗口已被人关掉、结果也已被前端读过：直接清掉换新的
      if (active !== null) await dispose(active);
      active = null;

      const browser = await launch();
      let context: BrowserContext;
      let page: Page;
      try {
        // viewport: null = 跟随窗口大小。登录页常有响应式布局，固定视口在小屏上反而点不到按钮。
        context = await browser.newContext({ viewport: null });
        page = await context.newPage();
      } catch (error) {
        await browser.close().catch(() => undefined);
        throw new JevtestError(`打开登录窗口失败：${describe(error)}`, { cause: error });
      }

      const status: LoginWindowStatus = {
        name,
        url,
        startedAt: new Date().toISOString(),
        state: "open",
        currentUrl: null,
        closedReason: null,
      };
      const current: Active = {
        status,
        browser,
        context,
        timer: setTimeout(() => {
          void markClosed(current, `超过 ${Math.round(idleTimeoutMs / 60_000)} 分钟没有保存，窗口已自动关闭`);
        }, idleTimeoutMs),
      };
      // 不挡住进程退出：停机路径会显式 stop()
      current.timer.unref();
      active = current;

      // 人把窗口（所有标签页）关了 = 放弃这次登录。Chromium 在 macOS 上关掉最后一个
      // 窗口进程也不退出，所以不能只听 disconnected，还要看标签页是不是都没了。
      const watchPage = (tab: Page): void => {
        tab.on("close", () => {
          if (current.status.state === "open" && context.pages().length === 0) {
            void markClosed(current, "登录窗口被关闭了，登录态没有保存");
          }
        });
      };
      watchPage(page);
      context.on("page", watchPage);
      browser.on("disconnected", () => {
        if (current.status.state === "open") {
          current.status.state = "closed";
          current.status.closedReason = "登录窗口被关闭了，登录态没有保存";
          clearTimeout(current.timer);
        }
      });

      try {
        // 打不开（地址写错、站点挂了）也把窗口留着：人可以在里面自己改地址，
        // 比「弹一下就关、只给一句错误」好用。
        await page.goto(url, { waitUntil: "domcontentloaded" });
      } catch (error) {
        console.warn(`[jevtest] 登录窗口打开 ${url} 失败（${describe(error)}），窗口保留，可手动改地址`);
      }
      await page.bringToFront().catch(() => undefined);
      return snapshot(current);
    } finally {
      opening = false;
    }
  }

  function status(): LoginWindowStatus | null {
    return active === null ? null : snapshot(active);
  }

  async function capture(): Promise<{ name: string; url: string; state: StorageState }> {
    const current = active;
    if (current === null) throw new JevtestError("没有开着的登录窗口");
    if (current.status.state !== "open") {
      throw new JevtestError(`${current.status.closedReason ?? "登录窗口已关闭"}。请重新打开登录窗口`);
    }
    const state = (await current.context.storageState()) as StorageState;
    const result = { name: current.status.name, url: current.status.url, state };
    active = null;
    await dispose(current);
    return result;
  }

  async function cancel(): Promise<void> {
    const current = active;
    active = null;
    if (current !== null) await dispose(current);
  }

  async function markClosed(current: Active, reason: string): Promise<void> {
    if (current.status.state !== "open") return;
    current.status.state = "closed";
    current.status.closedReason = reason;
    // 状态留给前端读（active 不清空），浏览器进程先收掉
    clearTimeout(current.timer);
    await current.browser.close().catch(() => undefined);
  }

  async function dispose(current: Active): Promise<void> {
    clearTimeout(current.timer);
    current.status.state = "closed";
    await current.browser.close().catch((error: unknown) => {
      console.warn(`[jevtest] 警告：关闭登录窗口失败（${describe(error)}）`);
    });
  }

  function snapshot(current: Active): LoginWindowStatus {
    if (current.status.state === "open") {
      const pages = current.context.pages();
      const last = pages[pages.length - 1];
      current.status.currentUrl = last === undefined ? null : last.url();
    }
    return { ...current.status };
  }

  return { open, status, capture, cancel, stop: cancel };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
