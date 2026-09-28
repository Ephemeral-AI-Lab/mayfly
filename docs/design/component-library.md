# Mayfly UI component library

This document is the design catalog for Mayfly's shared UI components: the
visual language, each component's wire interface, its keyboard behavior, and
the composition recipes for whole panels. It exists so that every pane,
overlay, and editor extension looks and behaves the same without each author
reinventing focus, hints, validation, or painting.

The executable authority is the type schema in
[`packages/ui/src/contracts.ts`](../../packages/ui/src/contracts.ts) and the
tests under `packages/mayfly/tests/core/`; when this document and the code
disagree, the code wins and this document must be updated. Companion
documents: [interaction-model.md](../interaction-model.md) owns input routing,
the key grammar, the Escape ladder, and focus rules;
[mayfly-seams.md](../mayfly-seams.md) owns the four contribution services and
the layout limits.

## 1. How a component works

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

## 2. UX principles

1. **Keys, not buttons.** Every operation is reachable from the keyboard
   focus or a declared accelerator. The actions row exists to make operations
   discoverable, not to be clicked. Prefer: `Enter` on the focused control,
   digits on numbered lists, type-to-filter on long lists, and a declared
   `key` accelerator for the few operations that deserve one.
2. **Enter confirms.** The focused control activates with `Enter`; `Space`
   toggles. Single-field forms declare `enterSubmits` so `Enter` inside the
   field submits the form — there is never a separate "move to the Save
   button" step.
3. **Report errors in real time, in place.** Validation failures return
   `invalid` with feedback and repaint beside the field; unavailable
   operations render disabled with their `disabledReason`; a filterable list
   narrows as you type. Never add an extra dialog or a second `Enter` where
   an inline reply suffices.
4. **One safe default.** `defaultFocus` sits on the least destructive action,
   and every Yes/No question is the shared `[No] [Yes]` decision with No
   focused first.
5. **Hints never lie.** The hint row is derived from the same ordered binding
   list that dispatches keys, and it updates with every state change
   (searching, editing, busy, decision open). It shows up to three fragments
   below 80 columns and four from 80; Escape is always first when it does
   something.
6. **Stable, additive interfaces.** Wire contracts evolve by addition only —
   see §5.

## 3. Visual language

Surface chrome anatomy:

```
╭ Approve bash? ─────────────────────────────────────────╮ ← chrome + title
│ optional subtitle (muted)                              │
│ [badge] [badge]                                        │
│                                                        │
│ → focused row (inverted)                               │ ← content
│   ordinary row                                         │
│                                                        │
│ optional custom footer node                            │
│   Esc close · Enter run · Tab actions                  │ ← hint row (muted)
╰────────────────────────────────────────────────────────╯
```

- Chrome kinds: `overlay` (`╭ ╮`, focus-colored border), `surface` (`┌ ┐`),
  `lane` (`─` rules), `none` (bare title). A surface's `footer` node carries
  custom content above the generated hint row.
- The hint row is indented two columns, fragments joined by ` · `
  (`Esc close · Enter run · Tab actions`).

Marker legend:

| Marker | Meaning |
| --- | --- |
| `→` | focused row or control (also inverted) |
| `‹ value ›` | active tab, or a focused select value that `←`/`→` can cycle |
| `●` / `○` | selected / unselected row in a multiple-mode list |
| `[x]` / `[ ]` | check state in option pickers and multiselects |
| `[on]` / `[off]` | toggle field value |
| `[ label ]` | primary-intent action |
| `! label` | danger-intent action |
| `… label` | busy action (running) |
| `label — reason` | disabled action or row, with its reason |
| `1.` … `9.` | numbered rows |
| `/ query` | active filter row of a filterable list |
| `[badge]` | row badge (for example `current`) |
| `! message` | field validation error, indented under the field |
| `⠋` | braille loader frame |
| `█` / `░` | filled / empty progress-bar cells |

## 4. Components

Each entry gives the wire interface (trimmed; see `contracts.ts` for the full
type), the builder, the rendered states, and the keys. All states are painted
by `core/ui-patterns.ts`; authors only supply data.

