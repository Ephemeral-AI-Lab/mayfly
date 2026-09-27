# Mayfly terminal UX optimization design: aligning every surface under the unified interaction model

> Superseded by [docs/interaction-model.md](../interaction-model.md); historical.
> This record does not describe current behavior.

- Status: historical — contract increments M1–M6 and the §7 command changes
  shipped (feat/ux-interaction, merged `a1ca2d5`); M7 later shipped as a
  validation rule (printable accelerators are rejected on pages with a
  filterable list), and the key grammar was replaced by
  `docs/interaction-model.md`. Sections that describe "current" behavior were
  written against baseline `867082e`; the Implementation status notes call
  out what has since landed.
- Baseline: `867082e` (main at design time)
- Scope: all implemented surfaces, commands, editor state, and key routing
- Related documents: `ui-ux-unification.md` (shared interaction contract),
  `pr15-interaction-refactor-plan.md` (refactor design record),
  `packages/mayfly/AGENTS.md`, `packages/ui/AGENTS.md`

## 0. Summary

The unified interaction architecture is complete (Steps 1–20): every overlay
goes through `UiSurfaceModel` + compiler key dispatch, and no private
controllers remain. At the baseline this document listed five
**experience-layer** problem categories — all since addressed by the shipped
implementation:

1. **Missing direct-access keys** — resolved by M1 `numbered` lists on
   provider kind, effort, plan, and questionnaire surfaces (approval
   deliberately keeps an actions row; see §12).
2. **Nested popups** — resolved: `/model` commits from one picker with inline
   effort and the second-level options overlay is deleted.
3. **Implicit flows** — resolved: provider add runs an ordered wizard with
   inline model discovery, and disabled actions carry `disabledReason`.
4. **Poor discoverability** — resolved: a focused select row renders the
   `‹ ›` cycle hint (M3) and segments show the effort hint.
5. **Input-state conflicts** — resolved: the bare-letter `i/u/r`/`q` bindings
   were removed from filterable surfaces; M7's registration-time warning is
   the remaining enforcement.

This document first pins down the "facts of the current state" (§1–2), then
gives the global key grammar (§3), the control spec (§4), the lifecycle spec
(§5), the full editor state map (§6), a per-command inventory (§7), and
finally the contract-delta list (§10) and migration priorities (§11). Every
recommendation is tagged with implementation cost: *[supported]* /
*[compiler]* / *[contract]* / *[projection]* / *[native]*.

## 1. The existing unified interaction architecture (facts)

### 1.1 Layers

```
native dsh ──────────────── domain facts and writes (Agent/Session/Settings/Credentials/Jobs…)
   ↑ readonly snapshots + structured writes
interaction/ ────────────── command handlers → wire nodes (packages/ui contract, no render objects)
   ↑ MayflyUiEvent (observation=fact / action=structured submit)
core/ui-interaction-* ───── shared state: Form/Choice/Document/Tree/Notification + SurfaceModel
   ↑ UiSurfaceModel.invoke: confirm→decision, validate→handler→reply(accepted/invalid/
     conflict/failed/completed/cancelled)→publish→settle
core/ui-compiler.ts ─────── wire→control compilation, focus/grouping, key dispatch (single priority chain)
   ↓
core/ui-patterns.ts ─────── render primitives (renderList/renderForm/renderActions/renderTabs…)
```

Key points:

- **Keys are dispatched in exactly one place** (`handleInput` in
  `ui-compiler.ts`), with a fixed priority — see §1.3.
- **Overlays are declarative**:
  `{ presentation: 'editor' | 'overlay', dismissal: 'confirm-dirty' | 'discard', capturing, scope }`;
  `presentation: 'editor'` overlays replace the editor dock (listSessions,
  agents, marketplace, etc. all do this).
- **Confirmation is a shared decision node**: when an action declares
  `confirm`, invoke first renders `{ danger title, [No]*, [Yes] }` replacing
  the whole surface with No focused by default; the handler runs only after
  return.
- **All async is fenced**: source `{ resourceId, revision }` + AbortSignal +
  exact Agent; late snapshots/replies are rejected.

### 1.2 Shared state model

| State | Carrier | Survives reload |
| --- | --- | --- |
| Form drafts | `UiFormState` (field values, dirty, errors) | yes (held by frontend; survives core rebuild) |
| List focus/selection/query/expansion | `UiChoiceState` (focusedIndex, selectedIds, query, matches, expandedIds, searchAnchor) | yes |
| Document scroll | `UiDocumentState` | yes |
| Confirmation decisions | `decision` (surface-level, one at a time) | with the surface |
| Editor draft/history | `draft-stash` | across theme/core reloads |

### 1.3 Key-dispatch priority (compiler fact)

`handleInput`'s decision order — higher priority consumes first (updated to
the shipped order, which now includes the Ctrl+E, numbered, and Alt+←→
branches added by M1/M6):

