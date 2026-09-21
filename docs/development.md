# 开发指南

面向要动手实现或修改本项目的人。

---

## 1. 环境

| 要求 | 版本 | 说明 |
| --- | --- | --- |
| Node | **≥ 22.6** | 需要 `--experimental-strip-types`。开发机实测 22.21.0 |
| npm | 任意较新版本 | 实测 10.9.4。pnpm 未安装，不必引入 |

```bash
npm install
npx playwright install chromium      # 约 150MB，首次需要
cp .env.example .env                 # 填 TYPESAFE_API_KEY
```

运行时依赖刻意保持在少数几个：

| 包 | `package.json` 声明 | 脚手架验证时解析到 | 用途 |
| --- | --- | --- | --- |
| `playwright` | `^1.49.0` | 1.63.0 | 浏览器层 |
| `zod` | `^4.0.0` | 4.6.5 | schema 校验，前后端共享 |
| `yaml` | `^2.6.0` | 2.9.1 | 用例文件 |

开发依赖只有 `typescript` 与 `@types/node`。

### 环境变量

全部在 [`.env.example`](../.env.example) 里带注释列出。全部有来源，且**只在一处定义**
（`config.ts` 的 `Settings`）——不要在模块里再写一遍默认值，
否则会出现「改了环境变量却没生效」这种最难查的问题。

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | — | **必填**。不填则任何用例都跑不了 |
| `TYPESAFE_MODEL` | `jev-latest` | 决策模型 |
| `TEXT_MODEL_API_KEY` | — | 可选。不填则遇到 `TYPE_TEXT` 的用例直接报错，而不是猜一个值 |
| `TEXT_MODEL_BASE_URL` / `TEXT_MODEL` | DeepSeek | 文本取值小模型 |
| `JEVTEST_PORT` | `8770` | 仅绑定 127.0.0.1 |
| `JEVTEST_WORKERS` | `1` | worker 并发度。1 = 串行 |
| `JEVTEST_ENGINE_INFLIGHT` | `4` | 在途引擎请求上限。**与 `WORKERS` 刻意解耦** |
| `JEVTEST_HEADLESS` | `true` | 要肉眼看 agent 操作时设 `false` |
| `JEVTEST_TRACING` | `true` | 关掉可省磁盘，但失败时就没 trace 可看了 |
| `JEVTEST_CASES_DIR` / `JEVTEST_RUNS_DIR` | `./cases` / `./runs` | 用例库与运行产物 |
| `JEVTEST_DEFAULT_ENGINE` | `typesafe` | 用例未声明 `engine` 时用它。`scripted` 不在注册表里（测试专用，见下） |

`JEVTEST_WORKERS` 与 `JEVTEST_ENGINE_INFLIGHT` 为什么是两个而不是一个：
前者的瓶颈是浏览器内存（每 context 约 80~150MB），后者是厂商侧限流。
两者无关，绑成一个总闸会让其中一个白白闲置（见 `browser/pool.ts`）。

> ⚠️ **`zod` 的 minor 版本是承重的。** 用例预算是否生效取决于 `.prefault()` 的行为
> （见 §5.1），而声明写的是 `^4.0.0` 而非固定版本——全新安装可能解析到更高的 minor。
> 升级 zod 之后**必须重跑那条 `budget.maxModelCalls === 40` 的断言**，
> 否则预算静默失效、成本无上限。

---

## 2. 常用命令

```bash
npm run dev -- --help        # 跑 CLI（无需编译）
npm run dev -- serve         # 启动 Web 平台
npm run typecheck            # tsc --noEmit，零错误是硬要求
npm test                     # node:test 离线测试
npm run build                # tsc -> dist/ + 复制非 TS 资产
npm run doctor               # 检查环境
node --check src/browser/snapshot.js    # 单独校验快照脚本语法
```

**开发期不需要编译。** `--experimental-strip-types` 直接执行 `.ts`，
`tsc` 只做类型检查。

---

## 3. TypeScript 配置的几个非默认选择

配置在 `tsconfig.json`，每一条都不是随手加的。

### `"module": "NodeNext"` + 源码内写 `./foo.ts`

ESM 下相对导入必须带扩展名。而 Node 的类型剥离要求扩展名与实际文件一致，
所以源码内写 `./foo.ts`，由 `rewriteRelativeImportExtensions` 在构建时改写成 `./foo.js`。

```ts
// 正确
import { loadSettings } from "./config.ts";

// 构建后自动变成
import { loadSettings } from "./config.js";
```

