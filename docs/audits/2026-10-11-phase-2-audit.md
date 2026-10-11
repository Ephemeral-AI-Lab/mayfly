# Phase 2 pre-review audit

Audit baseline: `b657469` (`main`, PR #1 merged) plus two uncommitted edits (the 2b/2c status tables in the
roadmap, and a `20_000` timeout on `markdown-rows.spec.ts:188`). Report date: 2026-10-11. This is an audit record
of that commit. It does not define current behavior, and no fix has been made.

## Conclusion

The foundation is sound where the Phase 2 work was measured: lists, row maps, windowed scrolls, and the
transcript source all scale as designed (see "What held up"). The defects sit in the paths the work budgets do not
time. They count rows, not milliseconds, so three of the "any size" claims of 2c fail on a stopwatch.

Fix first:

1. **F1, Markdown scanning is quadratic.** A 1.2 MB document takes 4.1 s to scan on the main thread, against 0.12 s
   for the plain lexer. The same cost is why the new `20_000` timeout was needed on `markdown-rows.spec.ts`. Remove
   the cause, not the timeout.
2. **F3, a newline in a `fields` value or label turns the whole node into a rejection row.** The input is ordinary
   (a multi-line error text) and the fix is small.
3. **E1, the architecture guard specs are not selected by leaf-file edits**, so a violation passes the round and pr
   tiers and surfaces only in the full tier on `main`.

Then F2, F4, F7 (to confirm at runtime), the compatibility leftovers the root instructions forbid (B1, B2), and the
test-time items (T2, T3), which together remove about 35 s of wait time from the suite.

Three leads from the first survey did not hold and are recorded under "Refuted or downgraded" so nobody
re-investigates them.

## Scope and evidence

- **Read:** the root and package instructions, the roadmap's Phase 2 text, the 2c slices, and the code of the 2c
  pipeline (`core/{ui-rows,content-segments,content-rows,markdown-rows,diff-align,width-estimate,ui-content-cache,
  ui-row-cache,ui-list-paint,ui-scroll-region,ui-interaction-document,ui-validator,plugin-view}.ts`), plus the
  conversation projection, the app startup chain, the editor, the gate scripts, and the vitest configuration.
- **Measured here:** the repro scripts in the appendix (each printed numbers that are quoted below), the existing
  `script/audit-performance.mjs`, and two timed runs of the whole `suite` project (one plain, one with
  `MAYFLY_UI_VERIFY_MEMO=1`, each with a JSON reporter, 8 cores, no coverage).
- **Not audited:** the Website pages other than for drift, `packages/cli` internals, the release scripts, Windows and
  macOS behavior, anything that needs a real terminal (see "Needs the owner"). The transcript row view that Phase 3a
  replaces was measured, not reviewed.
- Every finding says whether I reproduced it. "Read" means I traced it in code and did not run it.

## What held up

The baseline `script/audit-performance.mjs` run (median of 7, one machine):

| Scenario | 1,000 | 10,000 | 100,000 |
| --- | --- | --- | --- |
| list, first build, publish and render | 4.9 ms | 28.8 ms | 398.7 ms |
| list, repeat render | 0.2 ms | 0.2 ms | 0.2 ms |
| list, page down | 1.2 ms | 1.0 ms | 1.5 ms |
| list, tree page down | 1.2 ms | 0.9 ms | 1.2 ms |
| transcript source after a native clone | 1.0 ms | 6.7 ms | 107.3 ms |
| document append / prepend reconcile | 0.2 ms | 0.2 ms | 0.6-0.7 ms |

Frame cost per key is independent of list size, and the one-time builds are linear. The lead that `checkOf` is
O(items) per row (`ui-list-paint.ts:88-98`) does not show here: tree page down stays at 1.2 ms for 100,000 items.
That path stays a read-only note.

## Findings

Severity orders the work, it is not a security rating. P1 breaks a phase goal or blocks input, P2 is a
condition-triggered defect or scale limit, P3 is a lower-priority cost or consistency issue.

### P1

**F1. `scanMarkdown` is quadratic in paragraph count.** Reproduced.
`core/markdown-rows.ts:130-140` registers `pi-tui`'s `latexBlock` extension on the scan parser, and its `start`
callback runs `/(?:^|\n) {0,3}(?:\$\$|\\\[)/.exec(source)` on the whole remaining source, which `marked` calls for
every paragraph. Doubling the input quadruples the time:

| Paragraphs | Size | `scanMarkdown` | plain `marked` lexer |
| --- | --- | --- | --- |
| 2,500 | 147 KB | 110 ms | 27 ms |
| 5,000 | 296 KB | 308 ms | 29 ms |
| 10,000 | 594 KB | 1,192 ms | 75 ms |
| 20,000 | 1,209 KB | 4,063 ms | 124 ms |

The scan runs once per admitted node, synchronously, before the first row. Roadmap 2c.6 says Markdown works at any
size and the cost is bounded by the window. At 1 MB the first paint blocks input for about 2 s. The work budgets
count rows (W22 records no time), so no gate sees it. W22 and W24 are the two slowest budget rows (1.2 s each,
no coverage). `markdown-rows.spec.ts:188` needed its timeout bumped for the same reason (3.2 s plain).
*Fix direction:* make `start` cheap (search only to the next blank line, or memoize the next match position per
source) and add a timed assertion to W22.

### P2

**F2. The sanitizer regexes are quadratic on many unterminated OSC openers.** Reproduced.
`core/ui-validator.ts:67` (`TERMINAL_SEQUENCE`, lazy `[\s\S]*?`) and `core/plugin-view.ts:26` (`ANSI_OR_OSC`,
`[^\x07]*`) both rescan to the end of the string from every `\x1b]` that has no terminator:

| Input | validator regex | plugin-view regex |
| --- | --- | --- |
| 8 KB | 9 ms | 8 ms |
| 16 KB | 34 ms | 27 ms |
| 33 KB | 130 ms | 128 ms |
| 65 KB | 531 ms | 646 ms |

A single unterminated opener on a 1 MB body costs 1 ms, and normal text 1 ms, so only text with thousands of
unterminated openers triggers it (a binary or truncated terminal log, for example). Since 2c.2 removed the length
cap, nothing bounds this input, and admission runs on the event loop. *Fix direction:* a bounded or sticky scan
(treat a missing terminator as "to end of line" or cap the lookahead).

**F3. A newline in a `fields` value or label replaces the node with a rejection row.** Reproduced.
Admission keeps `\n` (`UNSAFE_CONTROLS` at `ui-validator.ts:68` excludes `\x0a`; `label()` at `:232` does not
collapse it). `fieldsSource` (`core/content-rows.ts:866-913`) then builds `raw` with more lines than `fields.length`,
and `values[line]` is `undefined` for the extra lines:

```
ui.fields([{ label: 'name', value: [{ text: 'line one\nline two' }] }, ...])  ->  |Mayfly UI rejected: values[line] is not iterable|
ui.fields([{ label: 'a\nb', value: [{ text: 'v' }] }])                       ->  same
a titled ui.sections([...fields with 'x\ny\nz'])                              ->  the title, then the same row
```

The Website names the value as a clipped one-row field (commit `ece6392`), so the contract says one row. The painter
does not enforce it. *Fix direction:* collapse or reject `\n` in one-row fields at admission, and add the case to
the validator spec.

**F4. Adjacent Markdown blocks form one oversized paint unit.** Reproduced.
`markdown-rows.ts:204-211` flushes a unit only beside a `space` token, so a document without blank lines never
splits (a token larger than 4 KB is cut into raw `lines` units, but a run of small tokens is not):

| Input | Units | Largest unit |
| --- | --- | --- |
| 8,000 headings, no blank lines (179 KB) | 1 | 182,889 chars |
| the same with blank lines | 47 | 4,094 chars |
| 3,000 adjacent code fences (83 KB) | 1 | 84,779 chars |

Painting the one unit costs 44 ms at 20 KB, 512 ms at 320 KB and 1,549 ms at 1.3 MB, all in one frame, and the rows
are one cache entry. That defeats the 4 KB segment and eviction design. *Fix direction:* also flush between tokens
once the budget is exceeded when the next token starts at a line boundary that is safe to cut.

