# Mayfly UI design

This is the target design for Mayfly's terminal UI. It has two layers and one rule:

- **Basic components** (§4) are the UI API: a small set of builders (`ui.list`, `ui.form`, `ui.tabs`, …), one
  renderer, and one key engine. They draw every state of every control.
- **Mayfly components** (§5) are the status bar, the editor, the transcript, and the panel behind each command.
  Each is a composition of basic components.
- **One API** (§6): Mayfly's own components and downstream plugins use exactly the same basic components. A Mayfly
  component may use nothing else, and a plugin can build anything a Mayfly component builds. The prototype
  enforces this (§9).

It is a **design for review**. It does not describe the shipped renderer, and nothing in it is limited by the
code. Where a section says *Today*, that is a one-line baseline so the change is visible; the full list of
changes is in §7, and the decisions that still need an answer are in §8.

Review it by running the prototype, which draws every component and every screen in a terminal:

```
node docs/design/prototypes/ui-preview.mjs          # the scenes
node docs/design/prototypes/ui-preview.mjs --audit  # which basic components each Mayfly component uses
```

After review and merge, a follow-up change implements the design in `packages/`. The material that change needs
(wire mechanics, builder tables, touch points, the backlog) is kept apart in
[component-library-reference.md](./component-library-reference.md) so it does not dilute this document.

## 1. Purpose and principles

The design aims to be four things, and each aim is a rule:

- **Elegant.** Quiet by default: one scarce accent, typographic emphasis (weight,
  dimness), rounded frames, no decoration that carries no meaning.
- **Comprehensive.** Every component has a look for each state (idle, focused,
  editing, busy, disabled, invalid, empty, narrow), and every screen is composed from
  those components rather than drawn on its own.
- **Concise.** An operation has one home, one key, and one word. A key that already
  does the job removes the button; a cue that already tells the user removes the
  second cue.
- **Consistent.** The same mark means the same thing everywhere (§2.2), the same key
  means the same thing everywhere (§3.4), and the same state looks the same everywhere
  (§2.4).
- **Self-consistent by construction.** There is one UI API. Mayfly's components and a plugin's components are built
  from the same basic components, so they cannot drift apart (§6).

### 1.1 Principles

1. **Keys, not buttons.** Every operation is reachable from keyboard focus or a bare
   key. Apply the *redundancy test* before drawing a button: if `Enter` on the focused
   row, `Esc`, a digit, `←`/`→` on a segment or select, or `/` already performs the
   operation, do not draw it. A button exists only for an operation no bare key
   reaches: a secondary write, a destructive action, or a choice between two equally
   valid commits.
2. **Enter confirms.** The focused control activates with `Enter`; `Space` toggles. A
   single-field form submits on `Enter`; there is never a separate step to reach a
   Save button.
3. **Report in place, in real time.** Errors paint beside the field, unavailable
   operations render disabled with their reason, and a filter narrows as you type (or
   after `/` on a panel with bare-letter keys, §3.4).
   No second dialog or second `Enter` where an inline answer suffices.
4. **Safe by position.** The focused default is the least destructive choice, every
   Yes/No question is the same `[No] [Yes]` decision with No focused first, and a
   surface that opens unprompted must not let a stray key grant anything (§5.7).
5. **Hints never lie.** The hint row is derived from the bindings that dispatch keys,
   so a displayed key always works, and it names the real effect (§3.2).
6. **Stable geometry.** Moving focus never changes the number of rows a surface
   paints. Per-row controls render on their row and fold before they wrap.
7. **Recognition over recall.** Current state is visible without opening anything:
   `[current]` on the live row, `(inherited)` on a field, the active token of a strip,
   a select's value beside its label.
8. **Preview, then commit.** Navigation and adjustment never write. Only `Enter`, a
   declared accelerator, or (where the surface allows it) a digit commits, and every
   commit is reversible in place or asks first with No focused.
9. **One verb per meaning.** Hints, labels, and notices draw from one vocabulary
   (§3.2); a surface does not invent a synonym.
10. **Color never carries meaning alone.** Every tone-coded state also has a glyph or a
    word, so a monochrome terminal stays unambiguous.
11. **One API.** Core and plugins build every surface from the same basic components. If a Mayfly
    component needs something the basic components cannot say, the basic component grows (§6.4); core
    never reaches around it.
12. **Keys are rebindable meanings.** A key belongs to a named action. The common meanings (save, copy, delete,
    refresh, open externally, search) mean the same thing in every panel, a component adds its own (`i` installs),
    and a consumer can rebind every one of them at runtime; the hint row follows the rebind (§3.5).

Keystroke budget, counted from an open surface (a digit and `Enter` are one key each):

| Frequency | Budget | Example |
| --- | --- | --- |
| Every session | 1-2 keys | approve a plan (`↓`, `Enter` under variant A, §5.7) |
| Several per day | 2 keys | change thinking effort (`→`, `Enter`) |
| Occasional | 3 keys | switch model (`/model`, type, `Enter`) |
| Rare or destructive | as many as needed, with a confirm | delete a provider |

## 2. Visual language

### 2.1 Brand

Mayfly's identity is quiet by construction: violet ink and rounded frames.
Components express it through palette tokens and glyphs, never surface-specific
paint.

1. **Scarce violet ink.** `primary` marks *the one place attention belongs*: the
   focused row and, inside it, the active choice (the `‹ high ›` token, the active
   tab, the primary action). Never body text, badges, headings, or a second
   highlighted row. If two things on a surface are both violet, one is wrong.
2. **The inset title rule.** `╭ Title ─────╮`: a rounded frame whose title sits inside
   the top rule. It is the only decorative line; no double rules, heavy borders, or
   boxed sub-panels. Overlays and inline surfaces both use the rounded frame (the
   overlay in the focus border color, the inline surface in the quiet border color);
   a `lane` is rules only. A frame's title may sit in the right corner instead (the editor's conversation
   title, §5.2).
3. **Words and weight, not paint.** Everything else is typographic: weight, dimness,
   the `→` mark, and words. No filled color blocks except the diff's changed code, and no emoji.

### 2.2 Glyphs and marks

One glyph, one meaning. These tables are the whole vocabulary; a new surface may not
add a third meaning to a glyph.

**Selection and focus.**

| Mark | Meaning | Where |
| --- | --- | --- |
| `→` | the cursor: the row `Enter` will act on; it shows only while its list has focus | choose, decision, option, and menu lists; form field focus; the views panel |
| `→` muted + bold | the persistent selection: the same arrow, muted once focus has moved on | rails, and browse lists whose detail follows them |
| inverse | a selected token | prompt tokens (`[Image #1 ×]` after the first `Backspace`) |
| `▸` `▾` | closed / open disclosure | tree branches, accordions, folded turns and blocks |
| `‹ v ›` | `←`/`→` changes this value | select, number, tab strip, segment |
| `●` `○` `◐` | chosen, not chosen, some children chosen | single and multiple choose lists, multiselect, trees, wizard steps |
| `[on]` `[off]` | a toggle's value | toggle fields only |
| `•` | an edited field (an implicit override) | forms |
| `[current]` | the current choice, always this muted badge | pickers |
| `— reason` | disabled, with its reason after a dash | actions, rows, options |
| `! text` | a field error, indented under the field | forms |
| `+N` | N tokens folded by a narrow width | actions, tabs, strips |

**State and progress.**

| Glyph | Meaning |
| --- | --- |
| `●` | assistant block; a tool or step running |
| `»` | user block |
| `✻` | thinking |
| `✓` `✗` | done / failed |
| `⊘` | cancelled |
| `◐` | declined (plan) |
| `■` | stopping or interrupted |
| `?` | waiting on the user |
| `⚠` | warning (deletes files, low balance, dangerous tool) |
| `ℹ` | information |
| `✕` `❚❚` | goal blocked / paused |
| `⎿` | detail connector under a header or a failed row |
| `⏵` | background jobs |
| `↻` | applies after a restart |
| `↗` | opens in the external editor |
| `▰` `▱` | determinate progress cells |
| `━` `─` | heavy and light rule: tab underline, todo and goal progress |
| `░▒▓█` | activity intensity (heatmap), four steps after `·` for none |

`●` and `▸` appear in both a control context and a transcript context; position and
tone tell them apart (a check right after the cursor versus a block marker at the line start versus an inline
status).

Marker rules: the live row is always `[current]`; every choice, single or multiple, uses `●` for chosen and `○`
for not chosen (`◐` for a parent with some children chosen), never `[x] [ ]`; a toggle uses `[on] [off]`.

### 2.3 Motion

One glyph, one meaning, one **motion channel per row**: a row animates its glyph or
its label, and the other stays still. Motion is a fact about the machine; when a row
waits on the user, or has settled, nothing moves.

| State | Moves | Frames | Step |
| --- | --- | --- | --- |
| Thinking | glyph (bloom) | `· ✢ ✳ ✶ ✻ ✽ ✻ ✶ ✳ ✢` | 100 ms |
| Deep diving (working on the model, writing) | glyph (fill) | `⡀ ⣄ ⣤ ⣦ ⣶ ⣷ ⣿ ⣷ ⣶ ⣦ ⣤ ⣄` | 100 ms |
| Tool running | label (shimmer); `●` static | a three-letter window sweeps the label | 100 ms per letter |
| Waiting on an external action | glyph (breath); label static | `●` steps through six tone shades, dim → bright → dim | 400 ms per step |
| Indeterminate loader | glyph (gap) | `⣾ ⣽ ⣻ ⢿ ⡿ ⣟ ⣯ ⣷` | 100 ms |
| Waiting on the user | nothing | `?` (warning) | none |
| Stopping | nothing | `■` (danger) | none |

```
✻ Thinking · 8s · ↑30.2k ↓1.1k                       Esc interrupt · Ctrl+O expand
⣤ Deep diving · 2s                                    Tip: @ files
● Running commands · 12s · ↑30.2k ↓4.1k · 38 tok/s    ← the label shimmers, ● is still
● Waiting for authorization · 45s                     ← ● breathes, label is still
? Waiting for your action · 8s                        ← static: nothing is computing
```

- Color is a cycle of tone tokens and the shimmer is `accent`+`strong` over `muted`,
  so both survive a monochrome terminal as weight. Width never changes between frames.
- One-shot transitions end by themselves and never loop or overlap a running channel
  on the same row: a 400 ms inverse flash when an item settles, a 300 ms stagger of a
  subagent fan-out, an 800 ms drain of the compaction bar.
- Every frame is one cell wide; a glyph that may render wide in some fonts falls back
  to `*`. Reduced motion freezes each channel on its first frame.
- The renderer owns every clock; a surface that hides stops its clock.

### 2.4 State patterns, feedback, and formats

**One answer for five states.** Every panel, and every secondary read inside it,
renders the same patterns, so users learn them once:

| State | Pattern | Example |
| --- | --- | --- |
| loading | gap spinner, what, elapsed | `⣾ Loading sessions…` |
| empty | what is missing and the next action | `No plugins installed — press → to browse` |
| error | `✗` reason and the retry key | `✗ Could not reach the market  r retry` |
| stale or offline | `⚠` and the data's age; content stays usable | `⚠ offline · showing cached data from 2d ago` |
| unavailable | `—` and the reason, no retry | `— not supported by this provider` |

A slow or failed secondary read (a balance, a catalog refresh) never blocks or alters
the primary content.

**Feedback.** `✓` success and `ℹ` info disappear after 5 s of visible time; `⚠`
warning stays until acted on; `✗` error stays and offers its retry key; progress
never auto-dismisses. Feedback is inline in the footer of an open surface and a toast
in the activity row's gap otherwise. Glyph plus word, never color alone.

**Breakpoints.** At 100 columns or more a list-and-detail surface is a split view;
from 60 to 99 it is one column and `Enter` opens the detail; below 60 it shows the name
and one status glyph and `Enter` opens the detail. Every row fits its width and
degrades by dropping, in order, the least important token (a counter before a label,
a label before the active token); the active or focused token is never removed.

**Formats.** Durations `4s`, `2m 10s`, `1h 5m`; ages `2m ago`, `3d ago`; tokens `148k`,
`~12k`, `22.9k / 128k`; money in the provider's currency with two decimals
(`¥ 128.40`); paths home-collapsed to `~` and middle-ellipsised; counts `12 turns`,
`+3 more`; keys as `Ctrl+O`, `Shift+Tab`, never `ctrl+o` or `Ctrl-O`.

## 3. Interaction

### 3.1 Surface state machine

Every capturing surface is the same small state machine. A control moves the surface
into a *mode*; `Esc` always leaves exactly one mode, and the hint row names which
(`end search`, `done`, `cancel`, `back`, `close`).

```
                       Esc: end search (query kept)
              ┌───────────────────────────────────────────────┐
              ▼                                               │
 closed ─open─► BROWSING ────────── type · "/" ────────────► SEARCHING
   ▲             │ │ │ │
   │             │ │ │ └─ Enter on text ───► EDITING ─ Enter: commit · Esc: done ────► BROWSING
   │             │ │ └─── Enter on select ─► PICKER ── Enter: apply · Esc: cancel ───► BROWSING
   │             │ └───── Enter on confirm ► DECIDING ─ Yes: run · No/Esc: answer No ─► BROWSING
   │             └─────── Enter on action ─► BUSY ──── ends  ─┬─ completed ──────────► closed
   │                                                          └─ invalid · failed ───► BROWSING + inline error
   └── Esc / Ctrl+C in BROWSING (one layer per press) ──────────────────────────────────
```

| Mode | Entered by | `Enter` | `Esc` (hint word) | Also live |
| --- | --- | --- | --- | --- |
| BROWSING | open; every other mode returns here | primary operation of the focused control (`choose`, `open`, `run`, `submit`) | `close`, or `back` on a wizard page | arrows, digits, accelerators, `Tab` groups |
| SEARCHING | typing or `/` on a filterable list | choose the focused match | `end search` (query kept) | `Ctrl+U` clear, `Backspace` |
| EDITING | `Enter` or typing on a text field | `next`, or `submit` on a single-field form | `done` (draft kept) | `Tab` commits and moves, `Alt+Enter` newline |
| PICKER | `Enter` on a select or multiselect | `apply` | `cancel` | `↑`/`↓` candidate, `Space` toggles (multi) |
| DECIDING | an action or row that asks first | the focused of `[No] [Yes]` | answers No | `←`/`→` switch |
| BUSY | an action whose handler is in flight | ignored on the busy action | `close` | the busy action shows `…` and is skipped by navigation |
| EXPANDED | `Ctrl+E` on a scroll region | — | `collapse` | scroll keys |

When the work ends, BUSY settles: success leaves the surface; an invalid or failed
result returns to BROWSING with feedback painted where the problem is; a cancellation
returns silently. Modes do not nest except EDITING/PICKER inside a form and DECIDING
over any mode. A surface with unsaved edits asks `Discard unsaved changes?` (No first)
before `Esc` closes it.

### 3.2 The hint row and key vocabulary

The hint row is one muted line at the bottom of a capturing surface, indented two
columns, fragments joined by ` · `, each fragment `Keys label`. It is computed from the
same ordered binding list that dispatches keys, never authored, so it cannot name a
dead key and updates with every state change.

- **Which fragments survive** when the row is full (three below 80 columns, four from
  80): `Esc` first, then the primary operation and the filter, declared accelerators,
  adjustment, navigation, the digit range, tabs and clear, then group moves.
- **Where they sit:** navigation, adjustment, the primary operation, everything else,
  group moves, and `Esc` always last, so the row reads "what I can do … how I leave".
- **Style:** the key in `text`, its label in `textMuted`, so the eye lands on the key.
- **Notation:** `Enter`, `Esc`, `Tab/Shift+Tab`, `Space`, `↑/↓`, `←/→`, `Alt+←→`,
  `PgUp/PgDn`, `Ctrl+U`; ranges as `1-3`; the word `Type` for type-to-filter and a bare
  `/` for slash-to-filter (§3.4).
