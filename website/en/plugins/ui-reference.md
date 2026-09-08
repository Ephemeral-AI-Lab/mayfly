# UI node reference

This page documents the complete Public Beta wire-node construction API in
`@ephemeral-ai/mayfly-ui`. A `ui.*` builder only constructs, copies, and freezes
renderer-neutral data. The Mayfly renderer owns validation, layout, themes,
width, focus, input routing, and event dispatch. The plugin still owns domain
data, native effects, and authoritative data snapshots.

> For how node trees are organized and controlled state flows, see the
> companion [Component model](/en/plugins/component-model) guide.

```ts
import type { MayflyUiActionEvent, MayflyUiEventContext, MayflyUiObservationEvent } from '@ephemeral-ai/mayfly-ui'
import { ui } from '@ephemeral-ai/mayfly-ui'
```

## Responsibility boundary

| Mayfly owns | The plugin owns |
| --- | --- |
| Rendering text, tabs, lists, forms, actions, and the other nodes | Node data and product copy |
| Drafts, selections, pages, operations, and feedback for the registration | Domain facts and calls to the owning native service/action |
| Theme mapping, width degradation, focus, and navigation | Data-snapshot baselines, source stamps, and scope |
| Event classification, reply admission, ack publication, and lifecycle fencing | Structured action replies and handle `set()` calls for external data |

Nodes never accept renderer callbacks, raw keys, terminal coordinates, ANSI,
or focus handles. Do not place I/O, Agent, Session, or mutable renderer objects
in a node.

## Shared rules and limits

- A tree may contain at most 256 nodes, with the root at depth 0 and maximum
  depth 8. Any array may contain at most 200 entries. Strings across the tree
  may total at most 20,000 UTF-16 code units.
- Builders recursively copy and freeze inputs and reject cycles. Host admission
  accepts only plain objects and dense arrays and strips ANSI, C1, and unsafe
  control characters.
- Numeric layout fields are non-negative safe integers. `minSize` cannot exceed
  `maxSize`, and viewport minimums cannot exceed their matching maximums.
- Tabs/list/form control ids, form field ids, action item ids, and form/loader
  submit or cancel ids must not collide in one interactive tree. Tab and list
  item ids must at least be unique within their node; ids used as controls
  cannot be empty.
- `tone` is semantic, not a color value:
  `default | muted | accent | success | warning | danger`.
- `emphasis` is `normal | strong`; omission means normal text.

The defaults below describe the current Mayfly TUI in `0.1.0-alpha.4`. The wire
contract promises field semantics, not exact border glyphs, color values, or
key bindings.

### Migrating from alpha.3

- Split `onEvent(event, context)` into `onEvent.observe` and `onEvent.action`.
- Replace `selection-change` with observation `selection-toggle` or action
  `selection-accept`; every event carries `pagePath`.
- Remove plugin-owned form/tab/list drafts, pending confirmation, and renderer
  cursors. Node values are initial/data baselines.
- Return a structured settlement from every action handler. Read submitted
  forms and selections from `event.submission`, not a flat `values` object.
- Remove `set(node, { eventRevision })`. Use `reason: 'data'` for external
  refresh and `reason: 'replace'` for a new instance. Only the
  registration-bound publisher creates acknowledgements.

## Content nodes

### `text`

![`text` node rendering](/shots/text.svg)

*A single-line hint in the danger tone (width 48).*

```ts
ui.text(content: string, options?: { tone?: MayflyTone })
```

A semantic text block that the renderer may wrap — use it for status hints,
result summaries, and other explanatory copy. An omitted `tone` uses the
theme's normal text color. The screenshot above renders exactly this node:

```ts
ui.text('Connection lost', { tone: 'danger' })
```

All six tones side by side:

![every `text` tone](/shots/text-tones.svg)

*`default`, `muted`, `accent`, `success`, `warning`, and `danger` (width 56).*

```ts
ui.stack.column([
  ui.text('Default body text'),
  ui.text('Muted secondary text', { tone: 'muted' }),
  ui.text('Accent highlight text', { tone: 'accent' }),
  ui.text('Success confirmation text', { tone: 'success' }),
  ui.text('Warning caution text', { tone: 'warning' }),
  ui.text('Danger failure text', { tone: 'danger' }),
])
```

Long text wraps at the allocated width instead of clipping:

![`text` wrapping](/shots/text-wrap.svg)

*The same warning text occupies three rows at width 48.*

```ts
ui.text('A long status message wraps at the allocated width instead of clipping, so narrow panes stay readable.', { tone: 'warning' })
```

### `richText`

![`richText` node rendering](/shots/richText.svg)

*A muted prefix followed by a strong accent model name (width 64).*

