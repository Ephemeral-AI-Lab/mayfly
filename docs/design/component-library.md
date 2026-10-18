# Mayfly UI reference

`@ephemeral-ai/mayfly-ui` is the one UI kit for Mayfly core, official
components, and external Cordis plugins. It defines renderer-neutral wire
nodes, pure `ui.*` builders, the `compose.*` compositions, and the four UI
registries. `packages/ui/src/contracts.ts` is the executable authority for the
shapes below; this document is the readable map.

## Wire model

- A node is immutable data. `ui.*` builders are pure and return deeply frozen
  trees. `freezeWire(value)` clones and freezes caller data (rejecting cycles
  and accessors); `isWireSnapshot(value)` is the only way to ask whether a
  value is already a trusted snapshot. `freezeWire` of a snapshot returns it
  unchanged, so an unchanged sub-node keeps its identity.
- Identity is the cache key. Core reuses admission, compilation, and painted
  rows by node identity, so a builder keeps unchanged children identical
  rather than rebuilding them to "refresh" a surface.
- `defineMayflyComponent({ id, render, memo? })` validates a namespaced
  lowercase id and freezes each render. With `memo: true`, a call whose props
  are shallowly equal to the previous call's returns the previous node;
  `render` must therefore be pure, and owners hoist translators and inline
  objects. The factory is not a registry.
- A node carries no function, color, width, focus handle, key binding, ANSI
  sequence, Agent, Session, Promise, or callback. Drafts, cursors, scroll
  positions, clocks, and focus live in the runtime.
- `MayflyTranslate` is the type-only translator a component takes. English
  strings are message keys; values interpolate `{name}` placeholders.

## Node kinds

### Content

| Builder | Shape and behavior |
| --- | --- |
| `ui.text(content, { tone?, styles?, overflow? })` | One tone per run. `overflow`: `wrap` (default), `truncate`, `middle`, `start`. |
| `ui.richText(spans, { overflow? })` | Mixed tone, `strong`/`italic`/`strike`, and a `shimmer` or `loader` motion span. |
| `ui.fields(rows)` | `label:` muted plus a span value; the key/value panels. |
| `ui.markdown(source)` | The shipped Markdown renderer: headings, lists, tables, fences, emphasis, links. |
| `ui.code(code, { language?, numbered?, start?, label? })` | Highlighted code, optional line numbers and language label. |
| `ui.diff(before, after, options)` | One numbered gutter, `−`/`+` rows with tinted code, hunk headers, context, `maxRows`, optional `tail`. |
| `ui.sections([{ title?, body, collapsed? }])` | Titled content sections; a collapsed section is its title row. |
| `ui.chart({ chart, … })` | `sparkline`, `bar`, `line`/`point`, and `heatmap`; heatmap takes `cell: 1 | 2`, `columnLabels`, `levels`. |
| `ui.diagram(source)` | Mermaid source rendered as ASCII within a size budget, source fallback. |
| `ui.image({ attachmentId, alt, maxRows? })` | A reference, never bytes; `alt` paints until bytes load or without an image protocol. |
| `ui.spacer({ size? })`, `ui.divider({ orientation?, label?, align?, inset?, tone? })` | Vertical rhythm and rules. |

`MayflyContentField` is either a string or an append-only list of
`{ text }` chunks. Chunks let a stream append without resending the whole
field; a chunk whose text ends mid-line joins the next chunk on one row.

### Layout and admission

```ts
ui.stack.row(children, { gap?, rule?: 'column', align? })
ui.stack.column(children, { gap?, align? })
ui.child(node, {
  id?, tab?, basis?, grow?, shrink?, minSize?, maxSize?,
  when?: { minWidth?, maxWidth?, minHeight?, maxHeight? },
  priority?, band?: 'left' | 'center' | 'right', mark?: 'underline',
  overflow?: 'truncate' | 'hide',
})
```

A row uses flex sizing: fixed `basis`, free-space `grow`, shortfall `shrink`,
and bounds. `when` is a width/height ladder; a plugin never reads a width.
`priority` admits children while they fit (lower first), `band` places the
admitted ones, `mark` underlines a status item's words, and `overflow` decides
whether a child truncates, hides, or drops the rest. `ui.child` is also the
only way to give a page `tab` identity or a size.

