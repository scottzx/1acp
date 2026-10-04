# A2A 调度、查询与完成通知

## 链路与入口

```text
主 Agent / CLI → 本机 a2a-gateway → 远端 DSH /a2a SendMessage
→ 解析远端 cwd 与 preset → 创建或恢复 DSH 会话 → 返回 taskId
→ 独立执行 → GetTask / SSE / webhook → gateway 持久收件箱 → 主会话处理并 ack
```

当前为 **A2A 1.0 JSON-RPC**，SDK `@a2a-js/sdk@1.3.0`。执行端挂载于 DSH web server；`acp-service serve` 提供 ACP，不会自动开放 DSH A2A。`a2a gateway` 是调用端工具和收件箱，不是另一个 DSH 执行器。

## 远端 DSH 启用 A2A

在现有 `oneagents-acp` 配置行的 `config` 中添加：

```yaml
a2a:
  enabled: true
  tokenEnv: DSH_A2A_TOKEN
  publicUrl: http://dsh-host:3080
  defaultCwd: /home/scott
  defaultAgentPreset: standard
  workspaces:
    demo: /home/scott/projects/demo
  # 仅需要 webhook 时设置接收端实际 origin
  pushNotificationOrigins:
    - http://caller-host:36815
```

目录和主机为示例，应替换为实际部署值。通过 DSH 进程的受保护环境配置 `DSH_A2A_TOKEN`，然后重启 DSH。不要把真实 token 放在技能文档或对话中；DSH UI 登录凭据不是 A2A bearer token。未配置 A2A 时默认关闭，缺少 token 会拒绝激活。

- 公开发现：`GET /.well-known/agent-card.json`。
- 认证调用：`POST /a2a`，`Authorization: Bearer <A2A-token>`、`A2A-Version: 1.0`、`Content-Type: application/json`。
- `publicUrl` 必须是调用端能访问的 DSH origin；`path` 可自定义 RPC 路由。
- `a2a.stateDirectory` 可覆盖默认 `<DSH_HOME>/plugins/1agents-acp/a2a`。

## 调用端 gateway

先复用已有 gateway。新部署时创建受保护的 JSON 配置，例如：

```json
{
  "stateDirectory": "/absolute/private/a2a-gateway-state",
  "port": 36814,
  "remotes": {
    "wsl-dsh": { "url": "http://dsh-host:3080", "token": "replace-with-protected-A2A-token" }
  }
}
```

```sh
chmod 600 /absolute/private/gateway.json
acp-service a2a gateway --config /absolute/private/gateway.json
curl http://127.0.0.1:36814/health
```

Unix 上 CLI 校验配置权限。gateway 工具端口固定监听 `127.0.0.1`，默认 `36814`；省略 `--no-report` 会向本机 DreamMate node 注册 `a2a-gateway`。不用 DreamMate 时加 `--no-report`，通过 CLI 使用。凭据仅保存在配置中，不传入任务参数。

callback 可选；不配置也会由后台 GetTask 查询补齐状态。需要 push 时增加：

```json
{
  "callback": {
    "host": "caller-bind-IP",
    "port": 36815,
    "url": "http://caller-host:36815/a2a-events",
    "token": "replace-with-separate-callback-token"
  }
}
```

替换可绑定的 IP 与 DSH 可达的 URL，并将 URL 的精确 origin 加入远端 `pushNotificationOrigins`。回调监听器只开放配置的事件路径，不开放工具 `/invoke`；本地工具端口拒绝浏览器 Origin 调用。`originSessionId` 是可信本地调用端使用的通知路由 ID，不是认证凭据。

## 七个调度工具

DreamMate 调用参数为 `service_id: "a2a-gateway"`、`method: 方法名`、`params: 参数对象`；先查询服务和方法契约。CLI 则从 stdin 读取同一参数 JSON：

| 方法 | 参数与用途 |
| --- | --- |
| `remote_agent_spawn` | 必填 `remote, originSessionId, cwd, prompt`；可选 `agentPreset, title, notificationTarget`；新建远端任务/上下文/DSH 会话 |
| `remote_agent_get` | `remote, originSessionId, taskId`；当前状态、结果；离线返回缓存与 stale |
| `remote_agent_message` | 上述任务定位字段加 `prompt`；复用远端会话，创建新 taskId |
| `remote_agent_cancel` | 任务定位字段；取消这项任务自己的执行 |
| `remote_agent_list` | `originSessionId`；列出该主会话派发的任务 |
| `remote_agent_inbox` | `originSessionId`；读取未确认的完成/需要输入通知 |
| `remote_agent_ack` | `originSessionId, noticeId`；确认已处理，重复确认安全 |

```sh
acp-service a2a invoke remote_agent_spawn <<'JSON'
{
  "remote": "wsl-dsh",
  "originSessionId": "actual-parent-session-id",
  "cwd": "/home/scott",
  "agentPreset": "standard",
  "title": "只读系统健康巡检",
  "prompt": "实际采集 CPU、内存、磁盘、服务状态并总结。仅只读；不安装、不修改、不重启、不读取凭据。"
}
JSON
```

CLI 和 DreamMate 都返回业务结果对象；spawn 的 `taskId`、`contextId`、`sessionId`、实际 cwd/preset 位于该对象中，`result` 字段是任务报告文本。受理返回 `TASK_STATE_SUBMITTED` 不等于完成。

