# Mayfly interaction model

This document defines how panes, overlays, and editor extensions take input,
hold focus, and report user intent. It describes the current implementation;
the public types in `packages/ui/src/contracts.ts` and the tests under
`packages/mayfly/tests/core/` are the executable authority.

## Layers

| Layer | Owner | Holds |
| --- | --- | --- |
| Wire contract | `@ephemeral-ai/mayfly-ui` | Readonly `MayflyUiNode` trees, action items, confirmations, and structured event/reply types |
| Interaction state | frontend `mayflyUiInteraction` (`core/ui-interaction-*.ts`) | Per-registration `UiSurfaceModel`: form drafts, choice state, tabs, page path, open decision, operations, and feedback |
| Key grammar | `core/ui-key-grammar.ts` | One ordered binding list per focus state: key match → intent → optional hint |
| Compiler | `core/ui-compiler.ts` | Focus geometry, control groups, rendering, and dispatch of grammar intents onto the model |
| Host routing | `core/screen.ts`, `core/index.ts` | Which surface receives a key, global keymap actions, and the prompt editor |

Plugins publish nodes and answer structured actions. They never see focus,
keys, or renderer objects, and a core/theme reload re-projects the same
interaction state.

## Routing

1. A capturing overlay (picker, form, approval, or other editor-slot surface)
   receives keys before the global keymap. Every conversation, including a
   readonly or stored child, renders in the transcript pane with the ordinary
   editor below it, so global actions such as `F7`/`F8` keep working.
2. A focused pane receives keys after `F6` moves focus to it; Escape in a pane
   releases focus back to the editor (`leave`).
3. In an editor shell (`presentation: 'editor'` decorations such as footer
   notices, slash hints, and editor extensions) the host editor owns every key
   except declared modifier accelerators. The shell never roves focus, never
   takes `Esc`, `Tab`, or `Shift+Tab`, and the validator rejects nodes that
   would take focus from the editor (forms, lists, tabs, loader cancel) and
   decoration actions without a modifier key. The editor extension runtime also
   drops accelerators already claimed by the keymap, with a notice.
4. Inside a surface, `Ctrl+C` requests the same close as the outermost Escape.

## Key grammar

`keyGrammar(state)` returns the ordered bindings for one `GrammarState`: the
surface mode, the focused control kind, list search state, numbering, declared
accelerators, tabs, control-group count, and the current Escape step. The first
binding whose matcher accepts an input handles it, and `grammarHints()` takes
the first hint of each id from the same list. A hint therefore cannot advertise
a key that dispatch routes elsewhere.

Binding order within a state is:

1. Expanded view (`Ctrl+E`): collapse, scroll, swallow everything else.
2. Escape step, then `Ctrl+C` close when the surface is closable.
3. Text editing or an open picker: their own bindings, then stop.
4. Search control (`Ctrl+U` clear, `/` start), expand, declared accelerators,
   digits for numbered rows, tab switches (`Alt+←/→`), and group moves
   (`Tab`/`Shift+Tab`).
5. The focused control's own keys, then a final swallow.

`SHARED_KEY_REFERENCE` in the same module is the reader-facing summary. `/help`
renders it, and `tests/core/key-grammar-docs.spec.ts` checks the shared-keys
block of both Website key references against it.

## Control behavior

- **Rows.** `↑`/`↓`, `PgUp`/`PgDn`, and `Home`/`End` move within the list.
  `←`/`→` adjust a row segment, open or close a tree branch, or otherwise leave
  the list for the nearest control beside it. `Enter` chooses (or opens for
  `role: 'browse'`); in multi-select lists `Space` toggles and `Enter` commits.
- **Text fields.** Typing or `Enter` starts editing; while editing, `Enter`
  confirms and moves on (or submits when the form declares `enterSubmits`),
  and `Alt+Enter` inserts a textarea newline. `Tab` takes the first completion
  the typed text starts, while the field has `suggestions` and one matches. A
  number field steps with `←`/`→` within `min` and `max`. `Ctrl+S` submits the
  surface's form from any field.
- **Select fields.** `↑`/`↓` always move between fields. `←`/`→` cycle the value
  without wrapping and skip disabled options; from an unset value `→` picks the
  first enabled option and `←` the last. `Enter` opens the option list. A
  multiselect opens with `Enter` or `Space` and never implicitly. A focused
  select that can cycle renders its value as `‹ value ›`.
