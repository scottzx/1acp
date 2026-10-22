# A2A 临时任务人工最终确认测试报告（2026-10-22）

测试日期与以下展示时间均为 `Asia/Shanghai`。证据来自本会话保存的受理回执、完成通知后的单次 `execution_get`、人工决定历史和 `execution_ack` 回执；整理报告时未重新派单或轮询线上任务。

## 结论

**简单 README 试单通过。** 一个临时智能体读取项目 README，生成英文 `README.en.md`；协调器检查指定文件后，父任务保持等待人工确认；Scott 在集中任务工作台通过 `report-v1` 后，父任务才完成。协调器随后通知原分配会话，分配者单次核对、记录结论并确认通知。没有增加智能体验收节点。

首次架构报告试单因输出目录不在临时智能体的可写工作区而等待工具权限，随后按用户要求取消。该次记录为**已取消，未完成验收**，不计入通过结果。修复执行目录后，较小的 README 任务验证了完整链路。

## 测试合同与环境

- 输入：`examples/activepieces/piece/README.md`，仅要求读取该文件，将主要内容用英文复述；不做源码架构分析。
- 产物：协调器分配的 `report-v1/README.en.md`。
- 流程：临时执行节点 → 确定性文件检查 → 人工最终确认。只有一个执行智能体，没有模型评审者。
- 网关：本机 A2A gateway；临时宿主为本机 DSH，使用 `standard` preset。连接沿用 `legacy:ppt-beautifier` 别名，实际目标类型是通用 `agent_host`，本次没有调用 PPT 固定角色。
- 人工入口：1agents Web 集中任务工作台；审核身份 `Scott / local-owner`，决定来源为 `1agents-web`。审核不是单会话工具调用权限审批。
- 分配者派单后保存受理回执并结束本轮，由真实协调器通知唤醒；成功试单没有主动查询进度。此前对旧架构任务的状态检查由用户明确要求。

## 真实执行结果

| 时间 | 事件与结果 |
| --- | --- |
| 23:08:57.352 | 父任务受理，状态 `working / author_pending`。 |
| 23:09:31.184 | 临时执行子任务完成，尚不代表父任务完成。 |
| 23:09:33.285 | 文件检查通过，1791 字节；进入 `input_required / awaiting_human`，等待 `report-v1`。从受理到此约 36 秒。 |
| 23:10:50.135 | Scott 在工作台选择通过，意见“过”；决定绑定当前版本和文件 SHA-256。 |
| 23:10:50.208 | 审核决定已应用，父任务变为 `completed / human_approved`。从受理到完成约 1 分 53 秒，包含人工等待。 |
| 23:11:30.964 | 原分配会话收到完成通知后，单次读取回执并记录结论；无在途或未决轮次。 |
| 23:11:31.100 | `execution_ack` 返回已确认。 |

可追溯标识：

| 对象 | 标识 |
| --- | --- |
| sourceId | `4b00a5d8-3edc-4a5b-a7bf-8ae2bea967e4` |
| 父 jobId | `dd42f3f2-c736-4dba-b334-d1c14e60b113` |
| 父 attemptId | `16e2ba4b-c050-4592-9832-eef8567375a1` |
| 子 jobId | `1e52e397-9475-41ef-b8c7-a862262a0562` |
| 子 attemptId | `af211797-c644-4974-b8e3-d89ce96966a9` |
| reviewId | `3979ec81-9a3a-41c8-ac38-efab4282b241` |
| 结果版本 | `report-v1` |
| SHA-256 | `d4d0f2df3d5617bafa2c5d9f38b219293c796712b589f7ac327f504bdf1803b0` |
| noticeId | `ac65b92e045095639dc7f776811f84e7ec90b51449cc51b61d98668d138ed401` |

运行时产物位于 `$HOME/.local/share/1agents/report-review/workspace/<jobId>/<attemptId>/report-v1/README.en.md`。本报告随附[当时冻结的英文 README](test-evidence/2026-10-22/README.en.md)和[精简结构化证据](test-evidence/2026-10-22/readme-human-review.json)，文件副本与上述摘要一致，不包含完整提示词、会话原文或网关凭据。

## 首次阻塞、取消与修复

旧架构报告父任务为 `8a12255d-9026-4f20-a58a-443fde48591e`，执行轮次为 `d40838dd-a010-4c21-bc79-0350057bdc64`。临时智能体从源码项目目录启动，而报告输出在独立的 report-review 工作目录。写入越过 `workspace-write` 范围后，执行停在工具权限申请，未到文件检查或人工产物审核。没有批准扩大沙箱权限。

