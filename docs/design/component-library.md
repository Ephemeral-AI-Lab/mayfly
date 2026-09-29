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
the layout limits. The refinement roadmap in §7 carries explicit
`shipped` / `target` / `backlog` labels; only `shipped` items describe running
behavior, and §7.4 registers the known gaps between this catalog and the code.
Hint rows in every diagram use the strings the key grammar really produces
(§2.2), not idealized ones.

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

1. **Keys, not buttons.** Every operation is reachable from keyboard focus or a
   declared accelerator. An actions row exists so an operation is discoverable,
   not so it can be clicked. Apply the *redundancy test* before drawing a
   button: if a bare key already performs the operation — `Enter` on the
   focused row, `Esc` for cancel/close, a digit, type-to-filter, `←`/`→` on a
   segment or select — do not draw it. Draw a button only for an operation no
   bare key reaches: a secondary write, a destructive action, or a choice
   between two equally valid commits.
2. **Enter confirms.** The focused control activates with `Enter`; `Space`
   toggles. Single-field forms declare `enterSubmits` so `Enter` inside the
   field submits the form — there is never a separate "move to the Save
   button" step.
3. **Report errors in real time, in place.** Validation failures return
   `invalid` with feedback and repaint beside the field; unavailable
   operations render disabled with their `disabledReason`; a filterable list
   narrows as you type. Never add an extra dialog or a second `Enter` where
   an inline reply suffices.
4. **One safe default, and no stray-key commits.** `defaultFocus` sits on the
   least destructive action, and every Yes/No question is the shared
   `[No] [Yes]` decision with No focused first. A surface that opens
   *unprompted* (tool approval, a question, a permission ask) can receive keys
   the user was typing into the editor a moment earlier, so its first digit or
   `Enter` must not grant anything (§4.8, roadmap E4).
5. **Hints never lie.** The hint row is derived from the same ordered binding
   list that dispatches keys, and it updates with every state change
   (searching, editing, busy, decision open). A hint names the *real effect*:
   `Enter open` is only truthful when `Enter` opens something (roadmap G2).
6. **Stable geometry.** Moving focus never changes the number of rows a
   surface paints and never shifts other rows. Per-row controls (segment
   strips) render inline on their row and fold before they wrap; the fallback
   footer line is reserved for the whole list, not just for the focused row
   (§4.4, §4.11).
7. **Recognition over recall.** Current state is visible without opening
   anything: `[current]` on the live row, `(Inherited)` / `(Override)` on
   fields, the active token of a strip, a select's value beside its label
   (`Theme: ‹ dark ›`). Never hide a value behind a dialog when it fits on the
   row.
8. **Preview, then commit.** Navigation and adjustment (`↑`/`↓`, `←`/`→`,
   filtering) never write anything. Only `Enter`, a digit on an unguarded
   list, or a declared accelerator commits. Every commit is either reversible
   in place (`Delete` reset, the Escape ladder) or asks first with No focused.
9. **One verb per meaning.** Hints, button labels, and toasts draw from the
   vocabulary in §2.2. A surface does not invent a synonym for `choose`,
   `open`, `apply`, or `run`.
10. **Stable, additive interfaces.** Wire contracts evolve by addition only —
    see §5.

Keystroke budget (from an open surface; digits and `Enter` count as one key):

| Frequency | Budget | Example |
| --- | --- | --- |
| Every session | 1 key | approve a plan (`Enter` on the focused decision) |
| Several per day | 2 keys | change thinking effort (`→`, `Enter`) |
| Occasional | 3 keys | switch model (`/model`, type, `Enter`) |
| Rare or destructive | as many as needed, with a confirm | delete a provider |

### 2.1 Surface state machine

Every capturing surface is the same small state machine. A control moves the
surface into a *mode*; `Esc` always leaves exactly one mode, and the hint row
names which (`end search`, `done`, `cancel`, `back`, `close`).

```
                       Esc: end search (query kept)
              ┌───────────────────────────────────────────────┐
              ▼                                               │
 closed ─open─► BROWSING ────────── type · "/" ────────────► SEARCHING
   ▲             │ │ │ │
   │             │ │ │ └─ Enter on text ───► EDITING ─ Enter: commit · Esc: done ────► BROWSING
   │             │ │ └─── Enter on select ─► PICKER ── Enter: apply · Esc: cancel ───► BROWSING
   │             │ └───── Enter on confirm ► DECIDING ─ Yes: run · No/Esc: answer No ─► BROWSING
   │             └─────── Enter on action ─► BUSY ──── reply ─┬─ completed ──────────► closed
   │                                                          └─ invalid · failed ───► BROWSING + inline error
   └── Esc / Ctrl+C in BROWSING (one layer per press) ──────────────────────────────────
```

| Mode | Entered by | `Enter` | `Esc` (hint word) | Also live |
| --- | --- | --- | --- | --- |
| BROWSING | open; every other mode returns here | primary operation of the focused control (`choose`, `open`, `run`, `submit`) | `close`, or `back` on a wizard page | arrows, digits, accelerators, `Tab` groups |
| SEARCHING | typing or `/` on a filterable list | choose the focused match | `end search` (query kept) | `Ctrl+U` clear, `Backspace` |
| EDITING | `Enter` or typing on a text field | `next`, or `submit` with `enterSubmits` | `done` (draft kept) | `Tab` commits and moves, `Alt+Enter` newline |
| PICKER | `Enter` on a select or multiselect | `apply` | `cancel` | `↑`/`↓` candidate, `Space` toggles (multi) |
| DECIDING | an action or row that declares `confirm` | the focused of `[No] [Yes]` | answers No | `←`/`→` switch |
| BUSY | an action whose handler is in flight | ignored on the busy action | `close` | the busy action keeps focus |
| EXPANDED | `Ctrl+E` on a scroll region | — | `collapse` | scroll keys |

A reply settles BUSY: `completed` (optionally with `dismiss`) leaves the
surface; `invalid`, `conflict`, `failed` return to BROWSING with feedback
painted where the problem is; `cancelled` returns silently. Modes do not nest
except EDITING/PICKER inside a form and DECIDING over any mode.

### 2.2 Key prompts (the hint row)

The hint row is one muted line, indented two columns, fragments joined by
` · `, each fragment `Keys label`. It is computed, never authored.

Two orderings exist and are easy to confuse:

- **Admission priority** decides which fragments survive when the row is full
  (three below 80 columns, four from 80): Escape (120) → primary operation and
  filter (100) → declared accelerators (96) → adjustment (95) → navigation
  (90) → digit range (88) → tabs/clear (85) → group moves (80).
