# UI Gallery 示例

这是一个 opt-in Mayfly 插件，通过公开 `right` pane lane 静态展示
`@ephemeral-ai/mayfly-ui` 的全部公开 builder。Content、Rich、Layout、Patterns 演示
位于 tab strip 之下，在窄视口下按策略降级到 bottom lane。Rich 组包含 Markdown
表格、Mermaid DAG、line/point、grouped/stacked/normalized bar、sparkline 与
heatmap。

```sh
dsh plugin --profile mayfly-dev add @mayfly-example/ui-gallery
```

包内自带单行 `cordis.patch.yml`，安装即激活；卸载时 pane 随 Cordis Fiber
一同清理。
