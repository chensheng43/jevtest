/**
 * YAML 往返幂等。
 *
 * 存在的理由：同一份用例无论从表单保存还是从文件导入，**落盘字节必须完全一致**。
 * 否则 git diff 会充满噪声、`caseDigest` 会漂移、revision 历史随之失去意义——
 * 而「什么时候变过一次」正是报告能回到确切的用例版本的前提（D13）。
 *
 * 本题覆盖「YAML ↔ 对象」这一段；「对象 ↔ 表单草稿」那一段在 tests/frontend.test.ts。
 * 这里锁的是：**同一份对象两次序列化必须逐字节相同**，以及**解析后再序列化不会丢东西**。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { CaseDefinitionSchema } from "../src/schema/case.ts";
import type { CaseDefinition } from "../src/schema/case.ts";
import { caseDigest, parseCase, stringifyCase, toYamlObject } from "../src/schema/yaml.ts";

const CASE_FILE = join(import.meta.dirname, "..", "cases", "wikipedia-godel.yaml");
const REAL_CASE_TEXT = readFileSync(CASE_FILE, "utf8");

/** 把「对象 -> YAML 文本 -> 对象」走一遍。 */
function roundTrip(definition: CaseDefinition): CaseDefinition {
  return parseCase(stringifyCase(definition));
}

/**
 * 找某个键所在行的位置，并断言它排在 `previous` 之后。
 *
 * 用行首锚定的正则而不是 `indexOf("key:")`：后者会匹配到**值**里出现的同名子串
 * （例如 `reason: 不许删除` 里的「删除」），得到一个看起来通过、实际没验证键序的结果。
 * `indent` 让同一套断言也能验证嵌套层的顺序。
 */
function assertKeyOrder(text: string, keys: readonly string[], indent = ""): void {
  let previous = -1;
  for (const key of keys) {
    const match = new RegExp(`^${indent}${key}:`, "m").exec(text);
    assert.ok(match !== null, `找不到键 ${indent}${key}\n${text}`);
    assert.ok(match.index > previous, `${indent}${key} 的位置不对：${match.index} 应在 ${previous} 之后\n${text}`);
    previous = match.index;
  }
}

// ---------------------------------------------------------------------------
// 主断言：YAML -> parseCase -> toYamlObject -> stringify -> parseCase -> 深比较
// ---------------------------------------------------------------------------

test("真实用例往返后深比较相等", () => {
  const first = parseCase(REAL_CASE_TEXT, "cases/wikipedia-godel.yaml");
  const second = roundTrip(first);
  assert.deepEqual(second, first);
});

test("真实用例的 digest 在往返后不变", () => {
  const first = parseCase(REAL_CASE_TEXT, "cases/wikipedia-godel.yaml");
  const second = roundTrip(first);
  // digest 是 sha256(规范化 YAML 字节)。它漂移意味着「用例没改但报告的比较基准变了」，
  // 那会让所有历史报告看起来都出自另一个版本的用例。
  assert.equal(caseDigest(second), caseDigest(first));
  // 反过来也要成立：同一份输入解析两次得到同一个 digest
  assert.equal(caseDigest(parseCase(REAL_CASE_TEXT)), caseDigest(first));
});

test("序列化是幂等的：连续两次 stringify 逐字节相同", () => {
  const first = parseCase(REAL_CASE_TEXT);
  const once = stringifyCase(first);
  const twice = stringifyCase(parseCase(once));
  assert.equal(twice, once);
  // toYamlObject 也要幂等：它固定键序重建对象，重复调用不该改变结果
  assert.deepEqual(toYamlObject(parseCase(once)), toYamlObject(first));
});

// ---------------------------------------------------------------------------
// 键序：digest 的直接决定者
// ---------------------------------------------------------------------------

test("顶层键按 CaseDefinition 的声明顺序排列", () => {
  // 键序不是审美问题：它直接决定 digest，改了顺序等于所有历史报告的比较基准都变了。
  assertKeyOrder(stringifyCase(parseCase(REAL_CASE_TEXT)), [
    "schemaVersion",
    "id",
    "title",
    "goal",
    "startUrl",
    "mode",
    "allowedOrigins",
    "budget",
    "guardrails",
    "allowDefaultOverride",
    "engine",
    "assertions",
  ]);
});

test("嵌套键同样按声明顺序，且 budget/assertions 的顺序固定", () => {
  const text = stringifyCase(parseCase(REAL_CASE_TEXT));
  assertKeyOrder(text, ["maxSteps", "maxModelCalls", "maxInputTokens", "maxCostUsd", "maxElapsedMs"], "  ");
  // assertions 下的固定顺序：final -> trajectory -> quality
  assertKeyOrder(text, ["final", "trajectory", "quality"], "  ");
  // trajectory 内部同样是声明顺序（statusIn 在最前，maxIdenticalConsecutive 在最后）
  assertKeyOrder(
    text,
    ["statusIn", "maxSteps", "mustUse", "mustNotUse", "forbiddenKinds", "maxIdenticalConsecutive"],
    "    ",
  );
  // 数组元素：第一个键跟在本行的 `- ` 后面，其余键再缩进两级。
  // 这个形态也是 digest 的一部分——yaml 库把它渲染成 `- role: x` 而不是
  // 换行写 `-\n  role: x`，两者的字节不同。
  assert.match(text, /^ {6}- role: searchbox$/m);
  assert.match(text, /^ {6}- labelContains: Log in$/m);
});

// ---------------------------------------------------------------------------
// 默认值：序列化后必须仍然解析得回来
// ---------------------------------------------------------------------------

