---
name: acp-service
description: 使用 @1agents/acp-service 的 ACP CLI、HTTP/WebSocket 服务和 DSH 插件，或通过 A2A 向远端 DSH 派发任务、查询进度、继续会话及处理完成收件箱。适用于接入和使用这些能力；不用于一般系统巡检或与该包无关的模型配置。
---

# ACP Service

`@1agents/acp-service` 将 Agent runtime、CLI、ACP 服务、DSH 插件和 A2A 实现打进同一个 npm 包。原生 Agent 的可执行文件、登录凭据和模型配置由执行主机提供。

## 选择调用入口

| 用户需求 | 使用入口 | 详细说明 |
| --- | --- | --- |
| 在当前主机运行 Codex、Claude 等 Agent，管理命名会话、队列或流程 | `acp-service <agent> ...` | [ACP CLI 与服务](references/acp.md) |
| 从客户端连接常驻 Agent 服务，使用标准会话与流式交互 | `acp-service serve`，ACP over WebSocket | [ACP CLI 与服务](references/acp.md) |
| 在 DSH 界面使用外部 Agent、原生模型和模式控制 | DSH 中安装同一个包，选择 `ACP · Agent` 预设 | [DSH 插件](references/dsh.md) |
| 像远端子任务一样调用 WSL/其他主机上的 DSH，立即取回任务 ID | A2A gateway 的 `remote_agent_*` 工具 | [A2A 调度与收件箱](references/a2a.md) |
| 为其他 A2A 客户端开放 DSH 能力 | DSH `a2a` 配置、Agent Card、标准 JSON-RPC/SSE | [A2A 调度与收件箱](references/a2a.md) |

先检查现有服务和安装版本；服务已经可用时直接复用。需要哪种入口就读对应引用文件。不要为了派发一次远端任务重新安装或重启正常运行的服务。

ACP 管理 Agent 会话、交互与工具权限；A2A 管理跨 Agent 的任务、状态、结果及订阅通知。A2A 指向 DSH 后，DSH 的预设决定由标准 Agent 还是外部 ACP Agent 执行。

## 安装与技能发现

需要 Node.js `>=22.13.0`。安装指定版本或用户提供的构建包；A2A 命令以实际安装版本的帮助输出为准，源码功能不代表 npm 上的旧版本已包含它。

```sh
npm install -g @1agents/acp-service
acp-service --version
acp-service --help
acp-service a2a --help
acp-service --skill list
acp-service --skill show acp-service
```

此技能随包保存在 `skills/acp-service/`，可独立导出，包含引用文档和 UI 元数据：

```sh
acp-service --skill export acp-service > acp-service-skill.tar
# 用户需要为当前项目安装技能时：
acp-service --skill install acp-service --agent codex --scope repo
```

`--skill` 同时保留内嵌 runtime 的 `acpx` 技能。`acp-service` **不带参数会启动 ACP 常驻服务**；查看帮助要显式传 `--help`。

## 远端任务的最短工作流

如果宿主已有 DreamMate 工具，检索服务 `a2a-gateway`，按需查看方法契约，再通过 `dreammate_invoke` 调用。没有 DreamMate 时，使用同名 CLI `a2a invoke`；两者调用同一个 gateway。

1. 取得当前主会话的稳定 ID，作为 `originSessionId`；保留真实会话归属，不使用每次随机生成的 ID。
2. 明确远端节点名、远端绝对目录、预设和完整任务说明。远端会话不会自动继承主会话上下文。
3. 调用 `remote_agent_spawn`，记录返回的 `taskId`、`contextId`、`sessionId` 和实际 `agentPreset`。取到 ID 只表示已受理；仍要检查状态和结果。
4. 查询 `remote_agent_get` 或读取 `remote_agent_inbox`。处理报告或所需输入后，按 `noticeId` 调用 `remote_agent_ack`。读取通知本身不会删除或确认它。
5. 要继续同一远端会话，使用 `remote_agent_message`；需要全新上下文则再次 spawn。取消时传入准确的任务 ID。

```json
{
  "remote": "wsl-dsh",
  "originSessionId": "actual-parent-session-id",
  "cwd": "/home/scott",
  "agentPreset": "standard",
  "prompt": "执行只读系统健康巡检：采集 CPU、内存、磁盘与服务状态，给出时间和证据；不得修改设置、重启、安装或读取凭据。"
}
```

工作目录与预设必须存在于远端部署。需要普通 DSH Agent 时显式传 `standard`；需要外部 Codex 时传 `oneagents-acp-codex`（前提是该预设可用）。省略 `agentPreset` 会用 **A2A 服务端配置的默认预设**，它可能与 DSH 界面默认值不同。

## 会话、模式与模型

| 概念 | 当前行为 |
| --- | --- |
| `cwd` | gateway 的 spawn 必填；是远端现有绝对路径，不能传本机路径代替 |
| `agentPreset` | 选择 DSH Agent 的组成；gateway 可省略并使用远端 A2A 默认值 |
| 标准 DSH 模型 | `standard` 使用该 DSH 部署的默认 provider/model，不固定为某一厂商 |
| ACP Agent 模型/模式 | 由原生 Agent 提供，通过其公布的配置选项或模式切换 |
| A2A `modelId` / `modeId` | 当前 spawn 和 `metadata.1agents` **没有这些参数**；不能凭空传入或把模型名称写进 prompt 当作配置 |

例如某部署默认配置为 `minimax-cn / MiniMax-M3` 时，`standard` 会调用它。应读取 DSH 模型目录/配置，并用会话实际请求记录中的 provider/model 核对；Agent 自述身份不足以证明模型路由。

## 可靠性与宿主边界

- ACP service session ID、原生 Agent session ID、A2A task ID、A2A context ID、DSH session ID 是不同标识。保存返回值，按各自 API 使用。
- gateway 重启可恢复任务记录和未确认通知；DSH 执行主机重启会将被中断的非终态任务标为失败，不能承诺自动续跑。
- 网络离线可能返回缓存与 `stale: true`，不等于远端任务失败。SendMessage 响应不明确时先核对，不盲目重发。
- DSH 的直接 webhook 为尽力投递；gateway 的持久收件箱和后台查询负责补齐，配置宿主通知接收端后还能重试投递。
- 完成通知到达收件箱不等于主模型被唤醒。接收宿主须实现去重、路由和会话注入；普通 MCP 连接本身不提供自动新一轮执行。此包没有接管 Codex 原生 `spawn_subagent`。
- 任务权限取决于用户授权、执行主机、DSH/原生 Agent 策略；“只读”任务应在 prompt 中写明动作边界。不要默认启用 `--approve-all` 或将凭据放进 prompt、结果和工具参数。

报告时说明受理、执行、完成和通知处理各阶段的实际状态，给出真实任务 ID及关键结果；无法验证的硬件或模型能力应明确标注。
