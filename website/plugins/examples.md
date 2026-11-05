# 示例目录

仓库提供一个共享 UI kit 和五个可运行的普通 Cordis 插件：

| 包 | 直接依赖 | 展示 |
| --- | --- | --- |
| `mayfly-user-kit` | `mayfly-ui` library | 可复用 `defineMayflyComponent` |
| `header` | `mayflyPanes` | header lane |
| `right-inspector` | `mayflyPanes` | right lane 与窄屏 bottom fallback |
| `bottom-log` | `mayflyPanes` | passive bottom lane |
| `overlay` | `mayflyEditorExtensions`, `mayflyOverlays` | 编辑器动作打开 capturing 设置 overlay |
| `ui-gallery` | `mayflyPanes` | 公共 node builder 展示 |

这些示例是模拟发布形态的 package 与 renderer fixture。每个插件都是普通 Cordis
模块，由 TUI 组合传给 `run(argv, { plugins })`；`mayfly-ecosystem` 把五个插件组合成
`mayfly-ecosystem` 命令。示例都不提供 dsh bundle：TUI 的树提供四个 UI service，没有
原生 dsh service，因此 `overlay` 示例把设置保存在自己的 Fiber 中。

示例证明 package entry、direct `inject`、renderer-neutral output、Fiber
unload、publish-shaped pack/install 和窄宽渲染。它们不进入 Mayfly 默认组合。
