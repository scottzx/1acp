# ACP 任务工作台与人工审核实施记录

- 日期：2026-10-22（Asia/Shanghai）
- 状态：源码已实现并完成隔离验证，尚未切换生产服务。
- 前端与 Web 代理位于父项目 `1agents_app`；执行事实仍由本模块的 ACP 账本保存。

阶段保存与后续范围见 [阶段保存记录](a2a-workbench-stage-checkpoint-20261022.md)及 [多角色扩展计划](multi-agent-expansion-plan-20261022.md)。保存时再次核对发现，当前人工审核预览仍限定六页；非六页文稿的人审兼容尚未完成，应在部署前处理。本记录中的通过结果不代表该场景已验收。

## 页面与数据

入口为桌面侧栏“任务工作台”和手机“更多 → 任务工作台”。全部任务、待我确认、进行中、异常共享同一个任务集合；表格复用既有 DataGrid 的列配置、排序、分组和父子层级。任务为表格主记录，执行轮次与产物版本放在详情内。

桌面点击任务打开宽详情，可展开整页；手机使用单页详情。外部链接使用 hash 路由，避免把审核参数传入终端连接参数：

```text
/#acp/tasks/{jobId}
/#acp/tasks/{jobId}?review={reviewId}
/#acp/tasks/{jobId}?review={reviewId}&mode=drawer
```

详情包含概览与进展、血缘关系、产物与审核、事件记录。阶段推进图来自已知工作流阶段；父子图表示归属，任务依赖与替代关系分别展示。计划阶段没有真实任务 ID，不伪造执行日志或下游任务。子任务只展示自身执行进展。

阶段状态、执行轮次、版本和人工决定通过只读投影返回。主应用不创建另一份 ACP 任务表，也不允许直接编辑表格中的执行状态。轮询读取不会唤醒原主会话或启动模型。

## 人工审核闭环

新创建的 PPT 交付默认 `requireHumanReview: true`。大纲校验完成后，父任务持久化为 `input_required / awaiting_human`，文稿作者的本轮执行保持完成，制作尚未派发。

- 评论只增加历史，不放行。
- 要求修改必须填写意见，继续原文稿作者会话，创建新的执行轮次与 `script-vN` 目录；人工修改轮次不消耗质量返工额度。
- 通过绑定父执行轮次、文字稿版本和 SHA-256；内容漂移、旧版本、其他审核人或过期任务均不能放行当前稿件。
- 放弃与要求修改分开，关闭本任务及其祖先取消边界下的后续派单入口，保留产物与历史。
- 稍后处理仅返回任务列表，不改变审核状态。

正文预览从同一份 `slide-script.json` 字节生成。每轮文字稿位于 `coordinator/script-vN/`，下游制作合同引用获批目录及摘要；制作版本仍为独立的 `revision-N`。决定与续跑意图保存在同一个父流程记录内，后台恢复以稳定派单标识消费，重复请求不会创建第二个有效执行。人工等待时间从执行预算中扣除。

既有持久任务沿用其冻结策略；不会给已经执行的老任务补插未经记录的人工关口。最终交付的 `humanAcceptance` 仍表示最终成品的业务验收，文字稿批准通过独立的 `approvedScript` 引用追溯。

## 服务配置

ACP gateway 私密配置增加独立的 `workbench` 段，令牌应与执行宿主、通知和自动化凭证区分：

```json
{
  "workbench": {
    "token": "REPLACE_WITH_DEDICATED_WORKBENCH_TOKEN",
    "reviewerId": "local-owner",
    "reviewerName": "本机用户",
    "publicBaseUrl": "https://your-1agents-host.example/"
  }
}
```

`publicBaseUrl` 可省略；配置后既有主会话通知渠道携带审核深链。每份新的待审核版本有独立通知标识。可选 `allowedOrigins` 为服务端允许查询的 `originSessionId` 列表；省略时，本机 owner 可读取该网关全部来源。该范围不能由浏览器查询参数指定。

父应用 Go 服务的启动环境增加：

```sh
ACP_WORKBENCH_URL=http://127.0.0.1:36814
ACP_WORKBENCH_TOKEN=REPLACE_WITH_THE_SAME_DEDICATED_WORKBENCH_TOKEN
```

Web 前端只调用下列主应用 API，不接触 gateway 凭证：

```text
GET  /api/agent/acp/tasks?filter=all&offset=0&limit=100
GET  /api/agent/acp/tasks/{jobId}
POST /api/agent/acp/tasks/{jobId}/reviews/{reviewId}/decisions
```

决定请求包含 `action / revision / digest / clientRequestId / note?`，不能提交操作者或权限范围。身份由专用 gateway 连接映射为配置的 owner；当前主应用是本机单用户认证模型，不声称具备多用户实名审批。人工写操作需要同源 Web 请求，内部 MCP/session、原生中转和 relay 连接不能替代这一人机边界；这些客户端可以通过原有执行接口查询进展。

没有配置连接时，工作台明确提示尚未连接；离线与版本冲突分别报告，不回退为示例数据或普通 `execution_review`。

## 验证

- ACP 服务构建及 TypeScript 检查通过；服务测试 240 项通过。
- 新增人工审核模型、任务投影、PPT 人工等待/修订/恢复和 HTTP 边界测试，覆盖旧版本、字节漂移、重复决定、跨重启续跑、两小时人工等待及取消后派单关闭。
- 父应用前端 `tsc --noEmit --skipLibCheck`、生产 Webpack 构建和 5 项任务导航/层级测试通过。构建仅保留既有 Sass 弃用提示；未加新依赖。
- Go 代理 race 测试、Web server 编译及认证/代理回归通过。
- 浏览器隔离验证使用真实前端组件、Go 代理和 ACP 账本，执行角色由测试适配器代替：已检查列表与父子层级、整页深链、旧版只读、评论不放行、批准后出现制作任务，以及 390px 手机布局。未调用生产模型或修改生产任务。

生产启用需要用以上独立凭证连接新 gateway 与新 Web 服务，并部署本次前端产物。本轮未重启或替换运行中的生产服务，也未发布 npm 包。

## 主要实现位置

本模块：`packages/service/src/execution/human-review.ts`、`workbench.ts`、`ppt-delivery.ts` 与 `packages/service/src/a2a/gateway.ts`。

父项目：`frontend/src/components/personal/AcpTaskWorkbench.tsx`、`frontend/packages/core/services/acpTaskService.ts`、`frontend/src/stores/acpTaskNavStore.ts` 与 `backend/internal/acpworkbench/handler.go`。
