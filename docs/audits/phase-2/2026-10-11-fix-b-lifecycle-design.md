# Audit fix B: terminal lifecycle, sanitizer and notification correctness — fix design

Design date: 2026-10-11. Issue: #7. Baseline: `main` at `7bb476a` (audit-1 merged). Status: **implemented**, merged as
PR #14 (`9edaa44`); its commits cite R1 to R6 as shipped. This document changed no product code; the
implementation followed the slicing in section 8.

Sources: [Part 2](2026-10-11-phase-2-audit-part2.md) (P2-1, P2-3 to P2-6, P2-8, "F8 and F10 traced to the end"), the
[audit report](2026-10-11-phase-2-audit.md) (F8, F10, F12) and its "Fix slices". The reports' "Fix direction" lines are
hints; this document re-reads the code and chooses.

## 1. Result

The eight items reduce to six root causes. Each is fixed once, in the place that owns it, instead of patching its
symptoms.

| # | Root cause | Items | Fix in one line |
| --- | --- | --- | --- |
| R1 | The terminal's lifetime has no single owner and no single release | P2-3, P2-5, P2-6 | Register the owner before acquiring, start synchronously after the last `await`, one memoized `stop()`, delete the process-global release path |
| R2 | The output guard assumes all renderer output passes `terminal.write` | P2-4 | A `Terminal` facade that marks every output-producing method as renderer-owned |
| R3 | "Terminal text to strip" is defined in more than one place | P2-1, F10 | One grammar in `core/escape-sequences.ts`; admission, paint and scanners all use it |
| R4 | Locale is a paint input for node slots but not for panes and overlays | F12 | The compiler's frame inputs include a locale revision, the way they include the keymap revision |
| R5 | The `handled` notification state has no producer, no reader and no meaning | P2-8 | Delete it (owner decision) |
| R6 | Async work started under a Fiber does not check the Fiber when it resumes | F8 | A liveness flag owned by the Fiber, checked by the startup chain |

Re-check against `7bb476a`: every item still holds. Four findings are wider than the reports say (marked **wider**
below). Nothing here was executed as a repro; section 9 names the test that must fail on `7bb476a` and pass after.

| Item | Status on `7bb476a` |
| --- | --- |
| P2-1 | Holds, **wider**: `content-rows.ts:684` (`ANSI_AT`) has the same greedy OSC arm |
| P2-3 | Holds by code reading and the report's model; the real `apply` was not driven |
| P2-4 | Holds, **wider**: pi-tui writes straight to `process.stdout` from about ten `Terminal` methods, not only the two the report named |
| P2-5 | Holds. `createTerminalRelease` has no production caller and dsh does not need one (section 2) |
| P2-6 | Holds, **wider**: Cordis does not dispose sibling effects in a serial order at all (section 2) |
| P2-8 | Holds, **wider**: `handle()` has no production caller and no renderer reads `state` (section 6) |
| F12 | Holds as reported |
| F8 | Holds as reported; minor |

## 2. Terminal lifetime (R1: P2-3, P2-5, P2-6)

### What the code does

`core/index.ts:157-199` (`apply`) awaits `startMayflyTerminal` (line 159). That function awaits the background probe
(`terminal.ts:970`, bounded to 200 ms) and then, with no further `await`, starts the TUI: raw mode, alternate screen
(`terminal.ts:971`). `apply` then registers plugins and effects, and registers the effect that stops the terminal last
(line 198). `terminal.ts:1202-1231` is `stop()`; `terminal.ts:645` is `createTerminalRelease`; `terminal.ts:636` is the
module-level `activeRuntime` they share.

Facts established from the pinned sources:

- Cordis refuses `ctx.effect` and `ctx.plugin` on a Fiber that was disposed (`INACTIVE_EFFECT`,
  `cordis/lib/index.js:1131, 1171`). A Fiber disposed during the probe lets the terminal start and then fails
  registration, so nothing ever stops it (P2-3).
- Cordis `_unload` (`cordis/lib/index.js:1373`) starts all of a Fiber's top-level disposables **concurrently**, in
  reverse insertion order, and waits for all of them. Only disposables created *inside one* `effect()` run serially
  and awaited (`effect`, lines 1175-1183). So "the terminal stops last" cannot be expressed by registration order; the
  comment at `core/index.ts:150-153` is wrong not only in direction (P2-6) but in kind.
