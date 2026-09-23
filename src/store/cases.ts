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

import { mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { parse as parseYaml } from "yaml";

import { CaseDefinitionSchema } from "../schema/case.ts";
import type { Case, CaseDefinition, CaseRevision } from "../schema/case.ts";
import { caseDigest, slugify, stringifyCase } from "../schema/yaml.ts";
import type { RunIndexEntry } from "../schema/report.ts";
import type { RunStatus } from "../schema/events.ts";
import { migrateCaseDocument } from "./migrations.ts";

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
   *
   * 给了 `ran`（实际跑的那份 `Case`）时，冻结的是它而不是仓库的当前版本，
   * revision 按 digest 在历史版本里反查——运行期间用例被改过，报告也不会指错版本。
   * 历史里找不到同 digest 的版本时 revision 记 0。
   */
  freeze(caseId: string, destination: string, ran?: Case): Promise<CaseRevision>;

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

/** 当前版本文件的文件名。冻结快照用同一个名字，见 `FROZEN_CASE_FILE` */
const CASE_FILE = "case.yaml";

/** 历史快照目录 */
const REVISIONS_DIR = "revisions";

/** 快照文件名。**只认 `0001.yaml` 这种形态**，临时文件与杂物因此不会被当成版本 */
const REVISION_FILE_PATTERN = /^(\d{4,})\.yaml$/;

/** 与 `CASE_ID_PATTERN` 的 `{1,63}` 对应：首位 1 个字符 + 最多 63 个字符 */
const MAX_ID_LENGTH = 64;

/** 分配 id 时最多试多少个后缀。没有它，一个写坏的候选生成器会让请求永远挂住 */
const MAX_ID_ATTEMPTS = 1000;

/**
 * 冻结快照在运行目录里的文件名。
 *
 * **分工**：文件由 cli/web 侧注入的 `persist` 回调写——只有它同时看得见
 * `CaseStore` 与报告（`store.freeze(caseId, join(runsDir, runId, FROZEN_CASE_FILE))`
 * 返回的 `CaseRevision` 正好是报告的 `caseRevision` / `caseDigest`）。
 * runner 不做这件事，也不持有 store；它只负责让 `artifacts.frozenCase`
 * 指向这个相对路径。理由见 `architecture.md §11.2`。
 */
export const FROZEN_CASE_FILE = "case.yaml";

/** 纯对象。YAML 映射与 zod 输出都是它，用它区分「对象」与「数组 / 标量」 */
type PlainObject = Record<string, unknown>;

interface StoredCase {
  /** 从 YAML 读出的原始对象（**已迁移**，未填默认值），导出时用它保留用户实际写下的字段 */
  doc: PlainObject;
  /** `CaseDefinitionSchema.parse()` 的输出：默认值已填充 */
  parsed: Case;
  /** 磁盘上的原始文本，供编辑器直接显示 */
  text: string;
  /** `case.yaml` 的 mtime。用例没有自己的更新时间字段，落盘时刻就是保存时刻 */
  savedAt: string;
}

export function createCaseStore(options: CaseStoreOptions): CaseStore {
  const root = options.root;
  const runsIndexPath = join(options.runsDir, "index.jsonl");

  // -------------------------------------------------------------------------
  // 进程内的写串行化
  // -------------------------------------------------------------------------

  // **这不是文件锁**（文件锁在 Windows 上很难做对，也是本模块明确拒绝的方案）。
  // 它防的是同一事件循环里两个 await 的交错：乐观检查读到的 revision 与真正落盘的
  // revision 之间隔着若干 await，中间被另一个保存插进来，检查就形同虚设。
  // 写入本身很短（几 KB 文件 + 两次 rename），全局串行不影响吞吐，
  // 却让「检查 → 推导新 revision → 落盘」成为一个不可分割的临界区。
  let writeChain: Promise<unknown> = Promise.resolve();

  function serialized<T>(task: () => Promise<T>): Promise<T> {
    const next = writeChain.then(task, task);
    // 链条自己吞掉失败：任务的失败由调用方接收，链条上再冒一次就是未处理的 rejection
    writeChain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  // -------------------------------------------------------------------------
  // 路径
  // -------------------------------------------------------------------------

  /** 已通过 `requireCaseId` 校验的 id 才能进来——id 直接参与拼路径 */
  function caseDirPath(caseId: string): string {
    return join(root, caseId);
  }

  function caseFilePath(caseId: string): string {
    return join(caseDirPath(caseId), CASE_FILE);
  }

  function revisionsDirPath(caseId: string): string {
    return join(caseDirPath(caseId), REVISIONS_DIR);
  }

  function revisionFilePath(caseId: string, revision: number): string {
    // 4 位零填充：目录列表按字典序排就是版本序。超过 4 位自然增长，不截断
    return join(revisionsDirPath(caseId), `${String(revision).padStart(4, "0")}.yaml`);
  }

  // -------------------------------------------------------------------------
  // 读路径
  // -------------------------------------------------------------------------

  /**
   * YAML 文本 → 迁移 → zod。
   *
   * **迁移必须在 zod 之前**：旧文档的结构还不受当前类型约束，
   * 先交给 zod 会在迁移有机会修它之前就把人挡在门外（`migrations.ts` 规则 3）。
   */
  function parseCaseDocument(text: string, source: string): { doc: PlainObject; parsed: Case } {
    let raw: unknown;
    try {
      raw = parseYaml(text);
    } catch (cause) {
      throw new CaseNotFound(`${source} 不是合法 YAML`, { cause });
    }
    if (!isPlainObject(raw)) {
      throw new CaseNotFound(`${source} 的顶层必须是映射（字段名: 值），实际是 ${describeType(raw)}`);
    }
    const doc = migrateCaseDocument(raw);
    // 这里**不**把 zod 的错误包成 CaseNotFound：POST 侧要把 issue 路径放进 400 的 detail
    // 里高亮表单字段（`api.md` §1.2），包一层就把路径吞了
    const parsed = CaseDefinitionSchema.parse(doc);
    return { doc, parsed };
  }

  /** 读磁盘上的用例库文件。读不到或读不出都抛 `CaseNotFound`（原始错误挂在 `cause` 上） */
  async function loadStoredCase(caseId: string): Promise<StoredCase> {
    const filePath = caseFilePath(caseId);
    let text: string;
    try {
      text = await readFile(filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new CaseNotFound(`用例 "${caseId}" 不存在：读不到 ${filePath}`);
      }
      throw error;
    }
    const { mtime } = await stat(filePath);
    let parsedDocument: { doc: PlainObject; parsed: Case };
    try {
      parsedDocument = parseCaseDocument(text, filePath);
    } catch (cause) {
      // 磁盘上的文件不合法：对调用方来说就是「这个用例读不出来」，
      // 但原始错误（含 zod 的 issue 路径）必须留在 cause 里，否则无从排查
      throw new CaseNotFound(`用例 "${caseId}" 的文件不合法：${errorMessage(cause)}`, { cause });
    }
    return {
      doc: parsedDocument.doc,
      // **用例的身份是它的目录，不是文件里的 `id` 字段。** 手工放进用例库的
      // `case.yaml` 可以没有 `id`，schema 会用 title 的 slug 兜底，而那个值只保证
      // 「同一个 title 得到同一个 slug」，与目录名毫无关系。
      //
      // 照原样返回会出一个隐蔽的数据错误：表单读到的 `id` 与目录名对不上，
      // 用户改完一保存，`write()` 走「显式 id 只校验不重命名」那条路，
      // 结果不是更新原用例，而是**凭空多出一个用例**，原文件永远停在旧内容上。
      // 这里统一成目录名，read / list / freeze / export 四处于是取到同一个身份，
      // 四处的 digest 也才对得上。
      parsed: { ...parsedDocument.parsed, id: caseId },
      text,
      savedAt: mtime.toISOString(),
    };
  }

  /** `revisions/` 里现有的版本号。临时文件与杂物不算版本 */
  async function revisionNumbers(caseId: string): Promise<number[]> {
    const names = await readdir(revisionsDirPath(caseId)).catch(() => undefined);
    if (names === undefined) return [];
    const numbers: number[] = [];
    for (const name of names) {
      const digits = REVISION_FILE_PATTERN.exec(name)?.[1];
      if (digits === undefined) continue;
      numbers.push(Number(digits));
    }
    return numbers;
  }

  /**
   * 当前 revision。**从目录推导**，没有计数器文件可漂移。
   *
   * 0 表示「一份快照都没有」：用例还不存在，或它是手工放进用例库的。
   */
  async function currentRevision(caseId: string): Promise<number> {
    const numbers = await revisionNumbers(caseId);
    return numbers.reduce((max, n) => (n > max ? n : max), 0);
  }

  // -------------------------------------------------------------------------
  // 写路径
  // -------------------------------------------------------------------------

  /**
   * 三条入口（Web 表单 / CLI / 导入）共用的落盘点。**D5 在这里被守住。**
   *
   * 调用前必须已持有写串行化，且 id 已确定。
   */
  async function saveCase(
    caseId: string,
    def: CaseDefinition,
    expectedRevision: number | undefined,
  ): Promise<CaseRevision> {
    const withId: CaseDefinition = { ...def, id: caseId };
    // 服务端永远重新校验：前端那份 zod 只是即时反馈，不是信任边界（`api.md` §1.2）。
    // **校验排在乐观锁检查之前**：一份不合法的载荷不管并发状态如何都是「请求不对」，
    // 把它报成 409「重新加载后再改」会误导人——重新加载并不会让那个字段变合法，
    // 用户会一圈圈重试。两处检查都不碰磁盘，先后只影响报出去的错误码。
    const parsed = CaseDefinitionSchema.parse(withId);

    const current = await currentRevision(caseId);
    if (expectedRevision !== undefined && expectedRevision !== current) {
      // 消息里带当前 revision，界面据此提示「重新加载后再改」；
      // 猜一个「就用最新版覆盖」等于把用户的编辑悄悄扔掉
      throw new CaseConflict(
        expectedRevision === 0
          ? `用例 "${caseId}" 已存在（revision ${current}）：新建时不能使用已有的 id。` +
              `要修改它，请先载入该用例再保存（请求需带 expectedRevision）。`
          : `用例 "${caseId}" 已被改动：磁盘上是 revision ${current}，请求基于 revision ${expectedRevision}。` +
              `请重新加载用例后再保存。`,
      );
    }

    // 磁盘上只写用户显式设置的部分：默认值留在代码里，将来调默认值能作用于全部用例，
    // 而「这一次实际用什么值跑」由冻结快照（完整 Case）固定住（`schema/yaml.ts` 文件头）
    const text = stringifyCase(explicitOnly(withId, parsed) as CaseDefinition);
    const revision = current + 1;

    await mkdir(revisionsDirPath(caseId), { recursive: true });

    // 先快照后当前版本：快照是不可变的历史，当前版本是「现在是什么」。
    // 顺序反过来的话，中间崩溃会得到一份「当前版本已更新但没有对应快照」的状态——
    // 那是无法回退的版本，而反过来只是多一份快照，无害。
    const snapshotPath = revisionFilePath(caseId, revision);
    await writeFileAtomic(snapshotPath, text);
    try {
      await writeFileAtomic(caseFilePath(caseId), text);
    } catch (error) {
      // 当前版本没落地，这份快照就是「一次没发生过的保存」。
      // 回滚它，免得 readRevision() 能读出一个 read() 从未返回过的版本，
      // 也免得重试时凭空跳号。
      await rm(snapshotPath, { force: true }).catch(() => undefined);
      throw error;
    }

    await pruneRevisions(caseId);
    return { caseId, revision, digest: caseDigest(parsed), savedAt: new Date().toISOString() };
  }

  /** 只保留最近 `REVISION_KEEP` 份快照。清理是家务事，失败不能让已成功的保存变成失败 */
  async function pruneRevisions(caseId: string): Promise<void> {
    const numbers = (await revisionNumbers(caseId)).sort((a, b) => a - b);
    const stale = numbers.slice(0, Math.max(0, numbers.length - REVISION_KEEP));
    for (const revision of stale) {
      await rm(revisionFilePath(caseId, revision), { force: true }).catch(() => undefined);
    }
  }

  /** 已存在的 id 不做任何处理：显式 id 只校验不重命名，否则历史与报告会对不上 */
  async function resolveTargetId(def: CaseDefinition): Promise<string> {
    if (def.id !== undefined) return requireCaseId(def.id);
    // 缺 id 时由 title 推导 slug。**推导之前必须先过一遍 schema**：title 缺失
    // （或不是字符串）会让 `slugify()` 崩在 `undefined.normalize()` 上，那是个
    // 没有字段路径的 TypeError——表单拿到它不知道该高亮哪一项（`api.md` §1.2），
    // 而 API 层也只能回一句 `Cannot read properties of undefined`。
    // 走 zod 就得到一个带 `path: ["title"]` 的 ZodError，与其他字段的报错形态一致。
    CaseDefinitionSchema.parse(def);
    return allocate(titleToIdBase(def.title));
  }

  /** 从 title 生成不冲突的 id */
  async function allocate(base: string): Promise<string> {
    for (let attempt = 1; attempt <= MAX_ID_ATTEMPTS; attempt++) {
      const suffix = attempt === 1 ? "" : `-${attempt}`;
      const head = base.slice(0, MAX_ID_LENGTH - suffix.length).replace(/-+$/, "");
      const candidate = `${head}${suffix}`;
      if (!CASE_ID_PATTERN.test(candidate)) continue;
      if (!(await pathExists(caseDirPath(candidate)))) return candidate;
    }
    throw new CaseConflict(`无法为 "${base}" 分配用例 id：连续 ${MAX_ID_ATTEMPTS} 个候选都已被占用`);
  }

  // -------------------------------------------------------------------------
  // 列表
  // -------------------------------------------------------------------------

  /**
   * 一次读完 `runs/index.jsonl` 建索引，而不是逐个用例去扫一遍全文。
   *
   * 坏行跳过而不是抛错——与 `core/report.ts` 的 `readIndex()` 同一纪律：
   * 一行坏数据不该让整个列表页打不开。
   */
  async function readLastRuns(): Promise<Map<string, RunIndexEntry>> {
    let text: string;
    try {
      text = await readFile(runsIndexPath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) return new Map(); // 还没跑过任何用例：空表，不是错误
      throw error;
    }
    const latest = new Map<string, RunIndexEntry>();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") continue;
      let entry: RunIndexEntry;
      try {
        entry = JSON.parse(trimmed) as RunIndexEntry;
      } catch {
        continue;
      }
      if (entry === null || typeof entry.caseId !== "string") continue;
      const previous = latest.get(entry.caseId);
      if (previous === undefined || isNewerRun(entry, previous)) latest.set(entry.caseId, entry);
    }
    return latest;
  }

  // -------------------------------------------------------------------------
  // 对外接口
  // -------------------------------------------------------------------------

  async function list(): Promise<CaseSummary[]> {
    const entries = await readdir(root, { withFileTypes: true }).catch((error: unknown) => {
      if (isErrno(error, "ENOENT")) return []; // 用例库还没建：空列表，不是错误
      throw error;
    });
    const lastRuns = await readLastRuns();
    const summaries: CaseSummary[] = [];
    for (const entry of entries) {
      // 目录名就是 id：不满足 CASE_ID_PATTERN 的目录不可能是用例（read() 也会拒绝它）
      if (!entry.isDirectory() || !CASE_ID_PATTERN.test(entry.name)) continue;
      const caseId = entry.name;
      try {
        const stored = await loadStoredCase(caseId);
        const run = lastRuns.get(caseId);
        summaries.push({
          id: caseId,
          title: stored.parsed.title,
          revision: await currentRevision(caseId),
          // digest 取自「默认值已填充的完整 Case」，见文件末尾的实现说明
          digest: caseDigest(stored.parsed),
          savedAt: stored.savedAt,
          lastRun:
            run === undefined
              ? null
              : { runId: run.runId, status: run.status, passed: run.passed, startedAt: run.startedAt },
        });
      } catch {
        // 一个坏用例不该让整个列表页打不开（与 readIndex 同一纪律）：跳过它，其余照常列
        continue;
      }
    }
    return summaries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async function read(caseId: string): Promise<LoadedCase> {
    const id = requireCaseId(caseId);
    // **版本号在内容之前读。** 两者之间若插进一次并发保存，这个顺序只会得到
    // 「内容比版本新」：客户端拿这个 revision 去保存会被乐观锁挡下，要求它重载——
    // 是安全的那一侧。反过来（先读内容、后读版本）会报出一个比内容更新的
    // revision，客户端据此提交就能顺利通过检查，把刚写进去的那一版**悄悄盖掉**，
    // 正是本模块明确拒绝的「静默覆盖」。冲突的代价是让人多点一次，覆盖的代价是丢数据。
    const revision = await currentRevision(id);
    const stored = await loadStoredCase(id);
    return {
      // 返回默认值已填充的形态：表单与程序化调用方拿到的都是可直接使用的完整用例。
      // 它是 `Case`，而 `Case` 满足 `CaseDefinition`（后者字段更宽松），
      // 因此原样回传给 write() 是安全的——写入路径会再校验一次
      def: stored.parsed,
      revision: {
        caseId: id,
        revision,
        digest: caseDigest(stored.parsed),
        savedAt: stored.savedAt,
      },
      yaml: stored.text,
    };
  }

  function write(def: CaseDefinition, writeOptions?: WriteOptions): Promise<CaseRevision> {
    return serialized(async () => {
      const caseId = await resolveTargetId(def);
      return saveCase(caseId, def, writeOptions?.expectedRevision);
    });
  }

  function remove(caseId: string): Promise<void> {
    // 不存在时**幂等返回**，不抛 CaseNotFound：DELETE 的语义是「让它不存在」，
    // 结果已经达成；抛 404 只会逼每个客户端为「双击删除」写一个特例。
    // 用例目录整个删掉——历史快照也属于这个用例，留着等于没删干净。
    return serialized(async () => {
      await rm(caseDirPath(requireCaseId(caseId)), { recursive: true, force: true });
    });
  }

  function importYaml(text: string): Promise<CaseRevision> {
    return serialized(async () => {
      // 导入的文本同样可能是旧版本，所以走与读磁盘完全相同的路径（先迁移再校验）
      const { doc, parsed } = parseCaseDocument(text, "导入的 YAML");
      // **冲突不覆盖**：导入是「加一个用例」，静默覆盖等于数据丢失——所以即便
      // YAML 里写了 id，也要再过一次 allocate()，让它落到 `-2`、`-3` 上。
      // 两个分支都必须是 id 字符串本身：allocate() 是异步的（要探测候选 id 有没有
      // 被占用），漏掉 await 会把一个 Promise 传给下一行，`base.slice()` 当场炸。
      const requested =
        typeof doc.id === "string" ? requireCaseId(doc.id) : titleToIdBase(parsed.title);
      const caseId = await allocate(requested);
      // 传 doc 而不是 parsed，是为了让磁盘上保留下来的仍是用户实际写下的字段
      return saveCase(caseId, doc as unknown as CaseDefinition, undefined);
    });
  }

  async function exportCase(caseId: string): Promise<string> {
    const id = requireCaseId(caseId);
    const stored = await loadStoredCase(id);
    // 与写入共用同一个规范化函数，因此对这个文件来说导出结果与磁盘字节一致，且反复调用不变。
    // id 强制取目录名：手工写的 case.yaml 可能没有 id 字段，而用例的身份就是它的目录
    return stringifyCase(explicitOnly({ ...stored.doc, id }, stored.parsed) as CaseDefinition);
  }

  async function freeze(caseId: string, destination: string, ran?: Case): Promise<CaseRevision> {
    return serialized(async () => {
      const id = requireCaseId(caseId);
      const stored = await loadStoredCase(id);
      // 身份统一取目录名（见 loadStoredCase），digest 才与仓库里的对得上
      const frozen = ran === undefined ? stored.parsed : { ...ran, id };
      const digest = caseDigest(frozen);
      // **冻结写完整的 Case**（默认值一并落盘）：报告是长期留存的物证，
      // 将来改了默认值也不能让旧报告变得无法解释（D13）
      const text = stringifyCase(frozen);
      // destination 是**文件路径**（`runs/<runId>/case.yaml`），不是目录
      await mkdir(dirname(destination), { recursive: true });
      await writeFileAtomic(destination, text);
      return {
        caseId: id,
        revision:
          ran === undefined || caseDigest(stored.parsed) === digest
            ? await currentRevision(id)
            : await revisionWithDigest(id, digest),
        digest,
        savedAt: stored.savedAt,
      };
    });
  }

  /** 从新到旧找 digest 相同的历史版本；找不到返回 0（「对不上任何已保存版本」）。 */
  async function revisionWithDigest(caseId: string, digest: string): Promise<number> {
    const numbers = [...(await revisionNumbers(caseId))].sort((a, b) => b - a);
    for (const n of numbers) {
      try {
        const text = await readFile(revisionFilePath(caseId, n), "utf8");
        const { parsed } = parseCaseDocument(text, revisionFilePath(caseId, n));
        if (caseDigest({ ...parsed, id: caseId }) === digest) return n;
      } catch {
        // 某一版读不出来（手工改坏、迁移失败）不影响继续往前找
      }
    }
    return 0;
  }

  function allocateId(title: string): Promise<string> {
    return serialized(() => allocate(titleToIdBase(title)));
  }

  async function readRevision(caseId: string, revision: number): Promise<string> {
    const id = requireCaseId(caseId);
    if (!Number.isInteger(revision) || revision < 1) {
      throw new CaseNotFound(`用例 "${caseId}" 没有 revision ${revision}：版本号是从 1 开始的整数`);
    }
    const filePath = revisionFilePath(id, revision);
    try {
      return await readFile(filePath, "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) {
        throw new CaseNotFound(`用例 "${caseId}" 没有 revision ${revision}（缺 ${filePath}）`);
      }
      throw error;
    }
  }

  return {
    list,
    read,
    write,
    remove,
    import: importYaml,
    export: exportCase,
    freeze,
    allocateId,
    readRevision,
  };
}

// ---------------------------------------------------------------------------
// 模块私有辅助
// ---------------------------------------------------------------------------

/**
 * 原子写：先写同目录下的临时文件，再 rename 覆盖目标。
 *
 * 同分区上的 rename 是原子的，读者要么看到旧内容、要么看到新内容，
 * 不会看到半截 YAML——而 `case.yaml` 是唯一事实来源，损坏它等于丢掉这个用例。
 *
 * **Windows 的例外**：目标文件被占用时（杀软扫描、搜索索引器、编辑器开着），
 * `rename` 覆盖已存在文件会失败（`EPERM` / `EEXIST` / `EACCES`）。
 * 这是 CI 之外的机器上会偶发的那种失败，不能当成 bug 忽略。
 * 处理方式是先 `rm` 再 `rename`：删掉目标再改名，目标必然是不存在的路径，
 * Windows 对这种情况从不失手。
 *
 * 为什么不用「复制 + 截断」（`open(dest, "w")` 后写入）：那样目标文件在写入过程中
 * 是半截内容，进程这时被杀就留下了损坏的 `case.yaml`，正是本函数要防的事。
 * 而 `rm` 与 `rename` 之间那个极小的窗口，最坏结果是文件**不存在**——
 * 读的时候明确报 `CaseNotFound`，比读出一份看起来正常但内容残缺的 YAML 好得多。
 */
async function writeFileAtomic(destination: string, data: string): Promise<void> {
  // 临时文件与目标同目录（保证同分区），名字带 pid 与序号（同一进程内不撞车）
  const temp = `${destination}.tmp-${process.pid}-${(tempCounter++).toString(36)}`;
  try {
    await writeFile(temp, data, "utf8");
    try {
      await rename(temp, destination);
      return;
    } catch (error) {
      if (!isReplaceBlocked(error)) throw error;
      await rm(destination, { force: true });
      await rename(temp, destination);
    }
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined); // 失败的残骸不留在用例目录里
    throw error;
  }
}

let tempCounter = 0;

/** Windows 上「目标已存在且被占用」时 rename 的失败码 */
function isReplaceBlocked(error: unknown): boolean {
  return isErrno(error, "EPERM") || isErrno(error, "EEXIST") || isErrno(error, "EACCES");
}

/**
 * 只保留 `input` 里实际写出来的字段，值取 `parsed`（已校验、已填默认值）里的对应项。
 *
 * 两个目的：默认值不落盘（默认值留在代码里，改默认值能作用于全部用例），
 * 而**未知键也不会被写进唯一事实来源**——zod 会把它们剥掉，但那是 `parsed` 的事，
 * 直接序列化原始输入就会把 `budget: {whatever: 1}` 这类东西留在文件里。
 */
function explicitOnly(input: unknown, parsed: unknown): unknown {
  if (!isPlainObject(input) || !isPlainObject(parsed)) return parsed;
  const out: PlainObject = {};
  for (const [key, value] of Object.entries(input)) {
    if (value === undefined) continue; // YAML 里不写 undefined
    if (!(key in parsed)) continue;
    out[key] = explicitOnly(value, parsed[key]);
  }
  return out;
}

/**
 * title → id 的基底。
 *
 * `slugify()` 对中文标题可能返回空串或非 ASCII，因此这里再兜一层；
 * `CASE_ID_PATTERN` 要求至少 2 个字符，单字符会给它补一段后缀。
 */
function titleToIdBase(title: string): string {
  let base = slugify(title)
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "");
  if (base.length > MAX_ID_LENGTH) base = base.slice(0, MAX_ID_LENGTH).replace(/-+$/, "");
  if (base.length === 0) base = "case"; // 中文、emoji 标题会走到这里
  if (base.length < 2) base = `${base}-case`;
  return base;
}

