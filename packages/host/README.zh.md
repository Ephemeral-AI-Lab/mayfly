# `@ephemeral-ai/mayfly-host`

[English](README.md) | 中文

Mayfly Host 在完整的 `dsh-web-app` 组合中添加 `mayflyConversation` 会话投影和 `mayflyHost` Remote 命名空间。其 bundle patch 禁用浏览器交接和普通 Web URL 行，并在 Loader 稳定后输出一行经过身份验证的 `mayfly host: <url>` 就绪信息。

独立前端是 `@ephemeral-ai/mayfly-remote`；Host 不内嵌该前端。

## Remote 契约

`capabilities()` 返回协议版本 1 和以下功能键：`mayflyConversation`、`presentTools`、`followWorkflow`、`gitStatus`、`mcpCatalog`、`toolCatalog`、`mayflySettings`、`skillCatalog`、`retractTurn`、`modelCatalogDetails`、`defaultModel`、`authorization`、`permissionCatalogDetails`、`providerBalance`、`settingsDocument`、`subagentDrain`、`workspaceChanges`、`workspacePath`、`mcpResources`。Session 作用域方法接收 `{ sessionId }`；`presentTools` 接收 `{ entries }`，Gateway 在任何 Agent 查找或激活之前授权所有指定 Session。非 owner 拒绝使用 `remote-access/denied`。普通冷 Session 通过原生 Session Controller 恢复；活跃子 Session 使用其精确的注册 Agent。冷子 Session 无法使用这条普通恢复路径，会返回 `mayflyHost/agent-unavailable`，而不会借用父 Agent 或全局工具视图。

- `presentTools(request, signal)` 接受发生变化的 `sessionId`、`callId`、`updatedSeq`、工具名、原始参数和可选结果内容，返回 `presentations[sessionId][callId] = { updatedSeq, call?, result? }`。重复条目对返回 `gateway/bad-request`。原生 `presentCall`/`presentResult` 输出会分离并通过 JSON 校验；未知工具、 presenter 抛错或非 JSON 视图只把对应视图降级为通用卡片。Tool Definition、回调、Agent、Session 或 Cordis 对象都不会跨越边界。
- `followWorkflow(request, signal)` 返回 Remote 流。首帧是 `{ type: 'baseline', value }`；后续帧是 `{ type: 'replacement', value }`，每帧都携带完整的新 `MayflyWorkflowSnapshot`。`mayflyWorkflow` Session 投影折叠原生 `tool-workflow/*` 记录并提供重连基线；进程内 `workflow/*` 事件只补充阶段和活跃元数据，不形成第二个 workflow 引擎。子 id 始终是 Session id。新 turn 清理已结束 run；中断或恢复的 Session 生命周期把未完成 run 和成员标记为 `interrupted: true`。Client 释放、Peer 取消、服务卸载或精确 Agent 丢失会关闭流并移除监听器；Agent 丢失报告 `mayflyHost/session-stale`。
- `gitStatus(request, signal)` 返回分支、dirty/ahead/behind 和增删行数；树探测失败时返回 `{ branch, unknown: true }`；不在仓库中或分支探测失败时返回 `null`。它只使用精确 Session 的有效 Host 目录。缓存按精确 Agent 和目录隔离，分支 TTL 为 5 秒、状态 TTL 为 15 秒、失败重试 TTL 为 5 秒。每个 Git 进程的超时为 500ms，输出上限为 4MiB。调用方取消会停止进程，而不会把取消转换为空结果。
- `mcpCatalog(request, signal)` 返回 `servers`、`orphanCount` 和 `sessionLive: true`。每个服务器包含 `entryId`、`serverName`、派生 `status`、`registeredCount`、可见 JSON 工具 schema 和 `config: { transport: null, endpoint: null }`。`toolCatalog(request, signal)` 按稳定的名称顺序返回精确 Agent 的可见 schema。目录及其参数 JSON 在构造后冻结，不携带执行或展示回调。
- Loader 条目 `mayfly` 向官方 settings 注册完整的 volatile Mayfly 首选项 schema，使 `remote.settings` 直接读写该命名空间。主题和语言应用仍由 TUI 本地负责。
- `skillCatalog` 返回 `{ skills, complete }`，在官方列表数据之外附带原生 `source` 和 `provider` 字段。`modelCatalogDetails` 返回适配器解析的 `provider`、`id`、`name`、`providerLabel`、可选 `contextWindow`、`efforts` 和 `defaultEffort`。`defaultModel` 接受 `{ operation: 'read' }` 或 `{ operation: 'select', provider, model, reasoningEffort? }`，通过 `agentDefaultModel` 返回最终选择，无需 Session。
- `permissionCatalogDetails` 返回官方选项/默认值以及每行 `sandbox` 和 `approval` 的 `specs` 映射，并为可选 `currentPreset` 计算 `yolo`。`providerBalance` 返回官方 API-key 钱包或 `network`/`rejected`/`no-key`；密钥和 Authorization 请求头始终留在 Host。
- `retractTurn` 接受 `{ sessionId, messageId }` 并返回是否接纳匹配的、无工具活动的运行中 turn。它通过精确 Agent 取消，并只在权威关闭提交后写入 Mayfly 替换标记，绝不以普通 cancel 或 `updateQueue` 代替。`subagentDrain` 接受 `{ parentSessionId, childSessionId }`，重新检查当前原生目录和活跃性保护条件，并只通过精确的直接父 Agent 调用 `drainChildren`。
- `workspaceChangesSummary` 接受 `{ sessionId, seq }`；`workspaceChangesDiff` 额外接受 `index`。它们返回原生摘要/hunk 或 `null`，不会激活 Session。`workspacePath` 按规范化路径解析现有 workspace，不创建或修改记录。
- `listMcpResources` 接受 `{ sessionId, server, kind: 'resources' | 'templates', cursor? }` 并返回 `{ items, cursor? }`，其中 metadata 均为 JSON 安全值。`readMcpResource` 接受 `{ sessionId, server, uri }` 并返回 `{ text }`，保留文本正文并概述二进制内容。只调用三个固定的原生资源工具，不提供任意工具执行 API。
- `authorize` 是 Remote 操作流。帧类型为 `started`、`notice`、`prompt`、`prompt-ended` 和 `settled`，均携带服务器生成的 `operationId`。上行应答为 `{ type: 'answer', operationId, promptId, value }` 或 `{ type: 'decline', operationId, promptId }`。`cancelAuthorization` 取消该凭据的原生尝试。关闭流会取消操作；秘密应答只从上行传给原生 prompt，绝不记录日志。
- `readSettingsDocument` 返回 `{ writable, content, revision }`，其中 revision 是原始文档的 SHA-256 哈希。`writeSettingsDocument` 接受 `{ content, expectedRevision }` 并在写入实际 settings 文档前立即重新校验 revision。没有任意文件路径或通用文件 API。

