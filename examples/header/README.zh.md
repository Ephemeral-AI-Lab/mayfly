# Header Pane 示例

这是一个 opt-in Mayfly 插件，通过公开 `header` pane lane 显示紧凑的工作区
摘要。它消费 `@mayfly-example/user-kit`，在窄视口下按策略隐藏。

把它组合进一个 TUI 入口；入口接受与 `mayfly` 相同的选项和环境变量：

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as header from '@mayfly-example/header'

await run(process.argv.slice(2), { plugins: [header] })
```

TUI 退出时，pane 随 Cordis Fiber 一同清理。
