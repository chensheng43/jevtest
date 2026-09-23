# 术语表

**本文是索引，不是定义。** 每条给一句话与**权威出处的链接**——
要看完整的定义、取舍理由与反例，去那一处。本文再复述一遍只会制造第二份事实来源。

用它是为了两个场景：

- **新接手项目**——先扫一遍建立地图，再按层去读；
- **读到某个词不确定是哪个概念时**——尤其是像「目标」「观测」「动作」这种
  日常词被赋予了特定含义的情况。

---

## 0. 贯穿全项目的信条

这三条是理解一切的钥匙，写在 README 的「三个必须理解的设计点」里。

| 信条 | 一句话 | 出处 |
| --- | --- | --- |
| **A DONE choice is not proof of success** | 模型说完成不算完成，独立断言说了才算 | [README](../README.md)、[decisions D8](decisions.md) |
| **`status` ≠ `passed`** | 前者描述循环如何结束，后者是断言判决。`done` + `false` 是完全正常的组合 | [case-format.md](case-format.md)、[report-format.md](report-format.md) |
| **有限选择空间即安全边界** | 模型只能从观测到的元素里挑索引，看不到也写不出选择器、坐标或脚本 | [architecture.md §5.1](architecture.md) |

---

## 1. 共享词汇表（`schema/events.ts`）

三个枚举被所有层引用，其余模块只从这里取，不从彼此取。

| 术语 | 一句话 | 出处 |
| --- | --- | --- |
| `ActionKind` | 可执行动作的**种类**：`click` / `fill` / `select` / `scroll` / `wait` | `schema/events.ts` |
| `Operation` | 决策引擎可以**选择**的操作（`CLICK` / `TYPE_TEXT` / … / `DONE` / `BLOCKED`） | 同上 |
| `RunStatus` | 运行**如何结束**的 8 种取值 | 同上 |

> `ActionKind` 与 `Operation` 是两件事：前者是代码执行的动作，后者是模型选择的意图。
> 两者靠 `core/policy.ts` 的 `KIND_TO_OPERATION` 映射。

---

## 2. 观测层（`browser/`）

| 术语 | 一句话 | 出处 |
| --- | --- | --- |
| **观测 / Observation** | 一次原子读取的产物——**模型能看到的一切**。不含选择器、不含 HTML | `browser/session.ts` |
| **原子** | 元素表、文本、守卫状态必须在**同一次** `page.evaluate` 里取完 | `browser/session.ts` 的 `observe` |
| **元素表** | 索引化的可交互元素清单，形如 `[3] button 搜索` | `browser/snapshot.js` |
| **`node` / code-owned 节点身份** | 由 WeakMap 分配的节点 id。**不是** CDP backendNodeId，也不是选择器，模型无法伪造 | `browser/session.ts` 的 `Action` |
| **`pageKey`** | 文档级语义状态（timeOrigin / href / 滚动 / 视口 / 表单值），用于新鲜度比较 | `browser/session.ts` 的 `Observation` |
| **`guard`** | 单个元素的局部守卫状态，供**动作级**新鲜度比较 | 同上 |
| **`marker`** | 整页语义标记，用于 `wait` / `scroll` / `fill` 的新鲜度比较 | 同上 |
| **`fingerprint`** | `sha256(url + text + actions + scroll)`，快速判断页面是否变化 | 同上 |
| **新鲜度 / `isFresh`** | 判断页面相对某次观测是否仍然有效。传入 `action` 时做动作级比较 | `browser/session.ts` |
| **`StalePage`** | 决策所指的页面已经不是当前页面。**这是正常控制流，不是故障** | `core/errors.ts` |
| **`OccludedTarget`** | 目标在执行前最后一刻变得不可点：被移除、遮挡、移出视口或禁用 | 同上 |
| **`Session`** | 浏览器会话接口。**可测试性的枢纽**——`core/` 只依赖它，从不 import playwright | `browser/session.ts` |
| **一个 context 一个用例** | 隔离边界。换到 Playwright 换来的最大收益 | [decisions D11](decisions.md) |

