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
`shipped` / `target` / `backlog` labels; sections outside §7 that are not yet
shipped carry their own `Status: target` banner. Only shipped items describe
running behavior, and §7.4 registers the known gaps between this catalog and
the code.
Hint rows in every diagram use the strings the key grammar really produces
(§2.2), not idealized ones.

§8 collects the redesign round (activity row, tool cards, loader, compaction,
todo and goal, the agents and jobs tray, decisions, tabs, lists, forms,
panels, the plugin marketplace, onboarding, the account panel, interaction
scenarios, the four transcript levels, and the system rules that tie them together). It is all `target`, it wins over earlier
text where the two disagree (§8.1), and it ships with a runnable terminal
prototype (§8.19).

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
| BUSY | an action whose handler is in flight | ignored on the busy action | `close` | the busy action shows `…` and is skipped by navigation |
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

Style: the key token paints in `text`, its label in `textMuted` (bold key under
`NO_COLOR`), so the eye lands on the key. The same rule applies to status row 2 of §2.3.

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

> The authoritative row-by-row shared-key list is `SHARED_KEY_REFERENCE`
> (checked against both Website key references by
> `tests/core/key-grammar-docs.spec.ts`); the rows above are illustrative and
> must match it.

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

### 2.3 Key prompts across the interface

§2.2 governs the row inside a capturing surface. The rest of the interface —
the main screen, the transcript, panes, side conversations — needs the same
guarantee: **wherever the user is, the keys that help right now are visible,
and each one sits with the thing it acts on.**

**Today.** Outside overlays the main screen has no persistent key prompt: the
footer is one status row, and every key is cued (or not) by whichever component
happens to own it.

| Key | Cue today | Problem |
| --- | --- | --- |
| `Ctrl+O` | inline `ctrl+o to expand` on a folded turn header or block, only for the last `expandTurns` (3) turns | invisible when nothing is folded or the folded turn is older; once expanded, nothing says how to collapse; dropped silently when the row is too narrow; hard-coded lowercase text, not read from the keymap |
| `Esc` interrupt / take back | none until the activity row shows `Stopping` | the most important running-state key is unadvertised |
| `Ctrl+S` steer, `Alt+Enter` newline, `Ctrl+G` external editor | none | invisible until the user reads `/help` |
| `Shift+Tab` plan, `Alt+M` model | a lowercase `plan` / `yolo` text or the model name, without the key | state is shown, the way to change it is not |
| `↑` recall a queued message | none (the Website even says the queue pane never takes `↑`) | |
| `Ctrl+T` todos | `ctrl+t to expand` in the pane footer, read from the keymap | good pattern |
| `F7` / `F8` | centered `F7 switch · F8 close` while a side conversation exists | good pattern, but the identity and the keys share one crowded row |
| `/` `@` `#` `!` triggers | rotating `Tip:` text on the activity row, only while a turn runs | the idle screen teaches nothing |
| `Ctrl+C` twice to exit | a `press ctrl+c again to exit` notice after the first press | good pattern |

> **Status: target (H1, H7, H8, B4).** The "Today" table above is shipped; the
> placement rules and the placeholder below are the intended design.
> **The two-line status bar below is superseded by §8.1:** the status bar stays
> one row, key hints and tips move into the activity row's gaps (§8.3), and row
> 2 is used only by the agents and jobs tray (§8.8).

#### Placement: each key lives with its owner

The editor box stays as it is — a rounded frame with the session title in the
top-right corner and nothing else. Prompts go where the thing they act on is:

| Key belongs to | Its prompt lives in | Examples |
| --- | --- | --- |
| a pane | that pane's own footer or head row | `Ctrl+T expand` in the todo footer; `↑ recall newest` in the queue head |
| a panel or overlay | that panel's hint row, at its bottom (§2.2) | `/jobs`, `/agents`, `/model`, approval, settings |
| the completion list | the last line of the list | `↑/↓ options · Tab complete · Enter run · Esc close` |
| a foldable block | the block's own summary row, on the newest block | `▸ Took 6s · 2 tool calls · Ctrl+O expand` |
| the typed prefixes `/` `@` `#` `!` | **the editor's empty-state placeholder** (ghost text inside the content row, gone on the first keystroke) | `Ask anything · / commands · @ files · # skills · ! shell` |
| the editor or the session (no visible owner) | **status bar row 2** | `Enter send`, `Esc interrupt`, `Ctrl+S steer`, `Shift+Tab plan`, `Alt+M model` |
| the conversation being viewed | status bar row 2, right cluster | `F7 switch · F8 close` |

A key has one home. `Ctrl+O` is the one exception, because it is both a block
key and a global toggle: row 2 carries it whenever any block is in scope, and
the block cue appears on the newest foldable block only, so the screen never
repeats the same sentence three times. Transient outcomes (`press ctrl+c again
to exit`, `interrupt requested`) stay notifications.

#### The two-line status bar

> **Status: superseded (§8.1).** Kept as a record of the audit; do not
> implement. The status bar stays one row.

Row 1 says **what is true**; row 2 says **where you are and what you can
press**. Nothing about the rows needs a new contract: `MayflyStatusDefinition`
already carries `row: 1 | 2`, `band`, `priority`, and `overflow`, and the footer
already renders both rows.

| Entry | Row · band | Priority | Content |
| --- | --- | --- | --- |
| `basic` | 1 · left | 0 | model, plus an explicit thinking effort (`deepseek-chat High`) |
| `mode` | 1 · left | 1 | mode chips (target, B4): `PLAN` (accent, `PLAN…` while pending), `YOLO` (warning), `SHELL` in `!` mode |
| `goal`, `schedule` | 1 · left | 2 | as today |
| `jobs` | 1 · left | 3 | `⏵ N jobs` |
| `cwd`, `git` | 1 · left | 5, 10 | as today |
| `context` | 1 · right | 4, `hide` | `cache 34%  context: 18% (22.9k/128k)` |
| `scope` | 2 · left | 0 | side conversations only: kind badge, label, access, counterpart (`BTW … ⇄ MAIN`) |
| `keys` | 2 · left | 2 | the contextual key fragments (catalog below) |
| `switch` | 2 · right | 1 | `F7 switch · F8 close` / `detach`, only with two or more conversations |

The centered `conversation-view` entry retires: it splits into `scope` (identity)
and `switch` (keys). Identity and switching outrank ordinary hints, so a narrow
terminal drops the ordinary hints first, then trims labels, and only then the
switch keys.

Main conversation, by state (editor unchanged, status rows below it):

```
[1 main, idle, empty — the placeholder teaches the typed prefixes]
  Ready.

╭─────────────────────────────────────────────────────────────────── Update the landing page hero ─╮
│ > ▌Ask anything · / commands · @ files · # skills · ! shell                                      │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  deepseek-chat High  ⏵ 2 jobs  ~/work/mayfly  main ±3          cache 34%  context: 18% (22.9k/128k)
  Shift+Tab plan · Alt+M model                                                            /help keys
```

```
[2 main, idle, a settled turn is in Ctrl+O scope, plan mode on]
  » Update the landing page hero copy and run the tests.
  ▸ Took 6s · 2 tool calls · Ctrl+O expand
  ● Done — the hero now reads "Ship agent UI in a keystroke"; all 214 tests pass.

╭─────────────────────────────────────────────────────────────────── Update the landing page hero ─╮
│ > ▌Ask anything · / commands · @ files · # skills · ! shell                                      │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  deepseek-chat High  PLAN  ⏵ 2 jobs  ~/work/mayfly  main ±3    cache 34%  context: 18% (22.9k/128k)
  Ctrl+O expand · Shift+Tab exit plan · Alt+M model                                       /help keys
```

```
[3 main, a turn is running, empty draft]
  » Update the landing page hero copy and run the tests.
  ⠋ Working · 12s · ↑4.1k ↓1.2k

╭─────────────────────────────────────────────────────────────────── Update the landing page hero ─╮
│ > ▌Type a follow-up to queue it · @ files · # skills                                             │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  deepseek-chat High  ⏵ 2 jobs  ~/work/mayfly  main ±3          cache 34%  context: 18% (22.9k/128k)
  Ctrl+O expand · Esc interrupt
```

```
[4 main, a turn is running, draft typed — the placeholder is gone]
  » Update the landing page hero copy and run the tests.
  ⠋ Working · 12s · ↑4.1k ↓1.2k

╭─────────────────────────────────────────────────────────────────── Update the landing page hero ─╮
│ > Also update the footer▌                                                                        │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  deepseek-chat High  ⏵ 2 jobs  ~/work/mayfly  main ±3          cache 34%  context: 18% (22.9k/128k)
  Enter queue · Ctrl+S steer · Alt+Enter newline · Esc interrupt
```

```
[5 shell mode]
  » Update the landing page hero copy and run the tests.

╭─────────────────────────────────────────────────────────────────── Update the landing page hero ─╮
│ ! ▌Run a shell command                                                                           │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  deepseek-chat High  SHELL  ⏵ 2 jobs  ~/work/mayfly  main ±3   cache 34%  context: 18% (22.9k/128k)
  Backspace exit shell · Alt+M model
```

```
[6 main, a BTW is open in the background]
  » Update the landing page hero copy and run the tests.

╭─────────────────────────────────────────────────────────────────── Update the landing page hero ─╮
│ > ▌Ask anything · / commands · @ files · # skills · ! shell                                      │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  deepseek-chat High  ⏵ 2 jobs  ~/work/mayfly  main ±3          cache 34%  context: 18% (22.9k/128k)
  Shift+Tab plan · Alt+M model                                          ⇄ BTW · F7 switch · F8 close
```

```
[7 BTW displayed (live)]
  » why does the cache miss?
  ● The prefix changes when the system prompt is rebuilt…

╭──────────────────────────────────────────────────────────────────────── why does the cache miss ─╮
│ > ▌Continue the side question · @ files · # skills                                               │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  deepseek-chat High  ⏵ 2 jobs  ~/work/mayfly  main ±3          cache 34%  context: 18% (22.9k/128k)
  BTW why does the cache miss ⇄ MAIN │ Shift+Tab plan · Alt+M model             F7 switch · F8 close
```

```
[8 subagent displayed, one-shot (read-only)]
  ● reviewer finished: 3 findings

╭─────────────────────────────────────────────────────────────────────────────────────── reviewer ─╮
│ > ▌Read-only conversation                                                                        │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  deepseek-chat High  ⏵ 2 jobs  ~/work/mayfly  main ±3          cache 34%  context: 18% (22.9k/128k)
  SUBAGENT reviewer · read-only ⇄ MAIN │ PgUp/PgDn scroll                      F7 switch · F8 detach
```

```
[9 subagent displayed, continuable and cold (resumable)]
  ● reviewer paused after 3 findings

╭─────────────────────────────────────────────────────────────────────────────────────── reviewer ─╮
│ > ▌Reply to reviewer — sending resumes it                                                        │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  deepseek-chat High  ⏵ 2 jobs  ~/work/mayfly  main ±3          cache 34%  context: 18% (22.9k/128k)
  SUBAGENT reviewer · reply to resume ⇄ MAIN │ Enter reply · PgUp/PgDn scroll  F7 switch · F8 detach
```

