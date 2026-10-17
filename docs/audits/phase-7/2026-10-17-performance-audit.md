# Phase 7 performance audit: long sessions, jobs, subagents, and the renderer

- **Date:** 2026-10-17
- **Commit audited:** `b38fe28` (`perf(stream): memoize translators, coalesce stream publishes, settle the stream's scroll extent`)
- **Status:** Round 0 record. Measurement and test scaffolding only; no product behavior changed by this round. Fix rounds P1-P7 are listed at the end.
- **Scope:** a 2,000-turn session, a flowing (unfocused) 15-turn stream, a tools/change burst over three retained views, and the combined `perf-long` scene (200 turns, two live background children with nested surveys, two running jobs, goal/todos, three high-context streamed steps, a `/btw`, then typing/scroll/wheel/views/search).

The previous round profiled a 16-turn replay and found "no single O(N) hotspot". It never overlapped child and main streaming, and its stream was focused. This round adds the workloads that expose those paths.

## How the numbers were taken

- Work-budget rows W28-W31 run the real `OfficialConversationModelSource`, the real `TranscriptController`, and an unfocused content slot. W28-W31 are direct rows in `packages/mayfly/tests/perf/workloads.ts`; W32-W35 are frame rows in `packages/mayfly/tests/perf/frame-workloads.ts` through pi-tui's alternate screen.
- Counters are exact and deterministic; wall-clock medians are reported beside them and gate nothing.
- `pnpm run frame perf-long` and `pnpm run perf -- --assert perf-long` measured the combined scene on the real CLI under a PTY. The ceilings in the catalog are initial, record-only values.

### Work budgets (Round 0 baseline)

| Row | What one step does | Entries mapped | Tool models | Diffs | Stream rows | Items walked | Rows written | Bytes written |
| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |
| W28 | 2,000-turn session; one durable tool result arrives | 12,100 | 6,100 | 4,000 | 106 | 1,310 | - | - |
| W29 | same session; the live draft grows 24 characters | 0 | 0 | 0 | 100 | 1,232 | - | - |
| W30 | same session; one 1 Hz tick with a pending call | 0 | 0 | 0 | 106 | 1,310 | - | - |
| W31 | one `tools/change` over 3 retained views | 36,300 | 18,300 | 12,000 | 106 | 1,310 | - | - |
| W32 | a views summary set again with equal text | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| W33a | one tick; pending tool row in view | 0 | 0 | 0 | 105 | 1,301 | 0 | 0 |
| W33b | one tick; pending row scrolled out | 0 | 0 | 0 | 105 | 1,301 | 0 | 0 |
| W34 | follow-tail; one row appended | 0 | 0 | 0 | 99 | 1,223 | 39 | 6,188 |
| W35 | one wheel notch | 0 | 0 | 0 | 0 | 0 | 39 | 6,666 |

The 2,000-turn fixture shares 12,099 of 12,100 input entry objects between the pending and settled projections, yet the durable mapper reuses 0 of 12,100 transcript entries. That is the L1 measurement: the cost is not parsing the wire value, it is rebuilding every entry and every tool model. W29's live overlay already reuses all 12,100 durable entries (identity assertion passes), so the draft path is not the problem; the durable publish is.

W31 is exactly three times the W28 cost, including the two hidden views. That is J1.

### Scale curves (report-only, medians)

The audit script runs the same operations at T = 100 / 500 / 2,000 turns and E = 1,000 / 5,000 / 20,000 entries; the
fix rounds turn the relevant ratios into deterministic counter gates.

| Operation | T=100 | T=500 | T=2,000 | Growth |
| --- | ---: | ---: | ---: | --- |
| durable conversion (ms) | 47.4 | 134.7 | 544.3 | ~11.5x for 20x turns |
| `StreamFacts.build` (ms) | 2.0 | 3.4 | 9.4 | ~4.6x |
| W28 publish+paint (ms) | 41.9 | 136.9 | 523.7 | ~12.5x |
| draft publish (ms) | 31.9 | 70.0 | 226.7 | ~7.1x |
| tick publish (ms) | 7.7 | 11.1 | 12.5 | ~1.6x |
| tools/change, 3 views (ms) | 95.7 | 426.9 | 1,369.5 | ~14.3x |
| search refresh (`findHits`, ms) | 3.3 | 11.1 | 40.2 | ~12x |
| projection fold / event (ms) | E=1k 0.017 | E=5k 0.037 | E=20k 0.210 | ~12x |

