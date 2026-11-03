# Phase 2 audit, Part 1: runtime and measurement

Audit date: 2026-10-11. Worktree: `/home/x/dev/mayfly-audit-part1`, branch
`audit/part1`, starting at `c4d711b493c88a04edd030fe8df6f75c9d1ce590`.
The product baseline is still `b657469`: `git diff --stat b657469 HEAD` at
the start listed only the three audit documents. This audit does **not** test
the unmerged `feat/audit-1` fixes. Source line references below refer to this
unfixed baseline, not the transformed line numbers in V8 profiles.
Unless written in full, `core/...` and `conversation/...` mean paths under
`packages/mayfly/src/`, and `tests/...` means `packages/mayfly/tests/`.

## Scope and method

This covers open items **3, 4, 6 (timings and import closure), and 7** in
`2026-10-11-phase-2-audit-progress.md:30-36, 76-88`. The plan, audit report,
progress report, root instructions, and all three packages' instructions were
read first. The report's F-numbers are retained. Part 2's lifecycle, static
reading, export/deletion checks, and report are outside this audit.

No product source, examples, repository script logic, tests, plan, progress
report, instructions, dependency policy, or worktree golden was edited.
Reproduction programs, profiles, logs, and disposable snapshots live only
under ignored `.artifacts/p1/`. The sole submitted file is this report.
The scratch catalog entry used for golden acceptance was removed afterward.
No owner's manual acceptance was performed, including F7 and the live F12
locale switch. Automated existing suites and headless approval scenarios are
not those manual checks.

There was an environment mismatch: `~/dev/mayfly` was a different, dirty
GitHub checkout without the audit branch. With the user's confirmation, the
requested worktree was created from `/tmp/mayfly`, whose `origin` is
`http://192.168.8.77:3000/Gorgeousltg/mayfly.git`. Neither checkout's
uncommitted edits were staged or copied into the audit. Network access for
fetch, dependency installation, and the requested push was explicitly approved.

### Machine and timing limitations

```text
Linux x 7.0.0-34-generic x86_64
CPU model: AMD EPYC 9115 16-Core Processor
Node v24.15.0
corepack 0.34.6
pnpm 11.7.0
getconf _NPROCESSORS_ONLN: 16
initial load average: 4.74, 4.20, 3.56
```

**The exclusive-machine premise could not be met.** Only one audit timing
command ran at a time, except the requested parallel scenario experiment.
However, unrelated processes were active: a `ROPgadget` process at about
101% CPU during early probes, `ld239.so` at 760% before the first coverage
run and 1068% before the seven-run perf sample, and several `rustc` processes
before the final clamp/golden probes. These were reported during the audit;
no unrelated process was stopped. Their origin was not established.

Appendix A records **the load before every timing invocation**, UTC start,
command, elapsed time, exit status, and the busiest process in a one-second
pre-run CPU sample. Load averages also retain the effects of the preceding
audit command; a high average alone is not proof of competing work.
Conversely, a quiet pre-run sample does not prove the whole run was isolated.

Accordingly, milliseconds, ratios, heap deltas, and perf verdict statistics
below are **observations on this host**, not clean regression ceilings or
precise estimates of coverage-only overhead. Deterministic work counts,
identity comparisons, retained map sizes, test outcomes, and byte-equal
grids are the stronger evidence. No timing claim below is inferred merely
from reading an algorithm.

Setup commands, in order:

```sh
# From /tmp/mayfly, after reading local instructions:
git fetch origin docs/phase-2-audit
git worktree add /home/x/dev/mayfly-audit-part1 -b audit/part1 origin/docs/phase-2-audit
# From the new worktree, after reading its instructions:
corepack pnpm --version
corepack pnpm install
corepack pnpm run build
```

Install and build exited 0. Install took 1.7 s as reported by pnpm. Pre-install
and pre-build `/proc/loadavg` were both `4.01 4.06 3.53`. The build retained
the existing ineffective-dynamic-import warning for `clipboard-write.ts`;
no warning was suppressed and the lockfile was not changed.

### Measurement conventions

- Direct probes import the tested TypeScript source with
  `--experimental-transform-types`; package-name dependencies resolve the
  freshly built workspace `lib/`. They use a warm-up and medians of seven
  calls, or three for F1/F2/F4/A10 and eleven for diff rebuilds.
- Direct CPU profiles use the Node inspector **after imports**, repeating the
  operation until at least 750 ms has elapsed. Self times are cumulative
  across those repetitions, not per operation. Inlined work can be attributed
  to its caller. The repository's `selfTimes` excludes idle, program, and GC
  samples; totals quoted here use that same convention.
- Real PTY profiles include boot. They must not be mistaken for steady-state
  profiles of the deliberately large direct inputs.
- Surface probes mount the provider, native Cordis Context, frontend, screen,
  components service, theme, and surface renderer over pi-tui and a recording
  terminal. Counters are reset around a publish and its render. Frame counts
  count the actual synchronized-output start sequence, not calls to a
  compiled leaf's `render`.
- Diagnostic load hooks count existing width calls/cache miss reasons without
  changing repository files. Wall timings without that hook are reported
  separately. The captured-service **scratch control** changes the test host,
  not product code; it is not a proposed or verified lifecycle fix.
- The four Vitest runs use the identical checked-in configuration and both
  projects, eight fork workers, and ABBA order: no coverage, coverage,
  coverage, no coverage. `suite` retains `MAYFLY_UI_VERIFY_MEMO=1` in all four.
  “Plain” here means **without coverage**, not without memo verification.

## Results at a glance

| Open item | Result | Relation to existing findings |
| --- | --- | --- |
| 3: CPU profiles | Real PTY profiles obtained; large-input direct profiles obtained for all five paths. CLI summary itself is broken. Catalog does not expose these stress inputs. | Confirms/extends F1, F2, F4, F6, A10; extends T13; new P1-01 |
| 4: diff resize | New-width reconstruction measured; 40-row paint stays one 64-row chunk at both sizes. | Extends B6; no slow-resize defect demonstrated |
| 4: row-cache eviction | Eight variants stay warm; sixteen thrash; a repeatedly accessed oldest entry still evicts. | Extends the cache survey; FIFO, not LRU, reproduced, not automatically a defect |
| 4: scroll memory | Id churn at a fixed position stays at one entry; historical positional paths grow 1,000 → 2,000. | New P1-02, bounded by runtime lifetime rather than current controls |
| 4: clamps | Two measured Mayfly clamp sites are proportional to history in main mode but to 40 visible rows in alternate mode. | Extends T13; refutes a blanket full-history-clamp claim for alternate frames |
| 4: pane/overlay refresh | Real Cordis service retrieval prevents otherwise reusable leaves from hitting the compile cache. | New P1-03; extends T13 |
| 6: coverage | Same 294 specs, 5,141 tests, zero failures in all four runs. Coverage runs slower; exclusive-machine estimate unavailable. | Extends T2/T3/T4; does not re-test T5 |
| 6: import closures | Per-spec table for all 294 specs; 120 value-source closures ≥150 files; width reaches 189 specs. | Confirms T1's broad fan-out; count definition clarified |
| 7: parallel determinism | Two full catalog invocations, four internal runners each, passed; all 40 corresponding grids byte-identical. | Confirms isolated-run determinism; no new finding |
| 7: perf statistics | 3/5/7 runs per side against HEAD: 9 same + 1 inconclusive, then 10 same, then 10 same. | Extends gate evidence, with host-load qualification |
| 7: golden acceptance | Scratch-only new → updated → same; scratch change discarded. | Confirms the ordinary single-scenario acceptance path |

## Item 3: profiles of the reproduced paths

### Real CLI/PTY run and P1-01

Command (Appendix A, `perf-prof`):

```sh
corepack pnpm run perf -- --against HEAD --runs 1 --prof perf-content perf-stream perf-gallery
```

Inputs are the unmodified catalog at 120×40:
`perf-content` opens the trace detail of a 4,000-record write (1,022,892
ASCII content bytes), pages ten times and resizes twice;
`perf-stream` plays the catalog Markdown replay, then twenty page keys and
twenty wheel notches; `perf-gallery` idles for 4 s then types the catalog
sentence. Definitions: `script/scenarios/catalog.mjs:150-180`,
`script/scenarios/replays.mjs:514-522`.

Trimmed output:

```text
perf-content (head vs c4d711b493, 1 runs each)
  most self time (head ms / base ms):
perf-stream (head vs c4d711b493, 1 runs each)
  most self time (head ms / base ms):
perf-gallery (head vs c4d711b493, 1 runs each)
  most self time (head ms / base ms):
perf: PASS
TIME wall=104.47 user=51.27 sys=7.55 rssKB=891276
```

**P1-01 — `perf --prof` records profiles but prints an empty function
summary. Reproduced; workflow defect.** `script/perf.mjs:102-106` writes each
profile under `head/<scenario>-<run>/`, but `:147` passes `head/` to
`selfTimes`. `script/scenarios/cpuprofile.mjs:17-21` reads only files directly
in its argument directory, not its children. The JSON report's `prof` lists
were empty as well. This is not a failure to obtain samples.

Reproduction of the reader mismatch:

```js
import { selfTimes, topFunctions } from './script/scenarios/cpuprofile.mjs'
console.log('root head functions:', selfTimes('.artifacts/perf/prof/head').size)
console.log(topFunctions(selfTimes('.artifacts/perf/prof/head/perf-content-1')))
```

```text
root head functions: 0
```

Reading each **existing leaf directory** with the same functions produced
these top self-time functions (head milliseconds, trimmed):

```text
perf-content-1:
  compileSourceTextModule utils:316      198.4
  wrapSafe loader:1721                   84.3
  get index.js:673                       66.3
  lstat                                 46.4
  internalModuleStat                    44.2
perf-stream-1:
  truncateToWidth utils.js:952           783.2
  graphemeWidth utils.js:144             258.2
  compileSourceTextModule utils:316      232.4
  extractAnsiCode utils.js:356           153.3
  get index.js:673                      146.9
perf-gallery-1:
  compileSourceTextModule utils:316      212.7
  extractSegments utils.js:1131         192.8
  graphemeWidth utils.js:144              89.4
  wrapSafe loader:1721                   84.9
  get index.js:673                       51.7
```

These are boot-plus-interaction profiles. A profile-node/sample scan also
showed why they cannot close the large-input leads alone:

```text
perf-content: scanMarkdown 0 nodes; markdownBlockRows 0; remapDocumentOffset 0;
              foldConversationProjection 1 node / 1.1 ms self
perf-stream:  all five named target functions 0 nodes
perf-gallery: scanMarkdown 1 node / 0 ms self; markdownBlockRows 1 / 0 ms;
              sanitizePluginText 3 / 3.2 ms; remapDocumentOffset 0; fold 0
```

The catalog parser accepts only its four perf names
(`script/perf.mjs:37-48`). There is no CLI parameter for a megabyte of
unterminated escapes, adjacent-heading count, append/remap input size, or
thousands of projection turns. No product catalog was changed to manufacture
a PTY stress path. The direct profiles below therefore **supplement**, not
pretend to be, `perf --prof` reproductions of those exact stress inputs.

### F1 — Markdown scan

`node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs F1 5000 10000`

Input: `Paragraph i with some words and [a link](http://x/i).`, joined with
blank lines. Each run also compares the plain `Marked().lexer`.
Source: `packages/mayfly/src/core/markdown-rows.ts:126-140, 178`.

Quoted values from the direct JSON:

| Paragraphs | ASCII bytes | Scan median ms | Plain lexer median ms | Units |
| ---: | ---: | ---: | ---: | ---: |
| 5,000 | 302,778 | 230.416 | 16.623 | 75 |
| 10,000 | 607,778 | 887.248 | 32.770 | 149 |

Doubling paragraphs observed 3.85× scan time and 1.97× plain lexer time.
Top profile output:

```text
5000, 4 repetitions:
  start markdown-rows.ts:110            853.3 ms
  inlineTokens marked.esm.js:57           19.8 ms
  inlineText marked.esm.js:43              8.6 ms
10000, 1 repetition:
  start markdown-rows.ts:110            853.8 ms
  inlineTokens marked.esm.js:57           13.0 ms
  lex marked.esm.js:43                     9.7 ms
```

**Confirms F1 and identifies the repeated latex-extension `start` search as
the hot function.** The quoted V8 line 110 is transformed; the owning source
function is at `markdown-rows.ts:134-137`. Timing isolation is qualified above.

### F2 — unterminated terminal escapes

`node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs F2 6000 12000`

Input: `'\x1b]0;x'.repeat(size)`; this opener is **five** bytes, so the
actual input sizes are 30,000 and 60,000 bytes. Both `sanitizePluginText`
and actual `validateMayflyUiNode(ui.text(input))` are called, not just a
copied regex. Sources: `core/plugin-view.ts:26-32`,
`core/ui-validator.ts:67-68, 217-219`.

| Openers | Bytes | Painter sanitizer median ms | Validator median ms | Sanitized length / admitted |
| ---: | ---: | ---: | ---: | --- |
| 6,000 | 30,000 | 81.293 | 101.752 | 18,000 / true |
| 12,000 | 60,000 | 324.883 | 408.123 | 36,000 / true |

```text
6000, 5 repetitions:
  text ui-validator.ts:105              516.1 ms
  sanitizePluginText plugin-view.ts:17   392.8 ms
12000, 2 repetitions:
  text ui-validator.ts:105              805.8 ms
  sanitizePluginText plugin-view.ts:17   665.1 ms
```

**Confirms F2:** approximately 4× observed time for twice the actual bytes
in both production functions. Admission succeeds; this is blocking work,
not an input-rejection result.

### F4 — adjacent headings evade the unit budget

`node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs F4 4000 8000`

Input: `## Heading i` joined by one newline. The scan is performed first,
then the entire resulting block is painted by `markdownBlockRows` at width
80. Sources: `core/markdown-rows.ts:203-223, 234-241`.

