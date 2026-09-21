/**
 * 用例仓库：`cases/<id>/` 的读写、版本、ID 分配。
 *
 * 这是 D5「YAML 是唯一事实来源」真正要被守住的地方。Web 表单、CLI、导入
 * 三条入口最后都落到这里的 `write()`，因此**只有一个地方**决定磁盘上长什么样。
 *
 * ## 目录布局
 *
 * ```text
 * cases/
 *   <caseId>/
 *     case.yaml            当前版本
 *     revisions/
 *       0001.yaml          每次保存的不可变快照，保留最近 REVISION_KEEP 份
 *       0002.yaml
 * ```
 *
 * ## 三个关键决定
 *
 * **1. revision 从 revisions/ 目录推导，不维护计数器文件。**
 * 计数器文件会漂移（写失败、手工删除、并发），而目录本身就是事实——
 * 有多少份快照就是多少版。少一个需要保持同步的东西。
 *
 * **2. 并发用乐观锁（`expectedRevision`），不用文件锁。**
 * 单进程单事件循环，真正的竞态来自两个 HTTP 请求同时保存，不是两个进程。
 * 且 Windows 上文件锁很难做对。乐观检查 + 原子 rename 足够，且简单得多。
 * 冲突时明确报错让用户重试，好过悄悄用后写的覆盖先写的。
 *
 * **3. 写入必须原子：先写临时文件再 rename。**
 * 直接覆写的话，进程在写一半时被杀会留下半截 YAML——而 `case.yaml` 是唯一
 * 事实来源，损坏它等于丢失这个用例。rename 在同分区上是原子的。
 *
 * ## 与 runs 侧的不对称
 *
 * 运行报告的落盘在 `core/report.ts`，不在本目录。这是有意的：报告要组装
 * `steps` / `assertion` / `stats`，与运行生命周期紧密耦合；而用例是纯 CRUD。
 * 把前者搬过来只会让两侧都变复杂。
 */

import type { Case, CaseDefinition, CaseRevision } from "../schema/case.ts";
import type { RunStatus } from "../schema/events.ts";

/** 保留多少份历史版本。再老的会被清理——它们是快照，不是档案 */
export const REVISION_KEEP = 20;

/** 用例 id 的合法形式。与 `docs/case-format.md` 的字段表一致 */
export const CASE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;

/** 列表页需要的最小信息，不必读完整用例 */
export interface CaseSummary {
  id: string;
  title: string;
  revision: number;
  digest: string;
  savedAt: string;
  /** 最近一次运行的结论。从 `runs/index.jsonl` 反查；从未跑过为 `null` */
  lastRun: { runId: string; status: RunStatus; passed: boolean | null; startedAt: string } | null;
}

export interface LoadedCase {
  def: CaseDefinition;
  revision: CaseRevision;
  /** 磁盘上的原始 YAML 文本，供编辑器直接显示——不要用序列化结果替代它 */
  yaml: string;
}

export interface WriteOptions {
  /**
   * 乐观并发：磁盘上的 revision 不等于它时拒绝写入，抛 `CaseConflict`。
   *
   * 表单提交时必须带上——否则两个标签页同时编辑，后保存的会静默覆盖先保存的，
   * 而用户直到发现改动消失才知道出事。
   */
  expectedRevision?: number;
}

/** 并发冲突。消息里要带当前 revision，让界面能提示「重新加载后再改」 */
export class CaseConflict extends Error {
  override readonly name = "CaseConflict";
}

/** 用例不存在或格式非法 */
export class CaseNotFound extends Error {
  override readonly name = "CaseNotFound";
}

export interface CaseStore {
  /** 列出全部用例。按 `savedAt` 倒序 */
  list(): Promise<CaseSummary[]>;

  read(caseId: string): Promise<LoadedCase>;

  /** 新建或更新。返回新的 revision。`id` 缺省时由 title 生成 */
  write(def: CaseDefinition, options?: WriteOptions): Promise<CaseRevision>;

  remove(caseId: string): Promise<void>;

  /**
   * 从 YAML 文本导入。
   *
   * **id 冲突时不覆盖，而是追加 `-2`、`-3`。** 导入是「加一个用例」的动作，
   * 静默覆盖既有用例属于数据丢失——用户以为在导入，实际在替换。
   */
  import(yaml: string): Promise<CaseRevision>;

  /** 导出规范化 YAML（往返幂等，见 `schema/yaml.ts`） */
  export(caseId: string): Promise<string>;

  /**
   * 把用例冻结一份到运行目录，让报告自包含。
   *
   * 返回的 `CaseRevision` 会被写进报告的 `caseRevision` / `caseDigest`，
   * 因此事后翻出一份旧报告能精确回到产生它的用例版本（D13）。
   */
  freeze(caseId: string, destination: string): Promise<CaseRevision>;

  /** 从 title 生成不冲突的 id。冲突时追加 `-2`、`-3`…… */
  allocateId(title: string): Promise<string>;

  /** 读某一份历史版本。供 diff 视图与「回到这一版」使用 */
  readRevision(caseId: string, revision: number): Promise<string>;
}

export interface CaseStoreOptions {
  /** 用例库根目录，来自 `settings.casesDir` */
  root: string;
  /** 运行目录，用于反查最近一次运行结论。来自 `settings.runsDir` */
  runsDir: string;
}

export function createCaseStore(options: CaseStoreOptions): CaseStore {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现 createCaseStore。
//
//   写入路径（三条入口共用，这是「唯一事实来源」的落点）：
//     1. CaseDefinitionSchema.parse()  —— 服务端永远重新校验，前端只是即时反馈
//     2. 分配或校验 id
//     3. toYamlObject() -> yaml.stringify()  —— 规范化，保证往返幂等
//     4. caseDigest()
//     5. 新 revision = max(revisions/*.yaml) + 1
//     6. 写 revisions/NNNN.yaml（临时文件 + rename）
//     7. 写 case.yaml（临时文件 + rename）
//     8. 清理超出 REVISION_KEEP 的旧快照
//
//   读路径：
//     1. 读 case.yaml
//     2. yaml.parse -> migrateCaseDocument() -> CaseDefinitionSchema.parse()
//        （迁移必须在 zod 之前——旧文档的结构还不受当前类型约束）
//
// TODO(P0): 原子写的辅助函数放在这里而不是 util/：它是本模块的核心约束，
//   不是通用工具。写法是 writeFile(tmp) -> rename(tmp, dest)，同分区上原子。
//
// TODO(P1): `list()` 反查 lastRun 时不要逐个读 runs/index.jsonl——
//   读一次建索引，否则用例一多就退化成 N 次全文件扫描。