W28's counters scale with turns (605 / 3,025 / 12,100 entries mapped; 305 / 1,525 / 6,100 tool models; 200 / 1,000 / 4,000
diffs), while `StreamFacts.build` stays at 106 rows because the window is fixed. W31 is 1,815 / 9,075 / 36,300 entries
mapped: three views, all converted. The draft and tick paths stay proportional to the window, not the session; the
durable and tools/change paths are the ones that need P1.

### `perf-long` spans (head only, initial ceilings)

| Span | Result |
| --- | --- |
| load (200 settled turns) | 108.7% CPU |
| combined (two children, two jobs, first high-context answer) | 55.8% CPU |
| type | 11.8% CPU, key p50 2.9 ms, 3.39 ms CPU/key |
| scroll | 14% CPU, key p50 4.5 ms, 4.5 ms CPU/key |
| wheel | 9.6% CPU, key p50 3.43 ms, 3 ms CPU/key |
| views (Alt+Down, Down x10) | 26.2% CPU, key p50 2.55 ms, 8.18 ms CPU/key |
| search | 44.3% CPU, key p50 14.05 ms, 23.33 ms CPU/key |
| settle | 29.1% CPU |

The initial ceilings were raised once after this run (load 150%, combined 80%, search 30 ms / 40 ms CPU per key) so the scenario records rather than fails while Round 0 is the only gate. They are not targets.

## Findings, ranked by measurement

### L. Long sessions

**L1. A durable publish re-maps the whole session (highest cost).**
W28 maps 12,100 entries, builds 6,100 tool models, and computes 4,000 diff alignments for one new tool result. `official-model.ts` re-runs `toolModel` and the group models for every entry; each edit runs `diffChangeCounts` per hunk (twice when cut), `trimContext`, a split of the command output, and the presentation summary. Only `resolveTool` is cached, under a `JSON.stringify([id, updatedSeq])` key that is never dropped. Cost: O(E + B_E + diffs) per publish.

**L2. New objects defeat the downstream identity memos.**
The new entry objects defeat `sanitizedOf`, `freezeModel`, and the row `intern`, so every window row is rebuilt and deep-compared. W28 shows the durable mapper reusing 0 of 12,100 entries even though the input entries are shared.

**L3. Snapshot bookkeeping walks the session.**
`visibleProjection` copies the entry array; `dispatchedCalls` and `settledSteps` rebuild Sets; `liveSeq` reduces every entry.

**L4. `turnsOf` filters all entries three to four times per publish.**
It builds three turn maps on every publish, including draft-rate publishes and the 1 Hz tick. W29/W30 still build 100-106 stream rows and walk 1,232-1,310 items for a 15-turn window.

**L5. The fold copies the entries array on every append/replace.**
`finalizedSteps` grows forever (`includes` plus a zod parse), `openStreamingStep` filters every entry, and compaction lookups use `findLast`.

**L6. The facts view is a new object on every event.**
It is re-parsed and wakes every listener; `agentCalls` is walked and searched.

**L7. Search re-finds every hit on every model change.**
`syncSearch` calls `findHits` over the whole model; `land()` publishes once per skipped hit.

**L8. The adaptive publish window measures L1-L4.**
A long session sits at the 200 ms cap, and each publish blocks the event loop.

### J. Jobs, subagents, and combined use

**J1. Spawning/disposing a live child eagerly reconverts every retained conversation, hidden ones included.**
Each tool-layer change emits `tools/change`; each emit runs `invalidateTools` on every retained slot (up to 3). W31 is three times W28, including the two hidden views. Nothing coalesces the emits.

**J2. A full stream publish runs every second while a pending row or background spawn is in the window.**
`republish()` (children, decision requests, inbox, facts marks) is not throttled. W30 measures the 1 Hz path; W33 measures the tick.

