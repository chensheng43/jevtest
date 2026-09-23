# 运行报告格式

**本文是运行产出物的权威定义。** 与 [`case-format.md`](case-format.md) 对称：
那是**输入**契约（你写什么 YAML），这是**输出**契约（你读出什么 JSON）。

类型定义在 [`src/schema/report.ts`](../src/schema/report.ts)——那是唯一事实来源。
本文讲**字段的含义、消费方式与不能踩的坑**，类型细节以该文件为准。

产出物有三类消费方，本文对每一类都标出该看什么：

| 消费方 | 主要读什么 |
| --- | --- |
| CI | `status` 与 `passed` 两个字段、`toJUnit()` 的映射规则 |
| Web 结果页 | `steps[]` 与 `assertion.checks`，按**稳定路径**定位 |
| 排查的人 | `trace.zip`、`steps[]` 里的实际值、`guardrailHits` |

---

## 1. 磁盘布局

一次运行产出 `runs/<runId>/`：

```text
runs/
  index.jsonl          一行一条摘要，列表页不必读完整报告
  <runId>/
    run.json           完整报告（CaseRunReport）
    case.yaml          产生本次运行的用例冻结快照
    frames/<n>.jpg     按需截图，序号对应 StepRecord.frame（默认关闭）
    trace.zip          Playwright trace，npx playwright show-trace 可直接打开
```

布局与落盘逻辑在 [`src/core/report.ts`](../src/core/report.ts)。三条不能动的性质：

1. **报告自包含。** `case.yaml` 是入队时冻结的副本，加上 `caseRevision` / `caseDigest`，
   事后翻出一份旧报告能精确回到产生它的**用例版本**。用例后来改了，旧报告的结论依然可解释。
   这是 D13，对应上游 `measurement.json` 里的 `source_hashes`。

2. **落盘必须原子。** 先写临时文件再 `rename`。否则进程被中断会留下半截 `run.json`，
   列表页一读就崩——而崩溃发生在下一次打开界面时，跟真正的故障点已经隔了很远。

3. **`frames/` 默认关闭。** 开启会让运行目录膨胀并拖慢每一步。事件里只带 `frame` 序号，
   画面由前端另外请求，见 [`architecture.md §8.4`](architecture.md)。

`index.jsonl` 的追加**由 runner 统一做**，不让各 worker 各写各的——并发追加会交错出坏行。
读的时候坏行跳过，而不是让整个列表打不开（`core/report.ts` 的 `readIndex`）。

---

## 2. `run.json` 字段

### 2.1 身份与版本

| 字段 | 含义 |
| --- | --- |
| `schemaVersion` | 报告格式版本，恒为 `1`。**报告比用例更需要迁移**——用例可以改，报告是长期留存的物证 |
| `runId` | 本次运行 id，也是目录名 |
| `caseId` / `caseRevision` / `caseDigest` | 用例身份三件套，让报告能回到确切的用例版本 |
| `suiteRunId` | 属于哪次批量运行；单跑为 `null` |
| `engine` | 实际使用的决策引擎。同一用例的 A/B 对比靠它区分 |

### 2.2 结论

| 字段 | 含义 |
| --- | --- |
| `status` | **循环如何结束**（8 种取值，见 §3） |
| `passed` | **断言判决**：`true` / `false` / `null`（`null` = 未能求值） |
| `failureReason` | 非 `done` 时的原因说明，给人看 |

这两个字段是独立的两件事，是本项目最重要的设计约束——语义与常见组合见
[`case-format.md` §status 与 passed](case-format.md)，本文不重复。

### 2.3 轨迹

`steps: StepRecord[]` 是**断言层的核心输入**，也是「模型的 DONE 不算证据」的物证：
无论最终 `status` 是什么，走过的每一步都在这里。

| 字段组 | 字段 | 说明 |
| --- | --- | --- |
| 选择 | `action` / `kind` / `role` / `operation` / `target` | `action` 是**人类可读标签**，轨迹断言按它匹配（见 D7） |
| 置信 | `probability` / `operationProbability` / `confidence` / `distribution` | `distribution` 为 `degenerate` 时，依赖概率的断言标 `skipped` |
| 执行 | `executed` / `blockReason` | `executed: false` = **浏览器没收到任何输入**，被护栏拦下了 |
| 输入 | `text` / `textEngine` | TYPE_TEXT 实际输入的文本；`textEngine` 为生成它的引擎名 |
| 时序 | `urlBefore` / `urlAfter` / `pageChanged` / `observedMs` / `engineLatencyMs` / `textLatencyMs` | `pageChanged` 为 `null` = 执行后观测失败（例如导航打断），**不代表动作没发生** |
| 画面 | `frame` | 对应 `frames/<n>.jpg`；未开启截图为 `null` |
| 成本 | `engineUsage` | 该步的 token / 金额 / 重试请求数 |

> `pageChanged` 的三态（`true` / `false` / `null`）值得单独说：`null` 不是「没变化」，
> 而是「没能观测」。无进展检测只应把 `false` 计入连续计数，把 `null` 当成 `false`
> 会误判卡死——而这恰好发生在页面正常导航的时候。

### 2.4 护栏与准入

| 字段 | 说明 |
| --- | --- |
| `guardrailHits[]` | `{ step, reason, action }`。命中即**浏览器未收到输入**，是**好结果**——说明安全网起作用了 |
| `admission` | 准入报告。在 `CaseAgent.run()` 第一次 `observe()` 之后采集一次。**是记录与警告，不是运行的闸**——`ok: false` 不阻止运行，只是把 `blocking` 项显著展示出来。确定性地说：一次正常跑完的运行，这个字段必定非 `null` |

### 2.5 成本统计

