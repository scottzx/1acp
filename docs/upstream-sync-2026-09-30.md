# acpx 上游同步经验总结（2026-09-30 合并）

> 一次合并 228 个上游提交（`bfd7c92` → upstream/main，fork 点 local 提前 106 个）到 `@scottzx/1acp` fork。
> 分支：`sync/upstream-20260930`，合并提交 `c4720e0`。
> 本文记录过程中踩过的坑、归因方法和下次同步的操作清单，供后续同步复用。

## 一、合并策略

**总原则：上游架构优先，本地特性重新落位。**

1. **架构对齐上游**：目录结构、模块划分、类型签名全部采用上游版本。这次的核心架构变化：
   - `src/session/execution/*` + `src/session/queue/*` 新布局，queue-owner 独立进程
   - SDK 原生 `ClientConnection` 取代被上游删除的 client facade
   - `conversation-reducer.ts` / `conversation-retention.ts` 拆分，**双轨会话语义**（lossless 轨全量 / runtime 轨按上限截断）
   - `LiveSessionCheckpoint`：`request()` = 500ms 防抖 + **unref timer**，`checkpoint()` = 立即 flush
2. **本地特性清单化，逐项重放**，不追求逐字保留原实现，而是把特性语义落到新架构的正确位置（见下文"本地特性落位表"）。
3. **上游新增测试是免费的回归检测器**：它们不仅验证上游，还会揪出 fork 的历史 bug。这次上游测试帮我们发现了 3 个本地 bug（`..notes` 路径误判、PATH/代理强制注入、错误消息回显 canonical 路径）。

### 本地特性落位表（本次实际操作）

| 本地特性 | 新架构中的落位 | 备注 |
|---|---|---|
| grok `_x.ai/ask_user_question` / `_x.ai/exit_plan_mode` | `createClient` options 的 handlers，随 `withConnectedSession` 注入 | 上游 facade 删除后需改为 options 传递 |
| grok 权限模式短路缓存 | `handlePermissionRequest` 前置分支 | 注意复杂度预算（oxlint max 8） |
| turn journal（`turn_results` 快照） | `prepareRuntimeTurnState` 写 running 快照；终态快照走 `applyTerminalTurnSnapshot` | **finalization 自身失败时跳过终态快照**（save 注定失败） |
| `onOutOfTurnSessionUpdate` | `LiveSessionCheckpoint.onPersisted` 回调 + owner 的 `pendingOutOfTurnNotice` | 不能用立即 `checkpoint()`，会破坏上游防抖语义 |
| codex 二进制解析、model selection maps | `codex-compat.ts` 并集合并、`client.ts` 移植 | |
| `adoptSession`（预热收养） | contract 里改为**可选**方法，满足上游 `SharedAcpRuntime` 可赋值性 | |
| agent 状态目录 fs allowlist（`~/.grok` 等） | `isWithinRoot` 白名单 + `isAgentStatePath` 绕过 fs-safe 工作区包装直读直写 | fs-safe root 只认 cwd 根，白名单路径必须旁路 |
| `claudecode` 别名、`canonicalizePath` | `AGENT_ALIASES`、filesystem.ts | |
| 完整 assistant 文本保留 | **放弃**——采纳上游双轨：lossless 轨全量，runtime 轨 8k 截断 | 旧测试改为双轨验证 |
| deepseek-build 包装 | **整体移除**（注册表、env 注入、agent 文档、测试） | 按决策不再需要 |

## 二、四类问题的归因分布

复盘全部问题，分布如下（这是最有复用价值的认知）：

| 类别 | 占比 | 典型案例 |
|---|---|---|
| **合并问题**（两种架构语义冲突） | ~60% | idle handler 位置、save 计数、防抖 vs 立即持久化 |
| **fork 遗留问题**（上游新测试揪出） | ~20% | `..notes` 误判穿越、PATH/代理强制注入 |
| **fork 身份问题**（改名的连带） | ~15% | `acpx/dist/cli.js` 自引用、`acpx/flows` 说明符、exports 丢条目 |
| **上游问题** | ≈0（新增 bug 层面） | 仅测试对时序负载敏感 |

### 1. 合并问题（最难，占大头）

上游恰好重构了本地特性所在区域时，两边语义直接撞车，**单独跑任何一边都没 bug**：

