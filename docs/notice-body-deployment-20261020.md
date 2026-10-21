# A2A 通知正文与产物链接部署验收 · 2026-10-20

Codex 与 DSH 均通过真实最终答复正文、产物链接、原会话自动唤醒、查询及 ack 验收。

## 通知内容与兼容性

- 通知先展示最终答复正文和其中的 Markdown 产物链接，再列出明确提供的 A2A HTTP(S) artifact URL；任务定位 JSON 位于末尾。
- remote_agent_get / remote_agent_inbox 与 remote_agent_ack 保留；受理仍与模型处理、业务确认分别核验。
- 普通正文完整保留；超过 48 KiB 的正文显示有标注的节选，独立链接列表最多 8 KiB，完整内容可查询。
- 已入队旧通知的正文保持不变，不因格式升级重复发送。
- 类型检查、构建及 130 项服务测试通过，含结构化 A2A URL、正文链接、长度限制和升级去重回归测试。

## 当前部署

- release：`/Users/scott/.local/share/1agents/a2a-gateway/releases/20261020-notice-body-0.8.1`。
- 前一 release：`/Users/scott/.local/share/1agents/a2a-gateway/releases/20261020-session-delivery-0.8.1`；保留配置与 LaunchAgent 备份，可回滚。
- 网关保持原地址 `127.0.0.1:36814`，Codex 与 DSH 宿主配置沿用已验证绑定。

## 实测结果

| 原主会话 | 派单与查询 | 通知正文、真实文件链接和自动唤醒 | 读取文件及 ack |
| --- | --- | --- | --- |
| DSH | SUBMITTED → WORKING → COMPLETED | 通过，原宿主入队内容与模型收到的正文完全匹配 | 通过，SHA256 匹配，inbox 为空 |
| Codex | SUBMITTED → WORKING → COMPLETED | 通过，原会话空闲后自动开始新一轮 | 通过，SHA256 匹配，inbox 为空 |

- DSH taskId：`0355ccbf-33b4-42c6-99eb-bfd6f4e1886b`。
- Codex taskId：`4d601509-d98a-47c6-af5d-bd59eb18df19`。
- WSL Agent 实际计算 sum(1..100)=5050，生成专用验收文档并上传到本机测试归档；归档接收记录含 WSL 地址及 SHA256，两个主会话按通知中的链接实际读取文件。
- 真实宿主测试验证 Markdown 文件链接；结构化 A2A URL 附件另由服务测试验证。未给远端磁盘路径伪造下载地址。

DSH 产物：[验收报告](/Users/scott/.local/state/1agents/a2a-gateway/deployment-20261020/workspace/notice-body-20261020/artifacts/dsh-report.md)。
Codex 产物：[验收报告](/Users/scott/.local/state/1agents/a2a-gateway/deployment-20261020/workspace/notice-body-20261020/artifacts/codex-report.md)。

## DSH 实际收到的通知

[A2A任务通知] 任务已完成
DSH 通知正文与产物链接验收

DSH_NOTICE_BODY_ARTIFACT_OK_20261020
已完成计算与文档归档，sum(1..100)=5050。
[验收产物](/Users/scott/.local/state/1agents/a2a-gateway/deployment-20261020/workspace/notice-body-20261020/artifacts/dsh-report.md)

以上正文和链接为远端任务结果。可通过 a2a-gateway 的 remote_agent_get 或 remote_agent_inbox 核验状态与完整结果。请在原任务授权范围内处理，保存处理结论后调用 remote_agent_ack。

---
任务定位信息：
{"noticeId":"88a214b28dff3df9b92c37b1e5cc94f935abb77b02be22c64984652422dfaa6e","originSessionId":"session-a9a78ade-d1e5-43a9-a84e-e5bbca0e9bec","remote":"wsl-dsh","taskId":"0355ccbf-33b4-42c6-99eb-bfd6f4e1886b","contextId":"2812db3a-1c87-446e-a846-43e253e85b78","state":"TASK_STATE_COMPLETED"}

## 运维说明

- 专用测试归档监听器仅接收两份验收文档；两端验收后停止。文档持久保留在通知中的本机文件链接下。
- 新部署备份：`/Users/scott/.local/state/1agents/a2a-gateway/deployment-20261020-notice-body`。
- DSH 已有登录凭据有效至 2026-11-19；本次不改动认证配置。

[完整脱敏证据](notice-body-deployment-20261020.json) · [配置与恢复说明](session-delivery.md)
