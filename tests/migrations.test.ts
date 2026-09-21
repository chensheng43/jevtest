/**
 * 迁移的三种失败路径 + 逐级升级。
 *
 * 这里刻意**不依赖真实的迁移链**：`CASE_MIGRATIONS` / `REPORT_MIGRATIONS`
 * 目前都是空的（只支持 v1），靠它们测不出链式行为。所以用自造的链造场景，
 * 逐级升级与链断裂才真的被走到——否则这段代码要等到第一次破坏性改格式时
 * 才第一次运行，而那时它已经在读**别人**的历史报告了。
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CASE_MIGRATIONS,
  CURRENT_CASE_SCHEMA_VERSION,
  CURRENT_REPORT_SCHEMA_VERSION,
  MigrationError,
  REPORT_MIGRATIONS,
  migrateCaseDocument,
  migrateDocument,
  migrateReportDocument,
} from "../src/store/migrations.ts";
import type { Migration } from "../src/store/migrations.ts";

/** 自造的迁移链：1 -> 2 加 mode，2 -> 3 改名。 */
const CHAIN: readonly Migration[] = [
  { from: 1, to: 2, description: "新增 mode 字段", apply: (doc) => ({ ...doc, mode: "interactive" }) },
  { from: 2, to: 3, description: "把 url 改名成 startUrl", apply: ({ url, ...rest }) => ({ ...rest, startUrl: url }) },
];

