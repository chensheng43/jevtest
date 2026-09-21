/**
 * 安全护栏的单元测试：域名白名单、禁止动作清单、只读轨迹核对。
 *
 * 护栏的失效不会报错——它会**安静地放行**。所以每条判据都要有一条**反向**用例
 * （该拦的确实拦住了），而不只是正向用例（正常的确实放行了）。
 *
 * 范围说明：本文件测的是**判据本身**（纯函数，手写 `Action` 字面量，不开浏览器）。
 * 「护栏命中时 `session.act` 调用次数为 0 / `StepRecord.executed === false` /
 * status 为 `guardrail_blocked`」是循环层面的后果，属于 runner/agent 的测试
 * （需要 FakeSession 与 scripted 引擎），不在这里重复。本文件覆盖的是那三者的**前提**：
 * checkAction 在浏览器收到任何输入之前就给出了拦截原因。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { CaseDefinitionSchema } from "../src/schema/case.ts";
import type { Case } from "../src/schema/case.ts";
import type { Action } from "../src/browser/session.ts";
import {
  DEFAULT_DENY_LABELS,
  DEFAULT_DENY_ROLES,
  assertActionAllowed,
  assertAllowedOrigin,
  auditTrajectory,
  checkAction,
  effectiveDenyList,
} from "../src/core/guard.ts";
import { GuardrailBlocked } from "../src/core/errors.ts";

function mkCase(overrides: Partial<Case> = {}): Case {
  return CaseDefinitionSchema.parse({
    title: "测试用例",
    goal: "把这件事做完",
    startUrl: "https://example.com/",
    ...overrides,
  });
}

/** 一个动作。只有 label / role / kind / value 参与护栏判据。 */
function action(overrides: Partial<Action> = {}): Action {
  return { id: "e1", kind: "click", label: "提交", role: "button", node: 1, ...overrides };
}

// ---------------------------------------------------------------------------
// 域名白名单
// ---------------------------------------------------------------------------

test("站内跳转通过：比对的是 origin，路径与查询串不参与", () => {
  const caseDef = mkCase();
  assert.doesNotThrow(() => assertAllowedOrigin(caseDef, "https://example.com/"));
  assert.doesNotThrow(() => assertAllowedOrigin(caseDef, "https://example.com/wiki/Main_Page?q=1#x"));
});

test("跨站拒绝：协议、主机、端口任一不同都算越界", () => {
  const caseDef = mkCase({ allowedOrigins: ["https://example.com"] });
  const crossed = [
    "https://evil.test/",          // 完全不同的站点
    "https://example.com:8443/",   // 同主机不同端口
    "http://example.com/",         // 同主机不同协议（降级到明文）
    "https://sub.example.com/",    // 子域
    "https://example.com.evil.test/", // 后缀伪装：看起来像 example.com，实际是 evil.test 的子域
  ];
  for (const url of crossed) {
    assert.throws(
      () => assertAllowedOrigin(caseDef, url),
      (error: unknown) => {
        assert.ok(error instanceof GuardrailBlocked, `${url} 应抛 GuardrailBlocked`);
        // 消息里必须同时有实际 origin 与白名单：只说「越界了」没法排查
        // （是站点跳了，还是白名单少写了一条？处置完全不同）。
        assert.ok(error.message.includes(new URL(url).origin), `消息缺实际 origin：${error.message}`);
        assert.ok(error.message.includes("https://example.com"), `消息缺白名单：${error.message}`);
        return true;
      },
    );
  }
});

test("白名单里写整条 URL 也接受（归一化成 origin）", () => {
  const caseDef = mkCase({ allowedOrigins: ["https://example.com/wiki/Main_Page"] });
  assert.equal(caseDef.allowedOrigins[0], "https://example.com");
  assert.doesNotThrow(() => assertAllowedOrigin(caseDef, "https://example.com/other"));
});

test("多站点白名单：每个 origin 都放行，白名单外仍拒绝", () => {
  const caseDef = mkCase({ allowedOrigins: ["https://example.com", "https://docs.example.com"] });
  assert.doesNotThrow(() => assertAllowedOrigin(caseDef, "https://docs.example.com/a"));
  assert.throws(() => assertAllowedOrigin(caseDef, "https://other.test/"), GuardrailBlocked);
});

