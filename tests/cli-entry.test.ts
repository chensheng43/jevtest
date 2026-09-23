/**
 * CLI 入口判定：经软链启动也要进入 main。
 *
 * npm 的 bin 是一条软链（node_modules/.bin/jevtest → dist/cli.js）。入口判定若直接比较
 * argv[1] 与 import.meta.url，经软链启动时两者永远不相等，进程什么都不输出就以 0 退出——
 * 这是「全局安装后命令没反应」那一类问题，单元测试 import cli.ts 时根本看不到。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

test("经软链启动 cli.ts 时 --help 照常输出", async (t) => {
  const dir = await mkdtemp(join(tmpdir(), "jevtest-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const link = join(dir, "jevtest.ts");
  await symlink(CLI, link);

  const { stdout } = await run(process.execPath, ["--experimental-strip-types", link, "--help"]);
  assert.match(stdout, /jevtest/);
  assert.match(stdout, /--help/);
});

test("cli.ts 带 shebang：作为 bin 直接执行时不会被当成 shell 脚本", async () => {
  const source = await readFile(CLI, "utf8");
  assert.ok(source.startsWith("#!/usr/bin/env node\n"), "第一行必须是 #!/usr/bin/env node");
});
