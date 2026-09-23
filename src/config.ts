/**
 * 环境配置：读取 + 校验。
 *
 * 只从环境变量取值，不解析 .env 文件本身——那由 Node 内置能力负责：
 *   - 开发：`node --env-file=.env ...`
 *   - 或在入口调用 `process.loadEnvFile()`
 * 因此不需要 dotenv 之类的依赖。凭证永远留在服务端，绝不进前端或报告。
 *
 * 每项默认值**只在这里定义一次**（见 docs/development.md §1）：模块里再写一遍
 * 就会出现「改了环境变量却没生效」这种最难查的问题。
 */

import { z } from "zod";
import type { ZodType } from "zod";

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
  /** 是否在每次观测后保存一帧截图。`RunOptions.recordFrames` 可逐次覆盖 */
  recordFrames: boolean;
  casesDir: string;
  runsDir: string;
  /** 登录态文件（`<名字>.json`）所在目录。内含会话 cookie，必须不入库 */
  authDir: string;
  /** 用例未指定 engine 时使用 */
  defaultEngine: string;
}

// ---------------------------------------------------------------------------
// 上限与默认值
// ---------------------------------------------------------------------------

/**
 * 上限只在这里定义一次，且**是刻意的**（docs/development.md 的环境变量表）：
 *   - `WORKERS` 的瓶颈是浏览器内存，每 context 约 80~150MB；
 *   - `ENGINE_INFLIGHT` 的瓶颈是厂商侧限流。
 * 两者无关，所以是两个数而不是一个总闸（见 `browser/pool.ts`）。
 */
const MAX_WORKERS = 8;
const MAX_ENGINE_INFLIGHT = 16;

const DEFAULT_PORT = 8770;
/** 1 = 串行。默认不并发：并发会成倍放大模型费用，要快得由用户显式要 */
const DEFAULT_WORKERS = 1;
const DEFAULT_ENGINE_INFLIGHT = 4;
const DEFAULT_TYPESAFE_MODEL = "jev-latest";
const DEFAULT_TEXT_MODEL_BASE_URL = "https://api.deepseek.com/v1";
const DEFAULT_TEXT_MODEL = "deepseek-chat";
const DEFAULT_CASES_DIR = "./cases";
const DEFAULT_RUNS_DIR = "./runs";
const DEFAULT_AUTH_DIR = "./auth";
/**
 * 用例未指定 engine 时的取值。**必须与 `schema/case.ts` 的 `DEFAULT_ENGINE` 一致**——
 * 那处是 schema 给 `Case.engine` 填的默认值，两处不同会让「没写 engine 的用例」
 * 与「settings 的默认引擎」指向不同的引擎。
 */
const DEFAULT_ENGINE = "typesafe";

// ---------------------------------------------------------------------------
// 字段校验
// ---------------------------------------------------------------------------

/**
 * 布尔环境变量接受的写法，**只有这六种**（不分大小写）：`true` / `false` / `1` / `0` / `on` / `off`。
 *
 * 刻意不支持 `yes`/`no`/`y`/`n`：多一套别名就多一条「我明明设了却被当成没设」的路径。
 * 刻意**不把空串当成 false**：`.env.example` 里 `JEVTEST_TRACING=` 这种「留了个空」
 * 极容易被当成「关掉」，而它真正的意思是「没设」——那就该走默认值 `true`。
 * 反过来写 `off` 才是关掉。这也是 `.env.example` 里同时用 `true` 与 `off` 两种风格的原因。
 *
 * 用有序数组而不是对象字面量：对象的整数样键（`"1"`、`"0"`）会被 JS 排到最前面，
 * 于是错误信息里的清单会渲染成 `0 / 1 / true / on / false / off`——
 * 那是键的枚举顺序，不是给人看的顺序。
 */
const BOOLEAN_LITERALS: readonly (readonly [literal: string, value: boolean])[] = [
  ["true", true],
  ["false", false],
  ["1", true],
  ["0", false],
  ["on", true],
  ["off", false],
];

/** 空白串与未设置等价。`TYPESAFE_API_KEY=` 这种「键在但值为空」不该被当成一把空钥匙。 */
function isBlank(value: string | undefined): boolean {
  return value === undefined || value.trim() === "";
}

/** 错误信息里统一让人「照抄一个能用的值」，所以每个字段都带着自己的默认值。 */
function fixHint(name: string, fallback: string): string {
  return `修复：设 ${name}=${fallback}，或删掉这一项用默认值 ${fallback}`;
}

/**
 * 读一个字符串项。空白视同未设置，走默认值。
 *
 * 顺带 `trim()`：从 .env 粘来的 key 常带尾随空格或引号，那会让服务端报 401，
 * 而报错信息里看不出是空格造成的——在入口归一化掉比让人查半天便宜。
 */