```ts
ui.richText(spans: readonly MayflyInlineSpan[])

type MayflyInlineSpan = {
  text: string
  tone?: MayflyTone
  emphasis?: 'normal' | 'strong'
}
```

Combines tone and emphasis within one text block — ideal for "label +
highlighted value" inline mixes. The renderer wraps the text; the plugin must
not assemble ANSI. The screenshot above renders exactly this node:

```ts
ui.richText([
  { text: 'Model ', tone: 'muted' },
  { text: 'deepseek-chat', tone: 'accent', emphasis: 'strong' },
])
```

Tone and emphasis compose into longer mixed passages:

![`richText` tone/emphasis combinations](/shots/richText-mix.svg)

*Muted narration, a strong accent path, a strong number, and a danger tail (width 56).*

```ts
ui.richText([
  { text: 'Rebuild of ', tone: 'muted' },
  { text: 'packages/mayfly', tone: 'accent', emphasis: 'strong' },
  { text: ' failed after ', tone: 'muted' },
  { text: '42s', emphasis: 'strong' },
  { text: ' with 2 errors', tone: 'danger' },
])
```

### `fields`

![`fields` node rendering](/shots/fields.svg)

*Two label/value rows, the status value in the success tone (width 64).*

```ts
ui.fields(rows: readonly {
  label: string
  value: readonly MayflyInlineSpan[]
}[])
```

Represents compact label/value information such as session metadata or an
environment summary. `value` is always an array of spans, not an arbitrary
`MayflyUiNode`. The screenshot above renders exactly this node:

```ts
ui.fields([
  { label: 'Status', value: [{ text: 'Ready', tone: 'success' }] },
  { label: 'Model', value: [{ text: 'deepseek-chat' }] },
])
```

Across multiple rows, each value can compose several spans for emphasis:

![`fields` multi-span values](/shots/fields-spans.svg)

*Four rows: a strong accent session name, a two-tone branch, a composed status, and a muted duration (width 64).*

```ts
ui.fields([
  { label: 'Session', value: [{ text: 'fix-width-scan', tone: 'accent', emphasis: 'strong' }] },
  { label: 'Branch', value: [{ text: 'p2/' }, { text: 'ui-gallery', tone: 'accent' }] },
  { label: 'Status', value: [{ text: 'Running', tone: 'success' }, { text: ' · 2 panes', tone: 'muted' }] },
  { label: 'Elapsed', value: [{ text: '4m 12s', tone: 'muted' }] },
])
```

### `code`

![`code` node rendering](/shots/code.svg)

*A multi-line code block with the `ts` language hint (width 64).*

```ts
ui.code(value: string, options?: { language?: string })
```

Represents code or preformatted text such as patch fragments, command output,
or configuration content. `language` is a renderer hint and does not guarantee
syntax highlighting. The screenshot above renders exactly this node:

```ts
ui.code([
  'export function estimateTokens(text: string): number {',
  '  // Rough heuristic: four characters per token.',
  '  return Math.ceil(text.length / 4)',
  '}',
].join('\n'), { language: 'ts' })
```

### `diff`

![`diff` node rendering](/shots/diff.svg)

*Multi-line before/after: context lines pass through, changed lines are marked `-`/`+` (width 64).*

```ts
ui.diff(before: string, after: string)
```

Represents the semantic before/after states of the same content, such as a
pending edit. Supply plain text rather than manually adding diff colors. The
screenshot above renders exactly this node:

```ts
ui.diff(
  ['export function connect() {', '  const retries = 3', '  return open(retries)', '}'].join('\n'),
  ['export function connect() {', '  const retries = 5', '  return open(retries)', '}'].join('\n'),
)
```

### `sections`

![`sections` node rendering](/shots/sections.svg)

*One expanded section and one collapsed section side by side (width 64).*

```ts
ui.sections(sections: readonly {
  title?: string
  body: MayflySectionContentNode
  collapsed?: boolean
}[])
```

Each `body` is restricted to the lightweight section-content union:
`text | fields | code | diff | sections`. It cannot directly contain tabs,
forms, actions, or another full `MayflyUiNode`.
Omitting `collapsed` is equivalent to `false`. With `true`, the current TUI
shows only the section title, or an ellipsis when no title exists. This is
static presentation state and does not produce an expand/collapse event. The
screenshot above renders exactly this node:

```ts
ui.sections([
  {
    title: 'Environment',
    body: ui.fields([
      { label: 'Node', value: [{ text: 'v24.15.0' }] },
    ]),
  },
  {
    title: 'Raw transcript',
    body: ui.text('Hidden until expanded.'),
    collapsed: true,
  },
])
```