Side conversations — the same two rows; `scope` leads row 2 and `switch` is
right-aligned so it never moves:


#### The placeholder: typed prefixes get their own area

> **Status: target (H8).**

The typed prefixes — `/` commands, `@` files, `#` skills, `!` shell — are not
keys to press but syntax to type, and there are four of them plus their
completion lists. Putting them beside `Esc`/`Enter`/`Ctrl+O` on row 2 would
crowd out the keys that matter most, so they get a different home: the
**editor's empty-state placeholder**. It is the dimmed ghost text every empty
prompt shows (the `> ▌Ask anything …` of screens 1–2), rendered *inside* the
content row, so the frame still carries only the title. It costs no row, sits
exactly where the user is about to type, and vanishes on the first keystroke —
which is precisely "tips during normal editing".

That splits the bottom of the screen by what the user is about to *do*:

| Question | Answered by | Cadence |
| --- | --- | --- |
| What can I type? | the placeholder (`/ @ # !`) | only while the buffer is empty |
| What can I press right now? | status row 2 (`Enter`, `Esc`, `Ctrl+S`, `Ctrl+O`, …) | changes with state |
| What is true right now? | status row 1 (model, `PLAN`, `YOLO`, jobs, context) | changes with facts |
| Where am I? | row 2 `scope` / `switch` | only in side conversations |
| Everything else | `/help` (linked from row 2 while idle) | on demand |

Placeholder by state:

| State | Placeholder variants, longest first |
| --- | --- |
| Main, idle | `Ask anything · / commands · @ files · # skills · ! shell` → `… # skills` → `… @ files` → `Ask anything · / commands` → `Ask anything` |
| Main, running | `Type a follow-up to queue it · @ files · # skills` → `Type a follow-up to queue it` |
| Shell mode | `Run a shell command` |
| BTW, live | `Continue the side question · @ files · # skills` → `Continue the side question` |
| Subagent, live | `Message <name> · @ files · # skills` → `Message <name>` |
| Subagent, resumable | `Reply to <name> — sending resumes it` |
| Read-only conversation | `Read-only conversation` |

Rules:

- **Whole triggers only.** The renderer takes the longest variant that fits the
  content width and never cuts a trigger in half (`# ski…`); the last variant
  may truncate with `…`.
- **Empty buffer, cursor at the end, no completion list open.** Any character —
  including `/` — removes it in the same frame. It never appears in a
  multi-line buffer, under an IME composition, or while a `/command` argument
  hint (the existing ghost) applies; the argument hint wins.
- **Tone.** `textMuted`, no chips, no key styling: it reads as ordinary
  placeholder text, not as a second toolbar.
- **Words match the triggers' lists.** `commands`, `files`, `skills`, `shell`
  are the same words the completion lists and `/help` use.
- **Owned by the mode.** Shell mode swaps it; a side conversation's access
  swaps it; a plugin may not add to it (extensions keep `hint?: string`).
- **Quiet on request.** `mayfly.keyHints: 'minimal'` shortens it to `Ask
  anything`; `off` removes it.

API: additive on the editor component, reusing the ghost path that already
paints command argument hints (`injectGhostHint`, which clips and drops itself
when there is no room):

```ts
setGhostHint(hint: string | readonly string[] | undefined): void
// a list is longest-first variants; the renderer picks the first that fits whole
// interaction/placeholder.ts computes them from mode, run state, and access;
// interaction/editor-plus.ts ghostHintFor(text) returns them for text === ''
```

Row 2 then stays small. Capacity budget: at most **four** fragments from 80
columns and **five** from 120, right cluster excluded, ordered by the §2.2
scale. A full idle row is `Ctrl+O expand · Shift+Tab plan · Alt+M model` plus
`/help keys`; a full running row is `Enter queue · Ctrl+S steer · Ctrl+O expand ·
Esc interrupt`. A new global key must displace a lower-priority fragment or take
an owner-local home; it does not get a third row.

Alternatives considered and rejected:

- **A third status row for tips.** A permanent row (about 4% of a 24-row
  terminal) that duplicates row 2's job and, for a learned user, is dead weight.
- **Rotating tips on row 2.** Moving text is hard to scan and steals the fixed
  place that `Esc`/`Ctrl+O` need. The activity row already rotates tips while a
  turn runs; that stays (roadmap H5).
- **Triggers as row 2 fragments.** Works at 120 columns, fails at 80: four
  syntaxes crowd out the keys, and the fragment limit would silently drop them.
- **Text in the editor frame.** The frame carries only the session title.

Keys that stay with their owner (not in the status bar):

```
[a] a slash-command list — its keys sit at the bottom of the list
╭──────────────────────────────────────────────────────────────────────────────────────────────────╮
│ > /mo▌                                                                                           │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
  /model   Switch the session model
  /effort  Switch the thinking effort
  ↑/↓ options · Tab complete · Enter run · Esc close

[b] the todo pane — its own keys sit in its own footer (shipped)
  Todo · ● active · 2/5
  ✓ read the config   ● wire the row   ○ update tests   ○ …
  … +2 more (1 done · 1 pending) · Ctrl+T expand

[c] the queue pane — the key that acts on it sits in its head row
  ── Queued (2) · ↑ recall newest ─────────────────────────────────────────────────────────────────
  Queued: also update the footer
  Steer:  keep the hero copy short

[d] a command panel (/jobs, /agents, /model, …) — the panel's own hint row
╭ Background jobs ─────────────────────────────────────────────────────────────────────────────────╮
│ → 1. pnpm test — running 42s                                                                     │
│   2. pnpm build — done                                                                           │
│                                                                                                  │
│   Enter open · Type filter · Esc close                                                           │
╰──────────────────────────────────────────────────────────────────────────────────────────────────╯
```

Narrow widths — row 1 sheds by its priorities; row 2 drops ordinary hints
first and never the identity or `F7`/`F8`:

```
[60 columns — the placeholder drops whole triggers, never half a word]
╭─────────────────────────── Update the landing page hero ─╮
│ > ▌Ask anything · / commands · @ files · # skills        │
╰──────────────────────────────────────────────────────────╯
  deepseek-chat High  ~/work/mayfly                  ctx 18%
  Ctrl+O expand · Shift+Tab plan                  /help keys
```

```
[60 columns, BTW]
╭─────────────────────────── Update the landing page hero ─╮
│ > ▌Continue the side question · @ files                  │
╰──────────────────────────────────────────────────────────╯
  deepseek-chat High  ~/work/mayfly                  ctx 18%
  BTW ⇄ MAIN │ Esc interrupt                         F7 · F8
```

```
[40 columns]
╭─────── Update the landing page hero ─╮
│ > ▌Ask anything · / commands         │
╰──────────────────────────────────────╯
  deepseek-chat High                 18%
  Ctrl+O expand · Shift+Tab plan
```

Fragment catalog for `keys`. Priority uses the §2.2 scale and is also the
display order, left to right, with `Esc` always last.

| Fragment | Key action | Shown when | Priority |
| --- | --- | --- | --- |
| `Esc interrupt` | `mayfly.interaction.cancel` | a turn or live descendant runs and no take-back is eligible | 120 |
| `Esc take back` | same | running, buffer empty, the just-sent message is still withdrawable | 120 |
| `Enter send` / `queue` | `submit` | draft non-empty; `queue` while running | 100 |
| `Enter reply` | `submit` | the displayed conversation is resumable (opens the reply form) | 100 |
| `Esc clear` | `cancel` | idle and draft non-empty | 98 |
| `Ctrl+S steer` | `steer` | running and draft non-empty | 96 |
| `Ctrl+O expand` / `collapse` | `mayfly.transcript.toggle-collapse` | any block in `expandTurns` scope is foldable / the scope is expanded | 92 |
| `Alt+Enter newline` | `newline` | draft non-empty | 88 |
| `Ctrl+G editor` | `external-editor` | draft non-empty | 84 |
| `PgUp/PgDn scroll` | `page-up`/`page-down` | the displayed conversation is read-only or resumable | 82 |
| `Shift+Tab plan` / `exit plan` | `shift-tab` | editor focused; label follows plan state | 78 |
| `F6 panes` | `mayfly.surface.next` | at least one interactive pane is mounted (built-in panes are passive) | 76 |
| `/help keys` (right cluster) | none (a command) | idle and buffer empty | 10 |
| `Alt+M model` | `cycle-model` | the provider lists more than one model | 50 |
| `Backspace exit shell` | `backspace` | `!` mode and buffer empty | 100 |

Side conversations by access, which decides both the editor's behavior and the
row:

| Displayed | Access | Editor | `scope` badge | `keys` | `switch` |
| --- | --- | --- | --- | --- | --- |
| BTW | interactive | the full chain | `BTW <question> ⇄ MAIN` | as main | `F7 switch · F8 close` |
| Subagent, live | interactive | the full chain | `SUBAGENT <name> ⇄ MAIN` | as main | `F7 switch · F8 detach` |
| Subagent, continuable and cold | resumable | `Enter` opens the reply form | `… · reply to resume` | `Enter reply · PgUp/PgDn scroll` | `F7 switch · F8 detach` |
| Subagent, one-shot | read-only | the draft is kept with a notice | `… · read-only` | `PgUp/PgDn scroll` | `F7 switch · F8 detach` |
| Main, with a side conversation open | interactive | the full chain | none | as main | `⇄ BTW · F7 switch · F8 close` |

`F8` names what it does: closing BTW disposes its temporary Agent (`close`),
closing a subagent only detaches the view and leaves it running (`detach`).
From main it acts on the `F7` counterpart, and the label says so
(`F8 close BTW`, `F8 detach reviewer`). With no counterpart the `F7`/`F8`
fragments are absent: a hint never names a key that does nothing.

The reply form (`Reply to <name>`) is a normal surface (§2.2). It follows the
redundancy rule: `Enter` sends (`enterSubmits`), `Esc` cancels, and its `Send`
and `Cancel` buttons go; the `Delivery` select (`‹ Queue ›`, `←`/`→` to `Steer`)
stays, because no bare key expresses it.

Rules:

- **Computed, never authored.** Row 2 is a pure function of app facts: running
  state and take-back eligibility (session facts), draft text (editor),
  disclosure state (transcript), queued messages, mounted panes, plan state,
  input mode, and the displayed conversation and its access. It recomputes on
  those changes only — no timers, no animation.
- **Keys come from the keymap.** A fragment names a key *action id*; its label
  renders `displayKey(keymap.getKeys(id))`. A rebound key updates the row, and a
  literal `ctrl+o` string is forbidden.
- **One notation: `Ctrl+O`.** Not `ctrl+o`, not `Ctrl-O`; the zh copy reads
  `按 Ctrl+O 展开`.
- **Toggles name the direction available now:** `expand` or `collapse`, never
  a bare key.
