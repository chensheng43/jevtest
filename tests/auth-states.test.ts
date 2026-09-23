/**
 * 登录态仓库 + 登录窗口管理器。
 *
 * 仓库这边锁的是三件事：权限 0600（文件里是会话 cookie）、名字进路径前必过白名单、
 * 对外摘要里绝不出现 cookie 值。登录窗口这边用一个假 Browser 验状态机：
 * 人把窗口关掉之后不能再「保存」，也不能卡在 open 上。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AuthStateNotFound,
  authStatePath,
  createAuthStateStore,
  judgeLoggedIn,
  parseStorageState,
} from "../src/store/auth-states.ts";
import type { StorageState } from "../src/store/auth-states.ts";
import { LoginBusy, createLoginManager } from "../src/browser/login.ts";
import type { Browser } from "playwright";
import { CaseDefinitionSchema } from "../src/schema/case.ts";
import { caseDigest, parseCase, stringifyCase } from "../src/schema/yaml.ts";

const STATE: StorageState = {
  cookies: [
    {
      name: "sid",
      value: "secret-value",
      domain: ".example.com",
      path: "/",
      expires: -1,
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
    },
    {
      name: "remember",
      value: "secret-2",
      domain: "sso.example.com",
      path: "/",
      expires: 2_000_000_000,
      httpOnly: false,
      secure: true,
      sameSite: "None",
    },
  ],
  origins: [{ origin: "https://app.example.com", localStorage: [{ name: "k", value: "v" }] }],
};

async function withRoot(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "jevtest-auth-"));
  try {
    await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 仓库
// ---------------------------------------------------------------------------

test("save：状态文件是原样的 storageState（可直接喂给 Playwright），权限 0600", async () => {
  await withRoot(async (root) => {
    const store = createAuthStateStore({ root });
    await store.save("shop-admin", STATE, { loginUrl: "https://app.example.com/", source: "login" });

    const onDisk = JSON.parse(await readFile(join(root, "shop-admin.json"), "utf8")) as StorageState;
    assert.deepEqual(onDisk, STATE);
    if (process.platform !== "win32") {
      assert.equal((await stat(join(root, "shop-admin.json"))).mode & 0o777, 0o600);
      assert.equal((await stat(join(root, "shop-admin.meta.json"))).mode & 0o777, 0o600);
    }
  });
});

test("摘要：计数、站点、过期时间，且不含任何 cookie 值", async () => {
  await withRoot(async (root) => {
    const store = createAuthStateStore({ root });
    const summary = await store.save("shop-admin", STATE, { loginUrl: null, source: "import" });

    assert.equal(summary.cookieCount, 2);
    assert.deepEqual(summary.sites, ["app.example.com", "example.com", "sso.example.com"]);
    assert.equal(summary.earliestExpiry, new Date(2_000_000_000 * 1000).toISOString());
    assert.equal(summary.hasSessionCookies, true);
    const serialized = JSON.stringify(summary);
    assert.equal(serialized.includes("secret-value"), false);
    assert.equal(serialized.includes("secret-2"), false);
  });
});

test("list：按名字排序；没有 meta 的手工文件也列得出；坏文件跳过而不是让整页打不开", async () => {
  await withRoot(async (root) => {
    const store = createAuthStateStore({ root });
    await store.save("b-state", STATE, { loginUrl: null, source: "login" });
    await writeFile(join(root, "a-manual.json"), JSON.stringify(STATE), "utf8");
    await writeFile(join(root, "c-broken.json"), "{not json", "utf8");
    await writeFile(join(root, "Bad Name.json"), JSON.stringify(STATE), "utf8");

    const warn = console.warn;
    console.warn = () => {};
    try {
      const names = (await store.list()).map((item) => item.name);
      assert.deepEqual(names, ["a-manual", "b-state"]);
    } finally {
      console.warn = warn;
    }
    const manual = await store.get("a-manual");
    assert.equal(manual.source, "import");
    assert.equal(manual.loginUrl, null);
  });
});

test("目录不存在时 list 为空，不报错", async () => {
  const store = createAuthStateStore({ root: join(tmpdir(), "jevtest-auth-does-not-exist-xyz") });
  assert.deepEqual(await store.list(), []);
});

test("recordVerify 写进 meta；remove 两个文件一起删；删不存在的抛 AuthStateNotFound", async () => {
  await withRoot(async (root) => {
    const store = createAuthStateStore({ root });
    await store.save("x-state", STATE, { loginUrl: "https://app.example.com/", source: "login" });
    await store.recordVerify("x-state", {
      at: "2026-09-23T00:00:00.000Z",
      ok: true,
      url: "https://app.example.com/",
      finalUrl: "https://app.example.com/home",
      detail: "ok",
    });
    assert.equal((await store.get("x-state")).lastVerified?.ok, true);

    await store.remove("x-state");
    assert.equal(await store.exists("x-state"), false);
    await assert.rejects(store.remove("x-state"), AuthStateNotFound);
    await assert.rejects(store.get("x-state"), AuthStateNotFound);
  });
});

test("名字进路径前必过白名单：目录穿越、大写、点号一律拒绝", () => {
  for (const name of ["../x", "a/b", "A-b", "has.dot", "x", ""]) {
    assert.throws(() => authStatePath("/tmp/auth", name), /非法的登录态名称/, name);
  }
  assert.equal(authStatePath("/tmp/auth", "ok-name"), join("/tmp/auth", "ok-name.json"));
});

test("parseStorageState：形状不对给出能照做的错误；多余字段丢掉；缺省字段补齐", () => {
  assert.throws(() => parseStorageState({ cookies: {} }), /storageState/);
  assert.throws(() => parseStorageState({ cookies: [{ name: "a" }], origins: [] }), /cookies\[0\]\.value/);

  const parsed = parseStorageState({
    cookies: [{ name: "a", value: "b", domain: "x.com", extra: 1 }],
    origins: [],
    junk: true,
  });
  assert.deepEqual(parsed, {
    cookies: [
      { name: "a", value: "b", domain: "x.com", path: "/", expires: -1, httpOnly: false, secure: false, sameSite: "Lax" },
    ],
    origins: [],
  });
});

// ---------------------------------------------------------------------------
// 验证的判据
// ---------------------------------------------------------------------------

test("验证：从登录页被送去控制台是**有效**（跨域不等于失效，实测过的站点就是这样）", () => {
  const result = judgeLoggedIn("https://www.example.com/login", "https://console.example.com/dashboard", 0);
  assert.equal(result.ok, true);
  assert.match(result.detail, /不像登录页/);
});

test("验证：被 SSO 跳到登录页是失效——看路径，不看 query 里的回跳地址", () => {
  const redirected = judgeLoggedIn(
    "https://shop_test9.example.com/products",
    "https://www.example.com/login?payload=abc&sso_sess=x",
    0,
  );
  assert.equal(redirected.ok, false);
  assert.match(redirected.detail, /登录页/);

  // 回跳参数里带 /login 的正常页面不能误判
  assert.equal(judgeLoggedIn("https://a.test/", "https://a.test/home?next=/login", 0).ok, true);
  // 路径段匹配：/blogin 不是登录页
  assert.equal(judgeLoggedIn("https://a.test/", "https://a.test/blogin", 0).ok, true);
  for (const path of ["/signin", "/user/sso/", "/passport/login", "/oauth2/authorize", "/login.html"]) {
    assert.equal(judgeLoggedIn("https://a.test/", `https://a.test${path}`, 0).ok, false, path);
  }
});

test("验证：同域但页面上有密码框是失效（登录页与业务同域的站点）", () => {
  const result = judgeLoggedIn("https://a.test/app", "https://a.test/app", 1);
  assert.equal(result.ok, false);
  assert.match(result.detail, /密码框/);
});

test("验证：停在原地、没有登录框是有效", () => {
  assert.equal(judgeLoggedIn("https://a.test/app", "https://a.test/app", 0).ok, true);
});

// ---------------------------------------------------------------------------
// 用例字段
// ---------------------------------------------------------------------------

test("用例 authState：只收名字；不写时不出现在 YAML 里，旧用例的 digest 不变", () => {
  const base = { title: "t", goal: "g", startUrl: "https://app.example.com/" };
  assert.equal(CaseDefinitionSchema.parse({ ...base, authState: "shop-admin" }).authState, "shop-admin");
  assert.throws(() => CaseDefinitionSchema.parse({ ...base, authState: "../../etc/passwd" }));
  assert.throws(() => CaseDefinitionSchema.parse({ ...base, authState: "/abs/path.json" }));

  const without = stringifyCase(CaseDefinitionSchema.parse(base));
  assert.equal(without.includes("authState"), false);

  const withAuth = stringifyCase(CaseDefinitionSchema.parse({ ...base, authState: "shop-admin" }));
  // 紧跟在 allowedOrigins 之后：键序决定 digest
  assert.match(withAuth, /allowedOrigins:\n {2}- https:\/\/app\.example\.com\nauthState: shop-admin\nbudget:/);
  assert.equal(parseCase(withAuth).authState, "shop-admin");
  assert.notEqual(caseDigest(parseCase(withAuth)), caseDigest(parseCase(without)));
});

// ---------------------------------------------------------------------------
// 登录窗口（假 Browser）
// ---------------------------------------------------------------------------

class FakePage extends EventEmitter {
  #url = "about:blank";
  readonly ctx: FakeContext;
  constructor(ctx: FakeContext) {
    super();
    this.ctx = ctx;
  }
  async goto(url: string): Promise<void> {
    this.#url = url;
  }
  url(): string {
    return this.#url;
  }
  async bringToFront(): Promise<void> {}
  /** 模拟人点了窗口的关闭按钮 */
  userClose(): void {
    this.ctx.pagesList = this.ctx.pagesList.filter((page) => page !== this);
    this.emit("close");
  }
}

