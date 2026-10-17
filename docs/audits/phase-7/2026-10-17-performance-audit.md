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
| W33a | one tick; pending tool row in view | 0 | 0 | 0 | 105 | 1,899 | 0 | 0 |
| W33b | one tick; pending row scrolled out | 0 | 0 | 0 | 105 | 1,301 | 0 | 0 |
| W34 | follow-tail; one row appended | 0 | 0 | 0 | 99 | 1,223 | 39 | 6,188 |
| W35 | one wheel notch | 0 | 0 | 0 | 0 | 0 | 39 | 6,666 |

The 2,000-turn fixture shares 12,099 of 12,100 input entry objects between the pending and settled projections, yet the durable mapper reuses 0 of 12,100 transcript entries. That is the L1 measurement: the cost is not parsing the wire value, it is rebuilding every entry and every tool model. W29's live overlay already reuses all 12,100 durable entries (identity assertion passes), so the draft path is not the problem; the durable publish is.

W31 is exactly three times the W28 cost, including the two hidden views. That is J1.

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
An unfocused content slot has an unlimited row limit, so the list does per-item work on every render: `listWindow` builds an entry and a `choiceRow` per item; the control walk builds a descriptor with three `JSON.stringify` keys per item; `walkKeys` joins them; `paintList` builds a join key, parents map, prefix sums, and a concat per item. W33a walks 1,899 items for one tick; W33b walks 1,301 with the pending row scrolled out.

**R2. The whole flowing list is repainted at about 10 Hz while any pending tool or thinking row is drawn, even off screen.**
Motion rows skip the row cache and the animated flag keys the list and frame cache on `animationFrame`. W33a is 5 leaf renders / 3 painted rows; W33b is 3 leaf renders / 2 rows even though the pending row is off screen (the tick still misses the row cache).

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

## Verification state

- `pnpm run build` passes; W28-W31 pass their Round 0 budgets.
- `pnpm run frame perf-long` completes (3,296 frames, ~128 s) with no driver failure.
- `pnpm run perf -- --assert perf-long` passes its initial ceilings after the record-only adjustment.
- Known baseline: `pnpm run typecheck`'s `tsconfig.tests.json` project fails on pre-existing Phase 6 specs that import deleted symbols; `tsc -b` and the changed files are clean.

## Next

P1 is the first fix: the identity caches and the lazy `tools/change`. Then P2 (tail facts and publish window), P3/P4 (flow list and animation patches), P5 (output optimizer), P6 (fan-out and fixed frame cost), P7 (fold). Each round commits its own counter gate and reports the measured delta; the final gate is `pnpm run check -- --tier pr`.