**J3. Every view republish recompiles the footer even with the same text.**
`setSummary` always makes a new identity; the agents/jobs panels show elapsed seconds, so this happens every tick plus 4 Hz for agents. Hidden panels compile eagerly.

**J4. A child update whose projection is unchanged counts as structural.**
`onlyLiveCharsChanged` requires `liveChars` to differ, so a tool-call delta or whitespace reasoning publishes the agents view at once, unthrottled.

**J5. Each live notification loops over every child ever seen.**
`session-facts.ts` calls `agents.get` per child, and `status-agents.ts` parses each call's arguments twice per publish.

**J6. Fan-out per main delta.**
`pane-todo` rebuilds every todo; `status-basic-model` takes a registry snapshot plus a zod parse; `pane-activity` stringifies its shape; at context >= 92% `notices` reports on every delta.

**J7. Every interaction change wakes `pane-notification` and the surface reconcile of all panes.**

**J8. Timers are not aligned.**
The 1 s tick, 100 ms clock, 250 ms child cadence, 30-200 ms publish window, `pane-workflow`'s own 1 s interval, and git every 5 s each cause their own frame.

**J9. Two things grow for the life of a conversation or process.**
`SessionFactsService.children` and `workflowLabels` (`agents-command.ts`). No per-child listener leaks were found.

### R. Renderer

**R1. A flowing list costs O(W) per render.**
An unfocused content slot has an unlimited row limit, so the list does per-item work on every render: `listWindow` builds an entry and a `choiceRow` per item; the control walk builds a descriptor with three `JSON.stringify` keys per item; `walkKeys` joins them; `paintList` builds a join key, parents map, prefix sums, and a concat per item. W33a walks 1,301 items for one tick; W33b walks the same 1,301 with the pending row scrolled out, so the work is the flowing-list paint, not the pending row.

**R2. The whole flowing list is repainted at about 10 Hz while any pending tool or thinking row is drawn, even off screen.**
Motion rows skip the row cache and the animated flag keys the list and frame cache on `animationFrame`. W33a is 3 leaf renders / 2 painted rows; W33b is also 3 leaf renders / 2 rows even though the pending row is off screen (the tick still misses the row cache), and W33b's `clockTicks` stays at 1 because the pending row's animation did not arm the global clock while scrolled out.

**R3. Any content viewport change re-renders the whole flowing list, because the viewport is part of the epoch.**
The editor gaining a row, the search line, a notice, and the lane all trigger it.

**R4. The output diff is index-aligned.**
A follow-tail append, a wheel notch, or a dock height change shifts every content row, so the whole viewport is rewritten. W34 writes 39 rows / 6,188 bytes for one appended row; W35 writes 39 rows / 6,666 bytes for one wheel notch. There is no scroll region (DECSTBM + SU/SD), and a frame with no changed row still writes.

**R5. Fixed work every frame.**
The bottom lane is planned again (every pane rendered and fitted); each row is measured 3-4 times through pi-tui's 512-entry FIFO width cache, which one scrolled frame overflows.

**R6. pi-tui's own alt-screen search is reachable.**
While it is open it materializes every content row into a corpus on every frame.

**R7. Smaller costs.**
Side lanes composite every visible row; tall overlays lay out twice; concat parts sum their revisions on every row read.

**R8. The counters see none of R1's loops in the old workloads.**
No old workload has a flowing stream; W4-slot focuses first. The new W28-W35 rows close that gap.

## Renderer analysis and proposed algorithm

A frame today: `requestRender` -> nextTick -> 16 ms throttled timer; `renderLayoutFrame` lays out the whole tree with a fresh per-frame cache, so every component's `render` runs; Mayfly answers repeats from `retain` keyed by the surface epoch (plus the animation frame for an animated render); the scroll child is measured at full height; `paintBox` reads only clipped rows; post-processing is O(H·W); the diff compares rows by string at the same index and rewrites a changed row whole.

The proposed direction, in order of measured impact:

1. **P3 virtual flow list (R1, R3).** A `FlowIndex` reconciles items by identity with a two-ended scan, keeps painted rows per item, stores heights in a Fenwick tree, and exposes a virtual row facade. Only V rows plus changed items are painted. The control walk exposes one lazily enumerated range. `expandedIds` becomes a Set and `reconcileChoice` an id->index map. The flowing render is keyed by width, not viewport rows. Target: W28/W33 `itemsWalked` = O(changed + V), with W4/W4-slot unchanged.
2. **P4 animation patches (R2).** A moving cell registers a patch (item, row offset, painter); a tick repaints only patch rows and the facade substitutes them. `onScreen` for list items comes from the FlowIndex top and the TailScrollView window, so an off-screen pending row disarms the clock. Target: W33a <= 1 leaf render per moving cell, W33b 0.
3. **P5 output optimizer (R4), Mayfly-side.** A write filter on the renderer's terminal facade parses pi-tui's frame grammar (BSU, `2J`, row writes, cursor, ESU) into a shadow screen, finds the dominant vertical shift inside the content band with an ncurses-style row hash match, and emits `CSI t;b r` + `CSI n S|T` + `CSI r` plus only the rows the shift does not explain. It drops no-op frames and passes anything it does not recognize through (images, `2J`, selection). Guards: an alt-screen `@xterm/headless` property spec (naive grid == optimized grid, including attributes and cursor) and a grammar pin spec against pi-tui upgrades. Target: W34/W35 `rowsWritten` <= changed rows + rows shifted in.
4. **P1 incremental conversion (L1-L3, J1).** WeakMap caches keyed by entry identity, tool/group memo by resolved members, tail reads for `liveSeq`/dispatched calls, and a microtask-coalesced `tools/change` that marks retained views stale and converts only the displayed one at its next snapshot. Target: W28 `entriesMapped` <= changed + O(1); W31 converts no hidden view.
5. **P2 tail-anchored stream facts (L4, L7, J2).** Find the window start from the tail, cache the turn index per model identity, reuse a settled `StreamTurn` by its entries/disclosure/children revision, cache view items per turn, route data-driven republish and the tick through the publish window, and coalesce search refreshes and `land()` publishes.
6. **P6 fixed frame cost and fan-out (R5-R7, J3-J9).** Memoize `planBottomLane` by pane revisions and width, add a Mayfly row-width memo of at least 4·H entries, route pi-tui's search key to the stream search, compare view summaries by value, do not publish an equal child projection, index children by Agent, parse spawn arguments once per call, gate `pane-todo` and `status-basic-model` by identity, report notices once per threshold crossing, move `pane-workflow` onto the shared tick, and bound `workflowLabels`.
7. **P7 fold (L5-L6).** Bound `finalizedSteps` to the current turn, splice the streaming step from the tail, keep open compaction ids in the state, and memoize the facts view per state. Chunked entries are a later round only if the array copy is measured to dominate.

## Fix rounds and targets

| Round | Findings | Target counter / gate |
| --- | --- | --- |
| P1 | L1-L3, J1 | W28 `entriesMapped` <= changed + O(1); W31 hidden views do not convert; 2,000 vs 100 scale ratio |
| P2 | L4, L7, J2 | W29/W30 `streamRowsBuilt` = O(window); one `findHits` per accepted query; one publish per `land()` |
| P3 | R1, R3 | W28/W33 `itemsWalked` = O(changed + V); W4/W4-slot unchanged |
| P4 | R2 | W33a <= 1 leaf render per moving cell; W33b `clockTicks` = 0 |
| P5 | R4 | W34/W35 `rowsWritten` <= changed + shifted-in; grid equality |
| P6 | R5-R7, J3-J9 | W32 equal summary no frame; W33 tick frames down; J4-J8 gates |
| P7 | L5-L6 | fold/event curve; facts view identity stable; resume/rewind green |

Each fix round lands with the scale gate it makes pass; the wall-clock curves are reported, not gated. The gates that are already deterministic live in `budgets.json` and `baseline.json`.

## P1 result (implemented)