`stats: RunStats`：`steps` / `modelCalls` / `decisions` / `inputTokens` / `outputTokens` /
`costUsd` / `elapsedMs` / `engineLatencyMs`。

⚠️ **`costUsd` 为 `null` 时不要写 0。** 引擎未报金额时无法校验，
用 `null` 表示「未知」；用 0 冒充会让成本统计悄悄失真，而成本正是这个平台最需要盯住的指标。

⚠️ **`modelCalls` 与 `decisions` 不是一回事，不要混用。**

| 字段 | 含义 |
| --- | --- |
| `modelCalls` | **实际 HTTP 请求数，含重试与文本取值。** `budget.maxModelCalls` 与 `quality.maxModelCalls` 都按它算 |
| `decisions` | 逻辑决策数，不含重试、不含文本取值。**只用于展示** |

一次重试 3 次才成功的决策记 **3** 个 `modelCalls`、**1** 个 `decisions`。
按逻辑决策数算的话，重试就是一条免费通道——最坏情况实际花费是预算的 3 倍而刹车不会响。

**文本取值（TYPE_TEXT 走的小模型）也算 `modelCalls`，但不算 `decisions`**：
它同样是要花钱的一次调用，预算不能对它视而不见。因此

```text
modelCalls - decisions = 重试造成的额外请求 + 文本取值调用
```

报告里看到「24 次调用 / 8 次决策」，先看 `steps[]` 里有几次 `fill`：
差异大致就是「重试 + 输入」。若一次 `fill` 都没有，那这个差就全是重试，问题在网络或限流，
而不在用例本身。

### 2.6 断言结果

`assertion: AssertionResult | null`。`null` 表示**未能求值**（例如预算在第一步之前就耗尽），
此时没有最终页面可供断言——这与「失败」是两回事。

`assertion.checks` 的 key 是**稳定路径**，报告与前端的定位都依赖它，因此生成规则不要随意改：

```text
final.url
final.text.contains[0]
final.controls[2].valueEquals
trajectory.mustNotUse[1]
quality.maxInputTokens
```

粒度为**条目**，不是整体。报告要能指出「7 条里第 3 条没过」，而不是「text 没过」。

`assertion.passed` 是 **`boolean | null`**，与 `CheckResult` 的三态对齐：

| 情况 | `assertion.passed` |
| --- | --- |
| 有任一检查失败 | `false` |
| 无失败，但有检查被跳过 | **`null`（未判定）** |
| 全部通过 | `true` |
| 没有任何检查项 | `null` |

中间那行是关键：7 条通过、1 条因 `degenerate` 分布被跳过时，整体判 `null` 而非 `true`。
判 `true` 就是 D9 要杜绝的谎报覆盖——我们确实没验证那一条。
聚合规则在 `core/checks.ts` 的 `aggregateChecks`。

> `assertion` 自身为 `null` 与 `assertion.passed` 为 `null` 是两件事：
> 前者是**断言层根本没跑**（例如预算在第一步之前就耗尽），
> 后者是**跑了但有检查无法求值**。报告里要能区分这两种情况。

---

## 3. `status` 取值

8 种，描述**循环如何退出**：`queued` / `running` / `done` / `blocked` /
`budget_exceeded` / `guardrail_blocked` / `cancelled` / `error`。

逐项含义、以及 `status` × `passed` 的常见组合表，见
[`case-format.md` §status 与 passed](case-format.md)。本项目的状态名到中文说明的映射
在 `core/runner.ts` 的 `STATUS_LABELS`，报告与界面共用同一份。

判断 CI 成败时记住三条：

- **`status: done` 不代表成功。** 必须看 `passed`。
- **`guardrail_blocked` 不一定是坏消息。** 先确认那是不是预期行为。
- **`error` 是基建问题，不是用例问题。** CI 上必须区别于测试失败——这正是
  `toJUnit` 把断言失败映射为 `<failure>`、把运行故障映射为 `<error>` 的理由。

---

## 4. 导出格式

| 导出 | 实现 | 用途 |
| --- | --- | --- |
| Markdown | `toMarkdown(report)` | 贴进 PR 或 issue |
| JUnit XML | `toJUnit(reports)` | CI 消费（**尚未实现**，导出端点回 501） |

Markdown 摘要**必须**包含：结论、每条断言的实际值与期望、步数与成本、trace 的打开方式。
失败时还要带上最终页面 URL 与关键元素的可见值——没有这些，一份失败报告对排查毫无帮助。

JUnit 的映射要点：

| 情况 | 映射 |
| --- | --- |
| 断言失败（`passed: false`） | `<failure>` |
| 运行故障（引擎不可达、浏览器崩溃） | `<error>` |
| 被跳过的检查 | **不产生** `<failure>` |

最后一条是关键：把 `skipped` 映射成 `<failure>` 会让 CI 报出并不存在的失败，
而映射成通过则正是 D9 要杜绝的谎报覆盖。

---

## 5. `index.jsonl`

`RunIndexEntry`，一行一条，让列表页不必读完整报告：

| 字段 | 说明 |
| --- | --- |
| `runId` / `caseId` / `caseTitle` / `suiteRunId` / `startedAt` | 定位 |
| `status` / `passed` / `elapsedMs` / `steps` | 结论与规模 |
| `costUsd` | **`number \| null`**，与报告里同一纪律：未知就是 `null` |

---

## 6. 变更本格式时

1. 改 `src/schema/report.ts`
2. 改本文
3. 若改了 `assertion.checks` 的 key 生成规则，同步改 `core/checks.ts`、前端与本文——
   那是报告与界面之间的接口
4. 若是**破坏性**变更，递增 `schemaVersion` 并写迁移说明（迁移落点是 `store/migrations.ts` 的
   `REPORT_MIGRATIONS`，见 [architecture.md §11.2 ④](architecture.md)）