- **Display order** decides where a surviving fragment sits: navigation,
  adjustment, primary operation, everything else, group moves, and **`Esc`
  last**. `Esc` is always kept but always trails, so the row reads
  "what I can do … how I leave" and the exit sits in a fixed place.

Key notation: `Enter`, `Esc`, `Tab/Shift+Tab`, `Space`, `↑/↓`, `←/→`,
`Alt+←→`, `PgUp/PgDn`, `Ctrl+U`; ranges as `1-3`; the literal word `Type` for
type-to-filter. Slashes join alternatives of one fragment.

Real rows (strings asserted in `tests/core/ui-compiler.spec.ts`, or derived
from `core/ui-key-grammar.ts`):

```
action group focused    ↑/↓/←/→ actions · Enter run · Tab/Shift+Tab groups · Esc close
single action           Enter run · Esc close
tab strip focused       ←/→ tabs · Enter open · Esc close
select picker open      ↑/↓ options · Enter apply · Tab/Shift+Tab groups · Esc cancel
text field, editing     Enter next · Tab/Shift+Tab groups · Esc done
list, filtering         Enter choose · Ctrl+U clear · Esc end search
list row with strip     ←/→ thinking · Enter choose · Type filter · Esc close
```

Vocabulary — the only verbs a fragment may use:

| Verb | Means | Used for |
| --- | --- | --- |
| `choose` | pick this row and commit | `role: 'choose'` rows, decisions |
| `open` | descend into detail | `role: 'browse'` rows, tab strip |
| `run` / `confirm` | execute an action / answer the decision | actions row |
| `apply` | commit an open picker or field action | select picker |
| `submit` / `next` | write the form / commit this field and move | text fields |
| `toggle` | flip a checkbox-like value | toggle, multiple lists |
| `<segment label>` | step the row's strip (lowercased label) | `←/→ thinking` |
| `Esc` words | `collapse` `cancel` `done` `end search` `back` `close` `leave` | the current layer |

Rules:

- Never advertise a dead key: dispatch and hints read one binding list.
- A hint never names a button that is not on screen; when a surface has no
  actions row, the `Tab/Shift+Tab groups` fragment does not appear either.
- Editor decorations do not get a hint row; they declare `hint?: string` and
  may only bind modifier accelerators.

## 3. Visual language

Surface chrome anatomy:

```
╭ Approve bash? ─────────────────────────────────────────╮
│ optional subtitle (muted)                              │
│ [badge] [badge]                                        │
│                                                        │
│ → focused row (inverted)                               │  ← content
│   ordinary row                                         │
│                                                        │
│ optional custom footer node                            │
│   Enter run · Tab/Shift+Tab groups · Esc close         │  ← hint row (muted)
╰────────────────────────────────────────────────────────╯
```

- Chrome kinds: `overlay` (`╭ ╮`, focus-colored border), `surface`
  (currently `┌ ┐`, target `╭ ╮` — see §7 A2), `lane` (`─` rules), `none`
  (bare title). A surface's `footer` node carries custom content above the
  generated hint row.
- The hint row is indented two columns, fragments joined by ` · `, with `Esc`
  last (§2.2).

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
| `[badge]` | row badge; the live row is always `[current]` (roadmap G4) |
| `▾` / `▸` | open / closed tree branch |
| `+N` | N tokens folded by a narrow width (actions, tabs, strips) |
| `(Inherited)` / `(Override)` | field or strip token provenance |
| `! message` | field validation error, indented under the field |
| `⠋` | braille loader frame |
| `█` / `░` | filled / empty progress-bar cells |

Some glyphs appear in both tables by design and are told apart by position and
tone: `!` prefixes a danger action (before its label), a field error (indented
under the field), and a warning in the feedback lane; `●` marks a selected list
row (control) or an assistant block / running tool (transcript). New surfaces
must not add a third meaning to either.

The marker legend covers control state. The transcript and status vocabulary
uses a second, equally fixed set (§3.2); the brand cues in §3.1 and the motion
rules in §3.3 apply to every component.

### 3.1 Brand layer

Mayfly's identity is quiet by construction: violet ink, rounded frames, and a
single ripple motif. Components express it through palette tokens and glyphs,
never through surface-specific paint. The palette itself is owned by the theme
plugins (`core/theme-dark.ts`, `-light`, `-ocean`, `-paper`, `-custom`,
`-auto`).

| Cue | Token / glyph | Where it appears |
| --- | --- | --- |
| Brand violet | `primary` (`#9A86E6` in the dark palette) | focus, active tab, primary action, loader indicator |
| Focus frame | `borderFocus` | overlay chrome, focused editor border |
| Quiet frame | `border` | inline `surface` chrome, panels |
| Waiting ripple | `·· ·≈ ≈≈ ≈·`, 120 ms | "waiting on an external action" |
| Working rotation | `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`, 80 ms | the model or a tool is actively computing |
| Logomark | eight-row braille mark + `logoGradient` | welcome banner only |

Brand signatures — the three things that make a Mayfly screen recognizable, and
the only decorative paint the components carry:

1. **Scarce violet ink.** `primary` marks *the one place attention belongs*:
   the focused row and, inside it, the active choice (the `‹ high ›` token, the
   active tab, the primary action). Never body text, badges, headings, or a
   second highlighted row. If two things on a surface are both violet, one is
   wrong.
2. **The inset title rule.** `╭ Title ─────╮` — a rounded frame whose title
   sits inside the top rule. It is the only decorative line; no double rules,
   heavy borders, or boxed sub-panels.
3. **The ripple.** One waiting motion (`·· ·≈ ≈≈ ≈·`), a nod to the insect's
   short life on water: calm, small, and used only when the wait is external.

Everything else stays typographic: weight, dimness, inversion of the focused
row, and words. There are no emoji and no filled color blocks except the
focused row's inversion.

Rules:

- **Rounded chrome is the Mayfly frame.** `overlay` and `surface` both use
  `╭ ╮ ╰ ╯`; square corners are not used. Overlays paint with `borderFocus`,
  inline surfaces with `border`, and `lane` with `muted`.
- **The ripple means "waiting on something outside the model"** (network,
  authorization, a child process); the braille rotation means "the model or a
  tool is working". Never run both in one surface (§3.3).
- **Color never carries meaning alone.** Every tone-coded state also carries a
  glyph or a word, so `NO_COLOR` terminals stay unambiguous.

### 3.2 Transcript and status glyph vocabulary

One glyph, one meaning. These are transcript and status glyphs, distinct from
the control markers above.

| Glyph | Meaning |
| --- | --- |
| `●` | assistant block; tool running |
| `»` | user block |
| `✻` | thinking / reasoning |
| `✓` | tool or step done |
| `✗` | tool or step failed |
| `◐` | declined (plan) |
| `⊘` | cancelled |
| `■` | stopping / interrupted |
| `⏵` | background jobs count |
| `›` | collapsed child |

