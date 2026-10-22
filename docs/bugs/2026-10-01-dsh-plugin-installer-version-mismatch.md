# [Bug] DSH 插件安装器显示最新版本，但 pnpm 实际安装旧版本

- 记录日期：2026-10-01
- 状态：已复现，待提交上游
- 上游仓库：https://github.com/deepseek-ai/deepseek-harness
- 提交阻碍：记录时上游仓库关闭了 Issues，尚未创建 GitHub issue。

## 问题概述

桌面端通过自定义 npm 镜像安装 `@1agents/dsh-acp` 时，安装器检查并展示 `0.2.2`，实际安装的却是 `0.2.0`。镜像元数据正确，版本差异出现在查询结果与 pnpm 安装解析之间。

旧版本继续使用旧服务依赖，用户以为已经安装新版本中的启动修复，实际运行的仍是旧版本。

## 环境

- macOS ARM64
- pnpm 11.7.0
- 自定义镜像：`https://registry.npmmirror.com`
- 包：`@1agents/dsh-acp`
- 复现时 `0.2.1`、`0.2.2` 均发布未满 24 小时，`0.2.0` 已超过该时间。

pnpm 11 默认使用 24 小时的版本年龄限制，参见 [pnpm 11 官方发布说明](https://pnpm.io/blog/releases/11.0)。

## 复现步骤

1. 打开桌面端插件安装器，选择上述自定义镜像。
2. 输入未指定版本的包名 `@1agents/dsh-acp`。
3. 检查结果显示版本 `0.2.2`。
4. 执行安装，查看 pnpm 输出和实际安装版本。

## 实际结果

安装日志显示：

```text
dependencies:
+ @1agents/dsh-acp ^0.2.0

Done in 507ms using pnpm v11.7.0
```

桌面 profile 中实际安装的插件为 `0.2.0`，服务依赖也为 `0.2.0`，与检查阶段展示的版本不同。

此前使用同一镜像、复制桌面 profile 配置进行隔离依赖解析，得到以下结果。这是 lockfile 解析验证，不代表完成了桌面端安装回归。

| 安装输入 | 插件解析版本 | 服务解析版本 |
| --- | --- | --- |
| `@1agents/dsh-acp` | `0.2.0` | `0.2.0` |
| `@1agents/dsh-acp@0.2.2` | `0.2.2` | `0.4.0` |

## 原因定位

检查阶段读取 registry 元数据，得到最新版本；安装阶段仍将用户输入的原始包名传给 `pnpm add`，未将检查到的版本绑定到安装请求。pnpm 按版本年龄策略解析未指定版本的包名，最终选择较旧版本。

本地源码中可见以下调用链：

- `packages/client/ui-plugin-manager/src/client/manager-store.ts`：`runInstall()` 调用 `inspect(spec, ...)`，随后将原始 `spec` 传给 `startInstall()`；后者调用 `installBundle(spec, ...)`。
- `packages/boot/plugin-manager/src/index.ts`：`installBundle()` 执行 `runPnpm(['add', spec, ...])`。安装后读取 bundle manifest，但没有与检查阶段的目标版本进行比较。

因此，pnpm 的解析行为触发了问题，DSH 安装器缺少版本一致性处理，导致界面检查结果不能准确代表最终安装结果。

## 预期行为与修复建议

1. 对 registry 包明确安装目标，使展示版本与实际安装目标一致；同时正确处理用户指定的版本、范围、tag，以及 Git 和本地路径输入。
2. 保留 pnpm 的版本年龄策略。目标版本受到策略限制时，明确展示限制原因和可用选项，避免静默安装另一个版本。
3. 安装结束后读取实际安装版本，核验目标与结果，并在界面显示真实结果。
4. 增加回归场景：registry 最新版本发布未满 24 小时，旧版本满足年龄策略时，检查、安装和最终展示应保持一致，或明确解释策略限制。

## 临时处理

在安装框明确输入 `@1agents/dsh-acp@0.2.2`。隔离依赖解析已验证该输入可解析为插件 `0.2.2` 和服务 `0.4.0`；桌面端完整安装回归仍需单独验证。
