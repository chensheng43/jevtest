# 架构

本文面向要接手实现的人。读完你应该能回答：数据怎么流、每层负责什么、
哪些代码是移植来的、为什么某些看似绕的做法是必需的。

---

## 1. 分层与依赖方向

```text
  cli ──► web ──┬─► core ──┬─► engine ──► schema
                │          │
                │          └─► browser ──► schema
                └─► store ─────────────────► schema
```

箭头 = 依赖。几条硬规矩：

| 规矩 | 为什么 |
| --- | --- |
| `schema/` 不 import 任何东西（除 `node:` 内置） | 它是数据契约，被所有层引用，一旦反向依赖就成环 |
| `engine/` 不 import `browser/` | 引擎是**纯网络组件**。它不持有会话、不碰浏览器，「浏览器变更从不重试」这条不变量才能由结构保证，而不是靠自觉 |
| `core/` 不 import `playwright` | 只依赖 `browser/session.ts` 的 `Session` 接口。因此单元测试用 `FakeSession` 就能覆盖 runner 的全部控制流 |
| `browser/` 可以 import `core/errors.ts` | `errors.ts` 是叶模块，被两边引用不成环 |
| `schema/events.ts` 拥有共享词汇表 | `ActionKind` / `Operation` / `RunStatus` 定义在这里，其余模块只从这里取，不从彼此取 |
| `store/` 只依赖 `schema/` | 它是纯 CRUD 仓库，不认识 agent、引擎或浏览器。`cli` 与 `web` 通过它读写用例，因此**磁盘格式只有一个决定者** |

各层职责：

| 层 | 职责 |
| --- | --- |
| `schema/` | 数据契约（输入用 `case.ts`，输出用 `report.ts`，共享词汇表在 `events.ts`） |
| `store/` | 磁盘读写：用例仓库 `cases.ts`、版本迁移 `migrations.ts` |
| `engine/` | 决策引擎（可插拔），纯网络组件 |
| `browser/` | Playwright 封装与准入探测 |
| `core/` | 策略、循环、断言、护栏、预算、运行器 |
| `web/` | HTTP 服务与界面 |
| `util/` | 并发原语，被 `core/` 与 `web/` 使用 |

> 运行产物的落盘在 `core/report.ts` 而非 `store/`。这是**有意的不对称**：
> 报告要组装 `steps` / `assertion` / `stats`，与运行生命周期紧密耦合；
> 用例是纯 CRUD。把前者搬进 `store/` 只会让两侧都变复杂。
> 但报告的**读取**会用到 `store/migrations.ts` 的迁移链。

---

## 2. 一次运行发生了什么

以 `cases/wikipedia-godel.yaml` 为例，从入队到报告落盘：

```text
POST /api/runs {caseIds: ["wikipedia-godel"]}
  │
  ├─ 1. 读 cases/wikipedia-godel/case.yaml -> CaseDefinition.parse() -> Case（默认值已填充）
  │     计算 caseDigest，分配 runId
  │
  ├─ 2. enqueue：把用例**冻结**复制到 runs/<runId>/case.yaml
  │     （此后编辑用例不影响在途运行，报告也自包含）
  │
  └─ 3. worker 从 AsyncQueue 取出
        │
        ├─ pool.withSession() 借出一个 BrowserContext（约 50ms）
        │   └─ context.tracing.start()  若开启录制
        │
        └─ CaseAgent.run(signal)  ──── 循环开始 ────
              │
              ├─ session.goto(startUrl) / session.observe()
              │    同一次 page.evaluate(READ_STATE) 取完元素表+文本+守卫状态
              │    emit step.observed
              │
              ├─ guard.assertAllowedOrigin()        越界 -> guardrail_blocked
              ├─ budget.check()                     超限 -> budget_exceeded
              │
              ├─ policy.buildActionSpace(actions, {mode})
              │    readonly 时此处就剔除了变更型操作
              ├─ policy.buildDecisionRequest()
              │    **断言不参与**（见 §6）
              │
              ├─ engine.decide(req, signal)  ──── 一次 HTTP 往返 ────
              │    返回 answers: {operation, click_target, ...}
              │    累积 usage（token / 金额 / 延迟 / 请求数）
              │    emit step.decided
              │
              ├─ policy.resolveDecision()
              │    ① 校验 operation head
              │    ② 只校验被选中操作的 target head
              │    ③ 映射回真实 Action  <- 此后模型输出不再有影响力
              │    校验失败 -> InvalidDecision，**不执行任何动作**
              │
              ├─ 若 operation 是 DONE / BLOCKED：
              │    复查页面新鲜度 -> 结束为 done / blocked
              │
              ├─ guard.checkAction()                命中 -> StepRecord.executed=false
              │                                       且终止为 guardrail_blocked
              │                                       **不调用 session.act**
              │
              ├─ 若 kind 是 fill：
              │    session.isFresh() 复查
              │    engine.writeText()  -> 小模型生成字段值
              │    按 textContextKey 缓存（仅当整个输入完全相同时复用）
              │
              ├─ session.act(action, page, text)   **绝不重试**
              │    内部：复查新鲜度 -> 重新解析几何 -> elementFromPoint 遮挡测试 -> 真实鼠标/键盘事件
              │
              ├─ 先写 StepRecord(executed: true) 并 emit step.executed
              │    ^^^ 顺序关键：必须早于下面的 observe()
              │
              ├─ session.observe()
              │    导航打断了也不影响上面那条记录
              │
              ├─ 无进展检测：连续 3 步 pageChanged=false 且非 wait -> blocked
              ├─ signal.throwIfAborted()            取消 -> cancelled
              │
              └─ 回到循环开始，直到终结状态
        │
        ├─ checks.evaluateAssertions(assertions, ctx)
        │    最终页面 / 动作轨迹 / 质量与成本 三族
        │    emit assertion.evaluated
        │
        ├─ context.tracing.stop() -> trace.zip   **在 finally 里**
        ├─ pool 归还 context -> contextsActive 减一
        │
        └─ report.persistReport() -> runs/<runId>/run.json
           追加 runs/index.jsonl
           emit run.finished
```

