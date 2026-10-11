# Phase 2 pre-review audit: progress report

Report date: 2026-10-11 (follow-up pass the same day). Baseline: `b657469`. Plan: [audit plan](2026-10-11-phase-2-audit-plan.md). Results:
[audit report](2026-10-11-phase-2-audit.md). This records the state of the audit when it was submitted and does not
define current behavior.

The audit ships as one PR: the first pass and the follow-up pass are both commits on `docs/phase-2-audit`
(`89f4c6b`, `855e7f4`, `4b1d736`). The follow-up pass that was submitted as a separate PR is folded into it.

## Status

The agent-auditable scope of the plan is complete (parts 1 and 2). Only the live checks and the manual part (M) remain, and the
fixes are split into the work packages under "Dispatch". Nothing has been fixed in this branch. The manual part has not started.

| Workstream | State | Done | Not done |
| --- | --- | --- | --- |
| A Logic and correctness | Done (the lifecycle sweep and the F8/F10 traces are in part 2) | F1, F2, F3, F4, F5, F6, F11, F12, A10 and the segmented-equals-whole property reproduced or run with numbers (F12 at the component level). F7 traced in code and strengthened (no `chdir` in Mayfly or the Harness). F8, F9, F10 re-read; F9 downgraded to not a defect | The live resume check for F7 (manual); a lifecycle sweep of `terminal.ts`, `surface-manager.ts` and `ui-interaction-*.ts` (the first pass went deep only on the 2c files); F8 and F10 only read |
| B Redundant and dead code | Done (the per-export review, the duplicate scan and script hygiene are in part 2) | Export-usage scan (1,945 exports: 218 own-file only, 280 test-only, 1 dead); compatibility leftovers (B1, B2); manifest duplicates (B3); helper duplication counted (B5) | None; the per-export review, the duplicate scan and script hygiene were completed in part 2 |
| C Algorithm and performance | Done (profiles and the unmeasured paths are in part 1) | Scaling repros for F1, F2, F4, F6, A10; the existing `audit-performance.mjs`; CPU profiles of the five paths; diff resize, row-cache eviction, scroll-memory growth, stacked clamps and pane/overlay refresh cost measured (P1-01 to P1-03) | An exclusive-machine timing pass; `perf --prof` of the exact stress inputs (the CLI does not parameterize them) |
| D Test efficiency | Done | Fresh per-test timings (plain and MEMO), work-budget timings, selection fan-out probes; T5 refuted; coverage-run timings (part 1); per-spec import closures (part 1); the deletion check (part 2) | An exclusive-machine pass for a clean coverage factor |
| E Gate and workflow | Done | Selection reach (E1 reproduced), step ordering, input declarations; scenario determinism under parallel runs, perf verdict statistics, golden accept path (part 1) | Clean-machine verdict stability |
| M Manual acceptance | Not started | The checklist is in the plan | All of it |

## Open items

Agent-auditable, still open:

1. ~~Lifecycle sweep of `terminal.ts`, `surface-manager.ts` and `ui-interaction-*.ts` (A).~~ Done in part 2.
2. ~~F8 and F10 traced to the end, not only read (A).~~ Done in part 2.
3. ~~CPU profiles with `perf --prof` (C).~~ Done in part 1.
4. ~~Measure `DiffRowsSource` rebuild on resize, `UiRowCache` FIFO eviction, `scrolled` map growth, stacked width
   clamps, and pane and overlay refresh costs (C).~~ Done in part 1.
5. ~~Per-export review of the 280 test-only exports; duplicate-function scan beyond the named helpers; script hygiene (B).~~ Done in part 2.
6. ~~Coverage-run timings and a per-spec import-closure report (D).~~ Done in part 1; the deletion check is in part 2.
7. ~~Scenario determinism under parallel runs; perf verdict statistics; golden accept path (E).~~ Done in part 1.

Needs a person or a live run:

8. Live checks: F7 on a resumed session of another workspace; F12 through a real `/settings` locale switch.
9. Manual acceptance (M), the eight items in the plan, including the owner decisions in item 8.

## Findings by severity