function stringField(name: string, fallback: string): ZodType<string, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw) => (isBlank(raw) ? fallback : (raw as string).trim()))
    .describe(name);
}

/**
 * 读一个正整数项，并检查上限。
 *
 * `fallback` 同时用于「没写」与错误信息里的修复建议：**报错必须给出一个能直接抄的值**，
 * 只说「不合法」等于没报（见 docs/api.md §1.2 对错误信息的同一条要求）。
 */
function positiveIntField(
  name: string,
  fallback: number,
  max: number,
  maxReason: string,
): ZodType<number, string | undefined> {
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (isBlank(raw)) return fallback;
      const trimmed = (raw as string).trim();
      // Number("12abc") 是 NaN、"1e3" 是 1000、" 12 " 是 12——只想要最后一种，
      // 因此用 Number 而不是 parseInt（后者会把 "12abc" 当 12 收下）。
      const value = Number(trimmed);
      if (!Number.isInteger(value) || value < 1) {
        ctx.addIssue({
          code: "custom",
          message: `必须是正整数，收到 ${JSON.stringify(raw)}。${fixHint(name, String(fallback))}`,
        });
        return z.NEVER;
      }
      if (value > max) {
        ctx.addIssue({
          code: "custom",
          message:
            `超过上限 ${max}（收到 ${value}）——${maxReason}。` +
            // 这里刻意不写「用默认值 ${max}」：默认值是 fallback（例如 workers 是 1），
            // 说成上限会让人以为照抄上限就是默认状态。
            `修复：设 ${name}=${max} 或更小，或删掉这一项用默认值 ${fallback}`,
        });
        return z.NEVER;
      }
      return value;
    })
    .describe(name);
}

/** 读一个布尔项。合法写法见 `BOOLEAN_LITERALS`。 */
function booleanField(name: string, fallback: boolean): ZodType<boolean, string | undefined> {
  const allowed = BOOLEAN_LITERALS.map(([literal]) => literal).join(" / ");
  return z
    .string()
    .optional()
    .transform((raw, ctx) => {
      if (isBlank(raw)) return fallback;
      const key = (raw as string).trim().toLowerCase();
      const parsed = BOOLEAN_LITERALS.find(([literal]) => literal === key)?.[1];
      if (parsed === undefined) {
        // 错误信息里把「空串 = 没设置」这条也讲清楚，因为那是最容易踩的一种。
        ctx.addIssue({
          code: "custom",
          message:
            `只接受 ${allowed}（不分大小写），收到 ${JSON.stringify(raw)}。` +
            `注意留空不等于 false，而是「没设置」、会用默认值 ${fallback}。` +
            // 两个方向都给出来，这样无论默认值是 true 还是 false，建议都是对的
            `修复：要关掉写 ${name}=off，要打开写 ${name}=on，或删掉这一项用默认值 ${fallback}`,
        });
        return z.NEVER;
      }
      return parsed;
    })
    .describe(name);
}

/**
 * 环境变量的校验器：输入是原始的 `string | undefined`，输出是填充好默认值的 `Settings`。
 *
 * 未列出的键（`PATH` 之类）由 zod 默认行为剥离，因此可以直接把整个 `process.env` 喂进来。
 */
const envSchema = z.object({
  TYPESAFE_API_KEY: z.string().optional(),
  TYPESAFE_MODEL: stringField("TYPESAFE_MODEL", DEFAULT_TYPESAFE_MODEL),

  // 文本取值小模型。键缺失时**归一化成空串**而不是抛错——是否致命由
  // missingCredentials 判定（它不把这一项算作致命，只有 TYPE_TEXT 用例会失败）。
  TEXT_MODEL_API_KEY: z.string().optional(),
  TEXT_MODEL_BASE_URL: stringField("TEXT_MODEL_BASE_URL", DEFAULT_TEXT_MODEL_BASE_URL),
  TEXT_MODEL: stringField("TEXT_MODEL", DEFAULT_TEXT_MODEL),

  JEVTEST_PORT: positiveIntField("JEVTEST_PORT", DEFAULT_PORT, 65535, "端口号最大 65535"),
  JEVTEST_WORKERS: positiveIntField(
    "JEVTEST_WORKERS",
    DEFAULT_WORKERS,
    MAX_WORKERS,
    "再高对模型 API 与被测站点都是压力，而且费用按并发成倍放大",
  ),
  JEVTEST_ENGINE_INFLIGHT: positiveIntField(
    "JEVTEST_ENGINE_INFLIGHT",
    DEFAULT_ENGINE_INFLIGHT,
    MAX_ENGINE_INFLIGHT,
    "厂商侧有限流，再高只会换来 429 与重试",
  ),
  JEVTEST_HEADLESS: booleanField("JEVTEST_HEADLESS", true),
  // `tracing` 的默认值：**默认开启**。
  //
  // trace.zip 是排查失败时最有用的东西（时间轴 + 每步 DOM 快照），
  // 而失败往往不可预测——关掉录制省下的磁盘，通常不值一次「要是当时录了就好了」。
  // 代价是运行目录会变大，所以 `.gitignore` 已忽略 `runs/`。
  // 需要跑大批量、只关心通过与否时，用 `JEVTEST_TRACING=off` 关掉。
  JEVTEST_TRACING: booleanField("JEVTEST_TRACING", true),
  // 截图同样**默认开启**，理由与 tracing 一样：结果页的轨迹要逐步看画面，
  // 而 trace.zip 得下载后另开工具才能看。代价是每步多一次截图（约几十毫秒，计入墙钟预算）
  // 和每帧约 100~150 KB 的磁盘。
  JEVTEST_RECORD_FRAMES: booleanField("JEVTEST_RECORD_FRAMES", true),
  JEVTEST_CASES_DIR: stringField("JEVTEST_CASES_DIR", DEFAULT_CASES_DIR),
  JEVTEST_RUNS_DIR: stringField("JEVTEST_RUNS_DIR", DEFAULT_RUNS_DIR),
  JEVTEST_AUTH_DIR: stringField("JEVTEST_AUTH_DIR", DEFAULT_AUTH_DIR),
  JEVTEST_DEFAULT_ENGINE: stringField("JEVTEST_DEFAULT_ENGINE", DEFAULT_ENGINE),
});

