# 只重试验收：恢复与部署验收

日期：2026-10-22（Asia/Shanghai）。实现提交：`3b4c354`；交付前漂移保护：`d8bab5a`。

## 恢复合同

`execution_continue` 支持 `input: {recoveryMode:"review_only",reviewTargetId,sourceSnapshotDirectory?}`。同一父 Job 创建新的执行轮次与独立验收子 Job；冻结业务输入、版本、脚本、来源清单和成稿摘要，保留原失败轮次及全部子执行。调用方只选择已登记的验收目标；本模式不自动切换目标，不进入制作、修订或重导出。新报告、预检和交付回执以新父 attemptId 单独命名。

恢复前拒绝已关闭、已取消、非独立验收失败停点，以及在途或受理未知的后代。派单前重新校验来源与全部本地/公开/HTTP 字节，交付前再次核对；失败或阻断问题保留已有产物并返回。新的验收执行重试计数从零开始，仍受原次数上限约束；本轮时长从显式恢复开始，历史累计耗时和质量修订预算保留。

项目已变化时允许显式指定原源码快照；系统逐文件按冻结来源清单核验 SHA256，并保留清单的原项目位置与 Git 基线。不能还原原字节时停止，不以当前源码替代历史事实。

## 构建、测试与部署

- 完整构建、服务类型检查通过；服务 **212/212**；DSH **158 通过、10 跳过**；部署/产物辅助测试 **11/11**、模型路由 **4/4**。跳过项需要额外外部源码环境。交付前保护补测时，全并发运行的一项既有 synthetic Codex queue 测试因子进程超时未生成临时文件而失败；限制测试文件并发为 2 后完整服务测试 212/212 通过，未修改该既有测试。
- 新测试覆盖新旧父轮次隔离、独立验收子任务、仅验收不返工、来源快照、脚本/产物漂移、取消与未知受理拦截、幂等重放和网关重启。
- 从实现提交的干净独立 checkout 构建，使用既有部署工具冻结完整源码、安装包及依赖。初始发布 ID：`0.8.3-local.b8fb493a96cc.cc20b7094d10`；包含交付前漂移保护的最终发布 ID：`0.8.3-local.0ecf48f1e5b5.7de9255f7c33`，source dirty=false、HEAD=`d8bab5a`。未纳入工作区其他未跟踪文档，未发布 npm。
- 共享 DSH 确认没有活动会话后，网关和 DSH 激活相同完整安装包，保留原配置、模型设置、账本、通知与产物。
- 首次网关启动早于 DSH 就绪，连接探测记录失败且提交被拒绝，未创建新轮次。DSH 就绪后仅重启网关清除该探测缓存，两个目标只读预检均 ready，再使用同一稳定请求编号受理。

完整证据：`/Users/scott/.local/share/1agents/a2a-gateway/releases/20261022-review-only-02/evidence`（包含初始发布与恢复受理证据，原发布目录仍保留）。

## DreamMate Node 实际恢复

- 原父 Job：`234da254-7b9c-4c10-b020-ed084841382e`；原失败 Attempt：`15c42d94-c5d4-475e-98fc-ffebc47eca65`。
- 新父 Attempt：`e5e28344-71c6-40a0-b906-4417cc03a82c`；新验收子 Job：`a791b11d-aa65-41a7-8e43-bf477ce17201`，Attempt：`3031981f-bd2b-4b73-a3b8-174f3d8c91a6`。
- 新验收会话：`session-e677d86d-f506-44db-8ecd-6600f400abde`；目标 `ppt-codex-backup`，固定预设 `oneagents-acp-codex`。DSH 原生会话投影实测 lastUsed/next 均为 provider=`1agents-acp`、model=`codex`，与原制作会话不同。
- 使用原 `revision-2`，PPT SHA256 为 `89fc6eaf1c3c657aafcdc87febc9c27000ad9b78500ff0a053eeb7ddfc0fb0c2`，清单摘要为 `62b7483312ed1b848c6e9df0d76dc79e3938b16caddea8a40682223cf78c2f13`。恢复提交后实测 8 个 URL 全部 200，字节/size/hash 与原记录一致；原 run JSON 完全未改变。
- 原项目已更新，按原 Git 提交还原目录，再覆盖来源清单记录的工作树文件；19 个引用文件全部匹配冻结 SHA256，其中 5 个从原提交恢复。快照只读，当前项目未修改，原脚本和清单未覆盖。
- 稳定请求重放只返回同一新轮次，两次父 Attempt 总数保持 2。已取消的第二轮父 Job `1bbda64b-5590-4eab-9bed-c5af725558c6` 保持 canceled、关闭回执 completed，恢复请求被拒绝且没有新增 Attempt。
- 验收子任务已受理且无待提交操作时，仅将网关切至最终发布并重启；DSH 制作者/验收宿主未中断。新网关恢复相同父 Attempt、验收子 Job/Attempt 和会话，没有再次派单。证据见 `inflight-gateway-update.json` 与 `inflight-gateway-restart-result.json`。

