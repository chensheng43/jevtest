/**
 * `src/store/cases.ts` 的行为测试。
 *
 * 这个模块是 D5「YAML 是唯一事实来源」的落点，因此这里的断言不是「函数返回对了」
 * 那么简单，而是**磁盘上长什么样**：版本号从哪来、冲突时字节有没有被动过、
 * 导入有没有覆盖既有文件、写坏一次会不会留下半截 YAML。
 * 所以每个测试都真的建一个临时用例库、真的读写文件，而不是打桩。
 *
 * 不调用付费 API、不访问外网、不启动浏览器。
 */

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, it } from "node:test";
import type { TestContext } from "node:test";

import { parse as parseYaml } from "yaml";
import { ZodError } from "zod";

import { CaseDefinitionSchema } from "../src/schema/case.ts";
import type { Case, CaseDefinition } from "../src/schema/case.ts";
import type { RunIndexEntry } from "../src/schema/report.ts";
import { caseDigest } from "../src/schema/yaml.ts";
import { MigrationError } from "../src/store/migrations.ts";
import {
  CASE_ID_PATTERN,
  CaseConflict,
  CaseNotFound,
  REVISION_KEEP,
  createCaseStore,
} from "../src/store/cases.ts";
import type { CaseStore } from "../src/store/cases.ts";

// ---------------------------------------------------------------------------
// 夹具
// ---------------------------------------------------------------------------

interface Library {
  /** 临时根目录。casesDir 与 runsDir 都在它下面，测试结束整个删掉 */
  base: string;
  casesDir: string;
  runsDir: string;
  store: CaseStore;
}

/**
 * 每个测试一个独立的用例库。
 *
 * 刻意**不**共享夹具：本模块几乎每个断言都是「磁盘上现在是什么」，
 * 共享状态会让测试之间通过残留文件互相影响，而那种失败极难定位。
 */
async function makeLibrary(t: TestContext): Promise<Library> {
  const base = await mkdtemp(join(tmpdir(), "jevtest-cases-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const casesDir = join(base, "cases");
  const runsDir = join(base, "runs");
  return { base, casesDir, runsDir, store: createCaseStore({ root: casesDir, runsDir }) };
}

/** 最小合法用例。默认值（mode / budget / assertions）全部留给 schema 填。 */
function definition(overrides: Partial<CaseDefinition> = {}): CaseDefinition {
  return {
    title: "Flights from Zurich",
    goal: "查询苏黎世到巴塞罗那的航班",
    startUrl: "https://example.com/travel",
    ...overrides,
  };
}

/** 用例目录里的当前版本文件 */
function caseFile(lib: Library, caseId: string): string {
  return join(lib.casesDir, caseId, "case.yaml");
}

/** 用例目录里的历史快照目录 */
function revisionsDir(lib: Library, caseId: string): string {
  return join(lib.casesDir, caseId, "revisions");
}

async function readTextOrNull(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return null;
  }
}

/** 目录里的名字，排好序；目录不存在时返回空数组而不是抛错 */
async function listNames(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true }).catch(() => []);
  return entries.map((entry) => entry.name).sort();
}

async function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/**
 * 拼一份合法的用例 YAML。
 *
 * 值一律走 `JSON.stringify`：YAML 是 JSON 的超集，这样带冒号、带中文、
 * 带引号的值都不用手工转义，测试里不会出现「因为 YAML 引号写错而失败」的噪声。
 */