**F7. `@` completion and `!` shell commands use `process.cwd()`, not the session's directory.** Read; needs a
runtime check. `interaction/editor-plus.ts:178` and `:439` call `process.cwd()`, while the status line
(`transcript/status-cwd.ts:51`), the git status (`status-git.ts:285`), `/btw` (`btw-command.ts:113`) and the session
picker use `session.header.cwd`. New sessions are created with `process.cwd()` (`app/index.ts:169`), so the two agree
until a session of another workspace is resumed through `/sessions` or `--resume`. Then the status line shows the
session's directory while `!pwd` and `@` completion use the launch directory. The comment above `builtCwd`
(`editor-plus.ts:157`) says the provider is rebuilt when "the session cwd moves", which the code does not do.
*Check:* resume a session of workspace B from a shell in workspace A, run `!pwd`, and complete `@`.

**E1. The architecture guard specs are not selected by leaf edits.** Reproduced with
`script/verify/select.mjs`. `keyboard-boundary.spec.ts`, `business-rendering-drift.spec.ts` and
`architecture-boundary.spec.ts` read `packages/mayfly/src` with `readdir` and import nothing from it, and
`inputs.mjs` `DATA_READS` has four rows, none for them:

| Changed file | Specs selected | Guards selected |
| --- | --- | --- |
| `interaction/jobs.ts` | 5 | none |
| `transcript/banner.ts` | 5 | none |
| `core/terminal.ts` | 123 | `architecture-boundary`, `locale-catalog` |

A change that breaks a boundary in a leaf file therefore passes the round and pr tiers and fails only in the full
tier on `main`. `ui/tests/types.spec.ts` already uses the directory-prefix form of `DATA_READS`.
*Fix direction:* add `[spec, 'packages/mayfly/src/']` rows (and the `locale` files for `locale-catalog`).

### P3

**F6. Appending to a chunked log costs O(total) per append.** Reproduced. Per appended chunk:

| Document | `remapDocumentOffset` | `indexMergedLines` | join |
| --- | --- | --- | --- |
| 1 MB (524 chunks) | 2.9 ms | 2.2 ms | 0.3 ms |
| 4 MB (2,097 chunks) | 13.0 ms | 4.7 ms | 1.7 ms |
| 10 MB (5,243 chunks) | 38.4 ms | 13.1 ms | 5.8 ms |

The prefix loop at `ui-interaction-document.ts:43` compares characters one at a time. For a pure append,
`after.startsWith(before)` answers in one native compare. The job output feed is capped by retention trims, so this
matters only for a long, fast job with an unfollowed place. W23's `linesEstimated: 20005` for one appended chunk
records the re-index and could gate the fix.

**A10. The conversation projection is quadratic in history.** Reproduced (this is item A10 of the 2026-09-06
audit, still open). Folding a synthetic history (7 events per turn):

| Turns | Entries | Total fold | Per event |
| --- | --- | --- | --- |
| 150 | 450 | 10 ms | 9 µs |
| 600 | 1,800 | 51 ms | 12 µs |
| 2,400 | 7,200 | 1,073 ms | 64 µs |
| 4,800 | 14,400 | 4,436 ms | 132 µs |

A 150-turn session (the 2b replay) is unaffected. The cost shows when a session of several thousand turns is
resumed. The sources are the `entries` array copy and linear `entryIndex` scan per event
(`conversation/projection.ts:188, 205, 259, 359, 425, 547`). The first survey called this the heaviest open item. It
is real but not urgent.

**B1. A compatibility parameter in `buildClipboardOsc52`.** Confirmed. `core/terminal-escape.ts:57-65` keeps
`insideTmux` "for call-site compatibility" and runs `void insideTmux`. The root instructions forbid compatibility
paths. One production call (`terminal-escape.ts:135`, `false`) and four spec calls pass the argument. *Fix:* remove
the parameter and update them.

**B2. The `'braille' | 'tide'` loader aliases.** Confirmed. `ui/src/contracts.ts:342` widens
`MayflyLoaderNode.variant`, `core/ui-validator.ts:1465` accepts both, `core/ui-loader-animation.ts:37-38` maps them
to `gap`, and `transcript/official-model.ts:686`, `examples/ui-gallery/src/index.ts:142` and
`website/plugins/ui-reference.md:1476` still use them. One change removes the aliases and updates every caller.

**B3. Duplicate `"@ephemeral-ai/mayfly-ui"` key in five example manifests.** Confirmed in `bottom-log`, `header`,
`mayfly-user-kit`, `right-inspector` and `ui-gallery` (the first survey counted four). JSON keeps the last value, so
nothing breaks, but the manifest check should reject it.