| Headings | Bytes | Units | Largest unit | Paint median ms | Painted rows |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 4,000 | 62,889 | 1 | 62,889 | 59.607 | 7,999 |
| 8,000 | 126,889 | 1 | 126,889 | 88.399 | 15,999 |

```text
4000, 14 repetitions:
  visibleWidth utils.js:204             282.8 ms
  graphemeWidth utils.js:144            101.5 ms
  extractAnsiCode utils.js:356           59.7 ms
8000, 8 repetitions:
  visibleWidth utils.js:204             351.6 ms
  graphemeWidth utils.js:144            117.3 ms
  extractAnsiCode utils.js:356           35.7 ms
```

**Confirms F4's unbounded unit, not a quadratic paint claim.** The stronger
evidence is one 126,889-character unit producing 15,999 rows despite a
windowed-unit design. The paint ratio here is 1.48×, with a noisy smaller case.
This extends T13 with the width functions doing most of the sampled work.

### F6 — append/remap, joining and indexing job-like chunks

`node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs F6 1000000 2000000`

Input: `some job output line\n` repeated and sliced to the specified length;
append `next output\n`; remap offset 100. Chunk size is 4,096 characters.
Chunk line scans are made outside the timed `indexMergedLines` call, matching
its real API. Sources: `core/ui-interaction-document.ts:38-46`,
`core/content-segments.ts:217-249`, `core/content-rows.ts:603-625`.

| Bytes before append | Chunks | Remap median ms | Join median ms | Merge/index median ms |
| ---: | ---: | ---: | ---: | ---: |
| 1,000,000 | 245 | 2.932 | 0.227 | 2.051 |
| 2,000,000 | 489 | 5.825 | 0.398 | 3.503 |

Outputs were offset `100`, joined lengths `1000000`/`2000000`, and line
counts `47620`/`95239`.

```text
1000000, 172 profile repetitions:
  remapDocumentOffset ui-interaction-document.ts:16  429.6 ms
  indexMergedLines content-segments.ts:173           159.9 ms
  planContentLines content-segments.ts:218            55.0 ms
2000000, 81 repetitions:
  remap repro.mjs:94                                 395.3 ms
  indexMergedLines content-segments.ts:173           208.7 ms
  planContentLines content-segments.ts:218            50.7 ms
```

The second profile attributes the hot, inlined remap to the scratch caller.
**Confirms F6's whole-prefix work on append and extends its profile evidence.**
The observed remap ratio is 1.99×. The heap/time impact of an actual long
running job with repeated live writes remains distinct from this single-append
measurement. This particular run had a competing CPU-bound process.

### A10 — conversation projection folding

`node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs A10 1200 2400`

Seven events per turn: turn/start, appended user/message, step/start,
appended assistant/message, tool/call with a unique id, appended tool/result,
turn/end with `{ reason: { kind: 'completed' } }`. The program asserts
**three entries per turn**, avoiding a misleading fold of ignored messages.
Sources: `conversation/projection.ts:190-206, 250-260, 433-453, 545-547`.

| Turns | Events | Result entries | Median fold ms |
| ---: | ---: | ---: | ---: |
| 1,200 | 8,400 | 3,600 | 180.105 |
| 2,400 | 16,800 | 7,200 | 689.577 |

```text
1200, 4 profile repetitions:
  foldConversationProjection projection.ts:475      565.3 ms
  applyToolResult projection.ts:426                   50.2 ms
  (anonymous) projection.ts:204                       38.4 ms
2400, 2 repetitions:
  foldConversationProjection projection.ts:475     1139.6 ms
  applyToolResult projection.ts:426                   62.0 ms
  markTurn projection.ts:261                         31.3 ms
```

**Confirms A10**, with 3.83× observed fold time for twice the turns and a
validated complete history. The separate real PTY profile reaches only a tiny
history and is not a several-thousand-turn resume profile.

## Item 4: previously unmeasured paths

### DiffRowsSource reconstruction at new widths

Final command:

```sh
node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs diff 32000 64000
```

Input: a diff from empty text to N lines `line i ` plus forty `x` characters.
The prepared diff is warmed at 80 columns. Reconstruction requests **new**
widths 81 through 92 (one warm-up and eleven samples), not alternating cached
80/120 sources. Sources: `core/content-rows.ts:235-253, 273-297, 360-362`.

Quoted JSON values:

```text
size=32000 bytes=1652889 medianMs=0.113 minMs=0.065 maxMs=0.179 length=32000
size=64000 bytes=3316889 medianMs=0.122 minMs=0.100 maxMs=8.104 length=64000
both rebuild counters: rowsPainted=0 segmentsPainted=0 linesEstimated=0
both fresh width-60 windows: rowsPainted=64 rowsMaterialized=40 segmentsPainted=1
```

**Extends B6; no expensive resize demonstrated at these sizes.** A new source
still makes chunk slices/counts/Fenwick state, work the existing sink does not
count. The elapsed measurements include that work. They do not show a reliable
2× timing ratio at these sub-millisecond medians; the 8.104 ms outlier should
not be hidden. In contrast, the visible paint is deterministically bounded
to one chunk at both sizes.

An earlier alternating-width probe measured cache hits (0.005/0.001 ms), not
reconstruction. It is recorded in the journal and excluded from the rebuild
conclusion.

### UiRowCache FIFO eviction

`node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs fifo 4 8 16`

One stable item and palette, 1,000 passes through 4, 8, then 16 distinct state
keys. A separate hot-entry probe fills keys 0–7, reads key 0 a hundred times,
adds key 8, then reads 0 again. Source: `core/ui-row-cache.ts:8, 26-43`.

```text
4 variants:   4000 reads, medianMs=0.199, paints=0 after warm-up
8 variants:   8000 reads, medianMs=0.414, paints=0 after warm-up
16 variants: 16000 reads, medianMs=1.582, paints=16000
hotPaintedAfterEviction=1 in every hot-entry probe
```

**Extends the cache survey.** The eight-entry bound works. Read hits do not
refresh insertion order: this really is FIFO, and a 16-variant round-robin
working set misses every read. Neither result proves real lists routinely
have that working set or that FIFO should be replaced; this is measured
behavior, not a new product defect by itself.

### P1-02 — historical scroll-position keys accumulate

Commands:

```sh
node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs scrolled 1000 2000
node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs scrolled-path 1000 2000
```

Both compile and render successive valid nodes through one persistent
`MayflyUiSurfaceRuntime`; only one scroll is present in each current tree.
The first changes its id at the same tree position. The second changes the
position using two levels of column stacks and at most 118 spacer nodes.
Its historical path count doubles; tree depth and individual tree size remain
within admission limits.

```text
fixed position / changing id:
  size=1000 held=1 afterDispose=1
  size=2000 held=1 afterDispose=1
changing positions:
  size=1000 elapsedMs=417.984 held=1000 heapDelta=5048880 afterDispose=1000
  size=2000 elapsedMs=1075.127 held=2000 heapDelta=7732336 afterDispose=2000
```

**P1-02, reproduced retention risk, low-impact synthetic case.**
`core/ui-compiler.ts:1731-1737` uses the positional path, not the node id, for
scroll memory; `:2137, 2355-2358` holds every encountered key in a Map.
`bind` at `:2274-2285` resets control generations but does not retire old
scroll keys; `dispose` at `:2555-2578` leaves them too.

This confirms growth with **historical paths**, and refutes an inference
that mere id churn causes growth. The heap figures are for the whole runtime,
including caches and the current tree, not bytes attributable solely to this
Map. The elapsed figures also include changing spacer counts, so they are
not a complexity estimate for Map access. No leak after the runtime becomes
unreachable was demonstrated. The current-tree/live-view versus historical
key distinction is the finding; real product frequency was not established.

### Stacked width clamps: cost and actual paint reach

Commands:

```sh
node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs clamps 10000 20000
node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/clamp-frame.mjs 1000 2000
```

The first measures one clamp, three explicitly stacked calls, and incremental
clamping after changing only the final row. Input rows are 77 ASCII columns,
below the 80-column cap:

```text
10000 rows / 770000 characters:
  one medianMs=1.062; stacked=3.226; incremental=0.206
20000 rows / 1540000 characters:
  one medianMs=2.256; stacked=6.635; incremental=0.106
```

This is a **synthetic upper-path comparison**, not evidence that production
always executes three full scans. The incremental result is noisy/JIT-sensitive.

The second mounts an actual compiled N-line text in the core terminal, width
120, height 40, and counts the source compiler and frame-clamp width calls
when synchronized output really paints:

```text
main, 1000 lines: frames=1, compiler width calls=1000, frame-clamp calls=1000
main, 2000 lines: frames=1, compiler width calls=2000, frame-clamp calls=2000
main, unchanged request: frames=0, frame-clamp calls=1000 / 2000
alternate, 1000 lines: frames=1, compiler calls=40, frame-clamp calls=40,
                       rowsMaterialized=40, segmentsPainted=1
alternate, 2000 lines: frames=1, compiler calls=40, frame-clamp calls=40,
                       rowsMaterialized=40, segmentsPainted=1
```

In this root-component fixture the alternate mount step did **not** itself
paint; the following explicit request did. Its initially near-zero elapsed
value is not presented as a frame measurement. The printed counters above
are from the step with `frames=1`. Early shorter-timer versions were retained
in the command journal, not treated as completed initial paints.

Source sites: `core/content-rows.ts:995-1018` skips a redundant leaf measure
when width is declared; `core/ui-compiler.ts:2928-2934` clips the surface;
`core/frame-clamp.ts:61-70, 94-111, 125-128` implements the exits;
`core/terminal.ts:128-140, 934-938` distinguishes alternate child caching
from the main-screen full exit scan.

**Extends T13, not a new alternate-screen defect.** Full main-screen scans
are reproduced, including one on an unchanged render request with no emitted
frame. Main mode is a fixture/legacy path, not the product's selected
alternate mode. The measured alternate frame's clamp work stays at 40 rows
when document size doubles. Upstream pi-tui width calls are not all covered by
this hook; their cost is visible in the separate real CPU profiles.

### Pane/overlay publish cost and P1-03

Final uninstrumented, diagnostic, and control commands:

```sh
node --experimental-transform-types .artifacts/p1/surfaces.mjs 32 64
node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/surfaces.mjs 32 64
P1_CAPTURE_COMPONENTS=1 node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/surfaces.mjs 32 64
```

Input: one right pane (preferred width 40, narrow-bottom policy), or one
capturing overlay, each containing a 20-row scroll over a column of N text
leaves. Publish the same node, change only one leaf retaining the other
identities, or rebuild all leaves. Seven samples per case. Every sample in
these runs emitted **one actual terminal frame**.

Uninstrumented median milliseconds:

| Surface | Leaves | Same | One leaf changed | All changed |
| --- | ---: | ---: | ---: | ---: |
| Pane | 32 | 4.005 | 3.407 | 4.155 |
| Pane | 64 | 3.009 | 3.854 | 4.644 |
| Overlay | 32 | 2.490 | 2.272 | 3.827 |
| Overlay | 64 | 2.591 | 3.053 | 3.620 |

The noisy times alone would hide the defect. Actual counter output from a
same-node publish:

```text
pane 32:    unitsCompiled=34 componentRenders=32 segmentsPainted=32 rowsPainted=84
pane 64:    unitsCompiled=66 componentRenders=64 segmentsPainted=64 rowsPainted=148
overlay 32: unitsCompiled=34 componentRenders=32 segmentsPainted=32 rowsPainted=52
overlay 64: unitsCompiled=66 componentRenders=64 segmentsPainted=64 rowsPainted=84
all four:   rowsMaterialized=20 controlWalks=1 layoutPasses=1 clockTicks=0 frames=1
```

**P1-03 — reacquiring the Cordis components wrapper defeats unchanged-leaf
compile reuse. Reproduced work defect.**
The diagnostic gives:

```text
IDENTITIES: componentsStable=false, colorsStable=true (all four hosts)
same publish: cache miss reason {"components":32} / {"components":64}
one-leaf change: {"absent":1,"components":31} / {"absent":1,"components":63}
```

The real `Context` returns different `mayflyComponents` wrapper identities
on successive reads. `core/surface-renderer.ts:350, 479` rereads that service
for each compile. `core/ui-compile-cache.ts:37-39` quite correctly refuses
reuse when the components identity differs. Same node and colors are not
enough in this mounting path.

The scratch control captures service references once on a plain owner host,
while leaving the source cache logic unchanged:

```text
same publish, 32 or 64 leaves, pane or overlay:
  cache {"hit":32} / {"hit":64}
  unitsCompiled=2 componentRenders=0 segmentsPainted=0 rowsPainted=20 frames=1
one-leaf change:
  cache {"absent":1,"hit":31} / {"absent":1,"hit":63}
  unitsCompiled=3 componentRenders=1 segmentsPainted=1 frames=1
all-leaf changes: absent=32 / 64 and original full work, as expected
```

This isolates wrapper identity rather than missing node identity or palette
changes. It **extends T13**: the direct workloads' stable component object is
not enough evidence for refreshes mounted with actual Cordis service getters.
No lifecycle fix, service-replacement behavior, or reload acceptance is
claimed by the scratch control.

The diagnostic also measured the Mayfly surface clamp: 13 width calls for
each overlay frame at both N, zero direct calls at those particular clamp
sites for pane frames; leaf declared-width checks bypass the redundant
measure. Sample 4's overlay same-publish measured width time was 0.00636 ms
at 32 leaves and 0.00565 ms at 64. The linear wasted leaf work above is not
explained by a growing final clamp.

### Real CLI frame counts, including doubled input

```sh
corepack pnpm run frame content
corepack pnpm run frame gallery
corepack pnpm run frame approvals
P1_CONTENT_RECORDS=8000 NODE_OPTIONS=--import=/home/x/dev/mayfly-audit-part1/.artifacts/p1/fixture-hook.mjs corepack pnpm run frame content
```