// ---------------------------------------------------------------------------
// 导出
// ---------------------------------------------------------------------------

/**
 * 读取并校验环境变量。
 *
 * **凭证缺失时故意不抛错**：本函数只负责「取值 + 值本身合法」，
 * 「配没配齐」是 `missingCredentials()` 的事。理由在调用点上：
 * `commandRun` 与 `commandDoctor` 都是先 `loadSettings()` 再 `missingCredentials()`
 * ——`doctor` 存在的意义正是把「没配 key」报告出来，如果这里先抛错，
 * doctor 就永远没机会说清缺的是哪一项（cli.ts `commandDoctor` 的检查 3）。
 *
 * **值本身不合法时抛错**，且一次列出全部问题（不是报第一个就停）：
 * 配置要改就一起改，报一个改一个会来回跑好几遍。错误信息里每项都带可复制的修复方式。
 */
export function loadSettings(env?: NodeJS.ProcessEnv): Settings {
  const source = env ?? process.env;
  const parsed = envSchema.safeParse(source);

  if (!parsed.success) {
    const lines = parsed.error.issues.map((issue) => {
      const name = issue.path.length > 0 ? issue.path.join(".") : "环境变量";
      return `  - ${name}：${issue.message}`;
    });
    throw new Error(
      `环境配置有误：\n${lines.join("\n")}\n\n各项含义与默认值见 .env.example，完整清单见 docs/development.md §1。`,
    );
  }

  const values = parsed.data;
  return {
    typesafeApiKey: isBlank(values.TYPESAFE_API_KEY) ? "" : (values.TYPESAFE_API_KEY as string).trim(),
    typesafeModel: values.TYPESAFE_MODEL,

    textModelApiKey: isBlank(values.TEXT_MODEL_API_KEY) ? null : (values.TEXT_MODEL_API_KEY as string).trim(),
    textModelBaseUrl: values.TEXT_MODEL_BASE_URL,
    textModel: values.TEXT_MODEL,

    port: values.JEVTEST_PORT,
    workers: values.JEVTEST_WORKERS,
    maxEngineInflight: values.JEVTEST_ENGINE_INFLIGHT,
    headless: values.JEVTEST_HEADLESS,
    tracing: values.JEVTEST_TRACING,
    recordFrames: values.JEVTEST_RECORD_FRAMES,
    casesDir: values.JEVTEST_CASES_DIR,
    runsDir: values.JEVTEST_RUNS_DIR,
    authDir: values.JEVTEST_AUTH_DIR,
    defaultEngine: values.JEVTEST_DEFAULT_ENGINE,
  };
}

/**
 * 列出缺失的**必填**凭证。
 *
 * 由 `jevtest doctor` 调用，目的是把「跑起来才发现没配 key」提前到一条命令里。
 *
 * **文本模型 key 缺失不算致命**，因此不在这里返回：决策引擎是必须的
 * （没有它任何用例都跑不了），而文本取值小模型只在决策结果是 TYPE_TEXT 时被调用——
 * 缺了它，不涉及输入的用例照样能跑完，涉及输入的那些会明确报错而不是猜一个值。
 * 把它算作致命等于让整个平台为一个可选特性停摆。需要输入的用例是否受影响，
 * 由 `doctor` 单独作为 warning 报出来（cli.ts `commandDoctor`）。
 */
export function missingCredentials(settings: Settings): string[] {
  const missing: string[] = [];
  if (isBlank(settings.typesafeApiKey)) missing.push("TYPESAFE_API_KEY");
  return missing;
}
