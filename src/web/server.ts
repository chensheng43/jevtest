/**
 * HTTP 服务：node:http + 约 40 行路由。
 *
 * 为什么不用 Hono：它确实能让 SSE 从 15 行降到 3 行，但代价是引入两个依赖，
 * 且其 `streamSSE` 有在连接静默断开时挂起、`onAbort` 不触发的已知问题
 * （honojs/hono#1902、#3540）。本项目用轮询，本来就不需要 SSE，
 * 因此不值得为省几十行代码换来一个长期存在的失败面。
 *
 * 这个决定是可低成本反悔的：路由都集中在 api.ts，换框架只改那两个文件。
 *
 * 服务只绑定 127.0.0.1，并强制走 security.ts 的三道闸。
 * **不要把它暴露到 0.0.0.0**——它能读写磁盘上的用例、能驱动浏览器、
 * 且持有 TypeSafe 的凭证。
 */

import { createServer as createHttpServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { AddressInfo } from "node:net";

import type { Settings } from "../config.ts";
import {
  MAX_BODY_BYTES,
  TOKEN_PLACEHOLDER,
  TOKEN_HEADER,
  guardRead,
  guardWrite,
  injectToken,
  resolveVendorPath,
} from "./security.ts";
import type { SecurityContext } from "./security.ts";
import { configureApi, handle } from "./api.ts";
import type { ApiResponse, Services } from "./api.ts";

export interface ServerDeps {
  settings: Settings;
  security: SecurityContext;
  /** 由 cli 组装好的依赖（pool / runner / store / events） */
  services: Services;
}

export interface Server {
  /** 开始监听。返回实际端口（传 0 时由系统分配，测试用） */
  listen(port: number): Promise<number>;
  /** 优雅停机：先停 runner 再关 server */
  close(): Promise<void>;
}

/**
 * 静态资源根目录。
 *
 * 用 `import.meta.url` 而不是 `process.cwd()`：开发期从 `src/web/` 提供，
 * 构建后 `scripts/copy-assets.mjs` 把它复制到 `dist/web/`，两种情形下
 * 相对本模块的位置相同。用 cwd 的话，从别处启动 CLI 就会 404。
 */
const PUBLIC_DIR = fileURLToPath(new URL("./public/", import.meta.url));

/** `/vendor/*` 的根。仅供把 zod 喂给浏览器做表单即时校验。 */
const VENDOR_ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)), "node_modules");

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
};

export function createServer(deps: ServerDeps): Server {
  // 路由依赖只装配一次：`handle(req)` 的签名里没有依赖（脚手架定下的形状）。
  configureApi({ settings: deps.settings, security: deps.security, services: deps.services });

  const server = createHttpServer((req, res) => {
    void route(req, res).catch((error: unknown) => {
      // route 内部已把所有预期内的失败变成响应；走到这里说明是装配层的问题，
      // 比如 PUBLIC_DIR 读不到。仍然要回一个响应，不能让请求悬着。
      writeJson(res, 500, {
        error: `服务内部错误：${error instanceof Error ? error.message : String(error)}`,
      });
    });
  });

  async function route(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${deps.security.port}`);
    const headers = normalizeHeaders(req);

    // ---- 三道闸 -----------------------------------------------------------
    // 写守卫更严：能驱动浏览器、能改磁盘的只有 POST / DELETE。
    const isWrite = method === "POST" || method === "PUT" || method === "DELETE" || method === "PATCH";
    const guard = isWrite
      ? guardWrite(deps.security, headers)
      : guardRead(deps.security, headers);
    if (!guard.ok) {
      // 失败原因写进响应体，方便排查「我的 curl 为什么被 403 了」；
      // 但令牌本身绝不回显（见 security.ts）。
      writeJson(res, guard.status, { error: guard.reason });
      return;
    }

    // ---- 静态资源与非 /api 路径 -------------------------------------------
    if (!url.pathname.startsWith("/api/")) {
      await serveStatic(req, res, url.pathname);
      return;
    }

    // ---- 读请求体（流式限长） ---------------------------------------------
    let body: unknown;
    if (isWrite) {
      const read = await readBody(req, res);
      if (read === null) return; // 已回 413 或 400
      body = read;
    }

    const response = await handle({
      method,
      path: url.pathname,
      query: url.searchParams,
      headers,
      body,
    });
    writeApiResponse(res, response);
  }

  async function serveStatic(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<void> {
    const method = (req.method ?? "GET").toUpperCase();
    if (method !== "GET" && method !== "HEAD") {
      writeJson(res, 405, { error: `${method} 不支持` });
      return;
    }

    const decoded = safeDecode(pathname);

    // /vendor/*：全项目唯一的动态文件服务路径，也是唯一的目录穿越风险点。
    if (decoded === "/vendor" || decoded.startsWith("/vendor/")) {
      const target = resolveVendorPath(VENDOR_ROOT, decoded);
      if (target === null) {
        writeJson(res, 404, { error: `不允许的 vendor 路径：${pathname}` });
        return;
      }
      await sendFile(res, target, "no-store");
      return;
    }

    // 相对 PUBLIC_DIR 的路径。空路径与 `/` 都落到 index.html。
    const relativePath = decoded === "" || decoded === "/" ? "index.html" : decoded.replace(/^\/+/, "");
    if (
      relativePath.includes("..") ||
      relativePath.includes("\0") ||
      // 只允许文件名与一层目录，避免任何拼接歧义
      !/^[A-Za-z0-9._/-]+$/.test(relativePath)
    ) {
      writeJson(res, 404, { error: `未知路径 ${pathname}` });
      return;
    }

    const isEntry = relativePath === "index.html";
    await sendFile(res, join(PUBLIC_DIR, relativePath), isEntry ? "no-store" : "max-age=60");
  }

  /** 写文件响应。HTML 需要替换令牌占位符——这是「只有能读到页面的人才拿得到令牌」的落点。 */
  async function sendFile(res: ServerResponse, path: string, cacheControl: string): Promise<void> {
    const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
    try {
      const data = await readFile(path);
      const payload = contentType.startsWith("text/html")
        ? Buffer.from(injectToken(data.toString("utf8"), deps.security.token), "utf8")
        : data;
      res.writeHead(200, {
        "content-type": contentType,
        "content-length": String(payload.length),
        // no-store 对 index.html 是必需的：令牌每进程一个，缓存住旧页面
        // 会让前端带着过期令牌请求，表现是「刷新后所有写操作 403」。
        "cache-control": cacheControl,
        "x-content-type-options": "nosniff",
      });
      res.end(payload);
    } catch {
      writeJson(res, 404, { error: `静态文件不存在：${path}` });
    }
  }

  return {
    listen: (port: number): Promise<number> =>
      new Promise((resolvePromise, rejectPromise) => {
        const onError = (error: NodeJS.ErrnoException): void => {
          if (error.code === "EADDRINUSE") {
            rejectPromise(
              new Error(
                `端口 ${port} 已被占用。换一个端口（--port <n> 或 JEVTEST_PORT），` +
                  `或先停掉占用的进程。`,
              ),
            );
            return;
          }
          rejectPromise(error);
        };
        server.once("error", onError);
        // 第三个参数显式给 127.0.0.1：默认会绑到 0.0.0.0，而这个服务
        // 能读写磁盘、驱动浏览器、且持有凭证。
        server.listen(port, "127.0.0.1", () => {
          server.off("error", onError);
          const address = server.address() as AddressInfo | null;
          const actual = address?.port ?? port;
          // Host 守卫比对的是 `security.port`，而传 0 时真实端口由系统分配。
          // 不校正的话，所有请求都会因为 Host 对不上而被 403——包括我们自己的健康检查。
          // origin 同理：它由端口推导，两者必须一起改，否则写守卫会拒掉合法的同源请求。
          deps.security.port = actual;
          deps.security.origin = `http://127.0.0.1:${actual}`;
          resolvePromise(actual);
        });
      }),

    close: async (): Promise<void> => {
      // 顺序不能反：先让在途用例走到步边界并写完报告，再断连接。
      // 反过来会出现「用例跑完了却没法把报告响应给任何人」。
      await deps.services.runner.stop();
      await new Promise<void>((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
        // keep-alive 连接会让 close() 一直不回调。轮询端点尤其容易留下这种连接。
        server.closeAllConnections();
      });
    },
  };
}