The last command changes **only the replay's generated-record count in memory**
via a scratch load hook, not any worktree file or golden. It supplies 8,000
records / 2,046,892 content bytes instead of 4,000 / 1,022,892.

```text
content at 120x40: booted in 1730 ms, 56 frames, 11343 ms
gallery at 120x40: booted in 1714 ms, 11 frames, 7864 ms
approvals at 120x40: booted in 1644 ms, 18 frames, 7989 ms
content [8000 records] at 120x40: booted in 1782 ms, 57 frames, 11525 ms
```

Both content runs captured card, detail, paged, tail, and resized checkpoints.
All four commands exited 0 with no wrapped-row, overflow, crash, driver, or
exit failure. These are whole-PTY frame counts, including boot, not leaf
render counts or instantaneous FPS. They extend the bounded-window evidence;
the one-frame difference and wall times are not a clean performance verdict.

## Item 6: coverage costs and per-spec import closure

### Identical suites, with and without coverage

Exact commands appear in Appendix A; each is:

```sh
corepack pnpm exec vitest run --maxWorkers=8 --reporter=default --reporter=json --outputFile=.artifacts/p1/<name>.json
# The coverage runs insert --coverage before --reporter.
```

No test, timeout, config, or coverage threshold was edited. Input is the same
294 spec files in both configured projects, 5,141 tests. All four produced:

```text
Test Files  293 passed | 1 skipped (294)
Tests       5140 passed | 1 skipped (5141)
```

| Order/run | Process wall s | Vitest duration s | Transform s | Import s (summed) | Tests s (summed) | Max process RSS KB |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| plain-1 | 37.10 | 36.25 | 13.33 | 111.70 | 137.73 | 785,924 |
| coverage-1 | 50.34 | 49.30 | 14.22 | 135.31 | 171.44 | 1,092,472 |
| coverage-2 | 45.53 | 44.55 | 11.11 | 115.84 | 157.71 | 1,124,052 |
| plain-2 | 38.70 | 37.96 | 13.73 | 125.68 | 134.76 | 721,524 |

Both coverage summaries were identical:

```text
Statements : 99.56% (26738/26856)
Branches   : 99.22% (20587/20747)
Functions  : 99.56% (5513/5537)
Lines      : 99.8%  (21424/21465)
```

The mean process wall ratio is 1.265× (47.94 / 37.90 s); the quieter
coverage-2/plain-2 pair is 1.177×. These are **observed paired-run ratios,
not a clean causal estimate**: the especially busy pre-coverage-1 sample
invalidates the exclusive-machine premise. No 1.68× coverage figure from an
old cache was reused.

Per-spec test durations from the fresh JSON, milliseconds; these are sums
of actual assertion durations, not Vitest's import time:

| Spec under `packages/mayfly/tests/` | plain-1 | coverage-1 | coverage-2 | plain-2 |
| --- | ---: | ---: | ---: | ---: |
| `perf/work-budget.spec.ts` | 9,450.5 | 13,184.2 | 11,386.5 | 8,688.0 |
| `core/markdown-rows.spec.ts` | 2,053.4 | 3,161.3 | 2,754.4 | 1,727.3 |
| `interaction/width-scan.spec.ts` | 6,981.0 | 8,623.8 | 7,792.1 | 5,923.9 |
| `core/width-scan.spec.ts` | 2,861.3 | 4,670.7 | 3,780.8 | 2,974.0 |
| `interaction/paste-image-native.spec.ts` | 21,523.5 | 21,763.2 | 21,383.5 | 21,630.8 |

**Extends T2/T3/T4.** Real waits remain about 21.5 s regardless of coverage;
work-budget and width-scan execution takes more time in these coverage runs.
Sources: `tests/perf/work-budget.spec.ts:60-66`,
`tests/interaction/paste-image-native.spec.ts:604-635`,
`tests/interaction/width-scan.spec.ts:31-66`, and `vitest.config.ts:19-33`.
There is no new claim that memo verification is expensive: T5 was not re-tested.
Deletion checks belong to Part 2 and were not performed.

### Per-spec closure from the actual verifier graph

Command: `node .artifacts/p1/closure.mjs`.
It calls `buildGraph(process.cwd(), { cache: null })`, not a regular-expression
import scan or a stale graph cache. It traverses forward **value** edges,
excludes the starting spec, expands directory targets, and separately counts
paths under `packages/*/src` and `examples/*/src`. It also emits value+data and
type-inclusive counts and full value-file sets as scratch JSON. The compact
per-spec results are embedded in Appendix B so the submitted report does not
depend on retaining the scratch artifacts.

Relevant implementation: `script/verify/graph.mjs:17-21, 63-83, 188-211,
227-236`. Workspace `lib` imports map back to their source entries; external
npm module closures are not included. Re-export and mocked-module edges
describe static reach, not proof that every resolved file executes at runtime.

Quoted output:

```text
specs: 294
source150: 120
value150: 120
barrel: 120
widthSelection: 189
top:
interaction/plugin.spec.ts          value=205 source=202 value+data=205 all=240
interaction/commands-plugin.spec.ts value=194 source=189 value+data=194 all=231
interaction/model-commands.spec.ts  value=193 source=189 value+data=193 all=230
vt-snapshot.spec.ts                 value=193 source=189 value+data=193 all=198
e2e.spec.ts                         value=191 source=188 value+data=284 all=289
```

**Confirms T1's broad fan-out** and its 189-spec width selection. The original
121-versus-here-120 large-closure count is not silently treated as identical:
the original closure program was not committed, and this report states its
strict value-source definition. All 120 value closures reaching the core
barrel are also the ones exceeding the 150-source-file threshold. The measured
111.70 s of imports is about 42.5% of plain-1's summed transform+import+test
worker time, consistent with the original import-share observation. Closure
counts alone do not quantify savings from replacing any particular barrel
import (`core/index.ts` is the relevant barrel).

## Item 7: determinism, verdict statistics, and acceptance

### Two full catalog runs in parallel

Two independent disposable snapshots were made from the tracked worktree
files, with its built `lib/` copied into each and dependencies installed
offline from the unchanged lockfile. The CLI commands were run simultaneously,
each with the default four-way internal pool:

```sh
# cwd: .artifacts/p1/parallel-a
P1_GRID_DIR=/home/x/dev/mayfly-audit-part1/.artifacts/p1/grids-A NODE_OPTIONS=--import=/home/x/dev/mayfly-audit-part1/.artifacts/p1/capture.mjs corepack pnpm run scenarios
# cwd: .artifacts/p1/parallel-b, launched at the same time:
P1_GRID_DIR=/home/x/dev/mayfly-audit-part1/.artifacts/p1/grids-B NODE_OPTIONS=--import=/home/x/dev/mayfly-audit-part1/.artifacts/p1/capture.mjs corepack pnpm run scenarios
```

The scratch hook records every `compareGolden` input and returns the original
comparison result unchanged. It is needed because a normal `scenarios` JSON
report stores comparison results rather than the captured grid text.

Inputs: **all 33 golden scenarios, all 34 catalog sizes, 40 checkpoints**.
Trimmed output and byte-hash comparison:

```text
A: scenarios: PASS (34 runs, 75.5 s)
B: scenarios: PASS (34 runs, 75.4 s)
A grids 40 B grids 40
missing A []
missing B []
different []
app-agents/running@80x30.grid
  dee10cf3f08c85f12d09a3367663c1132827d8eaceab613107b7d2435a88ec22 same
app-conversation/end@80x24.grid
  872607275aa4260f7044fb6b5cc5cb58e994887534a2b8799ba2207bde3b2f81 same
```

This **confirms determinism for isolated parallel invocations**, including
their internally overlapping scenarios. References:
`script/scenarios.mjs:118-129`, `script/scenarios/runner.mjs:129-145`,
`script/scenarios/session.mjs:36-70`.
Separate snapshots prevent the two processes from overwriting the same
`.artifacts/verify/scenarios.json` or scenario session directory. It does not
prove that racing two CLIs in one artifact directory is safe; the boot-turn
mutex at `runner.mjs:90-96` is process-local. That latter question was not
promoted to a finding without a reproduction.

The first scratch attempts used a symlinked root `node_modules`. pnpm 11's
dependency check attempted an install and aborted with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; no scenario ran. Only the
audit-created symlinks were removed, and the snapshots were installed
normally with `corepack pnpm --dir <copy> install --offline --frozen-lockfile`.
No policy was disabled and no global config was changed. The successful
retries above, not those aborted attempts, are the determinism evidence.

### Perf verdict statistics

```sh
corepack pnpm run perf -- --against HEAD --runs 3 perf-content
corepack pnpm run perf -- --against HEAD --runs 5 perf-content
corepack pnpm run perf -- --against HEAD --runs 7 perf-content
```

A baseline snapshot of the **same HEAD** was independently built by the
existing perf command, then reused. Both sides run the same 4,000-record
input at 120×40, ten measured scroll inputs and two resizes per boot.
The three commands perform 6, 10, and 14 fresh boots respectively. The earlier
profiled one-run samples are excluded from this stability comparison.

Quoted CLI output for the changing/latency metrics:

```text
runs=3:
  scroll keyP50Ms   7.36 vs 7.16    +2.7%  same
  resize cpuPct    47.5 vs 66      -28%    inconclusive
  resize keyP50Ms 19.37 vs 22.39   -13.5%  same
runs=5:
  scroll keyP50Ms   8.6 vs 7.12    +20.9% same
  resize cpuPct    63.7 vs 59.1     +7.8% same
  resize keyP50Ms 19.16 vs 18.25     +5%   same
runs=7:
  scroll keyP50Ms   8.05 vs 7.08    +13.7% same
  resize cpuPct    63.9 vs 66.8      -4.3% same
  resize keyP50Ms 20.56 vs 17.81    +15.5% same
all three: perf: PASS
```

| Runs/side | Same | Inconclusive | Regressed | Improved | Failures |
| ---: | ---: | ---: | ---: | ---: | ---: |
| 3 | 9 | 1 | 0 | 0 | 0 |
| 5 | 10 | 0 | 0 | 0 | 0 |
| 7 | 10 | 0 | 0 | 0 | 0 |

Each comparison has two spans × five metrics. Scroll frames are always ten,
resize frames always two. Example JSON statistics: five-run scroll latency
`p=0.2791`; seven-run resize latency `p=0.0769`. Large median differences
alone are not a verdict: the existing threshold, noise band, and rank test at
`script/scenarios/stats.mjs:67-77` apply.

**Extends the gate evidence:** these repeated equal-build comparisons
introduced no directional verdict, and the low-sample inconclusive result
settled to same. **Clean-machine verdict stability remains unverified**, in
particular because the pre-seven-run sample included a process using more
than ten cores. Nor does three aggregate comparisons establish a long-run
false-positive rate, or stability for every other catalog perf scenario.
No statistical defect is alleged from these observations.

### Golden accept path, scratch only

A scratch-only catalog entry `p1-throwaway` copied idle's source and boot
checkpoint at 120×40, with no Website shot mapping. From
`.artifacts/p1/golden-scratch`:

```sh
corepack pnpm run scenarios -- p1-throwaway
corepack pnpm run scenarios -- --update p1-throwaway
corepack pnpm run scenarios -- p1-throwaway
```

Actual output:

```text
✗ p1-throwaway 120x40 (1 checkpoints, 7.5 s) — boot new
scenarios: FAIL (1 runs, 7.5 s)                       [expected exit 1]
✓ p1-throwaway 120x40 (1 checkpoints, 7.6 s)
scenarios: PASS (1 runs, 7.6 s), goldens updated      [exit 0]
✓ p1-throwaway 120x40 (1 checkpoints, 7.4 s)
scenarios: PASS (1 runs, 7.4 s)                      [exit 0]
last JSON: passed=true updated=false
           [{"checkpoint":"boot","status":"same","diff":[]}]
scratch golden: 2224 bytes
sha256: 92c001e6917869c155d87fdd5f675e6071ae654fc9942618949733c9f7a910bb
```

**Confirms the ordinary new-golden accept/read path**, implemented at
`script/scenarios.mjs:121-127` and
`script/scenarios/golden.mjs:22-34`. The scratch catalog entry was reverted
and its newly generated golden deleted. `git diff --exit-code --
script/scenarios/golden` and the untracked-file check there were both empty
in the actual worktree. This does not test orphan removal or Website app-shot
repainting; neither is required to accept this unmapped throwaway checkpoint.

## What remains unverified or could not run cleanly

1. An exclusive-machine timing pass. The recorded competing work means no
   precise isolated coverage-cost factor or perf noise guarantee is claimed.
2. `perf --prof` of the **exact** five large stress inputs. Existing catalog
   PTY profiles were obtained, but the CLI does not parameterize those inputs
   and its function summary is broken (P1-01). Direct source CPU profiles
   cover all five, explicitly distinguished above.
3. Cross-process runs sharing one artifact/profile directory, a long-run
   verdict false-positive estimate, every perf scenario at every run count,
   orphan-golden cleanup, and app-shot update coupling were not exercised.
   No unverified suspicion about them is called a finding.
4. Real-world scroll-path churn frequency, a Map-only heap allocation
   measurement, and a lifecycle-safe remedy for P1-03. The experiments prove
   retention and unnecessary work, not an accepted fix.
5. Part 2's deletion checks and static/lifecycle scope were not run, and its
   file was not touched. The owner's eight manual items, F7 live resume,
   and F12 live settings switch remain the owner's work.

Scratch failures/corrections are deliberately retained in Appendix A:
the first F6 fixture incorrectly passed strings instead of line scans;
the first A10 omitted the required turn-end reason; a subsequent A10 fixture
omitted append surface operations, yielding only one entry per turn and was
excluded. The final A10 asserts 3N entries. The first diff-width probe was
cached rather than a reconstruction. Early frame fixtures did not finish the
initial alternate paint; only a step with recorded synchronized output is
used above. None of these scratch errors is a product finding.