- A hint never names a button that is not on screen, and an editor decoration gets no
  hint row of its own.

Representative rows:

```
action group focused    ↑/↓/←/→ actions · Enter run · Tab/Shift+Tab groups · Esc close
single action           Enter run · Esc close
tab strip focused       ←/→ tabs · Enter open · Esc close
select picker open      ↑/↓ options · Enter apply · Tab/Shift+Tab groups · Esc cancel
text field, editing     Enter next · Tab/Shift+Tab groups · Esc done
list, filtering         Enter choose · Ctrl+U clear · Esc end search
list row with strip     ←/→ thinking · Enter choose · Type filter · Esc close
```

Per-state footers for one surface (computed, shown here for the design):

```
idle, choose list         Enter choose · 1-3 choose · Esc close
searching                 Enter choose · Ctrl+U clear · Esc end search
field focused             Enter submit · ↑/↓ fields · Esc close
field editing             Enter next · Tab/Shift+Tab groups · Esc done
picker open               ↑/↓ options · Enter apply · Esc cancel
decision open             ←/→ actions · Enter confirm · Esc close
one action busy           ←/→ actions · Esc close              (the action shows …)
```

**Vocabulary.** These are the only words a fragment uses; a surface does not invent a
synonym.

| Verb | Means | Used for |
| --- | --- | --- |
| `choose` | pick this row and commit | choose lists, decisions, pickers |
| `open` | descend into detail | browse lists, tab strip |
| `run` / `confirm` | execute an action / answer the decision | actions row |
| `apply` | commit an open picker | select picker |
| `submit` / `next` | write the form / commit this field and move | text fields |
| `toggle` | flip a checkbox-like value | toggle, multiple lists |
| `adjust` / `options` | step a select value / move the candidate in an open picker | select field |
| `edit` / `reset` | start typing / restore the origin value (`use inherited` when it has one) | text fields |
| `branch` | open or close a tree branch | tree lists |
| `expand` / `scroll` / `newline` | open a scroll region / move through it / insert a newline | scroll regions, textareas |
| `filter` / `tabs` / `groups` | start filtering / move along tabs / jump between control groups | lists, tab strips, any surface with an actions row |
| `<segment label>` | step the row's strip (lowercased label) | `←/→ thinking` |
| `copy` / `delete` / `refresh` / `search` / `save` | the common meanings (§3.5), always these words | stream rows, lists, forms |
| `open in editor` / `open diff` | hand the content to `$EDITOR` (`external`, §3.5) | edits, plans, trace events |
| `select` / `stream` | move focus up into the conversation stream | the stream's own hint row (`Alt+↓ prompt`) |
| `history` / `queue` | recall earlier messages, queued ones first | the prompt (`↑/↓ history`) |
| `Esc` words | `collapse` `cancel` `done` `end search` `back` `close` `leave` | the current layer |

### 3.3 Where key cues live

The status area is **two rows** (§5.1): row 1 carries facts (model, mode chips, context, directory, branch,
balance) and row 2 carries views (agents, jobs, goal, todo). Neither carries keys. Every key cue sits with the
thing it acts on, so the screen never repeats a sentence and the user never has to look somewhere else:

| The key belongs to | Its cue lives in | Example |
| --- | --- | --- |
| a capturing surface | that surface's hint row (§3.2) | `Enter open · Type filter · Esc close` |
| a view | the view panel's own hint row | `Enter open · x stop · Esc back` |
| a stream row | the hint row, once the stream has focus | `Enter expand · c copy · Ctrl+G open in editor` |
| the completion list | the last line of the list | `↑/↓ options · Tab complete · Enter run · Esc close` |
| a foldable block | the block's own summary row, on the newest block | `▸ Took 6s · 2 tool calls · Ctrl+O expand` |
| the running turn | the **activity row's right gap** (§5.3) | `Esc interrupt · Ctrl+O expand` |
| the typed prefixes `/` `@` `#` `!` | the **editor's empty-state placeholder** | `Ask anything · / commands · @ files · # skills · ! shell` |

A setting can quiet these cues for experienced users: `minimal` keeps only interrupt,
`Ctrl+O`, and `F7`/`F8`, and `off` removes the gap cue and the placeholder.

An idle screen renders no tip and no key row: it teaches through the placeholder only,
and tips rotate in the gap of the `Deep diving` row, never while idle.

**The placeholder.** The dimmed ghost text of an empty prompt teaches the four typed
prefixes. It lives inside the content row (the frame still carries only the conversation
title, in its top-right corner), costs no row, and disappears on the first keystroke. It is state-driven, longest
variant first, and whole triggers only (it never cuts `# ski…`):

| State | Variants, longest first |
| --- | --- |
| Main, idle | `Ask anything · / commands · @ files · # skills · ! shell` → `… # skills` → `… @ files` → `Ask anything · / commands` → `Ask anything` |
| Main, running | `Type a follow-up to queue it · @ files · # skills` → `Type a follow-up to queue it` |
| Shell mode | `Run a shell command · Esc leaves shell mode` |
| Side question | `Continue the side question · @ files · # skills` → `Continue the side question` |
| Subagent, live | `Message <name> · @ files · # skills` → `Message <name>` |
| Subagent, resumable | `Reply to <name> — sending resumes it` |
| Read-only conversation | `Read-only conversation` |

It is `textMuted`, takes no key styling, never appears in a multi-line buffer or under
an IME composition, and a command argument hint wins over it. The editor frame carries
no hint, badge, or mode text: **input mode is the prompt symbol and the frame's border color** (shell mode
draws `!` and an accent border), never a chip.

**Mode chips.** Session modes are status, so they sit in status row 1 next to the model they modify, bold in
their own tone (no merged "highest alert" hue):

```
  normal      deepseek-chat High
  plan        deepseek-chat High  PLAN
  yolo        deepseek-chat High  YOLO
  plan+yolo   deepseek-chat High  PLAN  YOLO
```

`PLAN` is primary, `YOLO` is warning; `PLAN…` marks a pending toggle. Chips outrank the other row 1 entries
when the row is full, and a chip never carries a "dirty" word. The way to change a mode is a key cue in the
activity gap or a tip, never text on the chip.

**Side conversations.** A BTW or a subagent shown in the main view keeps the same
editor, with its access reflected in the placeholder (live, resumable, read-only). Its
identity (`BTW … ⇄ MAIN`, `SUBAGENT reviewer · read-only`) stays in status row 1's
center band, and `F7 switch · F8 close` / `F8 detach` sit in the view row's right
cluster whenever two or more conversations exist (§5.1). `F8` names what it does:
closing a BTW disposes its temporary agent (`close`); closing a subagent only
detaches the view (`detach`). With no counterpart the keys are absent.

### 3.4 Keyboard parity, filters, confirm and undo

The same key means the same thing in every panel:

| Key | Action | Meaning |
| --- | --- | --- |
| `↑` `↓` | `ui.up` `ui.down` | move (rows, fields) |
| `←` `→` | `ui.left` `ui.right` | switch tab or column, cycle a select, step a number, collapse or expand a row |
| `Enter` | `ui.accept` | the primary action of the focused row |
| `Space` | `ui.toggle` | toggle |
| `/` | `ui.filter` | filter |
| `Ctrl+S` | `ui.save` | save the form (the one `Save`, §4.3) |
| `c` | `ui.copy` | copy the focused row, plan, or event |
| `r` | `ui.refresh` | refresh or retry |
| `x` | `ui.delete` | the destructive action: remove, stop, sign out, delete (always behind a confirm) |
| `Ctrl+G` | `ui.external` | open the focused content in `$EDITOR` |
| `Ctrl+F` | `ui.search` | search the whole conversation or the whole list |
| `Esc` | `ui.cancel` | back one layer |

Every row of the table is a named action (§3.5): the key is its default, not its identity.

**Filtering and accelerators.** A list has one of two filter behaviors. A command
picker (`/model`, `/effort`, the completion list) *types into the filter*, so it binds
no printable accelerators. A panel that offers bare-letter operations (`i` install,
`x` remove, `r` refresh, `c` copy) filters only after `/`, so letters are free;
its hint row shows `/ filter`. A given list never does both.

**Confirm or undo.** A reversible local action (delete a session, withdraw a queued
message) happens at once and offers `u undo · 8s`. An irreversible action, or one that
reaches outside the app (sign out, remove a plugin, full access, stop a job), asks the
shared Yes/No with No focused first. A typed confirmation phrase is never used. A
destructive key always opens the shared decision:

```
  Delete provider?
  Removes the stored credentials.
→ [No]   [Yes]
```

### 3.5 Key semantics and rebinding

A key never means anything by itself. Every key the runtime dispatches belongs to a **named action**, and the key
is that action's current binding. This is what lets Mayfly, a plugin, and a user share one vocabulary and still
disagree about which physical key does what.

| Kind | Named like | Defined by | Examples |
| --- | --- | --- | --- |
| Navigation | `ui.up` `ui.accept` `ui.cancel` `ui.toggle` `ui.tab-next` `ui.focus-prev` | the kit | the arrows, `Enter`, `Esc`, `Space`, `Alt+←/→`, `Alt+↑/↓` |
| Common meaning | `ui.save` `ui.copy` `ui.delete` `ui.refresh` `ui.external` `ui.search` | the kit | `Ctrl+S` saves any form, `x` deletes the focused row, `Ctrl+G` opens `$EDITOR` |
| Component action | `<component>.<action>` | the component or plugin | `demo-plugin.install` (`i`), `trace.copy-all` (`a`) |

An action item declares **what it means**, not which key it uses:

```
{ id: 'remove', semantic: 'delete', label: 'Remove', hidden: true, confirm: {…} }   // the key is ui.delete's binding
{ id: 'install', action: 'demo-plugin.install', key: 'i', label: 'Install' }        // a component action with a default
```

- **Common meanings** are one action across the product. A form that has a `Save` button and a list that deletes
  rows use `ui.save` and `ui.delete`; rebinding `ui.delete` to `d` moves every delete in every panel, Mayfly's
  and plugins', at once. A kit form that offers no `Save` action still answers `ui.save`.
- **Component actions** carry their default `key`. They are what a plugin adds, and a user can rebind them too.
- **Rebinding is runtime state, not a node.** The consumer calls `keymap.bind(actionId, keys)`,
  `keymap.reset(actionId)`, or `keymap.resetAll()`; nodes stay plain data. `keymap.list()` returns every action the
  runtime has seen, with its label, default keys, and effective keys. Mayfly stores the overrides in its settings
  and applies them at startup.
- **The hint row follows.** Hints read the effective key, so after a rebind every cue shows the new key and the old
  one stops working (a key that is rebound away is dead, not an alias).
- **Alt is never the only way.** Terminals, multiplexers, and OS settings often swallow or rewrite Alt (macOS Option
  composes characters, some multiplexers consume `Alt+arrows`). Every default that uses Alt has a second default
  without it: `Alt+←/→` tabs are also `F2`/`F3`, `Alt+↑/↓` focus is also `F4`/`F5`, and `Alt+Enter` newline is also
  `Ctrl+J`. The decoder accepts every common encoding of a modified key (the xterm `ESC [ 1 ; 3 A` form with or
  without a kitty event type, a bare `ESC` prefix, SS3, kitty `CSI u`, modifyOtherKeys). A host that cannot deliver Alt
  lets the hint rows show the plain key first (`keymap.preferPlain`); the prototype switches by itself the first time
  an `F2`-`F5` key arrives, or with `--no-alt`.
- **Guards.** A binding that collides with another action in the same scope is refused with the owner's name. A bare
  printable key cannot be bound to an action beside a type-to-filter list or while a text control has focus
  (§3.4); `Esc` and `Enter` cannot be unbound.
- **Scope.** A hidden action list may declare `scope` (a control id): it acts, and shows its hint, only while that
  control has focus. The conversation stream's `c copy` and `Ctrl+G` work from the stream, never from the prompt.

The `/keys` panel (§5.15, scene *Keybindings*) lists every action grouped as common meanings, component actions,
navigation; `Enter` captures the next key, `Delete` restores the default, and the demo plugin panel under it shows its own hint
row following the rebind.

## 4. Basic components (the UI API)

The basic components are the whole UI vocabulary. Each entry gives the builder (its props, in design notation),
what it paints in each state, its keys, and the prototype scene that draws it. They are plain data: a node never
holds a function, a color, a width, a focus handle, or a key binding. Renderer state (cursor, focus, drafts,
scroll position, clocks) lives in the runtime, and the runtime turns user input into the structured events of
§4.10. Mayfly components (§5) and plugins call these builders and nothing else.

| Builder | What it is | Scene |
| --- | --- | --- |
| `ui.text` `ui.richText` `ui.fields` `ui.markdown` `ui.code` `ui.diff` `ui.sections` `ui.chart` `ui.diagram` `ui.spacer` `ui.divider` | content (§4.1) | Content |
| `ui.actions` | operations, row keys, and the shared decision (§4.2) | Actions |
| `ui.form` `ui.prompt` | text, choice, and number fields; the prompt with tokens, history, and completions (§4.3) | Fields and forms, Editor |
| `ui.list` | menus, pickers, inventories, trees, accordions, segment strips (§4.4) | Lists |
| `ui.tabs` | tab strips, wizards, vertical rails (§4.5) | Tabs, wizards, rails |
| `ui.surface` `ui.scroll` | chrome and scrolling (§4.6) | Surfaces and scroll |
| `ui.stack` `ui.child` | layout, ladders, priority admission (§4.7) | Layout |
| `ui.loader` `ui.progress` `ui.empty` | waiting, progress, nothing to show (§4.8) | Feedback and progress |
| patterns: `decisionPanel` `railPanel` `splitView` `statusPage` | recipes built from the above (§4.9) | Patterns |

### 4.1 Content

```
ui.text(content, { tone?, styles?, overflow?: 'wrap' | 'truncate' | 'middle' | 'start' })
ui.richText(spans, { overflow? })           span: { text, tone?, styles?, motion?: 'shimmer' }
ui.fields(rows)                              row: { label, value: string | span[] }
ui.markdown(source)   ui.code(code, { language?, numbered? })   ui.sections([{ title?, body, collapsed? }])
ui.diff(before, after, { start?, numbered?, hunkHeader?, context?, maxRows? })
ui.chart({ chart: 'sparkline' | 'bar' | 'line' | 'point' | 'heatmap', … })   ui.diagram(source)   // heatmap: { cell?: 1 | 2, columnLabels?, levels }
ui.spacer(size?)   ui.divider(label?)
```

Content is static: it takes no focus and owns no keys. Pick the narrowest form that says it.

| Content | Look |
| --- | --- |
| text | one tone per run (default, muted, primary, accent, user, success, warning, danger); wraps, or truncates to one ellipsized row |
| rich text | mixed tone and weight in one run (`strong`, `italic`, `strike`); the shape of every status entry and hint |
| fields | `label:` muted, then the value; the key/value panels (status, account) |
| sections | a bold `primary` title then a body; a collapsed section is its title row only |
| code | a muted language name, then the lines; highlighted by language (on by default); `numbered` adds a line-number gutter (the Write card, the trace JSON) |
| diff | two numbered gutters (old, new), `−`/`+` plus a **red background behind the removed code and a green one behind the added code** (the band covers the sign and the text to the full width; the line-number gutter is never tinted), `⋯` between hunks, an `@@` header when more than one hunk |
| charts | sparkline (one row), bars (grouped, stacked, normalized; horizontal or vertical), line and point, heatmap with a legend row (`cell: 1` draws one-cell columns, 26 weeks in 26 cells) |
| diagram | a flowchart or state diagram as ASCII within a size budget, falling back to its source |
| spacer, divider | vertical rhythm: a blank row or a rule, optionally labelled |