### Surfaces and scroll

| Node | Fields |
| --- | --- |
| `ui.surface` | `title?`, `subtitle?`, `badges?`, `chrome?: 'none' \| 'lane' \| 'surface' \| 'overlay'`, `coverStatus?`, `padding?`, `child`, `footer?`, `titleAlign?`, `titleCut?`, `border?`, `escapeLabel?`, `hint?: 'auto' \| 'none' \| 'completions'` |
| `ui.scroll` | `id?`, `child`, `follow?: 'none' \| 'start' \| 'end'`, `scrollbar?`, `height?`, `expandedHeight?`, `fit?`, `pill?`, `expandable?` (`false` disables `Ctrl+E`), `more?` (`↓ N more`) |

`chrome` is presentation, not a host: `overlay` is borderless with a title
rule and hint row, `surface` is the rounded editor shell, `lane` is rules
only, and `none` is a bare title. A `coverStatus` lane takes the whole editor
slot and hides the status row. A compact `scroll` shows only the content
window; the outer screen scroll windows what it paints.

### Actions

```ts
ui.actions({ id, scope?, items: MayflyActionItem[] })
MayflyActionItem = {
  id, label, intent?: 'primary' | 'secondary' | 'danger',
  disabled?, disabledReason?, busy?, confirm?, submit?, read?, selections?,
  defaultFocus?, hidden?, dismiss?, navigate?, key?, semantic?, action?, hintLabel?,
}
```

An action declares what it means, not which key runs it:

- `semantic` names a common meaning (`save`, `copy`, `delete`, `refresh`,
  `external`, `search`); it runs from the current binding of `ui.save`,
  `ui.copy`, and so on, so one rebind moves every panel.
- `action` names a component action `<owner>.<action>`; `key` is its default.
- `hidden` actions are keys, not buttons or focus stops.
- `confirm` asks the shared decision before the action runs; `busy` keeps the
  verb but drops the button; `disabledReason` paints after the label.
- `read`, `submit`, and `selections` address form drafts and list selections
  on a page path.

### Forms and prompt

```ts
ui.form({ id, fields, submitActionId?, submitLabel?, cancelActionId?,
          cancelLabel?, enterSubmits?, submitOnLastField?, autofocus? })
```

Field kinds: `input`, `textarea`, `secret`, `number`, `select`, `multiselect`,
`toggle`. Common fields take `label`, `value`, `required`, `disabled`,
`disabledReason`, `help`, `group`, `origin`, `resetValue`; text fields add
`placeholder`, `minLength`, `maxLength`, `pattern`, `suggestions`; numbers add
`min`, `max`, `step`, `unit`; choices carry `options`.

`ui.prompt` is the editor's one text control: `symbol`, `tokens`, `recall`,
`placeholder` (a ladder), `completions`, `reset`, `submitLabel`, `autofocus`.
Tokens are attachments or mentions inside the input row. `Backspace` on an
empty buffer selects the last token, a second `Backspace` removes it; `↑`/`↓`
walk recall on an empty buffer; `Enter` sends or queues, `Alt+Enter` inserts a
newline. Drafts live in the surface model, so a republish never loses input.

### Lists

```ts
ui.list({ id, role: 'browse' | 'choose', mode?, items, selectedIds?,
          filter?, filterable?, filterMode?: 'type' | 'slash', tree?,
          numbered?: true | 'focus', minSelected?, maxSelected?,
          acceptActionId?, empty?, marker?, marks?, maxRows?, highlight?,
          groupGap?, expandFocused?, acceptVerb?, autofocus?, focusItem?, hintLabel? })
```

Items take `id`, `label` (and `labelSpans`), `cells`, `right`/`rightFocus`,
`body`/`bodyAlways`/`bodyLead`, `expanded`, `wrap`, `meter`, `indent`, `rule`,
`gap`, `detail`, `badge`, `current`, `group`, parent links, `disabled` and
`disabledReason`, `confirm`, `unavailableActions`, and a `segment` strip.

- A `choose` list commits a selection; `browse` opens a detail. `Enter` is
  labeled with `acceptVerb`.
- Typing filters (`filterMode: 'type'`); `filterMode: 'slash'` reserves bare
  letters for accelerators. `Ctrl+U` clears, Escape ends search and keeps the
  filter.
