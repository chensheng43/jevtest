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
