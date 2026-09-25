# Mayfly UI/UX interaction refactor implementation plan

Status: pending implementation. Per the
[unified model design](./ui-ux-unification.md), coding starts from a dedicated
worktree off the current main branch; the original audit baseline is `bd171aa`
and this plan is against `b57eb0d`. This plan does not mean the runtime or the
public API has already changed.

## 1. Delivery boundary

First prove that "shared control behavior + one state owner per surface" works
for real editing flows, then expand the migration. The frontend only
coordinates cross-surface navigation, input, and the operation/notification
index; native dsh keeps owning the domain facts for authorization, Agents,
settings, Jobs, and updates.

The batches below can form independent commits and reviews, but that does not
mean every batch can be released independently. Standalone defect fixes can be
accepted on their own; pilots adopting the new public protocol stay on the
candidate branch until the official and external in-repo consumers of the
related controls have finished migrating. Do not give external plugins a
special CLI, a private realm, a fifth UI service, or long-term compatibility
exports.

| Batch | Depends on | Deliverables | Condition for entering the next batch |
| --- | --- | --- | --- |
| A. Protocol and scenarios | none | old/new contract diff, type plan, parameterized event traces, owner dependency graph | every branch of design §4.6/§4.7 has deterministic inputs and outputs |
| B. Stable owner and paired pilots | A | official Provider editing + external overlay; minimal shared Form/Choice, actions, navigation | all six mandatory scenarios of design §11 and manual acceptance pass |
| C. Notifications and authorization guidance | B | visible feedback, notification ownership, OAuth persistent content and child prompts | the five notification regressions, the full OAuth lifecycle, and short-terminal acceptance pass |
| D. Form/Choice full-category migration | B; the OAuth part depends on C | configuration, Provider, startup, settings enums, multi-select, and the public consumers | same-kind controller state deleted; the public contract and user-behavior migration closed |
| E. Composite interaction migration | C, D | Tabs/Tree/Document, the marketplace, questionnaires, approval, and plan review | official/external conformance for each role and the native-result preservation tests pass |
| F. Release and wrap-up | C, D, E | complete composition, upgrade docs, screenshots, release closure | all gates and applicable manual acceptance pass |

Re-check the main branch before implementing, so the Yes/No and permission
decoupling already done in PR #14 is not implemented twice. The P1s from the
original audit can be fixed first on a separate branch: queue classification by
source, no save on Tab past the last field of an official form, and error
visibility while a panel is open. Fixes should land in the existing shared
implementation and keep the regressions through the later migration; each runs
the gate and profile acceptance matching its actual blast radius.

## 2. A: protocol and test inputs

Code scope: `packages/ui/src/contracts.ts`, `builders.ts`, `services.ts`, and
their tests; read `packages/ui/AGENTS.md` first. The concrete implementation
only extends the existing readonly node, registration metadata, and callback
contracts, and keeps the four contribution services.

1. Pin down baseline/draft, data/ack/replace, the submitted draft revision,
   and the operation receipt. Split selection changes and selection acceptance
   into separate events; structured field validation stays in the registration
   layer.
2. Pin down `MayflyUiChild.tab`'s page association, control-event page paths,
   same-name field isolation, and the difference between a temporarily hidden
   page and a real deletion. Source updates no longer rely on object identity
   or labels.
3. Write down the old/new protocol diff and list every `onEvent` and
   `set(..., { eventRevision })` consumer. The new protocol's default data
   semantics can only ship with an explicit version bump — it must not quietly
   change the current version's external replacement.
4. Build parameterized conformance inputs: the same Form/Choice scenario is
   mounted once on the official editor replacement and once on a public
   overlay; assert the draft, native call counts, event ownership, and render
   visibility. Do not write tests that only restate the reducer.

Receipt tests must cover duplicate acks, wrong operation IDs, a stale
registration under the same name ID, concurrent data at submit time, and
conflict handling without a native revision. Freeze/admission keeps rejecting
accessors, cycles, and renderer objects; page association must not introduce
full compilation of hidden branches or large-list scans.

This batch's protocol code forms a runnable candidate together with B's real
consumers — a public type extension with no consumer is not released on its
own.

## 3. B: stable owner and paired editable pilots