- `marks` draws `●`/`○` for multiple choose; `numbered` maps digits to visible
  rows; `marker: 'selection'` keeps a muted arrow after focus leaves;
  `marker: 'band'` paints a selected band.
- Trees use `parentId`; `→`/`←`, `Space`, `*`, and `-` expand, collapse, and
  toggle branches. A row `segment` steps its options with `←`/`→`.

### Tabs, slider, review

| Node | Fields |
| --- | --- |
| `ui.tabs` | `id`, `items` (`label`, `count`, `attention`, `disabled`, `group`, `backId`, `review`, `clip`), `activeId`, `mode?: 'tabs' \| 'wizard'`, `orientation?: 'horizontal' \| 'vertical'`, `hintLabel?` |
| `ui.slider` | `id`, `levels`, `selectedId?`, `inheritedId?`, `startCaption?`, `endCaption?`, `hintLabel?`, `autofocus?` |
| `ui.review` | `id`, `tabsId`, `items` (list or form source), `skippedLabel`, `submitLabel`, `submitActionId`, `autofocus?` |

A vertical `tabs` is a rail. The selected tab is a filled chip; a wizard keeps
ordered step marks and validates a forward switch like its Next action. The
slider is a discrete level track: `←`/`→`, `Home`/`End`, `Delete` unpins;
`Enter` reports `slider-accept`. The review page lists one answer per step and
submits the wizard.

### Feedback

| Node | Behavior |
| --- | --- |
| `ui.loader({ variant?, message?, elapsedMs?, cancelActionId?, cancelLabel? })` | Indeterminate work: `bloom`, `fill`, `gap` (default), `breath`, `pulse`; cancel is a hint, never a button. |
| `ui.progress({ value, max, label?, style?, width?, tone?, showCount?, showPercent?, transition? })` | Determinate `cells` or `rule` bar; `transition` drains once from `from`. |
| `ui.empty({ title, description?, actions? })` | What is missing and the next step. |

### Status-only nodes

`ui.shed(full, narrower)` gives a status node ranked narrower forms; a row
that does not fit gives up forms in ascending `rank` across all its shed
nodes, and a `null` form hides the node. Status nodes are limited to text,
rich text, fields, progress, stack, and shed.

## The `compose` namespace

`compose` is the one surface layer for Mayfly and plugins. Every composition
is pure and returns an ordinary frozen node tree; none owns a renderer.

| Name | Host / chrome | Use |
| --- | --- | --- |
| `compose.panel` | editor overlay, `overlay` chrome | One command panel: title, optional subtitle/badges, body, footer, required `escapeLabel`. |
| `compose.decisionLane` | editor slot, `lane` chrome | Agent requests: approval, plan review, questions, permission. Exactly one of `body` or `choices`. |
| `compose.decisionStrip` | current panel or views panel, lane body | User-triggered Yes/No; hidden `y`/`n`, `Esc no`. |
| `compose.wizard` | inside a panel or lane | Step strip, pages, optional review page; no surface. |
| `compose.tabs` | inside a panel | Horizontal tab strip over arbitrary pages. |
| `compose.rail` | inside a panel | Vertical rail and one page per label. |
| `compose.browser` | inside a panel | Wide list + detail; one page at a time when narrow. |
| `compose.completionPalette` | editor overlay | Rows-only completion palette; the host owns filter, focus, and keys. |
| `compose.statusPage` | inside a panel | Tabs and read-only pages. |
| `compose.wizardNext(id, stepId)` | helper | The action id of a step's Next. |
| `compose.decisionArmMs` | helper | 300 ms arm delay for an unprompted decision lane. |

Rules:

- The surface node's `title` is authoritative; an overlay definition title is
  only a fallback.
- `lane` and `overlay` are chrome, not hosts. A lane decision occupies the
  editor slot; a decision strip replaces the current surface's body.
- All agent requests use `decisionLane`; a user-triggered confirm uses
  `decisionStrip`. Questions sets `coverStatus: true`; every other decision
  lane keeps the status row.
- Shipped panels are keys-only: no visible Save/Cancel/Close buttons.
  Multi-field forms save with the last field's `Enter` or `Ctrl+S`; `Esc`
  closes, asking first when dirty.
