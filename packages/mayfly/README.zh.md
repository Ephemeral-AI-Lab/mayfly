# `@ephemeral-ai/mayfly`

[English](README.md) | 中文

独立的 Mayfly TUI。它通过官方 HTTP/WebSocket Client 连接装有
`@ephemeral-ai/mayfly-host` 的原生 DeepSeek Harness Host，退出时解除连接；Host
上的 Session 与运行中的工作仍由 Harness 持有。全局 `@ephemeral-ai/mayfly-cli`
启动器负责启动它。本包不提供可安装的 dsh bundle、Host 插件入口、composition
patch 或 preset 载荷。

公共入口为根入口（应用与 `runRemoteFrontend`）、`./client`（官方 Client 层）和
`./bin`（`mayfly` 入口）。

当前开发分支使用工作区中经过验证的构建：

```sh
DSH_BIN=/path/to/dsh PROFILE=mayfly-split-accept script/install-dev.sh
/path/to/dsh --profile mayfly-split-accept
# 在另一个终端复制 Host 打印的认证 URL：
MAYFLY_DSH_STARTUP_URL='<Host URL>' script/mayfly-tui.sh
```

Host 需要官方 Harness `0.2.2-rc.1`，模型凭据设置在 Host 上。修改源码后重新构建
工作区。

TUI 插件在 TUI 自己的 Cordis 树中，通过 `mayflyPanes`、`mayflyStatus`、
`mayflyOverlays` 与 `mayflyEditorExtensions` 贡献渲染无关的节点。源码组合把它们
加入普通启动流程：

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as myPlugin from './my-plugin.ts'

await run(process.argv.slice(2), { plugins: [myPlugin] })
```

Host 插件在 Host 进程内使用原生 dsh service。TUI 插件接受只读事实与结构化
action，不持有原生 Agent 或 Session。

已发布的 `0.1.4-rc.2` 是本实现不可改写的 UI 参照。smoke 测试通过不代表视觉
一致性；验证方式见[分体式验证](../../docs/split-parity-validation.md)。