- **Verbs** extend the §2.2 vocabulary with `send`, `queue`, `reply`, `steer`,
  `interrupt`, `take back`, `clear`, `newline`, `editor`, `expand`, `collapse`,
  `scroll`, `plan`, `model`, `panes`, `switch`, `close`, `detach`, `commands`,
  `files`, `shell`.
- **Truthful scope.** A fragment appears only when its key would change
  something. Blocks older than `expandTurns` never advertise `Ctrl+O`; they say
  what is hidden, and roadmap H6 gives them a route.
- **Style.** Key token in `text`, label in `textMuted`, chips (`PLAN`, `YOLO`,
  `SHELL`, badges) bold in their tone; `NO_COLOR` keeps weight and glyphs.
- **Width.** Row 2 ladders the fragments with `when: { minWidth, maxWidth }`
  variants — the mechanism the activity row already uses — so the narrowest
  fitting variant never wraps.
- **Quiet on request.** `mayfly.keyHints: 'full' | 'minimal' | 'off'` (default
  `full`). `minimal` keeps interrupt/take back, `Ctrl+O`, and `F7`/`F8` on row 2
  and shortens the placeholder to `Ask anything`; `off` removes row 2, so the
  footer returns to one row, and the placeholder.
- **The editor frame is not decorated.** No hint, badge, or mode text is written
  into the frame; input mode is the prompt symbol, the frame hue, and the
  `SHELL` chip. The only text inside the box besides the buffer is the dimmed
  placeholder above.

Internal shape (interaction-owned, **not** a fifth public contribution
service — the four services of §1 stay the only seams; a plugin that wants a
fragment registers its own `mayflyStatus` entry on row 2):

```ts
interface KeyHint {
  id: string                    // 'expand', 'interrupt', …
  action: string                // key action id; the label is resolved, never typed
  label: string                 // localized verb from the vocabulary above
  priority: number              // §2.2 scale; higher survives narrower widths
}
// interaction/key-hints-status.ts computes KeyHint[] from facts and publishes
// one status entry on row 2 as a ladder of rich-text variants;
// interaction/conversation-view-status.ts splits into `scope` and `switch`.
```

Verification when this lands: a table-driven spec asserting the exact row 2 and
placeholder for every state above at 40, 60, 80, and 120 columns (whole triggers
only, gone on the first keystroke, absent in a multi-line buffer and under an
argument hint); an e2e that rebinds `Ctrl+O`
and sees row 2 and the block cue follow; the status footer's two-row width
scan; a locale spec for the zh copy; and a lifecycle spec that a side
conversation closing removes `scope` and `switch`. Runtime change:
dedicated-profile acceptance.

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
row (control) or an assistant block / running tool (transcript); `▸` folds a
tree branch (control) or a turn/child block (transcript). New surfaces must not
add a third meaning to either.

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
| Waiting ripple | `·· ·≈ ≈≈ ≈·`, 120 ms | "waiting on an external action" (superseded by the breathing dot, §8.2) |
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
| `▸` | folded turn or collapsed detail |

> **Status: target.** §8.2 adds `⎿`, `?`, `▌`, `↗`, `⚠`, `▰▱`, and `━─` to this
> table and replaces the moon and braille frame tables with the glyph system.

### 3.3 Motion policy

- **At most one animated indicator per surface** (refined by §8.2 to *one
  motion channel per row*, plus the one-shot transitions). The wire loader already
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
  Removes the stored credentials.          ← optional detail (warning)
→ [No]   [Yes]
```

Rules: put `defaultFocus` on the least destructive action; express
unavailability as `disabled` + `disabledReason` (never reject after the fact
in the handler); use `confirm` for every Yes/No question instead of drawing a
custom confirm page. Mark an action `busy` while its handler is in flight —
the busy action shows `…` and is skipped by `←`/`→` navigation.

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

> **Status: target (E1).**

Layout is renderer-owned and chosen by width, never by the plugin. Today the
strip is always the reserved footer row (§7.4 G3); the inline and folded
layouts below are the target:

```
inline (target, E1 — the strip shares the row, the row count never changes)
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

> **Status: target.** §8.10 redesigns the horizontal strip (text color only,
> heavy underline, no filled background) and the vertical rail (§4.6).

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

> **Status: target.** §8.10 and §8.11 specify the vertical rail that follows the
> cursor live (§7 F2), the long-path rules for sessions, and the status panel.

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
one action busy           ←/→ actions · Esc close              (action shows …)
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
≈ Waiting for authorization                        variant tide (see status)
  Esc cancel                                        ← cancelActionId, as a hint
```

Frames cycle `⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏` (braille, 80 ms) or `≈≋∿≋` (tide). The renderer owns
the clock — all loaders in one surface share it, and it stops when the surface
hides or unloads; `elapsedMs` is plain data the owner publishes (painted as
`45s`, then `2m 10s`). Loaders live in panes and overlays only: the status and
editor-extension unions exclude them, and live turn status belongs to the
activity pane.

`cancelActionId` should paint as the `Esc cancel` hint, not as a `[ Cancel ]`
button: cancelling a loader is exactly what `Esc` already does (redundancy
rule, §4.1). `cancelLabel` remains for surfaces that show the button anyway.

> **Status: superseded (§8.1, §8.5).** The ripple retires, so §7 A1 no longer
> applies. The loader gains `gap` (indeterminate default) and `breath` (waiting
> on an external action); `braille` and `tide` stay accepted for compatibility.
> Determinate work uses the `▰▱` bar with `n/N`.

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
   **shipped**; only the code, and the §1–§6 sections without a
   `Status: target` banner, describe what runs today.
6. Assert the footer string for every state the surface can be in (idle,
   searching, editing, decision, busy). A hint is a contract, and §2.2 lists
   the only verbs it may use.
7. Run the redundancy test (§4.1) on every action, and the stray-key test
   (§4.8) on every surface that opens without the user asking for it.
8. Key prompts: every key a screen state makes useful is visible in that state
   (§2.3) — the surface row inside overlays, the owner's own footer for pane
   and block keys, status row 2 for editor and session keys. A new global key or
   state extends the §2.3 fragment catalog and its exact-row spec.
9. Diagrams are exact renderings at a stated width: the top rule, every row,
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

**A1 · Unify the waiting ripple — superseded by §8.1 (R1).**
> The ripple retires; this item is kept for history only.

The wire `tide` loader frames (`≈ ≋ ∿ ≋`, 80 ms) are unused by any shipped
product surface, while the transcript's waiting animation is the moon ripple
(`·· ·≈ ≈≈ ≈·`, 120 ms). Align them into one ripple, keeping braille for work
that is actively computing.

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

**B4 · Mode chips in the status bar, an undecorated editor — target.**
The editor frame carries the session title in the top-right corner and nothing
else. Session and input modes are status, so they live in status row 1 as
chips (§2.3), next to the model they modify:

```
  normal      deepseek-chat High
  plan        deepseek-chat High  PLAN
  yolo        deepseek-chat High  YOLO
  plan+yolo   deepseek-chat High  PLAN  YOLO
  shell       deepseek-chat High  SHELL
```

Rules:

- **`PLAN` is `accent`, `YOLO` is `warning`, `SHELL` is `shellMode`**, each
  bold, each with its own tone. There is no merged "highest alert" hue, so
  `PLAN  YOLO` reads as one violet chip beside one amber chip. `PLAN…` marks a
  pending toggle.
- **Chips outrank goal, schedule, and jobs** (priority 1), so a narrow footer
  never drops the mode the user is in.
- **The way to change a mode is a key fragment on row 2**
  (`Shift+Tab plan` / `exit plan`), never text on the chip.
- **The editor frame changes only in paint**: `border` ↔ `borderFocus`, and the
  existing `shellMode` recolor plus `!` prompt symbol in shell mode. The
  left-edge `! shell mode` label of the shipped bash mode moves to the `SHELL`
  chip so the frame has no text but the title.
- The chip never carries a "dirty" or "unsaved" word.

Touch points: `interaction/mode-status.ts` (uppercase chips, priority 1, add
`SHELL`), `interaction/editor-plus.ts` (drop `setBorderLabel` for bash, keep
`setBorderColor` and `setPromptSymbol`), `interaction/mode-commands.ts` (still
owns the mode snapshot); `website/**/features/status-bar.md` and `modes.md`.

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

**H1 · Two-line status bar with a key row — superseded by §8.1 (R2, R7).**
> The status bar stays one row; keys and tips live in the activity row's gaps.

Add the state-driven `keys` entry of §2.3 on status row 2, and split the
centered `conversation-view` entry into `scope` (row 2, left) and `switch` (row
2, right). It covers running-state keys (`Esc` interrupt / take back, `Enter`
queue, `Ctrl+S` steer), draft keys (`Alt+Enter`, `Ctrl+G`, `Esc` clear), view
keys (`Ctrl+O`), mode keys (`Shift+Tab`, `Alt+M`), `/help keys` while idle, and
the side-conversation access states (`Enter reply`, read-only
scroll). No contract change: `row`, `band`, `priority`, and `overflow` exist.

Touch points: new `interaction/key-hints-status.ts`,
`interaction/conversation-view-status.ts` (split), `interaction/keys.ts`,
`interaction/locale.ts` and zh copy, `interaction/subagent-reply.ts` (reply form
loses `Send`/`Cancel`, gains `enterSubmits`); the status footer width scan;
a table-driven state spec; an e2e that rebinds a key; `website/**/features/
status-bar.md` and `panes.md` (the footer becomes two rows). Runtime change:
dedicated-profile acceptance.

**H8 · Editor placeholder for the typed prefixes — target.**
An empty prompt shows state-driven ghost text that teaches `/` commands, `@`
files, `#` skills, and `!` shell (§2.3), in whole-trigger variants that shrink
with the width; it vanishes on the first keystroke and never touches the frame.
`setGhostHint` accepts a longest-first variant list, and
`interaction/placeholder.ts` picks the text from input mode, run state, and the
displayed conversation's access.

Touch points: `core/components.ts` and `core/chrome.ts` (`setGhostHint`,
`injectGhostHint` variant selection), `core/types.ts` (editor interface),
`interaction/editor-plus.ts` (`ghostHintFor` for the empty buffer, argument
hint precedence), new `interaction/placeholder.ts`, `interaction/locale.ts` and
zh copy; the editor width scan and a state spec. Runtime change:
dedicated-profile acceptance.

**H7 · Owner-local prompts — target.**
Keys that belong to a visible owner are cued there: `↑ recall newest` in the
queue pane's head row (`Queued (2) · ↑ recall newest`), the slash-completion
list's own last line, and `Ctrl+T` in the todo footer (shipped). The Website
statement that the queue pane never takes `↑` is corrected: `↑` on an empty
prompt withdraws the newest queued message.

Touch points: `interaction/pane-queue.ts`, `interaction/editor-plus.ts`
(completion footer), `website/**/features/panes.md` and `editor.md`.

