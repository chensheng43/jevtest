/**
 * 界面走查：用真 Chromium 把 Web 平台点一遍。
 *
 *   npm run walkthrough
 *
 * 它自己起服务、自己收摊：随机空闲端口、`mkdtemp` 出来的临时用例库，
 * **不碰仓库里的 `cases/` 与 `runs/`**（`runs/` 只读地用来开一个历史运行）。
 * 截图落在临时目录里，退出时打印路径。
 *
 * 存在理由：`tests/frontend.test.ts` 能守住「改了会静默坏掉」的跨文件约定，
 * 但守不住「点起来对不对」——表单填一遍、断言增删、保存后重载这些事，
 * 只有真点过才知道。这个脚本就是那次点击的脚本化版本，它已经抓到过三个真缺陷：
 *
 *   1. 新建用例点「检测页面」请求的是 `/api/cases/null/admit`（"null" 恰好是
 *      合法 id 的形状），回一句看不懂的「用例不存在」；
 *   2. 已存在的用例第二次保存必然 409——`revision` 载入后从不回写；
 *   3. `DELETE` 回 204 + 空 body，前端却对空 body 调 `response.json()`，
 *      于是每一次删除都弹「Unexpected end of JSON input」——用例其实已经删了。
 *
 * 三条都是「页面照常打开、行为却是错的」，`npm test` 一条也测不到。
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SEED = readFileSync(join(ROOT, "cases", "wikipedia-godel.yaml"), "utf8");

const problems = [];
const steps = [];
const ok = (label, extra = "") => {
  const line = `OK   ${label}${extra ? `  ${extra}` : ""}`;
  steps.push(line);
  console.log(line);
};

/** 让内核给一个空闲端口：bind(0) 拿到的端口立刻放掉，随后交给服务用。 */
function freePort() {
  return new Promise((good, bad) => {
    const probe = createServer();
    probe.on("error", bad);
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => good(port));
    });
  });
}

