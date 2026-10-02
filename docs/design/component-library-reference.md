# Mayfly UI component library: implementation reference

This file collects the implementation material that is deliberately **outside
the design review**: wire mechanics, builder and event tables, content-node and
surface definitions, interface-stability rules, the author checklist, and the
implementation backlog. It is written for the follow-up change that modifies
`packages/`, after the design in [component-library.md](./component-library.md)
is reviewed and merged. The order in which the backlog of §6 ships is in
[implementation-roadmap.md](./implementation-roadmap.md) §9.

The executable form of the UI API is the prototype's kit, [prototypes/ui-kit.mjs](./prototypes/ui-kit.mjs):
its builders, renderer, and key engine are the reference for what each prop paints and which events it emits, and the
additive props the design needs are listed in spec §6.4. This file adds the wire mechanics and the mapping to the
current code.

The design leads. This file records what the code does today and what the design
would need from it; where the two disagree the design is the target, and nothing
here limits it. Section references written `spec §n` point into the design; plain
`§n` and `ref §n` point into this file. Backlog items marked superseded in the
design were removed. Statements about "today" were verified against `main` when
the design was written and may drift; the code is their authority.

## 1. Wire mechanics

```
plugin code                                   core (the only pi-tui consumer)
─────────────────────────────────             ─────────────────────────────
ui.* builders → frozen wire node → service →  validator → compiler → painter
onEvent handlers ← structured event/reply ←   key grammar ← terminal keys
```

- **Components are data.** `ui.form(...)`, `ui.list(...)`, `ui.tabs(...)`,
  `ui.actions(...)`, … return deeply frozen, readonly wire nodes
  (`packages/ui/src/builders.ts`). Wire data never contains functions,
  Promises, ANSI, focus handles, or terminal widths.
- **Surfaces mount through the four services**: `mayflyPanes`,
  `mayflyOverlays`, `mayflyStatus`, `mayflyEditorExtensions`. A registration
  carries the initial node plus `onEvent` handlers; refresh is `set()` with a
  replacement node.
- **Plugins answer events; they never see keys or focus.** Observations
  (`value-change`, `selection-toggle`, `tab-change`) report facts and cannot
  publish, navigate, or dismiss. Actions (`activate`, `submit`,
  `selection-accept`, `dismiss`) return structured replies: `completed`,
  `accepted`, `invalid`, `conflict`, `failed`, `cancelled`. `invalid` and
  `conflict` repaint feedback inline — that is the real-time error channel.
- **One key grammar drives both dispatch and the hint row**
  (`core/ui-key-grammar.ts`), so a displayed hint is always a working key.

## 2. Builder and event reference

Data flows down as immutable nodes and up as events; nothing else crosses the
seam. Builders take an options object, add `kind`, and freeze a clone.

| Builder | Required | Notable optional | Emits | Owns keys | Hint verbs |
| --- | --- | --- | --- | --- | --- |
| `ui.actions` | `id`, `items[]` | per item: `intent`, `confirm`, `key`, `submit`/`read`/`selections`, `navigate`, `dismiss`, `defaultFocus`, `hidden` | `activate`, `submit`, `dismiss` | `←→↑↓` between items, `Enter`/`Space` run, declared `key` | `run`, `confirm`, `actions` |
| `ui.form` | `id`, `fields[]` | `enterSubmits`, `submitActionId`/`cancelActionId`, `submitLabel`/`cancelLabel` | `value-change`, `submit` | `Enter` edit/commit, `Tab` commit+move, `Delete` reset, `Alt+Enter` newline | `edit`, `next`, `submit`, `newline`, `reset`, `fields` |
| form field `select` | `id`, `label`, `value`, `options[]` | `origin`, `resetValue`, `required` | `value-change` | `←→` cycle, `Enter` picker | `adjust`, `pick`, `apply`, `options` |
| form field `toggle` | `id`, `label`, `value` | `origin`, `resetValue` | `value-change` | `Enter`/`Space` flip | `toggle` |
| `ui.list` | `id`, `role`, `items[]`, `selectedIds` | `mode`, `filterable`, `tree`, `numbered`, `acceptActionId`, `minSelected`, `maxSelected`, `empty` | `selection-toggle`, `selection-accept` | `↑↓ PgUp PgDn Home End`, `Enter`, digits, `Space` (multiple), `/`+type | `choose`/`open`, `toggle`, `filter`, `options`, `<segment label>` |
| `ui.tabs` | `id`, `activeId`, `items[]` | `mode: 'wizard'`, per item `backId`, `count`, `disabled` | `tab-change` | `←→` move, `Enter` descend, `Alt+←→` switch | `tabs`, `open` |
| `ui.loader` | `message` | `variant`, `elapsedMs`, `cancelActionId` | — | none | (`Esc cancel`) |
| `ui.progress` | `value`, `max` | `label` | — | none | — |
| `ui.empty` | `title` | `description`, `actions` | as `actions` | none | — |
| `ui.surface` | `child` | `title`, `subtitle`, `badges`, `chrome`, `padding`, `footer` | — | `Esc`, `Ctrl+C` close | `close` |
| `ui.scroll` | `child` | `id`, `follow`, `scrollbar` | — | `↑↓ PgUp PgDn`, `Ctrl+E` expand | `scroll`, `expand` |
| `ui.stack` / `ui.child` | children | `gap`, `align`; per child `basis`, `grow`, `shrink`, `minSize`, `maxSize`, `tab`, `when` | — | none | — |
| `ui.text` / `ui.richText` | `content` / `spans[]` | `tone`, `overflow`; span `styles` | — | none | — |
| `ui.fields` | `rows[]` | — | — | none | — |
| `ui.markdown` / `ui.code` / `ui.diff` | `source` / `code` / `before`, `after` | `language` | — | none | — |
| `ui.sections` | `sections[]` | per section `title`, `collapsed` | — | none | — |
| `ui.chart` / `ui.diagram` | per `chart` variant / `source` | `title`, `height`, `layout`, `orientation`, `levels` | — | none | — |
| `ui.spacer` / `ui.divider` | none | `size` / `label` | — | none | — |