```
0. Ctrl+E-expanded scroll view owns the whole frame: Ctrl+E/Esc collapse,
   scroll keys move the shared viewport, every other key is swallowed;
   Ctrl+E on a focused scroll control expands it
1. Focused control belongs to a filterable list:
     searching:  Esc→exit search  Ctrl+U→clear  printable→into query (except Enter)
     !searching: '/'→enter search   declared shortcut/numbered/reserved action→first
                 other printable→type-to-filter
2. Esc chain: select picker cancel → wizard back() → dismissal='discard' passthrough
          → with tabs, jump back to parent tab group → onUnhandledEscape (close overlay/interrupt)
3. Numbered list: `1-9` moves to and emits the Nth visible row (only when !searching)
4. Alt+←→ → switch the enclosing/remembered tab group from any content control
   (not while a text/select is being edited)
5. Declared shortcuts (keyed accelerators): only when !searching && !editor &&
   no text/select editing in progress
6. Empty list + Enter → selection-accept
7. Tab/Shift+Tab → first commit in-progress text/select editing, then moveGroup(±1)
                   (when the surface has exactly one editor, Tab passes through to the editor=completion)
8. editor control → editor.handleInput (completion/history/rewrite belong to pi-tui)
9. text field editing → editor; Enter=commit single line and move out / textarea newline; Alt+Enter=newline
10. select not editing + arrow keys → instant cycle (begin+move+select+finish in one step)
11. select editing → picker (↑↓ move, Space checks multiselect, Enter accepts and exits)
12. scroll control → ↑↓/PgUp/PgDn/Home/End
13. tab control → ←→ switch tabs (emits tab-change observation); Enter → jump to next control group
14. list row → Space=tree expand/collapse; ↑↓/PgUp/PgDn/Home/End=move; ←→=segment adjust
15. arrow keys → move within the same-axis group, else the geometrically nearest control
16. text field not editing → Enter or printable → enter editing
17. select not editing → Enter → enter picker
18. field-action → Enter/Space → emit form intent
19. toggle → Enter/Space → flip
20. submit → Enter/Space → invoke (confirm/validate/handler chain)
21. event control → Enter/Space → emit activate event
```

Three corollaries:

- **Bare-letter shortcuts are dead while searching** (search wins); **when not
  searching they beat type-to-filter** — so binding a letter shortcut on a
  filterable list swallows that letter's first character (the root cause of
  the M2 problem).
- **Esc always closes the innermost first** (picker → wizard → tab →
  surface); it never blows up the whole stack at once.
- **Arrow keys have geometric fallback navigation**: pressing ↑ while focus is
  on the actions row returns to the list above.

### 1.4 Overlay lifecycle

| Property | Semantics |
| --- | --- |
| `presentation: 'editor'` | Replaces the editor dock (the default shape for picker UIs); exclusively owns keys while capturing |
| `presentation: 'overlay'` | A floating overlay (decision, confirm, etc.) |
| `dismissal: 'confirm-dirty'` | When the form is dirty, Esc pops the shared decision ("Discard unsaved changes?") |
| `dismissal: 'discard'` | Esc closes directly (readonly browsers) |
| `reopen: 'focus'/'replace'` | Whether reopening the same id focuses or replaces |
| `scope` | `app` / `session:{id}` / `panel`; session scope lapses with the exact Agent identity |

## 2. Kimi Code interaction conventions → Mayfly adaptation

| Kimi convention | Mayfly status | Adaptation |
| --- | --- | --- |
| Numbered direct access (1./2./3. pick an action) | **implemented** (M1): `MayflyListNode.numbered`; the compiler maps `1-9` to row selection | keep |
| `!` prefix enters bash | implemented (editor-plus, including empty-bash Backspace/Esc to exit) | keep |
| `@` file mention / `#` skill | implemented | keep |
| Argument ghost hints `/cmd [args]` | implemented (`input.hint` → ghost) | keep |
| Tab/Shift+Tab move between groups | implemented (moveGroup) | keep |
| Esc steps out level by level (completion→edit→search→wizard→surface) | implemented | keep |
| Enter=confirm / Alt+Enter=newline or secondary action | **implemented** (M2): `Alt+Enter` is the alternate submit (/model session-only) | keep |
| Search: type to filter | implemented (type-to-filter + `/` explicit search + Ctrl+U clear + Esc exit) | keep |
| Dangerous actions confirm twice, safe option focused by default | implemented (shared decision, No focused by default) | keep |
| Double Ctrl+C to quit | implemented (2s window + hint) | keep |
| Minimal status bar, single-line actions row | implemented | keep |
| Long content expands in place | **implemented** (M6): `Ctrl+E` promotes the focused scrollable content into a fullscreen readonly viewer | keep |

## 3. Global key grammar

### 3.1 Canonical key table (shared by all surfaces)

| Key | Semantics | Owning layer | Side-effect range |
| --- | --- | --- | --- |
| ↑↓ | Move in group / scroll / picker options | compiler | view |
| ←→ | Tab switch (when the strip is focused) / list segment / select instant cycle | compiler | view/draft |
| Alt+←→ | Global tab switch (available in the content area, not while editing) | compiler | view |
| PgUp/PgDn | Page (scroll, list, document) | compiler | view |
| Home/End | First/last (list, scroll, document) | compiler | view |
| Space | Tree fold, multiselect check, toggle, field-action | compiler | draft/view |
| Enter | Accept/submit/enter edit/activate action | compiler | draft→may trigger handler |
| Alt+Enter | textarea newline; extension: alternate submit (session scope, decided §12) | compiler | draft/submit |
| Tab / Shift+Tab | Next/previous control group (committing in-progress edits) | compiler | focus |
| Esc | Step out level by level: picker→search→wizard→tab→surface | compiler | view/may trigger dirty decision |
| `/` | Enter list search (filterable) | compiler | view |
| Ctrl+U | Clear search and return to the anchor | compiler | view |
| `1-9` | numbered-list direct access (M1) | compiler | selection |
| `Ctrl+E` | expand the focused scrollable content fullscreen / collapse (M6) | compiler | view |
| Declared shortcuts (e.g. `c`/`r`/`o`) | action `key` field | declared by the surface, dispatched by the compiler | triggers handler |