P1 landed on `perf/p1-incremental` (`2e33447f`) and was merged into `perf/phase-7`. It replaces the JSON-keyed resolved-tool
map with entry-keyed WeakMaps, caches non-tool entry models by identity, reuses tool and group models by their resolved
members, and makes `tools/change` a microtask that marks retained views stale and converts only the displayed one at its
next snapshot.

| Counter | Before | After |
| --- | ---: | ---: |
| W28 `entriesMapped` | 12,100 | 1 |
| W28 `toolModelsBuilt` | 6,100 | 1 |
| W28 `diffsComputed` | 4,000 | 0 |
| W31 `entriesMapped` | 36,300 | 6,100 |
| W31 `toolModelsBuilt` | 18,300 | 6,100 |
| W31 `diffsComputed` | 12,000 | 4,000 |

W31's remaining 6,100 is exactly the displayed view's tool entries; the two hidden views did no work. W28's step fell from
~525 ms to ~23-30 ms in the one-off harness. The W28 and W31 budgets were lowered to the measured values; W29/W30 are
unchanged. The focused official-model, conversation-slots, and live-overlay specs pass (76 cases, including new identity
and lazy-invalidation cases).

## P2 result (implemented)

P2 landed on `perf/p2-stream-facts` (`0dd7e9f5`) and was merged into `perf/phase-7`. `StreamFacts` caches a turn index
per durable-entry identity (and per live turn/step), so a live-only publish reuses the index and a durable publish builds
it once; the window and forced turns select entry ranges instead of filtering the whole array three times.
`republish()` and the 1 Hz tick use the same 30-200 ms publish window as `refresh()`; key-driven toggles stay immediate.
`syncSearch` reuses `findHits` while the durable and live entry arrays and the pattern are unchanged, and `land()` no
longer publishes twice when the first hit already has a row.

`StreamFacts.build` on the 2,000-turn model fell from 9.4 ms median to 4.4 ms median (p95 13.2 ms) in the same one-off
harness. The targeted stream-facts, publish-window, stream-search, and transcript-controller specs pass (78 cases). The
perf fixtures now drain the controller's trailing publish explicitly (`FixedPublishClock.flush()`), so W28/W29/W31 still
measure their real publish; W28-W31 and W33-W35 pass their budgets.

## P3 result (implemented)

P3 landed on `perf/p3-flow-list` (`b6a26f3d`) and was merged into `perf/phase-7`. A `FlowListPainter`/row source reconciles the
flowing list's items by two-ended identity, keeps per-item heights and a prefix sum, paints rows on demand, and exposes the
exact total height to `TailScrollView`. `listWindow` returns only the viewport + cursor window (+4 overscan) for a
virtualizable flow list; `walkControls` enumerates that window. Focused lists, `maxRows`, filters, trees, and an active
search current match keep the old whole-paint path, so W4/W4-slot are byte-identical.

W33a `itemsWalked` fell from **1,899 to 146** and W33b from **1,301 to 165**; W33a's `rowsPainted` fell from 3 to 1. The new
`p3-flow-list.spec` checks every virtual row against a whole `paintList` for unchanged, tail-changed, middle-changed,
appended, and prepended lists, and proves total height 2,000, `track()`, wheel-away, and follow-tail through the real
`TailScrollView` (5/5). The existing tail-extent seam specs pass 3/3. P4's animation-patch work is not landed; the visible
pending row already paints one row per tick, and the remaining clock tick is the real 1 Hz tick the workload fires.

The virtual rows shift the counter vocabulary: W29 and W-answer now materialize rows through the facade (`rowsMaterialized`
18 and 479) instead of painting them through the old static path (`rowsPainted` 18 and 0). Those two budgets no longer gate
`rowsMaterialized` (the baseline was recorded before the facade existed); W29 now gates `itemsWalked` at 150, and W-answer
keeps its painted-row ceiling. This is a measurement-semantics change, not a work regression, and is called out here so the
next budget review does not read the removed rows as a free pass.

## P5 result (implemented)

