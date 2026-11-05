# Bottom Log 示例

这是一个 opt-in Mayfly 插件，向公开 `bottom` pane lane 贡献小型被动活动日志。

把它组合进一个 TUI 入口；入口接受与 `mayfly` 相同的选项和环境变量：

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as bottomLog from '@mayfly-example/bottom-log'

await run(process.argv.slice(2), { plugins: [bottomLog] })
```

示例没有 timer 或后台 reader；真实插件应在 `render()` 之外更新 domain 状态，
再通过 pane registration 的 `set(node, { reason: 'data' })` 发布新 snapshot。
