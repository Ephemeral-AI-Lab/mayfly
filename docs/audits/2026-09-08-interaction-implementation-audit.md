# Interaction implementation audit

Date: 2026-09-08. Audited HEAD: `f51c40d`. Baseline: `b82acd2`.
Candidate package line: `0.1.0-alpha.4`.

## Assessment

The registration-owned interaction architecture is a substantial improvement:
frontend state survives renderer replacement, public actions have structured
settlements, and native requests can wait for admitted acknowledgements. The
implementation also has unusually extensive deterministic coverage.

However, passing the existing gate does not establish that all interaction
orderings are correct. This audit found ten implementation defects in the new
or migrated paths, two additional editor-adapter contract gaps, and two
pre-existing exact-Agent authority defects that remain in the current tree.
The most consequential new problems are stale snapshot publication, missing
picker observations, and presentation rebuilds invalidating pending actions.
The pre-existing permission-confirmation defect deserves priority because it
can dispatch a full-access permission change against an Agent that is no longer
selected.

This is an audit report, not a remediation change. No product implementation
was changed. Severity describes the impact of the observed condition, not a
claim that every user will encounter it. No critical vulnerability, credential
exfiltration, or lost persisted settings from stale conflict publication was
demonstrated.

## Scope and method

The seven commits are the seven entries in the ordinary Git log, including the
merge commit; they are not seven first-parent commits:

| Commit | Purpose |
| --- | --- |
| `4e94835` | Registration-owned interaction state |
| `63dbfae` | Consumer migration to shared surfaces |
| `e5c94fc` | Alpha.4 release candidate |
| `e09206f` | Public interaction guidance |
| `5fbbdc8` | Merge interaction refactor |
| `ccce85d` | Migration acceptance record |
| `f51c40d` | Repository guidance simplification |

The comparison `b82acd2..f51c40d` contains 276 changed files, 20,510 insertions,
and 22,258 deletions. Earlier output-progress work is outside this baseline.

Three subagents independently reviewed the shared protocol/state, migrated
consumers, and rendering/input. The primary reviewer examined composition,
public/distribution contracts, documentation and test evidence, challenged
findings, reran the protocol/consumer reproductions, and consolidated duplicate
reports. Owning AGENTS instructions and current architecture/types were used;
historical completion records were not treated as proof of present correctness.

| Perspective | Reviewed areas | Evidence and limits |
| --- | --- | --- |
| Protocol and state | UI contracts, provider endpoints, surface/form/choice/tree/notification models | Direct production-source reproductions, real endpoint publication, existing state tests |
| Native consumers | Provider setup/edit/OAuth, settings, approval/questions/plan, model/preset, tools/MCP, sessions/agents/jobs, marketplace/update | Source comparison and tests; targeted provider persistence and Agent-dispatch reproductions |
| Rendering and input | Compiler, surface bridge, screen, semantic document state, keys, editor extensions | Real compiler and mounted renderer reproductions, keyboard tests, width scans and PTY smoke |
| Architecture and lifecycle | Frontend owner, registry subscriptions, consumer Fibers, core reload, flat composition | Source inspection and full composition suite; no claim that every possible reload interleaving was exhausted |
| Public and distribution | Package manifests, public wire migration, external overlay example, packed runtime/types | Full build, export checks, independent example installation and pack checks |
| Documentation and performance | Current Website API claims, acceptance records, lazy list behavior | Website build, screenshots, source complexity instrumentation and fresh descriptive benchmarks |

Evidence labels below distinguish **reproduced**, **source-confirmed**, and
**contract-dependent** behavior. A source-confirmed finding has an explicit
reachable implementation path but was not necessarily exercised through a real
terminal or native service. Reproductions that use fake native services are
identified as such. This is broad coverage of the change, not a proof of every
line, platform, external provider, or possible interaction sequence.

## Verification performed in this audit

Environment: Linux x64, Node `v24.15.0`, pinned pnpm `11.7.0`; installed Vitest
reported `4.1.10`. Builds were refreshed before installed-profile smoke.

