# 阶段进度、异常产物与父子任务关闭验收

日期：2026-10-21（Asia/Shanghai）。代码提交：`b7b0c7a9e355b9cab8e7169f3150d9ddcb8d0456`。

## 已实现并部署

- `execution_get.deliveryProgress` 提供阶段状态、已完成/未完成阶段、保留版本和产物链接，区分制作端文件校验、父流程机器校验和独立验收。阶段完成只记录进度，不创建主会话通知或唤醒。
- 失败、需输入、取消通知附带已有产物，未通过最终验收时标为“已有 PPT（未完成最终验收）”。已投递或 ack 的旧通知保持不变，历史产物可通过查询读取。
- `execution_cancel` 支持 PPT 父任务关闭和默认级联；通用任务显式 `cascade:true` 可取消后代。关闭意图先持久化，阻止后续派单/继续，等待在途受理返回再取消真实后端执行。已完成结果保留，未知受理或取消未确认保留 blocked，重启继续核对。
- `cancellation` 返回持久关闭回执及逐轮次状态；PPT 父任务确认子执行均终结后才 canceled。重复关闭幂等，通知 ack 与业务接受仍分别记录。

## 源码与部署隔离

本轮主库同时存在其他工作的 `packages/dsh-plugin/src/transcript-view.js`、`packages/dsh-plugin/test/client.test.mjs` 未提交修改，均未纳入本轮提交或部署。构建使用代码提交的独立干净 checkout、独立离线依赖和已安装的 DSH SDK；原工作区依赖链接已恢复并核验。发布清单记录该源码 clean、HEAD 为上述代码提交。

网关和 DSH 使用同一冻结本地包 `0.8.1-local.c5544d228830.c6b861e09287`，公共版本仍为 0.8.1，未发布 npm。宿主确认没有活动会话后激活，保留私密配置、原生 peer 依赖、账本、产物和先前修复的稳定 Codex queue 工作目录。

运行目录：`/Users/scott/.local/share/1agents/a2a-gateway/releases/20261021-progress-cancel-01/runtime`。PPT 交付目标的 cancel 能力已通过目标 API 更新为 true。

## 验证结果

- 隔离源码构建通过，服务类型检查通过；服务测试 **207/207**；DSH 测试 **148 通过、10 跳过**；部署、产物及模型路由辅助测试 **19/19**。跳过项需要额外外部源码环境。
- 新测试覆盖异常通知的已有产物与验收边界、修订保留前版、关闭时在途请求、父/子/孙级联、权限范围、兄弟隔离、已完成结果保留、未知受理、重复关闭、重启及关闭后禁止新派单。
- 冻结安装包经真实 loopback HTTP/A2A 和受控非模型后端验证：父、子、孙关闭成功，后端 abort 信号触发，关闭后派单拒绝，重启不重派。阶段进度查询没有产生根会话通知；受控异常通知带 8 个已有产物链接，并标明不是最终交付。
- 当前生产网关正式关闭原暂停父任务 `1bbda64b-5590-4eab-9bed-c5af725558c6`：父状态 canceled，关闭回执 completed，原子任务保持 canceled；重复关闭幂等。该任务的子执行在此前用户停止测试中已经取消，本次生产关闭没有重新启动它。
- 当前网关查询原失败任务 `234da254-7b9c-4c10-b020-ed084841382e`：已完成脚本、制作和机器校验，未完成独立验收；8 个已有产物全部 HTTP GET 200，字节、size 和 SHA256 与原校验记录一致。旧父任务 failed 终态保留，已有稿没有被接受为最终稿。
- 当前网关实际重启后再次核对：已关闭父任务仍为 canceled，关闭回执 completed；经过后台核对周期没有新任务、执行轮次或活动执行。取消通知已保存处理结论并 ack。

本轮没有新增生产任务或执行轮次，没有模型调用或 PPT 制作/渲染。活动子孙任务的级联测试使用隔离的受控 A2A 后端；生产网关关闭的是之前已暂停且子任务已取消的真实任务，二者不混同。

## 已知验证边界

本机 DreamMate 发现入口 `127.0.0.1:36908` 的 health 和服务发现检查仍超时，此问题在本轮前已出现。本轮验证使用当前 A2A 网关 `127.0.0.1:36814` 的真实 HTTP 方法，及 DSH `3080` Agent Card，不据此声称 DreamMate 发现层已经恢复。

完整发布包、源码/依赖归档、安装与回滚回执、测试日志和生产核验记录位于：`/Users/scott/.local/share/1agents/a2a-gateway/releases/20261021-progress-cancel-01/evidence`。关键记录为 `installed-http-smoke.json`、`production-verification.json`、`production-restart-verification.json` 和 `deployment.json`。
