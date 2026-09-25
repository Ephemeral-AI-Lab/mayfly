# Full interaction-model migration: step-by-step execution plan

Date: 2026-09-07; status updated: 2026-09-08. Execution location:
`/home/x/dev/deepseek-harness-plugin/mayfly-ui-interaction`; branch:
`refactor/ui-interaction`. Steps 1–20 are complete; on 2026-09-08 the user
accepted the final Website/profile candidates, and the candidate was merged
into main with the main build and resource cleanup done.

Current facts are in the [resume audit](./ui-interaction-resume-plan.md), and
the protocol and behavior goals are in the
[detailed design](./pr15-interaction-refactor-plan.md). The latest candidate
has passed whole-repo typecheck, lint, per-file 100% coverage, and the full
release gate; Step 19's Website/profile manual acceptance is also complete.

## Execution conventions

Proceed through the 20 steps below in order; each step includes code and its
tests. Enter the next step only after the previous step's local completion
conditions pass; when a shared-protocol defect is found, return to the step
that owns it to fix it. Early on, not all unmigrated legacy tests are required
to pass, but every remaining failure must be recorded — failures must not be
eliminated by restoring the old protocol, loosening assertions, or lowering
coverage thresholds.

Each checkpoint records the changed files, the commands actually run and their
results, remaining problems, and the next step. Commits are organized by
completed responsibility with explicitly selected files; `.artifacts/` and
unrelated checkout changes do not enter commits. After the technical steps are
complete, provide the final profile as a whole — the user experiences each
item and discusses the interactions, and the merge happens only after all
applicable manual acceptances pass.

Below, `core/`, `interaction/`, and `frontend/` refer to the corresponding
directories under `packages/mayfly/src/`. New files are created only when an
actual responsibility needs splitting; do not add a public UI service, a
generic Panel DSL, a compatibility facade, or a product-state singleton.

## Step 1: pin the execution baseline and the consumer list

Depends on: none.

Work: check HEAD, the worktree diff, the existing build, and the latest gate
logs. Build the consumer list recording, per item, the native API, the
app/session/request scope, shared controls, operations, cancellation, sizing,
and legacy entry points. Classify failures into four kinds: missing fixtures,
old-protocol assertions, real regressions, and performance/timeouts. The Codex
session ID is only for work resumption, not for Harness resume.

Artifacts: the list at the end of this file serves as the work ledger; keep
citing the latest audit results. If the source has not changed, do not rerun a
full gate just to reproduce the same failure numbers.

Done when: every production entry point and public consumer has an owner;
implemented, not-yet-implemented, and to-be-verified are clearly
distinguished; the next step can locate files directly.

## Step 2: fix service dependencies and test fixtures

Depends on: Step 1.

Scope: `frontend/index.ts`, `interaction/index.ts`, `commands-plugin.ts`,
`trace-command.ts`, and the pane/overlay bridge, command, theme-switch, and
e2e fixtures.

Work: fix dependencies that actually read services like overlays without
declaring them; split app-level registrations from exact-Agent-level actions
by their actual Fiber lifecycles. Tests explicitly load the UI provider and
the stable frontend owner; do not create skills/questions when interaction is
missing services. Jobs stays its existing independent composition sibling.
Turn the already-located problems — marketplace page association, missing
actions, update cancel not settling — into reproducible new-protocol traces
for the owning later steps to fix.

Verify: with the dependency present the command registers normally; when
absent it waits or returns a clear optional-service result; after registry
unload the old contribution is removed and on recovery it registers exactly
once. Rerun the affected fixture/command-registration tests.

Done when: fixtures can drive the current production registration graph, and
missing-service and lifecycle failures are no longer conflated with old
assertion errors.

## Step 3: converge the public event and receipt contract

Depends on: Step 2.

Scope: `packages/ui/src/interaction.ts`, `contracts.ts`, `services.ts`,
`snapshot-events.ts`, `builders.ts`, and the public-type fixtures.

Work: distinguish type constraints for observation vs. action on the existing
registration. Writable submits must return a structured settlement; readonly
changes must not write the domain implicitly. Pin down pagePath,
form/selection addressing, source stamps, submission boundaries, and partial
success. `data` keeps valid drafts, `replace` creates new-instance semantics,
and an ack is only published by the current operation's prepared publisher.
Completion and submit transform use a context matching their request's nature
— do not fabricate an action identity.