**B4. Dead and test-only code.** Counted by `exports.mjs` over 1,945 exports of `packages/*/src`:

- 218 are referenced only inside their own file, so they should not be exported (core 85, interaction 68,
  transcript 27, frontend 14, ui `contracts.ts` 18).
- 280 are referenced only by tests (interaction 121, core 82, transcript 54). Some are legitimate seams, many are
  constants.
- Dead outright: `spanText` (`core/plugin-view.ts:67`, no reference anywhere).
- Referenced only by tests: `contentNodeRows`, `materializedRows`, `charWrap`, `segmentStrip`, `paintDiffRows`, and
  `TRANSCRIPT_MODEL_WINDOW` ("legacy export retained for consumers", `transcript-model.ts:68`, public through
  `transcript/index.ts`).
- `clipRow` (`ui-list-paint.ts`) is exported and used only inside its file.

**B5. Repeated helpers.** Counted by grep: the error-message idiom `error instanceof Error ? error.message :
String(error)` (37 uses); `originalDispose` wrapping in `ui/src/services.ts` (four copies, lines 298, 457, 529,
569); three deep-freeze copies (`builders.ts`, `services.ts`, `frontend/models.ts:204`); semver in three places; three
ANSI strippers. Merging them is mechanical and low risk but touches many files.

**B6. Three near-identical row-source classes.** Read. `SegmentedContent`, `DiffRowsSource` and
`MarkdownRowSource` (`core/content-rows.ts:106, 262, 370`) repeat counts, Fenwick, `changes`, `lazy`, `failures`,
`paintSafely`, `cacheKey`, and `prepare`. A shared base removes about 150 lines, but this is the hot path, so only do it
after F1, F4 and F6 are fixed, with the decision tests of W18-W24 in place.

**F5, F8, F9, F10, F11 (read, unverified at runtime, low impact).**

- F5: `SegmentedContent.row()` locates the segment before painting and does not re-locate after the painted count
  replaces the estimate (`content-rows.ts:185-191, 342-348, 504-519`), so a first read of an over-estimated segment can
  return `''`. Scrolls call `prepare` first. The first survey reproduced it on a family-emoji document.
- F8: `app/index.ts:150-187` queues startup, resume, new and fork on one promise chain with no unload or generation
  fence. `exit-epitaph.ts:29-53` keeps module-level mutable state and a `process.once('exit')` hook that is never
  removed. The epitaph is armed on dispose by design.
- F9: `new AbortController().signal` is passed to `commands.execute` in three places (`input-plugin.ts:575`,
  `permission-panel.ts:112`, `mode-commands.ts:61`), so a command cannot be cancelled when its Fiber unloads.
- F10: admission and paint sanitize with different regexes (`ui-validator.ts:67-68` also strips C1/DCS sequences and
  `﷐-﷯`; `plugin-view.ts:26-32` does not), and the painter sanitizes again per segment.
- F11: `estimateColumns` counts every code point of a ZWJ emoji family as two columns (about three times the real
  width). It only moves the estimated row map, which `prepare` corrects.

## Refuted or downgraded

| Lead from the survey | What the check showed |
| --- | --- |
| `MAYFLY_UI_VERIFY_MEMO=1` costs a lot and should be limited (T5) | Wall time with it is 52 s against 54 s without; per-file overhead sums to 3.2 s and the net is negative. Leave it on for every spec. The 1.68× gap in the old cache came from coverage and load. |
| `agentDocs` patterns for `.agents/`, `docs/skills/` and `mayfly-skills-plan.md` are stale (`script/verify/inputs.mjs:21`) | They are triggers for the check that forbids those paths (`check-agent-docs.mjs:48-53`). A file added there should select the check. Keep them. |
| The six `invariant.ts` area companions are dead and should be deleted | Each imports `@deepseek-ai/dsh-invariants`, is described as a "package-owned invariant companion", has an empty installer and its own spec. It appears to be a Harness convention. Whether the Harness requires one per area was not checked against its reference. Decide with the owner (ceremony, not a defect). |
| `checkOf` is O(items) per row on the hot path | Tree page down is 1.2 ms at 100,000 items. Not a measured cost. |
| F12, a stale elision text after a locale change | Not reproduced and not traced to the end: the compile cache is keyed on colors and components only (`ui-compile-cache.ts:34`) and `contentEnv` captures compile-time options. Whether a locale change recompiles the surface was not checked. Low priority; check it during the 2d locale pass. |

