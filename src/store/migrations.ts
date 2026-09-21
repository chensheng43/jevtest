/**
 * 版本迁移：读旧文档时在同一处逐级升级。
 *
 * `schemaVersion` 字段一直标着「用于未来迁移」，但迁移的**执行位置**此前没有定义。
 * 本文件补上这个落点，规则如下：
 *
 * 1. **迁移只在读的时候发生，永不改写磁盘。**
 *    尤其是报告——它是长期留存的**物证**。把一份 v1 报告读进来、升级、再写回去，
 *    等于篡改了证据。用例可以改（它本来就该演进），报告不可以。
 *
 * 2. **版本比当前高时直接报错，不做降级猜测。**
 *    一份由更新版本产生的报告，本版本读不懂它的字段语义。静默按当前版本解析
 *    会得到一份**看起来正常但实际错误**的报告——这是最坏的结果，
 *    比读不出来危险得多。
 *
 * 3. **迁移是逐级的，不是从任意版本跳到最新。**
 *    `1 -> 2` 与 `2 -> 3` 各写各的，链式应用。这样每一段迁移只需理解相邻两个版本，
 *    而跳级迁移要理解所有组合。
 *
 * 4. **报告比用例更需要迁移。** 用例是活文档，随时可以重写；
 *    报告是历史，一旦产生就不再变。所以新增 `schemaVersion` 时，
 *    先问「旧的报告还读得出来吗」。
 */

/** 当前支持的用例格式版本。改 `CaseDefinition` 的破坏性字段时必须递增 */
export const CURRENT_CASE_SCHEMA_VERSION = 1;

/** 当前支持的报告格式版本 */
export const CURRENT_REPORT_SCHEMA_VERSION = 1;

/**
 * 一次相邻版本的升级。
 *
 * `apply` 收一个普通对象、返回一个普通对象，不依赖 zod——
 * 迁移发生在 schema 解析**之前**，此时数据结构还不受当前类型约束。
 */
export interface Migration {
  from: number;
  to: number;
  /** 一句话说明改了什么，出现在错误信息与日志里 */
  description: string;
  apply(doc: Record<string, unknown>): Record<string, unknown>;
}

/** 读到无法识别的版本时抛出。消息必须说清「文档版本 vs 本程序版本」 */
export class MigrationError extends Error {
  override readonly name = "MigrationError";
}

/**
 * 用例格式的迁移链。
 *
 * 目前为空（只支持 v1）。新增时按 `from` 升序排列，且必须连续——
 * `migrateDocument` 会在链断裂时报错，而不是悄悄跳过。
 */
export const CASE_MIGRATIONS: readonly Migration[] = [];

/** 报告格式的迁移链。同上 */
export const REPORT_MIGRATIONS: readonly Migration[] = [];

/**
 * 把文档逐级升级到 `target` 版本。
 *
 * 缺 `schemaVersion` 时按 **1** 处理（v1 是最早的格式，那时还没写这个字段）。
 *
 * 三种失败都必须抛 `MigrationError` 而不是返回半成品：
 *   - `schemaVersion` 不是正整数
 *   - 版本高于 `target`（文档由更新版本产生）
 *   - 迁移链断裂（缺少某一段）
 */
export function migrateDocument(
  doc: Record<string, unknown>,
  migrations: readonly Migration[],
  target: number,
  label: string,
): Record<string, unknown> {
  throw new Error("未实现：P0 待实现");
}

/** 用例文档的迁移入口。在 `store/cases.ts` 解析 YAML 之后、zod 校验之前调用。 */
export function migrateCaseDocument(doc: Record<string, unknown>): Record<string, unknown> {
  return migrateDocument(doc, CASE_MIGRATIONS, CURRENT_CASE_SCHEMA_VERSION, "用例");
}

/** 报告文档的迁移入口。在 `core/report.ts` 的 `readReport` 里调用。 */
export function migrateReportDocument(doc: Record<string, unknown>): Record<string, unknown> {
  return migrateDocument(doc, REPORT_MIGRATIONS, CURRENT_REPORT_SCHEMA_VERSION, "报告");
}

// TODO(P0): 实现 migrateDocument。
//   - 目标版本低于文档版本 -> 报错，消息里带上两个版本号与文件路径。
//   - 链断裂 -> 报错并指出缺的是哪一段（`from` -> `to`）。
//   - 循环里每一步都要断言 `to > from`，防止迁移表写错导致死循环。
//
// TODO(P1): 写一个测试：把历史版本的样例文档逐个喂进来，
//   断言能升到当前版本且解析通过。样例存在 tests/fixtures/migrations/。