### 3.3 Motion policy

- **At most one animated indicator per surface.** The wire loader already
  shares one clock per surface (`core/ui-loader-animation.ts`); the transcript
  and panes must match that rule rather than running competing spinners.
- **The renderer owns every clock.** Wire data carries only `variant` and
  plain elapsed data; a surface that hides or unloads stops its clock.
- **Color and motion are degradable.** `NO_COLOR` removes paint but keeps
  weight, inversion, and glyphs; a reduced-motion setting freezes animation on
  its first frame. Both are roadmap items (§7 D1), not shipped behavior today.

## 4. Components

Each entry gives the wire interface (trimmed; see `contracts.ts` for the full
type), the builder, the rendered states, and the keys. Interactive states are
painted by `core/ui-patterns.ts`; content nodes (`markdown`, `code`, `diff`,
`sections`, `chart`, `diagram`) are painted by the content painters in
`core/plugin-view.ts`, `core/rich-document.ts`, `core/chart-renderer.ts`, and
`core/diff-align.ts`; authors only supply data.

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

Redundancy rule (principle 1): do not add an action whose only effect a bare
key already has. Concretely — no `Cancel` on a dismissable surface (`Esc`), no
primary action that repeats a list's `acceptActionId` when `Enter` on the row
reaches it, no `Next`/`Back` beside a wizard tab strip (`Alt+←→`, `Esc` walks
back) unless the page is the only way to show why a step is blocked. What
remains in the row is the set of operations a user could not otherwise find.

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
╭ Skills ──────────────────────────────────────────────────────╮
│ / re▌                                         2 matches      │
│ Project                                                      │
│ → review-pr — Review a pull request               [enabled]  │
│   release-notes — Draft release notes                        │
│   pdf-export — retired 2026/01                               │
│                                                              │
│   Enter open · Type filter · Esc close                       │
╰──────────────────────────────────────────────────────────────╯
     filter row while searching · group header (muted) ·
     focused row inverted · disabled row shows its reason
```

The `2 matches` counter and the scroll position (`↑2 / ↓7`) are roadmap item
B2. `role` decides what `Enter` means and what the hint says:

| `role` | `Enter` | Hint | Selection state | Use for |
| --- | --- | --- | --- | --- |
| `choose` | picks the row into the list's draft `selectedIds` | `choose` | draft; counts as unsaved until settled | decisions, option lists, questionnaires |
| `browse` | reports the focused row (`selection-accept`) — no draft | `open` | none | inventories, detail views, commit-on-Enter pickers |

A commit-on-Enter picker (`/model`, `/effort`) is a `browse` list on purpose:
it has no draft to discard, so closing it never asks "Discard unsaved
changes?". Its hint still says `open`, which is wrong for a picker; the fix is
the additive `acceptVerb` field (roadmap G2).

Numbered choose list (decisions with ≤ 9 options):

```
→ 1. Preset endpoint — known provider
  2. Custom endpoint — any compatible URL
  3. OAuth provider — browser sign-in

  Enter choose · 1-3 choose · Esc cancel
```

Digits pick a row directly (`numbered: 'focus'` only moves the cursor, so
gated surfaces like plan review still require `Enter`). Numbers label the
visible rows and stay stable while the window scrolls; the hint shows the
real range (and yields to the arrow hint when the row is full) and is omitted
while searching. The digit fragment repeats `Enter`, so arrows outrank it when
the row is full.

Multiple mode:

```
→ ● mentions                     Space toggles, Enter commits
  ○ errors                       minSelected/maxSelected bound the set
```

Tree mode: rows with a `parentId` indent under their parent; `←`/`→` (or
`Space`) closes and opens branches.

Segment strip — a horizontal option bar bound to a row (the thinking-effort
control of a model row, a per-row scope, a per-row mode). `←`/`→` steps it,
and `selection-accept` reports the active option as `segmentId`.

```ts
interface MayflyListSegment {
  label?: string                    // hint word (lowercased) and footer prefix
  options: { id: string, label: string, disabled?: boolean, disabledReason?: string }[]
  selectedId?: string               // the pinned option; absent = unpinned
  inheritedId?: string              // target (E1): option in force while unpinned
}
```

Layout is renderer-owned and chosen by width, never by the plugin:

```
inline (default — the strip shares the row, the row count never changes)
→ DeepSeek/DeepSeek-V4-Pro — 977k context   min ‹ high (default) › max

footer (fallback when the row plus its strip cannot fit: one reserved line
under the list body, so no row ever moves)
→ DeepSeek/DeepSeek-V4-Pro — 977k context
  ⋮
   Thinking: min ‹ high (default) › max

folded (many options: nearest neighbours stay, the rest become +N)
→ some-model — 128k context                 ‹ medium › high +2
```

Rules:

- The strip shows only on the row it belongs to *while that row is focused*;
  other rows show at most a badge (`[current · high]`, §4.11).
- The active token is `‹ label ›` in `primary`; other tokens are `textMuted`;
  disabled tokens are `muted` and skipped by `←`/`→`. Inline tokens are joined
  by one space, footer tokens by two.
- `←`/`→` **clamp** at the ends (no wrap, matching `select`) and skip disabled
  options. From an unpinned strip `→` pins the option after the inherited one
  and `←` the one before it; with no `inheritedId`, `→` pins the first enabled
  option and `←` the last.
- **Unpinned is a real state** (target, E1). While `selectedId` is absent the
  `inheritedId` token is active and carries `(default)`; stepping back onto it
  unpins again, and `Delete` on a pinned row unpins directly (hint `use
  default`, shown only while it would change something — the same rule as text
  fields). Committing an unpinned strip reports no `segmentId`, which the owner
  reads as "follow the provider".
- Degrade in this order as width shrinks: drop `(default)`, drop the label,
  fold far tokens into `+N`, move the strip to the footer line, and only then
  drop it to the active token alone. The active token is never removed.
- Unicode fallback (roadmap D2): `‹ ›` become `< >`, so the same strip reads
  `min <high> max` on an ASCII terminal.

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
than choosing; see the role table above for the commit-on-Enter exception). For purely static content with no interaction, use `fields`,
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

> **Status: target.** Today `/sessions` is a two-step flow — a workspace
> picker, then one workspace's session panel
> (`interaction/session-workspace-panel.ts`) — and `/settings` is a list-based
> overlay. This section is the intended single-panel layout.

Sessions and settings are separate panels sharing one layout: a horizontal
split whose **left column is the tab strip rendered vertically** — labels
stacked top to bottom — and whose right side shows the active group's
content.

The sessions panel — one label per workspace; the right side lists that
workspace's sessions:

```
╭ Sessions ─────────────────────────────────────────────────────────────╮
│  Workspaces    │  → fix login redirect              2h ago            │
│  → mayfly    4 │    mayfly docs sync                1d ago            │
│    dsh       1 │    release 0.9.0                   3d ago            │
│    website   2 │                                                      │
│                                                                       │
│  Enter open · Type filter · Tab/Shift+Tab groups · Esc close          │
╰───────────────────────────────────────────────────────────────────────╯
   labels: a choose list        content: the active workspace's sessions
