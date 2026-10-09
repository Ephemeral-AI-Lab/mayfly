# Public UI kit

`@ephemeral-ai/mayfly-ui` is the pure renderer-neutral construction layer. It
exports `ui`, `defineMayflyComponent()`, and all of its wire types. It has no
Cordis plugin, service registration, or terminal dependency.

```ts
import { ui } from '@ephemeral-ai/mayfly-ui'

const node = ui.surface({
  title: 'Build',
  child: ui.stack.column([
    ui.text('healthy', { tone: 'success' }),
    ui.progress({ value: 42, max: 100, label: 'Context' }),
  ]),
})
```

Builders clone caller data and deeply freeze their result. Cycles throw. Core
still owns final schema, quota, control-character, and width admission.

## Reusable components

```ts
import { defineMayflyComponent, ui } from '@ephemeral-ai/mayfly-ui'

export const summaryMetric = defineMayflyComponent<{
  label: string
  value: string
}>({
  id: '@acme/summary-metric',
  render: props => ui.richText([
    { text: props.label, tone: 'muted' },
    { text: ` ${props.value}`, tone: 'accent', emphasis: 'strong' },
  ]),
})
```

`defineMayflyComponent` validates only id and render, then deeply freezes each
rendered node. It does not register a node kind or bind a Fiber.

With `memo: true`, a call whose props are shallowly equal to the previous call's
returns the same frozen node, so Mayfly's identity caches skip validation,
compilation, and painting of the unchanged subtree. Shallow equality compares
each prop by reference: a prop that is rebuilt on every call (a new closure, an
inline array or object) never hits. The usual culprit is the translator.
Components take it as a prop typed `MayflyTranslate` (a type-only export of
`@ephemeral-ai/mayfly-ui`, `(key, values?) => string`), and the owner must pass
the same function until the locale revision changes.

```ts
import { defineMayflyComponent, ui, type MayflyTranslate } from '@ephemeral-ai/mayfly-ui'

export const modelList = defineMayflyComponent<{ t: MayflyTranslate, names: readonly string[] }>({
  id: '@acme/model-list',
  memo: true,
  render: ({ t, names }) => ui.list({
    id: 'models',
    role: 'choose',
    items: names.map(name => ({ id: name, label: name, detail: t('{size} context', { size: '128K' }) })),
  }),
})
```

A component kit is an ordinary npm library and cannot change Mayfly by itself.
Consumer plugins place rendered output in `mayflyPanes`, `mayflyStatus`,
`mayflyOverlays`, or `mayflyEditorExtensions`.