class FakeContext extends EventEmitter {
  pagesList: FakePage[] = [];
  async newPage(): Promise<FakePage> {
    const page = new FakePage(this);
    this.pagesList.push(page);
    return page;
  }
  pages(): FakePage[] {
    return this.pagesList;
  }
  async storageState(): Promise<StorageState> {
    return STATE;
  }
}

class FakeBrowser extends EventEmitter {
  readonly context = new FakeContext();
  closed = 0;
  async newContext(): Promise<FakeContext> {
    return this.context;
  }
  async close(): Promise<void> {
    this.closed += 1;
    this.emit("disconnected");
  }
}

function fakeLauncher(): { browsers: FakeBrowser[]; launch: () => Promise<Browser> } {
  const browsers: FakeBrowser[] = [];
  return {
    browsers,
    launch: async () => {
      const browser = new FakeBrowser();
      browsers.push(browser);
      return browser as unknown as Browser;
    },
  };
}

test("登录窗口：打开 -> 保存，拿到登录态并关掉浏览器", async () => {
  const fake = fakeLauncher();
  const manager = createLoginManager({ launchBrowser: fake.launch });
  const status = await manager.open("shop-admin", "https://app.example.com/");
  assert.equal(status.state, "open");
  assert.equal(status.currentUrl, "https://app.example.com/");

  const captured = await manager.capture();
  assert.equal(captured.name, "shop-admin");
  assert.deepEqual(captured.state, STATE);
  assert.equal(fake.browsers[0]?.closed, 1);
  assert.equal(manager.status(), null);
});

