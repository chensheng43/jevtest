# 怎么写用例

格式定义见 [`case-format.md`](case-format.md)。本文讲**怎么写得不容易出错**。

一句话前提：**这个平台不替代 Playwright，它补的是 Playwright 不划算的那一块。**
用错地方会得到又慢又贵又飘的结果，然后误以为平台不行。

---

## 1. 先判断这个用例适不适合

### 适合

| 场景 | 为什么适合 |
| --- | --- |
| 部署后"主流程还能不能走通" | 一句话写清目标即可，不需要为每个元素写选择器 |
| 长尾流程 | 写 Playwright 要维护几十行选择器，收益不值 |
| 粗粒度回归：搜索、筛选、下单前几步 | 断言放在最终状态上，中间怎么走不关心 |
| 可访问性健康度 | **Jev 找不到控件，通常意味着它的可访问名太差**。这是免费的副产品 |

### 不适合

| 场景 | 为什么不适合 |
| --- | --- |
| 字段级边界值、表单校验规则 | 需要精确控制输入与断言，Playwright 更快更便宜 |
| 并发、竞态、超时行为 | agent 的非确定性会掩盖真实问题 |
| 高频跑（每次 commit） | 单用例约 10~20 次付费调用 |
| 必须逐步复现的缺陷回归 | 每次运行路径可能不同 |
| 像素级视觉断言 | 本平台不看截图 |
| 需要登录态精确编排的多角色流程 | 目前没有角色切换机制 |

---

## 2. 写 `goal` 的三条规则

### 规则一：写你要什么，不写怎么做

```yaml
# 好
goal: 搜索并打开关于哥德尔不完备定理的条目

# 差
goal: 点击搜索框，输入 "Gödel"，点击第一个搜索建议，然后点击结果里的第一条链接
```

第二种写法有两个问题：把平台降级成了糟糕的 Playwright；
而且一旦页面结构变化，写死的步骤就会失败——**恰好丢掉了用它的理由**。

### 规则二：说清"停在哪里"

agent 需要知道什么状态算完成。

```yaml
# 好：明确了终止条件
goal: >-
  On Wikipedia, find and open the article about Gödel's incompleteness theorems.
  Stop when that article is displayed.

# 差：没说什么算完成
goal: 看看维基百科上关于哥德尔的东西
```

### 规则三：把约束写进去

护栏是硬性的，`goal` 是软性的。有些要求适合直接说：

```yaml
goal: >-
  Find and open the article. Do not create an account or sign in.
```

但**真正不能碰的东西要写进 `guardrails`**，不要只靠 `goal` 里的一句话——
前者是代码强制的，后者只是提示。

---

## 3. 断言写在哪一层

三层各管一件事，写错层次会得到误导性的报告。

| 问题 | 写在哪 |
| --- | --- |
| 最终页面对不对？ | `final` |
| 有没有走错路、碰了不该碰的？ | `trajectory` |
| 这次跑得稳不稳、贵不贵？ | `quality` |

### 判断标准：这个检查失败时，我想知道什么？

- 「页面上没有出现预期内容」→ `final`
- 「它绕过了搜索框，直接用直达链接蒙对了」→ `trajectory.mustUse`
- 「它点了登录按钮」→ `trajectory.mustNotUse`
- 「它跑了 40 步才完成，正常应该 8 步」→ `quality.maxModelCalls` 或 `trajectory.maxSteps`

---

## 4. 常见陷阱

### 陷阱一：用 URL 全等断言

```yaml
# 差
final:
  url:
    equals: "https://example.com/search?q=test"

# 好
final:
  url:
    matches: ["/search\\?q=test"]
```

URL 里常有无关的追踪参数、会话 id、排序参数。
全等断言会在第一次站点改动时碎掉，且碎得没有意义。

### 陷阱二：断言太严，把实现细节当成了需求

```yaml
# 差：把"它怎么做的"当成了"要什么"
final:
  controls:
    - labelContains: "Sort by"
      valueEquals: "Relevance"
```

如果业务需求只是「能搜到结果」，那排序方式是实现细节。
断言它会让测试在无关改动时失败——**这种失败会训练人忽略红灯**，
比没有测试更糟。

### 陷阱三：没有 `mustUse`，只靠最终状态

考虑这个用例：搜索并打开某条目。

只断言最终 URL，agent 可能直接用了页面上的直达链接——
结果"通过"了，但它根本没有验证搜索功能。

```yaml
trajectory:
  mustUse:
    - role: searchbox     # 必须真的走过搜索
```

### 陷阱四：`minTargetProbability` 在非 TypeSafe 引擎上假通过

如果将来给用例换了通用 LLM 引擎（`distribution: degenerate`），
目标概率恒为 1.0，这个断言会**永远通过**。

平台的处理是把它标为 `skipped`，报告显示「跳过」。
**看到「跳过」不要当成通过**——它意味着这条检查这次没有覆盖到。

