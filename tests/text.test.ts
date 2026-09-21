/**
 * 文本取值 helper 的行为锁定：请求构造、响应校验、上下文指纹。
 *
 * 这三件事都在「引擎之外」，因此可以纯粹用字符串驱动测试——不需要浏览器、
 * 不需要模型、不需要网络。它们守的是两条会真出事的性质：
 *
 *   1. **解析必须严**。放宽容错（抠出第一个 `{` 到最后一个 `}`）会让模型学会
 *      用「Thinking: {...}」夹带解释，最终把解析器变成一个宽松的正则——
 *      而它的输出会被真的填进目标站点的表单。
 *   2. **指纹必须准**。指纹错（碰撞或漂移）会让缓存复用为旧页面生成的文本，
 *      表现为「填进去的东西和当前页面无关」，且不报错。
 */

import { createHash } from "node:crypto";
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CONTEXT_CHARS,
  MAX_TEXT_LENGTH,
  buildTextRequest,
  parseTextHelperOutput,
  textContextKey,
} from "../src/engine/text.ts";
import type { RecentActionIR, TextRequest } from "../src/engine/types.ts";

/** 一份可用的最小输入。各用例只覆盖自己关心的那一部分。 */
function baseInput(): {
  goal: string;
  action: { label: string; role: string; value?: string };
  page: { title: string; text: string };
  history: RecentActionIR[];
} {
  return {
    goal: "在 Wikipedia 上打开 Godel 的条目",
    action: { label: "Search", role: "combobox", value: "" },
    page: { title: "Wikipedia", text: "The Free Encyclopedia" },
    history: [
      { action: "CLICK [12] link Wikipedia", kind: "click", text: null, pageChanged: true },
      { action: "TYPE_TEXT [3] textbox Search", kind: "fill", text: "Godel", pageChanged: null },
    ],
  };
}

// ---------------------------------------------------------------------------
// parseTextHelperOutput
// ---------------------------------------------------------------------------

test("parseTextHelperOutput 接受恰好一个 text 键的对象", () => {
  assert.deepEqual(parseTextHelperOutput('{"text": "Ada Lovelace"}'), { text: "Ada Lovelace" });
});

test("parseTextHelperOutput 接受带空白的 JSON（只有首尾空白可容忍）", () => {
  assert.deepEqual(parseTextHelperOutput('  \n\t{"text": "x"}\n  '), { text: "x" });
});

test('{"text": null} 是合法返回值：表示目标里缺少必要信息，而不是错误', () => {
  assert.deepEqual(parseTextHelperOutput('{"text": null}'), { text: null });
});

test("parseTextHelperOutput 拒绝带前言的输出——不抠片段，整串解析", () => {
  // 这是本文件最重要的两条断言之一。上游有对应用例：容错解析会让模型学会
  // 用前言夹带解释，而那种输出意味着模型没有遵守「只返回一个 JSON 对象」。
  for (const raw of [
    'Thinking: {"text": "Ada"}',
    'Here is the value: {"text": "Ada"}',
    '当然可以！{"text": "Ada"}',
    '```json\n{"text": "Ada"}\n```',
    '{"text": "Ada"} 以上。',
    '{"text": "Ada"}\n{"text": "Bob"}',
    'Thinking: ...\n{"text": "Ada"}',
  ]) {
    assert.throws(() => parseTextHelperOutput(raw), `应当拒绝：${raw.replace(/\n/g, "\\n")}`);
  }
});

test("parseTextHelperOutput 拒绝非 JSON 与非对象", () => {
  for (const raw of ["", "   ", "Ada Lovelace", "null", "42", '"Ada"', "[]", '["Ada"]', "true"]) {
    assert.throws(() => parseTextHelperOutput(raw), `应当拒绝：${JSON.stringify(raw)}`);
  }
});

test("parseTextHelperOutput 拒绝多余键与缺 text 键", () => {
  for (const raw of [
    '{"text": "Ada", "confidence": 0.9}',
    '{"value": "Ada"}',
    '{"Text": "Ada"}',
    "{}",
  ]) {
    assert.throws(() => parseTextHelperOutput(raw), `应当拒绝：${raw}`);
  }
});

test("parseTextHelperOutput 的 text 必须是字符串或 null", () => {
  for (const raw of ['{"text": 123}', '{"text": true}', '{"text": {"a": 1}}', '{"text": ["Ada"]}']) {
    assert.throws(() => parseTextHelperOutput(raw), `应当拒绝：${raw}`);
  }
});

