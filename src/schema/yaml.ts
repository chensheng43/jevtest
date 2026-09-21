/**
 * YAML 规范化：对象 ↔ YAML 文本 ↔ digest。
 *
 * 存在的理由只有一个：**保证「表单 ↔ YAML」往返幂等**。
 * 同一份用例，无论从表单保存还是从文件导入，落盘字节必须完全一致，
 * 否则 git diff 会充满噪声、digest 会漂移、revision 历史失去意义。
 *
 * 做法是固定键序重建普通对象再序列化，而不是直接 dump 原对象。
 */

import type { Case, CaseDefinition } from "./case.ts";

/** 序列化选项：`lineWidth: 0` 关闭自动折行，避免长 goal 在不同宽度下 diff 不同。 */
export interface YamlOptions {
  lineWidth: 0;
}

/**
 * 把用例对象按固定键序重建为普通对象。
 *
 * 键序与 `CaseDefinition` 的声明顺序一致，嵌套对象同样处理。
 * 这一步会丢弃 `undefined` 字段（YAML 里不写），但**保留已填充的默认值**——
 * 默认值是否落盘由调用方决定：保存到 `cases/<id>/case.yaml` 时只写用户显式设置的部分，
 * 冻结到 `runs/<runId>/case.yaml` 时写完整的 `Case`。
 */
export function toYamlObject(value: Case | CaseDefinition): Record<string, unknown> {
  throw new Error("未实现：P0 待实现");
}

/** 规范化序列化。往返幂等的唯一出口。 */
export function stringifyCase(value: Case | CaseDefinition): string {
  throw new Error("未实现：P0 待实现");
}

/** 读入 YAML 文本并校验为 `CaseDefinition`。校验失败时错误须带字段路径。 */
export function parseCase(text: string, source?: string): CaseDefinition {
  throw new Error("未实现：P0 待实现");
}

/** `sha256(规范化 YAML 字节)`。用于 caseDigest 与变更检测。 */
export function caseDigest(value: Case | CaseDefinition): string {
  throw new Error("未实现：P0 待实现");
}

/** 从 title 生成 slug；冲突时由调用方追加 `-2`、`-3`。 */
export function slugify(title: string): string {
  throw new Error("未实现：P0 待实现");
}
