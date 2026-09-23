/**
 * 前端静态资产的**契约测试**。
 *
 * 这一层没有 DOM 测试环境——项目刻意不引入前端构建工具链（见 `docs/development.md`），
 * 也没有 jsdom/happy-dom。所以这里不验「界面长什么样」，只验**改了会静默坏掉**的
 * 跨文件约定：界面不会报错，只会看起来正常地做错事。
 *
 * 守住三件事：
 *
 *   1. `app.js` 里 `getElementById("x")` 查到的元素，`index.html` 里真的存在。
 *      少了它不报错，只是路由或队列指示器对着 null 赋值，然后在控制台里安静地停摆。
 *   2. `app.js` 发请求用的头名与 `security.ts` 的 `TOKEN_HEADER` 一致。
 *      不一致的表现是**所有写操作 403**，而页面本身看不出任何异常。
 *   3. D9 / D8：`skipped` 不能借用 `passed` 的颜色，`undecided` 不能借用任何一方的颜色。
 *      把「跳过」画成「通过」就是在界面上谎报覆盖——这是全项目最不能出错的一条视觉约定。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { TOKEN_HEADER, resolveVendorPath } from "../src/web/security.ts";
import { CaseDefinitionSchema } from "../src/schema/case.ts";
import { parseCase } from "../src/schema/yaml.ts";
import { loginRedirectHint } from "../src/core/guard.ts";

const PUBLIC_DIR = join(import.meta.dirname, "..", "src", "web", "public");
const read = (name: string) => readFileSync(join(PUBLIC_DIR, name), "utf8");

const HTML = read("index.html");
const JS = read("app.js");
const CSS = read("style.css");

/** 取出某个类名对应规则块的声明体。 */
function ruleBody(selector: string): string {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const body = new RegExp(`${escaped}\\s*\\{([^}]*)\\}`).exec(CSS)?.[1];
  assert.ok(body !== undefined, `style.css 里应该定义 ${selector}`);
  return body;
}

// ---------------------------------------------------------------------------
// DOM 钩子
// ---------------------------------------------------------------------------

test("index.html 提供 app.js 会去查的每一个 id", () => {
  const ids = [...JS.matchAll(/getElementById\("([^"]+)"\)/g)].map((match) => match[1]);
  // 这个下限本身是断言：匹配正则一旦失效，下面循环会空转成「通过」。
  assert.ok(ids.length >= 2, `应该至少查到 #app 与 #queue，实际查到 ${ids.length} 个`);
  for (const id of ids) {
    assert.match(HTML, new RegExp(`id="${id}"`), `app.js 查了 #${id}，但 index.html 里没有`);
  }
});

test("#queue 在 #app 之外，否则会被 route() 抹掉", () => {
  const open = HTML.indexOf('<main id="app">');
  const close = HTML.indexOf("</main>");
  assert.ok(open !== -1 && close > open, 'index.html 里应该有 <main id="app">…</main>');

  const queue = HTML.indexOf('id="queue"');
  assert.ok(queue !== -1, "index.html 里应该有 #queue");
  assert.ok(
    queue < open || queue > close,
    "#queue 落在 #app 内部了——route() 每次导航都 replaceChildren，队列指示器会就此消失",
  );
});

test("令牌 meta 的名字与 app.js 查询的一致，且占位符留给服务端替换", () => {
  assert.match(JS, /querySelector\('meta\[name="jevtest-token"\]'\)/);
  assert.match(HTML, /<meta name="jevtest-token" content="__JEVTEST_TOKEN__"/);
});

test("令牌请求头名与 security.ts 的 TOKEN_HEADER 一致", () => {
  const declared = /const TOKEN_HEADER = "([^"]+)"/.exec(JS)?.[1];
  assert.equal(
    declared,
    TOKEN_HEADER,
    "app.js 与 security.ts 的头名不一致时所有写操作都会 403，而页面看不出异常",
  );
});

