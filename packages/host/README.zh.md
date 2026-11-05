# `@ephemeral-ai/mayfly-host`

[English](README.md) | 中文

Mayfly Host 在完整的 `dsh-web-app` 组合中添加 `mayflyConversation` 会话投影和 `mayflyHost` Remote 命名空间。其 bundle patch 禁用浏览器交接和普通 Web URL 行，并在 Loader 稳定后输出一行经过身份验证的 `mayfly host: <url>` 就绪信息。

Host 保留原生 Web 传输和浏览器服务，同时禁用 Web 专用的
`harness-dev-context` 系统提示段和 `DSH_WEB_URL` shell 上下文。模型不会被告知
终端用户正在操作 Web GUI。

独立前端是 `@ephemeral-ai/mayfly` TUI；Host 不内嵌该前端。

## Mayfly 创造模式 preset

Host bundle 通过原生 `@deepseek-ai/dsh-agent-preset` 注册表注册
`mayfly-cordis`（`Mayfly Cordis`）。它保留固定版本上游 Cordis preset 的工具和
isolate 分组，添加说明两个进程边界的 persona，并从已发布的 Host payload 加载
`cordis-plugin-development`、`mayfly-plugin-development` 和
`editing-cordis-compositions` 技能。在原生 Session 的 turn 边界允许切换时，可用
`/preset mayfly-cordis` 选择它。注册和技能加载均属于 Host；TUI 包不发布
preset。

创造模式可以检查原生服务，编写普通持久 Host bundle 和 Agent preset。
Harness `0.2.2-rc.1` 的 Cordis 模型工具只有 `cordis_inspect_list` 和
`cordis_inspect_query`，已不再提供创建、挂载、运行、停止或移除动态包的模型工具。
Host runner 仍保留程序调用的生命周期；`code.host` 在 Host 运行，`code.client`
面向原生浏览器 runner。

本版独立 TUI 没有公开的动态 UI 热加载或外部前端插件安装入口。Host 插件不能注入
前端本地的 `mayflyPanes`、`mayflyStatus`、`mayflyOverlays` 或
`mayflyEditorExtensions`，浏览器 client half 也不能访问这些服务。终端 UI 原型
目前需要把源码接入 Remote 组合、构建、重启，并在专用 profile 中验收。仅安装 Host
插件不会产生终端 UI 贡献。随包 persona 和技能均明确说明这一 API 限制。

## Remote 契约

`capabilities()` 返回协议版本 1 和以下基础功能键：`mayflyConversation`、`presentTools`、`followWorkflow`、`gitStatus`、`mcpCatalog`、`toolCatalog`、`mayflySettings`、`skillCatalog`、`retractTurn`、`modelCatalogDetails`、`defaultModel`、`authorization`、`permissionCatalogDetails`、`providerBalance`、`settingsDocument`、`subagentTree`、`subagentStop`、`workspaceChanges`、`workspacePath`、`mcpResources`、`stats`、`trace`、`deliveredFiles`、`btwFork`。若组合提供可调用的原生 MCP 服务器目录，还会增加 `mcpTransportHealth`。Session 作用域方法接收 `{ sessionId }`；`presentTools` 接收 `{ entries }`，Gateway 在任何 Agent 查找或激活之前授权所有指定 Session。非 owner 拒绝使用 `remote-access/denied`。普通冷 Session 通过原生 Session Controller 恢复；活跃子 Session 使用其精确的注册 Agent。冷子 Session 无法使用这条普通恢复路径：依赖 Agent 的操作返回 `mayflyHost/agent-unavailable`，工具展示则使用通用的持久内容；两者都不会借用父 Agent 或全局工具视图。