P5 landed on `perf/p5-output` (`c90ce560`) and was merged into `perf/phase-7`. `core/output-optimizer.ts` wraps the
alternate-screen terminal facade, parses pi-tui's frame grammar into a shadow grid, drops unchanged rows, and turns a
dominant vertical shift inside the content band into DECSTBM + SU/SD + only the unexplained rows. Anything it does not
recognize (titles, images, selection, other private modes) passes through byte-for-byte and invalidates the shadow until
a full repaint. It is off by default; the frame workloads enable it, and it is ready for the owner's live review before
production enables it. Upstream pi-tui is still the follow-up.

W34 (follow-tail append) fell from **39 rows / 6,188 bytes** to **1 row / 177 bytes**. W35 (wheel notch) is unchanged at
39 / 6,666: scrolling away makes Mayfly's two-column scrollbar visible on every row, so every row is genuinely different
and the row-equality shift explains none; a cell-patch grammar was deliberately not added. The property spec compares
200 deterministic random frame sequences (ASCII + CJK + SGR, shifts, appends, no-ops) cell-for-cell (chars, colors,
attributes, cursor) against a naive alt-screen xterm, and a grammar pin captures a real `TuiAltScreen` frame. The focused
follow-tail terminal case passes; 6 `terminal.spec` cases fail identically on `main` before P5 (stale scrollbar-width
expectations), so they are baseline, not this round.

## P6 result (implemented)

P6 landed on `perf/p6-fanout` (`88387796`) and was merged into `perf/phase-7`. It adds structural status-node equality
(`ui/status-equality.ts`) so a fresh but equal views summary bumps no serial and repaints nothing; compares every
`ChildSessionFacts` field so an unchanged child update does not publish and only streamed output uses the volatile
cadence; stores the exact child Agent and uses `liveStream.get(record.agent)` instead of `agents.get` per child, bounds
settled children to 32, and parses spawn arguments once per call. `pane-todo` memos by identity, `status-basic-model`
caches the model-selection snapshot by session, `pane-activity` compares shape fields instead of stringifying, and the
context notice reports once per 92/95/98 band crossing. `pane-workflow` moved to the shared tick, and `workflowLabels`
is an LRU capped at 256.

W32 fell from `unitsCompiled 1 / controlWalks 1 / reconciles 2` to all zero (the equal summary produces no frame); W33a
and W33b are unchanged, and W33a is now warmed before its measured tick so its counters are stable. R5/R7 (lane planning,
width memo, hidden-lane compositing, tall-overlay double layout, concat revision sums) and the hidden-pane lazy compile
were deliberately left for the next round; the measured impact of the landed J3-J9 items is the gate.

## P7 result (implemented)

P7 landed on `perf/p7-fold` (`5cffe892`) and was merged into `perf/phase-7`. `finalizedSteps` keeps only the current and
previous turn (`SETTLED_TURN_WINDOW = 2`, `settleKey`); older keys cannot be consulted by a late durable attempt. The
projection state keeps `openCompactions` (`entryId`, optional `compactionId`/`commandId`), so compaction start/summary/
end/`command/done`/`session/end-seed` pair without a history-wide `findLast`; `stateVersion` is 13 in both projection
tables. `openStreamingStep` splices a retried step's rows from its tail block instead of filtering every entry. The facts
view is memoized per immutable state, `agentCalls` has a callId index per array revision, and a repeated identical tool
result returns the identical state/array.

The facts tool/result path fell from 0.050/0.208/0.443 ms to 0.027/0.038/0.141 ms at E=1k/5k/20k, and the facts view from
~0.016 ms to ~0.002 ms per call. The projection tail fold is unchanged at 0.19 ms for E=20k because the audit event is a
`user/message` append dominated by the remaining O(E) entries copy; chunked entries are the later round that removes it.
The conversation projection/facts specs (37 cases) and the broader projection consumer/resume/rewind set (313 cases) pass.
Stored checkpoints from stateVersion <=12 are discarded and refolded from seq 0 on resume (one-time cost, no data loss).

## Verification state

- `pnpm run build` passes; `tsc -b` passes. The `tsconfig.tests.json` project still fails on the pre-existing Phase 6
  specs that import deleted symbols (`width-scan`, `banner`, stale `pane-todo`/`status-*`/`terminal` expectations); none of
  the errors are in the files changed here.
