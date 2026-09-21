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
  page.on("dialog", (dialog) => dialog.accept());
  page.on("response", (response) => {
    const status = response.status();
    if (status < 400) return;
    if (status === 400 && response.url().endsWith("/api/cases")) return;
    problems.push(`HTTP ${status} ${response.url()}`);
  });
  const shot = (name) => page.screenshot({ path: join(shotsDir, `${name}.png`), fullPage: true });

  // ------------------------------------------------------------------ 导入页
  await page.goto(`${base}/#/new`);
  await page.waitForSelector(".entry-choice-item");
  ok("导入页：两条入口并列", `entry-choice-item=${await page.locator(".entry-choice-item").count()}`);
  await page.waitForSelector(".drop-zone");
  const readonly = await page.locator("#app input[readonly]").count();
  if (readonly !== 0) problems.push(`导入页还有 ${readonly} 个只读输入框（应已删除）`);
  else ok("导入页：只读的「文件名」输入框已删除");
  await shot("01-import");

  // ---------------------------------------------------- 粘贴 YAML 导入种子
  await page.fill("#app textarea", SEED);
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith("#/case/"));
  const importedId = page.url().split("/").pop();
  ok("粘贴导入种子用例", `#/case/${importedId}`);

  // --------------------------------------------------- 载入后：断言有没有丢
  await page.waitForSelector("#tab-assertions");
  await page.click("#tab-assertions");
  ok("断言档：配方行",
    `角标="${await page.locator("#tab-assertions .tab-badge").textContent()}" 行数=${await page.locator(".recipe-row").count()}`);

  const rawRows = await page.locator(".disclosure[open] .raw-row").count();
  if (rawRows === 0) {
    problems.push("「其他（配方之外的断言字段）」没有默认展开——载入的 mustUse / minOperationProbability 看不见");
  } else {
    ok("「其他」默认展开且列出原始行",
      (await page.locator(".raw-row .raw-row-label").allTextContents()).join(" / "));
  }

  const role = await page.locator('.raw-row input[data-path="assertions.trajectory.mustUse.0.role"]').inputValue();
  if (role !== "searchbox") problems.push(`mustUse 的 role 没读出来（得到 "${role}"）`);
  else ok("原始行编辑器读回了 mustUse.role", role);

  const minOp = await page.locator('input[data-path="assertions.quality.minOperationProbability"]').inputValue();
  if (minOp !== "0.4") problems.push(`minOperationProbability 没读出来（得到 "${minOp}"）`);
  else ok("原始字段读回了 quality.minOperationProbability", minOp);
  await shot("02-assertions");

  const disabled = await page.getByRole("button", { name: "保存", exact: true }).isDisabled();
  if (!disabled) problems.push("没改动时「保存」应该是禁用的");
  else ok("未改动时「保存」为禁用");

  // ------------------------------------------------ 改一条断言 → 保存 → 重载
  // 种子用例里本来就是 "incompleteness"——填成一样的值不算改动（脏标记比的是
  // 语义不是击键），所以这里故意换个值。
  await page.fill('input[data-path="assertions.final.text.contains.0"]', "Gödel");
  if (!(await page.locator(".dirty-badge").isVisible())) {
    problems.push("改了断言却没有出现「有未保存的修改」");
  } else {
    ok("改动后出现「有未保存的修改」");
  }
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForSelector(".alert-success");
  ok("保存成功", (await page.locator(".alert-success").textContent())?.trim());

  // 再存一次：旧代码的第二次必然 409（revision 从不回写）。
  await page.fill('input[data-path="assertions.final.text.contains.0"]', "incompleteness_theorems");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.waitForSelector(".alert-success");
  ok("第二次保存也成功（revision 已回写）", (await page.locator(".alert-success").textContent())?.trim());

  await page.reload();
  await page.waitForSelector("#tab-assertions");
  await page.click("#tab-assertions");
  const kept = await page.locator('input[data-path="assertions.final.text.contains.0"]').inputValue();
  if (kept !== "incompleteness_theorems") problems.push(`重载后断言值不对：${kept}`);
  else ok("重载后断言值保持", kept);
  const roleAfter = await page.locator('.raw-row input[data-path="assertions.trajectory.mustUse.0.role"]').inputValue();
  if (roleAfter !== "searchbox") problems.push(`重载后 mustUse.role 丢了：${roleAfter}`);
  else ok("重载后 mustUse.role 仍在", roleAfter);

  // -------------------------------------------------------------- 手工新建
  await page.goto(`${base}/#/case-new-form`);
  await page.waitForSelector('input[data-path="title"]');
  await page.fill('input[data-path="title"]', "手工建的用例");
  await page.fill('textarea[data-path="goal"]', "打开本地夹具页并提交表单");
  await page.fill('input[data-path="startUrl"]', "https://example.test/form");

  // 未保存的用例没有 id：这个按钮必须置灰（旧代码会去请求 /api/cases/null/admit）。
  if (!(await page.getByRole("button", { name: "检测页面" }).isDisabled())) {
    problems.push("新建用例时「检测页面」应该是禁用的");
  } else {
    ok("未保存时「检测页面」置灰");
  }

  await page.locator(".disclosure > summary", { hasText: "更多（引擎与域名白名单）" }).click();
  ok("引擎提示跟着引擎走",
    (await page.locator(".disclosure-body .hint").first().textContent())?.trim().slice(0, 46));

  await page.click("#tab-assertions");
  await page.selectOption(".recipe-add select", "text.contains");
  await page.getByRole("button", { name: "+ 添加断言" }).click();
  await page.fill('input[data-path="assertions.final.text.contains.0"]', "已提交");
  ok("新用例：断言角标更新", `"${await page.locator("#tab-assertions .tab-badge").textContent()}"`);
  await shot("03-editor-new");

  // ------------------------------------------------------ 校验：必填项标红
  await page.click("#tab-basic");
  await page.fill('input[data-path="title"]', "");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.waitForSelector(".field-error");
  ok("校验失败：字段标红并自动切到所属标签",
    `is-invalid=${await page.locator("input.is-invalid").count()} 当前标签="${(await page.locator(".tab.is-active").textContent())?.trim()}"`);
  await shot("04-validation");

  await page.fill('input[data-path="title"]', "手工建的用例");
  await page.getByRole("button", { name: "创建", exact: true }).click();
  await page.waitForFunction(() => location.hash.startsWith("#/case/") && !location.hash.includes("new-form"));
  const manualId = page.url().split("/").pop();
  ok("手工创建成功", `#/case/${manualId}`);

  await page.click("#tab-limits");
  await page.waitForSelector('input[data-path="budget.maxSteps"]');
  ok("预算与护栏档渲染", "maxSteps 在位");
  await page.click("#tab-preview");
  const payload = await page.locator("pre.payload").textContent();
  if (!payload?.includes("assertions")) problems.push("「保存内容」档没有渲染出即将提交的内容");
  else ok("保存内容档渲染", `${payload.length} 字符`);
  await shot("05-payload");

  // ------------------------------------------------------------ 运行历史
  await page.goto(`${base}/#/runs`);
  // 等列表**或**空状态出现：`GET /api/runs` 是异步拉的，直接数行会数到 0
  // （这个脚本自己踩过一次，于是把「有 10 条历史」误报成「一条都没有」）。
  await page.waitForSelector(".list-table, .empty");
  const indexed = await page.locator(".list-table tbody tr").count();
  if (indexed === 0) {
    // 仓库里没有历史运行（全新 clone）时跳过结果页那几步，而不是判失败。
    console.log("SKIP 运行历史为空，跳过结果页走查（跑一次用例再回来）");
  } else {
    ok("运行历史渲染", `行数=${indexed}`);
    await shot("06-runs");

    await page.locator(".list-table tbody tr .row-title").first().click();
    await page.waitForSelector(".verdict-card");
    ok("结果页：判决卡 + 默认落档", `"${(await page.locator(".tab.is-active").textContent())?.trim()}"`);
    ok("断言逐条渲染", `行数=${await page.locator("#panel-assertions tr").count()}`);

    await page.click("#tab-trajectory");
    await page.waitForSelector("#panel-trajectory tbody tr");
    ok("轨迹档渲染", `步数=${await page.locator("#panel-trajectory tbody tr").count()}`);

    await page.click("#tab-events");
    await page.waitForSelector("#panel-events .events");
    ok("事件档：空缓冲说明在位",
      (await page.locator("#panel-events .events-placeholder").textContent())?.trim().slice(0, 24));
    await shot("07-run");
  }

  // -------------------------------------------------------------- 深色模式
  await page.emulateMedia({ colorScheme: "dark" });
  await page.goto(`${base}/#/cases`);
  await page.waitForSelector(".list-table");
  ok("深色模式生效", `data-bs-theme=${await page.locator("html").getAttribute("data-bs-theme")}`);
  await shot("08-cases-dark");
  await page.goto(`${base}/#/case/${manualId}`);
  await page.waitForSelector("#tab-assertions");
  await page.click("#tab-assertions");
  await shot("09-editor-dark");

  // -------------------------------------------------------- 删除手工用例
  await page.goto(`${base}/#/cases`);
  await page.waitForSelector(".list-table tbody tr");
  const before = await page.locator(".list-table tbody tr").count();
  const target = page.locator(".list-table tbody tr", { hasText: "手工建的用例" });
  await target.locator("summary").click();
  await target.getByRole("button", { name: "删除用例" }).click();
  await target.waitFor({ state: "detached" });
  ok("删除用例（行内折叠里的破坏性操作）", `${before} -> ${await page.locator(".list-table tbody tr").count()}`);
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