- `btwFork(request, signal)` 接受 `{ sessionId, atSeq?, allowMigration? }`，返回 `{ sessionId, historyFloorSeq? }`。未显式指定截断点时，它观察当前完整的原生历史尾部，包括尚未完成的首个 turn，再由原生 Session Controller fork 完成配平和组合。完全为空的源使用其有效 Host 目录和 preset 通过原生 create 创建，因此没有继承历史的 floor。调用取消、精确 Agent/来源替换和服务卸载会抑制迟到结果，不会取消 Host 工作。
- `presentTools(request, signal)` 接受发生变化的 `sessionId`、`callId`、`updatedSeq`、工具名、原始参数和可选结果内容，返回 `presentations[sessionId][callId] = { updatedSeq, call?, result? }`。重复条目对返回 `gateway/bad-request`。原生 `presentCall`/`presentResult` 输出会分离并通过 JSON 校验；未知工具、 presenter 抛错或非 JSON 视图只把对应视图降级为通用卡片。Tool Definition、回调、Agent、Session 或 Cordis 对象都不会跨越边界。
- `followWorkflow(request, signal)` 返回 Remote 流。首帧是 `{ type: 'baseline', value }`；后续帧是 `{ type: 'replacement', value }`，每帧都携带完整的新 `MayflyWorkflowSnapshot`。`mayflyWorkflow` Session 投影折叠原生 `tool-workflow/*` 记录并提供重连基线；进程内 `workflow/*` 事件只补充阶段和活跃元数据，不形成第二个 workflow 引擎。子 id 始终是 Session id。新 turn 清理已结束 run；中断或恢复的 Session 生命周期把未完成 run 和成员标记为 `interrupted: true`。Client 释放、Peer 取消、服务卸载或精确 Agent 丢失会关闭流并移除监听器；Agent 丢失报告 `mayflyHost/session-stale`。
- `gitStatus(request, signal)` 返回分支、dirty/ahead/behind 和增删行数；树探测失败时返回 `{ branch, unknown: true }`；不在仓库中或分支探测失败时返回 `null`。它只使用精确 Session 的有效 Host 目录。缓存按精确 Agent 和目录隔离，分支 TTL 为 5 秒、状态 TTL 为 15 秒、失败重试 TTL 为 5 秒。每个 Git 进程的超时为 500ms，输出上限为 4MiB。调用方取消会停止进程，而不会把取消转换为空结果。
- `mcpCatalog(request, signal)` 返回 `servers`、`orphanCount` 和 `sessionLive: true`。每个服务器包含 `entryId`、`serverName`、派生的工具可见性 `status`、连接状态、`registeredCount`、可见 JSON 工具 schema 和脱敏 `config`。已发布的原生版本没有服务器目录，因此连接状态为 `unknown`，`config` 为 `{ transport: null, endpoint: null }`；可选目录可提供这些详情。`toolCatalog(request, signal)` 按稳定的名称顺序返回精确 Agent 的可见 schema。目录及其参数 JSON 在构造后冻结，不携带执行或展示回调。
- Loader 条目 `mayfly` 向官方 settings 注册完整的 volatile Mayfly 首选项 schema，使 `remote.settings` 直接读写该命名空间。主题和语言应用仍由 TUI 本地负责。
- `skillCatalog` 返回 `{ skills, complete }`，在官方列表数据之外附带原生 `source` 和 `provider` 字段。`modelCatalogDetails` 返回适配器解析的 `provider`、`id`、`name`、`providerLabel`、可选 `contextWindow`、`efforts` 和 `defaultEffort`。`defaultModel` 接受 `{ operation: 'read' }` 或 `{ operation: 'select', provider, model, reasoningEffort? }`，通过 `agentDefaultModel` 返回最终选择，无需 Session。
- `permissionCatalogDetails` 返回官方选项/默认值以及每行 `sandbox` 和 `approval` 的 `specs` 映射，并为可选 `currentPreset` 计算 `yolo`。`providerBalance` 返回官方 API-key 钱包或 `network`/`rejected`/`no-key`；密钥和 Authorization 请求头始终留在 Host。
- `retractTurn` 接受 `{ sessionId, messageId }` 并返回是否接纳匹配的、无工具活动的运行中 turn。它通过精确 Agent 取消，并只在权威关闭提交后写入 Mayfly 替换标记，绝不以普通 cancel 或 `updateQueue` 代替。`subagentTree` 接受 `{ sessionId }`，返回完整的原生后代树、诊断和只读的活跃展示指标，不激活冷子 Session。`subagentStop` 接受 `{ sessionId, childSessionId }`，重新检查该根 Session 的当前原生后代与活跃性保护条件，并通过精确的直接父 Agent 等待 `drainChildren` 完成。取消只使响应失效，不会取消原生停止过程。
- `workspaceChangesSummary` 接受 `{ sessionId, seq }`；`workspaceChangesDiff` 额外接受 `index`。它们返回仍保留的原生摘要/hunk 或 `null`，不会激活 Session。Host 重启或 Session 释放后可能没有可用比较；这些读取不会恢复另一个历史存储。`workspacePath` 按规范化路径解析现有 workspace，不创建或修改记录。
- `deliveredFile` 接受权威交付记录的 `{ sessionId, deliveryId, preview? }`，通过精确 Agent 的原生文件系统解析，返回元数据和可选的文本预览，上限为 256 KiB。原生文件系统 target 不跨越传输边界。`latestWorkspaceChanges` 读取保留的原生摘要，不激活 Agent。
- `statsSession` 被动读取一个原生用量摘要及创建元数据。`statsHistory` 接受 `{ sessionId, allWorkspaces }`，流式返回完整进度和摘要快照。两种工作区模式都必须先获得 Host 全局授权，之后才会列出或观察历史；只有 anchor Session 的权限不足，被拒绝时返回 `remote-access/denied`。摘要只在已验证的冷 Session revision 上复用，活跃 Session 每次重新计算。`traceCatalog` 读取规范化的被动原生日志时间线；`traceDetail` 接受所选条目的 `{ sessionId, seq, eventSeqs }`，重新检查精确事件身份后返回不可变原始 JSON 和原生替换/来源关系。这些读取都不会激活 Agent。
- `listMcpResources` 接受 `{ sessionId, server, kind: 'resources' | 'templates', cursor? }` 并返回 `{ items, cursor? }`，其中 metadata 均为 JSON 安全值。`readMcpResource` 接受 `{ sessionId, server, uri }` 并返回 `{ text }`，保留文本正文并概述二进制内容。只调用三个固定的原生资源工具，不提供任意工具执行 API。
- `authorize` 是 Remote 操作流。帧类型为 `started`、`notice`、`prompt`、`prompt-ended` 和 `settled`，均携带服务器生成的 `operationId`。上行应答为 `{ type: 'answer', operationId, promptId, value }` 或 `{ type: 'decline', operationId, promptId }`。`cancelAuthorization` 取消该凭据的原生尝试。关闭流会取消操作；秘密应答只从上行传给原生 prompt，绝不记录日志。
- `readSettingsDocument` 返回 `{ writable, content, revision }`，其中 revision 是原始文档的 SHA-256 哈希。`writeSettingsDocument` 接受 `{ content, expectedRevision }`，使用原生配置写入方共享的 profile 锁，在锁内比较 revision、原子替换 settings 文档并读取返回文档，从而协调独立 Host 实例与原生配置写入。过期写入返回 `mayflyHost/settings-conflict`。这只是部分冲突保护：不遵守该锁的外部编辑器仍可能在最后一次 revision 检查后并发写入。调用方取消会停止等待锁；已经接纳的原子写入仍可能完成，但取消后的回复会被丢弃。没有任意文件路径或通用文件 API。

