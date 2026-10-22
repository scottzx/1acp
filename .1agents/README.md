# 项目 Agent 数据目录

角色定义、完整技能包缓存、任务工作目录和项目运行状态统一放在项目根 `./.1agents/`。角色定义与技能独立维护：profile 声明职责说明与技能引用，方法、脚本、模板及素材由能力网络发布。普通派单仍立即交接，技能解析由执行宿主后台完成。

创建角色、调用固定角色和派发临时任务的入口与参数见随包 [acp-service 技能](../packages/service/skills/acp-service/SKILL.md)及其 [API 路由](../packages/service/skills/acp-service/references/roles-and-tasks.md)。`resident-agent` 技能负责角色创建/维护；目标登记 API 不代替完整部署。

## 目录

```text
1acp/.1agents/
  README.md                     # Git：目录与维护约定
  roles/ppt-beautifier/          # Git：角色说明、技能引用和版本策略
  roles/wechat-stock-replenisher/ # Git：AP感应式角色说明及声明示例
  config/
    role-skills.example.json    # Git：更新配置示例
    project-discovery.example.json # Git：可选项目探查配置示例
    role-skills.local.json      # 本机配置，忽略提交
  skills/ppt/                   # 独立维护的完整技能源，忽略提交
  cache/roles/                  # 本机版本缓存，忽略提交
    catalog/ppt/                # 发布给 Skill Manager 的轻量投影
    skills/<identity>/<revision>/  # 提供方原始完整包和校验回执
    assets/<sha256>/blob         # 模板、图片等独立资产
    roles/<role>/<digest>/       # profile、角色说明和全部技能的可用快照
    locks/                      # 任务锁、更新预热锁；已有锁不覆盖
    current/                    # 最近一次成功更新入口，不替换任务锁
    updates/                    # 成功或失败更新回执
  runtime/ppt-beautifier/        # 本机运行数据，忽略提交
    agent-bundle/               # 宿主加载的角色 bundle
    host-bundle/                # 本机宿主挂载配置
    workspace/                  # 执行 PWD、任务目录及产物
    state/                      # 角色绑定、A2A 会话关联与版本归档
  state/a2a-gateway/             # 项目网关登记、任务账本与通知，忽略提交
    project-discovery/discovery.json # 目录候选快照、探查模式与诊断
```

Git 只跟踪角色声明、说明及示例配置。技能包、缓存、素材、任务数据、产物、状态和本机私密配置不提交。共享宿主安装包、登录凭据、全局模型配置及原生 DSH/Codex 会话库仍由宿主管理；本目录保存项目的会话关联、任务回执和产物，其角色绑定指向上述目录。

[公众号补库专员](roles/wechat-stock-replenisher/ROLE.md)是AP流程角色，使用 `role.example.json` 描述规则和依赖；它不是网络模型角色的原生 `profile.json`，不参与该格式的自动探查或A2A目标注册。当前仅规则演练草稿通过模拟测试，真实库存和自动生产尚未接通。

本机 macOS 的 launchd 不能打开 Documents 目录内的服务启动日志，三个启动器的 stdout/stderr 保存在 `~/Library/Logs/1agents/`，权限为目录 0700、文件 0600。该系统日志例外不改变角色任务的实际 PWD、技能缓存或产物位置。

本地完整技能源在 `.1agents/skills/ppt` 维护；发布投影和运行快照都是可校验缓存，不能把修改缓存作为更新技能的方式。旧私有 skills 目录仅作历史备份。缓存丢失可重新获取当前版本；历史版本恢复依赖保留的任务锁、技能包和资产，不自动删除这些版本。

## 可选项目与角色探查

网关可通过已安装的 Session Reader CLI 读取项目目录元数据，再只读检查项目中的 `.1agents/roles/*/profile.json` 结构，从项目/PWD 目录元数据形成角色候选。Reader 当前提供 `1session projects --json` CLI；不假设其 HTTP 服务存在 projects 接口。不安装 Reader，不读取会话正文、ROLE、技能脚本或执行角色代码。

参考 [project-discovery.example.json](config/project-discovery.example.json)，将其中 `projectDiscovery` 合入受保护网关配置，替换为本机真实可执行文件和允许根目录。`allowedRoots` 为非空绝对路径列表；`explicitRoots` 可补充已知项目根。默认 `timeoutMs=15000`、`maxProjects=200`，探查范围与单次数量有界。未配置时接口明确返回未启用，不自行扫描。示例文件不会被自动加载，也不代表当前服务已配置或部署。

| 可信管理接口 | 参数与作用 |
| --- | --- |
| `execution_project_scan` | `{}`；手动执行一次探查并保存候选快照，不创建任务或目标 |
| `execution_project_list` | `{}`；只读已保存快照，不隐式触发扫描 |
| `execution_discovery_config_get` | `{}`；只读持久的 manual/interval 模式与 intervalMs，不扫描 |
| `execution_discovery_config_update` | `{mode:"manual"}` 或 `{mode:"interval",intervalMs:60000}`；切换手动/定频模式 |

默认 `manual`。定频模式必须显式提供 `intervalMs`，范围为 60 秒至 24 小时，由网关后台维护；主会话不循环 scan/list，不等待目录变化，也不因目录更新被唤醒。切回 manual 停止周期探查，保留已有候选。执行范围和 Reader 路径由可信网关配置决定，普通任务参数不能覆盖。

快照位于 `.1agents/state/a2a-gateway/project-discovery/discovery.json`；Reader 失败或结果不完整时保留旧候选并标明 partial/stale 与诊断，不把旧快照冒记为最新成功。发现角色 profile 只说明存在候选，不代表宿主映射、技能加载、目录权限或模型已经就绪。登记角色/目标仍需显式管理操作；一键填入临时任务 cwd 和自动注册不在本次范围。Reader 缺失不影响手填目录或普通派单。

## 统一更新

根据 [role-skills.example.json](config/role-skills.example.json) 建立本机 `.1agents/config/role-skills.local.json`，填入执行机器上的真实绝对路径。在独立开发/部署阶段完成构建，再执行：

```sh
pnpm build
node scripts/update-role-skills.mjs --config .1agents/config/role-skills.local.json
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

手动缓存核验：`acp-service roles sync --profile .1agents/roles/ppt-beautifier/profile.json --cache-root .1agents/cache/roles --lock .1agents/cache/roles/locks/EXISTING.json`。已有锁完全离线核验；省略 `--lock` 为新缓存锁，解析当前版本。此命令不派模型任务。

迁移目录时保留旧路径的受控兼容入口及历史文件原字节，不改写旧锁、冻结合同、任务回执或历史部署记录。已登记目标及历史执行上下文可继续保留旧 cwd/锁路径的词法地址，通过兼容链接访问实际迁入 `.1agents/` 的文件；不要为统一显示而强改已有目标的冻结 cwd，避免破坏续派。新建角色与目标优先使用上述新目录。确认所有引用已转移前，不删除旧入口。运行环境、MCP 工具权限和二进制依赖仍由宿主管理；技能热更不隐式安装依赖。
