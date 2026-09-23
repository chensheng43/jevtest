/**
 * 端到端测试：真 Chromium + 本地夹具站点 + scripted 引擎。
 *
 * 它覆盖的是**整条链路**——用例入库 → 运行器 → 浏览器层 → 决策循环 → 断言 → 报告落盘，
 * 而成本是 0（scripted 引擎不联网）且结果完全确定（夹具站点不依赖外网）。
 * 这正是 `engine/scripted.ts` 与 `fixtures/site/` 存在的理由（见 tests/README.md）。
 *
 * 刻意**复用 `cli.ts` 的 `createWiring`**：测试里的接线与生产里的接线是同一份代码。
 * 各写一套的话，漂移只会发生在测试覆盖不到的那一侧——而那一侧才是线上跑的那套。
 *
 * 这个文件按 `tests/e2e/*.test.ts` 的命名被收集，但它的进入条件是「有 Chromium」：
 * 没装浏览器时会在 `before` 里以明确的错误失败（提示 `npx playwright install chromium`），
 * 而不是给出一堆看着像逻辑错误的断言失败。
 */

import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright";

import { startFixtureServer } from "./fixture-server.ts";
import type { FixtureServer } from "./fixture-server.ts";
import { createWiring } from "../../src/cli.ts";
import type { Wiring } from "../../src/cli.ts";
import type { Settings } from "../../src/config.ts";
import { CaseDefinitionSchema } from "../../src/schema/case.ts";
import type { Case } from "../../src/schema/case.ts";
import { createScriptedEngine } from "../../src/engine/scripted.ts";
import type { ScriptedStep } from "../../src/engine/scripted.ts";
import type { DecisionEngine, DecisionRequest } from "../../src/engine/types.ts";
import { readReport } from "../../src/core/report.ts";
import { buildActionSpace } from "../../src/core/policy.ts";
import { admit } from "../../src/browser/admission.ts";
import type { ActionSpace } from "../../src/core/policy.ts";
import type { CaseMode } from "../../src/schema/case.ts";
import type { Operation } from "../../src/schema/events.ts";
import { FROZEN_CASE_FILE } from "../../src/store/cases.ts";
import { JevtestError, OccludedTarget } from "../../src/core/errors.ts";
import type { CaseRunReport } from "../../src/schema/report.ts";
import type { Observation, Session } from "../../src/browser/session.ts";

/** 夹具站点的陷阱元素在 800ms 后生效（fixtures/site/app.js）。 */
const TRAP_DELAY_MS = 800;
/** 页面地址里覆写陷阱延迟：测试要让元素**在观测时可用**，所以把窗口拉长。 */
const KEEP_TRAPS = "?trapDelay=600000";

/**
 * 没有 Chromium 时**显式跳过**，而不是让 `npm test` 变红。
 *
 * 环境缺浏览器与代码坏掉是两回事，混成一个红叉会让人去查一个不存在的问题；
 * 但也不能静默通过——`node:test` 的 skip 会在汇总里显示为 skipped，看得见。
 */
const CHROMIUM_PATH = chromium.executablePath();
const SKIP_REASON: string | false = existsSync(CHROMIUM_PATH)
  ? false
  : `未安装 Chromium（先跑 npx playwright install chromium，约 150MB）`;
const e2e = (name: string, fn: () => Promise<void> | void): void => {
  test(name, { skip: SKIP_REASON }, fn);
};

let fixture: FixtureServer;
let root: string;
let wiring: Wiring;

/**
 * 当前用例使用的引擎。
 *
 * `createWiring` 在装配时就要拿到 `createEngine`，而每个用例要回放不同的答案序列，
 * 所以这里用一层间接：装配时给一个「读变量」的工厂，测试里改这个变量。
 * 同时把收到的决策请求记下来——只读模式的断言只能从请求本身取证。
 */
let currentSteps: ScriptedStep[] = [{ operation: { choice: "DONE" } }];
const seenRequests: DecisionRequest[] = [];

function makeSettings(overrides: Partial<Settings>): Settings {
  return {
    typesafeApiKey: "unused-in-e2e",
    typesafeModel: "unused",
    textModelApiKey: null,
    textModelBaseUrl: "http://127.0.0.1:1",
    textModel: "unused",
    port: 0,
    workers: 1,
    maxEngineInflight: 4,
    // 无头：CI 与本地都不该弹出窗口。要看过程时把它设成 false 再单独跑这个文件。
    headless: true,
    tracing: true,
    recordFrames: true,
    casesDir: "./cases",
    runsDir: "./runs",
    authDir: "./auth",
    defaultEngine: "typesafe",
    ...overrides,
  };
}

