/**
 * 安全守卫的单元测试。
 *
 * 这三道闸的失效不会报错——只会让「本地」这个前提悄悄不成立。
 * 所以每条守卫都要有一条**反向**用例（该拦的确实拦住了），
 * 而不只是正向用例（正常的确实放行了）。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { join, resolve } from "node:path";

import {
  MAX_BODY_BYTES,
  TOKEN_HEADER,
  TOKEN_PLACEHOLDER,
  createToken,
  guardRead,
  guardWrite,
  injectToken,
  resolveVendorPath,
} from "../src/web/security.ts";

const ctx = { token: "a".repeat(64), port: 8770, origin: "http://127.0.0.1:8770" };

const host = { host: "127.0.0.1:8770" };

test("createToken 每次不同且足够长", () => {
  const a = createToken();
  const b = createToken();
  assert.notEqual(a, b);
  // 32 字节的 hex = 64 字符。太短会让令牌可被暴力枚举。
  assert.equal(a.length, 64);
});

test("guardRead 只接受精确的 127.0.0.1:<port>", () => {
  assert.equal(guardRead(ctx, host).ok, true);

  // DNS rebinding：攻击者的域名解析到 127.0.0.1，Host 头会是攻击者的域名。
  const rebind = guardRead(ctx, { host: "evil.example.com" });
  assert.equal(rebind.ok, false);
  assert.equal(rebind.status, 403);

  // localhost 是同一个服务的另一个名字，而多一个别名就多一个 rebinding 入口。
  assert.equal(guardRead(ctx, { host: "localhost:8770" }).ok, false);
  // 端口不同也不行——否则另一个端口的服务能借我们的 Host 校验通过。
  assert.equal(guardRead(ctx, { host: "127.0.0.1:9999" }).ok, false);
  // 端口子串不算匹配（startsWith 那类写法的经典漏洞）。
  assert.equal(guardRead(ctx, { host: "127.0.0.1:87700" }).ok, false);
  assert.equal(guardRead(ctx, { host: "127.0.0.1" }).ok, false);
  assert.equal(guardRead(ctx, {}).ok, false);
});

test("guardWrite 要求 token 与 origin", () => {
  const good = guardWrite(ctx, { ...host, [TOKEN_HEADER]: ctx.token, origin: ctx.origin });
  assert.equal(good.ok, true);

  // 缺少令牌：外部页面能伪造请求，但读不到我们的 HTML，因此拿不到令牌。
  assert.equal(guardWrite(ctx, host).ok, false);
  assert.equal(guardWrite(ctx, { ...host, [TOKEN_HEADER]: "" }).ok, false);
  // 令牌错误。
  assert.equal(guardWrite(ctx, { ...host, [TOKEN_HEADER]: "b".repeat(64) }).ok, false);
  // 长度不同的错误令牌不能抛异常（timingSafeEqual 要求等长）。
  assert.equal(guardWrite(ctx, { ...host, [TOKEN_HEADER]: "short" }).ok, false);

  // 跨站表单提交：Origin 指向别处。
  const crossSite = guardWrite(ctx, {
    ...host,
    [TOKEN_HEADER]: ctx.token,
    origin: "http://evil.example.com",
  });
  assert.equal(crossSite.ok, false);
  assert.equal(crossSite.status, 403);

  // 同源导航与 curl 不带 Origin，必须放行——否则 CLI 自己都调不通。
  assert.equal(guardWrite(ctx, { ...host, [TOKEN_HEADER]: ctx.token }).ok, true);
  assert.equal(guardWrite(ctx, { ...host, [TOKEN_HEADER]: ctx.token, origin: "null" }).ok, true);
});

test("守卫失败的文案不回显收到的 token", () => {
  const secret = "leaked-token-value";
  const result = guardWrite(ctx, { ...host, [TOKEN_HEADER]: secret });
  assert.equal(result.ok, false);
  assert.equal(result.reason.includes(secret), false);
});

test("请求体上限是 8KB", () => {
  // 值本身是契约（docs/api.md §1.1），改动会同时影响前端与 CLI。
  assert.equal(MAX_BODY_BYTES, 8192);
});

test("injectToken 替换全部占位符", () => {
  const html = `<meta name="jevtest-token" content="${TOKEN_PLACEHOLDER}">\n<script>window.t="${TOKEN_PLACEHOLDER}";</script>`;
  // 令牌用一个不会偶然出现在 HTML 别处的值，否则计数会数到标签名里。
  const token = "TOKENVALUE9f3a";
  const out = injectToken(html, token);
  assert.equal(out.includes(TOKEN_PLACEHOLDER), false);
  assert.equal(out.split(token).length - 1, 2);
});

test("resolveVendorPath 只放行允许的扩展名", () => {
  const root = resolve("C:/tmp/vendor");
  const ok = resolveVendorPath(root, "/vendor/zod/index.js");
  assert.equal(ok, join(root, "zod", "index.js"));
  // 带 query 的 URL 是浏览器常态。
  assert.equal(resolveVendorPath(root, "/vendor/zod/index.js?v=1"), join(root, "zod", "index.js"));
  // 也接受已经剥掉 /vendor 前缀的路径。
  assert.equal(resolveVendorPath(root, "zod/index.js"), join(root, "zod", "index.js"));

  assert.equal(resolveVendorPath(root, "/vendor/zod/index.ts"), null);
  assert.equal(resolveVendorPath(root, "/vendor/.env"), null);
  assert.equal(resolveVendorPath(root, "/vendor/"), null);
});

test("resolveVendorPath 挡住各类目录穿越", () => {
  const root = resolve("C:/tmp/vendor");
  const escapes = [
    "/vendor/../../../Windows/System32/drivers/etc/hosts.json",
    "/vendor/zod/../../../../etc/passwd.js",
    "/vendor/..%2f..%2fsecret.js",
    "/vendor/%2e%2e/%2e%2e/secret.js",
    "/vendor/....//....//secret.js",
  ];
  for (const path of escapes) {
    // URL 解码交由调用方（server.ts）完成——这里断言的是：即使拿到未解码的
    // 形态也不会解析到 root 之外。解不开的百分号编码本来就匹配不到磁盘文件。
    const resolved = resolveVendorPath(root, path);
    if (resolved !== null) {
      assert.equal(resolved.startsWith(root + "\\") || resolved.startsWith(root + "/"), true, `${path} 逃出了 root`);
    }
  }
  // 同类名的兄弟目录不能被误判为在界内（startsWith 写法的经典漏洞）。
  assert.equal(resolveVendorPath(root, "/vendor/../vendor-evil/x.js"), null);
});

test("resolveVendorPath 拒绝 NUL 字节", () => {
  const root = resolve("C:/tmp/vendor");
  assert.equal(resolveVendorPath(root, "/vendor/a.js\0.png"), null);
});