Verify: compile time rejects receiptless saves, illegal event payloads, and
renderer objects; runtime keeps coverage for freezing, cycle/accessor
rejection, duplicate/late acks, same-name reopen, and hidden-branch local
admission. Both Provider and the external overlay actually consume the final
signatures.

Done when: public callers use the same contract; there is no legacy field
alias/conversion bridge; every new field has a real consumer. status/editor
decorations keep their narrower node union.

## Step 4: complete operation, close, and parent/child lifecycles

Depends on: Step 3.

Scope: `core/ui-interaction-state.ts`, `ui-interaction-surface.ts`,
`interaction/ui-overlay.ts`, `agent-overlay.ts`, `request-overlay.ts`, and
`update-command.ts`.

Work: unify single-flight reentry prevention, read-latest, submit lock,
cancel, receipt admission, and partial success. Distinguish registration,
replacement, draft, native source, and renderer generation. A child UI uses
its owning UI/request lifetime — it must not hang on an already-settled
operation signal. Define shared close policies for awaiting confirmation,
cancellable work, and uninterruptible writes; while an external write has
begun, a UI close must not be interpreted as a rollback.

Immediately fix two update regressions: Esc/registry close/unload on the
confirmation page must settle the cancel and release the in-flight guard; a
running swap controls closing per its declared policy — a dismiss handler
returning completed must not accidentally tear down the progress page.

Verify: a repeated save writes once; a same-ID reopen does not admit stale
results; after a same-session-ID live-Agent replacement old actions are
invalid; a renderer rebuild does not cancel still-valid business actions; a
successful native write whose UI admission fails is not auto-resent.
Confirmation and in-flight close traces go through the real registry.

Done when: every pending request has an explicit termination path; the
meanings of close, hide, unload, and business cancel do not substitute for
each other.

## Step 5: finish shared Form, Choice, Tabs, Wizard, and confirmation

Depends on: Step 4.

Scope: `core/ui-interaction-form.ts`, `ui-interaction-choice.ts`,
`ui-interaction-field-actions.ts`, `ui-interaction-surface.ts`,
`ui-validator.ts`, `ui-compiler.ts`.

Work: confirm each surface has exactly one draft, selection, page, and step
state. Implement focused navigation, Enter or direct typing to enter editing,
zero-save Tab, explicit Save, one cross-page submit, return-preserving, the
hidden-vs-deleted distinction, and the default-No shared confirmation.
Numerics keep raw intermediate states, multi-select keeps the legal empty set;
support inherited/explicit/reset and the necessary memory cleanup for secret
fields.

Verify: drive the official Provider and the external two-page overlay with the
same set of traces, then extend to panes: three-way refresh coordination,
field errors, submit failure, partial success, concurrent data/ack, tab
reorder/delete, same-name address isolation, dirty dismiss, candidate
deletion, and wizard-completion invalidation.

Done when: consumers need not keep values/cursor/tab or sustain editing via
per-set echoes; text originals, secrets, and Other/empty-answer semantics are
not broken by generic normalization.

## Step 6: unify action query, input routing, buttons, and hints

Depends on: Step 5.

Scope: `core/ui-compiler.ts`, `keymap.ts`, `index.ts`, `screen.ts`,
`interaction/keys.ts`, `input-plugin.ts`, and the hints/help data sources.

Work: derive AvailableActions from the current model, including a stable
action/address, enabled, disabledReason, pending, and target version. Core
merges the actual keymap and terminal capabilities so buttons, keyboard,
mouse, and hints use the same action query. Input first goes through the
active capture scope, then gets its semantics from the current
editor/search/picker/page; only unconsumed input proceeds to later routing.

Verify: after a real keymap change, hints and behavior change together;
typing `install` in text search does not trigger i/u/r; Delete/Ctrl-D in a
form does not become entity deletion; F7/F8/Tab/Esc do not leak through to the
prompt while a panel captures; Chinese input, paste, and native caret behavior
are preserved.

Done when: migrated consumers have no raw key dispatch and no second copy of
shortcut text; a disabled/busy action cannot be bypassed through any input
method.

## Step 7: actually wire in Document semantic anchors

Depends on: Steps 5, 6.

Scope: the existing `core/ui-interaction-document.ts`, surface state,
compiler, and the ScrollView/scrollable-panel bindings; real consumers use
Jobs output and trace/detail.