### `markdown` and `diagram`

```ts
ui.markdown(source: string)
ui.diagram(mermaidSource: string)
```

Markdown reuses Mayfly's pi-tui adapter, including tables and fenced code.
Mermaid is rendered as terminal Unicode through `beautiful-mermaid`; closed
`mermaid` fences in assistant messages use the same path. Parse failures,
unsupported or over-wide diagrams, graph/source/output complexity quotas, and
labels containing CJK, emoji, or other full-width characters remain visible as
the original Mermaid code fence. The complexity admission keeps large graphs
from blocking the terminal render loop. Diagrams are never wrapped or
truncated.

```ts
ui.diagram('flowchart TD\n  Request --> Validate\n  Validate --> Result')
```

`markdown` and `diagram` are available in ordinary panes and overlays.
It is not a status, editor-extension, or `sections.body` node.

### `chart`

`chart` carries data rather than renderer options. Mayfly adapts it through
`simple-ascii-chart`, maps semantic tones through the active theme, and falls
back to a bounded textual summary when a chart cannot fit.

```ts
ui.chart({
  chart: 'line' | 'point',
  title?: string,
  xLabel?: string,
  yLabel?: string,
  height?: number, // 4..20
  series: [{
    id: string,
    label?: string,
    tone?: MayflyTone,
    points: [{ x: number, y: number | null }],
  }],
})

ui.chart({
  chart: 'bar',
  layout?: 'grouped' | 'stacked' | 'normalized',
  title?: string,
  yLabel?: string,
  height?: number, // 4..20
  categories: readonly string[],
  series: [{ id: string, label?: string, tone?: MayflyTone, values: readonly (number | null)[] }],
})

ui.chart({ chart: 'sparkline', values: [2, 4, null, 7], label: 'Load', tone: 'warning' })

ui.chart({
  chart: 'heatmap',
  columns: ['Linux', 'macOS'],
  rows: ['Node 22'],
  values: [['pass', 'fail']],
  levels: [
    { value: 'pass', label: 'Passed', tone: 'success' },
    { value: 'fail', label: 'Failed', tone: 'danger' },
  ],
})
```

Values must be finite; `null` marks missing data. Series ids and heatmap level
values are unique, bar values match the category count, and heatmap dimensions
match their row/column labels. Each chart accepts at most 20 series, and one
tree accepts at most 4,000 chart cells. Like `document`, `chart` is available
in ordinary panes and passive or capturing overlays, not in narrower status,
status, editor-extension, or section-content trees.

## Layout nodes

### `child`

![`child` node rendering](/shots/child.svg)

*Width 64 satisfies `minWidth: 48`, so the detail renders.*

```ts
ui.child(node: MayflyUiNode, options?: {
  basis?: number | 'auto'
  grow?: number
  shrink?: number
  minSize?: number
  maxSize?: number
  when?: {
    minWidth?: number
    maxWidth?: number
    minHeight?: number
    maxHeight?: number
  }
})
```

Plain nodes can enter a stack directly. Wrap a node in `ui.child()` only when
it needs sizing hints or a responsive condition. Sizes are hints along the
current stack direction, not fixed terminal row or column promises. `when`
uses the actual viewport allocated to the current surface. When a condition
stops matching, the node and its controls leave the tree and Mayfly reconciles
focus. A `child` is only valid as a stack member; both screenshots render
exactly this node:

```ts
ui.stack.column([
  ui.text('Session overview'),
  ui.child(ui.text('Wide-only detail'), { grow: 1, when: { minWidth: 48 } }),
])
```

The same node at width 40: the condition no longer holds, the detail leaves
the tree, and only the heading row remains:

![`child` hidden at narrow width](/shots/child-hidden.svg)

*Width 40 fails `minWidth: 48`; `Wide-only detail` leaves the tree.*

### `stack.row` / `stack.column`

![`stack` node rendering](/shots/stack.svg)

*A row with a gap nested inside a column (width 64).*

```ts
ui.stack.row(children, options?)
ui.stack.column(children, options?)

type StackOptions = {
  gap?: 0 | 1 | 2
  align?: 'stretch' | 'start' | 'center' | 'end'
}
```

`row` expresses horizontal placement and `column` expresses vertical
placement. The current TUI uses gap 0 and stretch alignment when omitted. A
renderer may safely degrade spatial layout on a surface without spatial
layout, so do not depend on absolute child coordinates. The screenshot above
renders exactly this node:

```ts
ui.stack.column([
  ui.stack.row([ui.text('left'), ui.text('right')], { gap: 1 }),
  ui.text('below'),
])
```

Combined with `ui.child()`'s `grow`, a row splits its width proportionally:

![`stack` grow proportions](/shots/stack-grow.svg)

*`grow: 1` and `grow: 2` split the row width 1:2 (width 64).*

```ts
ui.stack.row([
  ui.child(ui.surface({ chrome: 'lane', child: ui.text('grow 1') }), { grow: 1 }),
  ui.child(ui.surface({ chrome: 'lane', child: ui.text('grow 2') }), { grow: 2 }),
], { gap: 1 })
```

### `surface`

![`surface` node rendering](/shots/surface.svg)

*Title, subtitle, badges, `surface` border chrome, padding, and a footer in one container (width 64).*

```ts
ui.surface({
  title?: string
  subtitle?: string
  badges?: readonly MayflyInlineSpan[]
  chrome?: 'none' | 'lane' | 'surface' | 'overlay'
  padding?: 0 | 1 | 2
  child: MayflyUiNode
  footer?: MayflyUiNode
})
```

`surface` combines heading metadata, body content, and an optional footer.

| Field | Meaning |
| --- | --- |
| `title` | Primary heading |
| `subtitle` | Muted supporting line after the heading |
| `badges` | Badge line built from semantic spans |
| `chrome` | Border intent; defaults to `none` |
| `padding` | Content inset level; defaults to `0` |
| `child` | Required body |
| `footer` | Optional node between the body and bottom border |

`chrome: 'overlay'` is only a visual intent. It does not create an overlay;
use `api.overlays.open()` for the actual surface. When that surface is the
registration root, core coalesces it with the registration title into one
frame. Ordinary overlays and `presentation: 'editor'` both honor `maxHeight`,
defaulting to at most one third of the terminal height. Short content keeps its
natural height instead of stretching to that limit. The screenshot above
renders exactly this node:

```ts
ui.surface({
  title: 'Settings',
  subtitle: 'Profile mayfly-dev',
  badges: [{ text: 'alpha', tone: 'accent' }],
  chrome: 'surface',
  padding: 1,
  child: ui.fields([
    { label: 'Model', value: [{ text: 'deepseek-chat' }] },
  ]),
  footer: ui.text('Footer note', { tone: 'muted' }),
})
```

`chrome: 'lane'` is the lighter variant: the title sits inside a top rule with
no full border:

![`surface` lane chrome](/shots/surface-lane.svg)

*Lane chrome: the title embedded in a top rule (width 64).*

```ts
ui.surface({
  title: 'Context',
  chrome: 'lane',
  child: ui.text('Lane chrome body'),
})
```

### `scroll`

![`scroll` node rendering](/shots/scroll.svg)

*Sixteen lines in an eight-row viewport after scrolling down three rows, with the `scrollbar: true` thumb visible (width 56).*

```ts
ui.scroll(node: MayflyUiNode, options?: {
  id?: string
  follow?: 'none' | 'start' | 'end'
  scrollbar?: boolean
})
```

`follow` expresses the desired position after refresh; omission behaves as
`none`. With an `id`, the frontend owner stores a semantic content-block and
character-offset anchor, so data insertion, width changes, and renderer rebuilds
restore the same position. `follow: 'end'` stays attached to appended content.
Interactive surfaces in both main and alternate modes use the height supplied
by their parent layout. A passive main-mode transcript scroll is linearized and
delegated to the outer transcript viewport. `scrollbar: true` requests a visible
scrollbar. Nested scroll nodes are rejected.
The screenshot above renders exactly this node:

```ts
ui.scroll(
  ui.stack.column(Array.from({ length: 16 }, (_, index) => ui.text(`log line ${index + 1}`))),
  { scrollbar: true },
)
```

## Controlled interactive nodes

The plugin supplies a readonly baseline and action declarations. Mayfly's
frontend owner keeps drafts, selections, pages, decisions, operations, and
feedback for each registration instance. The renderer projects that state and
emits semantic events. Plugins publish external domain changes as data snapshots
and settle native actions with structured replies.

### `tabs`

![`tabs` node rendering](/shots/tabs.svg)

*Initial state: `activeId: 'summary'`, a count badge on advanced, and a disabled legacy tab (width 64).*

```ts
ui.tabs({
  id: string
  activeId: string
  mode?: 'tabs' | 'wizard'
  items: readonly {
    id: string
    label: string
    disabled?: boolean
    count?: number
    backId?: string
  }[]
})
```

- `activeId` must name an item and supplies the initial or data-snapshot
  baseline. The Mayfly instance keeps the current active page.
- A disabled item remains visible but cannot be activated.
- `count` is a non-negative safe-integer hint that a renderer may hide at
  narrow widths.
- `mode: 'wizard'` records completed steps against validated form revisions;
  edits or conflicts invalidate completion.