- A picker uses `list` choose/segment; a form uses `select`/`multiselect`/
  `toggle`; a toggle carries `null` for unset and `origin`/`resetValue` for
  inherited values.
- `current: true` is the only current marker: primary label plus `✓`.
- Detail panels are one `panel` each: `rail` for sessions/settings, `browser`
  for list/detail, with a full-height `│` rule by default (`separator: false`
  turns it off).
- A completion palette is rows-only; the editor host owns the rest.

## Mayfly components

A Mayfly component is a pure function from plain facts to a node tree. It
paints nothing, measures nothing, and reads no key. The component modules live
in `packages/mayfly/src/components/` and import only
`@ephemeral-ai/mayfly-ui` and their siblings; `tests/components/layering.spec.ts`
is the guard, and every row renderer joins its owning `width-scan.spec.ts`.

| Component | Facts → output | Built from |
| --- | --- | --- |
| `Editor` | Conversation title, shell mode, parked state, placeholder ladder → editor frame with one `prompt` | `surface`, `prompt` |
| `TranscriptView` / `TranscriptStream` | Turns, rows, queued messages, cursor and search highlight → browse `list` | `list`, `rich-text`, `markdown`, `diff`, `code`, `image`, `divider` |
| `ToolLine`, `ToolBody`, `ToolGroupHead`, `ToolGroupItem`, `ToolMore` | Tool call state, stats, diff/code body → inline spans and body nodes | `rich-text`, `diff`, `code` |
| `ActivityRow` | Phase, label, tail counts, info or tip → three-row activity block | `loader`/motion spans, `rich-text`, `stack` |
| `NotificationLine` | Notice severity/message/tail, focus keys → notification row | `rich-text`, `stack` |
| `CompactionRow` | Compaction stages, occupancy, summary → list body | `progress`, `rich-text`, `stack` |
| `DecisionCard` | Title, queue count, choices, note, hidden keys → lane surface | `compose.decisionLane` |
| `ModelPicker` / `EffortPicker` | Model rows, live model, segment strip → browse list surface | `list`, `surface` |
| `questionWizard` | Questions, answers, review → wizard surface | `compose.wizard`, `list`, `form`, `tabs` |
| `onboardingWizard` | Preferences, connect step, sign-in, ready → wizard surface | `compose.wizard`, `form`, `list` |
| `PluginMarketplace` / `PluginDetail` | Catalog tabs, rows, detail, progress, restart banner → surface | `compose.tabs`, `compose.browser`, `list`, `fields`, `loader` |
| `StatsPanel` | Session/Account/History/Models tabs → status page | `compose.statusPage`, `fields`, `chart`, `list` |
| `signInBody` | Sign-in stage, labels, ids → account panel body | `list`, `fields`, `rich-text` |

Feature plugins own the facts, Fibers, and writes behind these components.
Status-row views and the footer are assembled by the transcript area, not by
`components/`; `transcript/view-items.ts` holds their shared summary/panel
helpers.

## Keys

A key is an action's current binding, never its identity. `mayflyKeymap` owns
every dispatched key as a named action with a scope: `global`, `editor`,
`surface`, or `stream`. A global action claims its key in every scope; within
overlapping scopes a key belongs to one action, and a conflict is refused with
the owner's name (`KEY_CONFLICT`). `bind`/`reset`/`resetAll` change a binding
for the session, `list` offers registered and seen component actions, and
`preferPlain` puts the plain second default first where Alt is not delivered.

### Navigation and common meanings

