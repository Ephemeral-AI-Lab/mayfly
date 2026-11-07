# UI gallery example

An opt-in Mayfly plugin that places a static showcase of the public
`@ephemeral-ai/mayfly-ui` builders in the `right` pane lane. Content, rich document,
chart, layout, and pattern demos sit behind a tab strip, and the pane degrades
to the bottom lane when the viewport is narrow. The rich group includes a
Markdown table, Mermaid DAG, line/point plots, grouped/stacked/normalized bars,
a sparkline, and a heatmap.

Compose it into a TUI entry; the entry takes the same options and environment
as `mayfly`:

```ts
import { run } from '@ephemeral-ai/mayfly/bin'
import * as gallery from '@mayfly-example/ui-gallery'

await run(process.argv.slice(2), { plugins: [gallery] })
```

The pane unloads with its Cordis Fiber when the TUI exits.
