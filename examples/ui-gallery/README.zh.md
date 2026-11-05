# UI Gallery 示例

这是一个 opt-in Mayfly 插件，通过公开 `right` pane lane 静态展示
`@ephemeral-ai/mayfly-ui` 的全部公开 builder。Content、Rich、Layout、Patterns 演示
位于 tab strip 之下，在窄视口下按策略降级到 bottom lane。Rich 组包含 Markdown
表格、Mermaid DAG、line/point、grouped/stacked/normalized bar、sparkline 与
heatmap。

把它组合进一个 TUI 入口；入口接受与 `mayfly` 相同的选项和环境变量：

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as gallery from '@mayfly-example/ui-gallery'

await run(process.argv.slice(2), { plugins: [gallery] })
```

TUI 退出时，pane 随 Cordis Fiber 一同清理。
