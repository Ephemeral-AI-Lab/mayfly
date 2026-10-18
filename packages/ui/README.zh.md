# @ephemeral-ai/mayfly-ui

Mayfly 公共 UI wire format 的纯 renderer-neutral builder。`ui` namespace 先递归克隆
调用方数据，再构造与插件手写对象形状完全一致的深冻结 `MayflyUiNode`，覆盖全部内容
leaf、flex/viewport child、横纵 stack、surface、scroll、显式 Markdown/Mermaid node、
结构化 chart、controlled pattern、
progress、spacer 与 divider。普通 node 可直接进入 stack；只有需要 child layout
metadata 时才使用 `ui.child`。

调用方持有的数据始终被隔离。本模块已创建的快照可在 builder 和 registry 更新间
共享，不重复克隆其不可变子树；任意外部冻结对象不会获得这项优化。
Wire 数据不能包含循环引用或访问器属性，getter 会被拒绝而不会执行。
即使调用方之后修改原始 definition，注册身份也保持不变。

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

## Compose

`compose` 是所有可见 UI 的统一分层外壳：

```ts
import { compose, ui } from '@ephemeral-ai/mayfly-ui'

const surface = compose.panel({
  title: 'Plugins',
  escapeLabel: 'close',
  body: compose.browser({
    list: ui.list({ id: 'plugins', role: 'browse', selectedIds: [], items: [] }),
    detail: ui.text('Select a plugin'),
  }),
})
```

`panel` 是命令 Panel（`overlay` 边框，占 editor 槽）。`decisionLane` 是所有 Agent 请求共用的一条 lane；
`decisionStrip` 是用户触发的 Yes/No lane（`y`/`n`，`Esc no`）。`tabs`、`wizard`、`rail`、`browser`、`statusPage` 和
`completionPalette` 只返回 body。`tabs` 是任意页面上的横向 tab；`rail` 是对应的纵向版本，带列间竖线。产品命令面板只用隐藏键：不绘制 Save/Cancel/Close 按钮；多字段表单用最后一个
字段的 `Enter` 和 `Ctrl+S` 保存。

`defineMayflyComponent` 记录带包 namespace 的 id，并深冻结每次
render 的节点。它只是纯 package factory，不是 runtime registry。插件提交展开后的
节点树时，kind、数值、深度、quota 与 renderer 安全仍由 core 验证。

根入口没有副作用；显式 `./provider` 入口持有四个 Fiber-scoped snapshot registry，
handle 通过 `set()` 发布、通过 `dispose()` 移除。snapshot 冻结成功后 revision 才
递增。`set()` 是数据刷新（`reason: 'data'`）或新实例边界
（`reason: 'replace'`，也是唯一能改变 `scope` 的更新）；callback 不自行制造
ack——action handler 返回结构化回执，core 准入后由一次性 publisher 更新原
registration。本包不依赖 Harness、core、pi-tui 或任何终端 runtime。

`ui.markdown(source)`、`ui.diagram(source)` 与 `ui.chart({ chart, ...data })` 只保留
renderer-neutral wire data。Mermaid 与 chart 库由 core 持有；插件无需安装它们，
也不能传入库专有配置。
