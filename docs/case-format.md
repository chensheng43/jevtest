# 用例格式规范

**本文是用例格式的权威定义。** YAML 文件、Web 表单、CLI 三条入口最终都归一到
同一份 schema（`src/schema/case.ts`）。改 schema 必须同步改本文；
`tests/schema.test.ts` 逐条核对本文列出的默认值，`tests/frontend.test.ts` 核对表单载入再保存不改变用例。

一个完整的例子见 [`cases/wikipedia-godel.yaml`](../cases/wikipedia-godel.yaml)。

输出侧的对称文档是 [`report-format.md`](report-format.md)——那是运行产出物的权威定义。
本文管**输入**（你写什么 YAML），它管**输出**（你读出什么 JSON）。

> **为什么没有 `engineOptions`：** 曾经设计过一个自由形态的
> `engineOptions: Record<string, unknown>` 用来给 `scripted` 测试引擎传答案序列，
> **已决定不采用**。理由：用例是给用户写的，用户不该在 YAML 里看到「答案序列」
> 这种测试脚手架；而且往「YAML 是唯一事实来源」里加自由形态字段，要穿过 YAML 往返、
> 冻结用例快照、`caseDigest` 三关，代价与收益不成比例。
>
> 测试引擎改走 `RunnerDeps.createEngine` 注入（那本来就是现成的注入点），
> **生产用例永不声明 `engine: scripted`**。详见
> [architecture.md §11.1 ④](architecture.md)。

---

## 顶层字段

| 字段 | 类型 | 必填 | 默认值 | 说明 |
| --- | --- | --- | --- | --- |
| `schemaVersion` | `1` | 否 | `1` | 格式版本，用于未来迁移 |
| `id` | string | 否 | 由 `title` 生成 slug | `^[a-z0-9][a-z0-9-]{1,63}$`，冲突时追加 `-2`、`-3` |
| `title` | string | **是** | — | 人类可读名称，显示在列表与报告里 |
| `goal` | string | **是** | — | 自然语言目标。**唯一的行为指令**，见下方 |
| `startUrl` | string (URL) | **是** | — | 起始地址 |
| `mode` | `interactive` \| `readonly` | 否 | `interactive` | 见下方 |
| `allowedOrigins` | string[] | 否 | `[startUrl 的 origin]` | 域名白名单 |
| `budget` | object | 否 | 见下方 | 成本与规模上限 |
| `guardrails` | Guardrail[] | 否 | `[]` | 追加在**内置默认集之上** |
| `allowDefaultOverride` | boolean | 否 | `false` | 是否允许移除内置护栏。慎用 |
| `engine` | string | 否 | `settings.defaultEngine` | 决策引擎名 |
| `assertions` | object | 否 | `{}` | 三层断言，见下方 |

### 关于 `goal`

`goal` 是 agent 看到的**全部**行为指令。它**不知道断言是什么**。

这是刻意的：让 agent 看见判分标准会诱导它对着答案演戏
（例如为了让 `final.url` 通过而伪造导航），也破坏策略的通用性。

所以：

- 想影响 agent 的行为，只能通过 `goal` 表达；
- 断言用来**检验**结果，不用来**引导**过程；
- 参考项目里 `goal` 与 `verify()` 是完全解耦的两件事，这里保持同样纪律。

### 关于 `mode`

| 值 | 效果 |
| --- | --- |
| `interactive` | 全部操作可用 |
| `readonly` | 变更型操作在**动作空间构造阶段**被剔除，因此 `TYPE_TEXT` / `SELECT` 根本不在候选集里，模型物理上无法选中 |

`readonly` 不是「事后拒绝」，而是「构造上不可能」。
被剔除的包括：`fill` 动作、`select` 动作，以及 role 属于
`{button, checkbox, radio, switch, combobox, menuitem, menuitemradio, menuitemcheckbox, option, gridcell}`
的 click。

后四个（ARIA 的选项、菜单单/复选项，以及日历与表格的可选单元格）不在最初的设计清单里，
是**实践补上的**：它们的点击同样会改变被提交的值，少列一个，只读用例就能悄悄改掉页面状态，
而报告里那句「本运行不可能发生变更」就变成了假话。清单的权威定义在
`src/core/policy.ts` 的 `READONLY_BLOCKED_CLICK_ROLES`，改它必须同步改本文。

刻意**不**剔除的：`link`（导航）、`tab`（切换可见面板，等同导航）、
`textbox` / `searchbox` / `spinbutton`（点击只是聚焦；输入才是变更，而输入走 `fill` 那条路径）。

### 关于 `allowedOrigins`

比对的是 **origin**（协议 + 主机 + 端口），不是完整 URL——站内路径跳转正常，
跳出站点才需要拦。

检查发生两次：

1. `goto` 之前——不许导航过去；
2. 每次观测之后——页面自己跳过去了也要发现。

越界即终止为 `guardrail_blocked`，且**在任何浏览器输入之前**。

---

## budget