async function waitForHealth(base, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${base}/api/health`);
      if (response.ok) return await response.json();
    } catch {
      // 还没起来，接着等。
    }
    await new Promise((done) => setTimeout(done, 250));
  }
  throw new Error(`服务没能在 ${timeoutMs / 1000} 秒内起来`);
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const casesDir = mkdtempSync(join(tmpdir(), "jevtest-walkthrough-cases-"));
const shotsDir = mkdtempSync(join(tmpdir(), "jevtest-walkthrough-shots-"));

// 用例库必须另指一处：脚本会建用例、也会删用例，跑在仓库的 cases/ 上就是污染。
// runs/ 不另指——历史运行是只读的，而且结果页需要一个真跑过的运行。
const server = spawn(process.execPath, ["--experimental-strip-types", "src/cli.ts", "serve"], {
  cwd: ROOT,
  env: { ...process.env, JEVTEST_PORT: String(port), JEVTEST_CASES_DIR: casesDir },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
server.stdout.on("data", (chunk) => { serverLog += chunk; });
server.stderr.on("data", (chunk) => { serverLog += chunk; });

let browser = null;
try {
  await waitForHealth(base);
  console.log(`服务已起：${base}（用例库 ${casesDir}）\n`);

  browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1280, height: 950 } });
  page.on("pageerror", (error) => problems.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() !== "error") return;
    // 校验那一步故意发一个空标题，浏览器一定会为那个 400 打一行——预期之内。
    if (message.text().includes("400 (Bad Request)")) return;
    problems.push(`console.error: ${message.text()}`);
  });
  // 界面不该再弹原生对话框（确认一律走 <dialog>）；离开有未保存修改的页面时的 beforeunload 除外
  page.on("dialog", (dialog) => {
    if (dialog.type() !== "beforeunload") problems.push(`弹出了原生 ${dialog.type()} 对话框：${dialog.message()}`);
    void dialog.accept();
  });
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    if (status === 400 && response.url().endsWith("/api/cases")) return;
    problems.push(`HTTP ${status} ${response.url()}`);
  });
  const shot = (name) => page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });
  /** 等一条 toast 出现，返回它的文字 */
  const toastText = async () => (await page.locator(".toast-item").last().textContent())?.trim();
  /** 点 <dialog> 里的确认按钮 */
  const confirmDialog = async () => {
    await page.waitForSelector("dialog.confirm-dialog[open]");
    await page.click("dialog.confirm-dialog [data-confirm]");
  };

  // ------------------------------------------------------------------ 新建页
  await page.goto(`${base}/#/new`);
  await page.waitForSelector(".new-grid");
  ok("新建页：手填与导入两个入口并列", `panel=${await page.locator(".new-grid .panel").count()}`);
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.waitForSelector(".error-slot .callout--danger");
  ok("空内容点导入：页面错误槽说清原因", (await page.locator(".error-slot .callout-title").textContent())?.trim());
  await shot("01-new");

  // ---------------------------------------------------- 粘贴 YAML 导入种子
  await page.fill("#app textarea", SEED);
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith("#/case/"));
  const importedId = page.url().split("/").pop();
  ok("粘贴导入种子用例", `#/case/${importedId}`);

  // --------------------------------------------------- 载入后：断言有没有丢
  await page.waitForSelector("#sec-assertions .recipe-row");
  ok("断言节：配方行", `行数=${await page.locator("#sec-assertions .recipe-row").count()} 目录计数="${await page.locator('.editor-nav-link[data-section="assertions"] .nav-count').textContent()}"`);

  const role = await page.locator('.raw-row input[data-path="assertions.trajectory.mustUse.0.role"]').inputValue();
  if (role !== "searchbox") problems.push(`mustUse 的 role 没读出来（得到 "${role}"）`);
  else ok("原始行编辑器读回了 mustUse.role", role);

  const minOp = await page.locator('input[data-path="assertions.quality.minOperationProbability"]').inputValue();
  if (minOp !== "0.4") problems.push(`minOperationProbability 没读出来（得到 "${minOp}"）`);
  else ok("原始字段读回了 quality.minOperationProbability", minOp);
  await shot("02-editor");

  const saveButton = page.getByRole("button", { name: "保存", exact: true });
  if (!(await saveButton.isDisabled())) problems.push("没改动时「保存」应该是禁用的");
  else ok("未改动时「保存」为禁用");

  // 原始行的改动也要标脏（旧版不会：保存按钮一直灰着）
  await page.fill('.raw-row input[data-path="assertions.trajectory.mustUse.0.role"]', "textbox");
  if (await saveButton.isDisabled()) problems.push("改了原始行却没有标脏");
  else ok("改原始行也会标脏");
  await page.fill('.raw-row input[data-path="assertions.trajectory.mustUse.0.role"]', "searchbox");

  // ------------------------------------------- 改一条断言 → 双击保存 → 重载
  await page.fill('input[data-path="assertions.final.text.contains.0"]', "Gödel");
  if (!(await page.locator(".dirty-badge").isVisible())) problems.push("改了断言却没有出现「有未保存的修改」");
  else ok("改动后出现「有未保存的修改」");
  // 双击：旧版第二次必然 409（假冲突）。现在按钮在执行期间是禁用的
  await saveButton.dblclick();
  await page.waitForSelector(".toast-item");
  ok("双击保存只存一次", await toastText());
  if ((await page.locator(".error-slot .callout--danger").count()) > 0) problems.push("双击保存出现了错误（假冲突？）");

  await page.fill('input[data-path="assertions.final.text.contains.0"]', "incompleteness_theorems");
  await page.keyboard.press(process.platform === "darwin" ? "Meta+s" : "Control+s");
  await page.waitForFunction(() => document.querySelectorAll(".toast-item").length >= 2 || document.querySelector(".toast-item")?.textContent.includes("r3"));
  ok("快捷键保存（revision 已回写，不 409）", await toastText());

  await page.reload();
  await page.waitForSelector("#sec-assertions .recipe-row");
  const kept = await page.locator('input[data-path="assertions.final.text.contains.0"]').inputValue();
  if (kept !== "incompleteness_theorems") problems.push(`重载后断言值不对：${kept}`);
  else ok("重载后断言值保持", kept);

  // ------------------------------------------------------ 离开确认用 <dialog>
  await page.fill('input[data-path="title"]', "改了但不保存");
  await page.click('#nav a[data-nav="runs"]');
  await page.waitForSelector("dialog.confirm-dialog[open]");
  ok("有未保存修改时离开：弹出确认框", (await page.locator(".dialog-title").textContent())?.trim());
  await page.click("dialog.confirm-dialog button:not([data-confirm])");
  if (!(await page.locator('input[data-path="title"]').isVisible())) problems.push("点了「留下」却离开了编辑器");
  else ok("点「留下」后草稿还在", await page.locator('input[data-path="title"]').inputValue());
  await page.fill('input[data-path="title"]', "Wikipedia 打开哥德尔不完备定理条目");

  // -------------------------------------------------------------- 手工新建
  await page.goto(`${base}/#/case-new-form`);
  await page.waitForSelector('input[data-path="title"]');
  await page.fill('input[data-path="title"]', "手工建的用例");
  await page.fill('textarea[data-path="goal"]', "打开本地夹具页并提交表单");
  await page.fill('input[data-path="startUrl"]', "https://example.test/form");
  if (!(await page.getByRole("button", { name: "检测页面" }).isDisabled())) problems.push("新建用例时「检测页面」应该是禁用的");
  else ok("未保存时「检测页面」置灰");

  await page.selectOption(".recipe-add select", "text.contains");
  await page.getByRole("button", { name: "添加断言" }).click();
  await page.fill('input[data-path="assertions.final.text.contains.0"]', "已提交");
  ok("新用例：断言计数更新", `"${await page.locator('.editor-nav-link[data-section="assertions"] .nav-count').textContent()}"`);

  // ------------------------------------------------------ 校验：字段标红 + 人话汇总
  await page.fill('input[data-path="title"]', "");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.waitForSelector(".field-error");
  ok("校验失败：字段标红", `is-invalid=${await page.locator("input.is-invalid").count()}`);
  const issue = (await page.locator(".error-slot .issue-field").first().textContent())?.trim();
  if (issue !== "标题") problems.push(`错误汇总没有把路径译成人话（得到「${issue}」）`);
  else ok("错误汇总用人话写字段名", issue);
  await page.locator(".error-slot .issue-link").first().click();
  ok("点汇总里的字段名跳过去", `焦点在 ${await page.evaluate(() => document.activeElement?.getAttribute("data-path"))}`);
  await shot("03-validation");

  await page.fill('input[data-path="title"]', "手工建的用例");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith("#/case/") && !location.hash.includes("new-form"));
  const manualId = page.url().split("/").pop();
  ok("手工创建成功", `#/case/${manualId}`);

  await page.getByRole("button", { name: "查看 YAML" }).click();
  const payload = await page.locator("pre.payload").textContent();
  if (!payload?.includes("assertions")) problems.push("「保存内容」抽屉没有渲染出将提交的内容");
  else ok("保存内容抽屉渲染", `${payload.length} 字符`);
  await shot("04-drawer");

  // ------------------------------------------------------------ 运行列表
  await page.goto(`${base}/#/runs`);
  // 等列表**或**空状态出现：`GET /api/runs` 是异步拉的，直接数行会数到 0
  await page.waitForSelector(".list-table, .empty");
  const indexed = await page.locator(".list-table tbody tr").count();
  if (indexed === 0) {
    // 仓库里没有历史运行（全新 clone）时跳过结果页那几步，而不是判失败。
    console.log("SKIP 运行历史为空，跳过结果页走查（跑一次用例再回来）");
  } else {
    ok("运行列表渲染", `行数=${indexed} 筛选=${(await page.locator(".segmented-item").allTextContents()).join(" ")}`);
    await shot("05-runs");

    await page.locator(".list-table tbody tr .row-title").first().click();
    // 等报告到：判决带落到三态之一（第一次轮询前是骨架，不是「运行中」）
    await page.waitForSelector(".verdict-card.passed, .verdict-card.failed, .verdict-card.undecided");
    ok("结果页：判决带", (await page.locator(".verdict-title").textContent())?.trim());
    await page.waitForSelector(".trace-step, .trace .viewer-empty");
    ok("轨迹：步骤时间线", `条目=${await page.locator(".trace-step").count()}`);
    const images = page.locator(".viewer-image img");
    if ((await images.count()) > 0) {
      await images.first().evaluate((img) => img.decode());
      const width = await images.first().evaluate((img) => img.naturalWidth);
      if (width === 0) problems.push("轨迹截图没加载出来");
      else ok("轨迹截图加载", `${width}px 宽`);
    } else {
      console.log("SKIP 这次运行没有截图（早于截图通路的运行），截图检查跳过");
    }
    ok("断言明细", `行数=${await page.locator("#run-assertions tr").count()}`);
    await shot("06-run");
  }

  // -------------------------------------------------------------- 深色模式
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${base}/#/cases`);
  await page.waitForSelector(".list-table");
  ok("深色模式生效", `data-bs-theme=${await page.locator("html").getAttribute("data-bs-theme")}`);
  await shot("07-cases-dark");
  await page.goto(`${base}/#/case/${manualId}`);
  await page.waitForSelector("#sec-assertions");
  await shot("08-editor-dark");

  // -------------------------------------------------------- 删除手工用例
  await page.goto(`${base}/#/cases`);
  await page.waitForSelector(".list-table tbody tr");
  const before = await page.locator(".list-table tbody tr").count();
  const target = page.locator(".list-table tbody tr", { hasText: "手工建的用例" });
  await target.locator(".menu > summary").click();
  await target.getByRole("menuitem", { name: "删除用例" }).click();
  await confirmDialog();
  await target.waitFor({ state: "detached" });
  ok("删除用例（菜单 + 确认框）", `${before} -> ${await page.locator(".list-table tbody tr").count()}，${await toastText()}`);
} catch (error) {
  problems.push(`走查中断：${error.message}`);
} finally {
  await browser?.close();
  server.kill();
  rmSync(casesDir, { recursive: true, force: true });
  // 服务没起来时把它的输出打出来——那是唯一能看出原因的地方。
  if (steps.length === 0) console.log(serverLog);
}

console.log(`\n=== 汇总 ===\n${steps.join("\n")}`);
console.log(`\n截图：${shotsDir}`);
if (problems.length === 0) {
  console.log("\n没有发现问题。");
  process.exit(0);
}
console.log(`\n问题 ${problems.length} 条：`);
for (const line of problems) console.log(`  - ${line}`);
process.exit(1);