- `backId` declares a return target in the same group. Admission rejects missing
  targets and cycles.
- Tabs render only the tab strip. Associate bodies with
  `ui.child(node, { tab })`.
- Activating an item sends a `tab-change` fact with its `pagePath` to
  `onEvent.observe`. The plugin does not echo a snapshot to switch pages.

```ts
ui.stack.column([
  ui.tabs({
    id: 'settings-tabs',
    activeId: 'summary',
    items: [
      { id: 'summary', label: 'Summary' },
      { id: 'advanced', label: 'Advanced', count: 4 },
      { id: 'legacy', label: 'Legacy', disabled: true },
    ],
  }),
  ui.child(ui.text('Summary content'), { tab: { controlId: 'settings-tabs', itemId: 'summary' } }),
  ui.child(ui.text('Advanced content'), { tab: { controlId: 'settings-tabs', itemId: 'advanced' } }),
])
```

After the user selects advanced, the strip and associated body project the
same frontend page state:

![`tabs` after switching](/shots/tabs-active.svg)

*`activeId: 'advanced'`: the count badge rides the highlighted item and the body switches (width 64).*

```ts
ui.stack.column([
  ui.tabs({
    id: 'settings-tabs',
    activeId: 'advanced',
    items: [
      { id: 'summary', label: 'Summary' },
      { id: 'advanced', label: 'Advanced', count: 4 },
      { id: 'legacy', label: 'Legacy', disabled: true },
    ],
  }),
  ui.text('Advanced content'),
])
```

### `list`

![`list` node rendering](/shots/list.svg)

*Single mode with the first item selected (width 64).*

```ts
ui.list({
  id: string
  mode?: 'single' | 'multiple'
  role: 'browse' | 'choose'
  selectedIds: readonly string[]
  items: readonly MayflyListItem[]
  filter?: string
  filterable?: boolean
  tree?: boolean
  minSelected?: number
  maxSelected?: number
  acceptActionId?: string
  empty?: MayflyUiNode
})

type MayflyListItem = {
  id: string
  label: string
  detail?: string
  detailSpans?: readonly MayflyInlineSpan[]
  badge?: string
  group?: string
  disabled?: boolean
  disabledReason?: string
  parentId?: string
  searchText?: string
}
```

`role: 'browse'` opens or inspects entries; `role: 'choose'` submits a choice.
`mode` defaults to `single`. Single mode permits at most one selected id, and
every selected id must exist in `items`. `detailSpans` takes precedence over
`detail`. `group` is a grouping heading and `badge` is a compact label. A
renderer may hide detail at narrow widths. The screenshot above renders
exactly this node:

```ts
ui.list({
  id: 'item-list',
  role: 'browse',
  selectedIds: ['one'],
  items: [
    { id: 'one', label: 'First item' },
    { id: 'two', label: 'Second item' },
  ],
})
```

`filterable: true` enables shared search, while `filter` supplies its initial
query. Mayfly matches and focuses the supplied items without starting network
work. `tree: true` combines with `parentId` for shared expansion state. Large
item arrays validate and render only around the current window. Empty items
render the optional `empty` node.

Multiple mode combines with `group`, `badge`, `detail`, and `disabled` for
richer pickers:

![`list` in multiple mode](/shots/list-multiple.svg)

*Multiple mode: two group headings, badges, a detail, and one disabled item (width 64).*

```ts
ui.list({
  id: 'plugin-list',
  role: 'choose',
  mode: 'multiple',
  selectedIds: ['context'],
  items: [
    { id: 'context', label: 'Context', group: 'Official', badge: 'core' },
    { id: 'remote', label: 'Remote', group: 'Official', detail: 'Session transport' },
    { id: 'lark', label: 'Lark', group: 'Optional', badge: 'notify', disabled: true },
  ],
})
```

Selection changes send `selection-toggle` and the complete `selectedIds` to
`onEvent.observe`. Explicit acceptance sends `selection-accept` to
`onEvent.action`. An action may also declare `selections` so immutable action
inputs contain the current selection with submitted forms.

### `form`

![`form` node rendering](/shots/form.svg)

*Common field kinds in their default state: the secret value is masked, the select shows its current value, and the toggle shows its switch (width 64).*

```ts
ui.form({
  id: string
  fields: readonly MayflyFormField[]
  submitActionId?: string
  cancelActionId?: string
})
```

A form field is this discriminated union:

| `kind` | Required fields | Optional fields | `value-change` value |
| --- | --- | --- | --- |
| `input` | `id`, `label`, `value: string` | `placeholder`, `error`, `disabled` | `string` |
| `textarea` | Same as input | Same as input | `string` |
| `secret` | Same as input | Same as input; renderer masks value | `string` |
| `number` | `id`, `label`, `value: number \| null` | `min`, `max`, `step`, `unit` | a `string` draft while editing |
| `select` | `id`, `label`, `value: string \| null`, `options: MayflyListItem[]` | `error`, `disabled` | `string \| null` |
| `multiselect` | `id`, `label`, `value: string[]`, `options` | `minSelected`, `maxSelected` | `string[]` |
| `toggle` | `id`, `label`, `value: boolean` | `error`, `disabled` | `boolean` |

The screenshot above renders exactly this node:

```ts
ui.form({
  id: 'profile-form',
  fields: [
    { kind: 'input', id: 'name', label: 'Name', value: 'Ada' },
    { kind: 'textarea', id: 'bio', label: 'Bio', value: 'Compiler tinkerer' },
    { kind: 'secret', id: 'token', label: 'Token', value: 'sk-live-9f27' },
    { kind: 'select', id: 'theme', label: 'Theme', value: 'dark', options: [
      { id: 'dark', label: 'Dark' },
      { id: 'light', label: 'Light' },
    ] },
    { kind: 'toggle', id: 'updates', label: 'Auto-update', value: true },
  ],
  submitActionId: 'Create profile',
  cancelActionId: 'Cancel',
})
```

The Mayfly frontend instance retains text drafts and sends `value-change` with a
field revision to `onEvent.observe` for optional asynchronous validation. The
plugin does not echo each keystroke as a snapshot. When an authoritative data
snapshot changes, the model reconciles untouched values, drafts, and conflicts.
Focused text fields remain in navigation until typing or Enter starts editing.
Enter advances from a single-line input; Enter or Alt+Enter inserts a textarea
newline.

In the form below, focusing the Name field and typing `Ada Lovelace` leaves a
draft. The shot shows the draft text and the
cursor that this interaction sequence produces:

![`form` text editing](/shots/form-editing.svg)

*Edit mode: the draft renders live with the cursor at the end of the text (width 64).*

```ts
ui.form({
  id: 'profile-form',
  fields: [
    { kind: 'input', id: 'name', label: 'Name', value: '' },
    { kind: 'toggle', id: 'updates', label: 'Auto-update', value: true },
  ],
  submitActionId: 'Create profile',
})
```

Enter opens a shared Choice picker for select fields. Left/Right moves semantic
focus, Enter accepts a single option, and Space toggles a multiselect option.
Escape discards the picker and stays on the field. Tab also discards an
unconfirmed picker adjustment, then moves to the next semantic group. The
picker draft survives renderer rebuilds.

In the form below, pressing Enter on the Theme field opens the adjustment
state and one Right step moves the candidate to Light — `‹ Light ›` is the
adjustment presentation:

![`form` select adjustment](/shots/form-select.svg)

*Adjustment state: `‹ Light ›` is the shared picker's semantic focus; Enter writes it into the field draft (width 64).*

```ts
ui.form({
  id: 'profile-form',
  fields: [
    { kind: 'input', id: 'name', label: 'Name', value: 'Ada' },
    { kind: 'select', id: 'theme', label: 'Theme', value: 'dark', options: [
      { id: 'dark', label: 'Dark' },
      { id: 'light', label: 'Light' },
    ] },
  ],
  submitActionId: 'Create profile',
})
```

`error` shows a validation message under the field; disabled fields do not
enter focus navigation but remain in the submitted form. Required, length,
numeric, and selection constraints run before an action starts. `origin` and
`resetValue` produce shared override/reset tools:

![`form` error and disabled states](/shots/form-validation.svg)

*Name carries an `error` message; Email is `disabled` and skipped by focus navigation (width 64).*

```ts
ui.form({
  id: 'profile-form',
  fields: [
    { kind: 'input', id: 'name', label: 'Name', value: '', error: 'Name is required' },
    { kind: 'input', id: 'email', label: 'Email', value: 'ada@example.com', disabled: true },
  ],
  submitActionId: 'Create profile',
})
```

`submitActionId` adds a submit control. An action's declared `submit` addresses
collect one or more forms across pages and lock that action boundary:

```ts
{
  kind: 'submit',
  controlId: form.id,
  pagePath: [],
  submission: {
    actionId: 'save',
    draftRevision: number,
    source: [{ resourceId: 'settings', revision: 3 }],
    forms: [{ pagePath: [], formId: form.id, draftRevision: number, fields: [
      { id: 'name', change: 'set', value: 'Ada' },
    ] }],
  },
}
```

`cancelActionId` adds a shared close control. A dirty form first opens the
default-No discard decision.

### `actions`

![`actions` node rendering](/shots/actions.svg)

