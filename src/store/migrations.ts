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
 * 缺 `schemaVersion` 时按 **1** 处理（v1 是最早的格式，那时还没写这个字段），
 * 且**不把补上的 1 写回对象**——「原样通过」是这条路径的契约，
 * 而且当前的 schema 自己会把缺失的版本默认成 1（`case.ts` 的 `z.literal(1).default(1)`）。
 *
 * 三种失败都必须抛 `MigrationError` 而不是返回半成品：
 *   - `schemaVersion` 不是正整数
 *   - 版本高于 `target`（文档由更新版本产生）
 *   - 迁移链断裂（缺少某一段）
 *
 * 每条错误信息都带「怎么修」：迁移失败意味着**读不出这份文档**，
 * 而读不出报告的人往往正在排查一次失败——只报「版本不对」等于把问题推回给他。
 */
export function migrateDocument(
  doc: Record<string, unknown>,
  migrations: readonly Migration[],
  target: number,
  label: string,
): Record<string, unknown> {
  // 调用点（store/cases.ts）已保证是普通对象；这里再挡一次是因为本函数是导出的，
  // 而 `doc["schemaVersion"]` 在 null/数组上会抛出难懂的 TypeError，
  // 与「三种失败都抛 MigrationError」的契约不一致。
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) {
    throw new MigrationError(
      `${label}文档必须是一个映射（字段名: 值），实际是 ${Array.isArray(doc) ? "数组" : doc === null ? "null" : typeof doc}`,
    );
  }

  // `??` 让 `null` 与「键不存在」同义。这是刻意的：YAML 里写 `schemaVersion:`
  // （留空）解析出来就是 null，那是「没填写」而不是「填了一个读不懂的版本」。
  // 两者都不携带版本信息，当成同一件事处理才不会有「留空报错、删掉却通过」这种怪事。
  // 反过来，`"1"` / `1.5` / `0` 是**有内容的**错误值，必须报错——它们看起来像版本号，
  // 静默按 1 处理会让人以为自己写对了。
  const declared: unknown = doc["schemaVersion"] ?? 1;

  if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 1) {
    // target 为 1 时不说「1 到 1 之间」——那读起来像笔误，而版本号恰恰是最不能含糊的地方。
    const range = target === 1 ? "1" : `1 到 ${target} 之间`;
    throw new MigrationError(
      `${label}文档的 schemaVersion 必须是正整数，实际是 ${JSON.stringify(declared)}。` +
        `修复：把它改成 ${range} 的整数（本程序当前支持的最高版本是 ${target}）；` +
        `若这一项本就不该存在，删掉它会按 1 处理。`,
    );
  }

  if (declared > target) {
    throw new MigrationError(
      `${label}文档版本 ${declared} 高于本程序支持的版本 ${target}——` +
        `这份文档由更新的版本产生，本程序读不懂它字段的语义。` +
        `修复：把本程序升级到支持${label}格式 v${declared} 的版本；` +
        `不要手工把 schemaVersion 改小，那会得到一份看起来正常但实际错误的${label}（本文件规则 2）。`,
    );
  }

  let current = declared;
  let result = doc;

  // 逐级升。终止性由「每轮必须真正前进」保证：`to > from` 的断言不通过就抛错，
  // 而不是继续循环——迁移表写错（`from: 2, to: 2`）会让这里变成死循环，
  // 而死循环不会报错，只会把进程挂住。
  while (current < target) {
    const step = migrations.find((migration) => migration.from === current);

    if (step === undefined) {
      const available = migrations.map((migration) => `${migration.from} -> ${migration.to}`).join("、");
      throw new MigrationError(
        `缺少 ${label}格式 ${current} -> ${current + 1} 的迁移，这份文档升不到版本 ${target}（迁移链断裂）。` +
          `现有迁移段：${available === "" ? "（链是空的）" : available}。` +
          `修复：在 store/migrations.ts 的${label}迁移链里补上 from: ${current}, to: ${current + 1} 这一段，` +
          `或用产生这份文档的那个版本重新导出。`,
      );
    }

    if (step.to <= step.from) {
      throw new MigrationError(
        `${label}迁移段的版本号写反了：from ${step.from} -> to ${step.to}（${step.description}）。` +
          `修复：迁移必须是前进的（to 大于 from），否则会死循环读不出来。`,
      );
    }

    // 越过目标版本说明迁移表与目标版本已经对不上（例如这段是 1 -> 5，而 target 是 3）。
    // 放过去的话会返回一份版本号高于本程序能力的文档，而调用方以为它已经升到位了。
    if (step.to > target) {
      throw new MigrationError(
        `${label}迁移段 from ${step.from} -> to ${step.to}（${step.description}）越过了目标版本 ${target}。` +
          `修复：检查迁移链与 CURRENT_CASE_SCHEMA_VERSION / CURRENT_REPORT_SCHEMA_VERSION 是否一致。`,
      );
    }

    // **由框架统一盖上新的版本号**，而不是指望每段迁移自己记得改：
    // 漏改的话会返回一份「内容已升级、版本号却是旧的」文档，
    // 紧接着又被下一条迁移匹配一次，静默地把同一段升两遍。
    result = { ...step.apply(result), schemaVersion: step.to };
    current = step.to;
  }

  return result;
}

/** 用例文档的迁移入口。在 `store/cases.ts` 解析 YAML 之后、zod 校验之前调用。 */
export function migrateCaseDocument(doc: Record<string, unknown>): Record<string, unknown> {
  return migrateDocument(doc, CASE_MIGRATIONS, CURRENT_CASE_SCHEMA_VERSION, "用例");
}

/** 报告文档的迁移入口。在 `core/report.ts` 的 `readReport` 里调用。 */
export function migrateReportDocument(doc: Record<string, unknown>): Record<string, unknown> {
  return migrateDocument(doc, REPORT_MIGRATIONS, CURRENT_REPORT_SCHEMA_VERSION, "报告");
}

// 已实现 `migrateDocument`（三条失败都抛 MigrationError，见函数头）。
//
// 与 TODO 的一处偏差：原计划「报错消息里带上文件路径」，但签名只收 `label`，
// 而路径只有调用方（store/cases.ts / core/report.ts 的 readReport）知道。
// 不改签名去补路径（签名已冻结），改由调用方在需要时把路径拼进自己的错误信息里。
//
// TODO(P1): 写一个测试：把历史版本的样例文档逐个喂进来，
//   断言能升到当前版本且解析通过。样例存在 tests/fixtures/migrations/。