test("parseTextHelperOutput 拒绝空串与纯空白：什么都不输入要用 null 表示", () => {
  for (const raw of ['{"text": ""}', '{"text": "   "}', '{"text": "\\n\\t"}']) {
    assert.throws(() => parseTextHelperOutput(raw), `应当拒绝：${raw}`);
  }
});

test("parseTextHelperOutput 拒绝超长值，但接受恰好到上限", () => {
  const atLimit = "a".repeat(MAX_TEXT_LENGTH);
  assert.equal(parseTextHelperOutput(JSON.stringify({ text: atLimit })).text, atLimit);

  const tooLong = "a".repeat(MAX_TEXT_LENGTH + 1);
  assert.throws(() => parseTextHelperOutput(JSON.stringify({ text: tooLong })));
});

test("parseTextHelperOutput 的错误信息里带上响应片段，便于定位", () => {
  // 出错时报告与日志要能看到模型到底回了什么；否则只剩一句「解析失败」。
  assert.throws(() => parseTextHelperOutput("Thinking: 我觉得应该是 Ada"), /Thinking: 我觉得应该是 Ada/);
});

test("parseTextHelperOutput 不把错误信息灌满整页文本", () => {
  // 片段要截断：一页 6000 字符的内容不该原样进报告与日志。
  let message = "";
  try {
    parseTextHelperOutput("x".repeat(5000));
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  assert.ok(message.length < 600, `错误信息过长（${message.length} 字符）`);
});

// ---------------------------------------------------------------------------
// buildTextRequest
// ---------------------------------------------------------------------------

test("buildTextRequest 把字段与页面映射进请求", () => {
  const input = baseInput();
  const req = buildTextRequest(input);

  assert.equal(req.goal, input.goal);
  assert.equal(req.field.label, "Search");
  assert.equal(req.field.role, "combobox");
  assert.equal(req.field.value, "");
  assert.equal(req.page.title, "Wikipedia");
  assert.equal(req.page.text, "The Free Encyclopedia");
  assert.equal(req.recentActions.length, 2);
});

test("buildTextRequest 用空串表示「字段当前没有值」，而不是 undefined", () => {
  // TextRequest.field.value 是必填 string：让「没有值」只有一种表示，
  // 调用方不必区分两种「没有」。
  const input = baseInput();
  delete input.action.value;
  assert.equal(buildTextRequest(input).field.value, "");
});

test("buildTextRequest 把页面文本截断到 MAX_CONTEXT_CHARS", () => {
  const input = baseInput();
  input.page.text = `${"a".repeat(MAX_CONTEXT_CHARS)}b`.repeat(2);
  const req = buildTextRequest(input);

  assert.equal(req.page.text.length, MAX_CONTEXT_CHARS);
  assert.ok(input.page.text.startsWith(req.page.text), "截断应当是前缀，不是改写");
});

test("buildTextRequest 的截断不切碎代理对（半个 emoji 会变成 U+FFFD 噪声）", () => {
  const input = baseInput();
  // 让切点正好落在 emoji 的高代理项上。
  input.page.text = `${"a".repeat(MAX_CONTEXT_CHARS - 1)}😀tail`;
  const req = buildTextRequest(input);

  const last = req.page.text.charCodeAt(req.page.text.length - 1);
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), "结尾不应是孤立的高代理项");
  assert.equal(req.page.text.length, MAX_CONTEXT_CHARS - 1);
});

test("buildTextRequest 复制历史数组：调用方随后改动不应改变这次请求", () => {
  const input = baseInput();
  const req = buildTextRequest(input);
  input.history.push({ action: "WAIT", kind: "wait", text: null, pageChanged: false });

  assert.equal(req.recentActions.length, 2, "请求持有的历史应与调用方解耦（否则指纹会在两次计算间漂移）");
});

// ---------------------------------------------------------------------------
// textContextKey
// ---------------------------------------------------------------------------

/** 一个完整、稳定的请求，供指纹用例做「只改一处」的对照。 */
function baseRequest(): TextRequest {
  return buildTextRequest(baseInput());
}

