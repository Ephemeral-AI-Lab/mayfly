# Key bindings

Keys register through the `mayflyKeymap` service; duplicate bindings are rejected. The `/help` overlay lists every registered binding live, followed by the shared panel keys below — it is the authoritative source for this page (if anything differs, trust `/help`).

## Global actions

In effect unless a capturing panel (a picker, form, or approval in the editor slot) owns input. The read-only subagent transcript is a view, not a capturing panel, so these keys keep working over it:

| Key | Action | Description |
| --- | --- | --- |
| `Ctrl-O` | Toggle tool output expansion | Switch the most recent **3 turns** of tool cards and thinking blocks between one-line summary and full output |
| `Ctrl-T` | Toggle todo pane folding | Five-row folded view ↔ full list |
| `F6` / `Shift+F6` | Move surface focus | Traverse the Editor and pane lanes in layout order; crossing an end returns to the Editor |
| `F7` | Toggle primary/auxiliary | Switch the complete UI between main and the retained BTW/subagent conversation; show a notice when no auxiliary exists |
| `F8` | Close auxiliary | Detach a subagent or dispose the temporary BTW Agent, returning to main |

## Shared panel keys

Every panel, picker, and form follows one key grammar. The hint row at the bottom of a focused panel is generated from that same grammar, so it only shows keys that do something in the current state (up to three hints below 80 columns, four from 80, always including Esc when Esc does something):

<!-- BEGIN shared-keys (checked against SHARED_KEY_REFERENCE in packages/mayfly/src/core/ui-key-grammar.ts) -->
| Key | Action |
| --- | --- |
| `↑/↓` | Move between rows and fields; scroll documents |
| `←/→` | Cycle a select value, adjust a row setting, open or close a tree branch, or move along a tab strip |
| `Alt+←/→` | Switch tabs from anywhere on the surface; wizards validate the step being left |
| `PgUp/PgDn, Home/End` | Page or jump in lists and documents |
| `Enter` | Choose, run, open a picker, apply it, or start editing a field |
| `Space` | Toggle a checkbox or multi-select row, open a multiselect, or fold a tree branch |
| `Tab/Shift+Tab` | Move to the next or previous control group, committing text and pickers |
| `Esc` | Leave the innermost layer: picker, editing, search, back, then close |
| `Ctrl+C` | Close the surface, asking first when there are unsaved changes |
| `Type or /` | Filter a filterable list; Ctrl+U clears the filter |
| `1-9` | Pick a numbered row |
| `Ctrl+E` | Expand focused scrollable content to full screen |
| `Alt+Enter` | Insert a newline in a multi-line field |
<!-- END shared-keys -->

Details that follow from the grammar:

- **Esc** leaves one layer per press, the same way everywhere: an open picker is cancelled, then text editing ends (the draft stays), then an active search ends (the filter stays), then a page with a Back target goes back, and only then does the panel close. Tab strips are not a stop on the way out.
- **Disabled rows and options** never take the cursor; movement steps over them. A row or action that is unavailable says why next to its label.
- **Select fields** change with `←`/`→` and never with `↑`/`↓`, which always move to the next field. `Enter` opens the option list; `Tab` applies the highlighted option and moves on.
- **Filtering** starts on the first typed character or `/`. Modifier shortcuts such as `Alt+Enter` or `Ctrl+R` keep working while a filter is active; in multi-select lists `Space` still toggles.
- **Numbered rows** keep their numbers while the list scrolls. In gates such as plan review a digit only moves the cursor; `Enter` confirms.
- **Confirmations** are one shared Yes/No decision with No focused first; the question may carry a sentence about consequences.

## Editor context

Text-editing keys (cursor movement, multi-line, undo, kill-ring) belong to the underlying editor; in addition:

| Key | Action | Description |
| --- | --- | --- |
| `Escape` | Interrupt the flow / clear the draft | While a session flow is in progress (the selected Agent or a live descendant runs), interrupt it: safe retraction of the just-submitted message first when the buffer is empty and eligible, restoring it into the editor, with the draft preserved; idle, it clears the draft, which stays one `↑` away in history; an open completion popup only closes |
| `Ctrl-C` | Clear draft → interrupt → exit | With a draft it only empties the box (the draft stays one `↑` away) and the flow continues; with an empty buffer while a session flow is in progress it interrupts the selected Agent and all running continuable descendants; when the whole tree is idle and the buffer is empty, a **second press within 1 second** exits Mayfly |
| `Ctrl-S` | Steer | Inject the non-empty draft as a steering instruction into the current turn, clearing the buffer |
| `Ctrl-V` | Paste image | Store the clipboard image in the attachment library, inserting an `[image #N]` marker at the cursor |
| `Ctrl-G` | External editor | Hand the draft to an external editor for full-screen editing (`mayfly.editorCommand` setting → `$VISUAL` → `$EDITOR`; Mayfly suspends and yields the terminal); quitting with `:cq` leaves the draft untouched |
| `Alt+M` | Cycle session model | Step through the current provider's models (**session-only**, no persisted default; the press is consumed, the draft stays intact) |
| `Backspace` | Delete / exit mode | Backspace on an empty `!` bash prompt exits back to prompt mode |
| `Shift+Tab` | Toggle plan state | normal ↔ plan, preserving permissions and YOLO (see [Session modes](/en/features/modes)) |

These keys reach the editor even while a notice is shown under the prompt. Editor extensions may add actions only on modifier keys (such as `Alt+R`); the editor keeps `Esc`, `Tab`, `Shift+Tab`, and every unmodified key.

## Panel contexts

| Surface | Keys |
| --- | --- |
| `/help` overlay | ↑↓ / PageUp / PageDown / Home / End scroll; `Ctrl+E` expands; `Tab` reaches Close; `Escape` closes |
| `/sessions` picker | Type to filter; ↑↓ moves, `Space` or `←` / `→` folds branches, `Enter` resumes; `Esc` first ends the filter (the query stays, `Ctrl+U` clears it), then closes |
| Approval panel | The focused default is **Reject**; `←` / `→` or `Tab` reach Allow once, Allow for this session, and Reject with feedback; `Enter` runs; `Escape` rejects. On the feedback page, `Enter` sends, `Alt+Enter` adds a line, `Esc` ends editing and then returns to the decisions. There are no digit shortcuts |
| Questionnaire | `1`–`9` or ↑↓ + `Enter` choose and advance; multi-choice toggles with `Space` and confirms with `Enter`; typing in Other starts an answer, `Enter` submits it, `Alt+Enter` adds a line; the question tabs switch with `←` / `→` on the strip or `Alt+←` / `Alt+→` anywhere, and moving forward validates the current question |
| Form panel | ↑↓ move between fields; typing or `Enter` starts editing text, `Enter` confirms and moves on, `Alt+Enter` inserts a textarea newline; a select changes with `←` / `→` or opens with `Enter`; a multiselect opens with `Enter` or `Space`; `Tab` commits and moves to the next group; `Escape` ends editing, then closes (asking first when there are unsaved changes) |
| Plan review | ↑↓ or `1`–`3` move between decisions and `Enter` confirms the focused one; `c` copies the plan, `o` opens feedback; `PageUp` / `PageDown` / `Shift+↑↓` scroll the plan |
| `/model` panel | One list grouped by provider: type to filter, ↑↓ selects a model, `←` / `→` adjusts its thinking level; `Enter` sets the default, `Alt+Enter` uses it for this session only (also while filtering) |
| `/effort` panel | `1`–`9` or ↑↓ + `Enter` set the default thinking level; `Alt+Enter` applies the focused level to this session only |
| `/permission` picker | `1`–`9` or ↑↓ + `Enter` switch presets; full access first asks a Yes/No decision with No focused |
| `/agents` browser | Type to filter; ↑↓ selects, `Space` or `←` / `→` expands/collapses, `Enter` views; `Tab` reaches **Stop selected**, which asks first and names why it cannot run for a one-shot, cold, or parent-of-live row |
| `/plugin` marketplace | Installed / Not installed tabs (`←` / `→` on the strip or `Alt+←` / `Alt+→`); type to filter; `Tab` reaches Details, Install or Update/repair, and Remove, each available per row; `Ctrl+R` refreshes |
| Readonly subagent transcript | ↑↓ / `PageUp` / `PageDown` / `Home` / `End` scroll; `Escape` closes; `F7` switches back, `F8` closes; `i` replies to a continuable child |
| Live BTW/subagent | Uses the complete main editor and the same panel keys; `F7` returns to main and `F8` closes the auxiliary slot |

## Custom bindings

Deferred to a later phase. There is no user-facing key configuration today; conflicts are prevented by rejecting duplicate registrations at keymap registration time. Panel accelerators declared by plugins must be valid key ids, cannot take shared navigation keys, cannot repeat on one page, and cannot be plain characters on a panel with a filterable list.