| 字段 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `maxSteps` | integer > 0 | `40` | 最多执行多少步 |
| `maxModelCalls` | integer > 0 | `40` | 最多发出多少次决策请求 |
| `maxInputTokens` | integer > 0 | `200000` | 累计 input token 上限 |
| `maxCostUsd` | number \| null | `null` | 金额上限。`null` = 不设限 |
| `maxElapsedMs` | integer > 0 | `300000` | 墙钟时间上限（毫秒） |

**任一维度超限即终止**，`status` 变为 `budget_exceeded`。

两条重要行为：

1. **超限不丢轨迹。** 已产生的步骤照样交给断言层求值。用户需要知道
   「跑到一半停了，但前半段是否满足断言」。
2. **`maxCostUsd` 为 null 时不写 0。** 引擎未报金额时无法校验，
   用 `null` 表示「未知」而不是伪装成 0——用 0 冒充会让成本统计悄悄失真。

量级参考：参考实现在一次真实的 Google Flights 任务上消耗
**17 次决策请求、90,558 input tokens**。

---

## guardrails

```yaml
guardrails:
  - labelContains: Create account
    reason: 测试不允许创建账号
```

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `labelContains` | string | 三者至少一 | 可访问名子串，不区分大小写 |
| `labelMatches` | string | 三者至少一 | 可访问名正则 |
| `role` | string | 三者至少一 | 限定角色，用于消歧 |
| `reason` | string | **是** | 拦截时报告显示给用户 |

命中时：**浏览器不会收到任何输入**，`StepRecord.executed` 为 `false`，
运行终止为 `guardrail_blocked`。这是好结果——说明安全网起作用了。

### 内置默认护栏只增不减

内置集覆盖破坏性动词（delete / purchase / pay / checkout / place order /
transfer / 删除 / 支付 / 下单……）与敏感输入（密码框、文件上传）。

用例**只能追加，不能移除**。要移除必须显式设置 `allowDefaultOverride: true`。
注意它是**整套停用**，不是删掉其中几条。按设计报告顶部应打红色横幅（**尚未落地**：报告目前不记录这件事，见 [limitations.md §9](limitations.md)）。

这个设计是为了让「悄悄关掉安全网」变得困难：默认安全，放弃安全需要明说。

---

## assertions

三层，分别回答不同的问题。

| 层 | 回答的问题 | 影响 `passed` |
| --- | --- | --- |
| `final` | 最终页面是否满足要求？ | 是 |
| `trajectory` | 过程是否走对了？有没有碰不该碰的？ | 是 |
| `quality` | 这次运行稳不稳、贵不贵？ | 是 |

### final —— 最终页面

```yaml
assertions:
  final:
    url:
      matches: ["Gödel|Incompleteness"]
    title:
      contains: ["incompleteness theorems"]
    text:
      contains: ["first incompleteness theorem"]
      notContains: ["Search results"]
    controls:
      - labelContains: "Search"
        role: searchbox
        exists: true
        valueContains: "Gödel"
      - labelContains: "Create account"
        exists: false
```

**TextMatch**（`url` / `title` / `text` 通用）：

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `equals` | string | 全等。URL 带 query 时很脆，慎用 |
| `contains` | string[] | 每一项生成一个独立检查项 |
| `notContains` | string[] | 每一项生成一个独立检查项 |
| `matches` | string[] | 正则，`new RegExp(pattern)` |

**数组的每一项产出独立的检查项**，报告粒度到条目
（`final.text.contains[0]`），而不是「text 整体通过/失败」。

**ControlAssertion**：

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `labelContains` | string | **必填** | 唯一的定位手段。没有选择器可用 |
| `role` | string | — | 可选，用于消歧 |
| `exists` | boolean | `true` | 设 `false` 表示断言「此元素不存在」 |
| `valueEquals` | string | — | 当前值全等 |
| `valueContains` | string | — | 当前值包含 |
| `valueMatches` | string | — | 当前值正则 |
| `checked` | boolean | — | 复选框/单选框状态 |

> **为什么只能按 label 定位？** 模型从头到尾看不到选择器，
> 断言层依赖它等于引入了一条模型看不见、而断言依赖的隐含契约。
> 上游 `examples/flights.py:29` 的 `values.get("Where from?") == "Zürich"`
> 就是这个模式。

### trajectory —— 动作轨迹

```yaml
  trajectory:
    statusIn: [done]
    maxSteps: 12
    mustUse:
      - role: searchbox
    mustNotUse:
      - labelContains: Log in
    forbiddenKinds: [fill, select]
    maxIdenticalConsecutive: 3
```

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `statusIn` | RunStatus[] | `["done"]` | 允许的结束方式 |
| `maxSteps` | integer | — | 实际步数上限 |
| `mustUse` | ActionMatch[] | `[]` | 轨迹中必须出现过 |
| `mustNotUse` | ActionMatch[] | `[]` | 轨迹中绝不能出现 |
| `forbiddenKinds` | ActionKind[] | `[]` | 绝不允许的动作种类，如只读用例写 `[fill, select]` |
| `maxIdenticalConsecutive` | integer | `3` | 连续多少步无变化判为卡死 |

