# 主会话提交后结束、通知后处理

日期：2026-10-22（Asia/Shanghai）。实现提交：`8ab8aa0`。

## 已固化的边界

更新包内 acp-service 调用技能和流程，以及本机 resident-agent 1.0.2、staged-a2a-workflow 1.0.1：开发、部署、预检及回归在正式调用前完成。派单响应落盘后必须立即结束本轮；禁止主会话主动轮询 get/list/inbox、等待任务完成、读子会话/进程日志或重复下载/hash/事实/图像验收。用户明确要求的单次状态查询、取消与专项排障独立处理，不扩展为监控循环。

限定入口位于 `packages/service/skills/acp-service/scripts/a2a-caller.py`。四个操作为 dispatch → 真实通知后 inspect → record → ack。dispatch 只有一次提交，受理未知也保存记录并结束，不自动重派。inspect 必须在本主会话真实 user 消息中找到与派单绑定的通知，才读取一次任务回执及本轮新验收报告；只核对宿主身份与报告/版本绑定，不打开原 PPT/PNG 或读取子日志。结论先保存，ack 同一次操作统计全部原生主会话工具调用并保存 step-count.json，然后立即答复。

通用查询 API 仍服务于显式单次状态请求和排障；这是技能纪律与受限调用入口的约束，不声称已用全局权限禁止 get。后台网关状态核对不受影响。

## 开发部署验证

- 7 项 Python 行为测试通过：提交不查询、拒绝通知前读取、不盲重发、回执/报告绑定、先结论后 ack、四步但未结束轮次不得达标、额外轮询即使总计五步也不合格。
- 完整构建及 11 项包/部署测试通过；三个调用技能通过 quick_validate。
- 从干净 checkout 冻结完整安装包，releaseId=`0.8.3-local.322d530fd770.d721ab8b7405`、source dirty=false；网关和 DSH 激活同一包，并完整安装本机 ACP 调用技能。
- 本机 resident/staged 技能完整快照及文件哈希另保存为 local-calling-skills.tar.gz / local-skill-policy-manifest.json，原版本有备份。未跟踪的其他设计文档未纳入本轮提交。
- DSH 首次启动发生 ACP 子服务 15 秒启动超时。独立服务启动探测 837ms 通过，确认宿主空闲后受控重启，5081ms 内就绪。排障期间没有派单；网关在 DSH 就绪后启动，目标预检 ready。

部署证据：`/Users/scott/.local/share/1agents/a2a-gateway/releases/20261022-strict-caller-01/evidence`。

## 独立只验收实测安排

新建独立 Codex 验收任务，固定已登记目标 ppt-codex-backup / oneagents-acp-codex；不恢复原 input_required 父任务，不触碰已取消第二轮。复用原 revision-2 PPT、7 张预览、冻结脚本和 19 文件原源码快照；不给新验证器先前结论，也不让其读取旧报告或其他会话。只允许核验并在新临时目录写报告，不改稿、不重导出、不制作。

新报告由执行宿主校验文件并提供真实身份/摘要。验收任务执行完成与 PPT 质量通过分别报告；主会话不会把 changes_requested 当作业务接受。

- 合同：`/tmp/1agents-strict-review-20261022-001/contract.json`。
- 调用状态：`/Users/scott/.local/state/1agents/a2a-caller/strict-review-20261022-001/run.json`。
- 新报告：`/tmp/1agents-strict-review-20261022-001/review-report.json`。
- 开发部署计步：调用状态同目录的 development-cost.json，在正式派单前冻结。
- 正式调用计步：同目录 step-count.json，由最终 ack 操作自动写入，不再另开审计调用。

本文提交时正式任务尚未派发。预期四次调用是待验证预算，不是已通过数据。实际统计从派单原生 callId 开始到通知处理 ack（含本身），不重置、不删除额外调用；同时必须证明派单后本轮已结束、真实通知到达且中间没有主会话额外操作。后台调用、模型工作和开发成本不能冒充主会话步骤。
