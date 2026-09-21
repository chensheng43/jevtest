/**
 * 命令行入口。
 *
 * 两个用途：
 *   1. `serve` 启动 Web 平台；
 *   2. `run` / `validate` 供 CI 使用——CI 不该依赖一个需要人点的界面。
 *
 * 目前只实现了参数解析与用法输出，各子命令尚未实现。
 *
 * 之所以保持无导入，是为了让 `node --experimental-strip-types src/cli.ts --help`
 * 在依赖尚未安装时也能跑起来——脚手架阶段这条很实用，
 * 也让它能作为「Node 类型剥离配置是否正确」的最小验证。
 * 实现时的装配顺序见文件末尾。
 */

const USAGE = `jevtest —— 基于快速自主决策的 Web 测试套件平台

用法:
  jevtest serve                     启动 Web 平台（默认 http://127.0.0.1:8770）
  jevtest run <用例...>             在命令行跑用例，输出 JSON 报告
  jevtest validate <用例...>        只校验用例文件，不运行、不调用模型
  jevtest import <文件...>          把 YAML 导入用例库
  jevtest doctor                    检查环境：Node、Chromium、凭证、目录可写

选项:
  --port <n>                        serve 的端口
  --workers <n>                     worker 并发度（默认 1，即串行）
  --out <目录>                      报告输出目录
  --format <json|md|junit>          run 的输出格式
  -h, --help                        显示本帮助

示例:
  jevtest serve
  jevtest run cases/wikipedia-godel.yaml
  jevtest validate cases/*.yaml

环境变量见 .env.example。凭证只从环境读取，绝不写入报告。`;

/** 已识别的子命令。 */
const COMMANDS = ["serve", "run", "validate", "import", "doctor"] as const;
type Command = (typeof COMMANDS)[number];

interface ParsedArgs {
  command: Command | null;
  operands: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const [head, ...tail] = argv;
  if (head === "-h" || head === "--help" || head === undefined) {
    return { command: null, operands: [], flags: { help: true } };
  }
  if (!(COMMANDS as readonly string[]).includes(head)) {
    throw new Error(`未知子命令: ${head}\n\n${USAGE}`);
  }

  const operands: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < tail.length; i += 1) {
    const arg = tail[i];
    if (arg?.startsWith("--")) {
      const name = arg.slice(2);
      const next = tail[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[name] = next;
        i += 1;
      } else {
        flags[name] = true;
      }
    } else if (arg !== undefined) {
      operands.push(arg);
    }
  }
  return { command: head as Command, operands, flags };
}

function main(argv: string[]): number {
  let parsed: ParsedArgs;
  try {
    parsed = parseArgs(argv);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    return 2;
  }

  if (parsed.flags.help || parsed.command === null) {
    console.log(USAGE);
    return 0;
  }

  console.error(
    `子命令 \`${parsed.command}\` 尚未实现（P0 待实现）。\n` +
      `当前仓库是脚手架：模块划分与接口已定，实现逻辑尚未编写。\n` +
      `详见 README.md 与 docs/architecture.md。`,
  );
  return 1;
}

process.exitCode = main(process.argv.slice(2));

// ---------------------------------------------------------------------------
// 实现时的装配顺序（P0）
//
// 刻意先做 CLI 再做 Web：CLI 跑通了，Web 层就只是薄薄的 I/O 与渲染，
// 而且离线 e2e 测试（真浏览器 + scripted 引擎 + 本地 fixture）
// 可以在 Web 层存在之前就锁死 runner 的正确性。
//
//   import { loadSettings, missingCredentials } from "./config.ts";
//   import { createBrowserPool } from "./browser/pool.ts";
//   import { createEngine } from "./engine/registry.ts";
//   import { createRunnerService } from "./core/runner.ts";
//   import { createServer } from "./web/server.ts";
//   import { createToken } from "./web/security.ts";
//
//   顺序：
//     1. process.loadEnvFile()（若存在 .env）
//     2. settings = loadSettings()
//     3. doctor / validate 在此就能返回，不必启动浏览器
//     4. pool = createBrowserPool({ maxContexts: settings.workers, ... })
//     5. runner = createRunnerService({ pool, settings, createEngine, persist, events })
//     6. serve  -> createServer(...).listen(settings.port)
//        run    -> runner.enqueueMany(...)，等待全部结束后输出报告
// ---------------------------------------------------------------------------
