/**
 * YAML 规范化：对象 ↔ YAML 文本 ↔ digest。
 *
 * 存在的理由只有一个：**保证「表单 ↔ YAML」往返幂等**。
 * 同一份用例，无论从表单保存还是从文件导入，落盘字节必须完全一致，
 * 否则 git diff 会充满噪声、digest 会漂移、revision 历史失去意义。
 *
 * 做法是固定键序重建普通对象再序列化，而不是直接 dump 原对象。
 */

import { createHash } from "node:crypto";

import { YAMLParseError, parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ZodError } from "zod";

import { CaseDefinitionSchema } from "./case.ts";
import type { Case, CaseDefinition } from "./case.ts";

/** 序列化选项：`lineWidth: 0` 关闭自动折行，避免长 goal 在不同宽度下 diff 不同。 */
export interface YamlOptions {
  lineWidth: 0;
}

const YAML_OPTIONS: YamlOptions = { lineWidth: 0 };

// ---------------------------------------------------------------------------
// 固定键序重建
// ---------------------------------------------------------------------------

/**
 * 键序表。**必须与 `case.ts` 里各 interface 的声明顺序逐字一致**——
 * 顺序变了 diff 就会变，也就等于 digest 变了。
 */
const CASE_KEYS = [
  "schemaVersion",
  "id",
  "title",
  "goal",
  "startUrl",
  "mode",
  "allowedOrigins",
  "authState",
  "budget",
  "guardrails",
  "allowDefaultOverride",
  "engine",
  "assertions",
] as const;
const BUDGET_KEYS = ["maxSteps", "maxModelCalls", "maxInputTokens", "maxCostUsd", "maxElapsedMs"] as const;
const GUARDRAIL_KEYS = ["labelContains", "labelMatches", "role", "reason"] as const;
const ASSERTIONS_KEYS = ["final", "trajectory", "quality"] as const;
const FINAL_KEYS = ["url", "title", "text", "controls"] as const;
const TEXT_MATCH_KEYS = ["equals", "contains", "notContains", "matches"] as const;
const CONTROL_KEYS = [
  "labelContains",
  "role",
  "exists",
  "valueEquals",
  "valueContains",
  "valueMatches",
  "checked",
] as const;
const TRAJECTORY_KEYS = [
  "statusIn",
  "maxSteps",
  "mustUse",
  "mustNotUse",
  "forbiddenKinds",
  "maxIdenticalConsecutive",
] as const;
const ACTION_MATCH_KEYS = ["labelContains", "labelMatches", "role", "kind"] as const;
const QUALITY_KEYS = [
  "minOperationProbability",
  "minTargetProbability",
  "maxModelCalls",
  "maxElapsedMs",
  "maxInputTokens",
  "maxCostUsd",
] as const;

type Nested = Record<string, (value: unknown) => unknown>;

/**
 * 按 `keys` 的顺序重建一个普通对象。
 *
 * - 丢弃 `undefined`：YAML 里不写这个键。
 * - 保留 `null`：`maxCostUsd: null` 是「不设金额上限」，与「没写这个字段」是两回事，
 *   不能一起丢掉。
 * - 全空时返回 `undefined`：`assertions: {}` 与没写 `assertions` 必须是同一份文档，
 *   否则同一份用例会有两种字节、两个 digest。由调用方决定是跳过这个键还是报错。
 */