Work: store block IDs, source text offsets, and follow intent in the stable
instance; actual line numbers and layout mapping stay in the renderer. Input
updates the semantic anchor; resize/reload restores by anchor; content changes
reconcile positions. Finish quota-bounded paging, overlong lines, and
surrogate-pair boundaries; handle page number and in-page position separately.

Verify: while reading, prepend/append/delete paragraphs, change width/theme,
or unmount and remount the renderer — it still returns to the same content;
follow=end vs. manual scroll-away are distinguished. Repeated renders do not
mutate the model and do not reread the native Job output; an extremely short
window still reaches the full text and the actions.

Done when: the existing Document helper has production callers and integration
tests; restore depends on semantic position, not old line numbers or
kept-alive components.

## Step 8: finish Tree and Search shared behavior

Depends on: Steps 5, 6.

Scope: `core/ui-interaction-choice.ts`, list admission/indexing, and the
compiler; the `interaction/session-tree.ts` and sessions/agents consumers.

Work: build the relationship and visible-node index from the declared
parentId/tree, validating duplicate IDs, self-references, and cycles; pin down
the orphan-node rule. Share the normal expansion set, the search temporary
expansion set, parent/child navigation, and focus coordination. Search shows
matching nodes plus ancestors; clearing restores the original expansion and a
valid anchor. Do not treat the current declaration-traversal file
`ui-interaction-tree.ts` as an already-finished Tree reducer.

Verify: deep matches under collapsed nodes are reachable; clearing a search
restores; focus stays stable after sort/delete/disable/insert; typed
characters go to search first; scrolling a large tree does not rescan all
business data per frame.

Done when: sessions/agents no longer simulate shared tree interaction through
closure expanded/selectedId.

## Step 9: finish the unified notification and feedback foundation

Depends on: Steps 4, 6, 7.

Scope: the frontend stable owner, the core feedback outlet, and if necessary a
new clearly-scoped notification module; the existing `UiSurfaceModel.feedback`
plugs into the same lifecycle.

Work: internal records carry Fiber/registration, scope, operation, severity,
purpose, summary/details, cumulative visible time, and handling state.
success/info accumulate 5 seconds of visibility; hidden pauses the clock;
progress settles with its operation; warning/error persist until handled,
replaced, or their scope ends. Authorization guidance stays on the
authorization surface; current state stays in the status projection. Record
count/body/long tasks are bounded, and an ordinary success must not displace
an unhandled critical failure.

Verify: errors are visible while a panel is open; long text can open details;
two operations' progress, failure, and cleanup interleave without overwriting
each other; late feedback, Agent switching, registration unload, sensitive
field redaction, and the visible clock all behave. The clock does not advance
inside render.

Done when: official background tasks have an internal ownership-bound entry;
externals use action reply/report and the four existing UI services — no
public notifications service is added.

## Step 10: finish migrating the three kinds of editor-extension requests

Depends on: Steps 3, 4, 6, 9.

Scope: `interaction/editor-extension-runtime.ts`, `editor-instance.ts`,
`prompt-submit-pipeline.ts`, the core editor-shell binding, the UI registry,
and the external example.

Work: decoration actions use the shared operation, confirmation, feedback, and
prepared reply — delete the separate action FIFO/timeout/notice paths.
Completion keeps the native editor's query/caret-latest semantics;
transformSubmit binds one prompt attempt, runs in order, and submits once
after all succeed. A renderer unload only revokes the applicable editor
binding/read; it does not cancel still-valid independent domain actions.

Verify: duplicate actions, structured failure/progress, registration
replacement, late completion results, original-text/attachment restoration
after a transform failure, Agent switching, and shell reload. The external
plugin uses the final API through a real package import.

Done when: the three request kinds each have the correct lifecycle and none
has a private business draft or drops structured receipts; undoing old
variable names does not count as migration evidence.

## Step 11: re-verify the config and request-type consumers

Depends on: Steps 5, 6, 9, 10.

Scope: Provider edit/add/first-run/OAuth, settings, model/effort/preset,
permission/plan, and questionnaire/questions/approval/request-overlay.

Work: align each item to the final protocol and delete residual business
editing state; native writes only originate from explicit actions. Config
values and revisions are read in the same pass, and Save only writes changed
paths; credentials and settings partial success retries only the unfinished
part. OAuth notify and child prompts are handled independently; user refusal,
prompt.signal withdrawal, and whole-authorization cancellation keep their
native distinctions. Request FIFO/allowance stays with the native request
consumer, and settlement must not precede a valid UI receipt.

