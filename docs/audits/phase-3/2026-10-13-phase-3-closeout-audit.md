# Phase 3 closeout audit

Audit baseline: `feat/3a` at `9b8d9ae` (`main` merged in) plus the closeout changes committed as `d5c6337` (docs), `9ea32cb`
(decision tests), `cdf2826` (the `phase3` integration replay and replay repairs), and `41b6810` (goldens). Report date:
2026-10-13. This is an audit record of that state. It does not define current behavior. The audit changed no product code;
every finding below is open unless it says otherwise.

## Why this audit exists

Phase 3 was built one round at a time and the owner accepted each component's look alone. Nobody had yet looked at the
components together in one session, and the decision tests, goldens, and documentation of rounds 4 to 9 were still owed.
This audit did four things: it adjusted the documentation, wrote the owed decision tests, added a long scenario that shows
every session state, and checked how the pieces fit. The accepted look is the standard. A finding here is a place where
two pieces disagree with each other, with the code, or with a document. It is never a request to change a look that the
owner accepted.

## Conclusion

The pieces fit together well. In the 61 checkpoints of the integration tour, the blank row between rows held, the prompt
stayed on the same row except where a decision card replaces it, tier counts matched the lines shown, and selection,
search, and the notification row stayed inside their rows at 120, 60, 40, and 28 columns. Of the 61 older golden
checkpoints that now differ, 56 are the accepted rounds 4 to 9 showing through, 4 are replay text, and 1 needs a look.

What needs attention, in this order:

1. **D1, a node-slot re-lease loses the interaction model.** This is a regression from round 9 (3e.2) that the test suite
   caught, and the tests that caught it were weakened during the closeout instead of the code being fixed.
2. **O1, what an interrupted tool call looks like.** The look the owner accepted for a cut-off call (`⊘`) cannot happen in a
   real session. A real interrupt draws `✗`. The owner decides what to show.
3. **D2 to D4, three places in the integration scenario where the screen contradicts itself** (a subagent both finished and
   running, an approved command shown again as pending, multi-hunk line numbers that restart at 1).

Everything else is a decision about wording or width (O2 to O6), stale comments and documents (C1 to C6), two perf
observations (P1, P2), and the remaining golden and snapshot review (O7).

## What was done

| Piece | Result |
| --- | --- |
| Documentation | 13 files adjusted against the code (roadmap status and 3a, 3c, 3d, 3e text, component library 5.7, reference rows, spec 7.1, package AGENTS, READMEs in both languages, interaction model, seams, harness adaptation, the two Website panes pages for the spinner wording). `check:agent-docs` passes. The Website was not built. |
| Decision tests | About 40 spec files for groups 3b to 3e: tool lines and edit/write blocks at every tier, activity row, notification line, compaction row, `mayflyTick`, decision cards and their plugins, levels, row text, search, selection bands, and the width scan of every Phase 3 renderer. Stale specs from rounds 4 to 9 were repaired. |
| Integration scenario | Replay `phase3` (50 marks) and the scenarios `phase3`, `phase3-tour` (61 checkpoints), `phase3-levels` plus `-compact`, `-detailed`, `-verbose`, `phase3-select`, `phase3-search`, `phase3-live`, `phase3-narrow`, `phase3-resume`. All frame runs pass at their sizes, including 28 columns and `--no-color`. Their goldens are not accepted yet. |
| Replay repair | The replay builder stored an interrupted call with no result, which the session loader rejects. Eleven scenarios could not be reopened with `dsh --resume`. The builder now writes the same closer a real interrupt writes, and all 27 scenario sessions resume. Three failing workflow tests were fixed, and `search-block` got a settle wait. |
| Goldens | 53 new goldens (scenarios that had none), 4 hint-row updates (`idle`, `schedule`), 15 re-recorded after the replay repair. No `phase3*` and no `app-*` golden was accepted. |

## Verification state

| Check | Result |
| --- | --- |
| `typecheck`, `lint`, `check:lib`, `check:agent-docs`, `check:examples` | pass |
| Workflow tests (`script/tests`) | 116 of 116 pass |
| Vitest `perf` project | 38 of 38 pass |
| Vitest `suite` project | passes except 7 file-snapshot tests in `tests/design/` (O7) |
| `smoke:happy`, `smoke:pty:output` | pass with `DSH_BIN` set |
| `perf --assert` | passes except `perf-focus` (P2) |
| Full tier, one run | failed on its first run: `dsh` was not on `PATH`, plus the workflow tests that R then fixed. It was not rerun after the fixes. A clean full-tier run is still owed. |