- dsh's own paths all go through the Fiber. Its fail-loud release is
  `installFailLoud(NAME, process, async () => { await app.current?.fiber.dispose() })`, and SIGTERM/SIGINT call
  `shutdown.interrupt`, which runs `app.current?.fiber.dispose()` and then exits
  (`dsh/lib/profile-boot-BZ2ZjNWi.js`, `createProcessShutdown` and the `installFailLoud` call). The Fiber effect is
  therefore already the only release path. `createTerminalRelease` would be a second caller of `stop()` that nothing
  needs.

### Design

1. **Owner first.** `apply` registers one effect before it acquires anything. Its disposer sets `disposed = true`
   and stops the runtime if one exists.
2. **Probe, check, start.** `apply` awaits the background probe itself, then checks `disposed`, then calls a
   **synchronous** `startMayflyTerminal`. Between acquiring the tty and being owned there is no `await`, so the window of
   P2-3 does not exist, and a throw anywhere later in `apply` is cleaned up by the already-registered effect (a throwing
   `apply` disposes the effects it registered).

   ```ts
   let runtime: MayflyTerminalRuntime | undefined
   let disposed = false
   ctx.effect(() => () => { disposed = true; return runtime?.stop() })
   const background = backgroundFromRgb(await probeTerminalBackground())
   if (disposed) return                       // unloaded during the probe: nothing was started
   runtime = startMayflyTerminal(terminal, { background, … })
   ```

3. **`startMayflyTerminal` becomes synchronous and loses its `probe` parameter.** The probe is the only `await` in it.
   Callers pass the probed `background`. This is an incompatible signature change by design (repository rule: no
   shim); it updates `core/index.ts`, `tests/core/terminal.spec.ts` (79 uses), `tests/e2e-boot.ts`,
   `tests/perf/frame-workloads.ts`, `key-decoder.spec.ts`, `overlay-arm.spec.ts` and
   `plugin-surface-bridge-overlay.spec.ts`. The migration is mechanical (`await start(t, probe, …)` becomes
   `start(t, { background, … })`).
4. **One memoized `stop()` (P2-5).** `stop()` returns `stopping ??= teardown()`. A second caller receives the first
   caller's promise and so settles when the terminal is restored, as the interface documents. The suspended branch and
   the normal branch merge into one `teardown()` that, in order: marks stopped; deactivates the output guard; if not
   suspended, drains input and stops the TUI; removes the four input listeners; disposes the overflow sink. Today a
   throwing `current.stop()` skips the listener removal and the sink disposal (Part 2, lifecycle table); one sequence with
   `try`/`finally` around the TUI stop removes that too.
5. **`suspend()` re-checks `stopped` after its `setImmediate` beat**, before it runs `fn` (the narrow window Part 2
   traced). Its resume guard becomes `!stopped`.
6. **Delete `createTerminalRelease`, `activeRuntime` and the `core/index.ts:50` export (P2-5, the decision this issue
   owns).** The reason is the dsh fact above plus the repository rule against mutable product singletons.
   `activeRuntime` has no other job: the resume guard it backs is covered by `stopped`, and a second `start` in one
   process is prevented by the plugin being a single Fiber, not by a global.
7. **Shutdown order contract (P2-6).** State the true contract once: *terminal restore starts first and is awaited by
   the Fiber's unload; the Fiber's children dispose concurrently with it and must tolerate a stopping runtime.* This is
   the order we want, not a defect to engineer away: a hung child disposer must not delay giving the user their shell
   back, and a stopped TUI ignores late `requestRender`. Edit the comment at `core/index.ts:150-153`, the `stop()`
   doc in `terminal.ts`, and the `exit-epitaph.ts` header, which today says "mayfly-app's fiber unloads before
   mayfly-core's stop effect". The epitaph's real dependencies are two: (a) `process 'exit'` fires after the awaited
   dispose, hence after the restore; (b) the app's epitaph disposer (`app/index.ts:145`) runs before the app's own
   services clear themselves, which holds because the disposers are synchronous and start in reverse registration order.
   (b) is pinned by a decision test with real Cordis (section 9) and named in a comment at `app/index.ts:145`.

### Rejected

- *Nest the Fiber's children inside the terminal's effect so serial reverse disposal makes the terminal last.* It
  works in Cordis, but makes the restore wait for every child: a hung child leaves the tty raw. Worse for the
  fail-loud case, which is the one this code exists for.