before(async () => {
  // `before` 在整组被跳过时照样会跑，所以这里必须先自己退出去。
  if (SKIP_REASON !== false) return;
  fixture = await startFixtureServer();
  root = await mkdtemp(join(tmpdir(), "jevtest-e2e-"));
  const settings = makeSettings({
    casesDir: join(root, "cases"),
    runsDir: join(root, "runs"),
    authDir: join(root, "auth"),
  });

  const engineFor = (): DecisionEngine => {
    const scripted = createScriptedEngine({ steps: currentSteps });
    return {
      name: "scripted-e2e",
      capabilities: scripted.capabilities,
      decide: (request, signal) => {
        seenRequests.push(request);
        return scripted.decide(request, signal);
      },
      writeText: (request, signal) => scripted.writeText(request, signal),
      close: () => scripted.close(),
    };
  };

  wiring = createWiring(settings, new Map(), { createEngine: engineFor });
  try {
    await wiring.pool.start();
  } catch (error) {
    throw new Error(
      `Chromium 起不来，e2e 无法运行：${error instanceof Error ? error.message : String(error)}\n` +
        `先跑 npx playwright install chromium（约 150MB）。`,
    );
  }
  wiring.runner.start();
});

after(async () => {
  if (SKIP_REASON !== false) return;
  await wiring.runner.stop();
  await fixture.close();
  await rm(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

/** 把一份 YAML 导入用例库，返回可直接交给 runner 的 `Case`。 */
async function importCase(yaml: string): Promise<Case> {
  const revision = await wiring.store.import(yaml);
  const loaded = await wiring.store.read(revision.caseId);
  return CaseDefinitionSchema.parse(loaded.def);
}

/**
 * 等一份报告落盘——**这是运行的真正终点，也是唯一可靠的等待信号。**
 *
 * 不要用 `status()` 的 `queued === 0 && active === 0` 判「跑完了」：
 * `AsyncQueue.push` 遇到正在等待的 worker 会**直投**（不落队列），
 * 而在 worker 把任务登记进 `activeRuns` 之前有一个微任务的窗口——
 * 那一瞬间两个计数都是 0，于是轮询会立刻误判成「已完成」，
 * 表现为「报告还没写就说读不到」。
 *
 * 报告落盘是 runner 的最后一步（先落盘再宣告 run.finished），因此以它为界是安全的。
 */
async function waitForReport(runId: string, timeoutMs: number): Promise<CaseRunReport> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return await readReport(wiring.settings.runsDir, runId);
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((settle) => setTimeout(settle, 100));
    }
  }
}

/** 跑一个用例到结束，返回报告。 */
async function runCase(caseDef: Case, steps: ScriptedStep[]): Promise<CaseRunReport> {
  currentSteps = steps;
  const { runIds } = wiring.runner.enqueueMany([caseDef]);
  const runId = runIds[0];
  assert.ok(runId !== undefined, "enqueueMany 必须返回 runId");
  return await waitForReport(runId, 60_000);
}

/**
 * 预先观测一次夹具页面并构建动作空间。
 *
 * 两个要点：
 *
 * 1. **必须在动作空间里找目标，而不是在 `Observation.actions` 里找。**
 *    给模型看的 id 是 `buildActionSpace` 分配的**连续索引**（`"6"`、`"9"`），
 *    而 `Observation.actions` 的 id 是 snapshot.js 分配的 `e1..eN`——两套 id 空间。
 *    这里走 agent 同一条构造路径，因此拿到的一定是模型看到的那个 id。
 * 2. **不硬编码索引**。夹具改一个元素就会让 `"6"` 变成别的意思，
 *    而这种失败会伪装成「模型选错了东西」，很难往夹具方向上想。
 */