### 3.2 Editor-specific

| Key | Behavior | Condition |
| --- | --- | --- |
| `!` (first char of empty buffer) | enter bash mode | prompt state |
| `/` (first char) | slash completion | not bash |
| `@` | file-mention completion | any position |
| `#` | skill completion | not bash |
| `↑↓` | history | when completion is closed |
| Enter | submit (transforms→followup) | — |
| Alt+Enter | newline | — |
| Ctrl+S | steer the current turn | running |
| Ctrl+G | $VISUAL/$EDITOR external edit | no external edit in flight |
| Shift+Tab | plan-mode cycle | — |
| Alt+M | cycle session model | — |
| Esc | close completion → (when running) interrupt/retract → clear draft | chained |
| Ctrl+C | draft→clear; empty+running→interrupt; empty+idle→double-press to quit | chained |
| Backspace/Esc (empty bash) | exit bash mode | bash state |

### 3.3 Shortcut conflicts and the hint line

- Declared shortcuts register through the keymap in bulk; duplicates/conflicts
  throw (the existing `KEY_CONFLICT`/`DUPLICATE_ACTION`).
- **Rule (decided §12)**: a filterable list's surface **must not** bind
  printable-character shortcuts (they swallow the first type-to-filter
  character); an action that needs a shortcut either binds a non-printable key
  or lives in the actions row reachable by Tab. **Open (M7)**: the
  registration-time warning when a filterable surface binds a printable key is
  not yet implemented.
- The hint line (the muted footer line of a surface) lists only keys usable in
  the **current state**, formatted `key action · key action`, with priority:
  danger/exit > search > primary op > navigation. While filtering, a
  `/ query` line replaces the hint line.

### 3.4 Cursors and markers

| Marker | Meaning |
| --- | --- |
| `→` | focused row (reachable) |
| `●`/`○` | selected/unselected (multiple mode) |
| `[x]`/`[ ]` | multiselect/tree check state |
| `*`/`current` | currently effective item (badge) |
| `…` prefix | action busy |
| `!` prefix | danger intent |
| `‹ ›` | focused tab / select placeholder |
| `⠋`/`≈` | loaders (braille/tide) |

## 4. Control behavior spec (ASCII demos)

### 4.1 Text input (input/secret/number)

```
unfocused     focused, not editing   editing          validation failed
Name: foo     → Name: foo            → Name: fo▌      → Name: ▌
                                                     ! required
```

- Enter or a printable character enters editing; Enter commits and moves to
  the next group; Tab commits and moves groups; Esc follows the §1.3 chain.
- secret shows `•••••`, never echoing plaintext.
- number shows `value unit`, edits like input, and validates min/max on
  submit.

**Proposal**: single-field forms (onboarding, OAuth prompt, plan feedback)
support Enter submitting the whole form directly — `MayflyFormNode.
enterSubmits` or an implicit default on the submit action
*[contract+compiler]*.

### 4.2 select (key finding: instant cycle already exists)

```
unfocused              focused (←→ instant cycle)      editing (Enter opens picker)
Protocol: openai-*   → Protocol: openai-*            → Protocol
                                                      > [ ] openai-completions
                                                        > [x] anthropic-messages
                                                        > [ ] custom
```

Current state: while focused, ←→ **changes the value without moving focus**
(compiler §1.3-8); only Enter opens the picker. **Problem**: there is no hint,
so users don't know ←→ works. **Proposal**: render a `‹ ›` hint at the end of
the focused row *[compiler rendering]*.

### 4.3 multiselect / toggle

```
→ Notifications                      → Notifications     → Notifications
   > [x] mentions                       [on]               (no expansion; Enter/Space flips directly)
   > [ ] errors
```

### 4.4 list: browse / choose / multiple / tree / segment

```
╭ Select a model ─────────────────────────────────────────╮
│ / deep▌                    ← search row (while searching)│
│ DeepSeek                  ← group header (muted)         │
│ → deepseek-v4-pro  256k    ← focused row (inverted)      │
│   deepseek-v4      128k                current ← badge   │
│    Thinking: default ‹ off › low +3   ← segment row      │
│                                        (4/12) ← count    │
│ Type filter · ↑↓ · ←→ effort · Enter default · Esc       │
╰──────────────────────────────────────────────────────────╯
```

- `tree: true`: Space collapses/expands, parent/child rows indent.
- `segment`: a horizontal option bar under the focused row; ←→ adjusts the
  value (already used for model effort).
- `filterable`: type-to-filter; `/` explicit search; `Ctrl+U` clears and
  returns to the anchor; `Esc` exits search.
- `acceptActionId`: the action Enter triggers in choose mode.

### 4.5 numbered choose (M1 — implemented)

```
╭ Add provider · step 1/3 ────────────────────────────────╮
│ → 1. Known provider — preset endpoints                   │
│   2. Custom endpoint — any compatible URL                │
│   3. OAuth provider — browser sign-in                    │
│                                                          │
│ 1-3 choose · Enter next · Esc cancel                     │
╰──────────────────────────────────────────────────────────╯
```

Number keys jump directly; ↑↓+Enter stays equivalent. Used for decision lists
of ≤9 items: provider kind, effort, plan decisions, and questionnaire
options. Approval deliberately kept its actions row (see §12).

### 4.6 tabs / wizard