### 4.1 Actions row (buttons)

Buttons exist only as items of an `actions` node — there is no standalone
button control, because an operation always belongs to a surface.

```ts
interface MayflyActionItem {
  id: string, label: string
  intent?: 'primary' | 'secondary' | 'danger'
  disabled?: boolean, disabledReason?: string
  busy?: boolean
  confirm?: string | MayflyConfirmation   // shared Yes/No decision
  submit?: MayflyFormAddress[]            // domain write boundary
  read?: MayflyFormAddress[]              // validation only (wizard Next)
  selections?: MayflySelectionAddress[]   // list selections to collect
  defaultFocus?: boolean, dismiss?: boolean
  navigate?: MayflyPagePath               // pure page navigation
  key?: string                            // accelerator, see §5
}
```

```ts
ui.actions({ id: 'save-bar', items: [
  { id: 'save', label: 'Save', intent: 'primary', submit: [{ pagePath: [], formId: 'editor' }] },
  { id: 'copy', label: 'Copy', key: 'c' },
  { id: 'delete', label: 'Delete provider', intent: 'danger',
    confirm: { title: 'Delete provider?', tone: 'danger' } },
] })
```

Rendered states:

```
  [ Save ]   Copy (c)   ! Delete provider
    ↑ primary   ↑ accelerator shown as (c)   ↑ danger

→ [ Save ]                        focused: inverted + cursor marker
  … Saving                        busy: muted, keeps focus while running
  Delete provider — archive it first     disabled: muted, reason after " — "
  [ Save ]   +2                   narrow widths fold hidden tokens into +N
```

Layout: one horizontal row; vertical in the main screen mode. `Enter` or
`Space` runs the focused action, arrows move between actions, a declared `key`
fires its action directly from anywhere on the page, and `Tab`/`Shift+Tab`
enters or leaves the group.

**Shared decision.** Every `confirm` renders the same way — No focused first,
Escape answers No:

```
  Delete provider?
  Removes the stored credentials.          ← optional detail (muted)
→ [No]   [Yes]
```

Rules: put `defaultFocus` on the least destructive action; express
unavailability as `disabled` + `disabledReason` (never reject after the fact
in the handler); use `confirm` for every Yes/No question instead of drawing a
custom confirm page. Mark an action `busy` while its handler is in flight —
the busy action keeps its focus highlight.

### 4.2 Text fields

`input`, `textarea`, `secret`, and `number` fields of a `form` node:

```ts
{ kind: 'input' | 'textarea' | 'secret', value: string, placeholder?: string,
  minLength?: number, maxLength?: number }
{ kind: 'number', value: number | null, min?: number, max?: number, step?: number,
  unit?: string }
// every field: id, label, error?, required?, disabled?, disabledReason?,
//              origin?: 'inherited' | 'explicit', resetValue?
```

Rendered states:

```
  Name: e.g. production          placeholder (muted) while the value is empty
  Name: foo                      filled
→ Name: foo                      focused
→ Name: fo▌                      editing (▌ is the terminal cursor)
   ! Required                    error, repainted from an invalid reply
  Token: •••••                   secret never echoes plaintext
  Timeout: 30 s                  number renders its unit
  Region: us-east (Inherited)    origin field; shows (Override) once edited
```

Keys: typing or `Enter` starts editing; while editing, `Enter` commits and
moves on — or submits the whole form when the form declares `enterSubmits` —
and `Alt+Enter` inserts a textarea newline. `Delete` on a focused,
non-editing field whose value differs from `resetValue` resets it (the
`reset` / `use inherited` hint exists only while a reset would change
something). Escape ends editing and keeps the draft (`done` step). Drafts
survive renderer reloads and rejected submissions.

Forms render `submitLabel` / `cancelLabel` (localized "Submit"/"Cancel" by
default) — never raw action ids.

### 4.3 Choice fields — the radio and checkbox analogs

There are no separate radio or checkbox node kinds; the mapping is:

| HTML analog | Mayfly component |
| --- | --- |
| radio group | `select` field (or a `choose` list for a page-level choice) |
| one checkbox | `toggle` field |
| checkbox group | `multiselect` field (or a `mode: 'multiple'` list) |

**select** — switch options without opening anything:

```
  Protocol: Choose…                       unset
→ Protocol: ‹ anthropic-messages ›        focused: ← → cycle the value
→ Protocol                                picker open (Enter)
   > [ ] openai-completions
   > [x] anthropic-messages
   > [ ] custom: not available in this plan
```

- While focused, `←`/`→` cycle the value **without wrapping** and skip
  disabled options; from an unset value `→` picks the first enabled option and
  `←` the last. This is the fastest path — two keys, no dialog.
- `Enter` opens the option picker for the full list. In the picker `↑`/`↓`
  move the candidate, `Enter` applies, `Tab`/`Shift+Tab` applies and moves to
  the next group, Escape cancels back to the field (`cancel` step).
- `↑`/`↓` always move between fields — they never change a select's value.

**toggle** — flips directly, never opens anything:

```
→ Notifications: [on]      Enter or Space flips to [off]
```

**multiselect** — opens with `Enter` or `Space`, never implicitly:

```
→ Channels: mentions, errors     collapsed value (or "None selected")
→ Channels                       open:
   > [x] mentions                  Space toggles the candidate
   > [ ] errors                    Enter applies the toggled set
   > [ ] digest: enterprise only   disabled option with reason
```

### 4.4 Lists

```ts
interface MayflyListNode {
  kind: 'list', id: string
  role: 'browse' | 'choose'        // browse: Enter opens; choose: Enter picks
  mode?: 'single' | 'multiple'
  selectedIds: string[], items: MayflyListItem[]
  filter?: string, filterable?: boolean
  tree?: boolean
  numbered?: boolean | 'focus'     // digits 1–9 choose, or only move the cursor
  minSelected?: number, maxSelected?: number
  acceptActionId?: string          // the action Enter resolves to
  empty?: MayflyUiNode             // rendered when there are no items
}
// MayflyListItem: id, label, detail?, badge?, group?, disabled?,
//   disabledReason?, parentId?, searchText?, segment?,
//   unavailableActions?: { [actionId]: reason }, confirm?
```

Browse list with filter, groups, badges, and details:

```
╭ Select a model ────────────────────────────────────────────╮
│ / deep▌                       filter row while searching   │
│ DeepSeek                      group header (muted)         │
│ → deepseek-v4-pro — 256k context [current]  ← focused (inverted)
│   deepseek-v4 — 128k context                               │
│   gpt-5 — retired 2026/01       disabled row shows reason  │
│                                                             │
│   Esc close · Enter open · Type filter · Tab actions       │
╰─────────────────────────────────────────────────────────────╯
```

Numbered choose list (decisions with ≤ 9 options):

```
→ 1. Preset endpoint — known provider
  2. Custom endpoint — any compatible URL
  3. OAuth provider — browser sign-in

  Esc cancel · 1-3 choose · Enter choose
```

Digits pick a row directly (`numbered: 'focus'` only moves the cursor, so
gated surfaces like plan review still require `Enter`). Numbers label the
visible rows and stay stable while the window scrolls; the hint shows the
real range and is omitted while searching.

Multiple mode:

```
→ ● mentions                     Space toggles, Enter commits
  ○ errors                       minSelected/maxSelected bound the set
```

Tree mode: rows with a `parentId` indent under their parent; `←`/`→` (or
`Space`) closes and opens branches.

Segment strip — a horizontal option bar bound to the focused row; `←`/`→`
steps it, and `selection-accept` reports it as `segmentId`:

```
→ deepseek-v4-pro — 256k context
   Effort: low  ‹ medium ›  high  +2     ← active option stays visible; +N folds the rest
```

Keys on any list: `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End` move; `Enter` chooses
(or opens for `browse`); typing or `/` starts filtering on a filterable list,
`Ctrl+U` clears the query, Escape ends the search keeping the filter; `←`/`→`
adjust a row segment, open or close a tree branch, or otherwise leave the
list toward the nearest control beside it. Choice reducers never focus a
disabled row, so `Enter` can never accept one.