- **idle handler 污染首连路径**（最典型）：上游把 `attachIdleProjection` 通用化（首连/终结/池化共用），本地 `installIdleOwnerEventHandlers` 的调用点留在里面 → 首连时 `clearEventHandlers` 抛错 → turn 未创建 → client 泄漏 → 挂死。修法：移回真正池化的时机（`retainPersistentSessionOwnerAfterTurn`），并给 clear 加容错。
- **save 计数冲突**：本地失败路径的额外持久化 vs 上游测试的精确 save 计数（`savesAfterPrompt === 2`）。
- **防抖 vs 立即持久化**：本地要求"持久化后立即回调"（立即 save 保活事件循环），上游是 500ms unref 防抖。最初两个上游测试和两个本地测试**只能过一边**，最终靠 `onPersisted` 回调 + pending notice 两全。注意上游测试普遍 `t.mock.timers.enable()` mock 掉防抖 timer，本地测试没有——两边对同一机制的前提不同。

**方法论**：
- 挂死类失败先写**最小复现脚本**（本次 `/tmp/repro71b.mjs` 用假 client 逐步 gate 出了 `client.close` 永不被调用），比在完整测试里调试快一个量级。
- 对"上游重构区 × 本地插入点"，合并后**先跑挂死类测试**（gated close / finalization failure 类）。
- 复杂度预算冲突（oxlint `complexity` max 8）用**抽小函数**解决，不申请豁免。

### 2. fork 遗留问题（上游测试帮你免费体检）

- `isPathInside` 用 `startsWith("..")` 判穿越 → `..notes` 这种合法文件名被误拒。正确判法：`relative !== ".." && !relative.startsWith("../")`。
- `baseAgentEnvironment` 强制注入 `PATH`/`HTTP_PROXY` 等四个键 → 上游新断言期望纯净 `{...process.env}`。改回上游形状。
- 越界拒绝的错误消息回显 canonicalize 后的 `/private/var/...` 而非调用方的原始路径。**错误消息要回显输入**。

### 3. fork 身份问题（改名的静默连带）

包名从 `acpx` 改为 `@scottzx/1acp` 后，所有**按包名自引用**的地方运行时才炸，编译不报错：

- `import.meta.resolve("acpx/dist/cli.js")`（shared.ts 的 queueOwnerArgs、shared-runtime.test 的 CLI 常量）→ 改相对解析 `new URL("../cli.js", import.meta.url)` 或新包名。
- `acpx/flows` 模块说明符：上游测试 fixtures 全用旧名 → **双说明符兼容**（`acpx/flows` 与 `@scottzx/1acp/flows` 都接受）。
- package.json exports 合并时丢了 `"./dist/*"` 条目 → service 的 `@scottzx/1acp/dist/cli.js` 导入崩。**exports/aliases 合并后必须 diff 校验**。
- 本地测试的桩（stub）形状要跟上游 API 走：facade 时代的 `connection.newSession(...)` 桩改为 SDK 形状 `connection.agent.request(method, params)`，并补 `close` 字段。

### 4. 上游本身

没有发现上游新增代码的真实 bug。仅两个软性特征：
- 部分 spawn/计时类测试对负载敏感（本机并发 4 + 长套件时偶发 flake，**隔离跑 100% 过**）。
- integration 全文件本来就要 ~10 分钟；`--test-timeout` 给小了会把"慢"误判成"挂死"。

## 三、排查方法论上的教训（不算代码问题，但浪费了时间）

1. **"随机挂死"先怀疑文件级超时**：node --test 的文件级超时覆盖整个文件，大文件（integration 159 个测试）跑不完会被标为超时，而当时正在跑的测试背锅，看起来像"挂点随机"。
2. **后台大任务跑测试时，不要再并发跑前台测试**：CPU 争抢制造整批假失败，事后甄别非常昂贵。
3. **进程泄漏要及早采样**：`pgrep -fl "cli.js __queue-owner"` 一行命令就能看到泄漏的 queue-owner 孤儿进程（PPID=1、挂 unix socket）。历史泄漏进程还会污染后续运行，先 `pkill` 清场再复现。
4. **测试必须无沙箱跑**：spawn/detached/IPC/ps 密集的测试（terminal-descendants、terminal、queue-ipc）在 workspace-write 沙箱下会挂 10 分钟以上；danger-full-access 下秒过。
5. pnpm 环境要点：`COREPACK_HOME="$PWD/.corepack"`（corepack 缓存 EPERM）、`CI=true`（no-TTY）、`--no-frozen-lockfile`（lockfile 重生成）。这些写进 shell 别名，不要每次踩。