## 实际验收结论与用户决定

独立 Codex 子任务执行 completed，报告 `verdict=changes_requested`、`factsChecked=true`、`allSlidesViewed=true`。它实际使用 `view_image(detail=original)` 查看总览与六张原图（工具在本环境叫 view_image），另查看两张模板参考。来源清单、PPT 原生文字/备注、结构与字节均有证据。父流程在最终发布版本上按只验收合同进入 **input_required**，没有把子任务完成解释为父任务验收通过。

核对原始源码后确认两处阻断事实问题：

1. 第 3 页“连续 5 次失败逐出”没有限定对象。原快照 `src/registry.ts:263–285` 跳过托管 MCP、无端口 CLI 不发 HTTP 探针；只有无 command 且 execution 非 cli/hybrid 的服务会被驱逐，其余保留元数据。
2. 第 4 页“缺失或失败 → semantic_status=no_provider”概括错误。原快照 `src/tool-search.ts:380–423` 中，没有发现就绪候选才是 no_provider；尝试失败或预算耗尽且备用未成功为 unavailable。

用户明确选择 **“保持只验收，保留现稿和问题报告”**。因此没有改稿、重导出或启动制作；新增加的子 Job 恰好 1 个、purpose=independent_review，制作子任务数量与原记录完全一致。没有创建最终交付回执，没有调用只允许 completed 父轮次的 `execution_review` 冒记业务接受。问题记录在独立验收报告、父运行状态和 `processing-conclusion.json`；原失败 run 逐字段保持相同，8 个原产物再次 GET 全部 200、字节与原 SHA256/size 完全一致。

现稿（**未通过独立验收，不标为最终稿**）：

- PPT：<http://100.88.227.56:36818/artifacts/234da254-7b9c-4c10-b020-ed084841382e/revision-2/project-overview.pptx>
- 预览：<http://100.88.227.56:36818/artifacts/234da254-7b9c-4c10-b020-ed084841382e/revision-2/preview.png>
- 原报告：`/tmp/1agents-ppt-delivery/234da254-7b9c-4c10-b020-ed084841382e/15c42d94-c5d4-475e-98fc-ffebc47eca65/revision-2/independent-review.e5e28344-71c6-40a0-b906-4417cc03a82c.json`，另复制到最终发布 evidence/independent-review.json。

异常通知 `530aeac204219badf0cb2e68146527e199336f7042ce1b29b8532785d271be2c` 包含问题和 8 个已有产物链接。原 Codex 会话队列受理 accepted、投递次数 1，messageId 固定，hostReceiptId=`01a1628a-514b-7c61-b974-7aa477620b4e`。保存处理结论后调用 execution_ack，inbox 已无该 notice。ack 只代表通知已处理。当前根轮次尚在运行，本轮未观察到该 notice 在原生会话开启后续新轮次，故只证明队列受理，不声称已完成本次自动唤醒验收。

最终 DSH 宿主在全部会话空闲后切换至同一最终完整发布包并启动，验收会话未被中断；只读目标探测 ready。取消的第二轮保持原 canceled 和 completed 关闭回执，未新增轮次。

本轮是开发部署与显式故障恢复，不作为正常全链主会话 3—5 次工具调用的基准测试。