```
sparkline   tokens ▁▂▃▅▇▆▃▂
bar         mon  ██████░░░░ 62        tue  ███░░░░░░░ 31
heatmap     Mon ·░▒▓█▒░··░▒▓       · none ░ light ▒ some ▓ busy █ peak
diagram     ┌─────────┐     ┌─────────┐
            │  queue  │────►│  agent  │
            └─────────┘     └─────────┘
```

Rules: never encode layout in spaces; tone plus a glyph or a word carries meaning; every
row fits its width and a renderer failure degrades to a bounded text summary, never an
overflowing row. The Content scene draws each form.

### 4.2 Actions

```
ui.actions({ id, scope?, items: [{ id, label, intent?: 'primary' | 'danger', key?, semantic?, action?, hidden?, busy?, disabled?,
  disabledReason?, confirm?: string | { title, detail?, tone? }, submit?, dismiss?, hintLabel? }] })
```

An actions row holds the operations of a surface. By the redundancy test (§1.1) it
holds only what a bare key does not already do: a secondary write, a destructive
action, or a choice between two equally valid commits.

```
  [ Save ]   Copy (c)   ! Delete provider
    ↑ primary   ↑ accelerator shown as (c)   ↑ danger

→ [ Save ]                        focused: inverted + cursor marker
  … Saving                        busy: muted, skipped by navigation
  Delete provider — archive it first     disabled: muted, reason after " — "
  [ Save ]   +2                   narrow widths fold hidden tokens into +N
```

`Enter` or `Space` runs the focused action, arrows move between actions, a declared
accelerator `(c)` fires from anywhere on the surface, and `Tab`/`Shift+Tab` enters or
leaves the group. A busy action keeps its verb, loses its button (`… Saving`), and is
skipped by navigation. An unavailable action is shown disabled with its reason, never
rejected after the fact. An operation may also exist with **no button at all**: it runs
from its key and the key sits in the hint row (the account panel's `Ctrl+Y copy link`).

**Row operations are keys, never buttons.** What acts on the focused row of a list (delete, stop, copy, install) is a
`hidden` action bound to a common meaning (`semantic: 'delete'` is `x`, `'copy'` is `c`, §3.5) or to a component
action (`i`). It has no button and no focus stop, its key sits in the hint row while the row can take it, the
row's `unavailableActions` entry says why it cannot (the key shows `⚠ built-in providers cannot be deleted` instead
of acting), and a destructive one asks the shared decision first. A consumer that rebinds `ui.delete` moves every
such key.

**The shared decision.** Every Yes/No question looks the same: No is focused first and
`Esc` answers No.

```
  Delete provider?
  Removes the stored credentials.          ← optional detail (warning)
→ [No]   [Yes]
```

Rules: put the default focus on the least destructive action; a destructive action
(`! Delete provider`) always asks; never draw `Cancel` on a surface `Esc` already
closes, a `Delete` or `Stop` button beside a list that `x` already serves, a primary action that repeats what `Enter` on the row does, or `Next`/`Back`
beside a wizard strip that `Alt+←→` already walks.

### 4.3 Fields and forms

```
ui.form({ id, fields, enterSubmits?, submitLabel? })
field: { id, kind: 'input' | 'textarea' | 'secret' | 'number' | 'select' | 'multiselect' | 'toggle', label, value,
         placeholder?, help?, group?, required?, pattern?, suggestions?, origin?: 'inherited', resetValue?,
         options?, min?, max?, step?, unit?, disabled?, disabledReason? }
ui.prompt({ id, symbol?, symbolTone?, value?, tokens?: [{ id, label, size? }], recall?: [{ kind: 'queued' | 'history', text }],
            placeholder?: string | string[], completions?: { items }, reset?: { rev, value }, submitLabel?, recallLabel? })
```

**Text fields.**

Text, textarea, secret, and number fields:

```
  Name: e.g. production          placeholder (muted) while the value is empty
  Name: foo                      filled
→ Name: foo                      focused
→ Name: fo▌                      editing (▌ is the terminal cursor)
   ! Required                    error, repainted from an invalid result
  Token: •••••                   secret never echoes plaintext
  Timeout: 30 s                  number renders its unit
  Region: us-east (Inherited)    origin field; shows (Override) once edited
```

Typing or `Enter` starts editing; `Enter` commits and moves on (or submits a
single-field form); `Alt+Enter` inserts a textarea newline; `Esc` ends editing and keeps
the draft. `Delete` on a focused field whose value differs from its origin restores it,
and the `reset` / `use inherited` hint appears only while that would change something.
A number steps with `←`/`→` or takes typed digits, and shows its unit and range. A
focused textarea expands. A secret is never echoed and reads `(saved)` when set. A path
field completes with `Tab`.

**Choice fields.**

A choice is a select (one of N), a toggle (on or off), or a multiselect (some of N);
there is no radio or checkbox.

**Select** switches options without opening anything:

```
  Protocol: Choose…                       unset
→ Protocol: ‹ anthropic-messages ›        focused: ← → cycle the value
→ Protocol                                picker open (Enter)
     ○ openai-completions
   → ● anthropic-messages
     ○ custom — not available in this plan
```

`←`/`→` cycle the value without wrapping and skip disabled options (the fastest path:
two keys, no dialog); `Enter` opens the picker for the full list; `↑`/`↓` always move
between fields, never the value.

**Toggle** flips directly:

```
→ Notifications: [on]      Enter or Space flips to [off]
```

**Multiselect** opens with `Enter` or `Space`, never implicitly:

```
→ Channels: mentions, errors     collapsed value (or "None selected")
→ Channels                       open:
   → ● mentions                    Space toggles the candidate
     ○ errors                      Enter applies the toggled set
     ○ digest — enterprise only    disabled option with its reason
```

**Forms.**

A form is the shared field kinds with field state made implicit: `•` marks an edited
field, `(inherited)`/`(override)` is text, secondary operations are keys in the hint row
only while they apply, and a focused select wraps its value `‹ auto ›`. There are no
per-field buttons.

```
╭ Edit provider ────────────────────────────────── unsaved changes ╮
│ ── Connection ──────────────────────────────                     │
│   Name:        production                                        │
│ → Endpoint:    https://api.example.com/v1                        │
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
│   [ Save ]                                                       │
│ ↑↓ field · ←/→ cycle · Enter edit · Delete reset · Esc close     │
╰──────────────────────────────────────────────────────────────────╯
```

Fields group under `── heading ──` rules, a focused field may show a one-line help
under it, and an error paints under the field as `! message` once the value is edited.
The finish row is one primary `Save`, and `Ctrl+S` (`ui.save`, §3.5) saves from any field, so a form that omits the
button still saves; `Esc` closes (asking `Discard unsaved changes?` if there are edits), so there is no `Cancel`.

**The prompt** is the one text control that is not a field: a symbol, the buffer, and **tokens inside the buffer**.
An attachment, a pasted block, and an `@` mention are all `[label size ×]` tokens in the input row, not chips around
it. Its keys:

| Key | Does |
| --- | --- |
| typing | edits the buffer; a leading `@`, `/`, or `#` word offers completions (`↑`/`↓` move, `Tab` or `Enter` inserts, `Esc` closes) |
| `Backspace` on an empty buffer | the first press **selects** the last token (inverse), the second **removes** it (`token-remove`); any other key deselects |
| `↑` / `↓` on an empty buffer | recall: queued messages first, then history, newest first; the corner reads `↑ history 2/4`; `↓` returns to the draft |
| `Enter` / `Alt+Enter` | send (or queue while the agent runs) / newline |
| `Alt+↑` | move focus up into the conversation stream (§5.6) |

```
╭────────────────────────────────────────────────── Update the landing page hero ╮
│ > [Image #1 84 KB ×] [notes.md 2 KB ×] explain @pane-act▌                      │
│ → @pane-activity.ts — packages/mayfly/src/transcript/                          │
│   @pane-agents.ts — packages/mayfly/src/transcript/                            │
╰────────────────────────────────────────────────────────────────────────────────╯
```

### 4.4 Lists

```
ui.list({ id, role: 'browse' | 'choose', mode?: 'single' | 'multiple', items, selectedIds?, filterable?, filterMode?: 'type' | 'slash',
  numbered?: true | 'focus', tree?, marker?: 'cursor' | 'selection', marks?, maxRows?, expandFocused?, acceptVerb?, autofocus?,
  focusItem?: { id, rev }, empty? })
item: { id, label: string | span[], detail?: string | span[], badge?, right?, rightFocus?, group?, parentId?, body?: string | node,
        bodyAlways?, wrap?, meter?, indent?, block?, rule?, gap?, disabled?, disabledReason?, confirm?, unavailableActions?,
        segment?: { label?, options, selectedId?, inheritedId? } }
```

A list is the one component for menus, pickers, inventories, trees, and accordions.
Its **role** decides what `Enter` means: a *choose* list picks the row into a draft
(`choose`); a *browse* list opens it (`open`). A picker that commits on `Enter` (the
model picker) says `choose` in its hint even though it is a browse list: the hint
names the real effect.

Filtering, groups, badges, and details. While filtering, the list shows a live match count
(`2 matches`), a long list shows its scroll position (`↑2 / ↓7`), and an empty result names
the next step:

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
     cursor `→` on the focused row · disabled row shows its reason
```

Numbered choose list (up to nine options); a digit picks a row, and the hint shows the
real range:

```
→ 1  Preset endpoint — known provider
  2  Custom endpoint — any compatible URL
  3  OAuth provider — browser sign-in

  Enter choose · 1-3 choose · Esc cancel
```

Choose lists mark the chosen row `●` and the rest `○` (single or multiple, §2.2), and a minimum and maximum bound a
multiple set:

```
→ ● mentions                     Space toggles, Enter commits
  ○ errors
```

**Tree and accordion.** One list covers a tree (parents with tri-state children) and an
accordion (a row that expands to text). The current row keeps the `→` and a bold label;
columns align (name, status, right-aligned count); checked children read normally and
unchecked ones dim:

```
 MCP SERVERS  4
  ▾ ◐ filesystem        ✓ connected · 120ms          4 tools
   │ ● read_file         Read a file from disk
   │ ● write_file        Create or overwrite a file
   │ ○ delete_file       Remove a file               ⚠ dangerous
   ╰ ● list_dir          List a directory
  ▸ ◐ github            ✓ connected · 340ms         12 tools

 SKILLS  2
  ▸     plugin-author   preset     Prototype a plugin in-process,
  ▾     preset-author   preset
    │ Compose your own presets from the
    ╰ built-in services and panels.
```

`Space` toggles the check (a parent toggles all its children); `→` expands and `←`
collapses; `Enter` expands or collapses a parent and toggles a leaf; `*` and `-` expand
and collapse everything. A row with no check, such as a skill, expands on `Space`
too. A long group ends in a "loads more" row.

**Segment strip.** A row may carry a horizontal option bar, such as the thinking effort
of a model row. `←`/`→` steps it (clamped, no wrap, skipping disabled tokens). The strip
shows only on the focused row, so no row grows. Unpinned is a real state: the inherited
token is active and carries `(default)`; stepping back onto it unpins; `Delete` unpins
directly. It degrades by dropping `(default)`, then the label, then folding far tokens
into `+N`, then moving to a reserved footer line, and last by showing the active token
alone:

```
inline (the strip shares the row; the row count never changes)
→ DeepSeek/DeepSeek-V4-Pro — 977k context   min ‹ high (default) › max

footer (the row plus its strip cannot fit: one line reserved under the list)
→ DeepSeek/DeepSeek-V4-Pro — 977k context
  ⋮
   Thinking: min ‹ high (default) › max

folded (many options: nearest neighbours stay, the rest become +N)
→ some-model — 128k context                 ‹ medium › high +2
```

Keys on any list: `↑`/`↓`, `PgUp`/`PgDn`, `Home`/`End` move and skip disabled rows (so
`Enter` can never accept one); `Enter` chooses or opens; typing (or `/`, §3.4) filters,
`Ctrl+U` clears, `Esc` ends the search keeping the filter; `←`/`→` adjust a strip,
open or close a branch, or leave the list toward the nearest control (§4.5). A row can mark a key
unavailable (`unavailableActions`: the key is dimmed with its reason while that row is focused, so `x` on a built-in
provider says why it cannot) and can ask the shared Yes/No before it is accepted. `meter` draws a small proportional
bar on the row (the trace's duration, 6 cells); `wrap` lets a row take several lines (an answer in the stream);
`focusItem` moves the cursor to a row from outside (a search match), opening its parents. `indent` pads a row and its body
(the hanging indent below the user's prompt), `gap` is a blank row, `rule` is a muted full-width rule with right-aligned
text, and `block` makes the row a wrapped block of text with an optional bar, background band, or titled card and a
`maxLines` cap (`block: { bar?, band?, card?, lead?, maxLines? }`). Gap and rule rows are never selectable.

### 4.5 Tabs and rails

```
ui.tabs({ id, items: [{ id, label, count?, attention?, disabled?, group?, clip? }], activeId,
         mode?: 'tabs' | 'wizard', orientation?: 'horizontal' | 'vertical', hintLabel? })
```

**Text color, never a filled background.** The focused tab is bold `primary` with a
heavy `━` rule beneath it; without focus it keeps its color but loses weight and the
rule dims; idle tabs and counts are muted; `!` is warning. Contrast is a design rule:
every tab text color is at least 4.5:1 against its theme background (a guard test in the
implementation asserts it).

```
  Overview   Usage 3   Connections !   Skills 12   About
             ━━━━━━━
  ✓ Kind  ›  ✓ Connection  ›  ● Models  ›  ○ Review             wizard steps
  ‹ Usage 3  Connections !  +3 ›                                 narrow: the active tab stays visible
```

`←`/`→` move along a focused strip and `Enter` descends into the page; `Alt+←`/`Alt+→`
switch tabs from anywhere outside text editing and open pickers. A **wizard** is an
ordered strip with step marks derived from position (done, current, to come); `Esc`
walks back, and a forward switch runs the same validation as the step's own Next, so an
invalid step cannot be skipped by any path.

**Vertical rail.** For many labels (sessions by workspace, settings by group) the strip
becomes a rail on the left with the content on the right. The content follows the cursor
live (preview, then commit), `→` or `Enter` enters the content, and `←` leaves it by the ladder below; the
active row is strong `primary` while the rail has focus and regular when focus is in
the content:

```
  SESSION                  group headings, → on the selected label, counts right-aligned
   General
   Model
  → Permissions     2
  INTEGRATIONS
   Providers        !
```

With only two to four short labels prefer the horizontal strip.

**The `←` ladder (inner to outer).** A panel has levels: the rail, a content control, and sometimes a field inside it.
`←` moves out exactly one level, innermost first, and the rule is the same on every panel:

1. The focused control gets `←` first. A select adjusts its value, a number steps down, a tree row collapses, a
   text field moves its caret, a segment strip steps. If it used the key, nothing else happens. A control that is
   already at its end stop (the first option, the minimum) did not use the key.
2. A `←` the control did not use moves focus to the **rail of the surface**, wherever the rail sits in the focus
   order. It does not matter whether the previous control in tab order is the rail, or how many controls are
   between them.
3. On the rail, `←` has no further level to leave: it does nothing (it never closes the panel). `Esc` is the key
   that leaves a layer, and it does so at every level: from a field it returns to the content control, from the
   content to the rail, from the rail it closes.

`Shift+Tab` always steps to the previous control and `Alt+←` always switches the tab strip, so there is no state
where the user is stuck. The hint row shows `← labels` whenever `←` would reach the rail and omits it where a control
consumes `←`, so the cue is true.

The intermittent failure this rule removes had two causes: the engine only looked at the control *immediately*
before the focused one, and a select, number, or segment at its end stop swallowed `←` without changing anything. A
control now uses `←` only when it actually changed something.

### 4.6 Surfaces, scroll, and chrome

```
ui.surface({ title?, titleAlign?: 'left' | 'right', hint?: 'none' | 'completions', subtitle?, badges?, chrome?: 'overlay' | 'surface' | 'lane' | 'none', border?: tone,
             child, footer?, escapeLabel?, dismissal? })
