# Overlay 示例

这是一个通过原生 `ctx.commands` 提供 `/example-overlay` 的 opt-in Mayfly
插件。命令直接通过 `ctx.mayflyOverlays` 打开 capturing modal，并通过原生
`ctx.settings` 编辑插件自己的 `mayfly-example-overlay` namespace。

Connection 与 Workspace 页面分别保留草稿。Save 携带原生 descriptor revision
提交修改路径；后台更新保留编辑内容并展示冲突。Cancel 使用 Mayfly 共享的未保存
修改确认。插件只提供 readonly snapshot 和结构化 action 回执，草稿、焦点、导航、
提交锁和 modal 边框都由 Mayfly 持有。

```sh
dsh plugin --profile mayfly-dev add @mayfly-example/overlay
```

包卸载时，命令、namespace、观察者和 overlay 都随插件 Fiber 清理；下次加载会重新
读取已保存的设置。
