# 示例目录

仓库提供一个共享 UI kit 和五个可运行的普通 Cordis 插件：

| 包 | 直接依赖 | 展示 |
| --- | --- | --- |
| `mayfly-user-kit` | `mayfly-ui` library | 可复用 `defineMayflyComponent` |
| `header` | `mayflyPanes` | header lane |
| `right-inspector` | `mayflyPanes` | right lane 与窄屏 bottom fallback |
| `bottom-log` | `mayflyPanes` | passive bottom lane |
| `overlay` | `commands`, `settings`, `mayflyOverlays` | 原生 command 打开 capturing overlay |
| `ui-gallery` | `mayflyPanes` | 公共 node builder 展示 |

这些示例是模拟发布形态的 package 与 renderer fixture。纯 UI entry 可在专用
Remote composition 中做源码集成。`overlay` 同时依赖原生 commands/settings 与
UI，属于私有进程内 fixture；分体实现必须把 Host 读写与前端 overlay 分开，通过官方
Client/Remote DTO 通信。`ecosystem` patch 不能向当前 Host 安装终端 UI。

示例证明 package entry、direct `inject`、renderer-neutral output、Fiber
unload、publish-shaped pack/install 和窄宽渲染。它们不进入 Mayfly 默认 bundle。