| Check | Result |
| --- | --- |
| `pnpm run verify:changed -- --plan --base b82acd2` | Selected the full deterministic gate |
| `pnpm run verify:changed -- --base b82acd2` | Passed repository workflow tests, typecheck, lint, diagrams, build, lib exports, agent docs, examples, coverage, and Website build |
| Coverage suite | 193 files passed, 2 skipped; 3,183 tests passed, 7 skipped |
| Coverage thresholds | Statements 18,056/18,056; branches 13,404/13,404; functions 3,698/3,698; lines 14,453/14,453 — all 100% |
| `pnpm run smoke:happy` | `HAPPY_SMOKE_PASS exit=0` |
| `pnpm run check:pack` | Three alpha.4 tarballs; publint and external packed UI runtime/type consumer passed |
| `pnpm run shots:check` | 36 component screenshots current; six app screenshot tests passed |
| `pnpm run smoke:pty` | `PTY_SMOKE_PASS exit=0` |
| `pnpm run smoke:pty:mouse` | `PTY_MOUSE_SMOKE_PASS exit=0` |
| `pnpm run smoke:pty:output` | `PTY_OUTPUT_RECOVERY_PASS exit=0` |
| `script/audit-performance.mjs` | Completed fresh headless measurements at 1k, 10k and 100k items |
| Targeted audit reproductions | Reproduced behaviors below outside the ordinary suite; expected-correctness renderer assertions fail on this HEAD |

The change-aware command already ran the full deterministic gate. Happy smoke
was run separately rather than repeating the entire suite with `verify:full`.
The audit did not repeat human visual acceptance, Windows/macOS desktop tests,
real OAuth-provider login, or system clipboard/IME acceptance. PTY runs used
their own throwaway profiles, not production `mayfly`. There is no persistent
preview or acceptance profile to approve for this documentation-only change.

## Findings at a glance

P1 means a high-impact authority/targeting defect deserving priority. P2 means
a functional, state-integrity, or cancellation defect to fix in the next
correctness pass. P3 means a lower-impact feedback or scalability defect.

| ID | Priority | Finding | Evidence | Origin |
| --- | --- | --- | --- | --- |
| A01 | P2 | Stale conflict/failure snapshots bypass the newer-data fence | Reproduced conflict; analogous failed-node path source-confirmed | New shared model |
| A02 | P2 | Picker commits omit observations and preserve obsolete provider discovery | Reproduced through shared state and native settings fixture | New shared model/migration |
| A03 | P2 | Editor presentation refresh discards pending action settlement | Reproduced with production-equivalent feedback refresh | Migrated editor adapter |
| A04 | P2 | Older read validation overwrites a newer submit error | Reproduced | New shared model |
| A05 | P2 | Selection acknowledgement erases a newer editable choice | Reproduced | New shared model |
| A06 | P2 | Provider Save can begin a write after operation cancellation | Reproduced with real shared model; API-level cancellation | New provider editor |
| A07 | P2 | Installed marketplace tab prevents update/partial-install recovery | Source-confirmed regression | Migrated marketplace |
| A08 | P2 | Live resize loses semantic document position | Reproduced in compiler and mounted renderer | New semantic scroll adapter |
| A09 | P3 | Repeated feedback updates double-count visible time | Reproduced with controlled clock | New notification store |
| A10 | P3 | Filtered/tree movement copies the complete cached index | Reproduced access count | New choice reducer |
| R01 | P2 | Delayed model cycle can target the replacement Agent | Reproduced native-controller spy | Pre-existing, retained |
| R02 | P1 | Permission confirmation survives exact-Agent replacement | Reproduced same-ID replacement and command spy | Pre-existing, retained |

Adapter gaps C02/C03 and the contract-dependent key-precedence issue C01 are
documented separately below to avoid inflating the ten primary defect count.

## A01 — Fence every snapshot-bearing settlement