test("顶栏当前页高亮的 data-nav 值都被 setActiveNav 认领", () => {
  const keys = [...HTML.matchAll(/data-nav="([^"]+)"/g)].map((match) => match[1]);
  assert.ok(keys.length >= 3, `应该有三个导航项，实际 ${keys.length} 个`);
  const claimed = /function setActiveNav[\s\S]*?\n\}/.exec(JS)?.[0];
  assert.ok(claimed !== undefined, "app.js 里应该有 setActiveNav");
  for (const key of keys) {
    assert.ok(claimed.includes(`"${key}"`), `data-nav="${key}" 没有任何一处路由分支认领它`);
  }
});

// ---------------------------------------------------------------------------
// 依赖：Bootstrap 走 /vendor/，不进打包器
// ---------------------------------------------------------------------------

test("index.html 引用的 /vendor/ 资源都在白名单扩展名之内", () => {
  const refs = [...HTML.matchAll(/(?:href|src)="(\/vendor\/[^"]+)"/g)]
    .map((match) => match[1])
    .filter((ref): ref is string => ref !== undefined);
  assert.ok(
    refs.length > 0,
    "index.html 应该从 /vendor/ 引 Bootstrap——这条断言失败通常意味着样式表整个没了",
  );
  for (const ref of refs) {
    assert.notEqual(
      resolveVendorPath(resolve("C:/tmp/vendor"), ref),
      null,
      `${ref} 不在 VENDOR_EXTENSIONS 白名单里，会被 404 掉：页面能开，但样式静默失效`,
    );
  }
});

// ---------------------------------------------------------------------------
// D9 / D8：三态与未判定的视觉区分
// ---------------------------------------------------------------------------