Events (up) and replies (down):

| Event | Class | Carries |
| --- | --- | --- |
| `value-change` | observation | `controlId`, `formId`, `value`, `draftRevision` |
| `selection-toggle` | observation | `controlId`, `selectedIds`, `actionId?` |
| `tab-change` | observation | `controlId`, `tabId` |
| `activate` | action | `controlId`, `actionId`, `itemId?`, `inputs?` |
| `selection-accept` | action | `controlId`, `selectedIds`, `actionId?`, `segmentId?` |
| `submit` | action | `controlId`, `submission` |
| `dismiss` | action | — |

| Reply to an action | Paints | Modifiers |
| --- | --- | --- |
| `completed` | nothing; the action settles | `dismiss`, `navigate`, `feedback` |
| `accepted` | the replacement `node` | same |
| `invalid` | field errors in place | — |
| `conflict` | the fresh `node` plus a resolve decision | — |
| `failed` | `message` beside the action; `acceptedFields` stay | — |
| `cancelled` | nothing | — |

Observations may reply only `invalid`, `failed`, `completed`, or `cancelled`;
they can never publish, navigate, or dismiss.

Handlers are registered as `onEvent: { observe?, action? }`: `observe` receives
the observation events (`value-change`, `selection-toggle`, `tab-change`) and
`action` the action events and returns the reply. A reply may carry `feedback`
(`{ message, severity, purpose?, detail? }`); the core keeps one record per
message (`id`, `owner`, `scope`, `state: 'active' | 'handled'`, `createdAt`,
`visibleMs`) and owns its lifetime (spec §2.4). The remaining routing fields in
`packages/ui/src/interaction.ts` (`operationId`, `fieldId`, `surfaceId`,
`targetId`, `resourceId`, `sessionId`, `focusRevision`) address a reply to the
control and revision it answers; they are protocol, not visual, and never appear
in a rendered state. `MayflyConfirmation` also carries `confirmLabel` and
`cancelLabel` (the permission panel's `Enable`) beside `title`, `detail`, and
`tone`, and a list item may supply `detailSpans` (toned inline spans) in place of
its plain `detail`.

Every field an author adds follows one spec template, so a proposal can be
reviewed before code exists:

| Slot | Question it answers |
| --- | --- |
| Type & default | What is it, and what does absence mean? |
| Validator | Which invalid inputs are rejected, and with what path? |
| Painted states | ASCII for unset / set / focused / disabled / narrow |
| Keys & hints | Which grammar binding and which hint verb? |
| Events & replies | What does it report, and what may the owner answer? |
| Degradation | In what order does it shrink at narrow widths? |
| Tests | Validator, painter, compiler/grammar, width-scan |

Worked specs for the additive fields this catalog proposes. Derived state needs
no field: wizard step marks (`✓ ● ○`) come from `activeId` order, the `•` edited
marker and `(inherited)` / `(override)` from `origin` and `resetValue`, and a
tree parent's `●` / `◐` / `○` from its children in a `tree` +
`multiple` list.

| Field | Type & default | Validator | Painted states | Keys & hints | Events | Degradation |
| --- | --- | --- | --- | --- | --- | --- |
| `MayflyListSegment.inheritedId` (E1) | `string`; absent = no inherited option | must equal an option `id`; not disabled | `‹ high (default) ›` unpinned, `‹ max ›` pinned | `Delete use default` only while pinned | `selection-accept` omits `segmentId` when unpinned | drop `(default)` first |
| `MayflyListNode.filterMode` (E5) | `'type' \| 'slash'`; `'type'` | enum; only meaningful with `filterable: true`; a `slash` list admits printable `action.key` on its surface (the validator's `printableKey` budget check keys on `filterMode`) | `/ query` row appears after `/`; typing without it reaches accelerators | hint `/ filter` replaces `Type filter`; adds the declared keys | none | none |
| `MayflyFormFieldBase.help` (R9) | `string`; absent = no help line | text, bounded like `placeholder` | muted line under the focused field | none | none | dropped first at narrow widths |
| `MayflyFormFieldBase.group` (R9) | `string`; absent = ungrouped | text; consecutive fields with one `group` render under one `── group ──` heading | heading row, never focusable | `↑`/`↓` skip it | none | heading drops before any field |
| `MayflyTabItem.attention` (R9) | `boolean`; `false` | boolean | `!` in `warning` strong beside the label | none | none | `!` survives `+N` folding |
| `MayflyTabsNode.orientation` (R9) | `'horizontal' \| 'vertical'`; `'horizontal'` | enum | vertical rail with the `→` mark on the selected label, counts right-aligned | `↑`/`↓` move, `→`/`Enter` enter the content | `tab-change` (live with F2) | below 60 columns becomes the horizontal strip |
| `MayflyListItem.body` (R9) | `string`; absent = not expandable | text | `▸`/`▾` row; body under the row with a `│`/`╰` guide | `→` expands, `←` collapses (`Space` stays toggle on `multiple`) | none | body truncates to one line first |
| `MayflyListNode.acceptVerb` (G2) | `'open' \| 'choose'`; default from `role` | enum | footer `Enter choose` | replaces the `open`/`choose` hint word | none | none |
| `MayflyActionsNode.reveal` (F1, only the delta over shipped `hidden`) | `'always' \| 'focus'`; `'always'` | enum; a `focus` group with a `key`-less, non-`dismiss` action must still be reachable by `Tab` | hidden until the group is focused; then the ordinary row | adds `Tab/Shift+Tab groups` while hidden | as `actions` | as `actions` |
| overlay `armMs` (E4) | `number` ms; `0` | integer `0–2000` | none (input is swallowed) | none | none | none |
| `focus-change` observation (F2) | `{ controlId, itemId }` | list ids only | right pane repaints read-only | none | new observation, cannot publish | debounced by the renderer |

## 3. Content nodes and surface definitions

### 3.1 Content nodes

Content nodes are static: they take no focus and own no keys, never emit events,
and are painted by the content painters (`core/plugin-view.ts`,
`core/rich-document.ts`, `core/chart-renderer.ts`, `core/diff-align.ts`).
Authors supply data only. Every content node composes anywhere a `MayflyUiNode`
is admitted, except where a narrower union applies (ref §3.2: status entries admit
only `text`, `rich-text`, `fields`, `progress`, and stacks of them; editor
extensions exclude `diagram` and `chart`).

| Builder | Data | Painted today | Notes |
| --- | --- | --- | --- |
| `ui.text` | `content`, `tone?`, `overflow?: 'wrap' \| 'truncate'` | one tone, wrapped (default) or one ellipsized row | tones: `default` `muted` `primary` `accent` `user` `success` `warning` `danger` |
| `ui.richText` | `spans[]` (`text`, `tone?`, `styles?: 'strong' \| 'italic' \| 'strike'`), `overflow?` | mixed tone and weight in one run | the shape of every status entry and hint |
| `ui.fields` | `rows[]` (`label`, `value: spans[]`) | `label: ` muted, then the value spans, wrapped | key/value panels (status, account) |
| `ui.markdown` | `source` | the shared markdown painter; a fenced `mermaid` block becomes a diagram | the only node whose code fences are highlighted today |
| `ui.code` | `code`, `language?` | muted language heading, then every line in `mdCodeBlock` | **not** highlighted (roadmap C2) |
| `ui.diff` | `before`, `after` (two strings) | aligned rows under a sign gutter, change bands padded to the width | numbered gutters, `@@` headers, and the red/green background behind the changed code (not the line numbers) are targets (ref §6 C1, spec §5.3) |
| `ui.sections` | `sections[]` (`title?`, `body`, `collapsed?`) | bold `primary` title, then the body; a collapsed section is its title row only (`...` when untitled) | bodies: `text`, `fields`, `code`, `diff`, nested `sections` |
| `ui.chart` | `chart: 'line' \| 'point'`, `'bar'`, `'sparkline'`, `'heatmap'` | `simple-ascii-chart` inside the width | below |
| `ui.diagram` | `diagram: 'mermaid'`, `source` | beautiful-mermaid ASCII, bounded | below |
| `ui.spacer` | `size?: 1 \| 2` | blank rows | the only vertical rhythm primitive |
| `ui.divider` | `label?` | a rule, optionally labelled | the `lane` chrome is the same rule |

Rendered states (illustrative; the Content scene of the prototype draws them):

```
text        Saved to clipboard                          tone: success
            Waiting for the provider…                   tone: muted, overflow: truncate

rich-text   deepseek-chat High  PLAN  ⏵ 2 jobs           spans: default · accent strong · warning

fields      Provider: DeepSeek
            Balance: ¥ 128.40                           label muted, value spans

code        typescript
            const frame = glyphFor(state)               every line one `mdCodeBlock` tone

diff        − const frame = moon
            + const frame = glyphFor(state)             sign gutter, change bands full width

sections    Connection                                  bold primary title
              Name: production
            Behaviour ...                               collapsed: the title row only
```

Charts. `line` and `point` take `series[]` of `{ x, y | null }` points with an
optional `tone` per series, plus `title`, `xLabel`, `yLabel`, `height`. `bar` takes
`categories[]` and `series[]` of `values[]` (`null` is a gap, `empty` paints `░`
instead of `█`), with `layout: 'grouped' \| 'stacked' \| 'normalized'`,
`orientation: 'vertical' \| 'horizontal'`, `title`, `yLabel`, `height`.
`sparkline` takes `values[]`, `label`, `tone`. `heatmap` takes `columns[]`,
`rows[]`, `values[][]`, and `levels[]` of `{ value, label, tone }` that map a
cell value to a tone and a label (a legend row is roadmap C3). Series without an
explicit tone cycle `accent`, `success`, `warning`, `danger`, `muted`,
`default`. A renderer failure falls back to a bounded text summary, never to
an overflowing row.

```
sparkline   tokens ▁▂▃▅▇▆▃▂                              one row

bar (horizontal, grouped)
            mon  ██████░░░░ 62
            tue  ███░░░░░░░ 31

heatmap     Mon Tue Wed                                  levels[] map cell → tone
            ░░  ▒▒  ██   low · mid · high
```

Diagrams. `diagram: 'mermaid'` renders flowcharts, state diagrams, and the other
types the library supports as ASCII, within a budget (`rich-document.ts`: 8 KiB
source, 100 non-empty lines, 25 graph nodes). Over budget or unparseable, the
painter shows the original fenced source as the bounded fallback, so a diagram
can never break the frame.

```
diagram     ┌─────────┐     ┌─────────┐
            │  queue  │────►│  agent  │                  flowchart LR; queue --> agent
            └─────────┘     └─────────┘
```

Rules: pick the narrowest node that says it (`text` before `richText` before
`markdown`); never encode layout in spaces (use `stack`, `spacer`, `divider`);
tone plus a glyph or a word carries meaning, never tone alone (spec §2.1);
every content row must fit `render(width)` and belongs in the owning
`width-scan.spec.ts` (ref §5).

### 3.2 Surfaces, panes, overlays, status, and editor extensions

The four services accept the same wire nodes through different definitions. A
definition is plain data (it may carry `onEvent` handlers, snapshot `load`
providers, and, for editor extensions, `complete` and `transformSubmit`
callbacks that the owner supplies, never the wire node).

**Structure nodes.**

| Builder | Data | Notes |
| --- | --- | --- |
| `ui.surface` | `title?`, `subtitle?`, `badges?: spans[]`, `chrome?: 'none' \| 'lane' \| 'surface' \| 'overlay'`, `padding?: 0 \| 1 \| 2`, `child`, `footer?` | chrome anatomy in spec §2; `footer` sits above the generated hint row |
| `ui.scroll` | `id?`, `child`, `follow?: 'none' \| 'start' \| 'end'`, `scrollbar?` | `↑↓ PgUp PgDn` scroll, `Ctrl+E` expands, `Esc` collapses (EXPANDED, spec §3.1); `follow: 'end'` keeps the tail in view |
| `ui.stack.row` / `.column` | `children[]`, `gap?: 0 \| 1 \| 2`, `align?: 'stretch' \| 'start' \| 'center' \| 'end'` | the only layout primitive |
| `ui.child` | `node`, `id?`, `tab?`, `basis?: number \| 'auto'`, `grow?`, `shrink?`, `minSize?`, `maxSize?`, `when?` | `when` is the viewport condition below |

**Viewport condition.** `when: { minWidth?, maxWidth?, minHeight?, maxHeight? }`
on a child makes it render only while the viewport satisfies every bound given.
A width ladder is several children with disjoint ranges (spec §3.3, spec §2.4; the
activity row and the status footer already work this way), so the renderer picks
the layout and a plugin never reads a width.

```
ui.stack.column([
  ui.child(ui.richText({ spans: wide }),   { when: { minWidth: 100 } }),
  ui.child(ui.richText({ spans: medium }), { when: { minWidth: 60, maxWidth: 99 } }),
  ui.child(ui.text({ content: 'Loop ✓' }), { when: { maxWidth: 59 } }),
])
```

**Panes** (`mayflyPanes.register(definition, node)`):

| Field | Meaning |
| --- | --- |
| `placement` | `'header' \| 'left' \| 'right' \| 'bottom'`; the bottom dock stacks panes by `priority` and a pane with no node renders zero rows |
| `size` | `{ min?, preferred?: number \| 'auto', max? }`, columns for `left`/`right`, rows for `bottom` (default `min` 1, the head row); never more than `max` before the tail truncates |
| `narrow` | `'bottom' \| 'overlay' \| 'hidden'`: what a side pane becomes on a narrow terminal |
| `load` | snapshot provider: `{ cursor, signal } → { node, nextCursor?, total? }`; the registration's `refresh()` and `loadMore()` drive it |

Built-in panes are passive (no key focus); an interactive pane is reached by
`F6` (`mayfly.surface.next`).

**Overlays** (`mayflyOverlays.open(definition, node)` → a handle with `set`,
`focus`, `hide`, `show`, `close`):

| Field | Meaning |
| --- | --- |
| `presentation` | `'overlay'` (default, floating) or `'editor'` (takes the editor's slot; the newest visible one wins; `/help`, rewind, and schedule use it) |
| `capturing` | the overlay takes keys. A non-capturing overlay is display-only: core replaces one that contains an interactive control with a failure node |
| `dismissible` / `dismissal` | on a capturing overlay `Esc` dismisses unless `dismissible: false`. A surface with unsaved edits asks the shared `Discard unsaved changes?` (No first) before closing, which is the default (`'confirm-dirty'`); `'discard'` skips the question |
| `anchor`, `width`, `minWidth`, `maxHeight` | `'center' \| 'top' \| 'bottom' \| 'left' \| 'right'`; `width` and `maxHeight` in cells or `%`; the renderer clamps all of them |
| `contentScroll` | the overlay scrolls its content inside a fixed frame |
| `load` | the same snapshot provider as panes |

**Status entries** (`mayflyStatus.register(definition, node)`): `band: 'left' \|
'center' \| 'right'`, `row: 1 \| 2`, `priority` (lower is kept first), and
`overflow: 'truncate' \| 'hide'`. The node is `text`, `rich-text`, `fields`,
`progress`, or a stack of them; a loader, list, form, or tabs node is rejected.
Entries are admitted in priority order across the whole row and dropped when
the row is full; admitted entries then lay out in their band.

**Editor extensions** (`mayflyEditorExtensions.register(definition, decoration)`):

| Piece | Meaning |
| --- | --- |
| decoration `before` / `after` | content nodes drawn around the editor (`MayflyEditorContentNode`: no `diagram`, no `chart`), plus `progress`, `spacer`, `divider`, stacks and surfaces of those |
| decoration `hint` | one muted line; extensions never get a hint row (spec §3.2) |
| decoration `diagnostics[]` | `{ id, message, tone? }` rows under the editor |
| decoration `actions[]` | action items that bind **modifier** accelerators only (ref §4) |
| definition `complete(request)` | `{ query, trigger: '/' \| '@' \| '#' \| 'manual' }` → `{ id, label, insertText, detail? }[]` for the completion list |
| definition `transformSubmit(request)` | `{ text, attachments[] }` → `{ text }`, run before the prompt is sent; an attachment is `{ id, label, mediaType?, size? }` |

Authors do not size or place any of these: they choose the definition fields
above and core owns layout, focus, and width (root `AGENTS.md`).

## 4. Interface stability and extending the catalog

- **Wire data is frozen** at the builder (`freezeWire` clones and rejects
  cycles/accessors) and contains no functions, Promises, ANSI, focus handles,
  or widths. Renderer state (focus, drafts, clocks) never enters the wire.
- **Contracts evolve additively.** New optional fields with defaults are fine;
  never repurpose a field, tighten a type, or encode renderer concerns
  (colors, columns, key codes) into the contract.
- **`action.key` constraints** (validator-enforced): a key id, never a
  reserved navigation key (`enter`, `escape`, `tab`, `shift+tab`, `space`,
  `backspace`, arrows, `pageup`/`pagedown`, `home`/`end`, `alt+left`,
  `alt+right`, `ctrl+c`, `ctrl+e`, `ctrl+u`), never repeated on one page,
  never printable on a surface that holds a type-to-filter list (the validator
  rejects it, `core/ui-validator.ts`: "would swallow typed filter text"), and
  modifiers only inside editor decorations. The target `filterMode: 'slash'`
  (ref §2, roadmap E5) lifts the printable restriction for that surface: only
  `/` starts a filter there, so a bare `i`, `u`, `x`, or `r` is an accelerator.
- **A genuinely new component kind touches, in order:** the `contracts.ts`
  union → a `ui.*` builder → admission in `core/ui-validator.ts` → a painter
  in `core/ui-patterns.ts` → a control arm in `core/ui-compiler.ts` /
  `core/ui-key-grammar.ts` → rows in the owning `width-scan.spec.ts` → this
  catalog. `packages/ui` changes run the full gate.
- **Do not reimplement.** The editor's autocomplete list (`SelectListAdapter`
  in `core/components.ts`, `core/wrapping-select-list.ts`,
  `renderAutocompleteList`) is a retained legacy integration with its own key
  handling — it is not a model. (The old `core/scrollable-panel.ts` no longer
  exists; the session transcript is an ordinary pane.) New surfaces compose wire nodes and
  inherit focus, hints, validation, and narrow-width behavior for free.

## 5. Author checklist

Pick the component by need:

| Need | Use |
| --- | --- |
| Yes/No before an action runs | action `confirm` (never a custom page) |
| Agent decision (approval, plan, permission) | spec §5.7 decision-panel composition |
| One of ≤ 9 options | `ui.list({ role: 'choose', numbered: true })` |
| Several of N | `mode: 'multiple'` with `minSelected`/`maxSelected` |
| Read-only inventory | `role: 'browse'` (static text: `fields`/`sections`/`markdown`) |
| Radio choice in a form | `select` field |
| One checkbox | `toggle` field |
| Checkbox group | `multiselect` field |
| Parallel pages | `ui.tabs` + tab-pinned children |
| Ordered steps | `mode: 'wizard'` + `backId`, `read` on Next |
| Tabbed page, labels on the left | spec §4.5 split recipe (`stack.row` + label list) |
| A per-row setting (thinking level, scope, mode) | list `segment` on that row (spec §4.4), never a separate row or page |
| Commit-on-`Enter` picker | `role: 'browse'` list, `selection-accept`, no buttons (spec §5.9) |
| An action a bare key already performs | none — omit it (redundancy rule, spec §4.2) |
| In-flight work | `loader` (determinate: `progress`) |
| Nothing to show | `empty` node |
| Dangerous operation | `intent: 'danger'` + `confirm: { tone: 'danger' }` |

Verification duties for any new or changed surface:

1. Every component row must fit `render(width)` — add the surface to the
   owning `width-scan.spec.ts` (`packages/mayfly/tests/{core,interaction,
   transcript}/`).
2. Labels go through the locale catalog; English strings are the stable keys
   (`tests/locale-catalog.spec.ts`).
3. Shared key changes update `SHARED_KEY_REFERENCE` in
   `core/ui-key-grammar.ts` and both Website key references together
   (`tests/core/key-grammar-docs.spec.ts`).
4. `packages/ui` contract or builder changes run the root full gate.
5. A roadmap item in ref §6 is not shipped behavior until its status flips to
   **shipped**; only the code, and the ref §1–ref §5 sections without a
   `Status: target` banner, describe what runs today.
6. Assert the footer string for every state the surface can be in (idle,
   searching, editing, decision, busy). A hint is a contract, and spec §3.2 lists
   the verbs it may use.
7. Run the redundancy test (spec §4.2) on every action, and the stray-key test
   (spec §5.7) on every surface that opens without the user asking for it.
8. Key prompts: every key a screen state makes useful is visible in that state
   (spec §3.3) — the surface row inside overlays, the owner's own footer for pane
   and block keys, status row 2 for editor and session keys. A new global key or
   state extends the spec §3.3 fragment catalog and its exact-row spec.
9. Diagrams are exact renderings at a stated width: the top rule, every row,
   and the bottom rule of a box share one width.
10. A change to a component or a spec §5 design updates its prototype scene (spec §9)
    in the same change and runs `node docs/design/prototypes/ui-preview.mjs
    --smoke`; a diagram quoted from a scene is copied from its output.

## 6. Implementation backlog

### 6.1 Design to code

The design in [component-library.md](./component-library.md) is the target. Each row maps
an earlier refinement item to the design section that now specifies the effect, with the
files it touches. Items are not ranked or scheduled here; the implementation change
chooses the order. `A3` (a running-block cue without a rail) was not adopted into the design.

| ID | Item | Design | Touch points |
| --- | --- | --- | --- |
| A2 | Rounded chrome everywhere | spec §2.1 | `core/ui-patterns.ts` (`renderSurfaceHead`, `renderSurfaceTail`); every `surface*` / `app-*` shot. |
| A4 | Consolidate the transcript glyph vocabulary | spec §2.2 | `transcript/components.ts`, `transcript/thinking.ts`, `transcript/pane-activity.ts`, `interaction/symbols.ts`. |
| B4 | Mode chips in status row 1, an undecorated editor whose border color is the shell mode | spec §3.3, §5.2 | `interaction/mode-status.ts` (uppercase `PLAN`/`YOLO` chips, priority 1; no `SHELL` chip), `interaction/editor-plus.ts` (drop `setBorderLabel` for bash, keep `setBorderColor` and `setPromptSymbol`; the title moves to the top-right corner), `interaction/mode-commands.ts` (still owns the mode snapshot); `website/**/features/status-bar.md` and `modes.md`. |
| B5 | Feedback severity prefix | spec §2.4 | `core/ui-compiler.ts` (feedback row), `core/ui-interaction-notifications.ts`. |
| C1 | Use the diff tokens and add hunk headers | spec §4.1 | `core/diff-align.ts`, `core/plugin-view.ts`; `diff.svg`. |
| C2 | Highlight standalone code | spec §4.1 | `core/plugin-view.ts` (code arm), `core/highlight.ts`. |
| D1 | `NO_COLOR` and reduced motion | spec §2.3 | `core/theme-palette.ts`, `core/ui-loader-animation.ts`, `transcript/spinners.ts`. |
| D3 | One animation per surface | spec §2.3 | the loader clock and the pane/transcript timers; a guard spec. |
| E1 | Inline thinking strip on the model row | spec §5.9 | `packages/ui/src/contracts.ts` (`inheritedId`), `core/ui-validator.ts`, `core/ui-patterns.ts` (`renderListSegment` inline layout), `core/ui-compiler.ts` (list body and reserved footer line), `interaction/model-commands.ts` (drop the `default` pseudo-option); specs and an `app-model` screenshot. Full gate. |
| E2 | Button-free pickers | spec §5.9 | `interaction/model-commands.ts` (`openPickerOverlay`), the `Set as default` locale key, `model-commands.spec.ts`, `model-selection-ui.spec.ts`. |
| E3 | Effort visible without focus | spec §5.9 | `interaction/model-commands.ts` (badge text, locale keys). |
| E4 | Arm delay for unprompted decisions | spec §5.7 | `packages/ui` overlay registration, `core/ui-interaction-*.ts`, `interaction/request-overlay.ts`; a replay test that types into the editor while a request opens. Full gate. |
| E5 | Slash-only list filter | spec §3.4 | `packages/ui/src/contracts.ts` and `builders.ts`, `core/ui-validator.ts` (the `printableKey` budget check at the end of validation), `core/ui-compiler.ts` and `core/ui-key-grammar.ts` (filter start binding and the `/ filter` hint), the owning specs. Full gate. |
| H8 | Editor placeholder for the typed prefixes | spec §3.3 | `core/components.ts` and `core/chrome.ts` (`setGhostHint`, `injectGhostHint` variant selection), `core/types.ts` (editor interface), `interaction/editor-plus.ts` (`ghostHintFor` for the empty buffer, argument hint precedence), new `interaction/placeholder.ts`, `interaction/locale.ts` and zh copy; the editor width scan and a state spec. Runtime change: dedicated-profile acceptance. |
| H7 | Owner-local prompts | spec §3.3 | `interaction/pane-queue.ts`, `interaction/editor-plus.ts` (completion footer), `website/**/features/panes.md` and `editor.md`. |
| H2 | Complete the `Ctrl+O` cue | spec §3.3 | `transcript/hints.ts`, `transcript/process-rows.ts`, `transcript/thinking.ts`, `transcript/components.ts`, `transcript/read-group.ts`, `transcript/search-group.ts`, `transcript/command-group.ts`, `transcript/tool-line.ts`, `transcript/locale.ts`; expose a readonly disclosure projection (expanded, foldable count in scope) for the H1 `keys` entry. |
| H3 | One key notation | spec §3.3 | `transcript/hints.ts` (`HINTS_ZH`), `transcript/locale.ts`, `transcript/pane-todo.ts` fallback, `website/**/reference/keys.md`, `website/**/features/streaming.md`, `website/**/guide/config.md`. |
| H4 | Quiet key hints setting | spec §3.3 | `interaction/settings.ts`, `interaction/settings-model.ts`, locale catalogs, `transcript/pane-activity.ts` (gap), and the new `interaction/placeholder.ts` (H8). There is no existing `prompt-hints` module. |
| H5 | Teach keys, not only commands | spec §3.3 | `transcript/tips-content.ts`, `transcript/status-tips.ts`, `transcript/pane-activity.ts`. |
| H6 | A keyboard route to older folded turns | spec §5.6 | `transcript/transcript-model.ts`, `transcript/hints.ts`, `core/surface-renderer.ts`. |
| B1 | One decision-card skeleton | spec §5.7 | `interaction/approval-plugin.ts`, `interaction/plan-review-panel.ts`, `interaction/permission-panel.ts`, `interaction/authorization-ui.ts`; interaction width scans. |
| B2 | List navigation affordances | spec §4.4 | `core/ui-compiler.ts` (list runtime), `core/ui-patterns.ts` (`renderList`), locale catalogs. |
| B3 | Busy elapsed and unsaved marker | spec §4.2, 4.7 | `core/ui-patterns.ts` (`renderActions`), `core/ui-compiler.ts` (action pending timing). |
| C3 | Chart legend and Website gallery | spec §4.1 | `core/chart-renderer.ts`, `interaction/session-info-model.ts`, the Website gallery. |
| C4 | Status grid and priority overflow | spec §4.7 | `transcript/status-model.ts` and the status plugins. |
| D2 | Unicode fallback | spec §8 | `core/chrome.ts`, `core/ui-patterns.ts`, `transcript/banner.ts`, `transcript/spinners.ts`. |
| F1 | Buttons on demand | spec §4.2 | `packages/ui` contract, `core/ui-patterns.ts` (`renderActions`), `core/ui-compiler.ts`, `core/ui-key-grammar.ts` (group hint), `interaction/questionnaire.ts`. Full gate. |
| F2 | Live-following label column | spec §4.5 | `packages/ui/src/interaction.ts`, `core/ui-interaction-choice.ts`, the sessions and settings panels. |
| A3 | Running-block cue without a rail | not in the design | `transcript/process-rows.ts` (`TurnHeaderComponent`), `transcript/components.ts`. |

### 6.2 Conformance register

Known gaps between this catalog and the code, or defects the audit found while
verifying it. IDs are stable; delete a row when its fix ships. Related
findings in the 2026-09-28 audit (PR #77) are cited as `UX-nn`.

| ID | Gap | Where | Fix |
| --- | --- | --- | --- |
| G2 | `Enter open` on pickers that commit: `browse` role forces the `open` verb (UX-23) | `core/ui-key-grammar.ts` `rowBindings`, `interaction/model-commands.ts` | additive `acceptVerb`, then set it on the model and effort pickers |
| G3 | The segment strip is appended after the list body, not on its row, and a row without a strip changes the list height (spec §1.1 principle 6) | `core/ui-compiler.ts` `segmentRows` | E1 |
| G4 | Two current markers: `CURRENT_MARK = '← current'` (renders `[← current]`) in theme and permission pickers, `[current]` in the model picker; `SELECT_POINTER = '❯'` is exported but unused while the painter draws `→` | `interaction/symbols.ts`, `theme-switch.ts`, `permission-panel.ts`, `model-commands.ts` | one localized `current` badge; delete `CURRENT_MARK` and `SELECT_POINTER`; drop `symbols.ts` from A4's touch points |
| G5 | Approval `Esc` is labeled `close` but rejects; `Reject with feedback` is a tab plus a `Back` button | `interaction/approval-plugin.ts`, escape labels in `core/ui-key-grammar.ts` | overridable Escape label; B1 |
| G7 | Redundant buttons: `Set as default` + `Cancel` (pickers); `Back`/`Next`/`Submit answers`/`Cancel` (questionnaire); loader `[ Cancel ]`; single-field form `Submit`/`Cancel` | see spec §4.2 redundancy rule | E2, F1 |
| G8 | Three checkbox notations: `●`/`○` (multiple lists), `[x]`/`[ ]` (pickers), `[on]`/`[off]` (toggle); `●` is also the "selected" marker in single lists (UX-24) | `core/ui-patterns.ts` `renderList`, `renderFormField` | every choice list and picker adopts `●`/`○`/`◐`; `[on]`/`[off]` stays for toggles |
| G9 | Hint verbs overlap: `pick` (open a select), `choose`, `apply`, `open` (UX-23) | `core/ui-key-grammar.ts` | settle on the spec §3.2 vocabulary; rename `pick` |
| G10 | The main screen has no persistent key prompt; `Esc` interrupt, `Ctrl+S`, `Alt+Enter`, `Ctrl+G`, `Shift+Tab`, `Alt+M`, and `F6` are cued nowhere | `interaction/input-plugin.ts`, `interaction/keys.ts` | H1 |
| G11 | The `Ctrl+O` cue is scope-limited (last `expandTurns` turns), one-directional (no `collapse` after expanding), silently dropped on narrow rows, and hard-coded as `ctrl+o` instead of read from the keymap (the todo pane does read it) | `transcript/hints.ts`, `process-rows.ts`, `thinking.ts`, `locale.ts` | H2 |
| G12 | Three notations for one key: `ctrl+o` (inline), `Ctrl-O` (zh copy, Website), `Ctrl+O` (grammar, `/help`) | `transcript/hints.ts`, `website/**` | H3 |
| G13 | (spec §7: the idle screen stays empty by decision; tips live in the `Deep diving` row's gap.) Tips rotate only while a turn runs; the idle screen teaches nothing, and the `#` skills prefix is cued nowhere (`!` and `@` appear in the rotation) | `transcript/tips-content.ts`, `interaction/editor-plus.ts` | H5, H8 |
| G14 | No keyboard route to blocks older than `expandTurns` | `transcript/transcript-model.ts` | H6 |
| G15 | The Website says the queue pane never takes `↑`, but `↑` on an empty prompt withdraws the newest queued message (`withdrawQueued`) | `website/**/features/panes.md`, `editor.md`; `interaction/input-plugin.ts` | H7 |
| G16 | The status-bar page documents a single-row footer with plan/yolo as lowercase text; the footer already renders two rows and nothing uses row 2 | `website/**/features/status-bar.md`, `transcript/status-model.ts` | H1, B4 |
| G17 | Side-conversation identity and `F7`/`F8` share one centered entry on the crowded state row; `F8` says `close` for a subagent although it only detaches | `interaction/conversation-view-status.ts` | H1 |
| G18 | The subagent reply form draws `Send` and `Cancel` buttons, and `Enter` in its textarea does not send | `interaction/subagent-reply.ts` | H1 |
| G19 | Bash mode writes `! shell mode` into the editor's left border, the only text besides the session title | `interaction/editor-plus.ts` | B4 |
| G20 | The activity row truncates the running action to one line (`DETAIL_BUDGETS`); a long command or reasoning paragraph is cut | `transcript/pane-activity.ts` | R2 |
| G21 | Frame tables mix a two-cell moon slot, braille, and an unused `tide`; the waiting ripple and the working rotation are separate motions | `transcript/spinners.ts`, `core/ui-patterns.ts` | R1 |
| G22 | Diff rows have only a two-column sign gutter (`GUTTER_COLUMNS = 2`); there are no old or new line numbers | `core/diff-align.ts`, `core/plugin-view.ts` | R3 |
| G23 | Subagents live in a pane above the editor and jobs only as a footer count; neither can be selected from the keyboard | `transcript/pane-agents.ts`, `transcript/status-jobs.ts` | R7 |
| G24 | Tabs cannot render a vertical rail that follows the cursor; the label column switches only on `Enter` (ref §6 F2) | `core/ui-compiler.ts` | R9 |
| G25 | The spec §5 panels (`/plugin`, sessions, tray, scenarios) call for bare printable accelerators beside a list, but the validator rejects a printable `key` on any surface with a type-to-filter list | `core/ui-validator.ts` (`printableKey`), spec §5.10–spec §5.11 | E5 |

### 6.3 Redesign touch points and open questions

| ID | Item | Touch points |
| --- | --- | --- |
| R1 | Motion and glyph system (spec §2.3); retire the ripple and `tide` | `transcript/spinners.ts`, `core/ui-loader-animation.ts`, `core/ui-patterns.ts` |
| R2 | Activity pane detail lines and gap; the `Deep diving` label is kept (spec §5.3) | `transcript/pane-activity.ts`, `conversation/activity-detail.ts`, `transcript/process-activity.ts`, `transcript/locale.ts` |
| R3 | Edit diff with line numbers and a red or green background behind the changed code (not the line numbers); Write as one line, highlighted code when expanded (spec §5.3) | `core/diff-align.ts`, `core/plugin-view.ts`, `transcript/tool-line.ts`, `transcript/process-rows.ts` |
| R4 | Loader variants and determinate bar (spec §4.8) | `core/ui-patterns.ts`, `packages/ui/src/contracts.ts` |
| R5 | Compaction bar and settled rule (spec §5.6) | `transcript/compaction.ts`, `conversation/facts.ts` |
| R6 | Todo and goal rule progress, moved from the stream to status row 2 (spec §5.4) | `transcript/pane-todo.ts`, `transcript/status-goal.ts` |
| R7 | Agents and jobs views in status row 2 (spec §5.1, §5.5) | `transcript/pane-agents.ts`, `transcript/status-jobs.ts`, `interaction/agents-command.ts`, `interaction/jobs.ts`; overlay for the focused view (ref §3.2), `packages/ui` unchanged |
| R8 | Decision skeleton and question wizard (spec §5.7) | `interaction/approval-plugin.ts`, `interaction/questionnaire.ts`, `core/ui-key-grammar.ts` |
| R9 | Text-color tabs, live-following rail, expandable lists, form refinements (spec §4.4) | `core/ui-patterns.ts`, `core/ui-compiler.ts`, `core/theme-palette.ts`; `packages/ui/src/contracts.ts` (`MayflyFormFieldBase.help`/`group`, `MayflyTabItem.attention`, `MayflyTabsNode.orientation`, `MayflyListItem.body`), `core/ui-validator.ts` |
| R10 | Sessions, settings, and status panels; account balance (spec §5.10) | `interaction/session-list-model.ts`, `interaction/session-workspace-panel.ts`, `interaction/settings.ts`, `interaction/usage.ts`; `filterMode: 'slash'` for the sessions list |
| R11 | Interaction scenarios (spec §5.13) | `interaction/external-editor.ts`, `core/ui-key-grammar.ts`; `filterMode: 'slash'` where a list has printable accelerators; empty-prompt `?` |
| R12 | Selectable and searchable conversation stream; scroll pill and scrollbar (spec §5.6) | `core/` (transcript viewport), `transcript/transcript-model.ts` |
| R13 | Contrast and one-motion-channel guard specs (ref §6 D1, D3) | `packages/mayfly/tests/core/` |
| R14 | Website key and status-bar pages follow spec §7 | `website/**` (needs the Website acceptance path) |
| R15 | Plugin marketplace: split view, key-driven actions, restart banner (spec §5.11) | `interaction/plugin-commands.ts`, `interaction/plugin-market/`; `filterMode: 'slash'` (E5) is a prerequisite |
| R16 | Onboarding: step strip, button-free steps, optional permissions step (spec §5.12) | `interaction/welcome.ts`, `interaction/provider-onboarding.ts` |
| R17 | Account panel: button-free states, balance row (spec §5.12) | `interaction/provider-account.ts` |
| R18 | System rules: selection vocabulary, state patterns, breakpoints, key parity, `x` for delete (spec §2.4) | `core/ui-key-grammar.ts`, `core/ui-patterns.ts`, `interaction/session-workspace-panel.ts`, width scans; `packages/ui/src/contracts.ts` + `core/ui-validator.ts` (`filterMode`, E5); delete session depends on a Harness capability |
| R19 | Four transcript levels: distinct settled views, diffstat header, failure reason, one-place detail (spec §5.6) | `transcript/presentation-policy.ts`, `transcript/process-groups.ts`, `transcript/process-rows.ts`, `transcript/transcript-model.ts`, `interaction/settings-model.ts`, `website/**/features/streaming.md` |
| R20 | Two-row status area and the editor frame (title top-right, `[… ×]` tokens, queue then history recall, border-color shell mode) (spec §5.1, §5.2) | `interaction/mode-status.ts`, `transcript/status-*.ts`, `interaction/editor-plus.ts`, `interaction/input-plugin.ts`; a `ui.prompt`-style editor contract in `packages/ui` |
| R21 | Named actions, common meanings, and runtime rebinding with a `/keys` panel (spec §3.5, §5.15) | `core/ui-key-grammar.ts`, `interaction/keys.ts`, `interaction/settings.ts` (persist overrides); `packages/ui/src/contracts.ts` (`semantic`, `action`, `scope` on action items) |
| R22 | The `←` ladder: a control uses `←` only when it changed something, otherwise focus goes to the surface's rail (spec §4.5) | `core/ui-key-grammar.ts`, `core/ui-patterns.ts` (select, number, segment adjusters) |
| R23 | Inline decision cards with an open-in-editor key (spec §5.7) | `interaction/approval-plugin.ts`, `interaction/plan-review-panel.ts`, `interaction/external-editor.ts` |
| R24 | `/trace` tree with duration meters and highlighted JSON (spec §5.14) | `interaction/trace-command.ts`, `interaction/trace-aggregate.ts` (carry the turn on each item), `interaction/trace-format.ts` |
| R25 | Usage tab: activity heatmap and conversation statistics (spec §5.10) | `interaction/usage.ts`, `packages/ui/src/contracts.ts` (heatmap `cell`, `columnLabels`) |

Verification for any of these follows the root gate: width scans for every new
row renderer, the owning suite for lifecycle changes, `pnpm run verify:full`,
and a dedicated-profile install with PTY smoke and human acceptance.

**Implementation questions** (the design questions are in spec §8):

1. Is the account balance reachable through the native provider services, or does it need a
   new read-only service?
2. Do `Alt+↑`/`Alt+↓` (stream and views), `F6`, `Ctrl+F`, `Ctrl+G`, `Ctrl+J`, and `?` conflict with the
   keymap or with terminal and multiplexer bindings, and does `↑`/`↓` queue-then-history recall fit the existing
   `withdrawQueued` behavior?
3. Where are stream search matches computed for folded blocks (rendered rows live in
   `core/`, which owns width and ANSI truth), and how does the stream map a selected row back to the facts it copies
   or opens in `$EDITOR`?
4. The name and exact semantics of the proposed list field `filterMode: 'slash'`
   (spec §3.4, ref §6.1 E5): whether `/` re-opens a kept query, and how it interacts with
   `acceptActionId` and numbered lists. Today the validator rejects a printable action
   `key` on any surface that holds a type-to-filter list (`core/ui-validator.ts`).
5. The "loads more" row of spec §4.4: panes and overlays already page whole snapshots
   (`load`, `nextCursor`, `loadMore()`, ref §3.2), but a list group has no paging contract;
   a path field needs a completion source (`complete()` exists only for editor extensions).
6. Does the native Harness expose session deletion?
7. Can each trace item carry its turn, and can the event store give the counts the Usage tab shows (turns per day,
   tool success rate, streak) without a new read path?
8. Where do keymap overrides persist, and how are a plugin's action ids registered so the `/keys` panel can list them
   before the plugin's panel has been opened?
