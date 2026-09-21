/**
 * 前端入口。原生 ES module，不打包。
 *
 * 尚未实现（P1）。计划的结构：
 *
 *   - `call(path, body)`：统一请求封装，自动带 X-Jevtest-Token 头（从
 *     <meta name="jevtest-token"> 读取），统一错误处理。
 *
 *   - 进度：**轮询** `GET /api/runs/:id/events?since=<lastSeq>`，间隔 500ms。
 *     不用 SSE —— 见 src/web/events.ts 里对轮询与 SSE 的取舍说明。
 *     把 `lastSeq` 存在变量里，刷新页面时从 0 重新拉，即可回放出全部历史。
 *
 *   - `GET /api/engines` 的结果要缓存下来：它决定界面是否显示概率类断言
 *     （`probabilities: "degenerate"` 的引擎下，概率检查会是 skipped）。
 *
 *   - 断言编辑器：三个 tab 对应 final / trajectory / quality 三族，
 *     每族是纯行编辑器（增删行、每行 2~5 个输入框）。
 *     **刻意不做 schema 驱动的表单生成器**——schema 小而固定，
 *     生成器只会带来一层间接。手写 section 与 YAML 键 1:1 对应，
 *     靠往返测试保证不漂移（见 src/schema/yaml.ts）。
 *
 *   - 事件里的 `frame` 序号要另外请求 `GET /api/runs/:id/frames/:n.jpg`。
 *     事件本身**不带截图 base64**，这是刻意的（见 src/web/api.ts）。
 */

const token = document.querySelector('meta[name="jevtest-token"]')?.content ?? "";

console.info("jevtest 前端尚未实现（P1）。令牌已注入：", token ? "是" : "否");
