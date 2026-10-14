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

A status entry is a passive chip. When the row is crowded it can fall back to narrower forms: publish
`ui.shed(full, [{ rank, node }])` and the row gives the forms up in rank order (lowest first, across every shed entry; a `null`
form hides the entry) before it admits by priority. To give a chip its own panel, register a view instead: a
[`views` pane](/en/plugins/ui-reference#views-of-status-row-2) puts its `summary` in the status row and opens its panel on `Alt+↓`.