ui.scroll({ id, child, height?, expandedHeight?, fit?, follow?: 'end' | 'none', scrollbar?, marks?, currentMark?, pill?, reveal? })
```

```
╭ Approve bash? ─────────────────────────────────────────╮
│ optional subtitle (muted)                              │
│ [badge] [badge]                                        │
│                                                        │
│ → focused row (inverted)                               │  ← content
│   ordinary row                                         │
│                                                        │
│ optional custom footer                                 │
│   Enter run · Tab/Shift+Tab groups · Esc close         │  ← hint row (muted)
╰────────────────────────────────────────────────────────╯
```

Four chromes: **overlay** (rounded, focus border color), **surface** (rounded, quiet
border color), **lane** (rules only, as a decision card in the stream), and **none** (a bare
bold title, as the views panel). `titleAlign: 'right'` moves the title into the top-right corner (the editor's
conversation title) and `border` recolors the frame (the editor's shell mode); both keep the glyphs the same. A scroll
with `fit` shrinks to short content and shows its scrollbar only when it overflows. A header badge on the right of the title rule carries a
short state (`unsaved changes`, `step 2 of 4`, `1 of 3 waiting`). A scroll region keeps
its tail in view while following, shows a scrollbar, and expands with `Ctrl+E` (`Esc`
collapses). Narrow widths drop the subtitle and badges before the title.

### 4.7 Layout, admission, and placement

```
ui.stack.row(children, { gap? })     ui.stack.column(children, { gap? })
ui.child(node, { basis?: number | 'auto', grow?, shrink?, minSize?, maxSize?,
                 when?: { minWidth?, maxWidth?, minHeight?, maxHeight? },
                 priority?, band?: 'left' | 'right', overflow?: 'hide' | 'truncate' })
```

A row lays its children out in flex fashion: a fixed `basis`, a share of the free space (`grow`), a share of the
shortfall (`shrink`). `when` shows a child only while the viewport satisfies its bounds, so a width ladder is
several children with disjoint ranges and a plugin never reads a width. **Priority admission** gives the status
bar and the activity row their behavior from one primitive: children with a `priority` (lower is kept first) are
admitted while they fit; a child marked `hide` drops out instead of truncating; once the row is full, later
children are dropped; admitted children lay out in their `band`.

Authors do not size or place anything: they choose a placement and the renderer owns width,
focus, and narrow behavior.

- **Overlay.** Floating (anchored center, top, bottom, left, or right, with a width and a
  maximum height in cells or percent) or *editor-presented* (it takes the editor's slot, as
  help and rewind do). A capturing overlay takes keys and closes on `Esc`; a display-only
  overlay holds no interactive control. A surface with unsaved edits asks before closing.
- **Panes.** A pane sits in the header, left, right, or the bottom dock. Panes in the dock
  stack by priority, a pane with nothing to say renders zero rows, and a side pane says
  what it becomes on a narrow terminal: it moves to the dock, becomes an on-demand overlay,
  or hides. Built-in panes are passive; an interactive pane is reached with `F6`.
- **Status area.** Two rows, each its own component (§5.1). Entries sit in a left or right band and are admitted in
  priority order across the row; an entry marked *hide* drops out instead of truncating, and once the row is
  full later entries are dropped.
- **Width ladders.** A layout is several variants with disjoint width (or height) ranges;
  the renderer picks the one that fits, so a screen never reads its own width. The
  marketplace, the status footer, and the activity row are all ladders.
- **Editor decorations.** An extension may draw content before or after the buffer, a
  one-line hint, diagnostics under the editor, and actions bound to modifier keys only. It
  may supply completions for `/`, `@`, `#` and a manual trigger, and may rewrite the text
  and attachments (`[Image #1 84 KB ×]`) on submit. It gets no hint row and no focus of its own.

The Layout scene draws a width ladder, priority admission, and a windowed list; the Status area and Editor scenes draw the same primitives in use.

### 4.8 Loader, progress, and empty

```
ui.loader({ variant?: 'bloom' | 'fill' | 'gap' | 'breath', message?, elapsedMs?, cancelActionId? })
ui.progress({ value, max, label?, width?, style?: 'cells' | 'rule', tone?, showCount?, showPercent? })
ui.empty(title, { description? })
```

Indeterminate work shows the gap spinner with what, where, and the elapsed time, and its
cancel is a hint, never a button. Determinate work shows `▰▱` cells with `n/N`. A bar
never appears for an unknown duration: an eased bar that never completes is a fabricated
estimate. Waiting on an external action breathes (§2.3). Settled forms are static.

```
⣾ Discovering models from api.example.com  12s       indeterminate
  Esc cancel
● Waiting for authorization · 45s                     waiting on an external action
Building ▰▰▰▰▰▰▱▱▱▱ 6/10                              determinate
✓ Discovered 14 models · 2.1s                         settled
✗ Discovery failed: 401 Unauthorized  r retry         failed; the retry is a key
⊘ Cancelled
```

An **empty** list or page says what is missing and the next action, in muted text:

```
No sessions found
Restore a checkpoint with /rewind
```

### 4.9 Patterns

A pattern is a recipe built only from the primitives above. It has no renderer of its own: it returns a node tree.
Core and plugins reuse the same four.

| Pattern | Composition | Used by |
| --- | --- | --- |
| `decisionPanel` | `surface` (overlay) + preview + a numbered `list` (choose) + an optional same-line `form` + hidden accelerator `actions` | approval, plan review, permission, any plugin's yes/no/other question |
| `railPanel` | `surface` + a vertical `tabs` rail + live content in a row stack | sessions, settings, any plugin with groups |
| `splitView` | a `stack` row of a list and a detail with a width ladder (`when`) | the marketplace, any list-and-detail panel |
| `statusPage` | `surface` + `tabs` + `fields` | the status panel, any read-only key/value page |

The decision skeleton and its two open variants are specified in §5.7.

### 4.10 Focus, keys, and events

One key engine drives every basic component, which is why a hint is always true and the same key means the same thing
everywhere (§3). It owns focus, cursors, drafts, scroll positions, and the hint row; none of that is ever in a node.

- **Focus** moves between controls in tree order with `Tab`/`Shift+Tab`; a control marked `autofocus` starts with
  focus; a list hands `↑`/`↓` to the next control at its edges and `←`/`→` to a neighbouring tab strip.
- **Accelerators** are `actions` bound to a key, either a component's own `key` or a common meaning (`semantic`,
  §3.5), active anywhere on the surface (or only while a `scope` control has focus). A printable key is rejected on a
  surface that holds a type-to-filter list and is never offered while a text control has focus; use
  `filterMode: 'slash'` or a modifier key (§3.4).
- **Rebinding** is consulted on every key: the engine resolves the physical key to an action through the keymap
  (§3.5), so rebinding changes dispatch and the hint row together.
- **Focus levels.** `Alt+↑`/`Alt+↓` move focus between controls from anywhere (the prompt to the stream and back);
  `←` and `Esc` leave one level (§4.5).
- **Escape** leaves one layer (§3.1); a surface with unsaved edits asks the shared Yes/No first.

The runtime reports facts as events and the owner answers with a reply. Observations cannot publish, navigate, or
dismiss; actions can.

| Event | Class | Carries |
| --- | --- | --- |
| `value-change` | observation | `controlId`, `fieldId`, `value` |
| `selection-toggle` | observation | `controlId`, `selectedIds` |
| `tab-change` | observation | `controlId`, `tabId` |
| `focus-change` | observation | `controlId`, `from` |
| `token-remove` | action | `controlId`, `tokenId` (the second `Backspace`) |
| `recall-change` | observation | `controlId`, `source: 'queued' \| 'history' \| 'draft'`, `index` |
| `completion-accept` / `completion-dismiss` | action | `controlId`, `itemId?` |
| `selection-accept` | action | `controlId`, `itemId`, `selectedIds`, `segmentId?`, `actionId?` |
| `activate` | action | `controlId`, `actionId`, `inputs` (every form's values), `selected` (each list's cursor row) |
| `submit` | action | `controlId`, `values` |
| `dismiss` | action | none |

Replies: `completed` (optionally with feedback and `dismiss`), `accepted`, `invalid` (field errors, painted in place),
`failed` (a message, the input kept), `cancelled` (silent). Feedback is `{ message, severity }` and follows §2.4.

## 5. Mayfly components

Each Mayfly component is a pure function from facts (plain data) to a node tree. It paints nothing, measures
nothing, and reads no keys. The **Built from** line under each heading is the basic components it uses, as measured
by `ui-preview.mjs --audit` (§6.2). Anything a Mayfly component could not say with the basic components became a
basic-component addition (§6.4), never private code.

### 5.1 Status area

**Built from:** `rich-text`, `stack` (priority admission) for both rows; `surface`, `tabs`, `list`, `scroll`, `actions` for the views panel. Scene: Status area.

The status area is **two composable rows** under the editor. Each row is its own Mayfly component, built from the
same priority-admission row, so a plugin can add an entry to either one (the Loop plugin's `↻ loop 15m` beside the
model) or add a whole view to row 2 with the same call.

```
╭────────────────────────────────────────── Update the landing page hero ╮
│ > ▌Ask anything · / commands · @ files · # skills · ! shell            │
╰────────────────────────────────────────────────────────────────────────╯
deepseek-chat High  PLAN  ~/work/mayfly  main ±3         cache 34%  context: 18% (22.9k/128k)   ← row 1: facts
Agents 5 ● 1 waiting   Jobs 3 ⏵ 2 running   Goal ● 2/8   Todo 2/6 ● Run the tests    ↓ views   ← row 2: views
```

**Row 1: facts.** What is true of the session, nothing that needs a key.

| Entry | Band | Priority | Overflow |
| --- | --- | --- | --- |
| model and effort | left | 0 | keep |
| mode chips (`PLAN` `YOLO`) | left | 1 | keep |
| context (`cache 34%  context: 18% (22.9k/128k)`) | right | 4 | hide |
| directory | left | 5 | truncate |
| balance chip (`⚠ ¥6.2`, only when low) | right | 6 | keep |
| git | left | 10 | keep |

A narrow terminal drops git first, then the balance chip, then truncates the directory, then hides the context
meter; the model and the mode chips survive longest (§3.3). Shell mode is not a chip (§5.2).

**Row 2: views.** What runs or is planned, each a short summary that opens its own panel. A view is a rich-text
summary plus a panel; the row admits them in priority order and truncates the todo view's current item first.

| View | Summary | Panel |
| --- | --- | --- |
| Agents | `Agents 5 ● 1 waiting` | a windowed list, `Enter` opens that agent's conversation (§5.5) |
| Jobs | `Jobs 3 ⏵ 2 running` | the same list; `Enter` opens the job's output |
| Goal | `Goal ● 2/8` (`❚❚` paused, `✕` blocked) | the goal with its progress rule (§5.4) |
| Todo | `Todo 2/6 ● Run the tests` | the todo list with its progress rule (§5.4) |

A view with nothing to show is absent (no goal means no `Goal` chip). The right end of the row says how to enter:
`↓ views` normally, and `F7 switch · F8 close` (or `detach`) when two or more conversations exist (§3.3).

**Entering the views.** `Alt+↓` from the prompt (or `F6`) focuses the row 2 panel of the first view; `←`/`→` move
between views, `↑`/`↓` select a row, `Enter` opens, `x` stops an agent or job behind the shared Yes/No, and `Esc`
returns to the prompt. Goal and todo have no row to select: the panel scrolls (`↑`/`↓`). Goal and todo no longer
appear in the conversation stream; they live here, so the stream carries only the conversation.

### 5.2 Editor and notices

**Built from:** `surface` (`titleAlign: 'right'`, `border`), `prompt`, `rich-text`, `list` (completions). Scenes: Editor, Notices and banners.

The editor is a rounded frame that carries **the conversation title in its top-right corner** and nothing else.
Inside it is the `ui.prompt` (§4.3): the prompt symbol, the tokens, the buffer, and the caret.

```
queued (2)  ⏎ "also update the footer"  ⏎ "keep the hero copy shor…"  ↑ recall
╭────────────────────────────────────────────────── Update the landing page hero ╮
│ > [Image #1 84 KB ×] [notes.md 2 KB ×] explain @pane-act▌                      │
╰────────────────────────────────────────────────────────────────────────────────╯
```

- **Mode is the frame.** In shell mode (`!` as the first character) the prompt symbol becomes `!` and the border
  takes the accent color; the buffer, the title, and the status bar do not change. `Esc` (or `Backspace` on an empty
  buffer) leaves shell mode. The status bar never shows a `SHELL` chip.
- **Tokens live in the input.** Images, pasted blocks, and `@` mentions are `[label size ×]` tokens in the
  buffer. `Backspace` on an empty buffer selects the last token (inverse) and the next `Backspace` removes it, so a
  token is removed with two predictable keys and never by accident.
- **Queued messages** are one truncated line above the frame: the first three, each cut to 22 characters, then `+N`,
  then `↑ recall`. They never grow the editor.
- **History and queue share `↑`/`↓`.** On an empty buffer `↑` recalls the queue first (newest queued message), then
  earlier messages; the right corner reads `↑ history 2/4`; `↓` walks back and ends on the draft. Recalling a queued
  message takes it out of the queue; sending it again re-queues it.
- **Alt+↑** moves focus into the conversation stream (§5.6); `Alt+↓` returns. The editor teaches neither: see below.
- **No hint row.** The editor frame never draws a key line (§3.3): the placeholder teaches the typed prefixes, the
  queue line carries `↑ recall`, the activity gap carries `Esc interrupt`, and `Alt+↑` is cued by a tip and by the
  stream's own hint row once it has focus. The one exception is the open completion list, whose last line is its key
  line (`↑/↓ options · Tab complete · Enter insert · Esc close`). A surface opts in with `hint: 'none'` or
  `hint: 'completions'`.
- **The placeholder ladder** (§3.3) is the same text in whole-trigger variants, each a child with a `when` range, so
  the renderer picks the longest that fits and no code reads a width.
- **Completions** are a `choose` list under the buffer: `@` files (inserted as a token), `/` commands, `#` skills
  (inserted as text), each with its own key line (`Tab complete · Enter insert · Esc close`).

**Notices** are rich-text rows: banners (`⚠ Rate limited · retrying in 12s`), a toast in the activity row's gap, and
an undo toast.

### 5.3 Activity row and tool rows

**Built from:** `loader`, `rich-text`, `stack` (priority admission), `diff`, `code`. Scenes: Activity row, Tool rows and edits.

The header carries the phase, elapsed time, throughput, and a right-aligned
gap. Under it, one to three wrapped `⎿` lines describe **the single action
running now**: the running command, path, or query, or the latest reasoning
paragraph. It is never a list of tools.

```
✻ Thinking · 8s · ↑30.2k ↓1.1k                       Esc interrupt · Ctrl+O expand
  ⎿ Checking whether the activity row can show more than the latest tool name,
    since every tool call overwrites the previous one…

● Running commands · 12s · ↑30.2k ↓4.1k · 38 tok/s   Esc interrupt · Ctrl+O expand
  ⎿ pnpm run verify:changed -- --plan

⣤ Deep diving · 2s                                    Tip: / commands
```

- **The gap.** Running rows with a detail line carry `Esc interrupt · Ctrl+O
  expand` there. The `Deep diving` row, which has no detail, rotates the tip there instead. Idle
  renders nothing.
- **Height.** One header plus at most three detail lines. The row never
  collapses while active, so the editor does not shift between phases; a phase
  with fewer lines pads to the turn's high-water mark.
- **Narrow widths** shed, in order: detail lines beyond the first, the `⎿`
  connector, the header tail (rate, counters, elapsed), then the gap.
- **Tense.** The activity row is the only place that speaks in the present tense;
  transcript rows speak in the past tense.

