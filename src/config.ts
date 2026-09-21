/**
 * 环境配置：读取 + 校验。
 *
 * 只从环境变量取值，不解析 .env 文件本身——那由 Node 内置能力负责：
 *   - 开发：`node --env-file=.env ...`
 *   - 或在入口调用 `process.loadEnvFile()`
 * 因此不需要 dotenv 之类的依赖。凭证永远留在服务端，绝不进前端或报告。
 */

export interface Settings {
  // ---- 决策引擎 ----
  typesafeApiKey: string;
  typesafeModel: string;

  // ---- 文本取值小模型（可选） ----
  /** null = 未配置。此时遇到需要输入的用例会直接报错，而不是猜一个值 */
  textModelApiKey: string | null;
  textModelBaseUrl: string;
  textModel: string;

  // ---- 平台 ----
  port: number;
  /** worker 并发度。1 = 串行 */
  workers: number;
  /**
   * 在途引擎请求数上限。**与 `workers` 刻意解耦**——见 `browser/pool.ts`。
   *
   * 两者瓶颈无关：`workers` 限制浏览器内存（每 context 约 80~150MB），
   * 这个限制厂商侧的限流。绑成一个总闸会让其中一个白白闲置。
   */
  maxEngineInflight: number;
  /** 无头模式。CI 与本地跑测试都应为 true；要肉眼看过程时临时关掉 */
  headless: boolean;
  /** 是否录制 Playwright trace。见下方说明 */
  tracing: boolean;
  casesDir: string;
  runsDir: string;
  /** 用例未指定 engine 时使用 */
  defaultEngine: string;
}

/** 读取并校验环境变量。缺必填项时抛错，错误信息须给出可复制的修复方式。 */
export function loadSettings(env?: NodeJS.ProcessEnv): Settings {
  throw new Error("未实现：P0 待实现");
}

/**
 * 列出缺失的必填凭证。
 *
 * 由 `jevtest doctor` 调用，目的是把「跑起来才发现没配 key」提前到一条命令里。
 * 文本模型 key 缺失不算致命——只有 TYPE_TEXT 用例会失败。
 */
export function missingCredentials(settings: Settings): string[] {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现 loadSettings —— 用 zod 校验，port/workers 需为合法整数，
//           workers 上限 8（再高对模型 API 与 staging 都是压力）。
//           `maxEngineInflight` 默认 4，上限 16。
// TODO(P0): 实现 missingCredentials。
//
// 关于 `tracing` 的默认值：**默认开启**。
//
// trace.zip 是排查失败时最有用的东西（时间轴 + 每步 DOM 快照），
// 而失败往往不可预测——关掉录制省下的磁盘，通常不值一次「要是当时录了就好了」。
// 代价是运行目录会变大，所以 `.gitignore` 已忽略 `runs/`。
// 需要跑大批量、只关心通过与否时，用 `JEVTEST_TRACING=off` 关掉。
//
// 环境变量名：JEVTEST_WORKERS / JEVTEST_ENGINE_INFLIGHT / JEVTEST_HEADLESS / JEVTEST_TRACING
