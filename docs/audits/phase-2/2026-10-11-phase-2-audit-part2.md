# Phase 2 pre-review audit, part 2: static reading and dead code

Report date: 2026-10-11. Branch `audit/part2`, from `docs/phase-2-audit` at `c4d711b`. Product sources are those of the
audit baseline `b657469`; the commits since touch only `docs/audits/`. Plan, report and progress report:
[plan](2026-10-11-phase-2-audit-plan.md), [report](2026-10-11-phase-2-audit.md),
[progress](2026-10-11-phase-2-audit-progress.md) ("Parallel split"). This records the state of the repository when it was read
and does not define current behavior. The lead merges it into the audit report.

This part changed no product code. It covers open items 1, 2, 5 and the deletion check of item 6. The deletion check ran on
a scratch copy after the lead's go-ahead.

## Result

New findings (IDs `P2-n`). Severity follows the audit report: P2 is a condition-triggered defect, P3 a lower-priority cost
or consistency issue. "Reproduced" means a script's output is quoted; "traced" means a path read to its effect and not run.

| ID | Sev. | Finding | Evidence | Status |
| --- | --- | --- | --- | --- |
| P2-1 | P2 | `sanitizePluginText` deletes the visible text between two ST-terminated OSC sequences (shell output with hyperlinks loses its labels) | `core/plugin-view.ts:26,31`; `transcript/components.ts:537` | Reproduced |
| P2-2 | P2 | macOS and Windows clipboard-image paste is documented and implemented, but nothing imports the implementation | `interaction/paste-image-native.ts` (353 lines), `paste-image.ts:165-171`, `website/en/features/editor.md:41` | Traced + import-graph scan |
| P2-3 | P3 | The terminal is started before its stop effect is registered; an unload or a throw in between leaves it running | `core/index.ts:159-198` | Traced + model reproduction |
| P2-4 | P3 | The output-recovery guard counts pi-tui's own `process.stdout` writes as ambient output and forces a full repaint | `core/terminal.ts:978-981,1222`; `core/output-recovery.ts:56-73` | Reproduced |
| P2-5 | P3 | `runtime.stop()` called a second time resolves before the terminal is restored; `createTerminalRelease` is unused | `core/terminal.ts:645,1203` | Reproduced (latent) |
| P2-6 | P3 | The comment "the effect stops the terminal last" is wrong: `stop()` starts first and the child plugins unload during its drain | `core/index.ts:151-153,198` | Reproduced on Cordis |
| P2-7 | P3 | Twenty module-level test hooks are mutable singletons; eleven setter bodies are byte-identical | list under P2-7 | Counted |
| P2-8 | P3 | A handled notification expires again after a hide and show | `core/ui-interaction-notifications.ts:116-140,161` | Reproduced |
| P2-9 | P3 | Duplicate implementations found by body comparison (beyond the named helpers) | Appendix B | Counted |
| P2-10 | P3 | Dead production code that only tests call: wrappers, dead functions and data (23 of the 280 test-only exports), plus `createTerminalRelease` and the `SurfaceManager` user-state API | Appendix A rows marked delete | Counted |
| P2-11 | P3 | Three unreferenced scripts and a PTY preamble copied into four smokes | `script/` | Counted |
| P2-12 | P3 | A test title embeds `new Date()`, so its test ID changes on every run | `tests/core/ui-validator.spec.ts:46` | Observed in two runs |

Existing findings this part confirms, refutes or extends:

| ID | Result |
| --- | --- |
| F8 | **Extends.** Traced to the end: queued operations run after the `mayfly-app` Fiber unloads and fail inside `select`; the exit hook is correct by Cordis disposal order. Not a defect at process exit; narrow in a reload. |
| F10 | **Confirms and extends to a defect (P2-1).** The two sanitizers differ, and the weaker one is the only gate on the model's and the tools' text; its greedy OSC arm deletes real text. |
| F2 | **Extends.** The audit-1 fix "keeps the output" of the old regexes, so it keeps P2-1 too (not checked against that branch, which is not on this machine). |
| B4 | **Extends.** 280 test-only exports reviewed one by one: 257 keep, 23 delete (Appendix A). One module is unreachable from every package entry. |
| B5 | **Extends.** Body comparison finds more exact duplicates than the named helpers (Appendix B). |
| B6 | **Supports.** `segmentRows`/`chunkRows` and the two `row` closures in `content-rows.ts` are token-identical (146 and 73 tokens). |
| T2 | **Extends.** The longest spec of the suite (`paste-image-native.spec.ts`, 21.7 s summed) tests a module no production code loads (P2-2). |
| T3, T6, T8 | **Confirmed safe to remove**, with one cost: the branch coverage floor keeps 0.02 points of headroom (item 6). |
| T9 | **Refuted as stated.** Deleting `tests/design` fails 13 spec files; the specs and frames can go, the helper modules cannot, and one script test names a frame (item 6). |

## Scope and method

Commands run, all from the worktree `~/dev/mayfly-audit-part2` unless said otherwise:

```
git fetch origin docs/phase-2-audit
git worktree add ~/dev/mayfly-audit-part2 -b audit/part2 origin/docs/phase-2-audit
# item 1 and 2: read terminal.ts, surface-manager.ts, views-lane.ts, ui-interaction-*.ts, core/index.ts,
#   app/index.ts, app/conversation-views.ts, app/current-agent.ts, app/exit-epitaph.ts, plugin-view.ts, ui-validator.ts;
#   then Cordis (lib/index.js), pi-tui 0.84.2 (tui.js, terminal.js) and dsh 0.2.0-rc.2 (profile-boot) as the code they call
node --experimental-transform-types <repro>.mjs       # repros importing the sources and the pinned packages
# item 5a: exports.mjs (the scan of the first pass, re-run on this tree), then a second scan adding the declaration kind,
#   the own-file uses with comments stripped, and the first test use of each export
# item 5b: a TypeScript-scanner pass over 2,328 product functions, 288 script functions and 1,203 test functions
# item 5c: reference counts of every file in script/ over package.json, workflows, scripts, tests and docs
# item 6: rsync of ~/dev/mayfly (working tree with the two uncommitted edits, built lib/) to a scratch directory,
#   node_modules hard-linked, then:
vitest run --coverage --reporter=json --outputFile=<run>.json      # baseline, set A, set B2
node --test script/tests/*.test.mjs                                 # on a git-initialised copy, before and after
tsc -p tsconfig.tests.json --noEmit
```

Deviations from the setup steps, stated so nobody assumes otherwise:

- I did not run `pnpm install` or `pnpm run build` in the worktree. The worktree has no `lib/` or `node_modules`; Part 1 was
  measuring and the build is heavy. Repros import the sources (and the pinned packages) from the main checkout read-only,
  with `--experimental-transform-types`. The sources there equal this tree's, apart from the two known uncommitted edits.
  Nothing in the main checkout was written.
- The deletion check used a scratch copy of the main working tree, so it includes the `20_000` timeout edit on
  `markdown-rows.spec.ts` that the audit baseline had.
- The reproduction scripts are in the session scratchpad and are not committed, as in the first pass. Appendix C gives each
  one's input.

## Item 1: lifecycle sweep

The rule read against: each registration, listener, timer and async work item needs unload and stale-generation handling.
Every pattern found is listed, passes and failures alike. "Unload" is what happens when the owner goes away; "stale" is what
happens to a result that arrives after it did.

### `core/terminal.ts` (1,235 lines)

| Pattern | Where | Unload | Stale generation | Result |
| --- | --- | --- | --- | --- |
| Four input listeners on the TUI (navigation, content scroll, wheel, viewport re-add); the stock viewport listener is removed | 713-766 | Removed in both `stop()` paths | n/a | Pass (1209-1212, 1225-1228) |
| `onTerminalColorSchemeChange(onSchemeChange)` | 983 | Unsubscribe function discarded | The callback holds the Fiber context; `ctx.emit` on a dead context returns undefined (checked) | Pass: the TUI is dropped with the runtime |
| `current.requestRender` and `current.render` replaced on the instance | 698, 935 | Not restored | The instance is discarded | Pass |
| Module singleton `activeRuntime` | 636 | Cleared only if it is still this runtime (1217, 1230); resume restarts only if it still is (1185) | Identity guard | Pass. A second start overwrites it without a check (see P2-3) |
| `OutputRecovery` activate/deactivate | 978-981, 1167, 1187, 1213, 1223 | Balanced across start, suspend, resume, stop | n/a | Pass on balance; fails on what it counts as ambient (P2-4) |
| `suspend()` | 1163-1195 | The `suspended` flag is cleared in `finally`; resume skips the restart if the runtime was stopped meanwhile (1185) | Exclusive (1164) | Pass, with a one-tick window: `stop()` during the `setImmediate` beat (1175) does not stop `fn` from starting afterwards. Narrow, traced only |
| `stop()` | 1202-1231 | Idempotent flag set first; drains 1,000 ms at most | A second caller returns at once | Contract mismatch (P2-5) |
| Async probe before start | 970 | `probeTerminalBackground` is bounded (200 ms, `terminal-info.ts:38`) and clears its timer, listener and raw mode on every exit path (63-78) | The caller does not fence an unload during the await | **Fails in the caller (P2-3)** |
| `joinSplitModifiers` microtask | 470 | A held prefix is released on the next microtask | A stale microtask can release a newer held value, but both run after the synchronous burst, so the output is the same (analysed) | Pass |
| `setContentScrollHandler` disposer | 1129-1134 | Clears only its own handler | Identity guard | Pass |
| Overflow sink `dispose` | 1216, 1229 | Awaited in both stop paths; skipped if `current.stop()` throws (1224) | n/a | Note: a throwing `stop()` also skips the listener removal |
| Container maps: `clampedChildren` (WeakMap), `DockLayoutContainer.metadata`, `contentChildren`/`bottomChildren`/`bottomPinned` | 92, 267, 725-775 | Deleted in `removeChild` (296-299, 1069-1077) | n/a | Pass |
| `createStableTuiReference` proxy | 604-629 | n/a | Built for a renderer swap; the only call passes `() => current` (704), a constant | Speculative; 5 tests exercise a swap that never happens (Appendix A row 50) |

### `core/surface-manager.ts` (798 lines) and `core/views-lane.ts` (409 lines)

No timer, no async work, no listener. Registrations only.

| Pattern | Where | Unload | Stale | Result |
| --- | --- | --- | --- | --- |
| `register()` returns `{ setHidden, replace, dispose }` | 429-499 | `dispose` is idempotent, retires focus and the active id, and notifies the focus transition | `setHidden` and `replace` return at once once `disposed` | Pass |
| Duplicate id | 430 | Throws | n/a | Pass |
| `layout()` writes state while it computes (collapse flags, focus retirement, which calls `onSurfaceFocusTransition`) | 585-643 | n/a | A revision check keeps the memo only if nothing moved during the call (577-579, 651) | Note: a getter with side effects on the render path; `terminal.ts:803-814` calls `stable.setFocus` from that callback, which can run inside a frame |
| `views.bind(host)` / `register(view)` | `views-lane.ts` 155-206 | Both disposers are idempotent; the bind disposer is a no-op once another host replaced it | Identity guard | Pass |
| `userState` option, `onUserStateChange`, `replaceUserState()` | 80-85, 501-512 | n/a | n/a | **Dead surface**: no caller in `src`, `examples`, `script` or `website`; only `surface-manager.spec.ts` uses them |

### `core/ui-interaction-*.ts` (2,745 lines in ten files)

| Pattern | Where | Unload | Stale generation | Result |
| --- | --- | --- | --- | --- |
| Service `live` flag, `changed()` microtask coalescing | `state.ts` 91-98, 113-121 | `dispose()` clears the flag and the schedule; the queued microtask re-checks `live` | n/a | Pass. The service is disposed by an effect (`frontend/index.ts:53`) |
| `subscribe` | `state.ts` 79-83 | Effect-bound disposer; a disposed service returns a no-op | n/a | Pass |
| Registry observers (panes, overlays) | `state.ts` 125-168 | `off()` and removal of every owned model | `remove(kind, id, expected)` removes only the model the observer owns | Pass |
| `UiNotificationStore` timers | `notifications.ts` 42, 161-167 | Cancelled on report, clear, clearOwner, handle, setVisible(false), trim and dispose | The callback fires only if `records.get(id) === record` (165) | Pass, one gap (P2-8) |
| `UiSurfaceModel.execute` (one `await`) | `surface.ts` 753-830 | `dispose()` aborts every task, clears the maps, swaps the endpoint for `DISPOSED_EVENTS` (896-906) | After the await: `live` and `aborted` (760), inputs still current (761); the progress `report` callback is guarded (758); a newer observation aborts the older one by key (727-730); `receive(null)` cancels tasks (245); a schema change aborts submitted tasks (370-376); `changed()` re-checks every task's inputs (889) | Pass. `setPhase` after a re-entrant dispose inside `publish()` writes one frozen record into an emptied map (802); invisible |
| `UiFormState` reducers | `form.ts` 168-243 | Pure | `operationId`, `draftRevision` and `schemaRevision` fence ack, release and invalid (169-196); `validated` is fenced by the field revision (200) | Pass |
| Choice, prompt, tree, field actions, locale | the other five files | Pure reducers over immutable state | n/a | Pass |
| Module-level `WeakSet`/`WeakMap` memos: `ownedIndexes` (`choice.ts:64`), `documentTexts` (`document.ts:123`), `estimatedDocuments` (`document.ts:141`, at most 4 widths per node) | | Weakly held, keyed by frozen node identity | n/a | Pass in behavior. By the letter, module-level memos; the package instructions name only the admission, compile and list-row memos as per-surface. Decide whether to list these as exempt |

### Defects the sweep found

- **P2-3**, **P2-4**, **P2-5**, **P2-6** below, all in or around `terminal.ts`.
- **P2-8**, in `ui-interaction-notifications.ts`.
- The dead `SurfaceManager` user-state surface (counted under P2-10).

## Item 2: F8 and F10 traced to the end

### F8: startup chain and exit epitaph

The chain (`app/index.ts:152-157`) runs `enqueue(operation)` as `chain = chain.then(operation).catch(print)`. It is not owned by
the Fiber: nothing stops a queued operation when `mayfly-app` unloads.