| Severity | Count | IDs |
| --- | --- | --- |
| P1 | 1 | F1 |
| P2 | 6 | F2, F3, F4, F7 (to confirm live), F13, E1 |
| P3 | 10, plus a low-impact group | F5, F6, F12, A10, B1-B6 (B1-B3 are rule violations with a mechanical fix); the group is F8, F10, F11 |

Reproduced: F1, F2, F3, F4, F5, F6, F11, F12 (component level), A10, E1, B1, B2, B3, B4 counts. Read but not run: F7
(strengthened), F8, F10, B6. Not a defect: F9.

## Corrections made during the audit

Five leads from the first survey were checked and dropped or changed: the `MAYFLY_UI_VERIFY_MEMO` cost (none), the
`agentDocs` patterns (intentional), the `invariant.ts` files (probably a Harness convention), `checkOf` (not slow),
and the A10 lead (real but milder than first reported). The first version of this report also said the duplicate-key
count was five manifests, not four; the follow-up pass found four (`mayfly-user-kit` lists the package once as a peer
and once as a dev dependency, which is legitimate), so the survey's four was right.

The follow-up pass also changed two findings: F12 went from "not reproduced" to reproduced, and F9 went from a
defect to not a defect (the late result is ignored and native work is not rolled back by design). Two numbers were
corrected: F11 is four times the real width (8 against 2), not three, and the F4 largest-unit size depends on the
heading text.

The plan lists twelve leads (F1 to F12). The follow-up pass's fuzz test added F13, which the plan does not list.

## Fix slices

`audit-1` is implemented on `feat/audit-1` (`1d357d5`, F1, F2, F3, F4, F7, E1, F13) and passes the pr and full tiers.
It is not merged. Owed: the runtime profile and Website preview acceptance. `audit-2` to `audit-5` have not started.
See "Fix slices" in the audit report for the decisions the slice made.

## Parallel split

The open agent items (1 to 7) are divided between two agents. Each works in its own worktree from `17b2c84` and writes
its own report. The lead merges both into the audit report.

- **Part 1, runtime and measurement** (`docs/audits/2026-10-11-phase-2-audit-part1.md`): open items 3, 4, 6 (the coverage
  timings and import-closure report) and 7.
- **Part 2, static reading and dead code** (`docs/audits/2026-10-11-phase-2-audit-part2.md`): open items 1, 2, 5, and
  the deletion check of item 6.

Rules: audit only, no product code edits; one timing run at a time, so Part 2 runs no heavy tests or builds while Part 1
measures; the deletion check runs after Part 1's timings; every finding has a `file:line` and every claim a quoted
reproduction. Owner items 8 and 9 stay out of both parts.

## Part 2 results

[Part 2](2026-10-11-phase-2-audit-part2.md) closes open items 1, 2 and 5 and the deletion check of item 6. Nothing in the product
was changed. It adds twelve findings, `P2-1` to `P2-12`:

- **P2** `P2-1`: `sanitizePluginText` deletes the text between two ST-terminated OSC sequences, so shell output with hyperlinks loses
  its labels (extends F10; the audit-1 F2 fix, as described, keeps it). `P2-2`: Windows and macOS clipboard-image paste is documented
  but its implementation, `paste-image-native.ts`, is imported by nothing.
- **P3** `P2-3` to `P2-12`: a terminal that outlives a failed or unloaded startup, the output guard forcing repaints on overlay
  show and hide, a second `stop()` returning early (latent), a wrong shutdown-order comment, twenty module-level test hooks,
  a handled notification that expires again, duplicate implementations, dead production code with tests, unreferenced scripts, and a
  test title that embeds a timestamp.
- **Export review**: of the 280 test-only exports, 257 stay and 23 can go.
- **Deletion check**: the proposed T3, T6 and T8 removals break no other test; the branch coverage floor then keeps only 0.02 points of
  headroom (99.22 to 99.02). T9 as written fails: the design specs and frames can go, the shared helpers cannot, and
  `script/tests/check.test.mjs:68` names a frame.

## Part 1 results