function yamlDocument(fields: Record<string, string>): string {
  const lines = Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`);
  return `${lines.join("\n")}\n`;
}

/** 一条 `runs/index.jsonl` 记录。字段齐全是刻意的：读端不该依赖缺字段的行 */
function indexEntry(overrides: Partial<RunIndexEntry> & { caseId: string }): RunIndexEntry {
  return {
    runId: "run-1",
    caseTitle: "Flights from Zurich",
    suiteRunId: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    status: "done",
    passed: true,
    elapsedMs: 1000,
    steps: 3,
    costUsd: null,
    ...overrides,
  };
}

/** 一次远端调用失败时拿到的错误对象；成功时返回 null */
async function rejection<T>(promise: Promise<T>): Promise<unknown> {
  return promise.then(
    () => null,
    (error: unknown) => error,
  );
}

// ---------------------------------------------------------------------------
// 写入与读回
// ---------------------------------------------------------------------------

describe("写入与读回", () => {
  it("新建用例得到 revision 1，read 能读回同一份内容", async (t) => {
    const lib = await makeLibrary(t);

    const written = await lib.store.write(definition({ id: "flights" }));
    assert.equal(written.caseId, "flights");
    assert.equal(written.revision, 1);

    const loaded = await lib.store.read("flights");
    assert.equal(loaded.revision.caseId, "flights");
    assert.equal(loaded.revision.revision, 1);
    assert.equal(loaded.def.id, "flights");

    // 默认值已填充：运行时只消费 `Case`，不该到处写 `?? 默认值`。
    // 注意 `LoadedCase.def` 的静态类型是宽松的 `CaseDefinition`（字段可选），
    // 而运行时的值是按 `read()` 的注释承诺的完整 `Case`——这里就按实际形态断言。
    const full = loaded.def as Case;
    assert.equal(full.mode, "interactive");
    assert.equal(full.budget.maxModelCalls, 40);
    assert.equal(full.budget.maxCostUsd, null);
    assert.equal(full.allowedOrigins[0], "https://example.com");

    // yaml 字段是磁盘上的原始文本，不是重新序列化的结果（编辑器要显示的就是它）
    assert.equal(loaded.yaml, await readFile(caseFile(lib, "flights"), "utf8"));

    // write() 与 read() 必须给出同一个 digest，否则报告里的 caseDigest 无法与用例库比对
    assert.equal(loaded.revision.digest, caseDigest(loaded.def));
    assert.equal(written.digest, loaded.revision.digest);
  });

  it("连续写入 revision 从 1 递增，每次都留下快照", async (t) => {
    const lib = await makeLibrary(t);

    const revisions = [
      await lib.store.write(definition({ id: "flights" })),
      await lib.store.write(definition({ id: "flights", goal: "改过的目标" })),
      await lib.store.write(definition({ id: "flights", goal: "再改一次" })),
    ];
    assert.deepEqual(
      revisions.map((revision) => revision.revision),
      [1, 2, 3],
    );
    assert.equal((await lib.store.read("flights")).revision.revision, 3);
    assert.deepEqual(await listNames(revisionsDir(lib, "flights")), [
      "0001.yaml",
      "0002.yaml",
      "0003.yaml",
    ]);
  });

  it("磁盘上只写用户显式设置的部分，默认值留在代码里", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    const text = await readFile(caseFile(lib, "flights"), "utf8");
    // budget 只该出现用户没写的那些键的「无」，不该出现默认值
    assert.ok(!text.includes("maxModelCalls"), `默认值不该落盘：\n${text}`);
    assert.ok(!text.includes("maxElapsedMs"), `默认值不该落盘：\n${text}`);
    assert.ok(!text.includes("interactive"), `默认值不该落盘：\n${text}`);
    assert.ok(!text.includes("allowedOrigins"), `推导值不该落盘：\n${text}`);
    // 用户写下的字段一个都不能丢
    assert.ok(text.includes("https://example.com/travel"));
  });

  it("未知字段不会进入唯一事实来源", async (t) => {
    const lib = await makeLibrary(t);
    const polluted = {
      ...definition({ id: "flights" }),
      budget: { maxSteps: 7, nonsense: 1 },
      whatever: true,
    } as unknown as CaseDefinition;

    await lib.store.write(polluted);

    const text = await readFile(caseFile(lib, "flights"), "utf8");
    assert.ok(text.includes("maxSteps: 7"), `显式字段必须保留：\n${text}`);
    assert.ok(!text.includes("nonsense"), `未知键不该落盘：\n${text}`);
    assert.ok(!text.includes("whatever"), `未知键不该落盘：\n${text}`);
  });

  it("写坏输入时磁盘上什么都不留下", async (t) => {
    const lib = await makeLibrary(t);
    const before = await listNames(lib.casesDir);

    const error = await rejection(
      lib.store.write({ title: "Bad", goal: "g", startUrl: "ftp://example.com" } as CaseDefinition),
    );
    assert.ok(error instanceof ZodError, `应当是校验错误，实际是 ${String(error)}`);
    assert.deepEqual(await listNames(lib.casesDir), before);
  });

  it("白名单不含 startUrl 的 origin 时拒绝保存", async (t) => {
    const lib = await makeLibrary(t);
    const error = await rejection(
      lib.store.write(definition({ id: "flights", allowedOrigins: ["https://other.example"] })),
    );
    assert.ok(error instanceof ZodError);
    assert.ok(
      error.issues.some((issue) => issue.path[0] === "allowedOrigins"),
      "跨字段规则必须报在 allowedOrigins 上，表单才知道高亮哪一项",
    );
    assert.equal(await pathExists(join(lib.casesDir, "flights")), false);
  });

  it("缺 title 时抛带字段路径的校验错误，而不是 TypeError", async (t) => {
    const lib = await makeLibrary(t);

    // id 缺省时由 title 推导 slug，因此 title 缺失会让 slugify 崩在字符串方法上。
    // 那种 TypeError 没有字段路径，表单不知道该高亮哪一项（`api.md` §1.2），
    // 所以校验必须发生在 id 分配之前。
    const error = await rejection(
      lib.store.write({ goal: "g", startUrl: "https://example.com" } as unknown as CaseDefinition),
    );

    assert.ok(
      error instanceof ZodError,
      `应当是 ZodError（带 issue 路径），实际是 ${(error as Error | null)?.name ?? "成功"}: ${String(error)}`,
    );
    assert.ok(error.issues.some((issue) => issue.path[0] === "title"));
    assert.deepEqual(await listNames(lib.casesDir), []);
  });

  it("读不存在的用例抛 CaseNotFound（对应 HTTP 404）", async (t) => {
    const lib = await makeLibrary(t);
    await assert.rejects(() => lib.store.read("ghost"), CaseNotFound);
  });

  it("非法 id 被路径校验拦下，不会拼出目录穿越的路径", async (t) => {
    const lib = await makeLibrary(t);
    // 用例库外面放一个文件，确认它没有被误伤
    const outsider = join(lib.base, "outsider.yaml");
    await writeFile(outsider, "keep me", "utf8");

    for (const bad of ["../outsider", "a/b", "..", "UPPER", "-leading", "a"]) {
      await assert.rejects(() => lib.store.read(bad), CaseNotFound, `id ${bad} 应当被拒绝`);
      await assert.rejects(() => lib.store.remove(bad), CaseNotFound, `id ${bad} 应当被拒绝`);
    }
    assert.equal(await readTextOrNull(outsider), "keep me");
  });
});

// ---------------------------------------------------------------------------
// revision 从目录推导
// ---------------------------------------------------------------------------

describe("revision 从 revisions/ 目录推导，不维护计数器文件", () => {
  it("用例目录里只有 case.yaml 与 revisions/，没有计数器也没有临时文件", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    await lib.store.write(definition({ id: "flights", goal: "再存一次" }));

    assert.deepEqual(await listNames(join(lib.casesDir, "flights")), ["case.yaml", "revisions"]);
  });

  it("删掉最新快照后，读到的 revision 跟着回落", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    await lib.store.write(definition({ id: "flights", goal: "第二版" }));
    await lib.store.write(definition({ id: "flights", goal: "第三版" }));
    assert.equal((await lib.store.read("flights")).revision.revision, 3);

    await rm(join(revisionsDir(lib, "flights"), "0003.yaml"));

    // 目录就是事实：没有计数器可以漂移
    assert.equal((await lib.store.read("flights")).revision.revision, 2);
  });

  it("快照目录里的杂物不被当成版本", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    const dir = revisionsDir(lib, "flights");
    // 写坏留下的临时文件、手工放的说明文件，都不该把 revision 顶上去
    await writeFile(join(dir, "0009.yaml.tmp-1-0"), "半截", "utf8");
    await writeFile(join(dir, "notes.txt"), "随手记", "utf8");
    await writeFile(join(dir, "9.yaml"), "位数不够", "utf8");

    assert.equal((await lib.store.read("flights")).revision.revision, 1);
    // 下一次保存仍然接在 1 后面，不跳号
    const next = await lib.store.write(definition({ id: "flights", goal: "第二版" }));
    assert.equal(next.revision, 2);
  });

  it("手工放进用例库的用例 revision 为 0，保存后从 1 开始", async (t) => {
    const lib = await makeLibrary(t);
    await mkdir(join(lib.casesDir, "handwritten"), { recursive: true });
    await writeFile(
      join(lib.casesDir, "handwritten", "case.yaml"),
      yamlDocument({ title: "手工写的", goal: "g", startUrl: "https://example.com" }),
      "utf8",
    );

    const loaded = await lib.store.read("handwritten");
    assert.equal(loaded.revision.revision, 0);
    // id 取目录名：手工写的文件里没有 id 字段，用例的身份就是它的目录。
    // 若让 schema 的 slug 兜底值漏出来，`read().def.id` 会是个与目录无关的
    // `case-<hash>`，接着就会出下面这条断言防的事。
    assert.equal(loaded.def.id, "handwritten");

    // **把读回来的 def 存回去，必须落在同一个用例上。**
    // 表单就是这个用法：id 若与目录名对不上，write() 会走「显式 id 只校验不重命名」
    // 那条路，于是不是更新原用例，而是凭空多出一个用例，原文件永远停在旧内容上。
    const written = await lib.store.write({ ...loaded.def, goal: "改过之后" });
    assert.equal(written.caseId, "handwritten");
    assert.equal(written.revision, 1);
    assert.deepEqual(await listNames(lib.casesDir), ["handwritten"]);
    assert.ok((await readFile(caseFile(lib, "handwritten"), "utf8")).includes("改过之后"));
  });

  it("超过 REVISION_KEEP 的旧快照被清理，新的全部保留", async (t) => {
    const lib = await makeLibrary(t);
    const total = REVISION_KEEP + 5;
    for (let index = 0; index < total; index++) {
      await lib.store.write(definition({ id: "flights", goal: `第 ${index} 次` }));
    }

    const names = await listNames(revisionsDir(lib, "flights"));
    assert.equal(names.length, REVISION_KEEP);
    assert.equal(names[0], "0006.yaml"); // 0001..0005 被清掉
    assert.equal(names[names.length - 1], `${String(total).padStart(4, "0")}.yaml`);

    // 当前版本号仍然是总保存次数——清理的是快照，不是版本计数
    assert.equal((await lib.store.read("flights")).revision.revision, total);

    // 被清掉的历史确实回读不到了
    await assert.rejects(() => lib.store.readRevision("flights", 1), CaseNotFound);
    assert.ok((await lib.store.readRevision("flights", 6)).includes("第 5 次"));
  });
});

// ---------------------------------------------------------------------------
// 乐观锁
// ---------------------------------------------------------------------------

describe("乐观锁（expectedRevision）", () => {
  it("expectedRevision 为 0（新建）而 id 已存在时拒绝，不静默覆盖", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights", goal: "原来的" }));

    const error = await rejection(lib.store.write(definition({ id: "flights", goal: "重名新建" }), { expectedRevision: 0 }));
    assert.ok(error instanceof CaseConflict);
    assert.match(error.message, /已存在/);
    assert.ok(!(await readFile(caseFile(lib, "flights"), "utf8")).includes("重名新建"));
  });

  it("expectedRevision 与磁盘一致时写入成功", async (t) => {
    const lib = await makeLibrary(t);
    const first = await lib.store.write(definition({ id: "flights" }));

    const second = await lib.store.write(definition({ id: "flights", goal: "基于最新版改的" }), {
      expectedRevision: first.revision,
    });
    assert.equal(second.revision, 2);
  });

  it("不匹配时抛 CaseConflict，消息含当前 revision，且磁盘一个字节都没动", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    await lib.store.write(definition({ id: "flights", goal: "第二版" }));

    const beforeText = await readFile(caseFile(lib, "flights"), "utf8");
    const beforeSnapshots = await listNames(revisionsDir(lib, "flights"));

    const error = await rejection(
      lib.store.write(definition({ id: "flights", goal: "从陈旧副本改的" }), {
        expectedRevision: 1, // 磁盘上已经是 2
      }),
    );

    assert.ok(error instanceof CaseConflict, `应当是 CaseConflict，实际是 ${String(error)}`);
    const message = (error as Error).message;
    assert.match(message, /revision 2/, "消息里要带当前 revision，界面才知道提示什么");
    assert.match(message, /revision 1/, "也要带请求基于的 revision");

    // 冲突不是「写了一半失败」：磁盘必须完全没被碰过
    assert.equal(await readFile(caseFile(lib, "flights"), "utf8"), beforeText);
    assert.deepEqual(await listNames(revisionsDir(lib, "flights")), beforeSnapshots);
    assert.equal((await lib.store.read("flights")).revision.revision, 2);
  });

  it("冲突之后用正确的 revision 重试仍然成功", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    await assert.rejects(
      () => lib.store.write(definition({ id: "flights" }), { expectedRevision: 7 }),
      CaseConflict,
    );
    const retried = await lib.store.write(definition({ id: "flights", goal: "重试成功" }), {
      expectedRevision: 1,
    });
    assert.equal(retried.revision, 2);
  });

  it("给还不存在的用例带上 expectedRevision 也不会凭空建目录", async (t) => {
    const lib = await makeLibrary(t);

    await assert.rejects(
      () => lib.store.write(definition({ id: "ghost" }), { expectedRevision: 1 }),
      CaseConflict,
    );
    assert.equal(await pathExists(join(lib.casesDir, "ghost")), false);
  });

  it("不带 expectedRevision 时不做检查（CLI 全量覆盖的用法）", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    const second = await lib.store.write(definition({ id: "flights", goal: "直接覆盖" }));
    assert.equal(second.revision, 2);
  });

  it("兼容并发保存：同一个 expectedRevision 只会有一次成功，另一次明确报冲突", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    // 两个标签页同时提交——这正是「写串行化 + 乐观锁」要挡的场景。
    // 只有乐观锁、没有串行化时，两次都会读到 current=1、都通过检查、都写 revision 2：
    // 后写的静默盖掉先写的，而用户要到很久以后发现改动消失才知道出了事。
    const settled = await Promise.allSettled([
      lib.store.write(definition({ id: "flights", goal: "标签页 A" }), { expectedRevision: 1 }),
      lib.store.write(definition({ id: "flights", goal: "标签页 B" }), { expectedRevision: 1 }),
    ]);

    const fulfilled = settled.filter((result) => result.status === "fulfilled");
    const rejected = settled.filter((result) => result.status === "rejected");
    assert.equal(fulfilled.length, 1, "恰好一次成功");
    assert.equal(rejected.length, 1, "另一次必须明确报冲突，而不是静默覆盖");

    const failure = rejected[0];
    assert.ok(failure !== undefined);
    assert.ok(failure.reason instanceof CaseConflict, `实际是 ${String(failure.reason)}`);

    // 版本只前进一格，快照也只有两份——没有两次保存挤进同一个 revision
    assert.equal((await lib.store.read("flights")).revision.revision, 2);
    assert.deepEqual(await listNames(revisionsDir(lib, "flights")), ["0001.yaml", "0002.yaml"]);
  });

  it("载荷不合法时报校验错误，而不是把陈旧的 revision 报成冲突", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    await lib.store.write(definition({ id: "flights", goal: "第二版" }));

    // 字段不合法 + revision 也陈旧：两处检查都不碰磁盘，先后只决定报哪个错误码。
    // 报 409「重新加载后再改」会把人绕进去——重新加载并不会让那个字段变合法，
    // 用户只会一圈圈重试；要报的应该是 400（带 issue 路径的那个）。
    const error = await rejection(
      lib.store.write(
        { id: "flights", goal: "g", startUrl: "ftp://example.com" } as CaseDefinition,
        { expectedRevision: 1 },
      ),
    );
    assert.ok(error instanceof ZodError, `应当是 ZodError，实际是 ${String(error)}`);

    // 该报冲突的时候照样报
    await assert.rejects(
      () => lib.store.write(definition({ id: "flights" }), { expectedRevision: 1 }),
      CaseConflict,
    );
  });
});

// ---------------------------------------------------------------------------
// 导入
// ---------------------------------------------------------------------------

describe("从 YAML 导入", () => {
  it("缺 id 时由 title 推导 slug", async (t) => {
    const lib = await makeLibrary(t);

    const revision = await lib.store.import(
      yamlDocument({ title: "Flights from Zurich", goal: "g", startUrl: "https://example.com" }),
    );

    assert.equal(revision.caseId, "flights-from-zurich");
    assert.equal(revision.revision, 1);
    assert.equal((await lib.store.read("flights-from-zurich")).def.id, "flights-from-zurich");
  });

  it("id 冲突时追加 -2、-3，不覆盖既有用例", async (t) => {
    const lib = await makeLibrary(t);
    const doc = yamlDocument({
      id: "flights",
      title: "Flights from Zurich",
      goal: "第一次导入",
      startUrl: "https://example.com",
    });

    const imported = [
      await lib.store.import(doc),
      await lib.store.import(doc),
      await lib.store.import(doc),
    ];
    assert.deepEqual(
      imported.map((revision) => revision.caseId),
      ["flights", "flights-2", "flights-3"],
    );
    // 每一次都是新用例的第 1 版，不是往既有用例上叠
    assert.deepEqual(
      imported.map((revision) => revision.revision),
      [1, 1, 1],
    );

    // 既有用例原封不动
    const original = await lib.store.read("flights");
    assert.ok(original.yaml.includes("第一次导入"));
    assert.equal(original.revision.revision, 1);
    assert.equal((await lib.store.read("flights-2")).def.title, "Flights from Zurich");
  });

  it("id 冲突时也不会碰既有用例的磁盘内容", async (t) => {
    const lib = await makeLibrary(t);
    const doc = yamlDocument({
      id: "flights",
      title: "F",
      goal: "原始版本",
      startUrl: "https://example.com",
    });
    await lib.store.import(doc);

    const beforeText = await readFile(caseFile(lib, "flights"), "utf8");
    const beforeSnapshots = await listNames(revisionsDir(lib, "flights"));

    await lib.store.import(doc);

    assert.equal(await readFile(caseFile(lib, "flights"), "utf8"), beforeText);
    assert.deepEqual(await listNames(revisionsDir(lib, "flights")), beforeSnapshots);
  });

  it("导入的 YAML 同样要过校验，失败时不留痕", async (t) => {
    const lib = await makeLibrary(t);

    const error = await rejection(
      lib.store.import(yamlDocument({ title: "x", goal: "g", startUrl: "ftp://example.com" })),
    );
    // 抛原始 ZodError 而不是包一层 CaseNotFound：POST 侧要拿 issue 路径去高亮字段
    assert.ok(error instanceof ZodError);
    assert.deepEqual(await listNames(lib.casesDir), []);
  });

  it("导入时非法 id 被拒绝，且报在 id 字段上", async (t) => {
    const lib = await makeLibrary(t);
    const error = await rejection(
      lib.store.import(
        yamlDocument({ id: "Bad Id", title: "x", goal: "g", startUrl: "https://example.com" }),
      ),
    );
    // 先过 schema 再谈路径安全：坏 id 要以带 issue 路径的 ZodError 回给表单，
    // 而不是一个没有字段信息的 404
    assert.ok(error instanceof ZodError);
    assert.ok(error.issues.some((issue) => issue.path[0] === "id"));
    assert.deepEqual(await listNames(lib.casesDir), []);
  });

  it("导入保留下来的仍是用户实际写下的字段，不落默认值", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.import(
      yamlDocument({ id: "flights", title: "F", goal: "g", startUrl: "https://example.com" }),
    );

    const text = await readFile(caseFile(lib, "flights"), "utf8");
    assert.ok(!text.includes("maxModelCalls"), `默认值不该落盘：\n${text}`);
  });
});

// ---------------------------------------------------------------------------
// freeze
// ---------------------------------------------------------------------------

describe("freeze 冻结用例到运行目录", () => {
  it("destination 是文件路径，父目录会被创建", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    const destination = join(lib.runsDir, "run-20260101-abcdef", "case.yaml");
    await lib.store.freeze("flights", destination);

    assert.ok((await stat(destination)).isFile(), "destination 是文件路径，不是目录");
    assert.ok((await stat(dirname(destination))).isDirectory());
    // 目录里只有这一个文件，没有把 case.yaml 当目录使唤的痕迹
    assert.deepEqual(await listNames(dirname(destination)), ["case.yaml"]);
  });

  it("写的是完整的 Case（默认值一并落盘），digest 与冻结字节一致", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    const destination = join(lib.runsDir, "run-1", "case.yaml");
    const frozen = await lib.store.freeze("flights", destination);

    const bytes = await readFile(destination, "utf8");
    // D13：报告是长期留存的物证，将来改了默认值也不能让旧报告变得无法解释
    assert.ok(bytes.includes("maxModelCalls: 40"), `冻结快照要写默认值：\n${bytes}`);
    assert.ok(bytes.includes("mode: interactive"), `冻结快照要写默认值：\n${bytes}`);
    assert.ok(bytes.includes("allowedOrigins"), `冻结快照要写推导值：\n${bytes}`);

    // digest 就是这份冻结字节的 sha256，报告里的 caseDigest 因此能直接校验
    assert.equal(frozen.digest, createHash("sha256").update(bytes, "utf8").digest("hex"));
    // 也与「冻结文件重新解析出来的 Case」一致
    assert.equal(frozen.digest, caseDigest(CaseDefinitionSchema.parse(parseYaml(bytes))));

    assert.equal(frozen.caseId, "flights");
    assert.equal(frozen.revision, (await lib.store.read("flights")).revision.revision);
  });

  it("覆盖已有快照时不留临时文件", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    const destination = join(lib.runsDir, "run-1", "case.yaml");
    await lib.store.freeze("flights", destination);

    await lib.store.write(definition({ id: "flights", goal: "改过之后冻结" }));
    await lib.store.freeze("flights", destination);

    assert.deepEqual(await listNames(dirname(destination)), ["case.yaml"]);
    assert.ok((await readFile(destination, "utf8")).includes("改过之后冻结"));
  });

  it("给了实际跑的 Case：冻结它而不是仓库当前版本，revision 按 digest 反查", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights", goal: "入队时的目标" }));
    // 入队时读到的那份（r1），随后用户在界面上改了用例（r2），运行才结束
    const ran = CaseDefinitionSchema.parse((await lib.store.read("flights")).def);
    await lib.store.write(definition({ id: "flights", goal: "运行途中改过" }), { expectedRevision: 1 });

    const destination = join(lib.runsDir, "run-1", "case.yaml");
    const frozen = await lib.store.freeze("flights", destination, ran);

    const bytes = await readFile(destination, "utf8");
    assert.ok(bytes.includes("入队时的目标"), `快照必须是实际跑的那份：\n${bytes}`);
    assert.ok(!bytes.includes("运行途中改过"));
    assert.equal(frozen.revision, 1, "revision 要指回实际跑的那一版，不是仓库此刻的 r2");
    assert.equal(frozen.digest, caseDigest(ran));
  });

  it("实际跑的 Case 对不上任何已保存版本时 revision 记 0", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    const ran = CaseDefinitionSchema.parse(definition({ id: "flights", goal: "从没保存过的内容" }));

    const frozen = await lib.store.freeze("flights", join(lib.runsDir, "run-1", "case.yaml"), ran);
    assert.equal(frozen.revision, 0);
    assert.equal(frozen.digest, caseDigest(ran));
  });

  it("冻结不存在的用例抛 CaseNotFound", async (t) => {
    const lib = await makeLibrary(t);
    await assert.rejects(
      () => lib.store.freeze("ghost", join(lib.runsDir, "run-1", "case.yaml")),
      CaseNotFound,
    );
    // 失败时不该留下一个空的 run 目录
    assert.equal(await pathExists(join(lib.runsDir, "run-1")), false);
  });
});

// ---------------------------------------------------------------------------
// allocateId
// ---------------------------------------------------------------------------

describe("allocateId", () => {
  it("从 title 生成合法 id，且不与已存在的用例冲突", async (t) => {
    const lib = await makeLibrary(t);

    const first = await lib.store.allocateId("Flights from Zurich");
    assert.match(first, CASE_ID_PATTERN);
    assert.equal(first, "flights-from-zurich");
    // 还只是分配，不该在磁盘上留下东西
    assert.deepEqual(await listNames(lib.casesDir), []);

    await lib.store.write(definition({ id: first }));
    const second = await lib.store.allocateId("Flights from Zurich");
    assert.equal(second, "flights-from-zurich-2");
    assert.match(second, CASE_ID_PATTERN);
  });

  it("中文标题也能得到合法且稳定的 id", async (t) => {
    const lib = await makeLibrary(t);

    const id = await lib.store.allocateId("查询苏黎世到巴塞罗那的航班");
    assert.match(id, CASE_ID_PATTERN, "slug 归零时要兜底，否则 id 不合法");
    // 同一个 title 必须总是同一个 id，否则每次保存都会新建一个用例、revision 历史断掉
    assert.equal(await lib.store.allocateId("查询苏黎世到巴塞罗那的航班"), id);
  });

  it("超长标题不会产出超长 id", async (t) => {
    const lib = await makeLibrary(t);

    const id = await lib.store.allocateId("a".repeat(200));
    assert.match(id, CASE_ID_PATTERN);
    assert.ok(id.length <= 64, `id 最长 64，实际 ${id.length}`);

    // 截断之后仍然要能继续追加后缀
    await lib.store.write(definition({ id }));
    assert.match(await lib.store.allocateId("a".repeat(200)), CASE_ID_PATTERN);
  });

  it("缺省 id 的写入用分配出来的 id，写进文件里的也是它", async (t) => {
    const lib = await makeLibrary(t);

    const written = await lib.store.write(definition({ title: "Flights from Zurich" }));
    assert.equal(written.caseId, "flights-from-zurich");
    assert.ok((await readFile(caseFile(lib, written.caseId), "utf8")).includes("id: flights-from-zurich"));
  });
});

// ---------------------------------------------------------------------------
// readRevision
// ---------------------------------------------------------------------------

describe("readRevision 回读历史版本", () => {
  it("返回的就是当次写入的字节", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights", goal: "第一版" }));
    const firstSnapshot = await readFile(join(revisionsDir(lib, "flights"), "0001.yaml"), "utf8");
    await lib.store.write(definition({ id: "flights", goal: "第二版" }));

    const history = await lib.store.readRevision("flights", 1);
    assert.equal(history, firstSnapshot);
    assert.ok(history.includes("第一版"));
    assert.ok(!history.includes("第二版"));

    // 最新一份快照与当前版本文件字节相同
    assert.equal(
      await lib.store.readRevision("flights", 2),
      await readFile(caseFile(lib, "flights"), "utf8"),
    );
  });

  it("没有的版本号抛 CaseNotFound", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    for (const revision of [0, -1, 1.5, 99]) {
      await assert.rejects(
        () => lib.store.readRevision("flights", revision),
        CaseNotFound,
        `revision ${revision} 应当被拒绝`,
      );
    }
  });

  it("不存在的用例同样抛 CaseNotFound", async (t) => {
    const lib = await makeLibrary(t);
    await assert.rejects(() => lib.store.readRevision("ghost", 1), CaseNotFound);
  });
});

// ---------------------------------------------------------------------------
// export
// ---------------------------------------------------------------------------

describe("export 导出规范化 YAML", () => {
  it("两次导出字节完全一致", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    const first = await lib.store.export("flights");
    const second = await lib.store.export("flights");
    assert.equal(first, second);
  });

  it("导出 → 导入 → 再导出，两份 YAML 只差 id 一行", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    const exported = await lib.store.export("flights");
    const imported = await lib.store.import(exported);
    assert.equal(imported.caseId, "flights-2");

    const reExported = await lib.store.export(imported.caseId);
    const normalize = (text: string): string => text.replace(/^id: .*$/m, "id: <id>");
    assert.equal(normalize(reExported), normalize(exported));
  });

  it("导出不存在的用例抛 CaseNotFound", async (t) => {
    const lib = await makeLibrary(t);
    await assert.rejects(() => lib.store.export("ghost"), CaseNotFound);
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe("list", () => {
  it("用例库还不存在时返回空列表而不是报错", async (t) => {
    const lib = await makeLibrary(t);
    // casesDir 从未创建
    assert.deepEqual(await lib.store.list(), []);
  });

  it("按 savedAt 倒序", async (t) => {
    const lib = await makeLibrary(t);
    for (const id of ["alpha", "beta", "gamma"]) {
      await lib.store.write(definition({ id, title: id.toUpperCase() }));
    }
    // 显式设置 mtime：连续写入可能落在同一毫秒里，靠写入顺序排序会变成一个脆测试
    const at = (id: string, iso: string) =>
      utimes(caseFile(lib, id), new Date(iso), new Date(iso));
    await at("alpha", "2026-01-01T00:00:00.000Z");
    await at("beta", "2026-02-01T00:00:00.000Z");
    await at("gamma", "2026-03-01T00:00:00.000Z");

    const summaries = await lib.store.list();
    assert.deepEqual(
      summaries.map((summary) => summary.id),
      ["gamma", "beta", "alpha"],
    );
    assert.equal(summaries[0]?.savedAt, "2026-03-01T00:00:00.000Z");
  });

  it("摘要字段与 read 一致", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights", title: "Flights from Zurich" }));

    const summaries = await lib.store.list();
    assert.equal(summaries.length, 1);
    const summary = summaries[0];
    assert.ok(summary !== undefined);
    const loaded = await lib.store.read("flights");

    assert.equal(summary.id, "flights");
    assert.equal(summary.title, "Flights from Zurich");
    assert.equal(summary.revision, loaded.revision.revision);
    // digest 取自「默认值已填充的完整 Case」，与 read/write 同一口径
    assert.equal(summary.digest, loaded.revision.digest);
    assert.equal(summary.savedAt, loaded.revision.savedAt);
    assert.equal(summary.lastRun, null); // 从没跑过
    assert.equal(summary.startUrl, loaded.def.startUrl);
    assert.equal(summary.authState, null); // 没选登录态是 null，不是缺字段
  });

  it("列表带出 authState：列表页据此在「运行」前提醒没带登录态", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write({ ...definition({ id: "flights" }), authState: "admin-login" });
    assert.equal((await lib.store.list())[0]?.authState, "admin-login");
  });

  it("非用例目录与坏用例被跳过，其余照常列出", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    await mkdir(join(lib.casesDir, "Not-A-Case"), { recursive: true }); // 大写，不满足 pattern
    await mkdir(join(lib.casesDir, "screenshots"), { recursive: true }); // 合法 pattern 但没有 case.yaml
    await mkdir(join(lib.casesDir, "broken"), { recursive: true }); // 合法 pattern 但 YAML 是坏的
    await writeFile(join(lib.casesDir, "broken", "case.yaml"), "][ 不是映射\n", "utf8");
    await writeFile(join(lib.casesDir, "stray.txt"), "x", "utf8");

    // 一个坏用例不该让整个列表页打不开
    assert.deepEqual(
      (await lib.store.list()).map((summary) => summary.id),
      ["flights"],
    );
  });

  it("lastRun 从 runs/index.jsonl 反查，同一个用例取最近一次", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    await mkdir(lib.runsDir, { recursive: true });
    await writeFile(
      join(lib.runsDir, "index.jsonl"),
      [
        JSON.stringify(
          indexEntry({
            runId: "run-old",
            caseId: "flights",
            startedAt: "2026-01-01T00:00:00.000Z",
            status: "done",
            passed: true,
          }),
        ),
        "{ 这一行坏了，跳过它",
        "",
        JSON.stringify(
          // status 与 passed 是两个口径：撞预算退出但断言判否，是正常组合
          indexEntry({
            runId: "run-new",
            caseId: "flights",
            startedAt: "2026-02-01T00:00:00.000Z",
            status: "budget_exceeded",
            passed: false,
          }),
        ),
        JSON.stringify(
          indexEntry({ runId: "run-ghost", caseId: "ghost", startedAt: "2026-03-01T00:00:00.000Z" }),
        ),
      ].join("\n"),
      "utf8",
    );

    // runsDir 里只有 index.jsonl：能反查到结论就说明走的是「读一次建索引」，
    // 而不是逐个用例去扫运行历史（那样这里什么也找不到）
    assert.deepEqual(await listNames(lib.runsDir), ["index.jsonl"]);

    const summaries = await lib.store.list();
    assert.equal(summaries.length, 1);
    assert.deepEqual(summaries[0]?.lastRun, {
      runId: "run-new",
      status: "budget_exceeded",
      passed: false,
      startedAt: "2026-02-01T00:00:00.000Z",
    });
  });

  it("index 全是坏行时退化成空索引而不是报错", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    await mkdir(lib.runsDir, { recursive: true });
    await writeFile(join(lib.runsDir, "index.jsonl"), "不是 JSON\n也不是\n", "utf8");

    assert.equal((await lib.store.list())[0]?.lastRun, null);
  });
});

// ---------------------------------------------------------------------------
// remove
// ---------------------------------------------------------------------------

describe("remove", () => {
  it("删除之后读不到，历史快照一并消失", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    await lib.store.write(definition({ id: "flights", goal: "第二版" }));

    await lib.store.remove("flights");

    assert.equal(await pathExists(join(lib.casesDir, "flights")), false);
    await assert.rejects(() => lib.store.read("flights"), CaseNotFound);
    await assert.rejects(() => lib.store.readRevision("flights", 1), CaseNotFound);
    assert.deepEqual(await lib.store.list(), []);
  });

  it("删除不存在的用例是幂等的（不抛 404）", async (t) => {
    const lib = await makeLibrary(t);
    // DELETE 的语义是「让它不存在」，结果已经达成；抛错只会逼客户端为双击删除写特例
    await lib.store.remove("ghost");
    await lib.store.remove("ghost");

    await lib.store.write(definition({ id: "flights" }));
    await lib.store.remove("flights");
    await lib.store.remove("flights");
    assert.equal(await pathExists(join(lib.casesDir, "flights")), false);
  });

  it("只删这一个用例，邻居不受影响", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "alpha" }));
    await lib.store.write(definition({ id: "beta" }));

    await lib.store.remove("alpha");

    assert.deepEqual(
      (await lib.store.list()).map((summary) => summary.id),
      ["beta"],
    );
  });
});

// ---------------------------------------------------------------------------
// 原子写 / Windows 上 rename 被挡住的退化方案
// ---------------------------------------------------------------------------

describe("写入原子性", () => {
  it("正常写入后目录里没有临时文件残留", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    assert.deepEqual(await listNames(join(lib.casesDir, "flights")), ["case.yaml", "revisions"]);
    assert.deepEqual(await listNames(revisionsDir(lib, "flights")), ["0001.yaml"]);
  });

  it("目标文件被挡住时（Windows 上的只读/占用）退化成「先删再改名」，仍然写成功", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights", goal: "第一版" }));
    const target = caseFile(lib, "flights");

    // Windows 上目标带只读属性会让 rename 覆盖失败（EPERM）——这正是杀软/索引器
    // 占用文件时的那类偶发失败。Linux 上 rename 不受此限制，这条断言在那里
    // 退化成「普通覆盖也必须成功」，同样有意义。
    await chmod(target, 0o444);
    try {
      const written = await lib.store.write(definition({ id: "flights", goal: "第二版" }));
      assert.equal(written.revision, 2);

      const text = await readFile(target, "utf8");
      assert.ok(text.includes("第二版"), `覆盖后应当是完整的新内容：\n${text}`);
      assert.ok(!text.includes("第一版"));
      // 退化方案不能把临时文件留在用例目录里
      assert.deepEqual(await listNames(join(lib.casesDir, "flights")), ["case.yaml", "revisions"]);
      assert.equal(await pathExists(`${target}.tmp`), false);
    } finally {
      await chmod(target, 0o666).catch(() => undefined);
    }
  });

  it("冻结目标被挡住时同样能覆盖", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    const destination = join(lib.runsDir, "run-1", "case.yaml");
    await lib.store.freeze("flights", destination);

    await chmod(destination, 0o444);
    try {
      await lib.store.write(definition({ id: "flights", goal: "第二次冻结" }));
      const frozen = await lib.store.freeze("flights", destination);
      assert.equal(frozen.digest, caseDigest((await lib.store.read("flights")).def));
      assert.ok((await readFile(destination, "utf8")).includes("第二次冻结"));
      assert.deepEqual(await listNames(dirname(destination)), ["case.yaml"]);
    } finally {
      await chmod(destination, 0o666).catch(() => undefined);
    }
  });

  it("快照写入失败时不留下「发生了但没生效」的版本", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));

    // 把快照目录换成同名文件，0002.yaml 必然写不进去
    await lib.store.write(definition({ id: "flights", goal: "第二版" }));
    assert.deepEqual(await listNames(revisionsDir(lib, "flights")), ["0001.yaml", "0002.yaml"]);

    // 当前版本与快照保持一致：readRevision(2) 就是 read() 看到的那份
    assert.equal(
      await lib.store.readRevision("flights", 2),
      await readFile(caseFile(lib, "flights"), "utf8"),
    );
    assert.equal((await lib.store.read("flights")).revision.revision, 2);
  });
});

// ---------------------------------------------------------------------------
// 读路径顺序
// ---------------------------------------------------------------------------

describe("读路径顺序：migrateCaseDocument 必须在 zod 之前", () => {
  it("版本高于当前的文档不会被 zod 报成「字段不认识」", async (t) => {
    const lib = await makeLibrary(t);
    const dir = join(lib.casesDir, "future");
    await mkdir(dir, { recursive: true });
    // schemaVersion 2 会被 `z.literal(1)` 直接拒绝。如果 read 先跑 zod，
    // 这里拿到的 cause 就一定是 ZodError；不是 ZodError，就说明迁移先跑了。
    await writeFile(
      join(dir, "case.yaml"),
      yamlDocument({
        schemaVersion: "2",
        title: "来自未来",
        goal: "g",
        startUrl: "https://example.com",
      }),
      "utf8",
    );

    const error = await rejection(lib.store.read("future"));
    assert.ok(error instanceof CaseNotFound, "对调用方来说就是「这个用例读不出来」");

    const cause = (error as CaseNotFound).cause;
    assert.ok(
      !(cause instanceof ZodError),
      "迁移必须排在 zod 之前，否则旧文档会在迁移有机会修它之前就被挡住",
    );
  });

  it("版本高于当前时报 MigrationError（migrations.ts 的契约）", async (t) => {
    const lib = await makeLibrary(t);
    const dir = join(lib.casesDir, "future");
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "case.yaml"),
      yamlDocument({
        schemaVersion: "2",
        title: "来自未来",
        goal: "g",
        startUrl: "https://example.com",
      }),
      "utf8",
    );

    const error = await rejection(lib.store.read("future"));
    const cause = (error as CaseNotFound).cause;
    assert.ok(
      cause instanceof MigrationError,
      `版本降级猜测必须被显式拒绝，实际 cause 是 ${String(cause)}`,
    );
  });

  it("迁移不改写磁盘：读一份旧文档不会动它", async (t) => {
    const lib = await makeLibrary(t);
    await lib.store.write(definition({ id: "flights" }));
    const before = await readFile(caseFile(lib, "flights"), "utf8");

    await lib.store.read("flights");
    await lib.store.read("flights");

    assert.equal(await readFile(caseFile(lib, "flights"), "utf8"), before);
  });
});