领域错误码为 `mayflyHost/capability-unavailable`、`mayflyHost/agent-unavailable`、`mayflyHost/session-stale`、`mayflyHost/session-directory-unavailable`、`mayflyHost/authorization-unavailable`、`mayflyHost/authorization-in-flight`、`mayflyHost/authorization-failed`、`mayflyHost/settings-conflict`、`mayflyHost/settings-read-only`、`mayflyHost/settings-document-unavailable`、`mayflyHost/subagent-tree-unavailable`、`mayflyHost/subagent-stop-unavailable`、`mayflyHost/subagent-stop-unauthorized`、`mayflyHost/mcp-resource-failed` 和 `mayflyHost/delivery-unavailable`。原生解析还可能返回 `session/not-found`、`session/agent-busy` 或 `session/writer-held`；传输和校验使用标准 `gateway/*` 错误码。异步方法同时响应调用方取消和 Host 服务卸载。DTO 及其嵌套值在发出前冻结。

### 公共 API 限制

冷子 Session 的历史和投影可通过官方 Session API 被动读取。没有活跃子 Agent 时，依赖 Agent 的专属 presenter 和控制仍不可用：`SubagentRuntime.startActivation` 需要精确活跃父 Agent 和初始任务，而普通 Session 路由会拒绝 subagent 所有的 Session。`presentTools` 对这些条目返回 `{ updatedSeq }`，让前端使用通用卡片，不影响同批次的活跃条目。其他依赖 Agent 的操作返回 `mayflyHost/agent-unavailable`。浏览历史不会恢复子 Agent，也不会借用父 Agent 或全局 Agent。

