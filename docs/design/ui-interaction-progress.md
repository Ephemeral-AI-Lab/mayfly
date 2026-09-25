# Interaction refactor implementation progress

Status date: 2026-09-08. Working branch: `refactor/ui-interaction`. Worktree:
`/home/x/dev/deepseek-harness-plugin/mayfly-ui-interaction`. Baseline:
`b82acd2`.

The goal is to complete the unified interaction model per the
[detailed plan](./pr15-interaction-refactor-plan.md), keeping no old-protocol
compatibility layer. The 20-step execution checklist is in
[full interaction-model migration](./ui-interaction-migration-steps.md).

## Current conclusion

Steps 1–20 are complete. On 2026-09-08 the user accepted the dedicated profile
and Website candidates; the four candidate commits entered main via merge
commit `5fbbdc8`. The shared `mayfly` profile was not written to.

The specified Codex session `01a07aa1-3760-7791-92dd-dc5f797f2874` was used
only to recover the development process; it is not a Harness durable session
ID. Actual progress is defined by this worktree, the types, and the test and
build results.

## Final model

- `@ephemeral-ai/mayfly-ui` provides readonly nodes, Form/Choice/Tabs/Document
  addressing, source/scope, structured submission/reply, and the four direct
  registries/providers.
- Pane and overlay registration drafts, selections, pages, document anchors,
  confirmations, operations, and feedback are held by the frontend
  `mayflyUiInteraction` instance. A core reload only releases editors, focus,
  layout, and scroll handles — it does not destroy valid semantic state.
- `onEvent.observe` receives value, selection-toggle, and tab-change facts;
  `onEvent.action` handles activate, selection accept, submit, and dismiss and
  returns `accepted`, `invalid`, `conflict`, `failed`, `completed`, or
  `cancelled`.
- Provider endpoints separate reply preparation from publishing. Core admits
  the reply first, then a one-shot publisher updates the original
  registration. data/replace, same-name reopen, abort, and Fiber unload all
  revoke stale continuations, reporters, and publishers.
- Form, Choice, Tree, Wizard, Document, field picker, dirty dismissal,
  default-No decisions, field validation, single-flight, and feedback all use
  the shared reducer/compiler. Hidden forms are admitted at explicit
  boundaries, and large lists stay windowed.
- Editor replacement uses an ordinary overlay with `presentation: 'editor'`.
  The old canonical/frontend/form/info/confirmation/select/editor-panel
  controller stack has been deleted.

## Consumer migration

The following production consumers have all switched to the final model while
keeping the native dsh services as the domain-fact and write authorities:

| Area | Migrated behavior |
| --- | --- |
| Provider / OAuth / first-run | profile editing, creation, credential partial ack, continuous authorization guidance, native prompt signals |
| Settings / model / effort / preset | descriptor revisions, path ops, inherit/override/reset, secrets, exact Agents, native preset transactions |
| Approval / questions / plan review | FIFO, default decline, Other/empty answers, cross-page wizards, native single settlement |
| Tools / MCP / skills | exact Agents, readonly Documents, redaction, child overlay lifecycles, shared catalog |
| Help / trace / session / agents | app- or exact-Agent lifecycles, Tree/Document, refresh and late-result fencing |
| Jobs / market / update | native list/get/read/stop, paging, long lines, preflight/rollback, structured feedback |
| Queue / notifications / editor extension | user-only queue, feedback by owner/scope, completion/transform/action cancellation |
| External overlay example | native settings namespace, two-page form, revision/path commits, conflicts and unload |

## Existing evidence

- `pnpm run test:coverage`: 193 test files passed, 2 skipped under their
  original conditions; 3183 tests passed, 7 skipped. Statements 18056/18056,
  Branches 13404/13404, Functions 3698/3698, Lines 14453/14453 — all 100%.
- `ui-interaction-surface.ts`: 622 statements, 572 branches, 115 functions,
  437 lines — all 100%.
