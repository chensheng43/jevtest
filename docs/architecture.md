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
  ├─ 2. enqueue：runner 持有这一刻的 Case，之后一直用它
  │     （此后编辑用例不影响在途运行；报告落盘时把**这一份**冻结到
  │      runs/<runId>/case.yaml，revision 按 digest 反查，报告因此自包含）
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
              ├─ policy.overrideWeakBlocked()
              │    BLOCKED 没过半（< 0.5）-> 改走概率最大的非终止操作（每次运行至多 3 次，见 D20）
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
              ├─ 点了没反应（CLICK 且 pageChanged=false）的节点移出下一步的 CLICK 候选，
              │    页面一变就放回（见 §6.5）
              ├─ 无进展检测：连续 3 步 pageChanged=false 且非 wait -> blocked
              │    （决策在执行前被丢弃的，另算：连续丢弃 3 次 -> blocked，见 §6.4）
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
为什么不做成「模型选了之后我们拒绝」，见 [`decisions.md` D10](decisions.md)。

`core/guard.ts` 的 `auditTrajectory` 仍会事后核对一遍——**「物理上不可能」
和「报告需要证据」是两回事**。

### 5.2 `status` 与 `passed` 彻底分离

```ts
status: RunStatus;        // 循环如何结束
passed: boolean | null;   // 断言判决
```

`status: "done"` 且 `passed: false` 是完全正常的组合。理由见 [`decisions.md` D8](decisions.md)。

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
- 报告里显示「跳过」，**绝不显示「通过」**（[`decisions.md` D9](decisions.md)）。

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

丢弃也有上限：自上一次成功执行以来**连续丢弃 `MAX_CONSECUTIVE_DISCARDS`（3）次**判为 `blocked`。
丢弃的决策不产生 StepRecord，6.5 的无进展检测看不到它；而模型的请求里只有执行过的动作，
它不知道上一次没点成，页面不变就会给出同一个答案。见 [decisions.md D21](decisions.md)。

### 6.5 无进展检测

连续 3 步页面无变化且不是 `wait` → 判为 `blocked`。

这是防「模型在一个它看不懂的页面上无限空转」的最后一道闸，
**也是最省钱的一道**。上游把 3 写死在代码里，本项目泛化成
`trajectory.maxIdenticalConsecutive`。

在它之前还有一道更轻的：一次 CLICK 之后页面没变，这个节点在页面变化之前不再作为 CLICK 候选。
模型看得到 `page_changed: false`，却常常照样再点一次；拿掉它，模型只能去试别的控件。
换着点也没用的时候，这道闸照样在第 3 步判 blocked。配合它的是页面提示（`Observation.notices`，
置顶交给模型、记进 `StepRecord.notices`），让模型看得到上一次为什么没成。见 [decisions.md D23](decisions.md)。

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

### 8.1 `node:http`，不用 Web 框架

理由见 [`decisions.md` D3](decisions.md)。路由集中在 `web/api.ts`，换框架只动两个文件。

### 8.2 轮询，不用 SSE

前端每 500ms 拉一次 `GET /api/runs/:id/events?since=<seq>`，理由见 [`decisions.md` D4](decisions.md)。
事件模型与 SSE 兼容（`seq` 对应 `Last-Event-ID`），真要换只改 `web/events.ts` 与一个端点。

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
  解析后断言前缀在允许目录内，且只放行 `.js` / `.map` / `.json` / `.css`。
  目前它只供 Bootstrap 的样式表（[`decisions.md` D18](decisions.md)）。

### 8.4 事件里绝不带截图

事件只带 `frame` 序号，前端另外请求 `GET /api/runs/:id/frames/:n.jpg`。

这把单条事件从约 200KB 压到约 400B。上游在导出 trace 时显式剔除
`page.screenshot`（上游 `app.js` 的 download 逻辑），是同一个直觉。
帧由 runner 在每次观测后截取（`JEVTEST_RECORD_FRAMES`，默认开启），语义见
[`report-format.md` §1](report-format.md)；结果页的轨迹查看器按序号取图（`components/trace.js`）。

---

## 9. 并发与隔离

### 9.1 模型

**单进程、单事件循环、N 个 worker 协程。**

- 不是线程：Playwright 在 Node 里是原生异步的，用 `worker_threads`
  会把这份优势抹掉，还让进度转发要过 `postMessage`。
- 不是独立进程：只买到崩溃隔离，而崩溃隔离靠 `try/catch` 加池重启已覆盖大半。

**一个用例一个 `BrowserContext`**，这是换到 Playwright 换来的最大收益，
与上游的对照见 [`decisions.md` D11](decisions.md)。

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

## 11. 实现层定案与待验证

§11.1 与 §11.2 是几处「看起来可以自由发挥、实际已经定死」的实现选择。
每条都对应一种**不报错、只会让报告或成本统计悄悄失真**的失败模式——
改相关代码前先读，不要重新推导出一个「看起来更简洁」的方案。
§11.3 是实测数据与仍未验证的事项。

### 11.1 接口层

#### ① `checkQuality` 读 `history` ＋ ② 分布质量按步判定

**结论**：`CheckContext` 没有整轮的 `distribution`，`checkQuality` 收 `history`。
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

#### ③ `RunStats` 归 `BudgetMeter` 独占

**结论**：`RunStats` 由 **`BudgetMeter` 独占**。`check()` / `view()` / `summary()`
不收 `stats` 参数，计数走 `recordStep()`，读取走 `stats()`。

理由是 `recordCall` 是唯一知道「这次调用花了多少」的地方。让调用方也维护一份计数
就会出现两个事实来源，而它们迟早分叉——分叉的表现是**成本统计悄悄失真**且不报错。
`elapsedMs` 一并归它算（它持有起始时刻），`AgentDeps` 因此没有 `clock`。