**H2 · Complete the `Ctrl+O` cue — target.**
One shared helper builds the inline cue from the live keymap and names the
direction available (`expand` / `collapse`). Turn headers, thinking blocks,
tool groups, and search/read/command groups use it; only the newest foldable
block shows it, and a narrow row drops counts before the key.

Touch points: `transcript/hints.ts`, `transcript/process-rows.ts`,
`transcript/thinking.ts`, `transcript/components.ts`,
`transcript/read-group.ts`, `transcript/search-group.ts`,
`transcript/command-group.ts`, `transcript/tool-line.ts`,
`transcript/locale.ts`; expose a readonly disclosure projection (expanded,
foldable count in scope) for the H1 `keys` entry.

**H3 · One key notation — target.**
`Ctrl+O` everywhere: inline cues (`ctrl+o`), zh copy (`按 Ctrl-O`), Website
pages (`Ctrl-O`), `/help`, and the tips. Keys always render through
`displayKey`.

Touch points: `transcript/hints.ts` (`HINTS_ZH`), `transcript/locale.ts`,
`transcript/pane-todo.ts` fallback, `website/**/reference/keys.md`,
`website/**/features/streaming.md`, `website/**/guide/config.md`.

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
entries when the row is full. With B4 the mode chips hold a reserved
first-cluster slot on row 1, and row 2 (§2.3) is a second grid for scope, keys,
and switch entries.

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

**H4 · Quiet key hints setting — backlog.**
`mayfly.keyHints: 'full' | 'minimal' | 'off'` for users who have learned the
keys. `minimal` keeps interrupt / take back, `Ctrl+O`, and `F7`/`F8`; `off`
removes status row 2.

Touch points: `interaction/settings.ts`, settings model and locale,
`interaction/prompt-hints.ts`.

**H5 · Teach keys, not only commands — backlog.**
The activity row's rotating tips are ASCII command teasers shown only while a
turn runs. Add key tips (`Shift+Tab` plan, `Ctrl+G` editor, `Alt+M` model,
`Ctrl+S` steer) to that rotation. The idle screen's teaching is the H8
placeholder, not tips.

Touch points: `transcript/tips-content.ts`, `transcript/status-tips.ts`,
`transcript/pane-activity.ts`.

**H6 · A keyboard route to older folded turns — backlog.**
Turns older than `expandTurns` say how much is hidden but offer no key. Either
let `F6` focus the transcript with `Enter` to open the block under the cursor,
or raise the scope from `/settings` and say so in the hidden-lines text.