/** 一个色药丸取自 Bootstrap 的哪个语义色系。 */
function colorFamily(body: string): string | undefined {
  return /var\(--bs-(success|danger|warning|info|primary|secondary)-/.exec(body)?.[1];
}

test("D9：三态取自三个不同的色系", () => {
  const passed = colorFamily(ruleBody(".badge--passed"));
  const failed = colorFamily(ruleBody(".badge--failed"));
  const skipped = colorFamily(ruleBody(".badge--skipped"));

  assert.equal(passed, "success");
  assert.equal(failed, "danger");
  assert.equal(skipped, "warning");
  // 这一条才是 D9 的可执行版本：三者两两不同，谁也别想混进别人的色系。
  assert.equal(
    new Set([passed, failed, skipped]).size,
    3,
    "passed / failed / skipped 必须来自三个不同的色系",
  );
});

test("D9：「跳过」必须比另两态更轻，且不能长得像「通过」", () => {
  const skipped = ruleBody(".badge--skipped");
  assert.ok(!/--bs-success-/.test(skipped), "「跳过」用了「通过」的绿色——这是在界面上谎报覆盖");
  // 接受 `border-style: dashed` 与 `border: 1px dashed …` 两种写法。
  assert.match(skipped, /border[^;]*dashed/, "「跳过」该用虚框，别长得像实心的通过");
  assert.ok(/font-size/.test(skipped), "「跳过」该比另两态小一号，视觉上不去抢注意力");
});

test("D8：「未判定」不借用任何一方的色系", () => {
  const body = ruleBody(".badge--undecided");
  assert.ok(
    !/--bs-(success|danger|warning)-/.test(body),
    "「未判定」借用了三态之一的颜色：琥珀会被读成「跳过」，红会被读成「失败」，都是把没发生的结论画在界面上",
  );
  assert.match(body, /--bs-secondary-|--bs-border-color/, "「未判定」该走中性灰");
});

test("D8：结果卡色条与药丸用同一套档位（null 不能落回 skipped）", () => {
  const body = /function verdictClass\(status, passed\)\s*\{([\s\S]*?)\n\}/.exec(JS)?.[1];
  assert.ok(body !== undefined, "app.js 里应该有 verdictClass");
  assert.ok(
    !/"skipped"/.test(body),
    "verdictClass 又返回 skipped 了：passed === null 的卡片会变成琥珀色色条，而药丸写着中性灰的「未判定」——自相矛盾",
  );
  assert.match(body, /"undecided"/, "passed === null 必须走 undecided");
  assert.match(CSS, /\.verdict-card\.undecided\s*\{/, "style.css 里要有对应的色条规则，否则档位落不到样式上");
});

// ---------------------------------------------------------------------------
// 界面重排之后新增的跨文件约定
// ---------------------------------------------------------------------------

test("前端只引 Bootstrap 的 CSS，不引它的 JS（D18 的信任边界）", () => {
  const scripts = [...HTML.matchAll(/(?:href|src)="(\/vendor\/[^"]+\.js)"/g)].map((match) => match[1] ?? "");
  assert.deepEqual(
    scripts,
    [],
    `index.html 引了 ${scripts.join("、")}：D18 说引入 Bootstrap 的 JS 组件要把 /vendor 从`
      + "「读静态文件」变成「运行第三方脚本」，那是一次需要重新权衡的决定，不该顺手做掉。",
  );
});

test("app.js 里没有 innerHTML 赋值（el() 的运行时报错之外再加一道静态的）", () => {
  assert.ok(!/\.innerHTML\s*=/.test(JS), "有地方在直接拼 HTML：动态文本一律走 textContent");
  assert.ok(!/\.outerHTML\s*=/.test(JS), "同上");
});

// ---------------------------------------------------------------------------
// 编辑器：把用例读进来再写出去，不该改变它的意思
// ---------------------------------------------------------------------------

/** 抠出来的那两段纯函数区的形状（由 app.js 里的 `#region 纯函数` 哨兵标出）。 */
interface EditorCore {
  formToDefinition: (draft: Record<string, unknown>) => Record<string, unknown>;
  normalizeDraft: (def: unknown) => Record<string, unknown>;
  assertionRows: (draft: Record<string, unknown>) => { recipe: { kind: string }; path: string; value: unknown }[];
  draftSummary: (draft: Record<string, unknown>) => { assertions: number; limits: number };
  suggestAuthName: (url: string) => string;
}

/**
 * 在干净的作用域里执行 app.js 的纯函数区。
 *
 * 前端没有 DOM 测试环境——本项目刻意不引 jsdom（见 `docs/development.md`）。
 * 但「载入一个用例、界面重画一遍、再保存」这条路上最不能靠肉眼保证的一件事是
 * **有没有东西被丢掉**：丢了不报错，只是断言少了几条。所以这里用最朴素的办法
 * 把它跑起来：那两段代码不碰 DOM，可以作为一段自包含的脚本求值。
 */
function editorCore(source: string): EditorCore {
  const blocks = [...source.matchAll(/\/\/ #region 纯函数[^\n]*\n([\s\S]*?)\/\/ #endregion/g)]
    .map((match) => match[1] ?? "");
  assert.ok(blocks.length >= 2, `app.js 里应该有两段标了「#region 纯函数」的代码，实际 ${blocks.length} 段`);
  const factory = new Function(`${blocks.join("\n")}
    return { formToDefinition, normalizeDraft, assertionRows, draftSummary, suggestAuthName };`);
  return factory() as EditorCore;
}

const SEED_CASE = parseCase(
  readFileSync(join(import.meta.dirname, "..", "cases", "wikipedia-godel.yaml"), "utf8"),
  "wikipedia-godel.yaml",
);

test("纯函数区真的能被抠出来跑（不是靠肉眼读代码）", () => {
  const core = editorCore(JS);
  assert.equal(typeof core.formToDefinition, "function");
  assert.ok(core.assertionRows(core.normalizeDraft(SEED_CASE)).length > 0, "种子用例应该能摊出断言行来");
});

test("种子用例：载入编辑器再保存，语义一字不变", () => {
  const core = editorCore(JS);
  const saved = core.formToDefinition(core.normalizeDraft(SEED_CASE));
  assert.deepEqual(
    CaseDefinitionSchema.parse(saved),
    CaseDefinitionSchema.parse(SEED_CASE),
    "载入再保存改变了用例的语义——界面不会报错，但断言会少掉或条件被改写",
  );
});

test("全覆盖：每一个配方与每一处原始字段都落得下去", () => {
  const core = editorCore(JS);
  const def = CaseDefinitionSchema.parse({
    title: "全覆盖",
    goal: "把所有字段都设一遍",
    startUrl: "https://example.test/",
    allowedOrigins: ["https://example.test"],
    authState: "example-admin",
    mode: "readonly",
    budget: { maxSteps: 10, maxModelCalls: 11, maxInputTokens: 12, maxCostUsd: 0.5, maxElapsedMs: 13 },
    guardrails: [{ labelContains: "删除", role: "button", reason: "别删东西" }],
    allowDefaultOverride: true,
    assertions: {
      final: {
        // 配方覆盖：contains / notContains。原始字段：equals / matches。
        url: { equals: "https://example.test/x", contains: ["/x"], notContains: ["/y"], matches: ["^https://"] },
        title: { equals: "T", contains: ["t"], notContains: ["z"], matches: ["^T"] },
        text: { equals: "e", contains: ["c"], notContains: ["n"], matches: ["^c"] },
        controls: [
          { labelContains: "提交", exists: true },
          { labelContains: "取消", exists: false },
          // 这一条含配方表达不了的字段（role / valueEquals / checked），整行走原始编辑器。
          { labelContains: "邮箱", role: "textbox", valueEquals: "a@b.c", checked: true },
        ],
      },
      trajectory: {
        statusIn: ["done", "blocked"],
        maxSteps: 7,
        mustUse: [{ labelContains: "搜索" }, { role: "searchbox" }],
        mustNotUse: [{ labelContains: "登录" }, { kind: "select" }],
        forbiddenKinds: ["fill", "select"],
        maxIdenticalConsecutive: 4,
      },
      quality: {
        minOperationProbability: 0.3,
        minTargetProbability: 0.4,
        maxModelCalls: 8,
        maxElapsedMs: 9,
        maxInputTokens: 10,
        maxCostUsd: 0.1,
      },
    },
  });
  const saved = core.formToDefinition(core.normalizeDraft(def));
  assert.deepEqual(
    CaseDefinitionSchema.parse(saved),
    CaseDefinitionSchema.parse(def),
    "有字段在界面上画得出来、保存时却被丢掉（或者顺序被打乱）",
  );
});

test("登录态名字建议：取主机名第一段并规整成合法名字；推不出来给空串", () => {
  const core = editorCore(JS);
  assert.equal(core.suggestAuthName("https://shop_test9.example.com/products"), "shop-test9");
  assert.equal(core.suggestAuthName("https://www.example.com/"), "example");
  assert.equal(core.suggestAuthName("not a url"), "");
  assert.equal(core.suggestAuthName("https://a.com/"), "");
  assert.equal(core.suggestAuthName("http://127.0.0.1:8080/"), "");
});

test("空的 statusIn 必须原样活着——它不是「没设」，而是「任何结束方式都不接受」", () => {
  const core = editorCore(JS);
  const def = CaseDefinitionSchema.parse({
    title: "空 statusIn",
    goal: "g",
    startUrl: "https://example.test/",
    assertions: { trajectory: { statusIn: [] } },
  });
  const saved = core.formToDefinition(core.normalizeDraft(def));
  assert.deepEqual(
    saved.assertions,
    { trajectory: { statusIn: [], maxIdenticalConsecutive: 3 } },
    "空 statusIn 被丢掉了：断言会退回默认的 done，一条必然失败的检查就这样变成了会通过的条件",
  );
});

test("结果页从失败原因里读「这次运行带的登录态」：正则必须与 guard.ts 写出的文案对得上", () => {
  // 两边各改各的不会报错，只会让「登录态过期了」被说成「用例没选登录态」——引导完全反了
  const pattern = /\/用例已带登录态 \(\[a-z0-9\]\[a-z0-9-\]\*\)\//;
  assert.match(JS, pattern, "app.js 里读登录态名字的正则变了，同步改这条测试与 guard.ts 的文案");
  const read = /用例已带登录态 ([a-z0-9][a-z0-9-]*)/.exec(loginRedirectHint("shop-test9"));
  assert.equal(read?.[1], "shop-test9");
  assert.equal(/用例已带登录态 ([a-z0-9][a-z0-9-]*)/.exec(loginRedirectHint(undefined)), null);
});
