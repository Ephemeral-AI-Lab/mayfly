# Right Inspector 示例

这是一个 opt-in Mayfly 插件，向公开 `right` pane lane 贡献上下文检查器；
窄视口下由宿主将它降级到 `bottom`。

把它组合进一个 TUI 入口；入口接受与 `mayfly` 相同的选项和环境变量：

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as inspector from '@mayfly-example/right-inspector'

await run(process.argv.slice(2), { plugins: [inspector] })
```

pane 只使用公开 API/UI 包与共享示例 Kit；包 Fiber 卸载后贡献立即消失。