```
plain tabs                        wizard (with progress)
‹ Models ›  Connection  Creds    Kind  ‹ Connection ›  Models   ← completion tracked by surface
```

- ←→ switches tabs (emits a tab-change observation; the handler may
  re-project content); Enter jumps to the first control in the page; Esc
  returns to the tab group first when one exists.
- **Alt+←→ global tab switching**: available while any content-area control is
  focused (except in text/select editing); after switching, focus lands on the
  new tab's remembered/first content control; when focus is on the tab strip
  it lands on the new item's strip position. Hint `Alt+←→ tabs`.
- wizard Back/Next are driven by the surface's `back()`/navigate; Esc=back.

### 4.7 scroll documents

```
╭ trace · #12 ────────────────────────────────────────────╮
│ Type: tool/call   Surface: main                          │
│ ┌ json ──────────────────────────────┐                   │
│ │ {...}                              │ ← scroll control  │
│ └────────────────────────────────────┘                   │
│ Page: [2] of 5   [ Previous ] [ Go ] [ Next ]            │
│ [ Copy trace item ]  [ Close ]                           │
╰──────────────────────────────────────────────────────────╯
```

When a scroll control is focused, ↑↓/PgUp/PgDn/Home/End scroll; document
paging is sliced by `documentPages()` (never splitting surrogate pairs or
losing line tails).

### 4.8 actions row

```
 [ Save ]   Cancel   ! Delete provider
 ↑primary   normal   ↑danger
```

- The focused action inverts + shows `→`; busy shows `… label`; disabled is
  dimmed.
- **Proposal**: a disabled action must give `disabledReason` (the contract
  already has the field — most currently leave it empty), rendered as
  `label (reason)` *[projection]*.
- **Proposal**: during invoke, automatically mark the initiating action busy
  until the reply (M4) *[compiler]*.

### 4.9 loader / empty / progress

```
⠋ discovering models from api.example.com…   ← loader(braille) + elapsedMs
≈ waiting for authorization                  ← loader(tide)

No sessions found                            ← empty
Restore a checkpoint with /rewind            ← empty.description

Progress ██████░░░░ 6/10                     ← progress (narrow width drops label first, then count)
```

## 5. Surface lifecycle spec

### 5.1 Shared decision (implemented; spec: the only confirmation shape)

```
The original surface is replaced wholesale by:

╭ Discard unsaved changes? ───────────────────────────────╮
│ → [ No ]   [ Yes ]          ← No focused by default      │
╰──────────────────────────────────────────────────────────╯
```

- Every "dangerous/irreversible/dirty-form discard" goes through it — no
  self-made confirmation UIs (permission-panel's self-drawn confirm overlay is
  an exception and may stay: it needs explanatory text) *[supported]*.
- While confirming, the original surface's input is entirely blocked (the
  decision node replaces the rendering).

### 5.2 Submit and reply chain (implemented)

```
action.invoke
  → confirm? ──yes──→ decision (§5.1) → continue after return
  → busy/pending? ──→ ignore (reentry prevention)
  → submit → collect form draft+revision → validate
      validation fails → invalid → field errors rendered (! msg), draft kept
  → handler(event) → reply:
      accepted(node,source)  swap snapshot
      conflict(node,source,message)  swap snapshot + notice (settings external-edit case)
      failed(message,…,acceptedFields?)  keep draft + notice
      completed / cancelled   close or stay
      + feedback → notification row   + dismiss → close   + navigate → wizard page jump
```

### 5.3 Async states (implemented + proposed)

| State | Current | Proposal |
| --- | --- | --- |
| pending (awaiting handler) | reentry blocked during invoke, no visual change | M4: auto `… busy` on the initiating action *[compiler]* |
| loading | each surface draws its own loader row | keep; show the loader in place when entering an async page (provider discovery is currently silent — needs adding) *[projection]* |
| failed-retry | notification row + reopen | bind `r` retry only on panels that have that action *[supported]* |
| stale/conflict | settings uses the `conflict` reply to swap in the latest snapshot | extend to provider edit *[projection]* |
| unload/Agent switch | AbortSignal + exact-Agent fencing, late results dropped | keep |

### 5.4 Nested overlay principle

- At most two levels (main surface + shared decision). **No second-level
  feature popups** — this is why the `/model` options popup and the provider
  `add-custom-model` popup need dismantling.
- Alternatives: inline edit rows (`+ model id: ___ [Add]`), segments,
  numbered direct access, wizard page switching.

## 6. Editor and input area (full state)

### 6.1 Layout

```
┌ transcript (top, passive scroll)─────────────────────────┐
│ ...                                                     │
├ panes (queue/steer inbox, shown only when non-empty)─────┤
│ Queued: refactor the parser                             │
│ Steer:  use the streaming API                           │
╭ editor ─────────────────────────────────────────────────╮
│ > tell me about this repo▌                              │
╰──────────────────────────────────────────────────────────╯
 notification-or-slash-hint (single muted row)             ← feedback/hint combined
 MAIN⇄SUBAGENT · F7 switch · F8 close                      ← only while the aux view is open
 plan · yolo                                               ← only when non-default
```

The editor dock hosts overlays: a `presentation:'editor'` picker directly
replaces the `>` line and restores the draft on close.

### 6.2 State × key matrix

