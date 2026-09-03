# 示例目录

仓库提供一个共享 UI kit 和五个可运行的普通 Cordis 插件：

| 包 | 直接依赖 | 展示 |
| --- | --- | --- |
| `mayfly-user-kit` | `mayfly-ui` library | 可复用 `defineMayflyComponent` |
| `header` | `mayflyPanes` | header lane |
| `right-inspector` | `mayflyPanes` | right lane 与窄屏 bottom fallback |
| `bottom-log` | `mayflyPanes` | passive bottom lane |
| `overlay` | `commands`, `mayflyOverlays` | 原生 command 打开 capturing overlay |
| `ui-gallery` | `mayflyPanes` | 公共 node builder 展示 |

`@mayfly-example/ecosystem` 通过五条普通 Cordis row 一次启用五个
runtime 示例：

```sh
dsh plugin --profile mayfly-examples add @ephemeral-ai/mayfly
dsh plugin --profile mayfly-examples add @mayfly-example/ecosystem
dsh --profile mayfly-examples
```

示例证明 package entry、direct `inject`、renderer-neutral output、Fiber
unload、publish-shaped pack/install 和窄宽渲染。它们不进入 Mayfly 默认 bundle。