用户要求取消后，23:05:11.541 的级联取消回执确认父任务和临时执行子任务均已取消，`cancellation.status=completed`、无未决轮次。旧任务取消通知已于 23:09:27.930 确认；该通知与后来成功的 README 任务分别处理。

本次修复让临时执行者从固定的 `<workspaceRoot>/<jobId>/<attemptId>` 输出根目录启动，每次修订写入其下的 `report-vN`，源码目录作为只读输入在指令中明确给出。后续修订保留原执行目录和作者会话。通用指令同时改为遵循具体任务要求的语言与内容，不再强制中文架构报告。

## 实现与回归范围

- `execution_submit` 对临时 `agent_host` 增加 `input.reportReview: { fileName }`，由网关持久保存本地流程、子任务回执、文件检查和人工决定。
- 确定性检查要求指定路径为非空、有效 UTF-8 的普通 Markdown 文件，最大 256 KiB；拒绝链接文件，冻结文件字节与摘要。人工通过前再次核对产物与快照，文件变化不能沿用旧批准。
- 人工操作使用既有工作台身份、版本与摘要校验；评论不放行，要求修改会生成新报告版本并等待重新批准。代理工具不提供代替用户批准的入口。
- 父任务只在最终完成、失败或取消时通知分配者，子任务完成和等待人工不会提前发送父任务完成通知。
- 工作台展示分析、文件检查、人工确认三个节点，并以文本显示 Markdown 产物和路径。

新增 7 项报告流程测试覆盖：最终人工门禁及无提前通知、评论不放行、缺失文件、内容变化与符号链接、修订沿用原作者且旧版失效、重启及重复请求幂等、父子级联取消、英文文件名与可写目录约束。其中部分断言合并在同一测试内。

最终提交前，在主线 `e261595` 加本次补丁的隔离工作区验证：

| 验证 | 结果 |
| --- | --- |
| service：`tsc -p tsconfig.build.json` | 通过。 |
| service：`tsc -p tsconfig.json --noEmit` | 通过。 |
| service：`node --import tsx --test --test-concurrency=1 test/*.test.ts` | **295 项全部通过**，含新增 7 项报告流程测试。 |
| 通知测试独立运行：`node --import tsx --test test/session-delivery-gateway.test.ts` | 9 项全部通过。 |
| frontend：`tsc --noEmit --skipLibCheck` | 通过。 |
| 工作台预览 webpack 构建 | 本轮部署前已通过，仅有既有 Sass 弃用警告。 |
| 补丁与证据 | `git diff --check` 通过；保存的 README 副本 SHA-256 与实际审核摘要一致。 |

首次以 `--test-concurrency=4` 运行服务全量回归时，294 项通过、1 项失败：既有模拟 Codex 队列测试在 2 秒启动限时内未写出调用记录，读取文件返回 `ENOENT`。该文件独立复测及全量串行回归均通过，未修改该测试或增加其时限。所有自动回归使用本地模拟后端，未创建新的真实模型任务。

## 复现方式

1. 配置网关 `reportReview.workspaceRoot`、只读源项目白名单 `allowedProjectRoots`、共享文件系统宿主白名单 `allowedRemotes`，以及工作台审核身份。临时宿主必须能读取源 README，并写入分配的输出目录；配置与凭据保留在受保护的本机部署目录。
2. 向登记的 `agent_host` 目标调用 `execution_submit`，提供源项目 `cwd`、`standard` preset、简短英文 README 生成指令及 `reportReview: { "fileName": "README.en.md" }`。保存受理回执后结束本轮，不循环查询或自动安排进度跟踪。
3. 人工在集中工作台查看产物并选择通过。分配者只在协调器真实通知到达后单次 `execution_get`、记录结论，再 `execution_ack`。

## 部署与验证边界

本次真实试单使用私有本机部署 `a2a-gateway/releases/20261022-readme-review-01/runtime`，工作台预览使用 `acp-workbench/releases/20261022-report-review-01`；未发布 npm。最终运行包基于当时活动版本保留其他已部署能力，仅修复报告作者工作目录、任务标题和通用指令。本报告不将其他并行会话的修改归入本次提交。

本次证明的是单机共享文件系统内，单个 Markdown 产物的确定性检查、人工最终确认与通知闭环。机器节点不判断英文内容质量；最终内容判断来自人工。真实试单没有额外演练返工、重启或异常文件，这些由上述自动测试覆盖；不据此宣称任意多阶段 DAG 或跨设备文件传输已验收。