---

## 3. 决策引擎的可插拔设计

### 3.1 为什么是「一问多题」

参考项目本来是两次串行调用：先问操作，再问目标。改成一次请求带多个问题后，
延迟直接减半——这是它 7 秒完成飞行搜索的主要原因之一。

`DecisionRequest.questions[]` 就是这个结构的抽象：

```ts
questions[0]  = { key: "operation",        options: [...所有操作 + 页面控件 + DONE/BLOCKED] }
questions[1]  = { key: "click_target",     options: [...所有可点击元素] }
questions[2]  = { key: "type_text_target", options: [...所有可编辑元素] }
questions[3]  = { key: "select_target",    options: [...所有下拉选项，形如 "3:1"] }
```

两个细节不能忘：

- **每个 target head 只含兼容的元素。** 可编辑元素不会出现在 `click_target` 里。
  这从源头上杜绝了「模型选了个输入框去点击」。
- **各问题独立求解。** target 问题读不到 operation 的答案，所以它的前提必须显式
  写明「假如下一步是这个操作」（见 `core/rules.ts` 的 `TARGET` 提示词）。
  换来的是单次往返。

### 3.2 引擎接口

```ts
interface DecisionEngine {
  readonly name: string;
  readonly capabilities: { text: boolean; probabilities: "full" | "degenerate" };
  decide(req: DecisionRequest, signal: AbortSignal): Promise<DecisionResult>;
  writeText(req: TextRequest, signal: AbortSignal): Promise<TextResult>;
  close(): Promise<void>;
}
```

**`capabilities.probabilities` 不是装饰性的。** 见 §5.3。

### 3.3 校验在引擎之外

引擎只负责「把 IR 翻译成 HTTP、把响应翻译回 IR」。
`validateChoice` 住在 `core/policy.ts`，因此**引擎无法产出越界的选择**——
即使某个引擎实现有 bug 返回了不存在的 id，也会被挡在执行之前。

移植自参考项目 `model.py:30-45` 的判据，一条不改：

```python
answer["choice"] in ids
and set(probabilities) == set(ids)          # 键集合完全匹配
and all(0 <= n <= 1 for n in numbers)       # 有限且合法
and abs(sum(probabilities.values()) - 1) < 0.02   # 和为 1
and probabilities[answer["choice"]] >= max(probabilities.values()) - 1e-6  # 是最大值
```

### 3.4 Scripted 引擎为什么重要

`engine/scripted.ts` 按预设数组返回答案。它把参考项目
`tests/test_agent.py:77-95` 里 `monkeypatch.setattr(model, "post_json", fake)`
的手法提升到了注册表层。

差别很大：monkeypatch 只能测孤立单元，而注册表层的替换让
**server + queue + pool + runner + checks 的全链路**都能在零成本、
完全确定的条件下被测试。这是整个项目最重要的一处可测试性设计——
没有它，每次回归测试都要烧真金白银。

---

## 4. 从 jev-ultrafast 借鉴了什么

逐项列出，含来源位置与移植成本。改这些代码前建议先看上游对应实现。

