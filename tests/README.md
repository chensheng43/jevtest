# tests/

离线测试。用 Node 内置的 `node:test`，不引入 vitest——devDeps 只留
`typescript` 与 `@types/node`。

```bash
npm test
```

## 硬性要求

**任何测试都不得调用付费 API。** 这靠 `scripted` 引擎实现
（`src/engine/scripted.ts`，设计见 [architecture.md §3.4](../docs/architecture.md)）。

同理，除 `tests/e2e/` 外不应启动浏览器；`tests/e2e/` 里的用例用本地 fixture 站点
（见 `fixtures/site/`），不访问外网。外网的 Wikipedia 用例只有显式设置
`JEVTEST_E2E=1` 时才跑。

## 覆盖内容

| 文件 | 覆盖内容 |
| --- | --- |
| `schema.test.ts` | **默认值必须真的被解析**——断言 `CaseDefinitionSchema.parse({最小输入}).budget.maxModelCalls === 40`。这条专门守着 zod v4 的 `.default({})` 陷阱，见下方 |
| `yaml-roundtrip.test.ts` | YAML → 对象 → 序列化 → 解析 → 深比较；digest 稳定。「对象 ↔ 表单草稿」那一段在 `frontend.test.ts` |
| `migrations.test.ts` | 逐级升级、版本过高报错、迁移链断裂报错 |
| `config.test.ts` | 环境变量默认值、越界拒绝、布尔写法、错误信息含修复方式 |
| `policy.test.ts` | `buildActionSpace` 的 readonly 模式**不含** `TYPE_TEXT` / `SELECT` 键；一个节点只拿一个索引；select 的每个 option 是独立 target；**断言不进 prompt**；只读角色清单与文档一致 |
| `validate-choice.test.ts` | 移植参考项目 `test_invalid_choice_is_rejected` 的六个参数：unknown / nan / missing / negative / non_max / confidence；**未选中的 target head 非法不抛** |
| `guardrails.test.ts` | 护栏命中（`session.act` 调用次数为 0 的前提）、域名白名单 fail-closed、`allowDefaultOverride`、select 的两半都查 |
| `checks.test.ts` | 三层断言求值；四条概率取样约束；**`skipped` 不等于 `passed`**——degenerate 分布下概率检查必须标 skipped；稳定路径 key |
| `report.test.ts` | 组装、原子落盘、迁移→zod 回读、index 坏行跳过、`toMarkdown` 的实际值与期望 |
| `runner.test.ts` / `agent.test.ts` | 五条不变量：陈旧决策不执行、**变更不重试**、先记日志再观测、连续无进展判 blocked、取消在步边界 |
| `budget.test.ts` | 各维度超限都正确刹车且**轨迹被保留**；`modelCalls` 按请求数算（重试不是免费通道）；`costUsd` 为 null 不写 0 |
| `async.test.ts` | Semaphore 的公平性与 `with` 的异常安全；AsyncQueue 的 close 语义 |
| `cases.test.ts` | 原子写（含 Windows rename 退化）、乐观锁、revision 从目录推导、导入冲突追加 `-2` |
| `engine.test.ts` / `text.test.ts` / `registry.test.ts` | TypeSafe 的重试/计数/取消（打本地假端点）、scripted 的回放、文本取值的前言拒绝规则、注册表 |
| `security.test.ts` | 三道闸的反向用例、`/vendor` 的穿越防护（含 NUL 与各类编码） |
| `events.test.ts` / `api.test.ts` | 事件的 seq 语义与回放；HTTP 集成（含 413 流式限长、409 带 currentRevision、路径穿越、令牌不泄漏） |
| `admission.test.ts` | 准入规则逐条命中/不命中 |
| `frontend.test.ts` | 前端静态资产的**契约**（无 DOM 环境，见下）：扫描 `public/` 下全部模块——查的 id 在 `index.html` 里都存在、每个模块都被 import、令牌头名与 `security.ts` 一致、`/vendor/` 引用都在白名单内、**D9/D8 的三态与未判定取自互不相同的色系**、不用原生 `alert`/`confirm`；外加直接 import `lib/core.js` 跑**编辑器往返**（种子用例载入再保存语义不变、每个配方与原始字段都落得下去、空 `statusIn` 原样活着）与**字段名/检查项/校验文案的人话翻译** |
| `e2e/fixture.e2e.test.ts` | **真浏览器**：观测/几何/遮挡命中测试、全链路（输入→提交→动态结果→断言→报告自包含）、护栏拦截、readonly 的候选集、`contextsActive` 归零 |

`frontend.test.ts` 不断言 DOM 结构、也不截图——项目没有 jsdom，也不打算引入。
它只守「改了之后**页面照常打开、但行为静默错掉**」那一类约定，因为那类问题
`npm test` 本来抓不到。它唯一执行前端代码的地方是 `lib/core.js`（不碰 DOM，直接 import）。

**界面本身点起来对不对**是另一回事，那由 `scripts/ui-walkthrough.mjs` 负责：

```bash
npm run walkthrough     # 自己起服务、自己收摊，用临时用例库，不碰 cases/ 与 runs/
```

它用真 Chromium 走一遍：导入（含空内容报错）、编辑与标脏（含原始行）、双击保存不出假冲突、
快捷键保存、重载后断言还在、离开确认框、新建与校验（字段标红 + 人话汇总 + 点击跳转）、
保存内容抽屉、运行列表与结果页（判决带、轨迹时间线、截图加载、断言明细）、深色模式、
菜单 + 确认框删除；并收集控制台/网络报错与任何原生对话框，截图落在临时目录。这不是 `npm test`
的一部分（要真浏览器、要几十秒）。改了界面之后跑一遍。

需要真 Chromium。没装时整组**显式跳过**（`npx playwright install chromium`），
而不是让 `npm test` 变红——环境缺浏览器与代码坏掉是两回事。

## 必须写进测试的两个陷阱

### 1. zod v4 的 `.default({})` 不解析默认值

用错会让**用例预算静默失效、成本无上限**。`schema.test.ts` 里那条
`budget.maxModelCalls === 40` 的断言必须存在。详见 [development.md §5.1](../docs/development.md)。

### 2. `skipped` 不是 `passed`

断言结果有三种状态，不是两种。把 `skipped` 当成 `passed` 会让报告谎报通过——
比直接失败更危险，因为它让人以为有覆盖而实际没有。
