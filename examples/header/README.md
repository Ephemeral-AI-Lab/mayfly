# Header pane example

An opt-in Mayfly plugin that places a compact workspace summary in the public
`header` pane lane. It consumes `@mayfly-example/user-kit` and degrades to
hidden when the viewport is narrow.

Compose it into a TUI entry; the entry takes the same options and environment
as `mayfly`:

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as header from '@mayfly-example/header'

await run(process.argv.slice(2), { plugins: [header] })
```

The pane unloads with its Cordis Fiber when the TUI exits.
