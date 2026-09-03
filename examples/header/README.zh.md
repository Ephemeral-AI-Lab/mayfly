# Header Pane 示例

这是一个 opt-in Mayfly 插件，通过公开 `header` pane lane 显示紧凑的工作区
摘要。它消费 `@mayfly-example/user-kit`，在窄视口下按策略隐藏。

```sh
dsh plugin --profile mayfly-dev add @mayfly-example/header
```

包内自带单行 `cordis.patch.yml`，安装即激活；卸载时 pane 随 Cordis Fiber
一同清理。
