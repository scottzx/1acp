# 项目 Agent 数据目录迁移

日期：2026-10-23，时区 Asia/Shanghai。将当前项目所属角色数据统一到根 `.1agents/`，不重新制作 PPT，不派模型任务。

## 当前布局

- `.1agents/roles/ppt-beautifier/`：可提交的 profile、ROLE 说明。
- `.1agents/config/role-skills.example.json`：可提交的配置示例；本机配置使用忽略提交的 `role-skills.local.json`。
- `.1agents/cache/roles/`：完整技能包、素材、快照、任务锁和发布投影。
- `.1agents/skills/ppt/`：独立维护的完整技能源。
- `.1agents/runtime/ppt-beautifier/`：角色 bundle、宿主挂载配置、workspace、产物和角色状态。
- `.1agents/state/a2a-gateway/`：目标登记、任务账本及通知。

共享宿主的安装、登录、全局模型与原生会话库存储继续由宿主管理；项目保存会话关联和任务数据。本机 launchd 打开 Documents 中 stdout/stderr 被系统拒绝，因此服务启动日志放在 `~/Library/Logs/1agents/`，目录 0700、文件 0600。任务执行 PWD 和业务产物仍在项目内。

## 兼容与迁移

实际目录已物理迁入 `.1agents/`。原 `roles/`、`.cache/roles` 和用户目录中的旧角色、技能源、网关状态地址保留兼容入口。已登记目标与历史上下文的 cwd 字符串保持不变，真实路径指向新 workspace；新增角色使用新目录。

旧锁只在缓存根/profile 的真实路径与当前可信实体完全一致时接受，缓存内部目录/文件的符号链接及越界仍拒绝。旧锁、技能快照、冻结合同和历史回执均未为改路径而重写；新任务使用新 profile 和缓存路径。

迁移前确认 DSH 没有运行中会话，再停止相关服务、搬移数据并保留别名、更新配置与完整运行包。宿主 stateDirectory 使用新真实目录，产物服务重新加载新真实根。迁移脚本首次遇旧通知包装字段差异，在搬移前恢复服务；修正后完成搬移。launchd 日志路径的系统限制已按上文处理。

## 实际验证

- 服务回归 299 项通过；DSH 独立目录回归 158 项通过、10 项跳过。首次非隔离运行遇诊断状态租约冲突，未记为通过。
- 发布器、更新事务、部署辅助测试共 32 项通过；新增根别名迁移、旧锁离线复用、保存上下文摘要保持和错误实体拒绝回归。
- 6 份既有任务锁在禁用 fetch 后使用新配置全部通过，锁文件原字节不变。
- 207 个原公开产物磁盘 SHA256 均保持不变；抽查 4 个历史 PPT/预览 URL，GET 全部 200 且字节摘要与搬移前一致。
- 原网关 sourceId、51 个任务、63 个执行轮次、55 条 A2A 通知及 9 条交付通知的身份集合完全一致。
- 网关、产物服务健康检查均 200；DSH PPT preset 正常、A2A agent-card 可用。
- 使用 `.1agents/config/role-skills.local.json` 真实执行统一更新成功，来源仍为 `skills-1acp-ppt`，新预热锁使用新目录。模型派单数为 0。

代码版本：`5f4dcd7`。完整包与受保护备份在本机 release `~/.local/share/1agents/a2a-gateway/releases/20261023-dot1agents-01/`；具体构建日志、目录映射、旧锁摘要、产物摘要和迁移回执在其 `evidence/`。项目侧回执同步到 `.1agents/state/migrations/20261023-directory/`，运行数据和私密配置不提交 Git。
