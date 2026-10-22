# @ephemeral-ai/mayfly-ui

Pure, renderer-neutral builders for Mayfly's public UI wire format. The `ui`
namespace recursively clones caller data, then creates deeply frozen
`MayflyUiNode` objects with the same shape a plugin can write by hand. It includes
every content leaf, flex and viewport children, row/column stacks, surfaces,
scrolling, explicit Markdown and Mermaid nodes, structured charts, controlled patterns,
progress, spacers, and dividers. Plain nodes can
enter a stack directly; use `ui.child` only when child layout metadata is needed.

```ts
import { defineMayflyComponent, ui } from '@ephemeral-ai/mayfly-ui'

export const metric = defineMayflyComponent<{ label: string, value: number }>({
  id: '@acme/metric',
  render: props => ui.surface({
    title: props.label,
    child: ui.stack.column([
      ui.child(ui.progress({ value: props.value, max: 100 }), {
        grow: 1,
        when: { minWidth: 40 },
      }),
    ]),
  }),
})
```

`defineMayflyComponent` records a package-namespaced id, then deeply freezes
each rendered node. It is a pure package-level factory, not a
runtime registry. Core still validates node kinds, values, depth, quotas, and
renderer safety when a plugin contributes the expanded tree.

The root entry is side-effect free. The explicit `./provider` entry owns the four
Fiber-scoped snapshot registries; handles publish with `set()` and remove with
`dispose()`. A snapshot is frozen before its revision advances. Pane, overlay,
and editor-extension callbacks can mark an event-owned update with
`{ eventRevision: context.revision }`. The package has no dependency on Harness,
core, pi-tui, or a terminal runtime.

`ui.markdown(source)`, `ui.diagram(source)`, and `ui.chart({ chart, ...data })` preserve
only renderer-neutral wire data. Mermaid and chart libraries are core-owned;
plugins do not install them or pass library-specific configuration.
