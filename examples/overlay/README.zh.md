# Overlay 示例

这是一个通过原生 `ctx.commands` 提供 `/example-overlay` 的 opt-in Mayfly
插件。命令直接通过 `ctx.mayflyOverlays` 打开 capturing modal。插件只贡献
renderer-neutral 内容，modal 的单一闭合边框由 Mayfly 统一绘制。

```sh
dsh plugin --profile mayfly-dev add @mayfly-example/overlay
```

包卸载时，命令与 overlay 都随插件 Fiber 清理。
