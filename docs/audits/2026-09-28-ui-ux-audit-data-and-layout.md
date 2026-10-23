# Mayfly UI/UX audit: data and layout

This section records issues UX-09 through UX-19 of the 2026-09-28 Mayfly UI/UX
audit: data and display errors in the agents pane, git badge, settings forms,
goal/todo surfaces, and provider flows, plus layout defects in the subagent
ScrollablePanel, the editor ghost hint, the todo pane, and the dock overflow
chrome. Audit baseline: `27bc1885c4b59268eb5b972a30f71bbb902fb1f8`. Every
citation was re-verified against the source at that commit. Severity indicates
the order of work, not a security rating. This is an audit record of that
commit; it does not indicate fixes were implemented.

## UX-09: Agents pane summary miscounts members and paints failures as success

- Severity: medium
- Category: data error
- Status: substantiated

### Symptom

Two headline errors in the agents dock pane:

1. Once every member of a group has settled, the summary row renders a green
   `✓` in success tone with "N agents finished" — even when some or all
   members failed or were cancelled. A swarm of three agents that all failed
   reads as a success headline; only the member rows below show the `✗`.
2. While members are still live, the headline reads "Running N agents" where N
   is the total member count, done and failed members included — e.g.
   "Running 5 agents (2 done, 1 failed, 2 running)". The workflow pane's
   equivalent header counts only genuinely unfinished members, so the two
   agent panes disagree about what the number means.

### Root cause

- `settled` at `packages/mayfly/src/transcript/pane-agents.ts:207` treats
  `done`, `failed`, and `cancelled` alike, and the settled branch at
  `pane-agents.ts:216-220` unconditionally emits `{ text: '✓ ', tone: 'success' }`
  followed by "N agents finished". There is no failed/cancelled-aware marker
  or tone branch.
- The running branch at `pane-agents.ts:223` interpolates `view.rows.length`
  (all members) instead of the count of running/waiting rows. The per-phase
  counts are already computed for the breakdown suffix at
  `pane-agents.ts:204-215`, so the correct number is on hand. The workflow
  pane counts correctly at `packages/mayfly/src/transcript/pane-workflow.ts:82`
  (`run.agents.filter(agent => agent.outcome === undefined).length`).

### User impact

Anyone running multi-agent swarms: a partially or fully failed group
announces success in green, and the live headline overstates how many agents
are actually working. Misleading exactly when the user is scanning for
failures.

### Suggested fix

In `paneNode` (`pane-agents.ts:202-225`): derive the settled marker and tone
from the phase counts (for example `✗` in danger tone when any member failed,
`⊘` muted when all were cancelled) and change the running headline to count
only running/waiting rows, reusing the `counts` map built at `pane-agents.ts:204-205`.

## UX-10: A cut turn leaks the agents pane's 250 ms tick, and a cancelled member's clock keeps counting

- Severity: medium
- Category: data error
- Status: substantiated

### Symptom

Interrupt a turn while a spawn-class call is still unanswered (no result, no
live overlay). The agents pane keeps its member row, correctly labeled
"cancelled" — but the row's elapsed time keeps counting up, repainting about
once a second, and the pane's 250 ms interval timer never stands down. The
state persists until the next turn's facts arrive.

### Root cause

- The render path passes the turn-ended flag: `currentView` calls
  `phaseOf(item, live, turnEnded(item))` at `packages/mayfly/src/transcript/pane-agents.ts:318`,
  and `turnEnded` (`pane-agents.ts:257`) is true once the turn is inactive, so
  the row maps to "cancelled" (`pane-agents.ts:140`).
- The tick guard does not pass it: `hasRunningMember` (`pane-agents.ts:155-160`)
  calls `agentPhase` → `phaseOf` with the default `turnEnded = false`
  (`pane-agents.ts:134`), so the same unanswered call falls through to
  `pending`, and `agentPhasePresentation('pending')` returns the label
  `running` (`packages/mayfly/src/transcript/agent-presentation.ts:33`).
  `hasRunningMember` therefore stays true and `syncTick` never reaches
  `stopTick` (`pane-agents.ts:432-444`; `PANE_TICK_MS = 250` at `pane-agents.ts:76`).
