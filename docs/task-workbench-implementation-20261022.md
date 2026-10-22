# ACP 任务工作台与人工审核实施记录

- 日期：2026-10-22（Asia/Shanghai）
- 状态：源码已实现并完成隔离验证；已连接本机真实 ACP 账本，开放 owner 专属 Tailscale 入口。
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

表格“待办与卡点”将换行和连续空白合并，最多显示 50 个 Unicode 字符（含省略号），并限制为两行、最大宽度 250px。待审核按钮保留，悬停可读原文，任务详情仍展示完整进展；截断不修改 ACP 数据或排序依据。

### 执行信息拆分

列表原“执行者”列拆成三个可独立排序、分组的字段；概览、各执行轮次和血缘节点沿用相同口径：

| 字段 | 展示内容 | 取值依据 |
| --- | --- | --- |
| 任务方式 | 临时任务、常驻角色、工作流或未记录 | 当前 Attempt 冻结的目标类型、角色绑定及已保存的流程记录 |
| 角色或预设 | 常驻角色名称/ID，或临时任务明确指定的预设 | 该 Attempt 的目标快照；未显式指定预设时提示宿主默认、实际预设未记录 |
| 执行服务 | A2A 端点、ACP 内置协调器或未记录 | 优先采用该 Attempt 执行回执中的端点，其次为冻结派单快照；网关内流程按自身流程记录识别 |

`legacy:ppt-beautifier` 是旧派单接口映射的目标 ID，不能当作 PPT 角色。任务标题不参与类型、角色或模型推断；服务别名不等同于物理设备。`standard` 表示记录的预设，不证明实际使用了哪一个模型。

`ppt-beautifier` 同时也是早期配置的通用 A2A 连接别名，指向本机 `127.0.0.1:3080`；不能把它直接当作执行服务名称。连接别名单独作为第二行/详情追溯信息展示。`execution.serviceInfo` 提供 `kind / source / host? / port? / locality? / connectionAlias?`；执行证据按 `backend_run / target_snapshot / workflow_run / unrecorded` 区分。只投影主机、端口和本机端点/网络端点分类，不返回 URL 路径、查询或凭据，也不据此推断服务品牌、物理设备或模型。PPT 父流程显示“ACP 内置协调器”，不把它绑定的子任务连接当作父流程宿主。事件视图也剔除原始 endpoint，避免旁路暴露 URL。

当前接入范围仅为配置连接的一个 ACP/A2A 网关账本；其他网关实例、本地 ACP 直连会话及主应用执行轮次尚未纳入。页面已明确提示该范围。原始 A2A 执行记录、Job、Attempt 和会话是不同口径，不能直接相加或按标题猜测关联。

Summary 和每个 Attempt 的 `execution` 投影分别包含 `kind / targetId / targetName? / roleId? / agentPreset? / presetStatus / service? / provider? / connectionId?`。Summary 使用当前执行轮次，历史轮次只用自己的快照；不回查今天的目录来覆盖过去的身份。缺失、冲突或不完整的信息保留未知，不迁移或重写旧账本。新派单快照增加 `targetKind`、`targetName`，使后续记录更完整。原始目标与连接 ID 保留在来源/轮次技术信息内；不返回原始输入、binding、端点或工作目录。

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

- ACP 服务构建及 TypeScript 检查通过；服务归属修正后，服务测试 249 项通过。
- 新增人工审核模型、任务投影、PPT 人工等待/修订/恢复和 HTTP 边界测试，覆盖旧版本、字节漂移、重复决定、跨重启续跑、两小时人工等待及取消后派单关闭。
- 父应用前端 `tsc --noEmit --skipLibCheck`、12 项导航/执行身份/服务来源/层级测试及本次工作台 Webpack 构建通过；初版已通过完整生产 Webpack 构建。构建仅保留既有 Sass 弃用提示；未加新依赖。
- Go 代理 race 测试、Web server 编译及认证/代理回归通过。
- 浏览器隔离验证使用真实前端组件、Go 代理和 ACP 账本，执行角色由测试适配器代替：已检查列表与父子层级、整页深链、旧版只读、评论不放行、批准后出现制作任务，以及 390px 手机布局。未调用生产模型或修改生产任务。

