# Service seam 参考

## dsh 原生

插件直接 inject `commands`、`sessionProjections`、`tools`、`settings`、
`skills`、`sessionController` 等 dsh service。与 `planMode` 同 realm 的插件
也可以直接 inject；根级 UI 插件直接读取 `plan` projection、执行 `/plan`
command。方法签名与返回值不经过 Mayfly 改写。

## Mayfly UI

| Service | 写入 | 消费方 |
| --- | --- | --- |
| `mayflyPanes` | `register(MayflyPaneDefinition, MayflyUiNode)` | core surface renderer |
| `mayflyStatus` | `register(MayflyStatusDefinition, MayflyStatusNode)` | transcript footer |
| `mayflyOverlays` | `open(MayflyOverlayDefinition, MayflyUiNode)` | core overlay renderer |
| `mayflyEditorExtensions` | `register(MayflyEditorExtensionDefinition, MayflyEditorDecoration)` | interaction editor |

`@ephemeral-ai/mayfly-ui` 提供 Context declaration merge 和 contract；
`@ephemeral-ai/mayfly-ui` 提供纯 builder。

## 当前 Agent

`mayflyCurrentAgent.current()` 返回 `Agent | null`；`subscribe(listener)`
立即 replay 当前 selection，并在 revision 变化时通知。插件把当前 Agent 或
`agent.session` 传给原生 dsh service。

## 生命周期

所有 registration 绑定 consumer Fiber。没有专用 admission 阶段、grant、
owner token 或跨 realm proxy。Renderer 暂时卸载时 registry 仍保留当前
definition；renderer 重挂后通过 `list()/subscribe()` 读取。

静态 UI 插件只 inject 它真正需要的 Mayfly service。依赖
`mayflyCurrentAgent` 的插件会在 app/core dependency unload 时按 Cordis
规则一起 unload。
