# jevtest

**基于快速自主决策的 Web 测试套件平台。** 你提供测试地址和测试用例，它自动跑完并给出可读的报告。

> ✅ **当前状态：P0 已实现。** 全部模块落地，`npm test` **480 项全绿**
> （470 项离线 + 10 项真浏览器 e2e），`npx tsc --noEmit` 零错误。
> 三个子命令 `doctor` / `validate` / `import` 已实测通过；`serve` 与 `run` 见
> [当前进度](#当前进度) 里尚未实测的两条。
> 尚未做完的部分（截图通路、JUnit、多引擎）逐项列在 [接下来做什么](#接下来做什么)。

---

## 这是什么

传统的端到端测试要你写清楚每一步：点哪个元素、填什么值、断言什么。元素改个 id 就得改测试。

jevtest 换了个方式：**你只写一句自然语言目标，它自己决定每一步做什么。**

```yaml
goal: >-
  On Wikipedia, find and open the article about Gödel's incompleteness theorems.
```

它拿到的不是截图，而是一张带索引的元素表：

```text
[1] link     Main Page
[2] searchbox Search Wikipedia
[3] button   Search
...
```

每次决策**只发一次 API 请求**，同时问「执行哪个操作」和「每个操作的候选目标是什么」，
然后只消费被选中操作对应的那个答案。模型从头到尾看不到 CSS 选择器，
也写不出坐标或可执行脚本——它只能从观测到的元素里挑一个索引。

这带来两个直接好处：**快**（参考实现 7.1 秒完成一次真实的 Google Flights 搜索），
和**抗改版**（元素 id、class、DOM 结构变了都不影响，只要可访问名还在）。

## 和 jev-ultrafast 的关系

**本项目是独立项目，不是 jev-ultrafast 的分支或二次开发。**

设计与部分实现参考了 [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
（MIT License，Copyright (c) 2026 Browser Use）。那是一个演示：一次跑一个目标，
没有用例概念、没有批量执行、没有报告，唯一的"断言"是给 Google Flights 硬编码的一段
`verify()`。它用 Browser Harness 直连用户已有的 Chrome，因此 profile 共享、无法并行、
无头 CI 困难。

jevtest 把它抽象成产品：加了用例模型、断言层、批量执行、报告与 Web 界面，
浏览器层换成 Playwright。移植的部分逐项列在 [`NOTICE`](NOTICE) 与
[`docs/architecture.md`](docs/architecture.md#4-从-jev-ultrafast-借鉴了什么)。

## 快速开始

```bash
npm install
npx playwright install chromium     # 约 150MB，首次需要
cp .env.example .env                # 填 TYPESAFE_API_KEY（必需）与 TEXT_MODEL_API_KEY（可选）
```

然后：

```bash
npm run dev -- serve                # 启动 Web 平台 http://127.0.0.1:8770
npm run dev -- run cases/wikipedia-godel.yaml
npm run dev -- doctor               # 检查环境是否齐备
```

> `doctor` / `validate` / `import` 可直接跑；`serve` 与 `run` 需要凭证
> （`run` 还需要 Chromium，见上一行）。

开发期用 `node --experimental-strip-types` 直接跑 `.ts`，不需要编译。
`npm run typecheck` 做类型检查，`npm run build` 才产出 `dist/`。

## 架构总览

```text
页面观察 ──► 索引化元素表 ──► 决策请求 ──► 选中的操作+目标 ──► 护栏 ──► 浏览器
                                 │                                    │
                                 │                          仅 TYPE_TEXT 时
                                 │                                    ▼
                                 │                            小模型生成文本
                                 ▼
        一次请求同时问:
          operation        选哪个操作
          click_target     若点，点哪个
          type_text_target 若输入，输到哪
          select_target    若下拉，选哪个
        只消费被选中操作对应的那一个 head
```

分层与依赖方向（箭头 = 依赖）：

```text
   cli ─► web ─► core ─► engine ─► schema
                  │        │
                  └──────► browser ──┘
```

| 层 | 职责 | 关键约束 |
| --- | --- | --- |
| `schema/` | 数据契约，全项目唯一事实来源 | 不含逻辑；`case.ts` 的字段表与 `docs/case-format.md` 一一对应 |
| `store/` | 磁盘读写：用例仓库、版本迁移 | 纯 CRUD，只依赖 `schema/`。**磁盘格式只有一个决定者** |
| `engine/` | 决策引擎（可插拔） | **纯网络组件**，不碰浏览器。因此「浏览器变更从不重试」由结构保证，而非靠自觉 |
| `browser/` | Playwright 封装 | `core/` 只依赖 `Session` 接口，从不 import playwright |
| `core/` | 策略、循环、断言、护栏、预算 | 安全边界在此确立 |
| `web/` | HTTP 服务与界面 | 只监听 127.0.0.1，三重安全守卫 |
| `util/` | 并发原语 | `Semaphore` / `AsyncQueue`，共约 40 行 |

> 运行产物的落盘在 `core/report.ts` 而非 `store/`——它要组装 `steps` / `assertion` /
> `stats`，与运行生命周期紧密耦合；而用例是纯 CRUD。这是**有意的不对称**。

## 目录导览

```text
src/
  cli.ts                        serve | run | validate | import | doctor
  config.ts                     环境变量读取与校验
  schema/
    case.ts                     ★ 用例 schema，唯一事实来源
    report.ts                   运行报告
    events.ts                   ★ 共享词汇表（ActionKind / Operation / RunStatus）+ 运行事件
    yaml.ts                     规范化序列化（往返幂等）
  engine/
    types.ts                    ★ DecisionEngine 接口与供应商无关 IR
    registry.ts                 引擎注册表
    typesafe.ts                 TypeSafe 实现（P0 唯一真实引擎）
    scripted.ts                 ★ 零成本回放引擎（测试用）
    text.ts                     文本取值请求构造与响应校验
  browser/
    snapshot.js                 ★ 原子 DOM 快照（移植自 jev-ultrafast，见 NOTICE）
    session.ts                  ★ Session 接口 —— 可测试性的枢纽
    playwright-session.ts       Playwright 实现（含 CDP 映射表）
    pool.ts                     一个 Chromium，每个用例一个 context
    admission.ts                用例准入检查（规则表 + 纯函数判定）
  store/
    cases.ts                    ★ 用例仓库：读写、版本、ID 分配、乐观锁
    migrations.ts               版本迁移（只在读时发生，永不改写磁盘）
  core/
    rules.ts                    提示词（移植自 jev-ultrafast questions.py）
    policy.ts                   ★ 动作空间 / 决策请求 / 校验 / 解析
    agent.ts                    ★ 执行循环，五条顺序敏感的不变量
    guard.ts                    三道安全护栏
    budget.ts                   用例级预算（成本控制的唯一落点）
    checks.ts                   三层断言求值
    runner.ts                   任务队列 + worker 池
    report.ts                   报告落盘与导出
    errors.ts                   错误类型（叶模块）
  util/
    async.ts                    Semaphore / AsyncQueue，另一片叶子
  web/
    server.ts                   node:http + 路由
    api.ts                      REST 端点
    security.ts                 Host + Token + Origin 三重守卫
    events.ts                   事件日志（轮询，非 SSE）
    public/                     原生 HTML/CSS/JS，无构建工具链
```

★ = 实现时最需要先读懂的文件。

## 文档

**契约类**——这些是权威定义，改代码要同步改它们，反之亦然：

| 文档 | 定义什么 |
| --- | --- |
| [docs/case-format.md](docs/case-format.md) | **输入契约**：YAML 用例格式，含每个字段的类型与默认值 |
| [docs/report-format.md](docs/report-format.md) | **输出契约**：运行产出物（磁盘布局、`run.json` 字段、导出格式） |
| [docs/api.md](docs/api.md) | **HTTP 契约**：端点、守卫、请求/响应。未定的形状都标了「待定」 |

**理解类**——接手项目按这个顺序读：

| 文档 | 内容 |
| --- | --- |
| [docs/glossary.md](docs/glossary.md) | 术语索引（一句话 + 权威出处）。**新会话先扫这个** |
| [docs/architecture.md](docs/architecture.md) | 分层、数据流、从 jev-ultrafast 借鉴了什么、CDP → Playwright 映射表。**动手前必读 §11** |
| [docs/security.md](docs/security.md) | 安全模型：资产、对手、**信任边界表**、五道防线 |
| [docs/limitations.md](docs/limitations.md) | 已知边界 + **用例准入清单**（准入判定的权威来源） |

**实践与记录**：

| 文档 | 内容 |
| --- | --- |
| [docs/writing-cases.md](docs/writing-cases.md) | 怎么写用例才不容易假阳性/假阴性，含正反例 |
| [docs/development.md](docs/development.md) | 离线开发、零成本测试、NodeNext 约定、构建 |
| [docs/decisions.md](docs/decisions.md) | 关键选型记录与理由（**只记已拍板的**，未决见 architecture §11） |
| [tests/README.md](tests/README.md) | 测试计划，含两个必须防住的陷阱 |

## 三个必须理解的设计点

这三条是理解本项目的关键，写在代码注释里的同时也在这里复述一遍。

### 1. `status` 和 `passed` 是两件事

`status` 描述**循环如何结束**（`done` / `blocked` / `budget_exceeded` / `guardrail_blocked` /
`cancelled` / `error`），`passed` 描述**断言判决**。

`status: "done"` 且 `passed: false` 是完全正常的组合——模型认为自己完成了，
独立断言发现它没有。这是参考项目最重要的信条在类型层面的固化：

> A `DONE` choice is not proof of success.

### 2. 只读模式在动作空间**构造阶段**实现

`mode: readonly` 时，变更型操作在构建候选集时就被剔除，
因此 `targets` 里**根本不存在** `TYPE_TEXT` / `SELECT` 键。
模型物理上无法选中它们——不是事后过滤，而是由构造提供安全。

### 3. 概率分布区分 `full` / `degenerate`

TypeSafe 给出真实概率分布；通用 LLM 通常只回一个选择，合成出来是 one-hot 1.0。
若不区分，`quality.minTargetProbability: 0.3` 在通用引擎上会**假通过**。

所以断言结果有三种状态而非两种：`passed` / `failed` / **`skipped`**。
`skipped` 既不算通过也不算失败，报告里必须显示「跳过」——**绝不能显示「通过」**。

## 已知陷阱

实现时最容易踩的几个，详细说明见 [docs/development.md](docs/development.md)：

| 陷阱 | 后果 |
| --- | --- |
| zod v4 的 `.default({})` 不解析默认值 | `budget` 变 `undefined`，**用例预算静默失效、成本无上限**。必须用 `.prefault()` |
| `NodeNext` 要求源码内写 `./foo.ts` | 配合 `allowImportingTsExtensions` + `rewriteRelativeImportExtensions` 才是完整方案 |
| `tsc` 不复制非 TS 资产 | `snapshot.js` 与 `web/public/*` 靠 `scripts/copy-assets.mjs` |
| Playwright 抛错未映射 | `Execution context was destroyed` 未映射成 `StalePage`，每次正常导航都被记为运行失败 |
| `tracing.stop()` 不在 `finally` | 异常路径下 `trace.zip` 不落盘，丢掉的正是最需要看的那次运行 |
| 点击用 `locator.click()` 而非 `page.mouse.click(x, y)` | 丢掉「元素被遮挡/已移动」的判断，该停下的时候继续点 |

## 当前进度

| 阶段 | 内容 | 状态 |
| --- | --- | --- |
| **脚手架** | 目录结构、30 个模块的类型与接口、配置、种子用例、整套文档 | ✅ 完成 |
| **P0 前置** | `scripted` 引擎 + `fixtures/site/` + `FakeSession` | ✅ 完成，且已被 480 项测试用上 |
| P0 骨架 | engine(TypeSafe) + browser + core/agent + checks + CLI | ✅ 完成 |
| P1 Web 平台 | server + api + 前端（用例管理、运行、结果页） | ✅ 完成（实时进度用轮询；界面基于 Bootstrap 5，走 `/vendor/` 直引，不打包） |
| P2 工程化 | 护栏 + 预算 + trace.zip + 并发 | ✅ 完成（JUnit 导出仍是 stub） |
| P3 收尾 | 套件自身离线测试 | ✅ 480 项；CI 配置未做 |

**已实测通过的：**

| 验证 | 结果 |
| --- | --- |
| `npx tsc --noEmit` | **0 错误**（`docs/development.md §8` 的硬要求） |
| `npm test` | **480 / 480**（470 离线 + 10 真浏览器 e2e，零付费调用、零外网） |
| `node --check src/browser/snapshot.js` | 通过 |
| `jevtest doctor` | 9 项检查：8 通过 / 1 警告（文本模型未配置）/ 0 失败 |
| `jevtest validate cases/wikipedia-godel.yaml` | 解析 + 默认值填充 + 内部自洽检查全部通过 |
| `jevtest import cases/wikipedia-godel.yaml` | 落盘为 `cases/wikipedia-godel/case.yaml`，revision 1，digest 稳定 |
| 真浏览器全链路（e2e） | 观测 → 决策 → 执行 → 断言 → 报告落盘 + trace.zip；护栏命中时 `executed: false` 且页面处理器未跑；`contextsActive` 归零 |
| **真 TypeSafe + 真 Wikipedia 跑 `cases/wikipedia-godel.yaml`** | `done` + `passed: true`（10/10 断言），2 步 / 6 次模型调用 / 33,859 input tokens / 约 5 秒。基线数据与抓到的三个缺陷见 [`architecture.md §11.3`](docs/architecture.md) |

**尚未实测的：**

| 未做 | 原因 |
| --- | --- |
| `jevtest serve` 的人工点验收 | 界面已用**真 Chromium**走查过一遍（四条路由 × 浅/深色，控制台与网络均无报错，`/vendor/` 的 Bootstrap 正常下发），但那是脚本驱动的渲染核对，不是人在真浏览器里点着用过。表单交互、行编辑器增删、跑用例时的实时进度这些**手感**层面的事仍未经人验 |
| 除种子用例之外的真跑 | 目前**只有一个用例**过了真跑这道闸——含下拉、复选框、断言更严的用例都还没跑过 |
| TypeSafe 是否报金额 | 实测没有：响应里没有金额字段，因此成本类断言在真引擎下是 skipped。要按金额设上限得先补这个映射 |

## 接下来做什么

按价值排序。前两条是**技术债**，其余是 P1 功能。

| # | 事项 | 为什么排这个位置 |
| --- | --- | --- |
| 1 | **再写 2~3 个真用例并跑通**（含下拉、复选框、更严的断言） | 验证闸已经过了，但**只有一个用例**过了——它的路径是「输入 + 点自动补全」，没有覆盖下拉、复选框、陷阱元素在真站点上的行为。基线数据见 [`architecture.md §11.3`](docs/architecture.md) |
| 2 | 人工点一遍 `jevtest serve` | 渲染层已经用真 Chromium 核对过（见上表），`tests/frontend.test.ts` 也把「改了会静默坏」的跨文件约定钉住了。剩下的纯粹是**手感**：表单填一遍、行编辑器增删、跑一次用例看实时进度，这些脚本替不了人 |
| 3 | 截图通路（`recordFrames`） | `StepRecord.frame` 与 `framesDir` 恒为 null。事件里只带 `frame` 序号的设计已经就位，缺的是 runner→agent 的接线（`browser/session.ts` 的 `frameJpeg()` 是现成的） |
| 4 | `toJUnit` | `core/report.ts` 里仍是 stub，`GET /api/runs/:id/export?format=junit` 明确回 501。CI 集成前必须有 |
| 5 | `openai-compat.ts` 通用引擎 | 让 `capabilities.probabilities: "degenerate"` 这条设计有第二个真实用户。需要先解决「引擎的凭证从哪来」（`EngineContext` 目前只有一对 apiKey/model） |
| 6 | shadow DOM 递归 / 跨 iframe | `docs/limitations.md` 里记着，准入会警告。有 `fixtures/site/` 之后补起来不难 |
| 7 | CI 配置 | `npm test` 已经能全绿，缺的只是一个 workflow 文件（记得装 Chromium，否则 e2e 会跳过） |

**如果你是新会话接手这个项目，按这个顺序读：**

1. [`docs/glossary.md`](docs/glossary.md)——术语索引。**先扫一遍建立地图**，
   后面读到「观测」「目标 head」「退化分布」「准入」时不至于卡住
2. 本文件的「三个必须理解的设计点」——不理解这三条，后面的代码会看不懂
3. [`docs/architecture.md`](docs/architecture.md) 的「从 jev-ultrafast 借鉴了什么」一节——
   知道哪些是移植、哪些是新写，以及每项的来源
4. `src/schema/case.ts` 与 `src/engine/types.ts`——数据契约
5. `src/core/agent.ts` 的注释——五条顺序敏感的不变量，**改循环前必读**
6. [`tests/README.md`](tests/README.md)——测试计划与两个必须防住的陷阱

> ✅ **设计缺口已全部关闭**，记在 [architecture.md §11](docs/architecture.md)。
> **实现前读 §11.1 与 §11.2**——它们说明了几处「看起来可以自由发挥、实际已经定死」
> 的选择：`checkQuality` 的概率取样口径、`RunStats` 归谁持有、`engineOptions` 为何被砍掉、
> `passed` 为何是三态、准入为何不做成闸、`modelCalls` 为何按请求数算、
> 停机信号怎么传到 agent 的每步检查点。
>
> 读它们是**替代重新推导**，不要自行发挥——这些结论都对应着具体的失败模式，
> 重新推导很容易推出一个「看起来更简洁但会静默失真」的方案。

**推荐的实现顺序是纵向切片，不是横向分层**（P0 已按此走完，记在这里供后续参考）：

```text
schema/case.ts
  → browser/snapshot.js + session.ts + playwright-session.ts
      目标：打开 Wikipedia 主页并打印元素表
  → engine/types.ts + typesafe.ts + core/policy.ts
      目标：跑一次决策，打印 operation 与概率分布
  → core/agent.ts + checks.ts + report.ts + runner.ts + budget.ts
      目标：完整跑完一个用例，CLI 输出报告 JSON
  → store/cases.ts + migrations.ts
      目标：用例能存能读能版本化（CLI 的 validate / import 先于 Web 用到）
  → 最后才是 web/（server + api + 前端）
```

`store/` 排在 `core/` 之后、`web/` 之前是刻意的：它只被 CLI 的
`validate` / `import` 和 Web 层用到，而**循环本身不需要它**——
`CaseAgent` 收的是已解析的 `Case`，不关心它从磁盘还是测试里来。
所以它不该挡住前面几个里程碑。

**先 CLI 后 Web。** CLI 跑通了，Web 层就只是薄薄的 I/O 与渲染；
而且离线 e2e 测试（真浏览器 + `scripted` 引擎 + 本地 fixture 站点）
可以在 Web 层存在之前就锁死 runner 的正确性——实际上它是**最后一个才被补上的**
模块的验证手段：`core/runner.ts` 与 `core/agent.ts` 的行为全部由
`FakeSession` + scripted 引擎锁住，一次真实模型调用都没发生。

### 验证闸：真跑一次

**在进入 Web 层之前插一道验证闸**：拿 `cases/wikipedia-godel.yaml` 真跑 5 次，
记下步数、请求数、token、耗时与失败模式，再回头重审 `schema/` 与 `engine/` 的接口。

理由是：几乎每个设计决策——一问多题的收益、三层断言、8 个 `RunStatus`、
每 context 隔离的成本、两个信号量的取值——都建立在「上游 7.1 秒跑完 Google Flights」
这**一个**数据点上（[architecture.md §11.3](docs/architecture.md) 自己也记着「未实测」）。

**这道闸已经过了**（2026-09-21，真 TypeSafe + 真 Wikipedia）：`done` + `passed: true`，
2 步 / 6 次模型调用 / 33,859 input tokens / 约 5 秒。过程中抓到三个离线测试看不见的真缺陷
（请求体形状不对、`act` 的陈旧决策被误判成运行故障、导航在途时观测被判失败），
每一个都补了回归测试，详见 [`architecture.md §11.3`](docs/architecture.md)。

闸门本身仍然值得定期重跑：它验的不是「代码能跑」，而是**接口定型的那些假设还成不成立**。

```bash
npm run dev -- run cases/wikipedia-godel.yaml        # 跑一次并输出报告
npm run dev -- run cases/wikipedia-godel.yaml --format md
npm run dev -- serve                                  # 起界面，逐条看事件与断言
```

### 改完代码后的检查

```bash
npx tsc --noEmit                        # 应为 0（硬要求）
node --check src/browser/snapshot.js    # 动了快照就要跑
npm test                                # 480 项，应全绿且无付费调用
npm run build && ls dist/browser/       # 动了资产就确认复制到位
```

e2e（`tests/e2e/`）需要真 Chromium：没装时它会**显式跳过**并显示在汇总里，
而不是让 `npm test` 变红——环境缺浏览器与代码坏掉是两回事。

## 许可

MIT。移植部分见 [`NOTICE`](NOTICE)。
