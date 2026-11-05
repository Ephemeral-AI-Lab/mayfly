# Bottom log example

An opt-in Mayfly plugin that contributes a small passive activity log to the
public `bottom` pane lane.

Compose it into a TUI entry; the entry takes the same options and environment
as `mayfly`:

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as bottomLog from '@mayfly-example/bottom-log'

await run(process.argv.slice(2), { plugins: [bottomLog] })
```

It has no timer or background reader; a real plugin would update domain state
outside `render()` and publish a new snapshot through the pane registration's
`set(node, { reason: 'data' })`.