*The three intents: primary, secondary, and a danger item carrying a confirm prompt (width 64).*

```ts
ui.actions({
  id: string
  items: readonly {
    id: string
    label: string
    intent?: 'primary' | 'secondary' | 'danger'
    disabled?: boolean
    disabledReason?: string
    busy?: boolean
    confirm?: string
    submit?: readonly MayflyFormAddress[]
    read?: readonly MayflyFormAddress[]
    selections?: readonly MayflySelectionAddress[]
    defaultFocus?: boolean
    dismiss?: boolean
    navigate?: MayflyPagePath
  }[]
})
```

Activating an enabled item sends `activate` with `actionId`, `controlId`, and
`pagePath` to `onEvent.action`.
Disabled and busy items cannot activate; busy also communicates in-progress
presentation. An action with `confirm` requires explicit Yes in a shared
default-No decision; Escape or No returns to the original surface.
`intent` communicates semantic priority; the theme owns its appearance. The
outer `actions.id` identifies the group, while an event's `controlId` is the
activated item's `id`. Both screenshots render exactly this node:

```ts
ui.actions({
  id: 'session-actions',
  items: [
    { id: 'save', label: 'Save', intent: 'primary' },
    { id: 'archive', label: 'Archive', intent: 'secondary' },
    { id: 'discard', label: 'Discard', intent: 'danger', confirm: 'Discard all changes?' },
  ],
})
```

Enter on the danger item opens the shared Yes/No decision with No focused.
Only Yes emits the original action:

![`actions` pending confirmation](/shots/actions-confirm.svg)

*Pending confirmation: `Discard all changes?` is a shared default-No decision (width 64).*

`busy` marks an in-progress action and `disabled` an unavailable one; neither
can activate:

![`actions` busy and disabled](/shots/actions-busy.svg)

*The busy item shows an in-progress ellipsis; the disabled item stays visible but cannot activate (width 64).*

```ts
ui.actions({
  id: 'session-actions',
  items: [
    { id: 'deploy', label: 'Deploy', intent: 'primary', busy: true },
    { id: 'retry', label: 'Retry', disabled: true },
    { id: 'cancel', label: 'Cancel' },
  ],
})
```

## Focus and contextual hints

The TUI derives operations directly from canonical control roles. Plugins
should not repeat generic keyboard teaching in a surface footer:

- Focus descends through outer tabs → nested tabs → content groups → editing.
- A tab strip uses non-wrapping Left/Right and Enter to descend. Tab/Shift-Tab
  is inert on tab strips and cycles semantic groups only in content, remembering
  the last focused item in each group.
- Directional content movement does not wrap and disabled items cannot receive
  focus. Single lists activate with Enter; multiple lists toggle with Space and
  confirm with Enter; actions accept Enter or Space.
- Text/select editing confirms with Enter, while invalid input stays active.
  Tab retains text drafts but discards an unconfirmed select adjustment before
  moving to the next semantic group. Escape climbs editing → content → nested
  tabs → outer tabs → close, one layer at a time.
- A pending action confirmation changes the hint to `Enter confirm · Esc
  cancel`. Read-only scroll regions are focusable and support arrows, Page,
  Home, and End.

The row appears only while a plugin pane owns focus or a capturing overlay is
open. Escape is advertised only for a surface that can actually close; passive
panes and non-capturing overlays do not show a false operation. At most three
semantic fragments are shown. Narrow layouts first use complete compact key
tokens, then remove whole fragments rather than clipping half an instruction.
Local counts, progress, risk, and business status still belong in the footer.

## Feedback and utility nodes

### `loader`

![`loader` node rendering](/shots/loader.svg)

*The default braille variant with the elapsed hint and a cancel control (width 64).*

```ts
ui.loader({
  message: string
  variant?: 'braille' | 'tide'
  elapsedMs?: number
  cancelActionId?: string
})
```

`variant` defaults to `braille`. `elapsedMs` is a non-negative millisecond
hint. The owning lifecycle manages animation timers; never start one in
`render()`. A `cancelActionId` adds a control that emits `activate`. The
screenshot above renders exactly this node:

```ts
ui.loader({
  message: 'Waiting for model',
  elapsedMs: 1200,
  cancelActionId: 'Stop',
})
```

The `tide` variant replaces the braille dots with a wave glyph:

![`loader` tide variant](/shots/loader-tide.svg)

*The tide variant (width 64).*

```ts
ui.loader({
  message: 'Syncing dependencies',
  variant: 'tide',
  elapsedMs: 4200,
})
```

### `empty`

![`empty` node rendering](/shots/empty.svg)

*A no-data state with the actions slot filled (width 64).*