**这是 tsc-only + ESM 的固定代价，不是配置错误。** 忘写扩展名会在 `tsc` 时报错。

### `"erasableSyntaxOnly": true`

禁止 `enum`、`namespace`、构造函数参数属性等**无法被单纯擦除**的语法。

这样源码永远可以被 `node --experimental-strip-types` 直接执行，
开发期不需要任何编译步骤。代价是不能用 `enum` 的便利——
本项目统一用字符串字面量联合类型代替（如 `ActionKind`、`RunStatus`）。

### `"verbatimModuleSyntax": true`

强制类型导入必须显式写 `import type`：

```ts
import type { Case } from "./schema/case.ts";     // 正确
import { Case } from "./schema/case.ts";          // 报错
```

这是 Node 类型剥离能正确工作的前提——它必须能判断哪些导入是纯类型的。

### `"strict": true` 与 `noUncheckedIndexedAccess`

后者让 `arr[0]` 的类型带上 `| undefined`。写起来啰嗦一点，
但在这个项目里值得——大量代码在处理「模型的输出可能缺字段」这类问题。

---

## 4. 零成本测试

**硬性要求：任何测试都不得调用付费 API。**

靠 `src/engine/scripted.ts` 实现——它按预设数组返回决策答案，
与真实引擎实现同一个 `DecisionEngine` 接口，因此 runner 完全不知道
自己在跟谁说话。

```ts
const engine = createScriptedEngine({
  steps: [
    { operation: { choice: "TYPE_TEXT" }, type_text_target: { choice: "1" }, text: "Ada Lovelace" },
    { operation: { choice: "CLICK" }, click_target: { choice: "3" } },
    { operation: { choice: "DONE" } },
  ],
});
```

这把参考项目 `tests/test_agent.py:77-95` 里
`monkeypatch.setattr(model, "post_json", fake)` 的手法提升到了注册表层。
差别很大：monkeypatch 只能测孤立单元，而这里
**server + queue + pool + runner + checks 的全链路**都能被确定性地测试。

`src/browser/session.ts` 的 `Session` 接口是同一思路的另一半：
`core/` 只依赖接口，不 import playwright，因此单元测试用 `FakeSession`
就能覆盖 runner 的全部控制流，不需要启动浏览器。

### 浏览器相关的测试

需要真浏览器的测试放在 `tests/e2e/`，用本地 fixture 站点（`fixtures/site/`），
不访问外网。外网用例（如 Wikipedia）只在显式设置 `JEVTEST_E2E=1` 时才跑。

---

## 5. 必须防住的陷阱

按踩到的概率排序。

### 5.1 zod v4 的 `.default({})` 不解析默认值 ⚠️ 会真金白银出事

```ts
// 错误：budget 会是 {}，嵌套默认值全部丢失
z.object({ budget: BudgetSchema.default({}) })

// 正确：.prefault 是 input-side 默认，会走 schema 解析
z.object({ budget: BudgetSchema.prefault({}) })
```

**后果**：`budget.maxModelCalls` 变成 `undefined`，用例预算静默失效、
**成本无上限**。这是会烧钱的那种 bug，而且不会报错。

脚手架验证时解析到的是 zod 4.6.5，`.prefault()` 可用。注意 `package.json` 写的是
`^4.0.0` 而非固定版本，因此升级 zod 后必须重跑这条断言。必须配套测试：

```ts
assert.equal(CaseDefinitionSchema.parse({ 最小输入 }).budget.maxModelCalls, 40);
```

### 5.2 `tsc` 不复制非 TS 资产

`src/browser/snapshot.js` 与 `src/web/public/*` 不会被 `tsc` 产出到 `dist/`。
它们由 `scripts/copy-assets.mjs` 负责，`npm run build` 里已串好。

漏了的话本地开发察觉不到（类型剥离直接跑源码），**部署时才炸**。
所以 `doctor` 里要加一条 dist 资产完整性检查。

`snapshot.js` 之所以保持 `.js`：它以**文本**读出后注入 `page.evaluate`，
从不作为模块 import。保持 `.js` 可以继续被 `node --check` 与 IDE 语法校验。

### 5.3 Playwright 抛错必须映射成 `StalePage`

页面导航时 Playwright 会抛 `Execution context was destroyed` 或 `Target closed`。

**若不映射，每一次正常跳转都会被记为运行失败**，报告直接失去意义。

用 `core/errors.ts` 的 `mapBrowserError`。对应参考项目
`browser.py:40-41` 对 `exceptionDetails` 的处理。

### 5.4 `context.close()` 与 `tracing.stop()` 必须在 `finally`