## Test efficiency

Measured on the plain `suite` run (8 cores, no coverage): 294 files, 5,107 tests, 0 failed, 1 skipped, 54 s wall,
164 s of summed test time. 3,035 tests (59%) take under 10 ms. The 139 slowest tests (2.7%) are half the time.
By directory: `interaction` 95 s, `core` 43 s, `transcript` 12 s, `design` 4 s, `app` 2 s.

| # | Item | Measured | Proposal |
| --- | --- | --- | --- |
| T2 | Real waits | Four `probeDarwin` timeout tests wait the real 5 s (20.1 s of the 22.2 s `paste-image-native.spec.ts`, the longest file of the suite); two `paste-image` tests wait out 3 s each; `agents-command` waits 2.1 s, `native-features` 1.0 s | Inject the tool timeout (`DARWIN_TOOL_TIMEOUT_MS`, `CLIPBOARD_TOOL_TIMEOUT_MS`) or advance fake timers. About 29 s of test time, and it removes the longest file from the critical path. |
| T3 | `work-budget.spec.ts` runs every workload three times | 9.0 s without coverage, of which the `is deterministic` test is 5.8 s (65%); it re-measures what the gate already stored in `measured` (`work-budget.spec.ts:60-66`) | Compare the gate's stored counters with one second pass of each, or keep one deterministic probe per workload kind. About 3-4 s plain (the 20 s in the full tier is coverage-inflated). |
| T4 | Width-scan matrix | The scan and guard specs sum to 22 s (13%): `interaction/width-scan` 8.3 s, `core/width-scan` 4.0 s, `transcript/width-scan` 3.0 s, `business-rendering-drift` 1.8 s, the rest 5 s | Share one node table and trim the middle widths and the extra heights. Keep a width-regression decision test per pattern. |
| T1 | The `core/index.ts` barrel | 25 value imports of the barrel from `transcript/` and `interaction/` (for example `sanitizePluginText`); 121 specs have a source closure of at least 150 files; an edit of `core/width.ts` selects 189 specs; import time is 42% of worker time in the full run | Import from the defining module. Cuts selection and import time at once. |
| T6 | One content stack, tested five ways | 50 MB scroll (2.0 s), 512 KB Markdown equivalence (3.2 s), 1,000,000-row read (1.5 s), 100,000-entry model source (4.3 s), plus W18-W24 and the `content` scenario | Keep one windowed-correctness test per layer and run the oversized cases once. The 100,000 case of `official-model.spec.ts` adds nothing over 10,000 (`reads === length` is the same decision). |
| T7 | Oversized timeouts | `file-mention.spec.ts:228, 242` use `30_000` on a 333 ms file; `types.spec.ts` `120_000`; `markdown-rows.spec.ts:188` now `20_000` | Remove, or set to about 5× the measured time. Do not paper over F1. |
| T8 | Coverage-driven tests | `plugin-commands.spec.ts:1310, 1642, 1820` ("coverage corners", "final arms"); `search-group.spec.ts:131`; 19 tests with no assertion (a static scan) | Delete or turn into decision tests; this conflicts with D25. The 99% floor encourages them, so the floor needs an owner decision. |
| T9 | Phase-1 design frames | 84 grids, 576 KB, 4 s of test time | Retire with the accepted 2d frames. |
| T10 | Copied test helpers | `identity` (27 files), `flush` (22), `plain` (16), `fakeAgent` (7 versions), 29 hand-built colour proxies | One shared module. |
| T12 | Serial full tier (365 s) | dsh boots are about 50%: scenarios 98 s, perf 74 s, smoke 10 s. `build` runs `tsc -b --force` right after `typecheck` already ran `tsc -b`. `browser.test.mjs` starts Chrome (16 s of the 22 s workflow tests) | Run the cheap checks beside the vitest step, drop the forced second compile in the full tier, and let several checkpoints share one boot (30 of 34 scenario runs capture one checkpoint). |
| T13 | Budget gaps | No counter or timing for the transcript path, the editor, job output or `highlight`; `perf-stream` has `ceilings: {}` | Add rows only where a measurement above shows a cost (F1, F6, A10), as D25 asks. |