test("登录窗口：同一时刻只能有一个", async () => {
  const fake = fakeLauncher();
  const manager = createLoginManager({ launchBrowser: fake.launch });
  await manager.open("first-one", "https://app.example.com/");
  await assert.rejects(manager.open("second-one", "https://app.example.com/"), LoginBusy);
  await manager.cancel();
  assert.equal(fake.browsers[0]?.closed, 1);
  // 取消之后可以再开
  await manager.open("second-one", "https://app.example.com/");
  await manager.stop();
});

test("登录窗口：人把窗口关了 -> 状态变 closed 并给出原因；此时不能保存；可以重开", async () => {
  const fake = fakeLauncher();
  const manager = createLoginManager({ launchBrowser: fake.launch });
  await manager.open("closed-one", "https://app.example.com/");
  fake.browsers[0]?.context.pagesList[0]?.userClose();
  await new Promise((resolve) => setImmediate(resolve));

  const status = manager.status();
  assert.equal(status?.state, "closed");
  assert.match(status?.closedReason ?? "", /没有保存/);
  await assert.rejects(manager.capture(), /没有保存/);

  // closed 状态不占位：直接开新窗口
  await manager.open("closed-one", "https://app.example.com/");
  assert.equal(manager.status()?.state, "open");
  await manager.stop();
});

test("登录窗口：超时没保存自动关闭", async () => {
  const fake = fakeLauncher();
  const manager = createLoginManager({ launchBrowser: fake.launch, idleTimeoutMs: 10 });
  await manager.open("slow-one", "https://app.example.com/");
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(manager.status()?.state, "closed");
  assert.match(manager.status()?.closedReason ?? "", /自动关闭/);
  assert.equal(fake.browsers[0]?.closed, 1);
});

test("登录窗口：弹不出来时的错误指向「上传 storageState」这条兜底路径", async () => {
  const manager = createLoginManager({
    launchBrowser: async () => {
      throw new Error("Missing X server or $DISPLAY");
    },
  });
  await assert.rejects(manager.open("no-display", "https://app.example.com/"), /上传 storageState/);
  assert.equal(manager.status(), null);
});
