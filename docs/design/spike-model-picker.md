# Spike: the model picker as a pure component

A composition spike before the `@ephemeral-ai/mayfly-ui` freeze (slice 1.11): are the public basic components enough to
build a real Mayfly component? `packages/mayfly/tests/design/spike/model-picker.ts` holds `ModelPicker` and `EffortPicker`
in the Phase 2a style: `defineMayflyComponent` (with `memo`), plain facts shaped like `catalogRows` and
`currentModelSelection`, a translator `t`, and only `@ephemeral-ai/mayfly-ui` imports. `model-picker.spec.ts` compiles them
with the real renderer (`createRealSurface`) and compares scene 23's goldens. No source changed; nothing is wired in.
Base: `e0d4d04`.

## 1. What composed cleanly

- Scene 23 is `ui.surface` + `ui.list` with `group`, `detail`, `badge`, and a per-row `segment` with `inheritedId`.
  No `patterns.*` fits (it is a list, not a rail, split view, status page, or decision card).
- The thinking strip, `(default)`, `Delete use default`, the numbered `/effort` list, `[current · high]`, `Provider default
  (high) [current]`, the filter header, and the 62-column ladder all come from the list painter. There is no button: with
  no `acceptActionId` the list still emits `selection-accept` with `segmentId` (absent = unpinned, roadmap 2a); the spec checks it.
- A strip pinned to the model's own default draws `‹ high ›` and accept reports `high`, so an explicit `high` and an
  unpinned selection stay distinguishable, as `sameSelection` needs.
- `/skills` and `/rename` already hand an overlay a surface-rooted node, so `chrome: 'overlay'` is enough (not mounted here).

## 2. Gaps and workarounds, by severity

Blocking: none. Awkward:
1. `selectedIds: []` is required on every `ui.list` (roadmap 3.1), so every Phase 2 component repeats it.
2. The UI package has no translator type. A component may not import `MayflyTranslate` (`frontend/`), so the spike
   redeclares `(key, values?) => string`; every component would.
3. `memo: true` compares props shallowly, but `interactionTranslator(ctx)` returns a new closure per call, so the memo
   never hits unless the owner hoists `t` (the spec shows both cases).
4. `formatContextWindow` lives in `interaction/`, off limits to a component. Phase 2a moves it into `components/` or puts a
   formatted `contextLabel` in the fact (the spike copies it).
5. Facts the commands do not pass: `openModelPicker` ignores the `defaultEffort` that `catalogRows` returns, and
   `switchEffort` never reads `info.reasoning.defaultEffort`. `inheritedId` and `Provider default (high)` need both.
6. Three interpolated catalog keys replace concatenation (`{size} context`, `current · {effort}`, `Provider default
   ({level})`); the zh catalog needs them.
7. Oracle gap: the kit never pins the live row's strip, so no golden shows that state. The component pins it, and an
   assertion covers it. A `live-row` walk (cursor on the current model) would pin it in the goldens.

Cosmetic:
8. `acceptVerb` is a closed enum, so the component cannot localize the hint verb (core does).
9. The kit's `empty: 'No models match'` is unreachable: a filter with no match shows core's `No matches`, and `empty`
   shows only for an empty catalog, so the component uses the real `No models advertised`.

## 3. Before the freeze (slice 1.11)?

Nothing blocks it, and every fix is additive, so none must precede it. The smallest worth taking: (a) default
`selectedIds` to `[]` in `ui.list` (item 1); (b) a type-only `MayflyTranslate` export (item 2). Item 3 is Phase 2
guidance (hoist `t` per locale revision); the rest is Phase 2a work.

## 4. Parity per walk (`golden/23-model-and-effort`)

| Walk | Result |
| --- | --- |
| `initial` (84), `pages` (Ctrl+N), `narrow` (62), `thinking` (`→ →`), `default` (`Delete`), `filter` frame 0 | exact: every character and style class, no waiver |
| `filter` frames 1, 2 (`/`, `d`) | `▌` in the field is Δ27 (waived, 1 cell); the hint row has a leading `←/→ thinking · ` the golden lacks (49 cells per frame) |

The hint row cannot be composed away: the kit steps the strip with `←/→` while searching (`ui-kit.mjs` line 1046) but does
not hint it; the renderer hints it ("the cue is true", like Δ29). The spec pins the row's text and fails if the difference
disappears. It needs a new accepted difference (Δ33) or a kit fix.

## 5. Work of one key (counters of `tests/perf/work-budget.spec.ts`)

A warmed, framed picker; the last key of each sequence is counted. Cells are `rowsPainted / stringsMeasured`;
`nodesValidated` and `unitsCompiled` are 0 everywhere.

| Key | 6 rows | 400 rows | 4,000 rows |
| --- | --- | --- | --- |
| `↓` | 2 / 41 | 2 / 198 | 2 / 198 |
| `→` (strip) | 2 / 42 | 2 / 199 | 2 / 199 |
| `/` | 1 / 45 | 1 / 199 | 1 / 199 |
| `d` (keeps all) | 0 / 44 | 0 / 198 | 0 / 198 |
| `9` (narrows) | 0 / 11 | 1 / 14 | 12 / 68 (11 matches) |
| `Enter` | 0 / 41 | 0 / 198 | 0 / 198 |

Within W3's rows budget (at most 2 painted, nothing validated or compiled), whatever the catalog size. Strings exceed W3's
40 because the overlay frame re-measures its rows on every key (bare list: 8 at 6 rows, 40 at 400; framed: 26, 198). That is
constant from 400 to 4,000 rows, but no budget covers a framed list; a `W3-framed` row would.

Ran: `vitest run packages/mayfly/tests/design packages/mayfly/tests/perf` (154 tests), `design:golden:check`,
`check:agent-docs`, `lint` (no finding in the spike), `typecheck` (`tsc -b` does not include `tests/`). No full gate.