| 机制 | 上游位置 | 本项目位置 | 移植成本 | 说明 |
| --- | --- | --- | --- | --- |
| 索引化元素表 | `jev_ultrafast/snapshot.js` 全文 | `src/browser/snapshot.js` | **几乎为零** | 它本身就是 JS。只改了全局缓存名 `__jevFast` → `__jev`，加了文件头。返回结构保持原版的 snake_case，到 TS `Observation` 的映射在 `playwright-session.ts` |
| 动作空间构建 | `model.py:48-78` (`action_space`) | `core/policy.ts` (`buildActionSpace`) | 重写约 80 行 | 加了 readonly 模式（上游没有） |
| 概率校验 | `model.py:30-45` (`validate_choice`) | `core/policy.ts` (`validateChoice`) | 重写约 40 行 | 判据一条不改；加了 `distribution` 判定 |
| 决策请求组装 | `model.py:81-148` (`choose`) | `core/policy.ts` (`buildDecisionRequest`) | 重写约 120 行 | 拆成 IR，不再直接拼 HTTP body |
| 文本取值 | `model.py:151-198` (`field_context` / `field_text`) | `engine/text.ts` | 重写约 80 行 | 拆成「构造请求」与「校验响应」两半 |
| 提示词 | `questions.py` 全文 | `core/rules.ts` | **零** | 逐字照搬，只在文件头注明来源 |
| 执行循环 | `agent.py:52-158` | `core/agent.ts` | 重写约 180 行 | 五条不变量逐条保留（见 §6） |
| 新鲜度守卫 | `browser.py:88-98` + `snapshot.js:44-54` | `browser/` | snapshot 部分随第 1 项免费 | `pageKey` 比语义状态，`guard` 比节点身份与属性 |
| 遮挡命中测试 | `browser.py:144-164` | `playwright-session.ts` | 随实现重写 | 输入前重新解析几何 + `elementFromPoint` |
| 独立结果校验 | `examples/flights.py:18-38` (`verify`) | `core/checks.ts` | 泛化重写 | 从硬编码函数变成声明式断言 |
| 本地服务安全模式 | `demo.py:17-19, 82-125` | `web/security.ts` | 照搬 | Host + Origin + Token 三重守卫 |
| 本地浏览器回归测试 | `scripts/check_guards.py` | `fixtures/site/` + `tests/e2e/` | 改造 | 上游用 `data:text/html` 内联页面，这里改成独立站点文件以便复用 |
| 报告结构 | `docs/measurement.json` 的 `source_hashes` | `CaseRunReport.caseDigest` | 正规化 | 让任何报告能精确回到产生它的用例版本 |

**没有移植的：**

| 上游的东西 | 为什么不抄 |
| --- | --- |
| `browser.py` 的 CDP 直接调用 | 换成 Playwright（见 §7） |
| `demo.py` 的全局 LOCK | 上游只有一个共享标签页才需要；本项目每个用例一个 context，锁反而杀掉并发 |
| `model.py` 的 `TARGET` 硬编码排序 | 上游有若干处针对具体站点的调整，本项目保持策略通用 |
| `scripts/record_flights.py` 等录制脚本 | 演示用，不属于测试平台 |

---

## 5. 三个关键设计点

### 5.1 只读模式在**构造阶段**实现

```ts
buildActionSpace(actions, { mode: "readonly" })
//  -> targets 里根本不存在 "TYPE_TEXT" 与 "SELECT" 这两个键
```