/** 捕获抛出的错误，便于断言类型与消息。 */
function catchError(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// 通过路径
// ---------------------------------------------------------------------------

test("v1 文档升到 v1（target 为 1）原样通过，且不注入 schemaVersion", () => {
  const doc = { schemaVersion: 1, title: "t", budget: { maxSteps: 1 } };
  const result = migrateCaseDocument(doc);
  assert.deepEqual(result, doc);

  // 缺 schemaVersion 按 1 处理。「原样」意味着**不把补上的 1 写回对象**——
  // 当前的 schema 自己会把缺失的版本默认成 1（case.ts 的 z.literal(1).default(1)），
  // 迁移层多插一个键会让「这份文档原本有没有写版本号」这个信息丢失。
  const noVersion = { title: "t" };
  assert.deepEqual(migrateCaseDocument(noVersion), { title: "t" });
  assert.ok(!("schemaVersion" in migrateCaseDocument(noVersion)));
});

test("目标版本等于文档版本时不做任何事", () => {
  const doc = { schemaVersion: 2, keep: "me" };
  assert.deepEqual(migrateDocument(doc, CHAIN, 2, "用例"), doc);
});

test("自造的 1 -> 2 -> 3 链逐级升级，每一段都生效", () => {
  const result = migrateDocument({ schemaVersion: 1, url: "https://example.com/" }, CHAIN, 3, "用例");
  assert.deepEqual(result, { schemaVersion: 3, mode: "interactive", startUrl: "https://example.com/" });
});

test("逐级应用的顺序由链决定（每段只理解相邻两个版本）", () => {
  const applied: string[] = [];
  const traced: readonly Migration[] = [
    { from: 1, to: 2, description: "第一段", apply: (doc) => (applied.push("first"), doc) },
    { from: 2, to: 3, description: "第二段", apply: (doc) => (applied.push("second"), doc) },
  ];
  migrateDocument({ schemaVersion: 1 }, traced, 3, "用例");
  assert.deepEqual(applied, ["first", "second"]);
});

test("框架统一盖上新的版本号，不指望每段迁移自己记得改", () => {
  // 故意写一个**不碰 schemaVersion** 的迁移：升级后版本号也必须是 2，
  // 否则它会被下一条 from: 1 的迁移再匹配一次，静默地把同一段升两遍。
  const sloppy: readonly Migration[] = [{ from: 1, to: 2, description: "忘了改版本号", apply: (doc) => ({ ...doc }) }];
  const result = migrateDocument({ schemaVersion: 1 }, sloppy, 2, "用例");
  assert.equal(result["schemaVersion"], 2);
});

test("迁移不改写传入的对象（in-memory 版的「永不改写磁盘」）", () => {
  const doc = { schemaVersion: 1, url: "https://example.com/" };
  const snapshot = { ...doc };
  migrateDocument(doc, CHAIN, 3, "用例");
  // 迁移只在读的时候发生。原地改会污染调用方手里的那份文档——
  // 而报告的整个价值建立在「读到的就是当初落盘的」之上。
  assert.deepEqual(doc, snapshot);
});

test("空链 + v1 文档是当前的正常情形（用例与报告都一样）", () => {
  assert.deepEqual(CASE_MIGRATIONS, []);
  assert.deepEqual(REPORT_MIGRATIONS, []);
  assert.equal(CURRENT_CASE_SCHEMA_VERSION, 1);
  assert.equal(CURRENT_REPORT_SCHEMA_VERSION, 1);

  assert.deepEqual(migrateCaseDocument({ schemaVersion: 1, title: "t" }), { schemaVersion: 1, title: "t" });
  assert.deepEqual(migrateReportDocument({ schemaVersion: 1, runId: "r" }), { schemaVersion: 1, runId: "r" });
});

// ---------------------------------------------------------------------------
// 失败路径一：版本高于 target
// ---------------------------------------------------------------------------

test("版本高于 target 时报错，且消息里带上两个版本号", () => {
  const error = catchError(() => migrateCaseDocument({ schemaVersion: 2, title: "t" }));
  assert.ok(error instanceof MigrationError, `期望 MigrationError，实际是 ${String(error)}`);
  // 两个版本号都要出现：只说「版本不对」会让人不知道到底是谁旧谁新
  assert.match(error.message, /版本 2/);
  assert.match(error.message, /版本 1/);
  // 并且必须劝住「手工改小版本号」这个最诱人的错误做法
  assert.match(error.message, /不要手工把 schemaVersion 改小/);
  assert.match(error.message, /修复/);
});

test("报告侧的报错说的是报告（label 被带进消息）", () => {
  const error = catchError(() => migrateReportDocument({ schemaVersion: 9 }));
  assert.ok(error instanceof MigrationError);
  assert.match(error.message, /报告文档版本 9/);
  assert.match(error.message, /报告格式 v9/);
});

// ---------------------------------------------------------------------------
// 失败路径二：迁移链断裂
// ---------------------------------------------------------------------------

test("链断裂时指出缺的是哪一段", () => {
  // 链里只有 2 -> 3，缺开头那一段
  const missingHead = catchError(() => migrateDocument({ schemaVersion: 1 }, [CHAIN[1]!], 3, "用例"));
  assert.ok(missingHead instanceof MigrationError);
  assert.match(missingHead.message, /缺少 用例格式 1 -> 2 的迁移/);
  // 顺带把现有链打出来，省得人去翻文件
  assert.match(missingHead.message, /2 -> 3/);
  assert.match(missingHead.message, /修复/);

  // 链里只有 1 -> 2，缺结尾那一段
  const missingTail = catchError(() => migrateDocument({ schemaVersion: 1 }, [CHAIN[0]!], 3, "用例"));
  assert.ok(missingTail instanceof MigrationError);
  assert.match(missingTail.message, /缺少 用例格式 2 -> 3 的迁移/);
});

test("链是空的时候，缺的是从文档版本开始的整段", () => {
  const error = catchError(() => migrateDocument({ schemaVersion: 2 }, [], 3, "用例"));
  assert.ok(error instanceof MigrationError);
  assert.match(error.message, /缺少 用例格式 2 -> 3 的迁移/);
  assert.match(error.message, /链是空的/);
});

// ---------------------------------------------------------------------------
// 失败路径三：版本号不是正整数
// ---------------------------------------------------------------------------

test("版本号不是正整数时报错，每种写法都挡住", () => {
  // 这些都是**有内容的**错误值：看起来像版本号，静默按 1 处理会让人以为自己写对了。
  // 其中 `"1"`（YAML 里手滑加了引号）尤其要命——它肉眼几乎看不出问题。
  for (const bad of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", "v1", true, {}, []]) {
    const error = catchError(() => migrateCaseDocument({ schemaVersion: bad } as Record<string, unknown>));
    assert.ok(error instanceof MigrationError, `schemaVersion=${JSON.stringify(bad)} 应该报 MigrationError`);
    assert.match(error.message, /必须是正整数/);
    assert.match(error.message, /修复/);
  }
});

test("schemaVersion 为 null 视同「没填」，按 1 处理（而不是报错）", () => {
  // YAML 里写 `schemaVersion:`（留空）解析出来就是 null——那是「没填写」，
  // 不是「填了一个读不懂的版本」。若这里报错，就会变成
  // 「留空被拒、删掉整行却通过」，同一个意图两种结果。
  assert.deepEqual(migrateCaseDocument({ schemaVersion: null }), { schemaVersion: null });
  assert.deepEqual(migrateCaseDocument({ schemaVersion: undefined }), { schemaVersion: undefined });
});

// ---------------------------------------------------------------------------
// 防死循环与越过目标
// ---------------------------------------------------------------------------

test("迁移段的 to 不大于 from 时报错而不是死循环", () => {
  const stuck: readonly Migration[] = [{ from: 1, to: 1, description: "空转", apply: (doc) => doc }];
  const error = catchError(() => migrateDocument({ schemaVersion: 1 }, stuck, 2, "用例"));
  assert.ok(error instanceof MigrationError);
  assert.match(error.message, /写反了/);
  assert.match(error.message, /from 1 -> to 1/);

  const backwards: readonly Migration[] = [{ from: 2, to: 1, description: "倒退", apply: (doc) => doc }];
  const backwardsError = catchError(() => migrateDocument({ schemaVersion: 2 }, backwards, 3, "用例"));
  assert.ok(backwardsError instanceof MigrationError);
  assert.match(backwardsError.message, /写反了/);
});

test("迁移段越过目标版本时报错（否则会返回一份版本号高于本程序能力的文档）", () => {
  const overshoot: readonly Migration[] = [{ from: 1, to: 5, description: "跳级", apply: (doc) => doc }];
  const error = catchError(() => migrateDocument({ schemaVersion: 1 }, overshoot, 3, "用例"));
  assert.ok(error instanceof MigrationError);
  assert.match(error.message, /越过了目标版本 3/);
});

test("跳级到目标本身是允许的（约束是单调前进，不是必须相邻）", () => {
  const jump: readonly Migration[] = [{ from: 1, to: 3, description: "一步到位", apply: (doc) => ({ ...doc, ok: true }) }];
  assert.deepEqual(migrateDocument({ schemaVersion: 1 }, jump, 3, "用例"), { schemaVersion: 3, ok: true });
});

// ---------------------------------------------------------------------------
// 输入形态
// ---------------------------------------------------------------------------

test("非映射的输入抛 MigrationError，而不是难懂的 TypeError", () => {
  for (const bad of [null, [], "doc", 42] as unknown[]) {
    const error = catchError(() => migrateDocument(bad as Record<string, unknown>, [], 1, "用例"));
    assert.ok(error instanceof MigrationError, `${JSON.stringify(bad)} 应该报 MigrationError`);
    assert.match(error.message, /必须是一个映射/);
  }
});

test("MigrationError 的 name 是 MigrationError（日志里能一眼认出来）", () => {
  const error = new MigrationError("x");
  assert.ok(error instanceof Error);
  assert.equal(error.name, "MigrationError");
});