### 陷阱五：把断言写进 `goal`

```yaml
# 差
goal: 搜索哥德尔，并确保最终 URL 包含 Gödel 且页面文本包含 incompleteness
```

这等于把答案告诉考生。agent 可能为了让 URL 通过而做奇怪的事，
而你的测试就失去了检验能力。**断言只用来检验，不用来引导。**

### 陷阱六：忘了设预算

默认预算是 40 步 / 40 次调用 / 200k tokens。

一个简单的用例如果跑了 30 步，通常不是复杂性高，而是 **agent 卡住了**。
给简单用例设一个紧预算（如 `maxSteps: 12`），能让卡死早暴露、少花钱。

### 陷阱七：在 `readonly` 用例里断言 `fill`

只读模式下变更型操作不在候选集里，写 `mustNotUse: [{kind: fill}]`
会通过——但它通过是因为**构造上不可能**，不是因为 agent 克制。

这是好事，但要知道它的通过不提供额外信息。
真正有价值的是 `mode: interactive` 下用 `mustNotUse` 约束行为。

---

## 5. 一个完整的正例

```yaml
schemaVersion: 1
id: wikipedia-godel
title: Wikipedia 打开哥德尔不完备定理条目

# 只说要什么，以及停在哪
goal: >-
  On Wikipedia, find and open the article about Gödel's incompleteness theorems.
  Stop when that article is displayed.

startUrl: https://en.wikipedia.org/wiki/Main_Page
allowedOrigins: [https://en.wikipedia.org]

budget:
  maxSteps: 12          # 紧预算：超过 12 步说明卡住了，不是复杂
  maxModelCalls: 24
  maxInputTokens: 150000

guardrails:
  - labelContains: Create account
    reason: 测试不允许创建账号

assertions:
  final:
    # 正则而非全等：URL 可能带锚点或参数
    url:
      matches: ["Gödel|Incompleteness"]
    # 不 notContains "Search results"：那是过程，不是结果
    text:
      contains: ["incompleteness"]
  trajectory:
    statusIn: [done]
    maxSteps: 12
    mustUse:
      - role: searchbox        # 必须真走搜索，不能蒙直达链接
    mustNotUse:
      - labelContains: Log in  # 不该登录
  quality:
    minOperationProbability: 0.4   # 低于此值说明模型在犹豫
    maxModelCalls: 24
```

---

## 6. 调试一个失败的用例

按这个顺序查：

| 现象 | 先看什么 |
| --- | --- |
| `status: done` 但 `passed: false` | **最常见**。看 `final` 族哪条没过，对比报告里的实际值。通常是断言写太严或 goal 没说清 |
| `status: blocked` | 看轨迹最后几步。通常是目标控件不在候选集里——可能踩中了[已知边界](limitations.md) |
| `status: budget_exceeded` | 看 `quality` 与步数。卡死的话调大预算没用，要改 goal |
| `status: guardrail_blocked` | 看 `guardrailHits`。命中内置护栏说明 goal 太宽；命中自定义护栏说明护栏太严 |
| `status: error` | 基建问题，不是用例问题。看错误消息与 trace.zip |
| 通过但耗时异常长 | 用 `quality.maxElapsedMs` 卡住它。可能是模型在某一步反复犹豫 |

**任何失败都先打开 `npx playwright show-trace runs/<runId>/trace.zip`。**
它有时间轴和每一步的 DOM 快照，比读报告快得多。

---

## 7. 从 Playwright 迁过来的用例怎么处理

| Playwright 里的东西 | 这里对应什么 |
| --- | --- |
| `page.goto(url)` | `startUrl` |
| 一串 `click` / `fill` | 删掉。用 `goal` 描述意图 |
| `expect(locator).toHaveText()` | `final.text.contains` 或 `final.controls[].valueContains` |
| `expect(page).toHaveURL()` | `final.url.matches`，或 `trajectory.statusIn` |
| 等待与重试逻辑 | 删掉。平台内部处理 |
| 测试夹具与数据准备 | 目前**没有对应机制**。见下方"尚不支持" |

**迁移时最该保留的是断言，最该删掉的是步骤。**
如果发现断言不完整、必须靠步骤顺序才能表达清楚，
那说明这个用例更适合留在 Playwright 里。

---

## 8. 尚不支持

写用例时请注意这些**还没有**的能力，它们会影响用例设计：

- **测试数据准备与清理**（fixture / teardown）——没有。用例需要的数据得预先存在
- **登录态管理**——底层 `storageState` 能力已有，但还没有配套的界面与用例字段
- **跨用例的数据传递**
- **参数化用例**（同一用例多组数据）
- **后端副作用校验**——只能断言页面，不能查数据库或调后端 API 确认操作真的生效

最后一条最值得注意：目前**断言只覆盖前端可见状态**。
「点击下单后页面显示了成功」不等于「订单真的创建了」。
