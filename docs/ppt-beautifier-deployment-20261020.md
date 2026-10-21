# PPT 美化大师 · 常驻服务与完整交付验收

常驻角色的真实 PPT 美化、下载、原主会话成功通知自动唤醒、业务验收与 ack 全部完成。

## 服务身份与生命周期

- 角色：`ppt-beautifier`，显示名称“PPT 美化大师”，仅配置 PPT 制作、美化及必要导出/验收工具。
- 常驻的是 DSH 宿主、角色预设和下载服务；每项 A2A 派单创建独立会话与任务目录。
- 宿主沿用本机 DSH Web，网关 remote 为 `ppt-beautifier`，A2A 地址 `http://127.0.0.1:3080/a2a`。
- 这是共享 DSH 宿主上的角色预设，使用通用 DSH Agent Card；职责由角色提示和技能/工具配置约束，不声称独立操作系统沙箱。
- DSH Web、现有 A2A 网关与新增产物下载服务均由用户级 LaunchAgent 管理，随当前用户登录启动。
- 产物入口：`http://100.88.227.56:36818/artifacts/<job>/<file>`，只读提供专用目录中的 PPTX/PDF/PNG，无目录列表和上传接口。

## 技能接入

- 实际通过独立 skill-manager 检索、按 revision 读取了本机 `pptx` 技能及其编辑说明。
- 来源节点 `scott-mac`，revision `c3731de3c335a330deea222dc9c55e2140a4581a8960f61d26f37db1dccdcddf`。
- 技能快照位于服务私有 skills 目录，并同时接入 Presentations 的 artifact-tool 制作、渲染与 finalizer 验收流程。
- 没有修改全局技能或模型默认；PPT 角色作用域的实际请求固定到已配置的 `minimax-cn/MiniMax-M3`，并保留对其他角色的设置。

## 本次合同与结果

- 示例源稿：4 页普通版式，内容为智能体能力常驻服务；明确授权调整版式、字体、配色、留白，保留原稿、页序和全部文字含义。
- 输入已冻结 SHA256；生产由真正接受 A2A 派单的独立 DSH 会话执行，主会话仅准备原稿并验收。
- 最新任务：`dfd2516b-9872-4dd6-8919-26df9839a9c3`。
- 执行会话：`session-15a26bd8-d8cc-45b2-b9c0-a909dba611dd`。
- 父会话：`01a1573e-be28-70b3-8cde-13d3470f4f74`；沿用已验证的 Codex queue 通知与 inbox/ack。

PPT 产物：[下载美化后的演示稿](http://100.88.227.56:36818/artifacts/demo-20261020-01/beautified.pptx)。

预览：[下载总览](http://100.88.227.56:36818/artifacts/demo-20261020-01/preview.png)。

- 原稿哈希未变，4 页全部文本保留，原生文字对象可编辑，HTTP 下载字节与本机 SHA256 一致。
- 原主会话逐页读取最终 PNG 完成真实视觉验收，保存处理结论后 ack；完成通知持续携带最终答复与文件链接。

## 通知与唤醒证据

- 派单、WORKING、COMPLETED 均已查询；成功通知被 Codex queue 接收，最终答复含真实 PPTX 与预览链接，业务验收结论已先于 ack 保存。
- 原主会话已由第一次失败通知自动唤醒；此记录不会把失败通知的唤醒误记为最新成功通知的唤醒。
- 最新成功通知实际进入原主会话的状态：已观测到，见完整验收记录。

## 恢复与验证记录

- 第一次任务在模型前被不支持的 persona 变量阻断，已移除变量并保存失败/修复关联后 ack。
- 第二次任务完成资料预检后遭遇 DeepSeek 流式连接超时和 5 次恢复失败；保存证据后 ack，并改用角色专属 MiniMax 路由、新建上下文恢复。
- scoped model 插件 4 项原生测试通过，下载服务 5 项真实 HTTP 测试通过；全局模型默认前后均为既有 DeepSeek route。
- 本次部署备份、技能来源、模型路由及原始验收证据保存在服务私有 state 与 job 目录。不要把其中的宿主凭据复制到报告或消息。

[完整脱敏验收记录](ppt-beautifier-deployment-20261020.json) · [可复用配置](../examples/ppt-beautifier/README.md)