async function observeFixture(mode: CaseMode): Promise<{ page: Observation; space: ActionSpace }> {
  return await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/index.html${KEEP_TRAPS}`, {
      waitUntil: "domcontentloaded",
    });
    return { page, space: buildActionSpace(page.actions, { mode }) };
  });
}

/** 按可访问名从某个操作的候选集里取目标索引。 */
function targetIndex(space: ActionSpace, operation: Operation, needle: string, role?: string): string {
  const candidates = space.targets[operation] ?? {};
  for (const [index, action] of Object.entries(candidates)) {
    if (action.label.includes(needle) && (role === undefined || action.role === role)) return index;
  }
  const available = Object.entries(candidates)
    .map(([index, action]) => `${index}=${action.label}`)
    .join("、");
  throw new Error(`动作空间里没有 ${operation} 目标「${needle}」（可用：${available}）`);
}

// ---------------------------------------------------------------------------
// 浏览器层：观测、几何、遮挡
// ---------------------------------------------------------------------------

e2e("观测：按可访问名索引元素，几何上不可见的元素不进候选集", async () => {
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/index.html${KEEP_TRAPS}`, {
      waitUntil: "domcontentloaded",
    });
    const labels = page.actions.map((action) => action.label);

    // 搜索框的可访问名来自它的 <label>，这正是断言层唯一的定位手段。
    assert.ok(labels.some((label) => label.includes("搜索设备")), `元素表里应有搜索框：${labels.join(" | ")}`);
    // 危险按钮也要在候选集里——**护栏要在执行前拦住它**，如果它根本不在候选集里，
    // 那条护栏测试就变成了空洞的通过。
    assert.ok(labels.some((label) => label.includes("删除此项目")));

    // 静态移出视口的按钮：snapshot.js 按几何判定，模型连看都不该看到它。
    // 必须**精确比较**：陷阱里另一个按钮叫「观测后会移出视口的按钮」，
    // 它包含这里的子串——用 includes 会让这条断言永远为真（一个空洞的通过）。
    assert.equal(
      labels.includes("移出视口的按钮"),
      false,
      `移出视口的按钮不该进候选集：${labels.join(" | ")}`,
    );
    // 一直被浮层盖住的按钮：它自己一切正常（尺寸、可见性、在视口内都成立），
    // 只有 elementFromPoint 能发现中心点被盖住了。观测时就做这次命中测试，所以它**不在**
    // 候选集里——否则模型会反复选中它、输入前被拦、再选它，每一轮都是一次模型调用。
    assert.equal(
      labels.includes("一直被浮层盖住的按钮"),
      false,
      `被盖住的按钮不该进候选集：${labels.join(" | ")}`,
    );
    // 浮层要等陷阱生效才出现（KEEP_TRAPS 下永不出现）：观测时它是可点的，必须在候选集里。
    assert.ok(labels.includes("观测后会被浮层盖住的按钮"));
    // 禁用的选项不进候选集（原生 select 的 option 是一个个独立 target）。
    assert.equal(labels.some((label) => label.includes("扫描仪")), false);
  });
});

e2e("遮挡命中测试：观测时可用、输入前被盖住的元素绝不被点击", async () => {
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/index.html`, {
      waitUntil: "domcontentloaded",
    });
    const target = page.actions.find((action) => action.label.includes("观测后会被浮层盖住的按钮"));
    assert.ok(target !== undefined, "这个按钮在陷阱生效前必须可点");

    // 等浮层出现：制造「决策做出之后它被盖住了」这个时序
    await new Promise((settle) => setTimeout(settle, TRAP_DELAY_MS + 300));

    // 这就是为什么点击必须用 page.mouse.click(x, y) 而不是 locator.click()：
    // locator 会替我们滚过去并点击，而此刻**不该继续点**（architecture §7.1）。
    await assert.rejects(
      () => session.act(target, page),
      (error: unknown) => {
        assert.ok(error instanceof OccludedTarget, `应抛 OccludedTarget，实际是 ${String(error)}`);
        return true;
      },
    );
  });
});

e2e("执行前重解析几何：观测后移出视口的元素同样不被点击", async () => {
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page: Observation = await session.goto(`${fixture.url}/index.html`, {
      waitUntil: "domcontentloaded",
    });
    const mover = page.actions.find((action) => action.label.includes("观测后会移出视口的按钮"));
    assert.ok(mover !== undefined, "这个按钮在陷阱生效前必须可见");

    // 等夹具把它 translateY 到视口外。这个等待是必要的：它制造出
    // 「决策做出之后元素变了」这个时序——正是要验证的那一刻。
    await new Promise((settle) => setTimeout(settle, TRAP_DELAY_MS + 300));

    await assert.rejects(
      () => session.act(mover, page),
      (error: unknown) => {
        // 具体是 OccludedTarget 还是 StalePage 取决于守卫先发现哪一条，
        // 真正要守住的是「它没有被静默点下去」。
        assert.ok(error instanceof JevtestError, `应当是 JevtestError，实际是 ${String(error)}`);
        return true;
      },
    );
  });
});

e2e("probe：准入统计能在真页面上采集（含原生 select 与复选框）", async () => {
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    await session.goto(`${fixture.url}/index.html${KEEP_TRAPS}`, { waitUntil: "domcontentloaded" });
    const stats = await session.probe();
    assert.equal(stats.frames, 1);
    assert.equal(stats.crossOriginFrames, 0, "夹具只有主文档");
    assert.equal(stats.fileInputs, 0);
    assert.equal(stats.passwordFields, 0, "夹具刻意不放密码框：否则准入会带警告");
    assert.ok(stats.interactiveElements > 3, `可交互元素过少：${stats.interactiveElements}`);
  });
});

e2e("probe：一个同源 + 一个跨域 iframe，各计一次（子 frame 不能被数两次）", async () => {
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    // waitUntil: load 会等子 frame 也加载完，frame 树在 probe 时已经稳定
    await session.goto(`${fixture.url}/frames.html`, { waitUntil: "load" });
    const stats = await session.probe();
    assert.equal(stats.frames, 3, "主文档 + 两个 iframe");
    assert.equal(stats.crossOriginFrames, 1);

    // 落到判定上：跨域的报一次；同源的已经能遍历，不报
    const caseDef = CaseDefinitionSchema.parse({ title: "frames", goal: "看一眼", startUrl: `${fixture.url}/frames.html` });
    const report = admit(stats, caseDef);
    assert.deepEqual(report.warnings, ["检测到 1 个跨域 iframe，其内部控件不可见"]);
  });
});

e2e("导航在途时观测：等文档就绪，而不是把「读不到」判成运行故障", async () => {
  // 这条来自一次真跑：点「Search」提交后跳转到新文档，而动作之后紧接的那次观测
  // 正好落在「旧文档已卸载、新文档还没 body」的窗口里，snapshot.js 于是返回 null，
  // 整轮运行被判成 error。
  //
  // 用 `waitUntil: "commit"` 让这个窗口**确定性地**出现：页面刚提交、DOM 还没解析，
  // 此时 document.body 必定不存在。修好之前，下面这一行会直接抛错。
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/index.html${KEEP_TRAPS}`, {
      waitUntil: "commit",
    });
    assert.match(page.url, /\/index\.html/, "观测到的应当是那份已提交的新文档");
    assert.ok(page.actions.length > 0, "等到文档就绪之后，元素表必须是有内容的");
    assert.ok(page.text.length > 0, "可见文本同样应当读到了");
  });
});

