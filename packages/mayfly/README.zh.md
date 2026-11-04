# `@ephemeral-ai/mayfly`

[English](README.md) | 中文

供独立 Mayfly TUI 使用的共享终端渲染与展示层。通过明确的 renderer、theme、
transcript、editor、configuration 和 status subpath，提供
`@ephemeral-ai/mayfly-remote` 使用的候选 UI 实现。

产品以两个进程运行：装有 `@ephemeral-ai/mayfly-host` 的原生 DeepSeek Harness
Host，以及装有 `@ephemeral-ai/mayfly-remote` 的独立 TUI。
全局 `@ephemeral-ai/mayfly-cli` 启动器负责启动 TUI。
本共享包不提供可安装的 dsh bundle、根插件入口、composition patch 或 preset 载荷。

当前开发分支使用工作区中经过验证的构建：

```sh
DSH_BIN=/path/to/dsh PROFILE=mayfly-split-accept script/install-dev.sh
/path/to/dsh --profile mayfly-split-accept
# 在另一个终端复制 Host 打印的认证 URL：
MAYFLY_DSH_STARTUP_URL='<Host URL>' script/mayfly-remote.sh
```

Host 需要官方 Harness `0.2.2-alpha.3`，模型凭据设置在 Host 上。
TUI 退出时解除连接，session 与运行中的工作仍由 Harness 持有。
修改源码后重新构建工作区。

前端 UI 插件通过 `mayflyPanes`、`mayflyStatus`、`mayflyOverlays` 与
`mayflyEditorExtensions` 贡献渲染无关的节点。Host 插件在 Host 进程内使用
原生 dsh service。共享展示层接受只读事实与结构化 action，不持有原生 Agent
或 Session。

已发布的 `0.1.4-rc.2` 是本实现不可改写的 UI 参照。smoke 测试通过不代表视觉
一致性；验证方式见[分体式验证](../../docs/split-parity-validation.md)。
