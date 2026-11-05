# Right inspector example

An opt-in Mayfly plugin that contributes a context inspector to the public
`right` pane lane. The host moves it to `bottom` on narrow viewports.

Compose it into a TUI entry; the entry takes the same options and environment
as `mayfly`:

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as inspector from '@mayfly-example/right-inspector'

await run(process.argv.slice(2), { plugins: [inspector] })
```

The pane uses only public API/UI packages plus the shared example user kit.
Its contribution disappears when the package Fiber unloads.