## New findings for triage

| ID | Evidence/status | Suggested attention |
| --- | --- | --- |
| **P1-01** | `perf --prof` summary reads the wrong directory level; real profile files exist, parent summary has zero functions. `script/perf.mjs:104, 147`; `script/scenarios/cpuprofile.mjs:20`. | Fix the profiler report before using its absence of hot functions as evidence. |
| **P1-02** | Persistent scroll memory retains historical positional paths (1,000/2,000) with one current scroll; id-only churn retains one. `core/ui-compiler.ts:1731, 2137, 2355-2358, 2555-2578`. | Low-impact retention case; establish product reach and intended lifetime/bound before a change. |
| **P1-03** | Real Cordis components wrappers miss static-leaf compile reuse on every publish; stable-reference scratch control hits it and removes the linear leaf work. `core/surface-renderer.ts:350, 479`; `core/ui-compile-cache.ts:39`. | Measured refresh-work defect; lifecycle/replacement verification is still required for any fix. |

## Appendix A: exact command and pre-run load journal

The wrapper and all reproduction programs are embedded in Appendix C.
Labels identify the raw `.artifacts/p1/<label>.log` files. Start times are UTC;
the shell's setup stamps above use the machine's UTC+08 timezone.
The busiest pre-run process is recorded as CPU-percent / pid / name, not
as proof that it ran for the command's entire duration.

W = worktree root; A/B/G = the parallel-a, parallel-b, golden-scratch copies under `.artifacts/p1/`. Each row ran as `python3 <W>/.artifacts/p1/run.py <label> <command>` in its stated cwd.