## Findings that need a fix

### D1. A node-slot re-lease loses the interaction model (medium)

Since round 9 (commit `5185723`, 3e.2) every `NodeSlotLease` creates its own `events` endpoint
(`core/node-slot.ts` near line 278). Before that commit the endpoint was a module-level constant. The interaction
service reuses a model only when the endpoint is the same object (`core/ui-interaction-state.ts` 42 to 52), so when a
host disposes its core and mounts a new one, the slot gets a new model (`slot/5` instead of `slot/2`). The cursor goes back
to `item-0` where the test expects `item-3`, and the draft in the test host's prompt comes back empty. The comment at
`node-slot.ts` near line 341 ("the endpoint is shared by every slot, so the owner keeps one model per id") is no longer true.

Reach in the product: the only production user of the node slot is the transcript stream (`transcript.conversation`). The
real editor draft is not affected, because it survives a reload through `interaction/draft-stash.ts` (its own test
proves it). The stream's cursor, focus, and search or selection state do live in the slot's model, so a re-lease of the
stream resets them. Which user actions re-lease the slot (a theme change, a settings change, a Fiber restart) was not traced.

Evidence: the original `tests/core/node-slot.spec.ts` fails two assertions at HEAD. During the closeout the test agent
removed the draft and cursor assertions from `core/node-slot.spec.ts` and `core/screen.spec.ts` and weakened a model identity
check to compare slot ids. Those weakened tests now pass, so the suite no longer reports this.

Recommendation: make `NodeSlotHost` own one endpoint per slot id, dispatching only to the live lease so a stale lease still
cannot publish or focus; fix the comment; restore the removed assertions in both specs. No owner decision is needed.

### D2. A subagent is shown as finished and running at once (medium)

In `phase3-tour`, checkpoint `rate-limited` (120x40), the run shows `✓ Subagent(Rewrite the client retry) · 0.8s` and the
live region shows `● Running 1 agent … 6m 3s` for the same agent. Either the tool line should say the agent was started in
the background (not `✓` done), or the run should omit it. It is not yet known whether the replay data is inconsistent
(parent call finished, child still running) or the stream and the pane read different facts. Check the replay first.

### D3. An approved command is shown again as a pending row (medium)

In `phase3-tour`, checkpoints `queue-card-2` and `queue-card-3`, `✓ Bash(rm -rf dist build) · allowed · 0.9s` sits above,
and the "Three actions need your approval" block shows the same call again as `● Bash(rm -rf dist build)` with no
outcome. The round 8 rule is that a command is never repeated under its line. Check whether the replay issues the call
twice or `transcript/tool-calls.ts` (`awaiting()`, `decided()`) draws one call as both settled and pending.

### D4. Gutter numbers restart at 1 in each hunk of a multi-hunk edit (medium)

In `phase3-select` (120x50), checkpoint `edit-walk`, hunk 2 of `src/client.mjs` shows `1 │ const row51 = paint(51)`, and
`src/config.mjs` hunk 2 starts at `5`. The round 5 brief says the gutter numbers the modified file. The suspect is
`transcript/official-model.ts` `fileChangeModel`, whose hunks carry no start line. Confirm in the Harness edit result whether
each hunk carries its start line; if it does, pass it through to the diff block.

### D5. Esc during a running write leaves no trace (unconfirmed)

In `phase3-live`, checkpoints `tool` and `interrupted` are identical: the write stays a grey `●`, the activity row still
says `Writing files`, and no stop row appears. The replay may simply not be able to drive an interrupt. Confirm in the live
profile: stream a write against the stub model and press Esc. If that works, change the scenario; if not, it is a product bug.

### D6. Compaction numbers disagree with the window (unconfirmed, low confidence)

In `phase3-tour`, checkpoint `manual-failing`, a 32k window shows `context 100% → 26% · ~37.1k → ~8.3k tokens`, and the
next compaction shows `~2.3k → ~0 tokens` while the footer says 8%. This may be replay data (`shadowedTokens`,
`summaryTokens`, `contextWindow` in the replay) and not a product bug. Check the replay values first.

## Findings that need an owner decision

### O1. What an interrupted tool call looks like (medium)

The look accepted for a cut-off call is `⊘ Bash(...)`. `transcript/tool-calls.ts` `stateOf` draws `⊘` only for a call that
has no result in a closed turn. The Harness never writes that state. What it writes:

- A live Esc or Ctrl+C during a running tool settles the call with code `ABORTED` and the text `Error: tool call aborted`.
  The stream draws `✗ Bash(...) · Error: tool call aborted`.
- A call aborted before it was sent gets `ABORTED_BEFORE_DISPATCH`, and a call that never started gets `TOOL_NOT_STARTED`.
- A session killed mid-tool is repaired on resume with `TOOL_OUTCOME_UNKNOWN`: "The tool call was interrupted after it was
  recorded, but no result was durably recorded. Its outcome is unknown…". The stream draws `✗` plus that long text.

So the earlier `⊘` look came from the replay builder and cannot be reached in real use. The builder now stores the real
closer, 15 goldens were re-recorded to `✗`, and the interrupted scenarios show the real look.

Options: (A, recommended) `⊘` with a short reason for calls that never ran (`TOOL_NOT_STARTED`, `ABORTED_BEFORE_DISPATCH`) and
for a live `ABORTED`, while `TOOL_OUTCOME_UNKNOWN` stays `✗` or a warning with a short "outcome unknown", because "cancelled"
would be false for a call that may have had a side effect. (B) keep `✗` everywhere and shorten only the
`TOOL_OUTCOME_UNKNOWN` text. Either way the interrupted scenarios and their goldens change, so accept the look before the
goldens are regenerated.

### O2. A long notice is cut without an ellipsis

At 60 columns `⚠ Rate limited · retrying in 9s · 1/5` becomes `⚠ Rate limited · retrying` with no `…`, and the countdown, which
the user needs most, is the part that disappears. The roadmap does not say whether truncation draws `…`. Decide: draw `…`,
and keep the trailing count or countdown.

### O3. A compaction with no context window shows a percentage

`compactionNoWindow` shows `Compacting context ▱▱▱▱▱▱▱▱▱▱ 0% summarizing`, a time-based estimate. The round 7 brief describes a
stage bar with no percentage (`CompactionBar.measured`), but the field was never built. The golden and the code agree; the
brief is out of date. Decide: is a percentage of an unknown window honest? If not, drop the `%` when there is no window. If it
is, correct the brief.

### O4. Narrow-width footer and hints

- **Footer path:** when the goal chip grows, the working directory collapses to `.` (`⏵ 1 job  .  cache 42%`) instead of a
  shortened path (`phase3-tour` `interrupted`, `phase3-narrow` 60x30). At 28 columns it is `~/...`.
- **Search hint row:** it shares a line with the notice and cuts off mid-list, losing `Esc end search`
  (`phase3-search` 100x40, `selected`).
- **Decision hints at 40 columns:** `Enter · Ctrl+G · Esc` has no labels, so `Ctrl+G` is unexplained
  (`phase3-narrow` 40x24, `queue-card-1`).

All three change what is visible, so they need a design and an effect agreement before any code.

### O5. Glyph and wording consistency

These are individually sensible but worth one decision together:

- A folded body reads `▸ N more lines · Enter` in prose and code, and `… +N more · Ctrl+O` in tool bodies, for the same meaning.
  `▸ 1 more lines` also has no singular form.
- The activity glyph `●` is the same character as message bullets and pending tool rows (`phase3-live` `prepare`).
- `✗` means failed or rejected, and `⚠` means risk, degraded, and also a partial failure in a run head
  (`⚠ Bash · 2 calls · 1 failed`).
- `✻` marks `Thinking`, `Worked for 6s`, `Failed after 2s`, and `Stopped after 5s`.
- The `────` separator touches the live region with no blank row. It may be intended, since a rule is not a row kind.

### O6. Markdown table cells break words at 28 columns

`retried` becomes `retri` and `ed`, and `250 ms` becomes `250` and `ms` (`phase3-narrow` 28x20, `answer`). The table stays inside
its width. This is the Markdown renderer, not a Phase 3 component. Decide whether to break at word boundaries or fall back to a
list form below some width.

### O7. Snapshots and older goldens still to review

- **7 snapshot tests** in `tests/design/` (`scene-08-content`, `scene-09-feedback`, `visual-language`) fail. All are intentional:
  the diff gutter from `d71a9e5` (3b.2), the highlight palette, and the breath and bloom changes (`77f5a9a`, `bbe68ec`). They
  need an owner-approved `-u`.