- The growing clock: `elapsedSeconds` (`pane-agents.ts:150-153`) is called
  with `terminal = true` for the cancelled label (`pane-agents.ts:319`), but a
  cut call has neither a live `endedAt` nor a result, so `end` falls back to
  `now`. Elapsed time is part of the row's volatile key (`pane-agents.ts:342`),
  so each second the view republishes.
- Note the adjacent `settled` computation in `sync` (`pane-agents.ts:367-371`)
  does use `turnEnded` and clears members at the next turn boundary
  (`pane-agents.ts:372-373`); only `hasRunningMember` is inconsistent.

### User impact

After any interrupted turn with an in-flight subagent spawn: a phantom
"cancelled" row whose clock visibly runs up, plus a permanent 250 ms timer
and a repaint per second until the user starts another turn. Wrong data on
screen and wasted render work in every idle session that cut a turn.

### Suggested fix

Make `hasRunningMember` (`pane-agents.ts:155-160`) agree with the render path:
pass `turnEnded` into the phase computation (or reuse the row views from
`currentView`) so a cancelled member no longer counts as running. Separately,
consider freezing the displayed elapsed for `cancelled` rows at the turn-end
time instead of `now` in `elapsedSeconds` (`pane-agents.ts:150-153`).

## UX-11: A slow or failing git status probe renders a dirty repo as a clean synced branch

- Severity: medium
- Category: data error
- Status: substantiated

### Symptom

On a large or slow repository (network filesystem, heavy index), the footer
git badge can show a bare branch name — no `±`, no `+N -M`, no `↑/↓` — while
the working tree is in fact dirty and the branch is ahead or behind. The
wrong "clean" reading then sticks for up to 15 seconds, and repeats on every
probe cycle while the repository stays slow.

### Root cause

- Every git invocation is capped at 500 ms (`SPAWN_TIMEOUT_MS`,
  `packages/mayfly/src/transcript/status-git.ts:39`; applied as the
  `execFile` timeout at `status-git.ts:76`), and any error or timeout makes
  the runner resolve `null` (`status-git.ts:72-79`).
- `probeStatus` (`status-git.ts:200-210`) maps that `null` to a zeroed
  status — `dirty: false, ahead: 0, behind: 0, diffAdded: 0, diffDeleted: 0`
  (`status-git.ts:202-204`) — indistinguishable from a genuinely clean,
  synced tree. The zeroed value is then cached under the 15-second
  `STATUS_TTL_MS` (`status-git.ts:36`) at `status-git.ts:224-226`, so the
  failure is memoized, not retried.
- `formatGitBadge` (`status-git.ts:237-247`) emits the bare branch when all
  parts are empty, so the failure surfaces as "clean" rather than as no data.

### User impact

Users working in repositories where `git status --porcelain -b` regularly
exceeds 500 ms see a confidently clean, synced branch while they have
uncommitted work or unpushed commits — worse than showing nothing, because it
actively misinforms a commit/push decision.

### Suggested fix

Keep "probe failed" distinct from "probe returned clean": have `probeStatus`
(`status-git.ts:200-210`) preserve the previously cached status (or an
explicit unknown state) on a `null` result instead of substituting zeros, and
do not let a failed probe refresh `fetchedAt` for the full TTL — retry
sooner. If an unknown state is introduced, the badge should omit the dirty
and sync parts rather than assert them.

## UX-12: Settings selects leak raw JSON ids; multiselects hide stale values that still fail save validation

- Severity: medium
- Category: data error
- Status: substantiated

### Symptom