## 本机真实数据接入（2026-10-22）

入口为 `https://scott-mac.tailfb4720.ts.net:8452/#acp/tasks`。链路为 Tailscale Serve HTTPS → loopback Web `18765` → loopback Go 代理 `18767` → 真实 ACP gateway `36814`。前端不再连接隔离 fixture。

Web 层只接受 Serve 注入的本机 owner 的 `Tailscale-User-Login`，页面、静态资源和 API 均受保护。Serve 会剥离请求自带的身份头并注入实际账号，参见 [Tailscale Serve 身份头说明](https://tailscale.com/docs/features/tailscale-serve)。凭据只保存在权限 `0600` 的服务端文件中。

- 实际账本仍为 `~/.local/state/1agents/a2a-gateway/gateway.json`，未迁移或复制成另一份工作数据。
- 当前 gateway 发布目录为 `~/.local/share/1agents/a2a-gateway/releases/20261022-human-workbench-03/runtime`。初次真实接入在原运行版本上只覆盖工作台与人工审核相关的四个 JS 文件；执行信息拆分仅更新 `workbench.js`，并为现行 `gateway.js` 的目标快照精确增加类型和名称；本次服务来源修正只更新 `workbench.js`。保留其他运行代码与已有角色/技能能力。原配置、运行目录指针及切换前账本均已备份；账本备份仅供取证，不作为回滚时覆盖在线状态的手段。
- Web 和 Go 代理发布至 `~/.local/share/1agents/acp-workbench/current`；配置位于 `~/.config/1agents/acp-workbench/`，由 `com.1agents.acp-workbench-web` 与 `com.1agents.acp-workbench-proxy` 两个 launchd 服务常驻。
- gateway 通过 SIGTERM 优雅重启；切换前无 dispatching 轮次，已受理的远端执行未取消。前后 sourceId、46 个 Job ID 和活动任务的 currentAttemptId 保持一致。
- HTTPS 浏览器已显示 31 个主任务、46 条记录、1 个进行中任务、0 个待人工审核；真实详情的阶段、执行轮次、父子关系和替代关系读取正常。无身份访问被拒绝，Serve 剥离伪造身份头的行为已验证。
- 仅进行了真实数据读取验证，没有提交真实批准、修改或取消。旧任务继续采用冻结策略，不补造人工审核请求。
- 执行信息拆分已在同一 HTTPS 入口生效：46 条记录中识别临时任务 26 条、常驻角色 12 条、工作流 4 条，另 4 条历史类型未记录；已检查真实临时 PWD 任务的列表、详情及轮次信息。Web 当前发布为 `~/.local/share/1agents/acp-workbench/releases/20261022-05`，保留卡点 50 字/两行摘要，并增加服务归属及来源范围提示。服务分布为本机 A2A 端点 34 条、远端 A2A 端点 8 条、ACP 内置协调器 4 条；其中 18 条当前 Job 的端点来自执行回执，24 条来自冻结快照，4 条内部流程由流程记录证明。

本次为本机私有部署，未发布 npm 包。

## 主要实现位置

本模块：`packages/service/src/execution/human-review.ts`、`workbench.ts`、`ppt-delivery.ts` 与 `packages/service/src/a2a/gateway.ts`。

父项目：`frontend/src/components/personal/AcpTaskWorkbench.tsx`、`frontend/packages/core/services/acpTaskService.ts`、`frontend/src/stores/acpTaskNavStore.ts` 与 `backend/internal/acpworkbench/handler.go`。

## 表格展示微调（2026-10-22）

保留字段与数据逻辑，仅调整表格样式和单元格包装：统一浅色表头、行边界与状态标签；标题和技术ID区分主次；任务名最多两行，父任务链接单行省略；任务方式采用中性标签，服务别名使用次级文字。表格滚动区独立边框，固定表头与任务名称列；层级只保留按深度的缩进，避免共享表格对子行再次增加padding。卡点继续最多50字/两行，完整内容仍在详情内。手机宽度下首列为220px。

类型检查、工作台构建及diff检查通过；浏览器验证横滚432px、纵滚720px后名称列和表头位置不变，并检查390px手机布局。未更改共享DataGrid和后端，也未改变用户列偏好。Web发布20261022-05。