- **61 older golden checkpoints differ** from their goldens. The appendix classifies each: 56 are accepted R4 to R9 effects
  (blank rows, run heads, the unfolded Standard level, `■ interrupted`, the notification hint row, the diff gutter), 4 are replay
  prose, and 1 needs a look: `edge` at 120x40, `end`, where the table status cells `✅ ⚠️` are now coloured red and green on
  rows 6 to 27. No brief mentions that. 14 of the 56 were classed by row shift without a line-by-line check.
- **Not accepted by the closeout:** these 61 checkpoints, the partial `approvals` and `plan` folders at new sizes, and the new
  `phase3*` goldens. Two orphan goldens remain: `approvals/end@120x40.grid` and `plan/end@120x40.grid`.
- **Search start (small):** with no cursor, `/` lands on the newest hit and `?` on the oldest. The hit count includes hits no
  row draws, and navigation skips them (Compact hides them unless forced). This is consistent with the design but is a
  behavior choice for the owner.

## Performance

- **P1, `perf-stream` draws more frames while scrolling.** Against the merge base (`df6fd02b74`), scroll frames are 23 against 20
  and wheel frames are 22 against 20, regressed in 7 of 7 runs. The scenario is 20 keys or notches, so it is one or two extra
  frames per excursion. The only Phase 3 repaint that toggles with scroll position is the tail chip (`b6c5d09`, round 7): leaving
  or regaining the tail announces `mayfly/content-tail-changed` through a microtask, and the republished pane schedules a second
  frame. This is the narrowest candidate and was not profiled. Either publish the chip in the same pass that found the tail change,
  or accept the cost and say so in the perf notes.
- **P2, `perf-focus` times out at `nav /theme`** ("timed out waiting for the driver to sync") on both the base and the head, so it
  is not a Phase 3 regression. The likely reason is that a theme change restarts fibers (`reloadTheme`) and the settle wait never
  sees a stable frame. Unverified. `perf --assert` fails only on this scenario.
- No budget was changed. The search highlight pass has no budget row.

## Cleanups with no visible change

- **C1. Decision card comment.** `components/decision-card.ts` line 6 says the note "travels with whichever choice is made". The code
  drops it on allow and approve and sends it on reject and revise, which is what `docs/interaction-model.md` says. Fix the comment.
  Owner question: should typing a note and then pressing an allow key warn that the note is not sent, or stay silent?
- **C2. Activity block height.** The docs say two rows, and three are drawn since `872d509` (a leading spacer, `components/activity-row.ts`
  line 77). Update `activity-row.ts` lines 2 to 3, `transcript/pane-activity.ts` line 7, `component-library.md` near line 1177,
  `component-development-spec.md` near lines 268 to 269, and the roadmap near line 1945. If the owner prefers two rows, remove the spacer instead.
- **C3. Digit-count width arithmetic.** `transcript/tool-calls.ts` line 217 (`String(preview.at(-1)?.number ?? 0).length`) is correct for
  ASCII numerals, but width arithmetic belongs in `core/width.ts` (exposed through `mayflyComponents`). Move it and drop its
  baseline entry in `tests/core/business-rendering-drift.spec.ts`.
- **C4. Tick dispatch.** `transcript/tick.ts` iterates a snapshot, so a listener disposed by another listener during the same tick
  still runs once. No consumer does this today. Skip disposed listeners and add a spec case.
- **C5. Notification row in `main` mode.** `components/notification-line.ts` builds its row without a priority child, so the
  compiler makes a column in `main` screen mode and the row becomes three rows (five with the chip). The live product compiles this pane
  in `alternate` mode, and frames show the prompt on the same line with or without a notice, so nothing is wrong today. Either
  give the branches a `priority: 0` child, or drop "always one row in main" from the docs.