```ts
ui.empty({
  title: string
  description?: string
  actions?: MayflyActionsNode
})
```

Represents an empty result or no-data state. `actions` must be the result of
`ui.actions()`. The screenshot above renders exactly this node:

```ts
ui.empty({
  title: 'No sessions yet',
  description: 'Start one to see it here.',
  actions: ui.actions({
    id: 'empty-actions',
    items: [{ id: 'new', label: 'New session', intent: 'primary' }],
  }),
})
```

### `progress`

![`progress` node rendering](/shots/progress.svg)

*A determinate bar with label and count (width 64).*

```ts
ui.progress({ label?: string, value: number, max: number })
```

`value` is a non-negative integer and `max` is an integer of at least 1. Host
admission clamps a value above max to max. At narrow widths a renderer may hide
the label or count while preserving the progress meaning. The screenshot above
renders exactly this node:

```ts
ui.progress({ label: 'Tokens', value: 12_000, max: 28_000 })
```

### `spacer`

![`spacer` node rendering](/shots/spacer.svg)

*One row of semantic whitespace between two text anchors (width 48).*

```ts
ui.spacer(options?: { size?: 1 | 2 })
```

Inserts semantic spacing and defaults to size 1. Do not simulate layout with a
text node full of spaces. `ui.spacer()` alone produces only blank rows, so the
shot clamps it between two text anchors — it renders exactly this node:

```ts
ui.stack.column([
  ui.text('Above'),
  ui.spacer(),
  ui.text('Below'),
])
```

### `divider`

![`divider` node rendering](/shots/divider.svg)

*A divider without a label (width 48).*

```ts
ui.divider(options?: { label?: string })
```

Inserts a semantic divider with an optional label. The renderer draws it at
the assigned width. The screenshot above renders exactly this node:

```ts
ui.divider()
```

## Events and snapshot updates

Panes, overlays, and editor extensions place the handler on the definition,
not on an individual node:

```ts
onEvent: {
  observe(event: MayflyUiObservationEvent, context: MayflyUiEventContext) {
    return { kind: 'completed' }
  },
  async action(event: MayflyUiActionEvent, context: MayflyUiEventContext) {
    return { kind: 'completed' }
  },
}
```

| Channel | Events | Purpose |
| --- | --- | --- |
| `observe` | `value-change`, `selection-toggle`, `tab-change` | Editing facts and async validation; cannot publish, navigate, or dismiss |
| `action` | `activate`, `selection-accept`, `submit`, `dismiss` | Native effects and explicit settlement |

`context` carries `surfaceId`, current source stamps, revision, a unique
`operationId`, `AbortSignal`, and `report(feedback)`. Observations are
latest-wins per field; each action boundary is single-flight. Replacement,
unload, or abort revokes late handlers, progress reports, and publishers.

Actions return a structured reply. `accepted` carries the authoritative node
and source; `invalid` carries field errors; `conflict` retains drafts against a
new baseline; `failed` may include partially accepted field addresses;
`completed` and `cancelled` publish no snapshot. Replies may also carry
`feedback`, semantic `navigate`, and successful `dismiss`. Core admits the
reply and then invokes its one-use publisher, so the handler does not call
`set()` to acknowledge its own action.

When an external projection, service subscription, or timer changes domain
state, call `set(node, { reason: 'data', source })` on a pane/overlay handle or
the corresponding editor-extension `set()`. A new instance or scope uses
`reason: 'replace'`. Callers cannot publish acknowledgements, and there is no
`eventRevision` compatibility argument.

## Surface compatibility matrix

| Surface | Allowed nodes | Interaction rule |
| --- | --- | --- |
| `panes` | Full `MayflyUiNode` | Controls work and events go to pane `onEvent` |
| Capturing overlay | Full `MayflyUiNode` | Receives focus and handles Escape dismissal |
| Non-capturing overlay | Passive content/layout only | Tabs/list/form/actions controls replace the whole render tree with an error message |
| Additive `status` | text, rich-text, fields, progress, recursive stack | Always passive; no surface, scroll, or controls |
| Editor extension | Passive content/rich-text/progress/spacer/divider plus stack/surface | Interactive actions use the extension decoration's `actions` field |

All four registries are direct Fiber-owned Cordis services; no secondary
manifest or capability host participates in registration.

## Validation checklist

- Exercise every content and responsive branch at 120, 80, and 40 columns;
  never rely on an absolute coordinate.
- Cover disabled, busy, empty, error, loading, abort, and capability-absent
  fallback states.
- Cover consumer unload, owner reload, late event results, and overlay dismiss.
- Run the package validator, packed fixture, and width scan described in
  [Testing and validation](/en/plugins/testing).