/**
 * id 直接参与拼路径，因此每个入口都要过这一关。
 *
 * 除了挡路径穿越（`../`、反斜杠），它也是 `case-format.md` 定义的合法形态：
 * 用例库只承认合法的用例，别的目录（`node_modules` 之类）不该被当成用例。
 */
function requireCaseId(caseId: string): string {
  if (!CASE_ID_PATTERN.test(caseId)) {
    throw new CaseNotFound(
      `用例 id "${caseId}" 不合法：应为 ^[a-z0-9][a-z0-9-]{1,63}$` +
        `（小写字母、数字与连字符，不以连字符开头）`,
    );
  }
  return caseId;
}

/** `index.jsonl` 里哪个更「近」：按 `startedAt` 比，时间相等的以后出现的那行为准 */
function isNewerRun(candidate: RunIndexEntry, previous: RunIndexEntry): boolean {
  const a = Date.parse(candidate.startedAt);
  const b = Date.parse(previous.startedAt);
  if (Number.isNaN(a)) return false;
  if (Number.isNaN(b)) return true;
  return a >= b; // 相等时用后者：runner 追加的顺序就是完成顺序
}

function isPlainObject(value: unknown): value is PlainObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function describeType(value: unknown): string {
  if (value === null) return "null";
  return Array.isArray(value) ? "数组" : typeof value;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as NodeJS.ErrnoException).code === code;
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// 实现说明（把文件头的三个决定落到具体位置）
// ---------------------------------------------------------------------------
//
// 写入路径（三条入口共用，这是「唯一事实来源」的落点）：
//   1. CaseDefinitionSchema.parse()                —— 服务端永远重新校验
//   2. 分配或校验 id（显式 id 只校验；缺省时 slug + `-2`、`-3`）
//   3. toYamlObject() -> yaml.stringify()          —— 规范化，保证往返幂等
//   4. caseDigest()
//   5. 新 revision = max(revisions/*.yaml) + 1     —— 从目录推导，不维护计数器
//   6. 写 revisions/NNNN.yaml（临时文件 + rename）
//   7. 写 case.yaml（临时文件 + rename）
//   8. 清理超出 REVISION_KEEP 的旧快照
//
// 读路径：case.yaml -> yaml.parse -> migrateCaseDocument() -> CaseDefinitionSchema.parse()
//
// 四处文档没写死、由本实现定下的判断：
//
// **① digest 的取值域是「默认值已填充的完整 Case」，不是磁盘上的最小形式。**
// 于是同一个用例版本在 write() / read() / freeze() 三处得到同一个 digest，
// 报告里的 caseDigest 才能与用例库里的 digest 直接比对。
// 代价：`case.yaml` 本身是最小形式，它的文件字节的 sha256 不等于 digest；
// 与 digest 逐字节对应的只有冻结快照（`stringifyCase(Case)`）。
//
// **② 磁盘上只写用户显式设置的部分，冻结快照写完整的 Case。**
// 前者让默认值留在代码里（改一次作用于全部用例），后者固定住「当时实际用的值」，
// 于是旧报告永远可解释（D13）。两者的分工写在 `schema/yaml.ts` 的文件头。
//
// **③ remove() 对不存在的用例幂等返回**，不抛 CaseNotFound——理由见方法上的注释。
//
// **④ list() 的 lastRun 走一次 `index.jsonl` 全量读取建索引**（`Map<caseId, RunIndexEntry>`），
// 而不是每个用例去扫一遍运行历史；index 不存在时返回空表而非报错。

