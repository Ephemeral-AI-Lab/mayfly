# dsh 原生命令

Host 插件注册原生 dsh command。插件依赖
`@deepseek-ai/dsh-commands` 并直接使用 `ctx.commands`。

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-commands'

export const inject = ['commands']

export function apply(ctx: Context): void {
  ctx.commands.register({
    name: 'health',
    description: 'Show build health',
    handler: (_invocation) => ({
      kind: 'success',
      text: 'healthy',
    }),
  })
}
```

这个 entry 运行在 Host。原生 handler 通过 `invocation.agent` 取得所选会话的精确
Agent，再把其 Session 传给 `sessionProjections` 等 Host service。Remote 编辑器发现
该 Session 的原生命令目录，并通过官方 Client transport 分发。Host handler 返回
可序列化 command result，不能直接打开前端本地 overlay。定义、参数与结果以
[Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
为准。

注册随插件 Fiber 卸载。不要把一个 Mayfly UI action 伪装成另一套 command
protocol。
