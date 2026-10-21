# 工作分支合并与阶段清理

日期：2026-10-21。目标主库：`/Users/scott/Documents/01-开发项目/1agents/1agents_app/modules/1acp`。

合并前 main 为 `e9a08cba4edad2e37abc5eb74fce370e370bedb9`。旧 `services/1acp` 主线仍为 `db0ea6274a10b693eea937feef826d6391a6ba1d`；本轮以当前主库为准。

## 冲突核对及处理

| 分支 | 核对结果 | 本轮处理 |
|---|---|---|
| session-delivery | 两个独有提交；与当前 main 模拟合并无文本冲突 | 以 `0f03a17dad4eb2a1f456117019b4552206430545` 合入 main；保留原始 `58d0d35`、`d9fcbc6` 历史；归档后移除旧工作目录和本地分支 |
| erp-agent-m1-ledger | 三个独有提交；与 main 及 session-delivery 均无文本冲突，且与后者没有共同修改文件 | 保留原分支与工作目录；另在主库保存 `archive/erp-agent-m1-ledger-20261021` 分支及文件归档，不合入 main |
| erp-agent-m1-errors | 已是当前 main 的祖先，无独有提交 | 归档运行记录后移除旧工作目录和本地分支 |
| erp-agent-plugin-diagnostics | 已是当前 main 的祖先，无独有提交 | 归档旧 0.7.0 发布包、清单及工作目录内容后移除旧工作目录和本地分支 |
| official-plugin-live-validation | 已是当前 main 的祖先，无独有提交 | 核验并归档全部七份验证文件后移除旧工作目录和本地分支 |

“无文本冲突”不等于阶段账本已与统一 Job/Attempt 账本整合。`erp-agent-m1-ledger` 的 15 个文件、三次提交约 4,989 行，是独立阶段合同、状态及结果验证模块，尚未接入服务入口；应在确定阶段编排方案后设计关联与集成测试。

## 合并验证

- 完整 workspace 构建及服务类型检查通过。
- 服务测试 199/199；DSH 插件测试 148 通过、10 条需要外部源码环境而跳过。
- 产物服务、角色模型路由及本地部署工具测试 19/19。
- 测试使用独立 DSH_HOME / ACP_STATE_DIR；未更换运行中服务的入口。
- 当前项目依赖没有指向被移除工作目录的链接；删除前未发现进程以这些目录为 cwd。

## 归档与恢复依据

归档根目录：`/Users/scott/.local/share/1agents/1acp-worktree-archives/20261021-stage-cleanup-7589e285`。

五个工作目录分别保存 `.tar.gz`。归档包含源码、未跟踪的 `.agent-runs`、已有构建结果及发布包；仅排除 Git 工作目录元数据与可重新安装的 node_modules。归档后逐文件比较大小、SHA256 和符号链接目标，删除前再次核对源文件未变化。`manifest.json` 保存原目录、分支、提交、完整清单和归档摘要；`checks/` 保存合并后的验证日志，`merge-audit.json` 保存模拟合并结果。

主库保留合并前标签 `archive/main-before-session-delivery-20261021`。五个独有提交的 Git 对象另存于 `unique-commits.pack`；父历史由主库原有 `db0ea62` 基线提供。阶段账本既有原分支，也有主库归档分支，可据此重新创建 worktree。

本轮仅处理表中工作分支及本地 Git 状态，不包含远端分支删除或远端发布。旧服务主目录中其余未跟踪文件保留。