| Key | Action | Meaning |
| --- | --- | --- |
| `↑` `↓` | `ui.up` `ui.down` | Move rows, fields, or candidates |
| `←` `→` | `ui.left` `ui.right` | Switch tabs/columns, cycle a select, step a number or segment, expand or collapse a row |
| `Enter` | `ui.accept` | The focused row's primary action |
| `Space` | `ui.toggle` | Toggle a choice |
| `/` | `ui.filter` | Start filtering |
| `Ctrl+S` | `ui.save` | Save the form |
| `c` | `ui.copy` | Copy the focused row or content |
| `r` | `ui.refresh` | Refresh or retry |
| `x` | `ui.delete` | Delete, remove, or stop; destructive actions confirm first |
| `Ctrl+G` | `ui.external` | Open the focused content in `$EDITOR` |
| `Ctrl+F` | `ui.search` | Search the whole conversation or list |
| `Esc` | `ui.cancel` | Leave one layer |
| `Tab` / `Shift+Tab` | `ui.next-group` / `ui.prev-group` | Move between controls |
| `Ctrl+E` | `ui.expand` | Expand a scroll region to its full-screen view |
| `Ctrl+U` | `ui.clear` | Clear an active search |
| `Alt+Enter`, `Ctrl+J` | `ui.newline` | Insert a newline in a textarea |
| `Alt+←/→`, `F2`/`F3` | `ui.tab-prev`/`ui.tab-next` | Switch tabs |
| `Alt+↑/↓`, `F4`/`F5` | `ui.focus-prev`/`ui.focus-next` | Move focus between controls |

### Product actions

| Key | Action |
| --- | --- |
| `Ctrl+C` | `mayfly.interaction.interrupt`: clear input, interrupt with an empty buffer, press twice to exit |
| `Ctrl+Enter` | `mayfly.interaction.steer`: send the draft as a steer while a turn runs |
| `Backspace` | `mayfly.interaction.backspace`: delete backward; exit shell mode on an empty prompt |
| `Shift+Tab` | `mayfly.interaction.cycle-mode`: toggle plan mode in the editor |
| `Alt+M` | `mayfly.interaction.cycle-model`: cycle the session model |
| `F7` / `F8` | `mayfly.interaction.toggle-agent-view` / `close-agent-view`: move between conversations, close the side one |
| `Ctrl+↓` | `mayfly.interaction.follow-tail`: new-messages rule first, then the newest content |

Component actions keep `<owner>.<action>` ids (`ui.*` is reserved). Printable
accelerators never pre-empt a control that takes text, and are rejected on a
surface with a type-to-filter list. Every default using Alt also has a plain
second default; `Esc` and `Enter` stay fixed. `core`'s key grammar derives the
hint row from the same state that dispatches, so a hint cannot name a dead key.
The full routing, escape ladder, choice rules, and search behavior are in
[interaction-model.md](../interaction-model.md).

## Events and replies

A pane, overlay, or editor extension places `observe` and/or `action` on its
definition. Events carry a `pagePath`, and the action context adds `source`,
`revision`, `operationId`, an `AbortSignal`, and `report(feedback)`.

| Event | Class | Carries |
| --- | --- | --- |
| `value-change` | observe | `controlId`, `formId`, `value`, `draftRevision` |
| `selection-toggle` | observe | `controlId`, `selectedIds`, `actionId?` |
| `tab-change` | observe | `controlId`, `tabId` |
| `focus-change` | observe | `controlId`, `itemId?` |
| `recall-change` | observe | `controlId`, `source`, `index` |
| `activate` | action | `controlId`, `actionId`, `itemId?`, `inputs?` |
| `selection-accept` | action | `controlId`, `selectedIds`, `actionId?`, `segmentId?` |
| `submit` | action | `controlId`, `submission` |
| `token-remove` | action | `controlId`, `tokenId` |
| `completion-accept` | action | `controlId`, `itemId` |
| `slider-accept` | action | `controlId`, `value` (or null) |
| `completion-dismiss` | action | `controlId` |
| `dismiss` | action | none |

A reply is `accepted` (node + source), `invalid` (field errors), `conflict`
(node, source, message), `failed` (message, optional node/source/accepted
fields), `completed`, or `cancelled`, optionally with `feedback`, `dismiss`,
and `navigate`. The provider publishes an accepted reply through a one-shot
endpoint bound to the original registration.

## Verification

- Every content renderer and component row must fit `render(width)`; add it
  to the owning `width-scan.spec.ts`.
- `tests/ui.compile.ts` type fixtures cover every contract field, component
  inference with `memo`, explicit child boundaries, and rejection of custom
  kinds; `tests/types.spec.ts` compiles them against built declarations.
- The vitest `suite` runs with `MAYFLY_UI_VERIFY_MEMO=1`; every retained-row
  hit paints again and a difference fails.
- `pnpm run check` is the full gate; a `src/` change to this package also
  takes the distribution checks `check:lib`, `check:examples`, and
  `check:pack`.