test("最小输入往返后默认值仍然齐全（默认值不会被序列化丢掉）", () => {
  const minimal: CaseDefinition = { title: "最小往返", goal: "打开首页", startUrl: "https://example.com/" };
  const parsed = CaseDefinitionSchema.parse(minimal);
  const again = CaseDefinitionSchema.parse(roundTrip(parsed));

  assert.deepEqual(again, parsed);
  // 这几条是「丢失即静默失效」的：budget 丢了等于没有成本上限
  assert.equal(again.budget.maxModelCalls, 40);
  assert.deepEqual(again.assertions.trajectory?.statusIn, ["done"]);
  assert.equal(again.assertions.trajectory?.maxIdenticalConsecutive, 3);
  assert.equal(again.engine, "typesafe");
});

test("maxCostUsd: null 必须落盘，不能被当成「没写」丢掉", () => {
  const parsed = CaseDefinitionSchema.parse({ title: "上限用例", goal: "g", startUrl: "https://example.com/" });
  const text = stringifyCase(parsed);
  // null = 不设金额上限，与「没写这个字段」是两回事（后者会被默认值补成 null，
  // 但语义上仍是「用户没表态」）。丢了它，YAML 里就再也看不出用户的意图。
  assert.match(text, /maxCostUsd: null/);
  assert.equal(CaseDefinitionSchema.parse(parseCase(text)).budget.maxCostUsd, null);
});

test("undefined 字段不落盘", () => {
  const text = stringifyCase({ title: "不落盘", goal: "g", startUrl: "https://example.com/" });
  assert.ok(!text.includes("undefined"));
  assert.ok(!text.includes("null"));
  // 顶层只写用户给过的键，默认值不落盘——保存到 cases/<id>/case.yaml 时只写显式设置的部分
  assert.ok(!text.includes("mode:"));
  assert.ok(!text.includes("budget:"));
});

// ---------------------------------------------------------------------------
// 复杂形状：每一张嵌套键序表都要走到
// ---------------------------------------------------------------------------

test("填满所有可选段的用例往返后深比较相等", () => {
  const rich: CaseDefinition = {
    schemaVersion: 1,
    id: "rich-case",
    title: "把所有可选段都填上",
    goal: "确认嵌套结构往返不丢字段",
    startUrl: "https://example.com/app?x=1#frag",
    mode: "readonly",
    allowedOrigins: ["https://example.com", "https://cdn.example.com/static/app.js"],
    budget: { maxSteps: 7, maxModelCalls: 9, maxInputTokens: 1234, maxCostUsd: 0.5, maxElapsedMs: 9876 },
    guardrails: [
      { labelContains: "删除", role: "button", reason: "破坏性操作" },
      { labelMatches: "^Pay\\b", reason: "不允许支付" },
    ],
    allowDefaultOverride: true,
    engine: "scripted",
    assertions: {
      final: {
        url: { equals: "https://example.com/done", contains: ["/done"], notContains: ["/error"], matches: ["^https://"] },
        title: { contains: ["完成"] },
        text: { notContains: ["Exception"] },
        controls: [
          { labelContains: "出发地", role: "combobox", valueEquals: "Zürich" },
          { labelContains: "已同意", checked: true, exists: false },
          { labelContains: "金额", valueMatches: "^\\d+\\.\\d{2}$" },
        ],
      },
      trajectory: {
        statusIn: ["done", "budget_exceeded"],
        maxSteps: 5,
        mustUse: [{ labelContains: "搜索", role: "searchbox" }, { kind: "click" }],
        mustNotUse: [{ labelMatches: "Log in" }],
        forbiddenKinds: ["fill", "select"],
        maxIdenticalConsecutive: 4,
      },
      quality: {
        minOperationProbability: 0.5,
        minTargetProbability: 0.3,
        maxModelCalls: 12,
        maxElapsedMs: 60000,
        maxInputTokens: 90000,
        maxCostUsd: 0.25,
      },
    },
  };

  const parsed = CaseDefinitionSchema.parse(rich);
  const again = CaseDefinitionSchema.parse(roundTrip(parsed));
  assert.deepEqual(again, parsed);

  // 逐段点一下，确保不是「两边一样地丢」而通过
  assert.equal(again.allowedOrigins[1], "https://cdn.example.com");
  assert.equal(again.assertions.final?.controls?.length, 3);
  assert.equal(again.assertions.final?.controls?.[1]?.checked, true);
  assert.equal(again.assertions.final?.controls?.[1]?.exists, false);
  assert.deepEqual(again.assertions.trajectory?.forbiddenKinds, ["fill", "select"]);
  assert.deepEqual(again.assertions.trajectory?.mustUse?.[1], { kind: "click" });
  assert.equal(again.assertions.quality?.maxCostUsd, 0.25);
  assert.equal(again.budget.maxCostUsd, 0.5);
  assert.equal(again.allowDefaultOverride, true);
});

test("同一份对象序列化两次逐字节相同（键序与缩进都稳定）", () => {
  const parsed = CaseDefinitionSchema.parse(parseCase(REAL_CASE_TEXT));
  assert.equal(stringifyCase(parsed), stringifyCase(parsed));
  // 长 goal 不折行：lineWidth: 0。折行会随终端宽度变化，diff 立刻变噪声。
  assert.equal(stringifyCase(parsed), stringifyCase(CaseDefinitionSchema.parse(parsed)));
});

test("中文与重音字符往返后不变", () => {
  const parsed = CaseDefinitionSchema.parse({
    title: "Gödel 不完备定理 — 测试用例",
    goal: "打开关于 Gödel's incompleteness theorems 的条目",
    startUrl: "https://example.com/",
  });
  const again = CaseDefinitionSchema.parse(roundTrip(parsed));
  assert.equal(again.title, parsed.title);
  assert.equal(again.goal, parsed.goal);
});
