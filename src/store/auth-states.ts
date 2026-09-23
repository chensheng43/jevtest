/**
 * 登录态仓库：`<authDir>/<名字>.json` 的读写与元信息。
 *
 * 登录态是**独立于用例的资源**：同一个账号的登录态会被很多用例共用，
 * 同一个站点也可能有多个账号（管理员、普通用户）。用例里只写名字（`authState`），
 * 运行时由 runner 解析成这里的路径交给浏览器池。
 *
 * ## 目录布局
 *
 * ```text
 * auth/
 *   <名字>.json         Playwright 的 storageState 原样落盘（cookie + localStorage）
 *   <名字>.meta.json    登录地址、来源、最近一次验证结果
 * ```
 *
 * 状态文件刻意保持 storageState 原格式、不包一层：CI 或别的工具可以直接拿它
 * `newContext({ storageState })`，而元信息丢了也不影响运行。
 *
 * ## 安全
 *
 * - 两个文件都以 0600 写入：状态文件里是会话 cookie，同机其他用户不该读得到。
 * - 名字走白名单正则，才会拼进路径——与用例 id 同一套规则（`AUTH_STATE_NAME_PATTERN`）。
 * - **任何对外的形态都不含 cookie 的值**：`summarize` 只产出计数、站点与过期时间。
 */

import { chmod, mkdir, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AUTH_STATE_NAME_PATTERN } from "../schema/case.ts";

/** Playwright `BrowserContext.storageState()` 的输出形态（只列用得到的字段） */
export interface StorageState {
  cookies: StorageCookie[];
  origins: { origin: string; localStorage: { name: string; value: string }[] }[];
}

export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix 秒；-1 = 会话 cookie（浏览器关闭即失效，但 storageState 会照样保存并恢复它） */
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/** 一次「这份登录态还能不能用」的检查结果 */
export interface AuthVerifyResult {
  at: string;
  ok: boolean;
  /** 验证时打开的地址 */
  url: string;
  /** 页面最终停在哪。打不开时为 null */
  finalUrl: string | null;
  /** 给人看的结论 */
  detail: string;
}

export interface AuthStateMeta {
  /** 在哪个地址登录的。「重新登录」与「验证」默认都用它 */
  loginUrl: string | null;
  source: "login" | "import";
  savedAt: string;
  lastVerified: AuthVerifyResult | null;
}

/** 对外（API、前端）的形态。**不含任何 cookie 值** */
export interface AuthStateSummary extends AuthStateMeta {
  name: string;
  cookieCount: number;
  /** cookie 域与 localStorage 来源合并去重后的主机名 */
  sites: string[];
  /** 持久 cookie 里最早的过期时间（ISO）。只是参考：站点未必靠那一个 cookie 判定登录 */
  earliestExpiry: string | null;
  /** 有没有会话 cookie。有的话，站点重启会话后它们就失效了 */
  hasSessionCookies: boolean;
}

export class AuthStateNotFound extends Error {
  constructor(name: string) {
    super(`登录态 ${name} 不存在`);
    this.name = "AuthStateNotFound";
  }
}

export interface AuthStateStore {
  /** 状态文件的路径。名字不合法直接抛错——这是它进入路径拼接前的最后一道闸 */
  pathOf(name: string): string;
  list(): Promise<AuthStateSummary[]>;
  get(name: string): Promise<AuthStateSummary>;
  exists(name: string): Promise<boolean>;
  /** 写入（新建或覆盖）。`state` 先经 `parseStorageState` 校验 */
  save(name: string, state: StorageState, meta: Pick<AuthStateMeta, "loginUrl" | "source">): Promise<AuthStateSummary>;
  recordVerify(name: string, result: AuthVerifyResult): Promise<void>;
  remove(name: string): Promise<void>;
}

const STATE_SUFFIX = ".json";
const META_SUFFIX = ".meta.json";

export function isValidAuthStateName(name: string): boolean {
  return AUTH_STATE_NAME_PATTERN.test(name);
}

/**
 * 名字 -> 状态文件路径。runner 与仓库共用这一处拼接：
 * 名字不合法直接抛错，这是它进入路径拼接前的最后一道闸。
 */
export function authStatePath(root: string, name: string): string {
  assertName(name);
  return join(root, `${name}${STATE_SUFFIX}`);
}