## 四、验收标准（下次同步照此执行）

- [ ] runtime 全套件：`node --test --test-timeout=500000 --test-concurrency=4 dist-test/test/*.test.js`（在 `packages/runtime`，无沙箱）。允许极少量负载 flake，但**每个失败必须隔离复跑甄别**，隔离跑必须 100% 过。
- [ ] 重灾区文件单跑全绿：runtime-manager、client、filesystem、auth-env、session-conversation-*、runtime-checkpoint-shutdown、runtime-replacement、shared-runtime、integration（给足 10 分钟）、replay-viewer-lossless（自带 440s 超时，外层给 500s）。
- [ ] `pnpm --filter @1agents/acp-service test`（27）、`pnpm --filter @1agents/dsh-acp test`（36，先 `pnpm link:dsh <DSH checkout>`）。
- [ ] runtime `lint`（oxlint type-aware，0 错误）、`format:check`、`typecheck`。
- [ ] 全局 grep `"acpx/`（含 test/、scripts/、conformance/）确认无裸包名残留。
- [ ] package.json `exports` 与上游 diff，确认无条目静默丢失。
- [ ] deepseek-build / 其它已移除特性全净：`grep -rn "deepseek-build\|DeepSeekBuild"` 确认只剩平台命名空间 `@deepseek-ai/*`。
- [ ] 本地特性逐项在册（对照上文落位表 grep 验证）。

## 五、发布流程（本次实际走通的链路）

三个包按依赖序发布：`@scottzx/1acp` → `@1agents/acp-service` → `@1agents/dsh-acp`。

- workspace 内依赖写 `workspace:^`（本地 install 走 link，`pnpm pack` 自动转义为 `^版本范围`）。**直接写 `^0.x.0` 会让本地 install 去 registry 找未发布版本而失败**。
- 版本节奏参考：上游架构同步 = runtime minor（0.16.0），适配方 minor（0.3.0），纯依赖范围更新 patch（0.2.1）。
- 发布门禁：`.github/workflows/ci.yml` 打 tarball + **manifest 断言**（pack 出来的 package.json 里 name/version/依赖范围逐项核对）→ `release.yml`（workflow_dispatch）顺序发布，幂等（已发布版本做 integrity 比对后跳过），发布后 `npm view` 验证注册表依赖范围。
- dsh-plugin 构建依赖 DSH 平台类型：本地 `pnpm link:dsh /path/to/DSH`；CI checkout 固定 ref 的 DSH 仓库自建。注意 **`pnpm install` 会清掉 node_modules 里的类型 symlink，每次 install 后要重新 link**。
- CI 装 autoreview 的 Python 依赖时**不要用 `pip install --user`**：`test:autoreview` 以 `python -I` 运行，隔离模式排除 user site-packages，Pillow 装进 `~/.local` 后测试看不见（症状：`ModuleNotFoundError: PIL` × N + 走 "requires Pillow" 兜底路径的断言失败）。照上游写法 `python -m pip install -r requirements-autoreview.txt` 即可。
- 发布前本地演练：三包 pack → `tar -xOf <tgz> package/package.json` 核对依赖 → 临时目录 npm install tarball 验证 bin/exports/依赖链全解析。

## 六、快速参考

```bash
# 环境（每次 shell）
export COREPACK_HOME="$PWD/.corepack"

# 构建 + 测试（packages/runtime 下，无沙箱）
pnpm --filter @scottzx/1acp run build:test
node --test --test-timeout=500000 --test-concurrency=4 dist-test/test/*.test.js

# 某个失败测试的隔离复跑
node --test --test-timeout=120000 --test-name-pattern="<名字片段>" dist-test/test/<file>.test.js

# 泄漏进程检查 / 清理
pgrep -fl "cli.js __queue-owner"; pkill -f "cli.js __queue-owner"

# dsh-plugin 类型链接（每次 pnpm install 后）
pnpm link:dsh /Users/scott/Documents/01-开发项目/DSH

# 发布演练
pnpm --filter <pkg> pack --pack-destination ./release
tar -xOf release/<archive>.tgz package/package.json
```