| State | Enter | Esc | Ctrl+C | Ctrl+S | ↑↓ | printable | Tab |
| --- | --- | --- | --- | --- | --- | --- | --- |
| idle empty | no-op | no-op | double-press quit (2s) | — | history | input | sole focus→inside editor |
| idle with draft | submit | clear draft | clear draft | — | history | input | same |
| completion open | apply and submit (slash)/insert (@#) | close completion | close completion + clear | — | pick candidate | filter | apply candidate |
| ghost hint shown | submit | back to command head | — | — | — | keep typing | — |
| bash mode | run shell | empty→exit bash | clear | — | shell history | input | filename completion |
| running | — (enqueue) | interrupt/retract | interrupt | steer | — | input (enqueued) | — |
| external editor | — | — | — | — | — | — | — (screen suspended) |
| overlay capturing | see §1.3 | step out | passthrough to surface | — | surface | surface | moveGroup |

Notes: `Alt+M` cycles the model, `Shift+Tab` cycles plan, `Ctrl+G` opens the
external editor — available in any editor state; image paste goes through
Ctrl+V (clipboard probing).

### 6.3 Completions (three kinds)

```
/ completion (fuzzy, dispatchable)   @ mention             # skill
│ > /mod▌                          │ > check @src/m▌      │ > #rev▌
│   /model   [name]  — desc        │  → src/mayfly/ dir   │  → #review  Review diff
│ → /mode    — Toggle plan         │    src/main.ts  file │    #release …
│   /effort  [level] — desc        └ Enter=insert, no submit
└ Enter=apply and dispatch the command
```

- slash: Enter dispatches the command directly; an alias match shows
  `Match: /canonical` + `[Tab] apply`.
- @/#: Enter only inserts the token, never submits.
- In bash mode `/`/`#` are shell syntax and both completion kinds close
  (already).

### 6.4 bash mode

```
╭ ! shell ─────────────────────────────────────────────────╮
│ ! ls -la▌                                                │
╰──────────────────────────────────────────────────────────╯
```

The `!` glyph + a distinct hue + a top-edge label; empty-buffer
Backspace/Esc exits. Commands run after `shell-sanitize`.

### 6.5 Submit pipeline

```
submit → submitTransformers (image marker etc., rollbackable)
       → running? enqueue (pane-queue shows Queued:/Steer:)
       → record retractionCandidate (Esc on an empty draft retracts the just-submitted message)
       → followup
```

## 7. Full command and surface inventory

Format: **current** → **gap** → **target** (ASCII) → **cost**.

### 7.1 Session family: `/quit /new /fork /rewind /sessions(/resume)`

- `/quit` (q/exit), `/new` (clear), `/fork`: no UI, notification-row
  feedback; `/fork` errors while running.
- `/sessions <id>` passes through and skips the picker; `/resume` is an alias
  rewrite, not a separate registration.

**/sessions**: filterable tree picker, `presentation:'editor'`, cwd filter,
new→old order, lazy title paging, current stays selected, Enter on
non-current→`request-resume`, Enter on current→"Already the current session"
hint, reopen=replace.

```
╭ Sessions ───────────────────────────────────────────────╮
│ / ▌                                                      │
│ → * Fix the parser bug            today 10:41  ← current │
│   ▸ older session                                        │
│   ▾ parent session                                       │
│      └ fork child                                        │
│ Type filter · ↑↓ · Space fold · Enter resume · Esc       │
╰──────────────────────────────────────────────────────────╯
```

Gap: none. Proposal: while titles load, show a muted `…` placeholder inline
(currently a fade-in). *[projection]*

**/rewind**: idle-only; takes user-turn boundaries from the event log, a
choose list, Enter→`request-rewind`; the original session stays in /sessions.

```
╭ Rewind ───────── select a user turn to branch from ─────╮
│ / ▌                                                      │
│ → Turn 12 · "add retry logic"      today 10:41           │
│   Turn 9  · "fix the parser"       today 09:20           │
│ Enter branch · Esc close                                 │
╰──────────────────────────────────────────────────────────╯
```

Gap: no preview. Proposal: the detail column shows the message count after
that turn ("rewinds 4 messages"). *[projection]*

### 7.2 `/help`

Scrolling overlay (chrome:'overlay') with commands+keys sections, a scroll
control + `[Close]` dismiss action, Esc closes, locale switching re-projects.
Gap: no `q` quick close. Proposal: give the close action `key:'q'` (no
filterable here, safe) — consistent with the "reading docs" mental model.
*[projection]*

### 7.3 `/mode`

No UI; equivalent to the Shift+Tab plan cycle, confirmed on the notification
row. Keep.

### 7.4 `/model`

**Implemented** (M2): the baseline shape was a filterable browse list whose
Enter opened a second-level overlay to re-pick effort; that popup is deleted
and the picker now looks and behaves as below — Enter commits the inline
effort and writes the default, Alt+Enter applies session-only:

```
╭ Select a model ─────────────────────────────────────────╮
│ / deep▌                                                  │
│ DeepSeek                                                 │
│ → deepseek-v4-pro  256k        thinking ‹ medium ›       │
│   deepseek-v4      128k                        current   │
│ my-corp                                                  │
│   gpt-5.2          400k                                  │
│                                        (4/12)            │
│ Type filter · ↑↓ · ←→ effort                             │
│ Enter set default · Alt+Enter session only · Esc         │
╰──────────────────────────────────────────────────────────╯
```

- **Enter = inline effort + write default** (the original Set-as-default
  path).
- **Alt+Enter = session-only**: `inputs.selections[]` carries `segmentId`
  (M2 contract delta — shipped) and the `session` action declares
  `key:'alt+enter'` + `selections:[models]`.
- The second-level `modelOptions` overlay is deleted; `/provider switch <id>`
  reuses the same picker.

### 7.5 `/effort` (`/thinking` alias)

**Implemented** (M1): the baseline reused the modelOptions form popup; it is
now a numbered choose list, ≤9 levels direct:

```
╭ Thinking effort — deepseek-v4-pro ──────────────────────╮
│ → 1. Provider default                                    │
│   2. off   3. low   4. medium   5. high                  │
│ 1-5 choose · Enter default · Alt+Enter session · Esc     │
╰──────────────────────────────────────────────────────────╯
```

### 7.6 `/provider` (list/edit/switch/add + onboarding + OAuth)

**Implemented** (all sub-flows below landed with the ux-interaction merge):
row details, the ordered add wizard, inline model add, disabledReason hints,
and OAuth/onboarding enterSubmits.

**List**: a detail per row (`N models · key configured/no key set`), warning
tone when the key is missing; `Add provider` stays in the actions row
(no bare letters on filterable).

**add**: an explicit wizard (`mode:'wizard'` completion tracking), fixing the
reversed "Models before Credentials" order:

```
step1  numbered kind ──→ step2  Connection (name/protocol/   ──→ step3  Models
      1 known 2 custom         baseURL/key merged on one page)      auto-discover on entry
      3 oauth                                            ┌ loader→failure gives retry+manual-add row ┐
                                                         │ [x] model-a  128k                          │
                                                         │ + model id: ___ [Add]                      │
                                                         │ [ Save ] (disabledReason)                  │
```

- Save `submit`s the Connection form + `selections` for Models; the handler
  writes settings/credentials separately inside (storage boundary not
  exposed).
- Discovery failure ≠ blocking: `minSelected:1` + a manual-add row as
  fallback, with a disabledReason hint.
- Success→dismiss+feedback+auto-open that provider's /model picker
  (onCreated already exists).

**edit**: isomorphic three-page tabs (Models/Connection/Credentials); the
`Add custom model` popup→an inline `+ model id` row on the Models page;
background discovery probe shows a loader row; `Delete`/`Clear key` go
through the shared decision; when `!dirty`, Save is dimmed + `No changes`.

**OAuth** (authorization-ui): notice scroll + URL/code + copy actions +
loader + Start/Cancel:

```
╭ Sign in — anthropic ────────────────────────────────────╮
│ Open this URL in your browser:                           │
│ https://claude.ai/oauth/authorize?code_challenge…        │
│ Code: XKCD-1234                                          │
│ ⠋ Waiting for authorization…                             │
│ c copy URL · y copy code · Ctrl-E expand · Esc           │
╰──────────────────────────────────────────────────────────╯
```

Bare letters `c`/`y` are safe (no filterable); `Ctrl+E` expands the long URL
fullscreen (M6). Child prompts (code/password) use a single field +
enterSubmits (M5).

**onboarding**: a single secret field + enterSubmits, Enter=Save, Esc=skip
(M5).

### 7.7 `/settings`

Two levels: namespace browse list → namespace form (Save/Refresh/Cancel +
restart hint + revision-conflict reply + shared dirty decision); external
editing of `settings.yaml` suspends the screen. In good shape. Proposal: the
namespace row's detail shows field count/modified count. *[projection]*

### 7.8 `/preset` / `/permission`

- `/preset`: browse list + Refresh/Close; the `custom` row's disabled
  explanation; Enter→native `agentPresets.select()` (turn-boundary fencing
  already exists). Proposal: row detail shows a composition summary.
  *[projection]*
- `/permission`: choose list; the `danger-full-access` preset → a self-drawn
  confirm overlay (with sandbox explanation, Yes danger/No default). The
  self-drawn version is justified (needs explanatory text) — keep; after
  dispatch the notification row acknowledges.

### 7.9 `/theme`

choose list + current; switching triggers a renderer reload (draft/history
preserved via the stash — verified). Keep.

### 7.10 `/mcp`, `/tools`, `/skills`

- `/mcp`: server browse list (status ordering+tone) → server detail (tabs
  Tools/Config, env/header show keys only) → tool detail. Proposal: server
  row detail shows `N tools · status`. *[projection]*
- `/tools`: browse list → tool detail (schema/desc). Keep.
- `/skills`: browse list → detail (does not load the body); `#` completion
  shares the catalog. Keep.

All three share the "list→detail" shape: a uniform detail footer
`[ Close ]` + Esc.

### 7.11 `/plugin` (marketplace)

Tabs Installed/Not installed → per-group filterable browse list + actions
(Details + install / remove + refresh + Close) → detail overlay (scroll
sections + Close); install/remove report progress + remove confirms.

Baseline gap — resolved (§12 decision shipped): the `i`/`u`/`r` bare-letter
keys on the filterable list are **deleted**, actions are reached via
Tab + ←→ + Enter, search goes entirely to type-to-filter, and Refresh is
rebound to the non-printable `Ctrl+R`. What remains open is only the M7
registration-time warning that would codify the rule for future surfaces.

```
╭ Plugins ────────────────────────────────────────────────╮
│ ‹ Installed (3) ›   Not installed (12)                   │
│ / ▌                                                      │
│ → mayfly-tools    v1.2.3 · installed                     │
│   web-search      v0.9.1                                 │
│                                                          │
│ [ Details ] [ Install ] [ Remove ] [ Refresh ] [ Close ] │
│ Type filter · ↑↓ · Tab actions · Esc                     │
╰──────────────────────────────────────────────────────────╯
```

### 7.12 `/update`

preflight→confirm (Yes primary/No default)→progress overlay (step list
✓/…/✗/· + scrolling log area)→result text + log path; `updateInFlight`
prevents concurrency; while running, Close is disabled
(`disabledReason:'The update is still running'`) and a dismiss event returns
`failed` — the panel cannot be closed before the swap settles, which is
correct. Remaining gap: progress step rows may lose their status icons at
narrow widths. *[no change needed / covered by width-scan]*

### 7.13 `/trace`

filterable browse list (seq/type/surface badge) → detail (fields + scroll
code + Page form + Previous/Go/Next + Copy trace item + Close);
`/trace copy <seq|all>` passes straight to the clipboard.

```
╭ Trace ──────────────────────────────────────────────────╮
│ / tool▌                                                  │
│ → #12 10:41:02  tool/call · Bash        main             │
│   #13 10:41:03  tool/result · Bash      main             │
│   #14 10:41:05  message/assistant       btw              │
│ Type filter · ↑↓ · Enter detail · Esc                    │
╰──────────────────────────────────────────────────────────╯
```

Detail-page navigation is already canonical (number field + Go +
prev/next). Proposal: a `[c]` copy shortcut (the detail has no filterable —
safe). *[projection]*

### 7.14 `/jobs`

filterable browse list (●running/○exited + duration) → detail (fields +
warning + Read output/Stop/Refresh/Close) → output (scroll code + page form +
Close). `Read output` explicitly consumes `read` (required by the contract);
status is re-checked before Stop.

```
╭ Jobs ───────────────────────────────────────────────────╮
│ / ▌                                                      │
│ → ● build   running · 2m14s                              │
│   ○ test    exited(0) · 45s                              │
│   ○ lint    failed(1) · 12s                              │
│ Type filter · ↑↓ · Enter detail · Esc                    │
╰──────────────────────────────────────────────────────────╯
```

Implemented, at a tighter cadence than proposed: the list page polls
approximately every second (a Fiber-owned refresh fenced by revision and
generation) rather than the 5s suggested here, so running rows update live.

### 7.15 `/agents`

subagent tree browser (filterable; running badge + a metrics row:
`3 tools · 12k tok · 1m04s`; diagnostic rows disabled) → Enter opens that
child Agent's aux view; a `[ Stop selected ]` action with confirm.

Implemented (§12 decision shipped): the baseline bound `q` to stop, which
conflicted with filtering on rows whose searchText contains label/id/mode.
The `q` key is removed and stop lives in the actions row reachable by Tab,
so searchText is fully filterable.

### 7.16 `/btw` + auxiliary view

`/btw <question>` starts a side-question aux Agent; Enter on the `agents`
tree can also attach. Status row `MAIN ⇄ SUBAGENT/BTW · F7 switch · F8
close`; cold/one-shot child sessions use the shared readonly transcript panel
(ScrollablePanel: Esc/arrows/PgUp/PgDn/Home/End, title+hint+footer).

```
╭ BTW · how does auth work ──────── Esc close ────────────╮
│ (readonly transcript rows)                               │
│ subagent · read-only                                     │
│ F7 toggle · F8 close · Esc close                         │
╰──────────────────────────────────────────────────────────╯
```

In good shape. Implemented: while the aux view is open, the F7/F8 hint is
rendered on both the primary and auxiliary sides (the proposal asked for the
main-side hint; both sides show it).

### 7.17 Plan/approval/questionnaire/authorization (Agent-initiated surfaces)

**plan review** (plan-review-panel + plan-document): the plan markdown goes
into the content flow; the decision control sits in the editor dock. The
baseline hand-wrote `1./2./3.` into labels; it is now a `numbered` list (M1)
so number keys dispatch directly, with `c` copy / `o` other and the feedback
subform on enterSubmits (M5).

```
content flow:                editor dock:
│ Plan                      ╭ Plan review ────────────────╮
│ ## 1. ...                 │ 1. Approve                   │
│ ## 2. ...                 │ → 2. Reject                  │
│                           │ 3. Other — type feedback     │
│                           │ c copy · o other · PgDn plan │
│                           ╰──────────────────────────────╯
```

**Approval** (approval-plugin): tabs `Decision`/`Reject with feedback`;
actions [Reject][Allow once][Allow X for session][Reject with feedback].

```
╭ Approval: Bash — rm -rf dist ───────────────────────────╮
│ ‹ Decision ›   Reject with feedback                      │
│                                                          │
│ → [ Reject ] [ Allow once ] [ Allow Bash for session ]   │
╰──────────────────────────────────────────────────────────╯
```

Deviation from the proposal (see §12): approval was **not** converted to a
numbered list. It keeps the actions row with `Reject` as the focused safe
default — the proposal's `1=Reject` numbering would have made a single digit
approve nothing while `2`/`3` granted access, which read poorly for a
permission gate.

**Questionnaire** (questionnaire/AskUserQuestion): wizard tabs + choose list
+ `Other:` textarea + Back/Next + Submit/Cancel. Implemented (M5): Enter on
a focused Other field submits the current page (enterSubmits).

### 7.18 Info overlays: `/status /context /version /changelog /export /copy /init`

- status/context: fields + progress + chart, a refresh action; context's
  chart drops the label and keeps the count at narrow widths (renderProgress
  already does this).
- export/copy: file/clipboard operations with notification-row receipts
  (path/byte counts).
- init: a canned prompt dispatched directly.
- All readonly surfaces use `dismissal:'discard'`, footer `[ Close ]`+Esc.

### 7.19 Status bar / panes / notifications

| Component | Current | Proposal |
| --- | --- | --- |
| pane-queue | shows `Queued:`/`Steer:` rows when non-empty | keep |
| agent-view-status | `MAIN⇄AUX·F7·F8` | implemented: the hint renders on both sides while aux is open (§7.16) |
| mode-status | `plan`/`yolo` shown only when non-default | keep |
| notification row | severity→tone, app/session scope, newest of highest severity | keep; operation notifications aggregate by `operationId` (already) |
| terminal-title | mirrors the session title | keep |

## 8. Narrow terminals and degradation (facts + spec)

Existing degradation (built into the compiler/render layers): list detail
hidden at `width≤40`; autocomplete description at the same threshold; segment
overflow folds into `+N`; tabs keep only `‹ active ›`; progress drops the
label then the count; panes declare `narrow:'bottom'|'overlay'|'hidden'`.

Spec: a new surface **must not** assume width — detail must be droppable,
badges truncatable, and the hint line trimmed by the §3.3 priority. Acceptance
goes through width-scan (`render(width)` with no line overflowing).

## 9. Contract and compiler delta list

| ID | Delta | Serving scenario | Layer | Status |
| --- | --- | --- | --- | --- |
| M1 | `MayflyListNode.numbered: true` → rows render an `N.` prefix + `1-9` keys jump directly | provider kind, effort, plan, questionnaire | contract+compiler+rendering | shipped |
| M2 | `inputs.selections[]` carries `segmentId`; `Alt+Enter` usable as a `key` | /model session scope | contract+compiler | shipped |
| M3 | a focused select row renders a `‹ ›` cycle hint at its end | provider edit/add, settings | compiler rendering | shipped |
| M4 | auto-mark the initiating action busy during invoke (cleared on reply landing) | discovery, Save, install, retry | compiler | shipped |
| M5 | `MayflyFormNode.enterSubmits?: actionId` → single-field Enter submits directly | onboarding, OAuth prompt, plan feedback, questionnaire Other | contract+compiler | shipped |
| M6 | `Ctrl+E` promotes the focused scrollable content into a fullscreen readonly viewer (Esc/Ctrl+E returns) | OAuth URL, approval reason, plan, trace | compiler | shipped (any scroll control, not a separate presentation variant) |
| M7 | warn at registration when a filterable surface binds a printable shortcut (dev-time) | marketplace, agents | compiler/keymap | **open** |

## 10. Migration priorities

Historical execution order — items 1–7 all landed in the ux-interaction
merge; item 8 is partially done:

| # | Content | Status |
| --- | --- | --- |
| 1 | `/model` (M2 + delete the second-level popup + segment hint M3) | landed |
| 2 | `/provider edit` inline model add + list detail | landed |
| 3 | `/provider add` wizard reorder + auto discovery + retry | landed |
| 4 | M1 numbered → provider kind, effort, plan, questionnaire (approval excluded, §12) | landed |
| 5 | marketplace/agents bare-letter cleanup | landed (M7 warning still open) |
| 6 | M4 auto busy marking | landed |
| 7 | OAuth/onboarding (M5+M6) | landed |
| 8 | jobs polling, sessions placeholder, rewind count, and other polish | partially: jobs polls ~1s; `/help` `q` close, `/trace` `[c]`, sessions ellipsis placeholder, and settings/preset/MCP row-detail polish remain open |

## 11. Acceptance

Document changes: no runtime acceptance needed (docs/** are documentation).

The implementation landed on main via the ux-interaction merge and passed
the full deterministic gate. Remaining work (M7 and the open polish items in
§10 row 8) follows the root AGENTS: `verify:changed -- --plan` →
`verify:changed`; touching the compiler/contracts counts as an architecture
change → `verify:full` + width-scan updates + a dedicated-profile
PTY acceptance (covering the main flow, narrow widths, and lifecycle
regressions). Contract changes go through the full `packages/ui` gate
(replay/replacement/duplicate/cancellation/late/Fiber-cleanup tests).

## 12. Decision log

Decided:

1. **`/model` Enter writes the default directly**: Enter=write default,
   Alt+Enter=session-only, and the second-level scope popup is deleted.
   Reason: the default and the `current` badge are both visible inline, the
   cost of a mistaken write is low (re-picking changes it back), and removing
   a popup layer is worth more.
2. **No printable shortcuts on filterable surfaces**: the `key` fields of
   marketplace `i`/`u`/`r` and agents `q` are deleted, with the actions kept
   in the actions row reachable by Tab; high-frequency actions may bind
   non-printable keys (e.g. Refresh on `Ctrl+R`). The M7 registration-time
   warning codifies this rule and remains open; the alternative (letters only
   go to input after an explicit `/` enters search) was rejected as a
   two-layer rule that is hard to teach.
3. **Approval keeps its actions row** (deviation from §7.17's numbering
   proposal): `Reject` stays the focused safe default rather than mapping
   digits to allow/deny — a permission gate reads better with an explicit
   focused action than a `1=Reject, 2=Allow` numeric shortcut.

Resolved during implementation:

4. **Scope of `Ctrl+E` expansion**: shipped for any focused scroll control —
   the expanded view owns the whole frame until Esc/Ctrl+E (§1.3 step 0) —
   not just the proposed long readonly text/URL/code case, and not
   editing-state text fields (the editor's Ctrl+G external editor already
   covers that need).
