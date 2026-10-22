# 通用 A2A 结果版本与验收登记补齐

2026-10-22 已在本机网关上线，公众号“导论”既有本地验收已补登统一账本。

## 变更

- 普通 resident_agent / agent_host 的完成结果自动获得轮次内 `resultRevision` 与 `resultDigest`。自动版本为 `result-1`、`result-2` 等，完整定位仍使用 `jobId/attemptId/resultRevision/resultDigest`。
- digest 为规范化结果 JSON 的 SHA256，覆盖正文、结构化回执引用、链接、宿主返回的文件大小与 SHA256 清单 `resultArtifacts`。不包含查询时间；未返回文件清单时，不能据此声称已核验文件字节。
- 重复读取、重启保持版本稳定。结果变化追加 `resultHistory` 快照；历史 attempt 保留各自历史，已发布的版本不能覆盖或重新选用。事件携带新版本、旧版本和 digest。
- 验收只匹配当前已完成且结果可用的轮次及版本。旧结论保留在 `acceptanceHistory`，不自动套用于返工或新结果。领域流程等待人工时的临时版本不提前进入完成版本历史。
- 缺版本的旧 A2A 完成结果从缓存回执补齐，不重跑、不新增该任务通知、不自动写业务接受。工作台对历史版本沿用当前结果的展示过滤规则。

实现位于 `packages/service/src/execution/ledger.ts`、`src/a2a/gateway.ts` 与 `src/execution/workbench.ts`；源码 API 使用说明及本机已安装技能引用已同步。

## 导论补登记

| 字段 | 值 |
| --- | --- |
| sourceId | `4b00a5d8-3edc-4a5b-a7bf-8ae2bea967e4` |
| jobId | `acde3216-f179-4413-bdde-680bda413472` |
| attemptId | `e2473381-5c67-4f0d-93c6-53572ce96ebd` |
| taskId | `2e64ed1e-5b51-43bc-890b-22fe7128250f` |
| resultRevision | `result-1` |
| resultDigest | `880e4ee90ddbb6bc654d004034145a1ef960728d04384f92964b9739aaee8416` |
| reviewStatus | `accepted` |
| recordedAt | `2026-10-22T14:54:58.989Z` |

当前回执的任务身份、正文、链接及 22 份宿主文件大小/SHA256 记录与原保存回执逐项相同。补登记沿用 `handling.json` 中 `2026-10-22T14:15:58.047Z` 已存在的 `local-production-delivery` 结论；没有重新制作或重复检查产物文件。

原 `completion-receipt.json` 保留；新增 `completion-receipt.versioned.json` 与 `ledger-review-receipt.json`，并更新 `handling.json` 和角色首单记录。文件均位于：

`/Users/scott/Documents/01-开发项目/1agents/services/老板IP/工作台/.local/wechat-series-editor/jobs/intro-20261022/`

公众号编辑器粘贴、平台预览与发布仍不在本次验收范围。

## 部署与验证

最终运行版本：`0.8.3-result-versions.overlay.14b2fc924b59`。

当前线上版本比主工作区多出报告人工验收能力，因此以原 `20261022-report-review-01/runtime` 为基础，在隔离源代码副本中合并并编译补丁，只替换网关、账本、工作台的 6 个 JS/类型文件。其余包文件逐项核对不变，报告流程模块保留。没有重启 DSH 执行宿主。

激活后 `/health` 为 `ok`；原 49 个 Job、61 个 attempt 及已有通知编号保留，42 个历史完成结果补齐版本。首次切换遇到 launchctl 卸载后的短暂注册错误，已回退并恢复健康；补上有界重试后成功激活。两份原状态备份均保留。

验证记录：

- 主工作区服务测试分组运行：278 + 9 项通过。单次全量运行的原有合成 Codex 队列测试曾因 2 秒启动截止时间失败；单独文件组通过，未修改该测试或交付策略。
- 随后新增的领域临时版本兼容回归包含在隔离合并版本的 69 项定向回归中，全部通过；报告流程另跑 7 项全部通过，包括作者执行中重启网关、保持同一子任务并最终人工批准。
- DSH 在独立 `DSH_HOME` 下回归：158 项通过，10 项按原条件跳过。默认目录首次运行与常驻宿主诊断存储锁冲突，未修改或关闭常驻宿主来迁就测试。
- 完整工作区构建、服务类型检查及隔离合并版本编译通过；真实导论缓存的离线升级演练通过，随后在线读取与正式登记、落盘核对通过。

冻结源码、包文件清单、增量补丁、测试日志、升级演练、激活回执、状态备份及业务登记回执保存于：

`/Users/scott/.local/share/1agents/a2a-gateway/releases/20261022-result-versions-03/`

此前 `result-versions-01/02` 为未激活候选；最终部署使用 `03`。本次未发布 npm。