#### ④ 用例里没有 `engineOptions`

**结论**：**不给用例加引擎私有配置。**

scripted 是测试专用引擎，而用例是给用户写的——用户不该在 YAML 里看到「答案序列」。
何况往「YAML 是唯一事实来源」这个契约里加自由形态 `Record<string, unknown>`，
要穿过 YAML 往返、冻结用例快照、`caseDigest` 三关，代价与收益不成比例。

更好的通路本来就有：`RunnerDeps.createEngine: (caseDef: Case) => DecisionEngine`
是现成的注入点，测试里传 `() => createScriptedEngine({steps})` 即可，零 schema 变更。
`engine/registry.ts` 的 `EngineContext` 没有 `options`，生产用例永不声明
`engine: scripted`。

#### ⑤ `AssertionResult.passed` 是三态

**结论**：字段类型为 **`boolean | null`**，聚合规则在 `core/checks.ts` 的 `aggregateChecks`，
逐行含义见 [`report-format.md` §2.6](report-format.md)。关键是「无失败但有跳过」判 `null` 而非 `true`——
判 `true` 就是 D9 要杜绝的谎报覆盖。想要确定的结论，就不该用需要概率的断言。

#### ⑥ 准入是记录，不是闸

**结论**：定位为**记录与警告，不是运行的闸**。调用点在 `CaseAgent.run()`
第一次 `observe()` 之后——不是入队时，因为那要开页面，会让入队变慢。
`blocking` 项在报告顶部显著展示，但**不阻止运行**。
若要做成闸，需要给 `RunStatus` 加成员，是 schema 变更。

结构同时解决了 `admit(page: unknown)` 收裸 Playwright `Page` 的问题：

```text
Session.probe()     -> AdmissionStats   （要真浏览器，不可单元测试）
admit(stats, case)  -> AdmissionReport  （纯函数，可单元测试）
```

这样切是因为**判定规则需要能回归**——而准入规则正是假阳性的第一道防线。
规则写成数据（`ADMISSION_RULES`），将来 `limitations.md` 的准入清单可以从它生成（尚未做）。

### 11.2 通路与模块

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

#### ③ 配置面：默认值只在 `Settings` 里

`maxEngineInflight`（默认 4）/ `headless`（默认 true）/ `tracing`（默认 true）
对应 `JEVTEST_ENGINE_INFLIGHT` / `JEVTEST_HEADLESS` / `JEVTEST_TRACING`。

`PoolOptions` **没有自己的默认值兜底**——在池里再写一遍默认值会出现
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

`RunStats` 因此同时有 `modelCalls`（实际请求数）与 `decisions`（逻辑决策数），
两者的口径与用法见 [`report-format.md` §2.5](report-format.md)。

「最多走几步」这件事由 `trajectory.maxSteps` 表达，不新增断言字段。

`BudgetMeter` 因此有 `recordDecision()` 与 `recordCall()` 两个方法：
前者加一，后者按 `Usage.requests` 累加。

### 11.3 待验证

#### 已实测：`cases/wikipedia-godel.yaml` 真跑基线

2026-09-21 用真 TypeSafe + 真 Wikipedia 跑通（Chromium 经代理访问站点）：

| 读数 | 值 |
| --- | --- |
| 结论 | `status: done`、`passed: true`（10/10 断言通过），退出码 0 |
| 浏览器步数 | **2**（搜索框输入 → 点自动补全建议） |
| 模型调用 | **6 次**（5 次决策，其中 1 次重试；另 1 次是文本取值） |
| token | **33,859 input / 2,663 output** |
| 墙钟耗时 | **5.0 ~ 5.7 秒**（4 次连续运行） |
| 成本 | **未知**——TypeSafe 的响应里没有金额字段，因此 `costUsd` 报 `null` 而不是 0 |
| 准入警告 | 1 条（检测到 2 个嵌套滚动容器） |

与上游「17 次请求 / 90,558 input tokens / 7.1 秒」相比，量级一致、方向更好：
本项目是一问多题（一次往返问操作 + 各目标），因此决策次数与 token 都更省。

> **认证通过（401 → 拿到真响应）不代表请求是对的。** TypeSafe 对请求体形状错误只回一句
> `Invalid request.`，不说是哪个字段。`tests/engine.test.ts` 因此直接断言请求体的
> `criteria` / `instructions` 结构，防止再次静默漂移。

#### 仍未验证

| 事项 | 状态 |
| --- | --- |
| TypeSafe 是否报金额 | 实测**没有**。要么是响应里用别的字段名（需核），要么这一版 API 就不报——在此之前成本类断言只能靠 `null` 跳过 |
| `cases/wikipedia-godel.yaml` 的更多次重复 | 已连跑 4 次全绿，但**样本太小**，也还没试过在慢网络/大页面下的表现 |
| 其他用例（含下拉、复选框、断言更严的） | 未跑过。目前只有种子用例真跑过 |
| Playwright 自带 Chromium 与真实 Chrome 的行为差异 | 未知。内部 staging 无所谓，测三方站点时是第一个会踩的坑 |
| `--enable-automation` 特征是否被站点检测 | 未验证。同上（Wikipedia 未拦） |
| 轮询在长运行（>5 分钟）下的体验 | 未验证。若不够，再考虑 SSE |
| shadow DOM 递归 / 跨 iframe | 尚未实现，因此仍在「不支持」清单里 |
| 用例 revision diff 视图 | 未实现 |
| 多引擎一致性投票 | 未实现 |