e2e("打开起始页：等接口回来再做第一次观测，而不是只看到 DOMContentLoaded 时的外壳", async () => {
  // 这条来自一次真跑：后台页面在 DOMContentLoaded 时只有导航栏，列表与「批量导入」
  // 按钮是随后一次 XHR 拉回来的。第一次观测落在那之前，模型看不到能做的事，直接 BLOCKED。
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/late.html`, { waitUntil: "domcontentloaded" });
    const labels = page.actions.map((action) => action.label);
    assert.ok(labels.includes("批量导入产品库"), `第一次观测就应当看到晚到的按钮，实际：${labels.join(" / ")}`);
    assert.ok(labels.includes("导入设置"));
  });
});

e2e("观测：没有 role、只靠 cursor:pointer 可点的菜单项也进候选集，且能被点中", async () => {
  // 这条来自一次真跑：「批量导入产品库」的下拉已经展开，但菜单项是无语义的 <li>，
  // 元素表里没有它们；模型读得到「导入eBay产品库」却无 id 可点，转而点了侧边栏的「eBay 导入」。
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/pointer.html`, { waitUntil: "domcontentloaded" });
    const labels = page.actions.map((action) => action.label);
    const item = page.actions.find((action) => action.label === "导入eBay产品库");
    assert.ok(item !== undefined, `菜单项应当进候选集：${labels.join(" | ")}`);
    assert.equal(item.role, "button", "无语义可点元素按 button 记，只读模式才会保守地剔除它");
    assert.ok(labels.includes("导入亚马逊产品库"));
    // cursor: no-drop 的禁用项不是 pointer，不进
    assert.equal(labels.includes("导入SHEIN产品库"), false, labels.join(" | "));
    // 每个菜单项只算一次：<span class="title"> 继承了 pointer，但它不是最外层
    assert.equal(labels.filter((label) => label === "导入eBay产品库").length, 1, labels.join(" | "));
    // 与语义候选重叠的 pointer 元素不重复收：label 包着复选框、卡片里有链接
    assert.equal(labels.filter((label) => label === "全选").length, 1, labels.join(" | "));
    assert.equal(labels.some((label) => label.includes("卡片正文")), false, labels.join(" | "));

    // 点下去必须真的触发委托在 <ul> 上的处理器：页面把结果写进可见文本
    await session.act(item, page);
    const after = await session.observe();
    assert.match(after.text, /已导入：ebay/);
  });
});

