# 常驻角色、网络技能与本机版本缓存

角色定义与技能独立维护。`ppt-beautifier/profile.json` 声明所需技能的名称、来源、网络入口和角色说明；领域方法、脚本、模板与素材由 Skill Manager 发布。普通派单仍立即交接，技能解析在执行宿主后台完成，不增加主会话轮询或验收步骤。

创建角色、调用固定角色和派发临时任务的入口与参数见随包 [acp-service 技能](../packages/service/skills/acp-service/SKILL.md)及其 [API 路由](../packages/service/skills/acp-service/references/roles-and-tasks.md)。`resident-agent` 技能负责角色创建/维护；目标登记 API 不代替完整部署。

## 目录

```text
1acp/
  roles/ppt-beautifier/      # Git：角色说明、技能引用和版本策略
  roles/local-update.json   # 本机更新配置，忽略提交；见 example
  .cache/roles/             # 本机缓存，忽略提交
    catalog/ppt/            # 发布给 Skill Manager 的轻量投影
    skills/<identity>/<revision>/  # 提供方原始完整包 + 校验回执
    assets/<sha256>/blob    # 模板和图片等独立资产
    roles/<role>/<digest>/ # profile、角色说明和全部技能/资产的可用快照
    locks/                 # 任务锁、更新预热锁；已有锁不覆盖
    current/               # 最近一次成功更新的缓存入口，不能替换任务锁
    updates/               # 成功或失败更新回执
```

当前独立维护的完整技能源位于 `~/.local/share/1agents/skill-library/ppt`；这是从旧角色目录迁移出的初始版本，以后统一在此维护。旧 `ppt-beautifier/skills` 仅保留作历史备份。发布投影和运行快照都是可校验缓存，不能把修改缓存作为维护技能的方式。缓存丢失可重新获取当前版本；历史版本恢复依赖保留的任务锁、技能包和资产，不自动删除这些版本。

## 统一更新

根据 `local-update.example.json` 建立本机 `roles/local-update.json`。在独立开发/部署阶段完成构建，再执行：

```sh
pnpm build
node scripts/update-role-skills.mjs --config roles/local-update.json
```

该入口发布当前技能源、注册或刷新能力网络来源、下载验证并预热新角色版本，最后写成功回执与 current 入口。它不调用模型、不派任务、不修改旧任务锁。更新失败回滚本次发布投影并保留失败证据；不可变资产及已缓存版本保留。目录切换存在短暂不可读窗口，不承诺无停顿交换；执行中的任务继续读本地锁，下载冲突或缓存校验失败时不启动模型。

Skill Manager 当前限制单文件 8 MiB、技能包 32 MiB。发布工具将 PPTX、PNG、PDF 拆成按 SHA256 定位的独立资产，轻量包用 `assets-manifest.json` 引用；宿主恢复同一相对路径。指南、脚本与索引按原字节缓存，完整包复算提供方 revision，大资产另核对大小和 SHA256。UTF-8 读取会丢弃 BOM 的提供方行为按清单字节数恢复，并仍须通过整包 revision；绝不忽略 hash 不符。

## 接单与版本规则

- 新任务解析当前网络版本，锁定 profile、角色说明、技能身份/revision、完整资源与资产。
- 同一任务的制作、独立验收、返工、续派和恢复共用父任务锁；不重新解析 latest。PPT 父任务的冷缓存准备也在受理后的后台完成。
- 通用 A2A 宿主通过 `roleSkills: {cacheRoot, profiles, presetRoles?}` 配置可信 profile；请求只传 `roleId` 和可选已有父锁，不能替换 profile、网络或缓存根目录。
- 固定目标声明 `binding.skillPolicy="network_pinned"` 后，网关转发该目标绑定的 roleId。旧配置仍兼容；旧无角色会话不会中途升级。固定 PPT preset 可通过宿主 presetRoles 自动选择角色；通用 Codex/standard 不受影响。
- 宿主先验缓存与锁，再进入 DSH 或 Codex 执行会话，并注入准确指南入口。二者共用同一宿主加载流程，不依赖主会话是否给它传递了 MCP。搜索/读取来自能力网络与 MCP 共用的技能目录协议。
- 系统结果 metadata 记录实际角色、技能版本和锁路径；独立验收也可核对同一绑定。

手动缓存核验：`acp-service roles sync --profile roles/ppt-beautifier/profile.json --cache-root .cache/roles --lock .cache/roles/locks/EXISTING.json`。已有锁完全离线核验；省略 `--lock` 为新缓存锁，解析当前版本。此命令不派模型任务。

运行环境、MCP 工具权限和二进制依赖仍由宿主管理。技能内容更新不需要重装或重启角色；新增运行依赖需要单独预检和部署，不能由技能读取隐式安装。