/**
 * 递归按键排序后重建对象（数组保序）。
 *
 * 这是**测试内的独立实现**：它走的是「重排对象 + JSON.stringify」这条路，
 * 而 `text.ts` 走的是手写序列化器。两条路得出同一个字符串，才说明
 * 「规范化」这件事真的成立，而不是两边各自碰巧自洽。
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
    a < b ? -1 : a > b ? 1 : 0,
  );
  return Object.fromEntries(entries.map(([key, entry]) => [key, sortDeep(entry)]));
}

test("textContextKey 对同一输入稳定（同对象重复计算 + 等价对象）", () => {
  const req = baseRequest();
  assert.equal(textContextKey(req), textContextKey(req));
  assert.equal(textContextKey(req), textContextKey(baseRequest()));
  assert.match(textContextKey(req), /^[0-9a-f]{64}$/);
});

test("textContextKey 忽略对象键的书写顺序（规范化序列化）", () => {
  // 直接 JSON.stringify 会对属性顺序敏感：等价的输入会算出不同指纹，
  // 缓存于是永远不命中。键排序一次解决。
  const a: TextRequest = {
    goal: "g",
    field: { label: "l", role: "r", value: "v" },
    page: { title: "t", text: "x" },
    recentActions: [],
  };
  const b: TextRequest = {
    recentActions: [],
    page: { text: "x", title: "t" },
    field: { value: "v", role: "r", label: "l" },
    goal: "g",
  };
  assert.equal(textContextKey(a), textContextKey(b));
});

test("textContextKey 对任一字段变化都变化", () => {
  const base = baseRequest();
  const variants: [string, TextRequest][] = [
    ["goal", { ...base, goal: `${base.goal}（改）` }],
    ["field.label", { ...base, field: { ...base.field, label: "Query" } }],
    ["field.role", { ...base, field: { ...base.field, role: "textbox" } }],
    ["field.value", { ...base, field: { ...base.field, value: "Godël" } }],
    ["page.title", { ...base, page: { ...base.page, title: "Wikipedia (en)" } }],
    ["page.text", { ...base, page: { ...base.page, text: `${base.page.text} ` } }],
    ["recentActions 长度", { ...base, recentActions: base.recentActions.slice(0, 1) }],
    [
      "recentActions 内容",
      {
        ...base,
        recentActions: [base.recentActions[0]!, { action: "WAIT", kind: "wait", text: null, pageChanged: false }],
      },
    ],
    [
      "recentActions[0].pageChanged",
      { ...base, recentActions: [{ ...base.recentActions[0]!, pageChanged: false }, ...base.recentActions.slice(1)] },
    ],
    [
      "recentActions[0].text",
      { ...base, recentActions: [{ ...base.recentActions[0]!, text: "Godël" }, ...base.recentActions.slice(1)] },
    ],
  ];

  const seen = new Map<string, string>([[textContextKey(base), "base"]]);
  for (const [what, variant] of variants) {
    const key = textContextKey(variant);
    assert.notEqual(key, textContextKey(base), `${what} 变了，指纹却没变——陈旧决策会复用为旧页面生成的文本`);
    assert.equal(seen.get(key), undefined, `${what} 与 ${String(seen.get(key))} 指纹相撞`);
    seen.set(key, what);
  }
});

test("textContextKey 的哈希输入带上格式版本：改口径即让旧指纹整体失效", () => {
  // 用**测试内独立实现**的规范化序列化算一遍 sha256 再比对，而不是复述实现：
  // 键排序、JSON 写法、版本前缀三件事里任何一件被改动，这条都会失败。
  const req = baseRequest();
  const expected = createHash("sha256")
    .update(`jevtest:text-context:v1\n${JSON.stringify(sortDeep(req))}`, "utf8")
    .digest("hex");
  assert.equal(textContextKey(req), expected);
});

test("两个只差 page.text 长度（截断后相同）的输入得到同一指纹", () => {
  // 截断发生在 buildTextRequest 里，因此指纹天然不受被丢弃的尾部影响——
  // 这是应有行为：模型看不到的东西不该影响缓存判定。
  const long = baseInput();
  long.page.text = `${"a".repeat(MAX_CONTEXT_CHARS)}TAIL-ONE`;
  const longer = baseInput();
  longer.page.text = `${"a".repeat(MAX_CONTEXT_CHARS)}TAIL-TWO`;

  assert.equal(textContextKey(buildTextRequest(long)), textContextKey(buildTextRequest(longer)));
});

test("常量与文档一致", () => {
  assert.equal(MAX_TEXT_LENGTH, 2000);
  assert.equal(MAX_CONTEXT_CHARS, 6000);
});
