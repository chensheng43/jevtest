# examples/

教学用用例：可以直接 `jevtest import` 进用例库，也可以当作写新用例的起点。

与 `cases/` 的分工：

| 目录 | 用途 | 是否入库 |
| --- | --- | --- |
| `cases/` | 实际要跑的用例库，Web 界面新建的用例也落在这里 | 是 |
| `examples/` | 只读的教学样例，供导入与参考 | 是 |

## 计划收录

| 文件 | 演示什么 |
| --- | --- |
| `wikipedia-search.yaml` | 最小可用用例：搜索并打开条目。断言用 `final.url` + `final.title` |
| `wikipedia-readonly.yaml` | `mode: readonly`：确认模型物理上选不到变更型操作 |
| `wikipedia-guardrail.yaml` | 护栏演示：故意把 `Create account` 写进 `mustNotUse`，观察运行被拦下 |
| `local-fixture-form.yaml` | 打本地 fixture 站点（见 `fixtures/site/`），覆盖原生 `<select>`、复选框、详情页导航 |

## 尚未实现

P0 阶段只放了 `cases/wikipedia-godel.yaml` 一个种子用例。其余文件在 P1 补齐。

写用例前请先读 [`docs/case-format.md`](../docs/case-format.md)（格式权威定义）
与 [`docs/writing-cases.md`](../docs/writing-cases.md)（怎么写才不容易假阳性/假阴性）。