```sh
acp-service a2a invoke remote_agent_get <<'JSON'
{"remote":"wsl-dsh","originSessionId":"actual-parent-session-id","taskId":"returned-task-id"}
JSON
acp-service a2a invoke remote_agent_inbox <<'JSON'
{"originSessionId":"actual-parent-session-id"}
JSON
# 处理通知结果后：
acp-service a2a invoke remote_agent_ack <<'JSON'
{"originSessionId":"actual-parent-session-id","noticeId":"returned-notice-id"}
JSON
```

每次 spawn 都创建新会话，即使 cwd 相同。message 复用原 context/cwd/preset，创建新任务；可排队，但不是对当前轮的原生 interrupt/steer。当前 gateway 没有 `modelId`、`modeId` 或显式恢复任意 DSH session ID 的参数。

## 直接使用标准 A2A

请求体示例，认证与版本放在 HTTP headers 中：

```json
{
  "jsonrpc": "2.0",
  "id": "submit-1",
  "method": "SendMessage",
  "params": {
    "message": {
      "messageId": "unique-message-id",
      "role": "ROLE_USER",
      "parts": [{ "text": "只读检查项目 README 并总结", "mediaType": "text/plain" }]
    },
    "configuration": { "returnImmediately": true },
    "metadata": { "1agents": { "workspace": "demo", "agentPreset": "standard" } }
  }
}
```

响应在 `result.task`，包含 `id`、`contextId`、`metadata.1agents.sessionId/cwd/agentPreset`。`returnImmediately: true` 等待会话准备后返回任务 ID；省略则默认等待终态或需要输入状态。

`metadata.1agents` 只接受 `cwd`、`workspace`、`agentPreset`；cwd 和 workspace 不可同时传，cwd 为远端现有绝对目录，workspace 为配置别名。省略位置与预设时按远端 A2A 默认值处理。

同一会话的新任务在 `message.contextId` 传已保存 context ID；保存的 cwd/preset 不能改变。已完成 task 不可重新打开。原 task 为 input-required 时可传 `message.taskId`，配合新的 `messageId` 继续；活跃 task 上的 follow-up 被拒绝。

| 标准方法 | 用法 |
| --- | --- |
| `GetTask` | `params: { "id": "task-id" }`；查询任务状态/历史/结果 |
| `ListTasks` | 按协议做作用域过滤与分页 |
| `SubscribeToTask` | `params: { "id": "task-id" }`；SSE，从当前任务快照开始；终态任务直接查询 |
| `SendStreamingMessage` | 提交并 SSE 观察；客户端断开不会取消独立执行 |
| `CancelTask` | `params: { "id": "task-id" }`；取消任务自己的排队或运行 |
| `Create/Get/DeleteTaskPushNotificationConfig`、`ListTaskPushNotificationConfigs` | webhook 配置生命周期 |

支持文本 prompt；不要发送附件或旧 v0.3 消息结构。终态包括 completed、failed、canceled、rejected；input-required/auth-required 需要继续处理，不是成功完成。

## 通知、持久化与恢复

发送配置里可加入标准 `taskPushNotificationConfig`（URL 的 origin 须被允许）：

```json
{
  "returnImmediately": true,
  "taskPushNotificationConfig": {
    "url": "http://caller-host:36815/a2a-events",
    "authentication": { "scheme": "Bearer", "credentials": "protected-callback-token" }
  }
}
```

DSH webhook 发送 A2A `StreamResponse`（`application/a2a+json`），含 task/artifactUpdate/statusUpdate。它按任务排序、超时 5 秒、拒绝重定向，尽力投递且不重试。回调提示不能替代可信的 GetTask 查询。

gateway 将状态、任务归属和通知原子落盘；通知有稳定 `noticeId`，读取不会确认。默认每 3 秒后台核对任务，丢失 webhook 或 gateway 重启后仍能补齐。主机离线只导致 `stale`，不会伪造远端 failed。

若要通知主 Agent 宿主，在 gateway 配置中增加 `notificationTargets` 名称映射，每项为 `{ "url": "http://host/notice", "token": "protected-token" }`，spawn 时传 `notificationTarget` 名称。这里接收的是 gateway notice（含 originSessionId/taskId/contextId/state/result），不是原始 A2A StreamResponse。

宿主通知使用 Bearer 与稳定 `Idempotency-Key`；失败或 gateway 重启后重试，直到接收端接受或通知被 ack。宿主须先持久化/去重，再注入对应主会话并触发模型执行。HTTP 成功只代表接收，不证明主模型已运行；当前包没有自动唤醒 Codex 下一轮的宿主适配器。

执行端和 gateway 状态目录各由单个活跃实例拥有，不应手工删除运行中实例的 lock。gateway 重启不取消远端任务；DSH 重启会将中断任务标为 failed，保留已完成结果和 context 映射，新任务可用 context 恢复 DSH 会话，不自动重放中断工作。

## 共享实现

`@1agents/acp-service/a2a` 导出 `createA2AServer`、`FileA2AStore`、`RemoteAgentGateway`、`serveA2AGateway` 及类型。server 接收 `A2ABackend`，核心不依赖 DSH，工厂本身不创建网络 listener；DSH 通过公开 session-controller API 提供 backend 并挂载路由，独立入口可复用这套实现。
