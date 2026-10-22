# Status bar

`ctx.mayflyStatus.register(definition, initialNode)` publishes immutable status snapshots.

```ts
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'

export const inject = ['mayflyStatus']

export function apply(ctx: Context): void {
  let healthy = true
  const status = ctx.mayflyStatus.register({
    id: 'acme.health',
    priority: 30,
    band: 'right',
    row: 1,
    overflow: 'hide',
  }, ui.text('healthy', { tone: 'success' }))

  ctx.on('acme/health-changed', value => {
    healthy = value
    status.set(ui.text(healthy ? 'healthy' : 'failed', {
      tone: healthy ? 'success' : 'danger',
    }))
  })
}
```

Status nodes are non-interactive and sort by priority then id. `set(null)`
releases the slot; `set(node)` clones and freezes the snapshot, increments its
revision, and invalidates only the footer host. `dispose()` removes the entry,
and Fiber unload disposes it automatically.
