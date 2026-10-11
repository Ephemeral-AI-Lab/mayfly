# Phase 2 pre-review audit: progress report

Report date: 2026-10-11 (follow-up pass the same day). Baseline: `b657469`. Plan: [audit plan](2026-10-11-phase-2-audit-plan.md). Results:
[audit report](2026-10-11-phase-2-audit.md). This records the state of the audit when it was submitted and does not
define current behavior.

## Status

The agent-auditable part is finished to the depth below after a follow-up pass that ran the open checks. Nothing has
been fixed. The manual part has not started.

| Workstream | State | Done | Not done |
| --- | --- | --- | --- |
| A Logic and correctness | Done except one sweep | F1, F2, F3, F4, F5, F6, F11, F12, A10 and the segmented-equals-whole property reproduced or run with numbers (F12 at the component level). F7 traced in code and strengthened (no `chdir` in Mayfly or the Harness). F8, F9, F10 re-read; F9 downgraded to not a defect | The live resume check for F7 (manual); a lifecycle sweep of `terminal.ts`, `surface-manager.ts` and `ui-interaction-*.ts` (the first pass went deep only on the 2c files); F8 and F10 only read |
| B Redundant and dead code | Done at counting depth | Export-usage scan (1,945 exports: 218 own-file only, 280 test-only, 1 dead); compatibility leftovers (B1, B2); manifest duplicates (B3); helper duplication counted (B5) | Per-export review of the 280 test-only exports; the duplicate-function scan beyond the named helpers; script hygiene (orphan smokes, copied PTY blocks) read from the first survey only |
| C Algorithm and performance | Partly done | Scaling repros for F1, F2, F4, F6, A10; the existing `audit-performance.mjs` (lists and transcript source healthy to 100,000) | CPU profiles with `perf --prof`; `DiffRowsSource` rebuild on resize, `UiRowCache` FIFO eviction, `scrolled` map growth, and the stacked width clamps are read only, not measured; pane and overlay refresh costs |
| D Test efficiency | Done | Fresh per-test timings (plain and MEMO), work-budget timings, selection fan-out probes; T5 refuted | Coverage-run timings to separate coverage cost; per-spec import-closure report; a deletion check for each proposed test removal |
| E Gate and workflow | Partly done | Selection reach (E1 reproduced), step ordering, input declarations | Scenario determinism under parallel runs; perf verdict statistics; golden accept path |
| M Manual acceptance | Not started | The checklist is in the plan | All of it |

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

## Fix slices

`audit-1` is implemented on `feat/audit-1` (`1d357d5`, F1, F2, F3, F4, F7, E1, F13) and passes the pr and full tiers.
It is not merged. Owed: the runtime profile and Website preview acceptance. `audit-2` to `audit-5` have not started.
See "Fix slices" in the audit report for the decisions the slice made.

## Next steps

1. Owner review of `audit-1` and its decisions, then triage of the rest of the slice table.
2. Slices `audit-2` to `audit-5`.
3. Run the remaining sweep above (lifecycle files, F8, F10) while the first slice is in review.
4. Owner runs the manual list in the plan; its results update the 2d acceptance record.

## Working-tree notes

The repository has two uncommitted edits that are not part of this submission: the 2b/2c status tables in
`docs/design/implementation-roadmap.md` and a `20_000` timeout on `markdown-rows.spec.ts:188`. The timeout is a
symptom of F1 and should go when F1 is fixed.

Reproduction scripts are in the audit session's scratch directory and are not committed; the report's appendix
describes their inputs.