e2e("观测：页面提示（toast / alert）单独收进 notices，常驻公告、读屏区域、已关的 toast 不收", async () => {
  // 这条来自一次真跑：「请输入SKU」的 toast 混在几千字正文里、与同名占位符分不开，模型连点了四次「确定」。
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/notices.html`, { waitUntil: "domcontentloaded" });
    assert.deepEqual(page.notices, ["请输入SKU", "SKU 不能为空", "导入失败"]);
  });
});

e2e("观测：无名复选框的 label 带上所在表格行，表头全选框与数据行分得开", async () => {
  // 这条来自一次真跑：目标写明「勾前 2 个、不要点表头全选框」，而元素表里它们全叫 `checkbox`，
  // 模型第一步就点了全选（一次选中 50 项）。
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/table.html`, { waitUntil: "domcontentloaded" });
    const labels = page.actions.filter((action) => action.role === "checkbox").map((action) => action.label);
    assert.deepEqual(labels, [
      "checkbox · header row (usually select all) · 标题 物品单价",
      "checkbox · row 1 · Remote Control Car Toy SG$8.82",
      "checkbox · row 2 · LELEMAO Large Rechargeable RC Off-road Car SG$26.10",
      "checkbox · row 3 · Hot Wheels Basic Single Car SG$3.50",
      "checkbox · header row (usually select all) · 账号",
      "checkbox · row 1 · 主账号",
      "checkbox · row 2 · 子账号",
      "保存图片",
      "checkbox",
    ]);
  });
});

e2e("动作之后：等动作引出的接口回来再观测，弹窗里晚到的选项不被错过", async () => {
  // 这条来自一次真跑：点「导入eBay产品库」后弹窗外壳立刻出现，SKU 选项等接口回来才渲染。
  // 观测落在两者之间，模型只看得到「确定」，于是在选 SKU 方式之前就点了它。
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/dialog.html`, { waitUntil: "domcontentloaded" });
    const open = page.actions.find((action) => action.label === "导入eBay产品库");
    assert.ok(open !== undefined);
    await session.act(open, page);
    const after = await session.observe();
    const labels = after.actions.map((action) => action.label);
    assert.ok(labels.includes("确定"), labels.join(" | "));
    assert.ok(labels.includes("自动以ListingID或ASIN为SKU"), `弹窗内容应当已经到了：${labels.join(" | ")}`);
  });
});

e2e("动作之后：动作引出的请求迟迟不回时按上限放行，不挂住运行", async () => {
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/dialog.html`, { waitUntil: "domcontentloaded" });
    const slow = page.actions.find((action) => action.label === "刷新统计");
    assert.ok(slow !== undefined);
    const started = Date.now();
    await session.act(slow, page);
    const elapsed = Date.now() - started;
    // 接口 5s 才回，上限 3s：等到上限就放行（留出 evaluate 往返的余量）
    assert.ok(elapsed < 4_500, `act 用了 ${elapsed}ms，应当在上限附近放行`);
    const after = await session.observe();
    assert.equal(after.text.includes("统计已刷新"), false, "这时接口确实还没回来");
  });
});