test("解析不出 origin 的 URL 一律按越界处理（fail-closed）", () => {
  const caseDef = mkCase();
  // 关键失败模式：`new URL("file:///x").origin` 是字符串 "null"，
  // 若把它当 origin 参与比对，所有非 http 站点会互相匹配，白名单直接失效。
  for (const url of ["", "not a url", "about:blank", "javascript:alert(1)", "file:///etc/passwd", "data:text/html,x"]) {
    assert.throws(
      () => assertAllowedOrigin(caseDef, url),
      (error: unknown) => {
        assert.ok(error instanceof GuardrailBlocked, `${JSON.stringify(url)} 应抛 GuardrailBlocked`);
        assert.match(error.message, /解析不出|实际 origin/);
        return true;
      },
    );
  }
});

// ---------------------------------------------------------------------------
// 禁止动作清单
// ---------------------------------------------------------------------------

test("内置禁止词：不区分大小写的子串匹配", () => {
  const caseDef = mkCase();
  for (const label of ["Delete account", "DELETE ALL", "删除账号", "立即支付", "Buy now"]) {
    const reason = checkAction(caseDef, action({ label }));
    assert.ok(reason !== null, `「${label}」应被内置禁止词拦下`);
    assert.match(reason, /命中内置禁止词/);
  }
});

test("普通动作放行：页面级动作与常见按钮不误伤", () => {
  const caseDef = mkCase();
  for (const candidate of [
    action({ label: "提交" }),
    action({ label: "Search", role: "searchbox" }),
    action({ kind: "scroll", label: "Scroll down", id: "scroll_down", delta: 560, role: undefined }),
    action({ kind: "wait", label: "Wait for the page to update", id: "wait", role: undefined }),
    action({ kind: "fill", label: "出发地", role: "textbox", value: "" }),
  ]) {
    assert.equal(checkAction(caseDef, candidate), null, `「${candidate.label}」不该被拦下`);
  }
});

test("敏感输入按角色拦：password 与 file", () => {
  const caseDef = mkCase();
  const password = checkAction(caseDef, action({ kind: "fill", label: "Password", role: "password" }));
  assert.ok(password !== null);
  assert.match(password, /内置禁止角色/);

  // 大小写不敏感。
  assert.ok(checkAction(caseDef, action({ kind: "fill", label: "PIN", role: "PASSWORD" })) !== null);

  // 文件上传：snapshot 不会把 input[type=file] 放进元素表，但**自定义上传控件**会进；
  // 点开原生文件对话框会让运行挂到超时（docs/limitations.md §4）。
  const file = checkAction(caseDef, action({ kind: "click", label: "Upload resume", role: "file" }));
  assert.ok(file !== null);

  // 反例：同样叫 Upload 的按钮但角色是普通 button——仍然命中内置禁止词「upload」。
  assert.ok(checkAction(caseDef, action({ kind: "click", label: "Upload resume", role: "button" })) !== null);
});

test("select 的两部分都要查：禁止词落在选项半边也要拦", () => {
  const caseDef = mkCase();
  const optionHalf: Action = {
    id: "e3",
    kind: "select",
    label: "国家 → 删除账号",
    role: "combobox",
    node: 3,
    value: "delete_account",
  };
  const reason = checkAction(caseDef, optionHalf);
  assert.ok(reason !== null, "禁止词在选项半边时必须拦下");
  // 报告要能说清是哪一边命中的——「国家 → 删除账号」与「删除 → 中国」是两种不同的站点。
  assert.match(reason, /选项名/);

  const fieldHalf: Action = { ...optionHalf, label: "删除 → 中国", value: "CN" };
  const fieldReason = checkAction(caseDef, fieldHalf);
  assert.ok(fieldReason !== null);
  assert.match(fieldReason, /字段名/);

  // 反例：正常的下拉放行。
  assert.equal(checkAction(caseDef, { ...optionHalf, label: "国家 → 中国", value: "CN" }), null);
});

test("select 的选项值也查：本地化文案里看不出破坏性动作时靠它兜底", () => {
  const caseDef = mkCase();
  // `<option value="purchase">Kaufen</option>`：label 不含任何内置英文词，
  // 只看 label 会让整个非英文站点的破坏性动作漏过去。value 只在本层被读，不进请求。
  const german = checkAction(caseDef, {
    id: "e3",
    kind: "select",
    label: "Zahlungsart → Kaufen",
    role: "combobox",
    node: 3,
    value: "purchase",
  });
  assert.ok(german !== null);
  assert.match(german, /选项值/);
});