变更型动作（`fill` / `select`，以及 role 属于
`{button, checkbox, radio, switch, combobox, menuitem, menuitemradio, menuitemcheckbox, option, gridcell}`
的 click）在构建候选集时就被剔除。清单的权威定义是
`core/policy.ts` 的 `READONLY_BLOCKED_CLICK_ROLES`，与
[`case-format.md` §mode](case-format.md#关于-mode) 必须一致。

于是 `operation` 问题的 criteria 里根本没有这些选项，**模型物理上无法选中**。

这比「模型选了之后我们拒绝」强得多，因为：

- 不消耗模型注意力在一个不可能被批准的选项上；
- 不存在「拒绝逻辑写漏一个 case」的可能；
- 报告里可以直接说「本运行不可能发生变更」而不是「我们相信它没发生」。

这是参考项目「有限选择空间即安全边界」这一核心机制最有价值的复用。
`core/guard.ts` 的 `auditTrajectory` 仍会事后核对一遍——**「物理上不可能」
和「报告需要证据」是两回事**。

### 5.2 `status` 与 `passed` 彻底分离

```ts
status: RunStatus;        // 循环如何结束
passed: boolean | null;   // 断言判决
```

`status: "done"` 且 `passed: false` 是完全正常的组合。

这不是洁癖。参考项目明确写下「A DONE choice is not proof of success」，
并在 `examples/flights.py` 里用独立的 `verify()` 检验结果而不是相信模型的 DONE。
本项目把这条纪律固化到了类型层面——两者的类型不同，写错编译器就会拦下。

`passed` 允许为 `null`：预算在第一步之前就耗尽时，没有最终页面可供断言，
此时是「未能求值」而不是「失败」。

### 5.3 `distribution: "full" | "degenerate"`

TypeSafe 给出真实的概率分布。但多数通用 LLM 只回一个选择，
把它合成成分布就是 one-hot 1.0。

如果不显式建模这件事，`quality.minTargetProbability: 0.3` 在通用引擎上会
**假通过**——因为「被选中项的概率」恒等于 1.0。

所以：

- `Answer.distribution` 是必填字段；
- 断言层看到 `degenerate` 时，概率类检查返回 **`skipped`**；
- 报告里显示「跳过」，**绝不显示「通过」**。

断言结果因此有三种状态。把 `skipped` 当 `passed` 会让报告谎报覆盖——
比直接失败更危险，因为它让人以为测过了。

---

## 6. 执行循环的五条不变量

`core/agent.ts` 里的循环很短，难点全在这些**顺序敏感**的约束上。
每一条都对应一个已经发生过的具体错误。改循环前必读。

### 6.1 决策先消费，再变更

```ts
state.decision = null;   // 先
session.act(...);        // 后
```

否则一次陈旧重试会变成双击。在「提交订单」这种按钮上后果不必多说。

来源：`agent.py:90-91`（上游注释原文：*Consume once, before any mutation or model call.
A retry cannot double-click.*）

### 6.2 浏览器变更从不重试

网络层可以重试（429 / 503 / 529 指数退避），**浏览器动作不可以**。
动作可能已经生效，只是我们没看到结果；重试就是执行两次。

这条由结构保证而非靠自觉：引擎是纯网络组件，传输恢复逻辑没有机会包住 `act()`。

### 6.3 先记执行日志，再观测结果

```ts
history.push(stepRecord);        // 先
const next = await session.observe();  // 后
```

如果反过来，一次恰好发生在观测时的导航会让「我们点过了」这件事从轨迹里消失，
报告开始说谎。

来源：`agent.py:120-121`（*Record execution before observing. A stale post-action
observation must not erase the action.*）

### 6.4 废弃的决策不产生副作用

`fingerprint` 对不上就只重新观测，不执行。

### 6.5 无进展检测

连续 3 步页面无变化且不是 `wait` → 判为 `blocked`。

这是防「模型在一个它看不懂的页面上无限空转」的最后一道闸，
**也是最省钱的一道**。上游把 3 写死在代码里，本项目泛化成
`trajectory.maxIdenticalConsecutive`。

### 6.6 取消只在步边界生效

**在每一步开始时检查 `signal.aborted`**（而不是 `throwIfAborted()`），不中断已经开始的
浏览器变更，以 `cancelled` 正常返回。否则会留下「点了一半」的状态——这与 6.2 是同一条原则的两面。

为什么是「检查」而不是「抛出」：抛出的异常会被 runner 归为 `status: "error"`（基建故障），
而取消是**用户主动要的结果**，必须记成 `cancelled`。两者在 CI 上的含义完全不同。

---

## 7. CDP → Playwright 映射

上游用 Browser Harness 直连用户已有的 Chrome，每个动作都要手写 CDP 调用。
换成 Playwright 后绝大部分是直译。

| 上游（CDP） | 本项目（Playwright） | 备注 |
| --- | --- | --- |
| `Target.createTarget` + `Target.attachToTarget` | `browser.newContext()` + `context.newPage()` | target 生命周期交给 Playwright |
| `Target.closeTarget` | `context.close()` / `page.close()` | |
| `Emulation.setDeviceMetricsOverride` | `newContext({ viewport, deviceScaleFactor })` | 一等公民 |
| `Emulation.setFocusEmulationEnabled` | CDP 逃生舱：`context.newCDPSession(page)` 后 `send(...)` | **唯一需要 CDP 的调用**，见下 |
| `Page.navigate` + readyState 轮询 | `page.goto(url, { waitUntil, timeout })` | |
| `Runtime.evaluate {returnByValue}` | `page.evaluate(fn)` | `exceptionDetails` 变成抛错，需映射 |
| `Runtime.evaluate {awaitPromise}` | `page.evaluate(async () => ...)` | settle 逻辑逐字保留 |
| `Page.captureScreenshot` | `page.screenshot({ type: "jpeg", quality: 72 })` | 返回 Buffer |
| `Input.dispatchMouseEvent`（wheel） | `page.mouse.wheel(0, delta)` | |
| `Input.dispatchMouseEvent`（按下+抬起） | `page.mouse.click(x, y)` | **不要换成 `locator.click()`**，见下 |
| `Input.insertText` | `page.keyboard.insertText(text)` | 语义相同：不解释按键 |
| `Input.dispatchKeyEvent` `commands:['selectAll']` + 平台分支 | `page.keyboard.press("ControlOrMeta+a")` | **上游的 `sys.platform` 分支可以删掉** |
| `window.__jevFast`（WeakMap 节点身份 + pageKey/guard/marker） | 原样保留，重命名 `window.__jev` | 上游最难的部分本身是 JS |
| （无） | `context.tracing.start/stop` → `trace.zip` | **新增能力**：白送官方 trace viewer |
| （无） | `newContext({ storageState })` / `context.storageState()` | **新增能力**：登录态复用/重置 |

### 7.1 两个不能直译的地方

**点击必须用 `page.mouse.click(x, y)`，不能用 `locator.click()`。**

上游刻意用真实坐标加命中测试（`browser.py:144-164`）：

```js
const r = e.getBoundingClientRect(), x = r.x + r.width/2, y = r.y + r.height/2;
if (!e.contains(document.elementFromPoint(x, y))) return null;   // 被遮挡
```

`locator.click()` 会替我们滚动、等待、自动重试，看似省事，
但它抹掉了「元素在决策之后移动了 / 被盖住了」这个判断——
而那正是不该继续点击的时刻。

**原生 `<select>` 保留 JS 直接设值 + 派发事件，不要换成 `selectOption()`。**

原因同样是守卫语义：我们要在**同一次 evaluate 里**完成
「确认 option 存在且未禁用 → 设值 → 派发 input/change」，
中途被导航打断必须报错而非重试（`browser.py:152-164`）。

### 7.2 关于 `Emulation.setFocusEmulationEnabled`

上游用它让**用户浏览器中的后台标签页**保持 rAF 运行，避免 Chrome 节流动画。

Playwright 里页面是我们自己的前台页，本不需要它。但如果将来用
`connectOverCDP` 复用已有的可见浏览器，就需要补回同等行为——
所以 `playwright-session.ts` 保留了这个 CDP 逃生舱，用 `REQUIRE_FOCUS_EMULATION`
常量控制，自建 context 时关闭（省一次 CDP 往返）。

### 7.3 错误映射是必需的，不是优化

Playwright 在页面导航时会抛 `Execution context was destroyed` / `Target closed`。
**若不映射成 `StalePage`，每一次正常跳转都会被记为运行失败**，报告直接失去意义。

对应上游 `browser.py:40-41` 对 `exceptionDetails` 的处理。
见 `core/errors.ts` 的 `mapBrowserError`。

---

## 8. Web 服务

### 8.1 为什么是 `node:http` 而不是 Hono

Hono 确实能把 SSE 从 15 行降到 3 行，但：

1. 引入两个依赖，而本项目运行时依赖刻意只有 3 个；
2. 它的 `streamSSE` 有在连接静默断开时挂起、`onAbort` 不触发的已知问题
   （[honojs/hono#1902](https://github.com/honojs/hono/issues/1902)、
   [#3540](https://github.com/honojs/hono/issues/3540)）；
3. **本项目用轮询，本来就不需要 SSE**。

为省几十行代码换来一个长期存在的失败面，不划算。
这个决定是可低成本反悔的：路由都集中在 `web/api.ts`。

### 8.2 为什么轮询而不是 SSE

进度事件是服务端单向推送，一次运行约 10~20 步，500ms 轮询完全够用。
SSE 会引入连接生命周期、心跳、断线重连、以及上面那两个框架 bug。

事件模型本身是 SSE 兼容的——`seq` 语义天然对应 `Last-Event-ID`。
真要换，只改 `web/events.ts` 与一个端点。

### 8.3 三重安全守卫

来自上游 `demo.py:17-19, 82-125`。**「本地」不等于「安全」**：
浏览器里任何一个你访问过的网页都能向 localhost 发请求。

> 本节讲**机制**。威胁模型（资产、对手、信任边界表、五道防线的映射）
> 见 [`security.md`](security.md)。

| 闸 | 防什么 |
| --- | --- |
| `Host` 必须精确等于 `127.0.0.1:<port>` | DNS rebinding（攻击者把域名解析到 127.0.0.1） |
| 一次性令牌 `X-Jevtest-Token` | 外部页面伪造请求（同源策略不让它读我们的 HTML，因此拿不到令牌） |
| `Origin` 为 null 或本服务 origin | 跨站表单提交 |

补充两条：

- **请求体流式限长**，不能先收完再判断大小——否则可以被塞爆内存。
- **`/vendor/*` 是唯一的动态文件服务路径**，必须防目录穿越：
  解析后断言前缀在允许目录内，且只放行 `.js` / `.map` / `.json`。
  （这条路径存在是为了把 zod 直接喂给浏览器做表单即时校验，见 §9.2。）

### 8.4 事件里绝不带截图

事件只带 `frame` 序号，前端另外请求 `GET /api/runs/:id/frames/:n.jpg`。

这把单条事件从约 200KB 压到约 400B。上游在导出 trace 时显式剔除
`page.screenshot`（`app.js` 的 download 逻辑），是同一个直觉。

---

## 9. 并发与隔离

### 9.1 模型

**单进程、单事件循环、N 个 worker 协程。**

- 不是线程：Playwright 在 Node 里是原生异步的，用 `worker_threads`
  会把这份优势抹掉，还让进度转发要过 `postMessage`。
- 不是独立进程：只买到崩溃隔离，而崩溃隔离靠 `try/catch` 加池重启已覆盖大半。

**一个用例一个 `BrowserContext`**，这是换到 Playwright 换来的最大收益：

| | 上游（Browser Harness） | 本项目（Playwright） |
| --- | --- | --- |
| profile | 共享用户 Chrome 的 profile | 每个 context 独立 |
| cookie / localStorage | 用例之间互相污染 | 完全隔离 |
| 并行 | 不可能 | 天然支持 |
| 登录态 | 手动维护 | `storageState` 复用与重置 |
| 单实例成本 | 新建标签页 | 约 50ms、80~150MB |

### 9.2 两道解耦的信号量

```ts
maxContexts      限制浏览器内存
maxEngineInflight 限制厂商侧限流
```

两者瓶颈无关——模型 API 的吞吐量与浏览器内存没有关系。
绑成一个总闸会让其中一个白白闲置。

### 9.3 `contextsActive` 必须归零

`GET /api/queue` 暴露这个计数。运行结束后它必须回到 0。

不归零说明 `context.close()` 没执行——通常是异常路径上漏了 `finally`。
泄漏的 renderer 进程会一直吃内存，而且不会自己消失。
验收时会盯着这个数字。

---

## 10. 移植时改了什么，为什么

| 改动 | 理由 |
| --- | --- |
| 浏览器层从 Browser Harness 换成 Playwright | 解决 profile 共享、无法并行、无头 CI 困难三个问题（见 §9.1） |
| 删掉全局 LOCK | 隔离天然之后，锁只会杀掉并发 |
| `verify()` 从硬编码函数变成声明式断言 | 上游只测得了 Google Flights 一个场景 |
| 加了 `mode: readonly` | 上游没有这个概念；测试平台需要「只看不改」的能力 |
| 加了用例级预算 | 上游一次跑一个任务，不需要；批量跑必须防成本失控 |
| 加了 `capabilities.probabilities` | 为接入非 TypeSafe 引擎做准备，避免概率断言假通过 |
| `MAX_STEPS` 等常量从代码里提到用例配置 | 上游写死 60 步 / 120 次决策；不同用例需要不同上限 |
| 事件模型 | 上游的 inspector 是单次运行的前端驱动循环；本项目要批量与历史 |

---

## 11. 设计缺口与待验证

这一节记录三类东西。**§11.1 与 §11.2 已全部定案**，读它们是替代重新推导——
动手时照此执行，不要自行发挥。§11.3 是诚实的未知，别当成结论。

| 小节 | 状态 | 内容 |
| --- | --- | --- |
| §11.1 接口层矛盾 | ✅ 已定案 | 6 处签名与契约对不上的地方，以及各自的结论与理由 |
| §11.2 通路与模块 | ✅ 已补齐 | 5 处「接口自洽但接线不存在」，新增 `src/store/` 两个模块 |
| §11.3 待验证 | ⏳ 未实测 | 耗时成本、无头模式、浏览器差异等，需要真跑才能回答 |

### 11.1 接口层矛盾（已定案）

以下六处曾是**签名与契约对不上**——照现状写实现只能靠猜，猜错了不会报错，
只会让报告悄悄失真或让成本上限静默失效。**现已全部定案**，
结论与理由记在这里。实现时照此执行，不要再自行推导。

#### ① `checkQuality` 缺 `history` ＋ ② `distribution` 被压成整轮一个值

**结论**：删掉 `CheckContext.distribution`，`checkQuality` 改收 `history`。
分布质量是**每次回答**的属性，逐步从 `StepRecord.distribution` 读。

压成整轮一个值必然二选一：过度 skip（丢掉真实的 full 覆盖），
或漏 skip（假通过照旧发生）——而 §5.3 要防的假通过恰好只发生在 target 侧，
正是被压平后最容易漏掉的那一半。

取样口径固化在 `core/checks.ts` 的 `PROBABILITY_SAMPLING`：

| 约束 | 理由 |
| --- | --- |
| 只取 `executed: true` 的步 | 被护栏拦下的步没有执行，其概率不代表决策质量 |
| `minOperationProbability` 只在 `distribution === "full"` 的步求值 | degenerate 的分布是合成的 one-hot |
| `minTargetProbability` 额外要求 `target != null` | DONE / BLOCKED / scroll / wait 都没有目标 |
| 聚合用 `min` 而非平均 | 要抓的是「某一步很犹豫」，平均会把它稀释掉 |

无任何步可求值时返回 **skipped**，不是通过。

#### ③ `BudgetMeter` 收不到 `RunStats`

**结论**：`RunStats` 由 **`BudgetMeter` 独占**。`check()` / `view()` / `summary()`
不再收 `stats` 参数，新增 `recordStep()` 与 `stats()`。

理由是 `recordCall` 是唯一知道「这次调用花了多少」的地方。让调用方也维护一份计数
就会出现两个事实来源，而它们迟早分叉——分叉的表现是**成本统计悄悄失真**且不报错。
`elapsedMs` 一并归它算（它持有起始时刻），`AgentDeps.clock` 因此删除。

#### ④ `engineOptions` 曾被三处引用却未定义

**结论**：**砍掉，不补进 schema。**

scripted 是测试专用引擎，而用例是给用户写的——用户不该在 YAML 里看到「答案序列」。
何况往「YAML 是唯一事实来源」这个契约里加自由形态 `Record<string, unknown>`，
要穿过 YAML 往返、冻结用例快照、`caseDigest` 三关，代价与收益不成比例。

更好的通路本来就有：`RunnerDeps.createEngine: (caseDef: Case) => DecisionEngine`
是现成的注入点，测试里传 `() => createScriptedEngine({steps})` 即可，零 schema 变更。
`engine/registry.ts` 的 `EngineContext.options` 已删除，生产用例永不声明
`engine: scripted`。

#### ⑤ `AssertionResult.passed` 的三态空洞

**结论**：字段类型改为 **`boolean | null`**，聚合规则写在 `core/checks.ts`
的 `aggregateChecks`：

| 情况 | `passed` |
| --- | --- |
| 有任一 failed | `false` |
| 无 failed，但有 skipped | **`null`（未判定）** |
| 全部 passed | `true` |
| 没有任何检查项 | `null` |

中间那行是关键：7 条通过、1 条因 degenerate 被跳过时判 `null` 而非 `true`。
判 `true` 就是 D9 要杜绝的谎报覆盖——我们确实没验证那一条。
想要确定的结论，就不该用需要概率的断言。

#### ⑥ `admission` 字段曾经没有调用点

**结论**：定位为**记录与警告，不是运行的闸**。调用点在 `CaseAgent.run()`
第一次 `observe()` 之后——不是入队时，因为那要开页面，会让入队变慢。
`blocking` 项在报告顶部显著展示，但**不阻止运行**。
要不要真做成闸留到 P1（那需要给 `RunStatus` 加成员，是 schema 变更）。

结构同时解决了 `admit(page: unknown)` 收裸 Playwright `Page` 的问题：

```text
Session.probe()     -> AdmissionStats   （要真浏览器，不可单元测试）
admit(stats, case)  -> AdmissionReport  （纯函数，可单元测试）
```

这样切是因为**判定规则需要能回归**——而准入规则正是假阳性的第一道防线，
靠人肉核对的规则表迟早与代码漂移。规则写成数据（`ADMISSION_RULES`），
顺带解决了 §11.2 最后一行「准入规则两处事实来源」：文档可以从规则表生成。

### 11.2 通路与模块（已补齐）

以下五处曾是**接线不存在**——接口自洽，但实现时会发现无处可接。
现已补上模块或定死通路。新增的两个模块在 `src/store/`。

#### ① 用例仓库：`src/store/cases.ts`

`CaseStore` 覆盖 `cases/<id>/` 的读写、列表、版本、ID 分配。
**这是 D5「YAML 是唯一事实来源」真正被守住的地方**——Web 表单、CLI、导入
三条入口最后都落到同一个 `write()`。

三个关键决定（都写在文件头）：

| 决定 | 理由 |
| --- | --- |
| revision 从 `revisions/` 目录推导，**不维护计数器文件** | 计数器会漂移（写失败、手工删除、并发）；目录本身就是事实，少一个需要保持同步的东西 |
| 并发用**乐观锁**（`expectedRevision`），不用文件锁 | 单进程单事件循环，真正的竞态来自两个 HTTP 请求，不是两个进程；且 Windows 上文件锁很难做对。冲突时明确报错，好过静默覆盖 |
| 写入**必须原子**（临时文件 + rename） | 直接覆写时进程被杀会留下半截 YAML——而 `case.yaml` 是唯一事实来源，损坏它等于丢失这个用例 |

与 runs 侧的不对称是有意的：报告落盘留在 `core/report.ts`，因为它要组装
`steps` / `assertion` / `stats`，与运行生命周期紧密耦合；用例是纯 CRUD。

#### ② 停机信号：两级 `AbortController` 合成

`core/runner.ts` 的 `composeRunSignal()` 定死了通路：

```text
  shutdownController   —— RunnerService 持有，进程内一个，cancelAll() 时 abort
  runControllers       —— 每 run 一个，cancel(runId) 时 abort
  传给 CaseAgent.run() = AbortSignal.any([runSignal, shutdownSignal])
```

`AbortSignal.any` 是 Node 内置的，语义正好：任一来源 abort 即 abort，
且**不区分是谁触发的**——`CaseAgent` 只需在步边界检查一次，
不必知道自己是「被用户取消」还是「进程要关了」。
两种情形的终态由 runner 区分，不由 agent 区分。

单独抽成函数是为了让它**可被单元测试**：「两级信号都能中断」这条性质
很容易被后续重构破坏（比如有人图省事只传 `runSignal`），
而破坏了不会有任何报错，只会让停机悄悄失效。

#### ③ 配置面：`Settings` 补齐三项

`maxEngineInflight`（默认 4）/ `headless`（默认 true）/ `tracing`（默认 true）
现在都有来源，对应 `JEVTEST_ENGINE_INFLIGHT` / `JEVTEST_HEADLESS` / `JEVTEST_TRACING`。

`PoolOptions` **不再有自己的默认值兜底**——在池里再写一遍默认值会出现
「改了环境变量却没生效」这种最难查的问题。字段名与 `Settings` 一一对应，
映射在调用处完成。

`tracing` 默认开：trace.zip 是排查失败时最有用的东西，而失败往往不可预测，
关掉省下的磁盘通常不值一次「要是当时录了就好了」。

#### ④ 迁移落点：`src/store/migrations.ts`

规则如下，都写在文件头：

1. **迁移只在读的时候发生，永不改写磁盘。** 尤其报告——它是长期留存的**物证**，
   读进来升级再写回去等于篡改证据。用例可以改，报告不可以。
2. **版本比当前高时直接报错**，不做降级猜测。静默按当前版本解析会得到一份
   「看起来正常但实际错误」的报告，比读不出来危险得多。
3. **逐级迁移**（`1→2`、`2→3` 各写各的），不写跳级迁移——每段只需理解相邻两版。

调用点：用例在 `store/cases.ts` 解析 YAML 之后、zod 校验**之前**；
报告在 `core/report.ts` 的 `readReport()` 里。

#### ⑤ `modelCalls` 的口径：按**实际请求数**算

一次重试 3 次才成功的决策，算 **3** 个 `modelCalls`。

按 1 算的话，重试就是一条**免费通道**：`MAX_ATTEMPTS` 为 3，
最坏情况实际花费是预算的 3 倍而刹车不会响。成本控制按请求数算才成立——
而且这与 `maxInputTokens` 的口径一致（它本来就数实际 token）。

`RunStats` 因此有两个字段：

| 字段 | 含义 | 用途 |
| --- | --- | --- |
| `modelCalls` | 实际 HTTP 请求数（**含重试**） | `budget.maxModelCalls` 与 `quality.maxModelCalls` 都按它算 |
| `decisions` | 逻辑决策数（不含重试） | 只用于展示。`modelCalls - decisions` 就是重试造成的额外请求 |

「最多走几步」这件事由 `trajectory.maxSteps` 表达，不新增断言字段。

`BudgetMeter` 因此有 `recordDecision()` 与 `recordCall()` 两个方法：
前者加一，后者按 `Usage.requests` 累加。

### 11.3 待验证

| 事项 | 状态 |
| --- | --- |
| 单用例真实耗时与成本 | **未实测**。上游同类任务 17 次请求 / 90,558 input tokens 可作参考，但本项目换了浏览器层、加了断言与护栏，实际值需测 |
| Playwright 自带 Chromium 与真实 Chrome 的行为差异 | 未知。内部 staging 无所谓，测三方站点时是第一个会踩的坑 |
| `--enable-automation` 特征是否被站点检测 | 未验证。同上 |
| shadow DOM 递归支持 | P1 计划（约 10 行），尚未实现，因此目前仍在「不支持」清单里 |
| 跨 iframe 支持 | P1 计划用 `f1:e7` 形式的限定 id，尚未实现 |
| 轮询在长运行（>5 分钟）下的体验 | 未验证。若不够，再考虑 SSE |
| 用例 revision diff 视图 | P1 |
| 多引擎一致性投票 | P2 |