```

The settings panel — one label per namespace; the right side is the shared
schema-driven form:

```
╭ Settings ────────────────────────────────────────────────────────────────╮
│  → General     │  → Theme: ‹ dark ›                                      │
│    Providers   │    Notifications: [on]                                  │
│    MCP         │    …                                                    │
│    Appearance  │                                                         │
│                                                                          │
│  Enter open · Tab/Shift+Tab groups · Esc close                           │
╰──────────────────────────────────────────────────────────────────────────╯
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

Preview-then-commit (principle 8) argues for the live-following variant: the
cursor on a label repaints the right side read-only, `Enter` or `→` crosses
into it. That needs one additive observation, `focus-change` (`controlId`,
`itemId`), debounced by the renderer and never able to publish or navigate
(roadmap F2). Until then, accept a label to switch the content.

### 4.7 Surfaces and the key-hint footer

Every capturing surface gets its prompt footer from the key grammar; §2.2 owns
the ordering, priority, notation, and vocabulary. Per-state footers for one
surface (exact fragments are computed; these follow the grammar):

```
idle, choose list         Enter choose · 1-3 choose · Esc close
searching                 Enter choose · Ctrl+U clear · Esc end search
field focused             Enter submit · ↑/↓ fields · Esc close
field editing             Enter next · Tab/Shift+Tab groups · Esc done
picker open               ↑/↓ options · Enter apply · Esc cancel
decision open             ←/→ actions · Enter confirm · Esc close
busy action focused       ←/→ actions · Esc close              (action shows …)
```

Authors do not write footers. They choose the right `role`, declare `key`
accelerators sparingly, and name segments meaningfully (the segment `label`
becomes the hint word, lowercased).

### 4.8 Decision panels: approval, plan review, permission

> **Status: mixed.** Shipped today, three different shapes:
>
> | Surface | Options | Extra input | Default focus |
> | --- | --- | --- | --- |
> | Tool approval (`approval-plugin.ts`) | horizontal actions row under a `Decision` / `Reject with feedback` tab strip | second tab: `Reason` textarea + `Back` | Reject |
> | Plan review (`plan-review-panel.ts`) | vertical `numbered: 'focus'` list: Approve, Reject, Other | `Other` (or `o`) swaps the page for a `Feedback` textarea; `c` copies the plan | Reject (seeded) |
> | Permission preset (`permission-panel.ts`) | vertical `numbered: true` list, row `confirm` on Full access | none | current preset |
>
> §7 B1 unifies all three onto the skeleton below.

Every "the agent asks, the user decides" surface is the same composition of
basic components: a **vertical choose list of options**, optional **same-line
input fields** beneath it, and the shared confirm for destructive picks. There
is no decision-specific widget.

```
╭ Approve bash? ─────────────────────────────────────────────────╮
│ Runs: rm -rf build && pnpm build            ← scrollable reason│
│                                                                │
│ → 1. Reject                                 ← safe default     │
│   2. Allow once                                                │
│   3. Allow bash for this session                               │
│   Feedback: ▌                               ← same-line input  │
│                                                                │
│   Enter choose · 1-3 focus · Esc reject                        │
╰────────────────────────────────────────────────────────────────╯
```

- **Safe default by position of the cursor, not of the row.** The cursor starts
  on the least destructive option (Reject). Digits only *move* the cursor
  (`numbered: 'focus'`) on every surface that grants something, so a stray
  `1` or `Enter` typed a moment before the prompt appeared cannot grant. A
  grant therefore costs two keys (digit or `↓`, then `Enter`); a rejection
  costs one (`Enter` on the default, or `Esc`). Surfaces that only *choose a
  preference* (permission preset, questionnaire) keep instant digits.
- **Row 1 is always the safest option** (Reject, Default, No), so the digit
  that costs least to mistype is never the one that grants.
- **Arm delay (target, E4).** A capturing surface that opens unprompted ignores
  everything except `Esc` for its first ~300 ms (`armMs`, plain data on the
  overlay registration). It removes the last stray-key path without slowing a
  deliberate answer.
- **Esc must say what it does.** Dismissing an approval *rejects* the call, so
  the footer reads `Esc reject`, not `Esc close`; the grammar's Escape label is
  overridable per surface for exactly this (roadmap G5).
- Options are `role: 'choose'`; rows may carry detail text, badges, disabled
  reasons, and a per-row `confirm` (a danger row asks the shared `[No] [Yes]`
  before its selection is accepted).
- Inputs are ordinary form fields rendering on one line as `Label: value` —
  `Feedback: …`, `Revise: …`, `Others: …`. `↓` from the last option focuses the
  field; typing or `Enter` edits in place; `Enter` commits. The decision
  settles as one action collecting the list selection (`selections:`) and the
  field (`submit:`) — exactly the questionnaire page composition (§4.9). No
  second page and no `Back` button exist.
- Lifecycle invariants hold on every shape: requests are FIFO per Agent,
  allowances live until that exact Agent is disposed, dismissal and abort
  settle distinct outcomes, and feedback steers the Agent with the typed
  reason.

Target renderings of the other two surfaces:

```
╭ Plan ready for review ────────────────────────────────────────╮
│ → 1. Reject                                                   │
│   2. Approve and start                                        │
│   Revise: ▌                       ← type the revision in place│
│                                                               │
│   Enter choose · c copy plan · 1-2 focus · Esc close          │
╰───────────────────────────────────────────────────────────────╯

╭ Permission preset ────────────────────────────────────────────╮
│ → 1. Default — ask before writes                    [current] │
│   2. Accept edits — apply file edits freely                   │
│   3. Full access — no prompts                                 │
│                                                               │
│   Enter choose · 1-3 choose · Esc close                       │
╰───────────────────────────────────────────────────────────────╯
```

Plan review keeps its declared `c` accelerator (copy) and drops the `Other`
row and `o` accelerator: the `Revise:` field replaces both, one key fewer.
Full access asks its row `confirm` before it is accepted.

### 4.9 Question panel pattern

A multi-question prompt (`src/interaction/questionnaire.ts`) is one wizard
tab per question; a single question drops the strip entirely.