| Label / UTC start | Cwd | Pre-run load (1/5/15 min) | Busiest pre-run CPU / pid / name | Wall s / exit | Exact command (after the wrapper) |
| --- | --- | --- | --- | --- | --- |
| `perf-prof` / 14:17:30 | W | 2.10 3.53 3.37 | 32.0% / 2507917 / `ld-linux-x86-64` | 104.475 / 0 | `corepack pnpm run perf -- --against HEAD --runs 1 --prof perf-content perf-stream perf-gallery` |
| `direct-F1` / 14:20:10 | W | 2.54 3.37 3.35 | 21.0% / 1507778 / `MainThread` | 7.285 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs F1 5000 10000` |
| `direct-F2` / 14:20:19 | W | 2.22 3.27 3.32 | 40.0% / 2429802 / `devin` | 6.612 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs F2 6000 12000` |
| `direct-F4` / 14:20:26 | W | 2.12 3.24 3.31 | 18.0% / 459963 / `MainThread` | 2.868 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs F4 4000 8000` |
| `direct-F6` / 14:20:30 | W | 2.03 3.20 3.29 | 14.0% / 459963 / `MainThread` | 0.522 / 1 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs F6 1000000 2000000` |
| `direct-F6-retry` / 14:21:40 | W | 0.98 2.61 3.08 | 101.0% / 2541633 / `ROPgadget` | 2.298 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs F6 1000000 2000000` |
| `direct-A10-retry` / 14:21:43 | W | 0.98 2.61 3.08 | 102.0% / 2541633 / `ROPgadget` | 0.53 / 1 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs A10 1200 2400` |
| `surfaces` / 14:21:45 | W | 1.14 2.61 3.08 | 101.0% / 2541633 / `ROPgadget` | 1.211 / 0 | `node --experimental-transform-types .artifacts/p1/surfaces.mjs 32 64` |
| `surfaces-width` / 14:21:47 | W | 1.14 2.61 3.08 | 102.0% / 2541633 / `ROPgadget` | 1.298 / 0 | `node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/surfaces.mjs 32 64` |
| `direct-A10-final` / 14:22:32 | W | 2.04 2.70 3.09 | 17.0% / 1811 / `dockerd` | 5.372 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs A10 1200 2400` |
| `direct-diff-final` / 14:22:38 | W | 2.04 2.69 3.08 | 23.0% / 1507778 / `MainThread` | 0.557 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs diff 32000 64000` |
| `direct-fifo-final` / 14:22:40 | W | 2.11 2.69 3.08 | 26.0% / 1507778 / `MainThread` | 0.512 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs fifo 4 8 16` |
| `direct-scrolled-final` / 14:22:41 | W | 2.11 2.69 3.08 | 54.0% / 459963 / `MainThread` | 0.752 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs scrolled 1000 2000` |
| `direct-clamps-final` / 14:22:43 | W | 2.11 2.69 3.08 | 20.0% / 1811 / `dockerd` | 0.661 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs clamps 10000 20000` |
| `suite-plain-1` / 14:22:45 | W | 2.26 2.72 3.08 | 25.0% / 1811 / `dockerd` | 37.101 / 0 | `corepack pnpm exec vitest run --maxWorkers=8 --reporter=default --reporter=json --outputFile=.artifacts/p1/plain-1.json` |
| `suite-coverage-1` / 14:23:23 | W | 7.02 3.78 3.42 | 760.0% / 2557441 / `ld239.so` | 50.347 / 0 | `corepack pnpm exec vitest run --maxWorkers=8 --coverage --reporter=default --reporter=json --outputFile=.artifacts/p1/coverage-1.json` |
| `suite-coverage-2` / 14:24:15 | W | 10.46 5.27 3.95 | 13.0% / 459963 / `MainThread` | 45.537 / 0 | `corepack pnpm exec vitest run --maxWorkers=8 --coverage --reporter=default --reporter=json --outputFile=.artifacts/p1/coverage-2.json` |
| `suite-plain-2` / 14:25:01 | W | 9.55 5.76 4.18 | 11.0% / 459963 / `MainThread` | 38.702 / 0 | `corepack pnpm exec vitest run --maxWorkers=8 --reporter=default --reporter=json --outputFile=.artifacts/p1/plain-2.json` |
| `direct-A10-valid` / 14:26:00 | W | 13.17 7.50 4.88 | 41.0% / 1811 / `dockerd` | 6.526 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs A10 1200 2400` |
| `direct-diff-new-widths` / 14:26:08 | W | 12.35 7.42 4.87 | 11.0% / 2262169 / `devin` | 0.576 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs diff 32000 64000` |
| `direct-scrolled-path` / 14:26:10 | W | 11.44 7.31 4.85 | 14.0% / 2262169 / `devin` | 2.2 / 0 | `node --experimental-transform-types --expose-gc .artifacts/p1/repro.mjs scrolled-path 1000 2000` |
| `surfaces-diagnostic` / 14:26:13 | W | 11.44 7.31 4.85 | 7.0% / 2498691 / `devin` | 1.227 / 0 | `node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/surfaces.mjs 32 64` |
| `frame-content` / 14:26:15 | W | 10.69 7.23 4.83 | 12.0% / 459963 / `MainThread` | 11.951 / 0 | `corepack pnpm run frame content` |
| `frame-gallery` / 14:26:28 | W | 9.44 7.07 4.81 | 25.0% / 459963 / `MainThread` | 8.44 / 0 | `corepack pnpm run frame gallery` |
| `frame-approval` / 14:26:38 | W | 8.13 6.87 4.76 | 16.0% / 459963 / `MainThread` | 8.502 / 0 | `corepack pnpm run frame approvals` |
| `scenarios-parallel-A` / 14:27:01 | A | 5.64 6.38 4.66 | 13.0% / 459963 / `MainThread` | 1.235 / 1 | `env P1_GRID_DIR=/home/x/dev/mayfly-audit-part1/.artifacts/p1/grids-A NODE_OPTIONS=--import=/home/x/dev/mayfly-audit-part1/.artifacts/p1/capture.mjs corepack pnpm run scenarios` |
| `scenarios-parallel-B` / 14:27:02 | B | 5.64 6.38 4.66 | 53.0% / 1811 / `dockerd` | 1.217 / 1 | `env P1_GRID_DIR=/home/x/dev/mayfly-audit-part1/.artifacts/p1/grids-B NODE_OPTIONS=--import=/home/x/dev/mayfly-audit-part1/.artifacts/p1/capture.mjs corepack pnpm run scenarios` |
| `scenarios-parallel-A-retry` / 14:28:36 | A | 4.93 6.42 4.87 | 6.0% / 459963 / `MainThread` | 79.841 / 0 | `env P1_GRID_DIR=/home/x/dev/mayfly-audit-part1/.artifacts/p1/grids-A NODE_OPTIONS=--import=/home/x/dev/mayfly-audit-part1/.artifacts/p1/capture.mjs corepack pnpm run scenarios` |
| `scenarios-parallel-B-retry` / 14:28:37 | B | 4.93 6.42 4.87 | 8.0% / 2498691 / `devin` | 79.75 / 0 | `env P1_GRID_DIR=/home/x/dev/mayfly-audit-part1/.artifacts/p1/grids-B NODE_OPTIONS=--import=/home/x/dev/mayfly-audit-part1/.artifacts/p1/capture.mjs corepack pnpm run scenarios` |
| `surfaces-identity` / 14:30:11 | W | 2.87 5.41 4.66 | 12.0% / 459963 / `MainThread` | 1.2 / 0 | `node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/surfaces.mjs 32 64` |
| `surfaces-captured` / 14:30:13 | W | 2.87 5.41 4.66 | 5.0% / 5234 / `herdr` | 1.107 / 0 | `env P1_CAPTURE_COMPONENTS=1 node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/surfaces.mjs 32 64` |
| `perf-runs-3` / 14:30:15 | W | 2.80 5.35 4.65 | 13.0% / 459963 / `MainThread` | 61.291 / 0 | `corepack pnpm run perf -- --against HEAD --runs 3 perf-content` |
| `perf-runs-5` / 14:31:17 | W | 1.29 4.44 4.38 | 38.0% / 2638806 / `python3` | 101.732 / 0 | `corepack pnpm run perf -- --against HEAD --runs 5 perf-content` |
| `perf-runs-7` / 14:33:00 | W | 4.98 5.17 4.67 | 1068.0% / 2644045 / `ld239.so` | 139.864 / 0 | `corepack pnpm run perf -- --against HEAD --runs 7 perf-content` |
| `clamp-real-frames` / 14:36:14 | W | 2.25 4.14 4.39 | 9.0% / 459963 / `MainThread` | 0.515 / 0 | `node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/clamp-frame.mjs 1000 2000` |
| `frame-content-doubled` / 14:36:16 | W | 2.25 4.14 4.39 | 44.0% / 2652401 / `kimi` | 12.061 / 0 | `env P1_CONTENT_RECORDS=8000 NODE_OPTIONS=--import=/home/x/dev/mayfly-audit-part1/.artifacts/p1/fixture-hook.mjs corepack pnpm run frame content` |
| `clamp-real-frames-clock` / 14:37:25 | W | 3.45 4.33 4.45 | 14.0% / 450835 / `MainThread` | 0.499 / 0 | `node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/clamp-frame.mjs 1000 2000` |
| `surfaces-final` / 14:37:27 | W | 3.45 4.33 4.45 | 8.0% / 450835 / `MainThread` | 1.088 / 0 | `node --experimental-transform-types .artifacts/p1/surfaces.mjs 32 64` |
| `surfaces-final-diagnostic` / 14:37:29 | W | 4.45 4.52 4.51 | 16.0% / 450835 / `MainThread` | 1.165 / 0 | `node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/surfaces.mjs 32 64` |
| `surfaces-final-control` / 14:37:31 | W | 4.45 4.52 4.51 | 28.0% / 2678390 / `python3` | 1.215 / 0 | `env P1_CAPTURE_COMPONENTS=1 node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/surfaces.mjs 32 64` |
| `clamp-painted-frames` / 14:39:21 | W | 10.29 5.49 4.80 | 134.0% / 2701607 / `rustc` | 0.947 / 0 | `node --experimental-transform-types --import=./.artifacts/p1/width-hook.mjs .artifacts/p1/clamp-frame.mjs 1000 2000` |
| `golden-missing` / 14:39:51 | G | 9.62 5.86 4.95 | 101.0% / 2690529 / `rustc` | 11.487 / 1 | `corepack pnpm run scenarios -- p1-throwaway` |
| `golden-update` / 14:40:04 | G | 7.78 5.64 4.89 | 101.0% / 2690529 / `rustc` | 10.327 / 0 | `corepack pnpm run scenarios -- --update p1-throwaway` |
| `golden-accepted` / 14:40:15 | G | 7.21 5.58 4.88 | 100.0% / 2690529 / `rustc` | 10.097 / 0 | `corepack pnpm run scenarios -- p1-throwaway` |

The wrapper records one pre-run CPU sample and launches `/usr/bin/time -f "TIME wall=%e user=%U sys=%S rssKB=%M" <command>`. It does not reserve CPUs or suppress background processes.

## Appendix B: per-spec import-closure report

Each row is one spec, excluded from its own closure. `V` is the number of
repository files reached through value edges, `S` the source-file subset;
`B` indicates reaching `packages/mayfly/src/core/index.ts`. Type-only and
data edges are excluded from these columns. Appendix C's generator emits
the additional closures and the actual member file lists.

Prefixes: `M/` = `packages/mayfly/tests/`; `U/` = `packages/ui/tests/`; `C/` = `packages/cli/tests/`; `E/` = `examples/`. B is 1 when the value closure reaches the core barrel.

| Spec | V | S | B |
| --- | ---: | ---: | ---: |
| `E/mayfly-user-kit/tests/ecosystem.spec.ts` | 25 | 24 | 0 |
| `E/mayfly-user-kit/tests/width-scan.spec.ts` | 84 | 83 | 0 |
| `E/overlay/tests/interaction.spec.ts` | 155 | 154 | 1 |
| `E/ui-gallery/tests/interaction.spec.ts` | 18 | 18 | 0 |
| `E/ui-gallery/tests/prompt.spec.ts` | 18 | 18 | 0 |
| `E/ui-gallery/tests/views.spec.ts` | 18 | 18 | 0 |
| `C/calibrate.spec.ts` | 4 | 3 | 0 |
| `C/internals.spec.ts` | 2 | 1 | 0 |
| `C/main.spec.ts` | 6 | 5 | 0 |
| `C/runtime-lock.spec.ts` | 2 | 1 | 0 |
| `C/runtime.spec.ts` | 5 | 4 | 0 |
| `C/translate.spec.ts` | 1 | 1 | 0 |
| `M/app/agent-interrupt.spec.ts` | 1 | 1 | 0 |
| `M/app/app.spec.ts` | 8 | 8 | 0 |
| `M/app/exit-epitaph.spec.ts` | 2 | 2 | 0 |
| `M/app/invariant.spec.ts` | 1 | 1 | 0 |
| `M/app/request-lifecycle.spec.ts` | 1 | 1 | 0 |
| `M/app/retraction.spec.ts` | 2 | 2 | 0 |
| `M/app/startup.spec.ts` | 2 | 1 | 0 |
| `M/bundle.spec.ts` | 163 | 163 | 1 |
| `M/conversation/activity-detail.spec.ts` | 1 | 1 | 0 |
| `M/conversation/admission.spec.ts` | 6 | 6 | 0 |
| `M/conversation/facts.spec.ts` | 9 | 9 | 0 |
| `M/conversation/invariant.spec.ts` | 1 | 1 | 0 |
| `M/conversation/live-stream.spec.ts` | 73 | 70 | 0 |
| `M/conversation/projection.spec.ts` | 9 | 9 | 0 |
| `M/conversation/stream-accumulator.spec.ts` | 2 | 2 | 0 |
| `M/core/business-rendering-drift.spec.ts` | 0 | 0 | 0 |
| `M/core/chart-renderer.spec.ts` | 6 | 6 | 0 |
| `M/core/chrome.spec.ts` | 4 | 4 | 0 |
| `M/core/components.spec.ts` | 63 | 61 | 0 |
| `M/core/content-rows.spec.ts` | 21 | 21 | 0 |
| `M/core/content-segments.spec.ts` | 3 | 3 | 0 |
| `M/core/context-hint-locale.spec.ts` | 4 | 4 | 0 |
| `M/core/diff-align.spec.ts` | 2 | 2 | 0 |
| `M/core/frame-clamp.spec.ts` | 3 | 2 | 0 |
| `M/core/glyphs.spec.ts` | 3 | 3 | 0 |
| `M/core/gutter.spec.ts` | 5 | 5 | 0 |
| `M/core/highlight.spec.ts` | 1 | 1 | 0 |
| `M/core/invariant.spec.ts` | 1 | 1 | 0 |
| `M/core/key-audit.spec.ts` | 181 | 180 | 1 |
| `M/core/key-decoder.spec.ts` | 30 | 29 | 0 |
| `M/core/key-grammar-docs.spec.ts` | 150 | 150 | 1 |
| `M/core/keyboard-boundary.spec.ts` | 0 | 0 | 0 |
| `M/core/keymap.spec.ts` | 2 | 2 | 0 |
| `M/core/markdown-rows.spec.ts` | 20 | 20 | 0 |
| `M/core/node-slot.spec.ts` | 154 | 152 | 1 |
| `M/core/output-recovery.spec.ts` | 1 | 1 | 0 |
| `M/core/overlay-arm.spec.ts` | 155 | 153 | 1 |
| `M/core/plugin-surface-bridge-overlay.spec.ts` | 155 | 153 | 1 |
| `M/core/plugin-surface-bridge-pane.spec.ts` | 154 | 153 | 1 |
| `M/core/plugin-view.spec.ts` | 21 | 20 | 0 |
| `M/core/plugin.spec.ts` | 154 | 153 | 1 |
| `M/core/presentation.spec.ts` | 6 | 6 | 0 |
| `M/core/rich-document-limits.spec.ts` | 1 | 1 | 0 |
| `M/core/rich-document.spec.ts` | 2 | 2 | 0 |
| `M/core/screen.spec.ts` | 69 | 67 | 0 |
| `M/core/search-input.spec.ts` | 162 | 159 | 1 |
| `M/core/surface-manager.spec.ts` | 24 | 24 | 0 |
| `M/core/terminal-escape.spec.ts` | 1 | 1 | 0 |
| `M/core/terminal-info.spec.ts` | 1 | 1 | 0 |
| `M/core/terminal.spec.ts` | 65 | 64 | 0 |
| `M/core/theme-auto.spec.ts` | 8 | 8 | 0 |
| `M/core/theme-contrast.spec.ts` | 8 | 8 | 0 |
| `M/core/theme-custom.spec.ts` | 150 | 150 | 1 |
| `M/core/theme-dark.spec.ts` | 150 | 150 | 1 |
| `M/core/theme-light.spec.ts` | 5 | 5 | 0 |
| `M/core/theme-ocean.spec.ts` | 5 | 5 | 0 |
| `M/core/theme-paper.spec.ts` | 5 | 5 | 0 |
| `M/core/ui-actions.spec.ts` | 155 | 152 | 1 |
| `M/core/ui-admission-cache.spec.ts` | 11 | 11 | 0 |
| `M/core/ui-admission.spec.ts` | 56 | 55 | 0 |
| `M/core/ui-compile-cache.spec.ts` | 57 | 57 | 0 |
| `M/core/ui-compiler-content.spec.ts` | 63 | 60 | 0 |
| `M/core/ui-compiler.spec.ts` | 58 | 57 | 0 |
| `M/core/ui-content-cache.spec.ts` | 1 | 1 | 0 |
| `M/core/ui-content-painters.spec.ts` | 32 | 31 | 0 |
| `M/core/ui-focus-change.spec.ts` | 63 | 60 | 0 |
| `M/core/ui-focus-levels.spec.ts` | 1 | 1 | 0 |
| `M/core/ui-form-keys.spec.ts` | 58 | 57 | 0 |
| `M/core/ui-form-paint.spec.ts` | 2 | 2 | 0 |
| `M/core/ui-image.spec.ts` | 160 | 158 | 1 |
| `M/core/ui-interaction-admission.spec.ts` | 11 | 11 | 0 |
| `M/core/ui-interaction-choice.spec.ts` | 16 | 15 | 0 |
| `M/core/ui-interaction-document.spec.ts` | 28 | 28 | 0 |
| `M/core/ui-interaction-form.spec.ts` | 17 | 17 | 0 |
| `M/core/ui-interaction-notifications.spec.ts` | 37 | 37 | 0 |
| `M/core/ui-interaction-prompt.spec.ts` | 12 | 12 | 0 |
| `M/core/ui-interaction-renderer.spec.ts` | 154 | 153 | 1 |
| `M/core/ui-interaction-state.spec.ts` | 153 | 153 | 1 |
| `M/core/ui-interaction-tree.spec.ts` | 12 | 12 | 0 |
| `M/core/ui-key-grammar.spec.ts` | 2 | 2 | 0 |
| `M/core/ui-list-keys.spec.ts` | 63 | 60 | 0 |
| `M/core/ui-list-paint.spec.ts` | 21 | 21 | 0 |
| `M/core/ui-list-segment.spec.ts` | 63 | 60 | 0 |
| `M/core/ui-list-selection.spec.ts` | 63 | 60 | 0 |
| `M/core/ui-loader-animation.spec.ts` | 4 | 4 | 0 |
| `M/core/ui-patterns.spec.ts` | 21 | 21 | 0 |
| `M/core/ui-presentation.spec.ts` | 63 | 60 | 0 |
| `M/core/ui-prompt-editor.spec.ts` | 70 | 65 | 0 |
| `M/core/ui-prompt-keys.spec.ts` | 63 | 60 | 0 |
| `M/core/ui-prompt.spec.ts` | 56 | 55 | 0 |
| `M/core/ui-retained.spec.ts` | 63 | 60 | 0 |
| `M/core/ui-row-cache.spec.ts` | 21 | 21 | 0 |
| `M/core/ui-row-pipes.spec.ts` | 7 | 7 | 0 |
| `M/core/ui-rows.spec.ts` | 1 | 1 | 0 |
| `M/core/ui-stacks.spec.ts` | 3 | 3 | 0 |
| `M/core/ui-tabs-keys.spec.ts` | 63 | 60 | 0 |
| `M/core/ui-tabs-paint.spec.ts` | 8 | 8 | 0 |
| `M/core/ui-validator-content.spec.ts` | 11 | 11 | 0 |
| `M/core/ui-validator-form.spec.ts` | 11 | 11 | 0 |
| `M/core/ui-validator-prompt.spec.ts` | 11 | 11 | 0 |
| `M/core/ui-validator-tabs.spec.ts` | 11 | 11 | 0 |
| `M/core/ui-validator.spec.ts` | 11 | 11 | 0 |
| `M/core/ui-work-counters.spec.ts` | 63 | 60 | 0 |
| `M/core/views-lane-renderer.spec.ts` | 154 | 153 | 1 |
| `M/core/views-lane.spec.ts` | 23 | 23 | 0 |
| `M/core/width-estimate.spec.ts` | 3 | 2 | 0 |
| `M/core/width-scan-content.spec.ts` | 56 | 55 | 0 |
| `M/core/width-scan-patterns.spec.ts` | 56 | 55 | 0 |
| `M/core/width-scan-tabs.spec.ts` | 56 | 55 | 0 |
| `M/core/width-scan.spec.ts` | 68 | 64 | 0 |
| `M/core/width.spec.ts` | 1 | 1 | 0 |
| `M/core/window-controller.spec.ts` | 1 | 1 | 0 |
| `M/core/wrapping-select-list.spec.ts` | 22 | 22 | 0 |
| `M/design/probe.spec.ts` | 63 | 60 | 0 |
| `M/design/scene-02-actions.spec.ts` | 156 | 152 | 1 |
| `M/design/scene-03-forms.spec.ts` | 65 | 60 | 0 |
| `M/design/scene-05-lists.spec.ts` | 65 | 60 | 0 |
| `M/design/scene-06-tabs.spec.ts` | 65 | 60 | 0 |
| `M/design/scene-07-surfaces.spec.ts` | 64 | 60 | 0 |
| `M/design/scene-08-content.spec.ts` | 69 | 65 | 0 |
| `M/design/scene-09-feedback.spec.ts` | 64 | 60 | 0 |
| `M/design/scene-10-layout.spec.ts` | 64 | 60 | 0 |
| `M/design/scene-11-patterns.spec.ts` | 65 | 60 | 0 |
| `M/design/scene-13-views.spec.ts` | 158 | 154 | 1 |
| `M/design/scene-15-editor.spec.ts` | 65 | 60 | 0 |
| `M/design/visual-language.spec.ts` | 63 | 60 | 0 |
| `M/e2e.spec.ts` | 191 | 188 | 1 |
| `M/frontend/architecture-boundary.spec.ts` | 150 | 150 | 1 |
| `M/frontend/assistant-stream.spec.ts` | 6 | 6 | 0 |
| `M/frontend/invariant.spec.ts` | 1 | 1 | 0 |
| `M/frontend/locale.spec.ts` | 1 | 1 | 0 |
| `M/frontend/models.spec.ts` | 1 | 1 | 0 |
| `M/frontend/theme.spec.ts` | 1 | 1 | 0 |
| `M/interaction/agents-command.spec.ts` | 169 | 164 | 1 |
| `M/interaction/approval-plugin.spec.ts` | 165 | 161 | 1 |
| `M/interaction/attachments.spec.ts` | 161 | 158 | 1 |
| `M/interaction/authorization-ui.spec.ts` | 155 | 153 | 1 |
| `M/interaction/btw-command.spec.ts` | 76 | 72 | 0 |
| `M/interaction/changelog-content.spec.ts` | 2 | 2 | 0 |
| `M/interaction/clipboard-runner.spec.ts` | 2 | 2 | 0 |
| `M/interaction/clipboard-write.spec.ts` | 151 | 150 | 1 |
| `M/interaction/command-meta.spec.ts` | 1 | 1 | 0 |
| `M/interaction/command-registration.spec.ts` | 190 | 188 | 1 |
| `M/interaction/commands-plugin.spec.ts` | 194 | 189 | 1 |
| `M/interaction/conversation-view-status.spec.ts` | 162 | 160 | 1 |
| `M/interaction/deliverables-command.spec.ts` | 168 | 162 | 1 |
| `M/interaction/draft-stash.spec.ts` | 169 | 167 | 1 |
| `M/interaction/editor-extension-runtime.spec.ts` | 161 | 159 | 1 |
| `M/interaction/editor-instance.spec.ts` | 2 | 2 | 0 |
| `M/interaction/editor-plus.spec.ts` | 170 | 167 | 1 |
| `M/interaction/external-editor.spec.ts` | 156 | 154 | 1 |
| `M/interaction/file-mention.spec.ts` | 4 | 3 | 0 |
| `M/interaction/help.spec.ts` | 151 | 151 | 1 |
| `M/interaction/input-plugin.spec.ts` | 175 | 171 | 1 |
| `M/interaction/invariant.spec.ts` | 1 | 1 | 0 |
| `M/interaction/jobs.spec.ts` | 168 | 162 | 1 |
| `M/interaction/keys.spec.ts` | 155 | 155 | 1 |
| `M/interaction/locale.spec.ts` | 150 | 150 | 1 |
| `M/interaction/mcp-commands.spec.ts` | 167 | 161 | 1 |
| `M/interaction/mcp-resources.spec.ts` | 167 | 161 | 1 |
| `M/interaction/mcp-servers.spec.ts` | 1 | 1 | 0 |
| `M/interaction/mode-commands.spec.ts` | 161 | 159 | 1 |
| `M/interaction/mode-status.spec.ts` | 163 | 160 | 1 |
| `M/interaction/model-commands.spec.ts` | 193 | 189 | 1 |
| `M/interaction/model-picker-model.spec.ts` | 1 | 1 | 0 |
| `M/interaction/model-selection-ui.spec.ts` | 157 | 155 | 1 |
| `M/interaction/models-dev.spec.ts` | 154 | 154 | 1 |
| `M/interaction/native-features.spec.ts` | 169 | 162 | 1 |
| `M/interaction/native-sessions.spec.ts` | 174 | 167 | 1 |
| `M/interaction/pane-queue.spec.ts` | 161 | 159 | 1 |
| `M/interaction/paste-image-native.spec.ts` | 4 | 3 | 0 |
| `M/interaction/paste-image.spec.ts` | 162 | 159 | 1 |
| `M/interaction/permission-panel.spec.ts` | 166 | 162 | 1 |
| `M/interaction/plan-document.spec.ts` | 160 | 158 | 1 |
| `M/interaction/plan-review-panel.spec.ts` | 165 | 161 | 1 |
| `M/interaction/platform-command.spec.ts` | 2 | 1 | 0 |
| `M/interaction/plugin-commands.spec.ts` | 173 | 167 | 1 |
| `M/interaction/plugin-market.spec.ts` | 5 | 4 | 0 |
| `M/interaction/plugin.spec.ts` | 205 | 202 | 1 |
| `M/interaction/preset-commands.spec.ts` | 166 | 161 | 1 |
| `M/interaction/provider-account.spec.ts` | 155 | 153 | 1 |
| `M/interaction/provider-add.spec.ts` | 155 | 153 | 1 |
| `M/interaction/provider-commands.spec.ts` | 155 | 153 | 1 |
| `M/interaction/provider-edit.spec.ts` | 155 | 153 | 1 |
| `M/interaction/provider-onboarding.spec.ts` | 161 | 159 | 1 |
| `M/interaction/provider-store.spec.ts` | 4 | 3 | 0 |
| `M/interaction/questionnaire.spec.ts` | 165 | 161 | 1 |
| `M/interaction/questions-plugin.spec.ts` | 165 | 161 | 1 |
| `M/interaction/rename-command.spec.ts` | 167 | 162 | 1 |
| `M/interaction/request-overlay.spec.ts` | 165 | 161 | 1 |
| `M/interaction/rewind.spec.ts` | 1 | 1 | 0 |
| `M/interaction/runtime-state.spec.ts` | 154 | 154 | 1 |
| `M/interaction/session-commands.spec.ts` | 167 | 161 | 1 |
| `M/interaction/session-export.spec.ts` | 190 | 187 | 1 |
| `M/interaction/session-init.spec.ts` | 151 | 151 | 1 |
| `M/interaction/session-list-model.spec.ts` | 17 | 16 | 0 |
| `M/interaction/session-list-reads.spec.ts` | 167 | 162 | 1 |
| `M/interaction/session-workspaces-model.spec.ts` | 2 | 2 | 0 |
| `M/interaction/settings-command.spec.ts` | 169 | 161 | 1 |
| `M/interaction/settings-model.spec.ts` | 156 | 153 | 1 |
| `M/interaction/settings.spec.ts` | 155 | 154 | 1 |
| `M/interaction/shell-sanitize.spec.ts` | 1 | 1 | 0 |
| `M/interaction/skills-catalog.spec.ts` | 160 | 158 | 1 |
| `M/interaction/skills-command.spec.ts` | 167 | 161 | 1 |
| `M/interaction/slash-filter.spec.ts` | 161 | 159 | 1 |
| `M/interaction/subagent-reply.spec.ts` | 168 | 162 | 1 |
| `M/interaction/terminal-title.spec.ts` | 161 | 159 | 1 |
| `M/interaction/theme-switch.spec.ts` | 191 | 188 | 1 |
| `M/interaction/tools-commands.spec.ts` | 167 | 161 | 1 |
| `M/interaction/trace-aggregate.spec.ts` | 2 | 2 | 0 |
| `M/interaction/trace-command.spec.ts` | 168 | 164 | 1 |
| `M/interaction/trace-format.spec.ts` | 1 | 1 | 0 |
| `M/interaction/ui-overlay.spec.ts` | 5 | 5 | 0 |
| `M/interaction/update-command.spec.ts` | 175 | 169 | 1 |
| `M/interaction/updater-check.spec.ts` | 168 | 164 | 1 |
| `M/interaction/updater-io.spec.ts` | 2 | 1 | 0 |
| `M/interaction/updater-preflight.spec.ts` | 153 | 153 | 1 |
| `M/interaction/updater-profile.spec.ts` | 4 | 3 | 0 |
| `M/interaction/updater-registry.spec.ts` | 2 | 2 | 0 |
| `M/interaction/updater-swap.spec.ts` | 155 | 153 | 1 |
| `M/interaction/updater-version.spec.ts` | 1 | 1 | 0 |
| `M/interaction/usage.spec.ts` | 8 | 8 | 0 |
| `M/interaction/welcome.spec.ts` | 159 | 157 | 1 |
| `M/interaction/width-scan.spec.ts` | 179 | 169 | 1 |
| `M/locale-catalog.spec.ts` | 154 | 153 | 1 |
| `M/perf/work-budget.spec.ts` | 166 | 160 | 1 |
| `M/presets.spec.ts` | 0 | 0 | 0 |
| `M/schedule-preset.spec.ts` | 1 | 0 | 0 |
| `M/transcript/agent-presentation.spec.ts` | 1 | 1 | 0 |
| `M/transcript/banner-art.spec.ts` | 1 | 1 | 0 |
| `M/transcript/banner.spec.ts` | 161 | 158 | 1 |
| `M/transcript/child-agent-model.spec.ts` | 2 | 1 | 0 |
| `M/transcript/command-group.spec.ts` | 153 | 152 | 1 |
| `M/transcript/compaction.spec.ts` | 176 | 172 | 1 |
| `M/transcript/components.spec.ts` | 158 | 157 | 1 |
| `M/transcript/conversation-feed.spec.ts` | 171 | 171 | 1 |
| `M/transcript/conversation-slots.spec.ts` | 12 | 12 | 0 |
| `M/transcript/envelope.spec.ts` | 2 | 2 | 0 |
| `M/transcript/flow-scenarios.spec.ts` | 177 | 174 | 1 |
| `M/transcript/fold-defaults.spec.ts` | 1 | 1 | 0 |
| `M/transcript/hints.spec.ts` | 2 | 2 | 0 |
| `M/transcript/invariant.spec.ts` | 1 | 1 | 0 |
| `M/transcript/live-overlay.spec.ts` | 177 | 174 | 1 |
| `M/transcript/live-rendering.spec.ts` | 177 | 174 | 1 |
| `M/transcript/locale.spec.ts` | 153 | 153 | 1 |
| `M/transcript/official-model-native.spec.ts` | 171 | 171 | 1 |
| `M/transcript/official-model.spec.ts` | 171 | 171 | 1 |
| `M/transcript/output-progress.spec.ts` | 184 | 179 | 1 |
| `M/transcript/pane-activity.spec.ts` | 169 | 165 | 1 |
| `M/transcript/pane-agents.spec.ts` | 165 | 161 | 1 |
| `M/transcript/pane-todo.spec.ts` | 163 | 159 | 1 |
| `M/transcript/pane-workflow.spec.ts` | 162 | 158 | 1 |
| `M/transcript/plugin.spec.ts` | 184 | 179 | 1 |
| `M/transcript/present.spec.ts` | 1 | 1 | 0 |
| `M/transcript/process-activity.spec.ts` | 153 | 153 | 1 |
| `M/transcript/process-groups.spec.ts` | 8 | 7 | 0 |
| `M/transcript/process-rows.spec.ts` | 159 | 156 | 1 |
| `M/transcript/read-group.spec.ts` | 153 | 152 | 1 |
| `M/transcript/search-group.spec.ts` | 153 | 152 | 1 |
| `M/transcript/session-facts.spec.ts` | 11 | 11 | 0 |
| `M/transcript/status-basic.spec.ts` | 73 | 70 | 0 |
| `M/transcript/status-context.spec.ts` | 73 | 70 | 0 |
| `M/transcript/status-cwd.spec.ts` | 74 | 71 | 0 |
| `M/transcript/status-git.spec.ts` | 74 | 70 | 0 |
| `M/transcript/status-goal.spec.ts` | 160 | 157 | 1 |
| `M/transcript/status-jobs.spec.ts` | 160 | 157 | 1 |
| `M/transcript/status-model.spec.ts` | 157 | 154 | 1 |
| `M/transcript/status-tips.spec.ts` | 2 | 2 | 0 |
| `M/transcript/thinking.spec.ts` | 161 | 160 | 1 |
| `M/transcript/tool-line.spec.ts` | 162 | 159 | 1 |
| `M/transcript/tool-model.spec.ts` | 161 | 158 | 1 |
| `M/transcript/transcript-model.spec.ts` | 175 | 172 | 1 |
| `M/transcript/version.spec.ts` | 154 | 154 | 1 |
| `M/transcript/width-scan.spec.ts` | 192 | 187 | 1 |
| `M/vt-snapshot.spec.ts` | 193 | 189 | 1 |
| `U/interaction-provider.spec.ts` | 4 | 4 | 0 |
| `U/patterns.spec.ts` | 3 | 3 | 0 |
| `U/provider.spec.ts` | 4 | 4 | 0 |
| `U/published.spec.ts` | 0 | 0 | 0 |
| `U/types.spec.ts` | 0 | 0 | 0 |
| `U/ui.spec.ts` | 3 | 3 | 0 |
| `U/views.spec.ts` | 6 | 6 | 0 |

## Appendix C: reproduction programs and analysis commands

Create the files below under ignored `.artifacts/p1/` in a fresh built
worktree; the commands in Appendix A are then directly runnable. These are
audit scratch programs, not additions to the product, test suite, or gate.
They contain no proposed product fix.

### `.artifacts/p1/run.py`

```python
import datetime
import json
import os
from pathlib import Path
import subprocess
import sys
import time