- **Field reset.** Fields with an `origin` show `(inherited)` or `(override)` after the value;
  editing an inherited value overrides it. `Delete` on a focused, non-editing
  field whose value is changed or overriding returns it to `resetValue` (the
  inherited value when the field has an origin). The binding and its hint exist
  only while a reset would change something and no declared accelerator owns
  `Delete`. Forms render no inline override or reset buttons; the only inline
  field choices are **Use current value** / **Keep my changes** on a conflict.
- **Pickers.** Arrows move the candidate, `Space` toggles in a multiselect,
  `Enter` applies, and `Tab`/`Shift+Tab` apply the candidate (or toggled set)
  before moving to the next group.
- **Tabs.** `←`/`→` move along a focused tab strip; `Alt+←/→` switch tabs from
  anywhere. A wizard runs the same step validation on a forward tab switch as
  on its Next action.
- **Actions.** `Enter` or `Space` runs the focused action; arrows move between
  actions. Declared accelerators run their action directly.

## Escape ladder

Each Escape press leaves exactly one layer, and the hint row always names the
step it will take:

| Step | Hint | Effect |
| --- | --- | --- |
| `collapse` | collapse | Leave the `Ctrl+E` expanded view |
| `cancel` | cancel | Discard an open picker and stay on the field |
| `done` | done | End text editing, keeping the draft |
| `end-search` | end search | End an active search, keeping the filter |
| `back` | back | Return to the page's `backId` target |
| `close` | close | Request close of a capturing overlay |
| `leave` | leave | Release pane focus to the editor |

Tab strips are not a stop on the ladder. Close goes through
`UiSurfaceModel.requestClose()`: an open decision answers No, a dirty surface
asks "Discard unsaved changes?" unless its definition declares
`dismissal: 'discard'`, and otherwise the surface closes.

## Focus invariants

- Choice reducers (`core/ui-interaction-choice.ts`) only focus enabled rows:
  movement, edges, query changes, creation, and reconciliation step over
  disabled rows, and a list with no enabled row has no focus. `Enter` can
  therefore never accept a disabled row.
- The compiler places the list cursor on the choice model's focused row, so
  the model and the painted cursor agree.
- A focused action that becomes busy keeps its focus highlight.

## Search

A filterable list starts searching on the first printable character or `/`;
`Backspace` on an idle list does nothing. While searching, typed text and
`Backspace` edit the query, `Ctrl+U` clears it, and Escape ends the search with
the filter kept. Modifier accelerators (for example `Alt+Enter` or `Ctrl+R`)
still fire while searching, and `Space` still toggles in multi-select lists.
The validator rejects printable accelerators on any page with a filterable
list, so typed text always reaches the filter.

## Numbered rows

`numbered: true` maps `1`–`9` to the visible (filtered) rows; the labels stay
stable while the list scrolls. A digit chooses the row. `numbered: 'focus'`
only moves the cursor, so a gate that opens unprompted and is not an overlay with an
arm delay still requires `Enter`. The decision card (approval, plan review) uses
`numbered: true`: a digit chooses at once, and the overlay ignores every key but
`Esc` for 300 ms after it opens (`armMs`), so a stray key grants nothing. The
hint shows the real range (`1`, `1-3`, …) and is omitted while searching.

### Decision card

The approval and plan review cards (`components/decision-card.ts`) sit in the editor's place. A digit or `Enter`
on the focused row chooses it. A note under the choices (`Feedback:` or `Revise:`) is edited with `↓` from the
last choice; its `Enter` settles the card: an approval rejects with the note, a plan sends it as the revision. `Esc`
rejects (a plan declines, with no note). `Ctrl+G` opens the request in `$EDITOR`, and a plan's `c` copies it. For
300 ms after the card takes focus (`armMs`), every key but `Esc` is swallowed.

## Stream selection and search

`Alt+↑` (or `F4`) with an empty prompt moves focus to the newest row of the conversation stream, and `Alt+↓`
or `Esc` returns to the prompt. On a row, `Enter` opens or folds it, `c` copies its text, `Ctrl+C` copies its raw
JSON, and `Ctrl+G` opens it in `$EDITOR`. In conversation mode `/` searches toward the newer rows and `?` toward the
older ones, as a regular expression with smart case, in a line above the editor. `Enter` selects the first match
from the cursor, `↑`/`↓` and `n`/`N` walk every occurrence, and `Esc` ends the search (a second `Esc` returns to the
prompt).