- Work budgets: W28-W35 pass their (lowered) budgets, and the determinism/id-set/never-above-baseline checks pass. The only
  failures are W16 (`stringsMeasured` 10 > 8) and W18-overlay (`rowsPainted` 3 > 2), both reproduced identically on
  `main` at `b38fe28` before any Phase 7 change.
- `pnpm run frame perf-long` completes: 3,307 frames, ~112.7 s, no driver failure; the replay's stored session still loads.
- `pnpm run perf -- --assert perf-long` passes: load 112.3% CPU, combined 52.4%, type 10.6% / 2.57 ms key p50 / 3.04 ms
  CPU per key, scroll 14.4% / 4.02 ms, wheel 8.1% / 3.65 ms, views 25.3% / 3.3 ms, search 47.7% / 13.81 ms, settle 25.4%.
- `pnpm run check:lib` (50 lib claims), `pnpm run check:agent-docs` (12 instruction files), and the packed external UI kit
  pass. `pnpm run check:pack` fails on the **pre-existing** library size budget: main is 3,154,816 bytes and this branch
  3,232,812, against the 2,950,000 budget; the +78 KB is the Phase 7 modules, and the budget was already exceeded on main.
- A `--prof` profile pass was started but killed when the `/tmp` tmpfs ran out of inodes; the scale curves and the
  `perf --assert` spans stand in for it in this record. No Website build/preview was run.
- `pnpm run check -- --plan` confirms the new files are claimed; the full `--tier pr` run is not green because of the
  pre-existing failures above, not because of a Phase 7 regression.

## Follow-up: multi-subagent / BTW switching and the tall-body truncation

The user's later review found the pure 200-turn stream acceptable and pointed at the multi-subagent case: invoking several
subagents, viewing `/btw` or a child conversation, and switching back to main. The second report was that markdown-rendered
LLM messages are truncated, not only the plan-mode plan.

### The swarm scenario

`perf-swarm` (catalog; source `perfSwarm`) strings six live background children with nested live surveys, a running
preview job, a `/btw`, and a main stream into one 30-turn conversation. Its script enters the agents view, opens a child,
returns with `F7`, advances through the `/btw` open, toggles to the BTW, back to main, then types and scrolls. The
`btw-open` span is separate from the `btw` F7 span so the side conversation's first conversion is not charged to the key.

`pnpm run perf -- --assert perf-swarm` now passes its initial record ceilings:

| span | CPU | key p50 | CPU per key |
| --- | ---: | ---: | ---: |
| load | 130.8% | | |
| swarm | 21.3% | | |
| agents | 30.4% | 4.43 ms | 14.29 ms |
| open (Enter on a child) | 16.4% | 4.70 ms | 90 ms |
| back (F7) | 13.2% | 28.10 ms | 50 ms |
| btw-open | 8.4% | | |
| btw (F7) | 16.3% | 40.72 ms | 60 ms |
| main (F7) | 8.7% | 19.58 ms | 30 ms |
| type | 11.4% | 2.73 ms | 3.22 ms |
| scroll | 19.9% | 4.47 ms | 6.67 ms |
| settle | 1.8% | | |

The first pass measured `open` 90 ms CPU/key, `back` 61.28 ms p50 / 130 ms CPU/key, `btw` 56.38 ms / 1200 ms (the span
then still included opening the BTW), and `main` 41.44 ms / 80 ms. The fixes below brought the steady-state switches to
the table: the side-conversation open itself is 8.2% CPU, and the F7 to its view is 46 ms p50 rather than a 1.2 s bill.

### Fixes in this follow-up

1. **A flowing list is marker-free.** `FlowListPainter` now declares `markerFree`, so pi-tui's layout marker scan does not
   walk every virtual row (`seekPart` was 321 ms in the first profile). Unfocused flowing lists carry no cursor marker.