Verify: paired tests for Provider and the external form; readonly config,
schema/default updates, document-updated, no secret backfill; permission
no-op, plan/YOLO independence; empty questionnaire/Other/multi-select/feedback
originals; OAuth beyond 5 s and 30 s, renderer reload, withdrawal, and late
results.

Done when: these rewritten consumers all pass under the final protocol, and no
private state or keys were reintroduced for other migrations.

## Step 12: finish the catalog-type consumers and the marketplace

Depends on: Steps 5–9, 11.

Scope: `plugin-commands.ts`, `frontend-panel.ts`, `help.ts`,
`info-panel.ts`, the tools/MCP/skills commands, and the version/changelog info
pages.

Work: the marketplace directly declares a list subtree with associated tabs;
explicit selection input produces the available actions; delete the business
selectedId/panelStatus and the FrontendPanelDocument runtime-conversion
dependency. Details are managed by the browser child Fiber;
Install/Uninstall/Refresh enter an operation and re-read the real install
state. Tools/MCP/Skills re-checks exact Agent, secrecy, and the browsing
boundary that performs no domain action; Help generates content from actual
actions and the keymap. App-level static pages must not depend on
current-Agent/skills staying alive.

Verify: the first open can complete selection and install/uninstall; a tab
only shows its group; searching does not misfire; offline/refresh
failure/install failure and rollback; detail return, repeated opens, locale
switching, and parent-view close. Browsing tools/skills performs zero native
executions.

Done when: the two known marketplace page-and-action regressions are gone;
Help/Info no longer constructs the old renderer controller; the existing
installer validation and profile/source rules hold.

## Step 13: finish sessions, Agents, Jobs, Trace, and readonly history

Depends on: Steps 7–9, 12.

Scope: session browsing/rewind, `agents-command.ts`, `session-tree.ts`,
`session-transcript-panel.ts`, Jobs, Trace, the app auxiliary target, and the
core fixed hosts.

Work: sessions/agents take the shared Tree/Choice; before executing, an action
re-reads native live/continuable/permission and passes the exact Agent; a Stop
result goes through structured feedback. Jobs keeps the explicit consuming
Read and bounded pages — list/detail/paging do not consume extra. Trace keeps
native order, complete details, copy current/all, and subpage cleanup. The
readonly transcript keeps using the existing complete renderer/source, with
the shell, focus, and mounting moved to core; app only keeps auxiliary target
selection.

Verify: real Harness session new/resume/fork/rewind; same-ID Agent
replacement; cold/one-shot complete history, tools, images, and observation
dispose; F7 hide/restore, F8 close; Job read counts and the stop terminal
state; long traces and overlong lines fully reachable.

Done when: the last production `mountEditorReplacement` call is fully
replaced; readonly history is not degraded into truncated plain text, and
Harness session facts are not duplicated.

## Step 14: finish the update flow and all remaining old notice producers

Depends on: Steps 4, 9, 12, 13.

Scope: `update-command.ts`, `update-notice.ts`, `updater/check.ts`,
`input-plugin.ts`, paste-image/editor-plus, command results, and the remaining
notice callers.

Work: present the whole update — preflight, confirmation, swap, validation,
rollback, and final details — as one app/profile operation; keep the existing
host selection and version checks. Migrate prompt errors, copy/paste,
background updates, marketplace results, etc. one by one into structured
notifications, deleting pre-colored text and cross-operation empty-string
clearing. The queue only projects user sources; the internal inbox is used
verbatim by native, and when filtering leaves it empty there is no empty
separator pane.

Verify: update can be restarted after Esc, the in-flight close policy,
reentry prevention, exec throw/failure rollback, consumer unload, and late
results; every notification producer attributes correctly across panel
visibility, hiding, Agent switching, and reload; an attachment-only queue has
a summary.

Done when: no production notice-string protocol or per-consumer private TTL
remains; no domain state/output was wrongly moved into notification history.

## Step 15: delete the old generic controllers and component stack

Depends on: Steps 10–14.

Scope: the no-longer-needed generic controllers in `canonical-panel.ts`,
`frontend-panel.ts`, `select-list.ts`, `info-panel.ts`, `help.ts`, and
`confirmation-panel.ts`; `editor-panel-controller.ts`,
`editor-dock-host.ts`; remaining references to the deleted form/select, the
old component APIs, and tests.

