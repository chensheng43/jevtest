/**
 * 本地夹具站点的静态服务——`node:http` 手写，不引入任何依赖。
 *
 * 为什么不用 `file://` URL 直接打开页面：`file://` 下每个文件的 origin 都是
 * opaque，`storageState`、cookie、以及 `page.frames()` 的同源判定全都不可用，
 * 而准入探测恰恰要判定同源与跨域。用真 HTTP 服务才能让被测的东西与
 * 生产环境（`http://` / `https://`）一致。
 *
 * 为什么端口用 0：让系统分配空闲端口。写死端口的话，并行跑测试文件会互相抢，
 * 开发机上撞上已占用的 3000/8080 也会变成一次莫名其妙的「夹具起不来」。
 *
 * 这是 e2e 的**辅助模块**，不是测试文件本身：它按 `tests/e2e/*.test.ts` 的
 * 命名约定不会被 `npm test` 当作用例收集，只由 e2e 用例 import。
 */

import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { IncomingMessage, Server, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * `fixtures/site/` 的绝对路径。
 *
 * 由 `import.meta.url` 推出来，不依赖 `process.cwd()`——测试可能从任何目录被跑起来，
 * 而相对路径在那种情况下会静默指向别处（表现为「全部 404」，很难一眼看出原因）。
 * `resolve()` 去掉尾部分隔符，好让下面的前缀比较写成简单的拼接。
 */
const SITE_ROOT = resolve(fileURLToPath(new URL("../../fixtures/site/", import.meta.url)));

export interface FixtureServer {
  /** 形如 `http://127.0.0.1:53124`，**不带**尾斜杠 */
  url: string;
  close(): Promise<void>;
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
};

/**
 * 起一个只服务 `fixtures/site/` 的静态服务。
 *
 * 调用方**必须**在 finally 里 `close()`：泄漏的监听端口会让同进程后续的
 * 测试拿到一个半死的服务，而 `node:test` 也会因为句柄没释放而挂住不退出。
 */
export async function startFixtureServer(): Promise<FixtureServer> {
  const server = createServer((request, response) => {
    // 处理器是异步的，但 createServer 不 await 它；显式 void 掉，
    // 让「这里的失败由 handle 自己兜住」这件事在代码里看得见。
    void handle(request, response);
  });

  await new Promise<void>((settle, fail) => {
    server.once("error", fail);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", fail);
      settle();
    });
  });

  const address = server.address();
  if (address === null || typeof address === "string") {
    await shutdown(server);
    throw new Error("夹具服务已经起来了却拿不到端口号，属于不该发生的情况");
  }

  let closed = false;
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      // 幂等：调用方在 finally 里关一次、外层清理再关一次是很常见的写法，
      // 而第二次 `server.close()` 会以 ERR_SERVER_NOT_RUNNING 报错。
      if (closed) return;
      closed = true;
      await shutdown(server);
    },
  };
}

async function shutdown(server: Server): Promise<void> {
  // 先掐掉保活连接。Chromium 默认保持 keep-alive，不主动断的话
  // `server.close()` 会一直等到那些连接自己超时——测试表现为「用例全过了却不退出」，
  // 而且看不出是这里的问题。
  server.closeAllConnections();
  await new Promise<void>((settle, fail) => {
    server.close((error) => (error ? fail(error) : settle()));
  });
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  try {
    if (request.method !== "GET" && request.method !== "HEAD") {
      respond(response, 405, "text/plain; charset=utf-8", "夹具服务只支持 GET");
      return;
    }

    // base 只用来让 URL 解析器有个起点，不影响结果：下面只用 pathname
    const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://127.0.0.1").pathname);
    const filePath = resolveFile(pathname);
    if (filePath === null) {
      respond(response, 403, "text/plain; charset=utf-8", "路径越界");
      return;
    }

    const body = await readFile(filePath);
    response.writeHead(200, {
      "content-type": CONTENT_TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream",
      "content-length": String(body.byteLength),
      // 夹具是本地文件，改了就该立刻生效。开着缓存的话，
      // 「改了夹具、测试还在跑旧页面」会浪费掉一轮排查。
      "cache-control": "no-store",
    });
    response.end(request.method === "HEAD" ? undefined : body);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "EISDIR" || code === "ENOTDIR") {
      respond(response, 404, "text/plain; charset=utf-8", "夹具站点里没有这个文件");
      return;
    }
    respond(response, 500, "text/plain; charset=utf-8", error instanceof Error ? error.message : String(error));
  }
}

/**
 * URL 路径 -> 磁盘路径。返回 `null` = 越界，调用方回 403。
 *
 * **必须先 `resolve` 再比较前缀**。只在字符串上找 `..` 是拦不住的：
 * `%2e%2e%2f` 之类在上一层 `decodeURIComponent` 之后才现形，
 * 而 `a/../../b` 这种在路径规范化之后才越界。
 * 追加 `sep` 是必需的：否则 `fixtures/site-evil/` 也会以 `fixtures/site` 开头。
 */
function resolveFile(pathname: string): string | null {
  const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = resolve(SITE_ROOT, relative);
  if (target !== SITE_ROOT && !target.startsWith(SITE_ROOT + sep)) return null;
  return target;
}

function respond(response: ServerResponse, status: number, contentType: string, body: string): void {
  response.writeHead(status, { "content-type": contentType, "content-length": String(Buffer.byteLength(body)) });
  response.end(body);
}