- *Register the stop effect right after the await and wrap it in try/catch that stops the runtime if registration
  throws* (the report's direction). It compensates for a window that should not exist and leaves the post-await
  `await`-to-effect gap in place.
- *Keep `createTerminalRelease` and wire it into `installFailLoud`.* dsh already releases through the Fiber; a second
  path races the first.

## 3. Renderer-write boundary (R2: P2-4)

### What the code does

`output-recovery.ts` replaces `terminal.write` on the instance, counts a depth, and repaints on any `process.stdout` or
`process.stderr` write made at depth 0. It assumes everything the renderer prints passes `terminal.write`. pi-tui does
not: `ProcessTerminal` writes to `process.stdout` directly from `start`, `stop`, `drainInput`, `hideCursor`,
`showCursor`, `moveBy`, `clearLine`, `clearFromCursor`, `clearScreen`, `setTitle` and the progress methods
(`pi-tui/dist/terminal.js` lines 105, 173, 259-265, 312, 344-352, 383-441). The TUI calls `hideCursor` on every overlay
show and hide (`tui.js:299, 315, 397`) and `showCursor` then `terminal.stop()` at its own stop (`tui.js:487-488`).
Each such write is counted as ambient and forces a full repaint. Part 2 measured one forced repaint per overlay show,
one per hide, and one at shutdown.

### Design

The boundary should be the `Terminal` object Mayfly hands to the TUI, not a patch on one method.

- `createOutputRecovery(output, repaint)` no longer takes the terminal and no longer assigns `terminal.write`. It
  returns `{ activate, deactivate, renderer(terminal) }`.
- `renderer(terminal)` returns a Proxy, built like `withJoinedModifiers` (`terminal.ts:482`, which is already a Proxy
  facade and is composed with it). Every function-valued property runs inside the renderer scope (depth up and down
  around the call); getters (`columns`, `rows`, `kittyProtocolActive`) pass through.
- Inside `startMayflyTerminal` the raw terminal never escapes: `setTitle`, `copySelectionText` and the size reads use
  the facade. A write that does not go through it is ambient by definition, which is the guard's whole purpose.
- The guard is deactivated first in `teardown()` (section 2), before `drainInput`, so the one asynchronous method needs
  no bracket and ambient output during the up-to-1 s drain is not repainted into a screen that is about to be left.
- Delete the `terminal.write = …` assignment and the restore code in `deactivate`.

### Rejected

- *Wrap only `hideCursor`, `showCursor` and `drainInput`* (the report's alternative). It repairs the two cases that
  were measured and leaves the next `Terminal` method pi-tui adds to repeat the bug.

## 4. One terminal-text grammar (R3: P2-1, F10)

### What the code does

After audit-1 the strip machinery is shared (`escape-sequences.ts`, `stripEscapeSequences(text, whole, tail, c1)`) but
the grammars are not:

| Where | OSC arm | Also strips |
| --- | --- | --- |
| `ui-validator.ts:68` (admission) | lazy `[\s\S]*?` to BEL, `ESC \` or `\x9c` | 8-bit C1 openers, DCS/APC/PM/SOS strings; controls include `U+FDD0-FDEF` |
| `plugin-view.ts:27` (paint, `sanitizePluginText`) | greedy `[^\x07]*` | none of those |
| `content-rows.ts:684` (`ANSI_AT`, sticky scanner) | greedy `[^\x07]*` | none of those |
| `interaction/shell-sanitize.ts:21` (editor `!` output) | lazy | different set; input-side |

The greedy arm runs to the end of the text and backs off to the **last** `ESC \`, so two ST-terminated OSC 8
hyperlinks delete everything between them (P2-1). Admission runs on every wire node, so for UI nodes paint receives clean
text; the transcript never passes admission (`transcript/components.ts` (user and assistant text, shell output, any tool result), `command-group.ts`,
`read-group.ts`, `search-group.ts`, `thinking.ts`, `compaction.ts`), so paint is the only gate that matters for the
cases the user sees. That is why the two definitions can drift unnoticed.

### Design

- `core/escape-sequences.ts` owns the **one** grammar: the validator's (the superset, with the lazy OSC arm). It exports
  `stripTerminalText(text)`: sequences, then unsafe controls (the union set, including `U+FDD0-FDEF` and the private-use
  focus sentinel `U+F8FF`), keeping the linear-time split after the last terminator that audit-1 introduced.
- `stripEscapeSequences` loses its `whole`, `tail` and `c1` parameters; the terminator set always includes `\x9c`.
- `sanitizePluginText` and the validator's two call sites (`ui-validator.ts:221, 260`) become one-line delegations.
  Their regexes, `ANSI_OR_OSC`, `ANSI_TAIL`, `TERMINAL_SEQUENCE`, `TERMINAL_TAIL` and both `UNSAFE_CONTROLS`, are
  deleted.
- `ANSI_AT` is derived from the same pattern source (a sticky variant of the escape alternatives) so a scanner that walks
  painted text agrees with the stripper about where a sequence ends. Mayfly itself paints only SGR today; the
  derivation keeps that from becoming a third grammar if it ever paints more.
- Behavioral consequences, all intended: ST-terminated OSC text between sequences survives (P2-1); 8-bit CSI/OSC and
  DCS/APC payloads are removed as units instead of leaving their payload visible (cosmetic part of F10); output
  for every input that contained no OSC or string sequence is unchanged.
- `interaction/shell-sanitize.ts` is a separate, input-side concern (a different contract: it keeps only `\n` and `\t`).
  It stays unless the implementation finds a case where it and the shared grammar disagree on something visible; if so,
  it delegates to the shared strip first.

### Rejected

- *Change only the greedy arm to lazy.* It fixes P2-1 and keeps F10: two grammars that agree today by accident.
- *A branded `SafeText` type so admitted text is not stripped again at paint.* The second pass is windowed and cheap;
  the type would have to cross the wire model, which carries no brands.

## 5. Locale as a paint input (R4: F12)

### What the code does

A filterable list paints `1 match` through `coreText` (`ui-compiler.ts:1054, 1062`), which calls the contextual
translator. After a locale change the host requests a frame (`core/index.ts:162`), but a pane or overlay recompiles
only when its entry or interaction revision changes (`surface-renderer.ts:550, 584`), and the compiled surface's
frame inputs are the viewport, the model revision, the keymap revision and the completion state
(`ui-compiler.ts:2989-2990`, `syncEpoch`). Locale is not among them, so `render(60)` returns the old text until
something else invalidates. Node slots do include it, through a second mechanism: `nodeSlotEpoch` sums keymap and locale
revisions, and `SlotAttachment.current()` invalidates the compiled component when it moves (`node-slot.ts:66, 102-108`).

### Design

The compiler already owns "what a frame reads from outside the surface". Add the locale there, once.

- `contextHints` gains `revision?: () => number`. `renderFrameOnce` reads it next to `keymap.revision`; `syncEpoch`'s
  `inputs` string and the `frameResult` memo key include it. A new locale then moves the surface epoch exactly as a key
  rebind does, so retained static leaves repaint through the existing `touch()` path.
- The translator and its revision travel together. `contextHintTranslator(ctx)` supplies the revision
  (`ctx.get('mayflyLocale')?.snapshot.revision ?? 0`) with the translate function, and `surface-renderer.ts`
  passes the pair to `compile` for panes and overlays and to `bindNodeSlots`.
- Delete `nodeSlotEpoch`, the node-slot compiler's `epoch` option, `SlotAttachment.renderedEpoch` and its branch. Slots
  then follow the locale through the same path as panes. Tests that import `nodeSlotEpoch` (`screen.spec.ts`) move
  to the compiler-level assertion.
- Check every `translateHint` consumer in the same change (`surface-renderer.ts:66, 106, 358, 443, 486, 676`,
  `node-slot.ts:46, 123`, and the views lane's `translate` option) so none keeps a second path.
- The hint row's text-keyed memo is unaffected: it is keyed by the translated text.

### Rejected

- *Add the locale revision to the pane's recompile condition* (the report's "pane epochs" direction taken literally).
  It recompiles the whole pane, discards its state-free caches, and leaves slots on a different mechanism.
- *Make `coreText` callers invalidate themselves.* Many call sites; none knows when the locale moved.

## 6. Notification state (R5: P2-8) — decided: delete `handled`

### Evidence

`handle(id)` cancels the record's timer and marks it `handled` (`ui-interaction-notifications.ts:116-122`);
`setVisible(true)` re-arms every record including handled ones (`:137, 161-162`), so a handled success disappears
after all. The two paths disagree, but there is nothing to reconcile them against:

- `handle`, `handleNotification` (`ui-interaction-state.ts:67`) and `handleFeedback`
  (`ui-interaction-surface.ts:878`) have **no production caller**; only tests call them.
- No renderer reads `record.state`: `visibleNotification` (`interaction/input-plugin.ts:242`) and the surface footer
  notice (`ui-compiler.ts:2901`) show handled records like any other.
- The spec says a warning "stays until acted on" (`docs/design/component-library.md:220`), and acting on it is already
  `clear`/`dismiss`.

### Design (owner decision recorded on the issue)

Remove the state instead of defining it:

- `UiNotificationStore.handle`, `UiNotificationOwner.handle`, `handleNotification`, `handleFeedback`.
- `state: 'active' | 'handled'` from `MayflyFeedbackRecord` (`packages/ui/src/interaction.ts:46`) and the
  `state: 'active' as const` it is written with in `report`.
- The `record.state === 'handled' ||` clause of `trim()`.
- The `state` mention in `docs/design/component-library-reference.md:104`, the five test assertions that use it
  (`ui-interaction-notifications.spec.ts`, `ui-interaction-state.spec.ts`), and the generated `lib` types by rebuild.
  The Website reference does not mention the state (checked on `7bb476a`); the implementation re-greps `website/`.

This is a public wire-record change in `packages/ui`; per the repository rule it updates every caller and leaves no
alias. P2-8 ceases to exist rather than being fixed.

## 7. Async work under a Fiber (R6: F8)

### What the code does

`app/index.ts:152-157` queues startup, resume, new, fork and rewind on one promise chain. The chain is not owned by the
Fiber. An operation that outlives the unload fails on its next Fiber-bound call (`ctx.agents.get` on an inactive
context throws), prints a `dsh:` line, and the startup operation's `catch` calls `io.exit(1)`. At process exit that exit
coalesces into the one already running (`createProcessShutdown.start` returns the pending promise), so it is harmless;
in a reload of the app plugin early in boot it is a process exit with code 1.

### Decision: a small fence, not "no change"

The root instructions require unload and stale-generation handling for async work. The fix is the same shape as
section 2, not a new mechanism:

- `let live = true` with `ctx.effect(() => () => { live = false })`, registered with the other app effects.
- `enqueue` skips an operation that starts after `live` is false, and its `catch` drops (does not print) an error
  that arrives after `live` is false. The startup operation's `io.exit(1)` is behind the same check.
- A comment at `app/index.ts:145` names the order dependency of the epitaph disposer (section 2, item 7).
- `packages/mayfly/AGENTS.md` gains one sentence in the lifetime section: *a resource acquired across an `await`
  registers its owner first and re-checks it on resumption.* It states the rule R1 and R6 share.

Recorded and not changed: a startup operation that never settles holds every later new/resume/fork behind it, because
the chain has no timeout. `loader.await()` cannot reject today, so this is not reachable; if that changes, the bound
belongs to the startup operation.

## 8. Implementation slicing (for the later pull request)

One pull request closing #7, five commits, each carrying its decision tests. Order keeps the shared files stable:

1. **Grammar** (R3): `escape-sequences.ts`, `plugin-view.ts`, `ui-validator.ts`, `content-rows.ts`. Touches the file
   issue C also edits (`plugin-view.ts`, `spanText`); rebase on C first if it lands.
2. **Notification state** (R5): `ui-interaction-notifications.ts`, `ui-interaction-state.ts`,
   `ui-interaction-surface.ts`, `packages/ui/src/interaction.ts`, the reference doc and tests.
3. **Locale epoch** (R4): `ui-compiler.ts`, `context-hint-locale.ts`, `surface-renderer.ts`, `node-slot.ts`. Shares
   `surface-renderer.ts` with issue A (P1-03): small commit, rebase.
4. **Terminal lifetime and renderer-write boundary** (R1, R2): `terminal.ts`, `output-recovery.ts`, `core/index.ts`,
   `exit-epitaph.ts` header, and the test migration for the `startMayflyTerminal` signature. The largest commit; it
   cannot be split without leaving the guard and `stop()` in the old shape between commits.
5. **App fence** (R6): `app/index.ts`, `AGENTS.md` sentence.

Step 0 of the implementation: re-run each audit repro on current `main`, and drive the real `apply` under real Cordis
to confirm that a plugin Fiber can be disposed while its async `apply` is awaiting. The design holds either way (the
owner-first effect also covers a throw after the start), but the P2-3 test should assert the actual behavior.

## 9. Verification

Every row is a test that fails on `7bb476a` and passes after, except where marked.

| Item | Test |
| --- | --- |
| P2-1, F10 | One table-driven spec runs the seven inputs of Part 2's Item 2 (OSC 8 pair, two OSC titles, ST then BEL, APC, DCS, 8-bit CSI, 8-bit OSC) through `sanitizePluginText` and the validator's admission path and asserts equal output, with the hyperlink repros pinned to `label-a and label-b tail` and `one KEEP THIS two`. The existing property test compares against the unsplit reference of the one grammar |
| P2-3 | Real Cordis, a fake `Terminal`: dispose the Fiber during the probe, assert the terminal was never started; make a registration after the start throw, assert `stop` ran once |
| P2-4 | Real `ProcessTerminal` and `TuiAltScreen`, recording `process.stdout`: zero forced repaints on overlay show, overlay hide and `stop()`; one repaint for a genuinely ambient write |
| P2-5 | A `FakeTerminal` whose `drainInput` takes 100 ms: the second `stop()` resolves no earlier than the first; `current.stop` called once |
| P2-6 | Real Cordis, in `tests/app/app.spec.ts` beside the existing `armedEpitaph` assertion (`:337`): the epitaph carries the Agent's id when the app Fiber unloads, and the test fails if the disposer is moved before the services |
| P2-8 | The type no longer has `state`; the trim spec no longer needs the handled case (assertions removed, not weakened) |
| F12 | A filterable list at query `Lead`: after the translator starts returning a Chinese catalog and the revision moves, `render(60)` returns the translated count line with no `invalidate()`; the same for an overlay and a node slot |
| F8 | Queue a resume, dispose the app Fiber before it resolves: no stderr line and no `exit` call |
| PTY | On the existing `script/smoke-pty*.mjs` harness: SIGTERM during the probe window leaves the tty out of the alternate screen and in cooked mode; ambient output still repaints (`smoke-pty-output-recovery.mjs`) |

Gate: `pnpm run check -- --tier pr` while finalizing, `--tier full` at the end (a lifecycle and composition change),
`pnpm run check:lib` after the subpath export removal, `check:agent-docs` for the `AGENTS.md` sentence. The `app-*`
and shell-card scenario goldens are re-reviewed with `pnpm run frame`; only the replay chosen for the hyperlink
output changes its golden.

## 10. Owner acceptance (runtime profile `dsh --profile mayfly-<tag>`)

Install with `PROFILE=mayfly-<tag> script/install-dev.sh` after the build.

1. **SIGTERM during startup.** Start `dsh`, send `SIGTERM` within the first 200 ms (a loop of `dsh & sleep 0.1; kill
   $!` in a PTY). Expected: the shell prompt returns on the main screen, echo works. Nearby: a normal `/quit` and a
   double Ctrl-C still restore the terminal and print the resume line.
2. **Overlays without a full repaint.** Open and close the permission picker and a command palette with a long
   transcript behind them. Expected: no whole-screen flash or scrollback jump. Nearby: `dsh` output written by another
   plugin while the TUI is up still repairs the screen.
3. **Hyperlinks.** A `bash` tool result with two OSC 8 links, added to one of the shell-card replays in
   `script/scenarios/replays.mjs` and opened with `pnpm run scenario <name>`: both labels and the text between them are visible. Nearby: a result with a title-setting OSC still shows its text.
4. **Locale.** In `/settings`, switch the language while a filterable list is open. Expected: its count line changes
   language at once; the same on a node slot (the footer). Nearby: switch back; keys rebound in the session still
   repaint their hints.

## 11. Risks and open points

- The `startMayflyTerminal` signature migration touches about 90 call sites in tests; it is mechanical but is the bulk
  of commit 4's diff.
- Cordis behavior while an async `apply` is awaiting is assumed from the sources, not run (step 0 above).
- Issue A (`surface-renderer.ts`, P1-03) and issue C (`plugin-view.ts` `spanText`; `terminal.ts` is **not** C's: the
  `createTerminalRelease` decision is made here) overlap with commits 1 and 3.
- Out of scope, as in the issue: F2 and F7 (done in audit-1), P2-7 (module-level test hooks, owner decision), the
  `SurfaceManager` user-state removal (issue C).