## Gate and workflow

- **E1** above is the one defect.
- **E2.** `script/change-files.mjs` is imported by `scenarios.mjs`, so a one-line edit to it selects all 33
  scenarios, and `packages/mayfly/package.json` does the same. Both are legitimate but costly. Consider a narrower
  declared input.
- **E3.** The `claimed-files` guard and `GLOBAL` list are sound as designed. `.github/workflows/` and any root
  `tsconfig*` escalate to the full tier; that is intended.

## Needs the owner

I cannot judge these from code or a headless run. They are the 2d acceptance itself:

1. The look of the basic components beside the prototype at 120 and 60 columns, with `NO_COLOR=1`, ASCII glyphs and
   reduced motion.
2. The prompt with paste, IME and the clipboard (`docs/platform-acceptance.md`), including a Chinese input method,
   image clipboard and OSC52 feedback, on Linux (X11 and Wayland), Windows Terminal and macOS.
3. An inline image in a terminal that supports images, and the fallback in one that does not.
4. A key rebound in `/settings` with the hint row following it, and one pattern copied from
   `examples/mayfly-user-kit`.
5. A plugin view in row 2, the work report, and whether the perf reading means what the owner expects.
6. The feel of a 1 MB diff, a long plan and job output following its tail on `dsh --profile mayfly-2c` (the
   headless goldens prove the cells, not the steadiness).
7. F7 on a real resumed session in another workspace (three commands in a shell).
8. Decisions the report leaves open: the `invariant.ts` companions, merging the three row-source classes (B6), what
   to cut from the gate (T6, T9), and the coverage floor (T8). Also how far to go in the Phase 3a transcript path,
   which this audit measured and did not review.

## Triage and proposed slices

| Slice | Contents | Gate tier | Owner decision |
| --- | --- | --- | --- |
| `audit-1` correctness | F1, F3, F2, F4, F7 (after the runtime check), E1 | pr, then full | F4's cut rule |
| `audit-2` forbidden leftovers | B1, B2, B3, `spanText`, test-only exports (B4) | pr | public-surface removals |
| `audit-3` content cost | F6, A10, and timed rows for W22/W23 | pr with perf A/B | none |
| `audit-4` tests and gate | T2, T3, T7, T1, T10, E2 | pr, then full | none |
| later | B5, B6, T4, T6, T8, T9, T12 | full | yes |

## Appendix: reproduction

All scripts live in the session scratchpad and were run from the repository root with Node 24.21.0; they import the
built `lib/` or the TypeScript sources (`--experimental-transform-types` for sources that use parameter properties).

- F1: `scanMarkdown(text)` and `new Marked().lexer(text)` over `N` paragraphs
  `Paragraph i with some words and [a link](http://x/i).` joined by a blank line.
- F2: `'\x1b]0;x'.repeat(n / 6)` through each regex with `.replace(re, '')`.
- F3: `compile(ui.fields([{ label: 'name', value: [{ text: 'line one\nline two' }] }]))` through
  `compileMayflyUiNode` (the harness copies `script/audit-performance.mjs`) and `component.render(60)`.
- F4: `scanMarkdown` over 8,000 `## Heading n` lines joined by `\n` or by `\n\n`; `markdownBlockRows` over the one unit.
- F6: `remapDocumentOffset(before, after, 100)`, `chunks.map(c => c.text).join('')` and `indexMergedLines` over
  chunked job-like text at 1, 4 and 10 MB.
- A10: `foldConversationProjection` over `turn/start`, `user/message`, `step/start`, `assistant/message`, `tool/call`,
  `tool/result`, `turn/end` per turn.
- E1: `classifyChanges([file], { graph })` from `script/verify/select.mjs` over `buildGraph(root, { cache: null })`.
- Tests: `vitest run --config <scratch>/plain.config.mjs --reporter=json --outputFile=...` (and the same with
  `env: { MAYFLY_UI_VERIFY_MEMO: '1' }`), then a per-test analysis of the JSON.
- Dead code: `exports.mjs` (regex scan of `export` declarations against word-boundary references in packages,
  examples, script, website and docs, bucketed by own file, source, tests and docs).