```
╭ Questions ───────────────────────────────────────────────────╮
│ ‹ Auth ›  Region                       ← wizard tabs (Q1, Q2)│
│ Which auth method?                                           │
│ → 1. OAuth — browser sign-in                                 │
│   2. API key — paste a token                                 │
│   3. No selection                                            │
│   Other: ▌                          ← free-text fallback     │
│                                                              │
│   Enter next · 1-3 choose · Alt+←→ tabs · Esc close          │
╰──────────────────────────────────────────────────────────────╯
```

> **Status: mixed.** The panel also ships `Back` / `Next` buttons per page and
> `Submit answers` / `Cancel` under the tab strip. By the redundancy rule
> (§4.1) every one of them duplicates a key — `Alt+←→` and `Esc` walk pages,
> `Enter` accepts and advances, and on the last page `Enter` submits — so the
> target renders none of them until the action group is focused (roadmap F1).

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
• Waiting for authorization                        variant tide (see status)
  Esc cancel                                        ← cancelActionId, as a hint
```

Frames cycle `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (braille, 80 ms) or `·•●•·` (tide). The renderer owns
the clock — all loaders in one surface share it, and it stops when the surface
hides or unloads; `elapsedMs` is plain data the owner publishes (painted as
`45s`, then `2m 10s`). Loaders live in panes and overlays only: the status and
editor-extension unions exclude them, and live turn status belongs to the
activity pane.

`cancelActionId` should paint as the `Esc cancel` hint, not as a `[ Cancel ]`
button: cancelling a loader is exactly what `Esc` already does (redundancy
rule, §4.1). `cancelLabel` remains for surfaces that show the button anyway.

> **Status: revision planned.** The `tide` pulse peaks on `●`, which §3.2
> reserves for "assistant block / tool running", and it is a second waiting
> motion beside the transcript's ripple. §7 A1 replaces it with the ripple so
> the variant changes once, not twice.

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

### 4.11 Model picker: `/model` and `/effort`

> **Status: target (roadmap E1–E3).** Today `/model` is a filterable `browse`
> list (`openModelPicker` in `interaction/model-commands.ts`) with three
> problems: the thinking strip is a detached row appended under the *whole list
> body*, labelled `Thinking:` and starting with a `Provider default`
> pseudo-option; a `Set as default` / `Cancel` actions row sits below it; and
> the footer says `Enter open` although `Enter` commits. This section is the
> intended design.

Goals: the thinking level is part of the model's entry; no buttons; rows never
jump; every hint tells the truth.

Entry anatomy — the model, its context, and its thinking control on one line:

```
→ DeepSeek/DeepSeek-V4-Pro — 977k context   min ‹ high (default) › max
  └────────── label ───────┘ └── detail ───┘ └──── inline segment ────┘
```

The label is `<provider label>/<model name>`; the detail is
`<context> context`; a badge follows the label (`[current]`, or
`[current · high]` on the live row so the running effort is visible before
focusing it). Group headers stay (they aid scanning); the provider prefix stays
too (it disambiguates filter results, where headers scroll away).

Inline layout (shown at 80 columns), idle:

```
╭ Select a model ──────────────────────────────────────────────────────────────╮
│ opencode-go                                                                  │
│   opencode-go/DeepSeek V4 Pro (New) — 977k context                           │
│   opencode-go/deepseek-v4.1-flash — 977k context                             │
│   opencode-go/mimo-v2.6-flash-free — 195k context                            │
│ DeepSeek                                                                     │
│   DeepSeek/DeepSeek-V41-Flash [current · high] — 977k context                │
│ → DeepSeek/DeepSeek-V4-Pro — 977k context   min ‹ high (default) › max       │
│                                                                              │
│   ←/→ thinking · Enter choose · Type filter · Esc close                      │
╰──────────────────────────────────────────────────────────────────────────────╯
```

The focused row is inverted; only it shows a strip, and inside it only the
active token is violet (brand signature 1, §3.1). Moving focus never adds or
removes a row.

State variants of the focused row (footer beneath in parentheses):

```
unpinned          → DeepSeek/DeepSeek-V4-Pro — 977k context   min ‹ high (default) › max
                    (←/→ thinking · Enter choose · Type filter · Esc close)
pinned            → DeepSeek/DeepSeek-V4-Pro — 977k context   min high ‹ max ›
                    (←/→ thinking · Enter choose · Delete use default · Esc close)
no default known  → some-provider/some-model — 128k context   min medium high
                    (no active token until the first ←/→; → pins the first, ← the last)
no thinking       → opencode-go/space-bunny-alpha — 256k context
                    (↑/↓ options · Enter choose · Type filter · Esc close)
filtering         / deep▌                                              3 matches
                    (↑/↓ options · ←/→ thinking · Enter choose · Esc end search)
```

Footer layout (shown at 60 columns): the strip no longer fits beside the row,
so it moves to the one footer line reserved for it; the list above never
shifts. The renderer picks the layout from the width, never the plugin:

```
╭ Select a model ──────────────────────────────────────────╮
│ DeepSeek                                                 │
│   DeepSeek/DeepSeek-V41-Flash [current · high]           │
│ → DeepSeek/DeepSeek-V4-Pro — 977k context                │
│                                                          │
│   Thinking: min ‹ high (default) › max                   │
│   ←/→ thinking · Enter choose · Esc close                │
╰──────────────────────────────────────────────────────────╯
```

Keys:

| Key | Effect |
| --- | --- |
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | move; group headers and disabled rows are skipped |
| `←` `→` | step the focused row's thinking level (clamped, no wrap); inert on rows without one |
| `Enter` | use this model **and** this thinking level for the session, and save it as the default |
| `Delete` | unpin thinking (shown only while pinned) |
| type or `/` | filter (`Ctrl+U` clears, `Esc` ends the search, a second `Esc` closes) |
| digits | none — the list is filterable, so printable keys are text |

There is no `Set as default` or `Cancel` button: `Enter` and `Esc` already do
both. The result is confirmed by the notice the commit already publishes
(`Switched to deepseek-v4-pro (DeepSeek) · thinking high`, or `Thinking set to
high` when only the level changed; with the severity glyph of roadmap B5).
`Esc` and abort leave the session's model untouched; a failed default save
never blocks the switch.