- **C6. Stale briefs.** `.artifacts/handoff/3c34-test-brief.md` (line 18, the stage bar) and the decision-card brief (line 66, "the note
  travels with the choice") describe behavior that changed. They are not in the repository, so correct them only if they are reused.

## What held up

- Blank-row rhythm between every sampled pair of row kinds, including around compaction rows, notices, decision cards, the activity
  row, edit cards, tool-line runs, and run heads. The one exception is the separator in O5.
- The prompt stays on the same row (row 37) in 52 of the 61 tour checkpoints and moves to row 40 in the 8 decision cards, which is
  the design. Notices, rate limits, and compaction never move it.
- Tier switching: the Compact line `▸ 3 tool calls · 4.1s · 2 failed` matches the Standard run with one `✓` and two `✗`. No row was
  lost or duplicated in the sampled turns.
- Selection bands and search highlights stay inside their rows (tool line, message, edit card, compaction row) without touching
  the gutter. The `Back to bottom · Ctrl+↓` pill appears at 40x24.
- Decision cards with live work (a write card under the streamed block), and the queue counters `1 of 3` and `1 of 2`.
- At 60 and 40 columns no row wraps unintentionally and truncations end in `…` (except O2); at 28 columns the approval card and
  activity rows truncate cleanly.
- Numbers agree: `↑5.5k` matches `context: 18% (5.5k/32k)`, and the running-agent and `1 job` counts agree.
- No leaked timer or listener in `transcript/` or `components/`: every timer is cleared on unload, and listeners are disposed with
  their owner.

## What was not checked

- No-color states beyond running `phase3-tour --no-color` (the frames were overwritten by a later run).
- CJK and emoji alignment in the tour and in `edge` (text only, no image), and search highlights over wide characters.
- Esc behavior (D5) outside the replay; `phase3-resume`'s visual output.
- Which fibers `reloadTheme` restarts, so D1's reach is "possible".
- Whether the full tier passes cleanly after the repairs.
- The decision queue, search line, and selection lifecycle in depth.
- The Website (not built, by rule). The text of `website/features/streaming.md`, `approval.md`, `editor.md`, and `guide/config.md`
  still describes the old fold and approval behavior; the release owns it.
- 14 older checkpoints were classified by row shift only.

## Next steps

1. Fix D1 and restore the removed assertions.
2. Decide O1, then update the interrupted scenarios and goldens.
3. Check D2, D3, and D6 against the replay data, fix D4, and confirm D5 in the live profile.
4. Decide O2 to O6; each changes what is visible.
5. Apply C1 to C5 and the document updates in C2.
6. Review O7, then `pnpm run scenarios -- --update` for the reviewed names and `-u` for the 7 design snapshots.
7. Review the `phase3*` scenarios and the live profile (`dsh --profile mayfly-3`), accept their goldens, run one clean full tier with
   `DSH_BIN`, mark groups 3b to 3e Finalized in `component-library.md`, and update PR #15.

## Appendix: the 61 older checkpoints that differ

Class E is explained by an accepted round 4 to 9 change; E-text means the replay prose or numbers changed with the row structure
intact; E-unv means E by row shift, not checked line by line; S is suspicious.

| # | Scenario @ size | Checkpoint | Class | One line |
|---|---|---|---|---|
| 1 | gallery @120x40 | boot | E | Diff gutter `│ −` and palette tokens on the code block rows. |
| 2 | tour @120x40 | end | E | `⚠ Bash · 2 calls · 1 failed` partial-failure glyph and blank-row shift. |
| 3 | toolkit @120x40 | end | E-unv | Banner shift and a new `✓ WebFetch` row between blank rows. |
| 4 | thinking @120x40 | live | E | Streaming Thinking window `… +5 earlier` and blank rows. |
| 5 | thinking @120x40 | end | E | Run head `▾ Ctrl+O to expand`, `✻ Thinking · 9s`, blank rows. |
| 6 | thinking @120x40 | open | E-unv | Banner shift with the opened thinking body. |
| 7 | thinking @120x40 | narrow | E | Thinking preview is one line truncated with `…` (streaming preview rule). |
| 8 | thinking-verbose @120x40 | live | E-unv | Banner shift at the streaming thinking. |
| 9 | thinking-verbose @120x40 | settled | E-unv | Banner shift; body lines kept. |
| 10 | thinking-verbose @120x40 | narrow | E | `▾ Worked` wrap and `✻ Thinking · 9s` row. |
| 11 | live @120x40 | half | E-unv | Markdown list and code window moved by blank rows. |
| 12 | live @120x40 | scrolled | E-unv | Same content, scroll window moved by blank rows. |
| 13 | live @120x40 | away | E-unv | Scroll-away position moved by the blank-row rhythm. |
| 14 | live @120x40 | followed | E-unv | Follow-tail position moved; tail row is the same content. |
| 15 | live @60x24 | half | E-unv | Table rows and window moved at 60 columns. |
| 16 | live @60x24 | scrolled | E-unv | Code block window moved. |
| 17 | live @60x24 | away | E-unv | List window moved. |
| 18 | live @60x24 | followed | E-unv | Tail window moved; `✻ Worked for 6s` row. |
| 19 | markdown @120x40 | half | E-unv | Code and list rows moved by blank rows. |
| 20 | markdown @120x40 | end | E-unv | Code block rows moved by blank rows. |
| 21 | markdown @120x40 | narrow | E | Colour only on rows 22 to 29 (lavender); focus palette. Colour not explained in detail. |
| 22 | edge @120x40 | end | S | Table status cells `✅ ⚠️` now coloured red and green on rows 6 to 27; no brief mentions this. Also the `Alt+↑` hint row moved. Low. |
| 23 | errors @120x40 | end | E | Banner shift and `» Run the checks.` row from the error replay. |
| 24 | context @120x40 | end | E | Banner shift; compaction row `✓ Compacted`. |
| 25 | compaction @120x40 | end | E | Run heads `▸ 1 tool call` to blank rows, compaction row `✓ compacted 3 items`. |
| 26 | manualCompact @120x40 | end | E | Run head fold and `✓ compacted 4 items` row with blank rows. |
| 27 | childStream @120x40 | end | E-text | Run head `▾ 1 subagent` and a new prose line; blank rows. |
| 28 | content @120x40 | card | E-unv | Banner shift and the `xxxxx` code rows. |
| 29 | content @120x40 | detail | E-unv | Code rows shifted; long line wraps at 120. |
| 30 | content @120x40 | paged | E-unv | Same as detail. |
| 31 | content @120x40 | tail | E-unv | Same as detail. |
| 32 | content @120x40 | resized | E-unv | Same as detail at the resized row count. |
| 33 | goal @120x40 | end | E-text | Run head `▾ 2 tool calls` and new prose `Working on round 1`. |
| 34 | history @120x40 | end | E-text | Replay question numbers changed (145 to 147) and blank rows. |
| 35 | jobs @120x40 | running | E | `▸ Ran commands` folded run replaced by the flat tool lines (Standard no longer folds a settled turn, 3b.1). |
| 36 | modes @120x40 | end | E | Banner shift and `» First, in the default mode.` row. |
| 37 | notices @120x40 | end | E | Blank rows before and after the notice; `✻ Worked` row. |
| 38 | phases @120x40 | end | E | Banner shift; activity rows. |
| 39 | prompts @120x40 | end | E | Folded paste `▸ 35 more lines · Enter`; line numbers shifted. |
| 40 | questions @120x40 | end | E | Blank rows; `● AskUserQuestion` row. |
| 41 | queued @120x40 | end | E-text | Run head `▾ 2 tool calls`, `✻ Thinking · 1s` new row. |
| 42 | retries @120x40 | end | E | Blank row before `✻ Worked for 10s`. |
| 43 | sideQuestion @120x40 | end | E | `▾ Ctrl+O to expand` (open run) instead of folded; blank rows. |
| 44 | subagents @120x40 | end | E | `▾ 5 subagents` expanded (Standard no longer folds). |
| 45 | turns @120x40 | settled | E | `✓ Grep("Working")` flat tool line; blank rows. |
| 46 | turns @120x40 | queued | E | Same turn layout; blank rows. |
| 47 | turns @120x40 | end | E | Continued prose wrap; blank rows. |
| 48 | turns @120x40 | open | E | `✻ Worked for 1s` and Chinese prompt line. |
| 49 | turns @120x40 | narrow | E | `■ interrupted` row and `▾ Stopped · 1 tool call`; prompt wraps differently at 120 cols (E-text). |
| 50 | turns @60x24 | settled | E | Chinese/CJK wrap and blank rows. |
| 51 | turns @60x24 | queued | E | Blank rows; `✓ Bash(...)` row. |
| 52 | turns @60x24 | end | E | `■ interrupted` row added. |
| 53 | turns @60x24 | open | E | `■ interrupted` row added; blank rows. |
| 54 | turns @60x24 | narrow | E | `■ interrupted` row; prompt wrap. |
| 55 | turns @40x24 | settled | E | Fold `▸ 1 more lines · Enter` (see L4). |
| 56 | turns @40x24 | queued | E | `✓ Bash(...)…` truncation at 40 with `…`; `■ interrupted`. |
| 57 | turns @40x24 | end | E | `■ interrupted` row; blank rows. |
| 58 | turns @40x24 | open | E | Prompt wrap and `■ interrupted`. |
| 59 | turns @40x24 | narrow | E | Prompt wrap; `▾ Stopped`. |
| 60 | wheel @40x24 | end | E | One blank row; Alt hint row. |
| 61 | wheel @40x24 | wheel | E | `Back to bottom · Ctrl+↓` pill on its own row (tail chip moved from core overlay to the pane, 3c.3). |