Work: delete by actual references, keeping still-needed pure domain
projections and placing them in the owning business module. The prompt's
physical host/input binding belongs to core; the semantic draft and
navigation belong to the stable instance. Delete the old raw keys,
leaf/window, unbounded viewport, renderer-object keep-alive, and compatibility
exports. Update the exact baselines in the related boundary checks — do not
delete the boundary checks themselves.

Verify: searches with import/AST constraints prove production calls are gone;
typecheck/build have no missing exports; the compiler and role tests take over
the old generic interaction assertions. The original domain-behavior tests
stay valid; only tests of fully replaced old controllers are deleted with
them.

Done when: adding a Form/Choice/Tabs/Decision to a business only takes a
readonly declaration plus a native action; no second generic state/event path
remains.

## Step 16: complete whole-tree lifecycle, coverage, and performance evidence

Depends on: Step 15; the related tests are written alongside each earlier
step.

Scope: `packages/ui/tests`, the core/compiler/bridge/width specs, interaction
specs, whole-tree e2e, examples tests, and the existing business boundary
scans.

Work: complete the per-instance
core/theme/app/skills/provider/consumer/frontend reload matrix; prove
retention or cleanup follows the real dependencies, and do not let a stub-only
e2e stand in for a production consumer. Organize the still-valid old
assertions and fill in branch coverage for every executable file. Check the
semantic purity of repeated renders, control-local notifications, large-list
windowing, and long Document update cost. Separately locate the cause of the
CJK Job output timeout under full coverage.

Verify: widths of at least 20/40/80/160 columns and the owning scan ranges,
short heights, main/alternate, CJK/combining characters/long URLs, and
mouse/keyboard; Save/Cancel/errors always reachable. Record the original
platform conditions for all skipped items — do not turn a new failure into a
skip.

Done when: every explicit design requirement has a corresponding assertion or
a pending-manual scenario; every current failure has a resolution. The final
full coverage is proved once in Step 18 — do not run an extra round of plain
tests before it.

## Step 17: sync public docs, examples, package contracts, and screenshots

Depends on: Steps 15, 16; the runtime protocol is stable.

Scope: `docs/mayfly-architecture.md`, `mayfly-seams.md`, the relevant AGENTS,
both README languages, the Website plugin docs, shipped skills, examples,
package manifests/types/files, and screenshots.

Work: describe the final ownership, interaction rules, and event/update
migration paths; the historical audits keep their point in time. Verify the
real external consumers of pane/overlay/status/editor-extension one by one —
the ecosystem example only composes. When a subpath actually changes, sync
export/source/types/files; do not presume new subpaths/rows, and do not
refresh the Harness dependency line. For breaking public-protocol changes,
mark the candidate version and upgrade notes explicitly. Sync screenshots
after the final build.

Done when: the Chinese and English user docs agree; the public contract has no
unused fields; no document teaches the old interfaces; dependency and release
changes have clear reasons. AGENTS/skill changes run `check:agent-docs`,
screenshots run sync/check, and Website changes go through the strict build
and the subsequent LAN acceptance.

## Step 18: run the full release-candidate gate

Depends on: Step 17.

Run the following in the worktree; if the final source has no extra changes,
do not repeat the full coverage:

```sh
pnpm run verify:changed -- --plan
pnpm run verify:full
pnpm run check:pack
pnpm run shots:sync
pnpm run shots:check
pnpm run website:build
```

`verify:full` already includes
workflow/typecheck/lint/diagrams/build/lib/agent-docs/examples/full
coverage/happy smoke — do not rerun individually commands that already passed
inside it. Screenshot sync and Website build run as needed by actual changes;
this model migration's public plugin docs and screenshots belong in the final
candidate. If a fix invalidates an earlier result, rerun that check — the
final source revision must own the complete passing evidence.

Done when: all executable source is at per-file 100% and every applicable
check passes; nothing was passed by leaning on the frame clamp, coverage
exclusions, lowered thresholds, or deleting still-valid tests. Record the
exact commit/diff, Node/pnpm, and build/test results.

## Step 19: install the final profile and run item-by-item manual acceptance

Depends on: Step 18.

Use one explicit worktree profile, for example:

```sh
PROFILE=mayfly-ui-interaction script/install-dev.sh
dsh --profile mayfly-ui-interaction
```