| Area | Coding work |
| --- | --- |
| `src/frontend/index.ts` | Mount the internal stable service on the existing frontend sibling; export no new runtime API, inject no app/skills/theme/terminal |
| `src/core/` | Build `ui-interaction-state.ts` that does not transitively import the terminal, plus on-demand split Form/Choice reducers; the registration instance index, reconcile, local operation/busy, and field-error ownership |
| `src/core/ui-surface-state.ts`, `ui-compiler.ts` | Consolidate the existing draft and list logic; the compiler reads instance state and submits semantic events; keep the native editor, windowing, width, and local-failure mechanisms |
| `src/core/surface-renderer.ts`, `index.ts` | Move registry observation from the renderer lifecycle to an independent subscriber child Fiber under the stable owner; the renderer only binds/unbinds; unify pilot action execution and reentry prevention |
| `src/interaction/canonical-panel.ts`, `form-panel.ts`, `editor-panel-controller.ts` | Provide structured surface registration for the pilot; remove the theme/input registration dependency and restore parent drafts and focus through the same protocol |
| `src/interaction/provider-add.ts` | Migrate the Provider edit form's node definition, native settings/credentials actions, and structured errors; do not duplicate UI drafts |
| `examples/mayfly-ecosystem/` | Add an external configuration overlay that actually reads and writes through the native settings namespace, using the same Form/Choice across two tabs; verify the complete ordinary Cordis composition |

The `src/` paths above mean `packages/mayfly/src/`; the new file names are
implementation locators — do not pre-build empty Tree/Wizard/Notification
skeletons. The external example follows its owning package's AGENTS and test
patterns.

The stable service is held by the frontend Fiber, and each registration owns
its mutable state separately; scope indexes do not put an Agent/Session into a
node. An Agent-scoped business action captures the exact Agent authority at
initiation and validates the corresponding scope at execution and settlement.
A business Fiber consuming current-Agent/skills must clean up when it truly
unloads, while independent static external UI survives.

The Provider configuration pilot is app scope: mount its contribution on an
independent business child Fiber under the existing frontend sibling,
depending only on the necessary native commands/settings/credentials and
similar services. Merely moving it out of the input child Fiber still leaves
it under the interaction parent Fiber's current-Agent/skills dependency and it
cannot pass the stability acceptance. When the mount actually changes the
lifecycle, update the package guidance and bundle tests to match.

Provider settings and credentials are already multiple native write steps; the
generic operation must not pretend they are a transaction. On partial success
the business handler re-reads the real state and returns a clear
failure/conflict — "cancel" or UI busy is not a rollback.

This batch's acceptance must cover all six items of design §11, focusing on
background refresh vs. draft conflicts, failures not losing drafts,
renderer/core/theme reload, real app/skills unload, and stale results not
polluting a reopened same-name surface. Readonly Documents and Yes/No are
acceptable auxiliary scenarios but cannot substitute for forms.

Set the expansion stop here: if a business still has to maintain its own
draft, guess a reset per tab, or keep an unloaded renderer instance, go back to
A/B and revise — do not migrate other commands early.

## 4. C: notifications and authorization guidance

Main files: `interaction/input-plugin.ts`, `editor-instance.ts`,
`editor-dock-host.ts`, `provider-add.ts`, `settings-command.ts`,
`plugin-commands.ts`, `jobs.ts`, `agents-command.ts`,
`preset-commands.ts`, `update-notice.ts`, `updater/check.ts`, and the fixed
slot implementation in core.

1. Wire in feedback records that update/clear by ID, operation, owner, and
   scope; severity and purpose are structured data. Feedback stays visible
   while an editor replacement is open and does not move the fixed root host
   order.
2. Migrate notice producers one by one and delete cross-operation
   empty-string clearing and pre-coloring. Recovery warnings, long output, the
   queue, and current state keep their designed semantics.
3. Put the OAuth notify message/URL/code into the authorization surface's
   persistent guidance; the prompt and view-full/copy/cancel stay reachable in
   the capturing panel. While a parent operation awaits a child prompt, only
   duplicate launches are restricted — the child interaction is not blocked.
4. Release sensitive references after authentication completes, fails, is
   cancelled, times out, or the owner unloads; a late notify/prompt does not
   reopen the panel. The five-second summary clock is only for short
   success/info feedback.

Verification: turn the expected behaviors behind the five ad-hoc notification
probes into durable regressions. For OAuth use a controllable authorization
mock — notify first, then prompt, wait past five seconds, cover with a panel,
switch tabs, reload, then settle/cancel separately; assert the full URL/code
is still reachable and does not enter history or audit output. PTY checks both
short height and narrow width.

## 5. D: Form/Choice full-category migration

Main files: `interaction/form-panel.ts`, `select-list.ts`, `select.ts`,
`settings-command.ts`, `provider-add.ts`, `provider-onboarding.ts`, the
corresponding basic selection logic in `questionnaire.ts`, and the examples
using the public Form/List.

