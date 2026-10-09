# 公共 UI Kit

`@ephemeral-ai/mayfly-ui` 是纯 renderer-neutral 构造层。它导出 `ui` builder、
`defineMayflyComponent()`，并重导全部 wire type。它没有
Cordis plugin、service registration 或终端依赖。

```ts
import { ui } from '@ephemeral-ai/mayfly-ui'

const node = ui.surface({
  title: 'Build',
  child: ui.stack.column([
    ui.text('healthy', { tone: 'success' }),
    ui.progress({ value: 42, max: 100, label: 'Context' }),
  ]),
})
```

Builder 会克隆调用方数据并深冻结结果；循环引用会抛错。Core 仍负责最终
schema、quota、控制字符与宽度 admission。

## 可复用组件

```ts
import { defineMayflyComponent, ui } from '@ephemeral-ai/mayfly-ui'

export const summaryMetric = defineMayflyComponent<{
  label: string
  value: string
}>({
  id: '@acme/summary-metric',
  render: props => ui.richText([
    { text: props.label, tone: 'muted' },
    { text: ` ${props.value}`, tone: 'accent', emphasis: 'strong' },
  ]),
})
```

`defineMayflyComponent` 只校验 id 与 render 函数，并深冻结每次 render 的
node。它不会注册新 node kind 或绑定 Fiber。

设置 `memo: true` 后，props 与上一次调用浅层相等时会返回同一个冻结 node，
Mayfly 的 identity cache 因而跳过未变子树的校验、编译与绘制。浅层相等按引用
比较每个 prop：每次调用都重新创建的 prop（新的闭包、内联数组或对象）永远不会
命中，最常见的就是翻译函数。组件把它作为类型为 `MayflyTranslate` 的 prop 接收
（`@ephemeral-ai/mayfly-ui` 的纯类型导出，`(key, values?) => string`），
调用方必须在语言 revision 变化之前传入同一个函数。

```ts
import { defineMayflyComponent, ui, type MayflyTranslate } from '@ephemeral-ai/mayfly-ui'

export const modelList = defineMayflyComponent<{ t: MayflyTranslate, names: readonly string[] }>({
  id: '@acme/model-list',
  memo: true,
  render: ({ t, names }) => ui.list({
    id: 'models',
    role: 'choose',
    items: names.map(name => ({ id: name, label: name, detail: t('{size} context', { size: '128K' }) })),
  }),
})
```

组件 kit 是普通 npm library；安装它不会改变 Mayfly。消费插件将 render 结果
放入 `mayflyPanes`、`mayflyStatus`、`mayflyOverlays` 或
`mayflyEditorExtensions`。