/** 请求头统一成小写键的普通对象——`Headers` 那套在 node:http 里不存在。 */
function normalizeHeaders(req: IncomingMessage): Record<string, string | undefined> {
  const headers: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    headers[key.toLowerCase()] = Array.isArray(value) ? value[0] : value;
  }
  void TOKEN_HEADER; // 令牌头的名字由 security.ts 定义，这里只是保持引用可发现
  return headers;
}

function safeDecode(pathname: string): string {
  try {
    return decodeURIComponent(pathname);
  } catch {
    // 畸形百分号编码：当成原样路径处理，后面的白名单校验会把它挡掉。
    return pathname;
  }
}

/**
 * 流式读取并限长。
 *
 * **不能先收完再判断大小**——那样对方只要发一个巨大的 body 就能把内存塞爆，
 * 而限制本身形同虚设。这里一边收一边数，超了立刻回 413 并断开。
 */
async function readBody(req: IncomingMessage, res: ServerResponse): Promise<unknown | null> {
  const chunks: Buffer[] = [];
  let total = 0;
  let exceeded = false;

  for await (const chunk of req) {
    const buffer = chunk as Buffer;
    total += buffer.length;
    if (total > MAX_BODY_BYTES) {
      exceeded = true;
      break;
    }
    chunks.push(buffer);
  }

  if (exceeded) {
    writeJson(res, 413, { error: `请求体超过 ${MAX_BODY_BYTES} 字节上限` });
    req.destroy();
    return null;
  }

  const raw = Buffer.concat(chunks).toString("utf8");
  if (raw === "") return undefined;

  const contentType = (req.headers["content-type"] ?? "").toLowerCase();
  if (contentType.includes("json")) {
    try {
      return JSON.parse(raw) as unknown;
    } catch (error) {
      writeJson(res, 400, {
        error: `请求体不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
      });
      return null;
    }
  }
  // 非 JSON 一律按文本原样交给路由（导入 YAML 用得上）。
  return raw;
}

function writeApiResponse(res: ServerResponse, response: ApiResponse): void {
  if (response.raw !== undefined) {
    res.writeHead(response.status, {
      "content-type": response.contentType ?? "application/octet-stream",
      "content-length": String(response.raw.length),
      "x-content-type-options": "nosniff",
    });
    res.end(response.raw);
    return;
  }
  writeJson(res, response.status, response.body);
}

function writeJson(res: ServerResponse, status: number, body: unknown): void {
  if (res.headersSent) {
    res.end();
    return;
  }
  const payload = Buffer.from(JSON.stringify(body ?? null), "utf8");
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": String(payload.length),
    // API 响应一律不缓存：进度与列表页刷新后必须是新的。
    "cache-control": "no-store",
  });
  res.end(payload);
}

// 令牌占位符被 server 在 sendFile 里替换；导出引用便于 doctor 与测试确认常量一致。
void TOKEN_PLACEHOLDER;