Wire recipe (no actions node, no `acceptActionId` — `Enter` reports a
`selection-accept` carrying the row's `segmentId`):

```ts
ui.list({
  id: 'selection', role: 'browse', filterable: true, selectedIds: [],
  acceptVerb: 'choose',                                  // target G2
  items: models.map(m => ({
    id: key(m), label: `${m.providerLabel}/${m.name}`, group: m.providerLabel,
    detail: `${formatContextWindow(m.contextWindow)} context`,
    ...m.live ? { badge: m.effort ? `current · ${m.effort}` : 'current' } : {},
    ...m.efforts && { segment: {
      label: 'Thinking',
      options: m.efforts.map(id => ({ id, label: id })),   // real levels only
      ...m.defaultEffort && { inheritedId: m.defaultEffort }, // target E1
      ...m.live && m.pinned && { selectedId: m.pinned },
    } },
  })),
  empty: ui.empty({ title: 'No models advertised' }),
})
// handler: event.kind === 'selection-accept'
//   → commit(byId.get(event.selectedIds[0]), event.segmentId)   // absent = provider default
```

`/effort` is the same component reduced to one model: the overlay title is the
current model, the rows are `Provider default (high)`, then each real level,
numbered, with `[current]` on the live one, and no buttons. `/effort <level>`
and `/model <id>` switch without opening anything; `Alt+M` keeps cycling.

Verification when this lands: `ui-patterns.spec.ts` (inline strip at
20/40/60/100 columns, pinned/unpinned/no-default), `ui-validator.spec.ts`
(`inheritedId` must name an option; `acceptVerb` enum), `ui-compiler.spec.ts`
(hint fragments and `Delete`), `model-commands.spec.ts` and
`model-selection-ui.spec.ts` (drive `selection-accept` instead of
`invoke('default')`), the owning `width-scan.spec.ts`, and a new `app-model`
screenshot. `packages/ui` changes run the full gate.

### 4.12 Component API reference

Data flows down as immutable nodes and up as events; nothing else crosses the
seam. Builders take an options object, add `kind`, and freeze a clone.

| Builder | Required | Notable optional | Emits | Owns keys | Hint verbs |
| --- | --- | --- | --- | --- | --- |
| `ui.actions` | `id`, `items[]` | per item: `intent`, `confirm`, `key`, `submit`/`read`/`selections`, `navigate`, `dismiss`, `defaultFocus` | `activate`, `submit`, `dismiss` | `←→↑↓` between items, `Enter`/`Space` run, declared `key` | `run`, `confirm`, `actions` |
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
| `ui.stack` / `ui.child` | children | `gap`, `align`; per child `basis`, `grow`, `tab` | — | none | — |

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

Worked specs for the additive fields this catalog proposes:

| Field | Type & default | Validator | Painted states | Keys & hints | Events | Degradation |
| --- | --- | --- | --- | --- | --- | --- |
| `MayflyListSegment.inheritedId` (E1) | `string`; absent = no inherited option | must equal an option `id`; not disabled | `‹ high (default) ›` unpinned, `‹ max ›` pinned | `Delete use default` only while pinned | `selection-accept` omits `segmentId` when unpinned | drop `(default)` first |
| `MayflyListNode.acceptVerb` (G2) | `'open' \| 'choose'`; default from `role` | enum | footer `Enter choose` | replaces the `open`/`choose` hint word | none | none |
| `MayflyActionsNode.reveal` (F1) | `'always' \| 'focus'`; `'always'` | enum; a `focus` group with a `key`-less, non-`dismiss` action must still be reachable by `Tab` | hidden until the group is focused; then the ordinary row | adds `Tab/Shift+Tab groups` while hidden | as `actions` | as `actions` |
| overlay `armMs` (E4) | `number` ms; `0` | integer `0–2000` | none (input is swallowed) | none | none | none |
| `focus-change` observation (F2) | `{ controlId, itemId }` | list ids only | right pane repaints read-only | none | new observation, cannot publish | debounced by the renderer |

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
- **Do not reimplement.** The editor's autocomplete list (`SelectListAdapter`
  in `core/components.ts`, `core/wrapping-select-list.ts`,
  `renderAutocompleteList`) is a retained legacy integration with its own key
  handling — it is not a model. (The old `core/scrollable-panel.ts` no longer
  exists; the session transcript is an ordinary pane.) New surfaces compose wire nodes and
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
| A per-row setting (thinking level, scope, mode) | list `segment` on that row (§4.4), never a separate row or page |
| Commit-on-`Enter` picker | `role: 'browse'` list, `selection-accept`, no buttons (§4.11) |
| An action a bare key already performs | none — omit it (redundancy rule, §4.1) |
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
5. A roadmap item in §7 is not shipped behavior until its status flips to
   **shipped**; only the code and §1–§6 describe what runs today.
6. Assert the footer string for every state the surface can be in (idle,
   searching, editing, decision, busy). A hint is a contract, and §2.2 lists
   the only verbs it may use.
7. Run the redundancy test (§4.1) on every action, and the stray-key test
   (§4.8) on every surface that opens without the user asking for it.
8. Diagrams are exact renderings at a stated width: the top rule, every row,
   and the bottom rule of a box share one width.

## 7. Refinement roadmap

This section collects the agreed visual and interaction refinements for the
components above. Unlike §1–§6, these are not all shipped: every item carries a
status, and the code remains the executable authority.

| Status | Meaning |
| --- | --- |
| **shipped** | implemented and covered by tests |
| **target** | agreed design; not implemented yet |
| **backlog** | candidate; not yet agreed |

Wave 1 items are priority **P1**, wave 2 **P2**, wave 3 **P3**. Waves are
ordered by risk and dependency; an item may move earlier only when it has no
cross-surface dependency. Every delivered item flips its status to
**shipped** in the change that implements it.

### 7.1 Wave 1 — identity and clarity (P1)

Low risk; no new node kinds.

**A1 · Unify the waiting ripple — target.**
The wire `tide` loader frames (`· • ● • ·`, 80 ms) are unused by any surface,
while the transcript's waiting animation is the moon ripple
(`·· ·≈ ≈≈ ≈·`, 120 ms). Align them into one ripple, keeping braille for work
that is actively computing. (The pulse also peaks on `●`, which §3.2 gives to
"assistant block / tool running". Land this item directly; do not ship the
pulse first and replace it later.)

```
  ripple (waiting on external action)   ·· → ·≈ → ≈≈ → ≈·      120 ms  [primary]
  braille (model or tool working)       ⠋  → ⠙  → ⠹  → ⠸  ...   80 ms  [primary]

  ⠋ Discovering models from api.example.com 12s
  ·· Waiting for authorization
```

Touch points: `core/ui-patterns.ts` (`TIDE_FRAMES`, `renderLoader`),
`core/ui-loader-animation.ts` (frame interval), `transcript/spinners.ts`;
`ui-patterns.spec.ts`, `ui-compiler.spec.ts`, `loader-tide.svg`.

**A2 · Rounded chrome everywhere — target.**
Square corners become rounded; the overlay/surface distinction moves to paint
only, and the §3.1 rules apply:

```
  now   overlay ╭ Approve bash? ─────╮   surface ┌ Select a model ────┐
  then  overlay ╭ Approve bash? ─────╮   surface ╭ Select a model ────╮
        [borderFocus]                           [border]
```

Touch points: `core/ui-patterns.ts` (`renderSurfaceHead`, `renderSurfaceTail`);
every `surface*` / `app-*` shot.

**A4 · Consolidate the transcript glyph vocabulary — target.**
Move the §3.2 glyphs into one owned module and enforce one meaning per glyph.

Touch points: `transcript/components.ts`, `transcript/thinking.ts`,
`transcript/pane-activity.ts`, `interaction/symbols.ts`.

**B4 · Editor mode labels, not a multicolored frame — target.**
The editor border already recolors for bash mode
(`interaction/editor-plus.ts`). Keep that input-mode recolor, and carry the
session modes as tinted **label text only** — the frame itself stays
`border` / `borderFocus`. Retire the plan/yolo badges from the status line so
the two surfaces can never disagree:

```
  normal      ╭──────────────────────────────╮  border
  focused     ╭──────────────────────────────╮  borderFocus
  plan        ╭ PLAN ────────────────────────╮  border; label [accent]
  yolo        ╭ YOLO ────────────────────────╮  border; label [warning]
  plan+yolo   ╭ PLAN · YOLO ─────────────────╮  border; PLAN [accent] · YOLO [warning]
  bash        ╭ BASH ────────────────────────╮  shellMode; label [shellMode]
              > Write a message▌
              ╰──────────────────────────────╯
```

Rules:

- **The frame carries at most the input mode.** Only bash repaints the frame
  `shellMode`; plan and yolo never do. Focus still moves `border` →
  `borderFocus`.
- **Each label token keeps its own tone:** `PLAN` is `accent`, `YOLO` is
  `warning`, `BASH` is `shellMode`. There is no merged "highest alert" frame
  hue, so `PLAN · YOLO` reads lighter than a pure `YOLO` — one violet token
  beside one amber token, not a fully amber frame.
- The label never carries a "dirty" or "unsaved" word; unsubmitted work is the
  save action's business.
- Session modes stack in one label in a fixed order (`PLAN` before `YOLO`);
  the bash label may stack too (`╭ BASH · PLAN ─╮`).
- The status footer stops registering the plan/yolo badge
  (`interaction/mode-status.ts`); the editor label is the single source for
  those two modes.

Touch points: `interaction/editor-plus.ts`
(`setBorderLabel`/`setPromptSymbol`, bash `setBorderColor`),
`core/components.ts`, `interaction/mode-status.ts` (retire the badge);
`interaction/mode-commands.ts` still owns the session-mode snapshot.

**B5 · Feedback severity prefix — target.**
The feedback lane renders one unprefixed row. Add the severity glyph and keep
the existing lifetime rules:

```
  ✓ Saved to clipboard                        success, auto-dismiss
  · 12 files indexed                          info, auto-dismiss
  ! permission picker is unavailable: ...     warning, sticky
  ✗ Plan copy failed                          error, sticky
```

Touch points: `core/ui-compiler.ts` (feedback row),
`core/ui-interaction-notifications.ts`.

**C1 · Use the diff tokens and add hunk headers — target.**
`diffAddedStrong`, `diffRemovedStrong`, and `diffGutter` are defined in every
theme but painted nowhere. Use them, and add an `@@` header when more than one
hunk is shown:

```
  @@ -12,6 +12,8 @@ function render()
      const before = 1
  -   const mid = 2          ← sign [diffGutter], body [diffRemoved] on diffRemovedBg
  +   const mid = 3          ← sign [diffGutter], body [diffAddedStrong]
      return before
  ⋯ 42 unchanged lines
```

Touch points: `core/diff-align.ts`, `core/plugin-view.ts`; `diff.svg`.

**C2 · Highlight standalone code — target.**
`ui.code` currently paints every line with `mdCodeBlock`; only fenced code
inside `markdown` is highlighted. Route `code` through the same highlighter
when `language` is known.

Touch points: `core/plugin-view.ts` (code arm), `core/highlight.ts`.

**D1 · `NO_COLOR` and reduced motion — target.**
Neither is handled today. `NO_COLOR` degrades every palette token to identity
(keeping bold, inverse, and glyphs); reduced motion freezes animation on its
first frame.

Touch points: `core/theme-palette.ts`, `core/ui-loader-animation.ts`,
`transcript/spinners.ts`.

**D3 · One animation per surface — target.**
Encode §3.3 as a test-time audit so the rule cannot regress.

Touch points: the loader clock and the pane/transcript timers; a guard spec.

**E1 · Inline thinking strip on the model row — target.**
Render a row's segment strip on the row itself (`min ‹ high (default) › max`),
fold it before moving it to a reserved footer line, and add the unpinned state
through `MayflyListSegment.inheritedId` (§4.4, §4.11). The strip stops being an
appended row that changes the list's height as focus moves.

Touch points: `packages/ui/src/contracts.ts` (`inheritedId`),
`core/ui-validator.ts`, `core/ui-patterns.ts` (`renderListSegment` inline
layout), `core/ui-compiler.ts` (list body and reserved footer line),
`interaction/model-commands.ts` (drop the `default` pseudo-option); specs and an
`app-model` screenshot. Full gate.

**E2 · Button-free pickers — target.**
`/model` and `/effort` lose the `Set as default` / `Cancel` actions row.
`Enter` reports `selection-accept`; `Esc` closes; the commit notice confirms.

Touch points: `interaction/model-commands.ts` (`openPickerOverlay`), the
`Set as default` locale key, `model-commands.spec.ts`,
`model-selection-ui.spec.ts`.

**E3 · Effort visible without focus — target.**
The live row carries `[current · <effort>]`; `/effort` reuses the model
picker's row and hint vocabulary.

Touch points: `interaction/model-commands.ts` (badge text, locale keys).

### 7.2 Wave 2 — decision and navigation consistency (P2)

**B1 · One decision-card skeleton — target.**
Tool approval, plan review, and the permission ask render three different
shapes today. Use one skeleton (§4.8): title, scrollable reason, numbered
vertical options with the safest option as row 1 and the cursor on it, an
optional same-line input, and the grammar hint row. Grants use
`numbered: 'focus'`.

```
  ╭ Approve bash? ───────────────────────────╮
  │ rm -rf build && pnpm build               │
  │ → 1. Reject                              │
  │   2. Allow once                          │
  │   3. Allow bash for this session         │
  │   Feedback: ▌                            │
  │   Enter choose · 1-3 focus · Esc reject  │
  ╰──────────────────────────────────────────╯
```

