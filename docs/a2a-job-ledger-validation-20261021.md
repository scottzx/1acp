# A2A Job Ledger P0/P1：部署与 xiaolan-bot 交付验收

日期：2026-10-21。结论：已部署并完成可编辑六页 PPT 的业务验收与通知 ack；整次实测未达到主会话 3—5 次目标。

## 最终交付

- [最终 PPTX](http://100.88.227.56:36818/artifacts/2f367547-1d18-4dbc-a530-48e5a71bc45a/revision-5/project-overview.pptx)
- [六页预览总览](http://100.88.227.56:36818/artifacts/2f367547-1d18-4dbc-a530-48e5a71bc45a/revision-5/preview.png)
- 最终 PPTX SHA256：`e7dc037645f2e6a57e095958c3ac7db68076a18508b5cec7d8e840a58ac98557`；清单摘要：`0c3ce91faac776d3c0d63523fb94f79336b2bb9d936453f86625c7f584d5cdde`。
- 字节/结构检查通过；独立验收会话亲自核对事实、查看七张最终图；root 核对系统回执后记录 accepted。未在 PowerPoint/Keynote/Google Slides 应用打开，实际字体为 PingFang SC。非阻断的排版、讲稿与记录问题见完整审计 JSON。

## 实现与部署范围

P0：持久执行目标/连接目录、显式版本与绑定、目录真实路径预检、只读健康探测及健康 TTL。P1：父任务、子任务和执行轮次；派单前持久身份；请求幂等；未知受理隔离；终态不可重开；当前产物选择；业务验收与通知 ack 分离；事件与旧缓存迁移。PPT 是固定领域交付角色，后台完成脚本、制作、机器校验与独立验收。未实现通用 DAG、AP 投影或 workflow 执行 provider。

当前网关与 DSH 宿主使用同一冻结本地包 `0.8.1-local.6bb4048afb27.d2d0666b73a0`，公共版本仍为 0.8.1，未发布 npm。运行目录 `/Users/scott/.local/share/1agents/a2a-gateway/releases/20261021-job-ledger-01-0.8.1/runtime-v4`。本轮恢复沿用冻结任务策略 `ppt-delivery-20261021-p0p1-v3`；当前新任务策略为 `ppt-delivery-20261021-p0p1-v4`，未改全局模型和原角色路由。

冻结包、依赖、源码和 hash 清单均保存在 release-v4；源码快照包含产物服务。测试验证同一包离线恢复到两个目录，激活保留宿主原生 peer 依赖、用户配置和任务状态。未声称从源码重建会产生逐字节相同的二进制包。产物服务实际部署文件与冻结源码 hash 一致。重启后需等待 DSH Agent Card 就绪并逐一探测目标，不能把 gateway /health 当作所有角色已就绪。

## 真实任务关系与完成条件

- sourceId：`4b00a5d8-3edc-4a5b-a7bf-8ae2bea967e4`；最终父 Job：`2f367547-1d18-4dbc-a530-48e5a71bc45a`。
- 父执行轮次 1 `8aea8f3d-47b9-453b-962a-ef903cfc2e10`：failed，保持终态。父执行轮次 2 `a56a4af1-c78b-4957-b345-b45e70b31140`：continue → working → completed。
- 同一制作子 Job `c2ce78fb-892c-4d72-aa6d-117629f131c0`，五个执行轮次共用一个实际 DSH session；五个独立验收子 Job 使用独立 session。
- 恢复复用已验收停点，并重新核对源码与精确字节；原子 Job 的创建 parentAttemptId 不重写。新增最终验收子 Job 指向新父轮次；恢复复用关系在 recovery 中另记。累计质量预算及总时长保留。
- 父完成条件：机器检查通过、独立事实及逐页视觉检查通过、摘要匹配、交付前重验未漂移。人工接受和通知 ack 均在父完成后分别记录。
- 原生 Codex transcript 已证明三次通知实际进入原主会话的新轮次；最终通知包含最终正文与产物 URL。不是用宿主 accepted 或 processedAt 冒充自动唤醒。

## 两次故障及修复

1. 旧产物服务只支持两段 URL，新合同使用 revision-N 三段 URL，造成 404。修复为兼容旧地址及严格一层版本目录，逐级拒绝符号链接/穿越；模型派单前增加真实版本 URL GET 字节探针。HTTP 发布故障转 input_required，不再消耗内容修订预算。旧记录中的三次无效制作重跑保留。
2. 旧逻辑把质量修订和调用方演练共用预算。修复为最多三次质量修订，加最多一次独立计数的显式演练；已通过独立验收但因旧策略失败的停点，可显式继续同一父 Job 的新轮次。冻结输入、宿主及角色不变；有在途或未知子任务时拒绝恢复。

## 调用统计

| 范围 | 主会话实际工具调用 |
|---|---:|
| 首次实现、部署及测量准备 | 72 |
| 从首次派单到最终验收审计，含两次故障与修复 | 38 |
| 上述全量合计 | 110 |
| 成功原生通知之后的 get、review、ack、审计（已计入上面） | 4 |

按原生 Codex transcript 中唯一 function_call/custom_tool_call 计数，包含最终审计调用本身，未重置窗口。一个主会话调用可以包含多个底层工具/RPC，不能视作一次远端操作或总成本；后台工作另计。最后四步收尾不是全链 3—5 次的证明。

后台第一条失败链加最终链共 9 个实际 DSH 会话，按 sessionId 去重后累计 token：`{"uncachedInputTokens": 1423748, "outputTokens": 953213, "cacheReadTokens": 193013760, "cacheWriteTokens": 0}`；sessionStats 累计：`{"turns": 16, "steps": 884, "llmMs": 5080142, "toolMs": 832116, "ttftMs": 1264328, "ttftSteps": 884, "decodeMs": 3815814, "decodeTokens": 953213}`。金额及实际底层工具调用总数未知。最终链为七个子 Job、十一个子执行轮次（脚本一次、制作五次、独立验收五次）；另一次恢复读取通过停点使 reviewRounds=6，不能当成六个独立验收模型会话。queryCalls 是内部缓存状态读取，不能当作实际远端 HTTP 请求数。

## 验证与证据

服务测试 199/199，产物服务 6/6，部署辅助 9/9，类型检查和 diff 检查通过。DSH 插件集成测试为本轮实现阶段 148 通过、10 条需外部源码环境而跳过；最终两个修复未修改插件源文件。

完整统计、原始调用 ID、实际 DSH sessionStats/tokenUsage、通知新轮次证据、accepted/ack 与已知限制：`/Users/scott/.local/share/1agents/a2a-gateway/releases/20261021-job-ledger-01-0.8.1/evidence/benchmark-final.json`。归档 QA/合同/来源清单：`/Users/scott/.local/share/1agents/ppt-beautifier/workspace/jobs/p0p1-ledger-20261021-acceptance`。产物在常驻文件服务的持久目录；原 /tmp 任务目录保持原样。
