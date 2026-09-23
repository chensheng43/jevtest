# HTTP API 参考

本地服务的 REST 端点，供前端使用。**状态码必须正确**——脚本与 CI 靠它判断成败。

实现集中在 [`src/web/api.ts`](../src/web/api.ts)（唯一入口 `handle()`），
路由与守卫在 [`src/web/server.ts`](../src/web/server.ts)。

CLI 不经过 HTTP：`run` / `validate` / `import` 直接调用同一套模块，
`doctor` 调同一个 `handle()` 但不经网络（[`decisions.md` D16](decisions.md)）。

---

## 1. 通用约定

### 1.1 请求

| 项 | 约定 |
| --- | --- |
| 监听地址 | **仅 `127.0.0.1`**。不要暴露到 `0.0.0.0`——它能读写用例、驱动浏览器、且持有凭证 |
| 路径前缀 | 除静态资源外均为 `/api/` |
| 请求头 | 写操作需 `X-Jevtest-Token`（见 §2） |
| 请求体 | JSON；**流式限长 8KB**（`MAX_BODY_BYTES`），超了直接 413 |
| 查询串 | `URLSearchParams` |

限长必须是**流式**的：先收完再判大小等于允许对方把内存塞爆。

### 1.2 响应

| 项 | 约定 |
| --- | --- |
| 成功 | JSON（二进制端点除外，见 §3.5） |
| 失败 | `{ error: string, detail?: unknown }`，**`error` 给人看**：说清原因与怎么修 |
| 状态码 | 正确反映结果。CLI 与 CI 靠它判断成败 |

校验失败时，`detail` 里带 zod 的 **issue 路径**（如
`assertions.final.controls.2.valueEquals`），前端据此高亮表单字段。

> **服务端校验是唯一的信任边界。** 前端的必填标红只是即时反馈。

### 1.3 二进制端点

截图与 trace 返回 `raw: Buffer` + `contentType`，`body` 为空。

---

## 2. 安全守卫

**「本地」不等于「安全」**：浏览器里任何一个你访问过的网页都能向 localhost 发请求。

| 动词 | 校验 |
| --- | --- |
| GET | `Host` 必须精确等于 `127.0.0.1:<port>` |
| POST / DELETE | `Host` + `X-Jevtest-Token` + `Origin` |

三重守卫各自防什么、为什么必须三道，见
[`architecture.md §8.3`](architecture.md)。威胁模型见 [`security.md`](security.md)。

守卫失败的原因会写进响应的 JSON（方便排查「我的 curl 为什么被 403 了」），
但**不回显收到的 token**。

---

## 3. 端点

### 3.1 环境

| 方法 | 路径 | 说明 | 契约 |
| --- | --- | --- | --- |
| GET | `/api/health` | 健康检查：Node 版本、并发与录制配置、用例/运行目录、缺哪些凭证。CLI `doctor` 也用它 | 已定（`web/api.ts`） |
| GET | `/api/engines` | 已注册引擎与各自能力 | **已定** |

`GET /api/engines` 的响应即 `registry.listEngines()` 的返回值：

```ts
{ name: string; text: boolean; probabilities: string }[]
```

`probabilities` 决定概率类断言是否可求值——前端表单据此决定要不要禁用
`minTargetProbability` 输入框。见 [`architecture.md §5.3`](architecture.md)。

