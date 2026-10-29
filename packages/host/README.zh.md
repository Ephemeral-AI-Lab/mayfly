# `@ephemeral-ai/mayfly-host`

[English](README.md) | 中文

Mayfly Host 在完整的 `dsh-web-app` 组合中添加 `mayflyConversation` 会话投影和 `mayflyHost` Remote 命名空间。其 bundle patch 禁用浏览器交接和普通 Web URL 行，并在 Loader 稳定后输出一行经过身份验证的 `mayfly host: <url>` 就绪信息。

独立前端是 `@ephemeral-ai/mayfly-remote`；Host 不内嵌该前端。

## Remote 契约

`capabilities()` 返回协议版本 1 和功能键 `mayflyConversation`、`presentTools`、`followWorkflow`、`gitStatus`、`mcpCatalog`、`toolCatalog`。Session 作用域方法接收 `{ sessionId }`；`presentTools` 接收 `{ entries }`，Gateway 在任何 Agent 查找或激活之前授权所有指定 Session。非 owner 拒绝使用 `remote-access/denied`。普通冷 Session 通过原生 Session Controller 恢复；活跃子 Session 使用其精确的注册 Agent。冷子 Session 无法使用这条普通恢复路径，会返回 `mayflyHost/agent-unavailable`，而不会借用父 Agent 或全局工具视图。

- `presentTools(request, signal)` 接受发生变化的 `sessionId`、`callId`、`updatedSeq`、工具名、原始参数和可选结果内容，返回 `presentations[sessionId][callId] = { updatedSeq, call?, result? }`。重复条目对返回 `gateway/bad-request`。原生 `presentCall`/`presentResult` 输出会分离并通过 JSON 校验；未知工具、 presenter 抛错或非 JSON 视图只把对应视图降级为通用卡片。Tool Definition、回调、Agent、Session 或 Cordis 对象都不会跨越边界。
- `followWorkflow(request, signal)` 返回 Remote 流。首帧是 `{ type: 'baseline', value }`；后续帧是 `{ type: 'replacement', value }`，每帧都携带完整的新 `MayflyWorkflowSnapshot`。`mayflyWorkflow` Session 投影折叠原生 `tool-workflow/*` 记录并提供重连基线；进程内 `workflow/*` 事件只补充阶段和活跃元数据，不形成第二个 workflow 引擎。子 id 始终是 Session id。新 turn 清理已结束 run；中断或恢复的 Session 生命周期把未完成 run 和成员标记为 `interrupted: true`。Client 释放、Peer 取消、服务卸载或精确 Agent 丢失会关闭流并移除监听器；Agent 丢失报告 `mayflyHost/session-stale`。
- `gitStatus(request, signal)` 返回分支、dirty/ahead/behind 和增删行数；树探测失败时返回 `{ branch, unknown: true }`；不在仓库中或分支探测失败时返回 `null`。它只使用精确 Session 的有效 Host 目录。缓存按精确 Agent 和目录隔离，分支 TTL 为 5 秒、状态 TTL 为 15 秒、失败重试 TTL 为 5 秒。每个 Git 进程的超时为 500ms，输出上限为 4MiB。调用方取消会停止进程，而不会把取消转换为空结果。
- `mcpCatalog(request, signal)` 返回 `servers`、`orphanCount` 和 `sessionLive: true`。每个服务器包含 `entryId`、`serverName`、派生 `status`、`registeredCount`、可见 JSON 工具 schema 和 `config: { transport: null, endpoint: null }`。`toolCatalog(request, signal)` 按稳定的名称顺序返回精确 Agent 的可见 schema。目录及其参数 JSON 在构造后冻结，不携带执行或展示回调。

领域错误码为 `mayflyHost/capability-unavailable`、`mayflyHost/agent-unavailable`、`mayflyHost/session-stale` 和 `mayflyHost/session-directory-unavailable`。原生解析还可能返回 `session/not-found`、`session/agent-busy` 或 `session/writer-held`；传输和校验使用标准 `gateway/*` 错误码。异步方法同时响应调用方取消和 Host 服务卸载。DTO 及其嵌套值在发出前冻结。

### 公共 API 限制

dsh `0.2.2-alpha.2` 没有公开已配置 MCP 服务器或传输健康状态的目录。Mayfly 因此只列出可通过已注册工具名称发现的服务器，并将 transport/endpoint 保持为 `null`；不会读取 Loader 条目，也不会发出命令参数、环境变量、请求头、凭据或其他原始 MCP 配置。`synced`/`restricted`/`no-tools` 状态描述工具可见性，而不是连接健康。冷子 Agent 恢复以及 MCP 传输/配置检查需要独立的上游公共 API；这里不复制私有实现。

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
