# 公共 UI Kit

`@ephemeral-ai/mayfly-ui` 是纯 renderer-neutral 构造层。它导出 `ui` builder、
`defineMayflyComponent()`，并重导 `@ephemeral-ai/mayfly-ui` 的 wire type。它没有
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

组件 kit 是普通 npm library；安装它不会改变 Mayfly。消费插件将 render 结果
放入 `mayflyPanes`、`mayflyStatus`、`mayflyOverlays` 或
`mayflyEditorExtensions`。
