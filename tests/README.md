# tests/

离线测试。用 Node 内置的 `node:test`，不引入 vitest——devDeps 只留
`typescript` 与 `@types/node`。

```bash
npm test
```

## 硬性要求

**任何测试都不得调用付费 API。** 这靠 `scripted` 引擎实现
（见 `src/engine/scripted.ts`），它把参考项目
`tests/test_agent.py:77-95` 里 `monkeypatch.setattr(model, "post_json", fake)`
的手法提升到注册表层——于是 server、queue、pool、runner、checks 的**全链路**
都能在零成本、完全确定的条件下被测试，而不只是孤立的单元。

同理，除 `tests/e2e/` 外不应启动浏览器；`tests/e2e/` 里的用例用本地 fixture 站点
（见 `fixtures/site/`），不访问外网。外网的 Wikipedia 用例只有显式设置
`JEVTEST_E2E=1` 时才跑。

## 计划收录

| 文件 | 覆盖内容 |
| --- | --- |
| `schema.test.ts` | **默认值必须真的被解析**——断言 `CaseDefinitionSchema.parse({最小输入}).budget.maxModelCalls === 40`。这条专门守着 zod v4 的 `.default({})` 陷阱，见下方 |
| `yaml-roundtrip.test.ts` | YAML → 对象 → 表单渲染 → 反解 → 深比较。保证「表单 ↔ YAML」双入口不漂移 |
| `policy.test.ts` | `buildActionSpace` 的 readonly 模式**不含** `TYPE_TEXT` / `SELECT` 键；一个节点只拿一个索引；select 的每个 option 是独立 target |
| `validate-choice.test.ts` | 移植参考项目 `test_invalid_choice_is_rejected` 的六个参数：unknown / nan / missing / negative / non_max / confidence |
| `guardrails.test.ts` | 护栏命中时 `session.act` **调用次数为 0**、`StepRecord.executed === false`、status 为 `guardrail_blocked` |
| `checks.test.ts` | 三层断言求值；**`skipped` 不等于 `passed`**——degenerate 分布下概率检查必须标 skipped |
| `runner.test.ts` | 非重试语义：陈旧决策不执行、变更不重试、先记日志再观测、连续无进展判 blocked |
| `budget.test.ts` | 各维度超限都正确刹车，且**已产生的轨迹被保留**供断言求值 |

## 必须写进测试的两个陷阱

### 1. zod v4 的 `.default({})` 不解析默认值

```ts
// 错误写法：budget 会是 {}，嵌套默认值全部丢失
z.object({ budget: BudgetSchema.default({}) })

// 正确写法：.prefault 是 input-side 默认，会走 schema 解析
z.object({ budget: BudgetSchema.prefault({}) })
```

直接后果是 `budget.maxModelCalls` 变成 `undefined`，**用例预算静默失效、成本无上限**。
这是会真金白银踩坑的地方，`schema.test.ts` 里的那条断言必须存在。
（已确认锁定的 zod 版本是 4.6.5，`.prefault()` 可用。）

### 2. `skipped` 不是 `passed`

断言结果有三种状态，不是两种。把 `skipped` 当成 `passed` 会让报告谎报通过——
比直接失败更危险，因为它让人以为有覆盖而实际没有。

## 尚未实现

P0 阶段仅占位。