Touch points: `transcript/transcript-model.ts`, `transcript/hints.ts`,
`core/surface-renderer.ts`.

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
| G7 | Redundant buttons: `Set as default` + `Cancel` (pickers); `Back`/`Next`/`Submit answers`/`Cancel` (questionnaire); loader `[ Cancel ]`; single-field form `Submit`/`Cancel` | see §4.1 redundancy rule | E2, F1 |
| G8 | Three checkbox notations: `●`/`○` (multiple lists), `[x]`/`[ ]` (pickers), `[on]`/`[off]` (toggle); `●` is also the "selected" marker in single lists (UX-24) | `core/ui-patterns.ts` `renderList`, `renderFormField` | multiple lists adopt `[x]`/`[ ]`; `●` stays transcript-only |
| G9 | Hint verbs overlap: `pick` (open a select), `choose`, `apply`, `open` (UX-23) | `core/ui-key-grammar.ts` | settle on the §2.2 vocabulary; rename `pick` |
| G10 | The main screen has no persistent key prompt; `Esc` interrupt, `Ctrl+S`, `Alt+Enter`, `Ctrl+G`, `Shift+Tab`, `Alt+M`, and `F6` are cued nowhere | `interaction/input-plugin.ts`, `interaction/keys.ts` | H1 |
| G11 | The `Ctrl+O` cue is scope-limited (last `expandTurns` turns), one-directional (no `collapse` after expanding), silently dropped on narrow rows, and hard-coded as `ctrl+o` instead of read from the keymap (the todo pane does read it) | `transcript/hints.ts`, `process-rows.ts`, `thinking.ts`, `locale.ts` | H2 |
| G12 | Three notations for one key: `ctrl+o` (inline), `Ctrl-O` (zh copy, Website), `Ctrl+O` (grammar, `/help`) | `transcript/hints.ts`, `website/**` | H3 |
| G13 | (§8.1: the idle screen stays empty by decision; tips live in the `Working` row's gap.) Tips rotate only while a turn runs; the idle screen teaches nothing, and the `#` skills prefix is cued nowhere (`!` and `@` appear in the rotation) | `transcript/tips-content.ts`, `interaction/editor-plus.ts` | H5, H8 |
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
| G24 | Tabs cannot render a vertical rail that follows the cursor; the label column switches only on `Enter` (§7 F2) | `core/ui-compiler.ts` | R9 |

## 8. Redesign round: activity, tools, panels, and interaction scenarios

> **Status: target.** Everything in this section is an agreed design, not
> shipped behavior. Every item carries an ID (R1–R19) in §8.18 and flips to
> **shipped** in the change that implements it. Diagrams are drawn by the
> runnable prototype in §8.19; run it to see the motion the ASCII cannot show.

This round redesigns the parts of the interface a user watches most: the live
activity row, tool results, loaders, compaction, todo and goal, the subagent
and job tray, decisions and questions, and the panels built from tabs, lists,
and forms. It also adds the interaction scenarios the earlier sections did not
cover. Where it disagrees with earlier text, §8.1 lists the winner.

### 8.1 Decisions that supersede earlier text

| Earlier text | Now |
| --- | --- |
| §2.3 two-line status bar, §7 H1, G16 (row 2 carries keys, scope, switch) | **The status bar stays one row.** Key hints and tips live in the activity row's gaps (§8.3); the tray (§8.8) is the only row-2 entry, and only while agents or jobs exist |
| §7 G13, §2.3 (tips on the idle screen) | **No tips while idle.** The idle activity row renders nothing. Tips rotate in the gap of the `Working` row only |
| §3.1 ripple rows, §7 A1, §4.10 `tide` | **The ripple `·· ·≈ ≈≈ ≈·` retires.** The waiting motion is the breathing dot (§8.2); the indeterminate loader is the gap spinner |
| §3.3 "at most one animated indicator per surface" | Refined: **one motion channel per row** (glyph *or* label, never both), plus the one-shot transitions of §8.2 |
| §3.2 `Deep diving` (the waiting-on-model label) | Renamed **`Working`**, with a braille fill glyph |

Unchanged and still authoritative: the §2.3 placement rules for pane, panel,
and block keys, the editor placeholder (H8), and the mode chips (B4).

### 8.2 Motion and glyph system

One glyph, one meaning, one motion channel per row. A row animates its glyph
or its label, and the other stays still. Motion is a fact about the machine:
when the row is waiting on the user, or settled, nothing moves.

| State | Moves | Frames | Step |
| --- | --- | --- | --- |
| Thinking | glyph (bloom) | `· ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢` | 100 ms |
| Working on the model, writing | glyph (fill) | `⡀ ⣄ ⣤ ⣦ ⣶ ⣷ ⣿ ⣷ ⣶ ⣦ ⣤ ⣄` | 100 ms |
| Tool running | label (shimmer); `●` static | a three-letter window sweeps the label | 100 ms per letter |
| Waiting on an external action | glyph (breath); label static | `●` steps `muted → accent → accent strong → accent` | 400 ms |
| Indeterminate loader | glyph (gap) | `⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷` | 100 ms |
| Waiting on the user | nothing | `?` (warning) | — |
| Stopping | nothing | `■` (danger) | — |

```
✻ Thinking · 8s · ↑30.2k ↓1.1k                       Esc interrupt · Ctrl+O expand
⣤ Working · 2s                                        Tip: @ files
● Running commands · 12s · ↑30.2k ↓4.1k · 38 tok/s    ← the label shimmers, ● is still
● Waiting for authorization · 45s                     ← ● breathes, label is still
? Waiting for your action · 8s                        ← static: nothing is computing
```

Rules:

- **The wire carries no color values.** The breath is a cycle of tone tokens
  and the shimmer is `accent`+`strong` spans over `muted` ones, so both survive
  `NO_COLOR` as weight (§7 D1). Width never changes between frames; only tone
  and weight do.
- **One-shot transitions are allowed and end by themselves:** the 400 ms
  inverse flash when an item settles (tool, todo item), the 300 ms stagger of a
  subagent fan-out, and the 800 ms drain of the compaction bar. They never loop
  and never overlap a running channel on the same row.
- **The renderer owns every clock** (§3.3). Frame tables live in
  `transcript/spinners.ts`; `≈≋∿≋` and `·· ·≈ ≈≈ ≈·` are removed.
- **Width.** `✳` and `✽` may render two cells wide in some fonts. Width math
  goes through `mayflyComponents.visibleWidth`; the fallback for a wide result
  is `*`. Every frame is one cell wide, so the two-cell moon slot disappears.
- **Reduced motion** freezes each channel on its first frame (§7 D1).

New glyph vocabulary (extends §3.2):

| Glyph | Meaning |
| --- | --- |
| `⎿` | detail connector under an activity header or a failed row |
| `?` | waiting on the user |
| `▌` | focus bar on a rail or list row |
| `↗` | opens in the external editor |
| `⚠` | warning (deletes files, low balance, dangerous tool) |
| `▰` `▱` | determinate progress cells |
| `━` `─` | heavy and light rule: tab underline, todo and goal progress |

### 8.3 Activity pane: one action, several lines

The header carries the phase, elapsed time, throughput, and a right-aligned
gap. Under it, one to three wrapped `⎿` lines describe **the single action
running now**: the running command, path, or query, or the latest reasoning
paragraph. It is never a list of tools.

```
✻ Thinking · 8s · ↑30.2k ↓1.1k                       Esc interrupt · Ctrl+O expand
  ⎿ Checking whether facts.activity can carry more than the latest tool name,
    since every tool/call overwrites the previous one…

● Running commands · 12s · ↑30.2k ↓4.1k · 38 tok/s   Esc interrupt · Ctrl+O expand
  ⎿ pnpm run verify:changed -- --plan

⣤ Working · 2s                                        Tip: / commands
```

- **The gap.** Running rows with a detail line carry `Esc interrupt · Ctrl+O
  expand` there (this cues the interrupt key that is unadvertised today, G10).
  The `Working` row, which has no detail, rotates the tip there instead. Idle
  renders nothing.
- **Height.** One header plus at most three detail lines. The row never
  collapses while active, so the editor does not shift between phases; a phase
  with fewer lines pads to the turn's high-water mark.
- **Narrow widths** shed, in order: detail lines beyond the first, the `⎿`
  connector, the header tail (rate, counters, elapsed), then the gap.
- **Data.** No new projection is required: `ConversationFacts.activity` already
  carries the single current action. Detail wrapping widens today's one-line
  budgets (`DETAIL_BUDGETS`) to three lines; `LIVE_DETAIL_MAX_CHARS` (160) and
  the reasoning scan window are unchanged.
- **Ownership** is unchanged: the activity pane is the sole owner of live
  status, and transcript rows speak only in the past tense (§3.2 stays).

### 8.4 Tool rows and cards

Running calls use the tool row of §8.3, with the category choosing label and
detail:

```
● Running commands    ⎿ pnpm run verify:changed -- --plan
● Reading files       ⎿ packages/mayfly/src/transcript/pane-activity.ts
● Searching code      ⎿ "liveProcessDetail" in packages/
● Visiting web pages  ⎿ https://pi.dev/docs/latest/tui
● Updating the plan   ⎿ 3 of 5 items done
? Waiting for your action ⎿ Which release channel should this go to?
```

Settled calls are one static line: glyph, past-tense verb, target, outcome.

```
✓ Read pane-activity.ts · 481 lines
✓ Searched "activity" · 47 matches in 12 files
✓ Ran pnpm run check:lib · 4.2s
✗ Ran pnpm run lint · exit 1 · 3s
✓ Fetched pi.dev/docs/latest/tui · 200 · 18 KB
▸ Read 3 files · Searched code · Ran 2 commands · 6s        ← folded turn, Ctrl+O
```

**Edit is a diff; Write is not.**

```
● Preparing to edit files · 3s · ↓0.8k           phase 1: arguments streaming
● Editing files · 5s                              phase 2: applying
  ⎿ pane-activity.ts  +12 −3 ▮▮▮▮▮▮▮▯                the counts tick up as the patch parses
✓ Edited pane-activity.ts  +12 −3 ▮▮▮▮▮▮▮▯        phase 3: 400 ms flash, then static
    41   41 │   const moon = state.mode === 'waiting'
    42      │ − const frame = moon
         42 │ + const frame = glyphFor(state)
    43   43 │   const now = activityNow()
    ⋯
   118  118 │   return { kind: 'stack', direction: 'column',
```

- Two gutters (old, new), sized by the largest line number. Every changed line
  carries `−` or `+` as well as color. One to three context lines per hunk,
  `⋯` between hunks, `… +N lines · Ctrl+O` beyond 12 rows, long lines end in
  `…`. Row painting stays with the diff tokens (§7 C1).
- Multi-file patches list `A`/`M`/`D` with a per-file stat; a failed edit puts
  the reason on the `⎿` line.
- **Write** is one line, `✓ Wrote path · 84 lines · 3.1 KB`. A plain preview
  (no `+` markers, no line numbers) shows only when expanded with `Ctrl+O`.

### 8.5 Loader and progress

```
⣾ Discovering models from api.example.com  12s       indeterminate: the gap spinner
● Waiting for authorization · 45s                     waiting on an external action: breath
Building ▰▰▰▰▰▰▱▱▱▱ 6/10                              determinate: the total is known
```

- The wire loader gains the variants `gap` (new default) and `breath`; `braille`
  and `tide` stay accepted for compatibility (additions only, §5).
  `cancelActionId` still paints as the `Esc cancel` hint (§4.1).
- **progress** is `▰▱` cells plus `n/N`. It replaces the `█░` bar wherever the
  total is known. A bar never appears for unknown durations: an eased bar that
  never completes is a fabricated estimate and is not used.
- Settled forms are static: `✓ Discovered 14 models · 2.1s`,
  `✗ … [ Retry ]`, `⊘ Cancelled`.

### 8.6 Compaction

Compaction reports real stages, so its bar is real. The bar is **context
occupancy** (`contextTokens / contextWindow`, both already in the facts), and
the two stages are the `compaction/start` → `compaction/summary` → `compaction/end`
lifecycle.

```
● Compacting context ▰▰▰▰▰▰▰▰▰▱ 91%  1/2 summarizing · 4s · auto      the edge cell breathes
● Compacting context ▰▱▱▱▱▱▱▱▱▱  9%  2/2 applying · auto              800 ms drain when the summary lands
✓ Compacted 84 items ▰▱▱▱▱▱▱▱▱▱ 91% → 9% · ~148k → ~12k tokens · auto
  ⎿ Ctrl+O summary
✓ Compacted 84 items · 91% → 9%                                       narrow: the bar goes first
✗ Compaction failed: context still over budget after summary
```

The drop comes from the existing `compaction/summary` metering event, so it
matches the status bar's context meter. Without a known context window the bar
falls back to the two stages (`1/2`, `2/2`).

### 8.7 Todo and goal

The heading rule is the progress bar: heavy `━` for done, light `─` for what is
left. There are no block bars and no per-item marker trail.

```
━━━━━━━━━━━━━━━━━━━━━──────────────────────────────  Goal ● active · round 2 of 8
  Ship the hero refresh and keep all 214 tests green
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━──────────────────────  Todo 2 of 6
  ✓ Audit current hero copy               ← muted, struck through
  ✓ Update landing page hero
  ● Run the tests                         ← bold: the only emphasised row
  ○ Update screenshots
  … +2 more · ctrl+t

━━━━━━━━────────────────  Todo 2 of 6 · ● Run the tests               collapsed
━━━━━━━━━━━━────────────  Goal ❚❚ paused · round 4 of 8
━━━━━━━━━━━━━━━━━━━━━━━━  Goal ✕ blocked · round 8 of 8
  blocked: needs a decision on the release channel
```

The window follows the active item and keeps two finished rows above it. The
only motion is the 400 ms flash when an item completes and a closing line,
`✓ Todo done 6/6 · 4m 12s`, before the pane closes.

### 8.8 Subagent and job tray

The subagent pane above the editor is replaced by a **tray**: one status entry
on row 2 under the single-row status bar, present only while agents or jobs
exist. It reuses the existing `row: 1 | 2` contract, so no status-contract
change is needed. Agents and jobs are separate tabs.

```
  Agents 5 ● 1 waiting  ·  Jobs 3 ⏵ 2 running                       ↓ manage
```

Focused, it shows at most four rows and counts the rest:

```
  ‹ Agents 5 ›   Jobs 3      ←/→ tab · ↑↓ select · Enter view · x stop · Esc back
 ▸ ● review   Audit facts projection     41s · 6 tools · ↓6.4k
   ● plan     Draft migration plan       waiting · reply needed
   ✓ explore  Map transcript files       12s · 8 tools
   ✓ lint     Sweep oxlint findings      9s · 3 tools
   ↑ 0 more · ↓ 1 more
```

- **Limits:** three names idle, four rows focused; live entries first.
- **Keys:** `↓` on an empty prompt (or `F6`) enters the tray; `←`/`→` switch
  tabs; `↑`/`↓` select; `Enter` on an agent opens its conversation (`F7`
  returns) and on a job its detail overlay; `x` stops behind the shared Yes/No
  with No focused first; `Esc` leaves one layer. `F7`/`F8` hints sit in the
  tray row's right cluster only when two or more conversations exist.
- **Motion:** the tray has no clock (the activity row above it already
  animates). Its fan-out staggers 300 ms per row once, and a row flashes once
  when its own numbers change.
- **Seam:** focus and selection come from an overlay list (§4.4), so plugins
  still never see keys. Agent-scoped actions bind to the exact Agent, as in
  `mayflyCurrentAgent`.

### 8.9 Decisions and questions

Approval, plan review, permission, and questions share one skeleton (§7 B1): an
overlay card with a header (title, subject, queue position), a preview, a
numbered choice list with descriptions, and the hint row. The safe option is
focused first and digits act instantly.

```
╭ Approve command ───────────────────────── bash · 1 of 3 waiting ╮
│   $ rm -rf build && pnpm build                                  │
│   in ~/work/mayfly                            ⚠ deletes files   │
│                                                                 │
│ ▸ 1  Allow once                                                 │
│   2  Allow bash for this session                                │
│   3  Reject and tell the agent why…                             │
│   Feedback: type to explain…                                    │
│   Esc reject · 1-3 choose · Enter confirm                       │
╰─────────────────────────────────────────────────────────────────╯
```

- **Edit approval** swaps the preview for the numbered diff of §8.4.
- **Plan review** shows a scrollable plan preview above the options
  (`Approve and start`, `Approve and auto-accept edits`, `Keep planning…` with
  `Revise:`, `Reject`), and keeps `numbered: 'focus'` so `Enter` alone can
  never approve.
- **Permission preset** keeps `[current]` on the row and a per-row `confirm`
  (`Full access — ⚠ asks first`).
- **Queue.** Queued approvals are FIFO per Agent; the header chip reads
  `1 of 3 waiting`.

Multiple questions get a step strip with per-step state and a Review page:

```
╭ Questions ──────────────────────────────────────────────── 2 of 3 ╮
│ ✓ Auth  │  ● Region  │  ○ Scopes  │  ○ Review                      │
│                                                                    │
│ Which region should the service deploy to?                         │
│ ▸ 1  ● us-east-1     lowest latency to most users                  │
│   2    eu-west-1     GDPR data residency                           │
│   3    ap-south-1    closest to the pilot customers                │
│   4    Other  type your own answer                                 │
│ ←/→ question · 1-4 choose · Enter next · Esc cancel                │
╰────────────────────────────────────────────────────────────────────╯
```

Multi-select uses `[x]`/`[ ]` and `Space`. The Review page lists every answer
(`— skipped` in warning), `1`–`3` jump to a question, and `Submit answers`
sends every page as one action. Below 60 columns the strip collapses to
`Region · 2/3 ›`.

### 8.10 Tabs, lists, and forms

**Tabs color the text, never a filled background.** The focused tab is bold
`primary` with a heavy `━` rule beneath it; without focus it keeps its color
but loses weight and the rule dims (`border`); idle tabs and counts are
`muted`; `!` is `warning` strong.

```
  Overview   Usage 3   Connections !   Skills 12   About        H1 underline (target)
             ━━━━━━━
  ✓ Kind  ›  ✓ Connection  ›  ● Models  ›  ○ Review             wizard steps
  ‹ Usage 3  Connections !  +3 ›                                 narrow: the active tab stays visible

  SESSION                  vertical rail: ▌ focus bar, counts right-aligned
   General                 the content follows the cursor live (F2 ships here)
   Model
  ▌ Permissions     2
  INTEGRATIONS
   Providers        !
```

- **Contrast is a spec, not an opinion.** A guard spec asserts every tab text
  color against its theme's background at ≥ 4.5:1 (disabled text is exempt).
  The prototype's values are `dark` active 5.4 / selected 7.1 / idle 5.5 /
  attention 9.3 and `light` 6.3 / 5.1 / 5.4 / 4.9.
- **`NO_COLOR`:** weight and the rule carry the state; glyphs are unchanged.
- **Rail.** Group headings, the `▌` bar, a right-aligned count or `!`. The
  active row is `primary` strong when the rail has focus and `primary` regular
  when focus is in the content. `↑`/`↓` move and the content follows; `→` or
  `Enter` enters the content, `←` returns.

**Expandable lists.** One list model covers a tree (parents with tri-state
children) and an accordion (a row that expands to text).

```
 MCP SERVERS  4
  ▾ [-] filesystem      ✓ connected · 120ms          4 tools
   │ [x] read_file       Read a file from disk
   │ [x] write_file      Create or overwrite a file
   │ [ ] delete_file     Remove a file               ⚠ dangerous
   ╰ [x] list_dir        List a directory
  ▸ [-] github          ✓ connected · 340ms         12 tools

 SKILLS  2
  ▸     plugin-author   preset     Prototype a Cordis plugin in-process,
  ▾     preset-author   preset     Compose user-owned presets on the native
    │ Compose user-owned presets on the native
    ╰ dsh services and the four UI services.
```

The selected row keeps the inverted bar with a `▌` focus mark. Columns align
(name, status, right-aligned count); checked children read normally and
unchecked ones dim; parents show `[x]`, `[-]`, or `[ ]`. `→`/`Space` expands,
`←` collapses, `Enter` toggles (a parent toggles all its children), `*` and
`-` expand and collapse everything, and a "loads more" row pages large groups.

**Forms** are the shared field kinds (§4.2, §4.3) with the rules of the form
audit made explicit:

```
╭ Edit provider ────────────────────────────────── unsaved changes ╮
│ ── Connection ──────────────────────────────                     │
│   Name:        production                                        │
│ ▸ Endpoint:    https://api.example.com/v1                        │
│     Base URL, including the version path                         │
│ • API key:     ••••••••••  (saved)                               │
│ ── Behaviour ───────────────────────────────                     │
│   Model:       ‹ deepseek-chat ›  (inherited)                    │
│ • Timeout:     ‹ 45 › s  5–120                                   │
│   Streaming:   [on]                                              │
│   Channels:    mentions, errors                                  │
│   Directory:   ~/work/may▌                                       │
│     ⇥ ~/work/mayfly                                              │
│   Notes:       Prefer small diffs. …      (expands when focused) │
│ ── Finish ──                                                     │
│   [ Save ]  [ Cancel ]                                           │
│ ↑↓ field · ←/→ cycle · Enter list · Delete reset · Esc close     │
╰──────────────────────────────────────────────────────────────────╯
```

- **No per-field buttons.** Field state is implicit: `•` marks an edited field,
  `(inherited)`/`(override)` is text, and secondary operations appear as keys
  in the hint row only while they apply (`Delete reset` only when a reset would
  change the value). The focused select wraps its value: `‹ auto ›`.
- **Field kinds:** text, secret (never echoed, `(saved)` when set), number
  (unit, range, `←`/`→` step or type), select (`←`/`→` cycles without wrapping,
  `Enter` opens the list), toggle (`Space`), multiselect (`Enter`/`Space`
  opens, `Space` toggles, `Enter` applies, disabled options show their reason),
  textarea (expands when focused, `Alt+Enter` newline), and a path field that
  completes with `Tab`.
- **Errors** repaint under the field as `! message` once the value is edited.
  The finish row is the form's own `Submit`/`Cancel`, not a field button.

### 8.11 Panels: sessions, settings, status

Panels are compositions of the components above, not new widgets: a vertical
rail plus a content column (sessions, settings) or a tab strip plus a
key/value body (status).

**Sessions.** The rail lists workspaces; the content lists that workspace's
sessions with a filter row, and the focused session expands in place to show
its first prompt and last outcome.

```
╭ Sessions ─────────────────────────────────────────────────── 25 total ╮
│                          │ ⌂ ~/dev/clients/acme/monorepo/packages/mayfly │
│    All             25    │ / filter…                                      │
│    work/mayfly      8    │ Recent                                         │
│ ▌  packages/mayfly  5    │▸ Port the tray to acme layout  feat/tray 6 turns 3h │
│    …roject-name-here 4   │    │ Port the tray design to the acme fork.    │
│    website          5    │    │ Rebased; specs pass.                      │
│ ↑↓ workspace · → sessions · / filter · y copy path · Esc close             │
╰────────────────────────────────────────────────────────────────────────────╯
```

- **Long paths never enter the rail.** A label is the basename; when two
  workspaces share it, the shortest distinguishing parent is added
  (`work/mayfly`, `packages/mayfly`); a label that still overflows is
  ellipsised at its *start* (`…roject-name-here`) so the distinguishing end
  stays visible.
- **The full path** is the first line of the content, home-collapsed to `~` and
  ellipsised in the *middle* (`~/dev/clients/acme/…/packages/mayfly`); `y`
  copies it in full.
- **No markers for the current directory or the current session.** Recency
  groups and the resume action are enough.
- Sessions stay lazy and bounded per the `/sessions` ownership rules: headers
  first, projections only for the opened workspace.

**Settings.** The rail holds the setting groups; the content is the shared
form of §8.10. Each group keeps its own draft; `←` on a non-cycling field
returns to the rail.

**Status** is read-only: tabs `Overview`, `Usage`, `Account`, `Connections`,
`About`, with a right-hand `!` on a tab that needs attention.

```
  Overview   Usage   Account !   Connections !   About
                     ━━━━━━━━━
  Provider     DeepSeek
  Balance      ⚠ ¥ 6.20 low balance · below ¥ 10.00
               topped-up ¥ 0.00 · granted ¥ 6.20
  Checked      2 min ago · r refresh
  Top up       platform.deepseek.com  ·  o open in browser
```

- **Account balance** is one optional read-only provider query, cached, with a
  refresh key. States: available, low (warning, threshold configurable),
  loading (`⣾ checking balance…`), unavailable (`— unavailable (network)  r
  retry`), and unsupported (the row is hidden). A failed check never affects
  the conversation, and the key never appears in the panel. When low, the
  status bar may carry a small `⚠ ¥6.2` chip.
- Overview also carries a one-line `Balance` row so the answer is visible
  without opening the tab.

### 8.12 Interaction scenarios

| Scenario | Design | Keys |
| --- | --- | --- |
| Command palette | filtered list with the match bolded, description, and the command's own key | `/` then type · `Tab` complete · `Enter` run · `Esc` close |
| `@` file picker | recent first, fuzzy on name and path; the focused row shows `↗ code` | `Enter` **open in the external editor** · `Tab` insert the mention · `Esc` close |
| Changed files | `M`/`A`/`D` with stat; `Enter` opens at the first changed line | `Enter` open · `d` diff |
| Notifications and undo | right-aligned toast in the activity row's gap (`✓ build finished · 22s`); a destructive action offers `u undo · 8s` | `Ctrl+J` view · `u` undo |
| Queued messages, attachments | `queued (2)` chips above the editor; attachment chips `[Image #1 84 KB ×]` | `↑` edit · `Esc` clear · `Backspace` removes a chip |
| Rewind | checkpoint list with a restore scope `‹ conversation + code ›` | `↑↓` · `←/→` scope · `Enter` restore |
| Diff hunk review | per-hunk accept or reject on the numbered diff | `a`/`r` · `A`/`R` all · `n`/`p` hunk |
| Banners | rate limit with countdown, offline, context nearly full, low balance, resumed session | `Esc` cancel · `r` retry |
| Key help | contextual, grouped by task | `?` |
| Job output | timestamped tail with follow | `f` follow · `↑` scroll · `x` stop |
| Delete session | **plain `[ No ]  Yes`**, No focused first; no typed phrase | `←/→` or `n`/`y` · `Enter` |
| Transcript scroll and search | see below | `/` or `Ctrl+F` |

- **Opening a file** reuses the existing editor resolution
  (`mayfly.editorCommand`, then `$VISUAL`, then `$EDITOR`, `interaction/external-editor.ts`).
  GUI editors open detached with a goto argument (`file:line`); terminal editors
  suspend the screen and restore it, as raw settings edit does. The command runs
  from a fixed argument array, never a shell string, and the path must resolve
  inside the workspace. With no editor configured the row says so and points to
  `/settings`.
- **Delete session** may become a soft delete with an eight-second `u undo`
  toast, which removes even the Yes/No prompt.

**Transcript scroll and search** (scene 15). The passive transcript keeps its
single outer viewport (see the transcript ownership rules); search reads the
rendered rows in `core/`, the only owner of width and ANSI truth.

```
┌ Transcript ─────────────────────────────── L11–22 of 33 · 67% ┐
│ ● Adding the panels to the width scan spec.                   ░
│ ● Running the width scan again to confirm.                    ▪
│ » Bump the changelog too.                              ↓ 2 new · End
└────────────────────────────────────────────────────────────────┘
⌕ width▌   12/13   Aa \b   Enter next · Tab list · Esc keep matches
```

- **Scroll-away pill** at the bottom-right of the viewport: `↓ N new · End`
  while output arrives, `↓ End` otherwise. `End` jumps to the latest.
- **Scrollbar** with a thumb and one tick per match (`▪`, `◆` for the current
  one), plus the visible line range and percentage in the frame.
- **Incremental search** jumps as you type; the current match is highlighted
  distinctly from the others; `Enter` and `n`/`N` step; `Tab` toggles a match
  list to jump from; `Esc` leaves one layer at a time (typing, then list, then
  search). Folded blocks expand when a match inside them is opened.

### 8.13 Plugin marketplace

**Today.** `/plugin` opens a marketplace overlay over the index published by
`Ephemeral-AI-Lab/dsh-plugins`: installed and not-installed tabs, a
type-to-filter catalog, and a detail panel (Overview, Surfaces, Provides,
Details) whose buttons install, update, and remove. Operations shell out to
`dsh plugin --profile <name> add|remove`, report progress in the surface, and
apply after a restart; the catalog loads cache-first and serves stale data
offline. The design below keeps all of that and changes the layout, the
actions, and the states.

```
╭ Plugin marketplace ──────────────────────────────────────────────────────────────────────────────────╮
│   Installed 3   Browse 5    index updated 2h ago · 8 entries                                         │
│   ━━━━━━━━━━━                                                                                        │
│   / filter plugins…                                                                                  │
│ ▌ Loop             official   T W   1.4.0               │ Loop  official · Automation                │
│   Git Helper       community  T W   1.2.1  update 1.3.0 │ Repeat a prompt on an interval.            │
│   Legacy Search    community  T ·   0.9.4  deprecated   │                                            │
│                                                         │ Status     ✓ installed 1.4.0               │
│                                                         │ Surfaces   TUI ✓ works here                │
│                                                         │            Web ✓ works on dsh Web          │
│                                                         │ Provides   /loop · loop_start · loop_stop  │
│                                                         │ Engines    dsh ^0.2 · mayfly ^0.1          │
│                                                         │ Needs      schedule                        │
│                                                         │ Verified   2026-09-20                      │
│                                                         │ Source     npm                             │
│                                                                                                      │
│ ↑↓ move · ←/→ tab · x remove · / filter · r refresh · Esc close                                      │
╰──────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

- **Layout follows width** (§8.16): at 100 columns or more the list and a live
  detail share the surface; below that the list is one column and `Enter` opens
  the detail, `Esc` returns. The header tab strip is the §8.10 text-color
  strip, with the catalog's age (or the offline notice) at its right.
- **List columns:** name, a status word (`stable` shows nothing; `beta` is
  accent, `unstable` and `deprecated` warning, `removed` danger), the source
  (`official`, `dsh`, `community`), the surfaces `T W` (bold when the plugin
  contributes there, a dim `·` when it does not), and the version, or
  `update x.y.z` when one is available. Deprecated and removed rows dim and
  their note leads the detail.
- **Actions are keys, not buttons** (§4.1 redundancy rule, G7): `i` install,
  `u` update, `x` remove behind the shared Yes/No with No first
  (`Removal applies after restarting Mayfly.`), `s` cycle the install source
  (`npm`, `github`) when an entry offers both and is not installed, `r`
  refresh, `/` filter. The hint row lists only the keys that apply to the
  focused entry.
- **Progress** is the gap spinner (§8.5) with what and where, `Installing Git
  Helper via npm… 4s · Esc cancel`, then a success line. Installs and removals
  are single-flight, as today (`a plugin operation is already running`).
- **Restart is a persistent banner, not a toast.** Bundle membership is a
  startup boundary, so every completed change adds to `↻ N changes apply after
  you restart Mayfly and start a new session`, which stays until the restart.
- **Web-only plugins** show `TUI ✗ no contribution in this terminal`; `i` on
  one reports the existing warning instead of installing.
- **States follow §8.16:** loading (`⣾ loading catalog…`), empty
  (`No plugins installed — press → to browse`), offline with cached data
  (`⚠ offline · showing cached data from 2d ago`, content stays usable), and
  refresh in progress.
- **Seam:** the index is discovery metadata only; nothing here participates in
  runtime loading. Detail rows are derived from `MarketEntry`
  (`status`, `source`, `surfaces`, `provides`, `engines`, `capabilities`,
  `verified`), so no new index fields are required.

### 8.14 Onboarding

**Today.** A first run opens the welcome (language and theme, once, while the
shared locale preference is unset), then the connection guide when no
credential or account grant exists: step 1 chooses between signing in with a
DeepSeek account and pasting an API key, step 2 finishes in the browser or
takes the key.

The redesign keeps the order and the guarantees (every step reversible with
`Esc`, `Skip for now` never blocks) and gives the flow one visible spine, a
text-color step strip, and a summary:

```
  ✓ Language  ›  ● Connect  ›  ○ Permissions  ›  ○ Ready
                 ━━━━━━━━━
╭ Connect to DeepSeek ────────────────────────────────────────── step 2 of 4 ╮
│ Mayfly needs a DeepSeek connection to start.                               │
│                                                                            │
│ ▸ 1  Sign in with a DeepSeek account  recommended                          │
│        browser sign-in, no API key to manage                               │
│   2  Enter a DeepSeek API key                                              │
│        paste a key from platform.deepseek.com                              │
│   3  Skip for now                                                          │
│        connect later with /account or /provider                            │
│ ↑↓ or 1-3 choose · Enter continue · Esc back                               │
╰────────────────────────────────────────────────────────────────────────────╯
```

| Step | Content | Keys |
| --- | --- | --- |
| 1 Language | the existing form (language, theme), no `Continue` button, plus a one-line preview of the chosen theme's text colors | `←/→` change · `Enter` continue |
| 2 Connect | the numbered choice above; account sign-in is hidden when no web server is composed | `1`–`3` · `Enter` · `Esc` |
| 2a Browser | the account panel (§8.15) inside the guide: a breathing `●`, the expiry countdown, the link, and a collapsed `▸ Browser on another machine?` row that opens the paste-back field on `p` | `Ctrl+Y` copy · `Ctrl+R` new link · `Esc` cancel |
| 2b API key | one secret field with `Enter` to save; `Your key is stored in the system credential store, never in settings.` | `Enter` save · `Esc` back |
| 3 Permissions | **new, proposed:** the permission preset as a numbered choice (`Default` recommended); `Full access` asks the shared Yes/No | `1`–`3` · `Enter` |
| 4 Ready | a checklist of what was set (`○ DeepSeek not connected · /account to sign in` when skipped) and three things to try (`/`, `@`, `Shift+Tab`) | `Enter` start chatting |

- **No buttons in the guide.** `Continue`, `Save`, and `Back` are `Enter` and
  `Esc` (G7); the primary choice is the focused row.
- **Progressive disclosure:** the other-machine paste-back is collapsed by
  default because the common case finishes by itself on this machine.
- **The permissions step is optional to ship.** Without it the strip is three
  steps and the preset stays `Default`.
- **Resumability:** quitting mid-guide leaves the unfinished step to reappear
  on the next start, as today; finished choices persist immediately.

### 8.15 Account panel

**Today.** `DeepSeek Account` shows `Status`, the sign-in phase or outcome,
the expiry, the sign-in link, and a paste-back field; `Sign in`, `Try again`,
`Sign out` (behind a confirm), and `Close` are buttons, and a setup without the
loopback web server explains where browser sign-in can happen.

The redesign is button-free and covers every state the code distinguishes:

```
╭ DeepSeek Account ─────────────────────────────────────────── not connected ╮
│ Status        Not signed in                                                │
│ Sign-in       ● Waiting for you in the browser                             │
│ Expires       4:41                                                         │
│                                                                            │
│ Approve in the browser — on this machine sign-in finishes by itself.       │
│ Sign-in link  https://platform.deepseek.com/oauth/authorize?…              │
│ ▸ Browser on another machine?                                              │
│                                                                            │
│ Ctrl+Y copy link · Ctrl+R new link · p other machine · Esc cancel          │
╰────────────────────────────────────────────────────────────────────────────╯
```

| State | Body | Primary / keys |
| --- | --- | --- |
| signed out | `Not signed in`, one sentence on what an account gives | focused `Sign in` · `k` use an API key |
| waiting | breathing `●`, expiry, link, collapsed paste-back | `Ctrl+Y` · `Ctrl+R` · `p` · `Esc` cancel |
| expired | `⚠ The sign-in link expired — try again` | focused `Try again` |
| network error | `✗ Could not reach DeepSeek — check the connection and try again` | focused `Try again` |
| no web server | the existing explanation (stored login is shared across hosts) | focused `Use an API key instead` |
| signed in | `✓ Signed in`, `Balance`, `Models`, `Checked` | `r` refresh · `o` top up · `x` sign out |
| low balance | `⚠ ¥ 6.20 low balance · below ¥ 10.00` with the breakdown | same keys; the Status panel's Account tab shows the `!` |
| sign out | the shared Yes/No, No first: `Account models stop working until you sign in again.` | `←/→` or `n`/`y` |

- **The balance row** is the one in §8.11: loading (`⣾ checking balance…`),
  unavailable (`— unavailable (network)  r retry`), unsupported (row hidden). A
  failed check never changes the sign-in state.
- **Outcome wording** stays the existing strings, one reason per error code
  (`expired`, `network`, `storage`, generic).
- **Identity** (name or email) is not shown: the account view exposes
  `status` and the attempt, not a profile, and this design does not assume more.

### 8.16 System refinements

Rules that make the panels above, and every future one, read as one system. The
prototype's scene 19 (§8.19) draws each of them.

**Selection and focus vocabulary.** One persistent-selection mark, one
transient cursor, one focus effect:

| Mark | Meaning | Where |
| --- | --- | --- |
| `▌` + bold | persistent selection | rails, browse lists, tab rails |
| `▸` | the row `Enter` will pick | choose and decision lists, form focus, the tray |
| inverse | the control has focus | only on the selected or cursor row |
| `[x]` `[ ]` `[-]` | checked, unchecked, some children | multi lists, trees |
| `‹ v ›` | `←`/`→` changes this value | select, number, tab strip |
| `•` | edited field (implicit override) | forms |
| `[current]` | the current choice, always the muted badge | pickers (G4) |
| `— reason` | disabled, with its reason after a dash | actions, rows, options |

**One answer for five states.** Every panel, and every secondary read inside
it, renders the same patterns, so users learn them once:

| State | Pattern | Example |
| --- | --- | --- |
| loading | gap spinner, what, elapsed | `⣾ Loading sessions…` |
| empty | what is missing and the next action | `No plugins installed — press → to browse` |
| error | `✗` reason and the retry key | `✗ Could not reach the market  r retry` |
| stale or offline | `⚠` and the data's age; content stays usable | `⚠ offline · showing cached data from 2d ago` |
| unavailable | `—` and the reason, no retry | `— not supported by this provider` |

A slow or failed secondary read (balance, catalog refresh) never blocks or
alters the primary content.

**Feedback severities.** `✓` success (3 s, auto-dismiss), `ℹ` info (5 s,
auto-dismiss), `⚠` warning (stays until acted on), `✗` error (stays and offers
the retry key). Feedback is inline in the footer of an open surface and a toast
in the activity row's gap otherwise. Glyph plus word, never color alone (§3.1).

**Breakpoints.** At 100 columns or more a list-and-detail surface is a split
view; from 60 to 99 it is one column and `Enter` opens the detail; below 60 it
shows the name and one status glyph and the detail opens on `Enter`. Every
renderer ladders with `when: { minWidth, maxWidth }` and appears in the owning
width scan.

**Keyboard parity.** The same key means the same thing in every panel:

| Key | Meaning |
| --- | --- |
| `↑` `↓` | move (rows, fields) |
| `←` `→` | switch tab or column, cycle a select, step a number |
| `Enter` | the primary action of the focused row |
| `Space` | toggle |
| `/` | filter |
| `r` | refresh or retry |
| `x` | the destructive action: remove, stop, delete, sign out |
| `Esc` | back one layer |

`x` replaces `d` for deleting a session, so remove, stop, delete, and sign out
all share one key. A destructive key always opens the shared Yes/No with No
focused first.

**Confirm or undo.** Reversible local actions (delete a session, withdraw a
queued message) happen at once and offer `u undo · 8s`. Irreversible actions or
ones that reach outside the app (sign out, remove a plugin, full access, stop a
job) use the shared Yes/No. Typed confirmation phrases are never used.

**Formats.** Durations `4s`, `2m 10s`, `1h 5m`; ages `2m ago`, `3d ago`; tokens
`148k`, `~12k`, `22.9k / 128k`; money in the provider's currency with two
decimals (`¥ 128.40`); paths home-collapsed to `~` and middle-ellipsised;
counts `12 turns`, `+3 more`.

### 8.17 Transcript levels

**Today.** `mayfly.transcriptView` already has four work-details modes,
`compact`, `standard` (default), `detailed`, and `verbose` (see the Website
streaming page). The transcript speaks in the past tense and the activity row
in the present, and `Ctrl+O` opens the fold of the most recent `expandTurns`
(3) turns. In practice `standard` and `detailed` look identical once a turn
settles, and a failed or compact turn tells you little about what happened.

The design keeps the four names and the setting, and makes each level a
distinct, predictable amount of detail. The same three turns (a successful
edit-and-test turn, a failed turn, and a running turn) at each level, from the
prototype (§8.19, scene 20):

```
1 Compact  (8 rows)                       2 Standard  (21 rows, −49% vs Verbose)
» Update the landing page hero …          » Update the landing page hero copy and run the tests.
▸ Took 38s · 6 tool calls · +10 −3        ▸ Took 38s · 6 tool calls · +10 −3 · Ctrl+O expand
● Done — the hero now reads …             ✓ Edited Hero.tsx  +4 −2 ▮▮▮▮▮▮▮▮
                                              12  12 │     return (
» Now bump the changelog …                    13     │ −     <h1>Build agents faster</h1>
✗ Failed · verify:full timed out · 4m 12s         13 │ +     <h1>Ship agent UI in a keystroke</h1>
  ⎿ last step: Ran verify:full ✗ exit 124     ✓ Edited tool-line.ts  +6 −1 …
                                          ● Done — the hero now reads …
» Regenerate the screenshots …            » Now bump the changelog …
                                          ✗ Failed · verify:full timed out · 4m 12s
                                          ✓ Edited CHANGELOG.md  +3 −0 …
                                          » Regenerate the screenshots …
                                            ⎿ Ran commands
```

```
3 Detailed  (29 rows, −29%)               4 Verbose  (41 rows)
» Update the landing page hero …          » Update the landing page hero …
▾ Took 38s · 6 tool calls · +10 −3        ▾ Took 38s · 6 tool calls · +10 −3
  ✻ I will read the hero component, …       ✻ Thinking
  ⎿ Read files and searched code               I will read the hero component, unify the heading, …
✓ Edited Hero.tsx  +4 −2 …                ✓ Read Hero.tsx · 96 lines
  ⎿ Ran commands · 1 failed               ✓ Searched "heading" · 7 matches in 3 files
✓ Edited tool-line.ts  +6 −1 …            ✓ Edited Hero.tsx  +4 −2 …
  ⎿ Ran commands                          ✗ Ran pnpm run test · 12.1s · exit 1
● Done — the hero now reads …                ⎿ FAIL width-scan.spec.ts
                                             ⎿ 1 failed · 213 passed
» Regenerate the screenshots …            ✓ Edited tool-line.ts  +6 −1 …
✻ Run shots:sync first, …                 ✓ Ran pnpm run test · 11.8s
✓ Ran pnpm run shots:sync · 8.0s          ● Done — the hero now reads …
● Running pnpm run shots:check · 8s       » Regenerate the screenshots …
                                          ● Running pnpm run shots:check · 8s
                                             ⎿ checking 14 files…
```

| Level | Settled turn | Running turn | Activity row |
| --- | --- | --- | --- |
| 1 Compact | prompt (one row), header with diffstat, final answer; a failure keeps its reason line | the prompt only | header and one `⎿` detail line |
| 2 Standard | header, file-change cards (numbered diff, capped at 6 rows), final answer | settled groups as `⎿` titles and file-change cards as they land | header and `⎿` detail |
| 3 Detailed | the header is open: reasoning preview, past-tense group titles between the file-change cards, final answer | every card live, one row each | header only |
| 4 Verbose | everything open: reasoning, every call with its output tail, full diffs | every card live, with the running card's output tail | header only |

- **Detail lives in exactly one place.** Compact and Standard have no running
  cards, so the activity row carries the `⎿` detail. Detailed and Verbose show
  the running card in the transcript, so the activity row drops it (this is
  today's `liveProcessDetail` split, extended to Compact).
- **The header says what changed.** A settled turn's header carries its
  diffstat (`+10 −3`) so a folded turn still tells you whether files changed.
- **Never folded away at any level:** failures and their reason, interruptions,
  cancelled calls (`⊘`), the final answer, compaction boundaries, and
  notices. Approvals, questions, and plan review are overlays and are not part
  of this setting. From Standard up, file changes stay visible as cards.
- **Rows are the metric.** The strip shows the row count of the current level
  and its saving against Verbose, so the cost of a level is visible when you
  choose it. The prototype's sample conversation gives 8 / 21 / 29 / 41.

**Switching.**

- The setting (`/settings`) sets the default level.
- `Ctrl+O` keeps its meaning: the most recent three turns open at Verbose. It
  is the quick "show me what happened" key at every level.
- `Enter` on a turn's header opens or closes that one turn at Verbose, in place;
  the cursor is the `▌` selection mark on the turn.
- A transient `view: Detailed · 29 rows` line confirms a level change in the
  activity row's gap, and the scroll position stays anchored on the visible
  prompt instead of jumping.
- Proposed, not yet checked against the keymap: `/view <level>` and a cycle key
  such as `Alt+V`.
- Search (§8.12) opens the turn holding a match at Verbose, so a hit inside a
  fold is never invisible.

**What changes from today.**

| Level | Today | Design |
| --- | --- | --- |
| Compact | header and final answer; file changes inside the fold; no activity detail | adds the diffstat, a failure reason line, and activity detail (`liveProcessDetail: true`) |
| Standard | header, file-change cards, answer | cards use the numbered diff of §8.4; header gains the diffstat |
| Detailed | identical to Standard once settled (the fold hides the titles) | the settled turn opens to titles and a reasoning preview: `foldCompletedTurns: false` with `settledProcess: 'titles'`, a combination the capability types allow, to be verified in the renderers |
| Verbose | every card open | unchanged apart from the shared visuals |

Every row is one line that ladders to width; the user prompt at Compact ends in
`…`, diff rows end in `…`, and `NO_COLOR` keeps `▸ ▾ ✓ ✗ ●` and the `⎿` tree as
the carriers of state. Touch points are in §8.18 (R19).

### 8.18 Roadmap and touch points

| ID | Item | Touch points |
| --- | --- | --- |
| R1 | Motion and glyph system (§8.2); retire the ripple and `tide` | `transcript/spinners.ts`, `core/ui-loader-animation.ts`, `core/ui-patterns.ts` |
| R2 | Activity pane detail lines, gap, `Working` label (§8.3) | `transcript/pane-activity.ts`, `conversation/activity-detail.ts`, `transcript/process-activity.ts`, `transcript/locale.ts` |
| R3 | Edit diff with line numbers; Write as one line (§8.4) | `core/diff-align.ts`, `core/plugin-view.ts`, `transcript/tool-line.ts`, `transcript/process-rows.ts` |
| R4 | Loader variants and determinate bar (§8.5) | `core/ui-patterns.ts`, `packages/ui/src/contracts.ts` |
| R5 | Compaction bar and settled rule (§8.6) | `transcript/compaction.ts`, `conversation/facts.ts` |
| R6 | Todo and goal rule progress (§8.7) | `transcript/pane-todo.ts`, `transcript/status-goal.ts` |
| R7 | Agents and jobs tray (§8.8) | `transcript/pane-agents.ts`, `transcript/status-jobs.ts`, `interaction/agents-command.ts`, `interaction/jobs.ts` |
| R8 | Decision skeleton and question wizard (§8.9) | `interaction/approval-plugin.ts`, `interaction/questionnaire.ts`, `core/ui-key-grammar.ts` |
| R9 | Text-color tabs, live-following rail, expandable lists, form refinements (§8.10) | `core/ui-patterns.ts`, `core/ui-compiler.ts`, `core/theme-palette.ts` |
| R10 | Sessions, settings, and status panels; account balance (§8.11) | `interaction/session-list-model.ts`, `interaction/session-workspace-panel.ts`, `interaction/settings.ts`, `interaction/usage.ts` |
| R11 | Interaction scenarios (§8.12) | `interaction/external-editor.ts`, `core/ui-key-grammar.ts` |
| R12 | Transcript scroll pill, scrollbar, and search (§8.12) | `core/` (transcript viewport), `transcript/transcript-model.ts` |
| R13 | Contrast and one-motion-channel guard specs (§7 D1, D3) | `packages/mayfly/tests/core/` |
| R14 | Website key and status-bar pages follow §8.1 | `website/**` (needs the Website acceptance path) |
| R15 | Plugin marketplace: split view, key-driven actions, restart banner (§8.13) | `interaction/plugin-commands.ts`, `interaction/plugin-market/` |
| R16 | Onboarding: step strip, button-free steps, optional permissions step (§8.14) | `interaction/welcome.ts`, `interaction/provider-onboarding.ts` |
| R17 | Account panel: button-free states, balance row (§8.15) | `interaction/provider-account.ts` |
| R18 | System rules: selection vocabulary, state patterns, breakpoints, key parity, `x` for delete (§8.16) | `core/ui-key-grammar.ts`, `core/ui-patterns.ts`, `interaction/session-workspace-panel.ts`, width scans |
| R19 | Four transcript levels: distinct settled views, diffstat header, failure reason, one-place detail (§8.17) | `transcript/presentation-policy.ts`, `transcript/process-groups.ts`, `transcript/process-rows.ts`, `transcript/transcript-model.ts`, `interaction/settings-model.ts`, `website/**/features/streaming.md` |

Verification for any of these follows the root gate: width scans for every new
row renderer, the owning suite for lifecycle changes, `pnpm run verify:full`,
and a dedicated-profile install with PTY smoke and human acceptance.

**Open questions.** (1) Whether the balance query is reachable through the
native provider services or needs a new read-only service. (2) Whether
`↓`-on-an-empty-prompt conflicts with prompt-history navigation in the editor
key handling. (3) The keys `Ctrl+F` (search) and `Ctrl+J` (view notification)
are proposals until checked against the keymap. (4) Where search matches are
computed for folded blocks. (5) Whether the optional onboarding permissions step is
wanted, since it adds a step to every first run. (6) Whether the account view
should ever expose an identity beyond `status`.

### 8.19 Prototype

[`prototypes/ui-preview.mjs`](./prototypes/ui-preview.mjs) draws every design in
this section in a terminal (20 scenes). It is a standalone Node script with no
dependencies; it draws its own colors and does not use the Mayfly renderer, so
it shows intent, not shipped rendering.

```
node docs/design/prototypes/ui-preview.mjs [scene-number]
```

`]` / `[` (or `Tab`) move between scenes and `q` quits; each scene lists its own
keys in its footer. While a text field has focus the scene keeps every key and
`Esc` stops typing.

| # | Scene | Section |
| --- | --- | --- |
| 1 | Activity states | §8.2, §8.3 |
| 2 | Loader | §8.5 |
| 3 | Tools | §8.4 |
| 4 | Edit and Write | §8.4 |
| 5 | Tray | §8.8 |
| 6 | Todo and goal | §8.7 |
| 7 | Approval and plan | §8.9 |
| 8 | Questions | §8.9 |
| 9 | Compaction | §8.6 |
| 10 | Tabs | §8.10 |
| 11 | Expandable lists | §8.10 |
| 12 | Forms | §8.10 |
| 13 | Panels (sessions, settings, status) | §8.11 |
| 14 | Scenarios | §8.12 |
| 15 | Transcript scroll and search | §8.12 |
| 16 | Plugin marketplace | §8.13 |
| 17 | Onboarding | §8.14 |
| 18 | Account panel | §8.15 |
| 19 | System reference (selection, states, feedback, breakpoints, keys, policies) | §8.16 |
| 20 | Transcript levels (four levels of one conversation) | §8.17 |
