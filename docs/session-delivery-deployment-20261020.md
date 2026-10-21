# A2A 宿主投递部署验收 · 2026-10-20

Codex 与 DSH 的真实派单、查询、自动通知、原会话继续执行和 ack 均通过。

## 运行部署

- 网关 release：`/Users/scott/.local/share/1agents/a2a-gateway/releases/20261020-session-delivery-0.8.1`
- 网关：本机 `127.0.0.1:36814`；DreamMate 已重新发现 11 个方法，健康状态正常。
- Codex 宿主：`codex-local`，原生 `/opt/homebrew/bin/codex queue`，绑定当前主会话。
- DSH 宿主：`dsh-local`，本机 `127.0.0.1:3080`，Web Remote `mode: queue`。
- 网关与 DSH Web 均由 LaunchAgent 管理；原始 4 项历史任务保留，旧 release 可回滚。
- WSL remote 已由 Windows 转发地址修正为 Agent Card 公布的 `http://100.75.225.56:3088`；origin 校验保留。

## 真实测试

| 主会话宿主 | 派单与状态查询 | 自动唤醒并读取结果 | 业务 ack |
| --- | --- | --- | --- |
| DSH | SUBMITTED → WORKING → COMPLETED | 通过，原会话空闲后开始新一轮 | 通过，inbox 为空 |
| Codex | SUBMITTED → WORKING → COMPLETED | 通过，当前主会话自动开始新一轮 | 通过，inbox 为空 |

- DSH 原会话：`session-a9a78ade-d1e5-43a9-a84e-e5bbca0e9bec`；任务：`20877e6c-fb46-42e2-9733-9dd7515be014`。
- Codex 原会话：`01a1573e-be28-70b3-8cde-13d3470f4f74`；任务：`048df8ef-421f-4f19-83f6-fa4e9c1b21ca`。
- 测试任务仅执行延迟与标记输出；未更改业务文件。
- DSH 证据来自持久 turn 日志、模型实际工具调用、远端结果、receipt 与 ack；模型入队与业务完成分别核验。
- DSH Web 受管理重启后，既有登录凭据仍有效；重启后的队列消息已单独验证。
- 源码类型检查、构建和 125 项服务测试通过。

## 部署注意事项与恢复

- 初次实测暴露旧 remote 地址与 Card 不一致，修正地址后重跑；首次失败没有创建任务。中止的诊断仅涉及新建 DSH 测试会话。
- DSH 登录 Cookie 由真实启动入口签发，仅保存于权限 600 的配置，未写入本报告。当前有效期至 2026-11-19 13:22（上海），到期需通过宿主登录流程续期。
- `accepted` 仅表示宿主入队；本验收继续核对真实模型执行与 ack。`unknown` 不自动重发。
- 受保护备份和恢复元数据：`/Users/scott/.local/state/1agents/a2a-gateway/deployment-20261020`。回滚需停网关、恢复原配置和 LaunchAgent、恢复 current 指向旧 release，再启动；保留 ledger 与 session-delivery.json，不删除通知证据。
- 旧配置中的 Windows 转发地址仍存在 Card origin 不一致问题；正常部署应保留本次确认的 WSL 直连地址。

完整脱敏证据：[JSON 验收记录](session-delivery-deployment-20261020.json)。
配置与恢复契约：[使用说明](session-delivery.md)。