export function createAuthStateStore(options: { root: string }): AuthStateStore {
  const { root } = options;

  function pathOf(name: string): string {
    return authStatePath(root, name);
  }

  function metaPathOf(name: string): string {
    assertName(name);
    return join(root, `${name}${META_SUFFIX}`);
  }

  async function exists(name: string): Promise<boolean> {
    try {
      await stat(pathOf(name));
      return true;
    } catch (error) {
      if (isErrno(error, "ENOENT")) return false;
      throw error;
    }
  }

  async function get(name: string): Promise<AuthStateSummary> {
    let raw: string;
    try {
      raw = await readFile(pathOf(name), "utf8");
    } catch (error) {
      if (isErrno(error, "ENOENT")) throw new AuthStateNotFound(name);
      throw error;
    }
    const state = parseStorageState(JSON.parse(raw) as unknown);
    const meta = await readMeta(name);
    return summarize(name, state, meta);
  }

  /**
   * 元信息缺失或损坏时用状态文件的 mtime 兜底：状态文件才是事实来源，
   * 手工放进目录的 storageState（没有 meta）也应该能列出来、能用。
   */
  async function readMeta(name: string): Promise<AuthStateMeta> {
    try {
      const parsed = JSON.parse(await readFile(metaPathOf(name), "utf8")) as Partial<AuthStateMeta>;
      return {
        loginUrl: typeof parsed.loginUrl === "string" ? parsed.loginUrl : null,
        source: parsed.source === "import" ? "import" : "login",
        savedAt: typeof parsed.savedAt === "string" ? parsed.savedAt : await mtimeOf(name),
        lastVerified: parsed.lastVerified ?? null,
      };
    } catch {
      return { loginUrl: null, source: "import", savedAt: await mtimeOf(name), lastVerified: null };
    }
  }

  async function mtimeOf(name: string): Promise<string> {
    return (await stat(pathOf(name))).mtime.toISOString();
  }

  async function list(): Promise<AuthStateSummary[]> {
    let entries: string[];
    try {
      entries = await readdir(root);
    } catch (error) {
      if (isErrno(error, "ENOENT")) return [];
      throw error;
    }
    const names = entries
      .filter((entry) => entry.endsWith(STATE_SUFFIX) && !entry.endsWith(META_SUFFIX))
      .map((entry) => entry.slice(0, -STATE_SUFFIX.length))
      .filter(isValidAuthStateName)
      .sort();

    const out: AuthStateSummary[] = [];
    for (const name of names) {
      try {
        out.push(await get(name));
      } catch (error) {
        // 一份坏文件不该让整个列表打不开；跳过并留痕，用户可以删掉它或重新登录覆盖。
        console.warn(
          `[jevtest] 警告：登录态 ${name} 读不出来（${error instanceof Error ? error.message : String(error)}），已跳过`,
        );
      }
    }
    return out;
  }

  async function save(
    name: string,
    state: StorageState,
    meta: Pick<AuthStateMeta, "loginUrl" | "source">,
  ): Promise<AuthStateSummary> {
    const checked = parseStorageState(state);
    await mkdir(root, { recursive: true });
    const fullMeta: AuthStateMeta = { ...meta, savedAt: new Date().toISOString(), lastVerified: null };
    await writePrivate(pathOf(name), JSON.stringify(checked, null, 2));
    await writePrivate(metaPathOf(name), JSON.stringify(fullMeta, null, 2));
    return summarize(name, checked, fullMeta);
  }

  async function recordVerify(name: string, result: AuthVerifyResult): Promise<void> {
    const meta = await readMeta(name);
    await writePrivate(metaPathOf(name), JSON.stringify({ ...meta, lastVerified: result }, null, 2));
  }

  async function remove(name: string): Promise<void> {
    if (!(await exists(name))) throw new AuthStateNotFound(name);
    await rm(pathOf(name), { force: true });
    await rm(metaPathOf(name), { force: true });
  }

  return { pathOf, list, get, exists, save, recordVerify, remove };
}

/**
 * 校验并规整一份 storageState。上传（用户手里的 JSON）与登录窗口导出的都走这里。
 *
 * 只校验形状，不校验内容是否「还有效」——那是验证按钮的事。
 * 多余字段丢掉：落盘的只有 Playwright 认识的那些，免得把不相干的东西带进会话目录。
 */
export function parseStorageState(raw: unknown): StorageState {
  const record = asRecord(raw);
  if (record === null || !Array.isArray(record["cookies"]) || !Array.isArray(record["origins"])) {
    throw new Error(
      "不是 Playwright 的 storageState：顶层应为 { cookies: [...], origins: [...] }" +
        "（可由 `context.storageState()` 或 `npx playwright codegen --save-storage` 导出）",
    );
  }

  const cookies = (record["cookies"] as unknown[]).map((item, index): StorageCookie => {
    const cookie = asRecord(item);
    const at = `cookies[${index}]`;
    if (cookie === null) throw new Error(`${at} 不是对象`);
    const name = requireString(cookie, "name", at);
    const value = requireString(cookie, "value", at);
    const domain = requireString(cookie, "domain", at);
    const path = typeof cookie["path"] === "string" ? cookie["path"] : "/";
    const expires = typeof cookie["expires"] === "number" ? cookie["expires"] : -1;
    const sameSite = cookie["sameSite"] === "Strict" || cookie["sameSite"] === "None" ? cookie["sameSite"] : "Lax";
    return {
      name,
      value,
      domain,
      path,
      expires,
      httpOnly: cookie["httpOnly"] === true,
      secure: cookie["secure"] === true,
      sameSite,
    };
  });

  const origins = (record["origins"] as unknown[]).map((item, index) => {
    const entry = asRecord(item);
    const at = `origins[${index}]`;
    if (entry === null) throw new Error(`${at} 不是对象`);
    const origin = requireString(entry, "origin", at);
    const storage = Array.isArray(entry["localStorage"]) ? (entry["localStorage"] as unknown[]) : [];
    return {
      origin,
      localStorage: storage.map((pair, i) => {
        const kv = asRecord(pair);
        if (kv === null) throw new Error(`${at}.localStorage[${i}] 不是对象`);
        return {
          name: requireString(kv, "name", `${at}.localStorage[${i}]`),
          value: requireString(kv, "value", `${at}.localStorage[${i}]`),
        };
      }),
    };
  });

  return { cookies, origins };
}

