# @ephemeral-ai/mayfly-ui

Mayfly 公共 UI wire format 的纯 renderer-neutral builder。`ui` namespace 先递归克隆
调用方数据，再构造与插件手写对象形状完全一致的深冻结 `MayflyUiNode`，覆盖全部内容
leaf、flex/viewport child、横纵 stack、surface、scroll、显式 Markdown/Mermaid node、
结构化 chart、controlled pattern、
progress、spacer 与 divider。普通 node 可直接进入 stack；只有需要 child layout
metadata 时才使用 `ui.child`。

```ts
import { defineMayflyComponent, ui } from '@ephemeral-ai/mayfly-ui'

export const metric = defineMayflyComponent<{ label: string, value: number }>({
  id: '@acme/metric',
  render: props => ui.surface({
    title: props.label,
    child: ui.stack.column([
      ui.child(ui.progress({ value: props.value, max: 100 }), {
        grow: 1,
        when: { minWidth: 40 },
      }),
    ]),
  }),
})
```

`defineMayflyComponent` 记录带包 namespace 的 id，并深冻结每次
render 的节点。它只是纯 package factory，不是 runtime registry。插件提交展开后的
节点树时，kind、数值、深度、quota 与 renderer 安全仍由 core 验证。

根入口没有副作用；显式 `./provider` 入口持有四个 Fiber-scoped snapshot registry，
handle 通过 `set()` 发布、通过 `dispose()` 移除。snapshot 冻结成功后 revision 才
递增；pane、overlay 与 editor-extension callback 可用
`{ eventRevision: context.revision }` 标记事件自身的更新。本包不依赖 Harness、
core、pi-tui 或任何终端 runtime。

`ui.markdown(source)`、`ui.diagram(source)` 与 `ui.chart({ chart, ...data })` 只保留
renderer-neutral wire data。Mermaid 与 chart 库由 core 持有；插件无需安装它们，
也不能传入库专有配置。