**Location:** [ui-interaction-surface.ts:581](../../packages/mayfly/src/core/ui-interaction-surface.ts#L581),
publication at line 607; [snapshot-events.ts:187](../../packages/ui/src/snapshot-events.ts#L187).

The source/baseline freshness check runs only for `accepted` and partial
`failed` replies carrying `acceptedFields`. A `conflict`, or ordinary `failed`
reply containing a node, can publish as data without that check.

Reproduction: start Save at source revision 1; publish external value C at
revision 3 while the handler waits; resolve the old handler with a conflict
snapshot containing `older` at revision 2. The current model ends at revision
**2**, with authoritative field definition **older**. Revision 3/C was replaced.

This can present obsolete conflict-resolution values and capture obsolete
source stamps for the next submission. Native optimistic concurrency may still
reject a later write; the audit did not demonstrate lost native persistence.

**Remediation:** apply the freshness decision to every reply that can publish a
node, preserving operation feedback when obsolete publication is declined.
Source revisions may be opaque strings: do not solve this by assuming numeric
ordering. Test conflict and ordinary failed-node replies as well as accepted and
partial replies, with source-changing and same-source data refreshes.

## A02 — Picker commits must emit committed value observations

**Location:** [ui-interaction-surface.ts:335](../../packages/mayfly/src/core/ui-interaction-surface.ts#L335),
[ui-compiler.ts:1417](../../packages/mayfly/src/core/ui-compiler.ts#L1417),
[provider-add.ts:159](../../packages/mayfly/src/interaction/provider-add.ts#L159).

`updateForm()` emits observations for `edit`, `reset` and `resolve-conflict`.
The real dropdown path commits through `finish-picker`, which is missing from
that observation path. A select field can change from a to b without emitting
any `value-change` event.

The in-tree consequence was reproduced using the provider fixture and native
settings service: discover/select model `one` for an `openai-completions`
endpoint, change the protocol dropdown to `anthropic-messages`, then Save.
The provider is persisted with the new protocol and the old discovered model
list. The observer intended to clear `advertised`, `metadata`, and `listingBase`
never runs. The reproduction uses shared picker intents corresponding to the
renderer path; it does not perform a real network discovery request.

**Remediation:** emit one observation for a successful picker commit that
actually changes the committed value, using its field revision. Cancelled or
unchanged commits should not invalidate discovery. Add select/multiselect
renderer-to-consumer tests; direct `model.edit()` tests cannot catch this gap.
Also ensure discovery validity is checked against submitted inputs at Save,
so a missed notification cannot alone authorize stale discovery data.

## A03 — Presentation identity must not own action lifetime

**Location:** [editor-extension-runtime.ts:489](../../packages/mayfly/src/interaction/editor-extension-runtime.ts#L489),
[input-plugin.ts:221](../../packages/mayfly/src/interaction/input-plugin.ts#L221)
and its interaction subscription at line 258.

An editor action's continuation discards the prepared reply when its captured
shell is no longer `this.shell`. Production feedback reporting updates the
notification owner, whose subscription calls `refreshPresentation()` and
installs a new shell. The action's own progress report can therefore invalidate
its final reply even though its registration remains alive.

A focused reproduction reports `Working` and then returns a structured failure
`Action failed`, with the reporter refreshing presentation as production does.
Expected feedback is both messages; actual feedback contains only `Working`.
The same early return skips accepted-decoration publication. Unrelated footer
or hint changes during the await can take the same path.

The existing progress test collects messages in an array; it does not reproduce
the notification-driven shell refresh. This is a test-fixture integration gap.

**Remediation:** fence replies by registration endpoint and operation lifetime,
not renderer-shell identity. Preserve replacement/disposal cancellation. Add a
test with the actual notification subscription, a progress report, an accepted
decoration, and a late failure. Verify progress is retired on settlement.

## A04 — New validation boundaries must retire older read results

**Location:** [ui-interaction-surface.ts:439](../../packages/mayfly/src/core/ui-interaction-surface.ts#L439),
task creation at line 543, error application at line 651, freshness at line 666.

Start an explicit read action for a form and hold its result. Submit the same
unchanged form; return `invalid` with `SAVE error`. Resolve the older read with
`older READ error`. The displayed error changes from the newer Save error to
the older read error.

Starting Submit retires value-change validators, but not overlapping explicit
read actions. Read freshness only compares draft revisions/selections; a newer
validation boundary without a value edit does not change those revisions.

**Remediation:** retire overlapping read-validation tasks at a newer submit/read
boundary, or introduce a validation generation separate from draft revision.
Keep independent form errors independent. Test both completion orders and a
read against a different form. The finding is the demonstrated error overwrite,
not an assumption that all concurrent reads should be globally prohibited.

## A05 — Preserve or lock newer choice edits during acknowledgement

**Location:** [ui-interaction-surface.ts:287](../../packages/mayfly/src/core/ui-interaction-surface.ts#L287),
choice updates at line 349; [ui-interaction-choice.ts:200](../../packages/mayfly/src/core/ui-interaction-choice.ts#L200).

Accept selection B and hold the handler. Change the still-editable choice to C.
Resolve the old action with accepted snapshot B. The choice becomes B and
`dirty=false`; the newer C edit disappears.

Acknowledgement matches the operation's selection address, but does not check
a selection draft generation. `acknowledgeChoice()` unconditionally replaces
the selection and clears dirty state. Renderer choice controls are not disabled
solely because acceptance is pending, so accepting newer input and later
discarding it is observable behavior.

**Remediation:** choose an explicit policy: lock the affected choice until its
submission settles, or retain newer C as a draft over acknowledged baseline B.
Test single/multiple lists and form actions with attached selections. Resetting
submitted B on successful acknowledgement is expected; erasing subsequent C
without a lock or conflict policy is the defect.

## A06 — Recheck cancellation after provider preflight reads

**Location:** [provider-edit.ts:110](../../packages/mayfly/src/interaction/provider-edit.ts#L110),
Delete mutation at line 122 and Save mutation at line 155.

The handler checks `context.signal`, awaits `read()`, then can enter a settings
mutation without checking the action signal again. `read()` observes the
surface/caller lifetime, which is distinct from cancellation of one operation.

Reproduction with the real shared model: edit provider display name; invoke
Save; delay `credentials.describe()` inside the preflight read; call
`model.cancelOperation(id)`; resolve the read. The model's operation is cancelled,
but native settings persist `Cancelled write`. The write begins after cancellation,
not before it. Delete has the same missing check before its settings mutation.
Clear-key has a later check before `credentials.unset()` and is not included in
the demonstrated affected write path.

**Reachability limit:** this reproduction uses the internal model cancellation
API while leaving the surface open. No current renderer caller of
`cancelOperation()` was found. Do not equate this with ordinary Escape/close,
which also aborts the surface lifetime and can protect this read.

**Remediation:** check operation and lifetime signals immediately after the
await and before beginning each new native side effect. Preserve truthful
partial-write handling when cancellation occurs after a write has already begun.
Add delayed-preflight cancellation tests for both Save and Delete.

## A07 — Marketplace grouping blocks update and repair

**Location:** [plugin-commands.ts:338](../../packages/mayfly/src/interaction/plugin-commands.ts#L338),
especially the unconditional disabled Install action at line 350.

Marketplace entries with any installed rows are placed under Installed.
Install is disabled for that entire tab with `Already installed in this profile`.
This includes partially installed multi-row entries and installed entries for
which an update is available. The old browser's install action remained usable
for update/recovery; the migration removes that UI path.

This is source-confirmed from grouping, action construction, and baseline
comparison. A real marketplace update was not performed during the audit.
The direct `/plugin install <id>` command remains a workaround.

**Remediation:** derive availability from the selected entry's actual install
state and policy, with Update/Repair wording where appropriate. Test fully
installed, update-available, partial, removed, blocked, and offline entries.
Avoid using tab membership as an installation eligibility predicate.

## A08 — Restore document anchors on live width changes

**Location:** [ui-compiler.ts:386](../../packages/mayfly/src/core/ui-compiler.ts#L386),
particularly the one-shot `restore` flag at lines 404–405.

`SemanticScrollView.render()` updates effective width, but `updateLayout()`
restores the semantic anchor only once per instance. A width change retains the
old physical row instead of recalculating the row containing the source anchor.

This was reproduced both through the compiler and a mounted surface renderer
with the real terminal runtime and FakeTerminal. With anchor offset 15, width 5
shows `pqrst`. Resize to width 10: the first row becomes `efghijklmn`, beginning
at source offset 30. Correct restoration would show `klmnopqrst`, containing
offset 15. The terminal's resize path forces a new frame without recreating the
compiled surface, so this is not limited to a standalone compiler fixture.

The existing renderer test combines width change with renderer reconstruction,
which resets `restore` and conceals the live-resize case. The Website explicitly
promises anchor preservation through width changes.

**Remediation:** remap the retained anchor after effective content width/layout
changes, preserving follow-end behavior separately. Test narrow→wide and
wide→narrow on the same mounted surface, plus simultaneous content refresh.

## A09 — Accrue each visible feedback interval once

**Location:** [ui-interaction-notifications.ts:47](../../packages/mayfly/src/core/ui-interaction-notifications.ts#L47),
snapshot accounting at line 35 and hide accounting at line 107.

`report()` adds elapsed exposure to `visibleMs` but retains the old creation
timestamp. A later report, snapshot, or hide adds time since that old timestamp
again.

Controlled-clock reproduction: report at 0ms, update the same ID at 1,000ms, then
again at 2,000ms. Snapshot exposure is already 5,000ms. Hiding records 5,000ms,
although the user saw it for only 2,000ms; showing again schedules immediate
expiry for ordinary informational feedback. Progress→settled transitions reset
the timestamp and do not exercise this exact path.

**Remediation:** separate creation time from the last accrued visibility time,
or store only completed visibility intervals. Test repeated reports separated
by positive elapsed time, then hide/show; assert both exposure and expiry.

## A10 — Retain immutable filter/tree indexes across movement

**Location:** [ui-interaction-choice.ts:42](../../packages/mayfly/src/core/ui-interaction-choice.ts#L42).

`freezeChoice()` spreads `matches` and `visibleTreeIndices` into fresh frozen
arrays on focus/movement even when the indexes are unchanged. A one-row move in
a filtered N-item list therefore traverses and allocates O(N) index data.

An instrumented readonly-index iterator counted **10,000 copied indices for
one Down operation** in a 10,000-match list. This is a deterministic complexity
observation, not an inference from noisy timing. Tree visibility has the same
copying path. Cached index construction alone does not make movement bounded.

**Remediation:** retain internally owned immutable index arrays on focus-only
updates, rebuilding them only when query, disclosure or definition changes.
Add a deterministic access/allocation budget after index construction. Preserve
private provenance rather than trusting arbitrary caller-frozen arrays.

Fresh descriptive measurements did not show catastrophic latency at 100k;
they do show why timing alone is insufficient to prove bounded work:

| Items | Repeat render median | Filtered PageDown median | Tree PageDown median | Filtered movement median heap growth |
| --- | ---: | ---: | ---: | ---: |
| 1,000 | 0.633ms | 1.519ms | 1.182ms | 860,688 bytes |
| 10,000 | 0.617ms | 1.088ms | 0.906ms | 921,600 bytes |
| 100,000 | 0.497ms | 1.414ms | 1.365ms | 1,613,992 bytes |

Measurements are seven-sample headless synthetic runs, with other audit work
running concurrently. They are not terminal FPS, a controlled before/after
comparison, or total allocation measurements. First build/publish/render at
100k had median 257.514ms; that is an initial-cost observation, not a separate
regression finding.

## Residual exact-Agent authority findings

### R01 — Model cycling can act on a newly selected Agent

**Location:** [model-commands.ts:225](../../packages/mayfly/src/interaction/model-commands.ts#L225)
and [commitModelSelection at line 131](../../packages/mayfly/src/interaction/model-commands.ts#L131).

The hotkey captures the current model selection, waits for the provider model
list, then calls a helper which reads the current Agent again. Reproduction:
start cycling on Agent A with model a; replace selection with Agent B while
listing waits; resolve models a/b. The native-controller spy receives B's
session ID with model b chosen from A's cycle, rather than retiring A's action.

The direct model/default-persistence helper also lacks an exact-Agent recheck
after `selectModel()` before saving the default. Picker operations receive
cancellation from `openAgentOverlay`, so that protected path should not be
conflated with the unfenced hotkey/direct-command paths.

Baseline comparison found the central retargeting behavior already present
before these seven commits. This is a current correctness/authority gap retained
through migration, not a newly introduced regression.

**Remediation:** capture exact Agent identity at invocation, recheck it after
each asynchronous read and before each new write, and cancel on replacement.
Test both different-session and same-session-ID replacement. Preserve native
work that already began while preventing new continuation writes.

### R02 — Full-access confirmation remains actionable for an old Agent

**Location:** [permission-panel.ts:99](../../packages/mayfly/src/interaction/permission-panel.ts#L99),
confirmation at line 121 and picker at line 132.

The permission picker/confirmation uses app-scoped `openUiOverlay()` and closes
over the Agent captured at opening. It has no selected-Agent subscription or
identity check before dispatch. Its command uses a fresh, unconnected
AbortController signal.

Reproduction used real Context, UI provider/frontend, a notifying current-Agent
service, and a native-command spy: open permission picker for A, choose full
access, replace A with a distinct Agent object sharing the same ID/session,
notify subscribers, then invoke Yes. The confirmation remains present and the
spy records `/permission danger-full-access` targeting the **old** Agent, not
the current one. This proves stale dispatch; it does not claim a real OS sandbox
was changed in the fixture.

The old panel controller also lacked an Agent fence, so this is a pre-existing
residual defect. Its consequence is more serious than ordinary stale visual
feedback because the operation changes permission policy.

**Remediation:** bind picker and confirmation to exact Agent lifetime, retire
both on selection change, and recheck identity at dispatch. Exercise full-access
Yes/No, ordinary permission selection, same-ID replacement, and unload. Keep
this separate from approval/request handling, whose `requestOverlay()` path
already implements a substantially stronger authority boundary.

## Additional input, adapter and documentation gaps

### C01 — Printable key remapping versus type-to-filter needs one policy

**Confirmed behavior; contract-dependent defect classification.** At
[ui-compiler.ts:1997](../../packages/mayfly/src/core/ui-compiler.ts#L1997), filterable
lists pass printable input to search before most semantic action matching.
With Submit remapped to `r`, pressing r produces query `r` and zero submissions.
The same remap works in a plain action surface.

The audit does not assume action bindings must always win over text input.
Choose and document the precedence: either reserve matching semantic bindings
before search, or declare the restriction and avoid hints advertising a binding
that cannot execute in the current focus context. Test remapped submit, cancel,
movement and toggle both inside and outside active search.

### C02 — Editor-extension controls omit the live keymap

**P2; reproduced.** [editor-extension-runtime.ts:452](../../packages/mayfly/src/interaction/editor-extension-runtime.ts#L452)
calls the shell compiler without `keymap`. A real runtime fixture with Submit
bound to r executes zero actions on r, but executes one on fallback Enter.
Ordinary surfaces pass the live keymap. Supply the same keymap to extension
compilation and test traversal/activation through the actual extension shell.
This is independent of the search-precedence policy in C01.

### C03 — Editor actions silently omit final reply feedback

**P3; source-confirmed.** [editor-extension-runtime.ts:490](../../packages/mayfly/src/interaction/editor-extension-runtime.ts#L490)
forwards streamed reports and synthesizes failed/conflict messages, but never
forwards `reply.feedback`. A completed reply carrying success feedback has no
notification path, even if presentation never changes. Handle the shared
feedback contract and settlement cleanup consistently with ordinary surfaces;
test completed/accepted success and warning feedback. This is distinct from A03's
early return discarding the entire prepared reply.

### C04 — Tab navigation prose disagrees with the routing code

The [English reference](../../website/en/plugins/ui-reference.md#L927) says
Tab/Shift-Tab are inert on tab strips, while
[ui-compiler.ts:2072](../../packages/mayfly/src/core/ui-compiler.ts#L2072) routes
them through group movement. Align English/Chinese guidance with the intended
behavior and a keyboard trajectory test. This is documentation drift, not a
demonstrated data or authority defect.

## What the refactor gets right

1. **Registration-bound endpoints:** combined registration/operation signals,
   cancellation races, single-use publishers and guarded progress callbacks
   make ownership explicit. The main remaining publication problem is incomplete
   use of that machinery, as A01 shows.
2. **Frontend-owned state:** forms, choices, pages and operations survive core
   renderer gaps. Registry observers use expected-model checks during cleanup;
   replacement can create a fresh instance without trusting public IDs alone.
3. **Form integrity:** explicit submissions, field revisions, partial
   acknowledgement addresses, schema/baseline comparisons and conflict state
   are materially stronger than ad hoc consumer draft stores.
4. **Native requests:** `requestOverlay()` defers native settlement until an
   admitted acknowledgement and rechecks exact Agent/abort state. Tests cover
   competing decisions, failed admission, withdrawal and settlement exceptions.
5. **Sensitive settings:** settings projection uses redacted descriptors,
   omits opaque containers, and does not place saved secrets/default secrets
   into form values. Provider editing distinguishes settings and credential
   partial writes; no secret disclosure was reproduced.
6. **Public consumption and packaging:** the external overlay example uses
   public package imports and native settings revisions. Fresh independent
   install, packed runtime/types, export and distribution checks passed.
7. **Renderer discipline:** default-No decisions, field focus, Delete/Ctrl-D
   containment, narrow-form reachability, Unicode width checks, prompt leases,
   and terminal recovery have useful existing tests and fresh smoke evidence.

## Test gaps and recommended remediation order

The dominant gap is combinations of individually tested features. Branch
coverage can be complete while event order, input modality, and owner identity
are wrong. Preserve the current deterministic gate, and add the following small
matrices rather than only more happy-path tests:

| Matrix | Necessary cross-product |
| --- | --- |
| Settlement publication | accepted/conflict/failed-node/partial × external data refresh × source unchanged/changed × replacement/unload |
| Validation ownership | observation/read/submit × both completion orders × same/disjoint forms × edit/no edit |
| Input modality | direct edit/text entry/select/multiselect × commit/cancel/unchanged × consumer observation |
| Choice submission | single/multiple/attached selection × newer edit × accepted/failed/cancelled |
| Renderer independence | notification/hint/theme/core rebuild × pending action × progress/final feedback/publication |
| Exact authority | different Agent/same-ID replacement × picker/confirmation/direct command/hotkey × before/after await |
| Live layout | same-instance resize × source anchor/follow-end × plain/markdown/gapped content |
| Consumer writes | cancel before preflight completion/before write/after first write × partial persistence/retry |
| Performance | unfiltered/filtered/tree × move/render/query change × index reads and identity retention |

Recommended order:

1. Address R02/R01 authority targeting, even though pre-existing. Their presence
   means an audit of the final implementation cannot declare exact-Agent
   behavior complete merely because migrated picker tests pass.
2. Repair A01/A02/A03 and C02/C03 at the shared/adapter boundaries. These affect
   multiple consumers and make subsequent migration tests more reliable.
3. Repair A04/A05/A06 and A07, adding tests that assert native side-effect counts
   and the actual persisted state, not only reply kinds.
4. Repair A08/A09/A10 and settle C01/C04. Use access-count checks for complexity
   and same-instance layout tests for resizing.
5. Run the full gate once on the resulting implementation, then required pack,
   screenshot and dedicated-profile acceptance for that runtime change. Exercise
   provider discovery after protocol change, permission replacement, retained
   drafts, editor progress and final feedback, live resize, and nearby regressions.

## Evidence artifacts and remaining uncertainty

Local evidence is archived under `.artifacts/interaction-audit-2026-09-08/`:
gate/pack/screenshot/smoke logs, benchmark JSON, protocol reproductions, consumer
reproductions, and renderer reproduction tests/output. These are audit artifacts,
not new committed regression tests or shipped runtime files. Temporary absolute
paths inside reproduction fixtures identify the audited checkout; instructions
in the artifact README explain rerunning them locally.

Protocol reproductions assert the observed defective behavior and exit zero
when it is reproduced. Consumer scripts print the resulting settings/dispatch
facts. Renderer reproductions assert the desired behavior and therefore fail
on this HEAD: five assertions cover search/remap precedence, compiler resize,
mounted resize, editor progress settlement, and extension keymap propagation.
The compiler and mounted resize assertions substantiate the same A08 finding.
They were kept outside the ordinary test glob, so the reported baseline gate
remains uncontaminated.

The source-to-row anchor algorithm also approximates rich-document geometry.
Padding, stack gaps, markdown, code decorations and grapheme clusters merit
additional insertion/removal tests. An initial same-content gap/rebuild control
passed; that concern is deliberately not counted as another confirmed defect.
Editor-action concurrency and absence of an action timeout are explicitly
tested current behavior and were not reported as accidental regressions.

Broad Linux automation passed, but it does not establish Windows/macOS desktop
behavior, real IME/clipboard integration, every external provider's behavior, or
human acceptance of the new interaction policy. Historical acceptance remains
historical evidence; this report records the current audited implementation and
the concrete limits of its fresh verification.