Per-row availability: an item's `unavailableActions` maps action ids to
reasons — while that row is the selection, the action renders disabled with
the reason and invoking it reports the reason instead of running. An item's
own `confirm` asks before its selection is accepted.

**Read-only lists** are `role: 'browse'` (Enter opens a detail view rather
than choosing). For purely static content with no interaction, use `fields`,
`sections`, or `markdown` content nodes instead of a list.

### 4.5 Tabs

```ts
interface MayflyTabsNode {
  kind: 'tabs', id: string, activeId: string
  items: { id: string, label: string, disabled?: boolean, count?: number,
           backId?: string }[]
  mode?: 'tabs' | 'wizard'
}
```

```
  ‹ Decision ›  Reject with feedback        active tab wrapped in ‹ ›
  Sessions 4   ‹ Settings ›  +1             counts above 40 columns; +N overflow
  Kind   ‹ Connection ›   Models            wizard: ordered steps
```

Keys: `←`/`→` move along a focused tab strip, and `Enter` descends into the
page (`open`); `Alt+←`/`Alt+→` switch tabs from anywhere outside text editing
and open pickers. Tab strips are not an Escape-ladder stop; on a wizard page
with `backId`, Escape walks back (`back` step). A wizard runs the same step
validation on a forward tab switch as on its Next action, so invalid steps
cannot be skipped by any path.

Pages are pinned with `ui.child(node, { tab: { controlId, itemId } })`; a
switch emits a `tab-change` observation and the owner re-projects the page
content.

### 4.6 Tabbed pages with labels on the left: sessions and settings

Sessions and settings are separate panels sharing one layout: a horizontal
split whose **left column is the tab strip rendered vertically** — labels
stacked top to bottom — and whose right side shows the active group's
content.

The sessions panel — one label per workspace; the right side lists that
workspace's sessions:

```
╭ Sessions ────────────────────────────────────────────────────╮
│  Workspaces    │  → fix login redirect           2h ago      │
│  → mayfly    4 │    mayfly docs sync            1d ago       │
│    dsh       1 │    release 0.9.0               3d ago       │
│    website   2 │                                             │
│   ↑ labels (choose list; ● marks the active group)           │
│                  ↑ content: sessions of the active workspace │
│   Esc close · Enter open · Type filter · Tab content         │
╰──────────────────────────────────────────────────────────────╯
```

The settings panel — one label per namespace; the right side is the shared
schema-driven form:

```
╭ Settings ────────────────────────────────────────────────────╮
│  → General    │  → Theme: ‹ dark ›                           │
│    Providers  │    Notifications: [on]                       │
│    MCP        │    …                                         │
│    Appearance │                                              │
╰──────────────────────────────────────────────────────────────╯
```

Recipe — the label column is an ordinary list, the content is the second
child of a row stack:

```ts
ui.stack.row([
  ui.child(ui.list({ id: 'workspaces', role: 'choose', items: [...] }),
           { basis: 24 }),
  ui.child(sessionsOf(selectedWorkspace)),
])
```

Keys come free from the shared grammar: `↑`/`↓` move between labels, `→` or
`Tab` crosses into the content, `←` returns to the label column, and each
side keeps its own cursor and (if filterable) query. A label's `count` badge
carries the group size.

Two honest notes:

- With today's contracts the label column is a list, so the content switches
  when a label is accepted (`Enter`). Following the cursor live — and painting
  the column as a true vertical tab strip with an `‹ ›` active label — would
  be a small extension per §5 (a `tabs` orientation field, or a list cursor
  observation).
- With only two to four short labels, prefer the horizontal strip of §4.5
  with the content beneath it — that is what approval (Decision / Reject with
  feedback) and `/mcp` (tools / config) use.

These are target layouts for a future rework — today's `/sessions` and
`/settings` ship as list-based overlays — composed from existing primitives.

### 4.7 Surfaces and the key-hint footer