---

## 3. 决策层（`engine/` + `core/policy.ts`）

| 术语 | 一句话 | 出处 |
| --- | --- | --- |
| **`DecisionEngine`** | 决策引擎接口。**纯网络组件**，不碰浏览器、不持有会话 | `engine/types.ts` |
| **IR** | 供应商无关的中间表示。引擎只负责「IR ↔ HTTP」的翻译 | 同上 |
| **一问多题** | 一次请求同时问「执行哪个操作」和「每个操作的候选目标是什么」 | [architecture.md §3.1](architecture.md) |
| **`operation` head** | `questions[0]`，恒为操作选择 | `engine/types.ts` |
| **target head / 目标** | `<operation>_target` 形式的问题，为该操作选一个目标 | 同上 |
| **候选集 / `Option` / `id`** | 模型可选的项。`id` 是 code-owned 的，模型只能回传它 | 同上 |
| **`choice` / `probabilities` / `confidence`** | 模型的回答：选了哪个、各候选的概率、整体置信度 | 同上 |
| **`distribution: full \| degenerate`** | `full` = 真实分布；`degenerate` = one-hot 合成（通用 LLM 只回一个选择） | [architecture.md §5.3](architecture.md) |
| **`validateChoice`** | 校验模型输出。判据移植自上游，一条不改 | `core/policy.ts` |
| **`InvalidDecision`** | 模型输出不合法。**此时绝不执行任何动作** | `core/errors.ts` |
| **脚本化引擎 / `scripted`** | 零成本回放引擎。把 monkeypatch 手法提升到注册表层 | [architecture.md §3.4](architecture.md) |
| **`capabilities`** | 引擎如实声明自己的能力：是否支持文本生成、概率是 full 还是 degenerate | `engine/types.ts` |

---

## 4. 执行层（`core/`）

| 术语 | 一句话 | 出处 |
| --- | --- | --- |
| **动作空间 / `ActionSpace`** | 由观测构建的「模型可选的操作与目标」全集 | `core/policy.ts` |
| **`readonly` / `interactive`** | 只读模式下变更型操作**在构造阶段就被剔除**，不在候选集里 | [decisions D10](decisions.md) |
| **护栏 / guardrail** | 禁止动作清单。命中即在**任何浏览器输入之前**终止 | `core/guard.ts`、[decisions D14](decisions.md) |
| **准入 / admission** | 判断这个用例本平台能不能测。`Session.probe()` 采集统计，`admit()` 是纯函数判定。**是记录与警告，不是运行的闸** | `browser/admission.ts`、[architecture.md §11.1 ⑥](architecture.md) |
| **`ADMISSION_RULES`** | 准入规则表。写成数据而非散在 `if` 里，因为文档的准入清单要从它生成 | `browser/admission.ts` |
| **预算 / `BudgetMeter`** | 成本控制的**唯一落点**：步数 / 调用数 / token / 金额 / 墙钟，多维硬刹车 | `core/budget.ts` |
| **`BudgetView`** | 下发给引擎的只读预算视图，让引擎自行裁剪上下文 | `engine/types.ts` |
| **无进展检测** | 连续 N 步页面无变化且非 `wait` → 判 `blocked`。最省钱的一道闸 | [architecture.md §6.5](architecture.md) |
| **`CaseStore`** | 用例仓库。`cases/<id>/` 的读写、版本、ID 分配。**D5「YAML 是唯一事实来源」被守住的地方** | `store/cases.ts` |
| **`revision`** | 用例版本号。**从 `revisions/` 目录推导，不维护计数器文件**——计数器会漂移，目录不会 | `store/cases.ts` |
| **乐观锁 / `expectedRevision`** | 保存时带上期望版本，磁盘版本不符即拒绝。防两个标签页并发编辑时静默覆盖 | `store/cases.ts` |
| **迁移 / migration** | 读旧文档时逐级升级。**只在读时发生，永不改写磁盘**——报告是物证，改它等于篡改 | `store/migrations.ts` |
| **`shutdownController`** | 全局停机信号。与 per-run 的 `runController` 用 `AbortSignal.any` 合成后传给 agent | `core/runner.ts` |
| **`recordDecision` / `recordCall`** | 前者加一，后者按 `Usage.requests` 累加。分开是为了让重试**不是免费通道** | `core/budget.ts` |
| **五条不变量** | 执行循环里顺序敏感的五条约束，每条对应一个发生过的错误 | [architecture.md §6](architecture.md) |
| **`StepRecord`** | 轨迹中的一条记录。**断言层的核心输入** | `schema/report.ts` |
| **轨迹 / trajectory** | `steps[]` 的集合。按**人类可读标签**匹配，不按内部 id | [decisions D7](decisions.md) |