root = Path(__file__).resolve().parents[2]
out = root / '.artifacts/p1'
label, *command = sys.argv[1:]
def ticks():
    result = {}
    for entry in Path('/proc').iterdir():
        if not entry.name.isdecimal():
            continue
        try:
            text = (entry / 'stat').read_text()
            fields = text[text.rindex(')') + 2:].split()
            result[int(entry.name)] = (int(fields[11]) + int(fields[12]), (entry / 'comm').read_text().strip())
        except (OSError, ValueError, IndexError):
            pass
    return result

first = ticks()
time.sleep(1)
second = ticks()
hz = os.sysconf('SC_CLK_TCK')
active = sorted([(round((v[0] - first[p][0]) * 100 / hz, 1), p, v[1]) for p, v in second.items() if p in first], reverse=True)[:10]
record = dict(label=label, start=datetime.datetime.now(datetime.timezone.utc).isoformat(), command=command,
              cwd=os.getcwd(), load=Path('/proc/loadavg').read_text().strip(), active=active)
print(json.dumps(record), flush=True)
start = time.monotonic()
with (out / f'{label}.log').open('w') as log:
    result = subprocess.run(['/usr/bin/time', '-f', 'TIME wall=%e user=%U sys=%S rssKB=%M', *command], stdout=log, stderr=subprocess.STDOUT)
record.update(wallSeconds=round(time.monotonic()-start, 3), exit=result.returncode)
with (out / 'runs.jsonl').open('a') as log:
    log.write(json.dumps(record) + '\n')
print(json.dumps(record), flush=True)
print('\n'.join((out / f'{label}.log').read_text(errors='replace').splitlines()[-25:]))
sys.exit(result.returncode)
```

### `.artifacts/p1/repro.mjs`

```js
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { Session } from 'node:inspector'
import { writeFileSync } from 'node:fs'
import { ui } from '../../packages/ui/lib/index.js'
import { contentNodeSource } from '../../packages/mayfly/src/core/content-rows.ts'
import { MayflyContentCache } from '../../packages/mayfly/src/core/ui-content-cache.ts'
import { UiRowCache } from '../../packages/mayfly/src/core/ui-row-cache.ts'
import { MayflyUiSurfaceRuntime, compileMayflyUiSurfaceNode } from '../../packages/mayfly/src/core/ui-compiler.ts'
import { createWorkCounters } from '../../packages/mayfly/src/core/ui-work-counters.ts'
import { scanMarkdown, markdownBlockRows, markdownTheme } from '../../packages/mayfly/src/core/markdown-rows.ts'
import { sanitizePluginText } from '../../packages/mayfly/src/core/plugin-view.ts'
import { validateMayflyUiNode } from '../../packages/mayfly/src/core/ui-validator.ts'
import { remapDocumentOffset } from '../../packages/mayfly/src/core/ui-interaction-document.ts'
import { indexMergedLines, scanContentLines } from '../../packages/mayfly/src/core/content-segments.ts'
import { foldConversationProjection, initialConversationState } from '../../packages/mayfly/src/conversation/projection.ts'
import { visibleWidth, wrapTextWithAnsi, truncateToWidth } from '../../packages/mayfly/src/core/width.ts'
import { clampFrame, clampFrameFrom } from '../../packages/mayfly/src/core/frame-clamp.ts'
import { selfTimes, topFunctions } from '../../script/scenarios/cpuprofile.mjs'