Every capturing surface gets its prompt footer from the key grammar, and the
row updates with every state change. Representative hint rows for one surface
(exact fragments are computed per state):

```
idle, choose list:     Esc close · Enter choose · 1-3 choose · Tab actions
while filtering:       Esc end search · Ctrl+U clear · Enter choose
field edited:          Esc done · Enter submit · Delete reset · Tab fields
decision open:         Esc close · Enter confirm · ←→ actions
busy action focused:   Esc close · ←→ actions              (action shows …)
```

Rules (owned by `interaction-model.md`, restated for authors):

- The hint row shows up to three fragments below 80 columns and four from 80.
- Escape is always first when it does something, and always names the exact
  step: `collapse`, `cancel`, `done`, `end search`, `back`, `close`, `leave`.
- Then come the primary operation, declared accelerators, adjustment
  (`adjust`/`tabs`), navigation, digit ranges, and secondary keys.
- A hint can never advertise a dead key: dispatch and hints read the same
  ordered binding list.
- Editor decorations do not get a hint row; they declare `hint?: string` and
  may only bind modifier accelerators.

### 4.8 Decision panels: approval, plan review, permission

Every "the agent asks, the user decides" surface — tool approval, plan
review, the permission preset ask — is the same composition of basic
components: a **vertical choose list of options**, optional **same-line input
fields** beneath it, and the shared confirm for destructive picks. There is
no decision-specific widget.

```
╭ Approve bash? ───────────────────────────────────────────────╮
│ Runs: rm -rf build && pnpm build        ← scrollable reason  │
│ → 1. Allow once                                              │
│   2. Allow bash for this session                             │
│   3. Reject                                                  │
│   Feedback: ▌                       ← same-line input: focus │
│                                       it, Enter starts typing│
│   Esc reject · 1-3 choose · Enter choose                     │
╰──────────────────────────────────────────────────────────────╯
```

- Options are a numbered choose list (`role: 'choose'`, `numbered: true`):
  digits decide instantly, `↑`/`↓` + `Enter` stays equivalent. Rows may carry
  detail text, badges, disabled reasons, and a per-row `confirm` (a danger
  row asks the shared `[No] [Yes]` before its selection is accepted).
- Inputs are ordinary form fields, which render on one line as
  `Label: value` — `Feedback: …`, `Revise: …`, `Others: …`. Focus the field
  and press `Enter` (or just type) to edit in place on that same line;
  `Enter` commits. The decision settles as one action collecting the list
  selection (`selections:`) and the field (`submit:`) — exactly the
  questionnaire page composition (§4.9).

```
╭ Plan ready for review ───────────────────────────────────────╮
│ → 1. Approve and start                                       │
│   2. Reject                                                  │
│   Revise: ▌                 ← type the revision in place     │
╰──────────────────────────────────────────────────────────────╯

╭ Permission preset ───────────────────────────────────────────╮
│ → 1. Default — ask before writes                  [current]  │
│   2. Accept edits — apply file edits freely                  │
│   3. Full access — no prompts        ← row confirm asks first│
╰──────────────────────────────────────────────────────────────╯
```

Shipped state: the permission picker and plan review already follow this
shape (plan review uses `numbered: 'focus'` so `Enter` alone can never
approve, plus declared accelerators); tool approval currently ships a
horizontal actions row with `defaultFocus` on Reject
(`src/interaction/approval-plugin.ts`) and is the candidate to adopt the
vertical list. Either way the lifecycle invariants hold: requests are FIFO
per Agent, allowances live until that exact Agent is disposed, dismissal and
abort settle distinct outcomes, and feedback steers the Agent with the typed
reason.

### 4.9 Question panel pattern

A multi-question prompt (`src/interaction/questionnaire.ts`) is one wizard
tab per question; a single question drops the strip entirely.

```
╭ Questions ───────────────────────────────────────────────────╮
│ ‹ Auth ›  Region                    ← wizard tabs (Q1, Q2)   │
│ Which auth method?                                           │
│ → 1. OAuth — browser sign-in                                 │
│   2. API key — paste a token                                 │
│   3. No selection                                            │
│   Other: ▌                    ← free-text fallback (textarea)│
│   [ Next ]                                                   │
│   Esc close · 1-3 choose · Enter next · Alt+←→ tabs          │
╰───────────────────────────────────────────────────────────────╯
```