Running calls use the same row, with the category choosing label and
detail:

```
● Running commands    ⎿ pnpm run verify:changed -- --plan
● Reading files       ⎿ packages/mayfly/src/transcript/pane-activity.ts
● Searching code      ⎿ "activity" in packages/
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

**Edit is a diff; Write is code.**

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
  `⋯` between hunks, `… +N rows · Ctrl+O` beyond the cap (6 rows in a
  collapsed Standard card, 12 once expanded), long lines end in
  `…`. The code of a removed line has a **red background** and the code of an added line a **green one**, to the full
  width; the line numbers stay plain muted text (a quiet gutter, the tints from the diff color tokens). The `−`/`+`
  keeps the meaning without color.
- Multi-file patches list `A`/`M`/`D` with a per-file stat; a failed edit puts
  the reason on the `⎿` line.
- **Write** is not a diff, because there is nothing to compare: collapsed it is one line, `✓ Wrote path · 84 lines ·
  3.1 KB · Ctrl+O expand`; expanded it shows the file as **syntax-highlighted code with line numbers**
  (`ui.code` with `numbered`), no `+` markers and no bands.

### 5.4 Goal and todo views

**Built from:** `progress` (rule), `rich-text`, `stack`, `scroll` (`fit`). Scene: Status area.

Goal and todo are views of status row 2 (§5.1), not stream rows. Each has a one-line summary in the row and a panel that
opens under it. The panel's heading rule is the progress bar: heavy `━` for done, light `─` for what is left. There
are no block bars and no per-item marker trail.

```
Agents 5   Jobs 3   Goal   Todo 2/6                 ← the row, with the Goal tab active
━━━━━━━━━━━━━━──────────────────────────────────────  Goal ● active · round 2 of 8
  Ship the hero refresh and keep all 214 tests green

━━━━━━━━━━━━━━━━━━━─────────────────────────────────  Todo 2 of 6
  ✓ Update landing page hero              ← muted, struck through
  ● Run the tests                         ← bold: the only emphasised row
  ○ Update screenshots
  ○ Bump changelog
  ○ Open the PR
  … +1 more (1 done)

━━━━━━━━━━━━────────────  Goal ❚❚ paused · round 4 of 8
━━━━━━━━━━━━━━━━━━━━━━━━  Goal ✕ blocked · round 8 of 8
  blocked: needs a decision on the release channel
```

The panel shows at most five todo rows: every in-progress item first, then the earliest pending items, with one slot
kept for the latest completed item; the footer counts what is hidden. The goal has paused (`❚❚`) and blocked
(`✕`) states and says why it is blocked. The panel is a `fit` scroll, so a longer list scrolls with `↑`/`↓` and a
short one takes exactly its rows. The only motion is the 400 ms flash when an item completes and a closing line,
`✓ Todo done 6/6 · 4m 12s`, before the view disappears from the row.

The queue is not a view: queued messages are the editor's truncated line (§5.2).

### 5.5 Agents and jobs views

**Built from:** `surface` (`none`), `tabs`, `list` (windowed), `actions` (hidden `delete`). Scene: Status area.

Agents and jobs are the first two views of row 2 (§5.1). Idle, each shows its count and, for the live ones, a
`● 1 waiting` or `⏵ 2 running` tail, never names. `Alt+↓` opens the panel on that view:

```
Agents 5   Jobs 3   Goal   Todo 2/6
━━━━━━━━
→ ● review   Audit facts projection     41s · 6 tools · ↓6.4k
  ● plan     Draft migration plan       waiting · reply needed
  ✓ explore  Map transcript files       12s · 8 tools
  ✓ lint     Sweep oxlint findings      9s · 3 tools
   ↑ 0 more · ↓ 1 more
  ←/→ tabs · Enter open · x stop · Esc back
```

- **Keys:** `←`/`→` switch views; `↑`/`↓` select; `Enter` on an agent opens its conversation (`F7` returns) and on a
  job its output; `x` is the common `delete` meaning (§3.5), so it **stops** the agent or job behind the shared
  Yes/No with No focused first (no Stop button); `Esc` leaves one layer. Live entries come first, and
  `↑ n more · ↓ n more` counts the rest.
- **Conversation keys.** `F7 switch · F8 close` (or `detach`) sit in row 2's right cluster whenever two or more
  conversations exist, so row 2 also appears for a side conversation with no agents or jobs (§3.3).
- **Motion.** The views have no clock (the activity row already animates). A fan-out staggers 300 ms per row once,
  and a row flashes once when its own numbers change.

### 5.6 Transcript

**Built from:** `list` (every stream row is an item; `bodyAlways` bodies, `focusItem`), `actions` (hidden `copy`, `external`), `rich-text`, `diff`, `markdown`, `form` (search), `progress`, `loader`. Scenes: Conversation stream, Compaction.

Four levels, `compact`, `standard` (default), `detailed`, and `verbose`, each a
distinct, predictable amount of detail. The same three turns (a successful
edit-and-test turn, a failed turn, and a running turn) at each level, from the
prototype (the Conversation stream scene):

Level 1, **Compact**, for the whole three-turn conversation (all 12 rows, as the
Conversation stream scene prints them):

```
  » Update the landing page hero copy and run the tests.
  ▸ Took 38s · 6 tool calls · +10 −3 · Ctrl+O expand
  ● Done — the hero now reads "Ship agent UI in a keystroke"; all 214 tests pass.
    The one failure was a truncation bug in the tool-line row, fixed in the same change.

  ────────────────────────────────────────────────────────── 10:04
  » Now bump the changelog and run the full gate.
  ✗ Failed · verify:full timed out after 4m · 4m 12s · 3 tool calls
    ⎿ last step: Ran pnpm run verify:full ✗ exit 124

  ────────────────────────────────────────────────────────── 10:09
  » Regenerate the screenshots and check that they are fresh.
```

Levels 2 to 4 for the first turn only (rows as the Conversation stream scene prints them; the
other two turns follow the same rules). Whole-conversation row counts: Standard
25 (−43% vs Verbose), Detailed 33 (−25%), Verbose 44, counting the blank row and rule between turns.

```
2 Standard
  » Update the landing page hero copy and run the tests.
  ▸ Took 38s · 6 tool calls · +10 −3 · Ctrl+O expand
