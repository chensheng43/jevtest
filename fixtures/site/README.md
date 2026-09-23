# fixtures/site/

本地被测站点。**存在的唯一目的是让套件能测自己。**

## 为什么需要它

离线 e2e 测试要满足三个条件才能进 CI：零 API 成本、完全确定、不依赖外网。
`scripted` 引擎解决了第一个和第二个（见 `src/engine/scripted.ts`），
这个本地站点解决第三个——它不需要网络，也不会因为第三方站点改版而失效。

配合 `scripted` 引擎，整条链路（server → queue → pool → runner → checks）
都能在真浏览器里被确定性地验证。

## 覆盖什么

| 区域 | 元素 | 用来验证 |
| --- | --- | --- |
| 搜索表单 | `input[type=search]` + 提交按钮 + 原生 `<select>` 分类 + 复选框筛选 | 文本输入、原生下拉的选择语义、复选框状态 |
| 结果卡片 | 动态渲染的卡片 + 「查看详情」按钮 | 动态内容出现后的观测、按语义标签定位 |
| 详情页 | 返回按钮 + 面包屑 | 导航后的新鲜度判定（旧文档必须失效） |
| 危险按钮 | 「删除此项目」 | 护栏拦截：断言 `session.act` **调用次数为 0** |
| 陷阱元素 | 移出视口 / 一直被浮层盖住 / 观测后被浮层盖住 / 中途被禁用的按钮 | 观测时的遮挡过滤；执行前的几何重解析与遮挡命中测试 |

最后两类是这个站点最重要的价值——**它们把参考项目里靠人工核对的安全性质
变成了可自动化的断言**。参考项目用 `scripts/check_guards.py` 的
`data:text/html` 内联页面做类似的事，这里改成独立文件以便复用与维护。

## 文件

| 文件 | 内容 |
| --- | --- |
| `index.html` | 搜索表单、动态结果卡片、危险按钮、四个陷阱元素 |
| `detail.html` | 返回按钮 + 面包屑 + 按 `?id=` 渲染的设备信息 |
| `style.css` | 含两条功能性样式：浮层必须盖住按钮中心点、离屏按钮必须在首屏之外 |
| `app.js` | 动态渲染（rAF）、自动补全候选（setTimeout）、陷阱定时器、`window.__fixture` 状态 |
| `detail.js` | 详情页填充与返回 |
| `frames.html` | 一个同源 + 一个跨域 iframe（跨域靠换成 `localhost` 访问同一服务），给准入探测的 frame 计数用 |
| `pointer.html` | jQuery 式下拉菜单：`<li>` 无 role、靠 `cursor: pointer` + 事件委托可点，另有禁用项（`no-drop`）和与语义候选重叠的 pointer 元素 |
| `late.html` + `late.json` | 按钮在 DOMContentLoaded 之后由一次慢接口（`?delay=800`）拉回来，给「打开起始页先等网络安静」用 |

配套的静态服务在 `tests/e2e/fixture-server.ts`，导出
`startFixtureServer(): Promise<{ url: string; close(): Promise<void> }>`，
端口用 0 由系统分配，只服务本目录。

### 改这个站点时必须知道的三件事

1. **首屏只有 1120x780，超出视口的元素根本不进元素表。** 陷阱元素、危险按钮、
   搜索表单里的每一个控件都必须落在首屏内——它们各自对应的断言都以
   「目标出现在元素表里」为前提。把某一段往后挪，断言会变成空转而**仍然是绿的**。
   `style.css` 里所有间距都压得很小，就是为了这个，不要随手调大。
2. **动态内容要用 `requestAnimationFrame`，不要用 `setTimeout`。**
   `settleDocument` 等的是**两个 rAF**（`SETTLE_MS` 只是兜底上限，不是等待时长），
   headless 下两个 rAF 只要几毫秒；`setTimeout(…, 20)` 会输给它，
   于是「卡片渲染了却不在元素表里」。
   唯一的例外是自动补全候选——它要的正是「慢一点出现」，
   因为 combobox 模式的 settle 会一直等到候选出现（上限 200ms）。
3. **不访问外网、不调用任何 API。** 这是它存在的前提。

### 可用的调试开关

- `index.html?trapDelay=<ms>` —— 覆写陷阱元素的生效延迟（默认 1500ms）。
  调大可以放宽「观测时有效、执行前失效」这个时间窗，便于在慢机器上排查。
- `window.__fixture` —— 页面上的状态：`deleted` / `searched` / `navigated` /
  `trapClicked` / `trapMoved` / `trapDisabled` / `trapOccluded` / `trapDelayMs`。
  **它是安全断言的物证**：护栏拦下动作时，`trapClicked` 与 `deleted`
  必须仍是初始值——只看 `status` 是不够的。