const require = createRequire(new URL('../../packages/mayfly/package.json', import.meta.url))
const { Marked } = await import(require.resolve('marked'))
const colors = new Proxy({}, { get: () => value => value })
const components = { visibleWidth, wrapText: wrapTextWithAnsi, truncateToWidth }
const counters = createWorkCounters()
const env = { components, colors, counters, cache: new MayflyContentCache(), bounded: false, viewportRows: () => 40, elide: n => `${n} more`, errorRows: s => [s] }
const mode = process.argv[2]
const sizes = process.argv.slice(3).map(Number)
const result = []
const ms = (fn, count = 7) => {
  fn()
  const values = []
  let output
  for (let i = 0; i < count; i++) {
    const at = performance.now()
    output = fn()
    values.push(performance.now() - at)
  }
  values.sort((a,b) => a-b)
  return { medianMs: +values[Math.floor(values.length/2)].toFixed(3), minMs: +values[0].toFixed(3), maxMs: +values.at(-1).toFixed(3), output }
}
const profile = async (id, fn) => {
  const session = new Session()
  session.connect()
  const post = (name, options) => new Promise((resolve, reject) => session.post(name, options, (error, value) => error ? reject(error) : resolve(value)))
  await post('Profiler.enable')
  await post('Profiler.start')
  const at = performance.now()
  let repetitions = 0
  do { fn(); repetitions++ } while (performance.now() - at < 750)
  const { profile: data } = await post('Profiler.stop')
  const dir = new URL(`./direct-${id}/`, import.meta.url)
  const { mkdirSync } = await import('node:fs')
  mkdirSync(dir, { recursive: true })
  writeFileSync(new URL('sample.cpuprofile', dir), JSON.stringify(data))
  session.disconnect()
  return { repetitions, top: topFunctions(selfTimes(dir.pathname), undefined, 8) }
}
const histories = count => {
  const events = []
  const push = (type, data) => events.push({ type, data, seq: events.length, time: 1700000000000+events.length, ...['user/message','assistant/message','tool/result'].includes(type)?{surfaceOp:'append'}:{} })
  for (let turn=0; turn<count; turn++) {
    push('turn/start',{turn})
    push('user/message',{id:`u${turn}`,role:'user',content:[{type:'text',text:'hello'}],source:{kind:'user'}})
    push('step/start',{turn,step:0})
    push('assistant/message',{turn,step:0,stream:[],message:{id:`a${turn}`,role:'assistant',content:[{type:'text',text:'answer'}],source:{kind:'model',provider:'mock',model:'mock'}}})
    push('tool/call',{turn,step:0,callId:`c${turn}`,name:'read',arguments:'{"path":"a"}'})
    push('tool/result',{turn,step:0,message:{id:`r${turn}`,role:'tool',toolCallId:`c${turn}`,isError:false,content:[{type:'text',text:'line'}],source:{kind:'tool',callId:`c${turn}`}}})
    push('turn/end',{turn,reason:{kind:'completed'}})
  }
  return events
}

for (const size of sizes) {
  if (mode === 'F1') {
    const text = Array.from({length:size},(_,i)=>`Paragraph ${i} with some words and [a link](http://x/${i}).`).join('\n\n')
    const scan = () => scanMarkdown(text).units.length
    result.push({ size, bytes:text.length, scan:ms(scan,3), lexer:ms(()=>new Marked().lexer(text).length,3), profile:await profile(`F1-${size}`,scan) })
  } else if (mode === 'F2') {
    const text = '\x1b]0;x'.repeat(size)
    const plugin = () => sanitizePluginText(text).length
    const validator = () => validateMayflyUiNode(ui.text(text)).ok
    result.push({ size, bytes:text.length, plugin:ms(plugin,3), validator:ms(validator,3), profile:await profile(`F2-${size}`,()=>{plugin();validator()}) })
  } else if (mode === 'F4') {
    const text = Array.from({length:size},(_,i)=>`## Heading ${i}`).join('\n')
    const scanned = scanMarkdown(text)
    const paint = () => markdownBlockRows(text,scanned.defs,80,markdownTheme(colors),colors.mdHr).length
    result.push({ size, bytes:text.length, units:scanned.units.length, largest:Math.max(...scanned.units.map(u=>u.end-u.start)), paint:ms(paint,3), profile:await profile(`F4-${size}`,paint) })
  } else if (mode === 'F6') {
    const before = ('some job output line\n').repeat(Math.ceil(size/21)).slice(0,size)
    const after = before+'next output\n'
    const chunks = Array.from({length:Math.ceil(size/4096)},(_,i)=>({text:before.slice(i*4096,(i+1)*4096)}))
    const scans = chunks.map(c=>scanContentLines(c.text))
    const remap = () => remapDocumentOffset(before,after,100)
    const join = () => chunks.map(c=>c.text).join('').length
    const index = () => indexMergedLines(scans,before).lines
    result.push({ size, chunks:chunks.length, remap:ms(remap), join:ms(join), index:ms(index), profile:await profile(`F6-${size}`,()=>{remap();join();index()}) })
  } else if (mode === 'A10') {
    const events = histories(size)
    const fold = () => {
      const length=events.reduce(foldConversationProjection,initialConversationState()).entries.length
      if(length!==size*3)throw new Error(`expected ${size*3} entries, got ${length}`)
      return length
    }
    result.push({ size, events:events.length, fold:ms(fold,3), profile:await profile(`A10-${size}`,fold) })
  } else if (mode === 'diff') {
    const after = Array.from({length:size},(_,i)=>`line ${i} ${'x'.repeat(40)}`).join('\n')
    const node = ui.diff('',after)
    contentNodeSource(node,80,env)
    Object.assign(counters,createWorkCounters())
    let width = 80
    const rebuild = () => contentNodeSource(node,++width,env).length
    const rebuilt = ms(rebuild,11)
    const work = {...counters}
    Object.assign(counters,createWorkCounters())
    const source = contentNodeSource(node,60,env)
    source.prepare(0,40)
    for(let i=0;i<40;i++) source.row(i)
    result.push({ size, bytes:after.length, rebuild:rebuilt, rebuildCounters:work, windowCounters:{...counters} })
  } else if (mode === 'fifo') {
    const item = {}
    const cache = new UiRowCache()
    const palette = {}
    let paints = 0
    const read = key => cache.read(palette,item,String(key),()=>{paints++;return 'row'})
    const cycle = ms(()=>{
      paints=0
      for(let pass=0;pass<1000;pass++)for(let key=0;key<size;key++)read(key)
      return paints
    })
    const hotCache = new UiRowCache()
    let hotPaints=0
    const hot = key=>hotCache.read(palette,item,String(key),()=>{hotPaints++;return 'row'})
    for(let k=0;k<8;k++)hot(k)
    for(let k=0;k<100;k++)hot(0)
    hot(8)
    const beforeHot=hotPaints
    hot(0)
    result.push({ size, operations:size*1000, cycle, hotPaintedAfterEviction:hotPaints-beforeHot })
  } else if (mode === 'scrolled' || mode === 'scrolled-path') {
    global.gc()
    const before = process.memoryUsage().heapUsed
    const runtime = new MayflyUiSurfaceRuntime()
    const at=performance.now()
    for(let i=0;i<size;i++) {
      const scroll=ui.scroll(ui.text('one row'),{id:`scroll-${i}`,height:6})
      const node=mode==='scrolled'?scroll:ui.stack.column([
        ...Array.from({length:i%20},()=>ui.spacer()),
        ui.stack.column([...Array.from({length:Math.floor(i/20)},()=>ui.spacer()),scroll]),
      ])
      const compiled=compileMayflyUiSurfaceNode(node,{surfaceRuntime:runtime,components,colors,getViewport:()=>({columns:80,rows:40}),screenMode:'alternate',emit:()=>{},verifyRetained:false})
      if(!compiled.ok)throw new Error(compiled.message)
      compiled.value.component.render(80)
    }
    const elapsed = performance.now()-at
    global.gc()
    const delta=process.memoryUsage().heapUsed-before
    const held=runtime.scrolled.size
    runtime.dispose()
    result.push({ size, elapsedMs:+elapsed.toFixed(3), held, heapDelta:delta, afterDispose:runtime.scrolled.size })
  } else if (mode === 'clamps') {
    const rows=Array.from({length:size},(_,i)=>`${String(i).padStart(6)} ${'x'.repeat(70)}`)
    const changed=rows.slice();changed[changed.length-1]='changed '+ 'x'.repeat(69)
    result.push({ size, bytes:rows.reduce((n,r)=>n+r.length,0), one:ms(()=>clampFrame(rows,80).length), stacked:ms(()=>clampFrame(clampFrame(clampFrame(rows,80),80),80).length), incremental:ms(()=>clampFrameFrom({source:rows,rows},changed,80).length) })
  }
}
console.log(JSON.stringify(result,null,2))
```

### `.artifacts/p1/surfaces.mjs`

```js
import { createRequire } from 'node:module'
import { performance } from 'node:perf_hooks'
import { mock } from 'node:test'
import { ui } from '../../packages/ui/lib/index.js'
import { apply } from '../../packages/ui/lib/provider.js'
import * as frontend from '../../packages/mayfly/src/frontend/index.ts'
import * as theme from '../../packages/mayfly/src/core/theme-dark.ts'
import { startMayflyTerminal } from '../../packages/mayfly/src/core/terminal.ts'
import { MayflyScreenService } from '../../packages/mayfly/src/core/screen.ts'
import { MayflyComponentsService } from '../../packages/mayfly/src/core/components.ts'
import { MayflyKeymapService } from '../../packages/mayfly/src/core/keymap.ts'
import { mountMayflySurfaceRenderer } from '../../packages/mayfly/src/core/surface-renderer.ts'
import { mountContextHintLocale, contextHintTranslator } from '../../packages/mayfly/src/core/context-hint-locale.ts'
import { createWorkCounters } from '../../packages/mayfly/src/core/ui-work-counters.ts'
import { FakeTerminal } from '../../packages/mayfly/tests/core/fake-terminal.ts'