Migrate in order: configuration forms, standalone enums, OAuth select,
numbers/collections, multi-select. Explicit Save/Cancel, navigation with zero
writes, empty-set cardinality, and no-op share one rule; a standalone boolean
toggle may still execute a clear action immediately. Keep the native settings
revision check, credentials handling, and permission-command semantics.

After each consumer switches to a readonly definition plus action handler,
delete that consumer's values/editing/cursor/zero-selection fallback; finally
delete the conversion paths that no longer have consumers. Questionnaires
reuse Choice at this point — full cross-question Wizard navigation is left to
E, and stitching `[x]` strings is no longer allowed to impersonate a
multi-select.

Acceptance covers Provider credential edit/delete cancel-restore, startup, a
settings enum's complete candidates, OAuth text/secret/select, numeric
intermediate states, multi-select empty sets, and public overlay/pane. Native
write counts, failure preservation, and exact Agent scope must all be
asserted.

## 6. E: composite interactions and the complete action routing

Migrate `frontend-panel.ts` and `info-panel.ts` first, then `session-tree.ts`,
sessions/agents, the marketplace, and the model selector, and finally
`questionnaire.ts`, `approval-plugin.ts`, `plan-review-panel.ts`, and the
public `action.confirm`.

Shared Tabs/Tree/Document only take over paging, filtering, expansion,
scrolling, and semantic actions. Job output's consuming reads, the paging
cursor, and bounded text pages stay with the business/native read path — do
not turn output back into a large cache inside the canonical snapshot.

Consolidate the complete input priority and `availableActions` in
`core/keymap.ts`, `core/index.ts`, and `core/ui-compiler.ts` so actual
matching, availability, and hints share one source. Delete the migrated
features' raw `handleInput` and hand-assembled keys; keep the prompt's
Enter/Tab/Shift+Tab/Ctrl+S conventions, and F7/F8 honors the capturing scope.

Approval, plan review, and questionnaires only share the Decision/Wizard
controls — the native outcome is not rewritten. Acceptance covers default
no-execute, repeated confirmation, target changes, native request abort, Agent
switching, and returning to the original instance after cancel. Typing a
search directly in the marketplace must not trigger the i/u/r business
actions.

## 7. F: release closure and acceptance record

Delete conversion boundaries with no consumers, update
`docs/mayfly-architecture.md`, `docs/mayfly-seams.md`, and the relevant
packages' `AGENTS.md`, and sync the affected READMEs in both languages plus
the Website's public protocol/key docs. Only add entry/export/types/files when
a package subpath actually changes; this design mounts the stable service
through the existing frontend entry and presumes no new subpath or composition
row.

The release notes must list the new snapshot update protocol, the selection
events, tab content association, and the form submit and confirmation
behavior. External consumers upgrade via an explicit version and the migration
example; already-published old versions' behavior is not retroactively
changed.

## 8. Per-batch verification and delivery

| Point in time | Verification to run |
| --- | --- |
| Before coding | Dedicated branch/worktree; read the owning AGENTS; a new worktree does a full build first so package-name imports do not resolve stale lib |
| Every iteration | `pnpm run verify:changed -- --plan` then `pnpm run verify:changed`; the actual changes trigger width, lifecycle, and changed-file coverage |
| Stage deliveries touching public UI, architecture, or composition | `pnpm run verify:full`; do not run plain tests redundantly first; manifest/subpath/dependency changes additionally run `check:pack`, and the related examples, bundle, and preset verifications must pass |
| Doc and screenshot sync | Run `check:agent-docs` as needed; renderer changes run `shots:sync` then `shots:check` after build; Website changes additionally do a strict build and provide a LAN preview |
| Before runtime manual acceptance | `PROFILE=mayfly-ux-<batch> script/install-dev.sh`, run the relevant headless/PTY smoke; rebuild after later source changes, reinstall only on dependency-graph changes |
| Manual acceptance | Provide `dsh --profile mayfly-ux-<batch>` plus this batch's main flow, expected results, failure/narrow/lifecycle, and no-neighbor-regression checklist; wait for all applicable acceptances |
| After acceptance | Only then merge deliverable batches; if runtime is involved rebuild the main checkout; stop previews, remove worktree profiles, and record the exercised scenarios and routes in the merge summary |

This plan and the design revision are documentation-only changes themselves —
run the change-aware gate applicable to docs and the Markdown link check, and
do not install a runtime acceptance profile. Future coding batches must follow
the table; this round's doc checks must not be treated as runtime acceptance.