▾ ✓ Edited Hero.tsx  +4 −2  ▮▮▮▮▮▮▮▮
   12  12 │     return (
   13     │ −     <h1>Build agents faster</h1>
       13 │ +     <h1>Ship agent UI in a keystroke</h1>
   14  14 │       <p>{sub}</p>
▾ ✓ Edited tool-line.ts  +6 −1  ▮▮▮▮▮▮▮▮
   87  87 │     const full = toolDetail(call)
   88     │ −   const detail = full
       88 │ +   const detail = truncate(full, width - 4)
  ● Done — the hero now reads "Ship agent UI in a keystroke"; all 214 tests pass.
    The one failure was a truncation bug in the tool-line row, fixed in the same change.

3 Detailed
  » Update the landing page hero copy and run the tests.
  ▾ Took 38s · 6 tool calls · +10 −3
  ✻ I will read the hero component, unify the heading, then run the tests.
    ⎿ Read files and searched code
▾ ✓ Edited Hero.tsx  +4 −2  ▮▮▮▮▮▮▮▮
   12  12 │     return (
   13     │ −     <h1>Build agents faster</h1>
       13 │ +     <h1>Ship agent UI in a keystroke</h1>
   14  14 │       <p>{sub}</p>
    ⎿ Ran commands · 1 failed
▾ ✓ Edited tool-line.ts  +6 −1  ▮▮▮▮▮▮▮▮
   87  87 │     const full = toolDetail(call)
   88     │ −   const detail = full
       88 │ +   const detail = truncate(full, width - 4)
    ⎿ Ran commands
  ● Done — the hero now reads "Ship agent UI in a keystroke"; all 214 tests pass.
    The one failure was a truncation bug in the tool-line row, fixed in the same change.

4 Verbose
  » Update the landing page hero copy and run the tests.
  ▾ Took 38s · 6 tool calls · +10 −3
  ✻ Thinking  I will read the hero component, unify the heading, then run the tests.
  ✓ Read Hero.tsx · 96 lines
  ✓ Searched "heading" · 7 matches in 3 files
▾ ✓ Edited Hero.tsx  +4 −2  ▮▮▮▮▮▮▮▮
   12  12 │     return (
   13     │ −     <h1>Build agents faster</h1>
       13 │ +     <h1>Ship agent UI in a keystroke</h1>
   14  14 │       <p>{sub}</p>
▾ ✗ Ran pnpm run test · 12.1s · exit 1
  ⎿ FAIL width-scan.spec.ts
  ⎿   tool-line row is 62 cells, expected ≤ 60
  ⎿ 1 failed · 213 passed
▾ ✓ Edited tool-line.ts  +6 −1  ▮▮▮▮▮▮▮▮
   87  87 │     const full = toolDetail(call)
   88     │ −   const detail = full
       88 │ +   const detail = truncate(full, width - 4)
▾ ✓ Ran pnpm run test · 11.8s
  ⎿ 214 passed
  ● Done — the hero now reads "Ship agent UI in a keystroke"; all 214 tests pass.
    The one failure was a truncation bug in the tool-line row, fixed in the same change.
```

| Level | Settled turn | Running turn | Activity row |
| --- | --- | --- | --- |
| 1 Compact | prompt (one row), header with diffstat, final answer; a failure keeps its reason line | the prompt only | header and one `⎿` detail line |
| 2 Standard | header, file-change cards (numbered diff, capped at 6 rows), final answer | settled groups as `⎿` titles and file-change cards as they land | header and `⎿` detail |
| 3 Detailed | the header is open: reasoning preview, past-tense group titles between the file-change cards, final answer | every card live, one row each | header only |
| 4 Verbose | everything open: reasoning, every call with its output tail, full diffs | every card live, with the running card's output tail | header only |

- **Detail lives in exactly one place.** Compact and Standard have no running
  cards, so the activity row carries the `⎿` detail. Detailed and Verbose show
  the running card in the transcript, so the activity row drops it.
- **The header says what changed.** A settled turn's header carries its
  diffstat (`+10 −3`) so a folded turn still tells you whether files changed.
- **Never folded away at any level:** failures and their reason, interruptions,
  cancelled calls (`⊘`), the final answer, compaction boundaries, and
  notices, and the agent's current request (an approval, a plan review): a request is a stream row and
  is always open (§5.7). From Standard up, file changes stay visible as cards.
- **Rows are the metric.** The strip shows the row count of the current level
  and its saving against Verbose, so the cost of a level is visible when you
  choose it. The prototype's sample conversation gives 12 / 25 / 33 / 44.

**Switching.**

- The setting (`/settings`) sets the default level.
- `Ctrl+O` keeps its meaning: the most recent three turns open at Verbose. It
  is the quick "show me what happened" key at every level.
- `Enter` on a turn's header opens or closes that one turn at Verbose, in place;
  the cursor is the `→` mark on the turn.
- A transient `view: Detailed · 29 rows` line confirms a level change in the
  activity row's gap, and the scroll position stays anchored on the visible
  prompt instead of jumping.
- Proposed, not yet checked against the keymap: `/view <level>` and a cycle key
  such as `Alt+V`.
- Search (below) opens the turn holding a match at Verbose, so a hit inside a
  fold is never invisible.

Every row is one line that ladders to width; a user prompt longer than the row at
Compact ends in `…` (the prototype cuts at 62 cells), diff rows end in `…`, and `NO_COLOR` keeps `▸ ▾ ✓ ✗ ●` and the `⎿` tree as
the carriers of state.

**Compaction.**

Compaction reports real stages, so its bar is real. The bar is **context
occupancy** (tokens in use over the context window), and the two stages are
summarizing and applying.

```
● Compacting context ▰▰▰▰▰▰▰▰▰▱ 91%  1/2 summarizing · 4s · auto      the edge cell breathes
● Compacting context ▰▱▱▱▱▱▱▱▱▱  9%  2/2 applying · auto              800 ms drain when the summary lands
✓ Compacted 84 items ▰▱▱▱▱▱▱▱▱▱ 91% → 9% · ~148k → ~12k tokens · auto
  ⎿ Ctrl+O summary
✓ Compacted 84 items · 91% → 9%                                       narrow: the bar goes first
✗ Compaction failed: context still over budget after summary
```

The drop matches the status bar's context meter. Without a known context window
the bar falls back to the two stages (`1/2`, `2/2`).

**The user's own words.** A prompt must be findable at a glance, and today it is not: it is one bold `»` row at the
same indent as the output with no space above it, so a turn's answer runs straight into the next prompt. The design
separates turns with a **turn rule**: before every turn after the first, a blank row and a muted full-width rule with
the turn's start time on the right, then the prompt row.

```
  ● Done — the hero now reads "Ship agent UI in a keystroke"; all 214 tests pass.
    The one failure was a truncation bug in the tool-line row, fixed in the same change.

  ──────────────────────────────────────────────────────── 10:03
  » Before the release, audit every place that still prints
    "Working" instead of "Deep diving": the activity row, the
    tips, the website pages, and the screenshots. List each file
    you changed, keep the diff small, and do not touch the
    ▸ 2 more lines · Enter
    ▸ Took 17s · 4 tool calls · +2 −2 · Ctrl+O expand
    ● Done — 5 files updated; the width scan has 6 narrow cases (24 to 60 columns) and all pass.
```

- The rule and the blank row are not selectable and cost two rows per turn; the first turn has none. The rule is
  monochrome-safe (a glyph, not a color) and its time is the turn's start, so the stream also reads as a timeline.
- **A prompt is capped at four lines** at every level. Lines beyond the cap are hidden behind one muted row,
  `▸ N more lines · Enter`; `Enter` on the selected prompt opens the rest and `Enter` again closes it. Copy (`c`) and
  open in `$EDITOR` (`Ctrl+G`) always take the whole prompt, and a search hit inside the hidden lines opens the
  prompt (§5.6 search). The cap is part of the design, not of one style (`PROMPT_MAX_LINES`).
- The prompt keeps its own bold row and wraps with its text aligned after the `»`, so a wrapped prompt reads as one
  block. At Compact level, where a turn is a prompt, a header, and an answer, the rule is the main separator.
- A queued or steered message uses the same row with a `⏎ queued` suffix, and an interrupted prompt a `■ interrupted`
  one.
- In the prototype this is `ui.list` rows with `rule` and `gap` (§4.4); no new component is needed.

*Considered and not chosen* (the Prompt styles scene still draws them, with `1`-`7`): a hanging indent for everything
under the prompt, a `▎` quote bar down each prompt line, a background band behind the prompt (truecolor only), a
titled card (three rows per turn, boxed), and the combination of indent, bar, and band. They stay in the scene so the
choice can be revisited; they are not part of the design.

**The stream is selectable.** The whole conversation is one browse list, and every row (a user prompt, a tool line,
an edit card, an answer, the agent's request) is an item. `Alt+↑` from the prompt moves focus to the newest row;
`↑`/`↓` walk the rows; `Alt+↓` (or `Esc`) returns to the prompt. A selected row has the `→` cursor and its own keys,
shown in the hint row only while the stream has focus (§3.5 `scope`):

| Key | Action | Does |
| --- | --- | --- |
| `Enter` | `ui.accept` | expand or collapse the row's details (a diff, a command's output, a reasoning block) |
| `c` | `ui.copy` | copy the row's content (the command, the new file text, the answer) |
| `Ctrl+G` | `ui.external` | open the row's content in `$EDITOR` |
| `Ctrl+F` | `ui.search` | search the whole conversation (below) |

```
→ ▾ ✓ Edited Hero.tsx  +4 −2 ▮▮▮▮▮▮▮▮
     12  12 │     return (
     13     │ −     <h1>Build agents faster</h1>
         13 │ +     <h1>Ship agent UI in a keystroke</h1>
  ▾ ✗ Ran pnpm run test · 12.1s · exit 1
    ⎿ FAIL width-scan.spec.ts
  Enter expand · c copy · Ctrl+G open in editor · Esc back
```

**The whole stream is searchable.** `Ctrl+F` opens a one-line search under the stream (`⌕ trunc▌   1/2 matches   matches
open the rows that hide them`). Matches are found in every row's text and in the details a level hides (command
output, diff text, reasoning); a turn holding a match opens at Verbose and the stream selects the current match, so a
hit inside a fold is never invisible. Matched text is highlighted in `warning` + `strong`; `Enter` steps to the next
match, `Esc` closes the search and keeps the highlight until the next search.

The scroll position follows the same rules as any scroll region: the stream keeps the tail in view while following, a
`↓ N new · End` pill appears while it is scrolled away, and `End` jumps to the latest.

### 5.7 Decision cards: approval, plan review, permission

**Built from:** `decisionPanel` = `surface` (lane), `list` (numbered), `form` (same-line input), hidden `actions`; the request row is a stream row (`list`, `diff`, `markdown`). Scene: Approval, plan review, permission.

Every "the agent asks, the user decides" moment (tool approval, plan review) is **two things in the conversation
stream**: the agent's *request* as the newest stream row, with the same content Mayfly shows today (the command, the
diff, the whole plan), and the *decision card* at the foot of the stream, where the editor normally sits. The card
is one composition: a lane head (`── Decide ──`), a numbered choice list, an optional same-line input, and the hint
row. There is no decision-specific widget, no second page, and no `Back` button.

```
  ▾ ? Approve edit  pane-activity.ts  +2 −1                  ← the request: a stream row, today's diff
     41  41 │     const moon = state.mode === 'waiting'
     42     │ −   const frame = moon
         42 │ +   const frame = glyphFor(state)
── Decide ─────────────────────────────────────────────────
→ 1  Reject
  2  Allow once
  3  Allow edits this session
  Feedback: type to explain…
  Enter choose · Ctrl+G open diff · Esc reject
```

- **The request stays in the stream** after it is answered, as the record of what was approved, and it follows the
  stream's rules (selectable, searchable, copyable, §5.6). Plan review keeps today's content: the plan is the
  request row, rendered as markdown.
- **Open in the editor.** An edit card and a plan card carry the common `external` key (`Ctrl+G`, §3.5): it opens
  the diff or the plan in `$EDITOR` to read it properly, and closing the editor returns to the card with the
  decision still open. A plan card also carries `c` (copy plan). Both are hidden accelerators with a hint, no buttons.
- **Preview.** A command shows the command and a `⚠` note when it deletes files; an edit shows the diff (§5.3) on
  a red or green background behind the changed code; a plan shows the plan above the options.
- **Same-line input.** `Feedback:` (approval) or `Revise:` (plan) is an ordinary field
  under the list; `↓` from the last option focuses it, typing edits in place, and the
  whole decision settles as one action.
- **`Esc` says what it does.** Dismissing an approval *rejects* the call, so the footer
  reads `Esc reject`, not `Esc close`.
- **Queue.** Pending requests are first in, first out per agent, and the request row reads
  `1 of 3 waiting`. An allowance lives until that agent ends.
- **Permission preset** is a *preference*, not a grant, and is not part of a conversation turn: it stays an overlay
  surface (`/settings` and the first run open it). Digits choose at once, the current preset carries `[current]`,
  and `Full access` asks the shared Yes/No first.

**Open for review: where the cursor starts and what a digit does.** Two variants are
drawn in the prototype's Approval scene (`Ctrl+T` switches the variant, `Ctrl+X` simulates a stray keystroke through the real key engine):

Variant A, **safe-first**: the least destructive option is row 1 and focused; digits
only move the cursor; a grant costs two keys.

```
  ▾ ? Approve command  bash · 1 of 3 waiting
    $ rm -rf build && pnpm build
    in ~/work/mayfly                            ⚠ deletes files
── Decide ─────────────────────────────────────────────────
→ 1  Reject
  2  Allow once
  3  Allow bash for this session
  Feedback: type to explain…
  Enter choose · 1-3 focus · Esc reject
```

Variant B, **grant-first**: the common grant is row 1 and focused; digits choose at
once; a rejection is `Esc` or its digit.

```
  ▾ ? Approve command  bash · 1 of 3 waiting
    $ rm -rf build && pnpm build
    in ~/work/mayfly                            ⚠ deletes files
── Decide ─────────────────────────────────────────────────
→ 1  Allow once
  2  Allow bash for this session
  3  Reject and tell the agent why…
  Feedback: type to explain…
  Enter choose · 1-3 choose · Esc reject
```

| | A safe-first | B grant-first |
| --- | --- | --- |
| Row 1, focused | Reject | Allow once |
| A digit | moves the cursor | chooses at once |
| Grant | 2 keys (`↓`, `Enter`) | 1 key (`Enter` or its digit) |
| Reject | 1 key (`Enter` or `Esc`) | 1 key (`Esc`) |
| A stray `1` or `Enter` typed before the card is seen | at worst rejects | grants |
| Needs an arm delay (a card that opens unprompted ignores all but `Esc` for about 300 ms) | no | yes |

The recommendation is **A**: approvals are rare and a wrong grant is costly, while a
wrong reject only costs one more request. The rest of this document assumes A; §8 lists
it as a decision for you.

Plan review under A (grants need an explicit move; `Enter` alone can never approve):

```
  ▾ ? Plan ready for review  6 steps
    # Plan
    1. Add activeCalls to the facts projection
    …                                          ← the whole plan, as today
── Decide ─────────────────────────────────────────────────
→ 1  Reject
  2  Approve and start
  3  Approve and auto-accept edits
  4  Keep planning…
  Revise: ▌                       ← type the revision in place
  Enter choose · c copy plan · Ctrl+G open plan · Esc reject
```

### 5.8 Questions

**Built from:** `surface`, `tabs` (wizard), `list` (numbered or multiple), `form` (Other), `text`. Scene: Questions.

A multi-question prompt is one wizard step per question plus a **Review** page; a single
question drops the strip. Digits answer at once (a question is a preference, not a grant),
`Enter` accepts and advances, and on the last page `Enter` submits every answer as one
action. A choice is `●` chosen and `○` not (a multi-select question uses the same marks and `Space`), and `Other` is a free-text
row typed in place.

```
╭ Questions ─────────────────────────────────────────────────── 2 of 3 ╮
│ ✓ Auth  │  ● Region  │  ○ Scopes  │  ○ Review                        │
│                                                                      │
│ Which region should the service deploy to?                           │
│ → 1  ● us-east-1       lowest latency to most users                  │
│   2  ○ eu-west-1       GDPR data residency                           │
│   3  ○ ap-south-1      closest to the pilot customers                │
│   4  ○ Other           type your own answer                          │
│ ←/→ question · 1-4 choose · Enter next · Esc cancel                  │
╰──────────────────────────────────────────────────────────────────────╯
```

**`←` and `→` move directly between questions** from any option row, because an option row has nothing for them to
adjust. In the `Other` text field the arrows keep moving the caret (and `←` at the start of the field is the first
key the ladder of §4.5 hands on), and `Alt+←`/`Alt+→` switch question from anywhere, including there.
The Review page lists every answer (`— skipped` in warning), `1`–`3` jump to a question,
and `Submit answers` sends everything. Below 60 columns the strip collapses to
`Region · 2/3 ›`. There are no `Back`/`Next`/`Cancel` buttons: `Alt+←→`, `Enter`, and `Esc`
do all three.

### 5.9 `/model` and `/effort`

**Built from:** `surface`, `list` (browse, filterable, `segment` strips). Scene: /model and /effort.

Goals: the thinking level is part of the model's entry; no buttons; rows never jump; every
hint tells the truth. A model entry puts the model, its context, and its thinking control
on one line:

```
→ DeepSeek/DeepSeek-V4-Pro — 977k context   min ‹ high (default) › max
  └────────── label ───────┘ └── detail ───┘ └──── inline segment ────┘
```

The label is `<provider>/<model>`; the detail is `<context> context`; a badge follows the
label (`[current]`, or `[current · high]` on the live row so the running effort is
visible before focusing it). Group headers stay (they aid scanning) and so does the
provider prefix (it disambiguates filter results). The focused row is inverted; only it
shows a strip, and only the active token is violet.

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

State variants of the focused row (hint beneath in parentheses):

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

The strip follows the segment degrade ladder (§4.4): when the focused row plus its strip
cannot fit, the strip moves to one footer line that the whole list reserves, so focus never
moves a row. At 80 columns the live row `DeepSeek-V41-Flash [current · high]` already falls
back to the footer when focused, while the shorter `DeepSeek-V4-Pro` row keeps its strip
inline (the /model scene draws both).

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

| Key | Effect |
| --- | --- |
| `↑` `↓` `PgUp` `PgDn` `Home` `End` | move; group headers and disabled rows are skipped |
| `←` `→` | step the focused row's thinking level (clamped, no wrap); inert on rows without one |
| `Enter` | use this model and this thinking level for the session, and save them as the default |
| `Delete` | unpin thinking (shown only while pinned) |
| type or `/` | filter (`Ctrl+U` clears, `Esc` ends the search, a second `Esc` closes) |

The result is confirmed by a notice: `Switched to deepseek-v4-pro (DeepSeek) · thinking
high`, or `Thinking set to high` when only the level changed. `Esc` leaves the model
untouched. `/effort` is the same component reduced to one model: the overlay title is the
current model, the rows are `Provider default (high)` and then each real level, numbered,
with `[current]` on the live one, and no buttons. `/effort <level>` and `/model <id>` switch
without opening anything; `Alt+M` keeps cycling.

### 5.10 `/sessions`, `/settings`, and `/status`

**Built from:** `railPanel` (sessions, settings), `statusPage` (status), `list`, `form`, `tabs`, `actions`. Scenes: /sessions, /settings, /status.

Panels are compositions of the components above, not new widgets: a vertical
rail plus a content column (sessions, settings) or a tab strip plus a
key/value body (status).

**Sessions.** The rail lists workspaces; the content lists that workspace's
sessions with a filter row, and the focused session expands in place to show
its first prompt and last outcome.

```
╭ Sessions ──────────────────────────────────────────────────────── 25 total ╮
│                          │ ~/dev/clients/acme/…/packages/mayfly            │
│   All             25     │ / filter…                                       │
│   work/mayfly      8     │ Recent                                          │
│ → packages/mayfly  5     │   Port the tray to acme layout  6 turns 3h      │
│   …roject-name-here 4    │     │ Port the tray design to the acme fork.    │
│   website          5     │     │ Rebased; specs pass.                      │
│ ↑↓ workspace · → sessions · / filter · y copy path · Esc close             │
╰────────────────────────────────────────────────────────────────────────────╯
```

- **Long paths never enter the rail.** A label is the basename; when two
  workspaces share it, the shortest distinguishing parent is added
  (`work/mayfly`, `packages/mayfly`); a label that still overflows is
  ellipsised at its *start* (`…roject-name-here`) so the distinguishing end
  stays visible.
- **The full path** is the first line of the content, home-collapsed to `~` and
  ellipsised in the *middle* (`~/dev/clients/acme/…/packages/mayfly`); `c`
  (the common copy meaning) copies it in full.
- **No markers for the current directory or the current session.** Recency
  groups and the resume action are enough.
- **Keys.** `c` copies the path, `n` starts a new session, `x` deletes: bare keys (two common meanings and one
  component action, §3.5), so the sessions list filters only after `/` (§3.4) and the hint row shows `/ filter`.
  Delete has no button and asks nothing for a reversible delete (`u undo · 8s`).

**Settings.** The rail holds the setting groups; the content is the shared
form of §4.3. Each group keeps its own draft; `←` follows the ladder of §4.5: a select or number adjusts first, and a `←`
the field cannot use (a text field, a toggle, a select already at its first option) returns to the rail.

**Status** is read-only: tabs `Overview`, `Usage`, `Account`, `Connections`,
`About`, with a right-hand `!` on a tab that needs attention.

The **Usage** tab carries the session's activity, in two blocks built from `fields` and `chart`:

```
  Session:   148.2k in · 50.4k cached · 18.9k out · 31 requests · ≈ ¥ 3.02
  Today:     ≈ ¥ 13.40 · 4 sessions

  Activity  turns per day, last 26 weeks
       Apr May  Jun Jul Aug  Sep
  Mon  ··░▒░░▒▒·▓··▓·░··▒█▓▓·▓▒·█
  Wed  ·░··░░▒▒▒▒·░·▒░░▓░▓▒·▒▒▒░█
  Fri  ··░░·░··░░░·░·▒··▓▒▒█░▒░▓▓
  Sun  ·····░░·····▒·░·▒░░·▒··░▒░
  legend: · none  ░ light  ▒ some  ▓ busy  █ peak

  Conversation statistics
  Sessions:    25 · 312 turns · 1,204 messages
  Tool calls:  1,873 · 94% succeeded
  Avg turn:    38s · longest session 2h 14m
  Streak:      6 days · best 19
  top tools    bash ████████████████████████ 612   read ███████████████████░░░░░ 481 …
  turns/day (last 14)  ▃▄▂▁▅▆▃▆▇▃▄█▆▅
```

The heatmap is one cell per week-day (`chart: 'heatmap', cell: 1`), its columns labelled by month, its four levels
shown as `░ ▒ ▓ █` after `·` for none (never color alone). Statistics are read-only facts from the session store;
they never block the other tabs.

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

### 5.11 `/plugin` marketplace

**Built from:** `surface`, `tabs`, `splitView`, `list` (slash filter), `fields`, `actions` (hidden keys), `loader`. Scene: /plugin marketplace.

```
╭ Plugin marketplace ──────────────────────────────────────────────────────────────────────────────────╮
│   Installed 3   Browse 5    index updated 2h ago · 8 entries                                         │
│   ━━━━━━━━━━━                                                                                        │
│   / filter plugins…                                                                                  │
│ → Loop             official   T W   1.4.0               │ Loop  official · Automation                │
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

- **Layout follows width** (§2.4): at 100 columns or more the list and a live
  detail share the surface; below that the list is one column and `Enter` opens
  the detail, `Esc` returns. The header tab strip is the §4.5 text-color
  strip, with the catalog's age (or the offline notice) at its right.
- **List columns:** name, a status word (`stable` shows nothing; `beta` is
  accent, `unstable` and `deprecated` warning, `removed` danger), the source
  (`official`, `dsh`, `community`), the surfaces `T W` (bold when the plugin
  contributes there, a dim `·` when it does not), and the version, or
  `update x.y.z` when one is available. Deprecated and removed rows dim and
  their note leads the detail.
- **Actions are keys, not buttons** (§4.2): `i` install,
  `u` update, `x` remove behind the shared Yes/No with No first
  (`Removal applies after restarting Mayfly.`), `s` cycle the install source
  (`npm`, `github`) when an entry offers both and is not installed, `r`
  refresh, `/` filter. The hint row lists only the keys that apply to the
  focused entry. The catalog filters only after `/` (§3.4), which is what frees the
  bare letters.
- **Progress** is the gap spinner (§4.8) with what and where, `Installing Git
  Helper via npm… 4s · Esc cancel`, then a success line. Installs and removals
  are single-flight (a second install while one runs is refused with a notice).
- **Restart is a persistent banner, not a toast.** Bundle membership is a
  startup boundary, so every completed change adds to `↻ N changes apply after
  you restart Mayfly and start a new session`, which stays until the restart.
- **Web-only plugins** show `TUI ✗ no contribution in this terminal`; `i` on
  one reports a warning instead of installing.
- **States follow §2.4:** loading (`⣾ loading catalog…`), empty
  (`No plugins installed — press → to browse`), offline with cached data
  (`⚠ offline · showing cached data from 2d ago`, content stays usable), and
  refresh in progress.

### 5.12 Onboarding and `/account`

**Built from:** `tabs` (wizard), `surface`, `form`, `list` (numbered), `fields`, `actions` (hidden keys). Scenes: Onboarding, /account.

**Onboarding.**

First run is one flow with a visible spine: a text-color step strip and a summary.
Every step is reversible with `Esc`, and `Skip for now` never blocks:

```
  ✓ Language  ›  ● Connect  ›  ○ Permissions  ›  ○ Ready
                 ━━━━━━━━━
╭ Connect to DeepSeek ────────────────────────────────────────── step 2 of 4 ╮
│ Mayfly needs a DeepSeek connection to start.                               │
│                                                                            │
│ → 1  Sign in with a DeepSeek account  recommended                          │
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
| 2a Browser | the account panel (§5.12) inside the guide: a breathing `●`, the expiry countdown, the link, and a collapsed `▸ Browser on another machine?` row that opens the paste-back field on `p` | `Ctrl+Y` copy · `Ctrl+R` new link · `Esc` cancel |
| 2b API key | one secret field with `Enter` to save; `Your key is saved as a credential, not as a setting.` | `Enter` save · `Esc` back |
| 3 Permissions | **new, proposed:** the permission preset as a numbered choice (`Default` recommended); `Full access` asks the shared Yes/No | `1`–`3` · `Enter` |
| 4 Ready | a checklist of what was set (`○ DeepSeek not connected · /account to sign in` when skipped) and **things to try**, each prefix with its name and one sentence (below) | `Enter` start chatting (`Ctrl+S`) |

```
  Things to try
  /          commands    run a command, such as /model or /sessions
  @          files       mention a file to attach it to your message
  #          skills      select a skill (a saved playbook) to guide the agent
  !          shell       run a shell command and share its output
  Shift+Tab  plan mode   let the agent plan first; you approve before it acts
```

- **No buttons in the guide.** `Continue`, `Save`, and `Back` are `Enter` and
  `Esc` ; the primary choice is the focused row.
- **Progressive disclosure:** the other-machine paste-back is collapsed by
  default because the common case finishes by itself on this machine.
- **The permissions step is optional to ship.** Without it the strip is three
  steps and the preset stays `Default`.
- **Resumability:** quitting mid-guide leaves the unfinished step to reappear
  on the next start; finished choices persist immediately.

**Account panel.**

```
╭ DeepSeek Account ─────────────────────────────────────────── not connected ╮
│ Status        Not signed in                                                │
│ Sign-in       ● Waiting for you in the browser                             │
│ Expires       4:41                                                         │
│                                                                            │
│ Approve in the browser — on this machine sign-in finishes by itself.       │
│ Sign-in link  https://platform.deepseek.com/oauth/authorize?…              │
│ → Browser on another machine?                                              │
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

- **The balance row** is the one in §5.10: loading (`⣾ checking balance…`),
  unavailable (`— unavailable (network)  r retry`), unsupported (row hidden). A
  failed check never changes the sign-in state.
- **Identity** (name or email) is not shown; the design does not assume a profile.

### 5.13 Command surfaces

**Built from:** `surface`, `list` (filterable, `segment`), `diff`, `scroll`, `fields`, `divider`, hidden `actions`. Scene: Command surfaces.

| Scenario | Design | Keys |
| --- | --- | --- |
| Command palette | filtered list with the match bolded, description, and the command's own key | `/` then type · `Tab` complete · `Enter` run · `Esc` close |
| `@` file picker | recent first, fuzzy on name and path; the focused row shows `↗ code` | `Enter` **open in the external editor** · `Tab` insert the mention · `Esc` close |
| Changed files | `M`/`A`/`D` with stat; `Enter` opens at the first changed line | `Enter` open · `d` diff |
| Notifications and undo | right-aligned toast in the activity row's gap (`✓ build finished · 22s`); a destructive action offers `u undo · 8s` | `Ctrl+J` view · `u` undo |
| Queued messages, attachments | one truncated `queued (2)` line above the editor; attachments and pasted blocks are `[Image #1 84 KB ×]` tokens inside the input (§5.2) | `↑` recall · `Backspace` selects then removes a token |
| Rewind | checkpoint list with a restore scope `‹ conversation + code ›` | `↑↓` · `←/→` scope · `Enter` restore |
| Diff hunk review | per-hunk accept or reject on the numbered diff | `a`/`r` · `A`/`R` all · `n`/`p` hunk |
| Banners | rate limit with countdown, offline, context nearly full, low balance, resumed session | `Esc` cancel · `r` retry |
| Key help | contextual, grouped by task | `?` |
| Job output | timestamped tail with follow | `f` follow · `↑` scroll · `x` stop |
| Delete session | **plain `[ No ]  Yes`**, No focused first; no typed phrase | `←/→` or `n`/`y` · `Enter` |
| Conversation search | the stream's search line (§5.6) | `Ctrl+F` |

- **Opening a file** uses the configured external editor. GUI editors open detached
  with a goto argument (`file:line`); terminal editors suspend the screen and restore
  it. The path must resolve inside the workspace. With no editor configured the row
  says so and points to `/settings`.
- **Delete session** may be a soft delete with an eight-second `u undo` toast, which
  removes even the Yes/No prompt (§3.4). It needs the Harness to expose session deletion
  (§8).
- **Key help `?`** is a printable key, and the editor owns every printable key
  while a draft exists, so `?` opens key help only on an empty prompt (the same
  rule as `↑` recalling a queued message and `Alt+↓` entering the views). On a
  non-empty draft it types a `?`; the hint row advertises `? keys` only while
  the prompt is empty.
- **Bare keys.** `d`, `a`, `r`, `n`, `p`, `f`, `x`, `u`, and `c` in this table work
  because those lists do not filter by typing (changed files, hunk review, job output).
  The palette and the `@` picker type into their filter and bind only `Tab`, `Enter`,
  and `Esc` (§3.4).

### 5.14 `/trace`

**Built from:** `surface`, `splitView` (`list` as a tree with `meter`, `badge`, `filterable`), `fields`, `scroll`, `code` (`json`, `numbered`), hidden `actions`. Scene: /trace.

*Today*, `/trace` is a flat list of events with a filter, a `copy` subcommand, and a paginated JSON overlay for the
selected event. The design keeps those operations and shows the structure the data already has: a session is
**turns**, and a turn is the **events** inside it.

```
╭ Trace · session 4f2a9 ──────────────────────────────────────────────────────────────────── 8 events ╮
│   ▾ Turn 1  10:02:11  38s  ↑18.4k ↓0.6k              ✓  Type:    tool-call                          │
│   │ 10:02:11 #1  » user message [main] ▱▱▱▱▱▱ Update the land…  Surface: tool                       │
│   │ 10:02:12 #2  ● model request [main] ▰▰▱▱▱▱ deepseek-chat …  Took:    300ms                      │
│ → │ 10:02:17 #3  ⏵ bash [tool] ▱▱▱▱▱▱ pnpm run test              json                            █  │
│   │ 10:02:29 #4  ✗ bash result [tool] ▰▰▰▰▰▰ exit 1 · 12.1s ·…    1 │ {                          █  │
│   ╰ 10:02:30 #5  ● subagent review [subagent] ▰▰▰▱▱▱ Audit fa…    2 │   "seq": 3,                █  │
│   ▾ Turn 2  10:04:02  4m 12s  ↑31.0k ↓2.1k           ✗ failed    3 │   "type": "tool-call",     █   │
│   │ …                                                              4 │   "surface": "tool",       ░ │
│   Enter open · c copy item · / filter · Esc close                                                   │
╰─────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

- **A tree, not a flat list.** Each turn is a parent row (start time, duration, tokens, a `✗ failed` mark when any
  event failed); its events are children with their time, sequence number, glyph, title, surface badge (`main`,
  `tool`, `subagent`, `system`), a six-cell **duration meter** relative to the longest event of the turn, and a
  one-line summary. A failed event is `danger`; the meter shows where the time went at a glance.
- **Detail follows the cursor.** The right pane (under it, below 110 columns) shows type, surface, duration and the
  event's JSON as highlighted, numbered `code` in a `fit` scroll: `Alt+↓` moves into it (`↑`/`↓` scroll) and `Ctrl+E` expands it, replacing today's pages.
- **Keys.** `/` filters (bare keys are free), `c` copies the selected event (`ui.copy`), `a` copies every event as
  JSON lines, `f` toggles *failures only* (the tree keeps only the failed events and their turns), `Ctrl+G` opens
  the JSON in `$EDITOR`. The `/trace copy <seq>` and `copy all` subcommands remain for scripting.
- A turn's rows follow the §5.6 level of detail only in that the panel is its own surface; it never folds a failure.

### 5.15 Keybindings

**Built from:** `surface`, `list` (grouped, `filterable`), `actions`. Scene: Keybindings.

The `/keys` panel is the user-facing side of §3.5. It lists every action the runtime has seen, grouped as *Common
meanings (every panel)*, then component actions (Mayfly's and plugins'), *Moving between controls*, and *Navigation*.
Each row shows the label, the action id, and its effective keys; a rebound row is `primary` and adds `default Ctrl+G`.

```
╭ Keys ─────────────────────────────────────────── Enter rebinds · Delete restores the default ╮
│ Common meanings (every panel)                                                                │
│   save              ui.save                                                           Ctrl+S │
│ → copy              ui.copy                                                                c │
│   delete            ui.delete                                                              x │
│ Demo plugin                                                                                  │
│   Install           demo-plugin.install                                                    i │
╰──────────────────────────────────────────────────────────────────────────────────────────────╯
```

`Enter` on a row starts capture (`press the new key · Esc cancels`); the next key is the new binding unless it is
already another action's, in which case the panel names that action and changes nothing. `Delete` restores the
focused row's default. A plugin panel shown with the list (the scene draws one) updates its hint row as soon as its
own action is rebound.

## 6. One API

### 6.1 The rule

Mayfly core and every downstream plugin build their UI from the same basic components (§4). Concretely:

- A Mayfly component is a pure function from facts to a node tree and may use **only** `ui.*` and the patterns of §4.9.
  It never paints a character, measures a width, or reads a key, and it keeps no focus or scroll state.
- A plugin is built the same way. The prototype's `acme.loop` is a plugin: its panel, its form, its confirm, and its
  status entry use the same calls as `SettingsPanel` and `StatusBar`, and nothing in the kit treats it differently.
- When core needs something the basic components cannot say, the basic component grows (§6.4) and the plugin
  gets it too. Core does not get a private path.

### 6.2 The audit

`node docs/design/prototypes/ui-preview.mjs --audit` checks that the Mayfly components module imports only the kit
and contains no raw escape codes, terminal access, width comparison, or text measuring, then walks every scene and
prints which basic components each component used. Today it reports 30 Mayfly components and 4 patterns, built only
from 20 of the 22 basic builders.

| Component | Layer | Basic components it is built from | Nested |
| --- | --- | --- | --- |
| `acme.loop` | plugin | `actions` `form` `stack` `surface` |  |
| `kit.decisionPanel` | pattern | `actions` `form` `list` `stack` `surface` |  |
| `kit.railPanel` | pattern | `stack` `surface` `tabs` |  |
| `kit.splitView` | pattern | `stack` |  |
| `kit.statusPage` | pattern | `fields` `spacer` `stack` `surface` `tabs` |  |
| `AccountContent` | mayfly | `actions` `fields` `list` `spacer` `stack` `text` |  |
| `AccountPanel` | mayfly | `surface` | `AccountContent` |
| `ActivityRow` | mayfly | `loader` `rich-text` `stack` |  |
| `Banner` | mayfly | `rich-text` |  |
| `ChangedFiles` | mayfly | `actions` `list` `stack` `surface` |  |
| `CommandPalette` | mayfly | `empty` `list` `surface` |  |
| `CompactionRow` | mayfly | `loader` `progress` `rich-text` `stack` |  |
| `DecisionCard` | mayfly | `text` | `decisionPanel` |
| `EditCard` | mayfly | `diff` `rich-text` `stack` |  |
| `Editor` | mayfly | `prompt` `rich-text` `stack` `surface` |  |
| `EffortPicker` | mayfly | `list` `surface` |  |
| `FilePicker` | mayfly | `list` `surface` |  |
| `JobOutput` | mayfly | `actions` `rich-text` `scroll` `stack` `surface` |  |
| `KeybindingsPanel` | mayfly | `list` `surface` |  |
| `KeyHelp` | mayfly | `divider` `fields` `stack` `surface` |  |
| `ModelPicker` | mayfly | `empty` `list` `surface` |  |
| `Onboarding` | mayfly | `form` `list` `rich-text` `spacer` `stack` `surface` `tabs` `text` |  |
| `PluginMarketplace` | mayfly | `actions` `empty` `fields` `list` `loader` `rich-text` `spacer` `stack` `surface` `tabs` `text` | `splitView` |
| `QuestionsPanel` | mayfly | `form` `list` `spacer` `stack` `surface` `tabs` `text` |  |
| `RewindPanel` | mayfly | `list` `surface` |  |
| `SessionsPanel` | mayfly | `actions` `empty` `list` `stack` `text` | `railPanel` |
| `SettingsPanel` | mayfly | `form` `spacer` `stack` `text` | `railPanel` |
| `StatusBar` | mayfly | `rich-text` `stack` |  |
| `StatusPanel` | mayfly | `chart` `fields` `rich-text` `spacer` `stack` | `statusPage` |
| `ToolLine` | mayfly | `rich-text` |  |
| `TracePanel` | mayfly | `actions` `code` `empty` `fields` `list` `scroll` `stack` `surface` | `splitView` |
| `TranscriptView` | mayfly | `actions` `diff` `list` `markdown` `rich-text` `stack` |  |
| `ViewPanel` | mayfly | `actions` `list` `stack` `surface` `tabs` |  |
| `ViewRow` | mayfly | `rich-text` `stack` |  |
| `WriteCard` | mayfly | `code` `rich-text` `stack` |  |

The audit also proves the plugin claim from the other side: `acme.loop` (`actions form stack surface`) uses a
subset of what core uses.

### 6.3 What core does not use

`sections` and `diagram` are used by no Mayfly component in this design. They stay in the API for plugins (and
`diagram` for the Mermaid views a status panel may grow). A Mayfly component that later needs one uses the same
builder.

### 6.4 API additions the design needs

Building every screen from the basic components alone found the gaps below. Each is **additive** (a new optional
prop or value, never a change to an existing one) and is specified in §3.5 or §4. Together they are what the
implementation change adds to the UI API.

| Builder | Addition | Needed by |
| --- | --- | --- |
| `ui.child` | `priority`, `band`, `overflow` (admission) | status rows, activity row |
| `ui.loader` | variants `bloom` `fill` `gap` `breath`; an inline shimmer span | activity row, loaders, onboarding |
| `ui.progress` | `style: 'rule'`, `width`, `tone`, `showPercent` | todo, goal, compaction |
| `ui.text` | `overflow: 'middle'` and `'start'` | sessions path, rail labels |
| `ui.diff` | `start`, `numbered`, `hunkHeader`, `context`, `maxRows`; a red or green background behind the removed or added code (never the gutter) | edit cards, hunk review, the stream |
| `ui.code` | `numbered`; highlighting on by default | the Write card, trace JSON |
| `ui.chart` | heatmap `cell` and `columnLabels` | status usage |
| `ui.list` | `marker`, `marks` (`●` `○` `◐`), `filterMode`, `maxRows`, `expandFocused`, `acceptVerb`, `autofocus`, `focusItem`; item `detail`/`label` as spans, `right`, `rightFocus`, `body` as a node, `bodyAlways`, `wrap`, `meter`, `indent`, `block`, `rule`, `gap` | the stream, sessions, marketplace, pickers, trace |
| `ui.tabs` | `orientation`, `attention`, `clip`, `hintLabel` | rails, status, questions, views |
| `ui.form` | field `help`, `group`, `suggestions`, `pattern`; `enterSubmits` from a select or toggle, `submitLabel` | settings, welcome, search |
| `ui.prompt` (new) | `symbol`, `tokens`, `recall`, `placeholder` ladder, `completions`, `reset` | the editor |
| `ui.scroll` | `marks`, `currentMark`, `pill`, `reveal`, `fit` | stream, job output, views, trace |
| `ui.surface` | `escapeLabel`, `titleAlign: 'right'`, `border` | approvals, the editor |
| `ui.actions` | item `hintLabel`, `semantic`, `action`; list `scope` | every accelerator hint, row keys |
| runtime | `keymap` (`bind`, `reset`, `list`, named actions, common meanings §3.5); `focus-change`, `token-remove`, `recall-change`, `completion-*` events; `activate.selected`; the `←` ladder (§4.5); the printable-key rule (§4.10) | every panel, `/keys`, plugins |

## 7. Changes from today

Every change this design makes to the shipped UI, listed once. "Today" is a one-line
baseline verified against `main` when this was written; *new* means nothing like it ships.

| Area | Today | Design |
| --- | --- | --- |
| Marks | multiple lists use `●`/`○`; theme and permission pickers use `[← current]`, the model picker `[current]` | `●` `○` `◐` for every choice (single and multiple), one `[current]` badge, `→` cursor, `▸ ▾` disclosure only (§2.2) |
| Chrome | inline surfaces use square corners | rounded frames everywhere; overlay in the focus color, surface in the quiet color (§2.1) |
| Motion | a two-cell wave ripple (120 ms) and a braille spinner (80 ms), label `Deep diving` | bloom, fill, shimmer, breath, and gap; one motion channel per row; the label stays `Deep diving`; the ripple and the `tide` loader retire (§2.3) |
| Status | one row; goal and jobs are chips in it; a `SHELL` chip | **two composable rows**: row 1 facts (model, mode chips, context, directory, git, balance), row 2 views (agents, jobs, goal, todo) (§5.1) |
| Editor | the conversation title and attachments are elsewhere; `! shell mode` is text in the border | the title in the frame's top-right corner; images, pastes, and `@` mentions as `[… ×]` tokens in the input with a two-step `Backspace`; one truncated queue line; `↑`/`↓` walk the queue then the history; shell mode is the border color (§5.2) |
| Activity row | one truncated detail line; tips only while a turn runs; the interrupt key is not advertised | up to three `⎿` lines; `Esc interrupt · Ctrl+O expand` in the gap; tips only in the `Deep diving` row (§5.3) |
| Tool rows | an edit has a two-column sign gutter; no line numbers | plain numbered old/new gutters and a red or green background behind the changed code, `A`/`M`/`D` for multi-file; write is one line, and highlighted code with line numbers when expanded (§5.3) |
| Compaction | a braille spinner and elapsed time; settles to `✓ compacted N items · ~Tk tokens` | a real occupancy bar with two stages, a drain on settle, and the before/after percentage (§5.6) |
| Todo and goal | a flat `─` rule and a `Todo` title above the editor; the goal as a status chip | views of status row 2; the rule is the progress bar with `n of N`; goal paused and blocked states; nothing in the stream (§5.4) |
| Subagents and jobs | a pane above the editor; jobs only as a footer count; neither selectable | views of status row 2, keyboard-selectable, `x` stops behind a confirm (§5.5) |
| Conversation stream | scroll only; `Ctrl+O` opens the last three turns; a prompt is one bold row with nothing above it, so turns run together | a blank row and a timed rule before every prompt; every row selectable (`Alt+↑`), expand, copy, open in `$EDITOR`, and the whole stream searchable with `Ctrl+F` (§5.6) |
| Key cues | no persistent prompt; `Ctrl+O` cue only on the last 3 turns, three spellings of a key; `ctrl+t to expand`-style lowercase | cues live with their owner, the activity gap, and the placeholder; one `Ctrl+O` notation (§3.3) |
| Keys | each surface binds its own keys | named actions, common meanings (`Ctrl+S` save, `c` copy, `x` delete, `r` refresh, `Ctrl+G` external, `Ctrl+F` search), and runtime rebinding with a `/keys` panel (§3.5, §5.15) |
| Feedback | one unprefixed row | a severity glyph and fixed lifetimes (§2.4) |
| Decisions | three shapes: approval (actions row plus a `Reject with feedback` tab), plan review (`Other`/`o`), permission preset | one skeleton; the request is a stream row and the card sits at the foot of the stream; `Esc reject`; a same-line `Feedback:`/`Revise:` field; an open-in-editor key; variant A or B pending (§5.7) |
| Questions | `Back`/`Next`/`Submit answers`/`Cancel` buttons | no buttons, a step strip with a Review page, `←`/`→` move between questions (§5.8) |
| Tabs and rails | the active tab wrapped in `‹ ›`; `←` out of a rail's content is unreliable | text color with a heavy underline, `!` attention, a vertical rail, and a defined inner-to-outer `←` ladder (§4.5) |
| Model picker | the thinking strip is a row under the whole list with a `Provider default` pseudo-option; `Set as default`/`Cancel` buttons; hint says `Enter open` | the strip on the row, an unpinned state, no buttons, hint `Enter choose`, `[current · high]` badge (§5.9) |
| Forms | single-field forms keep `Submit`/`Cancel` | one `Save` (or `Ctrl+S`), group headings, a help line, an `unsaved changes` badge (§4.3) |
| Row operations | a `Delete` button beside lists | a hidden key bound to a common meaning, a reason when unavailable, a confirm when destructive (§4.2) |
| Sessions and settings | `/sessions` is a workspace picker then a session panel; `/settings` is a list overlay | one panel with a vertical rail, long-path rules, delete session (§5.10) |
| Status panel | session information | tabs with an Account tab and balance, and a Usage tab with an activity heatmap and conversation statistics (§5.10) |
| `/trace` | a flat filterable list, `copy` subcommands, a paginated JSON overlay | a tree of turns and events with duration meters and highlighted JSON detail (§5.14) |
| Filtering | type-to-filter on every filterable list | panels with bare-letter keys filter after `/`; command pickers still type (§3.4) |
| Plugin marketplace | tabs, type-to-filter, a detail panel with install/update/remove buttons | split view, key-driven actions, a persistent restart banner (§5.11) |
| Onboarding | welcome, then a two-step connection guide with buttons | a step strip, no buttons, an optional permissions step, and an explained "things to try" list (§5.12) |
| Account panel | `Sign in`/`Try again`/`Sign out`/`Close` buttons (the waiting state is already key-only); a paste field always visible | button-free in every state; the paste field collapses behind `p`; a balance row (§5.12) |
| Transcript levels | `standard` and `detailed` look identical once a turn settles; `compact` has no diffstat | four distinct levels, a diffstat header, a failure reason line, detail in one place (§5.6) |
| Interaction scenarios | none | palette, `@` picker, changed files, undo, banners, rewind scope, hunk review, key help, job output (§5.13) |
| Degradation | neither `NO_COLOR` nor reduced motion is handled | both are part of the design (§2.3) |

## 8. Open questions for review

Decisions only you can make, each with a recommendation:

1. **Decision panels (§5.7).** Safe-first (A) or grant-first (B)? Recommendation: **A**.
   The Approval scene shows both and runs a stray keystroke through the real key engine.
2. **Rebinding (§3.5).** Where overrides persist (Mayfly settings), whether a plugin's action ids are namespaced by
   plugin name, and the conflict policy (the prototype refuses a clash and names the owner). Recommendation:
   persist in settings, namespace plugin actions, refuse clashes.
3. **Slash-to-filter (§3.4).** Panels with bare-letter keys (marketplace, sessions, job output) filter only after `/`,
   so typing no longer filters there. Recommendation: keep; the alternative is modifier keys (`Ctrl+X`), which are
   slower and harder to discover.
4. **Side conversations (§3.3).** Identity stays in status row 1's center band and `F7`/`F8` move to row 2's right
   cluster, which then also shows for a side conversation with no agents or jobs. Recommendation: keep.
5. **Keys not yet checked against the keymap.** `Alt+↓` and `F6` entering the views, `Alt+↑` selecting the stream
   (some terminals and multiplexers bind `Alt+arrows`), `Ctrl+F` search, `Ctrl+G` external, `Ctrl+J` view
   notification, `?` key help on an empty prompt, `/view <level>` and `Alt+V` for levels. The scene's `Ctrl+K`
   and `Ctrl+V` only simulate adding an image or a paste. Recommendation: approve the intent now and let the
   implementation resolve conflicts through §3.5.
6. **Onboarding permissions step (§5.12)** adds a step to every first run. Recommendation: ship it, with `Default`
   pre-selected.
7. **Delete session (§5.13)** needs the Harness to expose session deletion; if it does not, the scenario and the
   `x` key in sessions drop out. Soft delete with an 8-second undo is the recommendation if it does.
8. **Account balance (§5.10, §5.12)** needs one read-only provider query; the design shows no identity (name or
   email). Recommendation: balance yes, identity no.
9. **Toast and undo lifetimes (§2.4, §3.4).** 5 s for success and info, 8 s for undo.
10. **Unicode fallback.** The design assumes a Unicode terminal (braille, box drawing, `‹ ›`, `● ○ ◐`). A
    plain-ASCII fallback table (for example `●` → `(*)`, `○` → `( )`) is not drawn. Recommendation: specify it in
    the implementation change.
11. **The API additions (§6.4).** Additive props on every basic component, one new builder (`ui.prompt`), and the
    keymap. Recommendation: approve them as one change, since every screen in §5 depends on at least one.
12. **Core and the unused builders (§6.3).** Core uses 20 of the 22 builders. Recommendation: keep `sections` and
    `diagram` in the API for plugins and do not add a core-only path.
13. **Trace data (§5.14).** The tree needs each event to carry its turn; today's aggregated trace items do not. If
    deriving it is costly, the panel falls back to the flat list with the duration meter. Recommendation: add the
    turn to the trace item.
14. **Write highlighting (§5.3).** The language comes from the file extension and the highlight is capped (rows and
    bytes), falling back to plain monospace. Recommendation: cap at the expanded card's row limit.
15. **Turn rule (§5.6).** The user's prompt is separated by a blank row and a timed rule (chosen). Open: whether the rule
    should also carry the turn's elapsed time (`10:06 · 17s`) or only the start time. Recommendation: start time only.

## 9. Prototype

The prototype is three modules that mirror the two layers, and it runs in a terminal with no dependencies. It draws
its own colors and does not use the Mayfly renderer, so it shows the design, not shipped rendering.

| File | Layer | What it is |
| --- | --- | --- |
| [`prototypes/ui-kit.mjs`](./prototypes/ui-kit.mjs) | basic components | the `ui.*` builders, one renderer, one key engine (focus, drafts, events, the keymap, the computed hint row), and the four patterns |
| [`prototypes/mayfly-components.mjs`](./prototypes/mayfly-components.mjs) | Mayfly components | the status rows, editor, activity row, views, stream, trace, and every command panel; imports only the kit |
| [`prototypes/ui-preview.mjs`](./prototypes/ui-preview.mjs) | scenes | the runner and 32 scenes (12 basic, 20 Mayfly) |

```
node docs/design/prototypes/ui-preview.mjs [scene number or name]
node docs/design/prototypes/ui-preview.mjs --list     the scene index
node docs/design/prototypes/ui-preview.mjs --smoke    render every scene, walk it through its keys, exit 1 on an error or a misaligned box
node docs/design/prototypes/ui-preview.mjs --audit    prove the layering and print the matrix of §6.2
node docs/design/prototypes/ui-preview.mjs --keys     print the raw bytes of each key you press and how the prototype decodes them
node docs/design/prototypes/ui-preview.mjs --no-alt   show the non-Alt key first in every hint (for a terminal or multiplexer that eats Alt)
```

`]` / `[` (or `Tab`) move between scenes, `Ctrl+←` / `Ctrl+→` (or `Ctrl+]` / `Ctrl+\`) do the same while a text control holds
the keyboard, `Ctrl+↑` / `Ctrl+↓` scroll a scene taller than the terminal, `}` / `{` jump to the next or previous layer, and `q` quits; each scene lists its own keys in its footer. Pages inside
a scene use `Ctrl+N` / `Ctrl+P`. While a text field has focus the scene keeps every key and `Esc` stops typing. Every
interactive scene is driven by the kit's key engine, so what you press is what a plugin would get.

| # | Scene | Layer | Section |
| --- | --- | --- | --- |
| 1 | Marks and tokens | basic | §2 |
| 2 | Actions | basic | §4.2 |
| 3 | Fields and forms | basic | §4.3 |
| 4 | Replies and validation | basic | §4.10 |
| 5 | Lists | basic | §4.4 |
| 6 | Tabs, wizards, rails | basic | §4.5 |
| 7 | Surfaces and scroll | basic | §4.6 |
| 8 | Content | basic | §4.1 |
| 9 | Feedback and progress | basic | §4.8, §2.4 |
| 10 | Layout | basic | §4.7 |
| 11 | Patterns | basic | §4.9 |
| 12 | A downstream plugin | basic | §6 |
| 13 | Status area | Mayfly | §5.1 |
| 14 | Activity row | Mayfly | §5.3 |
| 15 | Editor | Mayfly | §5.2 |
| 16 | Notices and banners | Mayfly | §5.2 |
| 17 | Tool rows and edits | Mayfly | §5.3 |
| 18 | Conversation stream | Mayfly | §5.6 |
| 19 | Prompt styles | Mayfly | §5.6 |
| 20 | Compaction | Mayfly | §5.6 |
| 21 | Approval, plan review, permission (variants A and B) | Mayfly | §5.7 |
| 22 | Questions | Mayfly | §5.8 |
| 23 | /model and /effort | Mayfly | §5.9 |
| 24 | /sessions | Mayfly | §5.10 |
| 25 | /settings | Mayfly | §5.10 |
| 26 | /status | Mayfly | §5.10 |
| 27 | /plugin marketplace | Mayfly | §5.11 |
| 28 | /account | Mayfly | §5.12 |
| 29 | Onboarding | Mayfly | §5.12 |
| 30 | Command surfaces | Mayfly | §5.13 |
| 31 | /trace | Mayfly | §5.14 |
| 32 | Keybindings | Mayfly | §3.5 |

**What the prototype does not draw.**

- **Width ladders.** Scenes use one width unless they say otherwise. Drawn on purpose: the layout ladder and admission
  (Layout), the status rows and activity row at several widths (`Ctrl+W` in Status area), the editor at three widths,
  the model picker footer fallback and the narrow tab strip and action fold, and the marketplace's two layouts. The
  narrow forms of the other panels follow the §2.4 breakpoints and are described in text.
- **Demo keys.** `Ctrl+K` and `Ctrl+V` add an image or a paste token in the Editor scene (the real attach and paste
  flow is the editor's); `c`, `x`, and `n` in sessions act on mock data; `Ctrl+Y` / `Ctrl+R` in the account scene
  fire a feedback line; the stream's `c` and `Ctrl+G` only report what they would copy or open; some scenes use a
  `Ctrl` key where the design names a bare one because bare letters are the scene's own demo toggles.
- **Motion.** The views' fan-out stagger and row flash are not drawn, and row 2 is always present instead of only while
  a view has something to show.
- **Illustrative painters.** Charts, the Mermaid diagram, markdown, and highlighted code are hand-drawn approximations;
  this document is the specification.
- **Mock data.** Plugins, sessions, balances, models, the trace, the activity heatmap, and the conversation are
  invented; nothing is read from the repository or the network.
- **Colors and timing.** Truecolor drawn by the script, frames from one 100 ms interval; the renderer maps the same
  states to palette tokens and owns its clocks. `NO_COLOR` and reduced motion are properties of the design (§2.3) and
  are not toggled in the scenes.