function rebuild(source: unknown, keys: readonly string[], nested: Nested = {}): Record<string, unknown> | undefined {
  // 收 `unknown` 而不是 `object | null | undefined`：调用方几乎都从 `unknown` 的
  // 嵌套字段里取值（见 rebuildAssertions 的回调），收窄会逼每一处都写断言。
  // 真正的形状检查是下面这行——非对象、null、undefined 一律视作「没写」。
  if (source === null || source === undefined) return undefined;

  const record = source as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    const raw = record[key];
    if (raw === undefined) continue;

    const transform = nested[key];
    const value = transform === undefined ? raw : transform(raw);
    if (value === undefined) continue;
    out[key] = value;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

/** 数组元素逐个重建。元素本身缺失时留一个空对象，避免 `- ` 这样的空条目落盘。 */
function rebuildEach(value: unknown, keys: readonly string[], nested: Nested = {}): Record<string, unknown>[] {
  return (value as object[]).map((item) => rebuild(item, keys, nested) ?? {});
}

function rebuildAssertions(value: unknown): Record<string, unknown> | undefined {
  return rebuild(value, ASSERTIONS_KEYS, {
    final: (final) =>
      rebuild(final, FINAL_KEYS, {
        url: (match) => rebuild(match, TEXT_MATCH_KEYS),
        title: (match) => rebuild(match, TEXT_MATCH_KEYS),
        text: (match) => rebuild(match, TEXT_MATCH_KEYS),
        controls: (controls) => rebuildEach(controls, CONTROL_KEYS),
      }),
    trajectory: (trajectory) =>
      rebuild(trajectory, TRAJECTORY_KEYS, {
        mustUse: (matches) => rebuildEach(matches, ACTION_MATCH_KEYS),
        mustNotUse: (matches) => rebuildEach(matches, ACTION_MATCH_KEYS),
      }),
    quality: (quality) => rebuild(quality, QUALITY_KEYS),
  });
}

function rebuildCase(value: unknown): Record<string, unknown> | undefined {
  return rebuild(value, CASE_KEYS, {
    budget: (budget) => rebuild(budget, BUDGET_KEYS),
    guardrails: (guardrails) => rebuildEach(guardrails, GUARDRAIL_KEYS),
    assertions: rebuildAssertions,
  });
}

// ---------------------------------------------------------------------------
// 错误信息
// ---------------------------------------------------------------------------

/** zod 的 issue 路径 -> `assertions.final.controls[2].valueEquals`。 */
function formatIssuePath(path: readonly PropertyKey[]): string {
  let text = "";
  for (const segment of path) {
    if (typeof segment === "number") {
      text += `[${segment}]`;
    } else if (text === "") {
      text = String(segment);
    } else {
      // `String(segment)` 不能省：zod 的路径段类型是 `PropertyKey`，含 symbol，
      // 而模板字面量遇到 symbol 会在运行时抛 TypeError——报错路径本身把报错搞崩了。
      text += `.${String(segment)}`;
    }
  }
  return text === "" ? "<根对象>" : text;
}

/**
 * 把 zod 的 issue 逐条摊开。
 *
 * 每行都带字段路径：`docs/api.md §1.2` 要求把 issue 路径原样回传给前端高亮表单字段，
 * 而人看 YAML 报错时也一样需要知道是哪个字段，不是「校验失败」四个字。
 */
function formatIssues(error: ZodError): string {
  return error.issues.map((issue) => `  - ${formatIssuePath(issue.path)}: ${issue.message}`).join("\n");
}

function describeYamlError(error: unknown): string {
  if (error instanceof YAMLParseError) {
    // yaml 的位置是 0 基索引，报给人看要 +1 才对得上编辑器。
    const position = error.linePos?.[0];
    const where = position === undefined ? "" : `第 ${position.line + 1} 行第 ${position.col + 1} 列：`;
    return `${where}${error.message}`;
  }
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/**
 * 把用例对象按固定键序重建为普通对象。
 *
 * 键序与 `CaseDefinition` 的声明顺序一致，嵌套对象同样处理。
 * 这一步会丢弃 `undefined` 字段（YAML 里不写），但**保留已填充的默认值**——
 * 默认值是否落盘由调用方决定：保存到 `cases/<id>/case.yaml` 时只写用户显式设置的部分，
 * 冻结到 `runs/<runId>/case.yaml` 时写完整的 `Case`。
 */
export function toYamlObject(value: Case | CaseDefinition): Record<string, unknown> {
  // 顶层永远非空：title / goal / startUrl 是必填项，走到这里说明已经通过校验。
  return rebuildCase(value) ?? {};
}

/** 规范化序列化。往返幂等的唯一出口。 */
export function stringifyCase(value: Case | CaseDefinition): string {
  return stringifyYaml(toYamlObject(value), YAML_OPTIONS);
}

/** 读入 YAML 文本并校验为 `CaseDefinition`。校验失败时错误须带字段路径。 */
export function parseCase(text: string, source?: string): CaseDefinition {
  const label = source ?? "用例 YAML";

  let document: unknown;
  try {
    document = parseYaml(text);
  } catch (error) {
    throw new Error(`${label} 解析失败：${describeYamlError(error)}`);
  }

  // 顶层不是映射时，zod 只会说 "expected object"，而真正的原因通常是
  // 文件里多了一层缩进或整个文件是数组——这里直接说清楚。
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new Error(`${label} 的顶层必须是一个映射（key: value），实际是 ${Array.isArray(document) ? "数组" : typeof document}`);
  }

  try {
    // 只解析、不迁移：迁移的落点在读端（store/cases.ts 与 core/report.ts 的
    // readReport），见 architecture.md §11.2 ④。schema 层不认识「旧版本」，
    // 让它猜旧字段语义等于把迁移规则写散到两处。
    return CaseDefinitionSchema.parse(document);
  } catch (error) {
    if (error instanceof ZodError) {
      // 抛的是 ZodError 而不是包一层 Error：调用方（web/api.ts）要拿
      // issues[].path 原样回给前端高亮字段（docs/api.md §1.2）。
      // 这里只补上「是哪个文件」，免得每个调用点各写一遍。
      const wrapped = new ZodError(error.issues);
      wrapped.message = `${label} 校验失败：\n${formatIssues(error)}`;
      throw wrapped;
    }
    throw error;
  }
}

/** `sha256(规范化 YAML 字节)`。用于 caseDigest 与变更检测。 */
export function caseDigest(value: Case | CaseDefinition): string {
  // 十六进制：与 git 的短哈希习惯一致，肉眼比对前缀就能判断变没变。
  return createHash("sha256").update(stringifyCase(value), "utf8").digest("hex");
}

/** 从 title 生成 slug；冲突时由调用方追加 `-2`、`-3`。 */
export function slugify(title: string): string {
  // 先做 NFKD 分解再去掉组合用记号，让 "Gödel" -> "godel" 而不是 "g-del"：
  // 重音符号属于同一字母，不该被当成词边界。
  const folded = title.normalize("NFKD").replace(/\p{M}/gu, "");
  const slug = folded
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64)
    .replace(/-+$/g, "");

  // 中英混排或纯符号标题会得到一个太短甚至空的 slug，而 id 规则要求至少两个字符。
  // 用 title 的哈希兜底：同一个标题必须总是得到同一个 id，否则每次保存都会
  // 分配一个新 id、revision 历史直接断掉。
  if (slug.length >= 2) return slug;
  const suffix = createHash("sha256").update(title, "utf8").digest("hex").slice(0, 8);
  return slug === "" ? `case-${suffix}` : `${slug}-${suffix}`;
}