## Hints

The hint row shows up to three fragments below 80 columns and four from 80.
Escape has the highest priority and is always shown when Escape does
something; then the primary operation, declared accelerators, adjustment,
navigation, digit ranges, secondary keys, and group moves. Labels are translated through the
core `core-context-hints` catalog.

## Contract rules

- `action.confirm` is a string title or a `MayflyConfirmation`
  (`title`, `detail`, `confirmLabel`, `cancelLabel`, `tone: 'danger'`). Every
  confirmation renders as the shared decision with `[No] [Yes]` order and No
  focused first.
- A list item's `unavailableActions` maps action ids to reasons. When that row
  is the selection an action targets, the action renders disabled with the
  reason, and invoking it reports the reason instead of running. A list item's
  own `confirm` asks before its selection is accepted.
- A disabled action shows its `disabledReason` after the label, and a disabled
  row shows it as the row detail.
- A form with several fields renders one primary submit labelled
  `submitLabel` (the localized "Save" by default), never the action id; a
  single-field form draws none and submits on `Enter`. `cancelActionId` is
  never drawn: the outermost `Escape` runs it. A loader's `cancelLabel` words
  its `Esc` hint. Number fields render their `unit`.
- Action `key` must be a key id, cannot be a reserved navigation key (`enter`,
  `escape`, `tab`, `shift+tab`, `space`, `backspace`, arrows, `pageup`,
  `pagedown`, `home`, `end`, `alt+left`, `alt+right`, `ctrl+c`, `ctrl+e`,
  `ctrl+u`), and cannot repeat on one page.
- Submitting a form retires validation and read operations still pending for
  that form, so a late reply cannot overwrite the submitted result.

## Consumer rules

- Use `confirm` for every Yes/No question; do not draw a custom confirm page.
- Express per-row availability with `unavailableActions` or `disabledReason`
  rather than rejecting in the handler after the user has confirmed.
- Hotkey writes capture the exact current Agent at invocation and recheck it
  after every await before writing.
- Session-scoped state (such as approval allowances) lives per Agent until
  `agent/disposed`, not per displayed view.
- Clearing a non-empty prompt draft with Escape or `Ctrl+C` stores it in
  history so one `↑` restores it.

## Interrupt scope

`Esc`, or `Ctrl+C` on an empty prompt, interrupts **the current turn of the
Agent whose conversation is displayed, and nothing else** (owner decision,
Phase 4 round 3; `app/agent-interrupt.ts`). A change that also touches
interruption (for example one that stops interrupting subagents) merges toward
this contract.

- **Subagents are not interrupted.** Running children of the displayed Agent
  keep their turns and Activations. A displayed *continuable* child is itself
  "the Agent whose conversation is displayed": interrupting there stops that
  child's turn through its parent's authority (`interruptByParent`), never its
  siblings or parent.
- **Everything else is untouched:** background jobs, the goal and its
  continuation, plan mode and todos, pending decision cards, and the Agent's
  Activation.
- **Queued and steering messages are kept** (`agent.cancel({ kind: 'user' },
  { keepInbox: true })`) and are sent now: Harness's driver starts the next turn
  from the pending inbox as soon as the aborted turn has settled (the
  `turn()` loop in `dsh-agent-loop` continues while the inbox has pending
  input). Nothing the user queued is discarded by an interrupt; the user
  cancels a message with `d` on its row of the stream.
- **A flow in progress** (the test that makes `Esc` interrupt instead of
  clearing the draft, and that holds the `■ interrupting…` latch open) is the
  displayed Agent running, not a descendant. With only a subagent running,
  `Esc` behaves as at rest.

Surfaces: `interruptAgent` and `isAgentRunning` in `app/agent-interrupt.ts`
(the former tree walk and `hasRunningAgentWork` are gone), the `interrupt` and
`sessionFlowInProgress` functions of `interaction/input-plugin.ts`, the
retraction callback and the `agent/status` stop latch in `app/index.ts`.

Known limits, to check against a live model: a *foreground* subagent call is
part of the parent's turn, so aborting that turn aborts the call as Harness
defines it; Mayfly adds no cancellation of its own to any child. The behavior
was verified against the Harness source and the unit specs, not yet with a
running model.