test("用例护栏：追加在内置集之上，命中时带上 reason", () => {
  const caseDef = mkCase({
    guardrails: [{ labelContains: "Create account", reason: "测试不允许创建账号" }],
  });
  const reason = checkAction(caseDef, action({ label: "Create Account now" }));
  assert.ok(reason !== null);
  assert.match(reason, /命中用例护栏：测试不允许创建账号/);

  // 追加不是替换：内置词照样生效。
  assert.ok(checkAction(caseDef, action({ label: "Delete account" })) !== null);
  // 用例没写的正常动作照旧放行。
  assert.equal(checkAction(caseDef, action({ label: "登录" })), null);
});

test("用例护栏的 labelMatches 正则可编译时命中", () => {
  // 特意挑一个不含任何内置禁止词的 label：「Purge draft」不会被内置清单命中，
  // 于是这条用例测的确实是**用例护栏**这条判据，而不是被内置词顺手拦下。
  const caseDef = mkCase({ guardrails: [{ labelMatches: "^Purge\\b", reason: "清空类动作一律禁止" }] });
  const reason = checkAction(caseDef, action({ label: "Purge draft" }));
  assert.ok(reason !== null);
  assert.match(reason, /命中用例护栏：清空类动作一律禁止/);
  assert.match(reason, /匹配 \/\^Purge/);
  assert.equal(checkAction(caseDef, action({ label: "Repurge" })), null);
});

test("用例护栏里的 label 与 role 是 AND：role 用来消歧，不是放宽", () => {
  const caseDef = mkCase({ guardrails: [{ labelContains: "Save", role: "button", reason: "不许保存" }] });
  // 同名按钮拦下。
  assert.ok(checkAction(caseDef, action({ label: "Save", role: "button" })) !== null);
  // 同名链接不拦（role 条件的意义就在这里；取 OR 的话这里的链接会被误伤）。
  assert.equal(checkAction(caseDef, action({ label: "Save", role: "link" })), null);
  // 别的按钮不拦。
  assert.equal(checkAction(caseDef, action({ label: "Cancel", role: "button" })), null);
});

test("护栏正则写坏了按命中处理（fail-closed）：静默失效比误拦危险", () => {
  // 坏正则**过不了 schema**（`case.ts` 的 regexPattern 在保存时就校验可编译性），
  // 所以这里手工构造一个——那正是这道判据要覆盖的残余路径：手工拼的 Case、
  // 或回读一份旧版本的用例。此时这条护栏已经拦不住任何东西了，
  // 正是 D14 说的「安全网被悄悄关掉」，因此宁可拦下并报「正则写坏了」。
  const caseDef: Case = { ...mkCase(), guardrails: [{ labelMatches: "([", reason: "坏正则" }] };
  assert.throws(() => CaseDefinitionSchema.parse({ ...caseDef, guardrails: caseDef.guardrails }), "schema 必须拒绝坏正则");

  const reason = checkAction(caseDef, action({ label: "任意动作" }));
  assert.ok(reason !== null);
  assert.match(reason, /正则无法编译/);
});

test("空条件的护栏不匹配一切（与 ActionMatch 的口径一致）", () => {
  const caseDef = mkCase({ guardrails: [{ role: "button", reason: "只按角色" }] });
  // 角色命中即拦。
  assert.ok(checkAction(caseDef, action({ label: "任意按钮", role: "button" })) !== null);
  // 其它角色不拦——空 label 条件不等于「匹配一切」。
  assert.equal(checkAction(caseDef, action({ label: "任意链接", role: "link" })), null);
});

// ---------------------------------------------------------------------------
// effectiveDenyList 与 allowDefaultOverride
// ---------------------------------------------------------------------------

test("effectiveDenyList：内置项 + 用例追加项，overridden 为 false", () => {
  const caseDef = mkCase({ guardrails: [{ labelContains: "Create account", role: "link", reason: "x" }] });
  const list = effectiveDenyList(caseDef);

  assert.equal(list.overridden, false);
  assert.ok(list.labels.includes("delete"), "内置禁止词必须在清单里");
  assert.ok(list.labels.includes("Create account"), "用例追加的词必须在清单里");
  assert.ok(list.roles.includes("password"), "内置禁止角色必须在清单里");
  assert.ok(list.roles.includes("link"), "用例追加的角色必须在清单里");
});