When a value stored in `settings.yaml` is not among the options the form
currently offers — for example an agent preset that was deleted while still
set as `agent-preset-registry.default` — a collapsed select renders the raw
internal id with literal quotes, e.g. the value shows as `"some-preset"`
including the quote characters. For a multiselect the same stale value
vanishes from the display entirely (the field can even read "None
selected"), yet saving still fails with "A selected option is unavailable" —
an error about a selection the user cannot see anywhere.

### Root cause

- `settingsProjection` encodes option ids and field values as
  `JSON.stringify(value)` (`packages/mayfly/src/interaction/settings-model.ts:76`
  for select, `settings-model.ts:79` for multiselect). Dynamic option lists
  come from live services (`packages/mayfly/src/interaction/settings-command.ts:21-25`),
  so a stored value naming a deleted preset is not among the options.
- The collapsed select renderer falls back to the raw field value when no
  option matches: `field.options.find(...)?.label ?? field.value` at
  `packages/mayfly/src/core/ui-patterns.ts:352` — and the value is the JSON
  encoding, quotes included.
- The multiselect renderer keeps only values that match an option
  (`ui-patterns.ts:353`), silently dropping unknown stored values from the
  display.
- Save validation still sees the full stored list:
  `selected.some(id => !definition.options.some(...))` at
  `packages/mayfly/src/core/ui-interaction-form.ts:258` produces "A selected
  option is unavailable" for the invisible entries.

### User impact

Anyone whose settings file drifts from the current option set (deleted
presets, renamed enum values, hand-edited YAML): selects show cryptic quoted
ids, and multiselects present a save-blocking validation error with no
visible way to find or clear the offending value.

### Suggested fix

- In `renderFormField` (`ui-patterns.ts:352-353`): render unmatched select
  values decoded (parse the JSON id back to the scalar) and mark them as
  unavailable, and surface unmatched multiselect values explicitly (e.g. an
  extra muted row listing them) instead of dropping them.
- In `settingsProjection` (`settings-model.ts:74-79`): consider appending the
  currently stored value as a disabled/flagged option when it is absent from
  the candidate list, so the form shows what is actually configured and the
  user can change away from it.

## UX-13: Goal status leaks internal enums, unit-less fractions, and conflicting tones

- Severity: medium
- Category: unclear prompts
- Status: substantiated

### Symptom

With a goal attached, the status footer reads e.g. "Goal active · 2/10 ·
armed":

1. `armed` / `disarmed` is raw internal enum jargon shown to end users.
2. The `2/10` fraction carries no unit or label — the user cannot tell it is
   "round 2 of 10".
3. The same goal state is painted with conflicting tones across surfaces:
   `blocked` is warning-yellow in the footer but red `✕` danger in the todo
   pane; `paused` is warning in the footer but muted `❚❚` in the pane.
4. A completed goal disappears from the todo pane but keeps rendering "Goal
   complete · N/M · armed" in the footer indefinitely.

### Root cause

- `goalStatusText` (`packages/mayfly/src/transcript/status-goal.ts:19-22`)
  interpolates `goal.activation` directly; the type is the process-local
  continuation flag `GoalActivation = 'armed' | 'disarmed'` (dsh-goal
  `lib/types/types.d.ts:58`). The same line prints
  `${goal.roundsStarted}/${goal.maxGoalRounds}` with no unit. The todo pane
  title at least adds the human-readable objective next to its own fraction
  (`packages/mayfly/src/transcript/pane-todo.ts:227-230`).
- Tone mapping diverges by surface: the footer derives
  active→accent / complete→success / blocked,paused→warning at
  `status-goal.ts:39-45`, while the todo pane's `GOAL_BADGE` maps blocked→
  `✕` danger and paused→`❚❚` muted at `pane-todo.ts:202-206`.
- `goalStatusText` has no `complete` case (`status-goal.ts:19-22`): any
  defined goal renders text, so a completed goal stays in the footer forever,
  while the todo pane deliberately hides completed goals (`pane-todo.ts:209`).

### User impact

Users running goal-driven sessions see internal vocabulary, an unexplained
fraction, two different severity signals for the same state on screen at the
same time, and a permanent "Goal complete" badge that never clears.

### Suggested fix

- In `goalStatusText` (`status-goal.ts:19-22`): drop the raw `activation`
  segment (or translate it into user vocabulary only where it changes what
  the user should do), and label the fraction (e.g. "round 2/10").
- Return empty text for a completed goal (mirroring `goalBadge` at
  `pane-todo.ts:208-211`), or give `complete` an explicit, time-bounded
  treatment.
- Align the tone vocabulary between `status-goal.ts:39-45` and
  `pane-todo.ts:202-206` so `blocked` and `paused` mean the same severity in
  both places.

## UX-14: Miscellaneous formatting and display errors

- Severity: low
- Category: data error
- Status: substantiated (sub-item h is suspected; sub-item c is dormant)

A cluster of small, independent display defects. Each sub-item is listed with
its own symptom, cause, and fix direction.

### Symptom

1. **"1 jobs"**: the footer job badge is never singularized — "⏵ 1 jobs".
2. **Hour-long durations**: elapsed times of one hour or more render as e.g.
   "125m 3s" in the activity row, agents pane, and workflow pane.
3. **Loader raw milliseconds**: a loader with elapsed time renders "12345ms"
   with no rounding.
4. **Bare "blocked:" row**: a blocked goal with no recorded reason renders a
   `blocked:` row with nothing after the colon.
5. **Duplicated `[image]`**: a user message containing images shows one
   `[image]` marker inside the message text and another `[image]` placeholder
   row per attachment.
6. **Stale credential status**: an open `/provider` list keeps showing "key
   configured" / "no key set" from when it was built, after the key is saved
   or cleared elsewhere.
7. **Wrong clear-key failure message**: when clearing a stored key fails
   because the credential is not writable, the feedback says "Provider
   removed; its external credential remains unchanged" — nothing was removed.
8. **Revived stale working row**: a `tool/result` event landing after its
   turn ended flips the activity pane back to a live "working" phase.

### Root cause

1. `packages/mayfly/src/transcript/status-jobs.ts:35` always emits
   `⏵ ${count} jobs`. Sibling surfaces pluralize carefully (`tool`/`tools` at
   `packages/mayfly/src/transcript/pane-agents.ts:185`, `agent`/`agents` at
   `packages/mayfly/src/transcript/pane-workflow.ts:135`).
2. `compactElapsedSeconds` (`packages/mayfly/src/transcript/agent-presentation.ts:16-20`)
   only knows seconds and minutes; there is no hours branch. Consumers:
   `packages/mayfly/src/transcript/pane-activity.ts:222`,
   `pane-agents.ts:146-148`, `pane-workflow.ts:67-68`.
3. `renderLoader` interpolates the raw value: `` ` ${String(node.elapsedMs)}ms` ``
   at `packages/mayfly/src/core/ui-patterns.ts:400`. Dormant today: the
   contract admits `elapsedMs` (`packages/ui/src/contracts.ts:138`) and the
   validator accepts it (`packages/mayfly/src/core/ui-validator.ts:1065-1072`),
   but no producer in `src/` passes it, so the formatting bug is proven but
   not currently reachable.
4. `blockedReasonText` returns `''` when `blockedReason` is absent
   (`packages/mayfly/src/transcript/pane-todo.ts:213-215`), and the blocked
   row renders unconditionally for a blocked goal (`pane-todo.ts:241-251`).
5. The projection inlines one `[image]` per image block into the message
   text (`packages/mayfly/src/conversation/projection.ts:149-156`, marker at
   `:153`) and also keeps the `images[]` list (`projection.ts:466-475`);
   `UserMessageComponent.render` then prints the text (markers included) plus
   one placeholder or image row per attachment
   (`packages/mayfly/src/transcript/components.ts:276-283`) and never
   dedupes. The projection-level inlining is deliberate for exports.
6. The `/provider` list computes the credential status once at build time
   (`packages/mayfly/src/interaction/provider-commands.ts:49-56`) and rebuilds
   only on `settings/document-updated` (`provider-commands.ts:78`); saving a
   key through onboarding or clearing one in the editor fires no such event.
   The provider editor itself shows the correct pattern of subscribing to
   credential observations.
7. The early return at `packages/mayfly/src/interaction/provider-edit.ts:260`
   serves both `delete` and `clear-key` but always says "Provider removed;
   its external credential remains unchanged" — for `clear-key` nothing was
   removed (the success and catch paths at `provider-edit.ts:264` and
   `:270` do distinguish the two). Reachable only when writability changes
   between render and activation, since the button is disabled when the
   credential is not writable (`provider-edit.ts:157`).
8. **Suspected.** The `tool/result` case (`packages/mayfly/src/conversation/facts.ts:189-206`)
   sets `phase: 'tool', active: true` unconditionally — unlike its neighbors
   it has no turn/outcome guard (compare `step/end` at `facts.ts:208` and
   `turn/end` at `facts.ts:210-215`, which clear to idle). A spawn-class
   subagent result landing after its parent's `turn/end` would revive a live
   activity row with elapsed ticking from the stale `turnStartedAt` until the
   next `turn/start`. Marked suspected: no test covers result-after-turn-end,
   so this depends on the real event ordering of background agents, which was
   not executed.

### User impact

Mostly polish-level noise that erodes trust in the chrome's numbers: wrong
plurals, unreadable long durations on any session running over an hour, a
duplicate marker per image attachment, a stale credential hint while
configuring providers, and one misleading success message in a rare race.
Sub-item 8, if the event ordering occurs, shows a finished turn as actively
working.

### Suggested fix

1. Singularize in `status-jobs.ts:35` (`job`/`jobs`).
2. Add an hours branch to `compactElapsedSeconds` (`agent-presentation.ts:16-20`),
   e.g. `2h 5m`.
3. Format `elapsedMs` through the same duration helper in `renderLoader`
   (`ui-patterns.ts:400`).
4. Suppress the reason row (or show a placeholder) when `blockedReasonText`
   is empty (`pane-todo.ts:241-251`).
5. Dedupe in `UserMessageComponent.render` (`components.ts:276-283`): when the
   inline `[image]` markers already represent the attachments, skip the
   per-attachment placeholder rows for unresolved images (keep the export
   inlining untouched).
6. Rebuild the `/provider` list on credential observations as well, the way
   the provider editor subscribes to both settings and credential changes.
7. Branch the message on `event.actionId` at `provider-edit.ts:260`, as the
   `:264` path already does.
8. Add the same turn/outcome guard to the `tool/result` case (`facts.ts:189`)
   that `step/end` and `turn/end` already use, and add a result-after-turn-end
   test to confirm the ordering.

## UX-15: Subagent panel's title rule is clipped whenever the status footer has two rows or lanes are open

- Severity: medium
- Category: overlapping layout
- Status: substantiated

### Symptom

Open the readonly subagent transcript panel while any header/bottom dock lane
is open (todo, agents, workflow, queue panes) — or while any status entry
occupying footer row 2 exists — and the panel's first row, the
`╭ Subagent · <label> ─ hint ╮` title bar, is missing. The panel body starts
abruptly at the second row, so the user loses the agent label and the
key hints.

### Root cause

- `ScrollablePanel.bodyBudget` (`packages/mayfly/src/core/scrollable-panel.ts:101-105`)
  budgets body rows as `screen.rows - footerRows - 4` (its own footer row
  count, then a fixed 4), so the whole panel always renders `rows - 2` lines:
  top rule (1) + body + own footer + bottom rule, as assembled at
  `scrollable-panel.ts:84-92`.
- The dock grants the editor slot only
  `rows - actualFooterRows - 1 - laneRows`: the lane accounting lives in the
  dock callback at `packages/mayfly/src/core/terminal.ts:667-674` and the
  1-transcript-row reservation at `terminal.ts:300`, matching
  `screen.editorViewport` (`packages/mayfly/src/core/screen.ts:206`).
- The two agree only when the real status footer is exactly 1 row and no
  lanes are open. A 2-row footer or any open lane makes the panel too tall,
  and the dock drops the excess from the top —
  `entry.rows.slice(-allocated)` at `terminal.ts:322` — so the first row to
  disappear is the title rule (`scrollable-panel.ts:84-88`).
- `MayflyStatusDefinition.row?: 1 | 2` is public API
  (`packages/ui/src/contracts.ts:184`; rendered at
  `packages/mayfly/src/transcript/status-model.ts:35-36`), so any plugin —
  including third-party — contributing a row-2 status entry triggers this
  even with no lanes open.
- Compounding it, the panel's inner transcript renderer is told the true
  height (`viewportRows: () => screen.editorViewport.rows`,
  `packages/mayfly/src/interaction/session-transcript-panel.ts:68`), so the
  shell and its body already budget against two different height truths.

### User impact

Anyone opening a subagent transcript on a crowded dock — a common state
during agent work, when todo/agents/workflow panes are open — loses the
panel's title and hints row. Degradation grows with each additional lane row.

### Suggested fix

Budget the panel against the real grant instead of a constant: derive body
rows from `screen.editorViewport.rows` (the same source
`session-transcript-panel.ts:68` already uses for the body) minus the panel's
own chrome rows, in `ScrollablePanel.bodyBudget`
(`scrollable-panel.ts:101-105`). Alternatively, make the dock drop overflow
from the bottom of an editor-slot replacement rather than the top, so the
title survives clipping.

## UX-16: Ghost-hint width math uses UTF-16 code units, not display columns

- Severity: medium
- Category: overlapping layout
- Status: substantiated

### Symptom

Type a slash command whose argument hint contains wide (CJK) characters —
host commands supply the hint text, e.g. a Chinese `<文件路径>`. The dimmed
ghost hint renders wider than the space it replaces: the editor content row
exceeds its allotted width, the frame clamp cuts the row's right edge (eating
the editor's right `│` border and logging to `mayfly-overflow.log`), and the
ellipsized hint can end in a broken glyph where a surrogate pair was split.

### Root cause

- `truncateHint` (`packages/mayfly/src/core/chrome.ts:108-113`) measures and
  slices with `hint.length` and `hint.slice(0, maxLen - 1)` — UTF-16 code
  units — while `maxLen` is a budget in terminal columns. A CJK hint passes
  the `hint.length <= maxLen` check while occupying twice as many columns.
- The room calculation has the same flaw:
  `available = contentWidth - textLength - …` at `chrome.ts:145-146`, and the
  caller passes `this.editor.getText().length` as `textLength`
  (`packages/mayfly/src/core/components.ts:387`) even though the parameter is
  documented as "the visible length of the real editor text"
  (`chrome.ts:125`). CJK in the typed command itself therefore also skews the
  budget, and the insert position derived from it
  (`visibleIndexToRaw(line, EDITOR_LEFT_PADDING + textLength)`, `chrome.ts:151`)
  lands at the wrong column. The padding repair at `chrome.ts:153` likewise
  counts `trimmed.length` in code units.
- The hint originates from host command metadata
  (`ctx.commands.find(agent, canonical)?.input?.hint`,
  `packages/mayfly/src/interaction/editor-plus.ts:517`), so non-ASCII hints
  are a supported input, not an edge invention. All existing tests pin ASCII
  only (`packages/mayfly/tests/core/chrome.spec.ts:381-429`), which is why
  the row-width invariant is never exercised with wide characters.

### User impact

Users with CJK command hints (or CJK in typed slash commands) get a corrupted
editor row: missing right border, overflow-log noise, possibly a replacement
glyph in the hint. Broken layout on an ordinary input path for those users.

### Suggested fix

Convert the ghost-hint math to display columns end to end: measure with
`visibleWidth`, clip with `sliceByColumn`/`truncateToWidth` (grapheme-safe,
already imported at `chrome.ts:14`), and pass the editor text's visible width
from `components.ts:387` instead of `.length`. Add wide-character cases to
`tests/core/chrome.spec.ts` covering exact-fit, ellipsized, and
surrogate-boundary hints.

## UX-17: Todo rows wrap while siblings truncate; folded view exceeds its 5-row promise; expanded list unbounded

- Severity: low
- Category: overlapping layout
- Status: substantiated

### Symptom

Long todo items wrap onto as many screen rows as they need, while the pane's
own title and blocked-reason rows truncate. As a result the folded view —
documented and labeled as showing at most 5 items plus a footer — can take
many more screen rows, an expanded long list can grow without limit, and when
the dock lane runs out of rows the part clamped away is the pane's tail,
including the "all N items · ctrl+t to collapse" footer the user needs to
shrink the pane back.

### Root cause

- Todo item rows are emitted without an overflow option in both the expanded
  and folded branches (`packages/mayfly/src/transcript/pane-todo.ts:254` and
  `:260`), and the compiler's `rich-text` default is wrap
  (`packages/mayfly/src/core/ui-compiler.ts:1087-1089`). The title row and
  blocked row do pass `overflow: 'truncate'` (`pane-todo.ts:238`, `:249`), so
  siblings behave differently.
- The fold cap is `MAX_VISIBLE = 5` items (`pane-todo.ts:47`), but with
  wrapping, 5 items cost more than 5 rows.
- The pane registration declares no `size` cap (`pane-todo.ts:283-288`), so
  an expanded list is bounded only by the lane budget; the lane fits panes
  head-first via `fitSurfaceRows` (`packages/mayfly/src/core/surface-manager.ts:241-245`),
  which drops the tail rows — the expand/collapse footer
  (`pane-todo.ts:256`, `:262`) — first. (The queue pane's rows wrap the same
  unbounded way, `packages/mayfly/src/interaction/pane-queue.ts:39`.)

### User impact

Users with long todo texts or long lists lose the compact 5-row panel the UI
promises, and under dock pressure lose the very footer control that would
let them collapse the pane.

### Suggested fix

Add `overflow: 'truncate'` to the item-row nodes in `todoNode`
(`pane-todo.ts:254`, `:260`) so item rows behave like the title and blocked
rows, and declare a `size.max` on the pane registration (`pane-todo.ts:283-288`)
so an expanded list cannot consume the whole lane. If keeping wrapped rows
is deliberate, at least render the expand/collapse footer before the item
rows so the clamp cannot remove it.

## UX-18: Inconsistent overflow indicators across lanes and chrome

- Severity: low
- Category: inconsistent interaction
- Status: substantiated

### Symptom

Three different behaviors for content that does not fit, visible in the same
chrome layer:

1. A header lane taller than 4 rows silently loses its tail — no marker at
   all.
2. A bottom pane cut short shows a `… +N more rows` marker — except when it
   is allotted exactly one row, in which case it shows its first row with no
   indication that more content is hidden.
3. Truncated text ends with three different ellipsis styles depending on the
   panel: `foo...`, `foo…`, or a silent `foo` cut with no indicator.

### Root cause

1. Non-bottom lanes are hard-sliced at `SURFACE_HEADER_MAX_ROWS = 4`
   (`packages/mayfly/src/core/surface-manager.ts:88`) by
   `renderSurfaceLane`'s bare `.slice(0, …)` (`surface-manager.ts:344`), with
   no overflow row.
2. Bottom panes go through `fitSurfaceRows` (`surface-manager.ts:241-245`),
   which appends the `  … +N more rows` marker (`surface-manager.ts:317-320`)
   only when the allotment is at least 2 rows; at `size <= 1` it returns the
   head slice with no marker (`surface-manager.ts:243`).
3. Ellipsis styles: `framePanel` clips titles/footers through pi-tui's
   `truncateToWidth` with its default `'...'`
   (`packages/mayfly/src/core/chrome.ts:339`, `:344`, `:353`; default
   confirmed in pi-tui 0.84.2), `fitBorderTitle` appends `'…'`
   (`chrome.ts:191`), and `topRule` truncates with an empty ellipsis — no
   indicator (`chrome.ts:412`). Adjacent product code standardizes on `'…'`
   (`packages/mayfly/src/core/plugin-view.ts:74`).

### User impact

Users cannot form a reliable mental model of "there is more here": a plugin
header pane loses rows invisibly, a squeezed bottom pane looks complete when
it is not, and the same truncation is signposted three different ways in
adjacent panels.

### Suggested fix

Unify on one overflow vocabulary: give non-bottom lanes the same
`… +N more rows` treatment as bottom lanes (route them through
`fitSurfaceRows` or an equivalent marker in `renderSurfaceLane`,
`surface-manager.ts:336-345`), emit the marker even for a 1-row allotment
(replacing the head row), and pass an explicit `'…'` at the `framePanel`
(`chrome.ts:339`, `:344`, `:353`) and `topRule` (`chrome.ts:412`) call sites.

## UX-19: ScrollablePanel has no scroll-position affordance and vanishes below width 5; tall overlays hard-clip

- Severity: low
- Category: unfriendly interface
- Status: substantiated (the tall-overlay mechanism is suspected — see Root
  cause)

### Symptom

1. The subagent ScrollablePanel — top rule, framed body, footer, bottom rule —
   offers no scrollbar cell or position counter. Reading a long subagent
   transcript, the user cannot tell whether more content exists above or
   below without trying scroll keys.
2. At widths below 5 columns the panel renders nothing at all, borders
   included, instead of degrading.
3. An overlay whose content exceeds its frame height is hard-clipped; the
   clipped tail is unreachable unless the surface embedded its own scroll
   node.

### Root cause

1. The chrome assembled in `ScrollablePanel.render`
   (`packages/mayfly/src/core/scrollable-panel.ts:84-92`) contains no
   scroll-position element — compare the select list's `(3/17)` indicator at
   `packages/mayfly/src/core/ui-patterns.ts:152-154`. The panel tracks
   `scrollOffset`/`bodyTotal` internally (`scrollable-panel.ts:68-80`) but
   never displays them.
2. `render` returns `[]` when `width < 5` (`scrollable-panel.ts:62`), so the
   whole panel — including its borders — disappears on very narrow terminals
   rather than degrading to a bare rule.
3. **Suspected.** `OverlayComponent.render` passes over-tall content to
   pi-tui's `renderLayoutFrame`, clipped to the frame height
   (`packages/mayfly/src/core/surface-renderer.ts:205-211`), and the default
   max height is a third of the screen (`OVERLAY_DEFAULT_MAX_HEIGHT`,
   `surface-renderer.ts:20`). Shipped surfaces embed their own scroll nodes
   (`ui.scroll(...)` in `interaction/help.ts:38`, `interaction/jobs.ts:59`,
   `interaction/plugin-commands.ts:310`), so this is latent for first-party
   UI; a plugin overlay rendering a plain long stack loses its tail silently,
   and non-capturing overlays cannot receive scroll keys at all. Marked
   suspected because the impact depends on third-party overlay content.

### User impact

Users reading long subagent transcripts lose orientation; users on extremely
narrow terminals lose the panel entirely with no remnant; plugin authors can
unknowingly ship overlays whose content is unreachable.

### Suggested fix

Render a position indicator in the panel chrome — e.g. a `(N/M)`-style
counter or a `↑/↓` marker in the top rule or footer
(`scrollable-panel.ts:84-92`) — driven by the existing `scrollOffset` and
`bodyTotal`. Replace the `width < 5` early return (`scrollable-panel.ts:62`)
with a degraded minimal render (a clipped rule) instead of zero rows. For
overlays, consider auto-wrapping over-tall non-scrolled content in a scroll
container, or at least surfacing a clipped-content marker in the frame.