/** 对外摘要。**只算统计量，不带任何 cookie 值**——这个形态会进 API 响应 */
export function summarize(name: string, state: StorageState, meta: AuthStateMeta): AuthStateSummary {
  const sites = new Set<string>();
  for (const cookie of state.cookies) sites.add(cookie.domain.replace(/^\./, ""));
  for (const entry of state.origins) {
    try {
      sites.add(new URL(entry.origin).host);
    } catch {
      // 解析不了的来源不影响摘要
    }
  }

  const persistent = state.cookies.filter((cookie) => cookie.expires > 0).map((cookie) => cookie.expires);
  const earliest = persistent.length > 0 ? Math.min(...persistent) : null;

  return {
    name,
    ...meta,
    cookieCount: state.cookies.length,
    sites: [...sites].sort(),
    earliestExpiry: earliest === null ? null : new Date(earliest * 1000).toISOString(),
    hasSessionCookies: state.cookies.some((cookie) => cookie.expires <= 0),
  };
}

/**
 * 「带着登录态打开 `url` 之后停在 `finalUrl`、页面上有 `passwordFields` 个密码框」算不算还登录着。
 *
 * 只用两条与站点无关的信号：
 *   1. **页面上有密码框** -> 停在了登录页；
 *   2. **落地地址的路径像登录页**（`/login`、`/signin`、`/sso`、`/passport`、`/oauth`…）
 *      -> 被重定向去登录了。只看路径不看 query：SSO 常把回跳地址塞在参数里。
 *
 * **跳到别的域名本身不算失效。** 验证地址常常就是登录页本身，已登录的人打开它，
 * 站点会直接把他送去控制台（例如 `www.example.com/login` -> `console.example.com/dashboard`，实测过这种站点）。
 * 早先把「origin 变了」当成失效，恰好把这种最典型的有效登录态判成了失效。
 *
 * 两条都没命中也**不等于一定有效**（有的 SSO 第一步只要用户名、没有密码框），
 * 所以文案说的是「看起来」。真正的判定是用例跑一次。
 */
export function judgeLoggedIn(url: string, finalUrl: string, passwordFields: number): { ok: boolean; detail: string } {
  let landed: URL | null = null;
  try {
    landed = new URL(finalUrl);
  } catch {
    landed = null;
  }
  const where = landed === null ? finalUrl : `${landed.origin}${landed.pathname}`;
  if (passwordFields > 0) {
    return { ok: false, detail: `停在了 ${where}，页面上有密码框：看起来没有登录，需要重新登录` };
  }
  if (landed !== null && LOGIN_PATH.test(landed.pathname)) {
    return { ok: false, detail: `被跳到了登录页 ${where}：登录态看起来已失效，需要重新登录` };
  }
  let sameOrigin = false;
  try {
    sameOrigin = landed !== null && new URL(url).origin === landed.origin;
  } catch {
    sameOrigin = false;
  }
  return {
    ok: true,
    detail: sameOrigin
      ? `停留在 ${where}，没有登录框：看起来仍是登录状态`
      : `被带到了 ${where}（不像登录页），没有登录框：看起来仍是登录状态`,
  };
}

/** 路径里出现这些词的一段，就当作登录页。按路径段匹配，免得 `/blogin` 之类误伤 */
const LOGIN_PATH = /(^|\/)(login|log-in|signin|sign-in|sso|passport|oauth2?|cas|auth\/login)(\/|\.|$)/i;

// ---------------------------------------------------------------------------
// 模块私有辅助
// ---------------------------------------------------------------------------

function assertName(name: string): void {
  if (!isValidAuthStateName(name)) {
    throw new Error(`非法的登录态名称：${JSON.stringify(name)}（小写字母、数字与连字符，需以字母或数字开头，长度 2~64）`);
  }
}

/**
 * 以 0600 原子写入。
 *
 * 临时文件建时就带 0600（`mode` 只在新建时生效），rename 保留权限位，
 * 因此目标文件在任何时刻都不会以 0644 出现。再 chmod 一次兜住「umask 更严」之外的平台差异。
 * Windows 不认 POSIX 权限位，这里写的是 POSIX 上的正确行为（与 `pool.saveStorageState` 一致）。
 */
async function writePrivate(destination: string, data: string): Promise<void> {
  const temp = `${destination}.tmp-${process.pid}-${(tempCounter++).toString(36)}`;
  try {
    await writeFile(temp, data, { encoding: "utf8", mode: 0o600 });
    await chmod(temp, 0o600);
    await rename(temp, destination);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

let tempCounter = 0;

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function requireString(record: Record<string, unknown>, key: string, at: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new Error(`${at}.${key} 必须是字符串`);
  return value;
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === code;
}