否则异常路径下 `trace.zip` 不落盘——**丢掉的恰好是最需要看的那次运行**。

同理 `pool.withSession()` 把 try/finally 封在里面，让调用方不可能写错。
验证方式：运行结束后 `GET /api/queue` 的 `contextsActive` 必须是 0。

### 5.5 点击不要换成 `locator.click()`

必须用 `page.mouse.click(x, y)`。理由见
[architecture.md §7.1](architecture.md#71-两个不能直译的地方)。

同理原生 `<select>` 保留 JS 直接设值 + 派发事件的写法。

### 5.6 先记日志，再观测

```ts
history.push(stepRecord);                 // 先
const next = await session.observe();     // 后
```

反过来写，一次恰好发生在观测时的导航会让「我们点过了」从轨迹里消失。
见 [architecture.md §6.3](architecture.md#63-先记执行日志再观测结果)。

### 5.7 断言绝不进 prompt

发往模型的 `DecisionRequest` 里**不许出现任何断言内容**。

让 agent 看见判分标准会诱导它对着答案演戏，也破坏策略的通用性。
参考项目里 `goal` 与 `verify()` 完全解耦，这里保持同样纪律。

---

## 6. 代码约定

| 约定 | 说明 |
| --- | --- |
| 注释写"为什么"，不写"是什么" | 代码本身能说明做什么；注释的价值在于记录**为什么这样而不是那样** |
| 移植来的代码标注来源 | 文件头写明来源与 MIT 署名，详见 [`NOTICE`](../NOTICE) |
| 不引入前端构建工具链 | 原生 HTML/CSS/JS。`tsc` 是编译器，不算打包器 |
| 后端依赖控制在 3 个 | 加依赖前先问"手写要多少行" |
| 错误信息给人看 | 说清原因和怎么修，不要只抛 `Error: failed` |
| 字符串联合类型代替 `enum` | `erasableSyntaxOnly` 要求 |

### 关于 `snapshot.js`

它保持上游的**变量命名风格**（紧凑、无空格）与 snake_case 返回字段，
即使这与项目其他部分不一致。

这是刻意的：**上游若修复了可访问名解析或守卫语义，我们能直接 diff
而不必重新推导。** 字段映射的职责在 `playwright-session.ts`。

---

## 7. 实现顺序建议

**纵向切片，不是横向分层。**

```text
schema/case.ts
  → browser/snapshot.js + session.ts + playwright-session.ts
      里程碑：打开 Wikipedia 主页并打印元素表
  → engine/types.ts + typesafe.ts + core/policy.ts
      里程碑：跑一次决策，打印 operation 与概率分布
  → core/agent.ts + checks.ts + report.ts
      里程碑：完整跑完一个用例，CLI 输出报告 JSON
  → 最后才是 web/
```

**先 CLI 后 Web。** CLI 跑通了，Web 层就只是薄薄的 I/O 与渲染；
而且离线 e2e 测试可以在 Web 层存在之前就锁死 runner 的正确性。

每个里程碑都应该是**可运行的**，而不是"写完了但还不能跑"。

---

## 8. 修改 checklist

改完代码后：

```bash
npx tsc --noEmit                          # 必须 0
node --check src/browser/snapshot.js      # 动了快照就要跑
npm test                                  # 全绿且无付费调用
npm run build && ls dist/browser/         # 动了资产就确认复制到位
```

改 schema 时额外：

1. 同步更新 [`docs/case-format.md`](case-format.md) 的字段表
2. 跑 `yaml-roundtrip.test.ts` 确认「表单 ↔ YAML」没漂移
3. 破坏性变更要递增 `schemaVersion` 并写迁移说明

改移植代码时额外：

1. 对照上游实现确认没有丢掉语义
2. 在文件头保留来源标注

---

## 9. 尚待验证

**权威列表在 [architecture.md §11](architecture.md)**——那里分三部分记录了
接口层矛盾（§11.1，**已定案**）、通路与模块（§11.2，**已补齐**）
与待验证事项（§11.3，**需要真跑才能回答**）。§11.1 与 §11.2 读它们是**替代重新推导**，
动手时照此执行，不要自行发挥。

本节只保留与开发流程直接相关的两条，其余不重复，避免两处漂移。

| 事项 | 状态 |
| --- | --- |
| 无头模式下的完整任务跑通 | 未验证。这是 CI 的前提，应先于 CI 搭建验证 |
| `doctor` 的 dist 资产完整性检查 | 尚未实现（见 §5.2）。漏了本地察觉不到，**部署时才炸** |
