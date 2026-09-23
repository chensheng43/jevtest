# jevtest

**基于快速自主决策的 Web 测试套件平台。** 你提供测试地址和测试用例，它自动跑完并给出可读的报告。

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

这带来两个直接好处：**快**（种子用例真跑约 5 秒、2 步完成），
和**抗改版**（元素 id、class、DOM 结构变了都不影响，只要可访问名还在）。

## 和 jev-ultrafast 的关系

**本项目是独立项目，不是 jev-ultrafast 的分支或二次开发。**

设计与部分实现参考了 [browser-use/jev-ultrafast](https://github.com/browser-use/jev-ultrafast)
（MIT License，Copyright (c) 2026 Browser Use）。那是一个演示：一次跑一个目标，
没有用例概念、没有批量执行、没有报告，唯一的"断言"是给 Google Flights 硬编码的一段
`verify()`。

jevtest 把它抽象成产品：加了用例模型、断言层、批量执行、报告与 Web 界面，
浏览器层换成 Playwright。移植的部分逐项列在 [`NOTICE`](NOTICE) 与
[`docs/architecture.md` §4](docs/architecture.md#4-从-jev-ultrafast-借鉴了什么)。

## 快速开始

需要 Node ≥ 22.7。

```bash
npm install
npx playwright install chromium     # 约 150MB，首次需要
cp .env.example .env                # 填 TYPESAFE_API_KEY（必需）与 TEXT_MODEL_API_KEY（可选）
```

```bash
npm run dev -- doctor               # 检查环境是否齐备
npm run dev -- serve                # 启动 Web 平台 http://127.0.0.1:8770
npm run dev -- run cases/wikipedia-godel.yaml
npm test                            # 离线测试，零付费调用
```

开发期用 `node --experimental-strip-types` 直接跑 `.ts`，不需要编译。
更多命令与改完代码后的检查见 [`docs/development.md`](docs/development.md)。

## 三个必须理解的设计点

1. **`status` 和 `passed` 是两件事。** 前者描述循环如何结束，后者是独立断言的判决。
   `status: done` 且 `passed: false` 是完全正常的组合——*A `DONE` choice is not proof of success.*
   （[D8](docs/decisions.md)）
2. **只读模式在动作空间构造阶段实现。** 变更型操作根本不进候选集，模型物理上选不到，
   而不是选了之后再拒绝。（[D10](docs/decisions.md)）
3. **断言结果有三态：通过 / 失败 / 跳过。** 通用 LLM 的概率分布是合成的 one-hot，
   概率类断言在它上面会假通过，所以标为「跳过」——**绝不能显示成「通过」**。（[D9](docs/decisions.md)）

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
    typesafe.ts                 TypeSafe 实现（目前唯一真实引擎）
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
    async.ts                    Semaphore / AsyncQueue
  web/
    server.ts                   node:http + 路由
    api.ts                      REST 端点
    security.ts                 Host + Token + Origin 三重守卫
    events.ts                   事件日志（轮询，非 SSE）
    public/                     原生 HTML/CSS/JS + Bootstrap 样式，无构建工具链
```

★ = 最需要先读懂的文件。分层与依赖规则见 [`docs/architecture.md` §1](docs/architecture.md)。

## 文档

**契约**——权威定义，改代码要同步改它们：

| 文档 | 定义什么 |
| --- | --- |
| [docs/case-format.md](docs/case-format.md) | 输入：YAML 用例格式，每个字段的类型与默认值 |
| [docs/report-format.md](docs/report-format.md) | 输出：磁盘布局、`run.json` 字段、导出格式 |
| [docs/api.md](docs/api.md) | HTTP：端点、守卫、请求/响应 |

**理解**——接手项目按这个顺序读：

| 文档 | 内容 |
| --- | --- |
| [docs/glossary.md](docs/glossary.md) | 术语索引，先扫一遍建立地图 |
| [docs/architecture.md](docs/architecture.md) | 分层、数据流、执行循环的五条不变量、CDP → Playwright 映射、实现层定案（§11） |
| [docs/decisions.md](docs/decisions.md) | 选型记录：选了什么、放弃了什么、什么情况下该反悔 |
| [docs/security.md](docs/security.md) | 威胁模型与信任边界 |
| [docs/limitations.md](docs/limitations.md) | 已知边界与用例准入清单 |

**实践**：

| 文档 | 内容 |
| --- | --- |
| [docs/writing-cases.md](docs/writing-cases.md) | 怎么写用例才不容易假阳性/假阴性 |
| [docs/development.md](docs/development.md) | 环境、零成本测试、TS 配置、必须防住的陷阱、修改 checklist |
| [tests/README.md](tests/README.md) | 测试覆盖范围与界面走查脚本 |

## 还没做的

按价值排序：

| # | 事项 | 说明 |
| --- | --- | --- |
| 1 | 更多真用例 | 目前只有种子用例用真 TypeSafe + 真站点跑通过（基线见 [`architecture.md §11.3`](docs/architecture.md)）。含下拉、复选框、更严断言的用例都还没真跑过 |
| 2 | 人工使用 `jevtest serve` | 界面已由 `npm run walkthrough`（真 Chromium）脚本化走查，但滚动、窄屏、实时进度这类手感仍未经人验 |
| 3 | `toJUnit` | `core/report.ts` 里是 stub，`export?format=junit` 回 501。CI 集成前必须有 |
| 4 | 报告标注「停用过内置护栏」 | `allowDefaultOverride: true` 的运行在报告里看不出来，见 [`limitations.md` §9](docs/limitations.md) |
| 5 | 通用 LLM 引擎（`openai-compat.ts`） | 让 `probabilities: "degenerate"` 这条设计有第二个真实用户。需要先解决引擎凭证从哪来（`EngineContext` 目前只有一对 apiKey/model） |
| 6 | TypeSafe 的金额映射 | 实测响应里没有金额字段，成本类断言在真引擎下是 skipped |
| 7 | shadow DOM 递归 / 跨 iframe | 见 [`limitations.md`](docs/limitations.md)，准入会警告 |

## 许可

MIT。移植部分见 [`NOTICE`](NOTICE)。