**ActionMatch**：`labelContains` / `labelMatches` / `role` / `kind`，
至少填一个。

> **为什么按 label 而不是 id？** 内部的 `choice` 是 `e7` 这种 code-owned id，
> **只在单次观测内有效、跨运行完全不可比**。而轨迹记录里存的是人类可读的
> 动作标签（见上游 `agent.py:121-141`）。所以轨迹断言只能建立在 label 上。

`mustNotUse` 是**双重的**：既是事后断言，也是运行时护栏——
命中即在执行前拦截。

### quality —— 质量与成本

```yaml
  quality:
    minOperationProbability: 0.4
    minTargetProbability: 0.3
    maxModelCalls: 24
    maxElapsedMs: 30000
    maxInputTokens: 150000
    maxCostUsd: 0.25
```

| 字段 | 说明 |
| --- | --- |
| `minOperationProbability` | 决策置信度下限。低于此值说明模型在犹豫，**用例不稳** |
| `minTargetProbability` | 目标置信度下限。**`distribution` 为 `degenerate` 时此检查标为 `skipped`** |
| `maxModelCalls` | 实际发生的模型调用数上限 |
| `maxElapsedMs` | 实际耗时上限 |
| `maxInputTokens` | 实际 input token 上限 |
| `maxCostUsd` | 实际金额上限 |

后四项与 `budget` 同名项的区别：`budget` 是**运行时的硬刹车**（超了直接停），
`quality` 是**事后的断言**（超了算失败）。两者可以设成不同值——
例如让运行容许到 60 次调用，但断言要求不超过 24 次。

---

## status 与 passed

这两个是**独立的**，理解这一点是用好本平台的前提。

### status —— 循环如何结束

| 值 | 含义 |
| --- | --- |
| `queued` | 已入队 |
| `running` | 执行中 |
| `done` | 模型选择了 DONE，且页面在决策后未变化 |
| `blocked` | 模型选择了 BLOCKED，或连续多步无进展 |
| `budget_exceeded` | 撞到预算上限 |
| `guardrail_blocked` | 被安全护栏拦截 |
| `cancelled` | 用户取消 |
| `error` | 意料之外的故障 |

### passed —— 断言判决

`true` / `false` / `null`（`null` = 未能求值，例如第一步之前就超预算了）。

### 三种状态，不是两种

每条检查项的 `CheckResult` 是：

| 状态 | 含义 |
| --- | --- |
| `passed: true` | 满足 |
| `passed: false` | 不满足 |
| `skipped: true` | **无法求值**，既不算通过也不算失败 |

目前 `skipped` 的唯一来源是引擎的概率分布为 `degenerate` 时的概率类检查。

`AssertionResult.passed` 因而是 **`boolean | null`**：
有失败 → `false`；无失败但有跳过 → **`null`（未判定）**；全通过 → `true`。
聚合规则见 [architecture.md §11.1 ⑤](architecture.md)。

**报告里必须把 `skipped` 显示为「跳过」，绝不能显示为「通过」。**
把 `skipped` 当 `passed` 会让报告谎报覆盖——比直接失败更危险，
因为它让人以为测过了而实际没有。

### 常见组合

| status | passed | 含义 |
| --- | --- | --- |
| `done` | `true` | 正常通过 |
| `done` | `false` | **模型认为自己完成了，但独立断言发现没有**。这是最重要的一种失败 |
| `blocked` | `false` | agent 卡住了。通常需要改 `goal` 或换更明确的起点 |
| `budget_exceeded` | `false` | 跑不完。调大预算，或说明用例本身太复杂 |
| `guardrail_blocked` | `false` | 触碰护栏。**先确认这是不是预期行为**——如果是，说明护栏配得太严；如果不是，说明 goal 写得太宽 |
| `cancelled` | `false` | 断言**照常求值**：跑到一半停下，前半段仍然能说明问题。默认 `statusIn: ["done"]` 下通常判 `false`——运行确实没走完，这不叫谎报 |
| `error` | `null` | 基建故障，不是用例问题。CI 上应区别于测试失败。**这个 `null` 是刻意的**：引擎都不可达时，断言结论没有依据 |

> 想表达「被拦下是预期结果」，把 `trajectory.statusIn` 写成 `[guardrail_blocked]`；
> 想表达「取消也算过」，写成 `[done, cancelled]`。断言与 `status` 是两件事，这正是它们的用法。

---

## 完整示例

见 [`cases/wikipedia-godel.yaml`](../cases/wikipedia-godel.yaml)，
它同时被 `tests/schema.test.ts` 用作格式一致性的检查对象。

## 变更本格式时

1. 改 `src/schema/case.ts`
2. 改本文
3. 跑 `npm test`——`yaml-roundtrip.test.ts` 会验证「表单 ↔ YAML」没有漂移
4. 若是**破坏性**变更，递增 `schemaVersion` 并写迁移说明
