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
   receives keys before the global keymap. The readonly child transcript is a
   view in the `conversation` layer, not a capturing overlay, so global actions
   such as `F7`/`F8` keep working over it.
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
  and `Alt+Enter` inserts a textarea newline.
- **Select fields.** `↑`/`↓` always move between fields. `←`/`→` cycle the value
  without wrapping and skip disabled options; from an unset value `→` picks the
  first enabled option and `←` the last. `Enter` opens the option list. A
  multiselect opens with `Enter` or `Space` and never implicitly.
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
only moves the cursor, so gates such as plan review still require `Enter`. The
hint shows the real range (`1`, `1-3`, …) and is omitted while searching.

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
- Forms render `submitLabel`/`cancelLabel` (defaulting to the localized
  "Submit"/"Cancel"), never the action id; a loader's cancel button uses
  `cancelLabel`. Number fields render their `unit`.
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