const require=createRequire(new URL('../../packages/mayfly/package.json',import.meta.url))
const {Context}=await import(require.resolve('@deepseek-ai/cordis'))
mock.timers.enable({apis:['setTimeout','setInterval','Date']})
const turns=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>process.nextTick(resolve))}
const frames=async()=>{for(let i=0;i<3;i++){await turns();mock.timers.tick(20)}await turns()}
const outputs=[]
const identities=[]
for(const size of process.argv.slice(2).map(Number))for(const kind of ['pane','overlay']) {
  const ctx=new Context()
  const counters=createWorkCounters()
  await ctx.plugin({name:'p1-ui',apply})
  await ctx.plugin(frontend)
  const terminal=new FakeTerminal(120,40)
  const runtime=await startMayflyTerminal(terminal,()=>Promise.resolve(undefined),undefined,{record:()=>{}},'alternate')
  await ctx.plugin(theme)
  await ctx.plugin({
    name:'p1-core',inject:['mayflyTheme','mayflyUiInteraction'],
    apply(owner) {
      mountContextHintLocale(owner,()=>runtime.requestRender())
      owner.plugin(MayflyKeymapService)
      owner.plugin(MayflyScreenService,runtime)
      owner.plugin(MayflyComponentsService,{theme:owner.mayflyTheme,tui:runtime.tui})
      owner.plugin({name:'p1-renderer',inject:['mayflyUiInteraction','mayflyScreen','mayflyComponents','mayflyTheme','mayflyKeymap'],apply(renderer) {
        identities.push({kind,size,componentsStable:renderer.mayflyComponents===renderer.mayflyComponents,colorsStable:renderer.mayflyTheme.colors===renderer.mayflyTheme.colors})
        const bridge=process.env.P1_CAPTURE_COMPONENTS?{
          effect:renderer.effect.bind(renderer),emit:renderer.emit.bind(renderer),get:renderer.get.bind(renderer),
          mayflyComponents:renderer.mayflyComponents,mayflyKeymap:renderer.mayflyKeymap,
          mayflyScreen:renderer.mayflyScreen,mayflyTheme:renderer.mayflyTheme,mayflyUiInteraction:renderer.mayflyUiInteraction,
        }:renderer
        mountMayflySurfaceRenderer(bridge,runtime,contextHintTranslator(owner),undefined,counters)
      }})
    }
  })
  await frames()
  const children=Array.from({length:size},(_,i)=>ui.text(`Row ${i}: some text that wraps when the lane narrows.`))
  const node=ui.scroll(ui.stack.column(children),{id:'body',height:20,scrollbar:true})
  const handle=kind==='pane'?ctx.mayflyPanes.register({id:'p1',placement:'right',size:{preferred:40},narrow:'bottom'},node):ctx.mayflyOverlays.open({id:'p1',capturing:true},node)
  await frames()
  for(const variant of ['same','one-leaf','all-leaves']) {
    const values=[]
    const counts=[]
    const widths=[]
    const painted=[]
    const caches=[]
    for(let iteration=0;iteration<7;iteration++) {
      const next=variant==='same'?node:ui.scroll(ui.stack.column(children.map((child,i)=>variant==='one-leaf'&&i!==0?child:ui.text(`Row ${i}: changed ${iteration} text that wraps when the lane narrows.`))),{id:'body',height:20,scrollbar:true})
      Object.assign(counters,createWorkCounters())
      globalThis.__p1Width={}
      globalThis.__p1Cache={}
      terminal.written.length=0
      const at=performance.now()
      handle.set(next)
      await frames()
      values.push(performance.now()-at)
      counts.push({...counters})
      widths.push({...globalThis.__p1Width})
      caches.push({...globalThis.__p1Cache})
      painted.push(terminal.written.reduce((n,s)=>n+s.split('\x1b[?2026h').length-1,0))
    }
    const sorted=values.toSorted((a,b)=>a-b)
    outputs.push({kind,size,variant,medianMs:+sorted[3].toFixed(3),minMs:+sorted[0].toFixed(3),maxMs:+sorted[6].toFixed(3),counters:counts,clampMeasurements:widths,cacheResults:caches,frames:painted})
  }
  handle.dispose()
  await frames()
  await runtime.stop()
  await ctx.fiber.dispose()
}
mock.timers.reset()
console.log('IDENTITIES '+JSON.stringify(identities))
console.log(JSON.stringify(outputs,null,2))
```

### `.artifacts/p1/width-hook.mjs`

```js
import { registerHooks } from 'node:module'
const names = ['frame-clamp.ts','content-rows.ts','ui-compiler.ts','ui-compile-cache.ts']
registerHooks({
  load(url,context,next) {
    const result=next(url,context)
    const name = names.find(name=>url.endsWith('/src/core/'+name))
    if(!name)return result
    let source=String(result.source).replace(/(?<![\w.])visibleWidth\(/gu, 'p1Width(')
    if(name==='ui-compile-cache.ts')source=source.replace('const entry = this.entries.get(node)', `const entry = this.entries.get(node)
    const reason = entry === undefined ? 'absent' : entry.pass === this.pass ? 'same-pass' : entry.colors !== options.colors ? 'colors' : entry.components !== options.components ? 'components' : 'hit'
    if(globalThis.__p1Cache) globalThis.__p1Cache[reason] = (globalThis.__p1Cache[reason] ?? 0) + 1`)
    return {...result,source:source+`
function p1Width(...args) {
  const at = performance.now()
  const result = visibleWidth(...args)
  const sink = globalThis.__p1Width
  if(sink) {
    const item = sink[${JSON.stringify(name)}] ??= {calls:0,ms:0}
    item.calls++
    item.ms += performance.now()-at
  }
  return result
}
`}
  }
})
```

### `.artifacts/p1/clamp-frame.mjs`

```js
import { mock } from 'node:test'
import { performance } from 'node:perf_hooks'
import { ui } from '../../packages/ui/lib/index.js'
import { compileMayflyUiNode } from '../../packages/mayfly/src/core/ui-compiler.ts'
import { createWorkCounters } from '../../packages/mayfly/src/core/ui-work-counters.ts'
import { visibleWidth, wrapTextWithAnsi, truncateToWidth } from '../../packages/mayfly/src/core/width.ts'
import { startMayflyTerminal } from '../../packages/mayfly/src/core/terminal.ts'
import { FakeTerminal } from '../../packages/mayfly/tests/core/fake-terminal.ts'
const colors=new Proxy({},{get:()=>x=>x})
const components={visibleWidth,wrapText:wrapTextWithAnsi,truncateToWidth}
mock.timers.enable({apis:['setTimeout','setInterval','Date']})
const turns=async()=>{for(let i=0;i<12;i++)await new Promise(resolve=>process.nextTick(resolve))}
const paint=async()=>{for(let i=0;i<6;i++){await turns();mock.timers.tick(20);await new Promise(resolve=>setImmediate(resolve))}await turns()}
const results=[]
for(const mode of ['main','alternate'])for(const size of process.argv.slice(2).map(Number)) {
  const terminal=new FakeTerminal(120,40)
  const runtime=await startMayflyTerminal(terminal,()=>Promise.resolve(),undefined,{record(){}},mode)
  await paint()
  const counters=createWorkCounters()
  const text=Array.from({length:size},(_,i)=>`row ${i}: ${'x'.repeat(60)}`).join('\n')
  const compiled=compileMayflyUiNode(ui.text(text),{components,colors,counters,screenMode:mode,getViewport:()=>({columns:120,rows:40}),emit:()=>{}})
  if(!compiled.ok)throw new Error(compiled.message)
  globalThis.__p1Width={}
  terminal.written.length=0
  const at=performance.now()
  runtime.addChild(compiled.value.component)
  await paint()
  results.push({mode,size,elapsedMs:+(performance.now()-at).toFixed(3),counters:{...counters},width:{...globalThis.__p1Width},frames:terminal.written.reduce((n,s)=>n+s.split('\x1b[?2026h').length-1,0)})
  globalThis.__p1Width={}
  terminal.written.length=0
  const repeat=performance.now()
  runtime.requestRender()
  await paint()
  results.push({mode,size,repeat:true,elapsedMs:+(performance.now()-repeat).toFixed(3),counters:{...counters},width:{...globalThis.__p1Width},frames:terminal.written.reduce((n,s)=>n+s.split('\x1b[?2026h').length-1,0)})
  await runtime.stop()
}
mock.timers.reset()
console.log(JSON.stringify(results,null,2))
```

### `.artifacts/p1/fixture-hook.mjs`

```js
import { registerHooks } from 'node:module'
registerHooks({
  load(url,context,next) {
    const result=next(url,context)
    if(!url.endsWith('/script/scenarios/replays.mjs'))return result
    const size=Number(process.env.P1_CONTENT_RECORDS)
    if(!Number.isInteger(size)||size<1)throw new Error('P1_CONTENT_RECORDS must be positive')
    const before='const GENERATED_RECORDS = lines(4_000,'
    const source=String(result.source)
    if(!source.includes(before))throw new Error('fixture declaration changed')
    return {...result,source:source.replace(before,`const GENERATED_RECORDS = lines(${size},`)}
  }
})
```

### `.artifacts/p1/capture.mjs`

```js
import { registerHooks } from 'node:module'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const out = process.env.P1_GRID_DIR
if(out)registerHooks({
  load(url,context,next) {
    const result=next(url,context)
    if(!url.endsWith('/script/scenarios/golden.mjs'))return result
    const source=String(result.source).replace('export function compareGolden(', 'function originalCompareGolden(')
    return {...result,source:source+`
export function compareGolden(...args) {
  const folder = ${JSON.stringify(out)} + '/' + args[0]
  mkdirSync(folder, {recursive:true})
  writeFileSync(folder + '/' + args[1] + '@' + args[2] + 'x' + args[3] + '.grid', args[4] + '\\n')
  return originalCompareGolden(...args)
}
`}
  }
})
```

### `.artifacts/p1/closure.mjs`

```js
import { buildGraph, dependents, SPEC_FILE } from '../../script/verify/graph.mjs'
import { writeFileSync } from 'node:fs'
const graph = buildGraph(process.cwd(),{cache:null})
const specs = graph.files.filter(file=>SPEC_FILE.test(file))
const closure = (start,kinds) => {
  const seen = new Set()
  const queue = [start]
  while(queue.length) {
    const file=queue.pop()
    for(const edge of graph.nodes.get(file)?.edges??[]) {
      if(!kinds.includes(edge.kind))continue
      const targets = edge.to.endsWith('/')?graph.files.filter(file=>file.startsWith(edge.to)): [edge.to]
      for(const to of targets)if(!seen.has(to)&&to!==start){seen.add(to);queue.push(to)}
    }
  }
  return [...seen].sort()
}
const rows = specs.map(spec=>{
  const value=closure(spec,['value'])
  const source=value.filter(f=>/^(packages|examples)\/[^/]+\/src\//.test(f))
  const data=closure(spec,['value','data'])
  const all=closure(spec,['value','data','type'])
  return {spec,value:value.length,source:source.length,valueData:data.length,all:all.length,barrel:value.includes('packages/mayfly/src/core/index.ts'),files:value}
})
writeFileSync(new URL('./closures.json',import.meta.url),JSON.stringify(rows,null,2))
writeFileSync(new URL('./closures.tsv',import.meta.url),'spec\tvalue\tsource\tvalue+data\tall\tcoreBarrel\n'+rows.map(r=>[r.spec,r.value,r.source,r.valueData,r.all,r.barrel].join('\t')).join('\n')+'\n')
console.log(JSON.stringify({specs:rows.length,source150:rows.filter(r=>r.source>=150).length,value150:rows.filter(r=>r.value>=150).length,barrel:rows.filter(r=>r.barrel).length,widthSelection:[...dependents(graph,['packages/mayfly/src/core/width.ts']).keys()].filter(f=>SPEC_FILE.test(f)).length,top:rows.toSorted((a,b)=>b.source-a.source).slice(0,10).map(({files,...r})=>r)},null,2))
```

### Snapshot preparation and scratch-golden input

The initial snapshot preparation was run from W with `python3 -` using:

```python
from pathlib import Path
import subprocess, shutil
root = Path.cwd()
files = subprocess.check_output(['git', 'ls-files', '-z']).decode().split('\0')
for name in ['parallel-a', 'parallel-b', 'golden-scratch']:
    target = root / '.artifacts/p1' / name
    target.mkdir()
    for f in files:
        if not f:
            continue
        p = target / f
        p.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(root / f, p)
    for p in list((root / 'packages').iterdir()) + list((root / 'examples').iterdir()):
        if (p / 'lib').exists():
            shutil.copytree(p / 'lib', target / p.relative_to(root) / 'lib')
        if (p / 'node_modules').exists():
            (target / p.relative_to(root) / 'node_modules').symlink_to(p / 'node_modules', target_is_directory=True)
    (target / 'node_modules').symlink_to(root / 'node_modules', target_is_directory=True)
```

Following the pnpm abort, only those newly created dependency symlinks were
unlinked with this `python3 -` input:

```python
from pathlib import Path
for name in ['parallel-a', 'parallel-b', 'golden-scratch']:
    root = Path('.artifacts/p1') / name
    paths = [root / 'node_modules'] + [
        p / 'node_modules' for d in ['packages', 'examples']
        for p in (root / d).iterdir()
    ]
    for p in paths:
        if p.is_symlink():
            p.unlink()
```

Then, serially:

```sh
corepack pnpm --dir .artifacts/p1/parallel-a install --offline --frozen-lockfile
corepack pnpm --dir .artifacts/p1/parallel-b install --offline --frozen-lockfile
corepack pnpm --dir .artifacts/p1/golden-scratch install --offline --frozen-lockfile
```

The recorded pre-install loads were respectively `8.91 7.10 4.96`,
`8.91 7.10 4.96`, and `8.60 7.07 4.96`; pnpm reported 2.1, 1.8, and 1.9 s.
All three copied lockfiles byte-compared equal to W afterward.

The following entry was inserted with `apply_patch` **only inside the
scratch copy's** `CATALOG = Object.freeze({ ... })`:

```js
'p1-throwaway': {
  summary: 'scratch audit of golden acceptance',
  source: { idle: true },
  covers: [],
  sizes: [DEFAULT_SIZE],
  script: [checkpoint('boot')],
},
```

After the three golden commands it was removed with `apply_patch`, along
with the newly created scratch file
`script/scenarios/golden/p1-throwaway/boot@120x40.grid`. The scratch catalog
then byte-compared equal to W; that new golden no longer existed.

### Grid comparison and fresh JSON analysis

The grid comparison was run as `python3 -` from W; only output was redirected
to `.artifacts/p1/grids-compare.log`:

```python
from pathlib import Path
import hashlib
roots = [Path('.artifacts/p1/grids-A'), Path('.artifacts/p1/grids-B')]
maps = [
    {p.relative_to(r).as_posix(): hashlib.sha256(p.read_bytes()).hexdigest()
     for p in r.rglob('*.grid')}
    for r in roots
]
print('A grids', len(maps[0]), 'B grids', len(maps[1]))
print('missing A', sorted(set(maps[1]) - set(maps[0])))
print('missing B', sorted(set(maps[0]) - set(maps[1])))
print('different', sorted(k for k in maps[0].keys() & maps[1].keys()
                          if maps[0][k] != maps[1][k]))
for k in sorted(maps[0]):
    print(k, maps[0][k], 'same' if maps[0][k] == maps[1].get(k) else 'DIFF')
```

Fresh per-spec test timing analysis used the corresponding assertion
durations in the four JSON reports. The earlier inspection selected these
five exact names, with the following computation:

```python
from pathlib import Path
import json
for name in [
    'packages/mayfly/tests/perf/work-budget.spec.ts',
    'packages/mayfly/tests/core/markdown-rows.spec.ts',
    'packages/mayfly/tests/interaction/width-scan.spec.ts',
    'packages/mayfly/tests/interaction/paste-image-native.spec.ts',
    'packages/mayfly/tests/core/width-scan.spec.ts',
]:
    print(name)
    for f in ['plain-1', 'coverage-1', 'coverage-2', 'plain-2']:
        data = json.loads(Path(f'.artifacts/p1/{f}.json').read_text())
        r = next(r for r in data['testResults'] if r['name'].endswith('/' + name))
        print(f, 'spec ms', r['endTime'] - r['startTime'], 'test ms',
              round(sum(t.get('duration', 0) or 0 for t in r['assertionResults']), 1))
```

Perf reports were copied after each command, before the next one overwrote
`.artifacts/verify/perf.json`, using
`cp .artifacts/verify/perf.json .artifacts/p1/perf-runs-<N>.json`.
The verdict aggregation used:

```python
from pathlib import Path
import json, collections
for n in [3, 5, 7]:
    r = json.loads(Path(f'.artifacts/p1/perf-runs-{n}.json').read_text())
    counts = collections.Counter()
    print('runs', n, 'failures', r['failures'])
    for s in r['scenarios']:
        for e in s['judged']:
            for name, v in e['metrics'].items():
                counts[v['verdict']] += 1
                print(e['span'], name, v['head'], v['base'], v['delta'],
                      v['verdict'], 'p', v['p'])
    print('verdicts', dict(counts))
```

### Report-only verification

The report's eight embedded programs were byte-compared with their actual
scratch sources. All 294 table rows were programmatically compared against
the fresh closure JSON; every row matched. No unfinished marker remained.
The scratch golden/catalog changes were confirmed discarded, and the
working tree's source, examples, scripts, and lockfile diff was empty.

The documentation-only gate commands are:

```sh
corepack pnpm run check -- --tier round --base origin/docs/phase-2-audit
corepack pnpm run check -- --tier pr --base origin/docs/phase-2-audit
git diff --check
```

Both final checks passed (`round` and `pr`, 0.1 s each), with one changed
file, zero selected specs and workflow tests (“Nothing to check”).
The pre-check load for both was `4.20 4.14 4.42`. The staged
`git diff --cached --check` was clean as well. These report checks are not
additional runtime performance measurements and do not replace the evidence
above.