2. **The stream node survives a switch.** `StreamFacts.build` reuses its facts object when the turns and queued rows are
   the same by identity, and `TranscriptView`/`TranscriptStream` cache the list and its stack by facts, cursor, and
   highlight. An F7 that only changes the displayed conversation therefore reuses the compiled node instead of admitting
   and compiling the same list again.
3. **A hidden agents panel refreshes at 1 Hz, without dropping the skipped update.** `status-agents` still publishes its
   summary at the child cadence, but a hidden panel is rebuilt at most once a second; structural row changes (including
   the catalog's action modes) and an entered view keep the old immediate update. A skipped panel is not marked
   published, and a view-lane subscription forces one paint on entry, so a settled row cannot leave a stale panel behind.
   This cut the `back` F7 from 50 to 30 ms CPU/key in the first pass; the final run is 50 ms CPU/key with 28 ms p50.
4. **Tall list bodies are no longer viewport-bounded, and focus no longer re-windows the content list.** `paintBody`
   already unwrapped the leaf's alternate-screen bound only for flow content or a current search match; making it always
   return `unclampedRows(rows)` was necessary but not sufficient. A focused content slot also set `runtime.flow = false`
   (`node-slot.ts`), so `listRowLimit` became the viewport and the focused stream painted only ~39 rows; the tail of a
   tall answer was unreachable even though `paintBody` had measured 319 rows. The fix keeps flow true for a content
   region whether or not it holds focus, and lets `FlowListPainter` paint the focused list: it now carries the focused
   cursor/marker, reports `markerFree` only while unfocused, and answers a marker seek from the cursor block instead of
   walking every row. A focused list that cannot virtualize (filter, tree, current match) keeps the viewport fallback.
   The regression test renders 160 paragraphs, focuses the slot, calls `followContent()` (the old test only held a stale
   scroll top and passed before the fix), asserts the tail is past the first screen, and scrolls back to row 0.
   `W4-slot` now admits the changed off-screen item once to keep its total height exact (`nodesValidated` 2,
   `rowsPainted` 1); the slot gate allows that one item and every other counter stays at the direct figures.

### Remaining

The switch keys are still 20-90 ms p50, above the 30 ms aspiration, so the record ceilings are not final gates. The next
measured candidates are the deferred hidden-pane lazy compile, status-agents' summary cadence, and the remaining
virtual-row reads (`get`/`read`/`produce` in the first profile). `load` at 126% is the 30-turn fixture's boot plus history,
not a switch. The profile's top self time is now Cordis context-proxy `get` (894 ms) rather than the virtual row scan.
No full `check --tier pr` was run for this follow-up; the targeted specs, `p3-flow-list`, W4/W29/W33/W34, `perf-swarm`,
and `perf-long` were used instead.

## Hand-over

Open the combined scene with `pnpm run scenario perf-long`. It plays 200 settled turns, two compactions, the two live
background children with nested surveys, two jobs, the goal and todos, three high-context streamed answers, and the
`/btw`, then the script types, scrolls, wheels, enters the agents view, and searches over the stream. Watch for the lag
while the children and jobs run (especially when a spawn or dispose would reconvert the hidden views), and try typing
and scrolling inside the 200-turn stream. The audit record (this file) is the other hand-over; the profiles and scale
curves above are the measurement.

## Next

P1, P2, P3, P5, P6, and P7 and the multi-subagent/BTW follow-up are merged on `perf/phase-7`. P4's animation-patch work is
the only fix round not landed: the visible pending row now paints one row per tick and the off-screen row already stops
the animation clock, so its target is largely met by P3, but a dedicated moving-cell patch remains a later round. The
remaining measured candidates are R5 (plan-bottom-lane and row-width memo), R7 (hidden-lane compositing, tall-overlay
double layout, concat revision sums), the hidden-pane lazy compile that P6 deferred, and the 30-80 ms switch keys in
`perf-swarm`. The owner should review the flowing-list scroll/follow-tail feel in `perf-long`, the child/BTW switching in
`perf-swarm`, and a tall focused markdown message before this stack merges; the final gate remains
`pnpm run check -- --tier pr` once the pre-existing main failures (W16/W18, terminal.spec, pack size, stale Phase 6 specs)
are accepted or repaired.