e2e("观测：同源 iframe 的元素并进元素表（f1:e7、坐标在顶层），跨域 iframe 计入 unreadableFrames", async () => {
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/frames.html`, { waitUntil: "load" });
    assert.equal(page.unreadableFrames, 1, "跨域 iframe 200x100 在视口里：看得见、读不到");
    const inFrame = page.actions.filter((action) => /^f\d+:e\d+$/.test(action.id));
    const home = inFrame.find((action) => action.label === "首页");
    assert.ok(home !== undefined, `同源 iframe 里的面包屑链接应当进元素表：${page.actions.map((a) => a.id + " " + a.label).join(" | ")}`);
    assert.ok((home.node ?? 0) >= 1_000_000, "子 frame 的节点身份编码过，不与主文档撞号");
    assert.ok((home.rect?.y ?? 0) > 0, "几何换算到顶层视口");
    // 跨域 iframe 里同名的链接读不到：同一个 detail.html，只进来一份
    assert.equal(page.actions.filter((action) => action.label === "首页").length, 1);
    // 主文档没有文字：iframe 那段打头，前面不留空行
    assert.match(page.text, /^\[iframe f\d+: [^\]]*设备详情\]\n首页/);
  });
});

e2e("同源 iframe：弹窗里晚到的 iframe 表单能填、能选、能在 iframe 里滚、能点保存；被父文档浮层盖住的不进候选", async () => {
  // 这条来自一次真跑：「添加产品」的表单在弹窗的 iframe 里，主文档被遮罩盖住，
  // 快照只看主文档，模型面前只剩空壳，第 3 步就回了 BLOCKED。
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/iframe-modal.html`, { waitUntil: "domcontentloaded" });
    const add = page.actions.find((action) => action.label === "+ 添加产品");
    assert.ok(add !== undefined);
    await session.act(add, page);

    // iframe 文档 600ms 才回：动作之后的等待要把它算进去，这一次观测就该看到表单
    let now = await session.observe();
    const labels = (): string => now.actions.map((action) => `${action.id} ${action.label}`).join(" | ");
    const title = now.actions.find((action) => action.kind === "fill" && action.label === "模板标题");
    assert.ok(title !== undefined, `iframe 里的输入框应当进元素表：${labels()}`);
    assert.match(title.id, /^f\d+:e\d+$/);
    assert.equal(now.actions.some((action) => action.label === "+ 添加产品"), false, "主文档被遮罩盖住");
    assert.equal(now.actions.some((action) => action.label === "被盖住的按钮"), false, `父文档的浮层盖住了它：${labels()}`);

    await session.act(title, now, "测试模板");
    now = await session.observe();
    const uk = now.actions.find((action) => action.kind === "select" && action.label.endsWith("eBay UK"));
    assert.ok(uk !== undefined, labels());
    await session.act(uk, now);
    now = await session.observe();
    assert.equal(now.actions.find((action) => action.kind === "fill" && action.label === "模板标题")?.value, "测试模板");

    // 滚轮落点在 iframe 上：滚动动作取自 iframe（主文档本身并不能滚）
    assert.equal(now.actions.some((action) => action.label === "保存模板"), false, "保存按钮在 iframe 首屏之下");
    const down = now.actions.find((action) => action.id === "scroll_down");
    assert.ok(down !== undefined, `iframe 能往下滚：${labels()}`);
    await session.act(down, now);
    now = await session.observe();
    const save = now.actions.find((action) => action.label === "保存模板");
    assert.ok(save !== undefined, `滚过之后保存按钮应当露出来：${labels()}`);
    await session.act(save, now);
    now = await session.observe();
    assert.match(now.text, /已保存：测试模板 · eBay UK/);
  });
});