test("effectiveDenyList 返回的是副本：调用方改不动内置清单", () => {
  const before = [...DEFAULT_DENY_LABELS];
  const list = effectiveDenyList(mkCase());
  list.labels.push("污染");
  list.roles.length = 0;

  // 返回同一个数组的话，任何调用方（报告、Web 界面）都能顺手清空内置护栏——
  // 「悄悄关掉安全网」就成了一个 push 的距离。
  assert.deepEqual([...DEFAULT_DENY_LABELS], before);
  assert.equal(DEFAULT_DENY_LABELS.includes("污染"), false);
  assert.ok(DEFAULT_DENY_ROLES.length > 0);
});

test("allowDefaultOverride: true 时内置护栏不生效，且 overridden 为 true（红色横幅信号）", () => {
  const caseDef = mkCase({
    allowDefaultOverride: true,
    guardrails: [{ labelContains: "Create account", reason: "只保留这一条" }],
  });
  const list = effectiveDenyList(caseDef);

  // 报告顶部要打红色横幅：平台不阻止人关掉安全网，但要求留痕（D14）。
  assert.equal(list.overridden, true);
  assert.equal(list.labels.includes("delete"), false, "内置词必须已退出");
  assert.deepEqual(list.labels, ["Create account"]);

  // 内置项不再生效……
  assert.equal(checkAction(caseDef, action({ label: "Delete account" })), null);
  // ……但用例自己声明的护栏照样生效：关掉默认护栏不等于关掉用户写的规则。
  assert.ok(checkAction(caseDef, action({ label: "Create account now" })) !== null);
});

test("assertActionAllowed：允许时不动，命中时抛 GuardrailBlocked 且消息自带上下文", () => {
  const caseDef = mkCase({ guardrails: [{ labelContains: "Create account", reason: "测试不允许创建账号" }] });
  assert.doesNotThrow(() => assertActionAllowed(caseDef, action({ label: "登录" })));

  assert.throws(
    () => assertActionAllowed(caseDef, action({ label: "Create account" })),
    (error: unknown) => {
      assert.ok(error instanceof GuardrailBlocked);
      // 异常可能被上层单独捕获，那时上下文只剩这条消息：动作、原因、以及
      // 「浏览器没收到输入」这个关键事实（它决定 status 是 guardrail_blocked 而不是 error）。
      assert.ok(error.message.includes("Create account"));
      assert.ok(error.message.includes("测试不允许创建账号"));
      assert.match(error.message, /浏览器未收到任何输入/);
      return true;
    },
  );
});

// ---------------------------------------------------------------------------
// 只读轨迹事后核对
// ---------------------------------------------------------------------------

test("只读用例的轨迹里出现 fill / select 即报告问题", () => {
  const caseDef = mkCase({ mode: "readonly" });
  const reason = auditTrajectory(caseDef, ["click", "fill", "click"]);
  assert.ok(reason !== null);
  assert.match(reason, /fill/);
  assert.match(reason, /只读/);

  assert.ok(auditTrajectory(caseDef, ["scroll", "wait", "click", "select"]) !== null);
});

test("只读用例的合法轨迹通过", () => {
  const caseDef = mkCase({ mode: "readonly" });
  assert.equal(auditTrajectory(caseDef, []), null);
  assert.equal(auditTrajectory(caseDef, ["click", "scroll", "wait", "click"]), null);
});

test("交互式用例不适用这项核对：轨迹里有 fill 不是问题", () => {
  // 「不许出现某类动作」的诉求由用例的 assertions.trajectory.forbiddenKinds 表达，
  // 归 checks.ts 求值——两处都报会在报告里出现两条结论。
  assert.equal(auditTrajectory(mkCase(), ["fill", "select"]), null);
});

test("同一种越界动作只报一次", () => {
  const reason = auditTrajectory(mkCase({ mode: "readonly" }), ["fill", "fill", "fill"]);
  assert.ok(reason !== null);
  assert.equal(reason.split("fill").length - 1, 1);
});