Rebuild after source adjustments; reinstall only when the dependency graph
changes. Run the relevant `smoke:pty`, `smoke:pty:mouse`, and
`smoke:pty:output`; these existing scripts use a temporary profile, so passing
them must not be written up as the final profile being verified. Also actually
launch the named profile above and check the load path, main commands, and
session workflows.

Following the "manual acceptance order" checklist in the
[resume audit](./ui-interaction-resume-plan.md), provide the workflow,
expectations, failure/narrow/lifecycle cases, and the no-neighbor-regression
behavior. The experience order is forms/choices, pages/trees/documents,
OAuth/request decisions, marketplace/Jobs/update, and
prompt/session/extensions; record each user decision and subsequent
adjustment.

When the Website has changes, run `pnpm --dir website exec vitepress preview .
--host 0.0.0.0 --port <port>` on an available port and give the affected
routes at `http://<actual LAN IP>:<port>/`. Keep the preview and the profile
while waiting for each applicable manual acceptance; visual adjustments go
back into the owning step's code/test loop.

Done when: the user accepts the final interactions item by item; the checks
corresponding to any later change have re-passed. A profile booting is only
one of the scenarios — it does not mean the whole migration is complete.

## Step 20: post-acceptance merge and cleanup

Depends on: all of Step 19's applicable manual acceptances.

Work: organize the final changes and verification record and merge the
candidate branch per repository procedure; when conflicts or the merge result
change code, verify the affected behavior. Rebuild the main checkout so main's
`lib/` matches the merged source. Only after that stop the Website preview,
remove the worktree profile, clean up the worktree, and record the actual
acceptance routes and scenarios. The shared production `mayfly` profile is not
used as an early acceptance entry.

Done when: the implementation is merged, the main build is refreshed, the
acceptance evidence is traceable, temporary resources were cleaned up after
acceptance, and the user's pre-existing unrelated changes and artifacts are
preserved.

## Consumer completion matrix

Every row below must have production calls under the final protocol,
domain-behavior tests, cancellation/late-result proof, and applicable size
coverage. "Already changed to an overlay" alone does not count.

| Consumer | Closing step | Special behaviors that must be preserved |
| --- | --- | --- |
| Provider/add/first-run | 11 | app lifecycle, descriptor revision/path ops, credential partial success |
| OAuth | 11 | persistent URL/code, prompt.signal, decline/abort distinction, sensitive-reference cleanup |
| Settings | 11 | schema, inherit/override/reset, secrets, the original file entry, raw revision |
| Model/effort/preset | 11 | exact Agent, native selection, idle/turn boundary, partial persistence failure |
| Permission/plan | 11 | explicit confirmation for full access, no-op, plan/YOLO independence |
| Questions/approval/plan review | 11 | FIFO/allowance, Other/empty answers, default decline, native single settlement |
| Tools/MCP/Skills | 12 | exact Agent, readonly browsing, redaction, shared skills catalog, child-detail cleanup |
| Status/context/usage | 11/12 | one native projection read, statistics definitions and estimate meanings preserved |
| Version/changelog/help | 12 | app scope, real key hints, fully scrollable body |
| Market | 12 | tab content, first-screen actions, offline/install/rollback, profile/source checks |
| Sessions/rewind/agents | 13 | native relations and authority, Tree/Search, resume/view/stop |
| Readonly auxiliary transcript | 13 | complete history, cold observation, images/tools, core-hosted |
| Jobs | 13 | ordinary sibling, explicit consuming read, paging without rereads, native terminal state |
| Trace | 13 | native event order, complete details, bounded pages, copy and scope |
| Update | 4/14 | cancel settlement, preflight/swap/rollback, in-flight close and final details |
| Editor extensions | 10 | action/completion/transform each with its own lifecycle and consistent receipts |
| Prompt/attachments/queue/background notifications | 6/14 | native input and attachments, user source, operation ownership, and the visible clock |
| External pane/overlay/status/editor | 3/5/10/17 | same protocol, freezing and admission, packed consumer, Fiber cleanup |

## Judging complete migration

Technical completion requires the artifacts and evidence of Steps 1–18, all
same-role production consumers using the shared state and action paths, and
the old generic controllers retired. Delivery completion additionally
requires Step 19's user acceptance and Step 20's merge, main build, and
cleanup. Passing tests, renamed files, a booting profile, or visual similarity
can each never substitute for these completion conditions on their own.