领域错误码为 `mayflyHost/capability-unavailable`、`mayflyHost/agent-unavailable`、`mayflyHost/session-stale`、`mayflyHost/session-directory-unavailable`、`mayflyHost/authorization-unavailable`、`mayflyHost/authorization-in-flight`、`mayflyHost/authorization-failed`、`mayflyHost/settings-conflict`、`mayflyHost/settings-read-only`、`mayflyHost/settings-document-unavailable`、`mayflyHost/subagent-drain-unavailable`、`mayflyHost/subagent-drain-unauthorized` 和 `mayflyHost/mcp-resource-failed`。原生解析还可能返回 `session/not-found`、`session/agent-busy` 或 `session/writer-held`；传输和校验使用标准 `gateway/*` 错误码。异步方法同时响应调用方取消和 Host 服务卸载。DTO 及其嵌套值在发出前冻结。

### 公共 API 限制

冷子 Session 的只读激活仍不可用：`SubagentRuntime.startActivation` 需要精确活跃父 Agent 和初始任务，而普通 Session 路由会拒绝 subagent 所有的 Session。活跃子 Session 继续可用。最小的上游补充是经过 Session 资源授权、基于现有 continuation manager 的只读精确子 Agent 解析器，而不是 prompt/delivery 操作或父/全局 Agent 回退。

dsh `0.2.2-alpha.2` 没有公开已配置 MCP 服务器或传输健康状态的目录：其 `ServerContext` 仅包含 resources 和 instructions。Mayfly 因此只列出可通过已注册工具名称发现的服务器，并将 transport/endpoint 保持为 `null`；不会读取 Loader 条目，也不会发出命令参数、环境变量、请求头、凭据或其他原始 MCP 配置。`synced`/`restricted`/`no-tools` 状态描述工具可见性，而不是连接健康。最小的上游补充是公开的脱敏服务器目录，包含服务器身份、传输、脱敏 endpoint 和连接状态；环境变量和请求头必须排除。这里不复制私有实现。

## 开发 profile

使用 Node `>=24.9.0` 和仓库锁定的 pnpm。在仓库根目录安装并构建：

```sh
pnpm install
pnpm run build:changed
```

从随附的 Web 模板初始化一个全新的、已被 Git 忽略的开发 profile。此替换命令仅用于首次设置；再次运行会重置同名 profile：

```sh
export DSH_HOME="$PWD/.artifacts/dsh-host"
pnpm --dir packages/host exec dsh --profile mayfly-host-dev --from-default-profile web --dump-default-config >/dev/null
pnpm --dir packages/host exec dsh plugin --profile mayfly-host-dev add "link:$PWD/packages/host"
```

生成的 bundle 顺序为 `dsh-base`、`dsh-web-app`，然后是 `@ephemeral-ai/mayfly-host`。Host 包的开发依赖为安装和启动提供同一个 `0.2.2-alpha.2` CLI，与旧版进程内 Mayfly 包使用的 dsh 版本互不影响。

启动外部 Host：

```sh
pnpm --dir packages/host exec dsh --profile mayfly-host-dev --no-open
```

把唯一就绪行中的身份验证 URL 复制到第二个终端的环境变量中；切勿将其放入 argv 或提交到 Git：

```sh
MAYFLY_DSH_STARTUP_URL='<authenticated-url>' pnpm run scenario hostConversation
```

修改源代码后，运行 `pnpm run build:changed` 并重启 Host。修改 manifest 依赖后，运行 `pnpm install`；已有的 profile 链接会保持有效。

## 已安装 profile

当 `@deepseek-ai/dsh` `0.2.2-alpha.2` 和已发布的 `@ephemeral-ai/mayfly-host` 可用时，生产路径使用相同的 bundle 机制，但不使用 `link:`、工作区内的 CLI 或工作区内的 home：

```sh
dsh --profile mayfly-host --from-default-profile web --dump-default-config >/dev/null
dsh plugin --profile mayfly-host add @ephemeral-ai/mayfly-host
dsh --profile mayfly-host --no-open
```

初始化命令会替换已有的自定义 profile，因此仅应在创建或明确需要重置该 profile 时使用。
