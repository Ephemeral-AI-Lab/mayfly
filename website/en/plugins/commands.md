# Native dsh commands

Host plugins register native dsh commands. Depend on `@deepseek-ai/dsh-commands` and use
`ctx.commands` directly.

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

This entry runs on Host. A native handler receives the exact selected Agent as
`invocation.agent`; pass its Session to Host services such as
`sessionProjections`. The Remote editor discovers that Session's native command
catalog and dispatches through official Client transport. Host handlers return
serializable command results; they cannot open a frontend-local overlay. The
[Harness reference](https://deepseek-harness.github.io/deepseek-harness/reference/)
is authoritative for command definitions, args/options, and results.

Registration follows the plugin Fiber. Do not create a second command protocol
through Mayfly UI actions.