### 3.2 用例

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/cases` | 列表（含最近一次运行结论） |
| GET | `/api/cases/:id` | 读一个用例 |
| POST | `/api/cases` | 新建或更新 |
| POST | `/api/cases/import` | 从 YAML 文本导入 |
| DELETE | `/api/cases/:id` | 删除 |
| GET | `/api/cases/:id/export` | 导出规范化 YAML |
| POST | `/api/cases/:id/admit` | 对目标页面做一次准入检查 |

| 端点 | 请求体 | 响应 | 契约 |
| --- | --- | --- | --- |
| `GET /api/cases` | — | `CaseSummary[]` | 已定（`store/cases.ts`） |
| `GET /api/cases/:id` | — | `LoadedCase`：`{ def, revision, yaml }` | 已定（`store/cases.ts`） |
| `POST /api/cases` | `CaseDefinition` + `expectedRevision?` | `CaseRevision` | 已定；**必须带 `expectedRevision`**，否则两个标签页并发编辑时后写的会静默覆盖先写的 |
| `POST /api/cases/import` | YAML 文本 | `CaseRevision` | 已定；id 冲突追加 `-2`，**不覆盖既有用例** |
| `DELETE /api/cases/:id` | — | `204 No Content` | 已定；不做「撤销」，客户端自行刷新列表 |
| `GET /api/cases/:id/export` | — | 规范化 YAML，`text/yaml` | 已定 |
| `POST /api/cases/:id/admit` | — | `AdmissionReport` | 已定 |

`POST /api/cases` 的并发语义值得单独说：它**不是**「最后写入者赢」，而是乐观锁。
磁盘上的 `revision` 与请求里的 `expectedRevision` 不符时返回 `409`，
响应体带上当前 `revision`，前端据此提示「这个用例已被改动，重新加载后再保存」。
静默覆盖属于数据丢失，而用户通常要到很久以后才发现改动消失。

`GET /api/cases/:id` 在用例不存在时返回 `404`，`store/cases.ts` 的 `CaseNotFound`。
`POST /api/cases/:id/admit` 只在用例存在且目标页面可达时才返回 `AdmissionReport`；
页面打不开时返回 `502` 并说明原因——**准入探测失败不等于「用例不可测」**，
把两者混成一个响应会让前端显示误导性的结论。

`POST /api/cases` 的请求体就是 `CaseDefinition` JSON——字段定义见
[`case-format.md`](case-format.md)，那是权威规范。

`GET /api/cases/:id` 同时返回 **YAML 文本**与**解析后的对象**，是为了让表单编辑器
不必自己再序列化一遍；`revision` 用于乐观并发控制。

`POST /api/cases/:id/admit` **不运行用例、不调用模型**，只是一次只读的页面探测，
所以可以在表单里做一个「检测页面」按钮随手点。

> 落盘、revision、id 冲突都由 `src/store/cases.ts` 的 `CaseStore` 实现，
> 表单、CLI、导入三条入口最终落到同一个 `write()`（[`architecture.md §11.2 ①`](architecture.md)）。

### 3.3 运行

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| POST | `/api/runs` | 入队运行 |
| GET | `/api/runs` | 历史列表 |
| GET | `/api/runs/:id` | 完整报告 |
| GET | `/api/runs/:id/events` | 增量拉取事件 |
| POST | `/api/runs/:id/cancel` | 请求取消 |
| GET | `/api/runs/:id/export` | 导出 md / junit |

| 端点 | 请求 | 响应 | 契约 |
| --- | --- | --- | --- |
| `POST /api/runs` | `{ caseIds: string[], options?: RunOptions }` | `{ suiteRunId, runIds }` | 已定 |
| `GET /api/runs` | — | `RunIndexEntry[]`，**按时间倒序** | 已定 |
| `GET /api/runs/:id` | — | `CaseRunReport` | 已定 |
| `GET /api/runs/:id/events?since=N` | `since` = 上次拿到的 `seq` | `SeqEvent[]` | 已定 |
| `POST /api/runs/:id/cancel` | — | `boolean`（是否成功请求取消） | 已定 |
| `GET /api/runs/:id/export?format=md\|junit` | `format` | `text/markdown`；`junit` 尚未实现，回 `501` | 已定 |

`RunOptions`：`{ recordFrames?, engineOverride?, suiteRunId? }`。**`engineOverride` 用于同一用例的 A/B 对比**。

`CaseRunReport` 与 `RunIndexEntry` 的字段含义见 [`report-format.md`](report-format.md)。

**`GET /api/runs/:id/events` 是前端的轮询端点。** 前端每 500ms 带上 `?since=<上次的 seq>`
拉一次，因此刷新页面不会丢历史。见 [`architecture.md §8.2`](architecture.md)。

`SeqEvent` 是 `RunEvent` 加上 `seq`（单调递增）与 `ts`。前端按 `seq` 增量渲染，
switch 分支与 `schema/events.ts` 的判别联合一一对应。

> **事件响应里绝不带截图 base64。** 需要画面时只带 `frame` 序号，
> 前端另外请求 §3.5。这把单条事件从约 200KB 压到约 400B。

**取消语义：只在步边界生效**，不中断一次已经开始的浏览器变更。
这与「浏览器变更从不重试」是同一条原则的两面——都不能留下「做了一半」的状态。

### 3.4 队列

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| GET | `/api/queue` | `QueueStatus` |

```ts
{ queued: number, active: number, workers: number, contextsActive: number }
```

**`contextsActive` 是判断 context 泄漏的唯一手段**——运行结束后它必须回到 0。
不归零说明 `context.close()` 没执行（通常是异常路径上漏了 `finally`），
泄漏的 renderer 进程会一直吃内存且不会自己消失。见
[`architecture.md §9.3`](architecture.md)。

### 3.5 产物

| 方法 | 路径 | 响应 |
| --- | --- | --- |
| GET | `/api/runs/:id/frames/:n.jpg` | `image/jpeg` |
| GET | `/api/runs/:id/trace.zip` | `application/zip` |

`trace.zip` 可用 `npx playwright show-trace` 直接打开，带时间轴与每步 DOM 快照——
**排查任何失败都先看它**，比读报告快得多。

---

## 4. 非 `/api` 路径

| 路径 | 说明 |
| --- | --- |
| `/` 及静态资源 | `src/web/public/`，原生 HTML/CSS/JS。读取时把 `__JEVTEST_TOKEN__` 占位符替换为真实令牌 |
| `/vendor/*` | 从 `node_modules` 取前端资产，目前只有 Bootstrap 的样式表（D18）。**是全项目唯一的目录穿越风险点**，必须校验解析后的前缀在允许目录内且只放行 `.js` / `.map` / `.json` / `.css`。风险评估见 [`security.md` §5](security.md) |

---

## 5. 尚未覆盖

以下能力在 [`limitations.md`](limitations.md) 与 [decisions.md](decisions.md) 里有记录，
但**没有对应端点**，写界面时不要假设它们存在：

| 能力 | 状态 |
| --- | --- |
| 登录态管理（`storageState` 上传/复用） | 底层能力已规划，无端点与用例字段 |
| 套件（一组用例）的增删改 | 无。`suiteRunId` 只是批量运行的关联 id，不是持久化实体 |
| 用例 revision 的 diff 视图 | 未实现 |
| 权限 / 多用户 | 无。单机工具，靠 §2 的三重守卫保护 |
