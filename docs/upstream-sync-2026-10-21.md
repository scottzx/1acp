# acpx 上游同步（2026-10-21）

- 本仓库基线：`79b7063`（`origin/main`）。消费者子模块此前固定在 `7cb60d2`，先快进到该基线。
- 已导入的上游基线：`969972c`。上次同步提交 `c4720e0` 只有一个父提交，但已导入 `bfd7c92..969972c` 的 228 个提交。
- 本次上游：`afc076b`（acpx 0.20.0），新增 `969972c..afc076b` 的 30 个提交。

本次使用 `git merge-tree --write-tree --merge-base=969972c -Xsubtree=packages/runtime HEAD upstream/main` 生成三方合并树，保留本地包身份及扩展。最终合并提交同时以本仓库基线和 `afc076b` 为父提交，补全上游 ancestry；后续同步可直接按 `packages/runtime` 的 subtree 映射合并，不应再以 `bfd7c92` 重复导入。

## 工作区适配

- 保留 runtime 的 `@scottzx/1acp` 包名、独立版本、双 CLI、导出及私有状态；此次不发布包。
- 保留 Grok 扩展、turn journal、会话收养、本机适配器发现和 service/DSH 的最终答案、取消及诊断语义。
- 合入 Octomind、精确权限选项、会话启动失败清理、历史保留和输出健壮性修复。
- 将上游 lockfile 的 runtime importer 和依赖快照合入根 lockfile，并同步 service 内嵌 runtime 的依赖。保留 service/DSH 自身的 SDK 1.4 与 runtime SDK 的别名隔离。
- 将上游安全 overrides 应用于根 `pnpm-workspace.yaml`，继续只使用根工作区配置及 lockfile。
- 按上游迁出 autoreview 实现和实现测试，移除根 CI 对已删除 Python 测试文件的引用，使用共享 autoreview。实际文档部署继续使用根 `.github/workflows/pages.yml`。

## 验证范围

运行 runtime 的 `check`、`check:docs`，根构建和发布辅助脚本测试，以及 service/DSH 测试。`pnpm install` 后重新链接本地 DSH 类型，再验证内嵌产物。独立审查重点检查 runtime 清理与失败重试和本地扩展的交互。