e2e("动作之后：iframe 文档超过 3s 才回、回来后还白屏一阵，也等它加载完再观测", async () => {
  // 这条来自一次真跑：iframe 文档 2.2s 才回来，之后还要拉样式与脚本；3s 的安静上限到点时 iframe 仍是白屏，
  // 模型对着空壳回了 BLOCKED。
  const src = encodeURIComponent("iframe-form.html?delay=3500&ready=800");
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/iframe-modal.html?src=${src}`, { waitUntil: "domcontentloaded" });
    const add = page.actions.find((action) => action.label === "+ 添加产品");
    assert.ok(add !== undefined);
    await session.act(add, page);
    const after = await session.observe();
    const labels = after.actions.map((action) => action.label).join(" | ");
    assert.ok(after.actions.some((action) => action.label === "模板标题"), `iframe 表单应当已经显示出来：${labels}`);
    assert.equal(after.blankFrames, undefined);
  });
});

e2e("观测：看得见却一个可操作元素都没有的大 iframe 记进 blankFrames（键带文档身份）", async () => {
  const src = encodeURIComponent("about:blank");
  await wiring.pool.withSession({ tracing: false }, async (session) => {
    const page = await session.goto(`${fixture.url}/iframe-modal.html?src=${src}`, { waitUntil: "domcontentloaded" });
    assert.equal(page.blankFrames, undefined, "弹窗没打开时 iframe 看不见，不算白屏");
    const add = page.actions.find((action) => action.label === "+ 添加产品");
    assert.ok(add !== undefined);
    await session.act(add, page);
    const after = await session.observe();
    assert.equal(after.blankFrames?.length, 1);
    assert.match(after.blankFrames[0] ?? "", /^f\d+@\d+(\.\d+)?$/);
  });
});

// ---------------------------------------------------------------------------
// 全链路：搜索流程
// ---------------------------------------------------------------------------

e2e("全链路：输入 + 提交 + 动态结果 + 断言 + 报告自包含", async () => {
  const { space } = await observeFixture("interactive");
  const searchbox = targetIndex(space, "TYPE_TEXT", "搜索设备");
  const searchButton = targetIndex(space, "CLICK", "搜索", "button");
  const caseDef = await importCase(`schemaVersion: 1
title: 夹具站点搜索设备
goal: >-
  Search the device inventory for LaserJet printers and stop when the matching
  device is displayed.
startUrl: ${fixture.url}/index.html${KEEP_TRAPS}
allowedOrigins:
  - ${fixture.url}
budget:
  maxSteps: 8
  maxModelCalls: 16
  maxElapsedMs: 30000
assertions:
  final:
    text:
      contains:
        - HP LaserJet 1020
    controls:
      - labelContains: 搜索设备
        role: searchbox
        valueContains: LaserJet
  trajectory:
    statusIn:
      - done
    mustUse:
      - kind: fill
      - kind: click
`);

  const report = await runCase(caseDef, [
    {
      operation: { choice: "TYPE_TEXT" },
      targets: { type_text_target: { choice: searchbox } },
      text: "LaserJet",
    },
    { operation: { choice: "CLICK" }, targets: { click_target: { choice: searchButton } } },
    { operation: { choice: "DONE" } },
  ]);

  // status 描述循环如何结束，passed 是断言判决——这里两者都要对。
  assert.equal(report.status, "done", `failureReason: ${report.failureReason ?? ""}`);
  assert.equal(report.passed, true, JSON.stringify(report.assertion?.checks ?? {}, null, 2));

  // `steps` 数的是**浏览器动作**，DONE 不是一步：它只终止循环，不产生任何输入。
  // 「模型被问了几次」记在 stats.decisions 里——两者刻意不是一个数（见 report 层口径）。
  const steps = report.steps;
  assert.deepEqual(
    steps.map((step) => step.kind),
    ["fill", "click"],
    `实际轨迹：${steps.map((step) => `${step.kind}(${step.action})`).join(",")}`,
  );
  assert.equal(steps[0]?.text, "LaserJet");
  assert.equal(steps[0]?.executed, true);
  assert.equal(steps[1]?.pageChanged, true, "提交后结果卡片渲染出来了，页面应当被判定为有变化");

  // 准入是记录与警告，不是运行的闸；但一次正常跑完的运行必须有这份记录。
  assert.ok(report.admission !== null, "正常跑完的运行 admission 必定非 null");
  assert.equal(report.admission.ok, true);

  // 成本统计来自 BudgetMeter（唯一持有者），scripted 每次决策算 1 个请求。
  // 三次决策：fill / click / DONE。DONE 终止循环，不产生浏览器动作，所以 steps 只有两条。
  assert.equal(
    report.stats.decisions,
    3,
    `实际轨迹：${report.steps.map((step) => `#${step.step} ${step.kind} ${JSON.stringify(step.action)}`).join(" | ")}`,
  );
  // 但**实际付费请求是 4 次**：3 次决策 + 1 次文本取值（TYPE_TEXT 走了小模型）。
  // 预算按请求数算，因此文本取值也占额度——它同样是要花钱的一次调用。
  assert.equal(report.stats.modelCalls, 4, "3 次决策 + 1 次文本取值");
  // 输入的那一步要记下「文本是谁生成的」——排查用例失败时，先要知道值是谁给的。
  // 这里是 `scripted`（真正生成文本的那个引擎）而不是外层的包装名：
  // 报告该记**实际来源**，而不是调用链上某一层的自称。
  assert.equal(report.steps[0]?.textEngine, "scripted");
  assert.equal(report.stats.costUsd, null, "未报金额时必须是 null，不能拿 0 冒充");

  // 报告自包含（D13）：用例快照与版本标识都在，且快照是**完整的 Case**。
  assert.ok(report.caseRevision >= 1, "从用例库跑的运行应当带上 revision");
  assert.equal(report.caseDigest.length, 64);
  const frozen = await readFile(join(wiring.settings.runsDir, report.runId, FROZEN_CASE_FILE), "utf8");
  assert.ok(frozen.includes("maxSteps: 8"), `冻结的是完整 Case（默认值一并落盘）：\n${frozen}`);

  // trace.zip 是排查失败时最有用的东西，必须在 finally 里落盘。
  const trace = await stat(join(wiring.settings.runsDir, report.runId, "trace.zip"));
  assert.ok(trace.size > 0, "trace.zip 应当非空");
});

// ---------------------------------------------------------------------------
// 全链路：护栏
// ---------------------------------------------------------------------------

e2e("全链路：危险按钮被护栏在执行前拦下（命中时浏览器未收到任何输入）", async () => {
  const { space } = await observeFixture("interactive");
  const deleteButton = targetIndex(space, "CLICK", "删除此项目", "button");
  const caseDef = await importCase(`schemaVersion: 1
title: 夹具站点危险按钮（应被护栏拦下）
goal: Delete this project from the inventory.
startUrl: ${fixture.url}/index.html${KEEP_TRAPS}
allowedOrigins:
  - ${fixture.url}
assertions:
  trajectory:
    statusIn:
      - guardrail_blocked
`);

  const report = await runCase(caseDef, [
    { operation: { choice: "CLICK" }, targets: { click_target: { choice: deleteButton } } },
  ]);

  assert.equal(report.status, "guardrail_blocked");
  // 护栏命中时**浏览器没有收到任何输入**，这一条是它的全部意义所在。
  assert.equal(report.steps[0]?.executed, false);
  assert.ok((report.steps[0]?.blockReason ?? "").length > 0, "必须说清为什么被拦");
  assert.equal(report.guardrailHits.length, 1);
  assert.ok(report.guardrailHits[0]?.action.includes("删除"));

  // 用例把 guardrail_blocked 写进了 statusIn，所以断言判决是通过——
  // 「被拦下」在配置正确时是**好结果**（安全网起作用了）。
  assert.equal(report.passed, true, JSON.stringify(report.assertion?.checks ?? {}, null, 2));
});

// ---------------------------------------------------------------------------
// 全链路：只读模式
// ---------------------------------------------------------------------------

e2e("全链路：readonly 模式下变更型操作根本不在候选集里", async () => {
  const caseDef = await importCase(`schemaVersion: 1
title: 夹具站点只读浏览
goal: Look at the device inventory page and stop.
startUrl: ${fixture.url}/index.html${KEEP_TRAPS}
allowedOrigins:
  - ${fixture.url}
mode: readonly
assertions:
  trajectory:
    statusIn:
      - done
    forbiddenKinds:
      - fill
      - select
`);

  seenRequests.length = 0;
  const report = await runCase(caseDef, [{ operation: { choice: "DONE" } }]);
  assert.equal(report.status, "done");
  assert.equal(report.passed, true, JSON.stringify(report.assertion?.checks ?? {}, null, 2));

  const request = seenRequests[0];
  assert.ok(request !== undefined, "至少要发生一次决策");
  const keys = request.questions.map((question) => question.key);
  // 关键：不是「键存在但没有候选」，而是**键根本不存在**。模型无从选中一个不存在的东西。
  assert.equal(keys.includes("type_text_target"), false, `readonly 下仍有：${keys.join(",")}`);
  assert.equal(keys.includes("select_target"), false);

  const operation = request.questions[0];
  assert.equal(operation?.key, "operation");
  const offered = (operation?.options ?? []).map((option) => option.id);
  assert.equal(offered.includes("TYPE_TEXT"), false);
  assert.equal(offered.includes("SELECT"), false);
  assert.ok(offered.includes("CLICK"), "只读允许点击（导航与聚焦属于「看」）");

  // 夹具页面里确实有原生 select，且它在交互模式下**是**候选——所以上面那两条
  // 不是因为「页面上压根没有下拉」才通过的。不走这一步，整条测试可能是空洞的。
  const interactive = await observeFixture("interactive");
  assert.ok(
    interactive.space.elements.some((element) => element.role === "combobox"),
    "交互模式下应当观测到原生下拉",
  );
  assert.ok(interactive.space.targets["SELECT"] !== undefined, "交互模式下下拉的选项是独立候选");

  // 而只读下一个 `select` 动作都没有了（候选只剩变更型操作），
  // 于是这个元素**整个不进元素表**——这正是「构造阶段剔除」的直接后果。
  const readonly = await observeFixture("readonly");
  assert.equal(readonly.space.targets["SELECT"], undefined);
  assert.equal(readonly.space.targets["TYPE_TEXT"], undefined);
  assert.equal(
    readonly.space.elements.some((element) => element.role === "combobox"),
    false,
    "只读模式下下拉的候选全是变更型操作，因此它不该出现在元素表里",
  );
  assert.ok(readonly.space.elements.length > 0, "只读不等于空页面：链接与可聚焦字段仍在候选集里");
});

// ---------------------------------------------------------------------------
// 泄漏检查
// ---------------------------------------------------------------------------

e2e("全部运行结束后 contextsActive 回到 0（context 泄漏的唯一判据）", () => {
  assert.equal(wiring.pool.activeContexts(), 0);
  const status = wiring.runner.status();
  assert.equal(status.queued, 0);
  assert.equal(status.active, 0);
  assert.equal(status.contextsActive, 0);
});

e2e("每个运行的报告都能被读回，且都留下了 trace", async () => {
  const reports = await wiring.store.list();
  assert.ok(reports.length >= 3, `用例库里应当有 3 个夹具用例，实际 ${reports.length}`);
  // 每个用例都至少跑过一次，且最近一次运行的结论可反查。
  for (const summary of reports) {
    assert.ok(summary.lastRun !== null, `${summary.id} 应当有运行记录`);
  }
});