---

## 5. 断言层（`core/checks.ts`）

| 术语 | 一句话 | 出处 |
| --- | --- | --- |
| **三层断言** | `final`（最终页面对不对）/ `trajectory`（过程走对没走对）/ `quality`（稳不稳、贵不贵） | [decisions D6](decisions.md) |
| **`CheckResult` 三态** | `passed: true` / `passed: false` / `skipped: true`。**`skipped` 既不算通过也不算失败** | [decisions D9](decisions.md) |
| **稳定路径** | `checks` 的 key，形如 `final.text.contains[0]`。报告与前端按它定位 | `core/checks.ts`、[report-format.md](report-format.md) |
| **假阳性** | 失败原因是**平台测不了**，却被当成被测系统有缺陷。测试套件最致命的输出 | [limitations.md](limitations.md) |
| **假通过** | 检查没覆盖到却显示通过。**比失败更危险**——它让人以为测过了 | [decisions D9](decisions.md) |

---

## 6. 产出物（`core/report.ts`）

| 术语 | 一句话 | 出处 |
| --- | --- | --- |
| **`CaseRunReport` / `run.json`** | 一次运行的完整报告，**自包含** | [report-format.md](report-format.md) |
| **冻结用例 / `frozenCase`** | 入队时复制的用例快照，保证报告事后可解释 | 同上、[decisions D13](decisions.md) |
| **`caseDigest` / `caseRevision`** | 用例版本标识，让报告能精确回到产生它的用例版本 | `schema/case.ts` |
| **`suiteRunId`** | 批量运行的 id，把一组 run 关联起来；单跑为 `null` | `schema/report.ts` |
| **`contextsActive`** | 存活的浏览器 context 数。**运行结束后必须归零**，否则说明泄漏了 | [architecture.md §9.3](architecture.md) |
| **`RunIndexEntry`** | `runs/index.jsonl` 的一行，让列表页不必读完整报告 | [report-format.md](report-format.md) |

---

## 7. 容易混淆的几对

| 这对 | 区别 |
| --- | --- |
| `ActionKind` vs `Operation` | 前者是代码执行的动作种类，后者是模型选择的意图 |
| `status` vs `passed` | 循环如何结束 vs 断言判决。两者独立 |
| `Action` vs `ActionMatch` | 前者是运行时的可执行对象，后者是**断言里**的匹配器（按 label，不按 id） |
| `guardrail` vs `assertion` | 护栏是**事前**阻止「根本不许做」，断言是**事后**判断「做对了吗」 |
| `skipped` vs `passed` | 前者是「无法求值」，后者是「满足」。混同就是谎报覆盖 |
| `blocked` vs `guardrail_blocked` | 前者是 agent 自己说走不动，后者是被安全网拦下 |
| `budget_exceeded` vs `quality.maxCostUsd` | `budget` 是运行时硬刹车（超了直接停），`quality` 是事后断言（超了算失败） |
| `degenerate` vs `full` | 前者是 one-hot 合成的假分布，会让概率断言失去意义 |
| `admission` vs `assertion` | 准入是**跑之前**判断平台能不能测，断言是跑完判断做对没有 |
| `error` vs `passed: false` | 前者是基建坏了，后者是用例（或断言）有问题。CI 上必须区分 |