Path of an operation that outlives the unload (resume as the example, `app/index.ts:194-200`):

1. `ctx.on('mayfly/request-resume')` is Fiber-owned, so no new operation is queued after the unload. One already queued runs.
2. `await resolve(sessionId)` completes natively (`controller.resolveAgent`); native work is not rolled back, by design.
3. `select(agent)` calls `conversations.selectPrimary` (`conversation-views.ts:187-198`), whose first line reads
   `this.ctx.agents.get(...)`. On a context whose Fiber is gone, Cordis throws. Checked with the pinned Cordis:
   ```
   ctx.agents.get after dispose -> THROWS Error cannot get required service "agents" in inactive context
   ctx.get(agents) after dispose -> agent:1
   ctx.effect after dispose -> THROWS INACTIVE_EFFECT cannot create effect on inactive context
   ```
4. The operation's own `catch` prints `dsh: could not resume session X: cannot get required service "agents" in inactive
   context`. For the startup operation (`app/index.ts:175-192`) the `catch` calls `io.exit(1)`.
5. `io.exit` is `host.exit`, which is `shutdown.shutdown(code)` (dsh `profile-boot-BZ2ZjNWi.js:278`). It coalesces: the first
   call wins (`start` in `createProcessShutdown` begins with `if (pending !== void 0) return pending`). So at process exit a
   late `exit(1)` is a no-op.

Effect: an extra stderr line and, when the unload is a reload and not an exit, a process exit with code 1 from the startup
operation if it was still pending. The reload case needs `restart()` of the app plugin during the first seconds; HMR is off in
the default bundle. A session created by `create()` before the throw stays on disk empty (native work, accepted by design).
**Verdict: confirms "no unload or generation fence"; the effect is minor. No fix required at exit; a generation check at the top
of `enqueue`'s operations would cover the reload case.** Not reproduced as a failing test; the trace above is the evidence.

The epitaph, read to the end:

- `exit-epitaph.ts:29-53` holds `writer`, `armed` and `hooked` at module level and installs `process.once('exit', ...)` once.
  The hook fires once at exit and is consumed; `hooked` stays true, which is right for a process that is ending. By the letter of
  the root instructions this is a mutable product singleton. The module documents it as the `draft-stash` pattern.
- The epitaph is armed from a disposer (`app/index.ts:145-150`) that reads `current.current()`. That only works if the disposer
  runs before the `MayflyConversationsService` and `MayflyCurrentAgentService` clear themselves (`conversation-views.ts:121-127`,
  `current-agent.ts:19-22`), which were registered earlier. Cordis disposes a Fiber's own effects in reverse order of
  registration. Checked:
  ```
  D (registered after child)
  C (registered 3rd)
  B (registered 2nd)
  A (registered 1st)
  child effect
  ```
  So the epitaph disposer runs first and sees the Agent. **The epitaph path is correct.** It depends on that order; a comment at
  `app/index.ts:145` saying so would stop a reorder from silently removing the farewell line.
- A startup operation that never settles (`loader.await()` cannot reject: it uses `Promise.allSettled`, cordis-plugin-loader
  `lib/index.js:154-159`) would hold every later new, resume and fork request behind it. No timeout. Noted, not a defect today.

### F10: two sanitizers

`ui-validator.ts:67-68` (admission, `TERMINAL_SEQUENCE` and `UNSAFE_CONTROLS`) and `plugin-view.ts:26-32` (paint,
`ANSI_OR_OSC` and `UNSAFE_CONTROLS`) differ in three ways: C1 and DCS/APC/PM/SOS payloads, the noncharacters `﷐-﷯`, and
the OSC arm (`[\s\S]*?` lazy against `[^\x07]*` greedy).

Where each runs. Admission runs on every wire node, so for UI nodes the paint-time pass receives text that is already clean.
The paint-time `sanitizePluginText` is **the only gate on text that never passes admission**: the transcript. Callers on that
path: `transcript/components.ts:255` and `:341` (user and assistant text), `:537` (shell tool output), `:590` (any tool
result), `command-group.ts:105`, `read-group.ts:78,170`, `search-group.ts:124`, `thinking.ts:117,123`, `compaction.ts:132`.

Trace to the effect. After either sanitizer, no `ESC` or C1 control survives, so nothing active reaches the terminal. That
part of F10 is only cosmetic: payload text of a DCS or APC string and the text of an 8-bit CSI or OSC stays visible. The
second difference is worse, and it is the finding **P2-1**:

```
OSC 8 hyperlink, ST-terminated (ls --hyperlink, gh, cargo)
  in    "\u001b]8;;http://x/a\u001b\\label-a\u001b]8;;\u001b\\ and \u001b]8;;http://x/b\u001b\\label-b\u001b]8;;\u001b\\ tail"
  paint " tail"
  admit "label-a and label-b tail"
two OSC titles with text between
  in    "one \u001b]0;t1\u001b\\KEEP THIS\u001b]0;t2\u001b\\ two"
  paint "one  two"
  admit "one KEEP THIS two"
OSC (ST) then plain text then BEL
  in    "\u001b]0;t\u001b\\KEEP\u0007 rest"
  paint " rest"
  admit "KEEP rest"
APC (kitty graphics) payload
  in    "a\u001b_Ga=T,f=100;AAAA\u001b\\b"
  paint "aGa=T,f=100;AAAAb"
  admit "ab"