握手的包版本和所需 Harness 版本取自发布 manifest。可选组合若提供脱敏原生 MCP 服务器目录，可声明 `mcpTransportHealth`；连接中、重连中和已断开服务器的工具可用性标为 `unknown`，不会误报为 `no-tools` 或 `synced`。

dsh `0.2.2-rc.1` 没有公开已配置 MCP 服务器或传输健康状态的目录：其 `ServerContext` 仅包含 resources 和 instructions。Mayfly 因此只列出可通过已注册工具名称发现的服务器，并将 transport/endpoint 保持为 `null`；不会读取 Loader 条目，也不会发出命令参数、环境变量、请求头、凭据或其他原始 MCP 配置。`synced`/`restricted`/`no-tools` 状态描述工具可见性，而不是连接健康。补充目录必须由 Mayfly Host composition 扩展通过公开 API 和脱敏 DTO 提供，内容限于服务器身份、传输、脱敏 endpoint 和连接状态，排除环境变量和请求头。本项目不向 dsh 上游补齐该能力，也不复制其私有实现。

## 开发 profile

使用 Node `>=24.9.0`、锁定的 pnpm `11.7.0`，以及独立安装的官方 dsh
`0.2.2-rc.1` 可执行文件。从仓库根目录运行：

```sh
pnpm install --frozen-lockfile
DSH_BIN=/path/to/dsh PROFILE=mayfly-host-accept script/install-dev.sh
```

规范安装器构建工作区，必要时从原生 Web 模板创建专用 profile，再链接 Host
bundle、禁用可选原生构建脚本，并检查最终的 `dsh-base` / `dsh-web-app` /
Mayfly Host 组合。安装器校验所选 dsh 版本，不修改全局安装。已有专用 profile
会复用，共享的 `mayfly` 和 `default` profile 会被拒绝。

在不同终端分别启动两个进程：

```sh
# Host
/path/to/dsh --profile mayfly-host-accept

# TUI；复制 Host 唯一就绪行中的 URL
MAYFLY_DSH_STARTUP_URL='<authenticated-url>' script/mayfly-tui.sh
```

认证 URL 不得放入 argv 或提交到仓库。设置、凭据、workspace 和 Session
保留在 Host；调色板、剪贴板、导出和外部编辑器位于 TUI 所在机器。没有任务和
恢复 id 的启动在第一条 prompt 前不创建 Session；关闭 TUI 后 Host 工作继续。

修改源码后运行 `pnpm run build` 并重启受影响进程。依赖图变化后重新安装专用
profile。当前分支的分体包是开发产物，发布包安装须使用匹配且经过验证的发布集。