- **Switching questions:** `Alt+←`/`Alt+→` from anywhere (a forward switch
  runs the same validation as Next, so invalid steps cannot be skipped), or
  `←`/`→` on the focused tab strip, or the Back/Next actions.
- Digits answer instantly; `Enter` on an option accepts and advances
  (`acceptActionId` resolves to Next on early pages and to Submit on the
  last). `multiSelect` questions use `mode: 'multiple'` — `Space` toggles,
  `Enter` commits. The `Other`/`Answer` textarea has `enterSubmits`.
- One Submit collects every page at once: `submit:` lists every form address
  and `selections:` every list address, so no per-page writes exist.
- `Cancel` carries `dismiss: true`; closing answers with a cancellation.

### 4.10 Dynamic components: loader, progress, empty

**loader** — indeterminate work, renderer-animated:

```ts
{ kind: 'loader', message: string, variant?: 'braille' | 'tide',
  elapsedMs?: number, cancelActionId?: string, cancelLabel?: string }
```

```
⠋ Discovering models from api.example.com 12s      variant braille (default)
• Waiting for authorization                          variant tide: a calm pulse
                                                   [ Cancel ]  ← cancelActionId
```

Frames cycle `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (braille, 80 ms) or `·•●•·` (tide — a
breathing dot for waits on external action, visually distinct from the busy
braille rotation). The renderer owns the clock — all loaders in one surface
share it, and it stops when the surface hides or unloads; `elapsedMs` is
plain data the owner publishes (painted as `45s`, then `2m 10s`). Loaders
live in panes and overlays only: the status and editor-extension unions
exclude them, and live turn status belongs to the activity pane.

**progress** — determinate work only:

```
Building ██████░░░░ 6/10        partial cells ▏▎▍▌▋▊▉; narrow widths drop
                                 the label first, then the counter
```

**empty** — a list or page with nothing to show:

```
No sessions found
Restore a checkpoint with /rewind        ← muted description; optional actions
```

A list's `empty` node renders in place of the rows; standalone, `ui.empty`
fills an empty page.

## 5. Interface stability and extending the catalog

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
  never printable beside a filterable list, and modifiers only inside editor
  decorations.
- **A genuinely new component kind touches, in order:** the `contracts.ts`
  union → a `ui.*` builder → admission in `core/ui-validator.ts` → a painter
  in `core/ui-patterns.ts` → a control arm in `core/ui-compiler.ts` /
  `core/ui-key-grammar.ts` → rows in the owning `width-scan.spec.ts` → this
  catalog. `packages/ui` changes run the full gate.
- **Do not reimplement.** `core/scrollable-panel.ts` (session transcript) and
  the editor's autocomplete list (`SelectListAdapter`,
  `renderAutocompleteList`) are retained legacy integrations with their own
  key handling — they are not models. New surfaces compose wire nodes and
  inherit focus, hints, validation, and narrow-width behavior for free.

## 6. Author checklist

Pick the component by need:

| Need | Use |
| --- | --- |
| Yes/No before an action runs | action `confirm` (never a custom page) |
| Agent decision (approval, plan, permission) | §4.8 decision-panel composition |
| One of ≤ 9 options | `ui.list({ role: 'choose', numbered: true })` |
| Several of N | `mode: 'multiple'` with `minSelected`/`maxSelected` |
| Read-only inventory | `role: 'browse'` (static text: `fields`/`sections`/`markdown`) |
| Radio choice in a form | `select` field |
| One checkbox | `toggle` field |
| Checkbox group | `multiselect` field |
| Parallel pages | `ui.tabs` + tab-pinned children |
| Ordered steps | `mode: 'wizard'` + `backId`, `read` on Next |
| Tabbed page, labels on the left | §4.6 split recipe (`stack.row` + label list) |
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