8-bit CSI   in "a\x9b31mb"   paint "a31mb"   admit "ab"
```

`paint` is `text.replace(ANSI_OR_OSC, '').replace(UNSAFE_CONTROLS, '')` with both regexes read out of `plugin-view.ts` by the
script, `admit` the same for the validator's. The greedy `[^\x07]*` runs to the end of the string (or the first BEL) and backs
off to the last `ESC \` before it, so everything between the first OSC opener and the last string terminator disappears.

## Item 5: dead code, duplication, script hygiene

### 5a: the 280 test-only exports

The scan was re-run on this tree: 1,945 exports, 280 referenced only by tests (the first pass's number). A second scan added
the declaration kind, the uses in the export's own file with comments stripped, and the first test line that uses it. The full
table is Appendix A. Summary:

| Verdict | Count | Why |
| --- | --- | --- |
| keep | 257 | The export is the subject of a decision test, or a type that costs nothing, or a seam a rule requires |
| delete | 23 | Wrappers and dead data with no production caller, tests that restate a constant, an export never imported |

Keep reasons: `P` 96 pure function with a direct decision test; `L` 41 limit that a boundary test sits on; `T` 37 type-only
export; `S` 20 module-level test hook (P2-7); `K` 14 constant read as input or boundary; `W` 13 feeds a `width-scan.spec.ts`
as the root instructions require; `G` 9 read by a guard spec (`key-audit`, `locale-catalog`, `theme-contrast`); `F` 8
formatting rule, to merge with its near-duplicate (P2-9); `J` 8 weak: the test asserts a substring of `JSON.stringify(node)`;
`N` 4 the native clipboard probes (P2-2); `R` 3 the key-binding writers named by the roadmap; `C` 2 a class used as a fixture;
2 with their own reason.

Delete, grouped (confidence in Appendix A):

- **Wrappers with no production caller**: `renderFormField` (27 test uses) and `renderListSegment` (13) in `ui-patterns.ts:279,283`
  wrap `paintFormField` and `segmentFooter`; the compiler calls `paintFormField` directly (`ui-compiler.ts:776`).
  `contentNodeRows` (38 uses, `content-rows.ts:1076`), `decorateChoiceItem` (`ui-interaction-choice.ts:278`),
  `hasEditorEnhancement` and `applySubmitTransformers` (one-line facades over services). The tests are decision tests and stay;
  they call the underlying function. The root instructions forbid adapter facades.
- **Dead functions and data**: `framePanel` (`chrome.ts:334`, 46 lines, 19 test uses, a width-scan entry), `toTraceItem`,
  `updatePanelSummary`, `correlateChild`, `liveDraftsOf`, `itemActionId` (its derivation is inlined at `ui-actions.ts:55,66`),
  and `LOGO_GRADIENT` (the banner imports `LOGO_ART` and `LOGO_ROWS` but never the gradient, `banner.ts:40`).
- **Tests that restate the source**: `RAIL_MIN_COLUMNS`, `BREATH_LEVELS`, `LOADER_FRAMES`, `ENDPOINT_PROTOCOLS`,
  `MODELS_DEV_URL`, `POWERSHELL_ARGS`, `DIRECTORY_LABEL`; `formatReminderLocalTime` is asserted only with `typeof ... === 'string'`;
  `MESSAGE_INDENT` appears only in a test title.
- **Speculative**: `createStableTuiReference` (terminal.ts:604-629).

Not in the 280, because a barrel re-exports them: `createTerminalRelease` (`terminal.ts:645`, public through `core/index.ts:50`)
has no caller outside its own tests. The launcher's fail-loud path disposes the whole tree
(`profile-boot-BZ2ZjNWi.js:255-257`), which runs the Fiber effect, not this function.

An import-graph pass from every `package.json` export entry (the three packages, `src/**`) finds one product module that no
entry reaches: `interaction/paste-image-native.ts`. The `invariant.ts` companions and the `cli` sources are entries by other
routes and are not counted.

### 5b: duplicated bodies

Method: every function, method and arrow-function constant of 120 characters or more, with identifiers renamed by first
occurrence, hashed. Exact groups share the body with literals; shape groups mask literals; near pairs share at least 70 % of
their 5-token shingles. Counts: product 2,328 functions give 28 exact groups, 9 shape groups, 11 near pairs; `script/` gives 2
exact groups; the specs give 45 exact, 20 shape, 3 near. Appendix B lists the product groups. Findings that matter (**P2-9**):

| What | Where | Note |
| --- | --- | --- |
| `failureDetail` and `readCopiedImage` (Jaccard 0.99, about 90 and 162 tokens); `classifyFailure` and `classifyNativeFailure` are a third, similar pair that differ in their arguments | `paste-image.ts:202,267` and `clipboard-probe.ts:150,174` | The shared helpers live in `clipboard-probe.ts`; `paste-image.ts` kept private copies. Part of P2-2 |
| `observeInteractionLocale` and `observeTranscriptLocale` (170 tokens, exact) | `interaction/locale.ts:721`, `transcript/locale.ts:187` | One shared function |
| `readInstalledVersion` (86 tokens, exact) | `plugin-market/installer.ts:429`, `updater/profile.ts:110` | One shared function |
| `usagePercent` and `contextPercent` (71 tokens, exact), `cachePercent` (0.88) | `interaction/usage.ts:57`, `transcript/status-context.ts:84,98` | Three percent functions, two bodies |
| `schedulePane` and `scheduleOverlay` (86 tokens, exact) | `core/surface-renderer.ts:397,498` | |
| `segmentRows` and `chunkRows` (146), the two `row` closures (73) | `core/content-rows.ts:156,313,185,342` | B6 |
| `extractToolHint` and `extractKeyArgument` (0.88) | `session-export.ts:76`, `transcript/present.ts:158` | |
| `formatElapsedMs` and `compactElapsedSeconds` (0.86), with `formatDuration`, `formatJobDuration`, `formatAgentElapsed`, `formatWorkflowElapsed`, `formatAgo` | `ui-patterns.ts:358`, `agent-presentation.ts:43`, and the four interaction files | Five or six elapsed-time formatters; each has its own test (Appendix A, code `F`) |
| `fit` (42 tokens, exact) | `surface-manager.ts:128`, `ui-patterns.ts:79` | |
| `present` ×4, `setScope` ×4, `list` ×3 in `ui/src/services.ts` | validators, transcript groups, services | Small; a shared helper per group |
| The eleven `set*` hooks | P2-7 | |

By construction, not defects: `childEnv` (`updater/io.ts:73` and `cli/src/internals.ts:94`) and `dshHome`
(`updater/profile.ts:39` and `cli/src/calibrate.ts:100`). `packages/cli/AGENTS.md` says the launcher has no runtime
dependencies and the launcher and the in-app updater are owned separately.

### 5c: script hygiene

Reference counts of the 40 files directly in `script/` over `package.json`, the four workflows, other scripts, tests and docs:

- **Unreferenced by anything**: `smoke-plan-review.mjs` (225 lines), `smoke-schedule.mjs` (191), `demo-fresh-onboarding.sh` (35). The
  catalog's `plan` scenario covers the plan-review states (`script/scenarios/golden/plan`). Nothing in the catalog covers
  `/schedule` (`replays.mjs` has no schedule entry), so `smoke-schedule.mjs` is the only check of it and nothing runs it. The
  claimed-files guard cannot see this: `claimed()` accepts any `CODE_FILE` (`script/verify/select.mjs:76`).
- **Referenced only by a `package.json` script, in no tier and no workflow**: `smoke-pty.mjs` and `smoke-pty-output-recovery.mjs`.
  The output-recovery smoke is the only PTY check of that behavior; no scenario covers it (`grep bleed|output-recovery` over the
  catalog and replays finds nothing). Also `smoke-cli-local-registry.mjs`.
- **Wired**: `smoke-happy.mjs` (`verify/steps.mjs:59,95`), `smoke-platform-pty.mjs` (release workflow), the rest.
- **Copied PTY blocks**: the `node-pty` `spawn-helper` chmod preamble (16 lines) is in `smoke-pty.mjs`, `smoke-pty-output-recovery.mjs`,
  `smoke-plan-review.mjs` and `smoke-schedule.mjs`; `waitFor` is byte-identical in `smoke-happy.mjs:71`, `smoke-plan-review.mjs:93`
  and `smoke-pty.mjs:82`, and similar in two more. `script/smoke-lib.mjs` already exists with 14 importers. Also
  `runtimeTarget` / `defaultTarget` (40 tokens) in `check-pack.mjs:61` and `package-contract.mjs:63`.
- No orphan module in `script/scenarios`, `script/shots`, `script/verify` or `script/workbench`.

## Item 6: deletion check

Go-ahead from the lead after Part 1's timing runs. Scratch copy of the main working tree (8 cores, no other load; `uptime` load
average 0.24 before the first run). Each removal was made with the TypeScript AST (the whole statement), not by line.

Removal set A (pure test removals, applied together):

| # | Proposal | Removed |
| --- | --- | --- |
| A1 | T8: `describe('/plugin coverage corners')` | `plugin-commands.spec.ts:1310-1479` (170 lines) |
| A2 | T8: `describe('/plugin final coverage corners')` | `:1642-1720` (79 lines) |
| A3 | T8: `describe('final arms')` | `:1820-1849` (30 lines) |
| A4 | T8: `it('covers the degraded corners...')` | `search-group.spec.ts:131-209` (79 lines) |
| A5 | T6: the 100,000 case | `official-model.spec.ts:722`, `[1_000, 10_000, 100_000]` to `[1_000, 10_000]` |
| A6 | T3: `it('is deterministic')` | `work-budget.spec.ts:77-80` |
| A7 | No-assertion test that is a tool, not a test | `work-budget.spec.ts:82-85` (`rewrites the baseline on request`) |
| A8 | No-assertion tests (3 of the static scan's 21) | `updater-io.spec.ts:220`, `attachments.spec.ts:120`, `attachments.spec.ts:135` |
| A9 | Assertions that restate a constant (5a) | `ui-tabs-paint.spec.ts:158`, `ui-content-painters.spec.ts:40-42,45`, `provider-add.spec.ts:91`, `models-dev.spec.ts:174`, `native-features.spec.ts:96` |

Set B2 (T9, on top of A): the 13 `tests/design/scene-*.spec.ts`, `probe.spec.ts` and `visual-language.spec.ts` files, and
`tests/design/frames/`. The first attempt, deleting the whole `tests/design` directory (B1), is reported below.

Results:

| Run | Spec files | Tests | Failed | Summed test time | Coverage (statements / branches / functions / lines) |
| --- | --- | --- | --- | --- | --- |
| Baseline | 293 passed, 1 skipped | 5,140 passed, 1 skipped | 0 | 181.1 s | 99.56 / 99.22 / 99.56 / 99.80 |
| A | 293 passed, 1 skipped | 5,115 passed, 1 skipped | **0** | 157.7 s (-23.4 s) | 99.46 / 99.02 / 99.53 / 99.72 |
| B1: A + whole `tests/design` removed | 267 passed, **13 failed** | 4,719 | 13 files fail to load | | |
| B2: A + design specs and frames removed | 280 passed, 1 skipped | 5,020 passed, 1 skipped | **0** | 154.3 s (-3.4 s more) | 99.46 / 99.02 / 99.53 / 99.72 |

- **A: no other test fails.** 25 tests went (the 26th "missing" test is P2-12: a title with a timestamp). The 25 removed tests account for 10.9 s
  of summed test time (the suite's total fell 23.4 s between the two runs; the rest is run-to-run variance). The floor is 99 for each metric; **branches fall from 99.22 to 99.02, 0.02 above the floor.** The coverage-corner tests
  are what hold that margin (the report's T8 point about the floor), so the next uncovered branch fails the full tier.
- **B1 fails.** The 13 failing files import `tests/design/probe.ts`, `walks.ts` or `scene-NN.ts`: `core/width-scan.spec.ts`,
  `ui-actions`, `ui-compiler-content`, `ui-focus-change`, `ui-list-keys`, `ui-list-segment`, `ui-list-selection`,
  `ui-presentation`, `ui-prompt-editor`, `ui-prompt-keys`, `ui-retained`, `ui-tabs-keys`, `ui-work-counters`. Those helpers are
  shared. The report's T9 ("retire with the accepted 2d frames") needs "specs and frames only".
- **B2 passes** and adds no coverage loss against A (the numbers are identical: the scene specs cover nothing the rest does not).
  It saves 2.9 s of summed test time (95 tests), less than the report's 4 s.
- **Script tests** (`node --test script/tests/*.test.mjs`, on git-initialised copies): baseline 110 pass; with A and B2, 109 pass,
  1 fail: `script/tests/check.test.mjs:68`, "a grid golden or the grid serializer reruns the specs that compare grids", which names
  `packages/mayfly/tests/design/frames/02-actions/move.grid`. T9 also needs that test rewritten to name a frame that exists.
- **Typecheck** (`tsc -p tsconfig.tests.json --noEmit` on the A+B2 copy): 9 errors, all `TS6133` on names the removals left unused:
  `BREATH_LEVELS`, `LOADER_FRAMES`, `RAIL_MIN_COLUMNS`, `MODELS_DEV_URL`, `ENDPOINT_PROTOCOLS`, `writeFileSync`, and three helpers
  in `plugin-commands.spec.ts` (`KEY` at line 28, `activateBrowserRow` at 251, `currentAgent` at 1474). The gate's typecheck
  would fail until the imports and those helpers go. The helpers are themselves dead after the removal. (A baseline typecheck on a second
  scratch copy was not comparable, because its `node_modules` was a symlink; the 9 are all attributable to the removals by name.)

Not run as a deletion check: the 17 source-level deletions of Appendix A (they change `src`, so they are not pure test
removals; they belong to `audit-2`).

## New findings in detail

### P2-1: `sanitizePluginText` deletes text between two ST-terminated OSC sequences (P2)

`core/plugin-view.ts:26` is `/\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~]|.)/gu`. For input with two or more ST-terminated
OSC strings, the first `\x1b]` matches `[^\x07]*` greedily to the end (or to the first BEL) and backs off to the last `\x1b\`. Every
character between them is deleted. Output of the repro is under Item 2. Reachable through the shell card
(`transcript/components.ts:537`: `sanitizePluginText(terminal.output ?? result.fullText ?? result.text)`), any other tool result
(`:590`), and assistant and user text (`:255,:341`). Tools that print OSC 8 hyperlinks (`ls --hyperlink`, `gh`, recent `cargo`,
`rg --hyperlink-format`) lose their labels and the text between links. Display only; the stored session is unchanged.
*Fix direction:* make the arm lazy (`[\s\S]*?`) or share the validator's `TERMINAL_SEQUENCE`; do it with F2's fix, whose
described output-preserving rewrite would otherwise carry the greedy semantics over. Add the two inputs above to the spec.

### P2-2: macOS and Windows clipboard-image paste is not wired (P2)

`website/en/features/editor.md:41` documents "on Windows one PowerShell call saves the clipboard image ... (10s budget); on macOS
osascript reads the clipboard classes ...". The implementation is `interaction/paste-image-native.ts` (`probeWindows` at 127,
`probeDarwin` at 310). The import-graph scan finds it unreachable from every package entry, and `grep paste-image-native` over
`src`, the manifests and the patch files finds only comments (`clipboard-probe.ts:9`). The plugin's default reader
(`paste-image.ts:401-425`, `clipboardToolsFor` at 165-171) tries only `wl-paste` and `xclip`; there is no `process.platform`
check in `paste-image.ts`, `clipboard-probe.ts` or `clipboard-write.ts` for reading. `clipboard-probe.ts:24` still declares
`ClipboardBackend = 'wayland' | 'x11' | 'win32' | 'darwin'` with the comment "win32/darwin native probes (platform-selected)".
`paste-image.ts` keeps private copies of `failureDetail`, `readCopiedImage` and `classifyFailure` that `clipboard-probe.ts` also
exports (`failureDetail`, `readCopiedImage`, `classifyNativeFailure`), which looks like a migration that stopped half-way. `git log` shows the module in the first commit
(`81ac826`) and no commit that imports it.

Effect on macOS and Windows, by the trace: `Ctrl+V` calls `wl-paste` and `xclip`, both missing, and the user sees the
missing-tool message. Not run on those platforms (this machine is Linux), so this stays a trace. The platform acceptance list
(`docs/platform-acceptance.md:49-51`) is the check that would catch it.
Cost today: 353 lines, a 45-test spec, and 21.7 s of the suite (T2's four real 5 s waits are in this spec).
*Fix direction:* wire the probes by platform in `defaultClipboardImageReader` and delete the private copies; do not delete the
module, because the Website promises it. The `N` rows of Appendix A depend on this.

### P2-3: the terminal outlives a failed or unloaded startup (P3)

`core/index.ts:157-199`: `apply` awaits `startMayflyTerminal` (line 159), which puts the tty in raw mode and the alternate screen,
then registers other plugins and effects, and registers the effect that stops the terminal last (line 198). Cordis refuses effects on a
Fiber that is unloading or gone (`ctx.effect after dispose -> THROWS INACTIVE_EFFECT`, quoted under Item 2). If the Fiber is
disposed during the await (at most the 200 ms probe, plus the synchronous start), or any statement between 159 and 198 throws, the
first `ctx.effect` or `ctx.plugin` throws and the runtime is never stopped. A `SIGTERM` or `SIGINT` from outside in that window runs
`dispose()` then `process.exit` (`createProcessShutdown`, `forceAfterDispose`) and leaves the terminal raw and on the alternate
screen. A keyboard Ctrl+C cannot do this: the probe has put stdin in raw mode, so it arrives as data.

Model reproduction (the same shape as `apply`, with a 50 ms await standing in for the probe):
`{"terminalRunning":true,"stopCalls":0,"applyError":"INACTIVE_EFFECT: cannot create effect on inactive context"}`. The real function
was not driven: it needs a real `ProcessTerminal`.
*Fix direction:* register the stop effect immediately after `startMayflyTerminal`, and check the Fiber after the await.

### P2-4: the output guard treats pi-tui's own writes as ambient (P3)

`output-recovery.ts:56-73` repaints after any `process.stdout.write` made while `rendererWriteDepth === 0`. Only writes through
`terminal.write` raise the depth. pi-tui writes some control sequences straight to `process.stdout`: `hideCursor` (`terminal.js:411`)
on every overlay show and hide (`tui.js:299,315,397`), and `drainInput` (`terminal.js:312`, and `:265` through `disableModifyOtherKeys`), which `stop()` runs at
`terminal.ts:1222` while the guard is still active (`deactivate` is at 1223). Each such write calls `current.requestRender(true)`,
which resets the differential state (`tui.js:499-503`) and repaints the whole viewport.

```
[["after showOverlay",1],["after overlay hide",1],["terminal.write (renderer path)",0]]
{"repaintsDuringDrainInput":1}
```

(the real `ProcessTerminal` and `TuiAltScreen`, the real `createOutputRecovery`, `process.stdout` as the guarded stream). Cost: one
forced full frame per overlay show and per overlay hide, and one at shutdown with the Kitty protocol active. Not visible in a
golden because a forced frame draws the same cells. *Fix direction:* route the guard's depth through the `Terminal` methods that
write, or mark pi-tui's writes by wrapping `hideCursor`, `showCursor` and `drainInput` as well; deactivate before the drain.

### P2-5: a second `stop()` resolves before the terminal is restored (P3, latent)

The interface says `stop()` "settles when the terminal state is restored" (`terminal.ts:589-594`) and "Idempotent". The second call
returns at the `if (stopped) return` of line 1203 while the first awaits `drainInput`:

```
second stop() resolved at 0 ms  (terminal.stop calls: 0)
first  stop() resolved at 102 ms  (terminal.stop calls: 1)
```

(a `FakeTerminal` whose `drainInput` takes 100 ms). In the product only the Fiber effect calls `stop()`, once, so nothing is wrong today.
`createTerminalRelease` (`terminal.ts:645`), whose doc says it is the `installFailLoud` release, would be the second caller, but
nothing wires it (P2-10). The window of 1,000 ms at most (`drainInput`, `terminal.js:306`) would let a fail-loud exit run before
`current.stop()`. *Fix direction:* keep the first call's promise and return it; or delete `createTerminalRelease`.

### P2-6: the shutdown order comment is wrong (P3)

`core/index.ts:150-153` says unloading "stops the terminal last". Cordis disposes a Fiber's own effects in reverse registration order
and starts child Fibers' disposal after them, concurrently. The `runtime.stop()` effect is the last one registered (line 198), so it
starts first:

```
  11 ms  parent stop() starts
  12 ms  child (screen/surface renderer) disposer runs
 111 ms  parent stop() finishes (drain + current.stop)
```

So the surface renderer, the screen service and the components unload while the terminal is still draining, with the TUI live and
`stopped` already true. Harmless today (the structure operations tolerate it), but the comment is the contract a later change
would trust, and `exit-epitaph.ts:7-12` builds its ordering argument on the same assumption. *Fix direction:* correct the comment,
or register the stop effect first if the intent is "last".

### P2-7: module-level mutable test hooks (P3)

The root instructions forbid mutable product singletons. Twenty exports exist so a test can swap time, IO or a catalog through a
module-level variable: `setExitEpitaphWriter`, `armedEpitaph`, `writeArmedEpitaph`, `setClipboardOsc52Emitter`,
`setExternalEditorLauncher`, `setModelsDevFetch`, `setModelsDevLoader`, `setClipboardClock`, `resetClipboardBackendCooldowns`,
`accountInternals`, `providerStoreInternals`, `__setCatalogForTest`, `setCompactionTimers`, `setActivityTimers`, `setActivityClock`,
`setPaneAgentsClock`, `setWorkflowPaneTimers`, `setGitCommandRunner`, `setGitClock`, `setGitStatusTimers`. Three more setters of the same shape (`setClipboardTextWriter`, `setShellExecutor`, `setProcessRowTimers`) are not in the 280
because another file references them. Eleven setters (eight of the list and these three) have the same 19-token body (Appendix B). `__setCatalogForTest` names the problem in production code. They need no change for the audit; the decision tests
depend on them (code `S` in Appendix A). *Fix direction:* a Fiber-scoped option or service (`ctx.mayflyClock`) instead of
module variables, one slice.

### P2-8: a handled notification expires again (P3)

`handle(id)` cancels the timer and marks the record handled (`ui-interaction-notifications.ts:116-122`). `setVisible(false)` then
`setVisible(true)` re-arms every record, handled ones included, because `schedule` checks only visibility, purpose and severity (161-162):

```
after report:           timers = 1  state = active
after handle:           timers = 0  state = handled
after hide + show:      timers = 1  state = handled (a handled record is scheduled to expire again)
```

Success and info records then disappear after the remaining visible time. Whether a handled record should expire is the owner's
call; the two paths disagree. *Fix direction:* skip `state === 'handled'` in `schedule`, or let `handle` own expiry.

### P2-9: duplicate implementations

See 5b and Appendix B. The pair that matters is `paste-image.ts` against `clipboard-probe.ts` (P2-2).

### P2-10: dead production code with tests

The 23 delete rows of Appendix A, `createTerminalRelease`, the `SurfaceManager` options `userState` and `onUserStateChange` with
`replaceUserState`, and nothing else found. `saveKeybinding`, `resetKeybinding` and `resetAllKeybindings` have no caller either, but the
roadmap names them as the write half of the `/keys` panel (`implementation-roadmap.md:1209,2045`, slice 6f), so they are kept
(`R`): dead if 6f slips.

### P2-11: script hygiene

See 5c. *Fix direction:* delete `smoke-plan-review.mjs` and `demo-fresh-onboarding.sh`; decide on `smoke-schedule.mjs` (a catalog
scenario would replace it); wire `smoke-pty-output-recovery.mjs` into the full tier or fold it into a scenario; move the PTY preamble
and `waitFor` into `smoke-lib.mjs`.

### P2-12: a test title with a timestamp (P3)

`ui-validator.spec.ts:46` has `[new Date(), 'plain object']` in an `it.each` whose title uses `%j`, so the test is named
`... "2026-10-11T14:39:23.247Z"` and gets a new ID on each run. Name-keyed tooling (the per-test timing comparison of the first
pass, the stale-row check, a flaky-test history) cannot follow it. In the item 6 runs it appeared as the one "missing" test between
two runs. *Fix:* `new Date(0)`.

## What I could not run, and why

- **`pnpm install` and `pnpm run build` in the worktree**: not run (see Scope and method). No finding depends on a worktree build.
- **P2-2 on macOS or Windows**: this machine is Linux. The trace and the import graph are the evidence.
- **P2-3 through the real `apply`**: it needs a real `ProcessTerminal` and a TTY; the model reproduction stands in.
- **F8 as a failing test**: the trace ends in a throw whose text was checked on Cordis; I did not build a harness around
  `mayfly-app` to unload it mid-startup.
- **`feat/audit-1`**: not on this machine, so "the F2 fix keeps P2-1" rests on the progress report's description, not on its code.
- **The 17 source-level deletions of Appendix A**: not a test-removal check; no `src` file was edited.
- **Per-removal runs**: set A was applied as one change. A removal that made another test fail would have shown up as a failure in
  the combined run; none did, so no bisection was needed.
- **`perf` scenarios, scenario goldens, the Website build**: not part of this part.
- **Owner items**: the F7 and F12 live checks and the eight manual items were not touched.

## Appendix A: the 280 test-only exports

Source: this tree. File column: `m/` is `packages/mayfly/src/`, `ui/` is `packages/ui/src/`. First test use: `m/t/` is
`packages/mayfly/tests/`, `ui/t/` is `packages/ui/tests/`. "Test refs" counts word-boundary matches in test files, imports included.
Verdict **delete** means delete the export (the symbol, or only the `export` and the tests call the underlying function); the
reason says which. Confidence is high, medium or low.

Reason codes for **keep** rows:

| Code | Meaning |
| --- | --- |
| `P` | Pure function with a direct decision test of its output (rule, format, ordering, parse). I read the first test line of every row with three or fewer test uses (31 rows) and sampled the rest |
| `L` | A limit the decision test sits on: `LIMIT` accepted and `LIMIT + 1` refused, or a clock advanced by it |
| `K` | A constant read by a decision test as an input or a boundary |
| `T` | Type-only export (interface, type, barrel re-export): erased by the compiler, types a fixture against the real contract |
| `S` | Module-level test hook, a mutable singleton (P2-7); the decision tests inject time, IO or a clock through it |
| `W` | Feeds a `width-scan.spec.ts`, which the root instructions require for content renderers |
| `G` | Read by a guard spec the instructions require (`key-audit`, `locale-catalog`, `theme-contrast`) |
| `F` | Formatting or rounding rule; keep until the near-duplicates are merged (P2-9) |
| `C` | The real class a test subclasses or constructs as its fixture |
| `J`, `N`, `R` | Spelled out in the row (weak substring test; native clipboard path of P2-2; roadmap-owned key writer) |


| # | Export | Kind | Test refs | First test use | Verdict | Conf. | Reason |
| --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | `m/app/exit-epitaph.ts` `setExitEpitaphWriter` | function | 4 | m/t/app/exit-epitaph.spec.ts:15 | **keep** | medium | S |
| 2 | `m/app/exit-epitaph.ts` `armedEpitaph` | function | 5 | m/t/app/app.spec.ts:337 | **keep** | medium | S |
| 3 | `m/app/exit-epitaph.ts` `writeArmedEpitaph` | function | 4 | m/t/app/exit-epitaph.spec.ts:26 | **keep** | medium | S |
| 4 | `m/app/startup.ts` `MAYFLY_STARTUP_SERVICE` | const | 3 | m/t/app/startup.spec.ts:56 | **keep** | medium | K |
| 5 | `m/app/startup.ts` `MayflyStartupValues` | interface | 3 | m/t/app/startup.spec.ts:41 | **keep** | high | T |
| 6 | `m/conversation/activity-detail.ts` `LIVE_DETAIL_MAX_CHARS` | const | 3 | m/t/conversation/activity-detail.spec.ts:33 | **keep** | high | L |
| 7 | `m/conversation/activity-detail.ts` `REASONING_DETAIL_SCAN_CHARS` | const | 4 | m/t/conversation/activity-detail.spec.ts:52 | **keep** | high | L |
| 8 | `m/conversation/activity-detail.ts` `normalizeDetail` | function | 5 | m/t/conversation/activity-detail.spec.ts:31 | **keep** | high | P |
| 9 | `m/conversation/activity-detail.ts` `argumentDetail` | function | 3 | m/t/conversation/activity-detail.spec.ts:29 | **keep** | medium | P |
| 10 | `m/conversation/facts.ts` `conversationFactsSchema` | const | 7 | m/t/conversation/facts.spec.ts:68 | **keep** | medium | K |
| 11 | `m/conversation/facts.ts` `foldConversationFacts` | function | 92 | m/t/conversation/facts.spec.ts:52 | **keep** | high | P |
| 12 | `m/conversation/projection.ts` `conversationProjectionStateSchema` | const | 7 | m/t/conversation/projection.spec.ts:530 | **keep** | medium | K |
| 13 | `m/conversation/projection.ts` `initialConversationState` | function | 21 | m/t/conversation/admission.spec.ts:47 | **keep** | high | P |
| 14 | `m/conversation/projection.ts` `isTurnRetraction` | function | 10 | m/t/conversation/projection.spec.ts:354 | **keep** | high | P |
| 15 | `m/conversation/projection.ts` `foldConversationProjection` | function | 106 | m/t/conversation/projection.spec.ts:110 | **keep** | high | P |
| 16 | `m/core/chart-renderer.ts` `formatChartNumber` | function | 4 | m/t/core/chart-renderer.spec.ts:34 | **keep** | high | P |
| 17 | `m/core/chrome.ts` `framePanel` | function | 19 | m/t/core/chrome.spec.ts:5 | **delete** | medium | no production caller (chrome.ts:334, 46 lines; the surface head/tail in ui-patterns replaced it); 19 test uses and a width-scan entry keep dead code alive |
| 18 | `m/core/content-rows.ts` `charWrap` | function | 7 | m/t/core/content-rows.spec.ts:390 | **keep** | high | P |
| 19 | `m/core/content-rows.ts` `contentNodeRows` | function | 38 | m/t/core/content-rows.spec.ts:62 | **delete** | medium | one-line wrapper `virtualRows(contentNodeSource(...))` (content-rows.ts:1076) with no production caller; move to a tests helper, tests keep their assertions |
| 20 | `m/core/content-segments.ts` `CONTENT_CUT_UNITS` | const | 6 | m/t/core/content-segments.spec.ts:72 | **keep** | high | L |
| 21 | `m/core/context-hint-locale.ts` `CORE_CONTEXT_HINT_LOCALE` | const | 2 | m/t/locale-catalog.spec.ts:28 | **keep** | high | G |
| 22 | `m/core/context-hint-locale.ts` `HINT_MEMO_ENTRIES` | const | 2 | m/t/core/context-hint-locale.spec.ts:80 | **keep** | high | L |
| 23 | `m/core/frame-clamp.ts` `FrameOverflowEntry` | interface | 17 | m/t/core/frame-clamp.spec.ts:22 | **keep** | high | T |
| 24 | `m/core/glyphs.ts` `ASCII_GLYPHS` | const | 2 | m/t/core/glyphs.spec.ts:8 | **keep** | medium | K |
| 25 | `m/core/highlight.ts` `CodePaints` | interface | 2 | m/t/core/highlight.spec.ts:20 | **keep** | high | T |
| 26 | `m/core/index.ts` `MayflyUiImageBytes` | reexport | 1 | m/t/core/ui-image.spec.ts:24 | **keep** | high | T |
| 27 | `m/core/index.ts` `MayflyEditorShellCompilerOptions` | reexport | 1 | m/t/core/ui-compiler.spec.ts:184 | **keep** | high | T |
| 28 | `m/core/index.ts` `MayflyStatusCompilerOptions` | reexport | 1 | m/t/core/ui-compiler.spec.ts:167 | **keep** | high | T |
| 29 | `m/core/index.ts` `MayflyUiCompilerOptions` | reexport | 5 | m/t/core/ui-actions.spec.ts:33 | **keep** | high | T |
| 30 | `m/core/index.ts` `MayflyEscapeProcess` | reexport | 1 | m/t/core/terminal-escape.spec.ts:42 | **keep** | high | T |
| 31 | `m/core/keymap.ts` `actionOwner` | function | 2 | m/t/core/keymap.spec.ts:122 | **keep** | medium | P |
| 32 | `m/core/output-recovery.ts` `AmbientOutputStream` | interface | 4 | m/t/core/output-recovery.spec.ts:9 | **keep** | high | T |
| 33 | `m/core/presentation.ts` `monochromeColors` | function | 7 | m/t/core/presentation.spec.ts:50 | **keep** | high | P |
| 34 | `m/core/rich-document.ts` `MERMAID_MAX_SOURCE_BYTES` | const | 2 | m/t/core/rich-document.spec.ts:83 | **keep** | high | L |
| 35 | `m/core/rich-document.ts` `MERMAID_MAX_NON_EMPTY_LINES` | const | 2 | m/t/core/rich-document.spec.ts:84 | **keep** | high | L |
| 36 | `m/core/rich-document.ts` `MERMAID_MAX_GRAPH_NODES` | const | 2 | m/t/core/rich-document.spec.ts:91 | **keep** | high | L |
| 37 | `m/core/rich-document.ts` `MERMAID_MAX_LINE_CHARS` | const | 2 | m/t/core/rich-document.spec.ts:97 | **keep** | high | L |
| 38 | `m/core/surface-manager.ts` `SurfaceContribution` | interface | 3 | m/t/core/surface-manager.spec.ts:26 | **keep** | high | T |
| 39 | `m/core/surface-manager.ts` `SURFACE_TRANSCRIPT_MIN_COLUMNS` | const | 2 | m/t/core/surface-manager.spec.ts:251 | **keep** | high | L |
| 40 | `m/core/surface-manager.ts` `SURFACE_TRANSCRIPT_REOPEN_COLUMNS` | const | 2 | m/t/core/surface-manager.spec.ts:256 | **keep** | high | L |
| 41 | `m/core/surface-manager.ts` `allocateBottomRows` | function | 9 | m/t/core/surface-manager.spec.ts:152 | **keep** | high | P |
| 42 | `m/core/surface-manager.ts` `fitSurfaceRows` | function | 9 | m/t/core/surface-manager.spec.ts:55 | **keep** | high | P |
| 43 | `m/core/terminal-escape.ts` `loadTmuxClipboard` | function | 8 | m/t/core/terminal-escape.spec.ts:91 | **keep** | high | P |
| 44 | `m/core/terminal.ts` `measuredLaneRows` | function | 9 | m/t/core/terminal.spec.ts:2099 | **keep** | high | P |
| 45 | `m/core/terminal.ts` `wheelReport` | function | 5 | m/t/core/terminal.spec.ts:1961 | **keep** | high | P |
| 46 | `m/core/terminal.ts` `normalizeNavigationInput` | function | 10 | m/t/core/key-decoder.spec.ts:15 | **keep** | high | P |
| 47 | `m/core/terminal.ts` `normalizeFunctionKeyInput` | function | 7 | m/t/core/key-decoder.spec.ts:15 | **keep** | high | P |
| 48 | `m/core/terminal.ts` `joinSplitModifiers` | function | 2 | m/t/core/key-decoder.spec.ts:15 | **keep** | medium | P |
| 49 | `m/core/terminal.ts` `withJoinedModifiers` | function | 2 | m/t/core/key-decoder.spec.ts:82 | **keep** | medium | P |
| 50 | `m/core/terminal.ts` `createStableTuiReference` | function | 5 | m/t/core/terminal.spec.ts:2052 | **delete** | medium | its only production call passes `() => current` (terminal.ts:704), a constant, so the swap branch at :613-621 never runs; 5 tests exercise a hot swap that does not exist |
| 51 | `m/core/theme-ocean.ts` `OCEAN_COLORS` | const | 7 | m/t/core/theme-contrast.spec.ts:38 | **keep** | high | G |
| 52 | `m/core/theme-paper.ts` `PAPER_COLORS` | const | 6 | m/t/core/theme-contrast.spec.ts:39 | **keep** | high | G |
| 53 | `m/core/ui-actions.ts` `itemActionId` | function | 4 | m/t/core/ui-actions.spec.ts:60 | **delete** | medium | no caller; the same derivation is inlined at ui-actions.ts:55 and :66; either adopt it there or delete it with its 4 test uses |
| 54 | `m/core/ui-admission.ts` `ADMISSION_MIN_TRUNCATED` | const | 4 | m/t/core/ui-admission.spec.ts:42 | **keep** | high | L |
| 55 | `m/core/ui-admission.ts` `admitWidths` | function | 10 | m/t/core/ui-admission.spec.ts:15 | **keep** | high | P |
| 56 | `m/core/ui-admission.ts` `layoutBands` | function | 3 | m/t/core/ui-admission.spec.ts:52 | **keep** | medium | P |
| 57 | `m/core/ui-content-cache.ts` `MAYFLY_CONTENT_CACHE_BYTES` | const | 3 | m/t/core/content-rows.spec.ts:262 | **keep** | high | L |
| 58 | `m/core/ui-content-cache.ts` `MAYFLY_CONTENT_CACHE_KEEP` | const | 7 | m/t/core/ui-content-cache.spec.ts:36 | **keep** | high | L |
| 59 | `m/core/ui-focus-levels.ts` `LevelControl` | interface | 4 | m/t/core/ui-focus-levels.spec.ts:5 | **keep** | high | T |
| 60 | `m/core/ui-form-paint.ts` `FormFieldPaint` | interface | 4 | m/t/core/ui-form-paint.spec.ts:13 | **keep** | high | T |
| 61 | `m/core/ui-interaction-choice.ts` `visibleChoiceIndices` | function | 17 | m/t/core/ui-interaction-choice.spec.ts:19 | **keep** | low | no production caller (production reads the private `indexedVisibility`, ui-interaction-choice.ts:253); 17 assertions use it to observe the filter and tree decisions. Export `indexedVisibility` instead, or keep as the model read API |
| 62 | `m/core/ui-interaction-choice.ts` `decorateChoiceItem` | function | 3 | m/t/core/ui-interaction-choice.spec.ts:30 | **delete** | high | one-line `admittedListItem(...)!` (ui-interaction-choice.ts:278) whose comment says nothing is decorated; tests call `admittedListItem` |
| 63 | `m/core/ui-interaction-document.ts` `documentOffset` | function | 5 | m/t/core/ui-interaction-document.spec.ts:50 | **keep** | high | P |
| 64 | `m/core/ui-interaction-document.ts` `remapDocumentOffset` | function | 14 | m/t/core/ui-interaction-document.spec.ts:57 | **keep** | high | P |
| 65 | `m/core/ui-interaction-document.ts` `documentBlocks` | function | 7 | m/t/core/ui-image.spec.ts:338 | **keep** | high | P |
| 66 | `m/core/ui-interaction-document.ts` `documentBlockText` | function | 12 | m/t/core/ui-image.spec.ts:338 | **keep** | high | P |
| 67 | `m/core/ui-key-grammar.ts` `GrammarBinding` | interface | 2 | m/t/core/key-audit.spec.ts:86 | **keep** | high | T |
| 68 | `m/core/ui-list-segment.ts` `segmentStrip` | function | 7 | m/t/core/ui-list-segment.spec.ts:18 | **keep** | high | P |
| 69 | `m/core/ui-loader-animation.ts` `LOADER_MAX_FRAME_MS` | const | 2 | m/t/core/ui-loader-animation.spec.ts:104 | **keep** | high | L |
| 70 | `m/core/ui-loader-animation.ts` `LOADER_FRAMES` | const | 4 | m/t/core/ui-content-painters.spec.ts:40 | **delete** | high | three `toHaveLength` assertions restate the frame counts (ui-content-painters.spec.ts:40-42); `loaderFrameGlyph` is pinned by value |
| 71 | `m/core/ui-loader-animation.ts` `BREATH_LEVELS` | const | 2 | m/t/core/ui-content-painters.spec.ts:45 | **delete** | high | `toHaveLength(6)` restates the array (ui-content-painters.spec.ts:45); the `breathLevel` table test pins the values |
| 72 | `m/core/ui-loader-animation.ts` `loaderFrameGlyph` | function | 2 | m/t/core/ui-content-painters.spec.ts:43 | **keep** | medium | P |
| 73 | `m/core/ui-loader-animation.ts` `breathLevel` | function | 2 | m/t/core/ui-content-painters.spec.ts:44 | **keep** | medium | P |
| 74 | `m/core/ui-loader-animation.ts` `breathPaint` | function | 3 | m/t/core/ui-content-painters.spec.ts:59 | **keep** | medium | P |
| 75 | `m/core/ui-loader-animation.ts` `shimmerWindow` | function | 2 | m/t/core/ui-content-painters.spec.ts:64 | **keep** | medium | P |
| 76 | `m/core/ui-patterns.ts` `ListRenderExtras` | type | 4 | m/t/core/ui-list-paint.spec.ts:34 | **keep** | high | T |
| 77 | `m/core/ui-patterns.ts` `renderListSegment` | function | 13 | m/t/core/ui-patterns.spec.ts:191 | **delete** | high | thin wrapper over `segmentFooter` (ui-patterns.ts:279) that nothing in production calls; AGENTS forbids adapter facades; retarget its 13 test uses to `segmentFooter` |
| 78 | `m/core/ui-patterns.ts` `renderFormField` | function | 27 | m/t/core/ui-patterns.spec.ts:224 | **delete** | high | thin wrapper over `paintFormField` (ui-patterns.ts:283) that nothing in production calls (the compiler calls `paintFormField` at ui-compiler.ts:776); retarget its 27 test uses to `paintFormField` |
| 79 | `m/core/ui-prompt.ts` `placeholderLadder` | function | 5 | m/t/core/ui-prompt.spec.ts:46 | **keep** | high | P |
| 80 | `m/core/ui-prompt.ts` `pickPlaceholder` | function | 3 | m/t/core/ui-prompt.spec.ts:53 | **keep** | medium | P |
| 81 | `m/core/ui-prompt.ts` `paintTokenStrip` | function | 4 | m/t/core/ui-prompt.spec.ts:104 | **keep** | high | P |
| 82 | `m/core/ui-rows.ts` `materializedRows` | function | 15 | m/t/core/content-rows.spec.ts:74 | **keep** | medium | no production caller, but the only way to observe lazy materialization (the `meta` WeakMap is private); the laziness decision tests and W-budgets need it |
| 83 | `m/core/ui-stacks.ts` `ROW_STACK_ENTRIES` | const | 4 | m/t/core/ui-stacks.spec.ts:133 | **keep** | high | L |
| 84 | `m/core/ui-tabs-paint.ts` `TabsFocus` | interface | 3 | m/t/core/ui-tabs-paint.spec.ts:19 | **keep** | high | T |
| 85 | `m/core/ui-tabs-paint.ts` `RAIL_MIN_COLUMNS` | const | 2 | m/t/core/ui-tabs-paint.spec.ts:158 | **delete** | high | its only use is `expect(RAIL_MIN_COLUMNS).toBe(60)` (ui-tabs-paint.spec.ts:158), which restates the source |
| 86 | `m/core/ui-validator-content.ts` `SCROLL_HEIGHT_MAX` | const | 2 | m/t/core/ui-validator-content.spec.ts:91 | **keep** | high | L |
| 87 | `m/core/ui-validator-form.ts` `PATTERN_SOURCE_MAX` | const | 4 | m/t/core/ui-validator-form.spec.ts:47 | **keep** | high | L |
| 88 | `m/core/ui-validator-form.ts` `SUGGESTIONS_MAX` | const | 2 | m/t/core/ui-validator-form.spec.ts:57 | **keep** | high | L |
| 89 | `m/core/ui-validator-form.ts` `compilePattern` | function | 2 | m/t/core/ui-validator-form.spec.ts:70 | **keep** | medium | P |
| 90 | `m/core/ui-validator-prompt.ts` `MAYFLY_UI_MAX_PROMPT_TOKENS` | const | 3 | m/t/core/ui-validator-prompt.spec.ts:102 | **keep** | high | L |
| 91 | `m/core/ui-validator-prompt.ts` `MAYFLY_UI_MAX_PROMPT_TOKEN_TEXT` | const | 2 | m/t/core/ui-validator-prompt.spec.ts:94 | **keep** | high | L |
| 92 | `m/core/ui-validator-prompt.ts` `MAYFLY_UI_MAX_PROMPT_SYMBOL` | const | 3 | m/t/core/ui-validator-prompt.spec.ts:91 | **keep** | high | L |
| 93 | `m/core/ui-validator-prompt.ts` `MAYFLY_UI_MAX_PROMPT_LABEL` | const | 4 | m/t/core/ui-validator-prompt.spec.ts:92 | **keep** | high | L |
| 94 | `m/core/ui-validator-prompt.ts` `MAYFLY_UI_MAX_PROMPT_PLACEHOLDERS` | const | 2 | m/t/core/ui-validator-prompt.spec.ts:96 | **keep** | high | L |
| 95 | `m/core/ui-validator-prompt.ts` `MAYFLY_UI_MAX_PROMPT_PLACEHOLDER_TEXT` | const | 2 | m/t/core/ui-validator-prompt.spec.ts:95 | **keep** | high | L |
| 96 | `m/core/ui-validator.ts` `MAYFLY_UI_MAX_ITEM_BODY_NODES` | const | 4 | m/t/core/ui-validator.spec.ts:817 | **keep** | high | L |
| 97 | `m/core/views-lane.ts` `ViewsLaneHost` | interface | 5 | m/t/core/views-lane.spec.ts:20 | **keep** | high | T |
| 98 | `m/frontend/common-locale.ts` `COMMON_LOCALE` | const | 8 | m/t/interaction/commands-plugin.spec.ts:79 | **keep** | high | G |
| 99 | `m/interaction/agents-command.ts` `MayflySubagentTreeEntry` | type | 3 | m/t/interaction/agents-command.spec.ts:31 | **keep** | high | T |
| 100 | `m/interaction/agents-command.ts` `formatAgentElapsed` | function | 4 | m/t/interaction/agents-command.spec.ts:49 | **keep** | medium | F |
| 101 | `m/interaction/agents-command.ts` `agentMetricsText` | function | 9 | m/t/interaction/agents-command.spec.ts:52 | **keep** | high | P |
| 102 | `m/interaction/agents-command.ts` `agentTreeItems` | function | 2 | m/t/interaction/agents-command.spec.ts:75 | **keep** | medium | P |
| 103 | `m/interaction/agents-command.ts` `liveAgentDescendantCount` | function | 5 | m/t/interaction/agents-command.spec.ts:71 | **keep** | high | P |
| 104 | `m/interaction/attachments.ts` `FilesystemAttachmentStore` | class | 6 | m/t/interaction/attachments.spec.ts:55 | **keep** | high | C |
| 105 | `m/interaction/clipboard-write.ts` `setClipboardOsc52Emitter` | function | 29 | m/t/interaction/authorization-ui.spec.ts:13 | **keep** | medium | S |
| 106 | `m/interaction/editor-instance.ts` `hasEditorEnhancement` | const | 5 | m/t/interaction/editor-instance.spec.ts:67 | **delete** | medium | one-line facade over `ctx.mayflyPromptEditor.hasEnhancement` (editor-instance.ts:104); tests can ask the service |
| 107 | `m/interaction/editor-plus.ts` `ShellExecution` | interface | 3 | m/t/interaction/editor-plus.spec.ts:222 | **keep** | high | T |
| 108 | `m/interaction/external-editor.ts` `quoteShellArg` | function | 6 | m/t/interaction/external-editor.spec.ts:67 | **keep** | high | P |
| 109 | `m/interaction/external-editor.ts` `setExternalEditorLauncher` | function | 13 | m/t/interaction/external-editor.spec.ts:90 | **keep** | medium | S |
| 110 | `m/interaction/file-mention.ts` `MAX_FALLBACK_SUGGESTIONS` | const | 3 | m/t/interaction/editor-plus.spec.ts:1000 | **keep** | high | L |
| 111 | `m/interaction/jobs.ts` `isLiveJob` | function | 2 | m/t/interaction/jobs.spec.ts:585 | **keep** | medium | P |
| 112 | `m/interaction/jobs.ts` `sortJobs` | function | 3 | m/t/interaction/jobs.spec.ts:583 | **keep** | medium | P |
| 113 | `m/interaction/jobs.ts` `formatJobDuration` | function | 2 | m/t/interaction/jobs.spec.ts:579 | **keep** | medium | F |
| 114 | `m/interaction/jobs.ts` `jobItems` | function | 4 | m/t/interaction/jobs.spec.ts:586 | **keep** | high | W |
| 115 | `m/interaction/jobs.ts` `jobDetailsNode` | function | 4 | m/t/interaction/jobs.spec.ts:604 | **keep** | high | W |
| 116 | `m/interaction/jobs.ts` `JOB_OUTPUT_FEED_CHUNKS` | const | 3 | m/t/interaction/jobs.spec.ts:368 | **keep** | high | L |
| 117 | `m/interaction/jobs.ts` `jobOutputNode` | function | 7 | m/t/interaction/jobs.spec.ts:591 | **keep** | high | W |
| 118 | `m/interaction/keys.ts` `INTERACTION_KEY_ACTIONS` | const | 20 | m/t/core/key-audit.spec.ts:37 | **keep** | high | G |
| 119 | `m/interaction/keys.ts` `saveKeybinding` | function | 5 | m/t/interaction/keys.spec.ts:125 | **keep** | low | R: no production caller yet, but roadmap §2f/6f names them as the write half of the `/keys` panel (implementation-roadmap.md:1209); dead if 6f slips |
| 120 | `m/interaction/keys.ts` `resetKeybinding` | function | 2 | m/t/interaction/keys.spec.ts:127 | **keep** | low | R: no production caller yet, but roadmap §2f/6f names them as the write half of the `/keys` panel (implementation-roadmap.md:1209); dead if 6f slips |
| 121 | `m/interaction/keys.ts` `resetAllKeybindings` | function | 2 | m/t/interaction/keys.spec.ts:130 | **keep** | low | R: no production caller yet, but roadmap §2f/6f names them as the write half of the `/keys` panel (implementation-roadmap.md:1209); dead if 6f slips |
| 122 | `m/interaction/locale.ts` `INTERACTION_LOCALE` | const | 13 | m/t/core/key-grammar-docs.spec.ts:27 | **keep** | high | G |
| 123 | `m/interaction/mcp-commands.ts` `serverItems` | function | 3 | m/t/interaction/mcp-commands.spec.ts:118 | **keep** | medium | P |
| 124 | `m/interaction/mcp-commands.ts` `serverConfigNode` | function | 2 | m/t/interaction/mcp-commands.spec.ts:136 | **keep** | low | J: the test asserts a substring of `JSON.stringify(node)`: weak; convert to a scenario checkpoint or a width-scan entry, or drop |
| 125 | `m/interaction/mcp-commands.ts` `mcpServerNode` | function | 2 | m/t/interaction/mcp-commands.spec.ts:137 | **keep** | low | J: the test asserts a substring of `JSON.stringify(node)`: weak; convert to a scenario checkpoint or a width-scan entry, or drop |
| 126 | `m/interaction/mcp-servers.ts` `MCP_CLIENT_MODULE` | const | 4 | m/t/interaction/catalog-fixture.ts:17 | **keep** | medium | K |
| 127 | `m/interaction/mcp-servers.ts` `FIBER_PENDING` | const | 2 | m/t/interaction/mcp-servers.spec.ts:140 | **keep** | medium | K |
| 128 | `m/interaction/mcp-servers.ts` `FIBER_LOADING` | const | 2 | m/t/interaction/mcp-servers.spec.ts:141 | **keep** | medium | K |
| 129 | `m/interaction/mcp-servers.ts` `FIBER_ACTIVE` | const | 6 | m/t/interaction/catalog-fixture.ts:16 | **keep** | medium | K |
| 130 | `m/interaction/mcp-servers.ts` `FIBER_FAILED` | const | 5 | m/t/interaction/mcp-servers.spec.ts:118 | **keep** | medium | K |
| 131 | `m/interaction/mcp-servers.ts` `FIBER_DISPOSED` | const | 2 | m/t/interaction/mcp-servers.spec.ts:127 | **keep** | medium | K |
| 132 | `m/interaction/mcp-servers.ts` `FIBER_UNLOADING` | const | 2 | m/t/interaction/mcp-servers.spec.ts:126 | **keep** | medium | K |
| 133 | `m/interaction/mcp-servers.ts` `readSecretKeys` | function | 7 | m/t/interaction/mcp-servers.spec.ts:95 | **keep** | high | P |
| 134 | `m/interaction/mcp-servers.ts` `deriveMcpStatus` | function | 14 | m/t/interaction/mcp-servers.spec.ts:108 | **keep** | high | P |
| 135 | `m/interaction/model-commands.ts` `ModelListCache` | interface | 2 | m/t/interaction/model-commands.spec.ts:33 | **keep** | high | T |
| 136 | `m/interaction/models-dev.ts` `MODELS_DEV_URL` | const | 2 | m/t/interaction/models-dev.spec.ts:173 | **delete** | high | `toBe("https://models.dev/api.json")` restates the constant (models-dev.spec.ts:174): a change detector |
| 137 | `m/interaction/models-dev.ts` `setModelsDevFetch` | function | 9 | m/t/interaction/models-dev.spec.ts:42 | **keep** | medium | S |
| 138 | `m/interaction/models-dev.ts` `setModelsDevLoader` | function | 25 | m/t/interaction/model-commands.spec.ts:29 | **keep** | medium | S |
| 139 | `m/interaction/models-dev.ts` `buildIndex` | function | 20 | m/t/interaction/models-dev.spec.ts:45 | **keep** | high | P |
| 140 | `m/interaction/notifications.ts` `currentNotificationScope` | function | 3 | m/t/core/ui-interaction-notifications.spec.ts:162 | **keep** | medium | P |
| 141 | `m/interaction/paste-image-native.ts` `POWERSHELL_ARGS` | const | 2 | m/t/interaction/paste-image-native.spec.ts:353 | **delete** | medium | `expect(argv).toEqual(POWERSHELL_ARGS)` (paste-image-native.spec.ts:353) compares the constant to itself; pin the literal flags. Moot if the module is deleted (P2-3) |
| 142 | `m/interaction/paste-image-native.ts` `probeWindows` | function | 12 | m/t/interaction/paste-image-native.spec.ts:324 | **keep** | medium | N: the Website documents this path (features/editor.md:41) but nothing imports the module (P2-3): wire it in, do not delete the tests |
| 143 | `m/interaction/paste-image-native.ts` `parseClipboardClasses` | function | 7 | m/t/interaction/paste-image-native.spec.ts:228 | **keep** | medium | N: the Website documents this path (features/editor.md:41) but nothing imports the module (P2-3): wire it in, do not delete the tests |
| 144 | `m/interaction/paste-image-native.ts` `escapeAppleScriptString` | function | 4 | m/t/interaction/paste-image-native.spec.ts:248 | **keep** | medium | N: the Website documents this path (features/editor.md:41) but nothing imports the module (P2-3): wire it in, do not delete the tests |
| 145 | `m/interaction/paste-image-native.ts` `probeDarwin` | function | 29 | m/t/interaction/paste-image-native.spec.ts:436 | **keep** | medium | N: the Website documents this path (features/editor.md:41) but nothing imports the module (P2-3): wire it in, do not delete the tests |
| 146 | `m/interaction/paste-image.ts` `ClipboardBackendPolicy` | type | 1 | m/t/interaction/paste-image.spec.ts:514 | **keep** | high | T |
| 147 | `m/interaction/paste-image.ts` `ACTION_IMAGE_PASTE` | const | 6 | m/t/core/key-audit.spec.ts:23 | **keep** | high | G |
| 148 | `m/interaction/paste-image.ts` `setClipboardClock` | function | 3 | m/t/interaction/paste-image.spec.ts:103 | **keep** | medium | S |
| 149 | `m/interaction/paste-image.ts` `resetClipboardBackendCooldowns` | function | 2 | m/t/interaction/paste-image.spec.ts:104 | **keep** | medium | S |
| 150 | `m/interaction/plugin-market/catalog.ts` `MARKET_CACHE_TTL_MS` | const | 2 | m/t/interaction/plugin-market.spec.ts:146 | **keep** | high | L |
| 151 | `m/interaction/plugin-market/catalog.ts` `marketCachePath` | function | 16 | m/t/interaction/plugin-market.spec.ts:133 | **keep** | high | P |
| 152 | `m/interaction/preset-commands.ts` `presetItems` | function | 2 | m/t/interaction/preset-commands.spec.ts:85 | **keep** | medium | P |
| 153 | `m/interaction/prompt-submit-pipeline.ts` `applySubmitTransformers` | const | 15 | m/t/interaction/editor-instance.spec.ts:68 | **delete** | medium | one-line facade over `ctx.mayflyPromptSubmissions.apply` (prompt-submit-pipeline.ts:69); production uses `applyReversibleSubmitTransformers`; tests can call the service |
| 154 | `m/interaction/provider-account.ts` `accountInternals` | const | 40 | m/t/interaction/provider-account.spec.ts:128 | **keep** | medium | S |
| 155 | `m/interaction/provider-account.ts` `openerFor` | function | 4 | m/t/interaction/provider-account.spec.ts:468 | **keep** | high | P |
| 156 | `m/interaction/provider-account.ts` `openUrlInBrowser` | function | 2 | m/t/interaction/provider-account.spec.ts:515 | **keep** | medium | P |
| 157 | `m/interaction/provider-account.ts` `clientMetadata` | function | 2 | m/t/interaction/provider-account.spec.ts:554 | **keep** | medium | P |
| 158 | `m/interaction/provider-account.ts` `callbackOrigin` | function | 3 | m/t/interaction/provider-account.spec.ts:481 | **keep** | medium | P |
| 159 | `m/interaction/provider-account.ts` `parseCallbackLocation` | function | 8 | m/t/interaction/provider-account.spec.ts:295 | **keep** | high | P |
| 160 | `m/interaction/provider-account.ts` `accountPanelNode` | function | 11 | m/t/interaction/provider-account.spec.ts:490 | **keep** | high | W |
| 161 | `m/interaction/provider-account.ts` `GUIDE_CLOSE_DELAY_MS` | const | 3 | m/t/interaction/provider-account.spec.ts:230 | **keep** | high | L |
| 162 | `m/interaction/provider-add.ts` `ENDPOINT_PROTOCOLS` | const | 2 | m/t/interaction/provider-add.spec.ts:91 | **delete** | high | `toEqual` restates the constant (provider-add.spec.ts:91); the form behavior is tested through the add flow |
| 163 | `m/interaction/provider-onboarding.ts` `DEEPSEEK_KEY` | const | 9 | m/t/interaction/provider-onboarding.spec.ts:29 | **keep** | medium | K |
| 164 | `m/interaction/provider-onboarding.ts` `onboardingChoiceNode` | function | 3 | m/t/interaction/width-scan.spec.ts:315 | **keep** | high | W |
| 165 | `m/interaction/provider-onboarding.ts` `onboardingKeyNode` | function | 2 | m/t/interaction/width-scan.spec.ts:317 | **keep** | high | W |
| 166 | `m/interaction/provider-store.ts` `providerStoreInternals` | const | 32 | m/t/interaction/provider-fixture.ts:20 | **keep** | medium | S |
| 167 | `m/interaction/provider-store.ts` `providerOpsTarget` | function | 9 | m/t/interaction/provider-store.spec.ts:66 | **keep** | high | P |
| 168 | `m/interaction/provider-store.ts` `readHomeProviders` | function | 14 | m/t/interaction/provider-store.spec.ts:97 | **keep** | high | P |
| 169 | `m/interaction/provider-store.ts` `writeHomeProviders` | function | 6 | m/t/interaction/provider-store.spec.ts:98 | **keep** | high | P |
| 170 | `m/interaction/provider-store.ts` `restoreHome` | function | 3 | m/t/interaction/provider-store.spec.ts:107 | **keep** | medium | P |
| 171 | `m/interaction/provider-store.ts` `migrateProvidersToHome` | function | 6 | m/t/interaction/provider-store.spec.ts:179 | **keep** | high | P |
| 172 | `m/interaction/schedule-command.ts` `formatReminderFrequency` | function | 11 | m/t/interaction/native-features.spec.ts:79 | **keep** | high | P |
| 173 | `m/interaction/schedule-command.ts` `formatReminderLocalTime` | function | 1 | m/t/interaction/native-features.spec.ts:96 | **delete** | high | its only assertion is `typeof ... === "string"` (native-features.spec.ts:96); that decides nothing |
| 174 | `m/interaction/schedule-command.ts` `formatReminderRelative` | function | 9 | m/t/interaction/native-features.spec.ts:89 | **keep** | medium | F |
| 175 | `m/interaction/schedule-command.ts` `scheduleNode` | function | 4 | m/t/interaction/width-scan.spec.ts:320 | **keep** | high | W |
| 176 | `m/interaction/session-commands.ts` `sessionInfoFacts` | function | 6 | m/t/interaction/session-commands.spec.ts:35 | **keep** | high | P |
| 177 | `m/interaction/session-export.ts` `lastAssistantText` | function | 8 | m/t/interaction/session-export.spec.ts:4 | **keep** | high | P |
| 178 | `m/interaction/session-export.ts` `buildExportMarkdown` | function | 9 | m/t/interaction/session-export.spec.ts:4 | **keep** | high | P |
| 179 | `m/interaction/session-export.ts` `buildFullExportMarkdown` | function | 5 | m/t/interaction/session-export.spec.ts:82 | **keep** | high | P |
| 180 | `m/interaction/session-info-model.ts` `contextNode` | function | 8 | m/t/interaction/session-commands.spec.ts:136 | **keep** | low | J: the test asserts a substring of `JSON.stringify(node)`: weak; convert to a scenario checkpoint or a width-scan entry, or drop |
| 181 | `m/interaction/session-list-model.ts` `formatDuration` | function | 9 | m/t/interaction/session-list-model.spec.ts:109 | **keep** | medium | F |
| 182 | `m/interaction/session-list-model.ts` `formatAgo` | function | 6 | m/t/interaction/session-list-model.spec.ts:121 | **keep** | medium | F |
| 183 | `m/interaction/session-list-model.ts` `sessionSpan` | function | 7 | m/t/interaction/session-list-model.spec.ts:130 | **keep** | high | P |
| 184 | `m/interaction/session-workspaces-model.ts` `sessionWorkspaceId` | function | 7 | m/t/interaction/native-sessions.spec.ts:87 | **keep** | high | P |
| 185 | `m/interaction/settings-command.ts` `openSettingsNamespace` | function | 19 | m/t/interaction/settings-command.spec.ts:270 | **keep** | high | P |
| 186 | `m/interaction/skills-catalog.ts` `SkillsCatalogService` | class | 4 | m/t/interaction/fakes.ts:1114 | **keep** | high | C |
| 187 | `m/interaction/skills-catalog.ts` `__setCatalogForTest` | function | 24 | m/t/interaction/editor-plus.spec.ts:641 | **keep** | medium | S |
| 188 | `m/interaction/skills-command.ts` `skillGroup` | function | 4 | m/t/interaction/skills-command.spec.ts:130 | **keep** | high | P |
| 189 | `m/interaction/skills-command.ts` `skillsNode` | function | 3 | m/t/interaction/skills-command.spec.ts:133 | **keep** | low | J: the test asserts a substring of `JSON.stringify(node)`: weak; convert to a scenario checkpoint or a width-scan entry, or drop |
| 190 | `m/interaction/tools-commands.ts` `toolItems` | function | 2 | m/t/interaction/tools-commands.spec.ts:24 | **keep** | medium | P |
| 191 | `m/interaction/tools-commands.ts` `toolDetailNode` | function | 3 | m/t/interaction/tools-commands.spec.ts:26 | **keep** | low | J: the test asserts a substring of `JSON.stringify(node)`: weak; convert to a scenario checkpoint or a width-scan entry, or drop |
| 192 | `m/interaction/trace-command.ts` `tracePanelModel` | function | 3 | m/t/interaction/trace-command.spec.ts:38 | **keep** | low | J: the test asserts a substring of `JSON.stringify(node)`: weak; convert to a scenario checkpoint or a width-scan entry, or drop |
| 193 | `m/interaction/trace-command.ts` `traceDetailPanelModel` | function | 2 | m/t/interaction/trace-command.spec.ts:49 | **keep** | low | J: the test asserts a substring of `JSON.stringify(node)`: weak; convert to a scenario checkpoint or a width-scan entry, or drop |
| 194 | `m/interaction/trace-format.ts` `toTraceItem` | function | 3 | m/t/interaction/trace-format.spec.ts:53 | **delete** | medium | zero references in src, examples, script and website (only the declaration, trace-format.ts:78); `/trace` builds its `TraceItem`s another way, so this conversion and its 3 tests cover nothing that ships |
| 195 | `m/interaction/update-command.ts` `createUpdateProgressState` | function | 5 | m/t/interaction/update-command.spec.ts:267 | **keep** | high | P |
| 196 | `m/interaction/update-command.ts` `applyUpdateProgress` | function | 6 | m/t/interaction/update-command.spec.ts:268 | **keep** | high | P |
| 197 | `m/interaction/update-command.ts` `updatePanelModel` | function | 7 | m/t/interaction/update-command.spec.ts:269 | **keep** | low | J: the test asserts a substring of `JSON.stringify(node)`: weak; convert to a scenario checkpoint or a width-scan entry, or drop |
| 198 | `m/interaction/update-command.ts` `updatePanelSummary` | function | 6 | m/t/interaction/update-command.spec.ts:274 | **delete** | medium | zero references outside its declaration (update-command.ts:121); 6 tests pin a summary string no panel shows |
| 199 | `m/interaction/updater/check.ts` `UpdateCheckState` | interface | 2 | m/t/interaction/updater-check.spec.ts:318 | **keep** | high | T |
| 200 | `m/interaction/updater/check.ts` `updateCheckStatePath` | function | 2 | m/t/interaction/updater-check.spec.ts:89 | **keep** | medium | P |
| 201 | `m/interaction/updater/check.ts` `readUpdateCheckState` | function | 17 | m/t/interaction/updater-check.spec.ts:101 | **keep** | high | P |
| 202 | `m/interaction/updater/check.ts` `runUpdateCheck` | function | 24 | m/t/interaction/updater-check.spec.ts:92 | **keep** | high | P |
| 203 | `m/interaction/updater/preflight.ts` `DEFAULT_COOLDOWN_MINUTES` | const | 2 | m/t/interaction/updater-preflight.spec.ts:168 | **keep** | high | L |
| 204 | `m/interaction/updater/preflight.ts` `checkLinkPollution` | function | 4 | m/t/interaction/updater-preflight.spec.ts:53 | **keep** | high | P |
| 205 | `m/interaction/updater/preflight.ts` `checkSetConsistency` | function | 6 | m/t/interaction/updater-preflight.spec.ts:67 | **keep** | high | P |
| 206 | `m/interaction/updater/preflight.ts` `checkTargetExists` | function | 6 | m/t/interaction/updater-preflight.spec.ts:95 | **keep** | high | P |
| 207 | `m/interaction/updater/preflight.ts` `checkVersionFloor` | function | 5 | m/t/interaction/updater-preflight.spec.ts:118 | **keep** | high | P |
| 208 | `m/interaction/updater/preflight.ts` `checkHostLine` | function | 10 | m/t/interaction/update-command.spec.ts:279 | **keep** | high | P |
| 209 | `m/interaction/updater/preflight.ts` `checkCooldown` | function | 10 | m/t/interaction/update-command.spec.ts:275 | **keep** | high | P |
| 210 | `m/interaction/updater/preflight.ts` `checkDowngrade` | function | 6 | m/t/interaction/updater-preflight.spec.ts:238 | **keep** | high | P |
| 211 | `m/interaction/updater/registry.ts` `normalizePackument` | function | 20 | m/t/interaction/updater-preflight.spec.ts:26 | **keep** | high | P |
| 212 | `m/interaction/updater/swap.ts` `patchEntrySpecs` | function | 7 | m/t/interaction/updater-swap.spec.ts:217 | **keep** | high | P |
| 213 | `m/interaction/updater/swap.ts` `declaredRuntimeDeps` | function | 7 | m/t/interaction/updater-swap.spec.ts:243 | **keep** | high | P |
| 214 | `m/interaction/updater/swap.ts` `classifyInstallFailure` | function | 10 | m/t/interaction/update-command.spec.ts:278 | **keep** | high | P |
| 215 | `m/interaction/updater/swap.ts` `importSweepScript` | function | 2 | m/t/interaction/updater-swap.spec.ts:607 | **keep** | medium | P |
| 216 | `m/interaction/updater/swap.ts` `importSweepSmoke` | function | 5 | m/t/interaction/updater-swap.spec.ts:257 | **keep** | high | P |
| 217 | `m/interaction/updater/swap.ts` `bootSmoke` | function | 10 | m/t/interaction/updater-swap.spec.ts:277 | **keep** | high | P |
| 218 | `m/interaction/welcome.ts` `WELCOME_ID` | const | 5 | m/t/interaction/welcome.spec.ts:32 | **keep** | medium | K |
| 219 | `m/interaction/welcome.ts` `welcomeNode` | function | 5 | m/t/interaction/welcome.spec.ts:78 | **keep** | high | W |
| 220 | `m/transcript/banner-art.ts` `LOGO_COLS` | const | 21 | m/t/core/business-rendering-drift.spec.ts:53 | **keep** | medium | K |
| 221 | `m/transcript/banner-art.ts` `LOGO_GRADIENT` | const | 6 | m/t/transcript/banner-art.spec.ts:34 | **delete** | high | dead data: banner.ts imports `LOGO_ART` and `LOGO_ROWS` but not the gradient (banner.ts:40); its 6 test uses check a palette that is never painted |
| 222 | `m/transcript/banner.ts` `BANNER_MIN_WIDTH` | const | 5 | m/t/transcript/banner.spec.ts:107 | **keep** | high | L |
| 223 | `m/transcript/banner.ts` `DIRECTORY_LABEL` | const | 1 | m/t/transcript/banner.spec.ts:362 | **delete** | medium | the expected row is built from the constant itself (banner.spec.ts:362), so a wrong label cannot fail; pin the literal and drop the export |
| 224 | `m/transcript/banner.ts` `bannerLayout` | function | 10 | m/t/transcript/banner.spec.ts:105 | **keep** | high | W |
| 225 | `m/transcript/banner.ts` `shortenHome` | function | 12 | m/t/transcript/banner.spec.ts:86 | **keep** | high | W |
| 226 | `m/transcript/banner.ts` `BannerContent` | interface | 2 | m/t/transcript/banner.spec.ts:67 | **keep** | high | T |
| 227 | `m/transcript/banner.ts` `BannerDeps` | interface | 2 | m/t/transcript/banner.spec.ts:55 | **keep** | high | T |
| 228 | `m/transcript/banner.ts` `composeBannerLines` | function | 17 | m/t/transcript/banner.spec.ts:125 | **keep** | high | W |
| 229 | `m/transcript/child-agent-model.ts` `childIdOfResult` | function | 3 | m/t/transcript/child-agent-model.spec.ts:29 | **keep** | medium | P |
| 230 | `m/transcript/child-agent-model.ts` `correlateChild` | function | 6 | m/t/transcript/child-agent-model.spec.ts:31 | **delete** | medium | zero references outside its declaration (child-agent-model.ts:20); the model joins children through `childIdOfResult` directly |
| 231 | `m/transcript/child-agent-model.ts` `childLiveSnapshot` | function | 3 | m/t/transcript/child-agent-model.spec.ts:40 | **keep** | medium | P |
| 232 | `m/transcript/compaction.ts` `CompactionTimers` | interface | 2 | m/t/transcript/compaction.spec.ts:25 | **keep** | high | T |
| 233 | `m/transcript/compaction.ts` `setCompactionTimers` | function | 7 | m/t/transcript/compaction.spec.ts:43 | **keep** | medium | S |
| 234 | `m/transcript/components.ts` `TOOL_PREVIEW_SCAN_MAX_CHARS` | const | 5 | m/t/transcript/components.spec.ts:570 | **keep** | high | L |
| 235 | `m/transcript/components.ts` `TOOL_EXPANDED_RENDER_LINES` | const | 2 | m/t/transcript/components.spec.ts:587 | **keep** | high | L |
| 236 | `m/transcript/components.ts` `MESSAGE_INDENT` | const | 1 | m/t/transcript/components.spec.ts:331 | **delete** | high | named only in a test title (components.spec.ts:331), never imported; drop the export |
| 237 | `m/transcript/index.ts` `ACTION_TOGGLE_COLLAPSE` | const | 7 | m/t/core/key-audit.spec.ts:24 | **keep** | high | G |
| 238 | `m/transcript/index.ts` `ProcessRowTimers` | reexport | 1 | m/t/transcript/process-rows.spec.ts:21 | **keep** | high | T |
| 239 | `m/transcript/official-model.ts` `liveDraftsOf` | function | 4 | m/t/transcript/live-overlay.spec.ts:282 | **delete** | medium | zero references outside its declaration (official-model.ts:37); the tests build the source with it, production does not |
| 240 | `m/transcript/pane-activity.ts` `ActivityTimers` | interface | 1 | m/t/transcript/pane-activity.spec.ts:39 | **keep** | high | T |
| 241 | `m/transcript/pane-activity.ts` `setActivityTimers` | function | 11 | m/t/transcript/pane-activity.spec.ts:67 | **keep** | medium | S |
| 242 | `m/transcript/pane-activity.ts` `setActivityClock` | function | 6 | m/t/transcript/pane-activity.spec.ts:68 | **keep** | medium | S |
| 243 | `m/transcript/pane-agents.ts` `PANE_TICK_MS` | const | 3 | m/t/transcript/pane-agents.spec.ts:410 | **keep** | high | L |
| 244 | `m/transcript/pane-agents.ts` `setPaneAgentsClock` | function | 5 | m/t/transcript/pane-agents.spec.ts:32 | **keep** | medium | S |
| 245 | `m/transcript/pane-todo.ts` `ACTION_TOGGLE_TODO` | const | 8 | m/t/core/key-audit.spec.ts:25 | **keep** | high | G |
| 246 | `m/transcript/pane-todo.ts` `selectVisibleTodos` | function | 9 | m/t/transcript/pane-todo.spec.ts:4 | **keep** | high | P |
| 247 | `m/transcript/pane-todo.ts` `formatHiddenCounts` | function | 3 | m/t/transcript/pane-todo.spec.ts:155 | **keep** | medium | P |
| 248 | `m/transcript/pane-todo.ts` `TodoState` | interface | 1 | m/t/transcript/pane-todo.spec.ts:521 | **keep** | high | T |
| 249 | `m/transcript/pane-todo.ts` `todoNode` | function | 3 | m/t/transcript/pane-todo.spec.ts:523 | **keep** | medium | P |
| 250 | `m/transcript/pane-workflow.ts` `WorkflowRunState` | interface | 2 | m/t/transcript/width-scan.spec.ts:405 | **keep** | high | T |
| 251 | `m/transcript/pane-workflow.ts` `setWorkflowPaneTimers` | function | 3 | m/t/transcript/pane-workflow.spec.ts:26 | **keep** | medium | S |
| 252 | `m/transcript/pane-workflow.ts` `formatWorkflowElapsed` | function | 5 | m/t/transcript/pane-workflow.spec.ts:101 | **keep** | medium | F |
| 253 | `m/transcript/pane-workflow.ts` `workflowNode` | function | 8 | m/t/transcript/pane-workflow.spec.ts:105 | **keep** | high | W |
| 254 | `m/transcript/process-groups.ts` `memberFacts` | function | 9 | m/t/transcript/process-groups.spec.ts:176 | **keep** | high | P |
| 255 | `m/transcript/process-rows.ts` `TURN_CLOCK_INTERVAL_MS` | const | 5 | m/t/transcript/process-rows.spec.ts:73 | **keep** | high | L |
| 256 | `m/transcript/session-facts.ts` `CHILD_VOLATILE_MS` | const | 5 | m/t/transcript/session-facts.spec.ts:365 | **keep** | high | L |
| 257 | `m/transcript/session-facts.ts` `projectChildSessionFacts` | function | 18 | m/t/transcript/session-facts.spec.ts:105 | **keep** | high | P |
| 258 | `m/transcript/status-context.ts` `contextPercent` | function | 9 | m/t/transcript/status-context.spec.ts:32 | **keep** | medium | F |
| 259 | `m/transcript/status-context.ts` `cachePercent` | function | 9 | m/t/transcript/status-context.spec.ts:77 | **keep** | medium | F |
| 260 | `m/transcript/status-git.ts` `BRANCH_TTL_MS` | const | 3 | m/t/transcript/status-git.spec.ts:140 | **keep** | high | L |
| 261 | `m/transcript/status-git.ts` `STATUS_TTL_MS` | const | 2 | m/t/transcript/status-git.spec.ts:282 | **keep** | high | L |
| 262 | `m/transcript/status-git.ts` `STATUS_RETRY_MS` | const | 2 | m/t/transcript/status-git.spec.ts:330 | **keep** | high | L |
| 263 | `m/transcript/status-git.ts` `GitBadgeStatus` | interface | 3 | m/t/transcript/status-git.spec.ts:65 | **keep** | high | T |
| 264 | `m/transcript/status-git.ts` `GitCommandRunner` | type | 1 | m/t/transcript/status-git.spec.ts:51 | **keep** | high | T |
| 265 | `m/transcript/status-git.ts` `setGitCommandRunner` | function | 20 | m/t/transcript/status-git.spec.ts:29 | **keep** | medium | S |
| 266 | `m/transcript/status-git.ts` `setGitClock` | function | 20 | m/t/transcript/status-git.spec.ts:30 | **keep** | medium | S |
| 267 | `m/transcript/status-git.ts` `setGitStatusTimers` | function | 2 | m/t/transcript/status-git.spec.ts:31 | **keep** | medium | S |
| 268 | `m/transcript/status-git.ts` `createGitBadgeCache` | function | 1 | m/t/transcript/status-git.spec.ts:97 | **keep** | medium | P |
| 269 | `m/transcript/status-git.ts` `formatGitBadge` | function | 10 | m/t/transcript/status-git.spec.ts:5 | **keep** | high | P |
| 270 | `m/transcript/status-goal.ts` `goalStatusText` | function | 11 | m/t/transcript/status-goal.spec.ts:47 | **keep** | high | W |
| 271 | `m/transcript/status-jobs.ts` `liveJobCount` | function | 3 | m/t/transcript/status-jobs.spec.ts:48 | **keep** | medium | P |
| 272 | `m/transcript/tool-line.ts` `TOOL_LINE_EXPANDED_ROWS` | const | 3 | m/t/transcript/tool-line.spec.ts:104 | **keep** | high | L |
| 273 | `m/transcript/transcript-model.ts` `FOLLOW_NOTICE_INTERVAL_MS` | const | 2 | m/t/transcript/transcript-model.spec.ts:638 | **keep** | high | L |
| 274 | `ui/contracts.ts` `MayflySnapshotProvider` | type | 7 | ui/t/provider.spec.ts:14 | **keep** | high | T |
| 275 | `ui/contracts.ts` `MayflyEditorSubmitValue` | interface | 10 | m/t/interaction/editor-extension-runtime.spec.ts:443 | **keep** | high | T |
| 276 | `ui/index.ts` `MayflyDecisionPanelProps` | reexport | 1 | ui/t/ui.compile.ts:251 | **keep** | high | T |
| 277 | `ui/index.ts` `MayflyRailPanelProps` | reexport | 1 | ui/t/ui.compile.ts:252 | **keep** | high | T |
| 278 | `ui/index.ts` `MayflySplitViewProps` | reexport | 1 | ui/t/ui.compile.ts:253 | **keep** | high | T |
| 279 | `ui/index.ts` `MayflyStatusPageProps` | reexport | 1 | ui/t/ui.compile.ts:254 | **keep** | high | T |
| 280 | `ui/interaction.ts` `MayflyUiObservationHandler` | type | 4 | ui/t/interaction-provider.spec.ts:26 | **keep** | high | T |

## Appendix B: duplicated bodies in product code

From the scan of 2,328 functions in `packages/*/src` and `examples` (method in 5b). `m/` is `packages/mayfly/src/`, `ui/` is
`packages/ui/src/`, `cli/` is `packages/cli/src/`. Listed as the scan printed them; the assessment of the ones that matter is in 5b.

| Tokens | Same body (alpha-renamed identifiers, literals kept) |
| --- | --- |
| 170 | `m/interaction/locale.ts:721 observeInteractionLocale`; `m/transcript/locale.ts:187 observeTranscriptLocale` |
| 146 | `m/core/content-rows.ts:156 segmentRows`; `m/core/content-rows.ts:313 chunkRows` |
| 86 | `m/core/surface-renderer.ts:397 schedulePane`; `m/core/surface-renderer.ts:498 scheduleOverlay` |
| 86 | `m/interaction/plugin-market/installer.ts:429 readInstalledVersion`; `m/interaction/updater/profile.ts:110 readInstalledVersion` |
| 73 | `m/core/content-rows.ts:185 row`; `m/core/content-rows.ts:342 row` |
| 71 | `m/interaction/usage.ts:57 usagePercent`; `m/transcript/status-context.ts:84 contextPercent` |
| 66 | `ui/services.ts:354 list`; `ui/services.ts:539 list`; `ui/services.ts:579 list` |
| 61 | `m/interaction/plugin-commands.ts:367 report`; `m/interaction/plugin-commands.ts:502 report` |
| 56 | `m/core/ui-validator.ts:243 optionalLabel`; `m/core/ui-validator.ts:248 optionalId` |
| 55 | `m/transcript/read-group.ts:117 render`; `m/transcript/search-group.ts:66 render` |
| 47 | `m/transcript/session-facts.ts:178 subscribeGoal`; `m/transcript/session-facts.ts:185 subscribeAgent` |
| 45 | `m/core/surface-renderer.ts:201 dispose`; `m/core/surface-renderer.ts:245 dispose` |
| 45 | `m/interaction/updater/io.ts:73 childEnv`; `cli/internals.ts:94 childEnv` |
| 42 | `m/core/surface-manager.ts:128 fit`; `m/core/ui-patterns.ts:79 fit` |
| 38 | `m/conversation/live-stream.ts:97 subscribe`; `m/core/keymap.ts:334 subscribe`; `m/interaction/editor-instance.ts:60 subscribeEditorState` |
| 38 | `m/interaction/updater/profile.ts:39 dshHome`; `cli/calibrate.ts:100 dshHome` |
| 37 | `m/core/content-segments.ts:69 segmentLines`; `m/core/content-segments.ts:74 segmentText` |
| 37 | `m/interaction/session-info-model.ts:28 field`; `m/interaction/session-list-model.ts:182 field` |
| 36 | `ui/services.ts:487 close`; `ui/services.ts:494 focus` |
| 35 | `m/core/ui-validator-content.ts:39 present`; `m/core/ui-validator-form.ts:22 present`; `m/core/ui-validator-prompt.ts:38 present`; `m/core/ui-validator-tabs.ts:12 present` |
| 35 | `m/transcript/transcript-model.ts:861 refreshPresentationPolicy`; `m/transcript/transcript-model.ts:867 refreshLocale` |
| 34 | `m/transcript/command-group.ts:48 setScope`; `m/transcript/read-group.ts:105 setScope`; `m/transcript/search-group.ts:51 setScope`; `m/transcript/tool-line.ts:119 setScope` |
| 33 | `m/transcript/official-model.ts:166 firstNonEmptyLine`; `m/transcript/official-model.ts:284 lastNonEmptyLine` |
| 32 | `ui/services.ts:250 dispose`; `ui/services.ts:408 dispose` |
| 30 | `m/transcript/compaction.ts:174 stopTimer`; `m/transcript/process-rows.ts:117 stop` |
| 28 | `m/interaction/session-commands.ts:98 schedule`; `m/interaction/tools-commands.ts:108 schedule` |
| 22 | `m/transcript/conversation-feed.ts:107 take`; `m/transcript/conversation-feed.ts:150 take` |
| 19 | `m/interaction/clipboard-write.ts:102 setClipboardTextWriter`; `m/interaction/clipboard-write.ts:118 setClipboardOsc52Emitter`; `m/interaction/editor-plus.ts:97 setShellExecutor`; `m/interaction/external-editor.ts:95 setExternalEditorLauncher`; `m/interaction/paste-image.ts:150 setClipboardClock`; `m/transcript/compaction.ts:53 setCompactionTimers`; `m/transcript/pane-activity.ts:122 setActivityTimers`; `m/transcript/pane-workflow.ts:64 setWorkflowPaneTimers`; `m/transcript/process-rows.ts:42 setProcessRowTimers`; `m/transcript/status-git.ts:113 setGitCommandRunner`; `m/transcript/status-git.ts:142 setGitStatusTimers` |

| Tokens | Same shape (identifiers and literals masked) |
| --- | --- |
| 65 | `m/interaction/session-export.ts:208 buildExportMarkdown`; `m/interaction/session-export.ts:442 buildFullExportMarkdown` |
| 57 | `m/core/ui-validator.ts:307 pageSegment`; `m/core/ui-validator.ts:1036 chartPoint` |
| 56 | `m/interaction/session-export.ts:248 contentText`; `m/interaction/session-export.ts:256 reasoningText` |
| 51 | `m/transcript/command-group.ts:63 render`; `m/transcript/tool-line.ts:126 render` |
| 36 | `m/core/ui-validator.ts:1631 validateMayflyUiNode`; `m/core/ui-validator.ts:1636 validateMayflyStatusNode`; `m/core/ui-validator.ts:1641 validateMayflyEditorShellNode` |
| 34 | `ui/builders.ts:211 spacer`; `ui/builders.ts:215 divider` |
| 31 | `m/interaction/questionnaire.ts:11 address`; `m/interaction/questionnaire.ts:12 selection` |
| 31 | `ui/builders.ts:175 surface`; `ui/builders.ts:183 tabs`; `ui/builders.ts:187 list`; `ui/builders.ts:191 form`; `ui/builders.ts:195 actions`; `ui/builders.ts:199 loader`; `ui/builders.ts:203 empty`; `ui/builders.ts:207 progress`; `ui/builders.ts:219 image`; `ui/builders.ts:223 prompt` |
| 27 | `m/transcript/official-model.ts:118 isCommandTool`; `m/transcript/official-model.ts:123 isEditTool` |

| Jaccard (5-gram shingles) | Near-duplicate pair |
| --- | --- |
| 0.99 (90/89 tokens) | `m/interaction/clipboard-probe.ts:150 failureDetail` and `m/interaction/paste-image.ts:202 failureDetail` |
| 0.99 (163/162 tokens) | `m/interaction/clipboard-probe.ts:174 readCopiedImage` and `m/interaction/paste-image.ts:267 readCopiedImage` |
| 0.93 (73/80 tokens) | `m/core/ui-validator.ts:1043 chartSeries` and `m/core/ui-validator.ts:1057 barSeries` |
| 0.88 (123/126 tokens) | `m/interaction/session-export.ts:76 extractToolHint` and `m/transcript/present.ts:158 extractKeyArgument` |
| 0.88 (71/64 tokens) | `m/interaction/usage.ts:57 usagePercent` and `m/transcript/status-context.ts:98 cachePercent` |
| 0.88 (71/64 tokens) | `m/transcript/status-context.ts:84 contextPercent` and `m/transcript/status-context.ts:98 cachePercent` |
| 0.86 (104/113 tokens) | `m/core/ui-patterns.ts:358 formatElapsedMs` and `m/transcript/agent-presentation.ts:43 compactElapsedSeconds` |
| 0.85 (85/85 tokens) | `m/core/theme-palette.ts:21 foregroundColor` and `m/core/theme-palette.ts:33 backgroundColor` |
| 0.85 (61/60 tokens) | `m/core/ui-interaction-state.ts:79 subscribe` and `m/interaction/skills-catalog.ts:87 subscribe` |
| 0.81 (64/60 tokens) | `ui/services.ts:237 set` and `ui/services.ts:383 set` |
| 0.71 (198/202 tokens) | `m/transcript/read-group.ts:126 renderTree` and `m/transcript/search-group.ts:75 renderTree` |

The specs (`packages/*/tests`) have 45 exact groups, led by `createRuntime` and `fixture` (462 and 336 tokens) copied between
`plugin-surface-bridge-pane.spec.ts` and `views-lane-renderer.spec.ts`, `sourceFiles` in two guard specs, `expectDeepFrozen` in two ui specs,
and `effect`/`deferred` in three surface specs. That is the report's T10 (copied test helpers) with exact line numbers; the
scan did not look for the `identity`/`flush`/`plain` copies T10 counts, which are shorter than 120 characters.

## Appendix C: reproduction inputs

The scripts are in the audit session's scratchpad and are not committed. Each ran with Node 24.21.0 from outside the repository,
importing sources with `--experimental-transform-types` and the pinned packages from the main checkout's `node_modules`.

| Used by | Input |
| --- | --- |
| P2-1, F10 | Reads the regex literals `ANSI_OR_OSC`/`UNSAFE_CONTROLS` from `plugin-view.ts` and `TERMINAL_SEQUENCE`/`UNSAFE_CONTROLS` from `ui-validator.ts` out of the source text, applies `text.replace(seq, '').replace(controls, '')` to seven strings: an OSC 8 hyperlink pair with labels, two OSC titles around `KEEP THIS`, an ST-terminated OSC followed by text and a BEL, a kitty APC string, a DCS string, an 8-bit CSI, an 8-bit OSC |
| P2-4 | The real `ProcessTerminal` and `TuiAltScreen(terminal)`, `createOutputRecovery(terminal, { stdout: process.stdout, stderr: process.stderr }, () => repaints++)`, `activate()`; then `tui.showOverlay({ render: () => ['x'], invalidate() {} }, {})`, `handle.hide()`, `terminal.write('\x1b[?25h')`, and in a second script `terminal._kittyProtocolActive = true; await terminal.drainInput(5, 1)` |
| P2-5 | `startMayflyTerminal(term, async () => undefined, undefined, { record() {}, dispose: async () => {} }, 'alternate')` with `term` a `FakeTerminal` whose `drainInput` waits 100 ms; two `runtime.stop()` calls in a row, timing each |
| P2-3 | A Cordis root `Context`; a plugin whose async `apply` awaits 50 ms, sets `terminalRunning = true`, then calls `ctx.effect` twice (the second registers the stop); `fiber.dispose()` at 10 ms |
| F8, P2-3 | A root `Context` with `class Agents extends Service` registered as `agents`; a plugin with `inject: ['agents']` that captures its `ctx`; `fiber.dispose()`; then `ctx.agents.get(1)`, `ctx.get('agents')`, `ctx.effect(...)`, `ctx.on(...)`, `ctx.emit('custom/event')` |
| F8, P2-6 | A plugin registering effects A, B, C, a child plugin with its own effect, and D, in that order, recording the order in which the disposers run; a second run with an async 100 ms parent disposer beside a child disposer |
| P2-8 | `new UiNotificationStore(() => {})`; `report('n1', { owner: 'o', scope: { kind: 'surface', id: 's' } }, { severity: 'success', message: 'saved' })`; `handle('n1')`; `setVisible(false)`; `setVisible(true)`; read `timers.size` and `get('n1').state` after each step |
| P2-2 | Import graph over `packages/*/src/**/*.ts`: entries are the files named by each manifest's `exports`, `bin` and `main` (`./lib/x.js` to `src/x.ts`); edges are static `import`/`export ... from` and literal `import()`; prints the files never reached |
| 5a | `exports.mjs` of the first pass on this tree (1,945 exports, 280 test-only); a second scan adds the declaration kind, the uses in the export's own file with comments stripped, and the first test line that mentions it |
| 5b | TypeScript scanner over `FunctionDeclaration`, `MethodDeclaration` and arrow-function constants of 120 characters or more; tokens with identifiers renamed by first occurrence (`v0`, `v1`, ...); SHA-1 of the token list with and without literals masked; near pairs by Jaccard of 5-token shingles at 0.7 or more, among functions of 60 tokens or more |
| 5c | For each file directly in `script/`, the number of other files in the repository (excluding `.git`, `node_modules`, `lib`, `.artifacts`, `golden`, `frames`) that contain its file name, grouped by `package.json`, workflows, other scripts, tests and docs |
| Item 6 | `rsync -a --exclude .git --exclude .artifacts --exclude node_modules ~/dev/mayfly/ <scratch>/`, `cp -al node_modules`, then the AST remover over the 17 statements of set A (a whole statement per site, from the bottom of each file up) and the table edit of A5, `vitest run --coverage --reporter=json`, `node --test script/tests/*.test.mjs` on a `git init` copy of the baseline and of the removed tree, `tsc -p tsconfig.tests.json --noEmit` |