[Part 1](2026-10-11-phase-2-audit-part1.md) closes open items 3, 4, 6 (timings and import closures) and 7. Nothing in the product
was changed. Timings are qualified: the machine was not exclusive, so no clean coverage-cost factor is claimed (observed
paired-run ratio 1.18 to 1.27). It adds three findings:

- `P1-01`: `pnpm run perf -- --prof` reads the wrong directory level, so its function summary is empty although the profile
  files exist.
- `P1-02`: persistent scroll memory keeps historical positional paths (1,000 to 2,000 entries with one current scroll); id-only churn
  keeps one. Product reach and the intended bound are not established.
- `P1-03`: components obtained through the real Cordis service miss the static-leaf compile reuse on every publish; a stable-reference
  control hits it and removes the linear leaf work.

Confirmed or extended: F1, F2, F4, F6 and A10 profile as the report says, on direct large inputs (the catalog does not expose them).
No slow diff resize is demonstrated; `UiRowCache` is FIFO, not LRU (eight variants stay warm, sixteen thrash); the stacked width clamps
are proportional to history in main mode and to the visible rows in alternate mode. Four identical suite runs pass (5,140 tests, one
skipped), plain and with coverage. Two simultaneous full catalog runs produce 40 byte-identical grids each. Perf verdicts over equal
builds at 3, 5 and 7 runs per side show no directional verdict (one inconclusive at 3 runs); clean-machine stability is unverified. The
scratch golden path (new, updated, same) works. Appendix B lists the closure of all 294 specs (120 have at least 150 source files; width
reaches 189).

## Dispatch

The open fixes are split into four work packages, each an issue on the repository, each in its own worktree and PR. The packages
are divided by files and by kind of risk, not by fix. `audit-1` (F1, F2, F3, F4, F7, F13, E1) stays its own slice and is not merged;
items that touch its files wait for it.

| Package | Contents | Difficulty | After `audit-1` |
| --- | --- | --- | --- |
| A, content and measurement cost | P1-01, P1-03, P1-02, F6, A10, F5 with F11, timed budget rows (T13) | High: hot path, every claim measured, Cordis identity in P1-03 | F5 |
| B, lifecycle, sanitizer, notification correctness | P2-1 with F10, P2-3, P2-4, P2-5, P2-6, P2-8, F12, F8 | Medium to high: terminal timing, needs a PTY and manual acceptance | P2-1 |
| C, leftovers, dead code, native paste | B1, B2, B3, B4 with P2-10, P2-2 with the clipboard pair of P2-9, T2 paste waits | Medium: wide public-surface edits; P2-2 cannot be run on Linux | B2 |
| D, tests, gate, scripts | T1, T2 (rest), T3, T7, T10, E2, P2-11, P2-12 | Medium: wide and conflict-prone, gate changes hide failures if wrong | E1 rows, T7 |

Not dispatched, because each needs an owner decision: B5 with the rest of P2-9 (exact duplicates), B6 (a shared row-source base, only after
the content fixes), P2-7 (twenty module-level test hooks that the decision tests depend on), T4, T6, T8 with the coverage floor (0.02
points of headroom after the T3, T6 and T8 removals), T9 (specs and frames only), T12, and the `invariant.ts` companions. The manual
list (items 8 and 9) stays with the owner.

Overlaps to keep in mind: `core/surface-renderer.ts` (A and B), `core/plugin-view.ts` and `core/terminal.ts` (B and C),
`tests/perf/work-budget.spec.ts` (A and D); D's T1 and T10 touch many specs and go last.

## Next steps

1. Owner review of `audit-1` and its decisions; its merge unblocks the items marked above.
2. Packages A to D, claimed and worked in parallel; each PR runs the pr tier and the full tier before review.
3. Owner decisions on the items not dispatched.
4. Owner runs the manual list in the plan (items 8 and 9 above); its results update the 2d acceptance record.

## Working-tree notes

The repository has two uncommitted edits that are not part of this submission: the 2b/2c status tables in
`docs/design/implementation-roadmap.md` and a `20_000` timeout on `markdown-rows.spec.ts:188`. The timeout is a
symptom of F1 and should go when F1 is fixed.

Reproduction scripts are in the audit session's scratch directory and are not committed; the report's appendix
describes their inputs.
