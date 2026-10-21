# 工作分支合并与阶段清理

日期：2026-10-21。目标主库：`/Users/scott/Documents/01-开发项目/1agents/1agents_app/modules/1acp`。

合并前 main 为 `e9a08cba4edad2e37abc5eb74fce370e370bedb9`。旧 `services/1acp` 主线仍为 `db0ea6274a10b693eea937feef826d6391a6ba1d`；本轮以当前主库为准。

## 冲突核对及处理

| 分支 | 核对结果 | 本轮处理 |
|---|---|---|
| session-delivery | 两个独有提交；与当前 main 模拟合并无文本冲突 | 以 `0f03a17dad4eb2a1f456117019b4552206430545` 合入 main；保留原始 `58d0d35`、`d9fcbc6` 历史；归档后移除旧工作目录和本地分支 |
| erp-agent-m1-ledger | 三个独有提交；与 main 及 session-delivery 均无文本冲突，且与后者没有共同修改文件 | 经后续模型对照，用户决定不合并、直接删除；核验已有文件归档后移除工作目录、旧库 `codex/erp-agent-m1-ledger` 及主库 `archive/erp-agent-m1-ledger-20261021` 本地分支 |
| erp-agent-m1-errors | 已是当前 main 的祖先，无独有提交 | 归档运行记录后移除旧工作目录和本地分支 |
| erp-agent-plugin-diagnostics | 已是当前 main 的祖先，无独有提交 | 归档旧 0.7.0 发布包、清单及工作目录内容后移除旧工作目录和本地分支 |
| official-plugin-live-validation | 已是当前 main 的祖先，无独有提交 | 核验并归档全部七份验证文件后移除旧工作目录和本地分支 |

“无文本冲突”不等于阶段账本已与统一 Job/Attempt 账本整合。`erp-agent-m1-ledger` 的 15 个文件、三次提交约 4,989 行，是独立阶段合同、状态及结果验证模块，尚未接入服务入口。后续对照确认其 Attempt/StageRun 语义、强制 ERP 回读门槛与当前执行账本不同；按用户决定淘汰，不合入或提炼代码，继续以当前 Job/Attempt 为唯一执行账本。

## 合并验证

- 完整 workspace 构建及服务类型检查通过。
- 服务测试 199/199；DSH 插件测试 148 通过、10 条需要外部源码环境而跳过。
- 产物服务、角色模型路由及本地部署工具测试 19/19。
- 测试使用独立 DSH_HOME / ACP_STATE_DIR；未更换运行中服务的入口。
- 当前项目依赖没有指向被移除工作目录的链接；删除前未发现进程以这些目录为 cwd。

## 归档与恢复依据

归档根目录：`/Users/scott/.local/share/1agents/1acp-worktree-archives/20261021-stage-cleanup-7589e285`。

五个工作目录分别保存 `.tar.gz`。归档包含源码、未跟踪的 `.agent-runs`、已有构建结果及发布包；仅排除 Git 工作目录元数据与可重新安装的 node_modules。归档后逐文件比较大小、SHA256 和符号链接目标，删除前再次核对源文件未变化。`manifest.json` 保存原目录、分支、提交、完整清单和归档摘要；`checks/` 保存合并后的验证日志，`merge-audit.json` 保存模拟合并结果。

主库保留合并前标签 `archive/main-before-session-delivery-20261021`。五个独有提交的 Git 对象另存于 `unique-commits.pack`；父历史由主库原有 `db0ea62` 基线提供。阶段账本的工作目录及两处本地分支均已删除，历史文件和 Git 对象归档保留，未合入 main。

阶段账本删除前重新核验 1,063 个文件和符号链接（含 `.agent-runs`）与归档清单一致；`erp-agent-m1-ledger.tar.gz` SHA256 为 `26db88ed6bf6cb6ddc4249c3e2f1a3cb640e9498c968c03b7f65656c963c1e9d`。删除后确认目录不存在，两处本地分支均不存在。本次后续清理仅更新记录，不修改或重新部署运行服务。

本轮仅处理表中工作分支及本地 Git 状态，不包含远端分支删除或远端发布。旧服务主目录中其余未跟踪文件保留。