Touch points: `interaction/approval-plugin.ts`,
`interaction/plan-review-panel.ts`, `interaction/permission-panel.ts`,
`interaction/authorization-ui.ts`; interaction width scans.

**B2 · List navigation affordances — target.**
Show a live match count while filtering, a scroll position, and a next-step
line in empty states:

```
  / deep▌                                    3 matches
  → deepseek-v4-pro — 256k context [current]
    deepseek-v4 — 128k context
    ↑2 / ↓7
```

Touch points: `core/ui-compiler.ts` (list runtime), `core/ui-patterns.ts`
(`renderList`), locale catalogs.

**C4 · Status grid and priority overflow — target.**
The status definitions already carry `band`, `row`, `priority`, and
`overflow`. Lay the footer on a fixed grid and drop the lowest-priority
entries when the row is full. The plan/yolo badge retires with B4, so the grid
no longer reserves a slot for it.

Touch points: `transcript/status-model.ts` and the status plugins.

**E4 · Arm delay for unprompted decisions — target.**
An overlay that opens without a user gesture swallows everything but `Esc` for
its first ~300 ms (`armMs`). It closes the stray-key path that keeps grants at
two keys today (§4.8).

Touch points: `packages/ui` overlay registration, `core/ui-interaction-*.ts`,
`interaction/request-overlay.ts`; a replay test that types into the editor
while a request opens. Full gate.

### 7.3 Wave 3 — deeper presentation (P3)

**A3 · Running-block cue without a rail — backlog.**
Signal the streaming/running block through the marker it already has instead of
reserving a left column. While the block is active its bullet and header line
paint `primary` and the header shows the live clock; when it settles the tone
returns to `text` and the clock disappears. No reserved column, no background
band, and no second spinner (the §3.3 single-animation rule keeps the activity
pane as the only animated indicator).

```
  ● Deep diving for 12s        ← running: bullet + header [primary], live clock
    ├─ read  src/core/ui-patterns.ts
    └─ ✓ grep  "renderLoader"
  ● previous turn              ← settled: [text], clock gone
```

Touch points: `transcript/process-rows.ts` (`TurnHeaderComponent`),
`transcript/components.ts`.

**B3 · Busy elapsed and unsaved marker — backlog.**
Busy actions append their elapsed time; a form with unsubmitted edits shows an
`unsaved` marker in the action row — never in the editor frame — and confirms
on Escape.

```
  [ Save ]   … Saving 4s        · unsaved
```

Touch points: `core/ui-patterns.ts` (`renderActions`), `core/ui-compiler.ts`
(action pending timing).

**C3 · Expose chart and Mermaid — backlog.**
Both already render but are absent from this catalog. Document them, add a
usage-chart legend, and keep the existing bounded fallbacks.

Touch points: `interaction/session-info-model.ts`, this catalog, the Website
gallery.

**D2 · Unicode fallback — backlog.**
Provide ASCII fallbacks for braille spinners, rounded/box chrome, tree
markers, and progress cells, and drop the logomark when Unicode is
unavailable.

Touch points: `core/chrome.ts`, `core/ui-patterns.ts`,
`transcript/banner.ts`, `transcript/spinners.ts`.

**F1 · Buttons on demand — backlog.**
`ui.actions({ reveal: 'focus' })` paints the row only while its group is
focused; otherwise the footer shows `Tab/Shift+Tab groups`. Questionnaire
`Back` / `Next` / `Submit answers` / `Cancel`, form `Submit` / `Cancel`, and
the loader `[ Cancel ]` all duplicate bare keys (§4.1) and are the first
adopters.

Touch points: `packages/ui` contract, `core/ui-patterns.ts`
(`renderActions`), `core/ui-compiler.ts`, `core/ui-key-grammar.ts`
(group hint), `interaction/questionnaire.ts`. Full gate.

**F2 · Live-following label column — backlog.**
A `focus-change` observation lets the labels-left pages of §4.6 repaint their
content as the cursor moves.

Touch points: `packages/ui/src/interaction.ts`,
`core/ui-interaction-choice.ts`, the sessions and settings panels.

### 7.4 Conformance register

Known gaps between this catalog and the code, or defects the audit found while
verifying it. IDs are stable; delete a row when its fix ships. Related
findings in the 2026-09-28 audit (PR #77) are cited as `UX-nn`.

| ID | Gap | Where | Fix |
| --- | --- | --- | --- |
| G2 | `Enter open` on pickers that commit: `browse` role forces the `open` verb (UX-23) | `core/ui-key-grammar.ts` `rowBindings`, `interaction/model-commands.ts` | additive `acceptVerb`, then set it on the model and effort pickers |
| G3 | The segment strip is appended after the list body, not on its row, and a row without a strip changes the list height (§2 principle 6) | `core/ui-compiler.ts` `segmentRows` | E1 |
| G4 | Two current markers: `CURRENT_MARK = '← current'` (renders `[← current]`) in theme and permission pickers, `[current]` in the model picker; `SELECT_POINTER = '❯'` is exported but unused while the painter draws `→` | `interaction/symbols.ts`, `theme-switch.ts`, `permission-panel.ts`, `model-commands.ts` | one localized `current` badge; delete `CURRENT_MARK` and `SELECT_POINTER`; drop `symbols.ts` from A4's touch points |
| G5 | Approval `Esc` is labeled `close` but rejects; `Reject with feedback` is a tab plus a `Back` button | `interaction/approval-plugin.ts`, escape labels in `core/ui-key-grammar.ts` | overridable Escape label; B1 |
| G6 | This PR changes the `tide` frames to `·•●•·`, and roadmap A1 replans the same variant to the ripple; the peak `●` also collides with the tool-running glyph | `core/ui-patterns.ts` `TIDE_FRAMES`, `loader-tide.svg` | drop the code and screenshot change from this docs PR, or land the ripple (A1) directly |
| G7 | Redundant buttons: `Set as default` + `Cancel` (pickers); `Back`/`Next`/`Submit answers`/`Cancel` (questionnaire); loader `[ Cancel ]`; single-field form `Submit`/`Cancel` | see §4.1 redundancy rule | E2, F1 |
| G8 | Three checkbox notations: `●`/`○` (multiple lists), `[x]`/`[ ]` (pickers), `[on]`/`[off]` (toggle); `●` is also the "selected" marker in single lists (UX-24) | `core/ui-patterns.ts` `renderList`, `renderFormField` | multiple lists adopt `[x]`/`[ ]`; `●` stays transcript-only |
| G9 | Hint verbs overlap: `pick` (open a select), `choose`, `apply`, `open` (UX-23) | `core/ui-key-grammar.ts` | settle on the §2.2 vocabulary; rename `pick` |
