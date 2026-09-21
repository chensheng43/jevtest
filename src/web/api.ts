/**
 * API 路由。前端与 CLI 共用。
 *
 * 全部返回 JSON。错误响应统一为 `{ error: string, detail?: unknown }`，
 * 且 **HTTP 状态码必须正确**——CLI 与 CI 都靠状态码判断成败。
 *
 * 端点一览（P0）：
 *
 *   GET  /api/health                     健康检查，CLI doctor 也会用
 *   GET  /api/engines                    已注册引擎与各自能力（决定概率断言是否可求值）
 *
 *   GET  /api/cases                      用例列表（含最近一次运行结论）
 *   GET  /api/cases/:id                  读一个用例（返回 YAML 文本 + 解析后的对象）
 *   POST /api/cases                      新建或更新（body 就是 CaseDefinition JSON）
 *   POST /api/cases/import               从 YAML 文本导入
 *   DELETE /api/cases/:id
 *   GET  /api/cases/:id/export           导出规范化 YAML
 *   POST /api/cases/:id/admit            对目标页面做一次准入检查（只读，不调用模型）
 *
 *   POST /api/runs                       入队运行（body: { caseIds, options }）
 *   GET  /api/runs                       历史列表（读 index.jsonl）
 *   GET  /api/runs/:id                   完整报告
 *   GET  /api/runs/:id/events?since=N    增量拉取事件（前端 500ms 轮询这个）
 *   GET  /api/runs/:id/frames/:n.jpg     截图帧
 *   GET  /api/runs/:id/trace.zip         Playwright trace
 *   POST /api/runs/:id/cancel
 *   GET  /api/runs/:id/export?format=md|junit
 *
 *   GET  /api/queue                     队列状态（含 contextsActive，用于查泄漏）
 *
 * 一条约定：**事件响应里绝不带截图 base64**，只带 `frame` 序号，
 * 前端另外请求 frames/:n.jpg。这条把单条事件从约 200KB 压到约 400B。
 */

import type { SecurityContext } from "./security.ts";

export interface ApiDeps {
  settings: unknown;
  services: unknown;
  security: SecurityContext;
}

export interface ApiRequest {
  method: string;
  /** 已解析的路径，如 `/api/runs/abc/events` */
  path: string;
  query: URLSearchParams;
  headers: Record<string, string | undefined>;
  /** 已限长读取的请求体 */
  body: unknown;
}

export interface ApiResponse {
  status: number;
  body: unknown;
  /** 二进制响应（截图、trace.zip）用它，body 则为空 */
  raw?: Buffer;
  contentType?: string;
}

/** 唯一的请求入口。server.ts 收到请求后调用它 */
export async function handle(req: ApiRequest): Promise<ApiResponse> {
  throw new Error("未实现：P0 待实现");
}

// TODO(P0): 实现 handle()。
//   - 用简单的路径模式匹配即可，不必引入路由器。
//   - POST /api/cases 的服务端校验**永远要重新跑一遍**，
//     即使前端已经用同一份 zod schema 校验过——前端只是即时反馈，
//     不是信任边界。
//   - 校验失败时把 zod 的 issue 路径（如 `assertions.final.controls.2.valueEquals`）
//     原样回传，前端据此高亮对应表单字段。