- `ui-compiler.ts`: 1575 statements, 1257 branches, 293 functions, 1265 lines —
  all 100%.
- `pnpm run typecheck` and `pnpm run lint` pass.
- Surface/compiler tests cover renderer reload, reactive schema races, stale
  acks, field and selection input, Tree/Wizard/Document, narrow-height
  layouts, stale callbacks, dispose, and feedback ordering.
- The compiler no longer exposes or executes the max-leaf, leaf-path,
  leaf-offset, or leaf-scroll compatibility paths; the passive transcript uses
  the real screen viewport and gets the full canonical line count before its
  own folding policy.

The performance audit used Node 24.15.0, Linux x64, explicit GC, and 7
headless samples per scenario; it is not terminal FPS. The command is:

```sh
node --experimental-transform-types --expose-gc script/audit-performance.mjs
```

On the real frontend `UiSurfaceModel`, a one-shot first build/publish/render of
a 100,000-item list measures median 233.75 ms, p95 249.14 ms; a stable repeat
render is 0.50/0.81 ms, a selection update 2.12/3.33 ms, and PageDown
0.83/1.18 ms. For 100,000 items, filtered repeat/PageDown are 0.60/0.83 ms and
1.28/1.63 ms; Tree repeat/PageDown are 0.61/0.75 ms and 1.64/1.84 ms. For a
100,000-character Document, append/prepend reconcile p95 is 4.27 ms and 4.53 ms
respectively. Ordinary renders also assert the model revision is unchanged.
The results prove O(n) work only happens on first admission, on
query/disclosure/definition changes, or on a full native transcript
conversion — a stable render or move reads only the viewport neighborhood.

The CJK Job output history timeout under full coverage was also located
separately. The old `JobOutputPanel` rebuilt the
`CanonicalDocumentController` when moving between pages, and coverage
instrumentation amplifies the cost of rewrapping a full page of wide
characters each time. The final path reads native output only once,
`documentPages()` splits only once while preserving surrogate pairs, and a
page action only publishes the current shared Document without rereading the
Job. New test cases cover full rebuild, page-by-page scroll-to-bottom, and
round-trip navigation over 24,002 CJK characters; under targeted coverage the
38 Jobs tests take 1.40 s, and `jobs.ts` plus `document-pages.ts` are at 100%
on all four metrics.

## Release-candidate gate

- `verify:changed -- --plan` selects the full gate; `verify:full` passes in
  full, including workflow, typecheck, lint, diagrams, build, the 53 lib
  claims, agent docs, standalone examples, complete coverage, and the
  40-column happy smoke.
- `check:pack` passes: the three alpha.4 tarballs pass publint, and the CLI
  runtime bundles the pinned Harness 0.1.2-alpha.5, 26 platform sentinels, and
  7 archives.
- `shots:sync` / `shots:check` pass: the 36 component shots and 6 app shots
  are current.
- The final `website:build` passed; LAN port 4183 was stopped after
  acceptance.
- The `mayfly-ui-interaction` profile was installed from the worktree.
  `smoke:pty`, the mouse smoke, and the output-recovery smoke all pass; the
  dedicated profile's version, expanded composition, and real 40×24 startup
  were checked.

## Merge and cleanup

- The candidate commits are `4e94835`, `63dbfae`, `e5c94fc`, `e09206f`; the
  main merge commit is `5fbbdc8`.
- The main checkout's `pnpm run build` and `pnpm run check:lib` pass.
- Acceptance exercised the Chinese and English UI reference/component model
  routes, and ran the form, choice, Tree/Document, OAuth/request,
  Market/Jobs/Update, and Prompt/Session/Extension scenarios.
- The Website preview, the `mayfly-ui-interaction` profile, and the worktree
  were cleaned up. The candidate's alpha.4 pack artifacts are kept in main
  `.artifacts/ui-interaction-alpha4/`; main's original artifacts and audit
  files were not overwritten.
